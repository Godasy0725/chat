-- 管理员表
CREATE TABLE `chat_admin` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `username` varchar(50) NOT NULL COMMENT '管理员账号',
  `password` varchar(255) NOT NULL COMMENT 'bcrypt加密密码',
  `token` varchar(255) DEFAULT NULL COMMENT '登录令牌',
  `token_expire` int(11) DEFAULT NULL COMMENT '令牌过期时间',
  `allow_ips` text COMMENT '允许访问的IP列表',
  `create_time` int(11) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `username` (`username`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 初始化管理员（密码：Lmx%%112233）
INSERT INTO `chat_admin` (`username`, `password`, `allow_ips`, `create_time`) 
VALUES ('admin', '$2y$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', '127.0.0.1,::1', UNIX_TIMESTAMP());

-- 操作日志表
CREATE TABLE `chat_admin_logs` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `admin_id` int(11) NOT NULL,
  `action` varchar(100) NOT NULL COMMENT '操作类型',
  `content` text NOT NULL COMMENT '操作内容',
  `ip` varchar(50) NOT NULL COMMENT '操作IP',
  `create_time` int(11) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 扩展用户表（存储真实IP）
ALTER TABLE `chat_users` ADD COLUMN `real_ip` varchar(50) NOT NULL DEFAULT '' COMMENT '用户真实IP';
ALTER TABLE `chat_users` ADD COLUMN `mute_chat` tinyint(1) NOT NULL DEFAULT 0 COMMENT '群聊禁言 0-正常 1-禁言';
ALTER TABLE `chat_users` ADD COLUMN `mute_private` tinyint(1) NOT NULL DEFAULT 0 COMMENT '私聊禁言 0-正常 1-禁言';

-- 聊天室扩展字段
ALTER TABLE `chat_rooms` ADD COLUMN `status` tinyint(1) NOT NULL DEFAULT 1 COMMENT '状态 1-显示 0-隐藏';
