/* 单据页面：出库、入库、销售退货、采购退货 */
'use strict';

const DOC_CONF = {
  out:  { type: 'OUT',  api: '/docs/out',  title: '出库单',      partnerApi: '/customers', partnerLabel: '客户',   partnerKey: 'customer', permNew: 'outbound.create', permEdit: 'outbound.edit', permVoid: 'outbound.void', permAudit: 'outbound.audit', needSales: true },
  in:   { type: 'IN',   api: '/docs/in',   title: '入库单',      partnerApi: '/suppliers', partnerLabel: '供应商', partnerKey: 'supplier', permNew: 'inbound.create',  permEdit: 'inbound.edit',  permVoid: 'inbound.void',  permAudit: 'inbound.audit',  needSales: false },
  sret: { type: 'SRET', api: '/docs/sret', title: '销售退货单',  partnerApi: '/customers', partnerLabel: '客户',   partnerKey: 'customer', permNew: 'sret.create',     permEdit: 'sret.create',   permVoid: 'sret.void',     permAudit: 'sret.audit',     needSales: true },
  pret: { type: 'PRET', api: '/docs/pret', title: '采购退货单',  partnerApi: '/suppliers', partnerLabel: '供应商', partnerKey: 'supplier', permNew: 'pret.create',     permEdit: 'pret.create',   permVoid: 'pret.void',     permAudit: 'pret.audit',     needSales: false }
};

const DocState = { listData: {}, filter: {} };

/* ---------------- 列表页 ---------------- */
function makeDocListPage(key) {
  const conf = DOC_CONF[key];
  const f = DocState.filter[key] = DocState.filter[key] || { keyword: '', status: '', from: monthStart(), to: todayStr() };

  const p = () => {
    const d = DocState.listData[key] || { list: [] };
    const rows = (d.list || []).map(r => {
      const partner = r.partner_name || '—';
      return `<tr>
        <td><a onclick="openDocDetail('${key}',${r.id})">${esc(r.sn)}</a></td>
        <td class="num">${esc(r.doc_date)}</td>
        <td>${esc(partner)}</td>
        ${conf.needSales ? `<td>${esc(r.creator_name || '')}</td>` : `<td>${esc(r.creator_name || '')}</td>`}
        <td class="mono">${esc(r.contract_sn || '—')}</td>
        <td class="r num"><b>${money(r.total_amount)}</b></td>
        ${can('cost.view') ? `<td class="r num">${money(r.total_cost)}</td>` : ''}
        ${can('cost.view') ? `<td class="r num" style="color:var(--brand)">${money((r.total_amount || 0) - (r.total_cost || 0))}</td>` : ''}
        <td>${statusTag(r.status)}</td>
        <td>${payTag(r.pay_status)}</td>
        <td>
          <button class="btn sm" onclick="openDocDetail('${key}',${r.id})">查看</button>
          ${r.status === 'pending' && conf.permAudit && can(conf.permAudit) ? `<button class="btn sm primary" onclick="openAudit('${key}',${r.id},'${esc(r.sn)}')">审核</button>` : ''}
        </td>
      </tr>`;
    });
    return `
      <h1 class="pg">${conf.title}</h1>
      <p class="pg-sub">共 ${rows.length} 张，合计金额 <b>${money(d.totalAmount)}</b>${can('cost.view') ? '' : '（成本与利润仅管理员可见）'}</p>
      <div class="bar">
        <input class="inp" style="width:180px" placeholder="单号 / 合同号" value="${esc(f.keyword)}"
          oninput="DocState.filter['${key}'].keyword=this.value" onkeydown="if(event.key==='Enter')loadDocList('${key}')">
        <select class="inp" style="width:130px" onchange="DocState.filter['${key}'].status=this.value;loadDocList('${key}')">
          <option value="">全部状态</option>
          <option value="draft" ${f.status === 'draft' ? 'selected' : ''}>草稿</option>
          <option value="pending" ${f.status === 'pending' ? 'selected' : ''}>待审核</option>
          <option value="approved" ${f.status === 'approved' ? 'selected' : ''}>已审核</option>
          <option value="rejected" ${f.status === 'rejected' ? 'selected' : ''}>已驳回</option>
          <option value="void" ${f.status === 'void' ? 'selected' : ''}>已作废</option>
        </select>
        <input class="inp" type="date" style="width:150px" value="${f.from}" onchange="DocState.filter['${key}'].from=this.value">
        <span class="hint">至</span>
        <input class="inp" type="date" style="width:150px" value="${f.to}" onchange="DocState.filter['${key}'].to=this.value">
        <button class="btn" onclick="loadDocList('${key}')">查询</button>
        <div class="spacer"></div>
        ${can(conf.permNew) ? `<button class="btn primary" onclick="openDocForm('${key}')">＋ 新建${conf.title}</button>` : ''}
      </div>
      ${tableWrap([
        { label: conf.title + '号' }, { label: '日期' }, { label: conf.partnerLabel }, { label: '制单人' },
        { label: '合同号' }, { label: '金额', r: 1 },
        ...(can('cost.view') ? [{ label: '成本', r: 1 }, { label: '毛利', r: 1 }] : []),
        { label: '状态' }, { label: '结算' }, { label: '操作' }
      ], rows, '还没有单据，点右上角新建')}`;
  };
  p.afterRender = () => loadDocList(key);
  return p;
}

