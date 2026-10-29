'use strict';
/**
 * 万楼进销存系统 - 服务入口
 * 启动：node src/server/server.js
 * 默认端口 3000，可通过环境变量 PORT 修改
 */
const os = require('node:os');
const { createServer } = require('./http-framework');
const { seeded, DB_FILE } = require('./db');

// 加载所有路由（顺序无关，注册即生效）
require('./routes/auth');
require('./routes/users');
require('./routes/base');
require('./routes/docs');
require('./routes/inventory-reports');
require('./routes/checks');
require('./routes/exports');

const PORT = Number(process.env.PORT) || 3000;
const server = createServer();

server.listen(PORT, '0.0.0.0', () => {
  const ips = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const it of ifaces[name] || []) {
      if (it.family === 'IPv4' && !it.internal) ips.push(it.address);
    }
  }

  console.log('');
  console.log('  ╔══════════════════════════════════════════════╗');
  console.log('  ║        万楼进销存系统  已启动                ║');
  console.log('  ╚══════════════════════════════════════════════╝');
  console.log('');
  console.log(`  本机访问   http://localhost:${PORT}`);
  ips.forEach(ip => console.log(`  局域网访问 http://${ip}:${PORT}`));
  console.log('');
  if (seeded) {
    console.log('  ── 首次启动，已初始化数据库 ──');
    console.log('  超级管理员账号：admin');
    console.log('  初始密码：      admin123');
    console.log('  请登录后立即修改密码');
    console.log('');
  }
  console.log(`  数据库文件 ${DB_FILE}`);
  console.log('  按 Ctrl+C 停止服务');
  console.log('');
});

process.on('uncaughtException', (err) => {
  console.error('[未捕获异常]', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[未处理的 Promise 拒绝]', err);
});
