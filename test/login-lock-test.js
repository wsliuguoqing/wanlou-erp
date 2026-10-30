'use strict';
/**
 * 回归：登录连续输错 3 次锁 1 分钟
 *
 * 规则：同一账号 + 同一台电脑连续输错 3 次密码，锁 60 秒；
 * 锁定期内即使输对密码也不放行；登录成功会把失败次数清零。
 *
 * 用法：node test/login-lock-test.js
 * 会自己在临时数据目录起一个服务（端口 3999），跑完关掉，不碰 data/wanlou.db。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = Number(process.env.TEST_PORT) || 3999;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-login-'));

// 登录现在要图形验证码，测试得先把图还原成字符。
// 只 require 纯常量模块 captcha-font，不会打开数据库。
const { FONT, CELL } = require(path.join(__dirname, '..', 'src', 'server', 'captcha-font'));

/** 从 SVG 里把点阵还原成字符 */
function decodeSvg(svg) {
  const out = [];
  for (const chunk of svg.split('<g ').slice(1)) {
    const body = chunk.slice(0, chunk.indexOf('</g>'));
    const grid = Array.from({ length: 7 }, () => Array(5).fill('.'));
    for (const m of body.matchAll(/<rect x="(-?[\d.]+)" y="(-?[\d.]+)"/g)) {
      const c = Math.round(Number(m[1]) / CELL);
      const r = Math.round(Number(m[2]) / CELL);
      if (r >= 0 && r < 7 && c >= 0 && c < 5) grid[r][c] = '#';
    }
    const sig = grid.map(row => row.join('')).join('|');
    out.push(Object.keys(FONT).find(k => FONT[k] === sig) || '?');
  }
  return out.join('');
}

/** 取一张验证码，返回 { id, code } */
async function captcha() {
  const res = await fetch(BASE + '/api/auth/captcha');
  const j = await res.json();
  if (!j.ok || !j.data || j.data.enabled === false) throw new Error('取验证码失败：' + (j.message || '已关闭'));
  return { id: j.data.id, code: decodeSvg(j.data.svg) };
}

let failed = 0;
const assert = (cond, msg) => {
  if (cond) console.log('  ✓ ' + msg);
  else { console.error('  ✗ ' + msg); failed++; }
};

/** 发登录请求，不抛错，原样返回状态码和 JSON（每次都取新验证码） */
async function login(username, password, codeOverride) {
  const c = await captcha();
  const res = await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username, password,
      captcha_id: c.id,
      captcha_code: codeOverride === undefined ? c.code : codeOverride
    })
  });
  return { status: res.status, json: await res.json() };
}

async function waitReady(ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE + '/api/auth/me');
      if (res.status === 401) return true;
    } catch { /* 还没起来 */ }
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

(async () => {
  console.log('\n========== 登录失败锁定回归 ==========\n');
  console.log('  临时数据目录：' + DATA_DIR);

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), WL_DATA_DIR: DATA_DIR },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  child.stdout.on('data', d => { log += d.toString(); });
  child.stderr.on('data', d => { log += d.toString(); });

  const cleanup = () => {
    try { child.kill(); } catch {}
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
  };

  try {
    if (!await waitReady()) {
      console.error('服务没起来：\n' + log);
      cleanup();
      process.exit(1);
    }
    console.log('  ✓ 测试服务已启动\n');

    // 1. 前两次输错：提示还能试几次
    const w1 = await login('admin', 'wrong-1');
    assert(w1.status === 400 && /还可再试 2 次/.test(w1.json.message), '第 1 次输错：' + w1.json.message);
    const w2 = await login('admin', 'wrong-2');
    assert(w2.status === 400 && /还可再试 1 次/.test(w2.json.message), '第 2 次输错：' + w2.json.message);

    // 2. 输对一次应能登录，并把失败次数清零
    const ok1 = await login('admin', 'admin123');
    assert(ok1.status === 200 && ok1.json.ok, '输错 2 次后输对密码可以正常登录（未锁定）');
    assert(!!ok1.json.data?.token, '拿到登录令牌');

    // 3. 计数已清零：再错 2 次仍只是提示，不会锁
    await login('admin', 'wrong-3');
    const w4 = await login('admin', 'wrong-4');
    assert(w4.status === 400 && /还可再试 1 次/.test(w4.json.message),
      '登录成功后失败次数清零，再错 2 次仍未锁：' + w4.json.message);

    // 4. 第 3 次输错：上锁，返回 429 + 剩余秒数
    const w5 = await login('admin', 'wrong-5');
    assert(w5.status === 429, '第 3 次输错返回 429（已锁定）');
    assert(typeof w5.json.retryAfter === 'number' && w5.json.retryAfter > 55 && w5.json.retryAfter <= 60,
      'retryAfter 约为 60 秒：' + w5.json.retryAfter);
    assert(/请 \d+ 秒后再试/.test(w5.json.message), '提示语：' + w5.json.message);

    // 5. 锁定期内输对密码也不放行
    const ok2 = await login('admin', 'admin123');
    assert(ok2.status === 429 && !ok2.json.ok, '锁定期内正确密码同样被拦下');
    assert(ok2.json.retryAfter <= w5.json.retryAfter, '剩余秒数在递减：' + ok2.json.retryAfter);

    // 6. 别的账号不受影响（admin 被锁，不该连累其他人）
    //    默认只有 admin，这里用不存在的账号验证「按账号分开记」，它自己独立计数
    const other = await login('nobody-' + Date.now(), 'x');
    assert(other.status === 400 && /还可再试 2 次/.test(other.json.message),
      '另一个账号独立计数，没被 admin 的锁定牵连：' + other.json.message);

    console.log('\n========== 测试结束 ==========');
    console.log(failed ? `有 ${failed} 项未通过` : '全部通过');
  } finally {
    cleanup();
  }
  process.exit(failed ? 1 : 0);
})().catch(e => {
  console.error(e);
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
