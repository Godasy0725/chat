const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// 中间件
app.use(cors());
app.use(bodyParser.json());

// 创建 uploads 目录
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// 配置 multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, Date.now() + '-' + crypto.randomBytes(4).toString('hex') + ext);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    const allowed = /\.(jpg|jpeg|png|gif|webp)$/i;
    if (allowed.test(path.extname(file.originalname))) {
      cb(null, true);
    } else {
      cb(new Error('不支持的图片格式'));
    }
  }
});

// 静态文件服务
app.use('/uploads', express.static(uploadsDir));

// 内存数据库（实际项目建议用MongoDB/MySQL）
const users = new Map(); // { username: { password, avatar, ip, loginTime, muteRoom: false, mutePrivate: false } }
const rooms = new Map(); // { roomName: { owner, users: Set, muted: Set, messages: Array, status: 'show/hide' } }
const friendApplies = new Map(); // { to: [{ from, time }] }
const friends = new Map(); // { user: Set(friends) }
const privateMessages = new Map(); // { "user1-user2": Array }
const allMessages = []; // 所有消息记录（用于管理员查看）

// 管理员配置
const ADMIN_PASSWORD = 'Lmx%%112233';
const ADMIN_TOKEN_EXPIRE = 24 * 60 * 60 * 1000; // 24小时过期

// 工具函数
function hashPassword(pwd) {
  return crypto.createHash('md5').update(pwd).digest('hex');
}

function getBJTime() {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  const bjTime = new Date(utc + 8 * 3600000);
  return bjTime.toISOString().replace('Z', '+08:00');
}

function getPrivateKey(user1, user2) {
  return [user1, user2].sort().join('-');
}

// 验证管理员Token
function verifyAdminToken(token) {
  try {
    const decoded = atob(token).split('-');
    const timestamp = parseInt(decoded[0]);
    const pwd = decoded[2];
    // 检查密码和有效期
    return pwd === ADMIN_PASSWORD && (Date.now() - timestamp) < ADMIN_TOKEN_EXPIRE;
  } catch (e) {
    return false;
  }
}

// 广播消息到房间
function broadcast(room, data) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client.room === room) {
      client.send(JSON.stringify(data));
    }
  });
}

// 广播管理员公告
function broadcastAdminNotice(content) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({
        type: 'admin_notice',
        content
      }));
    }
  });
}

// 发送管理员消息
function sendAdminMsg(type, target, content) {
  const msgData = {
    type: 'admin_msg',
    target,
    content,
    time: getBJTime()
  };
  
  if (type === 'all') {
    // 发送给所有用户
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(msgData));
      }
    });
  } else if (type === 'room' && target) {
    // 发送到指定聊天室
    broadcast(target, msgData);
  } else if (type === 'private' && target) {
    // 发送给指定用户
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN && client.username === target) {
        client.send(JSON.stringify(msgData));
      }
    });
  }
  
  // 记录管理员消息
  allMessages.push({
    sender: '管理员',
    target,
    content,
    time: getBJTime(),
    type: 'admin'
  });
}

// 发送私聊消息
function sendPrivateMsg(sender, receiver, content, contentType = 'text') {
  // 检查发送方是否被私聊禁言
  const senderUser = users.get(sender);
  if (senderUser && senderUser.mutePrivate) {
    // 通知发送方禁言
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN && client.username === sender) {
        client.send(JSON.stringify({
          type: 'private_muted',
          message: '你已被禁止私聊，无法发送消息'
        }));
      }
    });
    return;
  }
  
  // 推送消息给接收方
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client.username === receiver) {
      client.send(JSON.stringify({
        type: 'private_msg',
        sender,
        receiver,
        content,
        contentType
      }));
    }
  });
  
  // 保存私聊记录
  const key = getPrivateKey(sender, receiver);
  if (!privateMessages.has(key)) privateMessages.set(key, []);
  const msgObj = {
    sender,
    receiver,
    content,
    contentType,
    time: getBJTime()
  };
  privateMessages.get(key).push(msgObj);
  // 记录到全局消息
  allMessages.push({
    ...msgObj,
    target: receiver,
    type: 'private'
  });
}

