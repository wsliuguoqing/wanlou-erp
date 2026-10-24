'use strict';
/**
 * 单据模块：入库 / 出库 / 销售退货 / 采购退货
 * 核心：审批通过才动库存，作废原路回滚，移动加权平均成本，胶带分切按宽度扣减
 */
const { route, bad, notFound, forbidden, logAction } = require('../http-framework');
const { db, now, today } = require('../db');
const { nextCode } = require('./base');

/* 退货单引用的原单（出库单/入库单）。老库升级时补字段 */
try { db.exec('ALTER TABLE docs ADD COLUMN origin_doc_id INTEGER'); } catch { /* 已存在 */ }
try { db.exec('ALTER TABLE docs ADD COLUMN return_status TEXT'); } catch { /* 已存在 */ }

/* 记录库存影响，便于作废时精确回滚 */
db.exec(`CREATE TABLE IF NOT EXISTS stock_effects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id INTEGER NOT NULL,
  kind TEXT NOT NULL,          -- inv | roll_create | roll_consume
  material_id INTEGER NOT NULL,
  warehouse_id INTEGER NOT NULL,
  ref_id INTEGER,              -- rolls.id
  qty_delta REAL DEFAULT 0,
  width_delta REAL DEFAULT 0,
  cost REAL DEFAULT 0,
  batch_no TEXT
)`);

const DOC_META = {
  IN:    { name: '入库单',   partner: 'supplier', view: 'inbound.view', create: 'inbound.create', edit: 'inbound.edit', audit: 'inbound.audit', void: 'inbound.void', prefixKey: 'sn_prefix_IN' },
  OUT:   { name: '出库单',   partner: 'customer', view: 'outbound.view', create: 'outbound.create', edit: 'outbound.edit', audit: 'outbound.audit', void: 'outbound.void', prefixKey: 'sn_prefix_OUT' },
  SRET:  { name: '销售退货单', partner: 'customer', view: 'sret.view', create: 'sret.create', edit: 'sret.create', audit: 'sret.audit', void: 'sret.void', prefixKey: 'sn_prefix_SRET' },
  PRET:  { name: '采购退货单', partner: 'supplier', view: 'pret.view', create: 'pret.create', edit: 'pret.create', audit: 'pret.audit', void: 'pret.void', prefixKey: 'sn_prefix_PRET' }
};

const STATUS_NAME = { draft: '草稿', pending: '待审核', approved: '已审核', rejected: '已驳回', void: '已作废' };

function setting(key, def = '') {
  const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return r ? r.value : def;
}

/* ---------------- 单号 ---------------- */
function makeSn(type) {
  const meta = DOC_META[type];
  const prefix = setting(meta.prefixKey, 'SN');
  const day = today().replace(/-/g, '');
  const like = `${prefix}${day}%`;
  const row = db.prepare('SELECT sn FROM docs WHERE sn LIKE ? ORDER BY id DESC LIMIT 1').get(like);
  let n = 1;
  if (row) {
    const tail = String(row.sn).slice(-4);
    const parsed = parseInt(tail, 10);
    if (!isNaN(parsed)) n = parsed + 1;
  }
  return `${prefix}${day}${String(n).padStart(4, '0')}`;
}

