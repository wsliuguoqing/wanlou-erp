/* 核心工具：请求、状态、格式化、UI 组件 */
'use strict';

const App = {
  token: localStorage.getItem('wl_token') || '',
  user: null,
  perms: new Set(),
  settings: {},
  cache: {},
  route: 'dashboard'
};

/* ---------------- 请求 ---------------- */
async function api(path, method = 'GET', body) {
  const res = await fetch('/api' + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(App.token ? { Authorization: 'Bearer ' + App.token } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  let json;
  try { json = await res.json(); } catch { throw new Error('服务器返回异常'); }
  if (res.status === 401) { logout(true); throw new Error('登录已过期，请重新登录'); }
  if (!json.ok) {
    const err = new Error(json.message || '操作失败');
    err.retryAfter = json.retryAfter; // 登录输错太多被锁时的剩余秒数
    throw err;
  }
  return json.data;
}

/* ---------------- 权限 ---------------- */
function can(p) { return App.perms.has(p); }
function need(p, msg) { if (!can(p)) { toast(msg || '没有该操作权限', 'err'); return false; } return true; }

/* ---------------- 格式化 ---------------- */
const money = n => (Number(n) || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qty = n => {
  const v = Number(n) || 0;
  return Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/\.?0+$/, '');
};
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const monthStart = () => todayStr().slice(0, 8) + '01';

/* ---------------- 提示 ---------------- */
function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  document.getElementById('toast-root').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, 2200);
  setTimeout(() => el.remove(), 2600);
}

/* ---------------- 弹窗 ---------------- */
function openDialog({ title, body, footer, size = '', onMount }) {
  const root = document.getElementById('modal-root');
  root.innerHTML = `
    <div class="mask">
      <div class="dialog ${size}">
        <div class="dlg-head">
          <h3>${esc(title)}</h3>
          <button class="x" onclick="closeDialog()">×</button>
        </div>
        <div class="dlg-body">${body}</div>
        ${footer ? `<div class="dlg-foot">${footer}</div>` : ''}
      </div>
    </div>`;
  if (onMount) onMount(root);
  const first = root.querySelector('input:not([type=hidden]),select,textarea');
  if (first) setTimeout(() => first.focus(), 40);
}
function closeDialog() { document.getElementById('modal-root').innerHTML = ''; }

/* ---------------- 输入格式限制 ---------------- */
/** 只允许数字、横线（固话/手机都适用） */
function onlyPhone(el) {
  el.value = el.value.replace(/[^\d-]/g, '').slice(0, 20);
}
/** 只允许 11 位纯数字（手机号） */
function onlyMobile(el) {
  el.value = el.value.replace(/\D/g, '').slice(0, 11);
}
/** 非负数字，可限定小数位 */
function onlyPositive(el, decimals = 3) {
  let v = el.value.replace(/[^\d.]/g, '');
  const parts = v.split('.');
  if (parts.length > 2) v = parts[0] + '.' + parts.slice(1).join('');
  if (decimals === 0) v = v.split('.')[0];
  else if (parts[1] !== undefined) v = parts[0] + '.' + parts[1].slice(0, decimals);
  el.value = v;
}
/** 失焦时把空值或负值归零 */
function normalizeNum(el, min = 0) {
  const n = Number(el.value);
  if (!el.value || isNaN(n) || n < min) el.value = min === 0 ? '' : String(min);
}

function confirmDialog(msg, onYes, yesText = '确定') {
  openDialog({
    title: '请确认',
    size: 'sm',
    body: `<div style="font-size:13.5px;line-height:1.8">${esc(msg)}</div>`,
    footer: `<button class="btn" onclick="closeDialog()">取消</button>
             <button class="btn primary" id="dlg-yes">${esc(yesText)}</button>`
  });
  document.getElementById('dlg-yes').onclick = () => { closeDialog(); onYes(); };
}

