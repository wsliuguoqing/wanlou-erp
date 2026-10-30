'use strict';
/**
 * 母卷流水口径统一：把「等效支数」改成「实际支数」
 *
 * 背景
 *   母卷（sub_unit='mm'）的库存单位是「支」，但早期分切时按宽度折算记账：
 *   切 100mm（母卷 1200mm）就记 -0.083 支。结果流水加起来是 548.89 支，
 *   实际在库 566 支，业务看不懂也对不上。
 *
 *   正确口径：一次分切只有在「切完一整支」时才让支数 -1，否则支数不变。
 *   代码已改（docs.js consumeRollWidth），这个脚本负责把历史流水也改成整数支。
 *
 * 做法
 *   对每个母卷物料：
 *     入库合计 O、整支出库合计 W 不变；
 *     分切行合计应等于  C_new = 在库支数 - O - W；
 *     把 |C_new| 个「-1」按各条分切行的占用宽度占比分配下去（最大余数法），
 *     保证每条都是整数、且合计精确等于 C_new。
 *   最后按时间顺序重算每行的结存（qty_before / qty_after），保证链条连续。
 *
 * 幂等：已经统一过的物料差额为 0，直接跳过，重复执行无副作用。
 *
 * 用法：
 *   node scripts/fix-roll-log-unit.js           # 只统计，不改数据
 *   node scripts/fix-roll-log-unit.js --yes     # 真正修改
 */
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const WRITE = process.argv.includes('--yes');
const DB_FILE = process.env.WL_DB || path.join(__dirname, '..', 'data', 'wanlou.db');

const EPS = 1e-6;
const round3 = n => Math.round(n * 1000) / 1000;

/** 从「分切 500mm」这类备注里取宽度 */
function pickWidth(remark) {
  const m = String(remark || '').match(/分切(?:占用)?\s*([\d.]+)\s*mm/);
  return m ? Number(m[1]) : 0;
}

/** 最大余数法：把 total 个 1 按权重分配到各条，返回整数数组 */
function distribute(weights, total) {
  const sum = weights.reduce((a, b) => a + b, 0);
  const n = weights.length;
  const out = new Array(n).fill(0);
  if (!n || total <= 0) return out;
  if (sum <= 0) { // 没有宽度信息时平均分
    for (let i = 0; i < total; i++) out[i % n] += 1;
    return out;
  }
  const exact = weights.map(w => (w / sum) * total);
  const base = exact.map(Math.floor);
  let left = total - base.reduce((a, b) => a + b, 0);
  const order = exact.map((e, i) => ({ i, r: e - Math.floor(e) }))
    .sort((a, b) => b.r - a.r || a.i - b.i);
  for (let k = 0; left > 0; k++, left--) base[order[k % n].i] += 1;
  return base;
}

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA busy_timeout = 8000');

console.log('\n========== 母卷流水口径统一（等效支数 → 实际支数） ==========');
console.log(`  模式：${WRITE ? '修改' : '仅统计（加 --yes 才修改）'}\n`);

const mats = db.prepare("SELECT id,code,name,base_width FROM materials WHERE sub_unit='mm' ORDER BY code").all();
if (!mats.length) {
  console.log('  没有母卷物料。\n');
  process.exit(0);
}

const plans = [];
for (const m of mats) {
  const logs = db.prepare(
    'SELECT id,doc_type,doc_sn,qty_change,remark FROM inventory_logs WHERE material_id=? ORDER BY id'
  ).all(m.id);
  if (!logs.length) continue;

  const isCut = r => String(r.remark || '').startsWith('分切');
  const cutRows = logs.filter(isCut);
  const stock = db.prepare("SELECT COUNT(*) n FROM rolls WHERE material_id=? AND status='open'").get(m.id).n;

  const sumOf = rows => rows.reduce((a, r) => a + Number(r.qty_change), 0);
  const O = sumOf(logs.filter(r => !isCut(r)));   // 入库 + 整支出库 + 回滚
  const C_old = sumOf(cutRows);
  const C_new = stock - O;                        // 分切行应该代表的支数变动

  const diff = C_new - C_old;
  if (Math.abs(diff) < EPS) {
    console.log(`  ${m.code} ${m.name}：已统一，跳过（分切 ${cutRows.length} 条，合计 ${round3(C_old)} 支，在库 ${stock} 支）`);
    continue;
  }
  if (Math.abs(C_new - Math.round(C_new)) > 1e-4) {
    console.log(`  ${m.code} ${m.name}：⚠ 目标支数 ${round3(C_new)} 不是整数，跳过，请人工核查`);
    continue;
  }
  plans.push({ m, logs, cutRows, O, C_old, C_new, stock, diff });
}

