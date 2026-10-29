'use strict';
/**
 * 导出 / 导入：单据、待结转清单、供应商、物料
 * 按 data/templates 里老系统的 Excel 样式来，字段以本系统为准做适配
 */
const { route, bad, notFound, forbidden, logAction } = require('../http-framework');
const { db, now } = require('../db');
const { buildXlsx, readTable, S } = require('../xlsx');
const { nextCode } = require('./base');

function setting(key, def = '') {
  const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return r ? r.value : def;
}
const company = () => setting('company_name', '河南万楼商贸有限公司');

/* ---------------- 下发文件 ---------------- */
function sendXlsx(ctx, buffer, filename) {
  const encoded = encodeURIComponent(filename);
  ctx.res.writeHead(200, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Length': buffer.length,
    'Content-Disposition': `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`,
    'Cache-Control': 'no-store'
  });
  ctx.res.end(buffer);
  return {};
}

/** 空行占位（用于模板里留白） */
const blank = () => [];

/* ==================== 单据导出 ==================== */
const DOC_EXPORT = {
  out:  { type: 'OUT',  label: '出库单', perm: 'outbound.view', partner: 'customer' },
  in:   { type: 'IN',   label: '入库单', perm: 'inbound.view',  partner: 'supplier' },
  sret: { type: 'SRET', label: '出库退货单', perm: 'sret.view', partner: 'customer' },
  pret: { type: 'PRET', label: '入库退货单', perm: 'pret.view', partner: 'supplier' }
};

/**
 * kind:
 *   doc      单据正本（出库单 / 入库单 …，按老模板列）
 *   delivery 送货单，不含任何金额
 */
route('GET', '/api/export/docs/:key/:id', async (ctx) => {
  const conf = DOC_EXPORT[ctx.params.key];
  if (!conf) notFound('不支持的单据类型');
  ctx.need(conf.perm);

  const doc = db.prepare('SELECT * FROM docs WHERE id=? AND type=?').get(Number(ctx.params.id), conf.type);
  if (!doc) notFound('单据不存在');
  if (ctx.user.role === 'sales' && doc.created_by !== ctx.user.userId && doc.salesperson_id !== ctx.user.userId) {
    forbidden('只能导出自己的单据');
  }

  const partnerTable = conf.partner === 'customer' ? 'customers' : 'suppliers';
  const partner = db.prepare(`SELECT * FROM ${partnerTable} WHERE id=?`).get(doc.partner_id) || {};
  const items = db.prepare(`SELECT i.*, m.name AS material_name, m.brand, m.model AS material_model,
                                   m.model_edited AS material_model_edited, m.spec AS material_spec, m.unit,
                                   m.type AS material_type, m.sub_unit, m.base_width
                            FROM doc_items i LEFT JOIN materials m ON m.id=i.material_id
                            WHERE i.doc_id=? ORDER BY i.id`).all(doc.id);
  const creator = db.prepare('SELECT name FROM users WHERE id=?').get(doc.created_by)?.name || '';
  const auditor = doc.audited_by ? (db.prepare('SELECT name FROM users WHERE id=?').get(doc.audited_by)?.name || '') : '';
  const warehouse = db.prepare('SELECT name FROM warehouses WHERE id=?').get(doc.warehouse_id)?.name || '';
  const salesperson = doc.salesperson_id
    ? (db.prepare('SELECT name FROM users WHERE id=?').get(doc.salesperson_id)?.name || '') : '';

  const kind = ctx.query.kind === 'delivery' ? 'delivery' : 'doc';
  const showCost = ctx.can('cost.view');

  const buf = kind === 'delivery'
    ? deliverySheet({ doc, partner, items, warehouse })
    : docSheet({ doc, conf, partner, items, warehouse, creator, auditor, salesperson, showCost });

  const name = kind === 'delivery'
    ? `${conf.label.replace('单', '')}送货单_${doc.sn}.xlsx`
    : `${conf.label}_${doc.sn}.xlsx`;
  return sendXlsx(ctx, buf, name);
});

