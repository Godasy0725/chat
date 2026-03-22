<?php
header("Content-Type: application/json; charset=utf-8");
header("Access-Control-Allow-Origin: *");
header("Access-Control-Allow-Methods: POST, GET, OPTIONS");
header("Access-Control-Allow-Headers: Content-Type, Authorization");

// 数据库配置
$db_host = 'localhost';
$db_user = 'root';
$db_pwd = 'root';
$db_name = 'chat_system';

// 连接数据库
$conn = new mysqli($db_host, $db_user, $db_pwd, $db_name);
if ($conn->connect_error) {
    die(json_encode(['code' => 500, 'msg' => '数据库连接失败']));
}
$conn->set_charset('utf8mb4');

// 安全配置
$ADMIN_USER = 'admin';
$ALLOW_IPS = explode(',', getAdminConfig('allow_ips')); // 允许的IP列表
$TOKEN_EXPIRE = 86400; // Token有效期24小时

// 路由分发
$action = $_REQUEST['action'] ?? '';
switch ($action) {
    case 'login':
        login();
        break;
    case 'getUserDashboard':
        checkAuth();
        getUserDashboard();
        break;
    case 'manageRoom':
        checkAuth();
        manageRoom();
        break;
    case 'manageUser':
        checkAuth();
        manageUser();
        break;
    case 'getChatLogs':
        checkAuth();
        getChatLogs();
        break;
    case 'sendNotice':
        checkAuth();
        sendNotice();
        break;
    case 'sendAdminMsg':
        checkAuth();
        sendAdminMsg();
        break;
    case 'downloadDB':
        checkAuth();
        downloadDB();
        break;
    default:
        jsonReturn(400, '无效的操作');
}

// 管理员登录
function login() {
    global $conn;
    $username = $_POST['username'] ?? '';
    $password = $_POST['password'] ?? '';
    $ip = getRealIp();

    // 验证IP
    if (!in_array($ip, $GLOBALS['ALLOW_IPS']) && !empty($GLOBALS['ALLOW_IPS'])) {
        jsonReturn(403, 'IP未授权');
    }

    // 查询管理员
    $stmt = $conn->prepare("SELECT id, password, allow_ips FROM chat_admin WHERE username = ?");
    $stmt->bind_param("s", $username);
    $stmt->execute();
    $result = $stmt->get_result();
    $admin = $result->fetch_assoc();
    $stmt->close();

    if (!$admin || !password_verify($password, $admin['password'])) {
        addAdminLog(0, '登录失败', "账号：$username，IP：$ip");
        jsonReturn(401, '账号或密码错误');
    }

    // 生成Token
    $token = md5(uniqid(mt_rand(), true));
    $expire = time() + $GLOBALS['TOKEN_EXPIRE'];
    $stmt = $conn->prepare("UPDATE chat_admin SET token = ?, token_expire = ? WHERE id = ?");
    $stmt->bind_param("sii", $token, $expire, $admin['id']);
    $stmt->execute();
    $stmt->close();

    addAdminLog($admin['id'], '登录成功', "IP：$ip");
    jsonReturn(200, '登录成功', [
        'token' => $token,
        'expire' => $expire
    ]);
}

// 验证管理员权限
function checkAuth() {
    global $conn;
    $token = $_REQUEST['token'] ?? '';
    $ip = getRealIp();

    // 验证IP
    if (!in_array($ip, $GLOBALS['ALLOW_IPS']) && !empty($GLOBALS['ALLOW_IPS'])) {
        jsonReturn(403, 'IP未授权');
    }

    // 验证Token
    $stmt = $conn->prepare("SELECT id, username FROM chat_admin WHERE token = ? AND token_expire > ?");
    $stmt->bind_param("si", $token, time());
    $stmt->execute();
    $result = $stmt->get_result();
    $admin = $result->fetch_assoc();
    $stmt->close();

    if (!$admin) {
        jsonReturn(401, '登录已过期，请重新登录');
    }

    // 延长Token有效期
    $expire = time() + $GLOBALS['TOKEN_EXPIRE'];
    $stmt = $conn->prepare("UPDATE chat_admin SET token_expire = ? WHERE id = ?");
    $stmt->bind_param("ii", $expire, $admin['id']);
    $stmt->execute();
    $stmt->close();

    $_SESSION['admin'] = $admin;
    return $admin;
}

