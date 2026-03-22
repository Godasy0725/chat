const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// 管理员密码
const ADMIN_PASSWORD = 'Lmx%%112233';

// 全局在线用户（存IP、房间、用户名）
const onlineUsers = new Map(); // username => { ws, ip, room }

// 数据库初始化（永久存储）
const db = new sqlite3.Database('./chat.db', (err) => {
  if (err) console.error('DB打开失败:', err);
  else console.log('SQLite 已连接');
});

// 创建表
db.run(`
CREATE TABLE IF NOT EXISTS users (
  username TEXT PRIMARY KEY,
  password TEXT NOT NULL
)`);

db.run(`
CREATE TABLE IF NOT EXISTS rooms (
  name TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  mute INTEGER DEFAULT 0,
  show INTEGER DEFAULT 1
)`);

db.run(`
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room TEXT,
  username TEXT,
  content TEXT,
  isAdmin INTEGER DEFAULT 0,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

db.run(`
CREATE TABLE IF NOT EXISTS private_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender TEXT,
  receiver TEXT,
  content TEXT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

db.run(`
CREATE TABLE IF NOT EXISTS friends (
  user1 TEXT, user2 TEXT,
  PRIMARY KEY (user1, user2)
)`);

db.run(`
CREATE TABLE IF NOT EXISTS friend_requests (
  fromUser TEXT, toUser TEXT,
  PRIMARY KEY (fromUser, toUser)
)`);

db.run(`
CREATE TABLE IF NOT EXISTS announce (
  id INTEGER PRIMARY KEY DEFAULT 1,
  content TEXT
)`);

// 中间件
app.use(express.json());
app.use(express.static(path.join(__dirname, './')));

// 工具：广播
function broadcast(data) {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

// 工具：给某人发
function sendToUser(username, data) {
  const u = onlineUsers.get(username);
  if (u && u.ws && u.ws.readyState === WebSocket.OPEN) {
    u.ws.send(JSON.stringify(data));
  }
}

// ------------------------------
// 用户接口
// ------------------------------

// 注册
app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.json({ success: false, message: '参数错误' });
  db.get('SELECT * FROM users WHERE username = ?', [username], (err, row) => {
    if (row) return res.json({ success: false, message: '用户已存在' });
    db.run('INSERT INTO users (username, password) VALUES (?, ?)', [username, password], (err) => {
      res.json({ success: true, message: '注册成功' });
    });
  });
});

// 登录
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  db.get('SELECT * FROM users WHERE username = ? AND password = ?', [username, password], (err, row) => {
    if (!row) return res.json({ success: false, message: '账号或密码错误' });
    res.json({ success: true, data: { username } });
  });
});

// 创建房间
app.post('/api/create-room', (req, res) => {
  const { username, name } = req.body;
  db.get('SELECT * FROM rooms WHERE name = ?', [name], (err, row) => {
    if (row) return res.json({ success: false, message: '房间已存在' });
    db.run('INSERT INTO rooms (name, owner) VALUES (?, ?)', [name, username], () => {
      broadcast({ type: 'room_list_update' });
      res.json({ success: true, message: '创建成功' });
    });
  });
});

// 获取所有房间
app.get('/api/all-rooms', (req, res) => {
  db.all('SELECT * FROM rooms', [], (err, rows) => {
    res.json({ success: true, rooms: rows });
  });
});

// 历史消息
app.get('/api/history', (req, res) => {
  const room = req.query.room;
  db.all('SELECT * FROM messages WHERE room = ? ORDER BY id ASC', [room], (err, rows) => {
    res.json({ list: rows });
  });
});

// 私聊历史
app.get('/api/private-history', (req, res) => {
  const { user, friend } = req.query;
  db.all(`
    SELECT * FROM private_messages
    WHERE (sender=? AND receiver=?) OR (sender=? AND receiver=?)
    ORDER BY id ASC
  `, [user, friend, friend, user], (err, rows) => {
    res.json({ list: rows });
  });
});

// 好友申请
app.post('/api/add-friend', (req, res) => {
  const { from, to } = req.body;
  db.get('SELECT * FROM users WHERE username = ?', [to], (err, row) => {
    if (!row) return res.json({ success: false, message: '用户不存在' });
    db.run('INSERT OR IGNORE INTO friend_requests (fromUser, toUser) VALUES (?, ?)', [from, to], () => {
      sendToUser(to, { type: 'friend_apply' });
      res.json({ success: true, message: '已发送' });
    });
  });
});

app.get('/api/friend-apply', (req, res) => {
  const username = req.query.username;
  db.all('SELECT fromUser FROM friend_requests WHERE toUser = ?', [username], (err, rows) => {
    res.json({ list: rows.map(r => ({ from: r.fromUser })) });
  });
});

