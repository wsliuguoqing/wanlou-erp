'use strict';
const { route, bad, forbidden, HttpError, createSession, destroySession, logAction } = require('../http-framework');
const { db, now, verifyPassword, hashPassword } = require('../db');
const captcha = require('../captcha');

/* ---------- 登录失败次数限制 ----------
 * 同一账号 + 同一台电脑连续输错 3 次，锁 1 分钟，锁定期内正确密码也不放行。
 * 计数只放内存：服务重启即清零，不写库，避免把人锁死在外。
 * 按「账号+IP」分开记，一个人输错不会连累同事用自己的账号登录。
 */
const LOGIN_MAX_FAIL = 3;
const LOGIN_LOCK_MS = 60 * 1000;
const loginFails = new Map(); // key -> { count, lockUntil }

function failKey(ctx, username) {
  return `${String(username || '').trim().toLowerCase()}|${ctx.ip || ''}`;
}

/** 还要等几秒才能再登录，0 表示没锁 */
function lockSeconds(key) {
  const rec = loginFails.get(key);
  if (!rec || !rec.lockUntil) return 0;
  const left = rec.lockUntil - Date.now();
  if (left <= 0) { loginFails.delete(key); return 0; }
  return Math.ceil(left / 1000);
}

/** 记一次失败：够 3 次就上锁，并把计数清零，下一轮重新数 */
function recordFail(key) {
  const rec = loginFails.get(key) || { count: 0, lockUntil: 0 };
  rec.count += 1;
  if (rec.count >= LOGIN_MAX_FAIL) {
    rec.count = 0;
    rec.lockUntil = Date.now() + LOGIN_LOCK_MS;
  }
  loginFails.set(key, rec);
  // 长期运行防内存堆积：记录太多时清掉已过期没锁的
  if (loginFails.size > 500) {
    for (const [k, v] of loginFails) {
      if (!v.lockUntil || v.lockUntil < Date.now()) loginFails.delete(k);
    }
  }
  return rec;
}

/** 输错一次后要返回的错误：锁定中返回 429 带剩余秒数，否则告诉用户还能试几次 */
function failError(key) {
  const rec = recordFail(key);
  if (rec.lockUntil) {
    const left = Math.max(1, Math.ceil((rec.lockUntil - Date.now()) / 1000));
    return new HttpError(429, `密码连续输错 ${LOGIN_MAX_FAIL} 次，请 ${left} 秒后再试`, { retryAfter: left });
  }
  const remain = LOGIN_MAX_FAIL - rec.count;
  return new HttpError(400, `账号或密码错误，还可再试 ${remain} 次`);
}

/* ---------- 图形验证码 ---------- */
/* 登录页每次打开/刷新都取一张。SVG 里没有明文，脚本读不出答案。 */
route('GET', '/api/auth/captcha', async (ctx) => {
  if (!captcha.captchaEnabled()) return { enabled: false };
  const { id, svg, width, height } = captcha.issue(ctx.ip);
  return { enabled: true, id, svg, width, height };
}, { public: true });

/* ---------- 登录 ---------- */
route('POST', '/api/auth/login', async (ctx) => {
  const { username, password, captcha_id, captcha_code } = ctx.body;
  if (!username || !password) bad('请输入账号和密码');

  const key = failKey(ctx, username);
  const locked = lockSeconds(key);
  if (locked > 0) {
    throw new HttpError(429, `密码连续输错 ${LOGIN_MAX_FAIL} 次，请 ${locked} 秒后再试`, { retryAfter: locked });
  }

  // 图形验证码：先于密码校验，输错直接打回，不消耗密码失败次数
  // （验证码本身是一次性的，想再试就得重新取图，暴力试错成本已经很高）
  if (captcha.captchaEnabled()) {
    if (!captcha_id || !captcha_code) bad('请输入图形验证码', { captchaFail: true });
    captcha.verify(captcha_id, captcha_code);
  }

  const user = db.prepare('SELECT * FROM users WHERE username=?').get(String(username).trim());
  if (!user) throw failError(key);
  if (user.status !== 1) forbidden('账号已停用，请联系管理员');
  if (!verifyPassword(password, user.password_hash)) throw failError(key);

  loginFails.delete(key); // 登录成功，清零失败记录

  const token = createSession(user);
  db.prepare('UPDATE users SET last_login_at=? WHERE id=?').run(now(), user.id);
  logAction({ ...ctx, user: { userId: user.id, username: user.username } }, 'login', 'auth', `${user.name} 登录`);
  return { token, user: publicUser(user) };
}, { public: true });

/* ---------- 登出 ---------- */
route('POST', '/api/auth/logout', async (ctx) => {
  destroySession(ctx.token);
  logAction(ctx, 'logout', 'auth', '退出登录');
  return {};
});

/* ---------- 当前用户 ---------- */
route('GET', '/api/auth/me', async (ctx) => {
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(ctx.user.userId);
  if (!user) bad('用户不存在');
  return { user: publicUser(user), permissions: [...ctx.perms] };
});

/* ---------- 修改自己的密码 ---------- */
route('POST', '/api/auth/change-password', async (ctx) => {
  const { oldPassword, newPassword } = ctx.body;
  if (!oldPassword || !newPassword) bad('请填写旧密码和新密码');
  if (String(newPassword).length < 6) bad('新密码至少 6 位');

  const user = db.prepare('SELECT * FROM users WHERE id=?').get(ctx.user.userId);
  if (!verifyPassword(oldPassword, user.password_hash)) bad('旧密码不正确');

  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(newPassword), user.id);
  logAction(ctx, 'change_password', 'auth', '修改自己的密码');
  return {};
});

function publicUser(u) {
  return {
    id: u.id, username: u.username, name: u.name, role: u.role,
    phone: u.phone, status: u.status, last_login_at: u.last_login_at
  };
}

module.exports = { publicUser };
