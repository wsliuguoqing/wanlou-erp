'use strict';
/**
 * 单据模块：入库 / 出库 / 销售退货 / 采购退货
 * 核心：审批通过才动库存，作废原路回滚，移动加权平均成本，胶带分切按宽度扣减
 */
const { route, bad, notFound, forbidden, logAction, pageParams, pageMeta, clampPage } = require('../http-framework');
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
function makeSn(type, salespersonId) {
  const meta = DOC_META[type];
  const day = today().replace(/-/g, '');
  let prefix;
  if (type === 'OUT') {
    const employeeNo = String(db.prepare('SELECT employee_no FROM users WHERE id=?').get(salespersonId)?.employee_no || '').trim();
    if (!employeeNo) bad('所选销售人员尚未分配工号，请先在员工管理中补充工号');
    prefix = `CK${employeeNo}${day}`;
  } else {
    prefix = `${setting(meta.prefixKey, 'SN')}${day}`;
  }
  const row = db.prepare('SELECT sn FROM docs WHERE type=? AND substr(sn,1,?)=? ORDER BY id DESC LIMIT 1')
    .get(type, prefix.length, prefix);
  let n = 1;
  if (row) {
    const tail = String(row.sn).slice(prefix.length);
    const parsed = parseInt(tail, 10);
    if (!isNaN(parsed)) n = parsed + 1;
  }
  return `${prefix}${String(n).padStart(4, '0')}`;
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
function adjustPackStock(materialId, warehouseId, delta, mat) {
  const current = db.prepare('SELECT qty,sub_qty FROM inventory WHERE material_id=? AND warehouse_id=?')
    .get(materialId, warehouseId) || { qty: 0, sub_qty: 0 };
  const perPack = Number(mat.base_width) || 1;
  const before = roundSubQty((current.qty || 0) * perPack + (current.sub_qty || 0), mat);
  const after = roundSubQty(before + delta, mat);
  if (after < -1e-7) throw new Error(`${mat.name} 库存不足`);
  const parts = splitPackStock(after, perPack, mat);
  db.prepare(`INSERT INTO inventory(material_id,warehouse_id,qty,sub_qty) VALUES (?,?,?,?)
              ON CONFLICT(material_id,warehouse_id) DO UPDATE SET qty=excluded.qty,sub_qty=excluded.sub_qty`)
    .run(materialId, warehouseId, parts.whole, parts.loose);
  return { before, after, whole: parts.whole, loose: parts.loose, perPack };
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

/** 母卷：整支出库。silent=true 时不单独写流水，由调用方汇总写一条 */
function consumeWholeRoll({ docId, materialId, warehouseId, operatorId, docSn, silent }) {
  const roll = db.prepare("SELECT * FROM rolls WHERE material_id=? AND warehouse_id=? AND status='open' ORDER BY id LIMIT 1")
    .get(materialId, warehouseId);
  if (!roll) bad('没有可用的整支母卷');
  db.prepare("UPDATE rolls SET width_used=width_total, status='used' WHERE id=?").run(roll.id);
  db.prepare('INSERT INTO stock_effects(doc_id,kind,material_id,warehouse_id,ref_id,width_delta,cost) VALUES (?,?,?,?,?,?,?)')
    .run(docId, 'roll_consume', materialId, warehouseId, roll.id, -(roll.width_total - roll.width_used), roll.cost);
  if (!silent) writeLog({
    materialId, warehouseId, docType: 'OUT', docSn, delta: -1,
    before: 1, after: 0, cost: roll.cost, amount: roll.cost, remark: '整支母卷出库', operatorId
  });
  return roll.cost;
}

/** 找或建同规格子卷物料 */
function ensureSubMaterial(masterId, width, unitCost, createdBy) {
  const master = db.prepare('SELECT * FROM materials WHERE id=?').get(masterId);
  const spec = `${width}mm`;
  let sub = db.prepare('SELECT * FROM materials WHERE parent_id=? AND spec=?').get(masterId, spec);
  if (sub) {
    if (unitCost > 0) db.prepare('UPDATE materials SET cost=? WHERE id=?').run(round4(unitCost), sub.id);
    return sub;
  }
  const code = nextCode('materials', 'M');
  const r = db.prepare(`INSERT INTO materials(code,name,brand,spec,unit,type,base_width,min_waste,cut_fee,parent_id,safety_stock,cost,created_by,status,created_at)
                        VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?,1,?)`)
    .run(code, master.name, master.brand || '', spec, '卷', 'sub', null, 10,
      master.cut_fee || 0, masterId, round4(unitCost || 0), createdBy || null, now());
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

  // 兼容 customer_id / supplier_id
  if (!b.partner_id) {
    if (meta.partner === 'customer' && b.customer_id) b.partner_id = b.customer_id;
    if (meta.partner === 'supplier' && b.supplier_id) b.partner_id = b.supplier_id;
  }

  if (!b.warehouse_id) bad('请选择仓库');
  if (!b.partner_id) bad(`请选择${meta.partner === 'customer' ? '客户' : '供应商'}`);
  if (!Array.isArray(b.items) || b.items.length === 0) bad('至少添加一行明细');

  const warehouse = db.prepare('SELECT * FROM warehouses WHERE id=?').get(b.warehouse_id);
  if (!warehouse) bad('仓库不存在');

  // 退货必须引用原单行价格。按物料 id 关联会在同一张采购单包含同物料多批次时串价。
  let originItems = null;
  let originDoc = null;
  if (type === 'PRET' || type === 'SRET') {
    const expectedOriginType = type === 'PRET' ? 'IN' : 'OUT';
    originDoc = b.origin_doc_id
      ? db.prepare('SELECT * FROM docs WHERE id=?').get(b.origin_doc_id)
      : null;
    if (!originDoc || originDoc.type !== expectedOriginType || originDoc.status !== 'approved') {
      bad('退货单必须引用已审核的原单');
    }
    if (Number(originDoc.partner_id) !== Number(b.partner_id) || Number(originDoc.warehouse_id) !== Number(b.warehouse_id)) {
      bad('退货单的往来单位和仓库必须与原单一致');
    }
    originItems = db.prepare('SELECT * FROM doc_items WHERE doc_id=?').all(originDoc.id);
  }

  let doc;
  if (docId) {
    doc = db.prepare('SELECT * FROM docs WHERE id=?').get(docId);
    if (!doc || doc.type !== type) notFound('单据不存在');
    if (!['draft', 'rejected'].includes(doc.status)) bad('只有草稿或已驳回的单据可以修改');
    if (ctx.user.role === 'sales' && doc.created_by !== ctx.user.userId) forbidden('只能修改自己的单据');
  }

  const docDate = b.doc_date || today();
  const requestedByOriginItem = new Map();

  // 取得用户可读的成本：只有有 cost.view 权限才接受前端传来的成本，否则由系统算
  const itemsPrepared = b.items.map(it => {
    const mat = db.prepare('SELECT * FROM materials WHERE id=?').get(it.material_id);
    if (!mat) bad('物料不存在');
    let originItem = null;
    if (originItems) {
      const candidates = originItems.filter(row => Number(row.material_id) === Number(mat.id));
      originItem = it.origin_item_id
        ? candidates.find(row => Number(row.id) === Number(it.origin_item_id))
        : candidates.length === 1 ? candidates[0] : null;
      if (!originItem) {
        bad(candidates.length > 1
          ? `${mat.name} 在原单有多行，请重新查询原单后选择对应批次退货`
          : `${mat.name} 不在所引用的原单中`);
      }
    }
    const isPackSplit = mat.type === 'master' && mat.sub_unit && mat.sub_unit !== 'mm';
    const perPack = Number(mat.base_width) || 1;
    let qty = Number(it.qty) || 0;
    let qtyWhole = null, qtySub = null;
    if (isPackSplit) {
      const hasUnitParts = it.qty_whole !== undefined || it.qty_sub !== undefined;
      if (hasUnitParts) {
        qtyWhole = Number(it.qty_whole) || 0;
        qtySub = Number(it.qty_sub) || 0;
        if (qtyWhole < 0 || (type !== 'IN' && !Number.isInteger(qtyWhole))) {
          bad(`${mat.name} 整单位数量必须是非负${type === 'IN' ? '数' : '整数'}`);
        }
        if (qtySub < 0) bad(`${mat.name} 零单位数量不能为负`);
        const step = mat.sub_unit === '米' ? 0.1 : 1;
        if (Math.abs(qtySub / step - Math.round(qtySub / step)) > 1e-6) {
          bad(`${mat.name} 的 ${mat.sub_unit} 数量最小按 ${step} 递增`);
        }
        qty = roundSubQty(qtyWhole * perPack + qtySub, mat);
      } else if (type === 'IN') {
        // 兼容旧接口：旧入库单的 qty 表示整单位数量。
        qtyWhole = qty;
        qtySub = 0;
        qty = roundSubQty(qty * perPack, mat);
      } else {
        // 兼容旧接口：出库、退货的 qty 按零单位记录。
        qty = roundSubQty(qty, mat);
        const parts = splitPackStock(qty, perPack, mat);
        qtyWhole = parts.whole;
        qtySub = parts.loose;
      }
    }
    if (qty <= 0) bad(`${mat.name} 数量必须大于 0`);
    if (originItem) {
      const sourceQty = isPackSplit && originDoc.type === 'IN' && originItem.qty_whole == null
        ? Number(originItem.qty) * perPack : Number(originItem.qty);
      const legacyUnambiguous = originItems.filter(row => Number(row.material_id) === Number(mat.id)).length === 1;
      const prior = db.prepare(`SELECT COALESCE(SUM(ri.qty),0) q
                                FROM docs rd JOIN doc_items ri ON ri.doc_id=rd.id
                                WHERE rd.type=? AND rd.origin_doc_id=? AND rd.status IN ('pending','approved')
                                  AND rd.id<>COALESCE(?, -1)
                                  AND (ri.origin_item_id=? OR (ri.origin_item_id IS NULL AND ?=1 AND ri.material_id=?))`)
        .get(type, originDoc.id, docId || null, originItem.id, legacyUnambiguous ? 1 : 0, mat.id).q;
      const sameSourceInRequest = requestedByOriginItem.get(originItem.id) || 0;
      if (prior + sameSourceInRequest + qty > sourceQty + 1e-9) {
        bad(`${mat.name} 本行来源数量 ${round3(sourceQty)}，已退 ${round3(prior + sameSourceInRequest)}，最多还可退 ${round3(Math.max(0, sourceQty - prior - sameSourceInRequest))}`);
      }
      requestedByOriginItem.set(originItem.id, sameSourceInRequest + qty);
    }
    const price = Number(originItem ? originItem.price : it.price) || 0;
    if (price < 0) bad('单价不能为负');
    const isPurchasePrice = type === 'IN' || type === 'PRET';
    // 入库若录了拆散数量，整件与散件全部按最小单位单价；只有整件数量时按整单位单价。
    const priceBasis = (type === 'IN' || type === 'PRET') && isPackSplit
      ? (type === 'PRET'
        ? (it.price_basis === 'sub' || it.price_basis === 'pack'
          ? it.price_basis : originItem?.price_basis === 'sub' ? 'sub' : 'pack')
        : (it.price_basis === 'sub' || it.price_basis === 'pack'
          ? it.price_basis : qtySub > 0 ? 'sub' : 'pack'))
      : '';
    const subUnitPurchasePrice = priceBasis === 'sub';
    const amount = round2(isPackSplit && isPurchasePrice && !subUnitPurchasePrice
      ? (qty / perPack) * price
      : qty * price);
    let costPrice = Number(mat.cost) || 0;
    let costAmount = round2(costPrice * qty);
    let cutWidth = null, cutQty = null;

    if (type === 'OUT' && mat.type === 'master' && mat.sub_unit === 'mm') {
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
    } else if (isPackSplit) {
      // 整进零出物料的平均成本按零单位记录。
      costPrice = Number(mat.cost) || 0;
      costAmount = round2(costPrice * qty);
    }
    // 上面的通用物料成本初始化不能覆盖退货来源行的成本/采购价格快照。
    if (originItem && type === 'PRET') {
      // 采购退货的财务金额按原采购行价格，不能按退货时的移动平均价重算。
      costPrice = priceBasis === 'sub' && isPackSplit
        ? price
        : (isPackSplit ? price / (Number(mat.base_width) || 1) : price);
      costAmount = amount;
    } else if (originItem && type === 'SRET') {
      // 销售退货收入按原销售价冲回，库存成本取原出库行成本快照。
      costPrice = Number(originItem.cost_price) || Number(mat.cost) || 0;
      costAmount = Number(originItem.cost_amount) > 0
        ? round2(Number(originItem.cost_amount) * qty / (Number(originItem.qty) || qty))
        : round2(costPrice * qty);
    }
    return {
      material_id: mat.id, qty, price, amount,
      qty_whole: qtyWhole, qty_sub: qtySub, price_basis: priceBasis,
      origin_item_id: originItem?.id || null,
      cost_price: costPrice, cost_amount: costAmount,
      cut_width: cutWidth, cut_qty: cutQty,
      batch_no: it.batch_no || '', remark: it.remark || ''
    };
  });

  const status = submit ? 'pending' : 'draft';
  let id = docId;

  if (!id) {
    const sn = makeSn(type, b.salesperson_id || ctx.user.userId);
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

  const insItem = db.prepare(`INSERT INTO doc_items(doc_id,material_id,qty,price,amount,cost_price,cost_amount,cut_width,cut_qty,batch_no,remark,qty_whole,qty_sub,price_basis,origin_item_id)
                              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const it of itemsPrepared) {
    insItem.run(id, it.material_id, it.qty, it.price, it.amount, it.cost_price, it.cost_amount,
      it.cut_width, it.cut_qty, it.batch_no, it.remark, it.qty_whole, it.qty_sub, it.price_basis, it.origin_item_id);
  }
  calcDoc(id);

  if (submit) {
    // 提交审批时就校验库存，不要等到审核才报不足
    const savedItems = db.prepare('SELECT * FROM doc_items WHERE doc_id=?').all(id);
    checkStockEnough(type, b.warehouse_id, savedItems, id);

    const needApproval = setting('need_approval', '1') === '1';
    if (!needApproval) {
      approveDoc(ctx, id);
    }
  }

  logAction(ctx, docId ? 'update' : 'create', type.toLowerCase(),
    `${meta.name} ${db.prepare('SELECT sn FROM docs WHERE id=?').get(id).sn}`);
  return { id };
}

/**
 * 校验库存是否够扣。提交审批和审核通过两处都调用，避免「提交时不报、审核才报」。
 * excludeDocId：校验自己时要排除自己已占用的量（编辑场景）
 */
function checkStockEnough(type, warehouseId, items, excludeDocId) {
  if (!['OUT', 'PRET'].includes(type)) return;

  // 其他待审核单据已占用的量，防止两张单重复占同一批库存
  const pendingHold = new Map();
  const holdRows = db.prepare(`
    SELECT di.material_id, d.sn, d.type, di.cut_width, SUM(di.qty) q
    FROM docs d JOIN doc_items di ON di.doc_id = d.id
    WHERE d.status='pending' AND d.warehouse_id=? AND d.type IN ('OUT','PRET')
      ${excludeDocId ? 'AND d.id != ?' : ''}
    GROUP BY di.material_id, d.id, di.cut_width`).all(
    ...(excludeDocId ? [warehouseId, excludeDocId] : [warehouseId]));
  for (const r of holdRows) {
    const cur = pendingHold.get(r.material_id) || { qty: 0, width: 0, docs: [] };
    if (r.cut_width > 0) cur.width += r.cut_width * r.q;
    else cur.qty += r.q;
    cur.docs.push({ sn: r.sn, type: r.type, qty: r.q, cutWidth: r.cut_width });
    pendingHold.set(r.material_id, cur);
  }

  const holdSources = (hold, unit) => hold.docs.length
    ? `；占用单据：${hold.docs.map(d => {
      const kind = d.type === 'PRET' ? '采购退货' : '出库';
      const amount = d.cutWidth > 0
        ? `${round3(d.qty)} 件×${round3(d.cutWidth)}mm`
        : `${round3(d.qty)} ${unit || ''}`.trim();
      return `${d.sn}（${kind} ${amount}）`;
    }).join('、')}`
    : '';

  for (const it of items) {
    const mat = db.prepare('SELECT * FROM materials WHERE id=?').get(it.material_id);
    if (!mat) bad('物料不存在');
    const hold = pendingHold.get(it.material_id) || { qty: 0, width: 0, docs: [] };

    if (mat.type === 'master' && mat.sub_unit === 'mm') {
      const openRolls = db.prepare("SELECT * FROM rolls WHERE material_id=? AND warehouse_id=? AND status='open'")
        .all(it.material_id, warehouseId);
      if (it.cut_width > 0) {
        if (mat.base_width && it.cut_width > mat.base_width) {
          bad(`${mat.name} 分切宽度 ${it.cut_width}mm 超过整支宽度 ${mat.base_width}mm`);
        }
        const need = it.cut_width * it.qty;
        const availRaw = openRolls.reduce((s, r) => s + (r.width_total - r.width_used), 0);
        const avail = availRaw - hold.width;
        if (need > avail + 1e-6) {
          const holdNote = hold.width > 0 ? `（其中 ${round3(hold.width)}mm 被其他待审核单据占用${holdSources(hold, 'mm')}）` : '';
          bad(`${mat.name} 可用宽度 ${round3(Math.max(0, avail))}mm${holdNote}，本次需要 ${round3(need)}mm，不足`);
        }
      } else {
        const avail = openRolls.length - hold.qty;
        if (it.qty > avail) {
          const holdNote = hold.qty > 0 ? `（其中 ${hold.qty} 支被其他待审核单据占用${holdSources(hold, '支')}）` : '';
          bad(`${mat.name} 可用整支 ${Math.max(0, avail)} 支${holdNote}，本次需要 ${round3(it.qty)} 支`);
        }
      }
    } else if (mat.type === 'master' && mat.sub_unit) {
      const inv = db.prepare('SELECT qty, sub_qty FROM inventory WHERE material_id=? AND warehouse_id=?')
        .get(it.material_id, warehouseId) || { qty: 0, sub_qty: 0 };
      const perBox = mat.base_width || 1;
      const needLoose = roundSubQty(it.qty, mat);
      const availTotal = (inv.qty || 0) * perBox + (inv.sub_qty || 0) - hold.qty;
      if (needLoose > availTotal) {
        const holdNote = hold.qty > 0 ? `（其中 ${hold.qty} ${mat.sub_unit} 被其他待审核单据占用${holdSources(hold, mat.sub_unit)}）` : '';
        bad(`${mat.name} 可用 ${inv.qty} ${mat.unit} + ${inv.sub_qty} ${mat.sub_unit}（共 ${availTotal} ${mat.sub_unit}）${holdNote}，本次需要 ${needLoose} ${mat.sub_unit}，不足`);
      }
    } else {
      const avail = invGet(it.material_id, warehouseId) - hold.qty;
      if (it.qty > avail + 1e-9) {
        const holdNote = hold.qty > 0 ? `（其中 ${round3(hold.qty)} 被其他待审核单据占用${holdSources(hold, mat.unit)}）` : '';
        bad(`${mat.name} 可用库存 ${round3(Math.max(0, avail))} ${mat.unit || ''}${holdNote}，本次需要 ${round3(it.qty)}，不足`);
      }
    }
  }
}

/* ---------------- 审批通过：执行库存变动 ---------------- */
function approveDoc(ctx, docId) {
  const doc = db.prepare('SELECT * FROM docs WHERE id=?').get(docId);
  if (!doc) notFound('单据不存在');
  if (doc.status !== 'pending') bad('只有待审核的单据可以审核');
  if (ctx.user.role !== 'admin' && ctx.user.role !== 'manager') forbidden('只有主管或超级管理员可以审核');

  const items = db.prepare('SELECT * FROM doc_items WHERE doc_id=?').all(docId);

  // 先做库存可行性校验
  checkStockEnough(doc.type, doc.warehouse_id, items, docId);

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
      // 模式 A：胶带母卷（按宽度 mm 分切），每支建一条 rolls 记录
      if (mat.type === 'master' && mat.sub_unit === 'mm') {
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
      }
      // 模式 B：整进零出，按零单位累计库存，展示时拆为整单位 + 零单位
      else if (mat.type === 'master' && mat.sub_unit) {
        const perPack = Number(mat.base_width) || 1;
        const moveQty = it.qty_whole == null
          ? roundSubQty(it.qty * perPack, mat) // 兼容升级前已提交的整单位入库单
          : roundSubQty(it.qty, mat);
        const stock = adjustPackStock(it.material_id, doc.warehouse_id, moveQty, mat);
        const newCost = stock.after > 0
          ? (stock.before * (mat.cost || 0) + it.amount) / stock.after
          : it.amount / Math.max(moveQty, 1e-9);
        db.prepare('UPDATE materials SET cost=? WHERE id=?').run(round4(newCost), it.material_id);
        writeLog({
          materialId: it.material_id, warehouseId: doc.warehouse_id, docType: 'IN', docSn: doc.sn,
          delta: moveQty, before: stock.before, after: stock.after,
          cost: round4(it.amount / moveQty), amount: it.amount,
          remark: `入库 ${stock.whole} ${mat.unit} + ${stock.loose} ${mat.sub_unit}`, operatorId: ctx.user.userId
        });
        pushEffect('subqty', null, moveQty, 0, round4(it.amount / Math.max(moveQty, 1e-9)));
        totalCost += it.amount;
      }
      // 普通物料
      else {
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
      // 模式 A：胶带母卷（按宽度 mm 分切）
      if (mat.type === 'master' && mat.sub_unit === 'mm') {
        if (it.cut_width > 0) {
          const need = it.cut_width * it.qty;
          const cost = consumeRollWidth({
            docId, materialId: it.material_id, warehouseId: doc.warehouse_id,
            needWidth: need, operatorId: ctx.user.userId, docSn: doc.sn
          });
          ensureSubMaterial(it.material_id, it.cut_width, it.cost_price, ctx.user.userId);
          totalCost += cost;
        } else {
          // 整支出库：逐支消耗，但只写一条汇总流水
          const n = Math.round(it.qty);
          const beforeRolls = db.prepare("SELECT COUNT(*) c FROM rolls WHERE material_id=? AND warehouse_id=? AND status='open'")
            .get(it.material_id, doc.warehouse_id).c;
          let cost = 0;
          for (let i = 0; i < n; i++) {
            cost += consumeWholeRoll({ silent: true,
              docId, materialId: it.material_id, warehouseId: doc.warehouse_id,
              operatorId: ctx.user.userId, docSn: doc.sn
            });
          }
          writeLog({
            materialId: it.material_id, warehouseId: doc.warehouse_id, docType: 'OUT', docSn: doc.sn,
            delta: -n, before: beforeRolls, after: beforeRolls - n,
            cost: n ? round4(cost / n) : 0, amount: round2(cost),
            remark: `整支母卷出库 ${n} 支`, operatorId: ctx.user.userId
          });
          totalCost += cost;
        }
      }
      // 模式 B：按零单位出库，优先消耗已拆包装
      else if (mat.type === 'master' && mat.sub_unit) {
        const needLoose = roundSubQty(it.qty, mat);
        const stock = adjustPackStock(it.material_id, doc.warehouse_id, -needLoose, mat);
        const unitCost = Number(mat.cost) || 0;
        const cost = round2(unitCost * needLoose);
        writeLog({
          materialId: it.material_id, warehouseId: doc.warehouse_id, docType: 'OUT', docSn: doc.sn,
          delta: -needLoose, before: stock.before, after: stock.after,
          cost: unitCost, amount: cost, remark: `拆箱出库 ${needLoose} ${mat.sub_unit}`, operatorId: ctx.user.userId
        });
        db.prepare('UPDATE doc_items SET cost_price=?,cost_amount=? WHERE id=?')
          .run(unitCost, cost, it.id);
        pushEffect('subqty', null, -needLoose, 0, unitCost);
        totalCost += cost;
      }
      // 普通物料
      else {
        const before = invGet(it.material_id, doc.warehouse_id);
        const after = before - it.qty;
        invSet(it.material_id, doc.warehouse_id, round3(after));
        const cost = (mat.cost || 0) * it.qty;
        writeLog({ materialId: it.material_id, warehouseId: doc.warehouse_id, docType: 'OUT', docSn: doc.sn,
          delta: -it.qty, before, after, cost: mat.cost, amount: cost, remark: '', operatorId: ctx.user.userId });
        db.prepare('UPDATE doc_items SET cost_price=?,cost_amount=? WHERE id=?')
          .run(Number(mat.cost) || 0, round2(cost), it.id);
        pushEffect('inv', null, -it.qty, 0, mat.cost || 0);
        totalCost += cost;
      }
    }

    else if (doc.type === 'SRET') { // 客户退货：库存增加
      // 模式 A：胶带母卷，退整支
      if (mat.type === 'master' && mat.sub_unit === 'mm') {
        for (let i = 0; i < Math.round(it.qty); i++) {
          const r = db.prepare(`INSERT INTO rolls(material_id,warehouse_id,batch_no,width_total,width_used,cost,status,created_at)
                                VALUES (?,?,?,?,0,?,'open',?)`)
            .run(it.material_id, doc.warehouse_id, it.batch_no || '', mat.base_width, it.cost_price, now());
          pushEffect('roll_create', Number(r.lastInsertRowid), 0, mat.base_width, it.cost_price);
        }
        totalCost += it.cost_amount;
      }
      // 模式 B：退回零单位，增加散装数量
      else if (mat.type === 'master' && mat.sub_unit) {
        const stock = adjustPackStock(it.material_id, doc.warehouse_id, it.qty, mat);
        const unitCost = Number(it.cost_price) || Number(mat.cost) || 0;
        const cost = Number(it.cost_amount) || round2(unitCost * it.qty);
        const newCost = stock.after > 0
          ? (stock.before * (Number(mat.cost) || 0) + cost) / stock.after
          : unitCost;
        db.prepare('UPDATE materials SET cost=? WHERE id=?').run(round4(newCost), it.material_id);
        writeLog({
          materialId: it.material_id, warehouseId: doc.warehouse_id, docType: 'SRET', docSn: doc.sn,
          delta: it.qty, before: stock.before, after: stock.after,
          cost: unitCost, amount: cost, remark: `客户退货 ${it.qty} ${mat.sub_unit}`, operatorId: ctx.user.userId
        });
        pushEffect('subqty', null, it.qty, 0, unitCost);
        totalCost += cost;
      }
      // 普通物料
      else {
        const before = invGet(it.material_id, doc.warehouse_id);
        const after = before + it.qty;
        invSet(it.material_id, doc.warehouse_id, round3(after));
        const returnCost = Number(it.cost_amount) || round2((Number(it.cost_price) || Number(mat.cost) || 0) * it.qty);
        const newCost = after > 0 ? (before * (mat.cost || 0) + returnCost) / after : (it.cost_price || mat.cost);
        db.prepare('UPDATE materials SET cost=? WHERE id=?').run(round4(newCost), it.material_id);
        writeLog({ materialId: it.material_id, warehouseId: doc.warehouse_id, docType: 'SRET', docSn: doc.sn,
          delta: it.qty, before, after, cost: it.cost_price, amount: returnCost, remark: '客户退货入库', operatorId: ctx.user.userId });
        pushEffect('inv', null, it.qty, 0, it.cost_price);
        totalCost += returnCost;
      }
    }

    else if (doc.type === 'PRET') { // 退回供应商：库存减少
      // 模式 A：胶带母卷，退整支
      if (mat.type === 'master' && mat.sub_unit === 'mm') {
        const n = Math.round(it.qty);
        const beforeRolls = db.prepare("SELECT COUNT(*) c FROM rolls WHERE material_id=? AND warehouse_id=? AND status='open'")
          .get(it.material_id, doc.warehouse_id).c;
        for (let i = 0; i < n; i++) {
          consumeWholeRoll({ silent: true, docId, materialId: it.material_id, warehouseId: doc.warehouse_id,
            operatorId: ctx.user.userId, docSn: doc.sn });
        }
        writeLog({
          materialId: it.material_id, warehouseId: doc.warehouse_id, docType: 'PRET', docSn: doc.sn,
          delta: -n, before: beforeRolls, after: beforeRolls - n,
          cost: n ? round4(it.amount / n) : 0, amount: it.amount,
          remark: `退回供应商 ${n} 支`, operatorId: ctx.user.userId
        });
        totalCost += it.amount;
      }
      // 模式 B：按零单位退回供应商，优先扣除散装数量
      else if (mat.type === 'master' && mat.sub_unit) {
        const needLoose = roundSubQty(it.qty, mat);
        const stock = adjustPackStock(it.material_id, doc.warehouse_id, -needLoose, mat);
        const unitCost = Number(it.cost_price) || Number(mat.cost) || 0;
        const cost = Number(it.amount) || round2(unitCost * needLoose);
        const newCost = stock.after > 0
          ? (stock.before * (Number(mat.cost) || 0) - cost) / stock.after
          : 0;
        db.prepare('UPDATE materials SET cost=? WHERE id=?').run(round4(Math.max(0, newCost)), it.material_id);
        writeLog({
          materialId: it.material_id, warehouseId: doc.warehouse_id, docType: 'PRET', docSn: doc.sn,
          delta: -needLoose, before: stock.before, after: stock.after,
          cost: unitCost, amount: cost, remark: `退回供应商 ${needLoose} ${mat.sub_unit}`, operatorId: ctx.user.userId
        });
        pushEffect('subqty', null, -needLoose, 0, unitCost);
        totalCost += cost;
      }
      // 普通物料
      else {
        const before = invGet(it.material_id, doc.warehouse_id);
        const after = before - it.qty;
        invSet(it.material_id, doc.warehouse_id, round3(after));
        const returnCost = Number(it.amount) || round2((Number(it.cost_price) || Number(mat.cost) || 0) * it.qty);
        const newCost = after > 0
          ? (before * (Number(mat.cost) || 0) - returnCost) / after
          : 0;
        db.prepare('UPDATE materials SET cost=? WHERE id=?').run(round4(Math.max(0, newCost)), it.material_id);
        writeLog({ materialId: it.material_id, warehouseId: doc.warehouse_id, docType: 'PRET', docSn: doc.sn,
          delta: -it.qty, before, after, cost: it.cost_price, amount: returnCost,
          remark: '退回供应商', operatorId: ctx.user.userId });
        pushEffect('inv', null, -it.qty, 0, it.cost_price);
        totalCost += returnCost;
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
    } else if (e.kind === 'subqty') {
      const mat = db.prepare('SELECT * FROM materials WHERE id=?').get(e.material_id);
      const stock = adjustPackStock(e.material_id, e.warehouse_id, -e.qty_delta, mat);
      writeLog({ materialId: e.material_id, warehouseId: e.warehouse_id, docType: 'VOID', docSn: doc.sn,
        delta: -e.qty_delta, before: stock.before, after: stock.after, cost: e.cost,
        amount: Math.abs(e.qty_delta) * (e.cost || 0), remark: '整进零出库存回滚', operatorId: ctx.user.userId });
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
    const { keyword = '', status = '', from = '', to = '', supplier = '', contract = '', model = '', customer = '', product = '', brand = '', material_keyword = '', salesperson = '' } = ctx.query;
    // 条件单独拼：列表要联表取名称，合计/计数不用联表，两者参数不能混用
    let where = ' WHERE d.type = ?';
    const wArgs = [type];
    if (ctx.user.role === 'sales') { where += ' AND (d.created_by = ? OR d.salesperson_id = ?)'; wArgs.push(ctx.user.userId, ctx.user.userId); }
    if (keyword) { where += ' AND (d.sn LIKE ? OR d.contract_sn LIKE ?)'; wArgs.push(`%${keyword}%`, `%${keyword}%`); }
    if (contract) { where += ' AND d.contract_sn LIKE ?'; wArgs.push(`%${contract}%`); }
    if (type === 'IN' && supplier) { where += ' AND EXISTS (SELECT 1 FROM suppliers sf WHERE sf.id=d.partner_id AND sf.name LIKE ?)'; wArgs.push(`%${supplier}%`); }
    if (type === 'IN' && model) {
      where += ' AND EXISTS (SELECT 1 FROM doc_items fi JOIN materials fm ON fm.id=fi.material_id WHERE fi.doc_id=d.id AND (fm.model LIKE ? OR (fm.model_edited=0 AND fm.spec LIKE ?)))';
      wArgs.push(`%${model}%`, `%${model}%`);
    }
    if (type === 'OUT') {
      if (customer) { where += ' AND EXISTS (SELECT 1 FROM customers cf WHERE cf.id=d.partner_id AND cf.name LIKE ?)'; wArgs.push(`%${customer}%`); }
      if (product) { where += ' AND EXISTS (SELECT 1 FROM doc_items pf JOIN materials pm ON pm.id=pf.material_id WHERE pf.doc_id=d.id AND pm.name LIKE ?)'; wArgs.push(`%${product}%`); }
      if (brand) { where += ' AND EXISTS (SELECT 1 FROM doc_items bf JOIN materials bm ON bm.id=bf.material_id WHERE bf.doc_id=d.id AND bm.brand LIKE ?)'; wArgs.push(`%${brand}%`); }
      if (material_keyword) {
        where += ' AND EXISTS (SELECT 1 FROM doc_items kf JOIN materials km ON km.id=kf.material_id WHERE kf.doc_id=d.id AND (km.name LIKE ? OR km.code LIKE ? OR km.model LIKE ? OR km.spec LIKE ? OR km.brand LIKE ? OR km.barcode LIKE ?))';
        wArgs.push(...Array(6).fill(`%${material_keyword}%`));
      }
      if (salesperson) { where += ' AND EXISTS (SELECT 1 FROM users sf WHERE sf.id=d.salesperson_id AND (sf.name LIKE ? OR sf.employee_no LIKE ?))'; wArgs.push(`%${salesperson}%`, `%${salesperson}%`); }
    }
    if (status) {
      where += ' AND d.status = ?';
      wArgs.push(status);
    } else {
      // 默认只显示非作废状态的单据(草稿、待审核、已审核、已驳回),需要看作废的单据时手动筛选
      where += " AND d.status != 'void'";
    }
    if (from) { where += ' AND d.doc_date >= ?'; wArgs.push(from); }
    if (to) { where += ' AND d.doc_date <= ?'; wArgs.push(to); }

    // 合计与总条数要按全部筛选结果算，不受当前页影响
    const agg = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(d.total_amount),0) AS amt FROM docs d' + where)
      .get(...wArgs);

    const sql = `SELECT d.*,
                 CASE WHEN ? = 'customer' THEN c.name ELSE s.name END AS partner_name,
                 u.name AS creator_name, a.name AS auditor_name,
                 sp.name AS salesperson_name, sp.employee_no AS salesperson_employee_no
               FROM docs d
               LEFT JOIN customers c ON ? = 'customer' AND c.id = d.partner_id
               LEFT JOIN suppliers s ON ? = 'supplier' AND s.id = d.partner_id
               LEFT JOIN users u ON u.id = d.created_by
               LEFT JOIN users sp ON sp.id = d.salesperson_id
               LEFT JOIN users a ON a.id = d.audited_by` + where + ' ORDER BY d.id DESC LIMIT ? OFFSET ?';

    const pg = clampPage(pageParams(ctx.query), agg.n);
    const rows = db.prepare(sql).all(meta.partner, meta.partner, meta.partner, ...wArgs, pg.size, pg.offset);

    // 入库单和采购退货单：进货价就是成本，不显示成本列；出库单才显示成本与毛利
    const showCost = ctx.can('cost.view') && type !== 'IN' && type !== 'PRET';
    const list = rows.map(r => {
      const o = { ...r, statusName: STATUS_NAME[r.status] };
      if (!showCost) { delete o.total_cost; }
      return o;
    });
    return {
      list, totalAmount: round2(agg.amt), statusNames: STATUS_NAME,
      page: pageMeta(agg.n, pg)
    };
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
    const items = db.prepare('SELECT i.*, m.name AS material_name, m.code AS material_code, m.model AS material_model, m.model_edited AS material_model_edited, m.spec AS material_spec, m.unit, m.type AS material_type, m.sub_unit, m.base_width FROM doc_items i LEFT JOIN materials m ON m.id=i.material_id WHERE i.doc_id=?').all(id);
    const creator = db.prepare('SELECT name FROM users WHERE id=?').get(doc.created_by);
    const auditor = doc.audited_by ? db.prepare('SELECT name FROM users WHERE id=?').get(doc.audited_by) : null;
    const warehouse = db.prepare('SELECT name FROM warehouses WHERE id=?').get(doc.warehouse_id);

    // 入库单和采购退货单：进货价就是成本，不显示成本列；出库单才显示成本与毛利
    const showCost = ctx.can('cost.view') && type !== 'IN' && type !== 'PRET';
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
                                   m.model AS material_model, m.model_edited AS material_model_edited,
                                   m.spec AS material_spec, m.unit, m.type AS material_type, m.sub_unit, m.base_width
                            FROM doc_items i LEFT JOIN materials m ON m.id=i.material_id
                            WHERE i.doc_id=?`).all(doc.id);

  // 该单已退过多少，避免重复退
  const retType = doc.type === 'OUT' ? 'SRET' : 'PRET';
  const returned = db.prepare(`SELECT ri.origin_item_id, ri.material_id, COALESCE(SUM(ri.qty),0) q
                               FROM docs rd JOIN doc_items ri ON ri.doc_id=rd.id
                               WHERE rd.type=? AND rd.origin_doc_id=? AND rd.status IN ('pending','approved')
                               GROUP BY ri.origin_item_id, ri.material_id`).all(retType, doc.id);
  const retByOriginItem = new Map(returned.filter(r => r.origin_item_id != null).map(r => [r.origin_item_id, r.q]));
  const legacyRetByMaterial = new Map();
  for (const r of returned) if (r.origin_item_id == null) {
    legacyRetByMaterial.set(r.material_id, (legacyRetByMaterial.get(r.material_id) || 0) + r.q);
  }
  const legacyRemainder = new Map(legacyRetByMaterial);

  return {
    doc: {
      id: doc.id, sn: doc.sn, type: doc.type, doc_date: doc.doc_date,
      partner_id: doc.partner_id, partner_name: partner?.name || '',
      warehouse_id: doc.warehouse_id, warehouse_name: warehouse?.name || '',
      contract_sn: doc.contract_sn, total_amount: doc.total_amount,
      salesperson_id: doc.salesperson_id
    },
    items: items.map(it => {
      const linkedReturned = retByOriginItem.get(it.id) || 0;
      // 兼容旧退货明细：旧数据未绑定原单行时，按原单行顺序分配已退数量，避免重复计算可退量。
      const legacyAvailable = legacyRemainder.get(it.material_id) || 0;
      const legacyReturned = Math.min(legacyAvailable, Math.max(0, it.qty - linkedReturned));
      if (legacyReturned > 0) legacyRemainder.set(it.material_id, legacyAvailable - legacyReturned);
      const already = linkedReturned + legacyReturned;
      const isPackSplit = it.material_type === 'master' && it.sub_unit && it.sub_unit !== 'mm';
      const perPack = Number(it.base_width) || 1;
      const qty = isPackSplit && doc.type === 'IN' && it.qty_whole == null
        ? it.qty * perPack : it.qty;
      const parts = isPackSplit
        ? (it.qty_whole != null || it.qty_sub != null
          ? { whole: Number(it.qty_whole) || 0, loose: Number(it.qty_sub) || 0 }
          : doc.type === 'IN'
            ? { whole: Number(it.qty) || 0, loose: 0 }
            : splitPackStock(qty, perPack, it))
        : { whole: null, loose: null };
      return {
        id: it.id, origin_item_id: it.id, material_id: it.material_id, material_name: it.material_name,
        material_code: it.material_code, material_model: it.material_model, material_model_edited: it.material_model_edited, material_spec: it.material_spec,
        unit: it.unit, material_type: it.material_type, sub_unit: it.sub_unit, base_width: it.base_width,
        qty, qty_whole: parts.whole, qty_sub: parts.loose, price: it.price, amount: it.amount,
        price_basis: it.price_basis || (doc.type === 'IN' && isPackSplit ? 'pack' : ''),
        cut_width: it.cut_width, batch_no: it.batch_no,
        returned_qty: already,
        returnable: isPackSplit && it.sub_unit === '米'
          ? Math.round(Math.max(0, qty - already) * 10) / 10
          : round3(Math.max(0, qty - already))
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
function roundSubQty(n, mat) {
  return mat?.sub_unit === '米'
    ? Math.round((Number(n) || 0) * 10) / 10
    : round3(n);
}
function splitPackStock(total, perPack, mat) {
  const safeTotal = Math.max(0, Number(total) || 0);
  const whole = Math.floor((safeTotal + 1e-8) / perPack);
  const loose = roundSubQty(safeTotal - whole * perPack, mat);
  return { whole, loose };
}
function fmt(n) { return round3(n); }

/* ---------------- 单据详情 ---------------- */
route('GET', '/api/docs/:id', async (ctx) => {
  const id = Number(ctx.params.id);
  const doc = db.prepare('SELECT * FROM docs WHERE id=?').get(id);
  if (!doc) notFound('单据不存在');
  const meta = DOC_META[doc.type];
  ctx.need(meta.view);
  const items = db.prepare(`SELECT di.*, m.name mat_name, m.model, m.model_edited, m.spec, m.unit, m.type mat_type, m.sub_unit, m.base_width
    FROM doc_items di JOIN materials m ON m.id=di.material_id WHERE di.doc_id=?`).all(id);
  return { ...doc, items };
});

/* ---------------- 列表 ---------------- */
route('GET', '/api/docs', async (ctx) => {
  const type = ctx.query.type || 'OUT';
  const meta = DOC_META[type];
  if (!meta) bad('单据类型无效');
  ctx.need(meta.view);

  const pg = pageParams(ctx.query);
  const warehouseId = ctx.query.warehouse_id || '';
  const status = ctx.query.status || '';
  const partnerId = ctx.query.partner_id || '';
  const from = ctx.query.from || '';
  const to = ctx.query.to || '';

  let where = ['type=?'];
  const args = [type];
  if (warehouseId) { where.push('warehouse_id=?'); args.push(warehouseId); }
  if (status) { where.push('status=?'); args.push(status); }
  if (partnerId) { where.push('partner_id=?'); args.push(partnerId); }
  if (from) { where.push('doc_date>=?'); args.push(from); }
  if (to) { where.push('doc_date<=?'); args.push(to); }

  // 销售员只看自己的单
  if (ctx.user.role === 'sales' && meta.partner === 'customer') {
    where.push('created_by=?');
    args.push(ctx.user.userId);
  }
  // 采购员只看自己的单
  if (ctx.user.role === 'purchase' && meta.partner === 'supplier') {
    where.push('created_by=?');
    args.push(ctx.user.userId);
  }

  const sql = 'SELECT * FROM docs WHERE ' + where.join(' AND ') + ' ORDER BY id DESC LIMIT ? OFFSET ?';
  const list = db.prepare(sql).all(...args, pg.size, pg.offset);
  const total = db.prepare('SELECT COUNT(*) c FROM docs WHERE ' + where.join(' AND ')).get(...args).c;

  const whs = db.prepare('SELECT id,name FROM warehouses').all();
  const whMap = new Map(whs.map(w => [w.id, w.name]));
  const partners = db.prepare(`SELECT id,name FROM ${meta.partner === 'customer' ? 'customers' : 'suppliers'}`).all();
  const pMap = new Map(partners.map(p => [p.id, p.name]));
  const users = db.prepare('SELECT id,name FROM users').all();
  const uMap = new Map(users.map(u => [u.id, u.name]));

  return {
    list: list.map(d => ({
      id: d.id, sn: d.sn, type: d.type, doc_date: d.doc_date,
      warehouse_id: d.warehouse_id, warehouse_name: whMap.get(d.warehouse_id) || '',
      partner_id: d.partner_id, partner_name: pMap.get(d.partner_id) || '',
      contract_sn: d.contract_sn, total_amount: d.total_amount, remark: d.remark,
      status: d.status, status_name: STATUS_NAME[d.status] || '',
      created_by: d.created_by, created_by_name: uMap.get(d.created_by) || '',
      created_at: d.created_at
    })),
    pagination: pageMeta(total, pg)
  };
});

/* ---------------- 新建 ---------------- */
route('POST', '/api/docs', async (ctx) => {
  const type = ctx.body.type || 'OUT';
  const meta = DOC_META[type];
  if (!meta) bad('单据类型无效');
  return saveDoc(ctx, null, type, false);
});

/* ---------------- 编辑 ---------------- */
route('PUT', '/api/docs/:id', async (ctx) => {
  const id = Number(ctx.params.id);
  const doc = db.prepare('SELECT * FROM docs WHERE id=?').get(id);
  if (!doc) notFound('单据不存在');
  return saveDoc(ctx, id, doc.type, false);
});


module.exports = { DOC_META, STATUS_NAME, round2, round3, round4, approveDoc, voidDoc };
