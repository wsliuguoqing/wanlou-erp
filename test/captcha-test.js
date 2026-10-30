'use strict';
/**
 * 回归：登录图形验证码
 *
 * 验证点：
 *   1. 取图接口能返回 SVG，且 SVG 里没有明文（没有 <text>，答案只存在服务端内存）
 *   2. 不填验证码 / 填错验证码都被拒绝，并带 captchaFail 让前端换图
 *   3. 一张图只能用一次，重复使用报「已失效」
 *   4. 验证码填对 + 密码正确能登录
 *   5. 验证码输错不消耗「密码输错 3 次锁 1 分钟」的次数
 *   6. 系统设置里关掉开关后，登录不再要求验证码
 *   7. 同一 IP 每分钟最多取 30 张，第 31 张被限流
 *
 * 用法：node test/captcha-test.js
 * 自己在临时数据目录起服务（端口 3997），跑完关掉，不碰 data/wanlou.db。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = Number(process.env.TEST_PORT) || 3997;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-captcha-'));

// 只取点阵字模（纯常量模块，不会去开数据库）
const { FONT, CELL } = require(path.join(__dirname, '..', 'src', 'server', 'captcha-font'));

let token = '';
let failed = 0;
const ok = (cond, msg, extra) => {
  if (cond) console.log('  ✓ ' + msg);
  else { console.error('  ✗ ' + msg + (extra ? `　→ ${extra}` : '')); failed++; }
};

async function raw(p, method = 'GET', body) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, json: await res.json() };
}
async function api(p, method = 'GET', body) {
  const r = await raw(p, method, body);
  if (!r.json.ok) throw new Error(r.json.message || '请求失败');
  return r.json.data;
}

/** 从 SVG 里把点阵还原成字符——证明「图是能画出来的，但响应里没有明文」 */
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
  console.log('\n========== 登录图形验证码回归 ==========\n');
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
    ok(true, '测试服务已启动');

    /* ---------- 1. 取图 ---------- */
    console.log('\n--- 1. 取一张验证码 ---\n');
    const cap = await api('/api/auth/captcha');
    ok(cap.enabled === true, '接口返回 enabled=true');
    ok(typeof cap.svg === 'string' && cap.svg.startsWith('<svg'), '返回的是 SVG');
    ok(!/<text/.test(cap.svg), 'SVG 里没有 <text> 节点，响应不含明文字符');
    ok(typeof cap.id === 'string' && cap.id.length >= 16, `图片编号 id=${cap.id.slice(0, 8)}…`);
    const code = decodeSvg(cap.svg);
    ok(/^[A-Z0-9]{4}$/.test(code), `把图形还原成 4 位字符：${code}`, code);

    /* ---------- 2. 不填验证码 ---------- */
    console.log('\n--- 2. 不填验证码 ---\n');
    let r = await raw('/api/auth/login', 'POST', { username: 'admin', password: 'admin123' });
    ok(r.status === 400 && /图形验证码/.test(r.json.message), `被拒绝：${r.json.message}`);
    ok(r.json.captchaFail === true, '带 captchaFail 标记，前端会换图');

    /* ---------- 3. 验证码填错 ---------- */
    console.log('\n--- 3. 验证码填错 ---\n');
    r = await raw('/api/auth/login', 'POST', {
      username: 'admin', password: 'admin123', captcha_id: cap.id, captcha_code: 'ZZZZ'
    });
    ok(r.status === 400 && /验证码不正确/.test(r.json.message), `被拒绝：${r.json.message}`);
    ok(r.json.captchaFail === true, '带 captchaFail 标记');

    /* ---------- 4. 一张图只能用一次 ---------- */
    console.log('\n--- 4. 重复使用同一张图 ---\n');
    r = await raw('/api/auth/login', 'POST', {
      username: 'admin', password: 'admin123', captcha_id: cap.id, captcha_code: code
    });
    ok(r.status === 400 && /已失效/.test(r.json.message), `第二次用同一张图被拒：${r.json.message}`);

    /* ---------- 5. 正确的验证码 + 正确的密码 ---------- */
    console.log('\n--- 5. 验证码正确 + 密码正确 ---\n');
    const cap2 = await api('/api/auth/captcha');
    const code2 = decodeSvg(cap2.svg);
    r = await raw('/api/auth/login', 'POST', {
      username: 'admin', password: 'admin123', captcha_id: cap2.id, captcha_code: code2.toLowerCase()
    });
    ok(r.json.ok === true && !!r.json.data.token, `登录成功（验证码用小写也能过）：${code2}`);
    token = r.json.data.token;

    /* ---------- 6. 验证码输错不消耗密码失败次数 ---------- */
    console.log('\n--- 6. 验证码输错不影响密码锁定计数 ---\n');
    for (let i = 0; i < 3; i++) {
      const c = await api('/api/auth/captcha');
      await raw('/api/auth/login', 'POST', {
        username: 'admin', password: 'admin123', captcha_id: c.id, captcha_code: 'AAAA'
      });
    }
    const c4 = await api('/api/auth/captcha');
    r = await raw('/api/auth/login', 'POST', {
      username: 'admin', password: 'admin123', captcha_id: c4.id, captcha_code: decodeSvg(c4.svg)
    });
    ok(r.json.ok === true, '连错 3 次验证码后，密码正确仍能登录（没被锁）');
    ok(r.status !== 429, '没有被误判成密码连错而锁定');
    token = r.json.data.token;

    /* ---------- 7. 关掉开关 ---------- */
    console.log('\n--- 7. 系统设置里关掉验证码 ---\n');
    await api('/api/settings', 'PUT', { login_captcha: '0' });
    const off = await api('/api/auth/captcha');
    ok(off.enabled === false, '取图接口返回 enabled=false');
    r = await raw('/api/auth/login', 'POST', { username: 'admin', password: 'admin123' });
    ok(r.json.ok === true, '关闭后不带验证码也能登录');
    await api('/api/settings', 'PUT', { login_captcha: '1' });
    const on = await api('/api/auth/captcha');
    ok(on.enabled === true, '重新打开后恢复要求验证码');
    token = r.json.data.token;

    /* ---------- 8. 取图限流 ---------- */
    console.log('\n--- 8. 同一 IP 每分钟取图上限 ---\n');
    let hit = 0, tries = 0;
    for (let i = 0; i < 40; i++) {
      tries++;
      const res = await raw('/api/auth/captcha');
      if (res.status === 429) { hit = i + 1; break; }
    }
    ok(hit > 0, `第 ${hit} 张被限流（共试 ${tries} 次）`);
    if (hit) {
      const res = await raw('/api/auth/captcha');
      ok(res.status === 429 && res.json.retryAfter > 0, `限流带 retryAfter=${res.json.retryAfter} 秒`);
    }

  } catch (e) {
    console.error('\n  ✗ 执行出错：' + e.message);
    failed++;
  } finally {
    console.log('\n========== 测试结束 ==========');
    console.log(failed ? `发现 ${failed} 个问题` : '全部通过');
    console.log('');
    cleanup();
    process.exit(failed ? 1 : 0);
  }
})();
