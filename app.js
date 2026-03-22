const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const bodyParser = require('body-parser');

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
      username TEXT PRIMARY KEY,
      password TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
      if (err) console.error('创建用户表失败:', err.message);
    });

    // 创建群聊消息表
    db.run(`CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      content TEXT NOT NULL,
      room TEXT NOT NULL DEFAULT '喵喵粉丝群',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
      if (err) console.error('创建消息表失败:', err.message);
    });

    // 创建私聊消息表
    db.run(`CREATE TABLE IF NOT EXISTS private_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender TEXT NOT NULL,
      receiver TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
      if (err) console.error('创建私聊消息表失败:', err.message);
    });

    // 创建好友申请表
    db.run(`CREATE TABLE IF NOT EXISTS friend_applies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_user TEXT NOT NULL,
      to_user TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(from_user, to_user)
    )`, (err) => {
      if (err) console.error('创建好友申请表失败:', err.message);
    });

    // 创建好友关系表
    db.run(`CREATE TABLE IF NOT EXISTS friends (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user1 TEXT NOT NULL,
      user2 TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user1, user2)
    )`, (err) => {
      if (err) console.error('创建好友关系表失败:', err.message);
    });

    // 房间表（一人一个）
    db.run(`CREATE TABLE IF NOT EXISTS rooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      owner TEXT NOT NULL UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
      if (err) console.error('创建房间表失败:', err.message);
    });

    // 房间禁言表
    db.run(`CREATE TABLE IF NOT EXISTS room_mutes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room TEXT NOT NULL,
      username TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(room, username)
    )`, (err) => {
      if (err) console.error('创建禁言表失败:', err.message);
    });

    // 房间黑名单（踢人）
    db.run(`CREATE TABLE IF NOT EXISTS room_bans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room TEXT NOT NULL,
      username TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(room, username)
    )`, (err) => {
      if (err) console.error('创建黑名单表失败:', err.message);
    });
  }
});

// 1. 注册接口
app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  
  // 验证参数
  if (!username || !password) {
    return res.status(400).json({ success: false, message: '用户名和密码不能为空' });
  }

  // 检查用户名是否已存在
  db.get('SELECT username FROM users WHERE username = ?', [username], (err, row) => {
    if (err) {
      console.error('注册失败:', err);
      return res.status(500).json({ success: false, message: '服务器内部错误' });
    }
    if (row) {
      return res.status(400).json({ success: false, message: '用户名已存在' });
    }

    // 插入新用户
    db.run('INSERT INTO users (username, password) VALUES (?, ?)', 
      [username, password], 
      (err) => {
        if (err) {
          console.error('插入用户失败:', err);
          return res.status(500).json({ success: false, message: '服务器内部错误' });
        }
        res.status(200).json({
          success: true,
          message: '注册成功',
          data: { username }
        });
      }
    );
  });
});

// 2. 登录接口（单账号唯一登录）
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;

  // 验证参数
  if (!username || !password) {
    return res.status(400).json({ success: false, message: '用户名和密码不能为空' });
  }

  // 验证用户
  db.get('SELECT username FROM users WHERE username = ? AND password = ?', 
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
      if (userMap.has(username)) {
        const oldWs = userMap.get(username);
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
        data: { username }
      });
    }
  );
});

// 3. 修改昵称接口
app.post('/api/rename', (req, res) => {
  const { oldName, newName } = req.body;

  if (!oldName || !newName || oldName === newName) {
    return res.status(400).json({ success: false, message: '参数错误' });
  }

  // 检查新昵称是否已存在
  db.get('SELECT username FROM users WHERE username = ?', [newName], (err, row) => {
    if (err) {
      return res.status(500).json({ success: false, message: '服务器内部错误' });
    }
    if (row) {
      return res.status(400).json({ success: false, message: '新昵称已被使用' });
    }

    // 事务：更新所有相关表
    db.serialize(() => {
      db.run('BEGIN TRANSACTION');
      
      // 更新用户表
      db.run('UPDATE users SET username = ? WHERE username = ?', [newName, oldName]);
      // 更新群聊消息表
      db.run('UPDATE messages SET username = ? WHERE username = ?', [newName, oldName]);
      // 更新私聊消息表（发送者）
      db.run('UPDATE private_messages SET sender = ? WHERE sender = ?', [newName, oldName]);
      // 更新私聊消息表（接收者）
      db.run('UPDATE private_messages SET receiver = ? WHERE receiver = ?', [newName, oldName]);
      // 更新好友申请表（发起者）
      db.run('UPDATE friend_applies SET from_user = ? WHERE from_user = ?', [newName, oldName]);
      // 更新好友申请表（接收者）
      db.run('UPDATE friend_applies SET to_user = ? WHERE to_user = ?', [newName, oldName]);
      // 更新好友关系表
      db.run('UPDATE friends SET user1 = ? WHERE user1 = ?', [newName, oldName]);
      db.run('UPDATE friends SET user2 = ? WHERE user2 = ?', [newName, oldName]);
      // 更新房间表（房主）
      db.run('UPDATE rooms SET owner = ? WHERE owner = ?', [newName, oldName]);
      // 更新房间禁言表
      db.run('UPDATE room_mutes SET username = ? WHERE username = ?', [newName, oldName]);
      // 更新房间黑名单
      db.run('UPDATE room_bans SET username = ? WHERE username = ?', [newName, oldName]);
      
      db.run('COMMIT', (err) => {
        if (err) {
          db.run('ROLLBACK');
          return res.status(500).json({ success: false, message: '修改失败' });
        }
        
        // 更新在线用户映射
        if (userMap.has(oldName)) {
          const ws = userMap.get(oldName);
          userMap.delete(oldName);
          userMap.set(newName, ws);
          wsToUser.set(ws, { username: newName, room: wsToUser.get(ws).room });
        }
        
        // 广播房间列表更新
        broadcastRoomList();
        
        res.json({ success: true, message: '昵称修改成功' });
      });
    });
  });
});

// 4. 注销账号接口
app.post('/api/delete-account', (req, res) => {
  const { username } = req.body;

  if (!username) {
    return res.status(400).json({ success: false, message: '参数错误' });
  }

  // 顶掉连接
  if (userMap.has(username)) {
    const oldWs = userMap.get(username);
    oldWs.close();
    userMap.delete(username);
  }

  // 事务：删除所有相关数据
  db.serialize(() => {
    db.run('BEGIN TRANSACTION');
    
    // 删除用户相关
    db.run('DELETE FROM users WHERE username = ?', [username]);
    db.run('DELETE FROM messages WHERE username = ?', [username]);
    db.run('DELETE FROM private_messages WHERE sender = ? OR receiver = ?', [username, username]);
    db.run('DELETE FROM friend_applies WHERE from_user = ? OR to_user = ?', [username, username]);
    db.run('DELETE FROM friends WHERE user1 = ? OR user2 = ?', [username, username]);
    
    // 删除房间相关
    db.run('DELETE FROM rooms WHERE owner = ?', [username]);
    db.run('DELETE FROM room_mutes WHERE username = ?', [username]);
    db.run('DELETE FROM room_bans WHERE username = ?', [username]);
    
    db.run('COMMIT', (err) => {
      if (err) {
        db.run('ROLLBACK');
        return res.status(500).json({ success: false, message: '注销失败' });
      }
      
      // 广播房间列表更新
      broadcastRoomList();
      
      res.json({ success: true, message: '账号注销成功' });
    });
  });
});

// 5. 添加好友接口
app.post('/api/add-friend', (req, res) => {
  const { from, to } = req.body;

  if (!from || !to || from === to) {
    return res.status(400).json({ success: false, message: '参数错误' });
  }

  // 检查对方是否存在
  db.get('SELECT username FROM users WHERE username = ?', [to], (err, row) => {
    if (err) {
      return res.status(500).json({ success: false, message: '服务器内部错误' });
    }
    if (!row) {
      return res.status(400).json({ success: false, message: '用户不存在' });
    }

    // 检查是否已发送申请
    db.get('SELECT id FROM friend_applies WHERE from_user = ? AND to_user = ?', [from, to], (err, row) => {
      if (err) {
        return res.status(500).json({ success: false, message: '服务器内部错误' });
      }
      if (row) {
        return res.status(400).json({ success: false, message: '已发送好友申请' });
      }

      // 检查是否已是好友
      db.get(`SELECT id FROM friends WHERE (user1 = ? AND user2 = ?) OR (user1 = ? AND user2 = ?)`, 
        [from, to, to, from], (err, row) => {
          if (err) {
            return res.status(500).json({ success: false, message: '服务器内部错误' });
          }
          if (row) {
            return res.status(400).json({ success: false, message: '已是好友' });
          }

          // 插入申请
          db.run('INSERT INTO friend_applies (from_user, to_user) VALUES (?, ?)', [from, to], (err) => {
            if (err) {
              return res.status(500).json({ success: false, message: '发送申请失败' });
            }

            // 实时通知对方
            if (userMap.has(to)) {
              const ws = userMap.get(to);
              ws.send(JSON.stringify({
                type: 'friend_apply',
                from: from
              }));
            }

            res.json({ success: true, message: '好友申请发送成功' });
          });
        }
      );
    });
  });
});

// 6. 同意好友申请
app.post('/api/agree-friend', (req, res) => {
  const { from, to } = req.body;

  if (!from || !to) {
    return res.status(400).json({ success: false, message: '参数错误' });
  }

  // 事务：更新申请状态 + 添加好友关系
  db.serialize(() => {
    db.run('BEGIN TRANSACTION');
    
    // 更新申请状态
    db.run('UPDATE friend_applies SET status = ? WHERE from_user = ? AND to_user = ?', ['agreed', from, to]);
    // 添加好友关系
    db.run('INSERT INTO friends (user1, user2) VALUES (?, ?)', [from, to]);
    
    db.run('COMMIT', (err) => {
      if (err) {
        db.run('ROLLBACK');
        return res.status(500).json({ success: false, message: '同意失败' });
      }
      res.json({ success: true, message: '已同意好友申请' });
    });
  });
});

// 7. 拒绝好友申请
app.post('/api/reject-friend', (req, res) => {
  const { from, to } = req.body;

  if (!from || !to) {
    return res.status(400).json({ success: false, message: '参数错误' });
  }

  db.run('UPDATE friend_applies SET status = ? WHERE from_user = ? AND to_user = ?', 
    ['rejected', from, to], (err) => {
      if (err) {
        return res.status(500).json({ success: false, message: '拒绝失败' });
      }
      res.json({ success: true, message: '已拒绝好友申请' });
    }
  );
});

// 8. 删除好友
app.post('/api/delete-friend', (req, res) => {
  const { user, friend } = req.body;

  if (!user || !friend) {
    return res.status(400).json({ success: false, message: '参数错误' });
  }

  db.run(`DELETE FROM friends WHERE (user1 = ? AND user2 = ?) OR (user1 = ? AND user2 = ?)`, 
    [user, friend, friend, user], (err) => {
      if (err) {
        return res.status(500).json({ success: false, message: '删除失败' });
      }
      res.json({ success: true, message: '好友删除成功' });
    }
  );
});

// 9. 获取好友申请列表
app.get('/api/friend-apply', (req, res) => {
  const { username } = req.query;

  if (!username) {
    return res.status(400).json({ success: false, message: '参数错误' });
  }

  db.all('SELECT from_user FROM friend_applies WHERE to_user = ? AND status = ?', 
    [username, 'pending'], (err, rows) => {
      if (err) {
        return res.status(500).json({ success: false, message: '获取失败' });
      }
      res.json({ 
        success: true, 
        list: rows.map(row => ({ from: row.from_user })) 
      });
    }
  );
});

// 10. 获取好友列表
app.get('/api/friend-list', (req, res) => {
  const { username } = req.query;

  if (!username) {
    return res.status(400).json({ success: false, message: '参数错误' });
  }

  db.all(`SELECT 
          CASE WHEN user1 = ? THEN user2 ELSE user1 END as friend 
          FROM friends 
          WHERE user1 = ? OR user2 = ?`, 
    [username, username, username], (err, rows) => {
      if (err) {
        return res.status(500).json({ success: false, message: '获取失败' });
      }
      res.json({ 
        success: true, 
        list: rows.map(row => row.friend) 
      });
    }
  );
});

// 11. 获取群聊历史消息
app.get('/api/history', (req, res) => {
  const { room = '喵喵粉丝群' } = req.query;
  
  db.all(`SELECT username, content,
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