// WebSocket连接
wss.on('connection', (ws, req) => {
  ws.username = '';
  ws.room = '';
  // 获取用户IP
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  
  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);
      
      // 管理员登录
      if (data.type === 'admin_login') {
        if (verifyAdminToken(data.token)) {
          ws.isAdmin = true;
          ws.send(JSON.stringify({ type: 'admin_login_success' }));
        } else {
          ws.send(JSON.stringify({ type: 'error', message: '管理员验证失败' }));
          ws.close();
        }
        return;
      }
      
      // 普通用户登录
      if (data.type === 'login') {
        ws.username = data.username;
        // 记录用户IP和登录时间
        if (users.has(data.username)) {
          users.set(data.username, {
            ...users.get(data.username),
            ip,
            loginTime: getBJTime()
          });
        }
        ws.send(JSON.stringify({ type: 'login_success', username: data.username }));
      }

      // 切换房间
      if (data.type === 'switch_room') {
        // 先清理旧房间
        if (ws.room && ws.room !== data.room && rooms.has(ws.room)) {
          const oldRoom = rooms.get(ws.room);
          oldRoom.users.delete(ws.username || data.username);
          broadcast(ws.room, {
            type: 'system',
            room: ws.room,
            content: `${ws.username || data.username} 离开房间`
          });
          broadcast(ws.room, {
            type: 'online',
            room: ws.room,
            count: oldRoom.users.size
          });
        }

        ws.room = data.room;
        if (!rooms.has(data.room)) {
          ws.send(JSON.stringify({ type: 'error', message: '房间不存在' }));
          return;
        }
        const room = rooms.get(data.room);
        room.users.add(data.username);
        broadcast(data.room, {
          type: 'system',
          room: data.room,
          content: `${data.username} 加入房间`
        });
        // 发送在线人数
        broadcast(data.room, {
          type: 'online',
          room: data.room,
          count: room.users.size
        });
      }

      // 发送群消息
      if (data.type === 'chat') {
        const room = rooms.get(data.room);
        if (!room) return;
        
        // 检查是否被禁言（房间禁言+全局禁言）
        const user = users.get(data.username);
        if (room.muted.has(data.username) || (user && user.muteRoom)) {
          ws.send(JSON.stringify({
            type: 'room_muted',
            message: '你已被禁言，无法发送消息'
          }));
          return;
        }

        // 保存消息并广播
        const msgObj = {
          username: data.username,
          content: data.content,
          contentType: data.contentType || 'text',
          time: getBJTime()
        };
        room.messages.push(msgObj);
        // 记录到全局消息
        allMessages.push({
          sender: data.username,
          target: data.room,
          content: data.content,
          contentType: data.contentType || 'text',
          time: getBJTime(),
          type: 'room'
        });
        
        broadcast(data.room, {
          type: 'chat',
          room: data.room,
          ...msgObj
        });
      }

      // 发送私聊消息
      if (data.type === 'private_msg') {
        sendPrivateMsg(data.sender, data.receiver, data.content, data.contentType || 'text');
      }

    } catch (e) {
      console.error('WebSocket消息解析错误:', e);
    }
  });

  // 断开连接
  ws.on('close', () => {
    if (ws.username && ws.room && rooms.has(ws.room)) {
      const room = rooms.get(ws.room);
      room.users.delete(ws.username);
      broadcast(ws.room, {
        type: 'system',
        room: ws.room,
        content: `${ws.username} 离开房间`
      });
      broadcast(ws.room, {
        type: 'online',
        room: ws.room,
        count: room.users.size
      });
    }
  });
});

// HTTP接口

// 注册
app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.json({ success: false, message: '用户名和密码不能为空' });
  }
  if (users.has(username)) {
    return res.json({ success: false, message: '用户名已存在' });
  }
  users.set(username, {
    password: hashPassword(password),
    avatar: username.charAt(0).toUpperCase(),
    ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
    loginTime: getBJTime(),
    muteRoom: false,
    mutePrivate: false
  });
  // 初始化好友列表
  friends.set(username, new Set());
  res.json({ success: true, message: '注册成功' });
});