app.post('/api/agree-friend', (req, res) => {
  const { from, to } = req.body;
  db.run('INSERT OR IGNORE INTO friends (user1, user2) VALUES (?, ?)', [from, to]);
  db.run('INSERT OR IGNORE INTO friends (user1, user2) VALUES (?, ?)', [to, from]);
  db.run('DELETE FROM friend_requests WHERE fromUser=? AND toUser=?', [from, to]);
  res.json({ success: true, message: '已同意' });
});

app.post('/api/reject-friend', (req, res) => {
  const { from, to } = req.body;
  db.run('DELETE FROM friend_requests WHERE fromUser=? AND toUser=?', [from, to]);
  res.json({ success: true, message: '已拒绝' });
});

app.get('/api/friend-list', (req, res) => {
  const username = req.query.username;
  db.all('SELECT user2 FROM friends WHERE user1=?', [username], (err, rows) => {
    res.json({ list: rows.map(r => r.user2) });
  });
});

// 踢人
app.post('/api/kick', (req, res) => {
  const { owner, room, username } = req.body;
  db.get('SELECT * FROM rooms WHERE name=? AND owner=?', [room, owner], (err, row) => {
    if (!row) return res.json({ success: false, message: '非房主' });
    sendToUser(username, { type: 'kick', reason: '你被踢出房间' });
    res.json({ success: true, message: '已踢出' });
  });
});

// 禁言
app.post('/api/mute', (req, res) => {
  const { owner, room, username } = req.body;
  db.get('SELECT * FROM rooms WHERE name=? AND owner=?', [room, owner], (err, row) => {
    if (!row) return res.json({ success: false, message: '非房主' });
    sendToUser(username, { type: 'room_muted' });
    res.json({ success: true, message: '已禁言' });
  });
});

// 清空房间消息
app.post('/api/clear-room', (req, res) => {
  const { room } = req.body;
  db.run('DELETE FROM messages WHERE room = ?', [room], () => {
    broadcast({ type: 'system', room, content: '房间消息已清空' });
    res.json({ success: true });
  });
});

// 解散房间
app.post('/api/dismiss-room', (req, res) => {
  const { owner, room } = req.body;
  db.get('SELECT * FROM rooms WHERE name=? AND owner=?', [room, owner], (err, row) => {
    if (!row) return res.json({ success: false });
    db.run('DELETE FROM rooms WHERE name=?', [room]);
    db.run('DELETE FROM messages WHERE room=?', [room]);
    broadcast({ type: 'room_dismissed', room });
    broadcast({ type: 'room_list_update' });
    res.json({ success: true });
  });
});

// 修改昵称
app.post('/api/rename', (req, res) => {
  const { oldName, newName } = req.body;
  db.get('SELECT * FROM users WHERE username=?', [newName], (err, row) => {
    if (row) return res.json({ success: false, message: '已存在' });
    db.run('UPDATE users SET username=? WHERE username=?', [newName, oldName]);
    db.run('UPDATE messages SET username=? WHERE username=?', [newName, oldName]);
    db.run('UPDATE friends SET user1=? WHERE user1=?', [newName, oldName]);
    db.run('UPDATE friends SET user2=? WHERE user2=?', [newName, oldName]);
    res.json({ success: true });
  });
});

// 注销账号
app.post('/api/delete-account', (req, res) => {
  const { username } = req.body;
  db.run('DELETE FROM users WHERE username=?', [username]);
  db.run('DELETE FROM messages WHERE username=?', [username]);
  db.run('DELETE FROM friends WHERE user1=? OR user2=?', [username, username]);
  res.json({ success: true });
});

// 公告
app.get('/api/announce', (req, res) => {
  db.get('SELECT content FROM announce WHERE id=1', (err, row) => {
    res.json({ success: true, content: row?.content || '' });
  });
});

// ------------------------------
// 管理员接口（你要的全部功能）
// ------------------------------

// 管理员验证
function adminAuth(req, res, next) {
  const pwd = req.body.password || req.query.password;
  if (pwd !== ADMIN_PASSWORD) return res.status(403).json({ success: false });
  next();
}

// 房间管理
app.get('/api/admin/rooms', adminAuth, (req, res) => {
  db.all('SELECT * FROM rooms', [], (err, rows) => {
    res.json({ rooms: rows });
  });
});

app.post('/api/admin/create-room', adminAuth, (req, res) => {
  const { name } = req.body;
  db.run('INSERT OR IGNORE INTO rooms (name, owner) VALUES (?, ?)', [name, 'admin']);
  broadcast({ type: 'room_list_update' });
  res.json({ success: true });
});

app.post('/api/admin/rename-room', adminAuth, (req, res) => {
  const { oldName, newName } = req.body;
  db.run('UPDATE rooms SET name=? WHERE name=?', [newName, oldName]);
  db.run('UPDATE messages SET room=? WHERE room=?', [newName, oldName]);
  broadcast({ type: 'room_list_update' });
  res.json({ success: true });
});