// 12. 获取私聊历史消息
app.get('/api/private-history', (req, res) => {
  const { user, friend } = req.query;

  if (!user || !friend) {
    return res.status(400).json({ success: false, message: '参数错误' });
  }

  db.all(`SELECT sender, content,
          datetime(created_at, '+8 hours') as created_at
          FROM private_messages
          WHERE (sender = ? AND receiver = ?) OR (sender = ? AND receiver = ?)
          ORDER BY id ASC
          LIMIT 500`, [user, friend, friend, user], (err, rows) => {
    if (err) {
      return res.status(500).json({ success: false, message: '获取私聊记录失败' });
    }
    res.json({ success: true, list: rows });
  });
});

// 13. 保存私聊消息
app.post('/api/send-private', (req, res) => {
  const { sender, receiver, content } = req.body;

  if (!sender || !receiver || !content) {
    return res.status(400).json({ success: false, message: '参数错误' });
  }

  // 保存私聊消息到数据库
  db.run('INSERT INTO private_messages (sender, receiver, content) VALUES (?, ?, ?)', 
    [sender, receiver, content], (err) => {
      if (err) {
        return res.status(500).json({ success: false, message: '保存失败' });
      }
      res.json({ success: true, message: '发送成功' });
    }
  );
});

// ------------------- 房间管理核心接口 -------------------
// 14. 获取所有房间列表（修复其他人看不到房间的核心接口）
app.get('/api/all-rooms', (req, res) => {
  db.all('SELECT name, owner FROM rooms ORDER BY created_at ASC', (err, rows) => {
    if (err) {
      return res.status(500).json({ success: false, message: '获取房间列表失败' });
    }
    res.json({ success: true, rooms: rows || [] });
  });
});

