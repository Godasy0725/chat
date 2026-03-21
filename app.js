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

    // 创建消息表（增加room字段支持多房间）
    db.run(`CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      content TEXT NOT NULL,
      room TEXT NOT NULL DEFAULT '喵喵粉丝群',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
      if (err) console.error('创建消息表失败:', err.message);
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

// 2. 登录接口（单账号唯一登录）
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

      // 顶掉旧连接（单账号唯一登录）
      if (userMap.has(row.id)) {
        const oldWs = userMap.get(row.id);
        oldWs.send(JSON.stringify({ 
          type: 'kick', 
          reason: '你的账号在其他设备登录' 
        }));
        oldWs.close(4001, 'replaced');
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

// 3. 获取历史消息接口（按房间筛选）
app.get('/api/history', (req, res) => {
  const { room = '喵喵粉丝群' } = req.query;
  
  db.all(`SELECT user_id, username, content,
          datetime(created_at, '+8 hours') as created_at
          FROM messages
          WHERE room = ?
          ORDER BY id ASC
          LIMIT 500`, [room], (err, rows) => {
    if (err) {
      console.error('获取历史消息失败:', err);
      return res.status(500).json({ success: false, message: '获取历史消息失败' });
    }
    res.json({ success: true, list: rows });
  });
});

// 在线用户映射：userId => ws
const userMap = new Map();
// ws => { userId, room }
const wsToUser = new WeakMap();

// 4. WebSocket 实时聊天处理（支持多房间）
wss.on('connection', (ws) => {
  console.log('新的WebSocket连接');

  // 接收客户端消息
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      // 客户端登录WebSocket（验证用户身份 + 绑定房间）
      if (data.type === 'login') {
        const { userId, username, room = '喵喵粉丝群' } = data;
        if (userId && username) {
          // 单处登录：踢旧
          if (userMap.has(userId)) {
            const oldWs = userMap.get(userId);
            oldWs.send(JSON.stringify({ type: 'kick', reason: '你的账号在别处登录' }));
            oldWs.close(4001, 'replaced');
          }

          // 绑定用户和房间
          userMap.set(userId, ws);
          wsToUser.set(ws, { userId, username, room });

          // 广播用户上线（仅同房间）
          broadcast({
            type: 'system',
            content: `${username} (ID: ${userId}) 加入了聊天室`,
            room: room
          });
          console.log(`${username} (${userId}) 进入房间 ${room}`);
        }
      }

      // 客户端发送聊天消息（仅同房间广播）
      if (data.type === 'chat' && wsToUser.has(ws)) {
        const userInfo = wsToUser.get(ws);
        const { userId, username } = userInfo;
        const { content, room = '喵喵粉丝群' } = data;

        // 保存消息到数据库（关联房间）
        db.run('INSERT INTO messages (user_id, username, content, room) VALUES (?, ?, ?, ?)',
          [userId, username, content, room], (err) => {
            if (err) console.error('保存消息失败:', err);
          });

        // 广播消息给同房间所有用户
        broadcast({
          type: 'chat',
          userId,
          username,
          content,
          room
        });
      }
    } catch (error) {
      console.error('消息处理失败:', error);
    }
  });

  // 连接关闭
  ws.on('close', () => {
    if (wsToUser.has(ws)) {
      const { userId, username, room } = wsToUser.get(ws);
      // 移除映射
      userMap.delete(userId);
      wsToUser.delete(ws);
      // 广播用户下线（仅同房间）
      broadcast({
        type: 'system',
        content: `${username} (ID: ${userId}) 离开了聊天室`,
        room: room
      });
      console.log(`${username} (${userId}) 离开房间 ${room}`);
    }
    console.log('WebSocket连接关闭');
  });

  // 错误处理
  ws.on('error', (error) => {
    console.error('WebSocket错误:', error);
  });
});

// 广播消息（仅发送给同房间的在线用户）
function broadcast(message) {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      // 获取客户端绑定的房间
      const clientInfo = wsToUser.get(client);
      // 只广播给同房间的用户
      if (clientInfo && clientInfo.room === message.room) {
        client.send(JSON.stringify(message));
      }
    }
  });
}

// 健康检查接口 (Render部署需要)
app.get('/', (req, res) => {
  res.send('聊天室后端服务运行中 ✨');
});

// 新增：数据库下载接口（仅管理员使用，可加简单验证）
app.get('/api/download-db', (req, res) => {
  // 可选：简单鉴权（防止他人下载，替换成你的密码）
  const { password } = req.query;
  if (password !== 'Lmx%%112233') { // 改成自己的密码
    return res.status(403).json({ success: false, message: '密码错误' });
  }

  // 下载数据库文件
  const dbPath = './database.db';
  res.download(dbPath, 'chat-database.db', (err) => {
    if (err) {
      res.status(500).json({ success: false, message: '下载失败：' + err.message });
    }
  });
});

// 改名接口
app.post('/api/rename', (req, res) => {
  const { userId, newName } = req.body;
  if (!userId || !newName) {
    return res.status(400).json({ success: false, message: '参数不能为空' });
  }
  
  db.run('UPDATE users SET username = ? WHERE id = ?', [newName, userId], (err) => {
    if (err) {
      console.error('修改昵称失败:', err);
      return res.status(500).json({ success: false, message: '修改失败' });
    }
    res.json({ success: true, message: '昵称修改成功' });
  });
});

// 注销账号接口
app.post('/api/delete-account', (req, res) => {
  const { userId } = req.body;
  if (!userId) {
    return res.status(400).json({ success: false, message: '参数不能为空' });
  }
  
  // 开启事务
  db.run('BEGIN TRANSACTION', (err) => {
    if (err) return res.status(500).json({ success: false });
    
    // 删除用户消息
    db.run('DELETE FROM messages WHERE user_id = ?', [userId], (err) => {
      if (err) {
        db.run('ROLLBACK');
        return res.status(500).json({ success: false });
      }
      
      // 删除用户
      db.run('DELETE FROM users WHERE id = ?', [userId], (err) => {
        if (err) {
          db.run('ROLLBACK');
          return res.status(500).json({ success: false });
        }
        
        db.run('COMMIT', () => {
          res.json({ success: true, message: '账号注销成功' });
        });
      });
    });
  });
});

// 好友相关表（初始化）
db.run(`CREATE TABLE IF NOT EXISTS friends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  friend_id TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, friend_id)
)`);

// 好友申请接口
app.post('/api/add-friend', (req, res) => {
  const { userId, friendId } = req.body;
  if (!userId || !friendId) {
    return res.status(400).json({ success: false, message: '参数不能为空' });
  }
  
  db.run('INSERT INTO friends (user_id, friend_id) VALUES (?, ?)', [userId, friendId], (err) => {
    if (err) {
      console.error('添加好友失败:', err);
      return res.status(500).json({ success: false, message: '添加失败' });
    }
    res.json({ success: true, message: '好友添加成功' });
  });
});

// 获取好友列表接口
app.get('/api/friends', (req, res) => {
  const { userId } = req.query;
  if (!userId) {
    return res.status(400).json({ success: false, message: '参数不能为空' });
  }
  
  db.all(`SELECT u.id, u.username 
          FROM friends f
          JOIN users u ON f.friend_id = u.id
          WHERE f.user_id = ?`, [userId], (err, rows) => {
    if (err) {
      console.error('获取好友列表失败:', err);
      return res.status(500).json({ success: false });
    }
    res.json({ success: true, list: rows });
  });
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
