const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const cors = require('cors');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

// 初始化应用
const app = express();
const server = http.createServer(app);

// 配置
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // 前端文件放在public目录

// 初始化数据库
const db = new sqlite3.Database('chat_database.db', (err) => {
  if (err) console.error('数据库连接失败：', err.message);
  else console.log('数据库连接成功');
});

// 创建数据表
db.serialize(() => {
  // 房间表
  db.run(`CREATE TABLE IF NOT EXISTS rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    owner TEXT,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  )`);

  // 聊天记录表
  db.run(`CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room TEXT NOT NULL,
    username TEXT NOT NULL,
    content TEXT NOT NULL,
    is_admin INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  )`);

  // 私聊记录表
  db.run(`CREATE TABLE IF NOT EXISTS private_chats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender TEXT NOT NULL,
    receiver TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  )`);

  // 公告表
  db.run(`CREATE TABLE IF NOT EXISTS announcements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  )`);

  // 初始化默认房间
  db.get('SELECT * FROM rooms WHERE name = ?', ['默认房间'], (err, row) => {
    if (err) console.error(err);
    if (!row) {
      db.run('INSERT INTO rooms (name, owner) VALUES (?, ?)', ['默认房间', '系统']);
    }
  });
});

// 在线用户管理
const onlineUsers = new Map(); // key: username, value: { ws, ip, room, loginTime }
const adminWss = new WebSocket.Server({ noServer: true }); // 管理员WS
const userWss = new WebSocket.Server({ noServer: true }); // 用户WS

// -------------------------- API接口 --------------------------
// 1. 公共接口
// 获取房间列表
app.get('/api/rooms', (req, res) => {
  db.all('SELECT * FROM rooms', (err, rows) => {
    if (err) return res.json({ success: false, message: err.message });
    // 补充成员数
    const roomsWithMemberCount = rows.map(room => {
      const memberCount = Array.from(onlineUsers.values()).filter(u => u.room === room.name).length;
      return { ...room, member_count: memberCount };
    });
    res.json({ success: true, rooms: roomsWithMemberCount });
  });
});

// 获取聊天记录
app.get('/api/chat-history', (req, res) => {
  const { room } = req.query;
  if (!room) return res.json({ success: false, message: '房间名不能为空' });
  
  db.all('SELECT * FROM chat_messages WHERE room = ? ORDER BY created_at ASC', [room], (err, rows) => {
    if (err) return res.json({ success: false, message: err.message });
    res.json({ success: true, messages: rows });
  });
});

// 获取最新公告
app.get('/api/get-latest-announcement', (req, res) => {
  db.get('SELECT * FROM announcements ORDER BY id DESC LIMIT 1', (err, row) => {
    if (err) return res.json({ success: false, message: err.message });
    res.json({ success: true, announcement: row || { content: '', created_at: '' } });
  });
});

// 2. 管理员接口
// 管理员登录（密码验证）
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === 'Lmx%%112233') {
    res.json({ success: true, message: '登录成功' });
  } else {
    res.json({ success: false, message: '密码错误' });
  }
});

// 获取房间列表（管理员）
app.get('/api/admin/rooms', (req, res) => {
  db.all('SELECT * FROM rooms', (err, rows) => {
    if (err) return res.json({ success: false, message: err.message });
    // 补充成员数
    const roomsWithMemberCount = rows.map(room => {
      const memberCount = Array.from(onlineUsers.values()).filter(u => u.room === room.name).length;
      return { ...room, member_count: memberCount };
    });
    res.json({ success: true, rooms: roomsWithMemberCount });
  });
});

// 新增房间
app.post('/api/admin/add-room', (req, res) => {
  const { name } = req.body;
  if (!name) return res.json({ success: false, message: '房间名不能为空' });
  
  db.run('INSERT INTO rooms (name, owner) VALUES (?, ?)', [name, '管理员'], function(err) {
    if (err) return res.json({ success: false, message: '房间已存在' });
    res.json({ success: true, message: '房间创建成功', roomId: this.lastID });
  });
});

