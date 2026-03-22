const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const bodyParser = require('body-parser');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

// 初始化Express
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// 中间件配置
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

// 数据库连接配置（保持原有配置，仅扩展）
const dbConfig = {
  host: 'localhost',
  user: 'root',
  password: 'root',
  database: 'chat_system'
};

// 全局变量
let onlineUsers = new Map(); // 在线用户: { userId: { ws, username, ip } }
const ADMIN_TOKEN_EXPIRE = 86400 * 7; // 管理员Token有效期7天

// -------------------------- 原有聊天功能（完全保留） --------------------------
// 1. 用户登录（补充IP记录）
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const realIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    
    const connection = await mysql.createConnection(dbConfig);
    const [rows] = await connection.execute(
      'SELECT id, username, password FROM chat_users WHERE username = ?',
      [username]
    );
    connection.end();

    if (rows.length === 0) {
      return res.json({ code: 401, msg: '用户名或密码错误' });
    }

    const user = rows[0];
    if (!bcrypt.compareSync(password, user.password)) {
      return res.json({ code: 401, msg: '用户名或密码错误' });
    }

    // 补充：更新用户真实IP
    const updateConn = await mysql.createConnection(dbConfig);
    await updateConn.execute(
      'UPDATE chat_users SET real_ip = ? WHERE id = ?',
      [realIp, user.id]
    );
    updateConn.end();

    res.json({
      code: 200,
      msg: '登录成功',
      data: {
        userId: user.id,
        username: user.username,
        token: uuidv4()
      }
    });
  } catch (err) {
    console.error('登录错误:', err);
    res.json({ code: 500, msg: '服务器错误' });
  }
});

// 2. WebSocket聊天核心（补充禁言校验、管理员消息处理）
wss.on('connection', (ws, req) => {
  let userId = '';
  let username = '';
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  // 验证用户连接
  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);
      
      // 连接认证
      if (msg.type === 'auth') {
        userId = msg.userId;
        username = msg.username;
        onlineUsers.set(userId, { ws, username, ip });
        ws.send(JSON.stringify({ type: 'auth_ok', msg: '连接成功' }));
        return;
      }

      // 校验禁言状态
      const connection = await mysql.createConnection(dbConfig);
      const [userRows] = await connection.execute(
        'SELECT mute_chat, mute_private FROM chat_users WHERE id = ?',
        [userId]
      );
      connection.end();

      const user = userRows[0];
      if (!user) return;

      // 群聊消息：校验群聊禁言
      if (msg.type === 'room_msg') {
        if (user.mute_chat === 1) {
          ws.send(JSON.stringify({ type: 'error', msg: '你已被禁言，无法发送群聊消息' }));
          return;
        }
        // 保存群聊记录
        const saveConn = await mysql.createConnection(dbConfig);
        await saveConn.execute(
          'INSERT INTO chat_room_logs (room_id, sender, content, create_time) VALUES (?, ?, ?, ?)',
          [msg.roomId, username, msg.content, Date.now()]
        );
        saveConn.end();
        // 广播群聊消息
        onlineUsers.forEach((client) => {
          if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(JSON.stringify({
              type: 'room_msg',
              roomId: msg.roomId,
              sender: username,
              content: msg.content,
              time: new Date().toLocaleTimeString()
            }));
          }
        });
      }

      // 私聊消息：校验私聊禁言
      if (msg.type === 'private_msg') {
        if (user.mute_private === 1) {
          ws.send(JSON.stringify({ type: 'error', msg: '你已被禁言，无法发送私聊消息' }));
          return;
        }
        // 查找接收方
        const [receiverRows] = await connection.execute(
          'SELECT id FROM chat_users WHERE username = ?',
          [msg.receiver]
        );
        const receiverId = receiverRows[0]?.id;
        if (!receiverId) {
          ws.send(JSON.stringify({ type: 'error', msg: '接收用户不存在' }));
          return;
        }
        // 保存私聊记录
        const saveConn = await mysql.createConnection(dbConfig);
        await saveConn.execute(
          'INSERT INTO chat_private_logs (sender, receiver, content, create_time) VALUES (?, ?, ?, ?)',
          [username, msg.receiver, msg.content, Date.now()]
        );
        saveConn.end();
        // 发送私聊消息
        const receiverClient = Array.from(onlineUsers.entries()).find(([id, client]) => id === receiverId);
        if (receiverClient && receiverClient[1].ws.readyState === WebSocket.OPEN) {
          receiverClient[1].ws.send(JSON.stringify({
            type: 'private_msg',
            sender: username,
            receiver: msg.receiver,
            content: msg.content,
            time: new Date().toLocaleTimeString()
          }));
        }
        // 回显给自己
        ws.send(JSON.stringify({
          type: 'private_msg',
          sender: username,
          receiver: msg.receiver,
          content: msg.content,
          time: new Date().toLocaleTimeString()
        }));
      }
    } catch (err) {
      console.error('WS消息处理错误:', err);
      ws.send(JSON.stringify({ type: 'error', msg: '消息发送失败' }));
    }
  });

  // 断开连接
  ws.on('close', () => {
    onlineUsers.delete(userId);
    console.log(`用户 ${username} 断开连接`);
  });

  // 错误处理
  ws.on('error', (err) => {
    console.error('WS错误:', err);
  });
});

