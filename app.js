const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

// 初始化应用
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 3000;

// 数据库初始化
const db = new sqlite3.Database('./database.db', (err) => {
  if (err) console.error('数据库连接失败:', err.message);
  else console.log('数据库连接成功');
});

// 创建数据表（完整结构）
db.serialize(() => {
  // 用户表
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // 聊天室表
  db.run(`CREATE TABLE IF NOT EXISTS rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    creator TEXT NOT NULL,
    locked INTEGER DEFAULT 0, -- 0:未锁定 1:已锁定
    muted INTEGER DEFAULT 0,
    visible INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // 群聊消息表
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    content TEXT NOT NULL,
    room TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // 私聊消息表
  db.run(`CREATE TABLE IF NOT EXISTS private_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender TEXT NOT NULL,
    receiver TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // 好友关系表
  db.run(`CREATE TABLE IF NOT EXISTS friends (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user1 TEXT NOT NULL,
    user2 TEXT NOT NULL,
    status INTEGER DEFAULT 0, -- 0:申请中 1:已同意 2:已拒绝
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user1, user2)
  )`);

  // 公告表
  db.run(`CREATE TABLE IF NOT EXISTS announcement (
    id INTEGER PRIMARY KEY,
    content TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // 禁言表
  db.run(`CREATE TABLE IF NOT EXISTS mutes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    room TEXT NOT NULL,
    admin TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // 初始化默认数据
  db.get('SELECT * FROM announcement WHERE id = 1', (err, row) => {
    if (!row) db.run('INSERT INTO announcement (id, content) VALUES (1, "欢迎使用聊天室系统！")');
  });
  db.get('SELECT * FROM rooms WHERE name = "喵喵粉丝群"', (err, row) => {
    if (!row) db.run('INSERT INTO rooms (name, creator, locked) VALUES ("喵喵粉丝群", "system", 0)');
  });
});

// 中间件
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 全局状态管理
const userMap = new Map();      // username -> ws
const wsToUser = new Map();     // ws -> { username, room, ip }
const mutedUsers = new Map();   // room -> Set(username) 按房间禁言
const roomLocks = new Map();    // room -> boolean 房间锁定状态

// 初始化房间锁定状态
db.all('SELECT name, locked FROM rooms', (err, rows) => {
  if (rows) rows.forEach(row => roomLocks.set(row.name, row.locked === 1));
});

// WebSocket 核心处理
wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;
  console.log(`新客户端连接，IP: ${ip}`);

  // 初始化当前连接的禁言状态
  ws.isMuted = false;

  // 消息处理
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      const userData = wsToUser.get(ws) || {};
      const username = userData.username;

      // 1. 登录验证
      if (msg.type === 'login') {
        db.get('SELECT * FROM users WHERE username = ? AND password = ?', 
          [msg.username, msg.password], (err, row) => {
          if (row) {
            // 顶号处理
            if (userMap.has(msg.username)) {
              userMap.get(msg.username).send(JSON.stringify({ 
                type: 'kick', 
                reason: '你的账号在其他设备登录' 
              }));
              userMap.get(msg.username).close();
            }
            // 绑定用户信息
            userMap.set(msg.username, ws);
            wsToUser.set(ws, { 
              username: msg.username, 
              room: msg.room || '', 
              ip 
            });
            ws.send(JSON.stringify({ type: 'login_success', username: msg.username }));
          } else {
            ws.send(JSON.stringify({ type: 'login_fail', message: '用户名或密码错误' }));
          }
        });
        return;
      }

      // 未登录拦截
      if (!username) {
        ws.send(JSON.stringify({ type: 'error', message: '请先登录' }));
        return;
      }

      // 2. 发送群聊消息
      if (msg.type === 'chat') {
        const room = msg.room;
        // 检查房间锁定
        if (roomLocks.get(room) && !isRoomCreator(username, room)) {
          ws.send(JSON.stringify({ type: 'error', message: '房间已被锁定，无法发送消息' }));
          return;
        }
        // 检查禁言状态
        if (mutedUsers.get(room)?.has(username)) {
          ws.send(JSON.stringify({ type: 'muted', message: '你已被禁言' }));
          return;
        }
        // 保存消息并广播
        db.run('INSERT INTO messages (username, content, room) VALUES (?, ?, ?)', 
          [username, msg.content, room]);
        broadcastRoom(room, {
          type: 'chat',
          username,
          content: msg.content,
          room
        });
        return;
      }

      // 3. 切换房间
      if (msg.type === 'switch_room') {
        const oldRoom = userData.room;
        const newRoom = msg.room;
        
        // 离开旧房间广播
        if (oldRoom) {
          broadcastRoom(oldRoom, {
            type: 'system',
            content: `${username} 离开了聊天室`,
            room: oldRoom
          });
        }
        
        // 更新房间信息
        wsToUser.set(ws, { ...userData, room: newRoom });
        
        // 加入新房间广播
        broadcastRoom(newRoom, {
          type: 'system',
          content: `${username} 加入了聊天室`,
          room: newRoom
        });
        return;
      }

      // 4. 私聊消息
      if (msg.type === 'private_msg') {
        const targetWs = userMap.get(msg.receiver);
        // 发送给接收方
        if (targetWs) {
          targetWs.send(JSON.stringify({
            type: 'private_msg',
            sender: username,
            receiver: msg.receiver,
            content: msg.content
          }));
        }
        // 发送方回显
        ws.send(JSON.stringify({
          type: 'private_msg',
          sender: username,
          receiver: msg.receiver,
          content: msg.content
        }));
        // 保存私聊消息
        db.run('INSERT INTO private_messages (sender, receiver, content) VALUES (?, ?, ?)', 
          [username, msg.receiver, msg.content]);
        return;
      }

      // 5. 房间管理 - 锁定/解锁
      if (msg.type === 'lock_room') {
        if (isRoomCreator(username, msg.room)) {
          roomLocks.set(msg.room, msg.locked);
          // 更新数据库
          db.run('UPDATE rooms SET locked = ? WHERE name = ?', 
            [msg.locked ? 1 : 0, msg.room]);
          // 广播房间状态
          broadcastRoom(msg.room, {
            type: 'system',
            content: `${username} ${msg.locked ? '锁定' : '解锁'}了房间`,
            room: msg.room
          });
        } else {
          ws.send(JSON.stringify({ type: 'error', message: '仅房间创建者可执行此操作' }));
        }
        return;
      }

      // 6. 房间管理 - 禁言用户
      if (msg.type === 'mute_user') {
        if (isRoomCreator(username, msg.room) && msg.target !== username) {
          if (!mutedUsers.has(msg.room)) mutedUsers.set(msg.room, new Set());
          const roomMutes = mutedUsers.get(msg.room);
          
          if (roomMutes.has(msg.target)) {
            roomMutes.delete(msg.target);
            ws.send(JSON.stringify({ type: 'success', message: `${msg.target} 已解除禁言` }));
          } else {
            roomMutes.add(msg.target);
            // 保存禁言记录
            db.run('INSERT INTO mutes (username, room, admin) VALUES (?, ?, ?)', 
              [msg.target, msg.room, username]);
            // 通知被禁言用户
            const targetWs = userMap.get(msg.target);
            if (targetWs) {
              targetWs.send(JSON.stringify({ 
                type: 'muted', 
                message: `你被 ${username} 禁言了` 
              }));
            }
          }
          // 广播禁言状态
          broadcastRoom(msg.room, {
            type: 'system',
            content: `${username} ${roomMutes.has(msg.target) ? '禁言' : '解除禁言'}了 ${msg.target}`,
            room: msg.room
          });
        }
        return;
      }

      // 7. 房间管理 - 踢出用户
      if (msg.type === 'kick_user') {
        if (isRoomCreator(username, msg.room) && msg.target !== username) {
          const targetWs = userMap.get(msg.target);
          if (targetWs) {
            // 获取目标用户的房间信息
            const targetRoom = wsToUser.get(targetWs)?.room;
            if (targetRoom === msg.room) {
              // 通知被踢出
              targetWs.send(JSON.stringify({ 
                type: 'kick', 
                reason: msg.reason || '被房间管理员踢出' 
              }));
              // 强制切换到默认房间
              wsToUser.set(targetWs, {
                ...wsToUser.get(targetWs),
                room: '喵喵粉丝群'
              });
              // 广播踢出消息
              broadcastRoom(msg.room, {
                type: 'system',
                content: `${msg.target} 被 ${username} 踢出房间`,
                room: msg.room
              });
              // 广播进入默认房间
              broadcastRoom('喵喵粉丝群', {
                type: 'system',
                content: `${msg.target} 加入了聊天室`,
                room: '喵喵粉丝群'
              });
            }
          }
        }
        return;
      }

      // 8. 好友申请响应
      if (msg.type === 'friend_response') {
        const targetWs = userMap.get(msg.to);
        if (targetWs) {
          targetWs.send(JSON.stringify({
            type: 'friend_response',
            message: msg.message
          }));
        }
        return;
      }

      // 9. 改名同步
      if (msg.type === 'rename') {
        if (userMap.has(msg.oldName)) {
          userMap.delete(msg.oldName);
          userMap.set(msg.newName, ws);
          wsToUser.set(ws, {
            ...wsToUser.get(ws),
            username: msg.newName
          });
        }
        return;
      }

    } catch (e) {
      console.error('消息处理错误:', e);
      ws.send(JSON.stringify({ type: 'error', message: '消息格式错误' }));
    }
  });

  // 断开连接处理
  ws.on('close', () => {
    const userData = wsToUser.get(ws);
    if (userData) {
      const { username, room } = userData;
      // 清理映射
      userMap.delete(username);
      wsToUser.delete(ws);
      // 广播离开消息
      if (room) {
        broadcastRoom(room, {
          type: 'system',
          content: `${username} 离开了聊天室`,
          room
        });
      }
    }
    console.log('客户端断开连接');
  });

  // 错误处理
  ws.on('error', (err) => {
    console.error('WebSocket错误:', err);
  });
});