/** 出库单 / 入库单 / 退货单 —— 照老模板的栏目排 */
function docSheet({ doc, conf, partner, items, warehouse, creator, auditor, salesperson, showCost }) {
  const isOut = conf.partner === 'customer';
  const withPrice = !isOut && showCost;   // 入库类才列价格，且要有成本权限
  const rows = [];

  rows.push([{ v: `${company()}${conf.label}`, s: S.title }, null, null, null, null, null, null, null, null]);
  rows.push(blank());

  const kv = (label, value) => [{ v: label, s: S.text }, { v: value || '', s: S.text }];

  if (isOut) {
    rows.push([...kv(`${conf.label}编号：`, doc.sn)]);
    rows.push([...kv('销售员：', salesperson || creator)]);
    rows.push([...kv('客户名称：', partner.name || '')]);
    rows.push([...kv('销售合同号：', doc.contract_sn || '')]);
    rows.push([{ v: '发货地址、收货人信息：', s: S.text }]);
    rows.push([{ v: [doc.receiver_addr, doc.receiver, doc.receiver_phone].filter(Boolean).join(' ') || partner.address || '', s: S.text }]);
    rows.push([...kv('物流公司：', doc.carrier || '')]);
    rows.push([...kv('其他信息：', doc.remark || '')]);
  } else {
    rows.push([...kv(`${conf.label}编号：`, doc.sn)]);
    rows.push([...kv('供应商名称：', partner.name || '')]);
    rows.push([...kv('采购合同号：', doc.contract_sn || '')]);
    rows.push([...kv('备注：', doc.remark || '')]);
  }
  rows.push(blank());

  const head = isOut
    ? ['序号', '产品', '型号 / 规格', '数量', '单位', '备注', '出库仓库']
    : ['序号', '产品', '型号 / 规格', '数量', '单位', ...(withPrice ? ['单价', '总价'] : []), '备注', '入库仓库'];
  rows.push(head.map(h => ({ v: h, s: S.head })));

  const isReturn = doc.type === 'SRET' || doc.type === 'PRET';
  const sign = isReturn ? -1 : 1;
  let qtySum = 0, amtSum = 0;

  items.forEach((it, i) => {
    const split = exportSplitQuantity(it, doc.type);
    const qty = sign * Math.abs(Number(it.qty) || 0);
    const amount = sign * Math.abs(Number(it.amount) || 0);
    qtySum += qty;
    amtSum += amount;
    const line = [
      { v: i + 1, s: S.int },
      { v: it.material_name || '', s: S.text },
      { v: exportMaterialModelSpec(it), s: S.text },
      { v: split ? `${split.whole} ${it.unit} + ${split.loose} ${it.sub_unit}` : qty, s: split ? S.text : S.int },
      { v: split ? it.sub_unit : (it.unit || ''), s: S.text },
      ...(withPrice ? [{ v: Number(it.price) || 0, s: S.num }, { v: amount, s: S.num }] : []),
      { v: exportRemark(it), s: S.text },
      { v: warehouse, s: S.text }
    ];
    rows.push(line);
  });

  const totalRow = [{ v: '合计：', s: S.total }, { s: S.total }, { s: S.total }, { v: qtySum, s: S.total }];
  if (withPrice) totalRow.push({ s: S.total }, { s: S.total }, { v: amtSum, s: S.total });
  rows.push(totalRow);
  rows.push(blank());
  rows.push([{ v: '发起人：', s: S.text }, { v: creator, s: S.text }, { v: '日期：', s: S.text }, { v: doc.created_at || '', s: S.text }]);
  rows.push([{ v: '审核人：', s: S.text }, { v: auditor, s: S.text }, { v: '日期：', s: S.text }, { v: doc.audited_at || '', s: S.text }]);

  return buildXlsx([{
    name: conf.label,
    cols: isOut ? [8, 30, 22, 10, 8, 18, 14] : [8, 30, 22, 10, 8, ...(withPrice ? [12, 14] : []), 18, 14],
    rows,
    merges: [
      { s: { r: 0, c: 0 }, e: { r: 0, c: isOut ? 6 : (withPrice ? 8 : 6) } },
      ...(isOut ? [{ s: { r: 5, c: 0 }, e: { r: 5, c: 6 } }] : [])
    ]
  }]);
}

