require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const http = require('http');

// 初始化Express应用
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// 配置
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

// Supabase客户端初始化
const supabaseUrl = 'https://eoibwsfebokjbokmwikd.supabase.co';
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVvaWJ3c2ZlYm9ramJva213aWtkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwNjI4NDMsImV4cCI6MjA4OTYzODg0M30.jZ58cWjIJCzUi-M780E45plLRpC4K4j4Or3RBVJAp1g';
const supabaseServiceKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVvaWJ3c2ZlYm9ramJva213aWtkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NDA2Mjg0MywiZXhwIjoyMDg5NjM4ODQzfQ.qpeahusRrwy8nYUWykP-xem-rT1EAJoZnJvbSVz1uwA';

// 两个客户端：匿名（前端用）和服务角色（后端管理用）
const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);
const supabase = createClient(supabaseUrl, supabaseAnonKey);

// 中间件
app.use(cors({
  origin: ['https://lmx.is-best.net', 'http://localhost:5500'], // 允许的前端域名
  credentials: true
}));
app.use(express.json());

// 生成随机唯一用户ID（6位数字+字母组合）
async function generateUniqueUserId() {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let userId;
  
  do {
    userId = '';
    for (let i = 0; i < 6; i++) {
      userId += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    // 检查ID是否已存在
    const { data, error } = await supabaseAdmin
      .from('users')
      .select('user_id')
      .eq('user_id', userId)
      .single();
      
    if (!data) break; // ID不存在，可用
  } while (true);
  
  return userId;
}

// 数据库初始化（首次运行创建表）
async function initDatabase() {
  // 创建用户表
  const createUsersTable = await supabaseAdmin.rpc('exec', {
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        username VARCHAR(50) UNIQUE NOT NULL,
        password VARCHAR(100) NOT NULL,
        user_id VARCHAR(6) UNIQUE NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `
  });

  // 创建消息表
  const createMessagesTable = await supabaseAdmin.rpc('exec', {
    sql: `
      CREATE TABLE IF NOT EXISTS messages (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id VARCHAR(6) NOT NULL,
        username VARCHAR(50) NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `
  });

  if (createUsersTable.error) console.error('创建用户表失败:', createUsersTable.error);
  if (createMessagesTable.error) console.error('创建消息表失败:', createMessagesTable.error);
}

// 初始化数据库
initDatabase();

// 注册接口
app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    // 验证输入
    if (!username || !password) {
      return res.status(400).json({ error: '用户名和密码不能为空' });
    }
    
    // 检查用户名是否已存在
    const { data: existingUser } = await supabaseAdmin
      .from('users')
      .select('username')
      .eq('username', username)
      .single();
      
    if (existingUser) {
      return res.status(400).json({ error: '用户名已存在' });
    }
    
    // 生成随机唯一ID
    const userId = await generateUniqueUserId();
    
    // 加密密码
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);
    
    // 保存用户
    const { data, error } = await supabaseAdmin
      .from('users')
      .insert([
        { username, password: hashedPassword, user_id: userId }
      ])
      .select();
      
    if (error) throw error;
    
    res.status(201).json({ 
      success: true, 
      message: '注册成功',
      user: {
        username: data[0].username,
        user_id: data[0].user_id
      }
    });
  } catch (error) {
    console.error('注册失败:', error);
    res.status(500).json({ error: '服务器错误，请重试' });
  }
});

// 登录接口
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    // 验证输入
    if (!username || !password) {
      return res.status(400).json({ error: '用户名和密码不能为空' });
    }
    
    // 查询用户
    const { data: user, error } = await supabaseAdmin
      .from('users')
      .select('*')
      .eq('username', username)
      .single();
      
    if (error || !user) {
      return res.status(400).json({ error: '用户名或密码错误' });
    }
    
    // 验证密码
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(400).json({ error: '用户名或密码错误' });
    }
    
    // 生成JWT token
    const token = jwt.sign(
      { id: user.id, user_id: user.user_id, username: user.username },
      JWT_SECRET,
      { expiresIn: '24h' }
    );
    
    res.json({
      success: true,
      token,
      user: {
        username: user.username,
        user_id: user.user_id
      }
    });
  } catch (error) {
    console.error('登录失败:', error);
    res.status(500).json({ error: '服务器错误，请重试' });
  }
});

// 获取历史消息
app.get('/api/messages', async (req, res) => {
  try {
    const { data: messages, error } = await supabase
      .from('messages')
      .select('*')
      .order('created_at', { ascending: true })
      .limit(100); // 限制获取最近100条消息
      
    if (error) throw error;
    
    res.json({ messages });
  } catch (error) {
    console.error('获取消息失败:', error);
    res.status(500).json({ error: '获取消息失败' });
  }
});

// 验证token中间件
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) return res.status(401).json({ error: '未授权' });
  
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'token无效或已过期' });
    req.user = user;
    next();
  });
}

// 发送消息（需要认证）
app.post('/api/messages', authenticateToken, async (req, res) => {
  try {
    const { content } = req.body;
    const { user_id, username } = req.user;
    
    if (!content) {
      return res.status(400).json({ error: '消息内容不能为空' });
    }
    
    // 保存消息
    const { data, error } = await supabaseAdmin
      .from('messages')
      .insert([
        { user_id, username, content }
      ])
      .select();
      
    if (error) throw error;
    
    // 广播消息到所有WebSocket客户端
    const message = JSON.stringify({
      type: 'new_message',
      data: data[0]
    });
    
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
    
    res.status(201).json({ success: true, message: data[0] });
  } catch (error) {
    console.error('发送消息失败:', error);
    res.status(500).json({ error: '发送消息失败' });
  }
});

// 健康检查接口
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// WebSocket连接处理
wss.on('connection', (ws) => {
  console.log('新的WebSocket连接');
  
  ws.on('close', () => {
    console.log('WebSocket连接关闭');
  });
  
  ws.on('error', (error) => {
    console.error('WebSocket错误:', error);
  });
});

// 启动服务器
server.listen(PORT, () => {
  console.log(`服务器运行在端口 ${PORT}`);
  console.log(`WebSocket服务器已启动`);
});
