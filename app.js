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
app.use(bodyParser.urlencoded({ extended: true }));

// 初始化数据库
const db = new sqlite3.Database('./database.db', (err) => {
  if (err) {
    console.error('数据库连接失败:', err.message);
  } else {
    console.log('成功连接到SQLite数据库');
    
    // 用户表
    db.run(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // 消息表
    db.run(`CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      content TEXT NOT NULL,
      room TEXT NOT NULL DEFAULT '喵喵粉丝群',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // 好友申请表
    db.run(`CREATE TABLE IF NOT EXISTS friend_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_user_id TEXT NOT NULL,
      from_username TEXT NOT NULL,
      to_user_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // 好友关系表
    db.run(`CREATE TABLE IF NOT EXISTS friendships (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      friend_id TEXT NOT NULL,
      friend_username TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, friend_id)
    )`);
  }
});

// 生成唯一用户ID
function generateUniqueUserId() {
  return new Promise((resolve, reject) => {
    const generateId = () => {
      const id = crypto.randomBytes(4).toString('hex').toUpperCase();
      db.get('SELECT id FROM users WHERE id = ?', [id], (err, row) => {
        if (err) reject(err);
        else if (row) generateId();
        else resolve(id);
      });
    };
    generateId();
  });
}

// 1. 注册接口
app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, message: '用户名和密码不能为空' });
    }

    const existingUser = await new Promise((resolve) => {
      db.get('SELECT username FROM users WHERE username = ?', [username], (err, row) => {
        resolve(row);
      });
    });

    if (existingUser) {
      return res.status(400).json({ success: false, message: '用户名已存在' });
    }

    const userId = await generateUniqueUserId();

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

  if (!username || !password) {
    return res.status(400).json({ success: false, message: '用户名和密码不能为空' });
  }

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

      if (userMap.has(row.id)) {
        const oldWs = userMap.get(row.id);
        oldWs.send(JSON.stringify({ 
          type: 'kick', 
          reason: '你的账号在其他设备登录' 
        }));
        oldWs.close(4001, 'replaced');
      }

      res.status(200).json({
        success: true,
        message: '登录成功',
        data: { userId: row.id, username: row.username }
      });
    }
  );
});

// 3. 获取群聊历史消息
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

// 4. 修改昵称接口
app.post('/api/rename', (req, res) => {
  const { userId, newName } = req.body;
  
  if (!userId || !newName) {
    return res.status(400).json({ success: false, message: '参数不能为空' });
  }

  // 检查新昵称是否已存在
  db.get('SELECT id FROM users WHERE username = ? AND id != ?', [newName, userId], (err, row) => {
    if (err) {
      return res.status(500).json({ success: false, message: '服务器错误' });
    }
    if (row) {
      return res.status(400).json({ success: false, message: '昵称已被使用' });
    }

    // 更新用户名
    db.run('UPDATE users SET username = ? WHERE id = ?', [newName, userId], (err) => {
      if (err) {
        return res.status(500).json({ success: false, message: '修改失败' });
      }

      // 更新好友关系中的昵称
      db.run('UPDATE friendships SET friend_username = ? WHERE friend_id = ?', [newName, userId]);
      db.run('UPDATE friend_requests SET from_username = ? WHERE from_user_id = ?', [newName, userId]);

      res.json({ success: true, message: '昵称修改成功' });
    });
  });
});

// 5. 注销账号接口
app.post('/api/delete-account', (req, res) => {
  const { userId } = req.body;
  
  if (!userId) {
    return res.status(400).json({ success: false, message: '参数不能为空' });
  }

  // 开启事务删除所有相关数据
  db.serialize(() => {
    db.run('BEGIN TRANSACTION');
    
    // 删除用户消息
    db.run('DELETE FROM messages WHERE user_id = ?', [userId]);
    // 删除好友申请
    db.run('DELETE FROM friend_requests WHERE from_user_id = ? OR to_user_id = ?', [userId, userId]);
    // 删除好友关系
    db.run('DELETE FROM friendships WHERE user_id = ? OR friend_id = ?', [userId, userId]);
    // 删除用户
    db.run('DELETE FROM users WHERE id = ?', [userId], (err) => {
      if (err) {
        db.run('ROLLBACK');
        return res.status(500).json({ success: false, message: '注销失败' });
      }
      db.run('COMMIT');
      res.json({ success: true, message: '账号注销成功' });
    });
  });
});