/* ---------------- 库存基础操作 ---------------- */
function invGet(materialId, warehouseId) {
  const r = db.prepare('SELECT qty FROM inventory WHERE material_id=? AND warehouse_id=?').get(materialId, warehouseId);
  return r ? r.qty : 0;
}
function invSet(materialId, warehouseId, qty) {
  db.prepare(`INSERT INTO inventory(material_id,warehouse_id,qty) VALUES (?,?,?)
              ON CONFLICT(material_id,warehouse_id) DO UPDATE SET qty=excluded.qty`)
    .run(materialId, warehouseId, qty);
}
function writeLog({ materialId, warehouseId, docType, docSn, delta, before, after, cost, amount, remark, operatorId }) {
  db.prepare(`INSERT INTO inventory_logs(material_id,warehouse_id,doc_type,doc_sn,qty_change,qty_before,qty_after,cost,amount,remark,operator_id,created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(materialId, warehouseId, docType, docSn, delta, before, after, cost || 0, amount || 0, remark || '', operatorId || null, now());
}

/** 普通物料/子卷入出库：改 inventory，并按移动加权更新成本 */
function moveInventory({ materialId, warehouseId, delta, cost, docType, docSn, operatorId, remark }) {
  const mat = db.prepare('SELECT * FROM materials WHERE id=?').get(materialId);
  const before = invGet(materialId, warehouseId);
  const after = before + delta;
  if (after < -1e-9) bad(`${mat.name} 库存不足，当前可用 ${fmt(before)}`);

  invSet(materialId, warehouseId, round3(after));

  // 移动加权平均：仅在入库时重算
  if (delta > 0 && cost > 0) {
    const totalAmount = before * (mat.cost || 0) + delta * cost;
    const newCost = after > 0 ? totalAmount / after : cost;
    db.prepare('UPDATE materials SET cost=? WHERE id=?').run(round4(newCost), materialId);
  }

  writeLog({
    materialId, warehouseId, docType, docSn, delta, before, after,
    cost: cost || mat.cost, amount: Math.abs(delta) * (cost || mat.cost || 0),
    remark, operatorId
  });
  db.prepare(`INSERT INTO stock_effects(doc_id,kind,material_id,warehouse_id,qty_delta,cost)
              VALUES (?,?,?,?,?,?)`)
    .run(docSn.__docId || 0, 'inv', materialId, warehouseId, delta, cost || mat.cost || 0);
}

/** 母卷：入库生成物理卷 */
function createRolls({ docId, materialId, warehouseId, count, unitCost, batchNo }) {
  const mat = db.prepare('SELECT * FROM materials WHERE id=?').get(materialId);
  if (!mat.base_width) bad(`${mat.name} 未设置母卷宽度`);
  const ins = db.prepare(`INSERT INTO rolls(material_id,warehouse_id,batch_no,width_total,width_used,cost,status,created_at)
                          VALUES (?,?,?,?,0,?,'open',?)`);
  for (let i = 0; i < count; i++) {
    const r = ins.run(materialId, warehouseId, batchNo || '', mat.base_width, unitCost, now());
    db.prepare('INSERT INTO stock_effects(doc_id,kind,material_id,warehouse_id,ref_id,width_delta,cost,batch_no) VALUES (?,?,?,?,?,?,?,?)')
      .run(docId, 'roll_create', materialId, warehouseId, Number(r.lastInsertRowid), mat.base_width, unitCost, batchNo || '');
  }
  // 母卷成本按加权平均记录
  const openRolls = db.prepare("SELECT * FROM rolls WHERE material_id=? AND warehouse_id=? AND status='open'").all(materialId, warehouseId);
  const totalCost = openRolls.reduce((s, r) => s + r.cost, 0);
  db.prepare('UPDATE materials SET cost=? WHERE id=?')
    .run(round4(openRolls.length ? totalCost / openRolls.length : unitCost), materialId);

  writeLog({
    materialId, warehouseId, docType: 'IN', docSn: '', delta: count, before: openRolls.length - count,
    after: openRolls.length, cost: unitCost, amount: count * unitCost, remark: '母卷入库', operatorId: null
  });
}

/** 母卷：按宽度分切消耗（FIFO），返回消耗总成本 */
function consumeRollWidth({ docId, materialId, warehouseId, needWidth, operatorId, docSn }) {
  let remain = needWidth;
  let totalCost = 0;
  const rolls = db.prepare("SELECT * FROM rolls WHERE material_id=? AND warehouse_id=? AND status='open' ORDER BY id")
    .all(materialId, warehouseId);
  for (const roll of rolls) {
    if (remain <= 1e-9) break;
    const avail = roll.width_total - roll.width_used;
    if (avail <= 1e-9) continue;
    const take = Math.min(avail, remain);
    const newUsed = roll.width_used + take;
    const leftover = roll.width_total - newUsed;
    const minWaste = db.prepare('SELECT min_waste FROM materials WHERE id=?').get(materialId)?.min_waste ?? 10;
    const status = leftover <= 1e-9 ? 'used' : (leftover < minWaste ? 'waste' : 'open');
    db.prepare('UPDATE rolls SET width_used=?, status=? WHERE id=?').run(round3(newUsed), status, roll.id);
    totalCost += (take / roll.width_total) * roll.cost;
    db.prepare('INSERT INTO stock_effects(doc_id,kind,material_id,warehouse_id,ref_id,width_delta,cost) VALUES (?,?,?,?,?,?,?)')
      .run(docId, 'roll_consume', materialId, warehouseId, roll.id, -take, (take / roll.width_total) * roll.cost);
    writeLog({
      materialId, warehouseId, docType: 'OUT', docSn, delta: -take / roll.width_total,
      before: avail / roll.width_total, after: leftover / roll.width_total,
      cost: roll.cost, amount: (take / roll.width_total) * roll.cost,
      remark: `分切 ${take}mm${status === 'waste' ? '（产生料头）' : ''}`, operatorId
    });
    remain -= take;
  }
  if (remain > 1e-6) bad('母卷可用宽度不足');
  return totalCost;
}

/** 母卷：整支出库 */
function consumeWholeRoll({ docId, materialId, warehouseId, operatorId, docSn }) {
  const roll = db.prepare("SELECT * FROM rolls WHERE material_id=? AND warehouse_id=? AND status='open' ORDER BY id LIMIT 1")
    .get(materialId, warehouseId);
  if (!roll) bad('没有可用的整支母卷');
  db.prepare("UPDATE rolls SET width_used=width_total, status='used' WHERE id=?").run(roll.id);
  db.prepare('INSERT INTO stock_effects(doc_id,kind,material_id,warehouse_id,ref_id,width_delta,cost) VALUES (?,?,?,?,?,?,?)')
    .run(docId, 'roll_consume', materialId, warehouseId, roll.id, -(roll.width_total - roll.width_used), roll.cost);
  writeLog({
    materialId, warehouseId, docType: 'OUT', docSn, delta: -1,
    before: 1, after: 0, cost: roll.cost, amount: roll.cost, remark: '整支母卷出库', operatorId
  });
  return roll.cost;
}

/** 找或建同规格子卷物料 */
function ensureSubMaterial(masterId, width, unitCost) {
  const master = db.prepare('SELECT * FROM materials WHERE id=?').get(masterId);
  const spec = `${width}mm`;
  let sub = db.prepare('SELECT * FROM materials WHERE parent_id=? AND spec=?').get(masterId, spec);
  if (sub) {
    if (unitCost > 0) db.prepare('UPDATE materials SET cost=? WHERE id=?').run(round4(unitCost), sub.id);
    return sub;
  }
  const code = nextCode('materials', 'M');
  const r = db.prepare(`INSERT INTO materials(code,name,brand,spec,unit,type,base_width,min_waste,cut_fee,parent_id,safety_stock,cost,status,created_at)
                        VALUES (?,?,?,?,?,?,?,?,?,?,0,?,1,?)`)
    .run(code, master.name, master.brand || '', spec, '卷', 'sub', null, 10,
      master.cut_fee || 0, masterId, round4(unitCost || 0), now());
  return db.prepare('SELECT * FROM materials WHERE id=?').get(Number(r.lastInsertRowid));
}

/* ---------------- 计算单据合计 ---------------- */
function calcDoc(docId) {
  const items = db.prepare('SELECT * FROM doc_items WHERE doc_id=?').all(docId);
  let amount = 0, cost = 0;
  for (const it of items) {
    amount += Number(it.amount) || 0;
    cost += Number(it.cost_amount) || 0;
  }
  db.prepare('UPDATE docs SET total_amount=?, total_cost=? WHERE id=?').run(round2(amount), round2(cost), docId);
  return { amount, cost };
}

/* ---------------- 保存单据（草稿/提交） ---------------- */
function saveDoc(ctx, docId, type, submit) {
  const meta = DOC_META[type];
  ctx.need(submit ? meta.create : meta.edit);
  const b = ctx.body;

  if (!b.warehouse_id) bad('请选择仓库');
  if (!b.partner_id) bad(`请选择${meta.partner === 'customer' ? '客户' : '供应商'}`);
  if (!Array.isArray(b.items) || b.items.length === 0) bad('至少添加一行明细');

  const warehouse = db.prepare('SELECT * FROM warehouses WHERE id=?').get(b.warehouse_id);
  if (!warehouse) bad('仓库不存在');

  let doc;
  if (docId) {
    doc = db.prepare('SELECT * FROM docs WHERE id=?').get(docId);
    if (!doc || doc.type !== type) notFound('单据不存在');
    if (!['draft', 'rejected'].includes(doc.status)) bad('只有草稿或已驳回的单据可以修改');
    if (ctx.user.role === 'sales' && doc.created_by !== ctx.user.userId) forbidden('只能修改自己的单据');
  }

  const docDate = b.doc_date || today();

  // 取得用户可读的成本：只有有 cost.view 权限才接受前端传来的成本，否则由系统算
  const itemsPrepared = b.items.map(it => {
    const mat = db.prepare('SELECT * FROM materials WHERE id=?').get(it.material_id);
    if (!mat) bad('物料不存在');
    const qty = Number(it.qty) || 0;
    if (qty <= 0) bad(`${mat.name} 数量必须大于 0`);
    const price = Number(it.price) || 0;
    if (price < 0) bad('单价不能为负');
    const amount = round2(qty * price);
    let costPrice = Number(mat.cost) || 0;
    let costAmount = round2(costPrice * qty);
    let cutWidth = null, cutQty = null;

    if (type === 'OUT' && mat.type === 'master') {
      cutWidth = Number(it.cut_width) || 0;
      cutQty = qty; // 数量即卷数
      if (cutWidth > 0) {
        if (cutWidth > mat.base_width) bad(`${mat.name} 切取宽度不能大于母卷宽度 ${mat.base_width}mm`);
        // 成本 = 按宽度比例分摊母卷成本 + 分切费
        const share = cutWidth / mat.base_width;
        costPrice = round4(costPrice * share + (mat.cut_fee || 0));
        costAmount = round2(costPrice * qty * 1);
      } else {
        costPrice = Number(mat.cost) || 0;
        costAmount = round2(costPrice * qty);
      }
    }
    return {
      material_id: mat.id, qty, price, amount,
      cost_price: costPrice, cost_amount: costAmount,
      cut_width: cutWidth, cut_qty: cutQty,
      batch_no: it.batch_no || '', remark: it.remark || ''
    };
  });

  const status = submit ? 'pending' : 'draft';
  let id = docId;

  if (!id) {
    const sn = makeSn(type);
    const r = db.prepare(`INSERT INTO docs(type,sn,doc_date,partner_id,warehouse_id,contract_sn,salesperson_id,status,
        total_amount,total_cost,invoice_status,carrier,receiver,receiver_phone,receiver_addr,remark,source_doc_id,
        origin_doc_id,created_by,created_at,submitted_at)
        VALUES (?,?,?,?,?,?,?,?,0,0,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(type, sn, docDate, b.partner_id, b.warehouse_id, b.contract_sn || '',
        b.salesperson_id || ctx.user.userId, status,
        Number(b.invoice_status) || 0, b.carrier || '', b.receiver || '',
        b.receiver_phone || '', b.receiver_addr || '', b.remark || '',
        b.source_doc_id || null, b.origin_doc_id || null,
        ctx.user.userId, now(), submit ? now() : null);
    id = Number(r.lastInsertRowid);
  } else {
    db.prepare(`UPDATE docs SET doc_date=?,partner_id=?,warehouse_id=?,contract_sn=?,salesperson_id=?,status=?,
                invoice_status=?,carrier=?,receiver=?,receiver_phone=?,receiver_addr=?,remark=?,source_doc_id=?,
                origin_doc_id=?,submitted_at=?,audit_reason=NULL WHERE id=?`)
      .run(docDate, b.partner_id, b.warehouse_id, b.contract_sn || '', b.salesperson_id || ctx.user.userId,
        status, Number(b.invoice_status) || 0, b.carrier || '', b.receiver || '',
        b.receiver_phone || '', b.receiver_addr || '', b.remark || '',
        b.source_doc_id || null, b.origin_doc_id || null, submit ? now() : null, id);
    db.prepare('DELETE FROM doc_items WHERE doc_id=?').run(id);
  }

  const insItem = db.prepare(`INSERT INTO doc_items(doc_id,material_id,qty,price,amount,cost_price,cost_amount,cut_width,cut_qty,batch_no,remark)
                              VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  for (const it of itemsPrepared) {
    insItem.run(id, it.material_id, it.qty, it.price, it.amount, it.cost_price, it.cost_amount,
      it.cut_width, it.cut_qty, it.batch_no, it.remark);
  }
  calcDoc(id);

  if (submit) {
    const needApproval = setting('need_approval', '1') === '1';
    if (!needApproval) {
      approveDoc(ctx, id);
    }
  }

  logAction(ctx, docId ? 'update' : 'create', type.toLowerCase(),
    `${meta.name} ${db.prepare('SELECT sn FROM docs WHERE id=?').get(id).sn}`);
  return { id };
}

/* ---------------- 审批通过：执行库存变动 ---------------- */
function approveDoc(ctx, docId) {
  const doc = db.prepare('SELECT * FROM docs WHERE id=?').get(docId);
  if (!doc) notFound('单据不存在');
  if (doc.status !== 'pending') bad('只有待审核的单据可以审核');
  if (ctx.user.role !== 'admin' && ctx.user.role !== 'manager') forbidden('只有主管或超级管理员可以审核');

  const items = db.prepare('SELECT * FROM doc_items WHERE doc_id=?').all(docId);

  // 先做库存可行性校验
  for (const it of items) {
    const mat = db.prepare('SELECT * FROM materials WHERE id=?').get(it.material_id);
    if (['OUT', 'PRET'].includes(doc.type)) {
      if (mat.type === 'master') {
        const openRolls = db.prepare("SELECT * FROM rolls WHERE material_id=? AND warehouse_id=? AND status='open'").all(it.material_id, doc.warehouse_id);
        if (it.cut_width > 0) {
          const need = it.cut_width * it.qty;
          const avail = openRolls.reduce((s, r) => s + (r.width_total - r.width_used), 0);
          if (need > avail + 1e-6) bad(`${mat.name} 可用宽度 ${round3(avail)}mm，本次需要 ${round3(need)}mm，不足`);
        } else if (openRolls.length < it.qty) {
          bad(`${mat.name} 可用整支仅 ${openRolls.length} 支，本次需要 ${it.qty} 支`);
        }
      } else {
        const avail = invGet(it.material_id, doc.warehouse_id);
        if (it.qty > avail + 1e-9) bad(`${mat.name} 库存 ${round3(avail)}，本次出库 ${round3(it.qty)}，不足`);
      }
    }
  }

  let totalCost = 0;

  for (const it of items) {
    const mat = db.prepare('SELECT * FROM materials WHERE id=?').get(it.material_id);
    const tag = { docId, material_id: it.material_id, warehouse_id: doc.warehouse_id };
    // 记录 effect 时用 doc_id 关联
    const pushEffect = (kind, refId, qtyDelta, widthDelta, cost) => {
      db.prepare(`INSERT INTO stock_effects(doc_id,kind,material_id,warehouse_id,ref_id,qty_delta,width_delta,cost,batch_no)
                  VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(docId, kind, it.material_id, doc.warehouse_id, refId || null, qtyDelta || 0, widthDelta || 0, cost || 0, it.batch_no || '');
    };

    if (doc.type === 'IN') {
      if (mat.type === 'master') {
        const unitCost = it.qty > 0 ? it.amount / it.qty : 0;
        for (let i = 0; i < Math.round(it.qty); i++) {
          const r = db.prepare(`INSERT INTO rolls(material_id,warehouse_id,batch_no,width_total,width_used,cost,status,created_at)
                                VALUES (?,?,?,?,0,?,'open',?)`)
            .run(it.material_id, doc.warehouse_id, it.batch_no || '', mat.base_width, unitCost, now());
          pushEffect('roll_create', Number(r.lastInsertRowid), 0, mat.base_width, unitCost);
        }
        const openRolls = db.prepare("SELECT * FROM rolls WHERE material_id=? AND warehouse_id=? AND status='open'").all(it.material_id, doc.warehouse_id);
        const avg = openRolls.reduce((s, r) => s + r.cost, 0) / (openRolls.length || 1);
        db.prepare('UPDATE materials SET cost=? WHERE id=?').run(round4(avg), it.material_id);
        writeLog({ materialId: it.material_id, warehouseId: doc.warehouse_id, docType: 'IN', docSn: doc.sn,
          delta: it.qty, before: openRolls.length - it.qty, after: openRolls.length,
          cost: unitCost, amount: it.amount, remark: '母卷入库', operatorId: ctx.user.userId });
        totalCost += it.amount;
      } else {
        const before = invGet(it.material_id, doc.warehouse_id);
        const after = before + it.qty;
        invSet(it.material_id, doc.warehouse_id, round3(after));
        const newCost = after > 0 ? (before * (mat.cost || 0) + it.amount) / after : (it.amount / it.qty);
        db.prepare('UPDATE materials SET cost=? WHERE id=?').run(round4(newCost), it.material_id);
        writeLog({ materialId: it.material_id, warehouseId: doc.warehouse_id, docType: 'IN', docSn: doc.sn,
          delta: it.qty, before, after, cost: it.price, amount: it.amount, remark: '', operatorId: ctx.user.userId });
        pushEffect('inv', null, it.qty, 0, it.price);
        totalCost += it.amount;
      }
    }

    else if (doc.type === 'OUT') {
      if (mat.type === 'master') {
        if (it.cut_width > 0) {
          const need = it.cut_width * it.qty;
          const cost = consumeRollWidth({
            docId, materialId: it.material_id, warehouseId: doc.warehouse_id,
            needWidth: need, operatorId: ctx.user.userId, docSn: doc.sn
          });
          // 自动建立子卷物料档案，方便后续退货与统计
          ensureSubMaterial(it.material_id, it.cut_width, it.cost_price);
          totalCost += cost;
        } else {
          let cost = 0;
          for (let i = 0; i < Math.round(it.qty); i++) {
            cost += consumeWholeRoll({
              docId, materialId: it.material_id, warehouseId: doc.warehouse_id,
              operatorId: ctx.user.userId, docSn: doc.sn
            });
          }
          totalCost += cost;
        }
      } else {
        const before = invGet(it.material_id, doc.warehouse_id);
        const after = before - it.qty;
        invSet(it.material_id, doc.warehouse_id, round3(after));
        const cost = (mat.cost || 0) * it.qty;
        writeLog({ materialId: it.material_id, warehouseId: doc.warehouse_id, docType: 'OUT', docSn: doc.sn,
          delta: -it.qty, before, after, cost: mat.cost, amount: cost, remark: '', operatorId: ctx.user.userId });
        pushEffect('inv', null, -it.qty, 0, mat.cost || 0);
        totalCost += cost;
      }
    }

    else if (doc.type === 'SRET') { // 客户退货：库存增加
      if (mat.type === 'master') {
        // 退整支母卷
        for (let i = 0; i < Math.round(it.qty); i++) {
          const r = db.prepare(`INSERT INTO rolls(material_id,warehouse_id,batch_no,width_total,width_used,cost,status,created_at)
                                VALUES (?,?,?,?,0,?,'open',?)`)
            .run(it.material_id, doc.warehouse_id, it.batch_no || '', mat.base_width, it.price, now());
          pushEffect('roll_create', Number(r.lastInsertRowid), 0, mat.base_width, it.price);
        }
        totalCost += it.amount;
      } else {
        const before = invGet(it.material_id, doc.warehouse_id);
        const after = before + it.qty;
        invSet(it.material_id, doc.warehouse_id, round3(after));
        const newCost = after > 0 ? (before * (mat.cost || 0) + it.amount) / after : (it.price);
        db.prepare('UPDATE materials SET cost=? WHERE id=?').run(round4(newCost), it.material_id);
        writeLog({ materialId: it.material_id, warehouseId: doc.warehouse_id, docType: 'SRET', docSn: doc.sn,
          delta: it.qty, before, after, cost: it.price, amount: it.amount, remark: '客户退货入库', operatorId: ctx.user.userId });
        pushEffect('inv', null, it.qty, 0, it.price);
        totalCost += it.amount;
      }
    }

    else if (doc.type === 'PRET') { // 退回供应商：库存减少
      if (mat.type === 'master') {
        for (let i = 0; i < Math.round(it.qty); i++) {
          consumeWholeRoll({ docId, materialId: it.material_id, warehouseId: doc.warehouse_id,
            operatorId: ctx.user.userId, docSn: doc.sn });
        }
        totalCost += (mat.cost || 0) * it.qty;
      } else {
        const before = invGet(it.material_id, doc.warehouse_id);
        const after = before - it.qty;
        invSet(it.material_id, doc.warehouse_id, round3(after));
        writeLog({ materialId: it.material_id, warehouseId: doc.warehouse_id, docType: 'PRET', docSn: doc.sn,
          delta: -it.qty, before, after, cost: mat.cost, amount: (mat.cost || 0) * it.qty,
          remark: '退回供应商', operatorId: ctx.user.userId });
        pushEffect('inv', null, -it.qty, 0, mat.cost || 0);
        totalCost += (mat.cost || 0) * it.qty;
      }
    }
  }

  db.prepare(`UPDATE docs SET status='approved', audited_by=?, audited_at=?, total_cost=? WHERE id=?`)
    .run(ctx.user.userId, now(), round2(totalCost), docId);
  calcDoc(docId);

  // 退货单审核通过后，回写原单的退货状态（部分退货 / 全部退货）
  if ((doc.type === 'SRET' || doc.type === 'PRET') && doc.origin_doc_id) {
    syncOriginReturnStatus(doc.origin_doc_id, doc.type);
  }

  logAction(ctx, 'approve', doc.type.toLowerCase(), `审核通过 ${doc.sn}`);
}