function promptDialog({ title, label, value = '', multiline = false, onOk }) {
  openDialog({
    title,
    size: 'sm',
    body: `<div class="field"><label>${esc(label)}</label>
      ${multiline
        ? `<textarea class="inp" id="pd-v" rows="3">${esc(value)}</textarea>`
        : `<input class="inp" id="pd-v" value="${esc(value)}">`}</div>`,
    footer: `<button class="btn" onclick="closeDialog()">取消</button>
             <button class="btn primary" id="pd-ok">确定</button>`
  });
  document.getElementById('pd-ok').onclick = () => {
    const v = document.getElementById('pd-v').value.trim();
    closeDialog();
    onOk(v);
  };
}

/* ---------------- 页面切换 ---------------- */
function go(route) {
  App.route = route;
  render();
  window.scrollTo(0, 0);
}

/* ---------------- 渲染外壳 ---------------- */
const MENU = [
  { group: '工作台', items: [{ key: 'dashboard', label: '首页看板' }] },
  { group: '单据', items: [
    { key: 'out', label: '出库单', perm: 'outbound.view' },
    { key: 'in', label: '入库单', perm: 'inbound.view' },
    { key: 'sret', label: '销售退货', perm: 'sret.view' },
    { key: 'pret', label: '采购退货', perm: 'pret.view' }
  ]},
  { group: '基础资料', items: [
    { key: 'customers', label: '客户管理', perm: 'customer.view' },
    { key: 'suppliers', label: '供应商管理', perm: 'supplier.view' },
    { key: 'materials', label: '物料管理', perm: 'material.view' },
    { key: 'warehouses', label: '仓库管理', perm: 'warehouse.view' }
  ]},
  { group: '库存', items: [
    { key: 'inventory', label: '库存查询', perm: 'inventory.view' },
    { key: 'logs', label: '库存流水', perm: 'inventory.log' },
    { key: 'checks', label: '库存盘点', perm: 'check.view' }
  ]},
  { group: '报表', items: [
    { key: 'carryover', label: '待结转库存', perm: 'report.carryover' },
    { key: 'summary', label: '进销存汇总', perm: 'report.summary' },
    { key: 'profit', label: '经营分析', perm: 'report.profit' },
    { key: 'receivable', label: '应收账款', perm: 'ar.view' },
    { key: 'payable', label: '应付账款', perm: 'ap.view' }
  ]},
  { group: '系统', items: [
    { key: 'users', label: '员工管理', perm: 'user.manage' },
    { key: 'roles', label: '角色权限', perm: 'user.manage' },
    { key: 'oplogs', label: '操作日志', perm: 'log.view' },
    { key: 'settings', label: '系统设置', perm: 'setting.manage' },
    { key: 'me', label: '我的账号' }
  ]}
];

const ROLE_NAME = { sales: '销售员', purchaser: '采购员', finance: '财务', manager: '主管', admin: '超级管理员' };

function render() {
  const root = document.getElementById('app');
  if (!App.user) { root.innerHTML = renderLogin(); return; }

  // 当前路由若没有权限，回落到看板，避免渲染出空白页
  const allowed = new Set();
  for (const g of MENU) for (const i of g.items) if (!i.perm || can(i.perm)) allowed.add(i.key);
  if (!allowed.has(App.route)) App.route = 'dashboard';

  const navHtml = MENU.map(g => {
    const items = g.items.filter(i => !i.perm || can(i.perm));
    if (!items.length) return '';
    return `<div class="nav-g">${g.group}</div>` + items.map(i =>
      `<a class="${App.route === i.key ? 'on' : ''}" onclick="go('${i.key}')">${i.label}</a>`
    ).join('');
  }).join('');

  const pageFn = PAGES[App.route] || PAGES.dashboard;
  const title = findTitle(App.route);

  root.innerHTML = `
    <div class="app">
      <aside class="side">
        <div class="brand"><b>万楼进销存</b><small>河南万楼商贸有限公司</small></div>
        <nav class="nav">${navHtml}</nav>
        <div class="side-foot"><b>${esc(App.user.name)}</b>${ROLE_NAME[App.user.role] || App.user.role}</div>
      </aside>
      <div class="main">
        <div class="top">
          <div class="crumb">${title.crumb}</div>
          <div class="spacer"></div>
          <div class="who">${esc(App.user.name)} · ${ROLE_NAME[App.user.role] || ''}</div>
          <button class="btn sm" onclick="go('me')">我的账号</button>
          <button class="btn sm" onclick="logout()">退出</button>
        </div>
        <div class="content" id="page">${pageFn()}</div>
      </div>
    </div>`;
  if (pageFn.afterRender) pageFn.afterRender();
}

