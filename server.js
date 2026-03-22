const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');

// 初始化应用
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// 核心配置
const PORT = process.env.PORT || 3000;
const FRONTEND_DOMAIN = '*'; // 生产环境替换为你的前端域名
const ADMIN_ACCOUNT = 'admin';
const ADMIN_PASSWORD = 'Lmx%%112233';
const ADMIN_TOKEN = 'admin_chat_system_lmx_112233'; // 管理员鉴权token

// 中间件
app.use(cors({ origin: FRONTEND_DOMAIN, credentials: true }));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('./')); // 静态文件托管，前端html直接放同目录即可

// 初始化SQLite数据库（永久存储）
const dbPath = path.join(__dirname, './database.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('数据库连接失败:', err.message);
  } else {
    console.log('✅ 成功连接SQLite数据库，数据永久存储');
    initDatabaseTables(); // 初始化所有表
  }
});

// 数据库表初始化
function initDatabaseTables() {
  // 1. 用户表（新增IP、在线状态字段）
  db.run(`CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY,
    password TEXT NOT NULL,
    last_ip TEXT DEFAULT '',
    online_status INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // 2. 群聊消息表（新增管理员消息标识）
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    content TEXT NOT NULL,
    room TEXT NOT NULL,
    is_admin INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // 3. 私聊消息表
  db.run(`CREATE TABLE IF NOT EXISTS private_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender TEXT NOT NULL,
    receiver TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // 4. 好友申请表
  db.run(`CREATE TABLE IF NOT EXISTS friend_applies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_user TEXT NOT NULL,
    to_user TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(from_user, to_user)
  )`);

  // 5. 好友关系表
  db.run(`CREATE TABLE IF NOT EXISTS friends (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user1 TEXT NOT NULL,
    user2 TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user1, user2)
  )`);

  // 6. 聊天室表（新增管理员控制字段，匹配截图功能）
  db.run(`CREATE TABLE IF NOT EXISTS rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    owner TEXT NOT NULL,
    member_count INTEGER DEFAULT 0,
    is_banned INTEGER DEFAULT 0,
    is_show INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // 7. 房间禁言表
  db.run(`CREATE TABLE IF NOT EXISTS room_mutes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room TEXT NOT NULL,
    username TEXT NOT NULL,
    UNIQUE(room, username)
  )`);

  // 8. 房间黑名单表
  db.run(`CREATE TABLE IF NOT EXISTS room_bans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room TEXT NOT NULL,
    username TEXT NOT NULL,
    UNIQUE(room, username)
  )`);

  // 9. 系统公告表
  db.run(`CREATE TABLE IF NOT EXISTS announcements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // 10. 管理员表（初始化默认账号）
  db.run(`CREATE TABLE IF NOT EXISTS admin (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL
  )`, () => {
    // 插入默认管理员账号
    db.get('SELECT * FROM admin WHERE account = ?', [ADMIN_ACCOUNT], (err, row) => {
      if (!row) {
        db.run('INSERT INTO admin (account, password) VALUES (?, ?)', [ADMIN_ACCOUNT, ADMIN_PASSWORD]);
        console.log('✅ 默认管理员账号初始化完成');
      }
    });
  });

  // 初始化默认官方房间
  db.get('SELECT * FROM rooms WHERE name = ?', ['喵喵粉丝群'], (err, row) => {
    if (!row) {
      db.run('INSERT INTO rooms (name, owner, is_show) VALUES (?, ?, ?)', ['喵喵粉丝群', 'system', 1]);
    }
  });
}

// ------------------- 管理员鉴权中间件 -------------------
function adminAuth(req, res, next) {
  const token = req.headers['admin-token'];
  if (token !== ADMIN_TOKEN) {
    return res.status(403).json({ success: false, message: '无管理员权限' });
  }
  next();
}

