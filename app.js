const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

// 初始化Express
const app = express();
const server = http.createServer(app);
// 初始化WebSocket
const wss = new WebSocket.Server({ server });

// 中间件配置
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// 静态文件托管（前端页面）
app.use(express.static(path.join(__dirname, 'public')));

// 数据库配置
const dbConfig = {
  host: 'localhost',
  user: 'root',
  password: 'root', // 替换为你的数据库密码
  database: 'chat_system',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
};
// 创建数据库连接池
const pool = mysql.createPool(dbConfig);

// 管理员JWT密钥（高安全性）
const ADMIN_JWT_SECRET = 'Lmx@Admin%%112233_Secret_2026';
// 管理员密码哈希（原始密码：Lmx%%112233）
const ADMIN_PASSWORD_HASH = '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi';

// -------------------------- 原有聊天功能（完全保留） --------------------------
// 存储在线用户
const onlineUsers = new Map();

// WebSocket连接处理
wss.on('connection', async (ws, req) => {
  // 获取客户端IP
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  let userId = null;
  let username = null;

  // 登录验证
  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);
      // 登录逻辑
      if (msg.type === 'login') {
        userId = msg.userId;
        username = msg.username;
        if (userId && username) {
          onlineUsers.set(userId, { ws, username, ip });
          // 更新用户真实IP
          await pool.execute(
            'UPDATE chat_users SET real_ip = ? WHERE id = ?',
            [ip, userId]
          );
          // 广播在线状态
          broadcast({
            type: 'userOnline',
            userId,
            username
          });
        }
      }
      // 群聊消息
      else if (msg.type === 'roomMsg') {
        // 检查用户是否被禁言
        const [userRows] = await pool.execute(
          'SELECT mute_chat FROM chat_users WHERE id = ?',
          [userId]
        );
        if (userRows[0]?.mute_chat === 1) {
          ws.send(JSON.stringify({ type: 'error', msg: '你已被禁言，无法发送群聊消息' }));
          return;
        }
        // 存储群聊消息
        await pool.execute(
          'INSERT INTO chat_room_logs (room_id, sender_id, sender, content, create_time) VALUES (?, ?, ?, ?, ?)',
          [msg.roomId, userId, username, msg.content, Date.now()]
        );
        // 广播群聊消息
        broadcast({
          type: 'roomMsg',
          roomId: msg.roomId,
          sender: username,
          content: msg.content,
          time: Date.now()
        });
      }
      // 私聊消息
      else if (msg.type === 'privateMsg') {
        // 检查用户是否被禁言
        const [userRows] = await pool.execute(
          'SELECT mute_private FROM chat_users WHERE id = ?',
          [userId]
        );
        if (userRows[0]?.mute_private === 1) {
          ws.send(JSON.stringify({ type: 'error', msg: '你已被禁言，无法发送私聊消息' }));
          return;
        }
        // 查找接收方
        const targetUser = Array.from(onlineUsers.entries()).find(([id, info]) => id === msg.targetId);
        // 存储私聊消息
        await pool.execute(
          'INSERT INTO chat_private_logs (sender_id, sender, receiver_id, receiver, content, create_time) VALUES (?, ?, ?, ?, ?, ?)',
          [userId, username, msg.targetId, msg.targetName, msg.content, Date.now()]
        );
        // 发送私聊消息
        if (targetUser) {
          targetUser[1].ws.send(JSON.stringify({
            type: 'privateMsg',
            sender: username,
            content: msg.content,
            time: Date.now()
          }));
        }
        // 给自己返回消息
        ws.send(JSON.stringify({
          type: 'privateMsg',
          receiver: msg.targetName,
          content: msg.content,
          time: Date.now()
        }));
      }
      // 退出登录
      else if (msg.type === 'logout') {
        onlineUsers.delete(userId);
        broadcast({
          type: 'userOffline',
          userId,
          username
        });
      }
    } catch (err) {
      console.error('消息处理错误:', err);
      ws.send(JSON.stringify({ type: 'error', msg: '消息处理失败' }));
    }
  });

  // 断开连接
  ws.on('close', () => {
    if (userId) {
      onlineUsers.delete(userId);
      broadcast({
        type: 'userOffline',
        userId,
        username
      });
    }
  });

  // 错误处理
  ws.on('error', (err) => {
    console.error('WebSocket错误:', err);
  });
});

