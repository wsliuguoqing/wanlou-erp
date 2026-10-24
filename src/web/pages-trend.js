/* 经营分析：销售额与毛利的年度 / 月度趋势与同期对比（纯 SVG 画图，无第三方库） */
'use strict';

const TrendState = { data: null, year: null, cmpYear: null };

page('profit', () => {
  const d = TrendState.data;
  if (!d) return `<h1 class="pg">经营分析</h1><p class="pg-sub">正在加载…</p>`;

  const years = d.availableYears?.length ? d.availableYears : [d.year];
  const yearOpts = (sel) => {
    const set = new Set([...years, d.year, d.compareYear, Number(todayStr().slice(0, 4))]);
    return [...set].sort((a, b) => b - a)
      .map(y => `<option value="${y}" ${y === sel ? 'selected' : ''}>${y} 年</option>`).join('');
  };

  const pct = v => (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + '%';
  const arrow = v => v >= 0 ? '▲' : '▼';
  const colorOf = v => v >= 0 ? 'var(--brand)' : 'var(--rust)';

  const ytd = d.ytd, tm = d.thisMonth;

  return `
    <h1 class="pg">经营分析</h1>
    <p class="pg-sub">销售额与毛利的月度走势，以及和去年同期的对比。只统计已审核的出库单。</p>

    <div class="bar">
      <span class="hint">本期</span>
      <select class="inp" style="width:120px" id="tr-year" onchange="loadTrend()">${yearOpts(d.year)}</select>
      <span class="hint">对比</span>
      <select class="inp" style="width:120px" id="tr-cmp" onchange="loadTrend()">${yearOpts(d.compareYear)}</select>
      <div class="spacer"></div>
      <button class="btn" onclick="exportTrend()">导出 Excel</button>
    </div>

    <div class="stats">
      <div class="stat">
        <div class="stat-label">${d.year} 年累计销售额</div>
        <div class="stat-val">${money(ytd.amount)}</div>
        <div class="stat-sub" style="color:${colorOf(ytd.amountGrowth)}">
          ${arrow(ytd.amountGrowth)} ${pct(ytd.amountGrowth)} 对比 ${d.compareYear} 同期 ${money(ytd.lastYearAmount)}
        </div>
      </div>
      <div class="stat">
        <div class="stat-label">${d.year} 年累计毛利</div>
        <div class="stat-val green">${money(ytd.profit)}</div>
        <div class="stat-sub" style="color:${colorOf(ytd.profitGrowth)}">
          ${arrow(ytd.profitGrowth)} ${pct(ytd.profitGrowth)} 对比 ${money(ytd.lastYearProfit)}
        </div>
      </div>
      <div class="stat">
        <div class="stat-label">${esc(tm.ym || '')} 销售额</div>
        <div class="stat-val">${money(tm.amount)}</div>
        <div class="stat-sub" style="color:${colorOf(tm.amountGrowth)}">
          ${arrow(tm.amountGrowth)} ${pct(tm.amountGrowth)} 去年同月 ${money(tm.lastYearAmount)}
        </div>
      </div>
      <div class="stat">
        <div class="stat-label">${esc(tm.ym || '')} 毛利</div>
        <div class="stat-val green">${money(tm.profit)}</div>
        <div class="stat-sub" style="color:${colorOf(tm.profitGrowth)}">
          ${arrow(tm.profitGrowth)} ${pct(tm.profitGrowth)} 去年同月 ${money(tm.lastYearProfit)}
        </div>
      </div>
    </div>

    <div class="card pad" style="margin-bottom:16px">
      <div class="sec">销售额月度走势</div>
      ${lineChart(d.months.map(m => m.amount), d.compareMonths.map(m => m.amount), d.year, d.compareYear, '销售额')}
    </div>

    <div class="card pad" style="margin-bottom:16px">
      <div class="sec">毛利月度走势</div>
      ${lineChart(d.months.map(m => m.profit), d.compareMonths.map(m => m.profit), d.year, d.compareYear, '毛利')}
    </div>

    <div class="card pad">
      <div class="sec">逐月明细与同期对比</div>
      <div id="trend-table">${monthTable(d)}</div>
    </div>`;
});

page('profit').afterRender = () => loadTrend();

async function loadTrend() {
  const y = document.getElementById('tr-year')?.value || '';
  const c = document.getElementById('tr-cmp')?.value || '';
  try {
    TrendState.data = await api(`/reports/trend?year=${y}&compare_year=${c}`);
    if (App.route === 'profit') document.getElementById('page').innerHTML = PAGES.profit();
  } catch (e) { toast(e.message, 'err'); }
}

/* ---------- 折线图：纯 SVG ---------- */
function lineChart(cur, prev, curYear, prevYear, label) {
  const W = 980, H = 260, L = 64, R = 16, T = 18, B = 34;
  const iw = W - L - R, ih = H - T - B;
  const max = Math.max(...cur, ...prev, 1);
  const ticks = 4;
  const x = i => L + (iw / 11) * i;
  const y = v => T + ih - (v / max) * ih;

  const path = arr => arr.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const dots = (arr, color) => arr.map((v, i) =>
    v > 0 ? `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3" fill="${color}"></circle>` : '').join('');

  const grid = Array.from({ length: ticks + 1 }, (_, k) => {
    const v = max * k / ticks, gy = y(v);
    return `<line x1="${L}" y1="${gy.toFixed(1)}" x2="${W - R}" y2="${gy.toFixed(1)}" stroke="#eceff0"></line>
            <text x="${L - 8}" y="${(gy + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="#98a1ab">${shortMoney(v)}</text>`;
  }).join('');

  const xLabels = Array.from({ length: 12 }, (_, i) =>
    `<text x="${x(i).toFixed(1)}" y="${H - 12}" text-anchor="middle" font-size="10.5" fill="#68737f">${i + 1}月</text>`).join('');

  return `
  <div style="overflow-x:auto">
    <svg viewBox="0 0 ${W} ${H}" style="width:100%;min-width:680px;height:${H}px">
      ${grid}${xLabels}
      <path d="${path(prev)}" fill="none" stroke="#b9bfc6" stroke-width="1.6" stroke-dasharray="4 3"></path>
      <path d="${path(cur)}" fill="none" stroke="#1a6b57" stroke-width="2.2"></path>
      ${dots(prev, '#b9bfc6')}${dots(cur, '#1a6b57')}
    </svg>
  </div>
  <div style="display:flex;gap:20px;justify-content:center;margin-top:6px;font-size:12px;color:var(--muted)">
    <span><span style="display:inline-block;width:18px;height:2px;background:#1a6b57;vertical-align:middle"></span> ${curYear} 年${label}</span>
    <span><span style="display:inline-block;width:18px;height:2px;background:#b9bfc6;vertical-align:middle"></span> ${prevYear} 年${label}</span>
  </div>`;
}

function shortMoney(v) {
  if (v >= 10000) return (v / 10000).toFixed(v >= 100000 ? 0 : 1) + '万';
  return String(Math.round(v));
}

function monthTable(d) {
  const rows = d.months.map((m, i) => {
    const p = d.compareMonths[i] || { amount: 0, profit: 0 };
    const g = p.amount > 0 ? (m.amount - p.amount) / p.amount : (m.amount > 0 ? 1 : 0);
    const future = d.year === Number(todayStr().slice(0, 4)) && m.month > d.currentMonth;
    return `<tr style="${future ? 'opacity:.4' : ''}">
      <td>${m.month} 月</td>
      <td class="r num">${m.count || '—'}</td>
      <td class="r num">${money(m.amount)}</td>
      <td class="r num">${money(m.cost)}</td>
      <td class="r num" style="color:var(--brand)"><b>${money(m.profit)}</b></td>
      <td class="r num">${m.amount > 0 ? (m.margin * 100).toFixed(1) + '%' : '—'}</td>
      <td class="r num" style="color:var(--muted)">${money(p.amount)}</td>
      <td class="r num" style="color:${g >= 0 ? 'var(--brand)' : 'var(--rust)'}">
        ${p.amount > 0 || m.amount > 0 ? (g >= 0 ? '+' : '') + (g * 100).toFixed(1) + '%' : '—'}</td>
    </tr>`;
  });
  const t = d.total, ct = d.compareTotal;
  const tg = ct.amount > 0 ? (t.amount - ct.amount) / ct.amount : 0;
  rows.push(`<tr style="border-top:2px solid var(--line);font-weight:600;background:#fbfcfb">
    <td>全年合计</td>
    <td class="r num">${t.count}</td>
    <td class="r num">${money(t.amount)}</td>
    <td class="r num">${money(t.cost)}</td>
    <td class="r num" style="color:var(--brand)">${money(t.profit)}</td>
    <td class="r num">${t.amount > 0 ? ((t.profit / t.amount) * 100).toFixed(1) + '%' : '—'}</td>
    <td class="r num" style="color:var(--muted)">${money(ct.amount)}</td>
    <td class="r num" style="color:${tg >= 0 ? 'var(--brand)' : 'var(--rust)'}">
      ${ct.amount > 0 ? (tg >= 0 ? '+' : '') + (tg * 100).toFixed(1) + '%' : '—'}</td>
  </tr>`);

  return tableWrap([
    { label: '月份' }, { label: '单数', r: 1 }, { label: '销售额', r: 1 }, { label: '成本', r: 1 },
    { label: '毛利', r: 1 }, { label: '毛利率', r: 1 },
    { label: `${d.compareYear} 年销售额`, r: 1 }, { label: '同比', r: 1 }
  ], rows, '没有数据');
}

function exportTrend() {
  exportTable('trend-table', `经营分析_${TrendState.data?.year || ''}`);
}