// 用户仪表盘（查看真实IP、在线状态等）
function getUserDashboard() {
    global $conn;
    $keyword = $_REQUEST['keyword'] ?? '';
    $page = intval($_REQUEST['page'] ?? 1);
    $limit = intval($_REQUEST['limit'] ?? 20);
    $offset = ($page - 1) * $limit;

    $where = '';
    if ($keyword) {
        $where = "WHERE username LIKE ?";
        $keyword = "%$keyword%";
    }

    $stmt = $conn->prepare("SELECT id, username, real_ip, mute_chat, mute_private, create_time FROM chat_users $where LIMIT ?, ?");
    if ($keyword) {
        $stmt->bind_param("sii", $keyword, $offset, $limit);
    } else {
        $stmt->bind_param("ii", $offset, $limit);
    }
    $stmt->execute();
    $result = $stmt->get_result();
    $users = [];
    while ($row = $result->fetch_assoc()) {
        $row['create_time'] = date('Y-m-d H:i:s', $row['create_time']);
        $users[] = $row;
    }
    $stmt->close();

    // 总数
    $stmt = $conn->prepare("SELECT COUNT(*) as total FROM chat_users $where");
    if ($keyword) {
        $stmt->bind_param("s", $keyword);
    }
    $stmt->execute();
    $total = $stmt->get_result()->fetch_assoc()['total'];
    $stmt->close();

    addAdminLog($_SESSION['admin']['id'], '查看用户仪表盘', "关键词：$keyword，页码：$page");
    jsonReturn(200, '成功', [
        'list' => $users,
        'total' => $total,
        'page' => $page,
        'limit' => $limit
    ]);
}

// 聊天室管理（增删改查、隐藏/显示、重命名）
function manageRoom() {
    global $conn;
    $type = $_POST['type'] ?? ''; // add, delete, hide, show, rename
    $room_id = intval($_POST['room_id'] ?? 0);
    $room_name = $_POST['room_name'] ?? '';
    $admin_id = $_SESSION['admin']['id'];

    switch ($type) {
        case 'add':
            if (empty($room_name)) jsonReturn(400, '聊天室名称不能为空');
            $stmt = $conn->prepare("INSERT INTO chat_rooms (name, status, create_time) VALUES (?, 1, ?)");
            $stmt->bind_param("si", $room_name, time());
            $stmt->execute();
            $stmt->close();
            addAdminLog($admin_id, '新增聊天室', "名称：$room_name");
            jsonReturn(200, '聊天室创建成功');
            break;
        case 'delete':
            if ($room_id <= 0) jsonReturn(400, '无效的聊天室ID');
            $stmt = $conn->prepare("DELETE FROM chat_rooms WHERE id = ?");
            $stmt->bind_param("i", $room_id);
            $stmt->execute();
            $stmt->close();
            addAdminLog($admin_id, '删除聊天室', "ID：$room_id");
            jsonReturn(200, '聊天室删除成功');
            break;
        case 'hide':
        case 'show':
            if ($room_id <= 0) jsonReturn(400, '无效的聊天室ID');
            $status = $type == 'show' ? 1 : 0;
            $stmt = $conn->prepare("UPDATE chat_rooms SET status = ? WHERE id = ?");
            $stmt->bind_param("ii", $status, $room_id);
            $stmt->execute();
            $stmt->close();
            addAdminLog($admin_id, $type == 'show' ? '显示聊天室' : '隐藏聊天室', "ID：$room_id");
            jsonReturn(200, $type == 'show' ? '聊天室已显示' : '聊天室已隐藏');
            break;
        case 'rename':
            if ($room_id <= 0 || empty($room_name)) jsonReturn(400, '参数错误');
            $stmt = $conn->prepare("UPDATE chat_rooms SET name = ? WHERE id = ?");
            $stmt->bind_param("si", $room_name, $room_id);
            $stmt->execute();
            $stmt->close();
            addAdminLog($admin_id, '重命名聊天室', "ID：$room_id，新名称：$room_name");
            jsonReturn(200, '聊天室重命名成功');
            break;
        default:
            jsonReturn(400, '无效的操作类型');
    }
}