// ------------------- 管理员核心接口 -------------------
// 1. 管理员登录
app.post('/api/admin/login', (req, res) => {
  const { account, password } = req.body;
  if (account === ADMIN_ACCOUNT && password === ADMIN_PASSWORD) {
    return res.json({
      success: true,
      message: '登录成功',
      token: ADMIN_TOKEN
    });
  }
  res.status(401).json({ success: false, message: '账号或密码错误' });
});

// 2. 获取所有聊天室列表（匹配截图字段）
app.get('/api/admin/rooms', adminAuth, (req, res) => {
  const { search, status } = req.query;
  let sql = 'SELECT * FROM rooms WHERE 1=1';
  let params = [];

  if (search) {
    sql += ' AND name LIKE ?';
    params.push(`%${search}%`);
  }
  if (status === 'show') {
    sql += ' AND is_show = 1';
  } else if (status === 'hide') {
    sql += ' AND is_show = 0';
  }

  sql += ' ORDER BY created_at DESC';
  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ success: false, message: '获取失败' });
    res.json({ success: true, list: rows });
  });
});

// 3. 新增聊天室
app.post('/api/admin/room/add', adminAuth, (req, res) => {
  const { name, owner = 'admin' } = req.body;
  if (!name) return res.status(400).json({ success: false, message: '房间名不能为空' });

  db.get('SELECT * FROM rooms WHERE name = ?', [name], (err, row) => {
    if (row) return res.status(400).json({ success: false, message: '房间名已存在' });
    db.run('INSERT INTO rooms (name, owner) VALUES (?, ?)', [name, owner], (err) => {
      if (err) return res.status(500).json({ success: false, message: '创建失败' });
      broadcastRoomListUpdate(); // 实时同步给所有用户
      res.json({ success: true, message: '聊天室创建成功' });
    });
  });
});

// 4. 修改聊天室名称
app.post('/api/admin/room/rename', adminAuth, (req, res) => {
  const { id, newName } = req.body;
  if (!id || !newName) return res.status(400).json({ success: false, message: '参数错误' });

  db.get('SELECT * FROM rooms WHERE id = ?', [id], (err, room) => {
    if (!room) return res.status(400).json({ success: false, message: '房间不存在' });
    db.run('UPDATE rooms SET name = ? WHERE id = ?', [newName, id], (err) => {
      if (err) return res.status(500).json({ success: false, message: '修改失败' });
      // 同步更新消息表的房间名
      db.run('UPDATE messages SET room = ? WHERE room = ?', [newName, room.name]);
      broadcastRoomListUpdate();
      res.json({ success: true, message: '房间名修改成功' });
    });
  });
});

// 5. 修改房间禁言状态
app.post('/api/admin/room/ban', adminAuth, (req, res) => {
  const { id, is_banned } = req.body;
  db.run('UPDATE rooms SET is_banned = ? WHERE id = ?', [is_banned, id], (err) => {
    if (err) return res.status(500).json({ success: false, message: '修改失败' });
    broadcastRoomListUpdate();
    res.json({ success: true, message: '禁言状态修改成功' });
  });
});

// 6. 修改房间显示状态
app.post('/api/admin/room/show', adminAuth, (req, res) => {
  const { id, is_show } = req.body;
  db.run('UPDATE rooms SET is_show = ? WHERE id = ?', [is_show, id], (err) => {
    if (err) return res.status(500).json({ success: false, message: '修改失败' });
    broadcastRoomListUpdate();
    res.json({ success: true, message: '显示状态修改成功' });
  });
});

// 7. 清空房间聊天记录
app.post('/api/admin/room/clear', adminAuth, (req, res) => {
  const { roomName } = req.body;
  db.run('DELETE FROM messages WHERE room = ?', [roomName], (err) => {
    if (err) return res.status(500).json({ success: false, message: '清空失败' });
    // 实时通知房间内用户
    broadcast({
      type: 'system',
      content: '管理员已清空本房间所有聊天记录',
      room: roomName
    });
    res.json({ success: true, message: '聊天记录清空成功' });
  });
});