// ==================== 工具函数 ====================
// 按房间广播消息
function broadcastRoom(room, msg) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      const userData = wsToUser.get(client);
      if (userData && userData.room === room) {
        client.send(JSON.stringify(msg));
      }
    }
  });
}

// 判断是否是房间创建者
function isRoomCreator(username, roomName) {
  let isCreator = false;
  db.get('SELECT creator FROM rooms WHERE name = ?', [roomName], (err, row) => {
    if (row) isCreator = row.creator === username;
  });
  return isCreator;
}

// 获取房间在线人数
function getRoomOnlineCount(roomName) {
  let count = 0;
  wss.clients.forEach(client => {
    const userData = wsToUser.get(client);
    if (userData && userData.room === roomName) count++;
  });
  return count;
}

// ==================== HTTP API 接口 ====================
// 1. 用户注册
app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.json({ success: false, message: '用户名和密码不能为空' });
  }
  db.run('INSERT INTO users (username, password) VALUES (?, ?)', 
    [username, password], (err) => {
    if (err) {
      res.json({ success: false, message: '用户名已存在' });
    } else {
      res.json({ success: true, message: '注册成功' });
    }
  });
});

// 2. 用户登录
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  db.get('SELECT * FROM users WHERE username = ? AND password = ?', 
    [username, password], (err, row) => {
    if (row) {
      res.json({ success: true, data: { username } });
    } else {
      res.json({ success: false, message: '用户名或密码错误' });
    }
  });
});

