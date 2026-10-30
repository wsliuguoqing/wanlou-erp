'use strict';
/**
 * 回归：母卷分切流水必须按「支」记整数，且流水合计 = 实际在库支数
 *
 * 曾经的问题：切 100mm（母卷 1200mm）记 -0.083 支，单位写着「支」却是小数，
 * 业务看不懂；按流水汇总得到 548.89 支，实际在库 566 支，两头对不上。
 *
 * 现在的口径：一次分切只有把某一支切完（变成已用完/料头）才让支数 -1，
 * 没切完就记 0，备注写清「支数不变」。
 *
 * 用法：node test/roll-log-unit-test.js
 * 自己在临时数据目录起服务（端口 3998），跑完关掉，不碰 data/wanlou.db。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = Number(process.env.TEST_PORT) || 3998;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-roll-'));

let token = '';
let failed = 0;
const ok = (cond, msg, extra) => {
  if (cond) console.log('  ✓ ' + msg);
  else { console.error('  ✗ ' + msg + (extra ? `　→ ${extra}` : '')); failed++; }
};

async function api(p, method = 'GET', body) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`${method} ${p} → ${json.message}`);
  return json.data;
}

async function waitReady(ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE + '/api/auth/me');
      if (res.status === 401) return true;
    } catch { /* 还没起来 */ }
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