// 8. 删除聊天室
app.post('/api/admin/room/delete', adminAuth, (req, res) => {
  const { id, roomName } = req.body;
  db.run('DELETE FROM rooms WHERE id = ?', [id], (err) => {
    if (err) return res.status(500).json({ success: false, message: '删除失败' });
    // 级联删除相关数据
    db.run('DELETE FROM messages WHERE room = ?', [roomName]);
    db.run('DELETE FROM room_mutes WHERE room = ?', [roomName]);
    db.run('DELETE FROM room_bans WHERE room = ?', [roomName]);
    // 实时通知房间内用户
    broadcast({
      type: 'room_dismissed',
      room: roomName,
      reason: '管理员已解散该房间'
    });
    broadcastRoomListUpdate();
    res.json({ success: true, message: '聊天室删除成功' });
  });
});

// 9. 获取所有用户列表（含IP、在线状态）
app.get('/api/admin/users', adminAuth, (req, res) => {
  db.all('SELECT username, last_ip, online_status, created_at FROM users ORDER BY created_at DESC', (err, rows) => {
    if (err) return res.status(500).json({ success: false, message: '获取失败' });
    res.json({ success: true, list: rows });
  });
});

// 10. 踢用户下线
app.post('/api/admin/user/kick', adminAuth, (req, res) => {
  const { username } = req.body;
  if (userMap.has(username)) {
    const ws = userMap.get(username);
    ws.send(JSON.stringify({ type: 'kick', reason: '管理员已将你踢下线' }));
    ws.close(4001, 'admin_kick');
    userMap.delete(username);
  }
  db.run('UPDATE users SET online_status = 0 WHERE username = ?', [username]);
  res.json({ success: true, message: '用户已被踢下线' });
});

// 11. 发布系统公告
app.post('/api/admin/announcement', adminAuth, (req, res) => {
  const { content } = req.body;
  if (!content) return res.status(400).json({ success: false, message: '公告内容不能为空' });

  db.run('INSERT INTO announcements (content) VALUES (?)', [content], (err) => {
    if (err) return res.status(500).json({ success: false, message: '发布失败' });
    // 实时推送给所有在线用户
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({
          type: 'announcement',
          content: content
        }));
      }
    });
    res.json({ success: true, message: '公告发布成功' });
  });
});

// 12. 获取最新公告
app.get('/api/announcement/latest', (req, res) => {
  db.get('SELECT * FROM announcements ORDER BY id DESC LIMIT 1', (err, row) => {
    res.json({ success: true, data: row || null });
  });
});

// 13. 管理员发送带标识的消息
app.post('/api/admin/send-msg', adminAuth, (req, res) => {
  const { room, content } = req.body;
  if (!room || !content) return res.status(400).json({ success: false, message: '参数错误' });

  // 保存到数据库
  db.run('INSERT INTO messages (username, content, room, is_admin) VALUES (?, ?, ?, ?)', 
    ['系统管理员', content, room, 1], (err) => {
      if (err) return res.status(500).json({ success: false, message: '发送失败' });
      // 实时广播
      broadcast({
        type: 'chat',
        username: '系统管理员',
        content: content,
        room: room,
        is_admin: 1
      });
      res.json({ success: true, message: '消息发送成功' });
    }
  );
});

// 14. 获取群聊聊天记录
app.get('/api/admin/messages', adminAuth, (req, res) => {
  const { room } = req.query;
  let sql = 'SELECT * FROM messages ORDER BY created_at DESC LIMIT 1000';
  let params = [];
  if (room) {
    sql = 'SELECT * FROM messages WHERE room = ? ORDER BY created_at DESC LIMIT 1000';
    params = [room];
  }
  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ success: false, message: '获取失败' });
    res.json({ success: true, list: rows });
  });
});

// 15. 删除单条聊天记录
app.post('/api/admin/message/delete', adminAuth, (req, res) => {
  const { id } = req.body;
  db.run('DELETE FROM messages WHERE id = ?', [id], (err) => {
    if (err) return res.status(500).json({ success: false, message: '删除失败' });
    res.json({ success: true, message: '记录删除成功' });
  });
});

