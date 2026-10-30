'use strict';
/**
 * 生成经营分析用的演示数据（2025-01 至今，每月约 50 张出库单）
 *
 * 所有生成的数据都带标记，便于整体清除：
 *   - 客户/供应商/物料：编号以 DM 开头，名称以「演示-」开头
 *   - 单据：备注以「演示数据」开头
 *   - 收付款：备注以「演示数据」开头
 * 清除用同目录的 clean-demo.js。
 *
 * 用法（服务要先跑起来）：
 *   node scripts/seed-demo.js           # 只打印计划，不写库
 *   node scripts/seed-demo.js --yes     # 真正写库
 *   TEST_BASE=http://127.0.0.1:3001 node scripts/seed-demo.js --yes
 */
const BASE = process.env.TEST_BASE || 'http://127.0.0.1:3000';
const MARK = '演示数据';
const PER_MONTH = Number(process.env.PER_MONTH) || 50;
const FROM = process.env.FROM || '2025-01';
const TO = process.env.TO || '2026-10';
const WRITE = process.argv.includes('--yes');

let token = '';
let failed = 0;
const failures = [];

/* ---------------- 基础工具 ---------------- */
let seed = 20261030;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = arr => arr[Math.floor(rnd() * arr.length)];
const money = n => Math.round(n * 100) / 100;
const pad = (n, w = 2) => String(n).padStart(w, '0');

async function api(path, method = 'GET', body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.message || '请求失败');
  return json.data;
}

/* ---------------- 物料定义 ---------------- */
// kind: normal 普通 | mm 胶带母卷（按 mm 分切）| pack 整进零出（箱装卷 / 卷装米）
const MATERIALS = [
  { key: 'm01', kind: 'normal', name: '10kV三芯冷缩户内终端', model: 'NLS-15/3.2', unit: '套', cost: 620, price: 880 },
  { key: 'm02', kind: 'normal', name: '10kV三芯冷缩户外终端', model: 'WLS-15/3.2', unit: '套', cost: 780, price: 1080 },
  { key: 'm03', kind: 'normal', name: '10kV中间接头', model: 'JLS-15/3.2', unit: '套', cost: 950, price: 1320 },
  { key: 'm04', kind: 'normal', name: '1kV四芯热缩终端', model: 'RSY-1/4.2', unit: '套', cost: 45, price: 68 },
  { key: 'm05', kind: 'normal', name: '铜接线端子', model: 'DT-70', unit: '个', cost: 6.5, price: 9.8 },
  { key: 'm06', kind: 'normal', name: '铜铝过渡端子', model: 'DTL-120', unit: '个', cost: 12, price: 17.5 },
  { key: 'm07', kind: 'normal', name: '绝缘穿刺线夹', model: 'JJC-1', unit: '个', cost: 28, price: 39 },
  { key: 'm08', kind: 'normal', name: '不锈钢扎带', model: '4.6×300', unit: '盒', cost: 22, price: 32 },
  { key: 'm09', kind: 'normal', name: '电缆标识牌', model: 'PVC-100', unit: '包', cost: 18, price: 26 },
  { key: 'm10', kind: 'normal', name: '防火泥', model: 'DR-A3', unit: '箱', cost: 85, price: 128 },
  { key: 'm11', kind: 'mm', name: '3M 1500电工胶带母卷', model: '1500-1200', unit: '支', base_width: 1200, cost: 320, price: 520, cutWidths: [24, 36, 48, 60, 100, 150] },
  { key: 'm12', kind: 'mm', name: '3M 33+防腐胶带母卷', model: '33P-1200', unit: '支', base_width: 1200, cost: 420, price: 640, cutWidths: [50, 100, 150, 200] },
  { key: 'm13', kind: 'pack', name: '3M 1500电工胶带', model: '18mm×10m', unit: '箱', sub_unit: '卷', base_width: 300, cost: 1.6, price: 2.7 },
  { key: 'm14', kind: 'pack', name: '3M 超级33+胶带', model: '19mm×20m', unit: '箱', sub_unit: '卷', base_width: 200, cost: 6.2, price: 9.8 },
  { key: 'm15', kind: 'pack', name: '接地线 25mm²', model: 'JDX-25', unit: '卷', sub_unit: '米', base_width: 100, cost: 3.2, price: 5.4 },
  { key: 'm16', kind: 'pack', name: '接地线 35mm²', model: 'JDX-35', unit: '卷', sub_unit: '米', base_width: 100, cost: 4.6, price: 7.4 },
  { key: 'm17', kind: 'pack', name: '铜编织带 16mm²', model: 'TZ-16', unit: '卷', sub_unit: '米', base_width: 50, cost: 5.1, price: 8.2 },
  { key: 'm18', kind: 'normal', name: '电缆保护管', model: 'MPP-110', unit: '根', cost: 38, price: 55 }
];

