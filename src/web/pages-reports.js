/* 报表与系统管理页面：看板、待结转、汇总、利润、应收应付、员工、角色、日志、设置、我的账号 */
'use strict';

/* ==================== 首页看板 ==================== */
page('dashboard', () => {
  const inv = BaseState.inv;
  const showCost = can('cost.view');
  return `
    <h1 class="pg">首页看板</h1>
    <p class="pg-sub">${esc(App.user.name)}，欢迎回来。今天是 ${todayStr()}</p>
    <div class="banner">
      <b>当前身份：${ROLE_NAME[App.user.role] || App.user.role}</b>
      ${App.user.role === 'sales' ? '— 你只能看到自己负责的客户和单据，成本和利润对你不可见。' : ''}
      ${App.user.role === 'purchaser' ? '— 你负责采购与供应商，销售价格与利润对你不可见。' : ''}
      ${App.user.role === 'finance' ? '— 你可以查看全部单据和利润报表，并登记收付款。' : ''}
      ${['manager', 'admin'].includes(App.user.role) ? '— 你可以审核单据并查看全部经营数据。' : ''}
    </div>

    <div class="stats">
      <div class="stat clickable" onclick="viewPendingDocs()" style="cursor:pointer" title="点击查看待审核单据列表">
        <div class="stat-label">待审核单据</div>
        <div class="stat-val" id="kpi-pending">—</div>
        <div class="stat-sub">需要你处理</div>
      </div>
      <div class="stat"><div class="stat-label">本月出库金额</div><div class="stat-val green" id="kpi-out">—</div><div class="stat-sub">已审核</div></div>
      ${can('ar.view') ? `<div class="stat"><div class="stat-label">应收账款余额</div><div class="stat-val" id="kpi-ar">—</div><div class="stat-sub">客户未结清</div></div>` : ''}
      ${can('ap.view') ? `<div class="stat"><div class="stat-label">应付账款余额</div><div class="stat-val" id="kpi-ap">—</div><div class="stat-sub">欠供应商</div></div>` : ''}
      ${showCost ? `<div class="stat"><div class="stat-label">本月毛利</div><div class="stat-val green" id="kpi-profit">—</div><div class="stat-sub">出库减去成本</div></div>` : ''}
    </div>

    <div class="card pad">
      <div class="sec">快捷入口</div>
      <div class="bar" style="margin-bottom:0">
        ${can('outbound.create') ? '<button class="btn primary" onclick="go(\'out\');setTimeout(()=>openDocForm(\'out\'),300)">开一张出库单</button>' : ''}
        ${can('inbound.create') ? '<button class="btn" onclick="go(\'in\');setTimeout(()=>openDocForm(\'in\'),300)">开一张入库单</button>' : ''}
        <button class="btn" onclick="go('inventory')">查库存</button>
        ${can('report.carryover') ? '<button class="btn" onclick="go(\'carryover\')">看待结转利润</button>' : ''}
      </div>
    </div>`;
});

page('dashboard').afterRender = async () => {
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  try {
    const tasks = [];
    if (can('outbound.view')) tasks.push(api('/docs/out?status=pending&from=&to=').then(d => d.list.length).catch(() => 0));
    else tasks.push(Promise.resolve(0));
    if (can('inbound.view')) tasks.push(api('/docs/in?status=pending&from=&to=').then(d => d.list.length).catch(() => 0));
    else tasks.push(Promise.resolve(0));
    const [outPending, inPending] = await Promise.all(tasks);
    set('kpi-pending', String(outPending + inPending));

    if (can('outbound.view')) {
      const outs = await api(`/docs/out?from=${monthStart()}&to=${todayStr()}&status=approved`);
      set('kpi-out', '¥' + money(outs.totalAmount));
      if (can('cost.view')) {
        const rep = await api(`/reports/carryover?from=${monthStart()}&to=${todayStr()}`);
        set('kpi-profit', '¥' + money(rep.summary.profit));
      }
    }
    if (can('ar.view')) {
      const ar = await api('/reports/receivable');
      set('kpi-ar', '¥' + money(ar.total));
    }
    if (can('ap.view')) {
      const ap = await api('/reports/payable');
      set('kpi-ap', '¥' + money(ap.total));
    }
  } catch (e) { /* 看板容错，不打断 */ }
};

/* ==================== 待结转库存清单 ==================== */
const RepState = { carryover: null, summary: null, profit: null, receivable: null, payable: null };

