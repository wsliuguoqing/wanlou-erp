'use strict';
const { route, bad, forbidden, createSession, destroySession, logAction } = require('../http-framework');
const { db, now, verifyPassword, hashPassword } = require('../db');

/* ---------- 登录 ---------- */
route('POST', '/api/auth/login', async (ctx) => {
  const { username, password } = ctx.body;
  if (!username || !password) bad('请输入账号和密码');

  const user = db.prepare('SELECT * FROM users WHERE username=?').get(String(username).trim());
  if (!user) bad('账号或密码错误');
  if (user.status !== 1) forbidden('账号已停用，请联系管理员');
  if (!verifyPassword(password, user.password_hash)) bad('账号或密码错误');

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
