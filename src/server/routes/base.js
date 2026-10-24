'use strict';
const { route, bad, notFound, forbidden, logAction } = require('../http-framework');
const { db, now } = require('../db');

/* ==================== 客户 ==================== */
route('GET', '/api/customers', async (ctx) => {
  ctx.need('customer.view');
  const { keyword = '', status = '' } = ctx.query;
  let sql = `SELECT c.*, u.name AS salesperson_name FROM customers c
             LEFT JOIN users u ON u.id = c.salesperson_id WHERE 1=1`;
  const args = [];
  // 销售员只能看自己负责的客户
  if (ctx.user.role === 'sales') { sql += ' AND c.salesperson_id = ?'; args.push(ctx.user.userId); }
  if (keyword) { sql += ' AND (c.name LIKE ? OR c.contact LIKE ? OR c.phone LIKE ? OR c.code LIKE ?)'; args.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`); }
  if (status !== '') { sql += ' AND c.status=?'; args.push(Number(status)); }
  sql += ' ORDER BY c.id DESC';
  const list = db.prepare(sql).all(...args);
  // 应收余额
  const arMap = receivableMap();
  return { list: list.map(c => ({ ...c, receivable: arMap.get(c.id) || 0 })) };
});

route('POST', '/api/customers', async (ctx) => {
  ctx.need('customer.create');
  const { name, contact, phone, address, salesperson_id, level, remark } = ctx.body;
  if (!name) bad('客户名称必填');
  const code = ctx.body.code || nextCode('customers', 'C');
  if (db.prepare('SELECT id FROM customers WHERE name=?').get(name)) bad('客户名称已存在');
  const sp = ctx.user.role === 'sales' ? ctx.user.userId : (salesperson_id || null);
  const r = db.prepare(`INSERT INTO customers(code,name,contact,phone,address,salesperson_id,level,remark,status,created_at)
                        VALUES (?,?,?,?,?,?,?,?,1,?)`)
    .run(code, name, contact || '', phone || '', address || '', sp, level || 'C', remark || '', now());
  logAction(ctx, 'create', 'customer', `新增客户 ${name}`);
  return { id: Number(r.lastInsertRowid), code };
});

route('PUT', '/api/customers/:id', async (ctx) => {
  ctx.need('customer.edit');
  const id = Number(ctx.params.id);
  const c = db.prepare('SELECT * FROM customers WHERE id=?').get(id);
  if (!c) notFound('客户不存在');
  if (ctx.user.role === 'sales' && c.salesperson_id !== ctx.user.userId) forbidden('只能修改自己负责的客户');
  const b = ctx.body;
  db.prepare(`UPDATE customers SET name=?,contact=?,phone=?,address=?,salesperson_id=?,level=?,remark=? WHERE id=?`)
    .run(b.name ?? c.name, b.contact ?? c.contact, b.phone ?? c.phone, b.address ?? c.address,
      b.salesperson_id ?? c.salesperson_id, b.level ?? c.level, b.remark ?? c.remark, id);
  logAction(ctx, 'update', 'customer', `编辑客户 ${c.name}`);
  return {};
});

// 删除仅超级管理员
route('DELETE', '/api/customers/:id', async (ctx) => {
  if (ctx.user.role !== 'admin') forbidden('只有超级管理员可以删除客户');
  const id = Number(ctx.params.id);
  const c = db.prepare('SELECT * FROM customers WHERE id=?').get(id);
  if (!c) notFound('客户不存在');
  const used = db.prepare('SELECT COUNT(*) n FROM docs WHERE partner_id=? AND type IN (?,?)').get(id, 'OUT', 'SRET').n;
  if (used > 0) bad(`该客户有 ${used} 张单据，不能删除，请改为「停用」`);
  db.prepare('DELETE FROM customers WHERE id=?').run(id);
  logAction(ctx, 'delete', 'customer', `删除客户 ${c.name}`);
  return {};
});

/* ==================== 供应商 ==================== */
route('GET', '/api/suppliers', async (ctx) => {
  ctx.need('supplier.view');
  const { keyword = '', status = '' } = ctx.query;
  let sql = 'SELECT * FROM suppliers WHERE 1=1';
  const args = [];
  if (keyword) { sql += ' AND (name LIKE ? OR contact LIKE ? OR phone LIKE ? OR code LIKE ?)'; args.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`); }
  if (status !== '') { sql += ' AND status=?'; args.push(Number(status)); }
  sql += ' ORDER BY id DESC';
  const list = db.prepare(sql).all(...args);
  const apMap = payableMap();
  return { list: list.map(s => ({ ...s, payable: apMap.get(s.id) || 0 })) };
});