/** 送货单：只给收货方看，不含任何价格 */
function deliverySheet({ doc, partner, items, warehouse }) {
  const rows = [];
  rows.push([{ v: `${company()}送货单`, s: S.title }]);
  rows.push(blank());
  const kv = (label, value) => [{ v: label, s: S.text }, { v: value || '', s: S.text }];
  rows.push([...kv('收货单位：', partner.name || '')]);
  rows.push([...kv('承运人：', doc.carrier || '')]);
  rows.push([...kv('收货地址：', [doc.receiver_addr || partner.address, doc.receiver, doc.receiver_phone].filter(Boolean).join(' ') || '')]);
  rows.push([...kv('合同号：', doc.contract_sn || '')]);
  rows.push([...kv('其他备注：', doc.remark || '')]);
  rows.push(blank());
  rows.push([{ v: '送货内容：', s: S.sub }]);
  rows.push(['序号', '产品', '品牌', '型号', '数量', '单位', '备注'].map(h => ({ v: h, s: S.head })));

  let qtySum = 0;
  items.forEach((it, i) => {
    const qty = Number(it.qty) || 0;
    qtySum += qty;
    const split = exportSplitQuantity(it, doc.type);
    rows.push([
      { v: i + 1, s: S.int }, { v: it.material_name || '', s: S.text }, { v: it.brand || '', s: S.text },
      { v: exportMaterialModelSpec(it), s: S.text },
      { v: split ? `${split.whole} ${it.unit} + ${split.loose} ${it.sub_unit}` : qty, s: split ? S.text : S.int },
      { v: split ? it.sub_unit : (it.unit || ''), s: S.text },
      { v: exportRemark(it), s: S.text }
    ]);
  });
  rows.push([{ v: '合计：', s: S.total }, { s: S.total }, { s: S.total }, { s: S.total }, { v: qtySum, s: S.total }]);
  rows.push(blank());
  rows.push([{ v: '若您对上述货物验收无误，请在此签名：', s: S.text }]);
  rows.push(blank());
  rows.push([{ v: '送货人：', s: S.text }, { v: '', s: S.text }, { v: '日期：', s: S.text }, { v: doc.doc_date || '', s: S.text }]);

  return buildXlsx([{
    name: '送货单',
    cols: [8, 30, 14, 22, 10, 8, 18],
    rows,
    merges: [
      { s: { r: 0, c: 0 }, e: { r: 0, c: 6 } },
      { s: { r: 4, c: 1 }, e: { r: 4, c: 6 } },
      { s: { r: 5 + 3 + 1, c: 0 }, e: { r: 5 + 3 + 1, c: 6 } }
    ]
  }]);
}

function exportSplitQuantity(item, docType) {
  if (item.material_type !== 'master' || !item.sub_unit || item.sub_unit === 'mm') return null;
  const perPack = Number(item.base_width) || 1;
  if (item.qty_whole != null || item.qty_sub != null) {
    return { whole: Number(item.qty_whole) || 0, loose: Number(item.qty_sub) || 0 };
  }
  // 旧入库单 qty 仍按整单位存储；其他旧单据 qty 按零单位存储。
  const total = docType === 'IN' ? (Number(item.qty) || 0) * perPack : (Number(item.qty) || 0);
  return { whole: Math.floor((total + 1e-8) / perPack), loose: Math.round((total % perPack) * 1000) / 1000 };
}

function exportMaterialModelSpec(item) {
  const edited = item.material_model_edited ?? item.model_edited ?? 1;
  const model = edited ? (item.material_model || '') : (item.material_spec || '');
  const spec = edited ? (item.material_spec || '') : '';
  return [model, spec].filter(Boolean).join(' · ');
}

function exportRemark(item) {
  const details = [];
  if (item.material_type === 'master' && item.sub_unit === 'mm') {
    details.push(`母卷宽度 ${Number(item.base_width) || 0}mm`);
  } else if (item.material_type === 'master' && item.sub_unit) {
    details.push(`1 ${item.unit} = ${Number(item.base_width) || 1} ${item.sub_unit}`);
  }
  if (item.cut_width) details.push(`分切 ${item.cut_width}mm`);
  if (item.remark) details.push(item.remark);
  return details.join('；');
}

