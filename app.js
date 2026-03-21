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
const ADMIN_PASSWORD = 'Lmx%%112233';

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

    // 创建聊天室表
    db.run(`CREATE TABLE IF NOT EXISTS rooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      creator TEXT NOT NULL,
      locked INTEGER NOT NULL DEFAULT 0,
      muted INTEGER NOT NULL DEFAULT 0,
      visible INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
      if (err) console.error('创建聊天室表失败:', err.message);
    });

    // 创建公告表
    db.run(`CREATE TABLE IF NOT EXISTS announcement (
      id INTEGER PRIMARY KEY,
      content TEXT DEFAULT '',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
      if (err) console.error('创建公告表失败:', err.message);
    });

    // 创建IP禁言表
    db.run(`CREATE TABLE IF NOT EXISTS muted_ips (
      ip TEXT PRIMARY KEY,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
      if (err) console.error('创建IP禁言表失败:', err.message);
    });

    // 初始化默认数据
    db.get('SELECT id FROM rooms WHERE name = ?', ['喵喵粉丝群'], (err, row) => {
      if (!row) {
        db.run('INSERT INTO rooms (name, creator, locked, muted, visible) VALUES (?, ?, 0, 0, 1)', 
          ['喵喵粉丝群', 'system']);
      }
    });
    db.get('SELECT id FROM announcement WHERE id = 1', (err, row) => {
      if (!row) {
        db.run('INSERT INTO announcement (id, content) VALUES (1, "")');
      }
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
      // 更新聊天室创建者
      db.run('UPDATE rooms SET creator = ? WHERE creator = ?', [newName, oldName]);
      
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
          wsToUser.set(ws, { username: newName, room: wsToUser.get(ws).room, ip: wsToUser.get(ws).ip });
        }
        
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
    
    db.run('DELETE FROM users WHERE username = ?', [username]);
    db.run('DELETE FROM messages WHERE username = ?', [username]);
    db.run('DELETE FROM private_messages WHERE sender = ? OR receiver = ?', [username, username]);
    db.run('DELETE FROM friend_applies WHERE from_user = ? OR to_user = ?', [username, username]);
    db.run('DELETE FROM friends WHERE user1 = ? OR user2 = ?', [username, username]);
    db.run('DELETE FROM rooms WHERE creator = ?', [username]);
    
    db.run('COMMIT', (err) => {
      if (err) {
        db.run('ROLLBACK');
        return res.status(500).json({ success: false, message: '注销失败' });
      }
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

// 14. 获取聊天室列表（带在线人数）
app.get('/api/rooms', (req, res) => {
  db.all('SELECT * FROM rooms WHERE visible = 1', (err, rooms) => {
    if (err) {
      return res.status(500).json({ success: false, message: '获取失败' });
    }
    
    // 计算每个房间的在线人数
    const result = [];
    let count = 0;
    
    rooms.forEach(room => {
      let onlineCount = 0;
      // 统计当前房间在线人数
      wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && wsToUser.has(client)) {
          const user = wsToUser.get(client);
          if (user.room === room.name) {
            onlineCount++;
          }
        }
      });
      
      result.push({
        id: room.id,
        name: room.name,
        creator: room.creator,
        locked: room.locked,
        onlineCount
      });
      
      count++;
      if (count === rooms.length) {
        res.json({ success: true, rooms: result });
      }
    });
    
    if (rooms.length === 0) {
      res.json({ success: true, rooms: [] });
    }
  });
});

// 15. 用户创建聊天室（每个用户只能创建一个）
app.post('/api/user/create-room', (req, res) => {
  const { username } = req.body;
  
  if (!username) {
    return res.status(400).json({ success: false, message: '参数错误' });
  }

  // 检查是否已创建过
  db.get('SELECT id FROM rooms WHERE creator = ?', [username], (err, row) => {
    if (err) {
      return res.status(500).json({ success: false, message: '服务器内部错误' });
    }
    if (row) {
      return res.status(400).json({ success: false, message: '你已经创建过一个聊天室' });
    }

    // 创建聊天室
    const roomName = `${username}的专属聊天室`;
    db.run('INSERT INTO rooms (name, creator, locked, muted, visible) VALUES (?, ?, 0, 0, 1)', 
      [roomName, username], (err) => {
        if (err) {
          return res.status(500).json({ success: false, message: '创建失败' });
        }
        res.json({ success: true, message: '聊天室创建成功', data: { roomName } });
      }
    );
  });
});

// ------------------- 管理员接口 -------------------
// 16. 管理员仪表盘
app.get('/api/admin/dashboard', (req, res) => {
  const online = userMap.size;
  
  // 获取今日消息数
  db.get('SELECT COUNT(*) as count FROM messages WHERE DATE(created_at) = DATE("now", "+8 hours")', (err, msgRow) => {
    const messages = msgRow?.count || 0;
    
    // 获取总用户数
    db.get('SELECT COUNT(*) as count FROM users', (err, userRow) => {
      const users = userRow?.count || 0;
      
      // 获取聊天室数
      db.get('SELECT COUNT(*) as count FROM rooms', (err, roomRow) => {
        const rooms = roomRow?.count || 0;
        
        // 获取在线IP列表
        const ips = [];
        wss.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN && wsToUser.has(client)) {
            const user = wsToUser.get(client);
            ips.push({
              username: user.username,
              ip: user.ip,
              room: user.room,
              muted: false // 简化处理，实际可查muted_ips表
            });
          }
        });
        
        res.json({ 
          success: true, 
          online, 
          rooms, 
          users, 
          messages, 
          ips 
        });
      });
    });
  });
});

// 17. 管理员获取聊天室列表
app.get('/api/admin/rooms', (req, res) => {
  db.all('SELECT * FROM rooms', (err, rooms) => {
    if (err) {
      return res.status(500).json({ success: false, message: '获取失败' });
    }
    
    const result = [];
    let count = 0;
    
    rooms.forEach(room => {
      // 计算成员数
      let memberCount = 0;
      wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && wsToUser.has(client)) {
          const user = wsToUser.get(client);
          if (user.room === room.name) {
            memberCount++;
          }
        }
      });
      
      result.push({
        id: room.id,
        name: room.name,
        memberCount,
        creator: room.creator,
        muted: room.muted,
        visible: room.visible,
        locked: room.locked
      });
      
      count++;
      if (count === rooms.length) {
        res.json({ success: true, rooms: result });
      }
    });
    
    if (rooms.length === 0) {
      res.json({ success: true, rooms: [] });
    }
  });
});

// 18. 管理员获取用户列表
app.get('/api/admin/users', (req, res) => {
  db.all('SELECT username, created_at FROM users', (err, users) => {
    if (err) {
      return res.status(500).json({ success: false, message: '获取失败' });
    }
    
    const result = users.map(user => ({
      username: user.username,
      createdAt: user.created_at,
      online: userMap.has(user.username)
    }));
    
    res.json({ success: true, users: result });
  });
});

// 19. 管理员获取聊天记录
app.get('/api/admin/records', (req, res) => {
  const { room = 'all' } = req.query;
  
  let sql = `SELECT m.*, r.name as roomName 
             FROM messages m 
             LEFT JOIN rooms r ON m.room = r.name 
             ORDER BY m.created_at DESC LIMIT 100`;
             
  if (room !== 'all') {
    sql = `SELECT m.*, r.name as roomName 
           FROM messages m 
           LEFT JOIN rooms r ON m.room = r.name 
           WHERE m.room = ? 
           ORDER BY m.created_at DESC LIMIT 100`;
  }
  
  db.all(sql, room !== 'all' ? [room] : [], (err, records) => {
    if (err) {
      return res.status(500).json({ success: false, message: '获取失败' });
    }
    
    const result = records.map(record => ({
      id: record.id,
      roomName: record.roomName || record.room,
      username: record.username,
      content: record.content,
      createdAt: record.created_at
    }));
    
    res.json({ success: true, records: result });
  });
});

// 20. 管理员获取好友列表
app.get('/api/admin/friends', (req, res) => {
  db.all('SELECT * FROM friends', (err, friends) => {
    if (err) {
      return res.status(500).json({ success: false, message: '获取失败' });
    }
    
    res.json({ success: true, friends });
  });
});

// 21. 管理员获取/保存公告
app.get('/api/admin/announcement', (req, res) => {
  db.get('SELECT content FROM announcement WHERE id = 1', (err, row) => {
    if (err) {
      return res.status(500).json({ success: false, message: '获取失败' });
    }
    res.json({ success: true, content: row?.content || '' });
  });
});

app.post('/api/admin/announcement', (req, res) => {
  const { content } = req.body;
  
  db.run('UPDATE announcement SET content = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1', [content], (err) => {
    if (err) {
      return res.status(500).json({ success: false, message: '保存失败' });
    }
    
    // 推送公告到所有在线用户
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({
          type: 'announcement',
          content
        }));
      }
    });
    
    res.json({ success: true, message: '公告保存成功' });
  });
});

// 22. 管理员禁言IP
app.post('/api/admin/mute-ip', (req, res) => {
  const { ip } = req.body;
  
  if (!ip) {
    return res.status(400).json({ success: false, message: '参数错误' });
  }
  
  // 检查是否已禁言
  db.get('SELECT ip FROM muted_ips WHERE ip = ?', [ip], (err, row) => {
    if (err) {
      return res.status(500).json({ success: false, message: '操作失败' });
    }
    
    if (row) {
      // 解除禁言
      db.run('DELETE FROM muted_ips WHERE ip = ?', [ip], (err) => {
        if (err) {
          return res.status(500).json({ success: false, message: '操作失败' });
        }
        res.json({ success: true, message: '已解除IP禁言' });
      });
    } else {
      // 禁言IP
      db.run('INSERT INTO muted_ips (ip) VALUES (?)', [ip], (err) => {
        if (err) {
          return res.status(500).json({ success: false, message: '操作失败' });
        }
        
        // 踢掉该IP的所有连接
        wss.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN && wsToUser.has(client)) {
            const user = wsToUser.get(client);
            if (user.ip === ip) {
              client.send(JSON.stringify({
                type: 'kick',
                reason: '你的IP已被管理员禁言'
              }));
              client.close();
            }
          }
        });
        
        res.json({ success: true, message: '已禁言该IP' });
      });
    }
  });
});

// 23. 管理员发送消息
app.post('/api/admin/send-msg', (req, res) => {
  const { roomId, content } = req.body;
  
  if (!roomId || !content) {
    return res.status(400).json({ success: false, message: '参数错误' });
  }
  
  // 获取聊天室名称
  db.get('SELECT name FROM rooms WHERE id = ?', [roomId], (err, row) => {
    if (err || !row) {
      return res.status(500).json({ success: false, message: '聊天室不存在' });
    }
    
    const roomName = row.name;
    
    // 保存消息
    db.run('INSERT INTO messages (username, content, room) VALUES (?, ?, ?)', 
      ['管理员', content, roomName], (err) => {
        if (err) {
          return res.status(500).json({ success: false, message: '发送失败' });
        }
        
        // 广播消息
        broadcast({
          type: 'chat',
          username: '管理员',
          content,
          room: roomName
        });
        
        res.json({ success: true, message: '消息发送成功' });
      }
    );
  });
});

// 24. 管理员管理聊天室
app.post('/api/admin/room', (req, res) => {
  const { name, locked } = req.body;
  
  if (!name) {
    return res.status(400).json({ success: false, message: '参数错误' });
  }
  
  db.run('INSERT INTO rooms (name, creator, locked, muted, visible) VALUES (?, ?, ?, 0, 1)', 
    [name, 'admin', locked ? 1 : 0], (err) => {
      if (err) {
        return res.status(500).json({ success: false, message: '创建失败' });
      }
      res.json({ success: true, message: '聊天室创建成功' });
    }
  );
});

app.put('/api/admin/room/:id', (req, res) => {
  const { id } = req.params;
  const { name, locked } = req.body;
  
  if (!name) {
    return res.status(400).json({ success: false, message: '参数错误' });
  }
  
  db.run('UPDATE rooms SET name = ?, locked = ? WHERE id = ?', 
    [name, locked ? 1 : 0, id], (err) => {
      if (err) {
        return res.status(500).json({ success: false, message: '修改失败' });
      }
      res.json({ success: true, message: '聊天室修改成功' });
    }
  );
});

app.delete('/api/admin/room/:id', (req, res) => {
  const { id } = req.params;
  
  // 先获取聊天室名称
  db.get('SELECT name FROM rooms WHERE id = ?', [id], (err, row) => {
    if (err || !row) {
      return res.status(500).json({ success: false, message: '聊天室不存在' });
    }
    
    const roomName = row.name;
    
    // 事务：删除聊天室 + 相关消息
    db.serialize(() => {
      db.run('BEGIN TRANSACTION');
      db.run('DELETE FROM rooms WHERE id = ?', [id]);
      db.run('DELETE FROM messages WHERE room = ?', [roomName]);
      db.run('COMMIT', (err) => {
        if (err) {
          db.run('ROLLBACK');
          return res.status(500).json({ success: false, message: '删除失败' });
        }
        res.json({ success: true, message: '聊天室删除成功' });
      });
    });
  });
});

// 在线用户映射：username => ws
const userMap = new Map();
// ws => { username, room, ip }
const wsToUser = new WeakMap();

// WebSocket 实时处理核心
wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;
  console.log(`新的WebSocket连接，IP: ${ip}`);

  // 检查IP是否被禁言
  db.get('SELECT ip FROM muted_ips WHERE ip = ?', [ip], (err, row) => {
    if (row) {
      ws.send(JSON.stringify({
        type: 'kick',
        reason: '你的IP已被管理员禁言'
      }));
      ws.close();
      return;
    }
  });

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

          // 绑定用户、房间、IP
          userMap.set(username, ws);
          wsToUser.set(ws, { username, room, ip });

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
          // 检查房间是否上锁
          db.get('SELECT locked FROM rooms WHERE name = ?', [room], (err, row) => {
            if (row && row.locked) {
              ws.send(JSON.stringify({
                type: 'system',
                content: '该聊天室已被上锁，无法发送消息',
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
          // 更新房间
          wsToUser.set(ws, { ...old, room });
          // 进入新房间广播
          broadcast({
            type: 'system',
            content: `${username} 加入了聊天室`,
            room
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
    console.log('WebSocket连接关闭');
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

// 静态文件服务
app.use(express.static('public'));

// 启动服务
server.listen(PORT, () => {
  console.log(`服务器运行在端口 ${PORT}`);
});