// 登录
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!users.has(username)) {
    return res.json({ success: false, message: '用户名不存在' });
  }
  const user = users.get(username);
  if (user.password !== hashPassword(password)) {
    return res.json({ success: false, message: '密码错误' });
  }
  // 更新登录信息
  users.set(username, {
    ...user,
    ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
    loginTime: getBJTime()
  });
  res.json({
    success: true,
    data: { username, avatar: user.avatar }
  });
});

// 创建房间
app.post('/api/create-room', (req, res) => {
  const { username, name } = req.body;
  if (!name) return res.json({ success: false, message: '房间名不能为空' });
  if (rooms.has(name)) return res.json({ success: false, message: '房间已存在' });
  
  rooms.set(name, {
    owner: username,
    users: new Set(),
    muted: new Set(),
    messages: [],
    status: 'show' // 显示/隐藏
  });
  
  // 通知所有客户端更新房间列表
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'room_list_update' }));
    }
  });
  
  res.json({ success: true, message: '房间创建成功' });
});

// 获取所有房间
app.get('/api/all-rooms', (req, res) => {
  const roomList = [];
  rooms.forEach((value, key) => {
    roomList.push({
      name: key,
      owner: value.owner,
      userCount: value.users.size,
      status: value.status
    });
  });
  res.json({ success: true, rooms: roomList });
});

// 获取房间用户列表
app.get('/api/room-users', (req, res) => {
  const { room } = req.query;
  if (!room || !rooms.has(room)) {
    return res.json({ success: false, message: '房间不存在' });
  }
  const r = rooms.get(room);
  res.json({
    success: true,
    users: Array.from(r.users),
    count: r.users.size
  });
});

// 踢出用户
app.post('/api/kick', (req, res) => {
  const { owner, room, username } = req.body;
  if (!rooms.has(room)) return res.json({ success: false, message: '房间不存在' });
  const roomData = rooms.get(room);
  
  if (roomData.owner !== owner) {
    return res.json({ success: false, message: '只有群主可以踢出用户' });
  }
  
  if (!roomData.users.has(username)) {
    return res.json({ success: false, message: '用户不在房间内' });
  }
  
  // 踢出用户
  roomData.users.delete(username);
  // 通知被踢出用户
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client.username === username) {
      client.send(JSON.stringify({
        type: 'room_kicked',
        room,
        reason: '你被群主踢出房间'
      }));
      client.room = '';
    }
  });
  
  broadcast(room, {
    type: 'system',
    room,
    content: `${username} 被踢出房间`
  });
  
  res.json({ success: true, message: '踢出成功' });
});

// 禁言用户
app.post('/api/mute', (req, res) => {
  const { owner, room, username } = req.body;
  if (!rooms.has(room)) return res.json({ success: false, message: '房间不存在' });
  const roomData = rooms.get(room);
  
  if (roomData.owner !== owner) {
    return res.json({ success: false, message: '只有群主可以禁言用户' });
  }
  
  if (!roomData.users.has(username)) {
    return res.json({ success: false, message: '用户不在房间内' });
  }
  
  roomData.muted.add(username);
  
  // 通知被禁言用户
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client.username === username) {
      client.send(JSON.stringify({
        type: 'room_muted',
        message: '你已被群主禁言'
      }));
    }
  });
  
  broadcast(room, {
    type: 'system',
    room,
    content: `${username} 被禁言`
  });
  
  res.json({ success: true, message: '禁言成功' });
});

