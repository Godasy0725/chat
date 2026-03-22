const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const expressWs = require('express-ws');
const fs = require('fs');
const path = require('path');

// 初始化应用
const app = express();
const server = http.createServer(app);
expressWs(app, server);

// 中间件
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// 数据库配置
const dbConfig = {
  host: 'localhost',
  user: 'root',
  password: 'root',
  database: 'chat_system',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
};

// 创建数据库连接池
const pool = mysql.createPool(dbConfig);

// 全局变量
const wss = new WebSocket.Server({ server });
const clients = new Map(); // 客户端映射: userId -> ws连接
const adminClients = new Set(); // 管理员WS连接

// -------------------------- 原有聊天功能适配 --------------------------
// 1. 用户登录（记录真实IP）
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const realIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    
    // 查询用户
    const [users] = await pool.execute(
      'SELECT id, username, password FROM chat_users WHERE username = ?',
      [username]
    );
    
    if (users.length === 0) {
      return res.json({ code: 401, msg: '账号或密码错误' });
    }
    
    const user = users[0];
    // 验证密码（如果是明文存储，替换为password === user.password）
    const isPwdValid = await bcrypt.compare(password, user.password);
    if (!isPwdValid) {
      return res.json({ code: 401, msg: '账号或密码错误' });
    }
    
    // 更新用户真实IP
    await pool.execute(
      'UPDATE chat_users SET real_ip = ? WHERE id = ?',
      [realIp, user.id]
    );
    
    // 生成token
    const token = uuidv4();
    res.json({
      code: 200,
      msg: '登录成功',
      data: {
        userId: user.id,
        username: user.username,
        token
      }
    });
  } catch (err) {
    console.error('登录错误:', err);
    res.json({ code: 500, msg: '服务器内部错误' });
  }
});

// 2. 检查用户禁言状态
async function checkUserMute(userId, type) {
  const [users] = await pool.execute(
    `SELECT ${type === 'chat' ? 'mute_chat' : 'mute_private'} as mute FROM chat_users WHERE id = ?`,
    [userId]
  );
  return users.length > 0 && users[0].mute === 1;
}

// 3. 群聊消息发送（增加禁言校验）
app.ws('/ws/room/:roomId', async (ws, req) => {
  const { roomId } = req.params;
  let userId = null;
  let username = null;

  // 验证用户身份
  ws.on('message', async (msg) => {
    try {
      const data = JSON.parse(msg);
      
      // 身份验证
      if (data.type === 'auth') {
        userId = data.userId;
        username = data.username;
        clients.set(userId, ws);
        return;
      }
      
      // 消息发送（禁言校验）
      if (data.type === 'room_msg') {
        const isMuted = await checkUserMute(userId, 'chat');
        if (isMuted) {
          ws.send(JSON.stringify({
            type: 'error',
            msg: '你已被禁言，无法发送群聊消息'
          }));
          return;
        }
        
        // 存储消息
        await pool.execute(
          'INSERT INTO chat_room_logs (room_id, sender_id, sender, content, create_time) VALUES (?, ?, ?, ?, ?)',
          [roomId, userId, username, data.content, Date.now()]
        );
        
        // 广播消息
        wss.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
              type: 'room_msg',
              roomId,
              sender: username,
              content: data.content,
              time: Date.now()
            }));
          }
        });
      }
    } catch (err) {
      console.error('群聊WS错误:', err);
    }
  });

  // 断开连接
  ws.on('close', () => {
    if (userId) clients.delete(userId);
  });
});

// 4. 私聊消息发送（增加禁言校验）
app.ws('/ws/private', async (ws, req) => {
  let userId = null;
  let username = null;

  ws.on('message', async (msg) => {
    try {
      const data = JSON.parse(msg);
      
      if (data.type === 'auth') {
        userId = data.userId;
        username = data.username;
        clients.set(userId, ws);
        return;
      }
      
      if (data.type === 'private_msg') {
        const { receiverId, receiver, content } = data;
        
        // 检查发送方禁言
        const isMuted = await checkUserMute(userId, 'private');
        if (isMuted) {
          ws.send(JSON.stringify({
            type: 'error',
            msg: '你已被禁言，无法发送私聊消息'
          }));
          return;
        }
        
        // 存储私聊记录
        await pool.execute(
          'INSERT INTO chat_private_logs (sender_id, sender, receiver_id, receiver, content, create_time) VALUES (?, ?, ?, ?, ?, ?)',
          [userId, username, receiverId, receiver, content, Date.now()]
        );
        
        // 发送给接收方
        const receiverWs = clients.get(receiverId);
        if (receiverWs && receiverWs.readyState === WebSocket.OPEN) {
          receiverWs.send(JSON.stringify({
            type: 'private_msg',
            sender: username,
            content,
            time: Date.now()
          }));
        }
        
        // 发送回执给发送方
        ws.send(JSON.stringify({
          type: 'private_msg',
          sender: username,
          receiver,
          content,
          time: Date.now(),
          status: 'success'
        }));
      }
    } catch (err) {
      console.error('私聊WS错误:', err);
    }
  });

  ws.on('close', () => {
    if (userId) clients.delete(userId);
  });
});

