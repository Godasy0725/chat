const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// 中间件
app.use(cors());
app.use(bodyParser.json());

// 内存数据库扩展（增加管理员和IP记录）
const users = new Map(); // { username: { password, avatar, ip, muted: { room: [], private: boolean, all: boolean } } }
const rooms = new Map(); // { roomName: { owner, users: Set, muted: Set, messages: Array, status: 'show'/'hidden' } }
const friendApplies = new Map(); // { to: [{ from, time }] }
const friends = new Map(); // { user: Set(friends) }
const privateMessages = new Map(); // { "user1-user2": Array }
const userIPs = new Map(); // { username: ip }
const announcements = []; // 系统公告
const ADMIN_PASSWORD = 'Lmx%%112233'; // 管理员密码

// 工具函数
function hashPassword(pwd) {
  return crypto.createHash('md5').update(pwd).digest('hex');
}

function getPrivateKey(user1, user2) {
  return [user1, user2].sort().join('-');
}

// 广播消息到房间
function broadcast(room, data) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client.room === room) {
      client.send(JSON.stringify(data));
    }
  });
}

// 广播到所有在线用户
function broadcastAll(data) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

// 发送私聊消息
function sendPrivateMsg(sender, receiver, content) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client.username === receiver) {
      client.send(JSON.stringify({
        type: 'private_msg',
        sender,
        receiver,
        content
      }));
    }
  });
  // 保存私聊记录
  const key = getPrivateKey(sender, receiver);
  if (!privateMessages.has(key)) privateMessages.set(key, []);
  privateMessages.get(key).push({
    sender,
    receiver,
    content,
    time: new Date().toISOString()
  });
}

// 管理员权限校验中间件
function checkAdmin(req, res, next) {
  const { password } = req.body;
  if (hashPassword(password) !== hashPassword(ADMIN_PASSWORD)) {
    return res.json({ success: false, message: '管理员密码错误' });
  }
  next();
}

// WebSocket连接（增加IP记录）
wss.on('connection', (ws, req) => {
  ws.username = '';
  ws.room = '';
  // 获取客户端真实IP
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  ws.ip = ip.replace('::ffff:', ''); // 格式化IPv6地址

  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);
      
      // 登录 - 记录IP
      if (data.type === 'login') {
        ws.username = data.username;
        userIPs.set(data.username, ws.ip);
        // 更新用户IP信息
        if (users.has(data.username)) {
          const user = users.get(data.username);
          user.ip = ws.ip;
          users.set(data.username, user);
        }
        ws.send(JSON.stringify({ type: 'login_success', username: data.username }));
      }

      // 切换房间
      if (data.type === 'switch_room') {
        // 检查房间是否隐藏
        const room = rooms.get(data.room);
        if (!room || room.status === 'hidden') {
          ws.send(JSON.stringify({ type: 'error', message: '房间不存在或已隐藏' }));
          return;
        }
        
        ws.room = data.room;
        room.users.add(data.username);
        broadcast(data.room, {
          type: 'system',
          room: data.room,
          content: `${data.username} 加入房间`
        });
        broadcast(data.room, {
          type: 'online',
          room: data.room,
          count: room.users.size
        });
      }

      // 发送群消息 - 检查禁言
      if (data.type === 'chat') {
        const room = rooms.get(data.room);
        if (!room) return;
        
        // 检查全局禁言/房间禁言
        const user = users.get(data.username) || { muted: { room: [], private: false, all: false } };
        if (user.muted.all || user.muted.room.includes(data.room) || room.muted.has(data.username)) {
          ws.send(JSON.stringify({
            type: 'room_muted',
            message: '你已被禁言，无法发送消息'
          }));
          return;
        }

        // 保存消息并广播
        room.messages.push({
          username: data.username,
          content: data.content,
          time: new Date().toISOString()
        });
        broadcast(data.room, {
          type: 'chat',
          room: data.room,
          username: data.username,
          content: data.content,
          time: new Date().toISOString()
        });
      }

      // 发送私聊消息 - 检查禁言
      if (data.type === 'private_msg') {
        const user = users.get(data.sender) || { muted: { room: [], private: false, all: false } };
        if (user.muted.all || user.muted.private) {
          ws.send(JSON.stringify({
            type: 'private_muted',
            message: '你已被禁言，无法发送私聊消息'
          }));
          return;
        }
        sendPrivateMsg(data.sender, data.receiver, data.content);
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

// ====================== 原有接口（保持不变） ======================
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
    ip: '',
    muted: { room: [], private: false, all: false }
  });
  friends.set(username, new Set());
  res.json({ success: true, message: '注册成功' });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!users.has(username)) {
    return res.json({ success: false, message: '用户名不存在' });
  }
  const user = users.get(username);
  if (user.password !== hashPassword(password)) {
    return res.json({ success: false, message: '密码错误' });
  }
  res.json({
    success: true,
    data: { username, avatar: user.avatar }
  });
});

