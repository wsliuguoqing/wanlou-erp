'use strict';
/**
 * 一次性数据修复：退回「非已审核单据」残留的库存变动
 *
 * 背景：approveDoc() 原来没有事务，逐行扣库存时某一行失败会抛错，
 * 但前面几行已经扣掉的库存留在库里不回滚。单据停在待审核或被驳回，
 * 库存却凭空少了。M0006 镀锡铜编织线就这样被两张驳回单吃掉 100 米。
 *
 * 本脚本按 stock_effects 原样退回这些变动，并写一条可追溯的流水。
 * 默认只预览（dry-run），确认无误后加 --apply 真正执行。
 *
 * 用法：
 *   node test/fix-orphan-stock-effects.js            # 只看要改什么
 *   node test/fix-orphan-stock-effects.js --apply    # 真正执行
 */
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const APPLY = process.argv.includes('--apply');
const dbPath = process.env.WL_DB || path.join(__dirname, '..', 'data', 'wanlou.db');
const db = new DatabaseSync(dbPath);

const round3 = n => Math.round(n * 1000) / 1000;
const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

// 已审核的单据本就该有库存变动，只找状态不对的
const dirty = db.prepare(`
  SELECT d.id, d.sn, d.type, d.status
  FROM docs d JOIN stock_effects se ON se.doc_id = d.id
  WHERE d.status != 'approved'
  GROUP BY d.id ORDER BY d.id`).all();

if (!dirty.length) {
  console.log('没有发现残留的库存变动，无需修复。');
  process.exit(0);
}

console.log(`\n发现 ${dirty.length} 张状态不是「已审核」却留有库存变动的单据：\n`);

const plan = [];
// 同一物料可能被多张脏单各扣一笔，预览要累计，否则每行都显示成从当前库存起算
const preview = new Map();
const previewStock = (materialId, warehouseId) => {
  const k = materialId + '|' + warehouseId;
  if (!preview.has(k)) {
    const inv = db.prepare('SELECT qty, sub_qty FROM inventory WHERE material_id=? AND warehouse_id=?')
      .get(materialId, warehouseId) || { qty: 0, sub_qty: 0 };
    preview.set(k, { qty: inv.qty || 0, sub_qty: inv.sub_qty || 0 });
  }
  return preview.get(k);
};

for (const doc of dirty) {
  const effects = db.prepare('SELECT * FROM stock_effects WHERE doc_id=?').all(doc.id);
  for (const e of effects) {
    const mat = db.prepare('SELECT * FROM materials WHERE id=?').get(e.material_id);
    plan.push({ doc, effect: e, mat });
    const cur = previewStock(e.material_id, e.warehouse_id);
    console.log(`  ${doc.sn}（${doc.status}）`);

    if (e.kind === 'subqty') {
      const perPack = Number(mat.base_width) || 1;
      const before = round3(cur.qty * perPack + cur.sub_qty);
      const after = round3(before - e.qty_delta);   // qty_delta 是负数，减去即退回
      const whole = Math.floor(after / perPack);
      const loose = round3(after - whole * perPack);
      cur.qty = whole; cur.sub_qty = loose;
      console.log(`    ${mat.code} ${mat.name}：退回 ${Math.abs(e.qty_delta)} ${mat.sub_unit}`);
      console.log(`    库存 ${before} ${mat.sub_unit} → ${after} ${mat.sub_unit}（即 ${whole} ${mat.unit} + ${loose} ${mat.sub_unit}）`);
    } else if (e.kind === 'inv') {
      const before = cur.qty;
      const after = round3(before - e.qty_delta);
      cur.qty = after;
      console.log(`    ${mat.code} ${mat.name}：退回 ${Math.abs(e.qty_delta)} ${mat.unit}，库存 ${before} → ${after}`);
    } else {
      console.log(`    ${mat.code} ${mat.name}：${e.kind}，母卷 ref_id=${e.ref_id}，宽度 ${e.width_delta}mm`);
    }
  }
}

