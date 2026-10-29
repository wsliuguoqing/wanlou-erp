'use strict';
/**
 * 端到端测试：模拟真实业务全流程
 * 用法：node test/flow-test.js
 */
const BASE = process.env.TEST_BASE || 'http://127.0.0.1:3000';
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
  const adminId = login.user.id;
  await api('/api/users/' + adminId, 'PUT', { employee_no: 'ADMIN-TEST' });

  /* 2. 建仓库、客户、供应商 */
  const wh = await api('/api/warehouses', 'POST', { name: '测试仓' + Date.now(), address: '郑州' });
  log('建仓库', wh);

  const ts = Date.now();
  const filterSales = await api('/api/users', 'POST', {
    username: 'filter_sales_' + ts, name: '筛选销售员', employee_no: 'F' + ts,
    password: 'sales123', role: 'sales'
  });
  const cust = await api('/api/customers', 'POST', {
    name: '洛阳屹程机电' + ts, contact: '王工', phone: '13800000001', level: 'A', salesperson_id: filterSales.id
  });
  log('建客户', cust);
  const customersBySales = await api('/api/customers?salesperson_id=' + filterSales.id);
  assert(customersBySales.list.some(c => c.id === cust.id), '客户管理可按负责销售人员筛选');

  const supName = '3M中国' + ts;
  const sup = await api('/api/suppliers', 'POST', { name: supName, contact: '张经理', phone: '02100000002' });
  log('建供应商', sup);

  /* 整进零出：数量相加、采购/销售单价单位及 0.1 米精度 */
  const mCable = await api('/api/materials', 'POST', {
    name: '测试电缆' + ts, model: 'CABLE-' + ts, brand: '测试品牌', spec: '100米/卷', unit: '卷', type: 'master', sub_unit: '米', base_width: 100
  });

  const cableWholeOnly = await api('/api/docs/in', 'POST', {
    warehouse_id: wh.id, partner_id: sup.id, submit: false,
    items: [{ material_id: mCable.id, qty_whole: 1.25, qty_sub: 0, price: 200 }]
  });
  const cableWholeOnlyDetail = await api('/api/docs/in/' + cableWholeOnly.id);
  assert(cableWholeOnlyDetail.items[0].qty === 125 && cableWholeOnlyDetail.items[0].amount === 250,
    '仅整单位入库时支持小数数量并按整单位单价计算金额');

  const cableLooseOnly = await api('/api/docs/in', 'POST', {
    warehouse_id: wh.id, partner_id: sup.id, submit: false,
    items: [{ material_id: mCable.id, qty_whole: 0, qty_sub: 50, price: 2 }]
  });
  const cableLooseOnlyDetail = await api('/api/docs/in/' + cableLooseOnly.id);
  assert(cableLooseOnlyDetail.items[0].amount === 100, '仅拆分单位入库时按最小单位单价计算总金额');

  const cableIn = await api('/api/docs/in', 'POST', {
    warehouse_id: wh.id, partner_id: sup.id, contract_sn: 'PO-' + ts,
    items: [{ material_id: mCable.id, qty_whole: 1, qty_sub: 50, price: 2 }]
  });
  const cableInDetail = await api('/api/docs/in/' + cableIn.id);
  assert(cableInDetail.items[0].qty === 150, '整进零出入库：1 卷 + 50 米合计 150 米');
  assert(cableInDetail.items[0].amount === 300, '入库含拆分数量时整件和散件统一按最小单位单价计价');
  await api('/api/docs/' + cableIn.id + '/approve', 'POST');
  const inFilter = new URLSearchParams({ supplier: supName, contract: 'PO-' + ts,
    model: 'CABLE-' + ts, status: 'approved', from: cableInDetail.doc_date, to: cableInDetail.doc_date });
  const filteredIn = await api('/api/docs/in?' + inFilter);
  assert(filteredIn.list.some(d => d.id === cableIn.id), '入库列表可组合筛选供应商、合同、型号、状态和日期');
  const inventoryFilter = new URLSearchParams({ brand: '测试品牌', keyword: 'CABLE-' + ts, uploaded_by: String(adminId) });
  const filteredInventory = await api('/api/inventory?' + inventoryFilter);
  assert(filteredInventory.list.some(r => r.material_id === mCable.id && r.uploader_name === '超级管理员'),
    '库存可按品牌、物料关键词和上传员工筛选');
  const cableOrigin = await api('/api/docs/lookup/' + encodeURIComponent(cableInDetail.sn));
  assert(cableOrigin.items[0].material_type === 'master' && cableOrigin.items[0].qty_sub === 50 && cableOrigin.items[0].price_basis === 'sub',
    '采购退货原单保留零单位数量和原单价口径');
  const cablePret = await api('/api/docs/pret', 'POST', {
    warehouse_id: wh.id, partner_id: sup.id, origin_doc_id: cableIn.id, submit: false,
    items: [{ material_id: mCable.id, qty: 2, qty_whole: 0, qty_sub: 2, price: 2, price_basis: 'sub' }]
  });
  const cablePretDetail = await api('/api/docs/pret/' + cablePret.id);
  assert(cablePretDetail.items[0].qty === 2 && cablePretDetail.items[0].amount === 4,
    '按最小单位采购价录入的物料退货按最小单位计算金额');
  let cableStock = await api('/api/inventory');
  let cableRow = cableStock.list.find(r => r.material_id === mCable.id);
  assert(cableRow.qty === 1 && cableRow.sub_qty === 50, '整进零出库存保留 1 卷 + 50 米');

  const cableOut = await api('/api/docs/out', 'POST', {
    warehouse_id: wh.id, partner_id: cust.id,
    items: [{ material_id: mCable.id, qty_whole: 0, qty_sub: 20.2, price: 4.5 }]
  });
  const cableOutDetail = await api('/api/docs/out/' + cableOut.id);
  assert(cableOutDetail.items[0].qty === 20.2 && cableOutDetail.items[0].amount === 90.9, '出库支持 0.1 米，销售单价按米计价');
  await api('/api/docs/' + cableOut.id + '/approve', 'POST');
  cableStock = await api('/api/inventory');
  cableRow = cableStock.list.find(r => r.material_id === mCable.id);
  assert(cableRow.qty === 1 && Math.abs(cableRow.sub_qty - 29.8) < 1e-8, '出库后库存为 1 卷 + 29.8 米');
  const cableSummary = await api('/api/reports/summary?from=2026-10-01&to=2026-10-31');
  const cableReportRow = cableSummary.list.find(r => r.code === mCable.code);
  assert(cableReportRow && cableReportRow.unit === '米' && cableReportRow.in_qty === 150 && cableReportRow.out_qty === 20.2 && cableReportRow.closing === 129.8,
    '进销存汇总按米统计整进零出物料，不误按胶带支数统计');

  let rejectedMeterStep = false;
  try {
    await api('/api/docs/out', 'POST', {
      warehouse_id: wh.id, partner_id: cust.id,
      items: [{ material_id: mCable.id, qty_whole: 0, qty_sub: 0.25, price: 4.5 }]
    });
  } catch (e) { rejectedMeterStep = /0\.1/.test(e.message); }
  assert(rejectedMeterStep, '米数量拒绝小于 0.1 米步进的输入');

  await api('/api/docs/' + cableOut.id + '/void', 'POST');
  cableStock = await api('/api/inventory');
  cableRow = cableStock.list.find(r => r.material_id === mCable.id);
  assert(cableRow.qty === 1 && cableRow.sub_qty === 50, '作废出库单后精确回滚米数库存');

  const cablePretApproved = await api('/api/docs/pret', 'POST', {
    warehouse_id: wh.id, partner_id: sup.id, origin_doc_id: cableIn.id, submit: true,
    items: [{ material_id: mCable.id, origin_item_id: cableInDetail.items[0].id,
      qty: 2, qty_whole: 0, qty_sub: 2, price: 999, price_basis: 'sub' }]
  });
  await api('/api/docs/' + cablePretApproved.id + '/approve', 'POST');
  const cablePretApprovedDetail = await api('/api/docs/pret/' + cablePretApproved.id);
  assert(cablePretApprovedDetail.items[0].price === 2 && cablePretApprovedDetail.items[0].amount === 4,
    '采购退货按精确原单行单价计算，不接受退货页面传入的其他价格');
  const pretLogs = await api('/api/inventory/logs?material_id=' + mCable.id + '&page=1&size=50');
  const pretLog = (pretLogs.list || []).find(r => r.doc_sn === cablePretApprovedDetail.sn);
  assert(pretLog && pretLog.amount === 4, '采购退货库存流水金额与来源采购价一致');

  /* 3. 建物料：普通 + 母卷 */
  const mNormal = await api('/api/materials', 'POST', {
    name: '德莎胶带19mm' + ts, model: 'D-19', spec: '19mm×50m', brand: '德莎', unit: '卷', type: 'normal', cost: 12
  });
  log('建普通物料', mNormal);
  const materialCheck = await api('/api/materials?keyword=' + encodeURIComponent('D-19'));
  const listedMaterial = materialCheck.list.find(m => m.id === mNormal.id);
  assert(listedMaterial?.model === 'D-19' && listedMaterial?.spec === '19mm×50m' && listedMaterial?.brand === '德莎',
    '物料型号、规格、品牌作为独立字段保存并可搜索型号');
  await api('/api/materials/' + mNormal.id, 'PUT', {
    name: '德莎胶带19mm' + ts, model: 'D-19A', spec: '19mm×50m', brand: '德莎', unit: '卷', type: 'normal'
  });
  const editedMaterial = await api('/api/materials/' + mNormal.id);
  assert(editedMaterial.model === 'D-19A' && editedMaterial.spec === '19mm×50m', '编辑物料可分别更新型号和规格');
  const decimalInbound = await api('/api/docs/in', 'POST', {
    warehouse_id: wh.id, partner_id: sup.id, submit: false,
    items: [{ material_id: mNormal.id, qty: 1.25, price: 12.5 }]
  });
  const decimalInboundDetail = await api('/api/docs/in/' + decimalInbound.id);
  assert(decimalInboundDetail.items[0].qty === 1.25 && decimalInboundDetail.items[0].amount === 15.63,
    '普通物料入库支持小数数量和小数单价');
  const importName = '导入物料' + ts;
  const importCsv = ['物料名称,型号,规格,品牌,计量单位,物料形态', `${importName},IM-01,额定电压10kV,测试品牌,只,整进整出`].join('\n');
  await api('/api/import/materials', 'POST', { filename: 'materials.csv', content: Buffer.from(importCsv).toString('base64') });
  const imported = await api('/api/materials?keyword=' + encodeURIComponent(importName));
  assert(imported.list[0]?.model === 'IM-01' && imported.list[0]?.model_edited === 1 && imported.list[0]?.spec === '额定电压10kV',
    '物料 CSV 导入可分别读取型号和规格');

  const mMaster = await api('/api/materials', 'POST', {
    name: '3M胶带母卷' + ts, brand: '3M', spec: '1200mm', unit: '支', type: 'master',
    sub_unit: 'mm', base_width: 1200, cut_fee: 0.5, cost: 480
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
    warehouse_id: wh.id, partner_id: cust.id, contract_sn: 'SO-' + ts, doc_date: '2026-10-23',
    items: [
      { material_id: mNormal.id, qty: 30, price: 18 },
      { material_id: mMaster.id, qty: 30, price: 22, cut_width: 40 }
    ]
  });
  log('创建出库单', outDoc);
  const outDetail = await api('/api/docs/out/' + outDoc.id);
  console.log(`  单号 ${outDetail.sn}`);
  assert(/^CKADMIN-TEST\d{12}$/.test(outDetail.sn), '出库单号按 CK+工号+日期+4位序号生成');
  const outFilter = new URLSearchParams({ customer: '洛阳屹程机电' + ts, product: '德莎胶带19mm' + ts,
    brand: '德莎', material_keyword: 'D-19A', contract: 'SO-' + ts,
    salesperson: 'ADMIN-TEST', status: 'pending', from: '2026-10-23', to: '2026-10-23' });
  const filteredOut = await api('/api/docs/out?' + outFilter);
  assert(filteredOut.list.some(d => d.id === outDoc.id), '出库列表可组合筛选客户、产品、品牌、物料关键词、合同、销售人员、状态和日期');
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
  assert(rep.list.some(r => r.sn === outDetail.sn), '报表含本次出库单');

  /* 13. 应收 */
  const ar = await api('/api/reports/receivable');
  const myAr = ar.list.find(r => r.customer_id === cust.id);
  console.log('  本次客户应收：', myAr);
  assert(myAr && myAr.balance > 0, '产生了应收账款');

  /* 14. 收款 */
  await api('/api/docs/' + outDoc.id + '/payment', 'POST', { amount: 500, method: '银行转账' });
  const ar2 = await api('/api/reports/receivable');
  console.log('  收款后应收：', ar2.total);
  assert(ar2.total === ar.total - 500, '应收减少 500');

  /* 15. 销售退货 */
  const sourceNormalLine = outDetail.items.find(it => it.material_id === mNormal.id);
  const sret = await api('/api/docs/sret', 'POST', {
    warehouse_id: wh.id, partner_id: cust.id, origin_doc_id: outDoc.id, doc_date: '2026-10-23',
    items: [{ material_id: mNormal.id, origin_item_id: sourceNormalLine.id, qty: 5, price: 18 }]
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
  const salesName = 'test_sales' + ts;
  const salesUser = await api('/api/users', 'POST', {
    username: salesName, name: '测试销售', employee_no: 'T' + ts, password: 'sales123', role: 'sales'
  });
  let duplicateEmployeeNo = false;
  try {
    await api('/api/users', 'POST', {
      username: salesName + '_duplicate', name: '重复工号', employee_no: 'T' + ts,
      password: 'sales123', role: 'sales'
    });
  } catch (e) { duplicateEmployeeNo = /工号/.test(e.message); }
  assert(duplicateEmployeeNo, '员工工号不可重复');
  const savedToken = token;
  const login2 = await api('/api/auth/login', 'POST', { username: salesName, password: 'sales123' });
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