// 3. 获取聊天室列表（带在线人数）
app.get('/api/rooms', (req, res) => {
  db.all('SELECT * FROM rooms WHERE visible = 1', (err, rooms) => {
    if (err) {
      res.json({ success: false, message: err.message });
    } else {
      const roomsWithOnline = rooms.map(room => ({
        ...room,
        onlineCount: getRoomOnlineCount(room.name),
        locked: room.locked === 1
      }));
      res.json({ success: true, rooms: roomsWithOnline });
    }
  });
});

// 4. 用户创建聊天室
app.post('/api/user/create-room', (req, res) => {
  const { username, name } = req.body;
  // 检查是否已创建过
  db.get('SELECT * FROM rooms WHERE creator = ?', [username], (err, row) => {
    if (row) {
      res.json({ success: false, message: '你已经创建过一个聊天室' });
    } else {
      db.run('INSERT INTO rooms (name, creator, locked) VALUES (?, ?, 0)', 
        [name, username], (err) => {
        if (err) {
          res.json({ success: false, message: '聊天室名称已存在' });
        } else {
          roomLocks.set(name, false); // 初始化锁定状态
          res.json({ success: true, message: '创建成功' });
        }
      });
    }
  });
});

// 5. 获取房间历史消息
app.get('/api/history', (req, res) => {
  const room = req.query.room;
  db.all('SELECT * FROM messages WHERE room = ? ORDER BY created_at DESC LIMIT 100', 
    [room], (err, rows) => {
    res.json({
      success: !err,
      list: rows ? rows.reverse() : []
    });
  });
});

