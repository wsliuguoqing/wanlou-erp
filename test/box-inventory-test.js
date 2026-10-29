/**
 * 回归：箱装母卷（如 M0024 3M1500电工胶带红色）的库存显示
 *
 * 曾经的问题：库存查询页显示 33 箱，但新建出库单时物料选择器显示 0。
 * 原因是前端只判断 type==='master' 就去读 roll_count / open_width（rolls 表），
 * 而箱装物料的库存在 inventory 表里，rolls 表没有记录，于是显示成 0。
 *
 * 用法：先启动服务，再 node test/box-inventory-test.js
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

/** 复刻前端 pages-docs.js 的 stockOf()，确保三种口径都不会误读 */
function stockOf(m) {
  if (!m || !m.id) return '—';
  if (m.type === 'master' && m.sub_unit === 'mm') {
    return `${m.roll_count || 0} 支 / ${m.open_width || 0}mm`;
  }
  if (m.type === 'master' && m.sub_unit && m.sub_unit !== 'mm') {
    let text = `${m.stock_qty || 0} ${m.unit}`;
    if (m.sub_qty > 0) text += ` + ${m.sub_qty} ${m.sub_unit}`;
    return text;
  }
  return `${m.stock_qty || 0} ${m.unit || ''}`;
}

(async () => {
  console.log('\n========== 箱装母卷库存显示回归 ==========\n');

  const login = await api('/api/auth/login', 'POST', { username: 'admin', password: 'admin123' });
  token = login.token;
  console.log('  ✓ 超管登录');

  // 物料下拉（新建出库单用的就是这个接口）
  const mats = await api('/api/materials?all=1');
  const boxMats = mats.list.filter(m =>
    m.type === 'master' && m.sub_unit && m.sub_unit !== 'mm' && (m.stock_qty || 0) > 0);

  if (!boxMats.length) {
    console.log('\n  （库里没有有库存的箱装物料，跳过。可先跑 node test/box-test.js 造一个）');
    console.log('\n========== 跳过 ==========\n');
    return;
  }

  console.log(`\n有库存的箱装物料 ${boxMats.length} 个：\n`);
  for (const m of boxMats) {
    const perBox = Number(m.base_width) || 1;
    const totalSub = (m.stock_qty || 0) * perBox + (m.sub_qty || 0);
    console.log(`  ${m.code} ${m.name}`);
    console.log(`    inventory: ${m.stock_qty} ${m.unit} + ${m.sub_qty || 0} ${m.sub_unit}`
      + `（1 ${m.unit} = ${perBox} ${m.sub_unit}，共 ${totalSub} ${m.sub_unit}）`);
    console.log(`    rolls 表: roll_count=${m.roll_count} open_width=${m.open_width}`);
    console.log(`    出库单显示: ${stockOf(m)}`);

    // 箱装物料本就不该有 rolls 记录；旧代码读这里才显示 0
    assert(!m.roll_count, `${m.code} 没有 rolls 记录（旧代码读这里才显示 0）`);
    assert(!stockOf(m).startsWith('0 '), `${m.code} 出库单库存不显示 0`);
    assert(totalSub > 0, `${m.code} 可用总数 ${totalSub} ${m.sub_unit} > 0，出库校验不会误拦`);
    console.log('');
  }

  // 库存查询页与物料下拉必须口径一致，不能一个有数一个是 0
  const inv = await api('/api/inventory?all=1');
  for (const m of boxMats) {
    const row = inv.list.find(r => r.material_id === m.id);
    if (!row) { assert(false, `${m.code} 在库存查询里找不到`); continue; }
    assert(row.qty === m.stock_qty,
      `${m.code} 库存查询(${row.qty})与物料下拉(${m.stock_qty})一致`);
  }

  console.log(failed ? `\n========== ${failed} 项失败 ==========\n` : '\n========== 全部通过 ==========\n');
  if (failed) process.exit(1);
})().catch(e => {
  console.error('\n✗ 测试失败:', e.message, '\n');
  process.exit(1);
});
