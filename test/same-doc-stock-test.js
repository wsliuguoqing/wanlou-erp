'use strict';
/**
 * 回归：同一张出库单里同一物料分成多行时，库存校验要按本单合计量算
 *
 * 曾经的问题：M0006 镀锡铜编织线库存 0 卷 + 50 米，
 * 出库单 CK001202610300001 第一行 50 米、第二行 10 米，合计 60 米超库存，
 * 却能提交审核成功。原因是前后端都逐行拿原始库存比对，同一单的多行互不相知。
 *
 * 用法：先启动服务（可用临时数据库），再 node test/same-doc-stock-test.js
 */
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

/** 期望这次调用被拒绝，返回错误消息 */
async function expectReject(path, method, body) {
  try {
    await api(path, method, body);
    return null;
  } catch (e) {
    return e.message;
  }
}

function assert(cond, msg) {
  if (cond) console.log('  ✓ ' + msg);
  else { console.error('  ✗ ' + msg); failed++; }
}

(async () => {
  console.log('\n========== 同单多行库存校验回归 ==========\n');

  const login = await api('/api/auth/login', 'POST', { username: 'admin', password: 'admin123' });
  token = login.token;
  console.log('  ✓ 超管登录');
  // 出库单要求销售人员有工号
  await api('/api/users/' + login.user.id, 'PUT', { employee_no: 'ADMIN-SAMEDOC' });

  const ts = Date.now();
  const wh = await api('/api/warehouses', 'POST', { name: '同单校验仓' + ts, address: '郑州' });
  const sup = await api('/api/suppliers', 'POST', { name: '同单供应商' + ts, contact: '张', phone: '02100000001' });
  const cust = await api('/api/customers', 'POST', { name: '同单客户' + ts, contact: '王', phone: '13800000001', level: 'A' });

  /* ---------- 场景一：整进零出（接地线式，1 卷 = 100 米） ---------- */
  const mCable = await api('/api/materials', 'POST', {
    name: '同单编织线' + ts, model: 'TX-' + ts, unit: '卷', type: 'master', sub_unit: '米', base_width: 100
  });
  // 入库 0 卷 + 50 米，和线上 M0006 的库存一致
  const inDoc = await api('/api/docs/in', 'POST', {
    warehouse_id: wh.id, partner_id: sup.id, submit: true,
    items: [{ material_id: mCable.id, qty_whole: 0, qty_sub: 50, price: 1, price_basis: 'sub' }]
  });
  await api('/api/docs/' + inDoc.id + '/approve', 'POST', {});
  const stockAfterIn = (await api(`/api/materials?all=1&warehouse_id=${wh.id}`)).list
    .find(m => m.id === mCable.id);
  assert(Number(stockAfterIn.sub_qty) === 50 && Number(stockAfterIn.stock_qty) === 0,
    '入库后库存是 0 卷 + 50 米');

  // 核心用例：两行 50 米 + 10 米 = 60 米，超过 50 米库存，必须被拦下
  const overMsg = await expectReject('/api/docs/out', 'POST', {
    warehouse_id: wh.id, partner_id: cust.id, submit: true,
    items: [
      { material_id: mCable.id, qty_whole: 0, qty_sub: 50, price: 1.25 },
      { material_id: mCable.id, qty_whole: 0, qty_sub: 10, price: 1.25 }
    ]
  });
  assert(overMsg !== null, '同一物料两行 50 米 + 10 米 超库存被拒绝提交');
  assert(overMsg && overMsg.includes('60'), '报错里体现本单合计需求 60 米：' + overMsg);
  assert(overMsg && overMsg.includes('2 行合计'), '报错提示是本单多行合计');

  // 边界：两行刚好等于库存（40 + 10 = 50），应该放行
  const exactDoc = await api('/api/docs/out', 'POST', {
    warehouse_id: wh.id, partner_id: cust.id, submit: true,
    items: [
      { material_id: mCable.id, qty_whole: 0, qty_sub: 40, price: 1.25 },
      { material_id: mCable.id, qty_whole: 0, qty_sub: 10, price: 1.25 }
    ]
  });
  assert(exactDoc.id > 0, '两行合计刚好等于库存（40 + 10 = 50 米）允许提交');

  // 这张待审核单据已占住 50 米，再开一张 1 米的单也应该被拦
  const holdMsg = await expectReject('/api/docs/out', 'POST', {
    warehouse_id: wh.id, partner_id: cust.id, submit: true,
    items: [{ material_id: mCable.id, qty_whole: 0, qty_sub: 1, price: 1.25 }]
  });
  assert(holdMsg !== null, '库存已被上一张待审核单占满，新单 1 米被拒绝');

  await api('/api/docs/' + exactDoc.id + '/approve', 'POST', {});
  const stockAfterOut = (await api(`/api/materials?all=1&warehouse_id=${wh.id}`)).list
    .find(m => m.id === mCable.id);
  assert(Number(stockAfterOut.sub_qty) === 0 && Number(stockAfterOut.stock_qty) === 0,
    '审核通过后 50 米全部扣完');

  /* ---------- 场景二：普通物料（整进整出） ---------- */
  const mPlain = await api('/api/materials', 'POST', {
    name: '同单电缆头' + ts, model: 'PL-' + ts, unit: '个', type: 'normal'
  });
  const inPlain = await api('/api/docs/in', 'POST', {
    warehouse_id: wh.id, partner_id: sup.id, submit: true,
    items: [{ material_id: mPlain.id, qty: 10, price: 5 }]
  });
  await api('/api/docs/' + inPlain.id + '/approve', 'POST', {});

  const plainOverMsg = await expectReject('/api/docs/out', 'POST', {
    warehouse_id: wh.id, partner_id: cust.id, submit: true,
    items: [
      { material_id: mPlain.id, qty: 7, price: 8 },
      { material_id: mPlain.id, qty: 5, price: 8 }
    ]
  });
  assert(plainOverMsg !== null, '普通物料两行 7 + 5 = 12 超 10 个库存被拒绝');

  const plainOk = await api('/api/docs/out', 'POST', {
    warehouse_id: wh.id, partner_id: cust.id, submit: true,
    items: [
      { material_id: mPlain.id, qty: 7, price: 8 },
      { material_id: mPlain.id, qty: 3, price: 8 }
    ]
  });
  assert(plainOk.id > 0, '普通物料两行合计刚好 10 个允许提交');

  /* ---------- 场景三：胶带母卷（整支 + 分切混在一张单） ---------- */
  const mTape = await api('/api/materials', 'POST', {
    name: '同单胶带' + ts, model: 'TAPE-' + ts, unit: '支', type: 'master',
    sub_unit: 'mm', base_width: 1000, min_waste: 10
  });
  const inTape = await api('/api/docs/in', 'POST', {
    warehouse_id: wh.id, partner_id: sup.id, submit: true,
    items: [{ material_id: mTape.id, qty: 2, price: 500 }]
  });
  await api('/api/docs/' + inTape.id + '/approve', 'POST', {});

  // 2 支母卷共 2000mm：一行整支出 2 支，另一行还想切 100mm，不该放行
  const tapeOverMsg = await expectReject('/api/docs/out', 'POST', {
    warehouse_id: wh.id, partner_id: cust.id, submit: true,
    items: [
      { material_id: mTape.id, qty: 2, cut_width: 0, price: 600 },
      { material_id: mTape.id, qty: 1, cut_width: 100, price: 2 }
    ]
  });
  assert(tapeOverMsg !== null, '母卷整支出 2 支后同单再分切 100mm 被拒绝');

  // 整支出 1 支 + 分切 100mm，剩下那支够切，应该放行
  const tapeOk = await api('/api/docs/out', 'POST', {
    warehouse_id: wh.id, partner_id: cust.id, submit: true,
    items: [
      { material_id: mTape.id, qty: 1, cut_width: 0, price: 600 },
      { material_id: mTape.id, qty: 1, cut_width: 100, price: 2 }
    ]
  });
  assert(tapeOk.id > 0, '整支出 1 支 + 另一支分切 100mm 允许提交');

  // 分切两行合计超过单支宽度也要拦：2 支里 1 支已被上一单占用
  const tapeCutOverMsg = await expectReject('/api/docs/out', 'POST', {
    warehouse_id: wh.id, partner_id: cust.id, submit: true,
    items: [
      { material_id: mTape.id, qty: 1, cut_width: 900, price: 2 },
      { material_id: mTape.id, qty: 1, cut_width: 900, price: 2 }
    ]
  });
  assert(tapeCutOverMsg !== null, '同单两行分切合计 1800mm 超可用宽度被拒绝');

  /* ---------- 场景四：数量为 0 的行不占库存 ---------- */
  const mZero = await api('/api/materials', 'POST', {
    name: '零行物料' + ts, model: 'ZR-' + ts, unit: '卷', type: 'master', sub_unit: '米', base_width: 100
  });
  const inZero = await api('/api/docs/in', 'POST', {
    warehouse_id: wh.id, partner_id: sup.id, submit: true,
    items: [{ material_id: mZero.id, qty_whole: 0, qty_sub: 50, price: 1, price_basis: 'sub' }]
  });
  await api('/api/docs/' + inZero.id + '/approve', 'POST', {});

  // 数量为 0 的行不该出现在单子里，提交时直接报「数量必须大于 0」，
  // 而不是把它算进库存需求、报出含它的合计量
  const zeroMsg = await expectReject('/api/docs/out', 'POST', {
    warehouse_id: wh.id, partner_id: cust.id, submit: true,
    items: [
      { material_id: mZero.id, qty_whole: 0, qty_sub: 50, price: 1.25 },
      { material_id: mZero.id, qty_whole: 0, qty_sub: 0, price: 1.25 }
    ]
  });
  assert(zeroMsg !== null && zeroMsg.includes('数量必须大于 0'),
    '数量为 0 的行报「数量必须大于 0」，不是库存不足：' + zeroMsg);

  // 单行 50 米（刚好等于库存）不该出现「2 行合计」字样
  const singleDoc = await api('/api/docs/out', 'POST', {
    warehouse_id: wh.id, partner_id: cust.id, submit: true,
    items: [{ material_id: mZero.id, qty_whole: 0, qty_sub: 50, price: 1.25 }]
  });
  assert(singleDoc.id > 0, '删掉空行后单行 50 米正常提交');
  await api('/api/docs/' + singleDoc.id + '/reject', 'POST', { reason: '测试驳回' });
  const afterReject = (await api(`/api/materials?all=1&warehouse_id=${wh.id}`)).list.find(m => m.id === mZero.id);
  assert(Number(afterReject.sub_qty) === 50,
    `驳回待审核单据后库存仍是 50 米（实际 ${afterReject.sub_qty}）`);

  /* ---------- 场景五：审核中途失败要整单回滚 ---------- */
  // 构造一张能提交、但审核时库存已不够的单：先提交 50 米，再用另一张单把库存吃掉
  const mTx = await api('/api/materials', 'POST', {
    name: '事务物料' + ts, model: 'TX2-' + ts, unit: '卷', type: 'master', sub_unit: '米', base_width: 100
  });
  const inTx = await api('/api/docs/in', 'POST', {
    warehouse_id: wh.id, partner_id: sup.id, submit: true,
    items: [{ material_id: mTx.id, qty_whole: 0, qty_sub: 60, price: 1, price_basis: 'sub' }]
  });
  await api('/api/docs/' + inTx.id + '/approve', 'POST', {});

  // 草稿先存（草稿不校验库存），再把库存吃光，然后提交这张草稿去审核
  const draftTx = await api('/api/docs/out', 'POST', {
    warehouse_id: wh.id, partner_id: cust.id, submit: false,
    items: [
      { material_id: mTx.id, qty_whole: 0, qty_sub: 40, price: 1.25 },
      { material_id: mTx.id, qty_whole: 0, qty_sub: 30, price: 1.25 }
    ]
  });
  const beforeTx = (await api(`/api/materials?all=1&warehouse_id=${wh.id}`)).list.find(m => m.id === mTx.id);
  // 直接走提交接口（绕过新建时的校验路径），再审核；两行合计 70 > 60，必须整单失败
  const submitMsg = await expectReject('/api/docs/' + draftTx.id + '/submit', 'POST', {});
  const approveMsg = submitMsg === null
    ? await expectReject('/api/docs/' + draftTx.id + '/approve', 'POST', {})
    : submitMsg;
  assert(approveMsg !== null, '两行合计 70 米超 60 米库存，提交或审核被拒绝');
  const afterTx = (await api(`/api/materials?all=1&warehouse_id=${wh.id}`)).list.find(m => m.id === mTx.id);
  assert(Number(afterTx.sub_qty) === Number(beforeTx.sub_qty) && Number(afterTx.stock_qty) === Number(beforeTx.stock_qty),
    `审核失败后库存没被部分扣减（仍是 ${afterTx.stock_qty} 卷 + ${afterTx.sub_qty} 米）`);

  console.log(failed === 0 ? '\n全部通过\n' : `\n失败 ${failed} 项\n`);
  process.exitCode = failed === 0 ? 0 : 1;
})().catch(e => {
  console.error('\n✗ 测试中断:', e.message);
  process.exitCode = 1;
});
