const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const bodyParser = require('body-parser');
const crypto = require('crypto');

// 初始化Express应用
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// 配置
const PORT = process.env.PORT || 3000;
const FRONTEND_DOMAIN = 'https://lmx.is-best.net';

// 中间件
app.use(cors({
  origin: FRONTEND_DOMAIN,
  credentials: true
}));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// 初始化SQLite数据库
const db = new sqlite3.Database('./database.db', (err) => {
  if (err) {
    console.error('数据库连接失败:', err.message);
  } else {
    console.log('成功连接到SQLite数据库');
    // 创建用户表
    db.run(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
      if (err) console.error('创建用户表失败:', err.message);
    });
  }
});

// 生成随机唯一用户ID (8位字母数字组合)
function generateUniqueUserId() {
  return new Promise((resolve, reject) => {
    const generateId = () => {
      const id = crypto.randomBytes(4).toString('hex').toUpperCase(); // 8位唯一ID
      // 检查ID是否已存在
      db.get('SELECT id FROM users WHERE id = ?', [id], (err, row) => {
        if (err) reject(err);
        else if (row) generateId(); // 重复则重新生成
        else resolve(id); // 唯一则返回
      });
    };
    generateId();
  });
}

// 1. 注册接口
app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    // 验证参数
    if (!username || !password) {
      return res.status(400).json({ success: false, message: '用户名和密码不能为空' });
    }

    // 检查用户名是否已存在
    const existingUser = await new Promise((resolve) => {
      db.get('SELECT username FROM users WHERE username = ?', [username], (err, row) => {
        resolve(row);
      });
    });

    if (existingUser) {
      return res.status(400).json({ success: false, message: '用户名已存在' });
    }

    // 生成唯一ID
    const userId = await generateUniqueUserId();

    // 插入新用户
    await new Promise((resolve, reject) => {
      db.run('INSERT INTO users (id, username, password) VALUES (?, ?, ?)', 
        [userId, username, password], 
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });

    res.status(200).json({
      success: true,
      message: '注册成功',
      data: { userId, username }
    });
  } catch (error) {
    console.error('注册失败:', error);
    res.status(500).json({ success: false, message: '服务器内部错误' });
  }
});

// 2. 登录接口
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;

  // 验证参数
  if (!username || !password) {
    return res.status(400).json({ success: false, message: '用户名和密码不能为空' });
  }

  // 验证用户
  db.get('SELECT id, username FROM users WHERE username = ? AND password = ?', 
    [username, password], 
    (err, row) => {
      if (err) {
        console.error('登录验证失败:', err);
        return res.status(500).json({ success: false, message: '服务器内部错误' });
      }
      if (!row) {
        return res.status(401).json({ success: false, message: '用户名或密码错误' });
      }
      // 登录成功
      res.status(200).json({
        success: true,
        message: '登录成功',
        data: { userId: row.id, username: row.username }
      });
    }
  );
});

// 3. WebSocket 实时聊天处理
// 存储在线用户
const onlineUsers = new Map(); // key: ws连接, value: { userId, username }

wss.on('connection', (ws) => {
  console.log('新的WebSocket连接');

  // 接收客户端消息
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      // 客户端登录WebSocket（验证用户身份）
      if (data.type === 'login') {
        const { userId, username } = data;
        if (userId && username) {
          onlineUsers.set(ws, { userId, username });
          // 广播用户上线
          broadcastMessage({
            type: 'system',
            content: `${username} (ID: ${userId}) 加入了聊天室`,
            time: new Date().toLocaleTimeString()
          });
          console.log(`${username} (${userId}) 上线`);
        }
      }

      // 客户端发送聊天消息
      if (data.type === 'chat' && onlineUsers.has(ws)) {
        const user = onlineUsers.get(ws);
        const chatMessage = {
          type: 'chat',
          userId: user.userId,
          username: user.username,
          content: data.content,
          time: new Date().toLocaleTimeString()
        };
        // 广播消息给所有在线用户
        broadcastMessage(chatMessage);
      }
    } catch (error) {
      console.error('消息处理失败:', error);
    }
  });

  // 连接关闭
  ws.on('close', () => {
    if (onlineUsers.has(ws)) {
      const user = onlineUsers.get(ws);
      onlineUsers.delete(ws);
      // 广播用户下线
      broadcastMessage({
        type: 'system',
        content: `${user.username} (ID: ${user.userId}) 离开了聊天室`,
        time: new Date().toLocaleTimeString()
      });
      console.log(`${user.username} (${user.userId}) 下线`);
    }
    console.log('WebSocket连接关闭');
  });

  // 错误处理
  ws.on('error', (error) => {
    console.error('WebSocket错误:', error);
  });
});

// 广播消息给所有在线用户
function broadcastMessage(message) {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  });
}

// 健康检查接口 (Render部署需要)
app.get('/', (req, res) => {
  res.send('聊天室后端服务运行中 ✨');
});

// 启动服务器
server.listen(PORT, () => {
  console.log(`服务器运行在端口 ${PORT}`);
  console.log(`后端地址: https://chat-051o.onrender.com`);
  console.log(`允许跨域的前端地址: ${FRONTEND_DOMAIN}`);
});

// 关闭数据库连接
process.on('SIGINT', () => {
  db.close((err) => {
    if (err) console.error('关闭数据库失败:', err.message);
    else console.log('数据库连接已关闭');
    process.exit(0);
  });
});