// 15. 创建房间（一人一个）
app.post('/api/create-room', (req, res) => {
  const { username, name } = req.body;

  if (!username || !name) {
    return res.status(400).json({ success: false, message: '参数错误' });
  }

  // 检查是否已创建过房间
  db.get('SELECT name FROM rooms WHERE owner = ?', [username], (err, row) => {
    if (err) {
      return res.status(500).json({ success: false, message: '服务器错误' });
    }
    if (row) {
      return res.status(400).json({ success: false, message: '你已创建过房间：' + row.name });
    }

    // 检查房间名是否重复
    db.get('SELECT id FROM rooms WHERE name = ?', [name], (err, row) => {
      if (err) {
        return res.status(500).json({ success: false, message: '服务器错误' });
      }
      if (row) {
        return res.status(400).json({ success: false, message: '房间名已存在' });
      }

      // 创建房间
      db.run('INSERT INTO rooms (name, owner) VALUES (?, ?)', [name, username], (err) => {
        if (err) {
          return res.status(500).json({ success: false, message: '创建失败' });
        }
        
        // 关键：创建房间后立即广播更新，所有在线用户实时看到新房间
        broadcastRoomList();
        
        res.json({ success: true, message: '房间创建成功' });
      });
    });
  });
});

// 16. 踢人（群主专属）
app.post('/api/kick', (req, res) => {
  const { owner, room, username } = req.body;

  if (!owner || !room || !username) {
    return res.status(400).json({ success: false, message: '参数错误' });
  }

  // 验证是否是群主
  db.get('SELECT id FROM rooms WHERE name = ? AND owner = ?', [room, owner], (err, row) => {
    if (err || !row) {
      return res.status(403).json({ success: false, message: '你不是该房间群主' });
    }

    // 不能踢自己
    if (username === owner) {
      return res.status(400).json({ success: false, message: '不能踢自己' });
    }

    // 加入黑名单
    db.run('INSERT OR IGNORE INTO room_bans (room, username) VALUES (?, ?)', [room, username], (err) => {
      if (err) {
        return res.status(500).json({ success: false, message: '操作失败' });
      }

      // 实时通知被踢用户
      if (userMap.has(username)) {
        const ws = userMap.get(username);
        ws.send(JSON.stringify({
          type: 'room_kicked',
          room: room,
          reason: '你被群主踢出房间'
        }));
        // 强制离开房间
        if (wsToUser.get(ws)?.room === room) {
          wsToUser.set(ws, { username: username, room: '' });
        }
      }

      // 广播踢人消息
      broadcast({
        type: 'system',
        content: `${username} 被群主踢出房间`,
        room: room
      });

      res.json({ success: true, message: '踢人成功' });
    });
  });
});

