'use strict';
/**
 * 本轮修复项的专项测试
 * 覆盖：退货引用原单、库存不足拦截、仓库删除保护、物料类型与成本
 */
const BASE = process.env.WL_TEST_BASE || 'http://127.0.0.1:3999';
let token = '';

async function api(path, method = 'GET', body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
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
async function expectFail(fn, re, m) {
  try { await fn(); no(m + '（应该被拒绝但通过了）'); }
  catch (e) { re.test(e.message) ? ok(m) : no(`${m}（报错信息不符：${e.message}）`); }
}

(async () => {
  console.log('\n===== 修复项专项测试 =====\n');

  token = await require('./login-helper').loginAt(BASE + '/api/auth/login', 'admin', 'admin123');
  ok('超管登录');

  /* 准备基础数据 */
  const wh = await api('/api/warehouses', 'POST', { name: '测试仓B' });
  const cust = await api('/api/customers', 'POST', { name: '测试客户B', contact: '陈工', phone: '13900000002' });
  const supp = await api('/api/suppliers', 'POST', { name: '测试供应商B', contact: '赵工', phone: '010-88886666' });

  /* 1. 物料新建：不传 cost，返回应为 0 */
  const mat = await api('/api/materials', 'POST', {
    name: '10kV冷缩中间接头', spec: 'JLS-10/3.1', unit: '套', type: 'normal', cost: 999
  });
  const matList = await api('/api/materials');
  const m1 = matList.list.find(x => x.id === mat.id);
  assert(Number(m1.cost) === 0, '新建物料成本强制为 0（忽略前端传来的成本）');
  assert(matList.units && matList.units.length > 5, '接口返回常用单位列表');
  assert(matList.creatableTypes && Object.keys(matList.creatableTypes).length === 2, '可新建类型只有不可分割与可分割');

  /* 2. 物料类型校验 */
  await expectFail(() => api('/api/materials', 'POST', { name: '非法类型', unit: '个', type: 'sub' }),
    /不可分割|可分割/, '不允许手工新建子卷类型');
  await expectFail(() => api('/api/materials', 'POST', { name: '缺单位', type: 'normal' }),
    /单位/, '不填单位被拒绝');
  await expectFail(() => api('/api/materials', 'POST', { name: '母卷无宽度', unit: '支', type: 'master' }),
    /宽度/, '可分割物料必须填整支宽度');

  /* 3. 库存为 0 时，提交审核这一步就该被拒绝（不再拖到审核时才报错） */
  await expectFail(() => api('/api/docs/out', 'POST', {
    doc_date: '2026-10-24', partner_id: cust.id, warehouse_id: wh.id,
    items: [{ material_id: mat.id, qty: 5, price: 100 }], submit: true
  }), /不足|没有|库存/, '库存为 0 时提交审核被拒绝');

  /* 4. 入库 10 套 */
  const inDoc = await api('/api/docs/in', 'POST', {
    doc_date: '2026-10-24', partner_id: supp.id, warehouse_id: wh.id,
    items: [{ material_id: mat.id, qty: 10, price: 80 }], submit: true
  });
  await api(`/api/docs/${inDoc.id}/approve`, 'POST');
  const inv1 = await api(`/api/inventory?warehouse_id=${wh.id}`);
  const row1 = inv1.list.find(r => r.material_id === mat.id);
  assert(Number(row1.qty) === 10, '入库审核后库存为 10');
  assert(Number(row1.cost) === 80, '入库价成为移动加权成本');

  /* 5. 出库 4 套并审核 */
  const out1 = await api('/api/docs/out', 'POST', {
    doc_date: '2026-10-24', partner_id: cust.id, warehouse_id: wh.id,
    items: [{ material_id: mat.id, qty: 4, price: 120 }], submit: true
  });
  await api(`/api/docs/${out1.id}/approve`, 'POST');
  const outInfo = await api(`/api/docs/out/${out1.id}`);
  ok(`出库单 ${outInfo.sn} 已审核`);

  /* 6. 按单号查原单 */
  const lk = await api('/api/docs/lookup/' + outInfo.sn);
  assert(lk.doc.sn === outInfo.sn, '按单号查到原出库单');
  assert(lk.items[0].returnable === 4, '可退数量为 4');
  assert(lk.items[0].returned_qty === 0, '已退数量为 0');

  /* 未审核的单不能退 */
  const draft = await api('/api/docs/out', 'POST', {
    doc_date: '2026-10-24', partner_id: cust.id, warehouse_id: wh.id,
    items: [{ material_id: mat.id, qty: 1, price: 120 }], submit: false
  });
  const draftInfo = await api(`/api/docs/out/${draft.id}`);
  await expectFail(() => api('/api/docs/lookup/' + draftInfo.sn), /已审核/, '草稿单不能被退货引用');

  /* 7. 部分退货：退 1 套 */
  const sret1 = await api('/api/docs/sret', 'POST', {
    doc_date: '2026-10-24', partner_id: cust.id, warehouse_id: wh.id,
    origin_doc_id: out1.id,
    items: [{ material_id: mat.id, qty: 1, price: 120 }], submit: true
  });
  await api(`/api/docs/${sret1.id}/approve`, 'POST');
  const inv2 = await api(`/api/inventory?warehouse_id=${wh.id}`);
  assert(Number(inv2.list.find(r => r.material_id === mat.id).qty) === 7, '退货 1 后库存 6+1=7');

  const outList = await api('/api/docs/out');
  const outRow = outList.list.find(r => r.id === out1.id);
  assert(outRow.return_status === 'partial', '原单标记为部分退货');

  const lk2 = await api('/api/docs/lookup/' + outInfo.sn);
  assert(lk2.items[0].returned_qty === 1, '再查原单，已退数量变成 1');
  assert(lk2.items[0].returnable === 3, '剩余可退 3');

  /* 8. 全部退完 */
  const sret2 = await api('/api/docs/sret', 'POST', {
    doc_date: '2026-10-24', partner_id: cust.id, warehouse_id: wh.id,
    origin_doc_id: out1.id,
    items: [{ material_id: mat.id, qty: 3, price: 120 }], submit: true
  });
  await api(`/api/docs/${sret2.id}/approve`, 'POST');
  const outList2 = await api('/api/docs/out');
  assert(outList2.list.find(r => r.id === out1.id).return_status === 'full', '退完后原单标记为已全退');

  /* 9. 列表默认不含作废 */
  await api(`/api/docs/${draft.id}/void`, 'POST', { reason: '测试作废' });
  const listDefault = await api('/api/docs/out');
  assert(!listDefault.list.some(r => r.id === draft.id), '默认列表不含已作废单据');
  const listVoid = await api('/api/docs/out?status=void');
  assert(listVoid.list.some(r => r.id === draft.id), '按作废状态筛选能查到');

  /* 10. 仓库删除保护 */
  await expectFail(() => api(`/api/warehouses/${wh.id}`, 'DELETE'), /单据/, '有单据的仓库不能删除');
  const whEmpty = await api('/api/warehouses', 'POST', { name: '空仓待删' });
  await api(`/api/warehouses/${whEmpty.id}`, 'DELETE');
  const whList = await api('/api/warehouses');
  assert(!whList.list.some(w => w.id === whEmpty.id), '空仓库可以被超管删除');

  /* 11. 非超管不能删仓库 */
  const sales = await api('/api/users', 'POST', {
    username: 'fixsales', password: 'test1234', name: '修复测试销售', role: 'sales'
  });
  const adminToken = token;
  const sLogin = await api('/api/auth/login', 'POST', { username: 'fixsales', password: 'test1234' });
  token = sLogin.token;
  await expectFail(() => api(`/api/warehouses/${wh.id}`, 'DELETE'), /超级管理员/, '销售员不能删除仓库');
  token = adminToken;
  await api(`/api/users/${sales.id}`, 'DELETE');

  console.log('\n===== 测试结束 =====');
  console.log(failed ? `有 ${failed} 项未通过` : '全部通过');
  console.log('');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('\n✗ 中断：' + e.message); process.exit(1); });
