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
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      is_deleted INTEGER DEFAULT 0
    )`, (err) => {
      if (err) console.error('创建用户表失败:', err.message);
    });

    // 创建消息表（支持多房间）
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

    // 创建好友申请表
    db.run(`CREATE TABLE IF NOT EXISTS friend_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_id TEXT NOT NULL,
      from_username TEXT NOT NULL,
      to_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
      if (err) console.error('创建好友申请表失败:', err.message);
    });

    // 创建好友关系表
    db.run(`CREATE TABLE IF NOT EXISTS friends (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      friend_id TEXT NOT NULL,
      friend_username TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, friend_id)
    )`, (err) => {
      if (err) console.error('创建好友关系表失败:', err.message);
    });
  }
});

// 生成随机唯一用户ID (8位字母数字组合)
function generateUniqueUserId() {
  return new Promise((resolve, reject) => {
    const generateId = () => {
      const id = crypto.randomBytes(4).toString('hex').toUpperCase();
      // 检查ID是否已存在（排除已删除的用户）
      db.get('SELECT id FROM users WHERE id = ? AND is_deleted = 0', [id], (err, row) => {
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

    // 检查用户名是否已存在（排除已删除的用户）
    const existingUser = await new Promise((resolve) => {
      db.get('SELECT username FROM users WHERE username = ? AND is_deleted = 0', [username], (err, row) => {
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

  // 验证用户（排除已删除的用户）
  db.get('SELECT id, username FROM users WHERE username = ? AND password = ? AND is_deleted = 0', 
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

// 4. 添加好友申请接口
app.post('/api/add-friend', (req, res) => {
  const { from_id, from_username, to_id } = req.body;

  if (!from_id || !from_username || !to_id) {
    return res.status(400).json({ success: false, message: '参数不全' });
  }

  if (from_id === to_id) {
    return res.status(400).json({ success: false, message: '不能添加自己为好友' });
  }

  // 检查对方是否存在
  db.get('SELECT id FROM users WHERE id = ? AND is_deleted = 0', [to_id], (err, user) => {
    if (err || !user) {
      return res.status(400).json({ success: false, message: '好友ID不存在' });
    }

    // 检查是否已发送过申请
    db.get('SELECT id FROM friend_requests WHERE from_id = ? AND to_id = ? AND status = "pending"', 
      [from_id, to_id], (err, req) => {
        if (req) {
          return res.status(400).json({ success: false, message: '已发送过好友申请' });
        }

        // 检查是否已是好友
        db.get('SELECT id FROM friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)', 
          [from_id, to_id, to_id, from_id], (err, friend) => {
            if (friend) {
              return res.status(400).json({ success: false, message: '已是好友，无需重复添加' });
            }

            // 插入好友申请
            db.run('INSERT INTO friend_requests (from_id, from_username, to_id) VALUES (?, ?, ?)',
              [from_id, from_username, to_id], (err) => {
                if (err) {
                  console.error('添加好友申请失败:', err);
                  return res.status(500).json({ success: false, message: '添加好友申请失败' });
                }

                // 通知对方有好友申请
                if (userMap.has(to_id)) {
                  const toWs = userMap.get(to_id);
                  toWs.send(JSON.stringify({
                    type: 'friend_request',
                    from_id,
                    from_username
                  }));
                }

                res.json({ success: true, message: '好友申请已发送' });
              }
            );
          }
        );
      }
    );
  });
});

// 5. 获取好友申请列表接口
app.get('/api/friend-requests', (req, res) => {
  const { user_id } = req.query;

  if (!user_id) {
    return res.status(400).json({ success: false, message: '参数不全' });
  }

  db.all('SELECT id, from_id, from_username FROM friend_requests WHERE to_id = ? AND status = "pending"', 
    [user_id], (err, rows) => {
      if (err) {
        console.error('获取好友申请失败:', err);
        return res.status(500).json({ success: false, message: '获取好友申请失败' });
      }
      res.json({ success: true, list: rows });
    }
  );
});

// 6. 同意好友申请接口
app.post('/api/approve-friend', (req, res) => {
  const { request_id, to_id, to_username, from_id, from_username } = req.body;

  if (!request_id || !to_id || !from_id) {
    return res.status(400).json({ success: false, message: '参数不全' });
  }

  // 开启事务
  db.run('BEGIN TRANSACTION', (err) => {
    if (err) {
      return res.status(500).json({ success: false, message: '事务开启失败' });
    }

    // 更新申请状态
    db.run('UPDATE friend_requests SET status = "approved" WHERE id = ?', [request_id], (err) => {
      if (err) {
        db.run('ROLLBACK');
        return res.status(500).json({ success: false, message: '更新申请状态失败' });
      }

      // 添加好友关系（双向）
      db.run('INSERT OR IGNORE INTO friends (user_id, friend_id, friend_username) VALUES (?, ?, ?)',
        [to_id, from_id, from_username], (err) => {
          if (err) {
            db.run('ROLLBACK');
            return res.status(500).json({ success: false, message: '添加好友关系失败1' });
          }

          db.run('INSERT OR IGNORE INTO friends (user_id, friend_id, friend_username) VALUES (?, ?, ?)',
            [from_id, to_id, to_username], (err) => {
              if (err) {
                db.run('ROLLBACK');
                return res.status(500).json({ success: false, message: '添加好友关系失败2' });
              }

              // 提交事务
              db.run('COMMIT', (err) => {
                if (err) {
                  db.run('ROLLBACK');
                  return res.status(500).json({ success: false, message: '事务提交失败' });
                }

                // 通知对方已同意
                if (userMap.has(from_id)) {
                  const fromWs = userMap.get(from_id);
                  fromWs.send(JSON.stringify({
                    type: 'friend_approved',
                    from_id: to_id,
                    from_username: to_username
                  }));
                }

                res.json({ success: true, message: '已同意好友申请' });
              });
            }
          );
        }
      );
    });
  });
});

// 7. 拒绝好友申请接口
app.post('/api/reject-friend', (req, res) => {
  const { request_id } = req.body;

  if (!request_id) {
    return res.status(400).json({ success: false, message: '参数不全' });
  }

  db.run('UPDATE friend_requests SET status = "rejected" WHERE id = ?', [request_id], (err) => {
    if (err) {
      console.error('拒绝好友申请失败:', err);
      return res.status(500).json({ success: false, message: '拒绝好友申请失败' });
    }
    res.json({ success: true, message: '已拒绝好友申请' });
  });
});

// 8. 获取好友列表接口
app.get('/api/friends', (req, res) => {
  const { user_id } = req.query;

  if (!user_id) {
    return res.status(400).json({ success: false, message: '参数不全' });
  }

  db.all('SELECT friend_id, friend_username FROM friends WHERE user_id = ?', [user_id], (err, rows) => {
    if (err) {
      console.error('获取好友列表失败:', err);
      return res.status(500).json({ success: false, message: '获取好友列表失败' });
    }
    res.json({ success: true, list: rows });
  });
});

// 9. 删除好友接口
app.post('/api/delete-friend', (req, res) => {
  const { user_id, friend_id } = req.body;

  if (!user_id || !friend_id) {
    return res.status(400).json({ success: false, message: '参数不全' });
  }

  // 开启事务
  db.run('BEGIN TRANSACTION', (err) => {
    if (err) {
      return res.status(500).json({ success: false, message: '事务开启失败' });
    }

    // 删除双向好友关系
    db.run('DELETE FROM friends WHERE user_id = ? AND friend_id = ?', [user_id, friend_id], (err) => {
      if (err) {
        db.run('ROLLBACK');
        return res.status(500).json({ success: false, message: '删除好友关系失败1' });
      }

      db.run('DELETE FROM friends WHERE user_id = ? AND friend_id = ?', [friend_id, user_id], (err) => {
        if (err) {
          db.run('ROLLBACK');
          return res.status(500).json({ success: false, message: '删除好友关系失败2' });
        }

        // 提交事务
        db.run('COMMIT', (err) => {
          if (err) {
            db.run('ROLLBACK');
            return res.status(500).json({ success: false, message: '事务提交失败' });
          }

          res.json({ success: true, message: '已删除好友' });
        });
      });
    });
  });
});

// 10. 修改昵称接口
app.post('/api/rename', (req, res) => {
  const { user_id, new_username } = req.body;

  if (!user_id || !new_username) {
    return res.status(400).json({ success: false, message: '参数不全' });
  }

  // 检查新昵称是否已被使用
  db.get('SELECT id FROM users WHERE username = ? AND id != ? AND is_deleted = 0', 
    [new_username, user_id], (err, user) => {
      if (user) {
        return res.status(400).json({ success: false, message: '昵称已被使用' });
      }

      // 更新用户昵称
      db.run('UPDATE users SET username = ? WHERE id = ? AND is_deleted = 0', 
        [new_username, user_id], (err) => {
          if (err) {
            console.error('修改昵称失败:', err);
            return res.status(500).json({ success: false, message: '修改昵称失败' });
          }

          // 更新好友列表中的昵称
          db.run('UPDATE friends SET friend_username = ? WHERE friend_id = ?', 
            [new_username, user_id], (err) => {
              if (err) {
                console.error('更新好友列表昵称失败:', err);
              }

              res.json({ success: true, message: '昵称修改成功' });
            }
          );
        }
      );
    }
  );
});

// 11. 注销账号接口
app.post('/api/delete-account', (req, res) => {
  const { user_id } = req.body;

  if (!user_id) {
    return res.status(400).json({ success: false, message: '参数不全' });
  }

  // 开启事务
  db.run('BEGIN TRANSACTION', (err) => {
    if (err) {
      return res.status(500).json({ success: false, message: '事务开启失败' });
    }

    // 标记用户为已删除
    db.run('UPDATE users SET is_deleted = 1, username = username || "_deleted_" || id WHERE id = ?', 
      [user_id], (err) => {
        if (err) {
          db.run('ROLLBACK');
          return res.status(500).json({ success: false, message: '标记用户删除失败' });
        }

        // 删除好友关系
        db.run('DELETE FROM friends WHERE user_id = ? OR friend_id = ?', [user_id, user_id], (err) => {
          if (err) {
            db.run('ROLLBACK');
            return res.status(500).json({ success: false, message: '删除好友关系失败' });
          }

          // 删除好友申请
          db.run('DELETE FROM friend_requests WHERE from_id = ? OR to_id = ?', [user_id, user_id], (err) => {
            if (err) {
              db.run('ROLLBACK');
              return res.status(500).json({ success: false, message: '删除好友申请失败' });
            }

            // 顶掉用户的连接
            if (userMap.has(user_id)) {
              const ws = userMap.get(user_id);
              ws.close();
              userMap.delete(user_id);
            }

            // 提交事务
            db.run('COMMIT', (err) => {
              if (err) {
                db.run('ROLLBACK');
                return res.status(500).json({ success: false, message: '事务提交失败' });
              }

              res.json({ success: true, message: '账号注销成功' });
            });
          });
        });
      }
    );
  });
});

// 在线用户映射：userId => ws
const userMap = new Map();
// ws => { userId, username, room }
const wsToUser = new WeakMap();

// 12. WebSocket 实时聊天处理（支持多房间 + 私聊）
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
          wsToUser.set(ws,