// 解除禁言
app.post('/api/unmute', (req, res) => {
  const { owner, room, username } = req.body;
  if (!rooms.has(room)) return res.json({ success: false, message: '房间不存在' });
  const roomData = rooms.get(room);
  
  if (roomData.owner !== owner) {
    return res.json({ success: false, message: '只有群主可以解除禁言' });
  }
  
  if (!roomData.muted.has(username)) {
    return res.json({ success: false, message: '该用户未被禁言' });
  }
  
  roomData.muted.delete(username);
  
  // 通知被解除禁言用户
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client.username === username) {
      client.send(JSON.stringify({
        type: 'room_unmuted',
        message: '你已被解除禁言'
      }));
    }
  });
  
  broadcast(room, {
    type: 'system',
    room,
    content: `${username} 被解除禁言`
  });
  
  res.json({ success: true, message: '解除禁言成功' });
});

// 清空房间消息
app.post('/api/clear-room', (req, res) => {
  const { owner, room } = req.body;
  if (!rooms.has(room)) return res.json({ success: false, message: '房间不存在' });
  const roomData = rooms.get(room);
  
  if (roomData.owner !== owner) {
    return res.json({ success: false, message: '只有群主可以清空聊天' });
  }
  
  roomData.messages = [];
  broadcast(room, {
    type: 'system',
    room,
    content: '聊天记录已被群主清空'
  });
  
  res.json({ success: true, message: '清空成功' });
});

// 解散房间
app.post('/api/dismiss-room', (req, res) => {
  const { owner, room } = req.body;
  if (!rooms.has(room)) return res.json({ success: false, message: '房间不存在' });
  const roomData = rooms.get(room);
  
  if (roomData.owner !== owner) {
    return res.json({ success: false, message: '只有群主可以解散房间' });
  }
  
  // 通知所有房间用户
  broadcast(room, {
    type: 'room_dismissed',
    room,
    message: '房间已被群主解散'
  });
  
  // 清空房间用户的room标识
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client.room === room) {
      client.room = '';
    }
  });
  
  rooms.delete(room);
  
  // 通知更新房间列表
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'room_list_update' }));
    }
  });
  
  res.json({ success: true, message: '房间已解散' });
});

// 获取房间聊天记录
app.get('/api/history', (req, res) => {
  const { room } = req.query;
  if (!rooms.has(room)) return res.json({ success: false, message: '房间不存在' });
  res.json({
    success: true,
    list: rooms.get(room).messages
  });
});

// 上传图片
app.post('/api/upload-image', upload.single('image'), (req, res) => {
  if (!req.file) {
    return res.json({ success: false, message: '请选择图片文件' });
  }
  res.json({
    success: true,
    url: '/uploads/' + req.file.filename
  });
});

// 添加好友
app.post('/api/add-friend', (req, res) => {
  const { from, to } = req.body;
  if (!users.has(to)) return res.json({ success: false, message: '用户不存在' });
  if (from === to) return res.json({ success: false, message: '不能添加自己为好友' });
  
  // 检查是否已是好友
  if (friends.has(from) && friends.get(from).has(to)) {
    return res.json({ success: false, message: '已是好友' });
  }
  
  // 保存好友申请
  if (!friendApplies.has(to)) friendApplies.set(to, []);
  // 去重
  const applies = friendApplies.get(to);
  if (applies.some(item => item.from === from)) {
    return res.json({ success: false, message: '已发送过申请' });
  }
  
  applies.push({ from, time: getBJTime() });
  
  // 通知被申请人
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client.username === to) {
      client.send(JSON.stringify({
        type: 'friend_apply',
        from
      }));
    }
  });
  
  res.json({ success: true, message: '好友申请已发送' });
});

// 获取好友申请
app.get('/api/friend-apply', (req, res) => {
  const { username } = req.query;
  const applies = friendApplies.get(username) || [];
  res.json({ success: true, list: applies });
});

