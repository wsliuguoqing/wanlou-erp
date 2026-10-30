'use strict';
/**
 * 极简 HTTP 框架：路由 + 会话 + 权限校验
 * 不依赖任何第三方包，兼容 Node 18+
 */
const http = require('node:http');
const { URL } = require('node:url');
const { db, now } = require('./db');

/* ---------------- 会话（内存） ---------------- */
const sessions = new Map(); // token -> {userId, username, role, expires}
const SESSION_TTL = 7 * 24 * 3600 * 1000; // 7 天

function createSession(user) {
  const token = require('node:crypto').randomBytes(24).toString('hex');
  sessions.set(token, {
    userId: user.id, username: user.username,
    name: user.name, role: user.role,
    expires: Date.now() + SESSION_TTL
  });
  return token;
}
function getSession(token) {
  const s = sessions.get(token);
  if (!s) return null;
  if (s.expires < Date.now()) { sessions.delete(token); return null; }
  return s;
}
function destroySession(token) { sessions.delete(token); }

/* ---------------- 权限 ---------------- */
const permCache = new Map(); // role -> Set
function permissionsOf(role) {
  if (permCache.has(role)) return permCache.get(role);
  const rows = db.prepare('SELECT permission FROM role_permissions WHERE role=? AND enabled=1').all(role);
  const set = new Set(rows.map(r => r.permission));
  permCache.set(role, set);
  return set;
}
function clearPermCache() { permCache.clear(); }

/* ---------------- 路由表 ---------------- */
const routes = [];
function route(method, pattern, handler, opts = {}) {
  // pattern 支持 /api/users/:id
  const keys = [];
  const regex = new RegExp('^' + pattern.replace(/\/:([a-zA-Z_]+)/g, (_, k) => {
    keys.push(k); return '/([^/]+)';
  }) + '$');
  routes.push({ method, regex, keys, handler, opts });
}

class HttpError extends Error {
  // extra：附加字段（如登录锁定的 retryAfter 秒数），会一起返回给前端
  constructor(status, message, extra) { super(message); this.status = status; Object.assign(this, extra); }
}
const bad = (msg) => { throw new HttpError(400, msg); };
const notFound = (msg = '未找到') => { throw new HttpError(404, msg); };
const forbidden = (msg = '没有权限') => { throw new HttpError(403, msg); };

/* ---------------- 请求体解析 ---------------- */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > 20 * 1024 * 1024) { reject(new HttpError(413, '请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(new HttpError(400, 'JSON 格式错误')); }
    });
    req.on('error', reject);
  });
}

/* ---------------- 响应辅助 ---------------- */
function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}
function ok(res, data = {}) { send(res, 200, { ok: true, data }); }

/* ---------------- 日志 ---------------- */
function logAction(ctx, action, module_, detail) {
  try {
    db.prepare(`INSERT INTO operation_logs(user_id,username,action,module,detail,ip,created_at)
                VALUES (?,?,?,?,?,?,?)`)
      .run(ctx?.user?.userId || null, ctx?.user?.username || '', action, module_,
        typeof detail === 'string' ? detail : JSON.stringify(detail || {}), ctx?.ip || '', now());
  } catch { /* 日志失败不影响主流程 */ }
}

/* ---------------- 服务器 ---------------- */
function createServer() {
  return http.createServer(async (req, res) => {
    const started = Date.now();
    let url;
    try { url = new URL(req.url, 'http://localhost'); }
    catch { return send(res, 400, { ok: false, message: '非法 URL' }); }

    // CORS（本地开发方便）
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    const pathname = url.pathname;

    // 非 API 请求交给静态文件处理器
    if (!pathname.startsWith('/api/')) {
      return staticHandler(req, res, pathname);
    }

    // 找路由
    const match = routes.find(r => r.method === req.method && r.regex.test(pathname));
    if (!match) return send(res, 404, { ok: false, message: `接口不存在: ${req.method} ${pathname}` });

    const m = pathname.match(match.regex);
    const params = {};
    match.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });

    // 认证
    let user = null;
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : (url.searchParams.get('token') || '');
    if (token) user = getSession(token);

    const ctx = {
      req, res, url, params, user, token,
      ip: req.socket.remoteAddress || '',
      body: {},
      query: Object.fromEntries(url.searchParams),
      perms: user ? permissionsOf(user.role) : new Set()
    };
    ctx.can = (perm) => ctx.perms.has(perm);
    ctx.need = (perm) => { if (!ctx.can(perm)) forbidden(`缺少权限: ${perm}`); };

    try {
      if (!match.opts.public && !user) throw new HttpError(401, '请先登录');
      if (req.method !== 'GET') ctx.body = await readBody(req);
      const data = await match.handler(ctx);
      if (res.writableEnded) return;
      ok(res, data ?? {});
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status >= 500) console.error('[500]', pathname, err);
      const payload = { ok: false, message: err.message || '服务器错误' };
      if (err.retryAfter) payload.retryAfter = err.retryAfter;
      send(res, status, payload);
    }
  });
}

/* ---------------- 静态文件 ---------------- */
const fs = require('node:fs');
const path = require('node:path');
const WEB_DIR = path.join(__dirname, '..', 'web');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2'
};

function staticHandler(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  rel = rel.replace(/\.\./g, '');
  const file = path.join(WEB_DIR, rel);
  if (!file.startsWith(WEB_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('文件不存在'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(buf);
  });
}

/* ---------------- 分页 ---------------- */
/** 从 query 解析页码与每页条数。size 允许 1~500，默认 50 */
function pageParams(query = {}) {
  let page = parseInt(query.page, 10);
  let size = parseInt(query.size, 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  if (!Number.isFinite(size) || size < 1) size = 50;
  if (size > 500) size = 500;
  return { page, size, offset: (page - 1) * size };
}

/**
 * 按总数修正页码：数据变少后停在最后一页，不会查出空列表。
 * 查列表前调用一次，返回修正后的 pg 可直接用其 offset。
 */
function clampPage(pg, total) {
  const pages = Math.max(1, Math.ceil(total / pg.size));
  if (pg.page > pages) { pg.page = pages; pg.offset = (pg.page - 1) * pg.size; }
  return pg;
}

/** 组装分页元信息 */
function pageMeta(total, pg) {
  const pages = Math.max(1, Math.ceil(total / pg.size));
  return {
    total, page: Math.min(pg.page, pages), size: pg.size, pages,
    hasPrev: pg.page > 1, hasNext: pg.page < pages
  };
}

module.exports = {
  route, createServer, HttpError, bad, notFound, forbidden, ok,
  createSession, getSession, destroySession, permissionsOf, clearPermCache, logAction,
  pageParams, pageMeta, clampPage
};