route('POST', '/api/suppliers', async (ctx) => {
  ctx.need('supplier.create');
  const { name, contact, phone, address, remark } = ctx.body;
  if (!name) bad('供应商名称必填');
  const code = ctx.body.code || nextCode('suppliers', 'S');
  if (db.prepare('SELECT id FROM suppliers WHERE name=?').get(name)) bad('供应商名称已存在');
  const r = db.prepare(`INSERT INTO suppliers(code,name,contact,phone,address,remark,status,created_at)
                        VALUES (?,?,?,?,?,?,1,?)`)
    .run(code, name, contact || '', phone || '', address || '', remark || '', now());
  logAction(ctx, 'create', 'supplier', `新增供应商 ${name}`);
  return { id: Number(r.lastInsertRowid), code };
});

route('PUT', '/api/suppliers/:id', async (ctx) => {
  ctx.need('supplier.edit');
  const id = Number(ctx.params.id);
  const s = db.prepare('SELECT * FROM suppliers WHERE id=?').get(id);
  if (!s) notFound('供应商不存在');
  const b = ctx.body;
  db.prepare('UPDATE suppliers SET name=?,contact=?,phone=?,address=?,remark=? WHERE id=?')
    .run(b.name ?? s.name, b.contact ?? s.contact, b.phone ?? s.phone, b.address ?? s.address, b.remark ?? s.remark, id);
  logAction(ctx, 'update', 'supplier', `编辑供应商 ${s.name}`);
  return {};
});

route('DELETE', '/api/suppliers/:id', async (ctx) => {
  if (ctx.user.role !== 'admin') forbidden('只有超级管理员可以删除供应商');
  const id = Number(ctx.params.id);
  const s = db.prepare('SELECT * FROM suppliers WHERE id=?').get(id);
  if (!s) notFound('供应商不存在');
  const used = db.prepare('SELECT COUNT(*) n FROM docs WHERE partner_id=? AND type IN (?,?)').get(id, 'IN', 'PRET').n;
  if (used > 0) bad(`该供应商有 ${used} 张单据，不能删除，请改为「停用」`);
  db.prepare('DELETE FROM suppliers WHERE id=?').run(id);
  logAction(ctx, 'delete', 'supplier', `删除供应商 ${s.name}`);
  return {};
});

/* ==================== 物料 ==================== */
/**
 * normal = 不可分割（整件出入库，如电缆附件、接头、端子）
 * master = 可分割母卷（如胶带整支，出库时按宽度分切）
 * sub    = 已分切子卷（系统自动生成，不手工新建）
 * waste  = 料头（剩余宽度不足，系统自动标记）
 */
const MATERIAL_TYPES = { normal: '不可分割', master: '可分割母卷', sub: '已分切子卷', waste: '料头' };
/** 新建物料时可选的类型（子卷和料头由系统生成） */
const CREATABLE_TYPES = { normal: '不可分割', master: '可分割母卷' };
/** 常用单位 */
const COMMON_UNITS = ['个', '只', '套', '台', '件', '箱', '盒', '包', '卷', '支', '米', '千克', '吨', '付', '张', '片'];

route('GET', '/api/materials', async (ctx) => {
  ctx.need('material.view');
  const { keyword = '', type = '', warehouse_id = '' } = ctx.query;
  let sql = `SELECT m.*, u.name AS unit FROM materials m LEFT JOIN materials u ON 0 WHERE 1=1`
    .replace(' u.name AS unit FROM materials m LEFT JOIN materials u ON 0 WHERE 1=1', ' * FROM materials m WHERE 1=1');
  const args = [];
  if (keyword) {
    sql += ' AND (m.name LIKE ? OR m.code LIKE ? OR m.spec LIKE ? OR m.brand LIKE ? OR m.barcode LIKE ?)';
    args.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
  }
  if (type) { sql += ' AND m.type=?'; args.push(type); }
  sql += ' ORDER BY m.id DESC';
  const rows = db.prepare(sql).all(...args);

  const showCost = ctx.can('cost.view');
  const list = rows.map(m => {
    const stock = totalStock(m.id, warehouse_id || null);
    const item = {
      ...m, typeName: MATERIAL_TYPES[m.type] || m.type,
      stock_qty: stock.qty,
      roll_count: stock.rolls,
      open_width: stock.openWidth
    };
    if (!showCost) { delete item.cost; }
    return item;
  });
  return { list, types: MATERIAL_TYPES, creatableTypes: CREATABLE_TYPES, units: COMMON_UNITS };
});