const CUSTOMERS = [
  '郑州中原电力工程', '河南恒通机电安装', '郑州华辰电气', '河南建工电力', '郑州新区市政',
  '河南众力电气', '郑州金水配电工程', '河南远大机电', '郑州铁路供电段', '河南恒信通信',
  '郑州航空港建设', '河南中州电气', '郑州二七市政工程', '河南联合电力', '郑州高新区管网',
  '河南宏远安装', '郑州郑东新区配电', '河南天元电气', '郑州管城机电', '河南正大电力',
  '郑州惠济供电所', '河南鑫源电气', '郑州经开市政', '河南博通电力'
];

const SUPPLIERS = [
  '3M中国有限公司河南代理', '河南电工器材批发', '郑州电缆附件供应商', '江苏亨通线缆',
  '浙江万马电缆', '河南胶带贸易', '上海起帆电缆', '河北华通线缆'
];

const PAY_METHODS = ['银行转账', '现金', '承兑汇票', '微信'];

/* ---------------- 单据辅助 ---------------- */
function monthsBetween(from, to) {
  const out = [];
  let [y, m] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${pad(m)}`);
    m += 1; if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

function daysInMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

/** 当月内挑一个工作日（避开周末），不超过今天 */
function pickDate(ym, todayStr) {
  const dim = daysInMonth(ym);
  for (let i = 0; i < 20; i++) {
    const d = ri(1, dim);
    const ds = `${ym}-${pad(d)}`;
    if (ds > todayStr) continue;
    const w = new Date(`${ds}T00:00:00`).getDay();
    if (w === 0 || w === 6) continue;
    return ds;
  }
  const d = Math.min(ri(1, dim), Number(todayStr.slice(8)));
  return `${ym}-${pad(d)}`;
}

/* ---------------- 主流程 ---------------- */
(async () => {
  console.log('\n========== 演示数据生成 ==========');
  console.log(`  服务：${BASE}`);
  console.log(`  区间：${FROM} ~ ${TO}，每月 ${PER_MONTH} 张出库单`);
  console.log(`  模式：${WRITE ? '写入数据库' : '仅预览（加 --yes 才写入）'}\n`);

  // 登录要带图形验证码，交给 test/login-helper 自动识别
  const { loginToken } = require(require('node:path').join(__dirname, '..', 'test', 'login-helper'));
  token = await loginToken(BASE, 'admin', 'admin123');
  console.log('  ✓ 已登录');

  const todayStr = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);

  // 已有演示数据就退出，避免重复灌入
  const exist = await api('/api/materials?all=1&keyword=' + encodeURIComponent('演示-'));
  const existList = exist.list || exist;
  if (existList.length > 0) {
    console.log(`\n  已存在 ${existList.length} 个演示物料，先跑 clean-demo.js 再灌。已退出。`);
    process.exit(1);
  }

  /* ---------- 1. 仓库 ---------- */
  const whs = await api('/api/warehouses?all=1');
  const wh = (whs.list || whs).find(w => w.name === '郑州仓') || (whs.list || whs)[0];
  if (!wh) throw new Error('没有可用仓库');
  console.log(`  ✓ 仓库：${wh.name}（id=${wh.id}）`);

  /* ---------- 2. 业务员 ---------- */
  const users = await api('/api/users?all=1');
  const userList = users.list || users;
  const salesmen = userList.filter(u => u.employee_no && u.status === 1
    && u.username !== 'admin' && !/测试|筛选/.test(u.name));
  if (!salesmen.length) throw new Error('没有带工号的员工，出库单无法生成单号');
  console.log(`  ✓ 业务员 ${salesmen.length} 人：${salesmen.map(u => u.name).join('、')}`);

  /* ---------- 3. 客户 / 供应商 ---------- */
  const custIds = [];
  for (let i = 0; i < CUSTOMERS.length; i++) {
    const name = `演示-${CUSTOMERS[i]}`;
    const sp = salesmen[i % salesmen.length];
    if (WRITE) {
      const r = await api('/api/customers', 'POST', {
        name, code: `DMC${pad(i + 1, 3)}`, contact: '联系人' + (i + 1),
        phone: '138' + String(10000000 + i * 137).slice(0, 8),
        address: '郑州市' + pick(['金水区', '中原区', '二七区', '高新区', '郑东新区']),
        salesperson_id: sp.id, level: pick(['A', 'B', 'B', 'C']), remark: MARK
      });
      custIds.push({ id: r.id, sp: sp.id, name });
    } else {
      custIds.push({ id: -(i + 1), sp: sp.id, name });
    }
  }
  console.log(`  ✓ 客户 ${custIds.length} 家`);

  const supIds = [];
  for (let i = 0; i < SUPPLIERS.length; i++) {
    const name = `演示-${SUPPLIERS[i]}`;
    if (WRITE) {
      const r = await api('/api/suppliers', 'POST', {
        name, code: `DMS${pad(i + 1, 3)}`, contact: '供应' + (i + 1),
        phone: '139' + String(20000000 + i * 311).slice(0, 8), remark: MARK
      });
      supIds.push({ id: r.id, name });
    } else {
      supIds.push({ id: -(i + 1), name });
    }
  }
  console.log(`  ✓ 供应商 ${supIds.length} 家`);

  /* ---------- 4. 物料 ---------- */
  const mats = [];
  for (let i = 0; i < MATERIALS.length; i++) {
    const m = MATERIALS[i];
    const body = {
      name: `演示-${m.name}`, model: m.model, unit: m.unit, code: `DMM${pad(i + 1, 3)}`,
      type: m.kind === 'normal' ? 'normal' : 'master',
      sub_unit: m.kind === 'mm' ? 'mm' : (m.kind === 'pack' ? m.sub_unit : ''),
      base_width: m.kind === 'normal' ? null : m.base_width,
      spec: m.model, remark: MARK
    };
    let id;
    if (WRITE) {
      const r = await api('/api/materials', 'POST', body);
      id = r.id;
    } else {
      id = -(i + 1);
    }
    mats.push({ ...m, id });
  }
  console.log(`  ✓ 物料 ${mats.length} 种（普通 ${mats.filter(m => m.kind === 'normal').length}、母卷 ${mats.filter(m => m.kind === 'mm').length}、整进零出 ${mats.filter(m => m.kind === 'pack').length}）`);

  /* ---------- 5. 排计划 ---------- */
  const months = monthsBetween(FROM, TO);
  const plan = [];          // {date, cust, items:[{mat, qty, price, cut_width}]}
  const needByQ = new Map(); // '2025Q1|matId' -> qty（零单位/支数）

  const qKey = (date, mid) => {
    const [y, m] = date.split('-').map(Number);
    return `${y}Q${Math.ceil(m / 3)}|${mid}`;
  };
  const addNeed = (date, mid, qty) => {
    const k = qKey(date, mid);
    needByQ.set(k, (needByQ.get(k) || 0) + qty);
  };

  for (const ym of months) {
    const count = PER_MONTH;
    for (let n = 0; n < count; n++) {
      const date = pickDate(ym, todayStr);
      const cust = pick(custIds);
      const lines = ri(1, 3);
      const items = [];
      const used = new Set();
      for (let l = 0; l < lines; l++) {
        const m = pick(mats);
        if (used.has(m.id)) continue;
        used.add(m.id);
        if (m.kind === 'normal') {
          const qty = m.unit === '个' ? ri(20, 200) : ri(1, 15);
          items.push({ mat: m, qty, price: money(m.price * (0.92 + rnd() * 0.22)) });
          addNeed(date, m.id, qty);
        } else if (m.kind === 'mm') {
          if (rnd() < 0.22) {
            const qty = ri(1, 3); // 整支出库
            items.push({ mat: m, qty, price: money(m.price * (0.95 + rnd() * 0.15)) });
            addNeed(date, m.id, qty);
          } else {
            const w = pick(m.cutWidths);
            const qty = ri(2, 8);
            const perRoll = m.price * (w / m.base_width) * 2.4;
            items.push({ mat: m, qty, price: money(perRoll * (0.9 + rnd() * 0.25)), cut_width: w });
            addNeed(date, m.id, qty);
          }
        } else {
          // 整进零出：按零单位出
          const per = m.base_width;
          let qty;
          if (m.sub_unit === '米') qty = money(ri(10, 40) * 5 / 5 * (0.5 + rnd())); // 10~40 米，带小数
          else qty = ri(5, Math.min(per, 120));
          qty = m.sub_unit === '米' ? Math.round(qty * 10) / 10 : Math.round(qty);
          items.push({ mat: m, qty, price: money(m.price * (0.93 + rnd() * 0.2)) });
          addNeed(date, m.id, qty);
        }
      }
      if (!items.length) continue;
      plan.push({ date, cust, items });
    }
  }
  plan.sort((a, b) => a.date < b.date ? -1 : 1);
  console.log(`  ✓ 出库计划 ${plan.length} 张（${months[0]} ~ ${months[months.length - 1]}）`);

  /* ---------- 6. 按季度入库备货 ---------- */
  const inPlan = [];
  const quarters = [...new Set([...needByQ.keys()].map(k => k.split('|')[0]))].sort();
  for (const q of quarters) {
    const [y, qn] = q.split('Q').map(Number);
    const startMonth = (qn - 1) * 3 + 1;
    // 季度首月前 5 天入库，保证当月出库前有货
    const inDate = `${y}-${pad(startMonth)}-0${ri(2, 5)}`;
    const items = [];
    for (const m of mats) {
      const need = needByQ.get(`${q}|${m.id}`) || 0;
      if (need <= 0) continue;
      const buffer = 1.18;
      if (m.kind === 'mm') {
        items.push({ mat: m, qty: Math.ceil(need * buffer), price: money(m.cost * (0.96 + rnd() * 0.1)) });
      } else if (m.kind === 'pack') {
        const packs = Math.max(1, Math.ceil(need * buffer / m.base_width));
        items.push({ mat: m, packs, price: money(m.cost * m.base_width * (0.96 + rnd() * 0.1)) });
      } else {
        items.push({ mat: m, qty: Math.max(1, Math.ceil(need * buffer)), price: money(m.cost * (0.96 + rnd() * 0.1)) });
      }
    }
    // 一张入库单最多 8 行，拆开
    for (let i = 0; i < items.length; i += 8) {
      inPlan.push({ date: inDate, supplier: supIds[Math.floor(i / 8) % supIds.length], items: items.slice(i, i + 8) });
    }
  }
  console.log(`  ✓ 入库计划 ${inPlan.length} 张（按季度备货）\n`);

  if (!WRITE) {
    console.log('  预览结束，未写入。确认无误后加 --yes 执行。');
    process.exit(0);
  }

  /* ---------- 7. 写单据 ---------- */
  async function saveDoc(type, body) {
    const created = await api('/api/docs', 'POST', { type, ...body });
    await api(`/api/docs/${created.id}/submit`, 'POST', {});
    await api(`/api/docs/${created.id}/approve`, 'POST', {});
    return created.id;
  }

  let done = 0;
  const total = inPlan.length + plan.length;
  const t0 = Date.now();

  // 入库
  for (const d of inPlan) {
    try {
      const items = d.items.map(it => it.mat.kind === 'pack'
        ? { material_id: it.mat.id, qty_whole: it.packs, qty_sub: 0, price: it.price, price_basis: 'pack' }
        : { material_id: it.mat.id, qty: it.qty, price: it.price });
      await saveDoc('IN', {
        doc_date: d.date, partner_id: d.supplier.id, warehouse_id: wh.id,
        items, remark: `${MARK}-入库`, invoice_status: pick([0, 1])
      });
    } catch (e) {
      failed++; failures.push(`入库 ${d.date}: ${e.message}`);
    }
    done++;
    if (done % 20 === 0) process.stdout.write(`\r  写入中 ${done}/${total}（失败 ${failed}）   `);
  }

  // 出库
  const approvedOut = [];
  for (const d of plan) {
    try {
      const items = d.items.map(it => ({
        material_id: it.mat.id, qty: it.qty, price: it.price,
        ...(it.cut_width ? { cut_width: it.cut_width } : {})
      }));
      const id = await saveDoc('OUT', {
        doc_date: d.date, partner_id: d.cust.id, warehouse_id: wh.id,
        salesperson_id: d.cust.sp,
        items, remark: `${MARK}-出库`,
        invoice_status: pick([0, 0, 1, 2]),
        carrier: pick(['顺丰物流', '德邦物流', '自提', '郑州同城配送']),
        receiver: pick(['王工', '李经理', '赵师傅', '刘主管']),
        receiver_phone: '136' + String(30000000 + ri(0, 9999999)).slice(0, 8),
        receiver_addr: '郑州市' + pick(['金水区', '中原区', '二七区', '高新区'])
      });
      approvedOut.push({ id, date: d.date, cust: d.cust, items: d.items });
    } catch (e) {
      failed++; failures.push(`出库 ${d.date}: ${e.message}`);
    }
    done++;
    if (done % 20 === 0) process.stdout.write(`\r  写入中 ${done}/${total}（失败 ${failed}）   `);
  }
  console.log(`\r  单据写入完成：${done} 张，失败 ${failed} 张，用时 ${((Date.now() - t0) / 1000).toFixed(0)} 秒   `);

  /* ---------- 8. 退货 ---------- */
  let sret = 0, pret = 0;
  // 销售退货：每月挑 2 张出库单，退其中一行的一部分
  for (const ym of months) {
    const monthDocs = approvedOut.filter(d => d.date.startsWith(ym));
    for (let k = 0; k < 2 && monthDocs.length; k++) {
      const src = monthDocs[ri(0, monthDocs.length - 1)];
      try {
        const detail = await api(`/api/docs/${src.id}`);
        const line = detail.items[ri(0, detail.items.length - 1)];
        const qty = line.qty > 2 ? Math.max(1, Math.round(line.qty * 0.3)) : 1;
        const body = {
          doc_date: src.date, partner_id: src.cust.id, warehouse_id: wh.id,
          origin_doc_id: src.id, remark: `${MARK}-销售退货`,
          items: [{
            material_id: line.material_id, qty, origin_item_id: line.id,
            ...(line.cut_width ? { cut_width: line.cut_width } : {})
          }]
        };
        await saveDoc('SRET', body);
        sret++;
      } catch (e) { failed++; failures.push(`销售退货 ${src.date}: ${e.message}`); }
    }
  }
  console.log(`  ✓ 销售退货 ${sret} 张`);

  // 采购退货：从入库单里挑，退一行的一部分
  const inDocs = await api('/api/docs?type=IN&size=500');
  const inList = (inDocs.list || []).filter(d => d.status === 'approved' && String(d.remark || '').startsWith(MARK));
  for (let i = 0; i < inList.length; i += 3) {
    const src = inList[i];
    try {
      const detail = await api(`/api/docs/${src.id}`);
      const line = detail.items[0];
      const qty = line.qty > 4 ? Math.max(1, Math.round(line.qty * 0.15)) : 1;
      await saveDoc('PRET', {
        doc_date: src.doc_date, partner_id: src.partner_id, warehouse_id: wh.id,
        origin_doc_id: src.id, remark: `${MARK}-采购退货`,
        items: [{ material_id: line.material_id, qty, origin_item_id: line.id }]
      });
      pret++;
    } catch (e) { failed++; failures.push(`采购退货 ${src.sn}: ${e.message}`); }
  }
  console.log(`  ✓ 采购退货 ${pret} 张`);

  /* ---------- 9. 收付款 ---------- */
  let payCount = 0;
  for (const d of approvedOut) {
    if (rnd() > 0.55) continue;
    try {
      const detail = await api(`/api/docs/${d.id}`);
      const totalAmt = Math.abs(Number(detail.total_amount) || 0);
      if (totalAmt <= 0) continue;
      const ratio = rnd() < 0.65 ? 1 : 0.4;
      const amount = money(totalAmt * ratio);
      if (amount <= 0) continue;
      const payDate = new Date(new Date(d.date + 'T00:00:00').getTime() + ri(1, 40) * 86400000)
        .toISOString().slice(0, 10);
      await api(`/api/docs/${d.id}/payment`, 'POST', {
        amount, pay_date: payDate > todayStr ? todayStr : payDate,
        method: pick(PAY_METHODS), remark: MARK
      });
      payCount++;
    } catch (e) { failed++; failures.push(`收款 ${d.id}: ${e.message}`); }
  }
  console.log(`  ✓ 收款登记 ${payCount} 笔`);

  /* ---------- 10. 各种状态 ---------- */
  // 草稿 3 张、待审核 3 张、作废 2 张，让列表各种状态都有
  const recent = approvedOut.slice(-6);
  for (let i = 0; i < 3 && i < recent.length; i++) {
    const d = recent[i];
    try {
      await api('/api/docs', 'POST', {
        type: 'OUT', doc_date: todayStr, partner_id: d.cust.id, warehouse_id: wh.id,
        salesperson_id: d.cust.sp, remark: `${MARK}-草稿`,
        items: d.items.map(it => ({ material_id: it.mat.id, qty: 1, price: it.price }))
      });
    } catch (e) { failed++; failures.push(`草稿: ${e.message}`); }
  }
  for (let i = 3; i < 6 && i < recent.length; i++) {
    const d = recent[i];
    try {
      const c = await api('/api/docs', 'POST', {
        type: 'OUT', doc_date: todayStr, partner_id: d.cust.id, warehouse_id: wh.id,
        salesperson_id: d.cust.sp, remark: `${MARK}-待审核`,
        items: d.items.map(it => ({ material_id: it.mat.id, qty: 1, price: it.price }))
      });
      await api(`/api/docs/${c.id}/submit`, 'POST', {});
    } catch (e) { failed++; failures.push(`待审核: ${e.message}`); }
  }
  for (const d of approvedOut.slice(-30, -28)) {
    try { await api(`/api/docs/${d.id}/void`, 'POST', { reason: '演示：客户取消订单' }); }
    catch (e) { failed++; failures.push(`作废: ${e.message}`); }
  }
  console.log('  ✓ 草稿 / 待审核 / 作废 状态各若干');

  /* ---------- 汇总 ---------- */
  console.log('\n========== 完成 ==========');
  console.log(`  出库单 ${approvedOut.length} 张、销售退货 ${sret} 张、采购退货 ${pret} 张、收款 ${payCount} 笔`);
  if (failed) {
    console.log(`  ⚠ 失败 ${failed} 条，前 10 条：`);
    failures.slice(0, 10).forEach(f => console.log('    - ' + f));
  }
  console.log('');
})().catch(e => {
  console.error('\n执行失败：', e.message);
  process.exit(1);
});