app.post('/api/admin/delete-room', adminAuth, (req, res) => {
  const { room } = req.body;
  db.run('DELETE FROM rooms WHERE name=?', [room]);
  db.run('DELETE FROM messages WHERE room=?', [room]);
  broadcast({ type: 'room_list_update' });
  res.json({ success: true });
});

app.post('/api/admin/toggle-mute', adminAuth, (req, res) => {
  const { room, mute } = req.body;
  db.run('UPDATE rooms SET mute=? WHERE name=?', [mute ? 1 : 0, room]);
  res.json({ success: true });
});

app.post('/api/admin/toggle-show', adminAuth, (req, res) => {
  const { room, show } = req.body;
  db.run('UPDATE rooms SET show=? WHERE name=?', [show ? 1 : 0, room]);
  broadcast({ type: 'room_list_update' });
  res.json({ success: true });
});

// 在线用户 & IP
app.get('/api/admin/online-users', adminAuth, (req, res) => {
  const list = [];
  onlineUsers.forEach((info, user) => {
    list.push({
      username: user,
      ip: info.ip || 'unknown',
      room: info.room || ''
    });
  });
  res.json({ users: list });
});

// 踢下线
app.post('/api/admin/kick-user', adminAuth, (req, res) => {
  const { username } = req.body;
  sendToUser(username, { type: 'kick', reason: '管理员踢你下线' });
  res.json({ success: true });
});

// 聊天记录
app.get('/api/admin/chat-records', adminAuth, (req, res) => {
  const room = req.query.room;
  db.all('SELECT * FROM messages WHERE room=? ORDER BY id DESC', [room], (err, rows) => {
    res.json({ records: rows });
  });
});

app.post('/api/admin/delete-chat-record', adminAuth, (req, res) => {
  const { id } = req.body;
  db.run('DELETE FROM messages WHERE id=?', [id]);
  res.json({ success: true });
});

// 私聊记录查看
app.get('/api/admin/private-records', adminAuth, (req, res) => {
  const { user1, user2 } = req.query;
  db.all(`
    SELECT * FROM private_messages
    WHERE (sender=? AND receiver=?) OR (sender=? AND receiver=?)
    ORDER BY id DESC
  `, [user1, user2, user2, user1], (err, rows) => {
    res.json({ records: rows });
  });
});

// 发布公告
app.post('/api/admin/announce', adminAuth, (req, res) => {
  const { content } = req.body;
  db.run('REPLACE INTO announce (id, content) VALUES (1, ?)', [content]);
  broadcast({ type: 'announce', content });
  res.json({ success: true });
});

// 下载数据库
app.get('/api/admin/download-db', adminAuth, (req, res) => {
  const file = path.join(__dirname, 'chat.db');
  res.download(file, 'chat.db');
});

// 所有用户列表
app.get('/api/admin/users', adminAuth, (req, res) => {
  db.all('SELECT username FROM users', [], (err, rows) => {
    res.json({ users: rows });
  });
});

// 管理员发消息带标识
app.post('/api/admin/send-message', adminAuth, (req, res) => {
  const { room, content } = req.body;
  const data = {
    type: 'chat',
    username: '管理员',
    content,
    room,
    isAdmin: true
  };
  db.run('INSERT INTO messages (room, username, content, isAdmin) VALUES (?, ?, ?, 1)',
    [room, '管理员', content]);
  broadcast(data);
  res.json({ success: true });
});

// ------------------------------
// WebSocket 实时逻辑
// ------------------------------

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress.replace('::ffff:', '') || 'unknown';

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);

      if (msg.type === 'login') {
        const user = msg.username;
        onlineUsers.set(user, { ws, ip, room: null });
      }

      if (msg.type === 'switch_room') {
        const user = msg.username;
        const room = msg.room;
        const u = onlineUsers.get(user);
        if (u) u.room = room;
        broadcast({ type: 'system', room, content: `${user} 进入房间` });
      }

      if (msg.type === 'chat') {
        const { room, username, content } = msg;
        db.run('INSERT INTO messages (room, username, content) VALUES (?, ?, ?)',
          [room, username, content]);
        broadcast({ type: 'chat', room, username, content, isAdmin: false });
      }

      if (msg.type === 'private_msg') {
        const { sender, receiver, content } = msg;
        db.run('INSERT INTO private_messages (sender, receiver, content) VALUES (?, ?, ?)',
          [sender, receiver, content]);
        sendToUser(receiver, { type: 'private_msg', sender, receiver, content });
        ws.send(JSON.stringify({ type: 'private_msg', sender, receiver, content }));
      }
    } catch (e) {}
  });

  ws.on('close', () => {
    onlineUsers.forEach((info, user) => {
      if (info.ws === ws) onlineUsers.delete(user);
    });
  });
});

// 首页
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// 管理员页面
app.get('/admin.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

const PORT = process.env.PORT || 80;
server.listen(PORT, () => {
  console.log(`服务运行在 http://localhost:${PORT}`);
});