// 同意好友
app.post('/api/agree-friend', (req, res) => {
  const { from, to } = req.body;
  
  // 移除申请
  if (friendApplies.has(to)) {
    const applies = friendApplies.get(to);
    friendApplies.set(to, applies.filter(item => item.from !== from));
  }
  
  // 添加好友关系（双向）
  if (!friends.has(from)) friends.set(from, new Set());
  friends.get(from).add(to);
  
  if (!friends.has(to)) friends.set(to, new Set());
  friends.get(to).add(from);
  
  // 通知双方
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      if (client.username === from) {
        client.send(JSON.stringify({
          type: 'friend_response',
          message: `${to} 同意了你的好友申请`
        }));
      }
      if (client.username === to) {
        client.send(JSON.stringify({
          type: 'friend_response',
          message: `已成功添加 ${from} 为好友`
        }));
      }
    }
  });
  
  // 通知更新好友列表
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && (client.username === from || client.username === to)) {
      client.send(JSON.stringify({ type: 'friend_list_update' }));
    }
  });
  
  res.json({ success: true, message: '添加好友成功' });
});

// 拒绝好友
app.post('/api/reject-friend', (req, res) => {
  const { from, to } = req.body;
  
  // 移除申请
  if (friendApplies.has(to)) {
    const applies = friendApplies.get(to);
    friendApplies.set(to, applies.filter(item => item.from !== from));
  }
  
  // 通知申请人
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client.username === from) {
      client.send(JSON.stringify({
        type: 'friend_response',
        message: `${to} 拒绝了你的好友申请`
      }));
    }
  });
  
  res.json({ success: true, message: '已拒绝好友申请' });
});

// 获取好友列表
app.get('/api/friend-list', (req, res) => {
  const { username } = req.query;
  const friendList = friends.has(username) ? Array.from(friends.get(username)) : [];
  res.json({ success: true, list: friendList });
});

// 删除好友
app.post('/api/delete-friend', (req, res) => {
  const { user, friend } = req.body;
  
  // 移除双向好友关系
  if (friends.has(user)) {
    friends.get(user).delete(friend);
  }
  if (friends.has(friend)) {
    friends.get(friend).delete(user);
  }
  
  // 通知对方
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client.username === friend) {
      client.send(JSON.stringify({
        type: 'friend_response',
        message: `${user} 已将你删除好友`
      }));
    }
  });
  
  // 通知更新好友列表
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && (client.username === user || client.username === friend)) {
      client.send(JSON.stringify({ type: 'friend_list_update' }));
    }
  });
  
  res.json({ success: true, message: '删除好友成功' });
});

// 发送私聊消息（备用接口）
app.post('/api/send-private', (req, res) => {
  const { sender, receiver, content } = req.body;
  sendPrivateMsg(sender, receiver, content);
  res.json({ success: true, message: '消息发送成功' });
});

// 获取私聊记录
app.get('/api/private-history', (req, res) => {
  const { user, friend } = req.query;
  const key = getPrivateKey(user, friend);
  const history = privateMessages.get(key) || [];
  res.json({ success: true, list: history });
});

// 修改昵称
app.post('/api/rename', (req, res) => {
  const { oldName, newName } = req.body;
  if (!users.has(oldName)) return res.json({ success: false, message: '用户不存在' });
  if (users.has(newName)) return res.json({ success: false, message: '昵称已被占用' });
  
  // 更新用户名
  const userData = users.get(oldName);
  users.delete(oldName);
  users.set(newName, userData);
  
  // 更新好友关系
  friends.forEach((friendSet, username) => {
    if (friendSet.has(oldName)) {
      friendSet.delete(oldName);
      friendSet.add(newName);
    }
  });
  if (friends.has(oldName)) {
    friends.set(newName, friends.get(oldName));
    friends.delete(oldName);
  }
  
  // 更新房间相关
  rooms.forEach((roomData, roomName) => {
    if (roomData.owner === oldName) {
      roomData.owner = newName;
    }
    if (roomData.users.has(oldName)) {
      roomData.users.delete(oldName);
      roomData.users.add(newName);
    }
    if (roomData.muted.has(oldName)) {
      roomData.muted.delete(oldName);
      roomData.muted.add(newName);
    }
  });
  
  // 通知客户端
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client.username === oldName) {
      client.username = newName;
      client.send(JSON.stringify({
        type: 'rename_success',
        newName
      }));
    }
  });
  
  res.json({ success: true, message: '昵称修改成功' });
});

