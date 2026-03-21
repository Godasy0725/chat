const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const cors = require('cors');

// 初始化应用
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 3000;

// 数据库初始化
const db = new sqlite3.Database('./chat.db', (err) => {
  if (err) console.error('数据库连接失败:', err.message);
  else console.log('数据库连接成功');
});

// 创建数据表
db.serialize(() => {
  // 用户表
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // 聊天室表
  db.run(`CREATE TABLE IF NOT EXISTS rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    creator TEXT NOT NULL,
    locked INTEGER DEFAULT 0,
    muted INTEGER DEFAULT 0,
    visible INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // 群聊消息表
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    content TEXT NOT NULL,
    room TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // 私聊消息表
  db.run(`CREATE TABLE IF NOT EXISTS private_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender TEXT NOT NULL,
    receiver TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // 好友关系表
  db.run(`CREATE TABLE IF NOT EXISTS friends (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user1 TEXT NOT NULL,
    user2 TEXT NOT NULL,
    status INTEGER DEFAULT 0, -- 0:申请中 1:已通过
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user1, user2)
  )`);

  // 在线IP表
  db.run(`CREATE TABLE IF NOT EXISTS online_ips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    ip TEXT NOT NULL,
    room TEXT,
    muted INTEGER DEFAULT 0,
    online INTEGER DEFAULT 1
  )`);

  // 公告表
  db.run(`CREATE TABLE IF NOT EXISTS announcement (
    id INTEGER PRIMARY KEY,
    content TEXT DEFAULT '',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // 初始化默认数据
  db.get('SELECT * FROM announcement WHERE id = 1', (err, row) => {
    if (!row) {
      db.run('INSERT INTO announcement (id, content) VALUES (1, "欢迎使用群聊系统")');
    }
  });
});

// 中间件
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

// 存储映射关系
const userMap = new Map(); // username -> ws
const wsToUser = new Map(); // ws -> { username, room, ip }
const mutedIPs = new Set(); // 禁言IP列表

// HTTP接口

// 用户注册
app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  db.run('INSERT INTO users (username, password) VALUES (?, ?)', [username, password], (err) => {
    if (err) {
      res.json({ success: false, message: '用户名已存在' });
    } else {
      res.json({ success: true });
    }
  });
});

// 用户登录
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const ip = req.ip || req.connection.remoteAddress;
  
  db.get('SELECT * FROM users WHERE username = ? AND password = ?', [username, password], (err, row) => {
    if (row) {
      // 顶号处理
      if (userMap.has(username)) {
        const oldWs = userMap.get(username);
        oldWs.send(JSON.stringify({ type: 'kick', message: '你的账号在其他设备登录' }));
        oldWs.close();
      }
      
      // 记录在线IP
      db.run('REPLACE INTO online_ips (username, ip, online) VALUES (?, ?, 1)', [username, ip]);
      res.json({ success: true });
    } else {
      res.json({ success: false, message: '用户名或密码错误' });
    }
  });
});

// 获取聊天室列表（带在线人数）
app.get('/api/rooms', (req, res) => {
  db.all('SELECT * FROM rooms WHERE visible = 1', (err, rooms) => {
    if (err) {
      res.json({ success: false });
      return;
    }
    
    const result = rooms.map(room => {
      // 计算在线人数
      let onlineCount = 0;
      for (const [ws, user] of wsToUser.entries()) {
        if (user.room === room.name) onlineCount++;
      }
      
      return {
        id: room.id,
        name: room.name,
        creator: room.creator,
        locked: room.locked,
        muted: room.muted,
        onlineCount
      };
    });
    
    res.json({ success: true, rooms: result });
  });
});

// 获取房间消息
app.get('/api/room/messages', (req, res) => {
  const { room } = req.query;
  db.all('SELECT * FROM messages WHERE room = ? ORDER BY created_at DESC LIMIT 100', [room], (err, rows) => {
    res.json({ success: true, messages: rows.reverse() });
  });
});

// 获取私聊消息
app.get('/api/private/messages', (req, res) => {
  const { sender, receiver } = req.query;
  db.all(`SELECT * FROM private_messages 
          WHERE (sender = ? AND receiver = ?) OR (sender = ? AND receiver = ?)
          ORDER BY created_at DESC LIMIT 100`, 
          [sender, receiver, receiver, sender], (err, rows) => {
    res.json({ success: true, messages: rows.reverse() });
  });
});

// 好友申请
app.post('/api/friend/apply', (req, res) => {
  const { from, to } = req.body;
  db.run('INSERT OR IGNORE INTO friends (user1, user2, status) VALUES (?, ?, 0)', [from, to], (err) => {
    if (err) {
      res.json({ success: false });
    } else {
      // 实时通知对方
      if (userMap.has(to)) {
        userMap.get(to).send(JSON.stringify({
          type: 'friend_apply',
          from,
          to
        }));
      }
      res.json({ success: true });
    }
  });
});

// 处理好友申请
app.post('/api/friend/response', (req, res) => {
  const { from, to, accept } = req.body;
  const status = accept ? 1 : -1;
  
  db.run('UPDATE friends SET status = ? WHERE user1 = ? AND user2 = ?', [status, from, to], (err) => {
    if (err) {
      res.json({ success: false });
    } else {
      // 实时通知申请人
      if (userMap.has(from)) {
        userMap.get(from).send(JSON.stringify({
          type: 'friend_response',
          from: to,
          accept
        }));
      }
      res.json({ success: true });
    }
  });
});

// 获取好友列表
app.get('/api/friends', (req, res) => {
  const { username } = req.query;
  db.all(`SELECT user1 as friend FROM friends WHERE user2 = ? AND status = 1
          UNION
          SELECT user2 as friend FROM friends WHERE user1 = ? AND status = 1`, 
          [username, username], (err, rows) => {
    res.json({ success: true, friends: rows.map(row => row.friend) });
  });
});

// 获取好友申请列表
app.get('/api/friend/applications', (req, res) => {
  const { username } = req.query;
  db.all('SELECT user1 as from FROM friends WHERE user2 = ? AND status = 0', [username], (err, rows) => {
    res.json({ success: true, applications: rows.map(row => row.from) });
  });
});

// 用户创建聊天室（每个用户只能创建一个）
app.post('/api/user/create-room', (req, res) => {
  const { username } = req.body;
  db.get('SELECT * FROM rooms WHERE creator = ?', [username], (err, row) => {
    if (row) {
      res.json({ success: false, message: '你已经创建过一个聊天室' });
    } else {
      const roomName = `${username}的聊天室`;
      db.run('INSERT INTO rooms (name, creator, locked, muted, visible) VALUES (?, ?, 0, 0, 1)', 
        [roomName, username], (err) => {
        res.json({ success: !err });
      });
    }
  });
});

// 聊天室创建者管理自己的聊天室
app.post('/api/user/manage-room', (req, res) => {
  const { username, roomId, action } = req.body;
  db.get('SELECT * FROM rooms WHERE id = ? AND creator = ?', [roomId, username], (err, row) => {
    if (!row) {
      res.json({ success: false, message: '无权限' });
      return;
    }

    if (action === 'mute') {
      db.run('UPDATE rooms SET muted = ? WHERE id = ?', [row.muted ? 0 : 1, roomId]);
    } else if (action === 'lock') {
      db.run('UPDATE rooms SET locked = ? WHERE id = ?', [row.locked ? 0 : 1, roomId]);
    } else if (action === 'clear') {
      db.run('DELETE FROM messages WHERE room = ?', [row.name]);
    } else if (action === 'delete') {
      db.run('DELETE FROM rooms WHERE id = ?', [roomId]);
      db.run('DELETE FROM messages WHERE room = ?', [row.name]);
    }
    
    res.json({ success: true });
  });
});

// 管理员接口

// 管理员仪表盘
app.get('/api/admin/dashboard', (req, res) => {
  const online = userMap.size;
  
  // 今日消息数
  db.get('SELECT COUNT(*) as count FROM messages WHERE DATE(created_at) = DATE("now")', (err, msgRow) => {
    const messages = msgRow?.count || 0;
    
    // 总用户数
    db.get('SELECT COUNT(*) as count FROM users', (err, userRow) => {
      const users = userRow?.count || 0;
      
      // 聊天室总数
      db.get('SELECT COUNT(*) as count FROM rooms', (err, roomRow) => {
        const rooms = roomRow?.count || 0;
        
        // 在线IP列表
        db.all('SELECT username, ip, room, muted FROM online_ips WHERE online = 1', (err, ipRows) => {
          res.json({
            success: true,
            online,
            rooms,
            users,
            messages,
            ips: ipRows || []
          });
        });
      });
    });
  });
});

// 管理员获取聊天室列表
app.get('/api/admin/rooms', (req, res) => {
  db.all('SELECT * FROM rooms', (err, rows) => {
    if (err) {
      res.json({ success: false });
      return;
    }
    
    const result = rows.map(room => {
      // 计算成员数量
      let memberCount = 0;
      for (const [ws, user] of wsToUser.entries()) {
        if (user.room === room.name) memberCount++;
      }
      
      return {
        id: room.id,
        name: room.name,
        creator: room.creator,
        locked: room.locked,
        muted: room.muted,
        visible: room.visible,
        memberCount
      };
    });
    
    res.json({ success: true, rooms: result });
  });
});

// 管理员获取用户列表
app.get('/api/admin/users', (req, res) => {
  db.all('SELECT username, created_at FROM users', (err, rows) => {
    if (err) {
      res.json({ success: false });
      return;
    }
    
    const result = rows.map(row => ({
      username: row.username,
      createdAt: row.created_at,
      online: userMap.has(row.username)
    }));
    
    res.json({ success: true, users: result });
  });
});

// 管理员获取聊天记录
app.get('/api/admin/records', (req, res) => {
  db.all('SELECT * FROM messages ORDER BY created_at DESC LIMIT 100', (err, rows) => {
    res.json({ success: true, records: rows || [] });
  });
});

// 管理员获取好友聊天记录
app.get('/api/admin/friend-records', (req, res) => {
  db.all('SELECT * FROM private_messages ORDER BY created_at DESC LIMIT 100', (err, rows) => {
    res.json({ success: true, records: rows || [] });
  });
});

// 管理员获取/保存公告
app.get('/api/admin/announcement', (req, res) => {
  db.get('SELECT content FROM announcement WHERE id = 1', (err, row) => {
    res.json({ success: true, content: row?.content || '' });
  });
});

app.post('/api/admin/announcement', (req, res) => {
  const { content } = req.body;
  db.run('REPLACE INTO announcement (id, content, updated_at) VALUES (1, ?, CURRENT_TIMESTAMP)', [content], (err) => {
    // 广播公告更新
    broadcast({
      type: 'announcement_update',
      content
    });
    
    res.json({ success: !err });
  });
});

// 管理员获取单个聊天室信息
app.get('/api/admin/room/:id', (req, res) => {
  const { id } = req.params;
  db.get('SELECT * FROM rooms WHERE id = ?', [id], (err, row) => {
    if (row) {
      res.json({ success: true, name: row.name, locked: row.locked });
    } else {
      res.json({ success: false });
    }
  });
});

// 管理员新增/编辑聊天室
app.post('/api/admin/room', (req, res) => {
  const { name, locked } = req.body;
  db.run('INSERT INTO rooms (name, creator, locked, muted, visible) VALUES (?, "admin", ?, 0, 1)', 
    [name, locked ? 1 : 0], (err) => {
    res.json({ success: !err });
  });
});

app.put('/api/admin/room/:id', (req, res) => {
  const { id } = req.params;
  const { name, locked } = req.body;
  db.run('UPDATE rooms SET name = ?, locked = ? WHERE id = ?', [name, locked ? 1 : 0, id], (err) => {
    res.json({ success: !err });
  });
});

// 管理员禁言IP
app.post('/api/admin/mute-ip', (req, res) => {
  const { ip } = req.body;
  db.get('SELECT muted FROM online_ips WHERE ip = ?', [ip], (err, row) => {
    const newStatus = row?.muted ? 0 : 1;
    db.run('UPDATE online_ips SET muted = ? WHERE ip = ?', [newStatus, ip], (err) => {
      if (newStatus) {
        mutedIPs.add(ip);
      } else {
        mutedIPs.delete(ip);
      }
      res.json({ success: !err });
    });
  });
});

// 管理员发送消息
app.post('/api/admin/send-msg', (req, res) => {
  const { roomId, content } = req.body;
  db.get('SELECT name FROM rooms WHERE id = ?', [roomId], (err, row) => {
    if (row) {
      // 保存消息
      db.run('INSERT INTO messages (username, content, room) VALUES (?, ?, ?)', 
        ['管理员', content, row.name]);
      
      // 广播消息
      broadcast({
        type: 'chat',
        username: '管理员',
        content,
        room: row.name
      });
      
      res.json({ success: true });
    } else {
      res.json({ success: false });
    }
  });
});

// WebSocket 处理
wss.on('connection', (ws, req) => {
  const ip = req.ip || req.connection.remoteAddress;
  
  ws.on('message', (data) => {
    try {
      const parsed = JSON.parse(data);
      
      // 登录验证
      if (parsed.type === 'login') {
        const { username } = parsed;
        // 顶号处理
        if (userMap.has(username)) {
          const oldWs = userMap.get(username);
          oldWs.send(JSON.stringify({ type: 'kick', message: '你的账号在其他设备登录' }));
          oldWs.close();
        }
        
        // 记录映射关系
        userMap.set(username, ws);
        wsToUser.set(ws, { username, room: '', ip });
        
        // 更新在线IP
        db.run('REPLACE INTO online_ips (username, ip, online) VALUES (?, ?, 1)', [username, ip]);
        
        ws.send(JSON.stringify({ type: 'login_success' }));
      }
      
      // 发送群聊消息
      if (parsed.type === 'chat' && wsToUser.has(ws)) {
        const { username, content, room } = parsed;
        const user = wsToUser.get(ws);
        
        // 检查禁言
        if (mutedIPs.has(user.ip)) {
          ws.send(JSON.stringify({ type: 'error', message: '你已被禁言' }));
          return;
        }
        
        // 检查房间禁言
        db.get('SELECT muted FROM rooms WHERE name = ?', [room], (err, row) => {
          if (row?.muted && username !== 'admin') {
            ws.send(JSON.stringify({ type: 'error', message: '该聊天室已被禁言' }));
            return;
          }
          
          // 保存消息
          db.run('INSERT INTO messages (username, content, room) VALUES (?, ?, ?)', [username, content, room]);
          
          // 广播消息
          broadcast({
            type: 'chat',
            username,
            content,
            room
          });
        });
      }
      
      // 切换房间
      if (parsed.type === 'switch_room' && wsToUser.has(ws)) {
        const { username, room } = parsed;
        const oldUser = wsToUser.get(ws);
        
        // 离开旧房间广播
        if (oldUser.room) {
          broadcast({
            type: 'system',
            content: `${username} 离开了聊天室`,
            room: oldUser.room
          });
        }
        
        // 更新房间
        wsToUser.set(ws, { ...oldUser, room });
        
        // 更新在线IP的房间信息
        db.run('UPDATE online_ips SET room = ? WHERE username = ?', [room, username]);
        
        // 进入新房间广播
        broadcast({
          type: 'system',
          content: `${username} 加入了聊天室`,
          room
        });
      }
      
      // 私聊消息
      if (parsed.type === 'private_msg' && wsToUser.has(ws)) {
        const { sender, receiver, content } = parsed;
        
        // 检查禁言
        const user = wsToUser.get(ws);
        if (mutedIPs.has(user.ip)) {
          ws.send(JSON.stringify({ type: 'error', message: '你已被禁言' }));
          return;
        }
        
        // 保存私聊消息
        db.run('INSERT INTO private_messages (sender, receiver, content) VALUES (?, ?, ?)', [sender, receiver, content]);
        
        // 推送给接收方
        if (userMap.has(receiver)) {
          userMap.get(receiver).send(JSON.stringify({
            type: 'private_msg',
            sender,
            receiver,
            content
          }));
        }
        
        // 自己也收到一份回显
        ws.send(JSON.stringify({
          type: 'private_msg',
          sender,
          receiver,
          content
        }));
      }
      
      // 好友申请/响应实时通知
      if (parsed.type === 'friend_apply' || parsed.type === 'friend_response') {
        const { from, to, accept } = parsed;
        if (userMap.has(to)) {
          userMap.get(to).send(JSON.stringify({
            type: parsed.type,
            from,
            to,
            accept
          }));
        }
      }
      
      // 改名同步
      if (parsed.type === 'rename') {
        const { oldName, newName } = parsed;
        if (userMap.has(oldName)) {
          const wsObj = userMap.get(oldName);
          userMap.delete(oldName);
          userMap.set(newName, wsObj);
          wsToUser.set(wsObj, { ...wsToUser.get(wsObj), username: newName });
        }
      }
    } catch (e) {
      console.error('消息解析错误:', e);
    }
  });

  // 断开连接处理
  ws.on('close', () => {
    const user = wsToUser.get(ws);
    if (user) {
      // 移除映射
      userMap.delete(user.username);
      wsToUser.delete(ws);
      
      // 更新在线状态
      db.run('UPDATE online_ips SET online = 0, room = "" WHERE username = ?', [user.username]);
      
      // 广播离开
      if (user.room) {
        broadcast({
          type: 'system',
          content: `${user.username} 离开了聊天室`,
          room: user.room
        });
      }
    }
  });

  ws.on('error', (err) => {
    console.error('WebSocket错误:', err);
  });
});

// 广播函数
function broadcast(msg) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      // 如果是房间消息，只广播给同房间用户
      if (msg.room) {
        const user = wsToUser.get(client);
        if (user && user.room === msg.room) {
          client.send(JSON.stringify(msg));
        }
      } else {
        // 全局消息（如公告更新）
        client.send(JSON.stringify(msg));
      }
    }
  });
}

// 启动服务器
server.listen(PORT, () => {
  console.log(`服务器运行在 http://localhost:${PORT}`);
});