/* ==================== 待结转库存清单 ==================== */
route('GET', '/api/export/carryover', async (ctx) => {
  ctx.need('report.carryover');
  if (!ctx.can('cost.view')) forbidden('清单含成本与毛利，需要成本查看权限');

  const { from = '', to = '', customer_id = '', salesperson_id = '', invoice_status = '' } = ctx.query;
  let sql = `SELECT d.sn, d.doc_date, d.contract_sn, d.total_amount, d.total_cost, d.invoice_status,
                    c.name AS customer_name, u.name AS salesperson_name
             FROM docs d
             LEFT JOIN customers c ON c.id=d.partner_id
             LEFT JOIN users u ON u.id=d.salesperson_id
             WHERE d.type='OUT' AND d.status='approved'`;
  const args = [];
  if (from) { sql += ' AND d.doc_date >= ?'; args.push(from); }
  if (to) { sql += ' AND d.doc_date <= ?'; args.push(to); }
  if (customer_id) { sql += ' AND d.partner_id = ?'; args.push(Number(customer_id)); }
  if (salesperson_id) { sql += ' AND d.salesperson_id = ?'; args.push(Number(salesperson_id)); }
  if (invoice_status !== '') { sql += ' AND d.invoice_status = ?'; args.push(Number(invoice_status)); }
  if (ctx.user.role === 'sales') { sql += ' AND d.salesperson_id = ?'; args.push(ctx.user.userId); }
  sql += ' ORDER BY d.doc_date DESC, d.id DESC';
  const list = db.prepare(sql).all(...args);

  const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
  const rows = [];
  rows.push([{ v: '公司名称：', s: S.text }, { v: company(), s: S.text }]);
  rows.push([{ v: '报表名称：', s: S.text }, { v: '待结转库存清单表', s: S.text }]);
  rows.push([{ v: '期间：', s: S.text }, { v: `${from || '不限'} - ${to || '不限'}`, s: S.text }]);
  rows.push(['出库单编号', '出库时间', '客户名称', '销售员', '销售合同号', '不含税销售总价', '不含税成本总价', '毛利润', '毛利率', '是否开票']
    .map(h => ({ v: h, s: S.head })));

  let amtSum = 0, costSum = 0, profitSum = 0;
  for (const r of list) {
    const amt = round2(r.total_amount), cost = round2(r.total_cost);
    const profit = round2(amt - cost);
    const rate = amt > 0 ? (profit / amt * 100).toFixed(2) + '%' : '0.00%';
    amtSum += amt; costSum += cost; profitSum += profit;
    rows.push([
      { v: r.sn, s: S.text }, { v: r.doc_date, s: S.text }, { v: r.customer_name || '', s: S.text },
      { v: r.salesperson_name || '', s: S.text }, { v: r.contract_sn || '', s: S.text },
      { v: amt, s: S.num }, { v: cost, s: S.num }, { v: profit, s: S.num }, { v: rate, s: S.text },
      { v: r.invoice_status === 0 ? '否' : '是', s: S.text }
    ]);
  }
  const margin = amtSum > 0 ? (profitSum / amtSum * 100).toFixed(2) + '%' : '0.00%';
  rows.push([{ v: '合计', s: S.total }, { s: S.total }, { s: S.total }, { s: S.total }, { s: S.total },
    { v: round2(amtSum), s: S.total }, { v: round2(costSum), s: S.total },
    { v: round2(profitSum), s: S.total }, { v: margin, s: S.total }, { s: S.total }]);

  const buf = buildXlsx([{
    name: '待结转库存清单',
    cols: [26, 12, 34, 10, 24, 16, 16, 14, 10, 10],
    rows
  }]);
  return sendXlsx(ctx, buf, `待结转库存清单表_${(from || '全部')}_${(to || '全部')}.xlsx`);
});

/* ==================== 供应商导入导出 ==================== */
const SUPPLIER_HEAD = ['供应商编号', '供应商名称', '地区', '联系人', '电话', '手机号', '邮箱地址', '公司地址', '资信时间(天)', '资信金额(万元)', '备注', '供应商级别'];

route('GET', '/api/export/suppliers', async (ctx) => {
  ctx.need('supplier.view');
  const list = db.prepare('SELECT * FROM suppliers ORDER BY id').all();
  const rows = [SUPPLIER_HEAD.map(h => ({ v: h, s: S.head }))];
  for (const s of list) {
    rows.push([
      { v: s.code, s: S.text }, { v: s.name, s: S.text }, { v: s.region || '', s: S.text },
      { v: s.contact || '', s: S.text }, { v: s.phone || '', s: S.text }, { v: s.mobile || '', s: S.text },
      { v: s.email || '', s: S.text }, { v: s.address || '', s: S.text },
      { v: Number(s.credit_days) || 0, s: S.int }, { v: Number(s.credit_amount) || 0, s: S.num },
      { v: s.remark || '', s: S.text }, { v: s.level || '', s: S.text }
    ]);
  }
  const buf = buildXlsx([{ name: '供应商', cols: [18, 34, 14, 12, 16, 14, 22, 34, 14, 16, 20, 12], rows }]);
  return sendXlsx(ctx, buf, `供应商导出_${now().slice(0, 10)}.xlsx`);
});

