'use strict';
/**
 * 清理早期测试留下的垃圾数据（测试仓、测试客户/供应商/物料、以及它们关联的单据）
 *
 * 只认这些特征，不碰真实业务数据和演示数据：
 *   仓库名含「测试」「校验」或以 13 位时间戳结尾
 *   客户/供应商/物料名含「测试」「同单」
 *   单据：往来单位或仓库命中上面任意一条
 *
 * 已审核的单据先逐张作废（走接口，库存正确回滚），再删除记录。
 *
 * 用法：
 *   node scripts/clean-test-data.js           # 只统计，不删除
 *   node scripts/clean-test-data.js --yes     # 真正删除
 */
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const BASE = process.env.TEST_BASE || 'http://127.0.0.1:3000';
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
  console.log('\n========== 清理历史测试数据 ==========');
  console.log(`  模式：${WRITE ? '删除' : '仅统计（加 --yes 才删除）'}\n`);

  const db = new DatabaseSync(DB_FILE);
  db.exec('PRAGMA busy_timeout = 8000');

  const TS = "'%[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'";
  const isTestName = `(name LIKE '%测试%' OR name LIKE '%同单%' OR name GLOB ${TS})`;

  const whs = db.prepare(`SELECT id,name FROM warehouses WHERE ${isTestName} OR name LIKE '%校验%'`).all();
  const custs = db.prepare(`SELECT id,code,name FROM customers WHERE ${isTestName}`).all();
  const sups = db.prepare(`SELECT id,code,name FROM suppliers WHERE ${isTestName}`).all();
  const mats = db.prepare(`SELECT id,code,name FROM materials WHERE ${isTestName}`).all();

  const whIds = whs.map(w => w.id);
  const custIds = custs.map(c => c.id);
  const supIds = sups.map(s => s.id);
  const mIds = mats.map(m => m.id);

  // 客户和供应商是两张表，主键各算各的，id 会撞车（客户 5 和供应商 5 同时存在）。
  // 所以绝不能把两边 id 合并成一个 IN，必须按单据类型分开匹配：
  //   OUT / SRET 的 partner_id 是客户    IN / PRET 的 partner_id 是供应商
  const CUST_TYPES = ['OUT', 'SRET'];
  const SUP_TYPES = ['IN', 'PRET'];
  const inList = ids => (ids.length ? ids.join(',') : '0');
  const typeSql = ts => ts.map(t => `'${t}'`).join(',');

  const cond = [];
  if (whIds.length) cond.push(`warehouse_id IN (${inList(whIds)})`);
  if (custIds.length) cond.push(`(partner_id IN (${inList(custIds)}) AND type IN (${typeSql(CUST_TYPES)}))`);
  if (supIds.length) cond.push(`(partner_id IN (${inList(supIds)}) AND type IN (${typeSql(SUP_TYPES)}))`);
  const docWhere = cond.length ? `(${cond.join(' OR ')})` : '0';
  const docs = db.prepare(`SELECT id,type,status,sn FROM docs WHERE ${docWhere}`).all();

  const byType = {};
  for (const d of docs) byType[d.type] = (byType[d.type] || 0) + 1;

  console.log(`  测试仓库 ${whs.length} 个：${whs.map(w => w.name).join('、') || '无'}`);
  console.log(`  测试客户 ${custs.length} 家、供应商 ${sups.length} 家、物料 ${mats.length} 种`);
  console.log(`  关联单据 ${docs.length} 张：${Object.entries(byType).map(([k, v]) => `${k} ${v}`).join('、') || '无'}`);
  if (docs.length) {
    const sample = docs.slice(0, 8).map(d => `${d.sn}(${d.type}/${d.status})`).join('、');
    console.log(`  单据示例：${sample}${docs.length > 8 ? ' …' : ''}`);
  }

  if (!docs.length && !mats.length && !custs.length && !sups.length && !whs.length) {
    console.log('\n  没有找到测试数据。\n');
    process.exit(0);
  }
  if (!WRITE) {
    console.log('\n  统计结束，未删除。确认后加 --yes。\n');
    process.exit(0);
  }

  // 1. 作废已审核单据（退货单先作废）
  // 登录要带图形验证码，交给 test/login-helper 自动识别
  const { loginToken } = require(path.join(__dirname, '..', 'test', 'login-helper'));
  token = await loginToken(BASE, 'admin', 'admin123');
  const order = ['SRET', 'PRET', 'OUT', 'IN'];
  const targets = docs.filter(d => d.status === 'approved')
    .sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
  let voided = 0, voidFail = 0;
  for (const d of targets) {
    try { await api(`/api/docs/${d.id}/void`, 'POST', { reason: '清理测试数据' }); voided++; }
    catch (e) { voidFail++; if (voidFail <= 3) console.log(`  作废失败 ${d.sn}：${e.message}`); }
  }
  if (targets.length) console.log(`  已作废 ${voided} 张${voidFail ? `，失败 ${voidFail}` : ''}`);

  // 2. 删除（先做一次热备份，误删可回退）
  const backupDir = path.join(__dirname, '..', 'data', 'backup');
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const bakFile = path.join(backupDir, `wanlou-before-clean-${stamp}.db`);
  db.exec(`VACUUM INTO '${bakFile.replace(/'/g, "''")}'`);
  console.log(`  已备份：${path.relative(path.join(__dirname, '..'), bakFile)}`);

  const docIds = inList(docs.map(d => d.id));
  const mIdSql = inList(mIds);
  const custIdSql = inList(custIds);
  const supIdSql = inList(supIds);
  const whIdSql = inList(whIds);

  // 收款(receive)挂客户，付款(pay)挂供应商，靠 type 区分，避免 id 撞车误删
  const payWhere = [
    custIds.length ? `(type='receive' AND partner_id IN (${custIdSql}))` : '',
    supIds.length ? `(type='pay' AND partner_id IN (${supIdSql}))` : ''
  ].filter(Boolean).join(' OR ') || '0';

  db.exec('BEGIN');
  try {
    const r1 = db.prepare(`DELETE FROM payment_allocations WHERE doc_id IN (${docIds}) OR payment_id IN (SELECT id FROM payments WHERE ${payWhere})`).run();
    const r2 = db.prepare(`DELETE FROM payments WHERE ${payWhere}`).run();
    const r3 = db.prepare(`DELETE FROM stock_effects WHERE doc_id IN (${docIds})`).run();
    const r4 = db.prepare(`DELETE FROM doc_items WHERE doc_id IN (${docIds})`).run();
    const r5 = db.prepare(`DELETE FROM inventory_logs WHERE doc_sn IN (SELECT sn FROM docs WHERE id IN (${docIds})) OR material_id IN (${mIdSql}) OR warehouse_id IN (${whIdSql})`).run();
    const r6 = db.prepare(`DELETE FROM docs WHERE id IN (${docIds})`).run();
    const r7 = db.prepare(`DELETE FROM stock_check_items WHERE check_id IN (SELECT id FROM stock_checks WHERE warehouse_id IN (${whIdSql}))`).run();
    const r8 = db.prepare(`DELETE FROM stock_checks WHERE warehouse_id IN (${whIdSql})`).run();
    const r9 = db.prepare(`DELETE FROM inventory WHERE material_id IN (${mIdSql}) OR warehouse_id IN (${whIdSql})`).run();
    const r10 = db.prepare(`DELETE FROM rolls WHERE material_id IN (${mIdSql}) OR warehouse_id IN (${whIdSql})`).run();
    const r11 = db.prepare(`DELETE FROM materials WHERE id IN (${mIdSql})`).run();
    const r12 = db.prepare(`DELETE FROM customers WHERE id IN (${custIdSql})`).run();
    const r13 = db.prepare(`DELETE FROM suppliers WHERE id IN (${supIdSql})`).run();
    const r14 = db.prepare(`DELETE FROM warehouses WHERE id IN (${whIdSql})`).run();
    db.exec('COMMIT');
    console.log(`  已删除：单据 ${r6.changes}、明细 ${r4.changes}、流水 ${r5.changes}、收付款 ${r2.changes}`);
    console.log(`          物料 ${r11.changes}、库存 ${r9.changes}、母卷 ${r10.changes}、客户 ${r12.changes}、供应商 ${r13.changes}、仓库 ${r14.changes}`);
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  console.log('\n========== 清理完成 ==========\n');
})().catch(e => {
  console.error('\n执行失败：', e.message);
  process.exit(1);
});