if (!APPLY) {
  console.log('\n以上是预览，没有改动任何数据。');
  console.log('确认无误后执行：node test/fix-orphan-stock-effects.js --apply\n');
  process.exit(0);
}

console.log('\n开始执行…');
db.exec('BEGIN');
try {
  for (const { doc, effect: e, mat } of plan) {
    if (e.kind === 'subqty') {
      const perPack = Number(mat.base_width) || 1;
      const cur = db.prepare('SELECT qty, sub_qty FROM inventory WHERE material_id=? AND warehouse_id=?')
        .get(e.material_id, e.warehouse_id) || { qty: 0, sub_qty: 0 };
      const before = (cur.qty || 0) * perPack + (cur.sub_qty || 0);
      const after = round3(before - e.qty_delta);
      const whole = Math.floor(after / perPack);
      const loose = round3(after - whole * perPack);
      db.prepare(`INSERT INTO inventory(material_id,warehouse_id,qty,sub_qty) VALUES (?,?,?,?)
                  ON CONFLICT(material_id,warehouse_id) DO UPDATE SET qty=excluded.qty,sub_qty=excluded.sub_qty`)
        .run(e.material_id, e.warehouse_id, whole, loose);
      db.prepare(`INSERT INTO inventory_logs(material_id,warehouse_id,doc_type,doc_sn,qty_change,qty_before,qty_after,cost,amount,remark,operator_id,created_at)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(e.material_id, e.warehouse_id, 'VOID', doc.sn, -e.qty_delta, before, after,
          e.cost || 0, Math.abs(e.qty_delta) * (e.cost || 0),
          `数据修复：${doc.status === 'rejected' ? '已驳回' : '未审核'}单据残留库存回退`, null, now());
    } else if (e.kind === 'inv') {
      const cur = db.prepare('SELECT qty FROM inventory WHERE material_id=? AND warehouse_id=?')
        .get(e.material_id, e.warehouse_id);
      const before = cur ? cur.qty : 0;
      const after = round3(before - e.qty_delta);
      db.prepare(`INSERT INTO inventory(material_id,warehouse_id,qty) VALUES (?,?,?)
                  ON CONFLICT(material_id,warehouse_id) DO UPDATE SET qty=excluded.qty`)
        .run(e.material_id, e.warehouse_id, after);
      db.prepare(`INSERT INTO inventory_logs(material_id,warehouse_id,doc_type,doc_sn,qty_change,qty_before,qty_after,cost,amount,remark,operator_id,created_at)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(e.material_id, e.warehouse_id, 'VOID', doc.sn, -e.qty_delta, before, after,
          e.cost || 0, Math.abs(e.qty_delta) * (e.cost || 0),
          `数据修复：${doc.status === 'rejected' ? '已驳回' : '未审核'}单据残留库存回退`, null, now());
    } else if (e.kind === 'roll_create') {
      db.prepare('DELETE FROM rolls WHERE id=?').run(e.ref_id);
    } else if (e.kind === 'roll_consume') {
      const roll = db.prepare('SELECT * FROM rolls WHERE id=?').get(e.ref_id);
      if (roll) {
        const newUsed = Math.max(0, roll.width_used + e.width_delta);
        const leftover = roll.width_total - newUsed;
        const minWaste = db.prepare('SELECT min_waste FROM materials WHERE id=?').get(e.material_id)?.min_waste ?? 10;
        const status = leftover >= minWaste ? 'open' : (leftover <= 1e-9 ? 'used' : 'waste');
        db.prepare('UPDATE rolls SET width_used=?, status=? WHERE id=?').run(round3(newUsed), status, roll.id);
      }
    }
    db.prepare('DELETE FROM stock_effects WHERE id=?').run(e.id);
  }
  db.exec('COMMIT');
  console.log('修复完成。\n');
} catch (err) {
  db.exec('ROLLBACK');
  console.error('修复失败，已回滚：', err.message);
  process.exitCode = 1;
}
