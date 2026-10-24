'use strict';
/**
 * 前端静态检查：不启动浏览器，直接加载前端脚本，验证
 * 1. 所有脚本能正常解析并注册页面
 * 2. 菜单里每个 key 都有对应的页面函数
 * 3. 每个页面在给定数据下能渲染出 HTML 而不抛错
 * 4. 销售员视角下不出现成本列
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WEB = path.join(__dirname, '..', 'src', 'web');
const FILES = ['core.js', 'pages-docs.js', 'pages-base.js', 'pages-reports.js', 'pages-trend.js', 'pages-admin.js'];

const fakeEl = () => ({
  innerHTML: '', value: '', textContent: '', style: {}, classList: { add() {}, remove() {}, toggle() {} },
  appendChild() {}, remove() {}, focus() {}, click() {}, addEventListener() {},
  querySelector: () => null, querySelectorAll: () => [], setAttribute() {}, getAttribute: () => null
});

const sandbox = {
  console,
  document: {
    getElementById: () => fakeEl(),
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => fakeEl(),
    addEventListener() {},
    body: fakeEl()
  },
  window: { addEventListener() {}, scrollTo() {}, location: { href: '' } },
  localStorage: { getItem: () => '', setItem() {}, removeItem() {} },
  fetch: async () => ({ status: 200, json: async () => ({ ok: true, data: { list: [], stats: {}, warehouses: [] } }) }),
  setTimeout, clearTimeout, URL, URLSearchParams,
  Blob: class { constructor() {} }
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

let failed = 0;
const fail = (m) => { console.error('  ✗ ' + m); failed++; };
const pass = (m) => console.log('  ✓ ' + m);

const ALL_PERMS = [
  'outbound.view','outbound.create','outbound.edit','outbound.delete','outbound.audit','outbound.void','outbound.invoice',
  'inbound.view','inbound.create','inbound.edit','inbound.delete','inbound.audit','inbound.void','inbound.pay',
  'sret.view','sret.create','sret.audit','sret.void','pret.view','pret.create','pret.audit','pret.void',
  'customer.view','customer.create','customer.edit','customer.delete',
  'supplier.view','supplier.create','supplier.edit','supplier.delete',
  'material.view','material.create','material.edit','material.delete',
  'warehouse.view','warehouse.manage','inventory.view','inventory.log',
  'check.view','check.create','check.audit','check.void',
  'report.carryover','report.summary','report.profit','ar.view','ap.view',
  'payment.receive','payment.pay','cost.view','user.manage','log.view',
  'setting.manage','backup.manage','migration.manage'
];

const EXPORTS = {
  'core.js': ['App', 'PAGES', 'MENU', 'ROLE_NAME'],
  'pages-docs.js': ['DOC_CONF', 'DocState'],
  'pages-base.js': ['BaseState'],
  'pages-reports.js': ['RepState'],
  'pages-trend.js': ['TrendState'],
  'pages-admin.js': ['AdminState']
};

console.log('\n========== 前端静态检查 ==========\n');

/* 加载脚本；core.js 之后注入身份 */
for (const f of FILES) {
  const code = fs.readFileSync(path.join(WEB, f), 'utf8');
  const epilogue = (EXPORTS[f] || []).map(n => `try{globalThis.${n}=${n};}catch(e){}`).join('\n');
  try {
    vm.runInContext(code + '\n;' + epilogue, sandbox, { filename: f });
    pass(`加载 ${f}`);
    if (f === 'core.js') {
      sandbox.App.token = 'test-token';
      sandbox.App.user = { id: 1, username: 'admin', name: '超级管理员', role: 'admin' };
      sandbox.App.perms = new Set(ALL_PERMS);
    }
  } catch (e) {
    fail(`加载 ${f} 失败：${e.message}`);
  }
}

const PAGES = sandbox.PAGES;
const MENU = sandbox.MENU;
if (!PAGES) { fail('PAGES 未定义'); process.exit(1); }