async function loadDocList(key) {
  const conf = DOC_CONF[key];
  const f = DocState.filter[key];
  const qs = new URLSearchParams({ keyword: f.keyword || '', status: f.status || '', from: f.from || '', to: f.to || '' });
  try {
    DocState.listData[key] = await api(`${conf.api}?${qs}`);
    if (App.route === key) {
      const el = document.getElementById('page');
      if (el) el.innerHTML = PAGES[key]();
    }
  } catch (e) { toast(e.message, 'err'); }
}

/* ---------------- 新建/编辑单据 ---------------- */
const Draft = { data: null, materials: [], partners: [], warehouses: [], editing: null };

async function openDocForm(key, docId) {
  const conf = DOC_CONF[key];
  try {
    const [mats, partners, whs] = await Promise.all([
      api('/materials'),
      api(conf.partnerApi),
      api('/warehouses')
    ]);
    Draft.materials = mats.list;
    Draft.partners = partners.list;
    Draft.warehouses = whs.list;

    let doc = null;
    if (docId) doc = await api(`${conf.api}/${docId}`);

    Draft.editing = docId || null;
    Draft.data = doc ? {
      doc_date: doc.doc_date, partner_id: doc.partner_id, warehouse_id: doc.warehouse_id,
      contract_sn: doc.contract_sn || '', salesperson_id: doc.salesperson_id,
      invoice_status: doc.invoice_status, carrier: doc.carrier || '',
      receiver: doc.receiver || '', receiver_phone: doc.receiver_phone || '',
      receiver_addr: doc.receiver_addr || '', remark: doc.remark || '',
      items: doc.items.map(i => ({
        material_id: i.material_id, qty: i.qty, price: i.price,
        cut_width: i.cut_width || 0, remark: i.remark || ''
      }))
    } : {
      doc_date: todayStr(), partner_id: '', warehouse_id: Draft.warehouses[0]?.id || '',
      contract_sn: '', salesperson_id: App.user.id, invoice_status: 0,
      carrier: '', receiver: '', receiver_phone: '', receiver_addr: '', remark: '',
      items: []
    };

    renderDocForm(key);
  } catch (e) { toast(e.message, 'err'); }
}