// 6. 发送好友申请
app.post('/api/add-friend', (req, res) => {
  const { userId, friendId } = req.body;
  
  if (!userId || !friendId) {
    return res.status(400).json({ success: false, message: '参数不能为空' });
  }

  // 检查好友ID是否存在
  db.get('SELECT id, username FROM users WHERE id = ?', [friendId], (err, friend) => {
    if (err || !friend) {
      return res.status(400).json({ success: false, message: '好友ID不存在' });
    }

    // 检查是否已是好友
    db.get('SELECT id FROM friendships WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)', 
      [userId, friendId, friendId, userId], (err, row) => {
        if (row) {
          return res.status(400).json({ success: false, message: '已是好友' });
        }

        // 检查是否已发送申请
        db.get('SELECT id FROM friend_requests WHERE from_user_id = ? AND to_user_id = ? AND status = ?', 
          [userId, friendId, 'pending'], (err, row) => {
            if (row) {
              return res.status(400).json({ success: false, message: '已发送好友申请' });
            }

            // 获取当前用户信息
            db.get('SELECT username FROM users WHERE id = ?', [userId], (err, user) => {
              if (err || !user) {
                return res.status(500).json({ success: false, message: '获取用户信息失败' });
              }

              // 插入好友申请
              db.run('INSERT INTO friend_requests (from_user_id, from_username, to_user_id) VALUES (?, ?, ?)', 
                [userId, user.username, friendId], (err) => {
                  if (err) {
                    return res.status(500).json({ success: false, message: '发送申请失败' });
                  }

                  // 通知对方有好友申请
                  notifyFriendRequest(friendId, userId, user.username);

                  res.json({ success: true, message: '好友申请已发送' });
                }
              );
            });
          }
        );
      }
    );
  });
});

// 7. 获取好友申请列表
app.get('/api/friend-requests', (req, res) => {
  const { userId } = req.query;
  
  if (!userId) {
    return res.status(400).json({ success: false, message: '参数不能为空' });
  }

  db.all('SELECT * FROM friend_requests WHERE to_user_id = ? AND status = ?', 
    [userId, 'pending'], (err, rows) => {
      if (err) {
        return res.status(500).json({ success: false, message: '获取申请列表失败' });
      }
      res.json({ success: true, list: rows });
    }
  );
});

// 8. 同意好友申请
app.post('/api/accept-friend', (req, res) => {
  const { requestId } = req.body;
  
  if (!requestId) {
    return res.status(400).json({ success: false, message: '参数不能为空' });
  }

  // 获取申请信息
  db.get('SELECT * FROM friend_requests WHERE id = ?', [requestId], (err, req) => {
    if (err || !req) {
      return res.status(400).json({ success: false, message: '申请不存在' });
    }

    // 更新申请状态
    db.run('UPDATE friend_requests SET status = ? WHERE id = ?', ['accepted', requestId], (err) => {
      if (err) {
        return res.status(500).json({ success: false, message: '同意申请失败' });
      }

      // 获取双方用户名
      db.get('SELECT username FROM users WHERE id = ?', [req.from_user_id], (err, fromUser) => {
        db.get('SELECT username FROM users WHERE id = ?', [req.to_user_id], (err, toUser) => {
          // 建立双向好友关系
          db.run('INSERT OR IGNORE INTO friendships (user_id, friend_id, friend_username) VALUES (?, ?, ?)', 
            [req.from_user_id, req.to_user_id, toUser.username]);
          db.run('INSERT OR IGNORE INTO friendships (user_id, friend_id, friend_username) VALUES (?, ?, ?)', 
            [req.to_user_id, req.from_user_id, fromUser.username], (err) => {
              if (err) {
                return res.status(500).json({ success: false, message: '建立好友关系失败' });
              }
              res.json({ success: true, message: '已同意好友申请' });
            }
          );
        });
      });
    });
  });
});