if (!plans.length) {
  console.log('\n  全部一致，无需处理。\n');
  process.exit(0);
}

console.log('\n  待处理：');
for (const p of plans) {
  console.log(`  ${p.m.code} ${p.m.name}`);
  console.log(`     在库 ${p.stock} 支｜入库+整支 ${round3(p.O)}｜分切 ${p.cutRows.length} 条，原合计 ${round3(p.C_old)} 支 → 应为 ${round3(p.C_new)} 支（差 ${round3(p.diff)}）`);
}

if (!WRITE) {
  console.log('\n  统计结束，未修改。确认后加 --yes。\n');
  process.exit(0);
}

// 备份
const backupDir = path.join(__dirname, '..', 'data', 'backup');
fs.mkdirSync(backupDir, { recursive: true });
const stamp = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace(/[-:T]/g, '');
const bakFile = path.join(backupDir, `wanlou-before-rollunit-${stamp}.db`);
db.exec(`VACUUM INTO '${bakFile.replace(/'/g, "''")}'`);
console.log(`\n  已备份：${path.relative(path.join(__dirname, '..'), bakFile)}`);

const updQty = db.prepare('UPDATE inventory_logs SET qty_change=?, qty_before=?, qty_after=?, remark=? WHERE id=?');

db.exec('BEGIN');
try {
  for (const p of plans) {
    const weights = p.cutRows.map(r => pickWidth(r.remark));
    const units = distribute(weights, Math.abs(Math.round(p.C_new)));
    const newQty = new Map();
    p.cutRows.forEach((r, i) => {
      const closed = units[i];
      const q = -closed;
      const w = pickWidth(r.remark);
      newQty.set(r.id, {
        qty: q,
        remark: `分切占用 ${round3(w)}mm${closed ? `，切完 ${closed} 支` : '，支数不变'}`
      });
    });

    // 按时间顺序重算结存，保证前后连续
    let run = 0;
    let changed = 0;
    for (const r of p.logs) {
      const before = run;
      const q = newQty.has(r.id) ? newQty.get(r.id).qty : Number(r.qty_change);
      run = Math.round((run + q) * 1e6) / 1e6;
      if (newQty.has(r.id)) {
        updQty.run(q, before, run, newQty.get(r.id).remark, r.id);
        changed++;
      } else if (Math.abs(Number(r.qty_change) - q) > EPS) {
        updQty.run(q, before, run, r.remark, r.id);
        changed++;
      }
    }
    console.log(`  ${p.m.code}：更新 ${changed} 条，分切合计 ${round3(p.C_old)} → ${round3(p.C_new)}，结存收尾 ${round3(run)} 支（在库 ${p.stock} 支）`);
  }
  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  throw e;
}

// 复核
console.log('\n  复核：');
let ok = true;
for (const p of plans) {
  const sum = db.prepare('SELECT COALESCE(SUM(qty_change),0) s FROM inventory_logs WHERE material_id=?').get(p.m.id).s;
  const frac = db.prepare('SELECT COUNT(*) n FROM inventory_logs WHERE material_id=? AND ABS(qty_change-ROUND(qty_change))>0.0001').get(p.m.id).n;
  const good = Math.abs(sum - p.stock) < 0.01 && frac === 0;
  if (!good) ok = false;
  console.log(`  ${p.m.code}：流水合计 ${round3(sum)} 支｜在库 ${p.stock} 支｜小数行 ${frac} 条 ${good ? '✓' : '✗'}`);
}
console.log(`\n========== ${ok ? '完成' : '仍有差异，请检查'} ==========\n`);