// 广播消息给所有在线用户
function broadcast(msg) {
  const msgStr = JSON.stringify(msg);
  onlineUsers.forEach(({ ws }) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msgStr);
    }
  });
}

// -------------------------- 管理员后台接口（新增，不影响原有功能） --------------------------
// 管理员登录接口
app.post('/api/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    // 仅允许admin账号
    if (username !== 'admin') {
      return res.json({ code: 401, msg: '账号或密码错误' });
    }
    // 验证密码
    const isPwdValid = await bcrypt.compare(password, ADMIN_PASSWORD_HASH);
    if (!isPwdValid) {
      return res.json({ code: 401, msg: '账号或密码错误' });
    }
    // 生成JWT Token（有效期24小时）
    const token = jwt.sign({ username: 'admin' }, ADMIN_JWT_SECRET, { expiresIn: '24h' });
    // 记录登录日志
    await pool.execute(
      'INSERT INTO chat_admin_logs (admin_id, action, content, ip, create_time) VALUES (?, ?, ?, ?, ?)',
      [1, '管理员登录', `IP: ${req.ip}`, req.ip, Date.now()]
    );
    res.json({
      code: 200,
      msg: '登录成功',
      data: { token, expire: Date.now() + 24 * 60 * 60 * 1000 }
    });
  } catch (err) {
    console.error('管理员登录错误:', err);
    res.json({ code: 500, msg: '服务器错误' });
  }
});

// 管理员权限验证中间件
const verifyAdminToken = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    return res.json({ code: 401, msg: '未登录' });
  }
  try {
    jwt.verify(token, ADMIN_JWT_SECRET);
    next();
  } catch (err) {
    return res.json({ code: 401, msg: '登录已过期' });
  }
};