// 9. 拒绝好友申请
app.post('/api/reject-friend', (req, res) => {
  const { requestId } = req.body;
  
  if (!requestId) {
    return res.status(400).json({ success: false, message: '参数不能为空' });
  }

  db.run('UPDATE friend_requests SET status = ? WHERE id = ?', ['rejected', requestId], (err) => {
    if (err) {
      return res.status(500).json({ success: false, message: '拒绝申请失败' });
    }
    res.json({ success: true, message: '已拒绝好友申请' });
  });
});

// 10. 获取好友列表
app.get('/api/friends', (req, res) => {
  const { userId } = req.query;
  
  if (!userId) {
    return res.status(400).json({ success: false, message: '参数不能为空' });
  }

  db.all('SELECT * FROM friendships WHERE user_id = ?', [userId], (err, rows) => {
    if (err) {
      return res.status(500).json({ success: false, message: '获取好友列表失败' });
    }
    res.json({ success: true, list: rows });
  });
});

// 11. 删除好友
app.post('/api/delete-friend', (req, res) => {
  const { friendshipId } = req.body;
  
  if (!friendshipId) {
    return res.status(400).json({ success: false, message: '参数不能为空' });
  }

  // 获取好友关系信息
  db.get('SELECT user_id, friend_id FROM friendships WHERE id = ?', [friendshipId], (err, fs) => {
    if (err || !fs) {
      return res.status(400).json({ success: false, message: '好友关系不存在' });
    }

    // 删除双向好友关系
    db.run('DELETE FROM friendships WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)', 
      [fs.user_id, fs.friend_id, fs.friend_id, fs.user_id], (err) => {
        if (err) {
          return res.status(500).json({ success: false, message: '删除好友失败' });
        }
        res.json({ success: true, message: '已删除好友' });
      }
    );
  });
});

// 在线用户映射
const userMap = new Map();
const wsToUser = new WeakMap();

// 通知好友申请
function notifyFriendRequest(toUserId, fromUserId, fromUsername) {
  // 查找对方的WebSocket连接
  if (userMap.has(toUserId)) {
    const ws = userMap.get(toUserId);
    ws.send(JSON.stringify({
      type: 'friend_request',
      fromUserId,
      fromUsername
    }));
  }
}

// WebSocket处理
wss.on('connection', (ws) => {
  console.log('新的WebSocket连接');

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      if (data.type === 'login') {
        const { userId, username, room = '喵喵粉丝群' } = data;
        if (userId && username) {
          if (userMap.has(userId)) {
            const oldWs = userMap.get(userId);
            oldWs.send(JSON.stringify({ type: 'kick', reason: '你的账号在别处登录' }));
            oldWs.close(4001, 'replaced');
          }

          userMap.set(userId, ws);
          wsToUser.set(ws, { userId, username, room });

          broadcast({
            type: 'system',
            content: `${username} (ID: ${userId}) 加入了聊天室`,
            room: room
          });
        }
      }

      if (data.type === 'chat' && wsToUser.has(ws)) {
        const userInfo = wsToUser.get(ws);
        const { userId, username } = userInfo;
        const { content, room = '喵喵粉丝群' } = data;

        db.run('INSERT INTO messages (user_id, username, content, room) VALUES (?, ?, ?, ?)',
          [userId, username, content, room], (err) => {
            if (err) console.error('保存消息失败:', err);
          });

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

  ws.on('close', () => {
    if (wsToUser.has(ws)) {
      const { userId, username, room } = wsToUser.get(ws);
      userMap.delete(userId);
      wsToUser.delete(ws);
      broadcast({
        type: 'system',
        content: `${username} (ID: ${userId}) 离开了聊天室`,
        room: room
      });
    }
    console.log('WebSocket连接关闭');
  });

  ws.on('error', (error) => {
    console.error('WebSocket错误:', error);
  });
});

// 广播消息
function broadcast(message) {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      const clientInfo = wsToUser.get(client);
      if (clientInfo && clientInfo.room === message.room) {
        client.send(JSON.stringify(message));
      }
    }
  });
}

// 健康检查
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