app.post('/api/create-room', (req, res) => {
  const { username, name } = req.body;
  if (!name) return res.json({ success: false, message: '房间名不能为空' });
  if (rooms.has(name)) return res.json({ success: false, message: '房间已存在' });
  
  rooms.set(name, {
    owner: username,
    users: new Set(),
    muted: new Set(),
    messages: [],
    status: 'show' // 新增状态：show/hidden
  });
  
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'room_list_update' }));
    }
  });
  
  res.json({ success: true, message: '房间创建成功' });
});

app.get('/api/all-rooms', (req, res) => {
  const roomList = [];
  rooms.forEach((value, key) => {
    // 只返回显示的房间
    if (value.status === 'show') {
      roomList.push({
        name: key,
        owner: value.owner,
        userCount: value.users.size
      });
    }
  });
  res.json({ success: true, rooms: roomList });
});

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
  
  roomData.users.delete(username);
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

app.post('/api/dismiss-room', (req, res) => {
  const { owner, room } = req.body;
  if (!rooms.has(room)) return res.json({ success: false, message: '房间不存在' });
  const roomData = rooms.get(room);
  
  if (roomData.owner !== owner) {
    return res.json({ success: false, message: '只有群主可以解散房间' });
  }
  
  broadcast(room, {
    type: 'room_dismissed',
    room,
    message: '房间已被群主解散'
  });
  
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client.room === room) {
      client.room = '';
    }
  });
  
  rooms.delete(room);
  
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'room_list_update' }));
    }
  });
  
  res.json({ success: true, message: '房间已解散' });
});

app.get('/api/history', (req, res) => {
  const { room } = req.query;
  if (!rooms.has(room)) return res.json({ success: false, message: '房间不存在' });
  res.json({
    success: true,
    list: rooms.get(room).messages
  });
});

app.post('/api/add-friend', (req, res) => {
  const { from, to } = req.body;
  if (!users.has(to)) return res.json({ success: false, message: '用户不存在' });
  if (from === to) return res.json({ success: false, message: '不能添加自己为好友' });
  
  if (friends.has(from) && friends.get(from).has(to)) {
    return res.json({ success: false, message: '已是好友' });
  }
  
  if (!friendApplies.has(to)) friendApplies.set(to, []);
  const applies = friendApplies.get(to);
  if (applies.some(item => item.from === from)) {
    return res.json({ success: false, message: '已发送过申请' });
  }
  
  applies.push({ from, time: new Date().toISOString() });
  
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

app.get('/api/friend-apply', (req, res) => {
  const { username } = req.query;
  const applies = friendApplies.get(username) || [];
  res.json({ success: true, list: applies });
});

app.post('/api/agree-friend', (req, res) => {
  const { from, to } = req.body;
  
  if (friendApplies.has(to)) {
    const applies = friendApplies.get(to);
    friendApplies.set(to, applies.filter(item => item.from !== from));
  }
  
  if (!friends.has(from)) friends.set(from, new Set());
  friends.get(from).add(to);
  
  if (!friends.has(to)) friends.set(to, new Set());
  friends.get(to).add(from);
  
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
  
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && (client.username === from || client.username === to)) {
      client.send(JSON.stringify({ type: 'friend_list_update' }));
    }
  });
  
  res.json({ success: true, message: '添加好友成功' });
});