// 17. 禁言（群主专属）
app.post('/api/mute', (req, res) => {
  const { owner, room, username } = req.body;

  if (!owner || !room || !username) {
    return res.status(400).json({ success: false, message: '参数错误' });
  }

  // 验证是否是群主
  db.get('SELECT id FROM rooms WHERE name = ? AND owner = ?', [room, owner], (err, row) => {
    if (err || !row) {
      return res.status(403).json({ success: false, message: '你不是该房间群主' });
    }

    // 不能禁言自己
    if (username === owner) {
      return res.status(400).json({ success: false, message: '不能禁言自己' });
    }

    // 加入禁言列表
    db.run('INSERT OR IGNORE INTO room_mutes (room, username) VALUES (?, ?)', [room, username], (err) => {
      if (err) {
        return res.status(500).json({ success: false, message: '操作失败' });
      }

      // 实时通知被禁言用户
      if (userMap.has(username)) {
        const ws = userMap.get(username);
        ws.send(JSON.stringify({
          type: 'room_muted',
          room: room,
          reason: '你被群主禁言'
        }));
      }

      // 广播禁言消息
      broadcast({
        type: 'system',
        content: `${username} 被群主禁言`,
        room: room
      });

      res.json({ success: true, message: '禁言成功' });
    });
  });
});