// 6. 好友申请相关
app.post('/api/add-friend', (req, res) => {
  const { from, to } = req.body;
  // 检查是否已存在关系
  db.get('SELECT * FROM friends WHERE (user1 = ? AND user2 = ?) OR (user1 = ? AND user2 = ?)', 
    [from, to, to, from], (err, row) => {
    if (row) {
      res.json({ success: false, message: '已发送过好友申请或已是好友' });
    } else {
      db.run('INSERT INTO friends (user1, user2, status) VALUES (?, ?, 0)', [from, to], (err) => {
        // 实时通知对方
        const targetWs = userMap.get(to);
        if (targetWs) {
          targetWs.send(JSON.stringify({
            type: 'friend_apply',
            from,
            to
          }));
        }
        res.json({ success: true, message: '好友申请已发送' });
      });
    }
  });
});

// 7. 获取好友申请列表
app.get('/api/friend-apply', (req, res) => {
  const username = req.query.username;
  db.all('SELECT user1 as from FROM friends WHERE user2 = ? AND status = 0', 
    [username], (err, rows) => {
    res.json({ success: !err, list: rows || [] });
  });
});

// 8. 同意好友申请
app.post('/api/agree-friend', (req, res) => {
  const { from, to } = req.body;
  db.run('UPDATE friends SET status = 1 WHERE user1 = ? AND user2 = ? AND status = 0', 
    [from, to], (err) => {
    res.json({
      success: !err,
      message: !err ? '已同意' : '操作失败'
    });
  });
});

// 9. 拒绝好友申请
app.post('/api/reject-friend', (req, res) => {
  const { from, to } = req.body;
  db.run('UPDATE friends SET status = 2 WHERE user1 = ? AND user2 = ? AND status = 0', 
    [from, to], (err) => {
    res.json({
      success: !err,
      message: !err ? '已拒绝' : '操作失败'
    });
  });
});

// 10. 获取好友列表
app.get('/api/friend-list', (req, res) => {
  const username = req.query.username;
  db.all(`
    SELECT CASE WHEN user1 = ? THEN user2 ELSE user1 END as friend 
    FROM friends 
    WHERE (user1 = ? OR user2 = ?) AND status = 1
  `, [username, username, username], (err, rows) => {
    res.json({
      success: !err,
      list: rows ? rows.map(item => item.friend) : []
    });
  });
});

// 11. 删除好友
app.post('/api/delete-friend', (req, res) => {
  const { user, friend } = req.body;
  db.run(`
    DELETE FROM friends 
    WHERE (user1 = ? AND user2 = ?) OR (user1 = ? AND user2 = ?)
  `, [user, friend, friend, user], (err) => {
    res.json({
      success: !err,
      message: !err ? '已删除好友' : '删除失败'
    });
  });
});

// 12. 私聊相关
app.get('/api/private-history', (req, res) => {
  const { user, friend } = req.query;
  db.all(`
    SELECT * FROM private_messages 
    WHERE (sender = ? AND receiver = ?) OR (sender = ? AND receiver = ?)
    ORDER BY created_at DESC LIMIT 100
  `, [user, friend, friend, user], (err, rows) => {
    res.json({
      success: !err,
      list: rows ? rows.reverse() : []
    });
  });
});

app.post('/api/send-private', (req, res) => {
  const { sender, receiver, content } = req.body;
  db.run('INSERT INTO private_messages (sender, receiver, content) VALUES (?, ?, ?)', 
    [sender, receiver, content], (err) => {
    res.json({ success: !err });
  });
});