app.post('/api/reject-friend', (req, res) => {
  const { from, to } = req.body;
  
  if (friendApplies.has(to)) {
    const applies = friendApplies.get(to);
    friendApplies.set(to, applies.filter(item => item.from !== from));
  }
  
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

app.get('/api/friend-list', (req, res) => {
  const { username } = req.query;
  const friendList = friends.has(username) ? Array.from(friends.get(username)) : [];
  res.json({ success: true, list: friendList });
});

app.post('/api/delete-friend', (req, res) => {
  const { user, friend } = req.body;
  
  if (friends.has(user)) {
    friends.get(user).delete(friend);
  }
  if (friends.has(friend)) {
    friends.get(friend).delete(user);
  }
  
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client.username === friend) {
      client.send(JSON.stringify({
        type: 'friend_response',
        message: `${user} 已将你删除好友`
      }));
    }
  });
  
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && (client.username === user || client.username === friend)) {
      client.send(JSON.stringify({ type: 'friend_list_update' }));
    }
  });
  
  res.json({ success: true, message: '删除好友成功' });
});

app.post('/api/send-private', (req, res) => {
  const { sender, receiver, content } = req.body;
  sendPrivateMsg(sender, receiver, content);
  res.json({ success: true, message: '消息发送成功' });
});

app.get('/api/private-history', (req, res) => {
  const { user, friend } = req.query;
  const key = getPrivateKey(user, friend);
  const history = privateMessages.get(key) || [];
  res.json({ success: true, list: history });
});

app.post('/api/rename', (req, res) => {
  const { oldName, newName } = req.body;
  if (!users.has(oldName)) return res.json({ success: false, message: '用户不存在' });
  if (users.has(newName)) return res.json({ success: false, message: '昵称已被占用' });
  
  const userData = users.get(oldName);
  users.delete(oldName);
  users.set(newName, userData);
  
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

app.post('/api/delete-account', (req, res) => {
  const { username } = req.body;
  if (!users.has(username)) return res.json({ success: false, message: '用户不存在' });
  
  users.delete(username);
  
  friends.delete(username);
  friends.forEach((friendSet) => {
    friendSet.delete(username);
  });
  
  friendApplies.forEach((applies, to) => {
    friendApplies.set(to, applies.filter(item => item.from !== username));
  });
  friendApplies.delete(username);
  
  rooms.forEach((roomData, roomName) => {
    if (roomData.owner === username) {
      rooms.delete(roomName);
    } else {
      roomData.users.delete(username);
      roomData.muted.delete(username);
    }
  });
  
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client.username === username) {
      client.send(JSON.stringify({ type: 'account_deleted' }));
      client.close();
    }
  });
  
  res.json({ success: true, message: '账号已注销' });
});

// ====================== 新增管理员接口 ======================
// 管理员登录
app.post('/api/admin/login', checkAdmin, (req, res) => {
  res.json({ success: true, message: '管理员登录成功' });
});

// 用户仪表盘数据
app.get('/api/admin/dashboard', (req, res) => {
  const userList = [];
  users.forEach((user, username) => {
    // 计算用户加入的房间数
    let roomCount = 0;
    rooms.forEach((room) => {
      if (room.users.has(username)) roomCount++;
    });
    // 好友数
    const friendCount = friends.has(username) ? friends.get(username).size : 0;
    // 在线状态
    let online = false;
    wss.clients.forEach(client => {
      if (client.username === username && client.readyState === WebSocket.OPEN) {
        online = true;
      }
    });
    
    userList.push({
      username,
      ip: user.ip || userIPs.get(username) || '未知',
      online,
      roomCount,
      friendCount,
      muted: user.muted.all || user.muted.private || user.muted.room.length > 0
    });
  });
  res.json({ success: true, users: userList });
});