/** 根据已退数量，标记原单为部分退货或全部退货 */
function syncOriginReturnStatus(originId, retType) {
  const origin = db.prepare('SELECT * FROM docs WHERE id=?').get(originId);
  if (!origin) return;
  const originItems = db.prepare('SELECT material_id, SUM(qty) q FROM doc_items WHERE doc_id=? GROUP BY material_id').all(originId);
  const retRows = db.prepare(`SELECT ri.material_id, COALESCE(SUM(ri.qty),0) q
                              FROM docs rd JOIN doc_items ri ON ri.doc_id=rd.id
                              WHERE rd.type=? AND rd.origin_doc_id=? AND rd.status='approved'
                              GROUP BY ri.material_id`).all(retType, originId);
  const retMap = new Map(retRows.map(r => [r.material_id, r.q]));

  let anyReturned = false, allReturned = originItems.length > 0;
  for (const it of originItems) {
    const r = retMap.get(it.material_id) || 0;
    if (r > 0) anyReturned = true;
    if (r + 1e-9 < it.q) allReturned = false;
  }
  const st = allReturned ? 'full' : (anyReturned ? 'partial' : null);
  db.prepare('UPDATE docs SET return_status=? WHERE id=?').run(st, originId);
}

/* ---------------- 作废：回滚库存 ---------------- */
function voidDoc(ctx, docId) {
  if (ctx.user.role !== 'admin') forbidden('只有超级管理员可以作废单据');
  const doc = db.prepare('SELECT * FROM docs WHERE id=?').get(docId);
  if (!doc) notFound('单据不存在');
  if (doc.status === 'void') bad('单据已作废');
  if (doc.status !== 'approved') {
    db.prepare("UPDATE docs SET status='void', void_reason=? WHERE id=?").run(ctx.body.reason || '', docId);
    logAction(ctx, 'void', doc.type.toLowerCase(), `作废未审核单据 ${doc.sn}`);
    return {};
  }

  const effects = db.prepare('SELECT * FROM stock_effects WHERE doc_id=?').all(docId);
  for (const e of effects) {
    if (e.kind === 'inv') {
      const before = invGet(e.material_id, e.warehouse_id);
      const after = before - e.qty_delta;
      invSet(e.material_id, e.warehouse_id, round3(after));
      writeLog({ materialId: e.material_id, warehouseId: e.warehouse_id, docType: 'VOID', docSn: doc.sn,
        delta: -e.qty_delta, before, after, cost: e.cost, amount: Math.abs(e.qty_delta) * (e.cost || 0),
        remark: '单据作废回滚', operatorId: ctx.user.userId });
    } else if (e.kind === 'roll_create') {
      db.prepare('DELETE FROM rolls WHERE id=?').run(e.ref_id);
    } else if (e.kind === 'roll_consume') {
      const roll = db.prepare('SELECT * FROM rolls WHERE id=?').get(e.ref_id);
      if (roll) {
        const newUsed = Math.max(0, roll.width_used + e.width_delta); // width_delta 是负值
        const leftover = roll.width_total - newUsed;
        const status = leftover >= (db.prepare('SELECT min_waste FROM materials WHERE id=?').get(e.material_id)?.min_waste ?? 10)
          ? 'open' : (leftover <= 1e-9 ? 'used' : 'waste');
        db.prepare('UPDATE rolls SET width_used=?, status=? WHERE id=?').run(round3(newUsed), status, roll.id);
      }
    }
  }
  db.prepare("UPDATE docs SET status='void', void_reason=? WHERE id=?")
    .run(ctx.body.reason || '', docId);

  // 作废退货单后，原单的退货状态要跟着回退
  if ((doc.type === 'SRET' || doc.type === 'PRET') && doc.origin_doc_id) {
    syncOriginReturnStatus(doc.origin_doc_id, doc.type);
  }

  logAction(ctx, 'void', doc.type.toLowerCase(), `作废单据 ${doc.sn}，库存已回滚`);
  return {};
}