page('carryover', () => {
  const d = RepState.carryover || { list: [], summary: {} };
  const rows = d.list.map(r => `<tr>
    <td class="mono">${esc(r.sn)}</td>
    <td class="num">${esc(r.doc_date)}</td>
    <td>${esc(r.customer_name || '')}</td>
    <td>${esc(r.salesperson_name || '')}</td>
    <td class="r num">${money(r.total_amount)}</td>
    <td class="r num">${money(r.total_cost)}</td>
    <td class="r num" style="color:var(--brand)"><b>${money(r.profit)}</b></td>
    <td class="r num">${r.margin}</td>
    <td>${r.invoice_status ? '<span class="tag ok">已开票</span>' : '<span class="tag mute">未开票</span>'}</td>
  </tr>`);
  const s = d.summary || {};
  return `
    <h1 class="pg">待结转库存清单</h1>
    <p class="pg-sub">已出库未结转的订单及其毛利，是看经营成果最常用的表</p>
    <div class="bar" style="flex-wrap:wrap">
      <input class="inp" type="date" style="width:148px" id="co-from" value="${esc(RepState.coFilter?.from || monthStart())}">
      <span class="hint">至</span>
      <input class="inp" type="date" style="width:148px" id="co-to" value="${esc(RepState.coFilter?.to || todayStr())}">
      <select class="inp" style="width:190px" id="co-cust" title="按客户筛选">
        <option value="">全部客户</option>
        ${(RepState.coCustomers || []).map(c => `<option value="${c.id}" ${String(RepState.coFilter?.customer_id) === String(c.id) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
      </select>
      <select class="inp" style="width:140px" id="co-sales" title="按销售员筛选">
        <option value="">全部销售员</option>
        ${(RepState.coSales || []).map(u => `<option value="${u.id}" ${String(RepState.coFilter?.salesperson_id) === String(u.id) ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}
      </select>
      <select class="inp" style="width:120px" id="co-inv">
        <option value="" ${!RepState.coFilter?.invoice_status ? 'selected' : ''}>开票：全部</option>
        <option value="0" ${RepState.coFilter?.invoice_status === '0' ? 'selected' : ''}>未开票</option>
        <option value="1" ${RepState.coFilter?.invoice_status === '1' ? 'selected' : ''}>已开票</option>
      </select>
      <button class="btn primary" onclick="loadCarryover(true)">查询</button>
      <button class="btn" onclick="resetCarryover()">清空</button>
      <div class="spacer"></div>
      <button class="btn" onclick="exportCarryover()">导出 Excel</button>
    </div>
    <div class="stats">
      <div class="stat"><div class="stat-label">不含税销售额</div><div class="stat-val">${money(s.amount)}</div></div>
      <div class="stat"><div class="stat-label">成本合计</div><div class="stat-val">${money(s.cost)}</div></div>
      <div class="stat"><div class="stat-label">毛利</div><div class="stat-val green">${money(s.profit)}</div></div>
      <div class="stat"><div class="stat-label">毛利率</div><div class="stat-val green">${s.margin || '0.00%'}</div></div>
    </div>
    <div id="carryover-table">
    ${tableWrap([
      { label: '出库单号' }, { label: '日期' }, { label: '客户' }, { label: '销售员' },
      { label: '销售额', r: 1 }, { label: '成本', r: 1 }, { label: '毛利', r: 1 }, { label: '毛利率', r: 1 }, { label: '开票' }
    ], rows, '所选期间没有已审核的出库单')}
    </div>
    ${pagerBar('carryover', d.page, 'loadCarryover', '张')}`;
});
page('carryover').afterRender = () => loadCarryover();

/** 导出走接口取全量，不受当前页码限制 */
async function exportCarryover() {
  const qs = new URLSearchParams({ ...(RepState.coFilter || {}), all: '1' });
  try {
    const d = await api(`/reports/carryover?${qs}`);
    const head = ['出库单号', '日期', '客户', '销售员', '销售额', '成本', '毛利', '毛利率', '开票'];
    const lines = [head.map(v => `"${v}"`).join(',')];
    for (const r of d.list) {
      lines.push([r.sn, r.doc_date, r.customer_name || '', r.salesperson_name || '',
        r.total_amount, r.total_cost, r.profit, r.margin,
        r.invoice_status ? '已开票' : '未开票']
        .map(v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`).join(','));
    }
    const s = d.summary || {};
    lines.push(['合计', '', '', '', s.amount, s.cost, s.profit, s.margin, '']
      .map(v => `"${String(v == null ? '' : v)}"`).join(','));
    downloadCsv('待结转库存清单', lines);
  } catch (e) { toast(e.message, 'err'); }
}

function downloadCsv(filename, lines) {
  const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${filename}_${todayStr()}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('已导出，可用 Excel 打开', 'ok');
}

async function loadCarryover(reset) {
  if (reset) pgState('carryover').page = 1;
  // 首次进入时把客户和销售员选项load出来
  if (!RepState.coCustomers) {
    try {
      const cs = await api('/customers');
      RepState.coCustomers = (cs.list || []).map(c => ({ id: c.id, name: c.name }));
    } catch { RepState.coCustomers = []; }
  }
  if (!RepState.coSales) {
    try {
      const us = await api('/users');
      RepState.coSales = (us.list || [])
        .filter(u => ['sales', 'manager', 'admin'].includes(u.role))
        .map(u => ({ id: u.id, name: u.name }));
    } catch { RepState.coSales = []; }
  }

  const f = {
    from: document.getElementById('co-from')?.value || '',
    to: document.getElementById('co-to')?.value || '',
    customer_id: document.getElementById('co-cust')?.value || '',
    salesperson_id: document.getElementById('co-sales')?.value || '',
    invoice_status: document.getElementById('co-inv')?.value ?? ''
  };
  RepState.coFilter = f;

  const qs = new URLSearchParams(f);
  const pg = pgState('carryover');
  qs.set('page', pg.page);
  qs.set('size', pg.size);
  try {
    RepState.carryover = await api(`/reports/carryover?${qs}`);
    if (App.route === 'carryover') document.getElementById('page').innerHTML = PAGES.carryover();
  } catch (e) { toast(e.message, 'err'); }
}

function resetCarryover() {
  RepState.coFilter = { from: monthStart(), to: todayStr(), customer_id: '', salesperson_id: '', invoice_status: '' };
  if (App.route === 'carryover') document.getElementById('page').innerHTML = PAGES.carryover();
  loadCarryover(true);
}

/* ==================== 进销存汇总 ==================== */
page('summary', () => {
  const d = RepState.summary || { list: [], period: {} };
  const rows = d.list.map(r => `<tr>
    <td class="mono">${esc(r.code)}</td>
    <td>${esc(r.name)}</td>
    <td>${esc(r.spec || '')}</td>
    <td>${esc(r.unit)}</td>
    <td class="r num">${qty(r.opening)}</td>
    <td class="r num" style="color:var(--brand)">${qty(r.in_qty)}</td>
    <td class="r num" style="color:var(--amber)">${qty(r.out_qty)}</td>
    <td class="r num"><b>${qty(r.closing)}</b></td>
    <td class="r num">${money(r.opening_amount)}</td>
    <td class="r num">${money(r.closing_amount)}</td>
  </tr>`);
  return `
    <h1 class="pg">进销存汇总</h1>
    <p class="pg-sub">按物料统计期初、本期入库、本期出库、期末结存</p>
    <div class="bar">
      <input class="inp" type="date" style="width:150px" id="sm-from" value="${monthStart()}">
      <span class="hint">至</span>
      <input class="inp" type="date" style="width:150px" id="sm-to" value="${todayStr()}">
      <button class="btn" onclick="loadSummary()">查询</button>
      <div class="spacer"></div>
      <button class="btn" onclick="exportTable('summary-table','进销存汇总')">导出 Excel</button>
    </div>
    <div id="summary-table">
    ${tableWrap([
      { label: '编号' }, { label: '名称' }, { label: '规格' }, { label: '单位' },
      { label: '期初', r: 1 }, { label: '入库', r: 1 }, { label: '出库', r: 1 }, { label: '期末', r: 1 },
      { label: '期初金额', r: 1 }, { label: '期末金额', r: 1 }
    ], rows, '所选期间没有库存变动')}
    </div>`;
});
page('summary').afterRender = () => loadSummary();

async function loadSummary() {
  try {
    RepState.summary = await api(`/reports/summary?from=${document.getElementById('sm-from').value}&to=${document.getElementById('sm-to').value}`);
    if (App.route === 'summary') document.getElementById('page').innerHTML = PAGES.summary();
  } catch (e) { toast(e.message, 'err'); }
}

/* ==================== 利润分析 ==================== */
/* 利润分析已改为「经营分析」图表看板，见 pages-trend.js */



/* ==================== 应收 / 应付 ==================== */
page('receivable', () => {
  const d = RepState.receivable || { list: [], total: 0 };
  const rows = d.list.map(r => `<tr>
    <td>${esc(r.name)}</td>
    <td>${esc(r.contact || '')}</td>
    <td class="num">${esc(r.phone || '')}</td>
    <td class="r num" style="color:var(--amber)"><b>${money(r.balance)}</b></td>
    <td class="num">${esc(r.last_date || '')}</td>
  </tr>`);
  return `
    <h1 class="pg">应收账款</h1>
    <p class="pg-sub">出库金额减去已收款后的余额，按客户汇总</p>
    <div class="stats">
      <div class="stat"><div class="stat-label">应收总额</div><div class="stat-val">${money(d.total)}</div></div>
      <div class="stat"><div class="stat-label">欠款客户数</div><div class="stat-val">${d.list.length}</div></div>
    </div>
    <div class="bar">
      <div class="spacer"></div>
      <button class="btn" onclick="exportTable('ar-table','应收账款')">导出 Excel</button>
    </div>
    <div id="ar-table">
    ${tableWrap([{ label: '客户' }, { label: '联系人' }, { label: '电话' }, { label: '应收余额', r: 1 }, { label: '最近出库' }],
      rows, '没有应收账款，账都清了')}
    </div>`;
});
page('receivable').afterRender = () => loadReceivable();

async function loadReceivable() {
  try {
    RepState.receivable = await api('/reports/receivable');
    if (App.route === 'receivable') document.getElementById('page').innerHTML = PAGES.receivable();
  } catch (e) { toast(e.message, 'err'); }
}

page('payable', () => {
  const d = RepState.payable || { list: [], total: 0 };
  const rows = d.list.map(r => `<tr>
    <td>${esc(r.name)}</td>
    <td>${esc(r.contact || '')}</td>
    <td class="num">${esc(r.phone || '')}</td>
    <td class="r num" style="color:var(--amber)"><b>${money(r.balance)}</b></td>
    <td class="num">${esc(r.last_date || '')}</td>
  </tr>`);
  return `
    <h1 class="pg">应付账款</h1>
    <p class="pg-sub">入库金额减去已付款后的余额，按供应商汇总</p>
    <div class="stats">
      <div class="stat"><div class="stat-label">应付总额</div><div class="stat-val">${money(d.total)}</div></div>
      <div class="stat"><div class="stat-label">欠款供应商数</div><div class="stat-val">${d.list.length}</div></div>
    </div>
    <div class="bar">
      <div class="spacer"></div>
      <button class="btn" onclick="exportTable('ap-table','应付账款')">导出 Excel</button>
    </div>
    <div id="ap-table">
    ${tableWrap([{ label: '供应商' }, { label: '联系人' }, { label: '电话' }, { label: '应付余额', r: 1 }, { label: '最近入库' }],
      rows, '没有应付账款')}
    </div>`;
});
page('payable').afterRender = () => loadPayable();

async function loadPayable() {
  try {
    RepState.payable = await api('/reports/payable');
    if (App.route === 'payable') document.getElementById('page').innerHTML = PAGES.payable();
  } catch (e) { toast(e.message, 'err'); }
}

/* ==================== 表格导出 Excel（CSV） ==================== */
function exportTable(containerId, filename) {
  const table = document.querySelector(`#${containerId} table`);
  if (!table) return toast('没有可导出的数据', 'err');
  const rows = [...table.querySelectorAll('tr')].map(tr =>
    [...tr.querySelectorAll('th,td')].map(td => {
      let t = td.innerText.replace(/\s+/g, ' ').trim().replace(/"/g, '""');
      return `"${t}"`;
    }).join(',')
  );
  const csv = '﻿' + rows.join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${filename}_${todayStr()}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('已导出，可用 Excel 打开', 'ok');
}

/* ==================== 首页快捷跳转 ==================== */
function viewPendingDocs() {
  // 跳转到出库单或入库单的待审核列表
  if (can('outbound.view')) {
    // 有出库权限,跳转到出库单列表,并自动筛选pending状态
    if (!DocState.filter) DocState.filter = {};
    if (!DocState.filter.out) DocState.filter.out = { keyword: '', status: 'pending', from: monthStart(), to: todayStr() };
    else DocState.filter.out.status = 'pending';
    go('out');
  } else if (can('inbound.view')) {
    // 只有入库权限,跳转到入库单列表
    if (!DocState.filter) DocState.filter = {};
    if (!DocState.filter.in) DocState.filter.in = { keyword: '', status: 'pending', from: monthStart(), to: todayStr() };
    else DocState.filter.in.status = 'pending';
    go('in');
  } else {
    toast('你没有查看单据的权限', 'err');
  }
}