// 获取所有聊天室（包括隐藏的）
app.get('/api/admin/rooms', (req, res) => {
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

// 获取所有用户
app.get('/api/admin/users', (req, res) => {
  const userList = [];
  users.forEach((user, username) => {
    userList.push({
      username,
      ip: user.ip || userIPs.get(username) || '未知',
      muted: user.muted.all || user.muted.private || user.muted.room.length > 0
    });
  });
  res.json({ success: true, users: userList });
});

// 新增聊天室
app.post('/api/admin/add-room', (req, res) => {
  const { name, owner } = req.body;
  if (!name || !owner) {
    return res.json({ success: false, message: '房间名和群主不能为空' });
  }
  if (rooms.has(name)) {
    return res.json({ success: false, message: '房间已存在' });
  }
  if (!users.has(owner)) {
    return res.json({ success: false, message: '群主用户不存在' });
  }
  
  rooms.set(name, {
    owner,
    users: new Set(),
    muted: new Set(),
    messages: [],
    status: 'show'
  });
  
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'room_list_update' }));
    }
  });
  
  res.json({ success: true, message: '聊天室创建成功' });
});

// 重命名聊天室
app.post('/api/admin/rename-room', (req, res) => {
  const { oldName, newName } = req.body;
  if (!rooms.has(oldName)) {
    return res.json({ success: false, message: '原房间不存在' });
  }
  if (rooms.has(newName)) {
    return res.json({ success: false, message: '新房间名已存在' });
  }
  
  // 复制房间数据
  const roomData = rooms.get(oldName);
  rooms.delete(oldName);
  rooms.set(newName, roomData);
  
  // 更新用户的房间信息
  wss.clients.forEach(client => {
    if (client.room === oldName) {
      client.room = newName;
    }
  });
  
  res.json({ success: true, message: '聊天室重命名成功' });
});

// 切换聊天室状态（显示/隐藏）
app.post('/api/admin/toggle-room', (req, res) => {
  const { name, status } = req.body;
  if (!rooms.has(name)) {
    return res.json({ success: false, message: '房间不存在' });
  }
  
  const roomData = rooms.get(name);
  roomData.status = status;
  rooms.set(name, roomData);
  
  // 通知客户端更新房间列表
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'room_list_update' }));
    }
  });
  
  res.json({ success: true, message: `聊天室已${status === 'show' ? '显示' : '隐藏'}` });
});

// 删除聊天室
app.post('/api/admin/delete-room', (req, res) => {
  const { name } = req.body;
  if (!rooms.has(name)) {
    return res.json({ success: false, message: '房间不存在' });
  }
  
  // 通知房间内用户
  broadcast(name, {
    type: 'room_dismissed',
    room: name,
    message: '房间已被管理员删除'
  });
  
  // 清空用户房间标识
  wss.clients.forEach(client => {
    if (client.room === name) {
      client.room = '';
    }
  });
  
  rooms.delete(name);
  
  // 更新房间列表
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'room_list_update' }));
    }
  });
  
  res.json({ success: true, message: '聊天室删除成功' });
});

// 禁言/解除禁言用户
app.post('/api/admin/mute-user', (req, res) => {
  const { username, type, room } = req.body;
  if (!users.has(username)) {
    return res.json({ success: false, message: '用户不存在' });
  }
  
  const user = users.get(username);
  // 切换禁言状态
  if (type === 'all') {
    user.muted.all = !user.muted.all;
  } else if (type === 'private') {
    user.muted.private = !user.muted.private;
  } else if (type === 'room' && room) {
    const index = user.muted.room.indexOf(room);
    if (index > -1) {
      user.muted.room.splice(index, 1);
    } else {
      user.muted.room.push(room);
    }
  }
  
  users.set(username, user);
  
  // 通知用户
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client.username === username) {
      const action = (type === 'all' && user.muted.all) || 
                     (type === 'private' && user.muted.private) || 
                     (type === 'room' && user.muted.room.includes(room)) ? '禁言' : '解除禁言';
      client.send(JSON.stringify({
        type: 'admin_mute',
        message: `你已被管理员${action}(${type === 'room' ? '房间：'+room : type})`
      }));
    }
  });
  
  res.json({ success: true, message: `用户${user.muted.all || (type === 'private' && user.muted.private) || (type === 'room' && user.muted.room.includes(room)) ? '禁言' : '解除禁言'}成功` });
});