// 3. 获取聊天室列表（补充状态字段）
app.get('/api/rooms', async (req, res) => {
  try {
    const connection = await mysql.createConnection(dbConfig);
    const [rows] = await connection.execute(
      'SELECT id, name, status FROM chat_rooms WHERE status = 1 ORDER BY create_time DESC'
    );
    connection.end();
    res.json({ code: 200, data: rows });
  } catch (err) {
    console.error('获取聊天室错误:', err);
    res.json({ code: 500, msg: '服务器错误' });
  }
});

// -------------------------- 新增管理员适配接口（不影响原有功能） --------------------------
// 1. 管理员登录验证
app.post('/admin_api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    // 仅允许admin账号
    if (username !== 'admin') {
      return res.json({ code: 401, msg: '账号或密码错误' });
    }

    // 验证密码（Lmx%%112233）
    const correctPwd = 'Lmx%%112233';
    if (password !== correctPwd) {
      return res.json({ code: 401, msg: '账号或密码错误' });
    }

    // 生成管理员Token
    const token = uuidv4();
    const expireTime = Date.now() + ADMIN_TOKEN_EXPIRE * 1000;

    // 保存Token到数据库
    const connection = await mysql.createConnection(dbConfig);
    await connection.execute(
      'UPDATE chat_admin SET token = ?, token_expire = ? WHERE username = ?',
      [token, expireTime, 'admin']
    );
    connection.end();

    // 记录操作日志
    await saveAdminLog('登录成功', `IP: ${ip}`, 1);

    res.json({
      code: 200,
      msg: '登录成功',
      data: { token, expire: expireTime }
    });
  } catch (err) {
    console.error('管理员登录错误:', err);
    res.json({ code: 500, msg: '服务器错误' });
  }
});

// 2. 管理员发送公告（推送至所有在线用户）
app.post('/admin_api/sendNotice', async (req, res) => {
  try {
    const { token, content } = req.body;
    // 验证管理员Token
    const isValid = await checkAdminToken(token);
    if (!isValid) {
      return res.json({ code: 401, msg: '登录已过期' });
    }

    // 推送公告
    onlineUsers.forEach((client) => {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(JSON.stringify({
          type: 'admin_notice',
          content,
          time: new Date().toLocaleTimeString()
        }));
      }
    });

    // 保存公告记录
    const connection = await mysql.createConnection(dbConfig);
    await connection.execute(
      'INSERT INTO chat_notices (content, create_time) VALUES (?, ?)',
      [content, Date.now()]
    );
    connection.end();

    // 记录日志
    await saveAdminLog('发送公告', `内容: ${content}`, 1);

    res.json({ code: 200, msg: '公告发送成功' });
  } catch (err) {
    console.error('发送公告错误:', err);
    res.json({ code: 500, msg: '服务器错误' });
  }
});