// 1. 用户仪表盘接口
app.get('/api/admin/user-dashboard', verifyAdminToken, async (req, res) => {
  try {
    const { keyword = '', page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    let sql = `SELECT id, username, real_ip, mute_chat, mute_private, create_time 
               FROM chat_users 
               WHERE 1=1`;
    const params = [];
    if (keyword) {
      sql += ' AND username LIKE ?';
      params.push(`%${keyword}%`);
    }
    sql += ' LIMIT ?, ?';
    params.push(offset, parseInt(limit));

    const [users] = await pool.execute(sql, params);
    const [totalRows] = await pool.execute(
      `SELECT COUNT(*) as total FROM chat_users WHERE 1=1 ${keyword ? ' AND username LIKE ?' : ''}`,
      keyword ? [`%${keyword}%`] : []
    );

    res.json({
      code: 200,
      msg: '成功',
      data: {
        list: users.map(u => ({
          ...u,
          create_time: new Date(u.create_time).toLocaleString()
        })),
        total: totalRows[0].total,
        page: parseInt(page),
        limit: parseInt(limit)
      }
    });
  } catch (err) {
    console.error('获取用户仪表盘错误:', err);
    res.json({ code: 500, msg: '服务器错误' });
  }
});

// 2. 聊天室管理接口
app.post('/api/admin/manage-room', verifyAdminToken, async (req, res) => {
  try {
    const { type, room_id, room_name } = req.body;
    switch (type) {
      case 'add':
        await pool.execute(
          'INSERT INTO chat_rooms (name, status, create_time) VALUES (?, 1, ?)',
          [room_name, Date.now()]
        );
        break;
      case 'delete':
        await pool.execute('DELETE FROM chat_rooms WHERE id = ?', [room_id]);
        break;
      case 'hide':
        await pool.execute('UPDATE chat_rooms SET status = 0 WHERE id = ?', [room_id]);
        break;
      case 'show':
        await pool.execute('UPDATE chat_rooms SET status = 1 WHERE id = ?', [room_id]);
        break;
      case 'rename':
        await pool.execute('UPDATE chat_rooms SET name = ? WHERE id = ?', [room_name, room_id]);
        break;
      default:
        return res.json({ code: 400, msg: '无效的操作类型' });
    }
    // 记录操作日志
    await pool.execute(
      'INSERT INTO chat_admin_logs (admin_id, action, content, ip, create_time) VALUES (?, ?, ?, ?, ?)',
      [1, `聊天室${type}`, `room_id:${room_id}, name:${room_name}`, req.ip, Date.now()]
    );
    res.json({ code: 200, msg: '操作成功' });
  } catch (err) {
    console.error('聊天室管理错误:', err);
    res.json({ code: 500, msg: '服务器错误' });
  }
});

// 3. 用户禁言管理接口
app.post('/api/admin/manage-user', verifyAdminToken, async (req, res) => {
  try {
    const { type, user_id } = req.body;
    let sql = '';
    let action = '';
    switch (type) {
      case 'mute_chat':
        sql = 'UPDATE chat_users SET mute_chat = 1 WHERE id = ?';
        action = '群聊禁言';
        break;
      case 'unmute_chat':
        sql = 'UPDATE chat_users SET mute_chat = 0 WHERE id = ?';
        action = '解除群聊禁言';
        break;
      case 'mute_private':
        sql = 'UPDATE chat_users SET mute_private = 1 WHERE id = ?';
        action = '私聊禁言';
        break;
      case 'unmute_private':
        sql = 'UPDATE chat_users SET mute_private = 0 WHERE id = ?';
        action = '解除私聊禁言';
        break;
      default:
        return res.json({ code: 400, msg: '无效的操作类型' });
    }
    await pool.execute(sql, [user_id]);
    // 记录操作日志
    await pool.execute(
      'INSERT INTO chat_admin_logs (admin_id, action, content, ip, create_time) VALUES (?, ?, ?, ?, ?)',
      [1, action, `user_id:${user_id}`, req.ip, Date.now()]
    );
    res.json({ code: 200, msg: '操作成功' });
  } catch (err) {
    console.error('用户管理错误:', err);
    res.json({ code: 500, msg: '服务器错误' });
  }
});

// 4. 获取聊天记录接口
app.get('/api/admin/chat-logs', verifyAdminToken, async (req, res) => {
  try {
    const { type, room_id, user1, user2, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    let sql = '';
    let params = [];

    if (type === 'room') {
      sql = `SELECT id, sender, content, is_admin, create_time 
             FROM chat_room_logs 
             WHERE room_id = ? 
             ORDER BY create_time DESC 
             LIMIT ?, ?`;
      params = [room_id, offset, parseInt(limit)];
    } else if (type === 'private') {
      sql = `SELECT id, sender, receiver, content, create_time 
             FROM chat_private_logs 
             WHERE (sender = ? AND receiver = ?) OR (sender = ? AND receiver = ?)
             ORDER BY create_time DESC 
             LIMIT ?, ?`;
      params = [user1, user2, user2, user1, offset, parseInt(limit)];
    } else {
      return res.json({ code: 400, msg: '无效的记录类型' });
    }

    const [logs] = await pool.execute(sql, params);
    res.json({
      code: 200,
      msg: '成功',
      data: {
        list: logs.map(log => ({
          ...log,
          create_time: new Date(log.create_time).toLocaleString()
        })),
        page: parseInt(page),
        limit: parseInt(limit)
      }
    });
  } catch (err) {
    console.error('获取聊天记录错误:', err);
    res.json({ code: 500, msg: '服务器错误' });
  }
});

// 5. 发送公告接口
app.post('/api/admin/send-notice', verifyAdminToken, async (req, res) => {
  try {
    const { content } = req.body;
    // 存储公告
    await pool.execute(
      'INSERT INTO chat_notices (content, create_time) VALUES (?, ?)',
      [content, Date.now()]
    );
    // 广播公告
    broadcast({ type: 'notice', content });
    // 记录日志
    await pool.execute(
      'INSERT INTO chat_admin_logs (admin_id, action, content, ip, create_time) VALUES (?, ?, ?, ?, ?)',
      [1, '发送公告', content, req.ip, Date.now()]
    );
    res.json({ code: 200, msg: '公告发送成功' });
  } catch (err) {
    console.error('发送公告错误:', err);
    res.json({ code: 500, msg: '服务器错误' });
  }
});

// 6. 发送管理员消息接口
app.post('/api/admin/send-admin-msg', verifyAdminToken, async (req, res) => {
  try {
    const { type, room_id, receiver, content } = req.body;
    const adminMsg = {
      type: type === 'room' ? 'adminRoomMsg' : 'adminPrivateMsg',
      sender: '管理员',
      content,
      isAdmin: true,
      time: Date.now()
    };

    if (type === 'room') {
      adminMsg.roomId = room_id;
      // 存储群聊管理员消息
      await pool.execute(
        'INSERT INTO chat_room_logs (room_id, sender, content, is_admin, create_time) VALUES (?, ?, ?, 1, ?)',
        [room_id, '管理员', content, Date.now()]
      );
      // 广播群聊管理员消息
      broadcast(adminMsg);
    } else if (type === 'private') {
      // 查找接收方
      const targetUser = Array.from(onlineUsers.entries()).find(([_, info]) => info.username === receiver);
      if (targetUser) {
        targetUser[1].ws.send(JSON.stringify(adminMsg));
      }
      // 存储私聊管理员消息
      await pool.execute(
        'INSERT INTO chat_private_logs (sender, receiver, content, is_admin, create_time) VALUES (?, ?, ?, 1, ?)',
        ['管理员', receiver, content, Date.now()]
      );
    }

    // 记录日志
    await pool.execute(
      'INSERT INTO chat_admin_logs (admin_id, action, content, ip, create_time) VALUES (?, ?, ?, ?, ?)',
      [1, `发送${type === 'room' ? '群聊' : '私聊'}管理员消息`, content, req.ip, Date.now()]
    );
    res.json({ code: 200, msg: '消息发送成功' });
  } catch (err) {
    console.error('发送管理员消息错误:', err);
    res.json({ code: 500, msg: '服务器错误' });
  }
});

// 7. 下载数据库备份接口
app.get('/api/admin/download-db', verifyAdminToken, async (req, res) => {
  try {
    const backupDir = path.join(__dirname, 'backups');
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    const filename = `chat_db_backup_${new Date().getTime()}.sql`;
    const backupPath = path.join(backupDir, filename);

    // 执行mysqldump备份（需确保系统安装了mysql客户端）
    const { exec } = require('child_process');
    const cmd = `mysqldump -h${dbConfig.host} -u${dbConfig.user} -p${dbConfig.password} ${dbConfig.database} > ${backupPath}`;
    
    exec(cmd, (err) => {
      if (err) {
        console.error('数据库备份失败:', err);
        return res.json({ code: 500, msg: '备份失败' });
      }
      // 下载文件
      res.download(backupPath, filename, (err) => {
        if (err) {
          console.error('下载失败:', err);
        }
        // 删除临时文件
        fs.unlinkSync(backupPath);
      });
    });

    // 记录日志
    await pool.execute(
      'INSERT INTO chat_admin_logs (admin_id, action, content, ip, create_time) VALUES (?, ?, ?, ?, ?)',
      [1, '下载数据库备份', filename, req.ip, Date.now()]
    );
  } catch (err) {
    console.error('下载数据库错误:', err);
    res.json({ code: 500, msg: '服务器错误' });
  }
});

// -------------------------- 启动服务 --------------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`服务启动成功，端口：${PORT}`);
  console.log(`前端访问：http://localhost:${PORT}`);
  console.log(`管理员后台：http://localhost:${PORT}/admin.html`);
});
