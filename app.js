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

            // 通知对方
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

// 13. 发送私聊消息
app.post('/api/send-private', (req, res) => {
  const { sender, receiver, content } = req.body;

  if (!sender || !receiver || !content) {
    return res.status(400).json({ success: false, message: '参数错误' });
  }

  // 检查是否是好友
  db.get(`SELECT id FROM friends WHERE (user1 = ? AND user2 = ?) OR (user1 = ? AND user2 = ?)`, 
    [sender, receiver, receiver, sender], (err, row) => {
      if (err) {
        return res.status(500).json({ success: false, message: '服务器内部错误' });
      }
      if (!row) {
        return res.status(400).json({ success: false, message: '非好友无法私聊' });
      }

      // 保存私聊消息
      db.run('INSERT INTO private_messages (sender, receiver, content) VALUES (?, ?, ?)', 
        [sender, receiver, content], (err) => {
          if (err) {
            return res.status(500).json({ success: false, message: '发送失败' });
          }

          // 通知对方
          if (userMap.has(receiver)) {
            const ws = userMap.get(receiver);
            ws.send(JSON.stringify({
              type: 'private_msg',
              sender: sender,
              content: content
            }));
          }

          res.json({ success: true, message: '发送成功' });
        }
      );
    }
  );
});

// 在线用户映射：username => ws
const userMap = new Map();
// ws => { username, room }
const wsToUser = new WeakMap();

// WebSocket 处理
wss.on('connection', (ws) => {
  console.log('新的WebSocket连接');

  // 接收客户端消息
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      // 客户端登录WebSocket
      if (data.type === 'login') {
        const { username, room = '喵喵粉丝群' } = data;
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
          broadcast({
            type: 'system',
            content: `${username} 加入了聊天室`,
            room: room
          });
          console.log(`${username} 进入房间 ${room}`);
        }
      }

      // 客户端发送群聊消息
      if (data.type === 'chat' && wsToUser.has(ws)) {
        const userInfo = wsToUser.get(ws);
        const { username } = userInfo;
        const { content, room = '喵喵粉丝群' } = data;

        // 保存消息到数据库
        db.run('INSERT INTO messages (username, content, room) VALUES (?, ?, ?)',
          [username, content, room], (err) => {
            if (err) console.error('保存消息失败:', err);
          });

        // 广播消息给同房间所有用户
        broadcast({
          type: 'chat',
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
      const { username, room } = wsToUser.get(ws);
      // 移除映射
      userMap.delete(username);
      wsToUser.delete(ws);
      // 广播用户下线
      broadcast({
        type: 'system',
        content: `${username} 离开了聊天室`,
        room: room
      });
      console.log(`${username} 离开房间 ${room}`);
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
      const clientInfo = wsToUser.get(client);
      if (clientInfo && clientInfo.room === message.room) {
        client.send(JSON.stringify(message));
      }
    }
  });
}

// 健康检查接口
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
