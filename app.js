const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const http = require('http');
const WebSocket = require('ws');

// 初始化Express
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// 配置
app.use(cors()); // 允许跨域
app.use(express.json()); // 解析JSON请求体
const PORT = process.env.PORT || 3000;

// 初始化SQLite3数据库
const db = new sqlite3.Database('./database.db', (err) => {
  if (err) console.error('数据库连接失败:', err.message);
  else console.log('成功连接SQLite3数据库');
});

// 创建用户表（id: 随机唯一ID, username: 用户名, password: 加密密码）
db.run(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY NOT NULL UNIQUE,
    username TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL
  )
`);

// 创建聊天记录表
db.run(`
  CREATE TABLE IF