// 3. 管理员发送带标识的消息
app.post('/admin_api/sendAdminMsg', async (req, res) => {
  try {
    const { token, type, target, content } = req.body;
    // 验证管理员Token
    const isValid = await checkAdminToken(token);
    if (!isValid) {
      return res.json({ code: 401, msg: '登录已过期' });
    }

    // 构造管理员消息
    const adminMsg = {
      type: type === 'room' ? 'admin_room_msg' : 'admin_private_msg',
      sender: '【管理员】',
      content,
      time: new Date().toLocaleTimeString(),
      isAdmin: true
    };

    // 群聊管理员消息
    if (type === 'room') {
      adminMsg.roomId = target;
      // 广播到指定聊天室（简化版：推送给所有在线用户，实际可过滤聊天室）
      onlineUsers.forEach((client) => {
        if (client.ws.readyState === WebSocket.OPEN) {
          client.ws.send(JSON.stringify(adminMsg));
        }
      });
      // 保存记录
      const conn = await mysql.createConnection(dbConfig);
      await conn.execute(
        'INSERT INTO chat_room_logs (room_id, sender, content, is_admin, create_time) VALUES (?, ?, ?, 1, ?)',
        [target, '【管理员】', content, Date.now()]
      );
      conn.end();
    }

    // 私聊管理员消息
    if (type === 'private') {
      adminMsg.receiver = target;
      // 查找接收方
      const conn = await mysql.createConnection(dbConfig);
      const [rows] = await conn.execute(
        'SELECT id FROM chat_users WHERE username = ?',
        [target]
      );
      conn.end();
      const receiverId = rows[0]?.id;
      if (!receiverId) {
        return res.json({ code: 400, msg: '接收用户不存在' });
      }
      // 发送给指定用户
      const receiverClient = Array.from(onlineUsers.entries()).find(([id]) => id === receiverId);
      if (receiverClient && receiverClient[1].ws.readyState === WebSocket.OPEN) {
        receiverClient[1].ws.send(JSON.stringify(adminMsg));
      }
      // 保存记录
      const saveConn = await mysql.createConnection(dbConfig);
      await saveConn.execute(
        'INSERT INTO chat_private_logs (sender, receiver, content, is_admin, create_time) VALUES (?, ?, ?, 1, ?)',
        ['【管理员】', target, content, Date.now()]
      );
      saveConn.end();
    }

    // 记录日志
    await saveAdminLog(`发送${type === 'room' ? '群聊' : '私聊'}管理员消息`, `目标: ${target}, 内容: ${content}`, 1);

    res.json({ code: 200, msg: '管理员消息发送成功' });
  } catch (err) {
    console.error('发送管理员消息错误:', err);
    res.json({ code: 500, msg: '服务器错误' });
  }
});

// 4. 管理员用户管理（禁言/解除禁言）
app.post('/admin_api/manageUser', async (req, res) => {
  try {
    const { token, type, userId } = req.body;
    // 验证管理员Token
    const isValid = await checkAdminToken(token);
    if (!isValid) {
      return res.json({ code: 401, msg: '登录已过期' });
    }

    const connection = await mysql.createConnection(dbConfig);
    let sql = '';
    let action = '';
    switch (type) {
      case 'mute_chat':
        sql = 'UPDATE chat_users SET mute_chat = 1 WHERE id = ?';
        action = '禁言群聊';
        break;
      case 'unmute_chat':
        sql = 'UPDATE chat_users SET mute_chat = 0 WHERE id = ?';
        action = '解除群聊禁言';
        break;
      case 'mute_private':
        sql = 'UPDATE chat_users SET mute_private = 1 WHERE id = ?';
        action = '禁言私聊';
        break;
      case 'unmute_private':
        sql = 'UPDATE chat_users SET mute_private = 0 WHERE id = ?';
        action = '解除私聊禁言';
        break;
      default:
        return res.json({ code: 400, msg: '无效的操作类型' });
    }

    await connection.execute(sql, [userId]);
    connection.end();

    // 记录日志
    await saveAdminLog(action, `用户ID: ${userId}`, 1);

    res.json({ code: 200, msg: `${action}成功` });
  } catch (err) {
    console.error('用户管理错误:', err);
    res.json({ code: 500, msg: '服务器错误' });
  }
});

