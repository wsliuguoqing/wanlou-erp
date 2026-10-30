'use strict';
/**
 * 分页条回归测试：验证「下一页」真的会翻页
 *
 * 背景：出库单列表点「下一页」没反应。原因是 pagerBar 把 loader 直接拼进了
 * onclick 字符串，传函数时生成 onclick="pgGo('docs-out','() => loadDocList(key)',2)"
 * 这种非法代码，点击后浏览器直接报语法错，什么也不会发生。
 *
 * 现在 pagerBar 会把函数登记成 ld1 / ld2 …，onclick 里只放 id。
 * 这个测试确保：
 *   1. 生成的 HTML 里不出现函数体
 *   2. 拿着 HTML 里的 ref 调用 pgGo，loader 真的被执行，页码真的变了
 *   3. 同一个 loader 渲染两次，两个 ref 都能用（不会互相踩）
 *   4. 传字符串函数名的老写法仍然兼容
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WEB = path.join(__dirname, '..', 'src', 'web');

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
  fetch: async () => ({ status: 200, json: async () => ({ ok: true, data: {} }) }),
  setTimeout, clearTimeout, URL, URLSearchParams,
  Blob: class { constructor() {} }
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

let failed = 0;
const fail = m => { console.error('  ✗ ' + m); failed++; };
const pass = m => console.log('  ✓ ' + m);
const eq = (a, b, m) => (a === b ? pass(m) : fail(`${m}（期望 ${b}，实际 ${a}）`));

console.log('\n========== 分页「下一页」回归测试 ==========\n');

const code = fs.readFileSync(path.join(WEB, 'core.js'), 'utf8');
vm.runInContext(code + '\n;globalThis.__pg={pagerBar,pgGo,pgSize,pgState,Loaders};', sandbox, { filename: 'core.js' });
const { pagerBar, pgGo, pgSize, pgState } = sandbox.__pg;
pass('core.js 加载完成');

const meta = { total: 1107, page: 1, size: 50, pages: 23, hasPrev: false, hasNext: true };

/* ---- 1. 传函数：HTML 里不能出现函数体 ---- */
console.log('\n--- 1. 函数型 loader ---\n');
let calls = [];
const loader = () => { calls.push(pgState('docs-out').page); };
const html = pagerBar('docs-out', meta, loader, '张');

if (html.includes('function') || html.includes('=>')) fail('HTML 里仍然拼进了函数体');
else pass('HTML 里没有函数体');

const refs = [...html.matchAll(/pgGo\('docs-out','([^']+)',(\d+)\)/g)].map(m => m[1]);
if (!refs.length) fail('没找到 pgGo 调用');
else pass(`生成 ${refs.length} 个翻页按钮，ref=${refs[0]}`);
if (refs.every(r => /^ld\d+$/.test(r))) pass('ref 都是 ld 编号');
else fail('ref 格式异常：' + refs.join(','));

/* ---- 2. 点下一页真的翻页 ---- */
console.log('\n--- 2. 点击「下一页」 ---\n');
const nextMatch = html.match(/onclick="pgGo\('docs-out','(ld\d+)',2\)"/);
if (!nextMatch) fail('没有生成「下一页」按钮');
else {
  calls = [];
  pgGo('docs-out', nextMatch[1], 2);
  eq(pgState('docs-out').page, 2, '页码变成 2');
  eq(calls.length, 1, 'loader 被调用 1 次');
  eq(calls[0], 2, 'loader 读到的页码是 2');
}

/* ---- 3. 末页按钮 ---- */
console.log('\n--- 3. 跳到末页 ---\n');
const lastMatch = html.match(/onclick="pgGo\('docs-out','(ld\d+)',23\)"/);
if (!lastMatch) fail('没有生成「末页」按钮');
else {
  calls = [];
  pgGo('docs-out', lastMatch[1], 23);
  eq(pgState('docs-out').page, 23, '页码变成 23');
  eq(calls[0], 23, 'loader 读到 23');
}

/* ---- 4. 同一 loader 渲染两次，两个 ref 都能用 ---- */
console.log('\n--- 4. 重新渲染后的旧 ref ---\n');
const html2 = pagerBar('docs-out', { ...meta, page: 2 }, loader, '张');
const ref2 = [...html2.matchAll(/pgGo\('docs-out','([^']+)',(\d+)\)/g)].map(m => m[1])[0];
if (ref2 === refs[0]) fail('重新渲染后 ref 没有变化，可能与旧按钮冲突');
else pass(`新 ref=${ref2}，与旧 ref=${refs[0]} 不同`);
calls = [];
pgGo('docs-out', refs[0], 5);
eq(calls[0], 5, '旧 ref 仍然可用');
calls = [];
pgGo('docs-out', ref2, 7);
eq(calls[0], 7, '新 ref 可用');

/* ---- 5. 每页条数：改完回到第 1 页 ---- */
console.log('\n--- 5. 修改每页条数 ---\n');
pgState('docs-out').page = 9;
calls = [];
pgSize('docs-out', ref2, { value: '100' });
eq(pgState('docs-out').size, 100, '每页条数变成 100');
eq(pgState('docs-out').page, 1, '页码回到 1');
eq(calls[0], 1, 'loader 读到 1');

/* ---- 6. 字符串函数名兼容 ---- */
console.log('\n--- 6. 字符串型 loader（老写法） ---\n');
sandbox.window.loadDemoList = () => { calls.push(pgState('demo').page); };
const html3 = pagerBar('demo', meta, 'loadDemoList', '条');
const ref3 = html3.match(/pgGo\('demo','([^']+)',2\)/)[1];
eq(ref3, 'loadDemoList', '字符串 loader 原样保留');
calls = [];
pgGo('demo', ref3, 2);
eq(calls[0], 2, '通过 window 上的函数名调用成功');

/* ---- 7. 没有数据时不渲染分页条 ---- */
console.log('\n--- 7. 空数据 ---\n');
eq(pagerBar('empty', { total: 0, page: 1, size: 50, pages: 0 }, loader), '', '总数 0 时不显示分页条');

/* ---- 8. 第 1 页时「上一页」是禁用态 ---- */
console.log('\n--- 8. 首末页禁用态 ---\n');
const firstPageBtns = [...html.matchAll(/<button class="btn sm"\s+(disabled\s+)?onclick="pgGo\('docs-out','ld\d+',(\d+)\)">([^<]+)<\/button>/g)];
const prev = firstPageBtns.find(b => b[3] === '上一页');
const next = firstPageBtns.find(b => b[3] === '下一页');
eq(!!prev[1], true, '第 1 页「上一页」禁用');
eq(!!next[1], false, '第 1 页「下一页」可点');

console.log('\n========== 测试结束 ==========');
console.log(failed ? `发现 ${failed} 个问题` : '全部通过');
console.log('');
process.exit(failed ? 1 : 0);