// 16. 获取所有好友私聊记录
app.get('/api/admin/private-messages', adminAuth, (req, res) => {
  db.all('SELECT * FROM private_messages ORDER BY created_at DESC LIMIT 1000', (err, rows) => {
    if (err) return res.status(500).json({ success: false, message: '获取失败' });
    res.json({ success: true, list: rows });
  });
});

// 17. 下载数据库文件
app.get('/api/admin/download-db', adminAuth, (req, res) => {
  if (fs.existsSync(dbPath)) {
    res.download(dbPath, 'chat-system-database.db', (err) => {
      if (err) res.status(500).json({ success: false, message: '下载失败' });
    });
  } else {
    res.status(404).json({ success: false, message: '数据库文件不存在' });
  }
});

// ------------------- 原有用户端接口（全量保留+优化） -------------------
// 用户注册
app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.json({ success: false, message: '用户名和密码不能为空' });
  db.get('SELECT username FROM users WHERE username=?', [username], (e, r) => {
    if (r) return res.json({ success: false, message: '用户名已存在' });
    db.run('INSERT INTO users (username,password) VALUES (?,?)', [username, password], (e) => {
      res.json({ success: true, message: '注册成功' });
    });
  });
});

// 用户登录（记录真实IP）
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  // 获取用户真实IP
  const clientIP = req.headers['x-forwarded-for'] || req.socket.remoteAddress || req.ip;
  db.get('SELECT username FROM users WHERE username=? AND password=?', [username, password], (e, r) => {
    if (!r) return res.json({ success: false, message: '账号或密码错误' });
    // 顶掉旧连接
    if (userMap.has(username)) {
      userMap.get(username).send(JSON.stringify({ type: 'kick', reason: '你的账号在别处登录' }));
      userMap.get(username).close();
    }
    // 更新IP和在线状态
    db.run('UPDATE users SET last_ip = ?, online_status = 1 WHERE username = ?', [clientIP, username]);
    res.json({ success: true, message: '登录成功', data: { username } });
  });
});

// 修改昵称
app.post('/api/rename', (req, res) => {
  const { oldName, newName } = req.body;
  if (!oldName || !newName || oldName === newName) return res.json({ success: false, message: '参数错误' });
  db.get('SELECT username FROM users WHERE username=?', [newName], (e, r) => {
    if (r) return res.json({ success: false, message: '新昵称已被使用' });
    db.serialize(() => {
      db.run('BEGIN TRANSACTION');
      db.run('UPDATE users SET username=? WHERE username=?', [newName, oldName]);
      db.run('UPDATE messages SET username=? WHERE username=?', [newName, oldName]);
      db.run('UPDATE private_messages SET sender=? WHERE sender=?', [newName, oldName]);
      db.run('UPDATE private_messages SET receiver=? WHERE receiver=?', [newName, oldName]);
      db.run('UPDATE friend_applies SET from_user=? WHERE from_user=?', [newName, oldName]);
      db.run('UPDATE friend_applies SET to_user=? WHERE to_user=?', [newName, oldName]);
      db.run('UPDATE friends SET user1=? WHERE user1=?', [newName, oldName]);
      db.run('UPDATE friends SET user2=? WHERE user2=?', [newName, oldName]);
      db.run('UPDATE rooms SET owner=? WHERE owner=?', [newName, oldName]);
      db.run('UPDATE room_mutes SET username=? WHERE username=?', [newName, oldName]);
      db.run('UPDATE room_bans SET username=? WHERE username=?', [newName, oldName]);
      db.run('COMMIT', (e) => {
        if (e) { db.run('ROLLBACK'); return res.json({ success: false, message: '修改失败' }); }
        if (userMap.has(oldName)) {
          const ws = userMap.get(oldName);
          userMap.delete(oldName);
          userMap.set(newName, ws);
          wsToUser.set(ws, { username: newName, room: wsToUser.get(ws).room });
        }
        broadcastRoomListUpdate();
        res.json({ success: true, message: '昵称修改成功' });
      });
    });
  });
});

