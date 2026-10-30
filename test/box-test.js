/**
 * 箱装小卷（按卷采购、按卷零售）逻辑测试
 */
'use strict';
const BASE = 'http://127.0.0.1:3000';
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

(async () => {
  console.log('\n===== 箱装小卷测试 =====\n');
  try {
    token = await require('./login-helper').loginAt(BASE + '/api/auth/login', 'admin', 'admin123');
    console.log('  ✓ 超管登录');

    const wh = await api('/api/warehouses', 'POST', { name: '测试仓' + Date.now() });
    const cust = await api('/api/customers', 'POST', { name: '客户' + Date.now(), contact: '张工', phone: '13900000001' });
    const supp = await api('/api/suppliers', 'POST', { name: '供应商' + Date.now(), contact: '李工', phone: '010-88889999' });

    /* 1. 新建箱装小卷物料：1箱=300卷 */
    const mat0 = await api('/api/materials', 'POST', {
      name: '电工胶带测试', code: 'MTEST' + Date.now(), spec: '1500', unit: '箱', type: 'master',
      sub_unit: '卷', base_width: 300, cost: 0
    });
    const mat = await api(`/api/materials/${mat0.id}`);
    console.log('  ✓ 新建物料：电工胶带，1箱=300卷');
    if (mat.sub_unit !== '卷' || mat.base_width !== 300) throw new Error('sub_unit 或 base_width 未保存');

    /* 2. 入库 50 箱，单价 600 元/箱 → 总成本 30000，单卷成本 = 600÷300 = 2 元 */
    const inDoc = await api('/api/docs', 'POST', {
      type: 'IN', warehouse_id: wh.id, partner_id: supp.id, doc_date: '2026-10-26', remark: '首批入库',
      items: [{ material_id: mat.id, qty: 50, price: 600, batch_no: 'BATCH001' }]
    });
    await api(`/api/docs/${inDoc.id}/submit`, 'POST');
    await api(`/api/docs/${inDoc.id}/approve`, 'POST');
    console.log(`  ✓ 入库 50 箱（15000 卷），成本 30000 元，单卷成本应为 2 元`);

    /* 3. 检查库存：应显示 50 箱 + 0 卷，materials.cost = 2 */
    const inv1 = await api('/api/inventory');
    const invRow = inv1.list.find(x => x.material_id === mat.id);
    if (!invRow) throw new Error('库存记录不存在');
    if (invRow.qty !== 50 || invRow.sub_qty !== 0) throw new Error(`库存应为 50 箱 + 0 卷，实际 ${invRow.qty} 箱 + ${invRow.sub_qty} 卷`);
    console.log(`  ✓ 库存：${invRow.qty} 箱 + ${invRow.sub_qty} 卷`);

    const mat2 = await api(`/api/materials/${mat.id}`);
    if (Math.abs(mat2.cost - 2) > 0.01) throw new Error(`单卷成本应为 2，实际 ${mat2.cost}`);
    console.log(`  ✓ 单卷成本：${mat2.cost} 元`);

    /* 4. 出库 50 卷，单价 3 元/卷 → 成本应扣 100 元，毛利 50 元 */
    const outDoc = await api('/api/docs', 'POST', {
      type: 'OUT', warehouse_id: wh.id, partner_id: cust.id, doc_date: '2026-10-26', remark: '拆箱零售',
      items: [{ material_id: mat.id, qty: 50, price: 3 }]
    });
    await api(`/api/docs/${outDoc.id}/submit`, 'POST');
    await api(`/api/docs/${outDoc.id}/approve`, 'POST');
    console.log(`  ✓ 出库 50 卷，销售额 150 元`);

    /* 5. 检查库存：应为 49 箱 + 250 卷 */
    const inv2 = await api('/api/inventory');
    const invRow2 = inv2.list.find(x => x.material_id === mat.id);
    if (invRow2.qty !== 49 || invRow2.sub_qty !== 250) {
      throw new Error(`库存应为 49 箱 + 250 卷，实际 ${invRow2.qty} 箱 + ${invRow2.sub_qty} 卷`);
    }
    console.log(`  ✓ 库存：${invRow2.qty} 箱 + ${invRow2.sub_qty} 卷`);

    /* 6. 检查单据成本与毛利 */
    const outDoc2 = await api(`/api/docs/${outDoc.id}`);
    if (Math.abs(outDoc2.total_cost - 100) > 0.01) {
      throw new Error(`总成本应为 100，实际 ${outDoc2.total_cost}`);
    }
    const profit = outDoc2.total_amount - outDoc2.total_cost;
    if (Math.abs(profit - 50) > 0.01) {
      throw new Error(`毛利应为 50，实际 ${profit}`);
    }
    console.log(`  ✓ 出库成本 ${outDoc2.total_cost} 元，毛利 ${profit.toFixed(2)} 元`);

    /* 7. 再出库 300 卷 → 应再拆 1 箱，剩余 48 箱 + 250 卷 */
    const outDoc3 = await api('/api/docs', 'POST', {
      type: 'OUT', warehouse_id: wh.id, customer_id: cust.id, doc_date: '2026-10-26',
      items: [{ material_id: mat.id, qty: 300, price: 3 }]
    });
    await api(`/api/docs/${outDoc3.id}/submit`, 'POST');
    await api(`/api/docs/${outDoc3.id}/approve`, 'POST');
    console.log(`  ✓ 再出库 300 卷`);

    const inv3 = await api('/api/inventory');
    const invRow3 = inv3.list.find(x => x.material_id === mat.id);
    if (invRow3.qty !== 48 || invRow3.sub_qty !== 250) {
      throw new Error(`库存应为 48 箱 + 250 卷，实际 ${invRow3.qty} 箱 + ${invRow3.sub_qty} 卷`);
    }
    console.log(`  ✓ 库存：${invRow3.qty} 箱 + ${invRow3.sub_qty} 卷`);

    console.log('\n===== 全部通过 =====\n');
  } catch (e) {
    console.error('✗', e.message);
    process.exit(1);
  }
})();