// 用户管理（禁言/解除禁言）
function manageUser() {
    global $conn;
    $type = $_POST['type'] ?? ''; // mute_chat, unmute_chat, mute_private, unmute_private
    $user_id = intval($_POST['user_id'] ?? 0);
    $admin_id = $_SESSION['admin']['id'];

    if ($user_id <= 0) jsonReturn(400, '无效的用户ID');

    switch ($type) {
        case 'mute_chat':
            $stmt = $conn->prepare("UPDATE chat_users SET mute_chat = 1 WHERE id = ?");
            $action = '禁言群聊';
            break;
        case 'unmute_chat':
            $stmt = $conn->prepare("UPDATE chat_users SET mute_chat = 0 WHERE id = ?");
            $action = '解除群聊禁言';
            break;
        case 'mute_private':
            $stmt = $conn->prepare("UPDATE chat_users SET mute_private = 1 WHERE id = ?");
            $action = '禁言私聊';
            break;
        case 'unmute_private':
            $stmt = $conn->prepare("UPDATE chat_users SET mute_private = 0 WHERE id = ?");
            $action = '解除私聊禁言';
            break;
        default:
            jsonReturn(400, '无效的操作类型');
    }

    $stmt->bind_param("i", $user_id);
    $stmt->execute();
    $stmt->close();
    addAdminLog($admin_id, $action, "用户ID：$user_id");
    jsonReturn(200, $action . '成功');
}

// 获取聊天记录（群聊/私聊）
function getChatLogs() {
    global $conn;
    $type = $_REQUEST['type'] ?? ''; // room, private
    $room_id = intval($_REQUEST['room_id'] ?? 0);
    $user1 = $_REQUEST['user1'] ?? '';
    $user2 = $_REQUEST['user2'] ?? '';
    $page = intval($_REQUEST['page'] ?? 1);
    $limit = intval($_REQUEST['limit'] ?? 20);
    $offset = ($page - 1) * $limit;
    $admin_id = $_SESSION['admin']['id'];

    if ($type == 'room') {
        if ($room_id <= 0) jsonReturn(400, '无效的聊天室ID');
        $stmt = $conn->prepare("SELECT * FROM chat_room_logs WHERE room_id = ? ORDER BY create_time DESC LIMIT ?, ?");
        $stmt->bind_param("iii", $room_id, $offset, $limit);
        $action = '查看群聊记录';
        $content = "聊天室ID：$room_id";
    } elseif ($type == 'private') {
        if (empty($user1) || empty($user2)) jsonReturn(400, '请选择两个用户');
        $stmt = $conn->prepare("SELECT * FROM chat_private_logs WHERE (sender = ? AND receiver = ?) OR (sender = ? AND receiver = ?) ORDER BY create_time DESC LIMIT ?, ?");
        $stmt->bind_param("ssssii", $user1, $user2, $user2, $user1, $offset, $limit);
        $action = '查看私聊记录';
        $content = "用户1：$user1，用户2：$user2";
    } else {
        jsonReturn(400, '无效的记录类型');
    }

    $stmt->execute();
    $result = $stmt->get_result();
    $logs = [];
    while ($row = $result->fetch_assoc()) {
        $row['create_time'] = date('Y-m-d H:i:s', $row['create_time']);
        $logs[] = $row;
    }
    $stmt->close();

    addAdminLog($admin_id, $action, $content);
    jsonReturn(200, '成功', [
        'list' => $logs,
        'page' => $page,
        'limit' => $limit
    ]);
}

// 发送顶部公告
function sendNotice() {
    global $conn;
    $content = $_POST['content'] ?? '';
    if (empty($content)) jsonReturn(400, '公告内容不能为空');

    // 存储公告
    $stmt = $conn->prepare("INSERT INTO chat_notices (content, create_time) VALUES (?, ?)");
    $stmt->bind_param("si", $content, time());
    $stmt->execute();
    $stmt->close();

    // 推送公告（WebSocket）
    pushWebSocketMsg('notice', ['content' => $content]);

    addAdminLog($_SESSION['admin']['id'], '发送顶部公告', "内容：$content");
    jsonReturn(200, '公告发送成功');
}