/* 菜单与页面一一对应 */
const menuKeys = [];
for (const g of MENU) for (const it of g.items) menuKeys.push(it.key);
console.log(`\n菜单 ${menuKeys.length} 项：${menuKeys.join(', ')}\n`);
for (const k of menuKeys) {
  if (typeof PAGES[k] !== 'function') fail(`菜单项 ${k} 没有页面函数`);
  else pass(`${k} 已注册`);
}

/* 逐个渲染 */
console.log('\n--- 渲染页面 ---\n');
for (const k of menuKeys) {
  if (typeof PAGES[k] !== 'function') continue;
  try {
    const html = PAGES[k]();
    if (typeof html !== 'string' || html.length < 20) fail(`${k} 渲染结果异常`);
    else pass(`${k} → ${html.length} 字符`);
  } catch (e) {
    fail(`${k} 渲染抛错：${e.message}`);
  }
}

/* afterRender */
console.log('\n--- afterRender ---\n');
let withAfter = 0;
for (const k of menuKeys) if (PAGES[k] && typeof PAGES[k].afterRender === 'function') withAfter++;
if (!withAfter) fail('没有任何页面挂载 afterRender（page() 返回值可能有问题）');
else pass(`${withAfter} 个页面挂载了 afterRender`);

/* 销售员视角 */
console.log('\n--- 销售员视角 ---\n');
sandbox.App.user = { id: 9, username: 'sales1', name: '销售一号', role: 'sales' };
sandbox.App.perms = new Set(['outbound.view', 'outbound.create', 'customer.view', 'material.view', 'inventory.view', 'inventory.log', 'warehouse.view']);
for (const k of ['out', 'customers', 'inventory']) {
  try {
    const html = PAGES[k]();
    if (/<th[^>]*>成本/.test(html)) fail(`${k} 仍显示成本列`);
    else pass(`${k} 无成本列`);
  } catch (e) { fail(`${k} 渲染抛错：${e.message}`); }
}

/* 整壳渲染：模拟真实流程，验证 render() 能拼出完整页面 */
console.log('\n--- 整壳 render() ---\n');
let lastHtml = '';
const origGet = sandbox.document.getElementById;
sandbox.document.getElementById = (id) => {
  const el = fakeEl();
  const desc = Object.getOwnPropertyDescriptor(el, 'innerHTML');
  Object.defineProperty(el, 'innerHTML', {
    get() { return desc.get ? desc.get.call(el) : el._h || ''; },
    set(v) { el._h = v; if (id === 'app') lastHtml = v; }
  });
  return el;
};
sandbox.App.user = { id: 1, username: 'admin', name: '超级管理员', role: 'admin' };
sandbox.App.perms = new Set(ALL_PERMS);
try {
  vm.runInContext('App.route="dashboard"; render();', sandbox, { filename: 'render' });
  if (lastHtml.includes('万楼进销存') && lastHtml.includes('导航') === false && lastHtml.includes('class="nav"')) {
    pass(`render() 输出 ${lastHtml.length} 字符，含侧边栏与内容区`);
  } else if (lastHtml.length > 500) {
    pass(`render() 输出 ${lastHtml.length} 字符`);
  } else {
    fail('render() 输出过短：' + lastHtml.slice(0, 120));
  }
  if (!lastHtml.includes('undefined</')) pass('输出无明显的 undefined 拼接');
  else fail('输出中出现了 undefined');
} catch (e) {
  fail('render() 抛错：' + e.message);
}

/* 无权限路由回落 */
console.log('\n--- 无权限路由回落 ---\n');
sandbox.App.perms = new Set(['outbound.view']);
try {
  vm.runInContext('App.route="users"; render();', sandbox, { filename: 'render2' });
  const cur = vm.runInContext('App.route', sandbox);
  if (cur === 'dashboard') pass('无权限路由已回落到看板');
  else fail('无权限路由未回落，当前=' + cur);
} catch (e) { fail('回落测试抛错：' + e.message); }

sandbox.document.getElementById = origGet;

console.log('\n========== 检查结束 ==========');
console.log(failed ? `发现 ${failed} 个问题` : '全部通过');
console.log('');
process.exit(failed ? 1 : 0);