'use strict';
/**
 * 库存盘点：PD + 日期 + 序号
 * 盘点流程：生成盘点单（带账面数）→ 填写实盘 → 提交 → 审核通过 → 按差异调整库存
 */
const { route, bad, notFound, logAction } = require('../http-framework');
const { db, now, today } = require('../db');
const { round2, round3, round4 } = require('./docs');

db.exec(`CREATE TABLE IF NOT EXISTS stock_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sn TEXT NOT NULL UNIQUE,
  check_date TEXT NOT NULL,
  warehouse_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',   -- draft|pending|approved|void
  remark TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL,
  audited_by INTEGER,
  audited_at TEXT,
  total_gain REAL DEFAULT 0,
  total_loss REAL DEFAULT 0,
  gain_amount REAL DEFAULT 0,
  loss_amount REAL DEFAULT 0
)`);

db.exec(`CREATE TABLE IF NOT EXISTS stock_check_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  check_id INTEGER NOT NULL,
  material_id INTEGER NOT NULL,
  book_qty REAL NOT NULL DEFAULT 0,
  real_qty REAL,
  diff_qty REAL DEFAULT 0,
  cost REAL DEFAULT 0,
  remark TEXT
)`);

function makeSn() {
  const prefix = db.prepare("SELECT value FROM settings WHERE key='sn_prefix_CHECK'").get()?.value || 'PD';
  const day = today().replace(/-/g, '');
  const row = db.prepare('SELECT sn FROM stock_checks WHERE sn LIKE ? ORDER BY id DESC LIMIT 1').get(`${prefix}${day}%`);
  let n = 1;
  if (row) {
    const parsed = parseInt(String(row.sn).slice(-4), 10);
    if (!isNaN(parsed)) n = parsed + 1;
  }
  return `${prefix}${day}${String(n).padStart(4, '0')}`;
}

function bookQty(materialId, warehouseId) {
  const m = db.prepare('SELECT * FROM materials WHERE id=?').get(materialId);
  if (!m) return 0;
  if (m.type === 'master') {
    return db.prepare("SELECT COUNT(*) n FROM rolls WHERE material_id=? AND warehouse_id=? AND status='open'").get(materialId, warehouseId).n;
  }
  const r = db.prepare('SELECT qty FROM inventory WHERE material_id=? AND warehouse_id=?').get(materialId, warehouseId);
  return r?.qty || 0;
}

/* ---------- 列表 ---------- */
route('GET', '/api/checks', async (ctx) => {
  ctx.need('check.view');
  const rows = db.prepare(`SELECT c.*, w.name AS warehouse_name, u.name AS creator_name, a.name AS auditor_name
                           FROM stock_checks c
                           LEFT JOIN warehouses w ON w.id=c.warehouse_id
                           LEFT JOIN users u ON u.id=c.created_by
                           LEFT JOIN users a ON a.id=c.audited_by
                           ORDER BY c.id DESC LIMIT 200`).all();
  const showCost = ctx.can('cost.view');
  const list = rows.map(r => {
    const o = { ...r, statusName: statusName(r.status) };
    if (!showCost) { delete o.gain_amount; delete o.loss_amount; }
    return o;
  });
  return { list };
});

/* ---------- 详情 ---------- */
route('GET', '/api/checks/:id', async (ctx) => {
  ctx.need('check.view');
  const c = db.prepare('SELECT * FROM stock_checks WHERE id=?').get(Number(ctx.params.id));
  if (!c) notFound('盘点单不存在');
  const items = db.prepare(`SELECT i.*, m.name AS material_name, m.code AS material_code, m.spec, m.unit, m.type AS material_type
                            FROM stock_check_items i LEFT JOIN materials m ON m.id=i.material_id
                            WHERE i.check_id=? ORDER BY i.id`).all(c.id);
  const w = db.prepare('SELECT name FROM warehouses WHERE id=?').get(c.warehouse_id);
  const showCost = ctx.can('cost.view');
  const out = { ...c, statusName: statusName(c.status), warehouse_name: w?.name || '', items };
  if (!showCost) {
    delete out.gain_amount; delete out.loss_amount;
    out.items = out.items.map(i => { const t = { ...i }; delete t.cost; return t; });
  }
  return out;
});

/* ---------- 新建盘点单（自动带入账面数） ---------- */
route('POST', '/api/checks', async (ctx) => {
  ctx.need('check.create');
  const b = ctx.body;
  if (!b.warehouse_id) bad('请选择盘点仓库');
  const wh = db.prepare('SELECT * FROM warehouses WHERE id=?').get(b.warehouse_id);
  if (!wh) bad('仓库不存在');

  const sn = makeSn();
  const r = db.prepare(`INSERT INTO stock_checks(sn,check_date,warehouse_id,status,remark,created_by,created_at)
                        VALUES (?,?,?,'draft',?,?,?)`)
    .run(sn, b.check_date || today(), b.warehouse_id, b.remark || '', ctx.user.userId, now());
  const checkId = Number(r.lastInsertRowid);

  // 自动生成明细：当前仓库所有有库存的物料（含母卷）
  const mats = db.prepare('SELECT * FROM materials WHERE status=1').all();
  const ins = db.prepare(`INSERT INTO stock_check_items(check_id,material_id,book_qty,real_qty,diff_qty,cost)
                          VALUES (?,?,?,?,0,?)`);
  for (const m of mats) {
    const bq = bookQty(m.id, b.warehouse_id);
    if (bq <= 0) continue;
    ins.run(checkId, m.id, round3(bq), round3(bq), m.cost || 0);
  }
  logAction(ctx, 'create', 'check', `新建盘点单 ${sn}`);
  return { id: checkId, sn };
});

