'use strict';
/**
 * 测试/脚本共用的「带图形验证码的登录」
 *
 * 登录接口现在要求图形验证码，脚本没法像以前那样直接 POST 账号密码。
 * 这里把流程包一层：取图 → 把点阵还原成字符 → 带上 captcha_id 和字符登录。
 *
 * 只依赖 captcha-font.js（纯常量，不会去开数据库），对被测服务没有任何副作用。
 */
const path = require('node:path');
const { FONT, CELL } = require(path.join(__dirname, '..', 'src', 'server', 'captcha-font'));

/** 从 SVG 里把点阵还原成字符（每个字符是一个 <g>，里面若干 <rect>） */
function decodeSvg(svg) {
  const out = [];
  for (const chunk of String(svg).split('<g ').slice(1)) {
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

/** 取一张验证码，返回 { id, code }；验证码被关掉时返回 null */
async function fetchCaptcha(base) {
  const res = await fetch(base + '/api/auth/captcha');
  const j = await res.json();
  if (!j.ok) throw new Error('取验证码失败：' + (j.message || '未知错误'));
  if (!j.data || j.data.enabled === false) return null;
  return { id: j.data.id, code: decodeSvg(j.data.svg) };
}

/**
 * 登录并返回接口原始响应 { status, json }
 * opts.captchaCode 可以强制填一个错误的验证码，用来测失败分支
 */
async function loginRaw(base, username, password, opts = {}) {
  const cap = await fetchCaptcha(base);
  const body = { username, password };
  if (cap) {
    body.captcha_id = cap.id;
    body.captcha_code = opts.captchaCode === undefined ? cap.code : opts.captchaCode;
  }
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: res.status, json: await res.json() };
}

/** 登录成功返回 token，失败直接抛错（给不需要测失败分支的脚本用） */
async function loginToken(base, username, password) {
  const r = await loginRaw(base, username, password);
  if (!r.json.ok) throw new Error('登录失败：' + r.json.message);
  return r.json.data.token;
}

/**
 * 直接给完整的登录地址，自己推出验证码地址（把结尾的 /login 换成 /captcha）。
 * 老脚本各自拼 URL 的方式不一样（有的带 /api 前缀、有的不带），用这个最省事。
 */
async function loginAt(loginUrl, username, password) {
  const captchaUrl = String(loginUrl).replace(/\/login$/, '/captcha');
  const body = { username, password };
  try {
    const j = await (await fetch(captchaUrl)).json();
    if (j.ok && j.data && j.data.enabled !== false) {
      body.captcha_id = j.data.id;
      body.captcha_code = decodeSvg(j.data.svg);
    }
  } catch { /* 取不到验证码就按「已关闭」处理，让登录接口自己报错 */ }

  const res = await fetch(loginUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const json = await res.json();
  if (!json.ok) throw new Error('登录失败：' + json.message);
  return json.data.token;
}

module.exports = { decodeSvg, fetchCaptcha, loginRaw, loginToken, loginAt };
