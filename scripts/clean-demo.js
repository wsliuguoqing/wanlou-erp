'use strict';
/**
 * 清除 seed-demo.js 生成的演示数据
 *
 * 做法：先把已审核的演示单据逐张作废（走正常作废接口，库存会正确回滚），
 * 再按标记删除单据、明细、收付款、流水、物料、客户、供应商。
 * 真实数据不受影响——只认这些标记：
 *   单据备注 / 收款备注 以「演示数据」开头；物料编号 DMM*；客户 DMC*；供应商 DMS*
 *
 * 用法：
 *   node scripts/clean-demo.js           # 只统计，不删除
 *   node scripts/clean-demo.js --yes     # 真正删除
 */
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const BASE = process.env.TEST_BASE || 'http://127.0.0.1:3000';
const MARK = '演示数据';
const WRITE = process.argv.includes('--yes');
const DB_FILE = process.env.WL_DB || path.join(__dirname, '..', 'data', 'wanlou.db');

let token = '';
async function api(p, method = 'GET', body) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.message || '请求失败');
  return json.data;
}

(async () => {
  console.log('\n========== 清除演示数据 ==========');
  console.log(`  模式：${WRITE ? '删除' : '仅统计（加 --yes 才删除）'}\n`);

  const db = new DatabaseSync(DB_FILE);
  db.exec('PRAGMA busy_timeout = 8000');

  const docs = db.prepare("SELECT id,type,status,sn FROM docs WHERE remark LIKE ?").all(MARK + '%');
  const mats = db.prepare("SELECT id,code,name FROM materials WHERE code LIKE 'DMM%'").all();
  const custs = db.prepare("SELECT id FROM customers WHERE code LIKE 'DMC%'").all();
  const sups = db.prepare("SELECT id FROM suppliers WHERE code LIKE 'DMS%'").all();
  const pays = db.prepare("SELECT id FROM payments WHERE remark LIKE ?").all(MARK + '%');

  const byType = {};
  for (const d of docs) byType[d.type] = (byType[d.type] || 0) + 1;

  console.log(`  演示单据 ${docs.length} 张：${Object.entries(byType).map(([k, v]) => `${k} ${v}`).join('、') || '无'}`);
  console.log(`  演示物料 ${mats.length} 种、客户 ${custs.length} 家、供应商 ${sups.length} 家、收付款 ${pays.length} 笔`);

  if (!docs.length && !mats.length) {
    console.log('\n  没有找到演示数据。\n');
    process.exit(0);
  }
  if (!WRITE) {
    console.log('\n  统计结束，未删除。确认后加 --yes。\n');
    process.exit(0);
  }

  // 1. 逐张作废（库存回滚），退货单先作废
  const login = await api('/api/auth/login', 'POST', { username: 'admin', password: 'admin123' });
  token = login.token;

  const order = ['SRET', 'PRET', 'OUT', 'IN'];
  const targets = docs.filter(d => d.status === 'approved')
    .sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));

  let voided = 0, voidFail = 0;
  for (const d of targets) {
    try {
      await api(`/api/docs/${d.id}/void`, 'POST', { reason: '清除演示数据' });
      voided++;
      if (voided % 50 === 0) process.stdout.write(`\r  作废中 ${voided}/${targets.length}   `);
    } catch (e) {
      voidFail++;
      if (voidFail <= 5) console.log(`\n  作废失败 ${d.sn}：${e.message}`);
    }
  }
  console.log(`\r  已作废 ${voided} 张${voidFail ? `，失败 ${voidFail} 张` : ''}   `);

  // 2. 删除数据（真实数据不匹配这些标记，不会被动到）
  const del = db.prepare(`DELETE FROM docs WHERE remark LIKE ?`);
  const demoDocIds = 'SELECT id FROM docs WHERE remark LIKE \'演示数据%\'';
  const demoMatIds = 'SELECT id FROM materials WHERE code LIKE \'DMM%\'';
  const demoPayIds = 'SELECT id FROM payments WHERE remark LIKE \'演示数据%\' OR id IN (SELECT payment_id FROM payment_allocations WHERE doc_id IN (' + demoDocIds + '))';

  db.exec('BEGIN');
  try {
    const r1 = db.prepare(`DELETE FROM payment_allocations WHERE doc_id IN (${demoDocIds}) OR payment_id IN (${demoPayIds})`).run();
    const r2 = db.prepare(`DELETE FROM payments WHERE id IN (${demoPayIds})`).run();
    const r3 = db.prepare(`DELETE FROM stock_effects WHERE doc_id IN (${demoDocIds})`).run();
    const r4 = db.prepare(`DELETE FROM doc_items WHERE doc_id IN (${demoDocIds})`).run();
    const r5 = db.prepare(`DELETE FROM inventory_logs WHERE doc_sn IN (SELECT sn FROM docs WHERE remark LIKE '演示数据%') OR material_id IN (${demoMatIds})`).run();
    const r6 = del.run(MARK + '%');
    const r7 = db.prepare(`DELETE FROM inventory WHERE material_id IN (${demoMatIds})`).run();
    const r8 = db.prepare(`DELETE FROM rolls WHERE material_id IN (${demoMatIds})`).run();
    const r9 = db.prepare(`DELETE FROM materials WHERE code LIKE 'DMM%'`).run();
    const r10 = db.prepare(`DELETE FROM customers WHERE code LIKE 'DMC%'`).run();
    const r11 = db.prepare(`DELETE FROM suppliers WHERE code LIKE 'DMS%'`).run();
    db.exec('COMMIT');
    console.log(`  已删除：单据 ${r6.changes}、明细 ${r4.changes}、流水 ${r5.changes}、收付款 ${r2.changes}`);
    console.log(`          物料 ${r9.changes}、库存 ${r7.changes}、母卷 ${r8.changes}、客户 ${r10.changes}、供应商 ${r11.changes}`);
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  console.log('\n========== 清除完成 ==========\n');
})().catch(e => {
  console.error('\n执行失败：', e.message);
  process.exit(1);
});
