'use strict';
const { route, bad, notFound, logAction, permissionsOf, clearPermCache } = require('../http-framework');
const { db, now, hashPassword, ALL_PERMISSIONS, DEFAULT_ROLE_PERMISSIONS } = require('../db');

const ROLES = ['sales', 'purchaser', 'finance', 'manager', 'admin'];
const ROLE_NAMES = { sales: '销售员', purchaser: '采购员', finance: '财务', manager: '主管', admin: '超级管理员' };

/* ---------- 员工列表 ---------- */
route('GET', '/api/users', async (ctx) => {
  ctx.need('user.manage');
  const { keyword = '', role = '', status = '' } = ctx.query;
  let sql = 'SELECT id,username,name,role,phone,status,created_at,last_login_at FROM users WHERE 1=1';
  const args = [];
  if (keyword) { sql += ' AND (username LIKE ? OR name LIKE ? OR phone LIKE ?)'; args.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`); }
  if (role) { sql += ' AND role=?'; args.push(role); }
  if (status !== '') { sql += ' AND status=?'; args.push(Number(status)); }
  sql += ' ORDER BY id';
  const rows = db.prepare(sql).all(...args);
  return { list: rows.map(r => ({ ...r, roleName: ROLE_NAMES[r.role] || r.role })) };
});

/* ---------- 新增员工 ---------- */
route('POST', '/api/users', async (ctx) => {
  ctx.need('user.manage');
  const { username, name, password, role, phone } = ctx.body;
  if (!username || !name || !password || !role) bad('账号、姓名、密码、角色都必须填写');
  if (String(password).length < 6) bad('初始密码至少 6 位');
  if (!ROLES.includes(role)) bad('角色不合法');
  const exist = db.prepare('SELECT id FROM users WHERE username=?').get(String(username).trim());
  if (exist) bad('该账号已存在');

  const r = db.prepare(`INSERT INTO users(username,password_hash,name,role,phone,status,created_at)
                        VALUES (?,?,?,?,?,1,?)`)
    .run(String(username).trim(), hashPassword(password), name, role, phone || '', now());
  logAction(ctx, 'create', 'user', `新增员工 ${name}(${username}) 角色=${ROLE_NAMES[role]}`);
  return { id: Number(r.lastInsertRowid) };
});

/* ---------- 编辑员工 ---------- */
route('PUT', '/api/users/:id', async (ctx) => {
  ctx.need('user.manage');
  const id = Number(ctx.params.id);
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!u) notFound('员工不存在');
  const { name, role, phone } = ctx.body;
  if (role && !ROLES.includes(role)) bad('角色不合法');
  // 不允许把最后一个超级管理员改成别的角色
  if (u.role === 'admin' && role && role !== 'admin') {
    const admins = db.prepare("SELECT COUNT(*) n FROM users WHERE role='admin' AND status=1").get().n;
    if (admins <= 1) bad('系统至少需要保留一个超级管理员');
  }
  db.prepare('UPDATE users SET name=?, role=?, phone=? WHERE id=?')
    .run(name ?? u.name, role ?? u.role, phone ?? u.phone, id);
  logAction(ctx, 'update', 'user', `编辑员工 ${u.username}`);
  return {};
});

/* ---------- 重置密码 ---------- */
route('POST', '/api/users/:id/reset-password', async (ctx) => {
  ctx.need('user.manage');
  const id = Number(ctx.params.id);
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!u) notFound('员工不存在');
  const pwd = ctx.body.password || '123456';
  if (String(pwd).length < 6) bad('密码至少 6 位');
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(pwd), id);
  logAction(ctx, 'reset_password', 'user', `重置 ${u.username} 的密码`);
  return { password: pwd };
});

/* ---------- 启用/停用 ---------- */
route('POST', '/api/users/:id/status', async (ctx) => {
  ctx.need('user.manage');
  const id = Number(ctx.params.id);
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!u) notFound('员工不存在');
  const status = Number(ctx.body.status) === 1 ? 1 : 0;
  if (status === 0 && u.role === 'admin') {
    const admins = db.prepare("SELECT COUNT(*) n FROM users WHERE role='admin' AND status=1").get().n;
    if (admins <= 1) bad('不能停用唯一的超级管理员');
  }
  db.prepare('UPDATE users SET status=? WHERE id=?').run(status, id);
  logAction(ctx, status ? 'enable' : 'disable', 'user', `${status ? '启用' : '停用'} ${u.username}`);
  return {};
});

/* ---------- 删除员工 ---------- */
route('DELETE', '/api/users/:id', async (ctx) => {
  ctx.need('user.manage');
  const id = Number(ctx.params.id);
  if (id === ctx.user.userId) bad('不能删除自己');
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!u) notFound('员工不存在');
  if (u.role === 'admin') {
    const admins = db.prepare("SELECT COUNT(*) n FROM users WHERE role='admin' AND status=1").get().n;
    if (admins <= 1) bad('不能删除唯一的超级管理员');
  }
  // 有业务痕迹的不能删，只能停用
  const used = db.prepare('SELECT COUNT(*) n FROM docs WHERE created_by=?').get(id).n;
  if (used > 0) bad(`该员工有 ${used} 张单据记录，不能删除，请改为「停用」`);
  db.prepare('DELETE FROM users WHERE id=?').run(id);
  logAction(ctx, 'delete', 'user', `删除员工 ${u.username}`);
  return {};
});

/* ---------- 角色权限查看 ---------- */
route('GET', '/api/roles', async (ctx) => {
  ctx.need('user.manage');
  const result = {};
  for (const role of ROLES) {
    const enabled = new Set(
      db.prepare('SELECT permission FROM role_permissions WHERE role=? AND enabled=1').all(role).map(r => r.permission)
    );
    result[role] = {
      name: ROLE_NAMES[role],
      permissions: ALL_PERMISSIONS.filter(p => enabled.has(p))
    };
  }
  return { roles: result, allPermissions: ALL_PERMISSIONS, roleNames: ROLE_NAMES };
});

/* ---------- 保存角色权限 ---------- */
route('PUT', '/api/roles/:role', async (ctx) => {
  ctx.need('user.manage');
  const role = ctx.params.role;
  if (!ROLES.includes(role)) bad('角色不合法');
  if (role === 'admin') bad('超级管理员权限不可修改');
  const perms = Array.isArray(ctx.body.permissions) ? ctx.body.permissions : [];
  const unknown = perms.filter(p => !ALL_PERMISSIONS.includes(p));
  if (unknown.length) bad(`未知权限: ${unknown.join(',')}`);

  const up = db.prepare(`INSERT INTO role_permissions(role,permission,enabled) VALUES (?,?,?)
                         ON CONFLICT(role,permission) DO UPDATE SET enabled=excluded.enabled`);
  for (const p of ALL_PERMISSIONS) up.run(role, p, perms.includes(p) ? 1 : 0);
  clearPermCache();
  logAction(ctx, 'update', 'role', `修改角色 ${ROLE_NAMES[role]} 的权限，共 ${perms.length} 项`);
  return {};
});

/* ---------- 恢复默认权限 ---------- */
route('POST', '/api/roles/:role/reset', async (ctx) => {
  ctx.need('user.manage');
  const role = ctx.params.role;
  if (!ROLES.includes(role)) bad('角色不合法');
  if (role === 'admin') bad('超级管理员权限不可修改');
  const defaults = DEFAULT_ROLE_PERMISSIONS[role];
  const up = db.prepare(`INSERT INTO role_permissions(role,permission,enabled) VALUES (?,?,?)
                         ON CONFLICT(role,permission) DO UPDATE SET enabled=excluded.enabled`);
  for (const p of ALL_PERMISSIONS) up.run(role, p, defaults.includes(p) ? 1 : 0);
  clearPermCache();
  logAction(ctx, 'reset', 'role', `恢复角色 ${ROLE_NAMES[role]} 的默认权限`);
  return {};
});

module.exports = { ROLES, ROLE_NAMES };
