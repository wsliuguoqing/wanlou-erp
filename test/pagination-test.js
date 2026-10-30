/* 分页功能测试 */
const http = require('http');

let token;
async function api(path, method = 'GET', body) {
  const res = await fetch('http://localhost:3000/api' + path, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.message);
  return json.data;
}

let failed = 0;
const ok = m => console.log('  ✓ ' + m);
const no = m => { console.log('  ✗ ' + m); failed++; };
function assert(c, m) { c ? ok(m) : no(m); }

(async () => {
  console.log('\n===== 分页功能测试 =====\n');

  token = await require('./login-helper').loginAt('http://localhost:3000/api/auth/login', 'admin', 'admin123');
  ok('超管登录');

  /* 准备测试数据：创建 60 条记录 */
  const rnd = Date.now().toString(36);
  for (let i = 1; i <= 60; i++) {
    await api('/customers', 'POST', { name: `分页测试客户${rnd}_${i}`, contact: '张工', phone: '13800000001' });
  }
  ok('创建了 60 个客户');

  /* 1. 默认分页（50 条） */
  const p1 = await api('/customers');
  assert(p1.list.length === 50, `默认每页 50 条（实际 ${p1.list.length}）`);
  assert(p1.page === 1, '默认第 1 页');
  assert(p1.pages >= 2, `总页数 ≥2（实际 ${p1.pages}）`);
  assert(p1.hasNext === true, '有下一页');
  assert(p1.hasPrev === false, '无上一页');

  /* 2. 自定义每页条数 */
  const p2 = await api('/customers?size=20');
  assert(p2.list.length === 20, `自定义每页 20 条（实际 ${p2.list.length}）`);
  assert(p2.pages >= 3, `总页数 ≥3（实际 ${p2.pages}）`);

  /* 3. 翻页 */
  const p3 = await api('/customers?page=2&size=20');
  assert(p3.page === 2, '第 2 页');
  assert(p3.list.length === 20, `第 2 页 20 条（实际 ${p3.list.length}）`);
  assert(p3.hasPrev === true, '有上一页');
  assert(p3.hasNext === true, '有下一页');

  /* 4. 末页 */
  const p4 = await api(`/customers?page=${p1.pages}&size=50`);
  assert(p4.page === p1.pages, `末页页码正确（${p4.page}）`);
  assert(p4.list.length <= 50, `末页数据不超过 50 条（实际 ${p4.list.length}）`);
  assert(p4.hasNext === false, '末页无下一页');

  /* 5. 越界页码：自动修正到末页 */
  const p5 = await api('/customers?page=9999');
  assert(p5.page === p1.pages, `越界页码修正到末页（${p5.page}）`);

  /* 6. 供应商分页 */
  for (let i = 1; i <= 30; i++) {
    await api('/suppliers', 'POST', { name: `分页测试供应商${rnd}_${i}`, contact: '李工', phone: '010-12345678' });
  }
  const s1 = await api('/suppliers?size=10');
  assert(s1.list.length === 10, `供应商分页生效（实际 ${s1.list.length}）`);
  ok('供应商分页正常');

  /* 7. 物料分页 */
  for (let i = 1; i <= 25; i++) {
    await api('/materials', 'POST', { name: `分页测试物料${rnd}_${i}`, unit: '套', type: 'normal', cost: 100 });
  }
  const m1 = await api('/materials?size=15');
  assert(m1.list.length === 15, `物料分页生效（实际 ${m1.list.length}）`);
  ok('物料分页正常');

  /* 8. 库存分页 */
  const inv = await api('/inventory?size=10');
  assert(typeof inv.page === 'number', '库存接口返回分页元信息');
  ok('库存分页正常');

  /* 9. 库存流水分页 */
  const logs = await api('/inventory/logs?size=20');
  assert(typeof logs.page === 'number', '流水接口返回分页元信息');
  ok('库存流水分页正常');

  /* 10. 单据列表分页 */
  const docs = await api('/docs?type=out&size=10');
  assert(typeof docs.page === 'number', '单据接口返回分页元信息');
  ok('单据列表分页正常');

  console.log(failed ? `\n❌ ${failed} 项失败` : '\n✅ 全部通过');
  process.exit(failed);
})().catch(e => {
  console.error('\n💥 测试异常：', e.message);
  process.exit(1);
});