// 18. 清空房间消息（群主专属）
app.post('/api/clear-room', (req, res) => {
  const { owner, room } = req.body;

  if (!owner || !room) {
    return res.status(400).json({ success: false, message: '参数错误' });
  }

  // 验证是否是群主
  db.get('SELECT id FROM rooms WHERE name = ? AND owner = ?', [room, owner], (err, row) => {
    if (err || !row) {
      return res.status(403).json({ success: false, message: '你不是该房间群主' });
    }

    // 清空消息
    db.run('DELETE FROM messages WHERE room = ?', [room], (err) => {
      if (err) {
        return res.status(500).json({ success: false, message: '操作失败' });
      }

      // 广播清空消息
      broadcast({
        type: 'system',
        content: '群主清空了所有聊天记录',
        room: room
      });

      res.json({ success: true, message: '清空成功' });
    });
  });
});

// 19. 解散房间（群主专属）
app.post('/api/dismiss-room', (req, res) => {
  const { owner, room } = req.body;

  if (!owner || !room) {
    return res.status(400).json({ success: false, message: '参数错误' });
  }

  // 验证是否是群主
  db.get('SELECT id FROM rooms WHERE name = ? AND owner = ?', [room, owner], (err, row) => {
    if (err || !row) {
      return res.status(403).json({ success: false, message: '你不是该房间群主' });
    }

    // 事务：删除房间+相关数据
    db.serialize(() => {
      db.run('BEGIN TRANSACTION');
      
      // 删除房间
      db.run('DELETE FROM rooms WHERE name = ?', [room]);
      // 删除房间消息
      db.run('DELETE FROM messages WHERE room = ?', [room]);
      // 删除禁言记录
      db.run('DELETE FROM room_mutes WHERE room = ?', [room]);
      // 删除黑名单
      db.run('DELETE FROM room_bans WHERE room = ?', [room]);
      
      db.run('COMMIT', (err) => {
        if (err) {
          db.run('ROLLBACK');
          return res.status(500).json({ success: false, message: '操作失败' });
        }

        // 广播解散消息
        broadcast({
          type: 'system',
          content: '房间已被群主解散',
          room: room
        });

        // 通知所有房间用户
        wss.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN && wsToUser.has(client)) {
            const u = wsToUser.get(client);
            if (u.room === room) {
              client.send(JSON.stringify({
                type: 'room_dismissed',
                room: room,
                reason: '房间已解散'
              }));
              // 强制离开房间
              wsToUser.set(client, { username: u.username, room: '' });
            }
          }
        });

        // 广播房间列表更新
        broadcastRoomList();

        res.json({ success: true, message: '解散成功' });
      });
    });
  });
});

// ------------------- WebSocket 核心逻辑 -------------------
// 在线用户映射：username => ws
const userMap = new Map();
// ws => { username, room }
const wsToUser = new WeakMap();