// 5. 管理员聊天室管理
app.post('/admin_api/manageRoom', async (req, res) => {
  try {
    const { token, type, roomId, roomName } = req.body;
    // 验证管理员Token
    const isValid = await checkAdminToken(token);
    if (!isValid) {
      return res.json({ code: 401, msg: '登录已过期' });
    }

    const connection = await mysql.createConnection(dbConfig);
    let sql = '';
    let action = '';
    switch (type) {
      case 'add':
        sql = 'INSERT INTO chat_rooms (name, status, create_time) VALUES (?, 1, ?)';
        await connection.execute(sql, [roomName, Date.now()]);
        action = '新增聊天室';
        break;
      case 'delete':
        sql = 'DELETE FROM chat_rooms WHERE id = ?';
        await connection.execute(sql, [roomId]);
        action = '删除聊天室';
        break;
      case 'hide':
        sql = 'UPDATE chat_rooms SET status = 0 WHERE id = ?';
        await connection.execute(sql, [roomId]);
        action = '隐藏聊天室';
        break;
      case 'show':
        sql = 'UPDATE chat_rooms SET status = 1 WHERE id = ?';
        await connection.execute(sql, [roomId]);
        action = '显示聊天室';
        break;
      case 'rename':
        sql = 'UPDATE chat_rooms SET name = ? WHERE id = ?';
        await connection.execute(sql, [roomName, roomId]);
        action = '重命名聊天室';
        break;
      default:
        return res.json({ code: 400, msg: '无效的操作类型' });
    }
    connection.end();

    // 记录日志
    await saveAdminLog(action, `聊天室ID: ${roomId || ''}, 名称: ${roomName || ''}`, 1);

    res.json({ code: 200, msg: `${action}成功` });
  } catch (err) {
    console.error('聊天室管理错误:', err);
    res.json({ code: 500, msg: '服务器错误' });
  }
});

// 6. 管理员下载数据库备份
app.get('/admin_api/downloadDB', async (req, res) => {
  try {
    const { token } = req.query;
    // 验证管理员Token
    const isValid = await checkAdminToken(token);
    if (!isValid) {
      return res.json({ code: 401, msg: '登录已过期' });
    }

    // 生成备份文件名
    const filename = `chat_backup_${Date.now()}.sql`;
    const backupPath = path.join(__dirname, 'backup', filename);
    
    // 创建备份目录
    if (!fs.existsSync(path.join(__dirname, 'backup'))) {
      fs.mkdirSync(path.join(__dirname, 'backup'), { recursive: true });
    }

    // 执行mysqldump（需确保系统安装mysql客户端）
    const { exec } = require('child_process');
    const cmd = `mysqldump -h${dbConfig.host} -u${dbConfig.user} -p${dbConfig.password} ${dbConfig.database} > ${backupPath}`;
    exec(cmd, (err) => {
      if (err) {
        console.error('备份失败:', err);
        return res.json({ code: 500, msg: '数据库备份失败' });
      }

      // 下载文件
      res.download(backupPath, filename, (err) => {
        if (err) console.error('下载失败:', err);
        // 删除临时文件
        fs.unlinkSync(backupPath);
      });
    });

    // 记录日志
    await saveAdminLog('下载数据库备份', `文件名: ${filename}`, 1);
  } catch (err) {
    console.error('下载数据库错误:', err);
    res.json({ code: 500, msg: '服务器错误' });
  }
});