// 注销账号
app.post('/api/delete-account', (req, res) => {
  const { username } = req.body;
  if (!username) return res.json({ success: false, message: '参数错误' });
  if (userMap.has(username)) {
    userMap.get(username).close();
    userMap.delete(username);
  }
  db.serialize(() => {
    db.run('BEGIN TRANSACTION');
    db.run('DELETE FROM users WHERE username=?', [username]);
    db.run('DELETE FROM messages WHERE username=?', [username]);
    db.run('DELETE FROM private_messages WHERE sender=? OR receiver=?', [username, username]);
    db.run('DELETE FROM friend_applies WHERE from_user=? OR to_user=?', [username, username]);
    db.run('DELETE FROM friends WHERE user1=? OR user2=?', [username, username]);
    db.run('DELETE FROM rooms WHERE owner=?', [username]);
    db.run('DELETE FROM room_mutes WHERE username=?', [username]);
    db.run('DELETE FROM room_bans WHERE username=?', [username]);
    db.run('COMMIT', (e) => {
      if (e) { db.run('ROLLBACK'); return res.json({ success: false, message: '注销失败' }); }
      broadcastRoomListUpdate();
      res.json({ success: true, message: '账号注销成功' });
    });
  });
});

// 添加好友
app.post('/api/add-friend', (req, res) => {
  const { from, to } = req.body;
  if (!from || !to || from === to) return res.json({ success: false, message: '参数错误' });
  db.get('SELECT username FROM users WHERE username=?', [to], (e, r) => {
    if (!r) return res.json({ success: false, message: '用户不存在' });
    db.get('SELECT id FROM friend_applies WHERE from_user=? AND to_user=?', [from, to], (e, r) => {
      if (r) return res.json({ success: false, message: '已发送好友申请' });
      db.get(`SELECT id FROM friends WHERE (user1=? AND user2=?) OR (user1=? AND user2=?)`, [from, to, to, from], (e, r) => {
        if (r) return res.json({ success: false, message: '已是好友' });
        db.run('INSERT INTO friend_applies (from_user,to_user) VALUES (?,?)', [from, to], (e) => {
          if (e) return res.json({ success: false, message: '发送申请失败' });
          if (userMap.has(to)) {
            userMap.get(to).send(JSON.stringify({ type: 'friend_apply', from: from }));
          }
          res.json({ success: true, message: '好友申请发送成功' });
        });
      });
    });
  });
});

// 同意/拒绝好友
app.post('/api/agree-friend', (req, res) => {
  const { from, to } = req.body;
  if (!from || !to) return res.json({ success: false, message: '参数错误' });
  db.serialize(() => {
    db.run('BEGIN TRANSACTION');
    db.run('UPDATE friend_applies SET status=? WHERE from_user=? AND to_user=?', ['agreed', from, to]);
    db.run('INSERT INTO friends (user1,user2) VALUES (?,?)', [from, to]);
    db.run('COMMIT', (e) => {
      if (e) { db.run('ROLLBACK'); return res.json({ success: false, message: '同意失败' }); }
      res.json({ success: true, message: '已同意好友申请' });
    });
  });
});
app.post('/api/reject-friend', (req, res) => {
  const { from, to } = req.body;
  if (!from || !to) return res.json({ success: false, message: '参数错误' });
  db.run('UPDATE friend_applies SET status=? WHERE from_user=? AND to_user=?', ['rejected', from, to], (e) => {
    if (e) return res.json({ success: false, message: '拒绝失败' });
    res.json({ success: true, message: '已拒绝好友申请' });
  });
});
app.post('/api/delete-friend', (req, res) => {
  const { user, friend } = req.body;
  if (!user || !friend) return res.json({ success: false, message: '参数错误' });
  db.run(`DELETE FROM friends WHERE (user1=? AND user2=?) OR (user1=? AND user2=?)`, [user, friend, friend, user], (e) => {
    if (e) return res.json({ success: false, message: '删除失败' });
    res.json({ success: true, message: '好友删除成功' });
  });
});