/** 空模板：只给表头 + 一行示例 */
route('GET', '/api/export/suppliers/template', async (ctx) => {
  ctx.need('supplier.create');
  const rows = [
    SUPPLIER_HEAD.map(h => ({ v: h, s: S.head })),
    ['（可留空，系统自动编号）', '郑州示例电气有限公司', '河南郑州', '张工', '0371-88886666', '13800000000',
      'zhang@example.com', '郑州市金水区', 30, 10, '示例行，导入前请删除', 'A'].map((v, i) => ({ v, s: i === 8 ? S.int : S.text }))
  ];
  const buf = buildXlsx([{ name: '供应商导入模板', cols: [22, 34, 14, 12, 16, 14, 22, 34, 14, 16, 24, 12], rows }]);
  return sendXlsx(ctx, buf, '供应商导入模板.xlsx');
});

route('POST', '/api/import/suppliers', async (ctx) => {
  ctx.need('supplier.create');
  const { filename = '', content = '', dryRun } = ctx.body || {};
  if (!content) bad('没有收到文件内容');
  const buf = Buffer.from(content, 'base64');
  if (buf.length > 15 * 1024 * 1024) bad('文件过大，请控制在 15MB 以内');

  let table;
  try { table = readTable(buf, filename); }
  catch (e) { bad('文件解析失败：' + e.message); }
  if (!table.length) bad('文件是空的');

  // 表头定位：在前 5 行里找含「供应商名称」的那一行
  let headIdx = table.findIndex(r => r.some(c => String(c).includes('供应商名称')));
  if (headIdx < 0) bad('没找到表头，请确认第一行包含「供应商名称」等列名');
  const head = table[headIdx].map(c => String(c || '').trim());
  const col = (...names) => {
    for (const n of names) {
      const i = head.findIndex(h => h === n);
      if (i >= 0) return i;
    }
    for (const n of names) {
      const i = head.findIndex(h => h.includes(n));
      if (i >= 0) return i;
    }
    return -1;
  };
  const idx = {
    code: col('供应商编号', '编号', '编码'),
    name: col('供应商名称', '名称'),
    region: col('地区', '区域'),
    contact: col('联系人'),
    phone: col('电话', '固话'),
    mobile: col('手机号', '手机'),
    email: col('邮箱地址', '邮箱'),
    address: col('公司地址', '地址'),
    creditDays: col('资信时间', '账期'),
    creditAmount: col('资信金额'),
    remark: col('备注'),
    level: col('供应商级别', '级别')
  };
  if (idx.name < 0) bad('缺少「供应商名称」列，无法导入');

  const pick = (row, i) => (i >= 0 && row[i] !== undefined ? String(row[i]).trim() : '');
  const num = v => { const n = Number(String(v).replace(/[,，\s]/g, '')); return Number.isFinite(n) ? n : 0; };
  const cleanCode = v => (/留空|自动编号|示例/.test(v) ? '' : v);

  let added = 0, updated = 0;
  const errors = [];
  const seen = new Set();

  const findByName = db.prepare('SELECT id FROM suppliers WHERE name=?');
  const findByCode = db.prepare('SELECT id FROM suppliers WHERE code=?');
  const ins = db.prepare(`INSERT INTO suppliers(code,name,region,contact,phone,mobile,email,address,
                          credit_days,credit_amount,remark,level,status,created_at)
                          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?)`);
  const upd = db.prepare(`UPDATE suppliers SET name=?,region=?,contact=?,phone=?,mobile=?,email=?,address=?,
                          credit_days=?,credit_amount=?,remark=?,level=? WHERE id=?`);
  const codeSeq = () => {
    const r = db.prepare("SELECT code FROM suppliers WHERE code LIKE 'S%' ORDER BY id DESC LIMIT 1").get();
    let n = 1;
    const m = /^S(\d+)$/.exec(r?.code || '');
    if (m) n = Number(m[1]) + 1;
    return 'S' + String(n).padStart(4, '0');
  };

  db.exec('BEGIN');
  try {
    for (let r = headIdx + 1; r < table.length; r++) {
      const row = table[r] || [];
      const name = pick(row, idx.name);
      if (!name) continue;                       // 空行跳过
      if (/^示例/.test(name) || /导入前请删除/.test(pick(row, idx.remark))) continue;
      if (seen.has(name)) { errors.push(`第${r + 1}行：${name} 在文件里重复，已跳过`); continue; }
      seen.add(name);

      const rec = {
        name,
        region: pick(row, idx.region), contact: pick(row, idx.contact),
        phone: pick(row, idx.phone), mobile: pick(row, idx.mobile), email: pick(row, idx.email),
        address: pick(row, idx.address), creditDays: num(pick(row, idx.creditDays)),
        creditAmount: num(pick(row, idx.creditAmount)), remark: pick(row, idx.remark),
        level: pick(row, idx.level)
      };

      const exist = findByName.get(name);
      if (exist) {
        if (dryRun) { updated++; continue; }
        upd.run(rec.name, rec.region, rec.contact, rec.phone, rec.mobile, rec.email, rec.address,
          rec.creditDays, rec.creditAmount, rec.remark, rec.level, exist.id);
        updated++;
      } else {
        let code = cleanCode(pick(row, idx.code));
        if (code && findByCode.get(code)) code = '';   // 编号被占用就重新生成
        if (!code) code = codeSeq();
        if (dryRun) { added++; continue; }
        ins.run(code, rec.name, rec.region, rec.contact, rec.phone, rec.mobile, rec.email, rec.address,
          rec.creditDays, rec.creditAmount, rec.remark, rec.level, now());
        added++;
      }
    }
    if (dryRun || errors.length) db.exec('ROLLBACK'); else db.exec('COMMIT');
    if (!dryRun && errors.length) { added = 0; updated = 0; }
  } catch (e) {
    db.exec('ROLLBACK');
    bad('导入失败，已全部回滚：' + e.message);
  }

  if (!dryRun) logAction(ctx, 'import', 'supplier', `导入供应商：新增 ${added}，更新 ${updated}`);
  return { added, updated, skipped: errors.length, errors: errors.slice(0, 20), dryRun: !!dryRun, aborted: errors.length > 0 };
});