/* ---------------- 路由 ---------------- */
function listRoute(type) {
  route('GET', `/api/docs/${type.toLowerCase()}`, async (ctx) => {
    const meta = DOC_META[type];
    ctx.need(meta.view);
    const { keyword = '', status = '', from = '', to = '' } = ctx.query;
    let sql = `SELECT d.*,
                 CASE WHEN ? = 'customer' THEN c.name ELSE s.name END AS partner_name,
                 u.name AS creator_name, a.name AS auditor_name
               FROM docs d
               LEFT JOIN customers c ON ? = 'customer' AND c.id = d.partner_id
               LEFT JOIN suppliers s ON ? = 'supplier' AND s.id = d.partner_id
               LEFT JOIN users u ON u.id = d.created_by
               LEFT JOIN users a ON a.id = d.audited_by
               WHERE d.type = ?`;
    const args = [meta.partner, meta.partner, meta.partner, type];
    if (ctx.user.role === 'sales') { sql += ' AND (d.created_by = ? OR d.salesperson_id = ?)'; args.push(ctx.user.userId, ctx.user.userId); }
    if (keyword) { sql += ' AND (d.sn LIKE ? OR d.contract_sn LIKE ?)'; args.push(`%${keyword}%`, `%${keyword}%`); }
    if (status) {
      sql += ' AND d.status = ?';
      args.push(status);
    } else {
      // 默认只显示非作废状态的单据(草稿、待审核、已审核、已驳回),需要看作废的单据时手动筛选
      sql += " AND d.status != 'void'";
    }
    if (from) { sql += ' AND d.doc_date >= ?'; args.push(from); }
    if (to) { sql += ' AND d.doc_date <= ?'; args.push(to); }
    sql += ' ORDER BY d.id DESC LIMIT 500';
    const rows = db.prepare(sql).all(...args);
    const showCost = ctx.can('cost.view');
    const list = rows.map(r => {
      const o = { ...r, statusName: STATUS_NAME[r.status] };
      if (!showCost) { delete o.total_cost; }
      return o;
    });
    const sum = list.reduce((s, r) => s + (Number(r.total_amount) || 0), 0);
    return { list, totalAmount: round2(sum), statusNames: STATUS_NAME };
  });
}