(async () => {
  console.log('\n========== 母卷分切流水口径回归 ==========\n');
  console.log('  临时数据目录：' + DATA_DIR);

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), WL_DATA_DIR: DATA_DIR },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  child.stdout.on('data', d => { log += d.toString(); });
  child.stderr.on('data', d => { log += d.toString(); });
  const cleanup = () => {
    try { child.kill(); } catch {}
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
  };

  try {
    if (!await waitReady()) {
      console.error('服务没起来：\n' + log);
      cleanup();
      process.exit(1);
    }
    ok(true, '测试服务已启动');

    token = (await api('/api/auth/login', 'POST', { username: 'admin', password: 'admin123' })).token;
    ok(true, '拿到登录令牌');

    /* ---------- 准备基础资料 ---------- */
    const wh = (await api('/api/warehouses')).list[0];
    const sup = await api('/api/suppliers', 'POST', { name: '回归用供应商' });
    const cus = await api('/api/customers', 'POST', { name: '回归用客户' });
    // 出库单要求销售人员有工号，单号前缀是 CK + 工号
    const sp = await api('/api/users', 'POST', {
      username: 'sp001', password: 'sp123456', name: '回归销售', employee_no: '001', role: 'sales'
    });

    // 母卷：1 卷 = 1200mm，料头阈值默认 10mm
    const mat = await api('/api/materials', 'POST', {
      name: '回归测试母卷', unit: '卷', type: 'master', sub_unit: 'mm', base_width: 1200
    });
    const MID = mat.id;
    ok(!!MID, `建好母卷物料 id=${MID}`);

    // 建单 → 提交审核 → 审核通过（建单接口只回 id，单号要再查一次）
    const createAndApprove = async (body) => {
      const created = await api('/api/docs', 'POST', body);
      await api(`/api/docs/${created.id}/submit`, 'POST', {});
      await api(`/api/docs/${created.id}/approve`, 'POST', {});
      const doc = await api(`/api/docs/${created.id}`);
      return { id: created.id, sn: doc.sn || doc.doc?.sn };
    };

    const logs = async () => {
      const d = await api(`/api/inventory/logs?material_id=${MID}&size=100`);
      return d.list.slice().sort((a, b) => a.id - b.id);
    };
    const openRolls = async () => {
      const d = await api(`/api/inventory/rolls?material_id=${MID}&size=200`);
      return d.list.filter(r => r.status === 'open').length;
    };

    /* ---------- 1. 入库 2 支 ---------- */
    console.log('\n--- 1. 母卷入库 2 支 ---\n');
    const inDoc = await createAndApprove({
      type: 'IN', warehouse_id: wh.id, partner_id: sup.id, doc_date: '2025-03-15',
      items: [{ material_id: MID, qty: 2, price: 120 }]
    });
    ok(true, `入库单 ${inDoc.sn} 已审核`);
    ok(/20250315/.test(inDoc.sn), `单号用单据日期而不是今天：${inDoc.sn}`);
    ok(await openRolls() === 2, '在库 2 支');

    /* ---------- 2. 分切 100mm，切不完一支 ---------- */
    console.log('\n--- 2. 分切 100mm（切不完一支） ---\n');
    const out1 = await createAndApprove({
      type: 'OUT', warehouse_id: wh.id, partner_id: cus.id, salesperson_id: sp.id,
      items: [{ material_id: MID, qty: 1, cut_width: 100, price: 50 }]
    });
    let L = await logs();
    const cut1 = L.find(r => r.doc_sn === out1.sn && String(r.remark).startsWith('分切'));
    ok(!!cut1, `分切流水已写入：${cut1 ? cut1.remark : '未找到'}`);
    ok(cut1 && cut1.qty_change === 0, '切不完一支时流水数量是 0（不再是 -0.083）', cut1 && String(cut1.qty_change));
    ok(cut1 && cut1.remark.includes('支数不变'), '备注写明「支数不变」', cut1 && cut1.remark);
    ok(await openRolls() === 2, '在库仍是 2 支');

    /* ---------- 3. 再分切 1100mm，正好把一支切完 ---------- */
    console.log('\n--- 3. 再分切 1100mm（正好切完一支） ---\n');
    const out2 = await createAndApprove({
      type: 'OUT', warehouse_id: wh.id, partner_id: cus.id, salesperson_id: sp.id,
      items: [{ material_id: MID, qty: 1, cut_width: 1100, price: 500 }]
    });
    L = await logs();
    const cut2 = L.find(r => r.doc_sn === out2.sn && String(r.remark).startsWith('分切'));
    ok(!!cut2, `分切流水已写入：${cut2 ? cut2.remark : '未找到'}`);
    ok(cut2 && cut2.qty_change === -1, '切完一支时流水数量是 -1 支', cut2 && String(cut2.qty_change));
    ok(cut2 && cut2.remark.includes('切完 1 支'), '备注写明「切完 1 支」', cut2 && cut2.remark);
    ok(await openRolls() === 1, '在库变成 1 支');

    /* ---------- 4. 流水合计 = 在库支数 ---------- */
    console.log('\n--- 4. 流水合计与在库对账 ---\n');
    const sum = L.reduce((a, r) => a + Number(r.qty_change), 0);
    const stock = await openRolls();
    ok(Math.abs(sum - stock) < 1e-6, `流水合计 ${sum} 支 = 在库 ${stock} 支`);
    const frac = L.filter(r => Math.abs(Number(r.qty_change) - Math.round(Number(r.qty_change))) > 1e-6);
    ok(frac.length === 0, '没有任何小数支数的流水', frac.map(r => r.qty_change).join(','));
    ok(L.every(r => Number(r.qty_after) === Number(r.qty_before) + Number(r.qty_change)),
      '每行的结存 = 上期结存 + 本次变动');
    const last = L[L.length - 1];
    ok(Number(last.qty_after) === stock, `最后一行结存 ${last.qty_after} 与在库 ${stock} 一致`);

    /* ---------- 5. 整支出库也按支记 ---------- */
    console.log('\n--- 5. 整支出库 ---\n');
    const out3 = await createAndApprove({
      type: 'OUT', warehouse_id: wh.id, partner_id: cus.id, salesperson_id: sp.id,
      items: [{ material_id: MID, qty: 1, price: 120 }]
    });
    L = await logs();
    const whole = L.find(r => r.doc_sn === out3.sn);
    ok(whole && whole.qty_change === -1, '整支出库记 -1 支', whole && String(whole.qty_change));
    ok(await openRolls() === 0, '在库变成 0 支');
    const sum2 = L.reduce((a, r) => a + Number(r.qty_change), 0);
    ok(sum2 === 0, `流水合计 ${sum2} 支 = 在库 0 支`);

    /* ---------- 6. 作废出库，支数回滚 ---------- */
    console.log('\n--- 6. 作废后支数回滚 ---\n');
    await api(`/api/docs/${out3.id}/void`, 'POST', { reason: '回归测试' });
    ok(await openRolls() === 1, '作废整支出库后在库恢复 1 支');
    L = await logs();
    const sum3 = L.reduce((a, r) => a + Number(r.qty_change), 0);
    ok(Math.abs(sum3 - 1) < 1e-6, `作废后流水合计 ${sum3} 支 = 在库 1 支`);

    /* ---------- 7. 作废「切完一支」的分切单，支数要加回来 ---------- */
    console.log('\n--- 7. 作废分切单 ---\n');
    await api(`/api/docs/${out2.id}/void`, 'POST', { reason: '回归测试' });
    ok(await openRolls() === 2, '作废后那一支重新变成在库，共 2 支');
    L = await logs();
    const voidRow = L.filter(r => r.doc_sn === out2.sn && r.doc_type === 'VOID').pop();
    ok(voidRow && voidRow.qty_change === 1, '作废补了一条 +1 支的流水', voidRow && `${voidRow.qty_change}｜${voidRow.remark}`);
    const sum4 = L.reduce((a, r) => a + Number(r.qty_change), 0);
    ok(Math.abs(sum4 - 2) < 1e-6, `作废后流水合计 ${sum4} 支 = 在库 2 支`);

    /* ---------- 8. 作废「没切完」的分切单，支数不动 ---------- */
    console.log('\n--- 8. 作废没切完的分切单 ---\n');
    await api(`/api/docs/${out1.id}/void`, 'POST', { reason: '回归测试' });
    ok(await openRolls() === 2, '支数仍是 2 支');
    L = await logs();
    const sum5 = L.reduce((a, r) => a + Number(r.qty_change), 0);
    ok(Math.abs(sum5 - 2) < 1e-6, `流水合计 ${sum5} 支 = 在库 2 支`);
    const frac2 = L.filter(r => Math.abs(Number(r.qty_change) - Math.round(Number(r.qty_change))) > 1e-6);
    ok(frac2.length === 0, '作废后仍然没有小数支数');

  } catch (e) {
    console.error('\n  ✗ 执行出错：' + e.message);
    failed++;
  } finally {
    console.log('\n========== 测试结束 ==========');
    console.log(failed ? `发现 ${failed} 个问题` : '全部通过');
    console.log('');
    cleanup();
    process.exit(failed ? 1 : 0);
  }
})();