// 重命名房间
app.post('/api/admin/rename-room', (req, res) => {
  const { roomId, newName } = req.body;
  if (!roomId || !newName) return res.json({ success: false, message: '参数不全' });
  
  // 检查新名称是否已存在
  db.get('SELECT * FROM rooms WHERE name = ? AND id != ?', [newName, roomId], (err, row) => {
    if (err) return res.json({ success: false, message: err.message });
    if (row) return res.json({ success: false, message: '房间名已存在' });
    
    // 更新房间名
    db.run('UPDATE rooms SET name = ? WHERE id = ?', [newName, roomId], (err) => {
      if (err) return res.json({ success: false, message: err.message });
      // 同步更新聊天记录中的房间名
      db.run('UPDATE chat_messages SET room = ? WHERE room = (SELECT name FROM rooms WHERE id = ?)', [newName, roomId]);
      res.json({ success: true, message: '房间名修改成功' });
    });
  });
});

// 删除房间
app.post('/api/admin/delete-room', (req, res) => {
  const { roomId } = req.body;
  if (!roomId) return res.json({ success: false, message: '房间ID不能为空' });
  
  // 获取房间名
  db.get('SELECT name FROM rooms WHERE id = ?', [roomId], (err, row) => {
    if (err) return res.json({ success: false, message: err.message });
    if (!row) return res.json({ success: false, message: '房间不存在' });
    
    // 删除房间及相关记录
    db.run('DELETE FROM rooms WHERE id = ?', [roomId]);
    db.run('DELETE FROM chat_messages WHERE room = ?', [row.name]);
    
    // 通知该房间用户切换到默认房间
    Array.from(onlineUsers.entries()).forEach(([username, user]) => {
      if (user.room === row.name) {
        user.room = '默认房间';
        user.ws.send(JSON.stringify({
          type: 'room_update',
          message: '当前房间已被删除，已切换到默认房间'
        }));
      }
    });
    
    res.json({ success: true, message: '房间删除成功' });
  });
});

// 清空房间聊天记录
app.post('/api/admin/delete-chat', (req, res) => {
  const { room } = req.body;
  if (!room) return res.json({ success: false, message: '房间名不能为空' });
  
  db.run('DELETE FROM chat_messages WHERE room = ?', [room], (err) => {
    if (err) return res.json({ success: false, message: err.message });
    res.json({ success: true, message: '聊天记录清空成功' });
  });
});

// 获取在线用户
app.get('/api/admin/online-users', (req, res) => {
  const users = Array.from(onlineUsers.entries()).map(([username, data]) => ({
    username,
    ip: data.ip,
    room: data.room,
    loginTime: data.loginTime
  }));
  res.json({ success: true, users });
});

// 发送全局公告
app.post('/api/admin/send-announcement', (req, res) => {
  const { content } = req.body;
  if (!content) return res.json({ success: false, message: '公告内容不能为空' });
  
  // 保存到数据库
  db.run('INSERT INTO announcements (content) VALUES (?)', [content], function(err) {
    if (err) return res.json({ success: false, message: err.message });
    
    // 推送给所有用户
    const announcement = {
      type: 'announcement',
      content,
      time: new Date().toLocaleString()
    };
    userWss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(announcement));
      }
    });
    
    res.json({ success: true, message: '公告发送成功' });
  });
});

// 发送管理员消息
app.post('/api/admin/send-admin-msg', (req, res) => {
  const { room, content } = req.body;
  if (!room || !content) return res.json({ success: false, message: '参数不全' });
  
  // 保存到数据库
  db.run('INSERT INTO chat_messages (room, username, content, is_admin) VALUES (?, ?, ?, 1)', 
    [room, '管理员', content], function(err) {
    if (err) return res.json({ success: false, message: err.message });
    
    // 推送给对应房间用户
    const msg = {
      type: 'chat',
      room,
      content,
      is_admin: true,
      username: '管理员'
    };
    userWss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        // 找到对应房间的用户
        const user = Array.from(onlineUsers.entries()).find(([_, data]) => data.ws === client);
        if (user && user[1].room === room) {
          client.send(JSON.stringify(msg));
        }
      }
    });
    
    res.json({ success: true, message: '管理员消息发送成功' });
  });
});

// 获取私聊记录
app.get('/api/admin/private-chats', (req, res) => {
  db.all('SELECT * FROM private_chats ORDER BY created_at DESC', (err, rows) => {
    if (err) return res.json({ success: false, message: err.message });
    res.json({ success: true, chats: rows });
  });
});

// 删除私聊记录
app.post('/api/admin/delete-private-chat', (req, res) => {
  const { msgId } = req.body;
  if (!msgId) return res.json({ success: false, message: '消息ID不能为空' });
  
  db.run('DELETE FROM private_chats WHERE id = ?', [msgId], (err) => {
    if (err) return res.json({ success: false, message: err.message });
    res.json({ success: true, message: '私聊记录删除成功' });
  });
});

