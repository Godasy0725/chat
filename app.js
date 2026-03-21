const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const bodyParser = require('body-parser');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const FRONTEND_DOMAIN = 'https://lmx.is-best.net';

app.use(cors({
  origin: FRONTEND_DOMAIN,
  credentials: true
}));
app.use(bodyParser.json());

// 数据库
const db = new sqlite3.Database('./database.db', err => {
  if (err) console.error('DB error', err.message);
  else console.log('DB connected');
});

// 创建表
db.run(`CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

db.run(`CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  username TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// 生成唯一ID
function generateUniqueUserId() {
  return new Promise((resolve, reject) => {
    function gen() {
      const id = crypto.randomBytes(4).toString('hex').toUpperCase();
      db.get('SELECT id FROM users WHERE id = ?', [id], (err, row) => {
        if (err) return reject(err);
        if (row) return gen();
        resolve(id);
      });
    }
    gen();
  });
}

// 注册
app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password)
      return res.status(400).json({ success: false, message: '不能为空' });

    db.get('SELECT username FROM users WHERE username = ?', [username], async (err, row) => {
      if (row) return res.status(400).json({ success: false, message: '用户名已存在' });
      const userId = await generateUniqueUserId();
      db.run('INSERT INTO users (id, username, password) VALUES (?,?,?)',
        [userId, username, password],
        err => {
          if (err) return res.status(500).json({ success: false });
          res.json({ success: true, data: { userId, username } });
        }
      );
    });
  } catch (e) {
    res.status(500).json({ success: false });
  }
});

// 登录（单账号唯一）
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ success: false, message: '不能为空' });

  db.get('SELECT id, username FROM users WHERE username=? AND password=?',
    [username, password], (err, user) => {
      if (err || !user)
        return res.status(401).json({ success: false, message: '账号或密码错误' });

      // 顶掉旧连接
      if (userMap.has(user.id)) {
        const oldWs = userMap.get(user.id);
        oldWs.send(JSON.stringify({ type: 'kick', reason: '你的账号在别处登录' }));
        oldWs.close(4001, 'replaced');
      }

      res.json({ success: true, data: { userId: user.id, username: user.username } });
    });
});

// 获取历史消息
app.get('/api/history', (req, res) => {
  db.all(`SELECT user_id, username, content,
          datetime(created_at, '+8 hours') as created_at
          FROM messages
          ORDER BY id ASC
          LIMIT 500`, (err, rows) => {
    if (err) return res.status(500).json({ success: false });
    res.json({ success: true, list: rows });
  });
});

// 在线用户映射：userId => ws
const userMap = new Map();
// ws => userId
const wsToUid = new WeakMap();

wss.on('connection', ws => {
  ws.on('message', data => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'login') {
        const { userId, username } = msg;
        if (!userId) return;

        // 单处登录：踢旧
        if (userMap.has(userId)) {
          const old = userMap.get(userId);
          old.send(JSON.stringify({ type: 'kick', reason: '账号在别处登录' }));
          old.close(4001, 'replaced');
        }

        userMap.set(userId, ws);
        wsToUid.set(ws, userId);

        // 广播上线
        broadcast({
          type: 'system',
          content: `${username} (ID:${userId}) 加入聊天室`
        });
      }

      // 聊天消息 + 入库
      if (msg.type === 'chat') {
        const userId = wsToUid.get(ws);
        if (!userId) return;

        db.get('SELECT username FROM users WHERE id=?', [userId], (err, row) => {
          if (!row) return;
          const username = row.username;
          // 存库
          db.run('INSERT INTO messages (user_id, username, content) VALUES (?,?,?)',
            [userId, username, msg.content]);
          // 广播
          broadcast({
            type: 'chat',
            userId,
            username,
            content: msg.content
          });
        });
      }
    } catch (e) {}
  });

  ws.on('close', () => {
    const userId = wsToUid.get(ws);
    if (userId) {
      userMap.delete(userId);
      wsToUid.delete(ws);
    }
  });
});

function broadcast(data) {
  wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify(data));
  });
}

app.get('/', (req, res) => res.send('running'));

server.listen(PORT, () => {
  console.log(`Server on ${PORT}`);
});

// 获取历史消息接口（无需修改，已包含时间）
app.get('/api/history', (req, res) => {
  db.all(`SELECT user_id, username, content,
          datetime(created_at, '+8 hours') as created_at  // 已转换为北京时间
          FROM messages
          ORDER BY id ASC
          LIMIT 500`, (err, rows) => {
    if (err) return res.status(500).json({ success: false });
    res.json({ success: true, list: rows });
  });
});
