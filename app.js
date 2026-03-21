const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const bodyParser = require('body-parser');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

// 初始化Express应用
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// 配置
const PORT = process.env.PORT || 3000;
const FRONTEND_DOMAIN = '*'; // 生产环境请替换为实际前端域名
const UPLOAD_DIR = './uploads';

// 创建上传目录
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// 中间件
app.use(cors({
  origin: FRONTEND_DOMAIN,
  credentials: true
}));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// 文件上传配置
const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 10 * 1024 * 1024 } // 限制10MB
});

// 初始化SQLite数据库
const db = new sqlite3.Database('./database.db', (err) => {
  if (err) {
    console.error('数据库连接失败:', err.message);
  } else {
    console.log('成功连接到SQLite数据库');
    initDatabase();
  }
});

// 初始化数据库表结构
function initDatabase() {
  // 1. 用户表
  db.run(`CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY,
    password TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`, (err) => {
    if (err) console.error('创建用户表失败:', err.message);
  });

  // 2. 群聊消息表
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    content TEXT NOT NULL,
    room TEXT NOT NULL DEFAULT '喵喵粉丝群',
    is_admin INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`, (err) => {
    if (err) console.error('创建消息表失败:', err.message);
  });

  // 3. 私聊消息表
  db.run(`CREATE TABLE IF NOT EXISTS private_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender TEXT NOT NULL,
    receiver TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`, (err) => {
    if (err) console.error('创建私聊消息表失败:', err.message);
  });

  // 4. 好友申请表
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

  // 5. 好友关系表
  db.run(`CREATE TABLE IF NOT EXISTS friends (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user1 TEXT NOT NULL,
    user2 TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user1, user2)
  )`, (err) => {
    if (err) console.error('创建好友关系表失败:', err.message);
  });

  // 6. 房间表
  db.run(`CREATE TABLE IF NOT EXISTS rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    owner TEXT NOT NULL UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`, (err) => {
    if (err) console.error('创建房间表失败:', err.message);
  });

  // 7. 房间禁言表
  db.run(`CREATE TABLE IF NOT EXISTS room_mutes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room TEXT NOT NULL,
    username TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(room, username)
  )`, (err) => {
    if (err) console.error('创建禁言表失败:', err.message);
  });

  // 8. 房间黑名单
  db.run(`CREATE TABLE IF NOT EXISTS room_bans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room TEXT NOT NULL,
    username TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(room, username)
  )`, (err) => {
    if (err) console.error('创建黑名单表失败:', err.message);
  });

  // 9. 公告表
  db.run(`CREATE TABLE IF NOT EXISTS announcements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`, (err) => {
    if (err) console.error('创建公告表失败:', err.message);
  });
}

// ===================== 基础功能接口 =====================
// 1. 用户注册
app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ success: false, message: '用户名和密码不能为空' });
  }

  db.get('SELECT username FROM users WHERE username = ?', [username], (err, row) => {
    if (err) {
      console.error('注册失败:', err);
      return res.status(500).json({ success: false, message: '服务器内部错误' });
    }
    if (row) {
      return res.status(400).json({ success: false, message: '用户名已存在' });
    }

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

// 2. 用户登录（单账号唯一登录）
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ success: false, message: '用户名和密码不能为空' });
  }

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

      // 顶掉旧连接
      if (userMap.has(username)) {
        const oldWs = userMap.get(username);
        oldWs.send(JSON.stringify({ 
          type: 'kick', 
          reason: '你的账号在其他设备登录' 
        }));
        oldWs.close(4001, 'replaced');
      }

      res.status(200).json({
        success: true,
        message: '登录成功',
        data: { username }
      });
    }
  );
});

// 3. 修改昵称
app.post('/api/rename', (req, res) => {
  const { oldName, newName } = req.body;

  if (!oldName || !newName || oldName === newName) {
    return res.status(400).json({ success: false, message: '参数错误' });
  }

  db.get('SELECT username FROM users WHERE username = ?', [newName], (err, row) => {
    if (err) {
      return res.status(500).json({ success: false, message: '服务器内部错误' });
    }
    if (row) {
      return res.status(400).json({ success: false, message: '新昵称已被使用' });
    }

    // 事务更新所有相关表
    db.serialize(() => {
      db.run('BEGIN TRANSACTION');
      db.run('UPDATE users SET username = ? WHERE username = ?', [newName, oldName]);
      db.run('UPDATE messages SET username = ? WHERE username = ?', [newName, oldName]);
      db.run('UPDATE private_messages SET sender = ? WHERE sender = ?', [newName, oldName]);
      db.run('UPDATE private_messages SET receiver = ? WHERE receiver = ?', [newName, oldName]);
      db.run('UPDATE friend_applies SET from_user = ? WHERE from_user = ?', [newName, oldName]);
      db.run('UPDATE friend_applies SET to_user = ? WHERE to_user = ?', [newName, oldName]);
      db.run('UPDATE friends SET user1 = ? WHERE user1 = ?', [newName, oldName]);
      db.run('UPDATE friends SET user2 = ? WHERE user2 = ?', [newName, oldName]);
      db.run('UPDATE rooms SET owner = ? WHERE owner = ?', [newName, oldName]);
      db.run('UPDATE room_mutes SET username = ? WHERE username = ?', [newName, oldName]);
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
        
        broadcastRoomList();
        res.json({ success: true, message: '昵称修改成功' });
      });
    });
  });
});

// 4. 注销账号
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

  // 事务删除所有相关数据
  db.serialize(() => {
    db.run('BEGIN TRANSACTION');
    db.run('DELETE FROM users WHERE username = ?', [username]);
    db.run('DELETE FROM messages WHERE username = ?', [username]);
    db.run('DELETE FROM private_messages WHERE sender = ? OR receiver = ?', [username, username]);
    db.run('DELETE FROM friend_applies WHERE from_user = ? OR to_user = ?', [username, username]);
    db.run('DELETE FROM friends WHERE user1 = ? OR user2 = ?', [username, username]);
    db.run('DELETE FROM rooms WHERE owner = ?', [username]);
    db.run('DELETE FROM room_mutes WHERE username = ?', [username]);
    db.run('DELETE FROM room_bans WHERE username = ?', [username]);
    
    db.run('COMMIT', (err) => {
      if (err) {
        db.run('ROLLBACK');
        return res.status(500).json({ success: false, message: '注销失败' });
      }
      
      broadcastRoomList();
      res.json({ success: true, message: '账号注销成功' });
    });
  });
});

// 5. 添加好友
app.post('/api/add-friend', (req, res) => {
  const { from, to } = req.body;

  if (!from || !to || from === to) {
    return res.status(400).json({ success: false, message: '参数错误' });
  }

  db.get('SELECT username FROM users WHERE username = ?', [to], (err, row) => {
    if (err) {
      return res.status(500).json({ success: false, message: '服务器内部错误' });
    }
    if (!row) {
      return res.status(400).json({ success: false, message: '用户不存在' });
    }

    db.get('SELECT id FROM friend_applies WHERE from_user = ? AND to_user = ?', [from, to], (err, row) => {
      if (err) {
        return res.status(500).json({ success: false, message: '服务器内部错误' });
      }
      if (row) {
        return res.status(400).json({ success: false, message: '已发送好友申请' });
      }

      db.get(`SELECT id FROM friends WHERE (user1 = ? AND user2 = ?) OR (user1 = ? AND user2 = ?)`, 
        [from, to, to, from], (err, row) => {
          if (err) {
            return res.status(500).json({ success: false, message: '服务器内部错误' });
          }
          if (row) {
            return res.status(400).json({ success: false, message: '已是好友' });
          }

          db.run('INSERT INTO friend_applies (from_user, to_user) VALUES (?, ?)', [from, to], (err) => {
            if (err) {
              return res.status(500).json({ success: false, message: '发送申请失败' });
            }

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

  db.serialize(() => {
    db.run('BEGIN TRANSACTION');
    db.run('UPDATE friend_applies SET status = ? WHERE from_user = ? AND to_user = ?', ['agreed', from, to]);
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

  db.all('SELECT from_user, status, created_at FROM friend_applies WHERE to_user = ?', 
    [username], (err, rows) => {
      if (err) {
        return res.status(500).json({ success: false, message: '获取失败' });
      }
      res.json({ 
        success: true, 
        list: rows.map(row => ({ 
          from: row.from_user, 
          status: row.status,
          time: row.created_at
        })) 
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
  
  db.all(`SELECT id, username, content, is_admin,
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

  db.all(`SELECT sender, receiver, content,
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

  db.run('INSERT INTO private_messages (sender, receiver, content) VALUES (?, ?, ?)', 
    [sender, receiver, content], (err) => {
      if (err) {
        return res.status(500).json({ success: false, message: '保存失败' });
      }
      res.json({ success: true, message: '发送成功' });
    }
  );
});

// 14. 获取所有房间列表
app.get('/api/all-rooms', (req, res) => {
  db.all('SELECT name, owner, created_at FROM rooms ORDER BY created_at ASC', (err, rows) => {
    if (err) {
      return res.status(500).json({ success: false, message: '获取房间列表失败' });
    }
    res.json({ success: true, rooms: rows || [] });
  });
});

// 15. 创建房间（普通用户）
app.post('/api/create-room', (req, res) => {
  const { username, name } = req.body;

  if (!username || !name) {
    return res.status(400).json({ success: false, message: '参数错误' });
  }

  db.get('SELECT name FROM rooms WHERE owner = ?', [username], (err, row) => {
    if (err) {
      return res.status(500).json({ success: false, message: '服务器错误' });
    }
    if (row) {
      return res.status(400).json({ success: false, message: '你已创建过房间：' + row.name });
    }

    db.get('SELECT id FROM rooms WHERE name = ?', [name], (err, row) => {
      if (err) {
        return res.status(500).json({ success: false, message: '服务器错误' });
      }
      if (row) {
        return res.status(400).json({ success: false, message: '房间名已存在' });
      }

      db.run('INSERT INTO rooms (name, owner) VALUES (?, ?)', [name, username], (err) => {
        if (err) {
          return res.status(500).json({ success: false, message: '创建失败' });
        }
        
        broadcastRoomList();
        res.json({ success: true, message: '房间创建成功' });
      });
    });
  });
});

// 16. 踢人（群主）
app.post('/api/kick', (req, res) => {
  const { owner, room, username } = req.body;

  if (!owner || !room || !username) {
    return res.status(400).json({ success: false, message: '参数错误' });
  }

  db.get('SELECT id FROM rooms WHERE name = ? AND owner = ?', [room, owner], (err, row) => {
    if (err || !row) {
      return res.status(403).json({ success: false, message: '你不是该房间群主' });
    }

    if (username === owner) {
      return res.status(400).json({ success: false, message: '不能踢自己' });
    }

    db.run('INSERT OR IGNORE INTO room_bans (room, username) VALUES (?, ?)', [room, username], (err) => {
      if (err) {
        return res.status(500).json({ success: false, message: '操作失败' });
      }

      if (userMap.has(username)) {
        const ws = userMap.get(username);
        ws.send(JSON.stringify({
          type: 'room_kicked',
          room: room,
          reason: '你被群主踢出房间'
        }));
        if (wsToUser.get(ws)?.room === room) {
          wsToUser.set(ws, { username: username, room: '' });
        }
      }

      broadcast({
        type: 'system',
        content: `${username} 被群主踢出房间`,
        room: room
      });

      res.json({ success: true, message: '踢人成功' });
    });
  });
});

// 17. 禁言（群主）
app.post('/api/mute', (req, res) => {
  const { owner, room, username } = req.body;

  if (!owner || !room || !username) {
    return res.status(400).json({ success: false, message: '参数错误' });
  }

  db.get('SELECT id FROM rooms WHERE name = ? AND owner = ?', [room, owner], (err, row) => {
    if (err || !row) {
      return res.status(403).json({ success: false, message: '你不是该房间群主' });
    }

    if (username === owner) {
      return res.status(400).json({ success: false, message: '不能禁言自己' });
    }

    db.run('INSERT OR IGNORE INTO room_mutes (room, username) VALUES (?, ?)', [room, username], (err) => {
      if (err) {
        return res.status(500).json({ success: false, message: '操作失败' });
      }

      if (userMap.has(username)) {
        const ws = userMap.get(username);
        ws.send(JSON.stringify({
          type: 'room_muted',
          room: room,
          reason: '你被群主禁言'
        }));
      }

      broadcast({
        type: 'system',
        content: `${username} 被群主禁言`,
        room: room
      });

      res.json({ success: true, message: '禁言成功' });
    });
  });
});

// 18. 清空房间消息（群主）
app.post('/api/clear-room', (req, res) => {
  const { owner, room } = req.body;

  if (!owner || !room) {
    return res.status(400).json({ success: false, message: '参数错误' });
  }

  db.get('SELECT id FROM rooms WHERE name = ? AND owner = ?', [room, owner], (err, row) => {
    if (err || !row) {
      return res.status(403).json({ success: false, message: '你不是该房间群主' });
    }

    db.run('DELETE FROM messages WHERE room = ?', [room], (err) => {
      if (err) {
        return res.status(500).json({ success: false, message: '操作失败' });
      }

      broadcast({
        type: 'system',
        content: '群主清空了所有聊天记录',
        room: room
      });

      res.json({ success: true, message: '清空成功' });
    });
  });
});

// 19. 解散房间（群主）
app.post('/api/dismiss-room', (req, res) => {
  const { owner, room } = req.body;

  if (!owner || !room) {
    return res.status(400).json({ success: false, message: '参数错误' });
  }

  db.get('SELECT id FROM rooms WHERE name = ? AND owner = ?', [room, owner], (err, row) => {
    if (err || !row) {
      return res.status(403).json({ success: false, message: '你不是该房间群主' });
    }

    db.serialize(() => {
      db.run('BEGIN TRANSACTION');
      db.run('DELETE FROM rooms WHERE name = ?', [room]);
      db.run('DELETE FROM messages WHERE room = ?', [room]);
      db.run('DELETE FROM room_mutes WHERE room = ?', [room]);
      db.run('DELETE FROM room_bans WHERE room = ?', [room]);
      
      db.run('COMMIT', (err) => {
        if (err) {
          db.run('ROLLBACK');
          return res.status(500).json({ success: false, message: '操作失败' });
        }

        broadcast({
          type: 'system',
          content: '房间已被群主解散',
          room: room
        });

        wss.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN && wsToUser.has(client)) {
            const u = wsToUser.get(client);
            if (u.room === room) {
              client.send(JSON.stringify({
                type: 'room_dismissed',
                room: room,
                reason: '房间已解散'
              }));
              wsToUser.set(client, { username: u.username, room: '' });
            }
          }
        });

        broadcastRoomList();
        res.json({ success: true, message: '解散成功' });
      });
    });
  });
});

// ===================== 管理员后台专属接口 =====================
// 1. 获取总用户数
app.get('/api/admin/total-users', (req, res) => {
  db.get('SELECT COUNT(*) as count FROM users', (err, row) => {
    if (err) return res.json({ success: false, count: 0 });
    res.json({ success: true, count: row.count || 0 });
  });
});

// 2. 获取在线用户
app.get('/api/admin/online-users', (req, res) => {
  const users = [];
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && wsToUser.has(client)) {
      const user = wsToUser.get(client);
      users.push({
        username: user.username,
        room: user.room || '',
        ip: client._socket.remoteAddress?.replace('::ffff:', '') || '未知',
        loginTime: new Date().toLocaleString()
      });
    }
  });
  res.json({ success: true, users });
});

// 3. 获取总房间数
app.get('/api/admin/total-rooms', (req, res) => {
  db.get('SELECT COUNT(*) as count FROM rooms', (err, row) => {
    if (err) return res.json({ success: false, count: 0 });
    res.json({ success: true, count: row.count || 0 });
  });
});

// 4. 获取总消息数
app.get('/api/admin/total-messages', (req, res) => {
  db.get('SELECT COUNT(*) as count FROM messages', (err, row) => {
    if (err) return res.json({ success: false, count: 0 });
    res.json({ success: true, count: row.count || 0 });
  });
});

// 5. 获取房间在线人数
app.get('/api/admin/room-online', (req, res) => {
  const { room } = req.query;
  if (!room) return res.json({ success: false, count: 0 });
  
  let count = 0;
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && wsToUser.has(client)) {
      const user = wsToUser.get(client);
      if (user.room === room) count++;
    }
  });
  
  res.json({ success: true, count });
});

// 6. 管理员创建房间
app.post('/api/admin/create-room', (req, res) => {
  const { name, owner = 'admin' } = req.body;
  if (!name) return res.json({ success: false, message: '房间名称不能为空' });
  
  db.get('SELECT id FROM rooms WHERE name = ?', [name], (err, row) => {
    if (row) return res.json({ success: false, message: '房间名已存在' });
    
    db.run('INSERT INTO rooms (name, owner) VALUES (?, ?)', [name, owner], (err) => {
      if (err) return res.json({ success: false, message: '创建失败' });
      broadcastRoomList();
      res.json({ success: true, message: '房间创建成功' });
    });
  });
});

// 7. 管理员修改房间名称
app.post('/api/admin/rename-room', (req, res) => {
  const { oldName, newName } = req.body;
  if (!oldName || !newName) return res.json({ success: false, message: '参数错误' });
  
  db.get('SELECT id FROM rooms WHERE name = ?', [newName], (err, row) => {
    if (row) return res.json({ success: false, message: '新房间名已存在' });
    
    db.run('UPDATE rooms SET name = ? WHERE name = ?', [newName, oldName], (err) => {
      if (err) return res.json({ success: false, message: '修改失败' });
      
      // 更新相关数据的房间名
      db.run('UPDATE messages SET room = ? WHERE room = ?', [newName, oldName]);
      db.run('UPDATE room_mutes SET room = ? WHERE room = ?', [newName, oldName]);
      db.run('UPDATE room_bans SET room = ? WHERE room = ?', [newName, oldName]);
      
      broadcastRoomList();
      res.json({ success: true, message: '房间名称修改成功' });
    });
  });
});

// 8. 管理员删除房间
app.post('/api/admin/delete-room', (req, res) => {
  const { name } = req.body;
  if (!name) return res.json({ success: false, message: '参数错误' });
  
  db.serialize(() => {
    db.run('BEGIN TRANSACTION');
    db.run('DELETE FROM rooms WHERE name = ?', [name]);
    db.run('DELETE FROM messages WHERE room = ?', [name]);
    db.run('DELETE FROM room_mutes WHERE room = ?', [name]);
    db.run('DELETE FROM room_bans WHERE room = ?', [name]);
    db.run('COMMIT', (err) => {
      if (err) {
        db.run('ROLLBACK');
        return res.json({ success: false, message: '删除失败' });
      }
      
      // 通知房间用户
      wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && wsToUser.has(client)) {
          const u = wsToUser.get(client);
          if (u.room === name) {
            client.send(JSON.stringify({
              type: 'room_dismissed',
              room: name,
              reason: '房间已被管理员删除'
            }));
            wsToUser.set(client, { username: u.username, room: '' });
          }
        }
      });
      
      broadcastRoomList();
      res.json({ success: true, message: '房间删除成功' });
    });
  });
});

// 9. 获取公告列表
app.get('/api/admin/announcements', (req, res) => {
  db.all('SELECT content, created_at FROM announcements ORDER BY created_at DESC', (err, rows) => {
    if (err) return res.json({ success: false, list: [] });
    res.json({ success: true, list: rows || [] });
  });
});

// 10. 发布全局公告
app.post('/api/admin/publish-announcement', (req, res) => {
  const { content } = req.body;
  if (!content) return res.json({ success: false, message: '公告内容不能为空' });
  
  db.run('INSERT INTO announcements (content) VALUES (?)', [content], (err) => {
    if (err) return res.json({ success: false, message: '发布失败' });
    
    // 广播公告到所有客户端
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({
          type: 'announcement',
          content,
          time: new Date().toLocaleString()
        }));
      }
    });
    
    res.json({ success: true, message: '公告发布成功' });
  });
});

// 11. 管理员发送消息
app.post('/api/admin/send-message', (req, res) => {
  const { room, content } = req.body;
  if (!room || !content) return res.json({ success: false, message: '参数错误' });
  
  // 保存管理员消息
  db.run('INSERT INTO messages (username, content, room, is_admin) VALUES (?, ?, ?, ?)', 
    ['管理员', content, room, 1], (err) => {
      if (err) return res.json({ success: false, message: '发送失败' });
      
      // 广播管理员消息
      broadcast({
        type: 'chat',
        username: '管理员',
        content,
        room,
        isAdmin: true
      });
      
      res.json({ success: true, message: '消息发送成功' });
    }
  );
});

// 12. 获取管理员消息记录
app.get('/api/admin/admin-messages', (req, res) => {
  db.all('SELECT content, room, created_at FROM messages WHERE is_admin = 1 ORDER BY created_at DESC', (err, rows) => {
    if (err) return res.json({ success: false, list: [] });
    res.json({ success: true, list: rows || [] });
  });
});

// 13. 清空聊天记录
app.post('/api/admin/clear-chat-records', (req, res) => {
  const { room } = req.body;
  if (!room) return res.json({ success: false, message: '参数错误' });
  
  db.run('DELETE FROM messages WHERE room = ?', [room], (err) => {
    if (err) return res.json({ success: false, message: '清空失败' });
    
    // 广播清空通知
    broadcast({
      type: 'system',
      content: '管理员清空了所有聊天记录',
      room
    });
    
    res.json({ success: true, message: '聊天记录清空成功' });
  });
});

// 14. 删除单条消息
app.delete('/api/admin/delete-message/:id', (req, res) => {
  const { id } = req.params;
  if (!id) return res.json({ success: false, message: '参数错误' });
  
  db.run('DELETE FROM messages WHERE id = ?', [id], (err) => {
    if (err) return res.json({ success: false, message: '删除失败' });
    res.json({ success: true, message: '消息删除成功' });
  });
});

// 15. 获取所有用户
app.get('/api/admin/all-users', (req, res) => {
  db.all('SELECT username FROM users', (err, rows) => {
    if (err) return res.json({ success: false, users: [] });
    res.json({ success: true, users: rows || [] });
  });
});

// 16. 获取私聊记录（管理员）
app.get('/api/admin/private-history', (req, res) => {
  const { user1, user2 } = req.query;
  if (!user1 || !user2) return res.json({ success: false, list: [] });
  
  db.all(`SELECT sender, receiver, content, created_at 
          FROM private_messages 
          WHERE (sender = ? AND receiver = ?) OR (sender = ? AND receiver = ?)
          ORDER BY created_at ASC`, 
    [user1, user2, user2, user1], (err, rows) => {
      if (err) return res.json({ success: false, list: [] });
      res.json({ success: true, list: rows || [] });
    }
  );
});

// 17. 下载数据库文件
app.get('/api/admin/download-db', (req, res) => {
  const dbPath = path.resolve('./database.db');
  if (!fs.existsSync(dbPath)) {
    return res.status(404).json({ success: false, message: '数据库文件不存在' });
  }
  
  res.download(dbPath, `chat-db-${new Date().getTime()}.db`, (err) => {
    if (err) res.status(500).json({ success: false, message: '下载失败' });
  });
});

// 18. 上传恢复数据库
app.post('/api/admin/upload-db', upload.single('dbFile'), (req, res) => {
  if (!req.file) return res.json({ success: false, message: '请选择文件' });
  
  try {
    const tempPath = req.file.path;
    const targetPath = path.resolve('./database.db');
    
    // 备份当前数据库
    if (fs.existsSync(targetPath)) {
      const backupPath = `${targetPath}.backup-${Date.now()}`;
      fs.copyFileSync(targetPath, backupPath);
    }
    
    // 替换数据库文件
    fs.copyFileSync(tempPath, targetPath);
    fs.unlinkSync(tempPath); // 删除临时文件
    
    res.json({ success: true, message: '数据库恢复成功' });
  } catch (err) {
    console.error('恢复数据库失败:', err);
    res.json({ success: false, message: '恢复失败' });
  }
});

// 19. 踢出用户（管理员）
app.post('/api/admin/kick-user', (req, res) => {
  const { username } = req.body;
  if (!username) return res.json({ success: false, message: '参数错误' });
  
  if (userMap.has(username)) {
    const ws = userMap.get(username);
    ws.send(JSON.stringify({
      type: 'kick',
      reason: '你被管理员踢出系统'
    }));
    ws.close();
    userMap.delete(username);
  }
  
  res.json({ success: true, message: '用户已被踢出' });
});

// 20. 强制用户下线（管理员）
app.post('/api/admin/force-logout', (req, res) => {
  const { username } = req.body;
  if (!username) return res.json({ success: false, message: '参数错误' });
  
  if (userMap.has(username)) {
    const ws = userMap.get(username);
    ws.send(JSON.stringify({
      type: 'kick',
      reason: '管理员强制你下线'
    }));
    ws.close();
    userMap.delete(username);
  }
  
  res.json({ success: true, message: '用户已被强制下线' });
});

// ===================== WebSocket 核心逻辑 =====================
// 在线用户映射：username => ws
const userMap = new Map();
// ws => { username, room }
const wsToUser = new WeakMap();

// WebSocket 连接处理
wss.on('connection', (ws, req) => {
  console.log('新的WebSocket连接，IP:', req.socket.remoteAddress);

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

          // 广播用户上线
          if (room) {
            broadcast({
              type: 'system',
              content: `${username} 加入了聊天室`,
              room: room
            });
          }
          
          // 推送在线用户更新
          pushOnlineUsersUpdate();
        }
      }

      // 群聊消息
      if (data.type === 'chat') {
        const { username, content, room } = data;
        if (username && content && room) {
          // 检查是否被禁言
          db.get('SELECT id FROM room_mutes WHERE room = ? AND username = ?', [room, username], (err, row) => {
            if (row) {
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
                ws.send(JSON.stringify({
                  type: 'system',
                  content: '你已被踢出房间，无法发送消息',
                  room: room
                }));
                return;
              }

              // 保存消息
              db.run('INSERT INTO messages (username, content, room) VALUES (?, ?, ?)',
                [username, content, room], (err) => {
                  if (err) console.error('保存消息失败:', err);
                });

              // 广播消息
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
          // 离开旧房间
          if (old.room) {
            broadcast({
              type: 'system',
              content: `${old.username} 离开了聊天室`,
              room: old.room
            });
          }

          // 检查是否被拉黑
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
            // 进入新房间
            broadcast({
              type: 'system',
              content: `${username} 加入了聊天室`,
              room
            });
            
            pushOnlineUsersUpdate();
          });
        }
      }

      // 私聊消息
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
          // 自己回显
          ws.send(JSON.stringify({
            type: 'private_msg',
            sender,
            receiver,
            content
          }));
        }
      }

      // 管理员登录
      if (data.type === 'admin_login') {
        // 推送在线用户数据
        pushOnlineUsersUpdate();
      }

      // 房间列表更新
      if (data.type === 'room_list_update') {
        broadcastRoomList();
      }
    } catch (e) {
      console.error('消息解析错误:', e);
    }
  });

  // 断开连接
  ws.on('close', () => {
    const user = wsToUser.get(ws);
    if (user) {
      userMap.delete(user.username);
      // 广播离线
      if (user.room) {
        broadcast({
          type: 'system',
          content: `${user.username} 离开了聊天室`,
          room: user.room
        });
      }
      wsToUser.delete(ws);
      // 推送在线用户更新
      pushOnlineUsersUpdate();
    }
    console.log('WebSocket连接关闭');
  });

  ws.on('error', (err) => {
    console.error('WebSocket错误:', err);
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

// 广播房间列表更新
function broadcastRoomList() {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'room_list_update' }));
    }
  });
}

// 推送在线用户更新
function pushOnlineUsersUpdate() {
  const users = [];
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && wsToUser.has(client)) {
      const user = wsToUser.get(client);
      users.push({
        username: user.username,
        room: user.room || '',
        ip: client._socket.remoteAddress?.replace('::ffff:', '') || '未知',
        loginTime: new Date().toLocaleString()
      });
    }
  });
  
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({
        type: 'online_users_update',
        users
      }));
    }
  });
}

// 静态文件服务（用于admin.html）
app.use(express.static('public'));

// 启动服务
server.listen(PORT, () => {
  console.log(`服务器运行在 http://localhost:${PORT}`);
  console.log(`WebSocket运行在 ws://localhost:${PORT}`);
});

// 优雅退出
process.on('SIGINT', () => {
  console.log('服务器正在关闭...');
  db.close((err) => {
    if (err) console.error('数据库关闭失败:', err.message);
    else console.log('数据库连接已关闭');
    server.close(() => {
      console.log('服务器已关闭');
      process.exit(0);
    });
  });
});