// 发送管理员消息（群聊/私聊）
function sendAdminMsg() {
    global $conn;
    $type = $_POST['type'] ?? ''; // room, private
    $room_id = intval($_POST['room_id'] ?? 0);
    $receiver = $_POST['receiver'] ?? '';
    $content = $_POST['content'] ?? '';
    $admin_id = $_SESSION['admin']['id'];

    if (empty($content)) jsonReturn(400, '消息内容不能为空');

    // 构造管理员消息
    $msg = [
        'type' => $type == 'room' ? 'admin_room_msg' : 'admin_private_msg',
        'sender' => '管理员',
        'content' => $content,
        'is_admin' => 1,
        'time' => time()
    ];

    if ($type == 'room') {
        if ($room_id <= 0) jsonReturn(400, '无效的聊天室ID');
        $msg['room_id'] = $room_id;
        // 存储消息
        $stmt = $conn->prepare("INSERT INTO chat_room_logs (room_id, sender, content, is_admin, create_time) VALUES (?, '管理员', ?, 1, ?)");
        $stmt->bind_param("isi", $room_id, $content, time());
        $stmt->execute();
        $stmt->close();
        $action = '发送群聊管理员消息';
        $content_log = "聊天室ID：$room_id，内容：$content";
    } elseif ($type == 'private') {
        if (empty($receiver)) jsonReturn(400, '请选择接收用户');
        $msg['receiver'] = $receiver;
        // 存储消息
        $stmt = $conn->prepare("INSERT INTO chat_private_logs (sender, receiver, content, is_admin, create_time) VALUES ('管理员', ?, ?, 1, ?)");
        $stmt->bind_param("ssi", $receiver, $content, time());
        $stmt->execute();
        $stmt->close();
        $action = '发送私聊管理员消息';
        $content_log = "接收人：$receiver，内容：$content";
    } else {
        jsonReturn(400, '无效的消息类型');
    }

    // 推送消息
    pushWebSocketMsg($type == 'room' ? 'admin_room' : 'admin_private', $msg);

    addAdminLog($admin_id, $action, $content_log);
    jsonReturn(200, '管理员消息发送成功');
}

// 下载数据库
function downloadDB() {
    global $db_host, $db_user, $db_pwd, $db_name;
    $admin_id = $_SESSION['admin']['id'];

    // 生成备份文件名
    $filename = "chat_db_backup_" . date('YmdHis') . ".sql";
    $backupPath = __DIR__ . "/backup/$filename";

    // 创建备份目录
    if (!is_dir(__DIR__ . "/backup")) {
        mkdir(__DIR__ . "/backup", 0755, true);
    }

    // 执行备份命令
    $command = "mysqldump -h$db_host -u$db_user -p$db_pwd $db_name > $backupPath";
    exec($command);

    // 检查备份文件
    if (!file_exists($backupPath)) {
        jsonReturn(500, '数据库备份失败');
    }

    // 下载文件
    header("Content-Type: application/octet-stream");
    header("Content-Disposition: attachment; filename=$filename");
    header("Content-Length: " . filesize($backupPath));
    readfile($backupPath);

    // 记录日志
    addAdminLog($admin_id, '下载数据库备份', "文件名：$filename");

    // 删除临时文件
    unlink($backupPath);
    exit;
}

// 辅助函数：返回JSON
function jsonReturn($code, $msg, $data = []) {
    echo json_encode([
        'code' => $code,
        'msg' => $msg,
        'data' => $data
    ], JSON_UNESCAPED_UNICODE);
    exit;
}

// 辅助函数：获取真实IP
function getRealIp() {
    if (!empty($_SERVER['HTTP_X_FORWARDED_FOR'])) {
        $ip = explode(',', $_SERVER['HTTP_X_FORWARDED_FOR'])[0];
    } elseif (!empty($_SERVER['HTTP_CLIENT_IP'])) {
        $ip = $_SERVER['HTTP_CLIENT_IP'];
    } else {
        $ip = $_SERVER['REMOTE_ADDR'];
    }
    return $ip;
}

// 辅助函数：获取管理员配置
function getAdminConfig($key) {
    global $conn;
    $stmt = $conn->prepare("SELECT $key FROM chat_admin WHERE username = ?");
    $stmt->bind_param("s", $GLOBALS['ADMIN_USER']);
    $stmt->execute();
    $result = $stmt->get_result()->fetch_assoc();
    $stmt->close();
    return $result[$key] ?? '';
}

// 辅助函数：添加管理员日志
function addAdminLog($admin_id, $action, $content) {
    global $conn;
    $ip = getRealIp();
    $stmt = $conn->prepare("INSERT INTO chat_admin_logs (admin_id, action, content, ip, create_time) VALUES (?, ?, ?, ?, ?)");
    $stmt->bind_param("isssi", $admin_id, $action, $content, $ip, time());
    $stmt->execute();
    $stmt->close();
}

// 辅助函数：推送WebSocket消息
function pushWebSocketMsg($type, $data) {
    // 对接原有WebSocket服务，此处需根据你的WS服务调整
    $wsUrl = 'ws://localhost:3000';
    $client = new \WebSocket\Client($wsUrl);
    $client->send(json_encode([
        'type' => $type,
        'data' => $data
    ]));
    $client->close();
}
?>