/* ==================== 物料导入导出 ==================== */
const MATERIAL_HEAD = ['物料编号', '物料名称', '型号', '规格', '品牌', '整单位', '物料形态', '零单位', '换算比例', '整支宽度mm', '分切费', '料头阈值mm', '安全库存', '条码'];
const TYPE_OUT = { normal: '整进整出', master: '整进零出' };
const TYPE_IN = { '普通': 'normal', '不可分割': 'normal', '整进整出': 'normal', '可分割母卷': 'master', '母卷': 'master', '可分割': 'master', '整进零出': 'master' };
const MATERIAL_SUB_UNITS = new Set(['mm', '卷', '米', '个', '只', '套', '片', '支']);

route('GET', '/api/export/materials', async (ctx) => {
  ctx.need('material.view');
  const list = db.prepare("SELECT * FROM materials WHERE type IN ('normal','master') ORDER BY id").all();
  const rows = [MATERIAL_HEAD.map(h => ({ v: h, s: S.head }))];
  for (const m of list) {
    rows.push([
      { v: m.code, s: S.text }, { v: m.name, s: S.text }, { v: m.model_edited ? m.model || '' : m.spec || '', s: S.text },
      { v: m.model_edited ? m.spec || '' : '', s: S.text }, { v: m.brand || '', s: S.text }, { v: m.unit, s: S.text },
      { v: TYPE_OUT[m.type] || '整进整出', s: S.text }, { v: m.sub_unit || '', s: S.text },
      { v: m.sub_unit && m.sub_unit !== 'mm' ? Number(m.base_width) || '' : '', s: S.num },
      { v: m.sub_unit === 'mm' ? Number(m.base_width) || '' : '', s: S.num },
      { v: Number(m.cut_fee) || 0, s: S.num },
      { v: Number(m.min_waste) || '', s: S.int }, { v: Number(m.safety_stock) || 0, s: S.int },
      { v: m.barcode || '', s: S.text }
    ]);
  }
  const buf = buildXlsx([{ name: '物料', cols: [18, 32, 22, 22, 16, 10, 16, 10, 12, 14, 12, 14, 12, 22], rows }]);
  return sendXlsx(ctx, buf, `物料导出_${now().slice(0, 10)}.xlsx`);
});