// 好友相关查询
app.get('/api/friend-apply', (req, res) => {
  const { username } = req.query;
  if (!username) return res.json({ success: false, message: '参数错误' });
  db.all('SELECT from_user FROM friend_applies WHERE to_user=? AND status=?', [username, 'pending'], (e, rows) => {
    res.json({ success: true, list: rows.map(row => ({ from: row.from_user })) });
  });
});
app.get('/api/friend-list', (req, res) => {
  const { username } = req.query;
  if (!username) return res.json({ success: false, message: '参数错误' });
  db.all(`SELECT CASE WHEN user1=? THEN user2 ELSE user1 END as friend FROM friends WHERE user1=? OR user2=?`, [username, username, username], (e, rows) => {
    res.json({ success: true, list: rows.map(row => row.friend) });
  });
});

// 消息历史查询
app.get('/api/history', (req, res) => {
  const { room = '喵喵粉丝群' } = req.query;
  db.all(`SELECT username,content,is_admin,datetime(created_at,'+8 hours') as created_at FROM messages WHERE room=? ORDER BY id ASC LIMIT 500`, [room], (e, rows) => {
    res.json({ success: true, list: rows });
  });
});
app.get('/api/private-history', (req, res) => {
  const { user, friend } = req.query;
  if (!user || !friend) return res.json({ success: false, message: '参数错误' });
  db.all(`SELECT sender,content,datetime(created_at,'+8 hours') as created_at FROM private_messages WHERE (sender=? AND receiver=?) OR (sender=? AND receiver=?) ORDER BY id ASC LIMIT 500`, [user, friend, friend, user], (e, rows) => {
    res.json({ success: true, list: rows });
  });
});
app.post('/api/send-private', (req, res) => {
  const { sender, receiver, content } = req.body;
  if (!sender || !receiver || !content) return res.json({ success: false, message: '参数错误' });
  db.run('INSERT INTO private_messages (sender,receiver,content) VALUES (?,?,?)', [sender, receiver, content], (e) => {
    if (e) return res.json({ success: false, message: '保存失败' });
    res.json({ success: true, message: '发送成功' });
  });
});

// 房间相关接口
app.get('/api/all-rooms', (req, res) => {
  // 只返回管理员设置为显示的房间
  db.all('SELECT name, owner FROM rooms WHERE is_show = 1 ORDER BY created_at ASC', (e, rows) => {
    res.json({ success: true, rooms: rows || [] });
  });
});
app.get('/api/my-room', (req, res) => {
  const { username } = req.query;
  if (!username) return res.json({ success: false, message: '参数错误' });
  db.get('SELECT name FROM rooms WHERE owner = ?', [username], (e, row) => {
    res.json({ success: true, room: row ? { name: row.name } : null });
  });
});
app.post('/api/create-room', (req, res) => {
  const { username, name } = req.body;
  if (!username || !name) return res.json({ success: false, message: '参数错误' });
  db.get('SELECT name FROM rooms WHERE owner=?', [username], (e, r) => {
    if (r) return res.json({ success: false, message: '你已创建过房间：' + r.name });
    db.get('SELECT id FROM rooms WHERE name=?', [name], (e, r) => {
      if (r) return res.json({ success: false, message: '房间名已存在' });
      db.run('INSERT INTO rooms (name,owner) VALUES (?,?)', [name, username], (e) => {
        if (e) return res.json({ success: false, message: '创建失败' });
        broadcastRoomListUpdate();
        res.json({ success: true, message: '房间创建成功' });
      });
    });
  });
});