// WebSocket 实时处理核心
wss.on('connection', (ws) => {
  console.log('新的WebSocket连接');

  // 接收客户端消息
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      console.log('收到客户端消息:', data);
      
      // 客户端登录（绑定用户）
      if (data.type === 'login') {
        const { username, room = '' } = data;
        if (username) {
          // 单处登录：踢旧
          if (userMap.has(username)) {
            const oldWs = userMap.get(username);
            oldWs.send(JSON.stringify({ type: 'kick', reason: '你的账号在别处登录' }));
            oldWs.close(4001, 'replaced');
          }

          // 绑定用户和房间
          userMap.set(username, ws);
          wsToUser.set(ws, { username, room });

          // 广播用户上线（仅同房间）
          if (room) {
            broadcast({
              type: 'system',
              content: `${username} 加入了聊天室`,
              room: room
            });
            console.log(`${username} 进入房间 ${room}`);
          }
        }
      }

      // 群聊消息（实时广播）
      if (data.type === 'chat') {
        const { username, content, room } = data;
        if (username && content && room) {
          // 检查是否被禁言
          db.get('SELECT id FROM room_mutes WHERE room = ? AND username = ?', [room, username], (err, row) => {
            if (row) {
              // 通知被禁言
              ws.send(JSON.stringify({
                type: 'system',
                content: '你已被禁言，无法发送消息',
                room: room
              }));
              return;
            }

            // 检查是否在黑名单
            db.get('SELECT id FROM room_bans WHERE room = ? AND username = ?', [room, username], (err, row) => {
              if (row) {
                // 通知被拉黑
                ws.send(JSON.stringify({
                  type: 'system',
                  content: '你已被踢出房间，无法发送消息',
                  room: room
                }));
                return;
              }

              // 保存到数据库
              db.run('INSERT INTO messages (username, content, room) VALUES (?, ?, ?)',
                [username, content, room], (err) => {
                  if (err) console.error('保存群聊消息失败:', err);
                });

              // 广播给同房间所有用户
              broadcast({
                type: 'chat',
                username,
                content,
                room
              });
            });
          });
        }
      }

      // 切换房间
      if (data.type === 'switch_room') {
        const { username, room } = data;
        if (username && room && wsToUser.has(ws)) {
          const old = wsToUser.get(ws);
          // 离开旧房间广播
          if (old.room) {
            broadcast({
              type: 'system',
              content: `${old.username} 离开了聊天室`,
              room: old.room
            });
          }

          // 检查目标房间是否被拉黑
          db.get('SELECT id FROM room_bans WHERE room = ? AND username = ?', [room, username], (err, row) => {
            if (row) {
              ws.send(JSON.stringify({
                type: 'system',
                content: '你已被该房间拉黑，无法进入',
                room: room
              }));
              return;
            }

            // 更新房间
            wsToUser.set(ws, { username, room });
            // 进入新房间广播
            broadcast({
              type: 'system',
              content: `${username} 加入了聊天室`,
              room
            });
          });
        }
      }

      // 私聊消息（实时）
      if (data.type === 'private_msg') {
        const { sender, receiver, content } = data;
        if (sender && receiver && content) {
          // 推送给接收方
          if (userMap.has(receiver)) {
            const targetWs = userMap.get(receiver);
            targetWs.send(JSON.stringify({
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
      }

      // 好友申请/同意/拒绝 实时通知
      if (data.type === 'friend_response') {
        const { to, message } = data;
        if (userMap.has(to)) {
          userMap.get(to).send(JSON.stringify({
            type: 'friend_response',
            message
          }));
        }
      }

      // 改名同步
      if (data.type === 'rename') {
        const { oldName, newName } = data;
        if (userMap.has(oldName)) {
          const wsObj = userMap.get(oldName);
          userMap.delete(oldName);
          userMap.set(newName, wsObj);
        }
      }
    } catch (e) {
      console.error('消息解析错误', e);
    }
  });

  // 断开连接
  ws.on('close', () => {
    const user = wsToUser.get(ws);
    if (user) {
      userMap.delete(user.username);
      // 离线广播
      broadcast({
        type: 'system',
        content: `${user.username} 离开了聊天室`,
        room: user.room
      });
    }
    wsToUser.delete(ws);
  });

  ws.on('error', (err) => {
    console.error('ws error', err);
  });
});

// 房间广播
function broadcast(msg) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && wsToUser.has(client)) {
      const u = wsToUser.get(client);
      if (u.room === msg.room) {
        client.send(JSON.stringify(msg));
      }
    }
  });
}

// 核心：广播房间列表更新（所有在线用户实时刷新房间列表）
function broadcastRoomList() {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'room_list_update' }));
    }
  });
}

// 启动服务
server.listen(PORT, () => {
  console.log(`服务器运行在端口 ${PORT}`);
});
