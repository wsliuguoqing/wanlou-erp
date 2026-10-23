'use strict';
/**
 * 端到端测试：模拟真实业务全流程
 * 用法：node test/flow-test.js
 */
const BASE = 'http://127.0.0.1:3000';
let token = '';

async function api(path, method = 'GET', body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`${method} ${path} -> ${json.message}`);
  return json.data;
}
function log(title, data) {
  console.log('\n✓ ' + title);
  if (data !== undefined) console.log('  ' + JSON.stringify(data).slice(0, 300));
}
function assert(cond, msg) {
  if (!cond) { console.error('✗ 断言失败:', msg); process.exitCode = 1; }
  else console.log('  ✓ ' + msg);
}

(async () => {
  console.log('\n========== 万楼进销存 端到端测试 ==========\n');

  /* 1. 登录 */
  const login = await api('/api/auth/login', 'POST', { username: 'admin', password: 'admin123' });
  token = login.token;
  log('超管登录', login.user);

  /* 2. 建仓库、客户、供应商 */
  const wh = await api('/api/warehouses', 'POST', { name: '测试仓A', address: '郑州' });
  log('建仓库', wh);

  const cust = await api('/api/customers', 'POST', {
    name: '洛阳屹程机电设备安装工程有限公司', contact: '王工', phone: '13800000001', level: 'A'
  });
  log('建客户', cust);

  const sup = await api('/api/suppliers', 'POST', { name: '3M中国', contact: '张经理', phone: '02100000002' });
  log('建供应商', sup);

  /* 3. 建物料：普通 + 母卷 */
  const mNormal = await api('/api/materials', 'POST', {
    name: '德莎胶带19mm', brand: '德莎', spec: '19mm×50m', unit: '卷', type: 'normal', cost: 12
  });
  log('建普通物料', mNormal);

  const mMaster = await api('/api/materials', 'POST', {
    name: '3M胶带母卷', brand: '3M', spec: '1200mm', unit: '支', type: 'master',
    base_width: 1200, cut_fee: 0.5, cost: 480
  });
  log('建母卷物料', mMaster);

  /* 4. 入库 */
  const inDoc = await api('/api/docs/in', 'POST', {
    warehouse_id: wh.id, partner_id: sup.id, doc_date: '2026-10-23',
    items: [
      { material_id: mNormal.id, qty: 100, price: 12 },
      { material_id: mMaster.id, qty: 2, price: 480 }
    ]
  });
  log('创建入库单', inDoc);

  const inDetail = await api('/api/docs/in/' + inDoc.id);
  console.log(`  单号 ${inDetail.sn}  金额 ${inDetail.total_amount}`);
  assert(inDetail.status === 'pending', '入库单提交后为待审核');
  assert(inDetail.total_amount === 100 * 12 + 2 * 480, '入库单金额正确 = 2160');

  /* 5. 审核入库 */
  await api('/api/docs/' + inDoc.id + '/approve', 'POST');
  const inAfter = await api('/api/docs/in/' + inDoc.id);
  assert(inAfter.status === 'approved', '入库单审核通过');

  /* 6. 查库存 */
  let stock = await api('/api/inventory');
  const rowNormal = stock.list.find(r => r.material_id === mNormal.id);
  const rowMaster = stock.list.find(r => r.material_id === mMaster.id);
  console.log(`  普通物料库存 ${rowNormal.qty}  母卷 ${rowMaster.qty} 支 可用宽度 ${rowMaster.available_width}mm`);
  assert(rowNormal.qty === 100, '普通物料库存 100');
  assert(rowMaster.qty === 2, '母卷 2 支');
  assert(rowMaster.available_width === 2400, '母卷总可用宽度 2400mm');

  /* 7. 出库：普通物料 + 母卷分切 */
  const outDoc = await api('/api/docs/out', 'POST', {
    warehouse_id: wh.id, partner_id: cust.id, doc_date: '2026-10-23',
    items: [
      { material_id: mNormal.id, qty: 30, price: 18 },
      { material_id: mMaster.id, qty: 30, price: 22, cut_width: 40 }
    ]
  });
  log('创建出库单', outDoc);
  const outDetail = await api('/api/docs/out/' + outDoc.id);
  console.log(`  单号 ${outDetail.sn}`);
  outDetail.items.forEach(it => {
    console.log(`   - ${it.material_name} ${it.qty} 单价${it.price} 成本${it.cost_price}`);
  });
  assert(outDetail.status === 'pending', '出库单待审核');

  /* 8. 审核出库 */
  await api('/api/docs/' + outDoc.id + '/approve', 'POST');
  const outAfter = await api('/api/docs/out/' + outDoc.id);
  assert(outAfter.status === 'approved', '出库单审核通过');

  /* 9. 验证库存扣减 */
  stock = await api('/api/inventory');
  const n2 = stock.list.find(r => r.material_id === mNormal.id);
  const m2 = stock.list.find(r => r.material_id === mMaster.id);
  console.log(`  出库后：普通 ${n2.qty}  母卷 ${m2.qty}支 总宽 ${m2.available_width}mm`);
  assert(n2.qty === 70, '普通物料 100-30=70');
  assert(m2.available_width === 2400 - 40 * 30, `母卷宽度 2400-1200=1200mm`);

  /* 10. 子卷是否自动建档 */
  const mats = await api('/api/materials');
  const sub = mats.list.find(x => x.type === 'sub');
  assert(!!sub, '分切后自动创建子卷物料档案');
  if (sub) console.log(`  子卷档案 ${sub.code} ${sub.name} ${sub.spec} 成本 ${sub.cost}`);

  /* 11. 母卷明细 */
  const rolls = await api('/api/inventory/rolls?material_id=' + mMaster.id);
  console.log('  母卷明细：');
  rolls.list.forEach(r => console.log(`   #${r.id} 总宽${r.width_total} 已用${r.width_used} 剩余${r.remain_width} 状态${r.status}`));
  assert(rolls.list.length === 2, '两支母卷');

  /* 12. 利润报表 */
  const rep = await api('/api/reports/carryover?from=2026-10-01&to=2026-10-31');
  console.log('  待结转库存清单：');
  rep.list.forEach(r => console.log(`   ${r.sn} 客户${r.customer_name} 销售额${r.total_amount} 成本${r.total_cost} 毛利${r.profit} 毛利率${r.margin}`));
  console.log('  合计:', rep.summary);
  assert(rep.list.length === 1, '报表含 1 张出库单');

  /* 13. 应收 */
  const ar = await api('/api/reports/receivable');
  console.log('  应收账款：', ar.list, '合计', ar.total);
  assert(ar.list.length === 1 && ar.list[0].balance > 0, '产生了应收账款');

  /* 14. 收款 */
  await api('/api/docs/' + outDoc.id + '/payment', 'POST', { amount: 500, method: '银行转账' });
  const ar2 = await api('/api/reports/receivable');
  console.log('  收款后应收：', ar2.total);
  assert(ar2.total === ar.total - 500, '应收减少 500');

  /* 15. 销售退货 */
  const sret = await api('/api/docs/sret', 'POST', {
    warehouse_id: wh.id, partner_id: cust.id, doc_date: '2026-10-23',
    items: [{ material_id: mNormal.id, qty: 5, price: 18 }]
  });
  await api('/api/docs/' + sret.id + '/approve', 'POST');
  stock = await api('/api/inventory');
  const n3 = stock.list.find(r => r.material_id === mNormal.id);
  assert(n3.qty === 75, '退货 5 后库存 70+5=75');
  log('销售退货完成，库存回补', { qty: n3.qty });

  /* 16. 作废出库单，库存回滚 */
  await api('/api/docs/' + outDoc.id + '/void', 'POST', { reason: '测试作废' });
  stock = await api('/api/inventory');
  const n4 = stock.list.find(r => r.material_id === mNormal.id);
  const m4 = stock.list.find(r => r.material_id === mMaster.id);
  console.log(`  作废后：普通 ${n4.qty}  母卷宽度 ${m4.available_width}mm`);
  assert(n4.qty === 105, '作废后普通物料回滚 75+30=105');
  assert(m4.available_width === 2400, '作废后母卷宽度回滚为 2400');

  /* 17. 销售员权限隔离（新建销售员并验证看不到成本） */
  const salesUser = await api('/api/users', 'POST', {
    username: 'test_sales', name: '测试销售', password: 'sales123', role: 'sales'
  });
  const savedToken = token;
  const login2 = await api('/api/auth/login', 'POST', { username: 'test_sales', password: 'sales123' });
  token = login2.token;

  const docsForSales = await api('/api/docs/out');
  assert(docsForSales.list.every(d => d.total_cost === undefined), '销售员看不到成本字段');
  const invForSales = await api('/api/inventory');
  assert(invForSales.list.every(r => r.cost === undefined), '销售员看不到库存成本');
  assert(invForSales.stats.totalAmount === null, '销售员看不到库存总金额');

  let forbidden = false;
  try { await api('/api/reports/carryover'); } catch (e) { forbidden = /权限/.test(e.message); }
  assert(forbidden, '销售员访问利润报表被拒绝');

  let cantDelete = false;
  try { await api('/api/customers/' + cust.id, 'DELETE'); } catch (e) { cantDelete = /超级管理员/.test(e.message); }
  assert(cantDelete, '销售员不能删除客户');

  token = savedToken;
  await api('/api/users/' + salesUser.id, 'DELETE');
  log('销售员权限隔离验证完毕');

  console.log('\n========== 测试结束 ==========');
  console.log(process.exitCode ? '有不通过的断言，请查看上面 ✗ 项' : '全部通过');
  console.log('');
})().catch(e => {
  console.error('\n✗ 测试中断:', e.message);
  process.exit(1);
});