// 7. 管理员获取聊天记录
app.get('/admin_api/getChatLogs', async (req, res) => {
  try {
    const { token, type, roomId, user1, user2, page = 1, limit = 20 } = req.query;
    // 验证管理员Token
    const isValid = await checkAdminToken(token);
    if (!isValid) {
      return res.json({ code: 401, msg: '登录已过期' });
    }

    const connection = await mysql.createConnection(dbConfig);
    let [rows] = [];
    const offset = (page - 1) * limit;

    if (type === 'room') {
      [rows] = await connection.execute(
        'SELECT * FROM chat_room_logs WHERE room_id = ? ORDER BY create_time DESC LIMIT ? OFFSET ?',
        [roomId, limit, offset]
      );
    } else if (type === 'private') {
      [rows] = await connection.execute(
        'SELECT * FROM chat_private_logs WHERE (sender = ? AND receiver = ?) OR (sender = ? AND receiver = ?) ORDER BY create_time DESC LIMIT ? OFFSET ?',
        [user1, user2, user2, user1, limit, offset]
      );
    } else {
      return res.json({ code: 400, msg: '无效的记录类型' });
    }

    connection.end();

    // 格式化时间
    const logs = rows.map(row => ({
      ...row,
      create_time: new Date(row.create_time).toLocaleString()
    }));

    // 记录日志
    await saveAdminLog(`查看${type === 'room' ? '群聊' : '私聊'}记录`, type === 'room' ? `聊天室ID: ${roomId}` : `用户1: ${user1}, 用户2: ${user2}`, 1);

    res.json({ code: 200, data: { list: logs, page, limit } });
  } catch (err) {
    console.error('获取聊天记录错误:', err);
    res.json({ code: 500, msg: '服务器错误' });
  }
});

// 8. 管理员获取用户列表（含IP）
app.get('/admin_api/getUserDashboard', async (req, res) => {
  try {
    const { token, keyword = '', page = 1, limit = 20 } = req.query;
    // 验证管理员Token
    const isValid = await checkAdminToken(token);
    if (!isValid) {
      return res.json({ code: 401, msg: '登录已过期' });
    }

    const connection = await mysql.createConnection(dbConfig);
    const offset = (page - 1) * limit;
    let [rows] = [];
    let [totalRows] = [];

    if (keyword) {
      [rows] = await connection.execute(
        'SELECT id, username, real_ip, mute_chat, mute_private, create_time FROM chat_users WHERE username LIKE ? LIMIT ? OFFSET ?',
        [`%${keyword}%`, limit, offset]
      );
      [totalRows] = await connection.execute(
        'SELECT COUNT(*) as total FROM chat_users WHERE username LIKE ?',
        [`%${keyword}%`]
      );
    } else {
      [rows] = await connection.execute(
        'SELECT id, username, real_ip, mute_chat, mute_private, create_time FROM chat_users LIMIT ? OFFSET ?',
        [limit, offset]
      );
      [totalRows] = await connection.execute('SELECT COUNT(*) as total FROM chat_users');
    }

    connection.end();

    // 格式化数据
    const users = rows.map(user => ({
      ...user,
      create_time: new Date(user.create_time).toLocaleString()
    }));

    // 记录日志
    await saveAdminLog('查看用户仪表盘', `关键词: ${keyword}, 页码: ${page}`, 1);

    res.json({
      code: 200,
      data: {
        list: users,
        total: totalRows[0].total,
        page,
        limit
      }
    });
  } catch (err) {
    console.error('获取用户仪表盘错误:', err);
    res.json({ code: 500, msg: '服务器错误' });
  }
});

// -------------------------- 辅助函数 --------------------------
// 验证管理员Token
async function checkAdminToken(token) {
  const connection = await mysql.createConnection(dbConfig);
  const [rows] = await connection.execute(
    'SELECT id FROM chat_admin WHERE token = ? AND token_expire > ?',
    [token, Date.now()]
  );
  connection.end();
  return rows.length > 0;
}

// 保存管理员操作日志
async function saveAdminLog(action, content, adminId) {
  try {
    const connection = await mysql.createConnection(dbConfig);
    await connection.execute(
      'INSERT INTO chat_admin_logs (admin_id, action, content, ip, create_time) VALUES (?, ?, ?, ?, ?)',
      [adminId, action, content, '', Date.now()]
    );
    connection.end();
  } catch (err) {
    console.error('保存日志错误:', err);
  }
}

// 启动服务器
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`服务器运行在 http://localhost:${PORT}`);
});