function createRoute(type) {
  const meta = DOC_META[type];
  route('POST', `/api/docs/${type.toLowerCase()}`, async (ctx) => {
    return saveDoc(ctx, null, type, ctx.body.submit !== false);
  });
}

function updateRoute(type) {
  route('PUT', `/api/docs/${type.toLowerCase()}/:id`, async (ctx) => {
    return saveDoc(ctx, Number(ctx.params.id), type, ctx.body.submit !== false);
  });
}

function detailRoute(type) {
  route('GET', `/api/docs/${type.toLowerCase()}/:id`, async (ctx) => {
    const meta = DOC_META[type];
    ctx.need(meta.view);
    const id = Number(ctx.params.id);
    const doc = db.prepare('SELECT * FROM docs WHERE id=? AND type=?').get(id, type);
    if (!doc) notFound('单据不存在');
    if (ctx.user.role === 'sales' && doc.created_by !== ctx.user.userId && doc.salesperson_id !== ctx.user.userId) {
      forbidden('只能查看自己的单据');
    }
    const partnerTable = meta.partner === 'customer' ? 'customers' : 'suppliers';
    const partner = db.prepare(`SELECT * FROM ${partnerTable} WHERE id=?`).get(doc.partner_id);
    const items = db.prepare('SELECT i.*, m.name AS material_name, m.code AS material_code, m.spec AS material_spec, m.unit, m.type AS material_type FROM doc_items i LEFT JOIN materials m ON m.id=i.material_id WHERE i.doc_id=?').all(id);
    const creator = db.prepare('SELECT name FROM users WHERE id=?').get(doc.created_by);
    const auditor = doc.audited_by ? db.prepare('SELECT name FROM users WHERE id=?').get(doc.audited_by) : null;
    const warehouse = db.prepare('SELECT name FROM warehouses WHERE id=?').get(doc.warehouse_id);

    const showCost = ctx.can('cost.view');
    const out = {
      ...doc,
      statusName: STATUS_NAME[doc.status],
      partner, items,
      creator_name: creator?.name || '',
      auditor_name: auditor?.name || '',
      warehouse_name: warehouse?.name || ''
    };
    if (!showCost) { delete out.total_cost; out.items = out.items.map(i => { const c = { ...i }; delete c.cost_price; delete c.cost_amount; return c; }); }
    return out;
  });
}