function findTitle(key) {
  for (const g of MENU) for (const i of g.items) if (i.key === key) return { crumb: `${g.group} / <b>${i.label}</b>` };
  return { crumb: '首页' };
}

/* ---------------- 登录 ---------------- */
/* 登录失败时把已填的账号密码回填，用户改一个字就能重试，不用重打 */
function renderLogin(err, username, password) {
  return `<div class="login">
    <div class="login-left">
      <div>
        <h1>让每一支胶带<br><span>都有账可查</span></h1>
        <p>入库、出库、母卷分切、库存流水、应收应付，全部在一套系统里跑通。销售看不到成本，财务看得到利润，谁能删数据由超级管理员说了算。</p>
      </div>
      <footer>河南万楼商贸有限公司 · 进销存系统</footer>
    </div>
    <div class="login-right">
      <h2>登录</h2>
      <p>请输入账号和密码</p>
      ${err ? `<div class="login-err">${esc(err)}</div>` : ''}
      <div class="login-field"><label>账号</label><input id="lg-u" autocomplete="username" value="${esc(username || '')}"></div>
      <div class="login-field"><label>密码</label><input id="lg-p" type="password" autocomplete="current-password"
        value="${esc(password || '')}"
        onkeydown="if(event.key==='Enter')doLogin()"></div>
      <button class="login-btn" onclick="doLogin()">登 录</button>
      <div class="login-tip">
        首次使用请输入超级管理员账号 admin，密码 admin123，登录后请立即修改密码。
      </div>
    </div>
  </div>`;
}

/* 登录锁定倒计时：输错 3 次后按钮变灰，按秒数倒计时，到点自动恢复 */
let loginLockTimer = null;

function startLoginLock(sec) {
  if (loginLockTimer) { clearInterval(loginLockTimer); loginLockTimer = null; }
  let left = Math.max(1, Math.round(Number(sec) || 60));
  const paint = () => {
    const btn = document.querySelector('.login-btn');
    const errEl = document.querySelector('.login-err');
    if (left > 0) {
      if (btn) { btn.disabled = true; btn.textContent = `请等待 ${left} 秒`; }
      if (errEl) errEl.textContent = `密码连续输错 3 次，请 ${left} 秒后再试`;
      left -= 1;
      return;
    }
    clearInterval(loginLockTimer); loginLockTimer = null;
    if (btn) { btn.disabled = false; btn.textContent = '登 录'; }
    if (errEl) errEl.textContent = '现在可以重新登录了';
  };
  paint();
  loginLockTimer = setInterval(paint, 1000);
}

async function doLogin() {
  if (loginLockTimer) return; // 倒计时没走完，点了也不发请求
  const u = document.getElementById('lg-u').value.trim();
  const p = document.getElementById('lg-p').value;
  const rerender = msg => {
    document.getElementById('app').innerHTML = renderLogin(msg, u, p);
    const pw = document.getElementById('lg-p');
    if (pw) { pw.focus(); pw.setSelectionRange(pw.value.length, pw.value.length); }
  };
  if (!u || !p) { rerender('请输入账号和密码'); return; }
  try {
    const d = await api('/auth/login', 'POST', { username: u, password: p });
    if (loginLockTimer) { clearInterval(loginLockTimer); loginLockTimer = null; }
    App.token = d.token;
    App.user = d.user;
    localStorage.setItem('wl_token', d.token);
    await loadMe();
    go('dashboard');
  } catch (e) {
    rerender(e.message);
    if (e.retryAfter) startLoginLock(e.retryAfter);
  }
}

async function loadMe() {
  const d = await api('/auth/me');
  App.user = d.user;
  App.perms = new Set(d.permissions);
}

async function logout(silent) {
  try { if (!silent) await api('/auth/logout', 'POST'); } catch {}
  App.token = ''; App.user = null; App.perms = new Set();
  localStorage.removeItem('wl_token');
  render();
}

