const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// 数据库初始化
const db = new sqlite3.Database('./database.db', (err) => {
  if (err) console.error('数据库连接失败:', err.message);
  else console.log('数据库连接成功');
});

// 创建用户表、消息表
db.run(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    username TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`);

// 全局变量：在线用户映射（userId => WebSocket连接）
const onlineUsers = new Map();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 注册接口
app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.json({ success: false, message: '用户名和密码不能为空' });
  }

  // 生成唯一随机ID（不可修改）
  const userId = crypto.randomBytes(8).toString('hex');

  db.run(
    'INSERT INTO users (id, username, password) VALUES (?, ?, ?)',
    [userId, username, password],
    (err) => {
      if (err) {
        if (err.message.includes('UNIQUE constraint failed')) {
          return res.json({ success: false, message: '用户名已存在' });
        }
        return res.json({ success: false, message: '注册失败' });
      }
      res.json({ success: true, message: '注册成功' });
    }
  );
});

// 登录接口
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  db.get(
    'SELECT id, username FROM users WHERE username = ? AND password = ?',
    [username, password],
    (err, row) => {
      if (err) return res.json({ success: false, message: '登录失败' });
      if (!row) return res.json({ success: false, message: '用户名或密码错误' });
      res.json({
        success: true,
        data: { userId: row.id, username: row.username }
      });
    }
  );
});

// WebSocket连接处理
wss.on('connection', (ws) => {
  let currentUser = null;

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);

      if (msg.type === 'login') {
        const { userId, username } = msg;
        currentUser = { userId, username };

        // 单设备登录：如果已在线，踢掉旧连接
        if (onlineUsers.has(userId)) {
          const oldWs = onlineUsers.get(userId);
          oldWs.send(JSON.stringify({
            type: 'system',
            content: '您的账号在其他设备登录，已被强制下线'
          }));
          oldWs.close();
        }

        // 保存当前连接
        onlineUsers.set(userId, ws);
        broadcast({
          type: 'system',
          content: `${username} (ID: ${userId}) 加入了聊天室`
        });

        // 加载历史消息
        loadHistoryMessages(ws);

      } else if (msg.type === 'chat' && currentUser) {
        const { content } = msg;
        // 存储消息到数据库
        db.run(
          'INSERT INTO messages (user_id, username, content) VALUES (?, ?, ?)',
          [currentUser.userId, currentUser.username, content],
          (err) => {
            if (err) console.error('消息存储失败:', err);
          }
        );
        // 广播消息
        broadcast({
          type: 'chat',
          userId: currentUser.userId,
          username: currentUser.username,
          content
        });
      }
    } catch (e) {
      console.error('消息解析错误:', e);
    }
  });

  ws.on('close', () => {
    if (currentUser) {
      onlineUsers.delete(currentUser.userId);
      broadcast({
        type: 'system',
        content: `${currentUser.username} (ID: ${currentUser.userId}) 离开了聊天室`
      });
    }
  });
});

// 广播消息
function broadcast(data) {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

// 加载历史消息
function loadHistoryMessages(ws) {
  db.all(
    'SELECT user_id, username, content, created_at FROM messages ORDER BY created_at ASC LIMIT 100',
    (err, rows) => {
      if (err) return console.error('加载历史消息失败:', err);
      rows.forEach((row) => {
        ws.send(JSON.stringify({
          type: 'chat',
          userId: row.user_id,
          username: row.username,
          content: row.content
        }));
      });
    }
  );
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`服务器运行在端口 ${PORT}`);
});
