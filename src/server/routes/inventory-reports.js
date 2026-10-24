'use strict';
const { route, bad, notFound, logAction } = require('../http-framework');
const { db, now, today } = require('../db');
const { round2, round3, round4 } = require('./docs');
const { totalStock, receivableMap, payableMap } = require('./base');

/* ==================== 库存查询 ==================== */
route('GET', '/api/inventory', async (ctx) => {
  ctx.need('inventory.view');
  const { keyword = '', type = '', warehouse_id = '', low = '' } = ctx.query;
  const showCost = ctx.can('cost.view');

  let sql = 'SELECT m.* FROM materials m WHERE m.status=1';
  const args = [];
  if (keyword) {
    sql += ' AND (m.name LIKE ? OR m.code LIKE ? OR m.spec LIKE ? OR m.brand LIKE ? OR m.barcode LIKE ?)';
    args.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
  }
  if (type) { sql += ' AND m.type=?'; args.push(type); }
  sql += ' ORDER BY m.id DESC';
  const mats = db.prepare(sql).all(...args);

  const wid = warehouse_id ? Number(warehouse_id) : null;
  const warehouses = db.prepare('SELECT id,name FROM warehouses WHERE status=1').all();
  const typeName = { normal: '普通', master: '母卷', sub: '子卷', waste: '料头', product: '成品' };

  let rows = mats.map(m => {
    if (m.type === 'master') {
      const rollSql = wid
        ? "SELECT * FROM rolls WHERE material_id=? AND warehouse_id=? AND status='open'"
        : "SELECT * FROM rolls WHERE material_id=? AND status='open'";
      const open = wid
        ? db.prepare(rollSql).all(m.id, wid)
        : db.prepare(rollSql).all(m.id);
      const wasteSql = wid
        ? "SELECT COUNT(*) n FROM rolls WHERE material_id=? AND warehouse_id=? AND status='waste'"
        : "SELECT COUNT(*) n FROM rolls WHERE material_id=? AND status='waste'";
      const waste = wid ? db.prepare(wasteSql).get(m.id, wid).n : db.prepare(wasteSql).get(m.id).n;
      const availableWidth = open.reduce((s, r) => s + (r.width_total - r.width_used), 0);
      const row = {
        material_id: m.id, code: m.code, name: m.name, brand: m.brand, spec: m.spec, unit: m.unit,
        type: m.type, typeName: typeName[m.type], warehouse_id: wid || null,
        warehouse_name: wid ? (warehouses.find(w => w.id === wid)?.name || '') : '全部仓库',
        qty: open.length, available_width: round3(availableWidth),
        roll_count: open.length, waste_count: waste,
        safety_stock: m.safety_stock, base_width: m.base_width, min_waste: m.min_waste,
        cost: m.cost, amount: round2(open.reduce((s, r) => s + r.cost, 0))
      };
      if (!showCost) { delete row.cost; delete row.amount; }
      return row;
    }
    const stockRows = wid
      ? db.prepare('SELECT qty FROM inventory WHERE material_id=? AND warehouse_id=?').all(m.id, wid)
      : db.prepare('SELECT qty FROM inventory WHERE material_id=?').all(m.id);
    const qty = stockRows.reduce((s, r) => s + r.qty, 0);
    const row = {
      material_id: m.id, code: m.code, name: m.name, brand: m.brand, spec: m.spec, unit: m.unit,
      type: m.type, typeName: typeName[m.type], warehouse_id: wid || null,
      warehouse_name: wid ? (warehouses.find(w => w.id === wid)?.name || '') : '全部仓库',
      qty: round3(qty), available_width: null, roll_count: 0, waste_count: 0,
      safety_stock: m.safety_stock, cost: m.cost, amount: round2(qty * (m.cost || 0))
    };
    if (!showCost) { delete row.cost; delete row.amount; }
    return row;
  });

  if (low === '1') rows = rows.filter(r => r.qty < (r.safety_stock || 0));

  const totalQty = rows.reduce((s, r) => s + (r.qty || 0), 0);
  const totalAmount = showCost ? round2(rows.reduce((s, r) => s + (r.amount || 0), 0)) : null;
  const lowCount = rows.filter(r => (r.qty || 0) < (r.safety_stock || 0)).length;

  return {
    list: rows, warehouses, typeName,
    stats: {
      kindCount: rows.length,
      lowCount,
      totalAmount: totalAmount,
      zeroCount: rows.filter(r => (r.qty || 0) <= 0).length
    }
  };
});