// 群主管理接口
app.post('/api/kick', (req, res) => {
  const { owner, room, username } = req.body;
  if (!owner || !room || !username) return res.json({ success: false, message: '参数错误' });
  db.get('SELECT id FROM rooms WHERE name=? AND owner=?', [room, owner], (e, r) => {
    if (!r) return res.json({ success: false, message: '你不是该房间群主' });
    if (username === owner) return res.json({ success: false, message: '不能踢自己' });
    db.run('INSERT OR IGNORE INTO room_bans (room,username) VALUES (?,?)', [room, username], (e) => {
      if (e) return res.json({ success: false, message: '操作失败' });
      if (userMap.has(username)) {
        userMap.get(username).send(JSON.stringify({ type: 'room_kicked', room: room, reason: '你被群主踢出房间' }));
        if (wsToUser.get(userMap.get(username))?.room === room) {
          wsToUser.set(userMap.get(username), { username: username, room: '' });
        }
      }
      broadcast({ type: 'system', content: `${username} 被群主踢出房间`, room: room });
      res.json({ success: true, message: '踢人成功' });
    });
  });
});
app.post('/api/mute', (req, res) => {
  const { owner, room, username } = req.body;
  if (!owner || !room || !username) return res.json({ success: false, message: '参数错误' });
  db.get('SELECT id FROM rooms WHERE name=? AND owner=?', [room, owner], (e, r) => {
    if (!r) return res.json({ success: false, message: '你不是该房间群主' });
    if (username === owner) return res.json({ success: false, message: '不能禁言自己' });
    db.run('INSERT OR IGNORE INTO room_mutes (room,username) VALUES (?,?)', [room, username], (e) => {
      if (e) return res.json({ success: false, message: '操作失败' });
      if (userMap.has(username)) {
        userMap.get(username).send(JSON.stringify({ type: 'room_muted', room: room, reason: '你被群主禁言' }));
      }
      broadcast({ type: 'system', content: `${username} 被群主禁言`, room: room });
      res.json({ success: true, message: '禁言成功' });
    });
  });
});
app.post('/api/clear-room', (req, res) => {
  const { owner, room } = req.body;
  if (!owner || !room) return res.json({ success: false, message: '参数错误' });
  db.get('SELECT id FROM rooms WHERE name=? AND owner=?', [room, owner], (e, r) => {
    if (!r) return res.json({ success: false, message: '你不是该房间群主' });
    db.run('DELETE FROM messages WHERE room=?', [room], (e) => {
      if (e) return res.json({ success: false, message: '操作失败' });
      broadcast({ type: 'system', content: '群主清空了所有聊天记录', room: room });
      res.json({ success: true, message: '清空成功' });
    });
  });
});
app.post('/api/dismiss-room', (req, res) => {
  const { owner, room } = req.body;
  if (!owner || !room) return res.json({ success: false, message: '参数错误' });
  db.get('SELECT id FROM rooms WHERE name=? AND owner=?', [room, owner], (e, r) => {
    if (!r) return res.json({ success: false, message: '你不是该房间群主' });
    db.serialize(() => {
      db.run('BEGIN TRANSACTION');
      db.run('DELETE FROM rooms WHERE name=?', [room]);
      db.run('DELETE FROM messages WHERE room=?', [room]);
      db.run('DELETE FROM room_mutes WHERE room=?', [room]);
      db.run('DELETE FROM room_bans WHERE room=?', [room]);
      db.run('COMMIT', (e) => {
        if (e) { db.run('ROLLBACK'); return res.json({ success: false, message: '操作失败' }); }
        broadcast({ type: 'system', content: '房间已被群主解散', room: room });
        wss.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN && wsToUser.has(client)) {
            const u = wsToUser.get(client);
            if (u.room === room) {
              client.send(JSON.stringify({ type: 'room_dismissed', room: room, reason: '房间已解散' }));
              wsToUser.set(client, { username: u.username, room: '' });
            }
          }
        });
        broadcastRoomListUpdate();
        res.json({ success: true, message: '解散成功' });
      });
    });
  });
});