route('POST', '/api/materials', async (ctx) => {
  ctx.need('material.create');
  const b = ctx.body;
  if (!b.name) bad('物料名称必填');
  if (!b.unit) bad('请选择计量单位');
  const type = b.type || 'normal';
  if (!CREATABLE_TYPES[type]) bad('物料类型只能是不可分割或可分割母卷');
  if (type === 'master' && !(Number(b.base_width) > 0)) bad('可分割母卷必须填写整支宽度（毫米）');
  const code = b.code || nextCode('materials', 'M');
  if (db.prepare('SELECT id FROM materials WHERE code=?').get(code)) bad('物料编号已存在');
  const r = db.prepare(`INSERT INTO materials(code,name,brand,spec,unit,type,barcode,base_width,min_waste,cut_fee,parent_id,safety_stock,cost,batch_manage,status,created_at)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)`)
    .run(code, b.name, b.brand || '', b.spec || '', b.unit, type, b.barcode || '',
      Number(b.base_width) || null, Number(b.min_waste) || 10, Number(b.cut_fee) || 0,
      b.parent_id || null, Number(b.safety_stock) || 0,
      0,  // 成本由入库单决定，新建物料时一律为 0
      b.batch_manage ? 1 : 0, now());
  logAction(ctx, 'create', 'material', `新增物料 ${b.name}`);
  return { id: Number(r.lastInsertRowid), code };
});

route('PUT', '/api/materials/:id', async (ctx) => {
  ctx.need('material.edit');
  const id = Number(ctx.params.id);
  const m = db.prepare('SELECT * FROM materials WHERE id=?').get(id);
  if (!m) notFound('物料不存在');
  const b = ctx.body;
  db.prepare(`UPDATE materials SET name=?,brand=?,spec=?,unit=?,barcode=?,base_width=?,min_waste=?,cut_fee=?,safety_stock=?,batch_manage=? WHERE id=?`)
    .run(b.name ?? m.name, b.brand ?? m.brand, b.spec ?? m.spec, b.unit ?? m.unit, b.barcode ?? m.barcode,
      b.base_width ?? m.base_width, b.min_waste ?? m.min_waste, b.cut_fee ?? m.cut_fee,
      b.safety_stock ?? m.safety_stock, b.batch_manage ?? m.batch_manage, id);
  logAction(ctx, 'update', 'material', `编辑物料 ${m.name}`);
  return {};
});

route('DELETE', '/api/materials/:id', async (ctx) => {
  if (ctx.user.role !== 'admin') forbidden('只有超级管理员可以删除物料');
  const id = Number(ctx.params.id);
  const m = db.prepare('SELECT * FROM materials WHERE id=?').get(id);
  if (!m) notFound('物料不存在');
  const used = db.prepare('SELECT COUNT(*) n FROM doc_items WHERE material_id=?').get(id).n;
  if (used > 0) bad(`该物料有 ${used} 条单据明细，不能删除，请改为「停用」`);
  db.prepare('DELETE FROM inventory WHERE material_id=?').run(id);
  db.prepare('DELETE FROM rolls WHERE material_id=?').run(id);
  db.prepare('DELETE FROM materials WHERE id=?').run(id);
  logAction(ctx, 'delete', 'material', `删除物料 ${m.name}`);
  return {};
});

/* ==================== 仓库 ==================== */
route('GET', '/api/warehouses', async (ctx) => {
  ctx.need('warehouse.view');
  const list = db.prepare('SELECT * FROM warehouses ORDER BY id').all();
  return { list };
});

route('POST', '/api/warehouses', async (ctx) => {
  ctx.need('warehouse.manage');
  const { name, address, keeper } = ctx.body;
  if (!name) bad('仓库名称必填');
  if (db.prepare('SELECT id FROM warehouses WHERE name=?').get(name)) bad('仓库名称已存在');
  const r = db.prepare('INSERT INTO warehouses(name,address,keeper,status,created_at) VALUES (?,?,?,1,?)')
    .run(name, address || '', keeper || '', now());
  logAction(ctx, 'create', 'warehouse', `新增仓库 ${name}`);
  return { id: Number(r.lastInsertRowid) };
});

route('PUT', '/api/warehouses/:id', async (ctx) => {
  ctx.need('warehouse.manage');
  const id = Number(ctx.params.id);
  const w = db.prepare('SELECT * FROM warehouses WHERE id=?').get(id);
  if (!w) notFound('仓库不存在');
  const b = ctx.body;
  db.prepare('UPDATE warehouses SET name=?,address=?,keeper=?,status=? WHERE id=?')
    .run(b.name ?? w.name, b.address ?? w.address, b.keeper ?? w.keeper,
      b.status !== undefined ? Number(b.status) : w.status, id);
  logAction(ctx, 'update', 'warehouse', `编辑仓库 ${w.name}`);
  return {};
});

