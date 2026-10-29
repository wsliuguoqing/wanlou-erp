/**
 * 回归：箱装物料盘点时账面数按卷显示，审核后库存按箱调整
 *
 * 场景：
 * - M0024（3M1500电工胶带红色）是箱装物料（1 箱 = 300 卷）
 * - 当前库存 33 箱（inventory 表）
 * - 生成盘点单，账面数应显示 9900 卷（33 × 300）
 * - 实盘填 10200 卷，差异 +300 卷
 * - 审核后，inventory 应调整为 34 箱（33 + 300/300）
 *
 * 用法：先启动服务，再 node test/check-box-test.js
 */
'use strict';

const BASE = process.env.TEST_BASE || 'http://127.0.0.1:3000';
let token = '';
let failed = 0;

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

function assert(cond, msg) {
  if (cond) console.log('  ✓ ' + msg);
  else { console.error('  ✗ ' + msg); failed++; }
}

(async () => {
  console.log('\n========== 箱装物料盘点按卷显示 ==========\n');

  const login = await api('/api/auth/login', 'POST', { username: 'admin', password: 'admin123' });
  token = login.token;
  console.log('  ✓ 超管登录');

  // 找一个有库存的箱装物料
  const mats = await api('/api/materials?all=1');
  const boxMat = mats.list.find(m =>
    m.type === 'master' && m.sub_unit && m.sub_unit !== 'mm' && (m.stock_qty || 0) > 0);

  if (!boxMat) {
    console.log('\n  （库里没有有库存的箱装物料，跳过。可先跑 node test/box-test.js 造一个）');
    console.log('\n========== 跳过 ==========\n');
    return;
  }

  const perBox = Number(boxMat.base_width) || 1;
  const beforeBox = boxMat.stock_qty || 0;
  const beforeRoll = beforeBox * perBox + (boxMat.sub_qty || 0);
  console.log(`\n使用物料: ${boxMat.code} ${boxMat.name}`);
  console.log(`  库存: ${beforeBox} ${boxMat.unit} + ${boxMat.sub_qty || 0} ${boxMat.sub_unit}`);
  console.log(`  换算: 1 ${boxMat.unit} = ${perBox} ${boxMat.sub_unit}，共 ${beforeRoll} ${boxMat.sub_unit}\n`);

  // 获取仓库
  const whs = await api('/api/warehouses?all=1');
  const wh = whs.list.find(w => w.status === 1);
  if (!wh) throw new Error('没有可用仓库');

  // 新建盘点单
  const checkRes = await api('/api/checks', 'POST', {
    warehouse_id: wh.id,
    check_date: new Date().toISOString().slice(0, 10),
    remark: '箱装物料盘点测试'
  });
  console.log(`  ✓ 新建盘点单 ${checkRes.sn}`);

  // 查看盘点明细
  const check = await api(`/api/checks/${checkRes.id}`);
  const item = check.items.find(i => i.material_id === boxMat.id);
  if (!item) {
    console.error('\n  ✗ 盘点单里找不到箱装物料明细');
    failed++;
    process.exit(1);
  }

  console.log(`  账面数: ${item.book_qty} ${boxMat.sub_unit}`);
  assert(item.book_qty === beforeRoll, `账面数 ${item.book_qty} 等于换算后卷数 ${beforeRoll}`);

  // 填写实盘（盘盈 1 箱 = 300 卷）
  const realRoll = beforeRoll + perBox;
  await api(`/api/checks/${checkRes.id}`, 'PUT', {
    items: [{ id: item.id, real_qty: realRoll, remark: '盘盈测试' }],
    submit: true
  });
  console.log(`  ✓ 填写实盘 ${realRoll} ${boxMat.sub_unit}，差异 +${perBox} ${boxMat.sub_unit}`);

  // 审核通过
  await api(`/api/checks/${checkRes.id}/approve`, 'POST');
  console.log(`  ✓ 审核通过`);

  // 验证库存
  const matsAfter = await api('/api/materials?all=1');
  const boxMatAfter = matsAfter.list.find(m => m.id === boxMat.id);
  const afterBox = boxMatAfter.stock_qty + (boxMatAfter.sub_qty || 0) / perBox;
  const expectBox = beforeBox + 1;  // 盘盈 300 卷 = 1 箱
  console.log(`  审核后库存: ${boxMatAfter.stock_qty} ${boxMat.unit} + ${boxMatAfter.sub_qty || 0} ${boxMat.sub_unit}（合计 ${afterBox} ${boxMat.unit}）`);
  assert(Math.abs(afterBox - expectBox) < 0.01, `库存从 ${beforeBox} ${boxMat.unit} 调整为 ${expectBox} ${boxMat.unit}`);

  console.log(failed ? `\n========== ${failed} 项失败 ==========\n` : '\n========== 全部通过 ==========\n');
  if (failed) process.exit(1);
})().catch(e => {
  console.error('\n✗ 测试失败:', e.message, '\n');
  process.exit(1);
});