// 删除账号
app.post('/api/delete-account', (req, res) => {
  const { username } = req.body;
  if (!users.has(username)) return res.json({ success: false, message: '用户不存在' });
  
  // 移除用户
  users.delete(username);
  
  // 移除好友关系
  friends.delete(username);
  friends.forEach((friendSet) => {
    friendSet.delete(username);
  });
  
  // 移除好友申请
  friendApplies.forEach((applies, to) => {
    friendApplies.set(to, applies.filter(item => item.from !== username));
  });
  friendApplies.delete(username);
  
  // 移除房间（如果是群主）
  rooms.forEach((roomData, roomName) => {
    if (roomData.owner === username) {
      rooms.delete(roomName);
    } else {
      roomData.users.delete(username);
      roomData.muted.delete(username);
    }
  });
  
  // 通知客户端
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client.username === username) {
      client.send(JSON.stringify({ type: 'account_deleted' }));
      client.close();
    }
  });
  
  res.json({ success: true, message: '账号已注销' });
});

// ====================== 管理员接口 ======================
// 验证管理员中间件
function adminAuth(req, res, next) {
  const token = req.headers['admin-token'];
  if (!token || !verifyAdminToken(token)) {
    return res.json({ success: false, message: '管理员验证失败' });
  }
  next();
}

// 仪表盘数据
app.get('/api/admin/dashboard', adminAuth, (req, res) => {
  // 在线用户
  let onlineCount = 0;
  const userIpList = [];
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client.username) {
      onlineCount++;
      const user = users.get(client.username);
      userIpList.push({
        username: client.username,
        ip: user?.ip || client._socket.remoteAddress,
        room: client.room || '',
        loginTime: user?.loginTime || getBJTime()
      });
    }
  });
  
  // 总消息数
  const totalMessages = allMessages.length;
  
  res.json({
    success: true,
    totalUsers: users.size,
    totalRooms: rooms.size,
    onlineUsers: onlineCount,
    totalMessages,
    userIpList
  });
});

// 获取所有聊天室
app.get('/api/admin/rooms', adminAuth, (req, res) => {
  const roomList = [];
  rooms.forEach((value, key) => {
    roomList.push({
      name: key,
      owner: value.owner,
      userCount: value.users.size,
      status: value.status
    });
  });
  res.json({ success: true, rooms: roomList });
});

// 新增聊天室
app.post('/api/admin/add-room', adminAuth, (req, res) => {
  const { name, owner } = req.body;
  if (!name || !owner) {
    return res.json({ success: false, message: '参数不能为空' });
  }
  if (rooms.has(name)) {
    return res.json({ success: false, message: '聊天室已存在' });
  }
  rooms.set(name, {
    owner,
    users: new Set(),
    muted: new Set(),
    messages: [],
    status: 'show'
  });
  // 通知更新
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'room_list_update' }));
    }
  });
  res.json({ success: true, message: '聊天室创建成功' });
});

// 编辑聊天室
app.post('/api/admin/edit-room', adminAuth, (req, res) => {
  const { oldName, newName, status } = req.body;
  if (!oldName || !newName || !status) {
    return res.json({ success: false, message: '参数不能为空' });
  }
  if (!rooms.has(oldName)) {
    return res.json({ success: false, message: '聊天室不存在' });
  }
  // 重命名
  if (oldName !== newName && rooms.has(newName)) {
    return res.json({ success: false, message: '新名称已存在' });
  }
  const roomData = rooms.get(oldName);
  rooms.delete(oldName);
  rooms.set(newName, {
    ...roomData,
    status
  });
  // 通知更新
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'room_list_update' }));
    }
  });
  res.json({ success: true, message: '聊天室编辑成功' });
});

