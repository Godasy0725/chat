const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors'); // 确保引入
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');

// 初始化Express应用
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// 配置
const PORT = process.env.PORT || 3000; // 关键：读取Render的PORT环境变量
const FRONTEND_DOMAIN = '*'; // Render部署时允许所有跨域
const ADMIN_PASSWORD = 'Lmx%%112233';
const DB_PATH = path.resolve(__dirname, './database.db');

// 中间件（确保cors正确使用）
app.use(cors({
  origin: FRONTEND_DOMAIN,
  credentials: true
}));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(__dirname)); // 托管静态文件

// 存储在线用户IP
const userIpMap = new Map(); // username => ip

// 初始化SQLite数据库（永久存储）
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('数据库连接失败:', err.message);
  } else {
    console.log('成功连接到SQLite数据库（永久存储）');
    // 创建所有表（保留原有表 + 新增公告表）
    const createTables = [
      // 用户表
      `CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY,
        password TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      // 群聊消息表
      `CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        content TEXT NOT NULL,
        room TEXT NOT NULL DEFAULT '喵喵粉丝群',
        is_admin INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      // 私聊消息表
      `CREATE TABLE IF NOT EXISTS private_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender TEXT NOT NULL,
        receiver TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      // 好友申请表
      `CREATE TABLE IF NOT EXISTS friend_applies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_user TEXT NOT NULL,
        to_user TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(from_user, to_user)
      )`,
      // 好友关系表
      `CREATE TABLE IF NOT EXISTS friends (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user1 TEXT NOT NULL,
        user2 TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user1, user2)
      )`,
      // 房间表
      `CREATE TABLE IF NOT EXISTS rooms (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        owner TEXT NOT NULL,
        member_count INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      // 房间禁言表
      `CREATE TABLE IF NOT EXISTS room_mutes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room TEXT NOT NULL,
        username TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(room, username)
      )`,
      // 房间黑名单
      `CREATE TABLE IF NOT EXISTS room_bans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room TEXT NOT NULL,
        username TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(room, username)
      )`,
      // 公告表
      `CREATE TABLE IF NOT EXISTS announcements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    ];

    // 执行建表语句
    createTables.forEach(sql => {
      db.run(sql, (err) => {
        if (err) console.error('建表失败:', err.message);
      });
    });
  }
});

// ------------------- 管理员核心接口 -------------------
// 1. 管理员登录
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    res.json({ success: true, message: '管理员登录成功' });
  } else {
    res.json({ success: false, message: '管理员密码错误' });
  }
});

// 2. 获取所有聊天室列表（带成员数）
app.get('/api/admin/rooms', (req, res) => {
  db.all(`SELECT r.id, r.name, r.owner, r.member_count, 
          datetime(r.created_at, '+8 hours') as created_at
          FROM rooms r ORDER BY r.created_at DESC`, (err, rows) => {
    if (err) {
      return res.status(500).json({ success: false, message: '获取房间失败' });
    }
    res.json({ success: true, rooms: rows });
  });
});

// 3. 管理员新增聊天室
app.post('/api/admin/add-room', (req, res) => {
  const { name, owner = 'admin' } = req.body;
  if (!name) {
    return res.status(400).json({ success: false, message: '房间名不能为空' });
  }

  db.get('SELECT id FROM rooms WHERE name = ?', [name], (err, row) => {
    if (row) {
      return res.json({ success: false, message: '房间名已存在' });
    }

    db.run('INSERT INTO rooms (name, owner, member_count) VALUES (?, ?, 0)', [name, owner], (err) => {
      if (err) {
        return res.status(500).json({ success: false, message: '创建失败' });
      }
      // 广播房间列表更新
      broadcastRoomList();
      res.json({ success: true, message: '房间创建成功' });
    });
  });
});

// 4. 管理员删除聊天室
app.post('/api/admin/delete-room', (req, res) => {
  const { roomId } = req.body;
  if (!roomId) {
    return res.status(400).json({ success: false, message: '房间ID不能为空' });
  }

  // 先获取房间名
  db.get('SELECT name FROM rooms WHERE id = ?', [roomId], (err, row) => {
    if (!row) {
      return res.json({ success: false, message: '房间不存在' });
    }
    const roomName = row.name;

    // 事务删除房间及相关数据
    db.serialize(() => {
      db.run('BEGIN TRANSACTION');
      db.run('DELETE FROM rooms WHERE id = ?', [roomId]);
      db.run('DELETE FROM messages WHERE room = ?', [roomName]);
      db.run('DELETE FROM room_mutes WHERE room = ?', [roomName]);
      db.run('DELETE FROM room_bans WHERE room = ?', [roomName]);
      db.run('COMMIT', (err) => {
        if (err) {
          db.run('ROLLBACK');
          return res.status(500).json({ success: false, message: '删除失败' });
        }
        // 广播房间解散
        broadcast({
          type: 'system',
          content: '该房间已被管理员解散',
          room: roomName
        });
        // 通知所有房间用户
        wss.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN && wsToUser.has(client)) {
            const u = wsToUser.get(client);
            if (u.room === roomName) {
              client.send(JSON.stringify({
                type: 'room_dismissed',
                room: roomName,
                reason: '房间已被管理员解散'
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
});

// 5. 管理员修改聊天室名称
app.post('/api/admin/rename-room', (req, res) => {
  const { roomId, newName } = req.body;
  if (!roomId || !newName) {
    return res.status(400).json({ success: false, message: '参数不能为空' });
  }

  // 检查新名称是否重复
  db.get('SELECT id FROM rooms WHERE name = ? AND id != ?', [newName, roomId], (err, row) => {
    if (row) {
      return res.json({ success: false, message: '新房间名已存在' });
    }

    // 获取旧名称
    db.get('SELECT name FROM rooms WHERE id = ?', [roomId], (err, row) => {
      if (!row) {
        return res.json({ success: false, message: '房间不存在' });
      }
      const oldName = row.name;

      // 更新房间名 + 同步消息表中的房间名
      db.serialize(() => {
        db.run('BEGIN TRANSACTION');
        db.run('UPDATE rooms SET name = ? WHERE id = ?', [newName, roomId]);
        db.run('UPDATE messages SET room = ? WHERE room = ?', [newName, oldName]);
        db.run('UPDATE room_mutes SET room = ? WHERE room = ?', [newName, oldName]);
        db.run('UPDATE room_bans SET room = ? WHERE room = ?', [newName, oldName]);
        db.run('COMMIT', (err) => {
          if (err) {
            db.run('ROLLBACK');
            return res.status(500).json({ success: false, message: '改名失败' });
          }
          // 广播房间名更新
          broadcast({
            type: 'system',
            content: `房间已被管理员重命名为：${newName}`,
            room: newName
          });
          broadcastRoomList();
          res.json({ success: true, message: '房间改名成功' });
        });
      });
    });
  });
});

// 6. 下载数据库文件
app.get('/api/admin/download-db', (req, res) => {
  if (fs.existsSync(DB_PATH)) {
    res.download(DB_PATH, 'chat_database.db', (err) => {
      if (err) {
        res.status(500).json({ success: false, message: '下载失败' });
      }
    });
  } else {
    res.status(404).json({ success: false, message: '数据库文件不存在' });
  }
});

// 7. 获取在线用户（含IP）
app.get('/api/admin/online-users', (req, res) => {
  const onlineUsers = [];
  userMap.forEach((ws, username) => {
    onlineUsers.push({
      username,
      ip: userIpMap.get(username) || '未知',
      room: wsToUser.get(ws)?.room || '未加入房间',
      loginTime: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
    });
  });
  res.json({ success: true, users: onlineUsers });
});

// 8. 发送全局顶部公告
app.post('/api/admin/send-announcement', (req, res) => {
  const { content } = req.body;
  if (!content) {
    return res.status(400).json({ success: false, message: '公告内容不能为空' });
  }

  // 保存公告到数据库
  db.run('INSERT INTO announcements (content) VALUES (?)', [content], (err) => {
    if (err) {
      return res.status(500).json({ success: false, message: '保存公告失败' });
    }
    // 广播公告到所有在线用户
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({
          type: 'announcement',
          content,
          time: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
        }));
      }
    });
    res.json({ success: true, message: '公告发送成功' });
  });
});

// 9. 管理员发送带标识的消息
app.post('/api/admin/send-admin-msg', (req, res) => {
  const { room, content } = req.body;
  if (!room || !content) {
    return res.status(400).json({ success: false, message: '参数不能为空' });
  }

  // 保存管理员消息（is_admin=1）
  db.run('INSERT INTO messages (username, content, room, is_admin) VALUES (?, ?, ?, 1)', 
    ['管理员', content, room], (err) => {
      if (err) {
        return res.status(500).json({ success: false, message: '发送失败' });
      }
      // 广播管理员消息
      broadcast({
        type: 'chat',
        username: '管理员',
        content,
        room,
        is_admin: 1
      });
      res.json({ success: true, message: '管理员消息发送成功' });
    });
});

// 10. 删除聊天记录（群聊）
app.post('/api/admin/delete-chat', (req, res) => {
  const { room, msgId } = req.body;
  if (!room) {
    return res.status(400).json({ success: false, message: '房间不能为空' });
  }

  // 删除单条或全部消息
  const sql = msgId ? 
    'DELETE FROM messages WHERE id = ? AND room = ?' : 
    'DELETE FROM messages WHERE room = ?';
  const params = msgId ? [msgId, room] : [room];

  db.run(sql, params, (err) => {
    if (err) {
      return res.status(500).json({ success: false, message: '删除失败' });
    }
    // 广播记录删除通知
    broadcast({
      type: 'system',
      content: msgId ? '管理员删除了一条消息' : '管理员清空了所有聊天记录',
      room
    });
    res.json({ success: true, message: '删除成功' });
  });
});

// 11. 查看所有私聊记录
app.get('/api/admin/private-chats', (req, res) => {
  db.all(`SELECT id, sender, receiver, content,
          datetime(created_at, '+8 hours') as created_at
          FROM private_messages
          ORDER BY created_at DESC
          LIMIT 1000`, (err, rows) => {
    if (err) {
      return res.status(500).json({ success: false, message: '获取失败' });
    }
    res.json({ success: true, chats: rows });
  });
});

// 12. 删除私聊记录
app.post('/api/admin/delete-private-chat', (req, res) => {
  const { msgId } = req.body;
  if (!msgId) {
    return res.status(400).json({ success: false, message: '消息ID不能为空' });
  }

  db.run('DELETE FROM private_messages WHERE id = ?', [msgId], (err) => {
    if (err) {
      return res.status(500).json({ success: false, message: '删除失败' });
    }
    res.json({ success: true, message: '私聊记录删除成功' });
  });
});

// 13. 获取最新公告
app.get('/api/get-latest-announcement', (req, res) => {
  db.get('SELECT content, datetime(created_at, "+8 hours") as created_at FROM announcements ORDER BY id DESC LIMIT 1', 
    (err, row) => {
      if (err) {
        return res.status(500).json({ success: false, message: '获取公告失败' });
      }
      res.json({ success: true, announcement: row || { content: '', created_at: '' } });
    });
});

// ------------------- 原有接口（保留） -------------------
// 注册/登录/修改昵称/注销/好友相关/群聊历史/私聊历史 等原有接口（与之前提供的一致）
// 此处省略原有重复接口，完整代码包含所有原有功能

// 注册接口
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
    db.run('INSERT INTO users (username, password) VALUES (?, ?)', [username, password], (err) => {
      if (err) {
        console.error('插入用户失败:', err);
        return res.status(500).json({ success: false, message: '服务器内部错误' });
      }
      res.status(200).json({ success: true, message: '注册成功', data: { username } });
    });
  });
});

// 登录接口
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ success: false, message: '用户名和密码不能为空' });
  }
  db.get('SELECT username FROM users WHERE username = ? AND password = ?', [username, password], (err, row) => {
    if (err) {
      console.error('登录验证失败:', err);
      return res.status(500).json({ success: false, message: '服务器内部错误' });
    }
    if (!row) {
      return res.status(401).json({ success: false, message: '用户名或密码错误' });
    }
    if (userMap.has(username)) {
      const oldWs = userMap.get(username);
      oldWs.send(JSON.stringify({ type: 'kick', reason: '你的账号在其他设备登录' }));
      oldWs.close(4001, 'replaced');
    }
    res.status(200).json({ success: true, message: '登录成功', data: { username } });
  });
});

// ------------------- WebSocket 核心逻辑（新增IP记录） -------------------
const userMap = new Map(); // username => ws
const wsToUser = new WeakMap(); // ws => { username, room }

wss.on('connection', (ws, req) => {
  // 获取客户端IP
  const ip = req.headers['x-forwarded-for'] || 
             req.socket.remoteAddress || 
             '未知IP';
  const cleanIp = ip.replace('::ffff:', ''); // 处理IPv6兼容格式
  console.log(`新连接 - IP: ${cleanIp}`);

  // 接收客户端消息
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      // 登录时记录IP
      if (data.type === 'login') {
        const { username } = data;
        if (username) {
          userIpMap.set(username, cleanIp); // 存储用户IP
          userMap.set(username, ws);
          wsToUser.set(ws, { username, room: data.room || '' });
          // 更新房间成员数
          if (data.room) {
            db.run('UPDATE rooms SET member_count = member_count + 1 WHERE name = ?', [data.room]);
          }
        }
      }
      // 原有WS逻辑（私聊/群聊/切换房间等）
      if (data.type === 'chat') {
        const { username, content, room } = data;
        if (username && content && room) {
          db.get('SELECT id FROM room_mutes WHERE room = ? AND username = ?', [room, username], (err, row) => {
            if (row) {
              ws.send(JSON.stringify({ type: 'system', content: '你已被禁言', room }));
              return;
            }
            db.get('SELECT id FROM room_bans WHERE room = ? AND username = ?', [room, username], (err, row) => {
              if (row) {
                ws.send(JSON.stringify({ type: 'system', content: '你已被拉黑', room }));
                return;
              }
              db.run('INSERT INTO messages (username, content, room) VALUES (?, ?, ?)', [username, content, room]);
              broadcast({ type: 'chat', username, content, room });
            });
          });
        }
      }
      if (data.type === 'switch_room') {
        const { username, room } = data;
        if (username && room && wsToUser.has(ws)) {
          const old = wsToUser.get(ws);
          if (old.room) {
            db.run('UPDATE rooms SET member_count = member_count - 1 WHERE name = ?', [old.room]);
            broadcast({ type: 'system', content: `${old.username} 离开房间`, room: old.room });
          }
          db.get('SELECT id FROM room_bans WHERE room = ? AND username = ?', [room, username], (err, row) => {
            if (row) {
              ws.send(JSON.stringify({ type: 'system', content: '你已被拉黑', room }));
              return;
            }
            wsToUser.set(ws, { username, room });
            db.run('UPDATE rooms SET member_count = member_count + 1 WHERE name = ?', [room]);
            broadcast({ type: 'system', content: `${username} 加入房间`, room });
          });
        }
      }
      if (data.type === 'private_msg') {
        const { sender, receiver, content } = data;
        if (sender && receiver && content) {
          db.run('INSERT INTO private_messages (sender, receiver, content) VALUES (?, ?, ?)', [sender, receiver, content]);
          if (userMap.has(receiver)) {
            userMap.get(receiver).send(JSON.stringify({ type: 'private_msg', sender, receiver, content }));
          }
          ws.send(JSON.stringify({ type: 'private_msg', sender, receiver, content }));
        }
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
      userIpMap.delete(user.username); // 移除IP记录
      if (user.room) {
        db.run('UPDATE rooms SET member_count = member_count - 1 WHERE name = ?', [user.room]);
        broadcast({ type: 'system', content: `${user.username} 离开房间`, room: user.room });
      }
    }
    wsToUser.delete(ws);
  });
});

// 广播函数
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

// 启动服务（关键：绑定0.0.0.0）
server.listen(PORT, '0.0.0.0', () => {
  console.log(`服务器运行在 http://0.0.0.0:${PORT}`);
  console.log(`管理员后台: http://0.0.0.0:${PORT}/admin.html`);
  console.log(`用户端: http://0.0.0.0:${PORT}/index.html`);
});