/* ---------- 单物料库存流水 ---------- */
route('GET', '/api/inventory/logs', async (ctx) => {
  ctx.need('inventory.log');
  const { material_id = '', from = '', to = '', warehouse_id = '' } = ctx.query;
  let sql = `SELECT l.*, m.name AS material_name, m.code AS material_code, m.unit
             FROM inventory_logs l LEFT JOIN materials m ON m.id=l.material_id WHERE 1=1`;
  const args = [];
  if (material_id) { sql += ' AND l.material_id=?'; args.push(Number(material_id)); }
  if (warehouse_id) { sql += ' AND l.warehouse_id=?'; args.push(Number(warehouse_id)); }
  if (from) { sql += ' AND l.created_at >= ?'; args.push(from + ' 00:00:00'); }
  if (to) { sql += ' AND l.created_at <= ?'; args.push(to + ' 23:59:59'); }
  sql += ' ORDER BY l.id DESC LIMIT 1000';
  const rows = db.prepare(sql).all(...args);
  const showCost = ctx.can('cost.view');
  const list = rows.map(r => {
    const o = { ...r };
    if (!showCost) { delete o.cost; delete o.amount; }
    return o;
  });
  return { list };
});

/* ---------- 母卷明细（每支的剩余宽度） ---------- */
route('GET', '/api/inventory/rolls', async (ctx) => {
  ctx.need('inventory.view');
  const { material_id = '' } = ctx.query;
  if (!material_id) bad('请指定物料');
  const rows = db.prepare(`SELECT r.*, m.name AS material_name, w.name AS warehouse_name
                           FROM rolls r LEFT JOIN materials m ON m.id=r.material_id
                           LEFT JOIN warehouses w ON w.id=r.warehouse_id
                           WHERE r.material_id=? ORDER BY r.id`).all(Number(material_id));
  const showCost = ctx.can('cost.view');
  return {
    list: rows.map(r => {
      const o = { ...r, remain_width: round3(r.width_total - r.width_used) };
      if (!showCost) delete o.cost;
      return o;
    })
  };
});