route('DELETE', '/api/warehouses/:id', async (ctx) => {
  if (ctx.user.role !== 'admin') forbidden('只有超级管理员可以删除仓库');
  const id = Number(ctx.params.id);
  const w = db.prepare('SELECT * FROM warehouses WHERE id=?').get(id);
  if (!w) notFound('仓库不存在');

  const docCount = db.prepare('SELECT COUNT(*) n FROM docs WHERE warehouse_id=?').get(id).n;
  if (docCount > 0) bad(`该仓库关联了 ${docCount} 张单据，不能删除。可以改为「停用」，停用后不再出现在新建单据的选项里。`);

  const invQty = db.prepare('SELECT COALESCE(SUM(qty),0) s FROM inventory WHERE warehouse_id=?').get(id).s;
  const rollCount = db.prepare("SELECT COUNT(*) n FROM rolls WHERE warehouse_id=? AND status!='used'").get(id).n;
  if (invQty > 0 || rollCount > 0) bad('该仓库还有库存，请先出库或调拨后再删除');

  const whCount = db.prepare('SELECT COUNT(*) n FROM warehouses').get().n;
  if (whCount <= 1) bad('至少要保留一个仓库');

  db.prepare('DELETE FROM inventory WHERE warehouse_id=?').run(id);
  db.prepare('DELETE FROM warehouses WHERE id=?').run(id);
  logAction(ctx, 'delete', 'warehouse', `删除仓库 ${w.name}`);
  return {};
});

/* ==================== 工具函数 ==================== */
function nextCode(table, prefix) {
  const row = db.prepare(`SELECT code FROM ${table} WHERE code LIKE ? ORDER BY id DESC LIMIT 1`).get(`${prefix}%`);
  let n = 1;
  if (row) {
    const num = parseInt(String(row.code).replace(prefix, ''), 10);
    if (!isNaN(num)) n = num + 1;
  }
  return prefix + String(n).padStart(4, '0');
}

function totalStock(materialId, warehouseId) {
  const m = db.prepare('SELECT * FROM materials WHERE id=?').get(materialId);
  if (!m) return { qty: 0, rolls: 0, openWidth: 0 };
  if (m.type === 'master') {
    const rows = warehouseId
      ? db.prepare("SELECT * FROM rolls WHERE material_id=? AND warehouse_id=? AND status='open'").all(materialId, warehouseId)
      : db.prepare("SELECT * FROM rolls WHERE material_id=? AND status='open'").all(materialId);
    return { rolls: rows.length, qty: rows.length, openWidth: rows.reduce((s, r) => s + (r.width_total - r.width_used), 0) };
  }
  const row = warehouseId
    ? db.prepare('SELECT qty FROM inventory WHERE material_id=? AND warehouse_id=?').get(materialId, warehouseId)
    : db.prepare('SELECT SUM(qty) qty FROM inventory WHERE material_id=?').get(materialId);
  return { qty: row?.qty || 0, rolls: 0, openWidth: 0 };
}

/** 客户应收余额：出库总额 - 已收款（含退货冲减） */
function receivableMap() {
  const map = new Map();
  const outs = db.prepare(`SELECT partner_id, SUM(total_amount) s FROM docs
                           WHERE type='OUT' AND status='approved' GROUP BY partner_id`).all();
  const rets = db.prepare(`SELECT partner_id, SUM(total_amount) s FROM docs
                           WHERE type='SRET' AND status='approved' GROUP BY partner_id`).all();
  const pays = db.prepare(`SELECT partner_id, SUM(amount) s FROM payments
                           WHERE type='receive' GROUP BY partner_id`).all();
  const add = (rows, sign) => rows.forEach(r => map.set(r.partner_id, (map.get(r.partner_id) || 0) + sign * (r.s || 0)));
  add(outs, 1); add(rets, -1); add(pays, -1);
  return map;
}

/** 供应商应付余额：入库总额 - 已付款（含采购退货冲减） */
function payableMap() {
  const map = new Map();
  const ins = db.prepare(`SELECT partner_id, SUM(total_amount) s FROM docs
                          WHERE type='IN' AND status='approved' GROUP BY partner_id`).all();
  const rets = db.prepare(`SELECT partner_id, SUM(total_amount) s FROM docs
                           WHERE type='PRET' AND status='approved' GROUP BY partner_id`).all();
  const pays = db.prepare(`SELECT partner_id, SUM(amount) s FROM payments
                           WHERE type='pay' GROUP BY partner_id`).all();
  const add = (rows, sign) => rows.forEach(r => map.set(r.partner_id, (map.get(r.partner_id) || 0) + sign * (r.s || 0)));
  add(ins, 1); add(rets, -1); add(pays, -1);
  return map;
}

module.exports = { nextCode, totalStock, receivableMap, payableMap, MATERIAL_TYPES };
