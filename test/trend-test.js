'use strict';
/**
 * 经营分析（趋势图）专项测试
 * 造跨年、跨月的出库数据，验证月度汇总与同比计算
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
const assert = (c, m) => c ? ok(m) : no(m);
const near = (a, b) => Math.abs(a - b) < 0.02;

(async () => {
  console.log('\n===== 经营分析测试 =====\n');

  token = (await api('/api/auth/login', 'POST', { username: 'admin', password: 'admin123' })).token;
  const wh = await api('/api/warehouses', 'POST', { name: '趋势测试仓' });
  const cust = await api('/api/customers', 'POST', { name: '趋势客户', contact: '李', phone: '13700000001' });
  const supp = await api('/api/suppliers', 'POST', { name: '趋势供应商', contact: '王', phone: '13700000002' });
  const mat = await api('/api/materials', 'POST', { name: '测试接头', spec: 'T-01', unit: '套', type: 'normal' });

  // 先入库 1000 套，单价 50
  const inDoc = await api('/api/docs/in', 'POST', {
    doc_date: '2025-01-05', partner_id: supp.id, warehouse_id: wh.id,
    items: [{ material_id: mat.id, qty: 1000, price: 50 }], submit: true
  });
  await api(`/api/docs/${inDoc.id}/approve`, 'POST');
  ok('入库 1000 套，成本 50');

  /* 造数据：2025 年 3 个月，2026 年 3 个月 */
  const plan = [
    { date: '2025-03-10', qty: 10, price: 80 },   // 2025-03 销售 800 成本 500 毛利 300
    { date: '2025-10-15', qty: 20, price: 90 },   // 2025-10 销售 1800 成本 1000 毛利 800
    { date: '2025-12-20', qty: 5,  price: 100 },  // 2025-12 销售 500 成本 250 毛利 250
    { date: '2026-03-11', qty: 15, price: 85 },   // 2026-03 销售 1275 成本 750 毛利 525
    { date: '2026-10-16', qty: 30, price: 95 },   // 2026-10 销售 2850 成本 1500 毛利 1350
    { date: '2026-10-18', qty: 10, price: 100 }   // 2026-10 再加 1000 成本 500 毛利 500
  ];
  for (const p of plan) {
    const d = await api('/api/docs/out', 'POST', {
      doc_date: p.date, partner_id: cust.id, warehouse_id: wh.id,
      items: [{ material_id: mat.id, qty: p.qty, price: p.price }], submit: true
    });
    await api(`/api/docs/${d.id}/approve`, 'POST');
  }
  ok(`造了 ${plan.length} 张跨年出库单`);

  /* 查 2026 年，对比 2025 */
  const t = await api('/api/reports/trend?year=2026&compare_year=2025');
  assert(t.year === 2026 && t.compareYear === 2025, '年份参数生效');
  assert(t.months.length === 12 && t.compareMonths.length === 12, '两年都返回 12 个月');

  const m3 = t.months[2], m10 = t.months[9];
  assert(near(m3.amount, 1275), `2026-03 销售额 1275（实际 ${m3.amount}）`);
  assert(near(m3.profit, 525), `2026-03 毛利 525（实际 ${m3.profit}）`);
  assert(near(m10.amount, 3850), `2026-10 销售额 3850（两单合并，实际 ${m10.amount}）`);
  assert(near(m10.profit, 1850), `2026-10 毛利 1850（实际 ${m10.profit}）`);
  assert(m10.count === 2, `2026-10 单数 2（实际 ${m10.count}）`);

  const p3 = t.compareMonths[2], p10 = t.compareMonths[9], p12 = t.compareMonths[11];
  assert(near(p3.amount, 800), `2025-03 销售额 800（实际 ${p3.amount}）`);
  assert(near(p10.amount, 1800), `2025-10 销售额 1800（实际 ${p10.amount}）`);
  assert(near(p12.amount, 500), `2025-12 销售额 500（实际 ${p12.amount}）`);

  /* 全年合计 */
  assert(near(t.total.amount, 5125), `2026 全年销售 5125（实际 ${t.total.amount}）`);
  assert(near(t.compareTotal.amount, 3100), `2025 全年销售 3100（实际 ${t.compareTotal.amount}）`);

  /* 本月与去年同月 */
  assert(t.thisMonth.ym === '2026-10', '本月定位到 2026-10');
  assert(near(t.thisMonth.amount, 3850), '本月销售额正确');
  assert(near(t.thisMonth.lastYearAmount, 1800), '去年同月销售额 1800');
  // (3850-1800)/1800 = 1.1389
  assert(near(t.thisMonth.amountGrowth, 1.1389), `本月同比 +113.9%（实际 ${(t.thisMonth.amountGrowth * 100).toFixed(1)}%）`);

  /* 年初至今：2026 只到 10 月 = 1275+3850 = 5125；2025 同期 = 800+1800 = 2600 */
  assert(near(t.ytd.amount, 5125), `年初至今销售 5125（实际 ${t.ytd.amount}）`);
  assert(near(t.ytd.lastYearAmount, 2600), `去年同期 2600，不含 12 月（实际 ${t.ytd.lastYearAmount}）`);
  assert(near(t.ytd.amountGrowth, 0.9712), `累计同比 +97.1%（实际 ${(t.ytd.amountGrowth * 100).toFixed(1)}%）`);

  assert(t.availableYears.includes(2025) && t.availableYears.includes(2026), '可选年份含 2025 与 2026');

  /* 反向对比：查 2025 对比 2026 */
  const t2 = await api('/api/reports/trend?year=2025&compare_year=2026');
  assert(near(t2.total.amount, 3100), '切换年份后本期变成 2025');
  assert(near(t2.compareTotal.amount, 5125), '对比年变成 2026');

  /* 作废一单，金额应该从统计里消失 */
  const outs = await api('/api/docs/out?from=2026-10-01&to=2026-10-31');
  const toVoid = outs.list.find(r => near(r.total_amount, 1000));
  await api(`/api/docs/${toVoid.id}/void`, 'POST', { reason: '测试作废' });
  const t3 = await api('/api/reports/trend?year=2026&compare_year=2025');
  assert(near(t3.months[9].amount, 2850), `作废后 2026-10 销售额回到 2850（实际 ${t3.months[9].amount}）`);
  assert(t3.months[9].count === 1, '作废后单数变 1');

  /* 销售员无权访问 */
  const sales = await api('/api/users', 'POST', { username: 'trsales', password: 'test1234', name: '趋势销售', role: 'sales' });
  const adminT = token;
  token = (await api('/api/auth/login', 'POST', { username: 'trsales', password: 'test1234' })).token;
  try { await api('/api/reports/trend'); no('销售员竟能访问经营分析'); }
  catch (e) { /权限/.test(e.message) ? ok('销售员访问经营分析被拒绝') : no('拒绝信息不符：' + e.message); }
  token = adminT;
  await api(`/api/users/${sales.id}`, 'DELETE');

  console.log('\n===== 测试结束 =====');
  console.log(failed ? `有 ${failed} 项未通过` : '全部通过');
  console.log('');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('\n✗ 中断：' + e.message); process.exit(1); });