/* ==================== 报表：待结转库存清单（利润表） ==================== */
route('GET', '/api/reports/carryover', async (ctx) => {
  ctx.need('report.carryover');
  const { from = '', to = '', customer_id = '', salesperson_id = '', invoice_status = '' } = ctx.query;
  let sql = `SELECT d.id, d.sn, d.doc_date, d.contract_sn, d.total_amount, d.total_cost,
                    d.invoice_status, d.paid_amount, d.pay_status,
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
  const rows = db.prepare(sql).all(...args);

  const list = rows.map(r => {
    const profit = round2((r.total_amount || 0) - (r.total_cost || 0));
    const rate = r.total_amount > 0 ? round4(profit / r.total_amount) : 0;
    return {
      ...r,
      profit, margin: (rate * 100).toFixed(2) + '%',
      invoice_text: r.invoice_status === 0 ? '否' : '是'
    };
  });

  const sum = list.reduce((a, r) => ({
    amount: a.amount + (r.total_amount || 0),
    cost: a.cost + (r.total_cost || 0),
    profit: a.profit + r.profit
  }), { amount: 0, cost: 0, profit: 0 });

  return {
    list,
    summary: {
      amount: round2(sum.amount),
      cost: round2(sum.cost),
      profit: round2(sum.profit),
      margin: sum.amount > 0 ? ((sum.profit / sum.amount) * 100).toFixed(2) + '%' : '0.00%'
    }
  };
});

/* ==================== 报表：进销存汇总 ==================== */
route('GET', '/api/reports/summary', async (ctx) => {
  ctx.need('report.summary');
  const { from = '', to = '', warehouse_id = '' } = ctx.query;
  const start = from || today().slice(0, 8) + '01';
  const end = to || today();

  const mats = db.prepare('SELECT * FROM materials WHERE status=1').all();
  const list = mats.map(m => {
    const inv = (wid) => {
      let sql = `SELECT COALESCE(SUM(qty_change),0) s FROM inventory_logs
                 WHERE material_id=? AND created_at < ? AND doc_type != 'VOID'`;
      const args = [m.id, start + ' 00:00:00'];
      if (warehouse_id) { sql += ' AND warehouse_id=?'; args.push(Number(warehouse_id)); }
      return db.prepare(sql).get(...args).s;
    };
    // 母卷用支数近似：用 rolls 表当前状态推算
    let opening = inv();
    if (m.type === 'master') {
      let sql = `SELECT COUNT(*) n FROM rolls WHERE material_id=? AND created_at < ?`;
      const args = [m.id, start + ' 00:00:00'];
      if (warehouse_id) { sql += ' AND warehouse_id=?'; args.push(Number(warehouse_id)); }
      opening = db.prepare(sql).get(...args).n;
    }

    const mover = (types, sign) => {
      let sql = `SELECT COALESCE(SUM(qty_change),0) s FROM inventory_logs
                 WHERE material_id=? AND created_at >= ? AND created_at <= ? AND doc_type IN (${types.map(() => '?').join(',')})`;
      const args = [m.id, start + ' 00:00:00', end + ' 23:59:59', ...types];
      if (warehouse_id) { sql += ' AND warehouse_id=?'; args.push(Number(warehouse_id)); }
      return db.prepare(sql).get(...args).s;
    };

    const inQty = Math.abs(mover(['IN', 'SRET'], 1));
    const outQty = Math.abs(mover(['OUT', 'PRET'], -1));
    const closing = m.type === 'master'
      ? db.prepare("SELECT COUNT(*) n FROM rolls WHERE material_id=? AND status='open'").get(m.id).n
      : opening + inQty - outQty;

    return {
      code: m.code, name: m.name, spec: m.spec, unit: m.unit,
      opening: round3(opening), in_qty: round3(inQty), out_qty: round3(outQty), closing: round3(closing),
      opening_amount: round2(opening * (m.cost || 0)),
      closing_amount: round2(closing * (m.cost || 0))
    };
  }).filter(r => r.opening || r.in_qty || r.out_qty || r.closing);

  return { list, period: { from: start, to: end } };
});

/* ==================== 报表：利润统计 ==================== */
route('GET', '/api/reports/profit', async (ctx) => {
  ctx.need('report.profit');
  const { from = '', to = '', by = 'customer' } = ctx.query;
  let sql = `SELECT d.id, d.total_amount, d.total_cost, d.partner_id, d.salesperson_id
             FROM docs d WHERE d.type='OUT' AND d.status='approved'`;
  const args = [];
  if (from) { sql += ' AND d.doc_date >= ?'; args.push(from); }
  if (to) { sql += ' AND d.doc_date <= ?'; args.push(to); }
  const docs = db.prepare(sql).all(...args);

  const map = new Map();
  for (const d of docs) {
    let key, name;
    if (by === 'salesperson') {
      key = d.salesperson_id;
      name = key ? (db.prepare('SELECT name FROM users WHERE id=?').get(key)?.name || '未指定') : '未指定';
    } else if (by === 'material') {
      // 按商品统计需要读明细
      const items = db.prepare(`SELECT i.*, m.name AS mn FROM doc_items i LEFT JOIN materials m ON m.id=i.material_id WHERE i.doc_id=?`).all(d.id);
      for (const it of items) {
        const k = it.material_id;
        const cur = map.get(k) || { name: it.mn, amount: 0, cost: 0, count: new Set() };
        cur.amount += it.amount || 0;
        cur.cost += it.cost_amount || 0;
        cur.count.add(d.id);
        map.set(k, cur);
      }
      continue;
    } else {
      key = d.partner_id;
      name = key ? (db.prepare('SELECT name FROM customers WHERE id=?').get(key)?.name || '未指定') : '未指定';
    }
    const cur = map.get(key) || { name, amount: 0, cost: 0, count: new Set() };
    cur.amount += d.total_amount || 0;
    cur.cost += d.total_cost || 0;
    cur.count.add(d.id);
    map.set(key, cur);
  }

  const list = [...map.values()].map(v => {
    const profit = v.amount - v.cost;
    return {
      name: v.name,
      amount: round2(v.amount),
      cost: round2(v.cost),
      profit: round2(profit),
      margin: v.amount > 0 ? ((profit / v.amount) * 100).toFixed(2) + '%' : '0.00%',
      order_count: v.count.size
    };
  }).sort((a, b) => b.amount - a.amount);

  return { list, by };
});

/* ==================== 应收 / 应付 ==================== */
route('GET', '/api/reports/receivable', async (ctx) => {
  ctx.need('ar.view');
  const arMap = receivableMap();
  const list = [];
  for (const [cid, balance] of arMap) {
    if (Math.abs(balance) < 0.01) continue;
    const c = db.prepare('SELECT * FROM customers WHERE id=?').get(cid);
    if (!c) continue;
    const last = db.prepare(`SELECT MAX(doc_date) d FROM docs WHERE partner_id=? AND type='OUT' AND status='approved'`).get(cid);
    list.push({
      customer_id: cid, name: c.name, contact: c.contact, phone: c.phone,
      balance: round2(balance), last_date: last?.d || ''
    });
  }
  list.sort((a, b) => b.balance - a.balance);
  return { list, total: round2(list.reduce((s, r) => s + r.balance, 0)) };
});

route('GET', '/api/reports/payable', async (ctx) => {
  ctx.need('ap.view');
  const apMap = payableMap();
  const list = [];
  for (const [sid, balance] of apMap) {
    if (Math.abs(balance) < 0.01) continue;
    const s = db.prepare('SELECT * FROM suppliers WHERE id=?').get(sid);
    if (!s) continue;
    const last = db.prepare(`SELECT MAX(doc_date) d FROM docs WHERE partner_id=? AND type='IN' AND status='approved'`).get(sid);
    list.push({
      supplier_id: sid, name: s.name, contact: s.contact, phone: s.phone,
      balance: round2(balance), last_date: last?.d || ''
    });
  }
  list.sort((a, b) => b.balance - a.balance);
  return { list, total: round2(list.reduce((s, r) => s + r.balance, 0)) };
});

/* ==================== 收付款流水 ==================== */
route('GET', '/api/payments', async (ctx) => {
  const type = ctx.query.type === 'pay' ? 'pay' : 'receive';
  ctx.need(type === 'pay' ? 'payment.pay' : 'payment.receive');
  const rows = db.prepare(`SELECT p.*, u.name AS operator FROM payments p
                           LEFT JOIN users u ON u.id=p.created_by
                           WHERE p.type=? ORDER BY p.id DESC LIMIT 500`).all(type);
  const list = rows.map(r => {
    const partnerName = type === 'receive'
      ? db.prepare('SELECT name FROM customers WHERE id=?').get(r.partner_id)?.name
      : db.prepare('SELECT name FROM suppliers WHERE id=?').get(r.partner_id)?.name;
    return { ...r, partner_name: partnerName || '' };
  });
  return { list };
});

/* ==================== 操作日志 ==================== */
route('GET', '/api/logs', async (ctx) => {
  ctx.need('log.view');
  const { keyword = '', from = '', to = '', limit = 200 } = ctx.query;
  let sql = 'SELECT * FROM operation_logs WHERE 1=1';
  const args = [];
  if (keyword) { sql += ' AND (username LIKE ? OR action LIKE ? OR module LIKE ? OR detail LIKE ?)'; args.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`); }
  if (from) { sql += ' AND created_at >= ?'; args.push(from + ' 00:00:00'); }
  if (to) { sql += ' AND created_at <= ?'; args.push(to + ' 23:59:59'); }
  sql += ' ORDER BY id DESC LIMIT ?';
  args.push(Math.min(Number(limit) || 200, 1000));
  return { list: db.prepare(sql).all(...args) };
});