// 删除聊天室
app.post('/api/admin/delete-room', adminAuth, (req, res) => {
  const { name } = req.body;
  if (!rooms.has(name)) {
    return res.json({ success: false, message: '聊天室不存在' });
  }
  // 通知用户
  broadcast(name, {
    type: 'room_dismissed',
    room: name,
    message: '房间已被管理员删除'
  });
  // 移除房间
  rooms.delete(name);
  // 通知更新
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'room_list_update' }));
    }
  });
  res.json({ success: true, message: '聊天室删除成功' });
});

// 获取所有用户
app.get('/api/admin/users', adminAuth, (req, res) => {
  const userList = [];
  users.forEach((value, key) => {
    userList.push({
      username: key,
      ip: value.ip,
      muteRoom: value.muteRoom,
      mutePrivate: value.mutePrivate,
      loginTime: value.loginTime
    });
  });
  res.json({ success: true, users: userList });
});

// 禁言用户
app.post('/api/admin/mute-user', adminAuth, (req, res) => {
  const { username, type } = req.body;
  if (!users.has(username)) {
    return res.json({ success: false, message: '用户不存在' });
  }
  const user = users.get(username);
  if (type === 'room' || type === 'all') {
    user.muteRoom = true;
  }
  if (type === 'private' || type === 'all') {
    user.mutePrivate = true;
  }
  users.set(username, user);
  // 通知用户
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client.username === username) {
      client.send(JSON.stringify({
        type: 'global_mute',
        status: {
          room: user.muteRoom,
          private: user.mutePrivate
        }
      }));
    }
  });
  res.json({ success: true, message: '禁言成功' });
});

// 解除禁言
app.post('/api/admin/unmute-user', adminAuth, (req, res) => {
  const { username, type } = req.body;
  if (!users.has(username)) {
    return res.json({ success: false, message: '用户不存在' });
  }
  const user = users.get(username);
  if (type === 'room' || type === 'all') {
    user.muteRoom = false;
  }
  if (type === 'private' || type === 'all') {
    user.mutePrivate = false;
  }
  users.set(username, user);
  // 通知用户
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client.username === username) {
      client.send(JSON.stringify({
        type: 'global_mute',
        status: {
          room: user.muteRoom,
          private: user.mutePrivate
        }
      }));
    }
  });
  res.json({ success: true, message: '解除禁言成功' });
});

// 获取消息记录
app.get('/api/admin/msg-records', adminAuth, (req, res) => {
  const { type, keywords } = req.query;
  let records = allMessages;
  // 筛选类型
  if (type) {
    records = records.filter(item => item.type === type);
  }
  // 筛选关键词
  if (keywords) {
    records = records.filter(item => item.content.includes(keywords));
  }
  res.json({ success: true, records });
});

// 发送公告
app.post('/api/admin/send-notice', adminAuth, (req, res) => {
  const { content } = req.body;
  if (!content) {
    return res.json({ success: false, message: '公告内容不能为空' });
  }
  broadcastAdminNotice(content);
  res.json({ success: true, message: '公告发送成功' });
});

// 发送管理员消息
app.post('/api/admin/send-msg', adminAuth, (req, res) => {
  const { type, target, content } = req.body;
  if (!content) {
    return res.json({ success: false, message: '消息内容不能为空' });
  }
  sendAdminMsg(type, target, content);
  res.json({ success: true, message: '管理员消息发送成功' });
});

// 下载数据库
app.get('/api/admin/download-db', adminAuth, (req, res) => {
  const dbData = {
    users: Object.fromEntries(users),
    rooms: Object.fromEntries(Array.from(rooms.entries()).map(([k, v]) => [k, {
      ...v,
      users: Array.from(v.users),
      muted: Array.from(v.muted)
    }])),
    friends: Object.fromEntries(Array.from(friends.entries()).map(([k, v]) => [k, Array.from(v)])),
    friendApplies: Object.fromEntries(friendApplies),
    privateMessages: Object.fromEntries(privateMessages),
    allMessages
  };
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename=chat-db-${Date.now()}.json`);
  res.send(JSON.stringify(dbData, null, 2));
});

// 启动服务器
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`服务器运行在 http://localhost:${PORT}`);
});