/* ---------------- 通用页面辅助 ---------------- */
const PAGES = {};

/* 注册页面。传函数则注册并返回它（支持 page('x').afterRender = ...）；
   不传函数则只取已注册的页面，不会覆盖。 */
function page(name, fn) {
  if (typeof fn === 'function') { PAGES[name] = fn; return fn; }
  return PAGES[name];
}

function tableWrap(headers, rows, emptyText = '暂无数据') {
  if (!rows.length) return `<div class="card"><div class="empty">${emptyText}</div></div>`;
  return `<div class="tw"><table>
    <thead><tr>${headers.map(h => `<th class="${h.r ? 'r' : ''}">${h.label}</th>`).join('')}</tr></thead>
    <tbody>${rows.join('')}</tbody>
  </table></div>`;
}

/* ---------------- 分页 ---------------- */
/* 每个列表各自记住页码、每页条数和筛选条件：翻页不丢筛选，改筛选回到第 1 页 */
const Pager = {};
const Filters = {};

function pgState(key, size = 50) {
  if (!Pager[key]) Pager[key] = { page: 1, size };
  return Pager[key];
}
function filterState(key) {
  if (!Filters[key]) Filters[key] = {};
  return Filters[key];
}
/** 改筛选条件：记下来并回到第 1 页 */
function setFilter(key, patch) {
  Object.assign(filterState(key), patch);
  pgState(key).page = 1;
}
/** 拼到接口地址后面的分页参数 */
function pgQuery(key) {
  const s = pgState(key);
  return `page=${s.page}&size=${s.size}`;
}
function callLoader(loader) {
  const fn = typeof loader === 'string' ? window[loader] : loader;
  if (typeof fn === 'function') return fn();
}
function pgGo(key, loader, page) {
  const s = pgState(key);
  const p = Math.floor(Number(page));
  s.page = Number.isFinite(p) && p >= 1 ? p : 1;
  callLoader(loader);
}
function pgSize(key, loader, el) {
  const s = pgState(key);
  let n = Math.floor(Number(el.value));
  if (!Number.isFinite(n) || n < 1) n = 50;
  if (n > 500) n = 500;
  el.value = n;
  s.size = n; s.page = 1;
  callLoader(loader);
}
/** 分页条：首页/上一页/下一页/末页 + 跳页 + 每页条数 */
function pagerBar(key, meta, loader, unit = '条') {
  if (!meta || !meta.total) return '';
  const btn = (label, page, off) =>
    `<button class="btn sm" ${off ? 'disabled' : ''} onclick="pgGo('${key}','${loader}',${page})">${label}</button>`;
  return `<div class="pager">
    <span class="hint">共 ${meta.total} ${unit}，第 <b>${meta.page}</b> / ${meta.pages} 页</span>
    ${btn('首页', 1, meta.page <= 1)}${btn('上一页', meta.page - 1, meta.page <= 1)}
    ${btn('下一页', meta.page + 1, meta.page >= meta.pages)}${btn('末页', meta.pages, meta.page >= meta.pages)}
    <span class="spacer"></span>
    <span class="hint">跳到</span>
    <input class="inp num pg-jump" type="number" min="1" max="${meta.pages}" value="${meta.page}"
      onchange="pgGo('${key}','${loader}',this.value)">
    <span class="hint">页，每页</span>
    <input class="inp num pg-size" type="number" min="1" max="500" value="${meta.size}"
      onchange="pgSize('${key}','${loader}',this)">
    <span class="hint">条</span>
  </div>`;
}

function statusTag(s) {
  const map = {
    draft: ['mute', '草稿'], pending: ['wait', '待审核'], approved: ['ok', '已审核'],
    rejected: ['no', '已驳回'], void: ['mute', '已作废']
  };
  const [cls, txt] = map[s] || ['mute', s];
  return `<span class="tag ${cls}">${txt}</span>`;
}

function payTag(s) {
  if (s === 'paid') return '<span class="tag ok">已结清</span>';
  if (s === 'partial') return '<span class="tag wait">部分结清</span>';
  return '<span class="tag mute">未结清</span>';
}