// 删除用户
app.post('/api/admin/delete-user', (req, res) => {
  const { username } = req.body;
  if (!users.has(username)) {
    return res.json({ success: false, message: '用户不存在' });
  }
  
  // 执行原有删除账号逻辑
  users.delete(username);
  friends.delete(username);
  friends.forEach((friendSet) => {
    friendSet.delete(username);
  });
  friendApplies.forEach((applies, to) => {
    friendApplies.set(to, applies.filter(item => item.from !== username));
  });
  friendApplies.delete(username);
  rooms.forEach((roomData, roomName) => {
    roomData.users.delete(username);
    roomData.muted.delete(username);
  });
  
  // 断开用户连接
  wss.clients.forEach(client => {
    if (client.username === username) {
      client.close();
    }
  });
  
  res.json({ success: true, message: '用户删除成功' });
});

// 发送系统公告
app.post('/api/admin/send-announcement', (req, res) => {
  const { content } = req.body;
  if (!content) {
    return res.json({ success: false, message: '公告内容不能为空' });
  }
  
  // 保存公告
  announcements.push({
    content,
    time: new Date().toISOString()
  });
  
  // 广播公告
  broadcastAll({
    type: 'system_announcement',
    content,
    time: new Date().toISOString()
  });
  
  res.json({ success: true, message: '公告发送成功' });
});

// 发送管理员消息
app.post('/api/admin/send-msg', (req, res) => {
  const { type, room, user, content } = req.body;
  
  if (type === 'room') {
    // 发送到指定房间（带管理员标识）
    broadcast(room, {
      type: 'chat',
      username: '[管理员]',
      content,
      room,
      time: new Date().toISOString()
    });
    // 保存到房间记录
    const roomData = rooms.get(room);
    if (roomData) {
      roomData.messages.push({
        username: '[管理员]',
        content,
        time: new Date().toISOString()
      });
    }
  } else if (type === 'private') {
    // 发送私聊（带管理员标识）
    sendPrivateMsg('[管理员]', user, content);
  } else if (type === 'all') {
    // 发送到所有在线用户
    broadcastAll({
      type: 'system',
      content: `[管理员] ${content}`,
      time: new Date().toISOString()
    });
  }
  
  res.json({ success: true, message: '管理员消息发送成功' });
});

// 下载数据库
app.get('/api/admin/download-db', (req, res) => {
  // 转换Map为普通对象
  const dbData = {
    users: Object.fromEntries(users),
    rooms: Object.fromEntries(rooms),
    friends: Object.fromEntries(friends),
    privateMessages: Object.fromEntries(privateMessages),
    announcements,
    friendApplies: Object.fromEntries(friendApplies),
    exportTime: new Date().toISOString()
  };
  
  // 转换为JSON并下载
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename=chat-db-${Date.now()}.json`);
  res.send(JSON.stringify(dbData, null, 2));
});

// 备份数据库
app.post('/api/admin/backup-db', (req, res) => {
  const dbData = {
    users: Object.fromEntries(users),
    rooms: Object.fromEntries(rooms),
    friends: Object.fromEntries(friends),
    privateMessages: Object.fromEntries(privateMessages),
    announcements,
    friendApplies: Object.fromEntries(friendApplies),
    backupTime: new Date().toISOString()
  };
  
  const backupDir = path.join(__dirname, 'backups');
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir);
  }
  
  const backupPath = path.join(backupDir, `chat-backup-${Date.now()}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(dbData, null, 2));
  
  res.json({ success: true, message: '数据库备份成功', path: backupPath });
});

// 启动服务器
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`服务器运行在 http://localhost:${PORT}`);
  console.log(`管理员后台地址: http://localhost:${PORT}/admin.html`);
});