// ------------------- WebSocket实时核心 -------------------
const userMap = new Map(); // username => ws
const wsToUser = new WeakMap(); // ws => { username, room }

wss.on('connection', (ws) => {
  console.log('新客户端连接');

  // 接收客户端消息
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      // 用户登录绑定
      if (data.type === 'login') {
        const { username, room = '' } = data;
        if (username) {
          if (userMap.has(username)) {
            const oldWs = userMap.get(username);
            oldWs.send(JSON.stringify({ type: 'kick', reason: '你的账号在别处登录' }));
            oldWs.close(4001, 'replaced');
          }
          userMap.set(username, ws);
          wsToUser.set(ws, { username, room });
          db.run('UPDATE users SET online_status = 1 WHERE username = ?', [username]);
          if (room) {
            broadcast({ type: 'system', content: `${username} 加入了聊天室`, room: room });
          }
        }
      }

      // 群聊消息
      if (data.type === 'chat') {
        const { username, content, room } = data;
        if (username && content && room) {
          // 检查房间全局禁言
          db.get('SELECT is_banned FROM rooms WHERE name = ?', [room], (err, roomInfo) => {
            if (roomInfo?.is_banned === 1) {
              ws.send(JSON.stringify({ type: 'system', content: '管理员已开启全房间禁言，无法发送消息', room: room }));
              return;
            }
            // 检查个人禁言
            db.get('SELECT id FROM room_mutes WHERE room = ? AND username = ?', [room, username], (err, row) => {
              if (row) {
                ws.send(JSON.stringify({ type: 'system', content: '你已被禁言，无法发送消息', room: room }));
                return;
              }
              // 检查黑名单
              db.get('SELECT id FROM room_bans WHERE room = ? AND username = ?', [room, username], (err, row) => {
                if (row) {
                  ws.send(JSON.stringify({ type: 'system', content: '你已被踢出房间，无法发送消息', room: room }));
                  return;
                }
                // 保存消息
                db.run('INSERT INTO messages (username, content, room) VALUES (?, ?, ?)', [username, content, room]);
                // 广播
                broadcast({ type: 'chat', username, content, room, is_admin: 0 });
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
          if (old.room) {
            broadcast({ type: 'system', content: `${old.username} 离开了聊天室`, room: old.room });
          }
          // 检查黑名单
          db.get('SELECT id FROM room_bans WHERE room = ? AND username = ?', [room, username], (err, row) => {
            if (row) {
              ws.send(JSON.stringify({ type: 'system', content: '你已被该房间拉黑，无法进入', room: room }));
              return;
            }
            wsToUser.set(ws, { username, room });
            broadcast({ type: 'system', content: `${username} 加入了聊天室`, room });
          });
        }
      }

      // 私聊消息
      if (data.type === 'private_msg') {
        const { sender, receiver, content } = data;
        if (sender && receiver && content) {
          if (userMap.has(receiver)) {
            userMap.get(receiver).send(JSON.stringify({ type: 'private_msg', sender, receiver, content }));
          }
          ws.send(JSON.stringify({ type: 'private_msg', sender, receiver, content }));
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
      db.run('UPDATE users SET online_status = 0 WHERE username = ?', [user.username]);
      broadcast({ type: 'system', content: `${user.username} 离开了聊天室`, room: user.room });
    }
    wsToUser.delete(ws);
  });

  ws.on('error', (err) => console.error('WebSocket错误', err));
});

// 房间广播函数
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

// 房间列表更新广播
function broadcastRoomListUpdate() {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'room_list_update' }));
    }
  });
}

// 启动服务
server.listen(PORT, () => {
  console.log(`✅ 服务器启动成功，运行端口：${PORT}`);
  console.log(`📌 管理员后台地址：http://localhost:${PORT}/admin.html`);
  console.log(`📌 用户端地址：http://localhost:${PORT}/index.html`);
  console.log(`🔐 管理员账号：admin  密码：Lmx%%112233`);
});
