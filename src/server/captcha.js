'use strict';
/**
 * 登录图形验证码（零第三方依赖）
 *
 * 做法：服务端用 5×7 点阵把字符画成一堆小方块，输出 SVG。
 * 关键点：**SVG 里不出现明文字符**，只出现矩形坐标，
 * 所以脚本没法直接从响应里把答案读出来，必须真的渲染成图才能看。
 *
 * 再叠几层干扰：每个字符随机倾斜/旋转/上下浮动/换色，画 3 条随机曲线、40 个噪点。
 *
 * 有效期 5 分钟，**一次性**：校验一次（不管对错）立刻作废，
 * 想再试必须重新取一张图，这样暴力试错成本就上去了。
 * 另外每个 IP 每分钟最多取 30 张，防止有人刷接口。
 */
const crypto = require('node:crypto');
const { HttpError } = require('./http-framework');
const { db } = require('./db');

/* ---------------- 点阵字模与画布参数（见 captcha-font.js） ---------------- */
const { FONT, CHARS, CODE_LEN, CELL, DOT, PAD_X, PAD_Y, GAP, CW, CH, W, H } = require('./captcha-font');


const INK = ['#2f3e4d', '#1f6f5c', '#8a4b2a', '#3a4a8c', '#7a2f4a', '#2b6b7a', '#4a4a2f'];

/* ---------------- 存储与限流 ---------------- */
const TTL_MS = 5 * 60 * 1000;
const store = new Map();   // id -> { code, exp }
const hits = new Map();    // ip  -> { n, reset }
const RATE_MAX = 30;       // 每个 IP 每分钟最多取 30 张
const RATE_WINDOW = 60 * 1000;

const rnd = (a, b) => a + Math.random() * (b - a);
const pick = arr => arr[Math.floor(Math.random() * arr.length)];

/** 验证码开关：系统设置里 login_captcha 写成 off / 0 就关掉（默认开） */
function captchaEnabled() {
  try {
    const v = db.prepare("SELECT value FROM settings WHERE key='login_captcha'").get()?.value;
    if (v == null || v === '') return true;
    return !['off', '0', 'false', 'no'].includes(String(v).trim().toLowerCase());
  } catch {
    return true;
  }
}

function checkRate(ip) {
  const t = Date.now();
  let r = hits.get(ip);
  if (!r || r.reset <= t) { r = { n: 0, reset: t + RATE_WINDOW }; hits.set(ip, r); }
  r.n += 1;
  if (r.n > RATE_MAX) {
    const left = Math.max(1, Math.ceil((r.reset - t) / 1000));
    throw new HttpError(429, `验证码请求过于频繁，请 ${left} 秒后再试`, { retryAfter: left });
  }
  if (hits.size > 2000) {
    for (const [k, v] of hits) if (v.reset <= t) hits.delete(k);
  }
}

function purge() {
  const t = Date.now();
  for (const [k, v] of store) if (v.exp <= t) store.delete(k);
  // 长期运行防堆积
  if (store.size > 3000) {
    const keys = [...store.keys()].slice(0, store.size - 3000);
    for (const k of keys) store.delete(k);
  }
}

/* ---------------- 画字符 ---------------- */
function drawChar(ch, x0, color) {
  const rows = FONT[ch].split('|');
  const rot = rnd(-11, 11);          // 整个字符旋转
  const skew = rnd(-4, 4);           // 轻微错切，笔画不再是死板的格子
  const dy = rnd(-3, 3);             // 上下浮动
  let dots = '';
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < rows[r].length; c++) {
      if (rows[r][c] !== '#') continue;
      // 每个点给一点点抖动，肉眼几乎看不出，但按坐标反推字模会变难
      const x = c * CELL + rnd(-0.22, 0.22);
      const y = r * CELL + rnd(-0.22, 0.22);
      dots += `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${DOT}" height="${DOT}" rx="1.1"/>`;
    }
  }
  return `<g fill="${color}" transform="translate(${x0.toFixed(2)},${(PAD_Y + dy).toFixed(2)}) rotate(${rot.toFixed(1)} ${CW / 2} ${CH / 2}) skewX(${skew.toFixed(1)})">${dots}</g>`;
}

/** 3 条随机曲线，穿过字符，让人眼和机器都得费点劲 */
function drawLines() {
  let out = '';
  for (let i = 0; i < 3; i++) {
    const y1 = rnd(8, H - 8), y2 = rnd(8, H - 8);
    const x1 = rnd(0, W * 0.25), x2 = rnd(W * 0.35, W * 0.7), x3 = rnd(W * 0.75, W);
    out += `<path d="M${x1.toFixed(1)},${y1.toFixed(1)} Q${x2.toFixed(1)},${rnd(0, H).toFixed(1)} ${x3.toFixed(1)},${y2.toFixed(1)}"
      fill="none" stroke="${pick(INK)}" stroke-width="${rnd(0.9, 1.6).toFixed(1)}" opacity="${rnd(0.25, 0.5).toFixed(2)}"/>`;
  }
  return out;
}

/** 噪点 */
function drawNoise() {
  let out = '';
  for (let i = 0; i < 40; i++) {
    out += `<circle cx="${rnd(0, W).toFixed(1)}" cy="${rnd(0, H).toFixed(1)}" r="${rnd(0.5, 1.4).toFixed(1)}"
      fill="${pick(INK)}" opacity="${rnd(0.12, 0.3).toFixed(2)}"/>`;
  }
  return out;
}

function makeSvg(code) {
  const chars = code.split('').map((ch, i) =>
    drawChar(ch, PAD_X + i * (CW + GAP), pick(INK))
  ).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="图形验证码">
  <rect width="${W}" height="${H}" fill="#fbfcfb"/>
  <path d="M0,${(H * 0.3).toFixed(0)} L${W},${(H * 0.15).toFixed(0)}" stroke="#eef2ef" stroke-width="10"/>
  <path d="M0,${(H * 0.75).toFixed(0)} L${W},${(H * 0.9).toFixed(0)}" stroke="#f1f4f2" stroke-width="9"/>
  ${drawNoise()}
  ${chars}
  ${drawLines()}
</svg>`;
}

/* ---------------- 对外接口 ---------------- */

/** 生成一张验证码，返回 { id, svg }（code 只留在服务端） */
function issue(ip) {
  checkRate(ip || '');
  purge();
  let code = '';
  for (let i = 0; i < CODE_LEN; i++) code += pick(CHARS);
  const id = crypto.randomBytes(12).toString('hex');
  store.set(id, { code, exp: Date.now() + TTL_MS });
  return { id, svg: makeSvg(code), width: W, height: H };
}

/**
 * 校验。不管对错，这张图立刻作废（一次性）。
 * 抛 HttpError 表示不通过，前端据此刷新图片。
 */
function verify(id, input) {
  const key = String(id || '').trim();
  const rec = store.get(key);
  if (!rec) throw new HttpError(400, '验证码已失效，请刷新后重试', { captchaFail: true });
  store.delete(key); // 一次性
  if (rec.exp <= Date.now()) throw new HttpError(400, '验证码已过期，请刷新后重试', { captchaFail: true });
  const got = String(input || '').replace(/\s/g, '').toUpperCase();
  if (got !== rec.code) throw new HttpError(400, '图形验证码不正确，请重新输入', { captchaFail: true });
  return true;
}

module.exports = { issue, verify, captchaEnabled, CODE_LEN, SIZE: { W, H }, FONT, CELL };
