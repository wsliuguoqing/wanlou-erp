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

// 端口被占用是最常见的启动失败：多半是系统已经在另一个窗口跑着，
// 直接把原始堆栈抛给用户看不懂，这里改成能照做的提示。
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('');
    console.error(`  [启动失败] 端口 ${PORT} 已经被占用`);
    console.error('  通常是系统已经在另一个窗口运行了（或者上次没关干净）。');
    console.error('  处理办法：');
    console.error(`   1) 直接打开浏览器用 http://localhost:${PORT}，说明服务已经在跑；`);
    console.error('   2) 想重启：先双击 停止系统.bat 结束旧进程，再双击 启动系统.bat；');
    console.error(`   3) 也可以换端口：set PORT=3001 然后运行启动脚本。`);
    console.error('');
    process.exit(1);
  }
  console.error('[启动失败]', err);
  process.exit(1);
});

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
