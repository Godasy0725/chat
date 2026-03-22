const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const bodyParser = require('body-parser');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// 中间件
app.use(cors());
app.use(bodyParser.json());

// 内存数据库（实际项目建议用MongoDB/MySQL）
const users = new Map(); // { username: { password, avatar } }
const rooms = new Map(); // { roomName: { owner, users: Set, muted: Set, messages: Array } }
const friendApplies = new Map(); // { to: [{ from, time }] }
const friends = new Map(); // { user: Set(friends) }
const privateMessages = new Map(); // { "user1-user2": Array }

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

// 修复后的 sendPrivateMsg 函数（逻辑不变，仅确保只被调用一次）
function sendPrivateMsg(sender, receiver, content) {
  // 1. 推送给接收方（仅一次）
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
  // 2. 保存私聊记录（仅一次）
  const key = getPrivateKey(sender, receiver);
  if (!privateMessages.has(key)) privateMessages.set(key, []);
  privateMessages.get(key).push({
    sender,
    receiver,
    content,
    time: new Date().toISOString()
  });
}

// 修复 /api/send-private 接口（可选：要么删除，要么仅存储不推送）
app.post('/api/send-private', (req, res) => {
  const { sender, receiver, content } = req.body;
  // 仅保存记录，不推送（避免重复）
  const key = getPrivateKey(sender, receiver);
  if (!privateMessages.has(key)) privateMessages.set(key, []);
  privateMessages.get(key).push({
    sender,
    receiver,
    content,
    time: new Date().toISOString()
  });
  res.json({ success: true, message: '消息发送成功' });
});

// WebSocket处理私聊消息（核心推送逻辑）
wss.on('connection', (ws) => {
  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);
      // 私聊消息处理（仅推送+存储一次）
      if (data.type === 'private_msg') {
        sendPrivateMsg(data.sender, data.receiver, data.content);
      }
    } catch (e) {
      console.error('WebSocket消息解析错误:', e);
    }
  });
});

// WebSocket连接
wss.on('connection', (ws) => {
  ws.username = '';
  ws.room = '';

  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);
      
      // 登录
      if (data.type === 'login') {
        ws.username = data.username;
        ws.send(JSON.stringify({ type: 'login_success', username: data.username }));
      }

      // 切换房间
      if (data.type === 'switch_room') {
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
        
        // 检查是否被禁言
        if (room.muted.has(data.username)) {
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

      // 发送私聊消息
      if (data.type === 'private_msg') {
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
    avatar: username.charAt(0).toUpperCase()
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
    messages: []
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
      userCount: value.users.size
    });
  });
  res.json({ success: true, rooms: roomList });
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

// 解除禁言（新增）
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
  
  applies.push({ from, time: new Date().toISOString() });
  
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

// 删除好友（新增）
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

// 启动服务器
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`服务器运行在 http://localhost:${PORT}`);
});