route('GET', '/api/export/materials/template', async (ctx) => {
  ctx.need('material.create');
  const rows = [
    MATERIAL_HEAD.map(h => ({ v: h, s: S.head })),
    ['（可留空）', '示例：10kV冷缩中间接头', 'JLS-10/3.1', '10kV、3.1级', '3M', '套', '整进整出', '', '', '', 0, '', 0, ''].map((v, i) => ({ v, s: [8, 9, 10, 11, 12].includes(i) ? S.num : S.text })),
    ['（可留空）', '示例：电工胶带（整箱）', '1500', '300卷/箱', '德莎', '箱', '整进零出', '卷', 300, '', 0, '', 0, ''].map((v, i) => ({ v, s: [8, 9, 10, 11, 12].includes(i) ? S.num : S.text })),
    ['（可留空）', '示例：胶带母卷', '母卷', '宽度1200mm', '德莎', '支', '整进零出', 'mm', '', 1200, 0.5, 10, 0, ''].map((v, i) => ({ v, s: [8, 9, 10, 11, 12].includes(i) ? S.num : S.text }))
  ];
  const buf = buildXlsx([{ name: '物料导入模板', cols: [18, 32, 22, 22, 16, 10, 16, 10, 12, 14, 12, 14, 12, 22], rows }]);
  return sendXlsx(ctx, buf, '物料导入模板.xlsx');
});