// -------------------------- 管理员功能适配 --------------------------
// 1. 管理员WS连接（接收管理员消息推送）
app.ws('/ws/admin', (ws) => {
  adminClients.add(ws);
  
  // 管理员发送消息
  ws.on('message', async (msg) => {
    try {
      const data = JSON.parse(msg);
      
      // 管理员群聊消息
      if (data.type === 'admin_room_msg') {
        const { roomId, content } = data;
        // 广播给所有在线用户
        wss.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
              type: 'admin_room_msg',
              roomId,
              sender: '管理员',
              content,
              isAdmin: true,
              time: Date.now()
            }));
          }
        });
      }
      
      // 管理员私聊消息
      if (data.type === 'admin_private_msg') {
        const { receiverId, content } = data;
        const receiverWs = clients.get(receiverId);
        if (receiverWs && receiverWs.readyState === WebSocket.OPEN) {
          receiverWs.send(JSON.stringify({
            type: 'admin_private_msg',
            sender: '管理员',
            content,
            isAdmin: true,
            time: Date.now()
          }));
        }
      }
      
      // 系统公告
      if (data.type === 'system_notice') {
        const { content } = data;
        wss.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
              type: 'system_notice',
              content,
              time: Date.now()
            }));
          }
        });
      }
    } catch (err) {
      console.error('管理员WS错误:', err);
    }
  });
  
  ws.on('close', () => {
    adminClients.delete(ws);
  });
});

// 2. 管理员API代理（对接PHP后台）
app.post('/api/admin/proxy', async (req, res) => {
  try {
    const { action, data } = req.body;
    
    // 管理员发送公告
    if (action === 'send_notice') {
      adminClients.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'system_notice',
            content: data.content
          }));
        }
      });
      return res.json({ code: 200, msg: '公告推送成功' });
    }
    
    // 管理员发送群聊消息
    if (action === 'send_admin_room_msg') {
      adminClients.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'admin_room_msg',
            roomId: data.roomId,
            content: data.content
          }));
        }
      });
      return res.json({ code: 200, msg: '管理员消息推送成功' });
    }
    
    // 管理员发送私聊消息
    if (action === 'send_admin_private_msg') {
      adminClients.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'admin_private_msg',
            receiverId: data.receiverId,
            content: data.content
          }));
        }
      });
      return res.json({ code: 200, msg: '管理员私聊消息推送成功' });
    }
    
    res.json({ code: 400, msg: '无效的操作类型' });
  } catch (err) {
    console.error('管理员代理错误:', err);
    res.json({ code: 500, msg: '服务器内部错误' });
  }
});

// 3. 获取聊天室列表（供管理员后台调用）
app.get('/api/admin/rooms', async (req, res) => {
  try {
    const [rooms] = await pool.execute(
      'SELECT id, name, status, create_time FROM chat_rooms ORDER BY create_time DESC'
    );
    res.json({
      code: 200,
      data: { list: rooms, total: rooms.length }
    });
  } catch (err) {
    console.error('获取聊天室列表错误:', err);
    res.json({ code: 500, msg: '服务器内部错误' });
  }
});

// 4. 获取用户列表（供管理员后台调用）
app.get('/api/admin/users', async (req, res) => {
  try {
    const { keyword = '', page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    
    let query = 'SELECT id, username, real_ip, mute_chat, mute_private, create_time FROM chat_users';
    let params = [];
    
    if (keyword) {
      query += ' WHERE username LIKE ?';
      params.push(`%${keyword}%`);
    }
    
    query += ' LIMIT ?, ?';
    params.push(offset, parseInt(limit));
    
    const [users] = await pool.execute(query, params);
    
    // 获取总数
    const [countRes] = await pool.execute(
      keyword ? 'SELECT COUNT(*) as total FROM chat_users WHERE username LIKE ?' : 'SELECT COUNT(*) as total FROM chat_users',
      keyword ? [`%${keyword}%`] : []
    );
    
    res.json({
      code: 200,
      data: {
        list: users,
        total: countRes[0].total,
        page: parseInt(page),
        limit: parseInt(limit)
      }
    });
  } catch (err) {
    console.error('获取用户列表错误:', err);
    res.json({ code: 500, msg: '服务器内部错误' });
  }
});

// -------------------------- 启动服务 --------------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`服务器运行在 http://localhost:${PORT}`);
  console.log(`管理员WS连接: ws://localhost:${PORT}/ws/admin`);
  console.log(`群聊WS连接: ws://localhost:${PORT}/ws/room/{roomId}`);
  console.log(`私聊WS连接: ws://localhost:${PORT}/ws/private`);
});

// 错误处理
process.on('uncaughtException', (err) => {
  console.error('未捕获的异常:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('未处理的Promise拒绝:', promise, '原因:', reason);
});