function renderDocForm(key) {
  const conf = DOC_CONF[key];
  const d = Draft.data;
  const isOut = key === 'out' || key === 'sret';
  const showCost = can('cost.view');

  const itemRows = d.items.map((it, i) => {
    const m = Draft.materials.find(x => x.id === Number(it.material_id)) || {};
    const isMaster = m.type === 'master';
    const amount = (Number(it.qty) || 0) * (Number(it.price) || 0);
    const costPrice = computeCostPrice(m, it, key);
    const costAmount = costPrice * (Number(it.qty) || 0);
    const needCut = isMaster && (key === 'out' || key === 'pret');
    return `<tr>
      <td style="width:250px">
        <button class="btn sm" style="width:100%;text-align:left" onclick="pickMaterial(${i},'${key}')">
          ${m.id ? `<span class="cell-pick"><b>${esc(m.name)}</b><small>${esc(m.code)} · ${esc(m.spec || '')} · ${esc(m.unit || '')}${isMaster ? ' · 母卷' : ''}</small></span>` : '<span class="hint">点击选择物料</span>'}
        </button>
      </td>
      ${needCut ? `<td style="width:86px"><input class="num" type="number" min="0" placeholder="宽度mm" value="${it.cut_width || ''}"
          oninput="setItem(${i},'cut_width',this.value,'${key}')" title="分切宽度（填 0 表示整支出库）"></td>` : ''}
      <td style="width:86px"><input class="num" type="number" min="0" step="0.001" value="${it.qty || ''}" oninput="setItem(${i},'qty',this.value,'${key}')"></td>
      <td style="width:104px"><input class="num ${it._priceWarn ? 'warn' : ''}" type="number" min="0" step="0.01" value="${it.price ?? ''}" oninput="setItem(${i},'price',this.value,'${key}')"></td>
      <td class="r num" style="width:110px">${money(amount)}</td>
      ${showCost ? `<td class="r num" style="width:104px;color:var(--muted)">${money(costPrice)}</td>
      <td class="r num" style="width:104px;color:var(--muted)">${money(costAmount)}</td>` : ''}
      <td style="width:40px"><button class="btn sm danger" onclick="removeItem(${i},'${key}')">×</button></td>
    </tr>`;
  }).join('');

  const totals = d.items.reduce((a, it) => {
    const m = Draft.materials.find(x => x.id === Number(it.material_id)) || {};
    const amt = (Number(it.qty) || 0) * (Number(it.price) || 0);
    const cp = computeCostPrice(m, it, key);
    a.amount += amt; a.cost += cp * (Number(it.qty) || 0);
    return a;
  }, { amount: 0, cost: 0 });
  const profit = totals.amount - totals.cost;

  const body = `
    <div class="form-grid" style="margin-bottom:18px">
      <div class="field"><label>${conf.title}日期 *</label>
        <input class="inp" type="date" value="${d.doc_date}" onchange="Draft.data.doc_date=this.value"></div>
      <div class="field"><label>${conf.partnerLabel} *</label>
        <select class="inp" onchange="Draft.data.partner_id=Number(this.value)">
          <option value="">请选择${conf.partnerLabel}</option>
          ${Draft.partners.map(p => `<option value="${p.id}" ${Number(d.partner_id) === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
        </select></div>
      <div class="field"><label>仓库 *</label>
        <select class="inp" onchange="Draft.data.warehouse_id=Number(this.value)">
          ${Draft.warehouses.map(w => `<option value="${w.id}" ${Number(d.warehouse_id) === w.id ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}
        </select></div>
      <div class="field"><label>合同号</label>
        <input class="inp" value="${esc(d.contract_sn)}" oninput="Draft.data.contract_sn=this.value"></div>
      ${conf.needSales && key === 'out' ? `<div class="field"><label>开票状态</label>
        <select class="inp" onchange="Draft.data.invoice_status=Number(this.value)">
          <option value="0" ${d.invoice_status === 0 ? 'selected' : ''}>未开票</option>
          <option value="1" ${d.invoice_status === 1 ? 'selected' : ''}>已开票</option>
          <option value="2" ${d.invoice_status === 2 ? 'selected' : ''}>随货开票</option>
        </select></div>` : ''}
    </div>

    ${isOut ? `<div class="form-grid" id="ship-area" style="margin-bottom:18px">
      <div class="field"><label>承运人</label><input class="inp" value="${esc(d.carrier)}" placeholder="如 京东快递 / 客户自提" oninput="Draft.data.carrier=this.value"></div>
      <div class="field"><label>收货人</label><input class="inp" value="${esc(d.receiver)}" oninput="Draft.data.receiver=this.value"></div>
      <div class="field"><label>收货电话</label><input class="inp" value="${esc(d.receiver_phone)}" oninput="Draft.data.receiver_phone=this.value"></div>
      <div class="field"><label>收货地址</label><input class="inp" value="${esc(d.receiver_addr)}" oninput="Draft.data.receiver_addr=this.value"></div>
    </div>` : ''}

    <div class="sec">明细</div>
    <table class="items">
      <thead><tr>
        <th>物料</th>
        ${(key === 'out' || key === 'pret') ? '<th class="r">分切宽度</th>' : ''}
        <th class="r">数量</th>
        <th class="r">单价</th>
        <th class="r">金额</th>
        ${showCost ? '<th class="r">成本单价</th><th class="r">成本金额</th>' : ''}
        <th></th>
      </tr></thead>
      <tbody>
        ${itemRows || `<tr><td colspan="8" class="empty" style="padding:26px">还没有明细，点下面的按钮添加</td></tr>`}
        <tr><td colspan="8" style="padding:8px 6px">
          <button class="btn sm" onclick="addItem('${key}')">＋ 添加物料</button>
          <span class="hint" style="margin-left:10px">
            ${key === 'out' ? '母卷填分切宽度按卷卖，留空或填 0 表示整支出库' : ''}
            ${key === 'pret' ? '退回供应商的母卷按整支计算' : ''}
          </span>
        </td></tr>
      </tbody>
    </table>

    <div style="display:flex;justify-content:flex-end;gap:28px;padding:14px 4px 2px;border-top:1px solid var(--line-2);margin-top:8px">
      ${showCost ? `<div style="text-align:right"><div class="hint">成本合计</div><b class="num">${money(totals.cost)}</b></div>
      <div style="text-align:right"><div class="hint">毛利</div><b class="num" style="color:${profit >= 0 ? 'var(--brand)' : 'var(--rust)'}">${money(profit)}</b></div>` : ''}
      <div style="text-align:right"><div class="hint">金额合计</div><b class="num" style="font-size:17px">${money(totals.amount)}</b></div>
    </div>

    <div class="field" style="margin-top:16px"><label>备注</label>
      <input class="inp" value="${esc(d.remark)}" oninput="Draft.data.remark=this.value"></div>
  `;

  openDialog({
    title: (Draft.editing ? '编辑' : '新建') + conf.title,
    size: 'lg',
    body,
    footer: `<button class="btn" onclick="closeDialog()">取消</button>
      <button class="btn" onclick="saveDoc('${key}',false)">存为草稿</button>
      <button class="btn primary" onclick="saveDoc('${key}',true)">提交审批</button>`
  });
}

function computeCostPrice(m, it, key) {
  if (!m || !m.id) return 0;
  if (m.type === 'master' && key === 'out' && Number(it.cut_width) > 0) {
    const share = Number(it.cut_width) / (m.base_width || 1200);
    return (Number(m.cost) || 0) * share + (Number(m.cut_fee) || 0);
  }
  return Number(m.cost) || 0;
}

function setItem(i, field, val, key) {
  const it = Draft.data.items[i];
  it[field] = field === 'price' ? Number(val) : Number(val);
  if (field === 'price') it._priceWarn = false;
  const scroll = document.querySelector('.dlg-body').scrollTop;
  renderDocForm(key);
  document.querySelector('.dlg-body').scrollTop = scroll;
}

function addItem(key) {
  Draft.data.items.push({ material_id: '', qty: 1, price: 0, cut_width: 0, remark: '' });
  renderDocForm(key);
}

function removeItem(i, key) {
  Draft.data.items.splice(i, 1);
  renderDocForm(key);
}

/* 物料选择器 */
function pickMaterial(index, key, forCheck) {
  const list = Draft.materials;
  openDialog({
    title: '选择物料',
    body: `
      <input class="inp" id="pk-kw" placeholder="输入名称、编号、规格、品牌或扫描条码" style="margin-bottom:12px"
        oninput="filterMaterialPicker('${key}',${index})">
      <div class="tw" style="max-height:50vh">
        <table><thead><tr><th>编号</th><th>名称</th><th>规格</th><th>类型</th><th class="r">库存</th><th class="r">参考价</th><th></th></tr></thead>
        <tbody id="pk-body">${materialRows(list, '', key, index)}</tbody></table>
      </div>`,
    size: 'lg',
    footer: `<button class="btn" onclick="closeDialog()">关闭</button>`
  });
  setTimeout(() => document.getElementById('pk-kw')?.focus(), 50);
}

function materialRows(list, kw, key, index) {
  const k = kw.toLowerCase();
  const filtered = list.filter(m => !k || [m.name, m.code, m.spec, m.brand, m.barcode].join(' ').toLowerCase().includes(k));
  if (!filtered.length) return `<tr><td colspan="7" class="empty">没有匹配的物料</td></tr>`;
  return filtered.map(m => {
    const stock = m.type === 'master' ? `${m.roll_count || 0} 支 / ${qty(m.open_width)}mm` : qty(m.stock_qty);
    const refPrice = m.cost ? (Number(m.cost) * 1.3).toFixed(2) : '';
    return `<tr onclick="applyMaterial(${index},${m.id},'${key}')" style="cursor:pointer">
      <td class="mono">${esc(m.code)}</td>
      <td>${esc(m.name)}</td>
      <td>${esc(m.spec || '')}</td>
      <td>${esc(m.typeName || '')}</td>
      <td class="r num">${stock}</td>
      <td class="r num" style="color:var(--faint)">${refPrice}</td>
      <td><button class="btn sm primary">选择</button></td>
    </tr>`;
  }).join('');
}

function filterMaterialPicker(key, index) {
  const kw = document.getElementById('pk-kw').value;
  document.getElementById('pk-body').innerHTML = materialRows(Draft.materials, kw, key, index);
}

function applyMaterial(index, materialId, key) {
  const m = Draft.materials.find(x => x.id === materialId);
  const it = Draft.data.items[index];
  it.material_id = materialId;
  it.price = it.price || (m.type === 'master' ? Math.round((m.cost || 0) * 1.25) : Math.round((m.cost || 0) * 1.4 * 100) / 100);
  closeDialog();
  renderDocForm(key);
}

async function saveDoc(key, submit) {
  const conf = DOC_CONF[key];
  const d = Draft.data;
  if (!d.partner_id) return toast('请选择' + conf.partnerLabel, 'err');
  if (!d.warehouse_id) return toast('请选择仓库', 'err');
  if (!d.items.length) return toast('至少添加一行明细', 'err');
  const bad = d.items.find(i => !i.material_id || !(Number(i.qty) > 0));
  if (bad) return toast('有明细未选择物料或数量为 0', 'err');
  if (submit && !can(conf.permNew) && !can(conf.permEdit)) return toast('没有提交权限', 'err');

  const payload = {
    doc_date: d.doc_date, partner_id: d.partner_id, warehouse_id: d.warehouse_id,
    contract_sn: d.contract_sn, salesperson_id: d.salesperson_id || App.user.id,
    invoice_status: d.invoice_status, carrier: d.carrier, receiver: d.receiver,
    receiver_phone: d.receiver_phone, receiver_addr: d.receiver_addr, remark: d.remark,
    submit,
    items: d.items.map(i => ({
      material_id: i.material_id, qty: i.qty, price: i.price,
      cut_width: i.cut_width || 0, remark: i.remark || ''
    }))
  };
  try {
    if (Draft.editing) {
      await api(`${conf.api}/${Draft.editing}`, 'PUT', payload);
    } else {
      await api(conf.api, 'POST', payload);
    }
    closeDialog();
    toast(submit ? '已提交，等待审核' : '已保存草稿', 'ok');
    loadDocList(key);
  } catch (e) { toast(e.message, 'err'); }
}

/* ---------------- 单据详情 ---------------- */
async function openDocDetail(key, id) {
  const conf = DOC_CONF[key];
  try {
    const d = await api(`${conf.api}/${id}`);
    const showCost = can('cost.view');
    const items = d.items.map(it => `<tr>
      <td>${esc(it.material_name)}</td>
      <td class="mono">${esc(it.material_code)}</td>
      <td>${esc(it.material_spec || '')}</td>
      ${key === 'out' && it.material_type === 'master' ? `<td class="num">${it.cut_width ? it.cut_width + 'mm' : '整支'}</td>` : ''}
      <td class="num">${qty(it.qty)} ${esc(it.unit || '')}</td>
      <td class="r num">${money(it.price)}</td>
      <td class="r num"><b>${money(it.amount)}</b></td>
      ${showCost ? `<td class="r num" style="color:var(--muted)">${money(it.cost_price)}</td>
      <td class="r num" style="color:var(--muted)">${money(it.cost_amount)}</td>` : ''}
    </tr>`).join('');

    const totalAmount = d.total_amount || 0;
    const totalCost = d.total_cost || 0;
    const profit = totalAmount - totalCost;

    const actions = [];
    if (d.status === 'draft' || d.status === 'rejected') {
      if (can(conf.permEdit)) actions.push(`<button class="btn" onclick="closeDialog();openDocForm('${key}',${d.id})">编辑</button>`);
      actions.push(`<button class="btn primary" onclick="submitDoc(${d.id},'${key}')">提交审批</button>`);
    }
    if (d.status === 'pending' && can(conf.permAudit)) {
      actions.push(`<button class="btn" onclick="rejectDoc(${d.id},'${key}')">驳回</button>`);
      actions.push(`<button class="btn primary" onclick="approveDoc(${d.id},'${key}')">审核通过</button>`);
    }
    if (d.status === 'approved') {
      if (key === 'out' && can('outbound.invoice')) actions.push(`<button class="btn" onclick="toggleInvoice(${d.id},${d.invoice_status},'${key}')">${d.invoice_status ? '取消开票' : '标记已开票'}</button>`);
      if (['out', 'sret'].includes(key) && can('payment.receive')) actions.push(`<button class="btn" onclick="openPayment(${d.id},'${d.sn}',${totalAmount},${d.paid_amount || 0},'receive','${key}')">登记收款</button>`);
      if (['in', 'pret'].includes(key) && can('payment.pay')) actions.push(`<button class="btn" onclick="openPayment(${d.id},'${d.sn}',${totalAmount},${d.paid_amount || 0},'pay','${key}')">登记付款</button>`);
      if (can(conf.permVoid)) actions.push(`<button class="btn danger" onclick="voidDoc(${d.id},'${key}','${esc(d.sn)}')">作废</button>`);
    }

    openDialog({
      title: `${conf.title} ${d.sn}`,
      size: 'lg',
      body: `
        <div style="display:flex;gap:12px;align-items:center;margin-bottom:16px">
          ${statusTag(d.status)} ${payTag(d.pay_status)}
          ${d.invoice_status ? '<span class="tag info">已开票</span>' : '<span class="tag mute">未开票</span>'}
        </div>
        <div class="form-grid" style="margin-bottom:18px">
          <div><div class="hint">${conf.partnerLabel}</div><div>${esc(d.partner?.name || '—')}</div></div>
          <div><div class="hint">日期</div><div class="num">${esc(d.doc_date)}</div></div>
          <div><div class="hint">仓库</div><div>${esc(d.warehouse_name)}</div></div>
          <div><div class="hint">合同号</div><div class="mono">${esc(d.contract_sn || '—')}</div></div>
          <div><div class="hint">制单人</div><div>${esc(d.creator_name)}</div></div>
          ${d.auditor_name ? `<div><div class="hint">审核人</div><div>${esc(d.auditor_name)}</div></div>` : ''}
          ${d.carrier ? `<div><div class="hint">承运人</div><div>${esc(d.carrier)}</div></div>` : ''}
          ${d.receiver ? `<div><div class="hint">收货人</div><div>${esc(d.receiver)} ${esc(d.receiver_phone || '')}</div></div>` : ''}
        </div>
        ${d.receiver_addr ? `<div class="hint" style="margin-bottom:14px">收货地址：${esc(d.receiver_addr)}</div>` : ''}
        ${d.audit_reason ? `<div class="banner warn">驳回原因：${esc(d.audit_reason)}</div>` : ''}
        ${d.void_reason ? `<div class="banner warn">作废原因：${esc(d.void_reason)}</div>` : ''}

        <div class="sec">明细</div>
        <table class="items">
          <thead><tr><th>物料</th><th>编号</th><th>规格</th>
            ${key === 'out' ? '<th>分切</th>' : ''}
            <th class="r">数量</th><th class="r">单价</th><th class="r">金额</th>
            ${showCost ? '<th class="r">成本单价</th><th class="r">成本金额</th>' : ''}
          </tr></thead>
          <tbody>${items}</tbody>
        </table>

        <div style="display:flex;justify-content:flex-end;gap:30px;padding-top:16px;margin-top:8px;border-top:1px solid var(--line-2)">
          ${showCost ? `<div><div class="hint">成本合计</div><b class="num">${money(totalCost)}</b></div>
          <div><div class="hint">毛利 / 毛利率</div><b class="num" style="color:${profit >= 0 ? 'var(--brand)' : 'var(--rust)'}">${money(profit)}
            <span style="font-size:12px;font-weight:400">${totalAmount > 0 ? ((profit / totalAmount) * 100).toFixed(2) + '%' : ''}</span></b></div>` : ''}
          <div><div class="hint">金额合计</div><b class="num" style="font-size:17px">${money(totalAmount)}</b></div>
        </div>
        ${d.remark ? `<div class="hint" style="margin-top:12px">备注：${esc(d.remark)}</div>` : ''}
        ${d.status === 'approved' ? `<div class="hint" style="margin-top:12px">已收付款 ${money(d.paid_amount)}，未结 ${money(totalAmount - (d.paid_amount || 0))}</div>` : ''}
      `,
      footer: `${actions.join('')}<button class="btn" onclick="closeDialog()">关闭</button>`
    });
  } catch (e) { toast(e.message, 'err'); }
}

async function approveDoc(id, key) {
  const conf = DOC_CONF[key];
  try {
    await api(`/docs/${id}/approve`, 'POST');
    closeDialog();
    toast('审核通过，库存已更新', 'ok');
    loadDocList(key);
  } catch (e) { toast(e.message, 'err'); }
}

function rejectDoc(id, key) {
  promptDialog({
    title: '驳回单据', label: '驳回原因（必填）', multiline: true,
    onOk: async (reason) => {
      if (!reason) return toast('请填写驳回原因', 'err');
      try {
        await api(`/docs/${id}/reject`, 'POST', { reason });
        toast('已驳回', 'ok');
        loadDocList(key);
      } catch (e) { toast(e.message, 'err'); }
    }
  });
}

async function submitDoc(id, key) {
  const conf = DOC_CONF[key];
  try {
    await api(`/docs/${id}/submit`, 'POST');
    closeDialog();
    toast('已提交，等待审核', 'ok');
    loadDocList(key);
  } catch (e) { toast(e.message, 'err'); }
}

function voidDoc(id, key, sn) {
  promptDialog({
    title: '作废单据', label: `确认作废 ${sn}？库存将自动回滚。请填写作废原因`, multiline: true,
    onOk: async (reason) => {
      try {
        await api(`/docs/${id}/void`, 'POST', { reason });
        toast('已作废，库存已回滚', 'ok');
        loadDocList(key);
      } catch (e) { toast(e.message, 'err'); }
    }
  });
}

async function toggleInvoice(id, cur, key) {
  try {
    await api(`/docs/${id}/invoice`, 'POST', { invoice_status: cur ? 0 : 1 });
    toast(cur ? '已取消开票标记' : '已标记开票', 'ok');
    loadDocList(key);
  } catch (e) { toast(e.message, 'err'); }
}

function openPayment(docId, sn, total, paid, type, key) {
  const remain = total - paid;
  openDialog({
    title: type === 'receive' ? '登记收款' : '登记付款',
    size: 'sm',
    body: `
      <div class="hint" style="margin-bottom:14px">单据 ${esc(sn)}，金额 ${money(total)}，已结 ${money(paid)}，未结 ${money(remain)}</div>
      <div class="field" style="margin-bottom:12px"><label>${type === 'receive' ? '收款' : '付款'}金额 *</label>
        <input class="inp num" id="pay-amt" type="number" step="0.01" value="${remain > 0 ? remain : ''}"></div>
      <div class="field" style="margin-bottom:12px"><label>日期</label>
        <input class="inp" id="pay-date" type="date" value="${todayStr()}"></div>
      <div class="field" style="margin-bottom:12px"><label>方式</label>
        <select class="inp" id="pay-method"><option>银行转账</option><option>现金</option><option>微信</option><option>支付宝</option><option>承兑汇票</option></select></div>
      <div class="field"><label>备注</label><input class="inp" id="pay-note"></div>`,
    footer: `<button class="btn" onclick="closeDialog()">取消</button>
      <button class="btn primary" onclick="submitPayment(${docId},'${key}')">确定</button>`
  });
}

async function submitPayment(docId, key) {
  const amount = Number(document.getElementById('pay-amt').value);
  if (!amount) return toast('请输入金额', 'err');
  try {
    await api(`/docs/${docId}/payment`, 'POST', {
      amount, pay_date: document.getElementById('pay-date').value,
      method: document.getElementById('pay-method').value,
      remark: document.getElementById('pay-note').value
    });
    closeDialog();
    toast('已登记', 'ok');
    loadDocList(key);
  } catch (e) { toast(e.message, 'err'); }
}

/* 注册页面 */
page('out', makeDocListPage('out'));
page('in', makeDocListPage('in'));
page('sret', makeDocListPage('sret'));
page('pret', makeDocListPage('pret'));