for (const t of Object.keys(DOC_META)) {
  listRoute(t); createRoute(t); updateRoute(t); detailRoute(t);
}

/* ---------- 提交审核 ---------- */
route('POST', '/api/docs/:id/submit', async (ctx) => {
  const id = Number(ctx.params.id);
  const doc = db.prepare('SELECT * FROM docs WHERE id=?').get(id);
  if (!doc) notFound('单据不存在');
  if (!['draft', 'rejected'].includes(doc.status)) bad('当前状态不能提交');
  const meta = DOC_META[doc.type];
  ctx.need(meta.create);
  if (ctx.user.role === 'sales' && doc.created_by !== ctx.user.userId) forbidden('只能提交自己的单据');
  db.prepare("UPDATE docs SET status='pending', submitted_at=? WHERE id=?").run(now(), id);
  logAction(ctx, 'submit', doc.type.toLowerCase(), `提交审核 ${doc.sn}`);
  return {};
});

/* ---------- 审核通过 ---------- */
route('POST', '/api/docs/:id/approve', async (ctx) => {
  approveDoc(ctx, Number(ctx.params.id));
  return {};
});

/* ---------- 驳回 ---------- */
route('POST', '/api/docs/:id/reject', async (ctx) => {
  const id = Number(ctx.params.id);
  const doc = db.prepare('SELECT * FROM docs WHERE id=?').get(id);
  if (!doc) notFound('单据不存在');
  if (doc.status !== 'pending') bad('只有待审核的单据可以驳回');
  if (ctx.user.role !== 'admin' && ctx.user.role !== 'manager') forbidden('只有主管或超级管理员可以驳回');
  if (!ctx.body.reason) bad('请填写驳回原因');
  db.prepare("UPDATE docs SET status='rejected', audited_by=?, audited_at=?, audit_reason=? WHERE id=?")
    .run(ctx.user.userId, now(), ctx.body.reason, id);
  logAction(ctx, 'reject', doc.type.toLowerCase(), `驳回 ${doc.sn}：${ctx.body.reason}`);
  return {};
});