/* ==================== 经营趋势（按月销售额与毛利） ==================== */
route('GET', '/api/reports/trend', async (ctx) => {
  ctx.need('report.profit');
  const thisYear = Number(ctx.query.year) || Number(today().slice(0, 4));
  const cmpYear = Number(ctx.query.compare_year) || (thisYear - 1);

  /** 取某年 12 个月的销售额与成本 */
  function yearMonths(y) {
    const rows = db.prepare(`
      SELECT substr(doc_date,1,7) ym,
             COALESCE(SUM(total_amount),0) amount,
             COALESCE(SUM(total_cost),0) cost,
             COUNT(*) cnt
      FROM docs
      WHERE type='OUT' AND status='approved' AND substr(doc_date,1,4)=?
      GROUP BY ym`).all(String(y));
    const map = new Map(rows.map(r => [r.ym, r]));
    return Array.from({ length: 12 }, (_, i) => {
      const ym = `${y}-${String(i + 1).padStart(2, '0')}`;
      const r = map.get(ym) || { amount: 0, cost: 0, cnt: 0 };
      const amount = round2(r.amount);
      const cost = round2(r.cost);
      return {
        month: i + 1, ym, amount, cost,
        profit: round2(amount - cost),
        margin: amount > 0 ? round4((amount - cost) / amount) : 0,
        count: r.cnt
      };
    });
  }

  const cur = yearMonths(thisYear);
  const prev = yearMonths(cmpYear);

  const sumOf = arr => arr.reduce((a, m) => ({
    amount: round2(a.amount + m.amount),
    cost: round2(a.cost + m.cost),
    profit: round2(a.profit + m.profit),
    count: a.count + m.count
  }), { amount: 0, cost: 0, profit: 0, count: 0 });

  const curTotal = sumOf(cur);
  const prevTotal = sumOf(prev);

  const nowMonth = Number(today().slice(5, 7));
  const isCurrentYear = thisYear === Number(today().slice(0, 4));
  const thisMonth = cur[nowMonth - 1] || { amount: 0, profit: 0 };
  const sameMonthLastYear = prev[nowMonth - 1] || { amount: 0, profit: 0 };

  // 年初至今对比（只比到当前月，避免拿整年比半年）
  const ytdCur = sumOf(isCurrentYear ? cur.slice(0, nowMonth) : cur);
  const ytdPrev = sumOf(isCurrentYear ? prev.slice(0, nowMonth) : prev);

  const growth = (a, b) => b > 0 ? round4((a - b) / b) : (a > 0 ? 1 : 0);

  return {
    year: thisYear, compareYear: cmpYear, currentMonth: nowMonth,
    months: cur, compareMonths: prev,
    total: curTotal, compareTotal: prevTotal,
    thisMonth: {
      ym: thisMonth.ym, amount: thisMonth.amount, profit: thisMonth.profit,
      lastYearAmount: sameMonthLastYear.amount,
      lastYearProfit: sameMonthLastYear.profit,
      amountGrowth: growth(thisMonth.amount, sameMonthLastYear.amount),
      profitGrowth: growth(thisMonth.profit, sameMonthLastYear.profit)
    },
    ytd: {
      amount: ytdCur.amount, profit: ytdCur.profit,
      lastYearAmount: ytdPrev.amount, lastYearProfit: ytdPrev.profit,
      amountGrowth: growth(ytdCur.amount, ytdPrev.amount),
      profitGrowth: growth(ytdCur.profit, ytdPrev.profit)
    },
    availableYears: db.prepare(`SELECT DISTINCT substr(doc_date,1,4) y FROM docs
                                WHERE type='OUT' AND status='approved' ORDER BY y DESC`)
      .all().map(r => Number(r.y))
  };
});

/* ==================== 系统设置 ==================== */
route('GET', '/api/settings', async (ctx) => {
  const rows = db.prepare('SELECT * FROM settings').all();
  const obj = {};
  for (const r of rows) obj[r.key] = r.value;
  return { settings: obj };
});

route('PUT', '/api/settings', async (ctx) => {
  ctx.need('setting.manage');
  const up = db.prepare(`INSERT INTO settings(key,value) VALUES (?,?)
                         ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
  for (const [k, v] of Object.entries(ctx.body || {})) up.run(k, String(v));
  logAction(ctx, 'update', 'setting', '修改系统设置');
  return {};
});

/* ==================== 数据备份 ==================== */
route('GET', '/api/backup/download', async (ctx) => {
  ctx.need('backup.manage');
  const fs = require('node:fs');
  const { DB_FILE } = require('../db');
  if (!fs.existsSync(DB_FILE)) bad('数据库文件不存在');
  const buf = fs.readFileSync(DB_FILE);
  const name = `wanlou-backup-${today()}.db`;
  ctx.res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${name}"`,
    'Content-Length': buf.length
  });
  ctx.res.end(buf);
  logAction(ctx, 'backup', 'system', '下载数据备份');
  return null;
});

module.exports = {};