/* ---------- 保存盘点结果 ---------- */
route('PUT', '/api/checks/:id', async (ctx) => {
  ctx.need('check.create');
  const id = Number(ctx.params.id);
  const c = db.prepare('SELECT * FROM stock_checks WHERE id=?').get(id);
  if (!c) notFound('盘点单不存在');
  if (!['draft', 'pending'].includes(c.status)) bad('只有草稿或待审核的盘点单可以修改');

  const items = Array.isArray(ctx.body.items) ? ctx.body.items : [];
  for (const it of items) {
    const row = db.prepare('SELECT * FROM stock_check_items WHERE id=? AND check_id=?').get(it.id, id);
    if (!row) continue;
    const real = Number(it.real_qty);
    if (isNaN(real) || real < 0) bad('实盘数量必须是不小于 0 的数字');
    db.prepare('UPDATE stock_check_items SET real_qty=?, diff_qty=?, remark=? WHERE id=?')
      .run(round3(real), round3(real - row.book_qty), it.remark || '', row.id);
  }
  recompute(id);
  if (ctx.body.remark !== undefined) {
    db.prepare('UPDATE stock_checks SET remark=? WHERE id=?').run(ctx.body.remark, id);
  }
  if (ctx.body.submit) {
    db.prepare("UPDATE stock_checks SET status='pending' WHERE id=?").run(id);
  }
  logAction(ctx, 'update', 'check', `更新盘点单 ${c.sn}`);
  return {};
});

function recompute(id) {
  const items = db.prepare('SELECT * FROM stock_check_items WHERE check_id=?').all(id);
  let gain = 0, loss = 0, gainAmt = 0, lossAmt = 0;
  for (const it of items) {
    const d = Number(it.diff_qty) || 0;
    if (d > 0) { gain += d; gainAmt += d * (it.cost || 0); }
    else if (d < 0) { loss += -d; lossAmt += -d * (it.cost || 0); }
  }
  db.prepare('UPDATE stock_checks SET total_gain=?, total_loss=?, gain_amount=?, loss_amount=? WHERE id=?')
    .run(round3(gain), round3(loss), round2(gainAmt), round2(lossAmt), id);
}

/* ---------- 审核通过：按差异调整库存 ---------- */
route('POST', '/api/checks/:id/approve', async (ctx) => {
  ctx.need('check.audit');
  const id = Number(ctx.params.id);
  const c = db.prepare('SELECT * FROM stock_checks WHERE id=?').get(id);
  if (!c) notFound('盘点单不存在');
  if (c.status !== 'pending') bad('只有待审核的盘点单可以审核');

  const items = db.prepare('SELECT * FROM stock_check_items WHERE check_id=?').all(id);
  for (const it of items) {
    const diff = Number(it.diff_qty) || 0;
    if (Math.abs(diff) < 1e-9) continue;
    const m = db.prepare('SELECT * FROM materials WHERE id=?').get(it.material_id);
    if (m.type === 'master') {
      // 母卷：盘盈补建空卷，盘亏作废最早的开卷
      if (diff > 0) {
        for (let i = 0; i < Math.round(diff); i++) {
          db.prepare(`INSERT INTO rolls(material_id,warehouse_id,batch_no,width_total,width_used,cost,status,created_at)
                      VALUES (?,?,'',?,0,?,'open',?)`)
            .run(m.id, c.warehouse_id, m.base_width, m.cost || 0, now());
        }
      } else {
        const open = db.prepare("SELECT * FROM rolls WHERE material_id=? AND warehouse_id=? AND status='open' ORDER BY id LIMIT ?")
          .all(m.id, c.warehouse_id, Math.round(-diff));
        for (const roll of open) db.prepare("UPDATE rolls SET status='used' WHERE id=?").run(roll.id);
      }
    } else {
      const before = bookQty(m.id, c.warehouse_id);
      const after = before + diff;
      db.prepare(`INSERT INTO inventory(material_id,warehouse_id,qty) VALUES (?,?,?)
                  ON CONFLICT(material_id,warehouse_id) DO UPDATE SET qty=excluded.qty`)
        .run(m.id, c.warehouse_id, round3(Math.max(0, after)));
      db.prepare(`INSERT INTO inventory_logs(material_id,warehouse_id,doc_type,doc_sn,qty_change,qty_before,qty_after,cost,amount,remark,operator_id,created_at)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(m.id, c.warehouse_id, 'CHECK', c.sn, diff, before, after,
          m.cost || 0, Math.abs(diff) * (m.cost || 0), diff > 0 ? '盘盈' : '盘亏', ctx.user.userId, now());
    }
  }
  db.prepare("UPDATE stock_checks SET status='approved', audited_by=?, audited_at=? WHERE id=?")
    .run(ctx.user.userId, now(), id);
  logAction(ctx, 'approve', 'check', `审核盘点单 ${c.sn}，库存已调整`);
  return {};
});

/* ---------- 作废 ---------- */
route('POST', '/api/checks/:id/void', async (ctx) => {
  if (ctx.user.role !== 'admin') bad('只有超级管理员可以作废盘点单');
  const id = Number(ctx.params.id);
  const c = db.prepare('SELECT * FROM stock_checks WHERE id=?').get(id);
  if (!c) notFound('盘点单不存在');
  if (c.status === 'approved') bad('已审核的盘点单不能作废，请做一次反向盘点');
  db.prepare("UPDATE stock_checks SET status='void' WHERE id=?").run(id);
  logAction(ctx, 'void', 'check', `作废盘点单 ${c.sn}`);
  return {};
});

function statusName(s) {
  return { draft: '盘点中', pending: '待审核', approved: '已审核', void: '已作废' }[s] || s;
}

module.exports = {};