/* ---------- 作废 ---------- */
route('POST', '/api/docs/:id/void', async (ctx) => {
  voidDoc(ctx, Number(ctx.params.id));
  return {};
});

/* ---------- 付款/收款核销 ---------- */
route('POST', '/api/docs/:id/payment', async (ctx) => {
  const id = Number(ctx.params.id);
  const doc = db.prepare('SELECT * FROM docs WHERE id=?').get(id);
  if (!doc) notFound('单据不存在');
  if (doc.status !== 'approved') bad('只有已审核的单据可以登记收付款');
  const isReceive = ['OUT', 'SRET'].includes(doc.type);
  ctx.need(isReceive ? 'payment.receive' : 'payment.pay');
  const amount = Number(ctx.body.amount) || 0;
  if (amount === 0) bad('金额不能为 0');

  const r = db.prepare(`INSERT INTO payments(type,partner_id,pay_date,amount,method,remark,created_by,created_at)
                        VALUES (?,?,?,?,?,?,?,?)`)
    .run(isReceive ? 'receive' : 'pay', doc.partner_id, ctx.body.pay_date || today(),
      amount, ctx.body.method || '银行转账', ctx.body.remark || '', ctx.user.userId, now());
  db.prepare('INSERT INTO payment_allocations(payment_id,doc_id,amount) VALUES (?,?,?)')
    .run(Number(r.lastInsertRowid), id, amount);

  const paid = (Number(doc.paid_amount) || 0) + amount;
  const total = Math.abs(Number(doc.total_amount) || 0);
  const status = paid <= 0 ? 'unpaid' : (paid >= total - 0.01 ? 'paid' : 'partial');
  db.prepare('UPDATE docs SET paid_amount=?, pay_status=? WHERE id=?').run(round2(paid), status, id);
  logAction(ctx, isReceive ? 'receive' : 'pay', doc.type.toLowerCase(),
    `${doc.sn} 登记${isReceive ? '收款' : '付款'} ${amount}`);
  return { paid_amount: round2(paid), pay_status: status };
});