// 下载数据库文件
app.get('/api/admin/download-db', (req, res) => {
  const dbPath = path.join(__dirname, 'chat_database.db');
  res.download(dbPath, 'chat_database.db', (err) => {
    if (err) {
      res.json({ success: false, message: '下载失败' });
    }
  });
});

// -------------------------- WebSocket处理 --------------------------
// 管理员WS
adminWss.on('connection', (ws) => {
  console.log('管理员WS连接成功');
  
  ws.on('message', (data) => {
    const msg = JSON.parse(data);
    // 处理踢人
    if (msg.type === 'kick') {
      const user = Array.from(onlineUsers.entries()).find(([username]) => username === msg.username);
      if (user) {
        const [_, userData] = user;
        // 通知用户被踢出
        userData.ws.send(JSON.stringify({ type: 'kick' }));
        // 关闭用户连接
        userData.ws.close();
        // 从在线列表移除
        onlineUsers.delete(msg.username);
        
        // 通知所有管理员更新在线列表
        adminWss.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'online_update' }));
          }
        });
      }
    }
    // 转发公告/房间更新
    if (msg.type === 'announcement' || msg.type === 'room_update') {
      userWss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify(msg));
        }
      });
    }
    // 转发管理员消息
    if (msg.type === 'chat' && msg.is_admin) {
      userWss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          const user = Array.from(onlineUsers.entries()).find(([_, data]) => data.ws === client);
          if (user && user[1].room === msg.room) {
            client.send(JSON.stringify(msg));
          }
        }
      });
    }
  });
  
  ws.on('close', () => {
    console.log('管理员WS连接关闭');
  });
});

// 用户WS
userWss.on('connection', (ws, req) => {
  // 获取用户IP
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`用户WS连接成功，IP: ${ip}`);
  
  // 用户认证（简化版，实际可加token）
  let username = null;
  
  ws.on('message', (data) => {
    const msg = JSON.parse(data);
    
    // 初始化用户
    if (msg.type === 'init' && msg.username) {
      username = msg.username;
      const room = msg.room || '默认房间';
      onlineUsers.set(username, {
        ws,
        ip,
        room,
        loginTime: new Date().toLocaleString()
      });
      
      // 通知管理员更新在线列表
      adminWss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ type: 'online_update' }));
        }
      });
      return;
    }
    
    // 聊天消息
    if (msg.type === 'chat' && username) {
      const { room, content } = msg;
      if (!room || !content) return;
      
      // 更新用户当前房间
      onlineUsers.get(username).room = room;
      
      // 保存到数据库
      db.run('INSERT INTO chat_messages (room, username, content) VALUES (?, ?, ?)', 
        [room, username, content]);
      
      // 推送给同房间用户
      const sendMsg = {
        type: 'chat',
        room,
        username,
        content,
        is_admin: false
      };
      userWss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          const user = Array.from(onlineUsers.entries()).find(([_, data]) => data.ws === client);
          if (user && user[1].room === room) {
            client.send(JSON.stringify(sendMsg));
          }
        }
      });
    }
    
    // 私聊消息
    if (msg.type === 'private_chat' && username) {
      const { receiver, content } = msg;
      if (!receiver || !content) return;
      
      // 保存到数据库
      db.run('INSERT INTO private_chats (sender, receiver, content) VALUES (?, ?, ?)', 
        [username, receiver, content]);
      
      // 推送给接收者
      const receiverData = Array.from(onlineUsers.entries()).find(([uname]) => uname === receiver);
      if (receiverData) {
        receiverData[1].ws.send(JSON.stringify({
          type: 'private_chat',
          sender: username,
          content
        }));
      }
    }
  });
  
  ws.on('close', () => {
    if (username) {
      onlineUsers.delete(username);
      // 通知管理员更新在线列表
      adminWss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ type: 'online_update' }));
        }
      });
    }
    console.log(`用户WS连接关闭，用户名: ${username || '未知'}`);
  });
});

// 路由分发（WS升级）
server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
  
  if (pathname === '/admin-ws') {
    adminWss.handleUpgrade(request, socket, head, (ws) => {
      adminWss.emit('connection', ws, request);
    });
  } else if (pathname === '/ws') {
    userWss.handleUpgrade(request, socket, head, (ws) => {
      userWss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// 启动服务
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`服务运行在端口 ${PORT}`);
  console.log(`前端访问：http://localhost:${PORT}`);
  console.log(`管理员后台：http://localhost:${PORT}/admin.html`);
});