// 13. 个人信息管理
app.post('/api/rename', (req, res) => {
  const { oldName, newName } = req.body;
  // 检查新名称是否存在
  db.get('SELECT * FROM users WHERE username = ?', [newName], (err, row) => {
    if (row) {
      res.json({ success: false, message: '昵称已被占用' });
    } else {
      // 更新用户表
      db.run('UPDATE users SET username = ? WHERE username = ?', [newName, oldName], (err) => {
        if (err) {
          res.json({ success: false, message: '修改失败' });
        } else {
          // 更新房间创建者
          db.run('UPDATE rooms SET creator = ? WHERE creator = ?', [newName, oldName]);
          // 更新消息记录
          db.run('UPDATE messages SET username = ? WHERE username = ?', [newName, oldName]);
          db.run('UPDATE private_messages SET sender = ? WHERE sender = ?', [newName, oldName]);
          db.run('UPDATE private_messages SET receiver = ? WHERE receiver = ?', [newName, oldName]);
          // 更新好友关系
          db.run('UPDATE friends SET user1 = ? WHERE user1 = ?', [newName, oldName]);
          db.run('UPDATE friends SET user2 = ? WHERE user2 = ?', [newName, oldName]);
          
          res.json({ success: true, message: '昵称修改成功' });
        }
      });
    }
  });
});

// 14. 注销账号
app.post('/api/delete-account', (req, res) => {
  const { username } = req.body;
  // 事务删除所有相关数据
  db.serialize(() => {
    db.run('DELETE FROM users WHERE username = ?', [username]);
    db.run('DELETE FROM rooms WHERE creator = ?', [username]);
    db.run('DELETE FROM messages WHERE username = ?', [username]);
    db.run('DELETE FROM private_messages WHERE sender = ? OR receiver = ?', [username, username]);
    db.run('DELETE FROM friends WHERE user1 = ? OR user2 = ?', [username, username]);
    
    // 清理内存状态
    userMap.delete(username);
    wsToUser.forEach((value, key) => {
      if (value.username === username) wsToUser.delete(key);
    });
    
    res.json({ success: true, message: '账号已注销' });
  });
});

// 15. 房间管理接口
app.post('/api/admin/room/clear', (req, res) => {
  const { room, creator } = req.body;
  // 验证创建者
  db.get('SELECT * FROM rooms WHERE name = ? AND creator = ?', [room, creator], (err, row) => {
    if (row) {
      db.run('DELETE FROM messages WHERE room = ?', [room], (err) => {
        res.json({ success: !err });
      });
    } else {
      res.json({ success: false, message: '无权限执行此操作' });
    }
  });
});

app.post('/api/admin/room/delete', (req, res) => {
  const { room, creator } = req.body;
  db.get('SELECT * FROM rooms WHERE name = ? AND creator = ?', [room, creator], (err, row) => {
    if (row) {
      db.run('DELETE FROM rooms WHERE name = ?', [room]);
      db.run('DELETE FROM messages WHERE room = ?', [room]);
      roomLocks.delete(room);
      mutedUsers.delete(room);
      res.json({ success: true });
    } else {
      res.json({ success: false, message: '无权限执行此操作' });
    }
  });
});

// 16. 公告管理
app.get('/api/admin/announcement', (req, res) => {
  db.get('SELECT content FROM announcement WHERE id = 1', (err, row) => {
    res.json({
      success: !err,
      content: row?.content || '欢迎使用聊天室系统！'
    });
  });
});

app.post('/api/admin/announcement', (req, res) => {
  const { content } = req.body;
  db.run('UPDATE announcement SET content = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1', 
    [content], (err) => {
    // 广播公告更新
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({
          type: 'announcement',
          content
        }));
      }
    });
    res.json({ success: !err });
  });
});

// 静态文件服务
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 启动服务
server.listen(PORT, () => {
  console.log(`服务器运行在 http://localhost:${PORT}`);
});

// 优雅退出
process.on('SIGINT', () => {
  db.close((err) => {
    if (err) console.error('数据库关闭失败:', err.message);
    else console.log('数据库连接已关闭');
    server.close(() => {
      console.log('服务器已关闭');
      process.exit(0);
    });
  });
});