/* ---------- 按单号查原单，供退货引用 ---------- */
route('GET', '/api/docs/lookup/:sn', async (ctx) => {
  const sn = String(ctx.params.sn || '').trim();
  if (!sn) bad('请输入单号');
  const doc = db.prepare('SELECT * FROM docs WHERE sn=?').get(sn);
  if (!doc) notFound(`没有找到单号 ${sn}`);

  const meta = DOC_META[doc.type];
  ctx.need(meta.view);
  if (doc.status !== 'approved') bad(`单号 ${sn} 当前状态是「${STATUS_NAME[doc.status]}」，只有已审核的单据才能退货`);
  if (ctx.user.role === 'sales' && doc.created_by !== ctx.user.userId && doc.salesperson_id !== ctx.user.userId) {
    forbidden('只能查询自己的单据');
  }

  const partnerTable = meta.partner === 'customer' ? 'customers' : 'suppliers';
  const partner = db.prepare(`SELECT id,name FROM ${partnerTable} WHERE id=?`).get(doc.partner_id);
  const warehouse = db.prepare('SELECT name FROM warehouses WHERE id=?').get(doc.warehouse_id);
  const items = db.prepare(`SELECT i.*, m.name AS material_name, m.code AS material_code,
                                   m.spec AS material_spec, m.unit, m.type AS material_type
                            FROM doc_items i LEFT JOIN materials m ON m.id=i.material_id
                            WHERE i.doc_id=?`).all(doc.id);

  // 该单已退过多少，避免重复退
  const retType = doc.type === 'OUT' ? 'SRET' : 'PRET';
  const returned = db.prepare(`SELECT ri.material_id, COALESCE(SUM(ri.qty),0) q
                               FROM docs rd JOIN doc_items ri ON ri.doc_id=rd.id
                               WHERE rd.type=? AND rd.origin_doc_id=? AND rd.status IN ('pending','approved')
                               GROUP BY ri.material_id`).all(retType, doc.id);
  const retMap = new Map(returned.map(r => [r.material_id, r.q]));

  return {
    doc: {
      id: doc.id, sn: doc.sn, type: doc.type, doc_date: doc.doc_date,
      partner_id: doc.partner_id, partner_name: partner?.name || '',
      warehouse_id: doc.warehouse_id, warehouse_name: warehouse?.name || '',
      contract_sn: doc.contract_sn, total_amount: doc.total_amount,
      salesperson_id: doc.salesperson_id
    },
    items: items.map(it => {
      const already = retMap.get(it.material_id) || 0;
      return {
        material_id: it.material_id, material_name: it.material_name,
        material_code: it.material_code, material_spec: it.material_spec,
        unit: it.unit, material_type: it.material_type,
        qty: it.qty, price: it.price, amount: it.amount,
        cut_width: it.cut_width, batch_no: it.batch_no,
        returned_qty: already,
        returnable: round3(Math.max(0, it.qty - already))
      };
    })
  };
});

/* ---------- 开票 ---------- */
route('POST', '/api/docs/:id/invoice', async (ctx) => {
  ctx.need('outbound.invoice');
  const id = Number(ctx.params.id);
  const doc = db.prepare('SELECT * FROM docs WHERE id=?').get(id);
  if (!doc) notFound('单据不存在');
  db.prepare('UPDATE docs SET invoice_status=? WHERE id=?').run(Number(ctx.body.invoice_status) || 1, id);
  logAction(ctx, 'invoice', doc.type.toLowerCase(), `${doc.sn} 开票状态更新`);
  return {};
});

/* ---------------- 数值工具 ---------------- */
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function round3(n) { return Math.round((Number(n) || 0) * 1000) / 1000; }
function round4(n) { return Math.round((Number(n) || 0) * 10000) / 10000; }
function fmt(n) { return round3(n); }

module.exports = { DOC_META, STATUS_NAME, round2, round3, round4, approveDoc, voidDoc };