route('POST', '/api/import/materials', async (ctx) => {
  ctx.need('material.create');
  const { filename = '', content = '', dryRun } = ctx.body || {};
  if (!content) bad('没有收到文件内容');
  const buf = Buffer.from(content, 'base64');
  if (buf.length > 15 * 1024 * 1024) bad('文件过大，请控制在 15MB 以内');

  let table;
  try { table = readTable(buf, filename); }
  catch (e) { bad('文件解析失败：' + e.message); }

  const headIdx = table.findIndex(r => r.some(c => String(c).includes('物料名称')));
  if (headIdx < 0) bad('没找到表头，请确认第一行包含「物料名称」等列名');
  const head = table[headIdx].map(c => String(c || '').trim());
  const col = (...names) => {
    for (const n of names) {
      const i = head.findIndex(h => h === n);
      if (i >= 0) return i;
    }
    for (const n of names) {
      const i = head.findIndex(h => h.includes(n));
      if (i >= 0) return i;
    }
    return -1;
  };
  const idx = {
    code: col('物料编号', '编号'), name: col('物料名称', '名称'), model: col('型号'), spec: col('规格'),
    brand: col('品牌'), unit: col('整单位', '计量单位', '单位'), type: col('物料形态', '类型'),
    subUnit: col('零单位', '拆分单位', '最小单位'), conversion: col('换算比例', '整单位换算'),
    baseWidth: col('整支宽度'), cutFee: col('分切费'), minWaste: col('料头阈值'),
    safety: col('安全库存'), barcode: col('条码')
  };
  if (idx.name < 0) bad('缺少「物料名称」列，无法导入');
  if (idx.unit < 0) bad('缺少「计量单位」列，无法导入');

  const pick = (row, i) => (i >= 0 && row[i] !== undefined ? String(row[i]).trim() : '');
  const num = v => { const n = Number(String(v).replace(/[,，\s]/g, '')); return Number.isFinite(n) ? n : 0; };
  /** 编号列填的是「（可留空）」这类提示语时，当作没填，交给系统生成 */
  const cleanCode = v => (/留空|自动编号|示例/.test(v) ? '' : v);

  let added = 0, updated = 0;
  const errors = [];
  const warnings = [];
  let skippedExamples = 0;
  const seen = new Set();

  const findByName = db.prepare('SELECT * FROM materials WHERE name=? AND type IN (?,?)');
  const findByCode = db.prepare('SELECT id FROM materials WHERE code=?');
  const ins = db.prepare(`INSERT INTO materials(code,name,model,model_edited,brand,spec,unit,type,sub_unit,barcode,base_width,min_waste,cut_fee,
                          parent_id,safety_stock,cost,batch_manage,created_by,status,created_at)
                          VALUES (?,?,?,1,?,?,?,?,?,?,?,?,?,NULL,?,0,0,?,1,?)`);
  const upd = db.prepare(`UPDATE materials SET name=?,model=?,model_edited=1,brand=?,spec=?,unit=?,type=?,sub_unit=?,barcode=?,
                          base_width=?,min_waste=?,cut_fee=?,safety_stock=? WHERE id=?`);

  db.exec('BEGIN');
  try {
    for (let r = headIdx + 1; r < table.length; r++) {
      const row = table[r] || [];
      const name = pick(row, idx.name);
      if (!name) continue;
      const importedCode = pick(row, idx.code);
      if (/^示例\s*[:：]/.test(name) || /示例行|导入前请删除/.test(name)) {
        skippedExamples++;
        warnings.push(`第${r + 1}行：物料名称带有示例标记，已跳过；请删除“示例：”前缀并填写实际物料后重新检查`);
        continue;
      }

      const typeText = pick(row, idx.type) || '普通';
      const type = TYPE_IN[typeText];
      if (!type) {
        errors.push(`第${r + 1}行：${name} 的物料形态「${typeText}」无法识别（请填 整进整出 / 整进零出）`);
        continue;
      }
      const unit = pick(row, idx.unit);
      if (!unit) { errors.push(`第${r + 1}行：${name} 缺少计量单位`); continue; }
      const subUnit = pick(row, idx.subUnit);
      const conversion = num(pick(row, idx.conversion));
      const baseWidth = subUnit === 'mm' ? num(pick(row, idx.baseWidth)) : conversion;
      if (type === 'master' && !subUnit) {
        errors.push(`第${r + 1}行：${name} 是整进零出物料，必须填零单位`);
        continue;
      }
      if (type === 'master' && !MATERIAL_SUB_UNITS.has(subUnit)) {
        errors.push(`第${r + 1}行：${name} 的零单位「${subUnit}」不受支持`);
        continue;
      }
      if (type === 'master' && subUnit === 'mm' && !(baseWidth > 0)) {
        errors.push(`第${r + 1}行：${name} 的零单位为 mm，必须填写整支宽度`);
        continue;
      }
      if (type === 'master' && subUnit !== 'mm' && !(baseWidth > 0)) {
        errors.push(`第${r + 1}行：${name} 必须填写换算比例`);
        continue;
      }
      if (seen.has(name)) { errors.push(`第${r + 1}行：${name} 在文件里重复，已跳过`); continue; }
      seen.add(name);

      const rec = {
        name,
        model: pick(row, idx.model) || (idx.model < 0 ? pick(row, idx.spec) : ''),
        spec: idx.model < 0 ? '' : pick(row, idx.spec),
        brand: pick(row, idx.brand), unit, type, subUnit: type === 'master' ? subUnit : '',
        barcode: pick(row, idx.barcode),
        baseWidth: type === 'master' ? baseWidth : null,
        minWaste: num(pick(row, idx.minWaste)) || 10,
        cutFee: num(pick(row, idx.cutFee)),
        safety: num(pick(row, idx.safety))
      };

      const exist = findByName.get(name, 'normal', 'master');
      if (exist) {
        if (dryRun) { updated++; continue; }
        upd.run(rec.name, rec.model, rec.brand, rec.spec, rec.unit, rec.type, rec.subUnit, rec.barcode,
          rec.baseWidth, rec.minWaste, rec.cutFee, rec.safety, exist.id);
        updated++;
      } else {
        let code = cleanCode(importedCode);
        if (code && findByCode.get(code)) code = '';
        if (!code) code = nextCode('materials', 'M');
        if (dryRun) { added++; continue; }
        ins.run(code, rec.name, rec.model, rec.brand, rec.spec, rec.unit, rec.type, rec.subUnit, rec.barcode,
          rec.baseWidth, rec.minWaste, rec.cutFee, rec.safety, ctx.user.userId, now());
        added++;
      }
    }
    if (dryRun || errors.length) db.exec('ROLLBACK'); else db.exec('COMMIT');
    if (!dryRun && errors.length) { added = 0; updated = 0; }
  } catch (e) {
    db.exec('ROLLBACK');
    bad('导入失败，已全部回滚：' + e.message);
  }

  if (!dryRun) logAction(ctx, 'import', 'material', `导入物料：新增 ${added}，更新 ${updated}`);
  return { added, updated, skipped: errors.length + skippedExamples, errors: errors.slice(0, 20), warnings: warnings.slice(0, 50), dryRun: !!dryRun, aborted: errors.length > 0 };
});
