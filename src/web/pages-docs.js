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
  // 默认不限日期，避免单据因日期填错而看不到；需要时再手动筛选
  const f = DocState.filter[key] = Object.assign(
    { keyword: '', status: '', from: '', to: '', supplier: '', contract: '', model: '', customer: '', product: '', brand: '', material_keyword: '', salesperson: '' },
    DocState.filter[key] || {}
  );

  const p = () => {
    const d = DocState.listData[key] || { list: [] };
    const showCostCol = can('cost.view') && key !== 'in' && key !== 'pret';
    const showPayCol = key !== 'in' && key !== 'pret';
    const rows = (d.list || []).map(r => {
      const partner = r.partner_name || '—';
      // 待审核行加淡黄底，已驳回加淡红底，便于一眼区分
      const rowBg = r.status === 'pending' ? 'background:#fdf8ec'
        : r.status === 'rejected' ? 'background:#fdf0ec'
        : r.status === 'draft' ? 'background:#f7f8f7' : '';
      return `<tr style="${rowBg}">
        <td><a onclick="openDocDetail('${key}',${r.id})">${esc(r.sn)}</a></td>
        <td class="num">${esc(r.doc_date)}</td>
        <td>${esc(partner)}</td>
        <td>${esc(key === 'out' ? (r.salesperson_name || r.creator_name || '') : (r.creator_name || ''))}</td>
        <td class="mono">${esc(r.contract_sn || '—')}</td>
        <td class="r num"><b>${money(r.total_amount)}</b></td>
        ${showCostCol ? `<td class="r num">${money(r.total_cost)}</td>` : ''}
        ${showCostCol ? `<td class="r num" style="color:var(--brand)">${money((r.total_amount || 0) - (r.total_cost || 0))}</td>` : ''}
        <td>${statusTag(r.status)}${r.return_status === 'full' ? ' <span class="tag no">已全退</span>' : r.return_status === 'partial' ? ' <span class="tag wait">部分退货</span>' : ''}</td>
        ${showPayCol ? `<td>${payTag(r.pay_status)}</td>` : ''}
        <td>
          <button class="btn sm" onclick="openDocDetail('${key}',${r.id})">查看</button>
          ${r.status === 'pending' && conf.permAudit && can(conf.permAudit) ? `<button class="btn sm primary" onclick="openAudit('${key}',${r.id},'${esc(r.sn)}')">审核</button>` : ''}
        </td>
      </tr>`;
    });
    return `
      <h1 class="pg">${conf.title}</h1>
      <p class="pg-sub">共 ${rows.length} 张，合计金额 <b>${money(d.totalAmount)}</b>${can('cost.view') ? '' : '（成本与利润仅管理员可见）'}</p>
      <div class="bar" style="flex-wrap:wrap">
        <input class="inp" style="width:180px" placeholder="单号 / 合同号" value="${esc(f.keyword)}"
          oninput="DocState.filter['${key}'].keyword=this.value" onkeydown="if(event.key==='Enter')loadDocList('${key}')">
        <select class="inp" style="width:140px" onchange="DocState.filter['${key}'].status=this.value;loadDocList('${key}')">
          <option value="">全部(不含作废)</option>
          <option value="draft" ${f.status === 'draft' ? 'selected' : ''}>草稿</option>
          <option value="pending" ${f.status === 'pending' ? 'selected' : ''}>待审核</option>
          <option value="approved" ${f.status === 'approved' ? 'selected' : ''}>已审核</option>
          <option value="rejected" ${f.status === 'rejected' ? 'selected' : ''}>已驳回</option>
          <option value="void" ${f.status === 'void' ? 'selected' : ''}>已作废</option>
        </select>
        <input class="inp" type="date" style="width:148px" value="${f.from}" title="开始日期，留空表示不限"
          onchange="DocState.filter['${key}'].from=this.value;loadDocList('${key}')">
        <span class="hint">至</span>
        <input class="inp" type="date" style="width:148px" value="${f.to}" title="结束日期，留空表示不限"
          onchange="DocState.filter['${key}'].to=this.value;loadDocList('${key}')">
        ${key === 'in' ? `
          <input class="inp" style="width:160px" placeholder="供应商名称" value="${esc(f.supplier)}" oninput="DocState.filter.in.supplier=this.value" onkeydown="if(event.key==='Enter')loadDocList('in')">
          <input class="inp" style="width:150px" placeholder="合同编号" value="${esc(f.contract)}" oninput="DocState.filter.in.contract=this.value" onkeydown="if(event.key==='Enter')loadDocList('in')">
          <input class="inp" style="width:150px" placeholder="物料型号" value="${esc(f.model)}" oninput="DocState.filter.in.model=this.value" onkeydown="if(event.key==='Enter')loadDocList('in')">` : ''}
        ${key === 'out' ? `
          <input class="inp" style="width:150px" placeholder="客户名称" value="${esc(f.customer)}" oninput="DocState.filter.out.customer=this.value" onkeydown="if(event.key==='Enter')loadDocList('out')">
          <input class="inp" style="width:140px" placeholder="产品名称" value="${esc(f.product)}" oninput="DocState.filter.out.product=this.value" onkeydown="if(event.key==='Enter')loadDocList('out')">
          <input class="inp" style="width:120px" placeholder="品牌" value="${esc(f.brand)}" oninput="DocState.filter.out.brand=this.value" onkeydown="if(event.key==='Enter')loadDocList('out')">
          <input class="inp" style="width:140px" placeholder="物料关键词" value="${esc(f.material_keyword)}" oninput="DocState.filter.out.material_keyword=this.value" onkeydown="if(event.key==='Enter')loadDocList('out')">
          <input class="inp" style="width:140px" placeholder="销售人员 / 工号" value="${esc(f.salesperson)}" oninput="DocState.filter.out.salesperson=this.value" onkeydown="if(event.key==='Enter')loadDocList('out')">
          <input class="inp" style="width:150px" placeholder="销售合同编号" value="${esc(f.contract)}" oninput="DocState.filter.out.contract=this.value" onkeydown="if(event.key==='Enter')loadDocList('out')">` : ''}
        <button class="btn" onclick="loadDocList('${key}')">查询</button>
        ${Object.values(f).some(Boolean) ? `<button class="btn" onclick="resetDocFilter('${key}')">清空条件</button>` : ''}
        <div class="spacer"></div>
        ${can(conf.permNew) ? `<button class="btn primary" onclick="openDocForm('${key}')">＋ 新建${conf.title}</button>` : ''}
      </div>
      ${tableWrap([
        { label: conf.title + '号' }, { label: '日期' }, { label: conf.partnerLabel }, { label: key === 'out' ? '销售人员' : '制单人' },
        { label: '合同号' }, { label: '金额', r: 1 },
        ...(can('cost.view') && key !== 'in' && key !== 'pret' ? [{ label: '成本', r: 1 }, { label: '毛利', r: 1 }] : []),
        { label: '状态' },
        ...(key !== 'in' && key !== 'pret' ? [{ label: '结算' }] : []),
        { label: '操作' }
      ], rows, '还没有单据，点右上角新建')}
      ${pagerBar('docs-' + key, d.page, () => loadDocList(key), '张')}`;
  };
  p.afterRender = () => loadDocList(key);
  return p;
}

function resetDocFilter(key) {
  DocState.filter[key] = { keyword: '', status: '', from: '', to: '', supplier: '', contract: '', model: '', customer: '', product: '', brand: '', material_keyword: '', salesperson: '' };
  pgState('docs-' + key).page = 1;
  loadDocList(key);
}

async function loadDocList(key) {
  const conf = DOC_CONF[key];
  const f = DocState.filter[key];
  const qs = new URLSearchParams({
    ...f,
    page: pgState('docs-' + key).page, size: pgState('docs-' + key).size
  });
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

/* ---------------- 退货单：先查原单再退 ---------------- */
const RetDraft = { key: null, origin: null, items: [] };

function openReturnForm(key) {
  RetDraft.key = key;
  RetDraft.origin = null;
  RetDraft.items = [];
  const label = key === 'sret' ? '出库单' : '入库单';
  openDialog({
    title: key === 'sret' ? '新建销售退货单' : '新建采购退货单',
    size: 'lg',
    body: `
      <div class="field">
        <label>原${label}号 *</label>
        <div style="display:flex;gap:8px">
          <input class="inp mono" id="ret-sn" placeholder="输入或扫码原${label}号，回车查询"
            onkeydown="if(event.key==='Enter'){event.preventDefault();lookupOrigin()}">
          <button class="btn primary" onclick="lookupOrigin()">查询</button>
        </div>
      </div>
      <div class="hint" style="margin-top:8px">只有已审核的${label}可以退货。查到后在下面填写各行要退的数量，不填表示整行全退。</div>
      <div id="ret-body" style="margin-top:16px"></div>`,
    footer: `<button class="btn" onclick="closeDialog()">取消</button>
      <span id="ret-actions"></span>`
  });
  setTimeout(() => document.getElementById('ret-sn')?.focus(), 60);
}

async function lookupOrigin() {
  const sn = document.getElementById('ret-sn').value.trim();
  if (!sn) return toast('请输入单号', 'err');
  try {
    const d = await api('/docs/lookup/' + encodeURIComponent(sn));
    const want = RetDraft.key === 'sret' ? 'OUT' : 'IN';
    if (d.doc.type !== want) {
      return toast(`单号 ${sn} 是${d.doc.type === 'OUT' ? '出库单' : d.doc.type === 'IN' ? '入库单' : '其他单据'}，不能用于本类型退货`, 'err');
    }
    RetDraft.origin = d.doc;
    // 默认全退：数量预填为可退数量
    RetDraft.items = d.items.map(it => ({ ...it, ret_qty: it.returnable }));
    renderReturnBody();
  } catch (e) { toast(e.message, 'err'); }
}

function renderReturnBody() {
  const o = RetDraft.origin;
  const key = RetDraft.key;
  const canRet = RetDraft.items.some(it => it.returnable > 0);

  const rows = RetDraft.items.map((it, i) => {
    const isMaster = it.material_type === 'master';
    const isPackSplit = isSplitPack(it);
    const dec = isPackSplit ? (it.sub_unit === '米' ? 1 : 0) : isMaster ? 3 : 0;
    const step = isPackSplit ? (it.sub_unit === '米' ? 0.1 : 1) : isMaster ? 0.1 : 1;
    const unit = isPackSplit ? it.sub_unit : it.unit;
    const retAmount = returnAmount(it, key, it.ret_qty);
    const done = it.returnable <= 0;
    return `<tr style="${done ? 'opacity:.45' : ''}">
      <td class="num" style="color:var(--faint)">${i + 1}</td>
      <td><b>${esc(it.material_name)}</b><br><small class="hint">${esc(it.material_code)}${materialModelSpec(it) ? ' · ' + materialModelSpec(it) : ''}</small>${materialMeasureHint(it) ? `<br><small class="hint">${esc(materialMeasureHint(it))}</small>` : ''}</td>
      <td class="r num">${formatItemQuantity(it, key === 'sret' ? 'out' : 'in')}</td>
      <td class="r num">${it.returned_qty > 0 ? `${qty(it.returned_qty)} ${esc(unit || '')}` : '—'}</td>
      <td class="r num"><b>${qty(it.returnable)} ${esc(unit || '')}</b></td>
      <td style="width:100px">
        ${done ? '<span class="hint">已退完</span>'
          : `<input class="num" type="number" min="0" max="${it.returnable}" step="${step}" value="${it.ret_qty || ''}"
               oninput="onlyPositive(this,${dec});setRetQty(${i},this.value)" onblur="clampRetQty(${i},this)">`}
      </td>
      <td class="r num">${formatItemPrice(it, key === 'sret' ? 'out' : 'pret')}</td>
      <td class="r num cell-ret-amt"><b>${money(retAmount)}</b></td>
    </tr>`;
  });

  const total = RetDraft.items.reduce((s, it) => s + returnAmount(it, key, it.ret_qty), 0);

  document.getElementById('ret-body').innerHTML = `
    <div class="banner" style="margin-bottom:12px">
      原单 <b class="mono">${esc(o.sn)}</b> · ${esc(o.doc_date)} · ${esc(o.partner_name)}
      · 仓库 ${esc(o.warehouse_name)} · 原金额 <b>${money(o.total_amount)}</b>
    </div>
    <table class="items">
      <thead><tr>
        <th style="width:34px"></th><th>物料</th>
        <th class="r">原数量</th><th class="r">已退</th><th class="r">可退</th>
        <th class="r">本次退</th><th class="r">单价</th><th class="r">退货金额</th>
      </tr></thead>
      <tbody>${rows.join('')}</tbody>
    </table>
    <div class="totals-area" style="display:flex;justify-content:flex-end;gap:28px;padding:14px 4px 2px;border-top:1px solid var(--line-2);margin-top:8px">
      <div style="text-align:right"><div class="hint">退货金额合计</div><b class="num" id="ret-total" style="font-size:17px">${money(total)}</b></div>
    </div>
    <div class="field" style="margin-top:14px"><label>退货原因</label>
      <input class="inp" id="ret-remark" placeholder="如客户少要、规格不符、质量问题"></div>`;

  document.getElementById('ret-actions').innerHTML = canRet
    ? `<button class="btn" onclick="saveReturn(false)">存为草稿</button>
       <button class="btn primary" onclick="saveReturn(true)">提交审批</button>`
    : '<span class="hint">该单各行均已退完</span>';
}

function setRetQty(i, v) {
  RetDraft.items[i].ret_qty = Number(v) || 0;
  const total = RetDraft.items.reduce((s, it) => s + returnAmount(it, RetDraft.key, it.ret_qty), 0);
  const el = document.getElementById('ret-total');
  if (el) el.textContent = money(total);
  const row = document.querySelectorAll('#ret-body .items tbody tr')[i];
  const cell = row?.querySelector('.cell-ret-amt');
  if (cell) cell.innerHTML = `<b>${money(returnAmount(RetDraft.items[i], RetDraft.key, v))}</b>`;
}

function clampRetQty(i, el) {
  const it = RetDraft.items[i];
  let v = Number(el.value) || 0;
  if (v > it.returnable) {
    v = it.returnable;
    toast(`「${it.material_name}」最多只能退 ${qty(it.returnable)}`, 'err');
  }
  if (v < 0) v = 0;
  el.value = v || '';
  setRetQty(i, v);
}

async function saveReturn(submit) {
  const o = RetDraft.origin;
  if (!o) return toast('请先查询原单', 'err');
  const items = RetDraft.items
    .filter(it => (Number(it.ret_qty) || 0) > 0)
    .map(it => ({
      material_id: it.material_id, qty: Number(it.ret_qty),
      origin_item_id: it.id,
      ...(RetDraft.key === 'pret' && isSplitPack(it) ? { price_basis: it.price_basis || 'pack' } : {}),
      price: it.price, cut_width: it.cut_width || 0, batch_no: it.batch_no || ''
    }));
  if (!items.length) return toast('至少填写一行退货数量', 'err');

  const payload = {
    doc_date: todayStr(), partner_id: o.partner_id, warehouse_id: o.warehouse_id,
    contract_sn: o.contract_sn || '', salesperson_id: o.salesperson_id,
    origin_doc_id: o.id, source_doc_id: o.id,
    remark: (document.getElementById('ret-remark')?.value || '') + `（退 ${o.sn}）`,
    items, submit
  };
  try {
    await api(DOC_CONF[RetDraft.key].api, 'POST', payload);
    closeDialog();
    toast(submit ? '退货单已提交审批' : '已存为草稿', 'ok');
    loadDocList(RetDraft.key);
  } catch (e) { toast(e.message, 'err'); }
}

async function openDocForm(key, docId) {
  // 退货单走「先查原单」的流程
  if ((key === 'sret' || key === 'pret') && !docId) return openReturnForm(key);
  const conf = DOC_CONF[key];
  try {
    const [mats, partners, whs] = await Promise.all([
      api('/materials?all=1'),        // 物料下拉要全部，不能只拿一页
      api(conf.partnerApi + '?all=1'),
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
      items: doc.items.map(i => {
        const m = Draft.materials.find(x => x.id === i.material_id) || {};
        if (isSplitPack(m)) {
          const parts = i.qty_whole != null || i.qty_sub != null
            ? { whole: Number(i.qty_whole) || 0, loose: Number(i.qty_sub) || 0 }
            : key === 'in'
              ? { whole: Number(i.qty) || 0, loose: 0 }
              : splitQtyParts(i.qty, m);
          return {
            material_id: i.material_id,
            qty: itemQuantity({ qty_whole: parts.whole, qty_sub: parts.loose }, m),
            qty_whole: parts.whole, qty_sub: parts.loose, price: i.price,
            price_basis: key === 'in' ? (i.price_basis || 'pack') : '',
            cut_width: i.cut_width || 0, remark: i.remark || ''
          };
        }
        return {
          material_id: i.material_id, qty: i.qty, price: i.price,
          cut_width: i.cut_width || 0, remark: i.remark || ''
        };
      })
    } : {
      doc_date: todayStr(), partner_id: '', warehouse_id: Draft.warehouses[0]?.id || '',
      contract_sn: '', salesperson_id: App.user.id, invoice_status: 0,
      carrier: '', receiver: '', receiver_phone: '', receiver_addr: '', remark: '',
      items: []
    };

    await refreshDocMaterialStock(Draft.data.warehouse_id);
    renderDocForm(key);
  } catch (e) { toast(e.message, 'err'); }
}

function renderDocForm(key) {
  const conf = DOC_CONF[key];
  const d = Draft.data;
  const isOut = key === 'out' || key === 'sret';
  // 入库单的单价就是采购价，不显示成本与毛利
  const showCost = can('cost.view') && key !== 'in' && key !== 'pret';
  // 只有本单包含胶带母卷（sub_unit='mm'）时才显示分切宽度列
  const showCutCol = (key === 'out') && d.items.some(it => {
    const m = Draft.materials.find(x => x.id === Number(it.material_id));
    return m && m.type === 'master' && m.sub_unit === 'mm';
  });

  const itemRows = d.items.map((it, i) => {
    const m = Draft.materials.find(x => x.id === Number(it.material_id)) || {};
    const isMaster = m.type === 'master';
    const isRollMaster = isMaster && m.sub_unit === 'mm';    // 胶带母卷
    const isPackSplit = isSplitPack(m);
    const amount = itemAmount(m, it, key);
    const costPrice = computeCostPrice(m, it, key);
    const costAmount = costPrice * itemQuantity(it, m);
    const needCut = isRollMaster && (key === 'out' || key === 'pret');
    const avail = stockOf(m);
    // 胶带母卷可录分切卷数；整进零出通过零单位数量录入精度，其余整进整出必须整数。
    const allowInboundFraction = key === 'in' && !isMaster;
    const qtyStep = allowInboundFraction ? 0.001 : isMaster ? 0.1 : 1;
    const qtyDec = allowInboundFraction || isMaster ? 3 : 0;
    const wholeQtyStep = key === 'in' ? 0.001 : 1;
    const wholeQtyDecimals = key === 'in' ? 3 : 0;
    const smallStep = m.sub_unit === '米' ? 0.1 : 1;
    const smallDecimals = m.sub_unit === '米' ? 1 : 0;
    const modelAndSpec = materialModelSpec(m);
    const measureHint = isPackSplit
      ? `换算：1 ${m.unit} = ${qty(m.base_width)} ${m.sub_unit}`
      : isRollMaster ? `母卷宽度：${qty(m.base_width)} mm` : '';
    const priceLabel = itemPriceLabel(m, it, key);
    return `<tr data-row="${i}">
      <td style="width:250px">
        <button class="btn sm" style="width:100%;text-align:left" onclick="pickMaterial(${i},'${key}')">
          ${m.id ? `<span class="cell-pick"><b>${esc(m.name)}</b><small>${esc(m.code)}${modelAndSpec ? ' · ' + esc(modelAndSpec) : ''} · ${esc(m.unit || '')}</small>${measureHint ? `<small class="hint">${esc(measureHint)}</small>` : ''}</span>` : '<span class="hint">点击选择物料</span>'}
        </button>
        ${m.id && isOut ? `<div class="hint" style="margin-top:3px">本仓现存 ${esc(avail)}</div>` : ''}
      </td>
      ${showCutCol ? (needCut
        ? `<td style="width:100px"><div style="display:flex;align-items:center;gap:4px"><input class="num" type="number" min="0" step="1" placeholder="宽度" value="${it.cut_width || ''}"
            oninput="onlyPositive(this,0);setItem(${i},'cut_width',this.value,'${key}')" onblur="normalizeNum(this)" title="分切宽度，留空或 0 表示整支出库"><span class="hint">mm</span></div></td>`
        : '<td style="width:92px" class="hint">—</td>') : ''}
      ${isPackSplit ? `<td style="min-width:210px"><div style="display:flex;gap:6px">
        <label class="hint" style="flex:1">整数量<div style="display:flex;align-items:center;gap:3px"><input class="num" type="number" min="0" step="${wholeQtyStep}" value="${it.qty_whole ?? ''}"
          oninput="onlyPositive(this,${wholeQtyDecimals});setItem(${i},'qty_whole',this.value,'${key}')" onblur="normalizeNum(this)"><span>${esc(m.unit)}</span></div></label>
        <label class="hint" style="flex:1">拆分数量<div style="display:flex;align-items:center;gap:3px"><input class="num" type="number" min="0" step="${smallStep}" value="${it.qty_sub ?? ''}"
          oninput="onlyPositive(this,${smallDecimals});setItem(${i},'qty_sub',this.value,'${key}')" onblur="normalizeNum(this)"><span>${esc(m.sub_unit)}</span></div></label>
        </div><div class="hint cell-qty-total">合计 ${qty(itemQuantity(it, m))} ${esc(m.sub_unit)}</div></td>`
        : `<td style="width:106px"><div style="display:flex;align-items:center;gap:4px"><input class="num" type="number" min="0" step="${qtyStep}" value="${it.qty || ''}"
          oninput="onlyPositive(this,${qtyDec});setItem(${i},'qty',this.value,'${key}')" onblur="normalizeNum(this)"><span class="hint">${esc(m.unit || '')}</span></div></td>`}
      <td style="width:138px"><input class="num ${it._priceWarn ? 'warn' : ''}" type="number" min="0" step="0.01" value="${it.price ?? ''}" title="${esc(priceLabel)}"
        oninput="onlyPositive(this,2);setItem(${i},'price',this.value,'${key}')" onblur="normalizeNum(this)">
        ${isPackSplit ? `<div class="hint cell-price-unit">${esc(priceLabel)}</div>` : ''}</td>
      <td class="r num cell-amount" style="width:110px">${money(amount)}</td>
      ${showCost ? `<td class="r num cell-cost-price" style="width:104px;color:var(--muted)">${formatCostWithUnit(costPrice, m)}</td>
      <td class="r num cell-cost-amount" style="width:104px;color:var(--muted)">${formatCost(costAmount)}</td>` : ''}
      <td style="width:40px"><button class="btn sm danger" onclick="removeItem(${i},'${key}')">×</button></td>
    </tr>`;
  }).join('');

  const totals = d.items.reduce((a, it) => {
    const m = Draft.materials.find(x => x.id === Number(it.material_id)) || {};
    const quantity = itemQuantity(it, m);
    const amt = itemAmount(m, it, key);
    const cp = computeCostPrice(m, it, key);
    a.amount += amt; a.cost += cp * quantity;
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
        <select class="inp" onchange="changeDocWarehouse(this.value,'${key}')">
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
      <div class="field"><label>收货电话</label><input class="inp" value="${esc(d.receiver_phone)}"
        placeholder="手机或固话" oninput="onlyPhone(this);Draft.data.receiver_phone=this.value"></div>
      <div class="field"><label>收货地址</label><input class="inp" value="${esc(d.receiver_addr)}" oninput="Draft.data.receiver_addr=this.value"></div>
    </div>` : ''}

    <div class="sec">明细</div>
    <table class="items">
      <thead><tr>
        <th>物料</th>
        ${showCutCol ? '<th class="r">分切宽度</th>' : ''}
        <th class="r">数量（单位显示在数量后）</th>
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

    <div class="totals-area" style="display:flex;justify-content:flex-end;gap:28px;padding:14px 4px 2px;border-top:1px solid var(--line-2);margin-top:8px">
      ${showCost ? `<div style="text-align:right"><div class="hint">成本合计</div><b class="num">${money(totals.cost)}</b></div>
      <div style="text-align:right"><div class="hint">毛利</div><b class="num" style="color:${profit >= 0 ? 'var(--brand)' : 'var(--rust)'}">${money(profit)}</b></div>` : ''}
      <div style="text-align:right"><div class="hint">${key === 'in' || key === 'pret' ? '采购金额合计' : '金额合计'}</div><b class="num" style="font-size:17px">${money(totals.amount)}</b></div>
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

/** 物料可用库存的可读文本 */
function stockOf(m) {
  if (!m || !m.id) return '—';
  // 胶带母卷（按 mm 分切）
  if (m.type === 'master' && m.sub_unit === 'mm') {
    return `${m.roll_count || 0} 支 / ${qty(m.open_width || 0)}mm`;
  }
  // 箱装母卷（按卷零售）
  if (m.type === 'master' && m.sub_unit && m.sub_unit !== 'mm') {
    let text = `${qty(m.stock_qty || 0)} ${m.unit}`;
    if (m.sub_qty > 0) text += ` + ${m.sub_qty} ${m.sub_unit}`;
    return text;
  }
  // 普通物料
  return `${qty(m.stock_qty || 0)} ${m.unit || ''}`;
}

async function refreshDocMaterialStock(warehouseId) {
  if (!warehouseId) return;
  const res = await api(`/materials?all=1&warehouse_id=${encodeURIComponent(warehouseId)}`);
  if (Number(Draft.data?.warehouse_id) === Number(warehouseId)) Draft.materials = res.list;
}

async function changeDocWarehouse(warehouseId, key) {
  Draft.data.warehouse_id = Number(warehouseId);
  try {
    await refreshDocMaterialStock(Draft.data.warehouse_id);
    renderDocForm(key);
  } catch (e) { toast(`读取所选仓库库存失败：${e.message}`, 'err'); }
}

function isSplitPack(m) {
  const type = m?.type || m?.material_type;
  return !!(m && type === 'master' && m.sub_unit && m.sub_unit !== 'mm');
}

function formatCost(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? money(n) : '—';
}

function formatCostWithUnit(value, m) {
  const formatted = formatCost(value);
  const unit = isSplitPack({ type: m?.type || m?.material_type, sub_unit: m?.sub_unit }) ? m.sub_unit : m?.unit;
  return formatted === '—' || !unit ? formatted : `${formatted} / ${esc(unit)}`;
}

function materialMeasureHint(m) {
  const type = m?.material_type || m?.type;
  if (type !== 'master') return '';
  if (m.sub_unit === 'mm') return `母卷宽度：${qty(m.base_width)} mm`;
  return m.sub_unit ? `换算：1 ${m.unit} = ${qty(m.base_width)} ${m.sub_unit}` : '';
}

function materialModelSpec(m) {
  if (!m) return '';
  const edited = m.model_edited ?? m.material_model_edited ?? 1;
  const model = edited ? (m.model || m.material_model || '') : (m.spec || m.material_spec || '');
  const spec = edited ? (m.spec || m.material_spec || '') : '';
  return [model, spec].filter(Boolean).map(esc).join(' · ');
}

/** 单据统一按零单位计算整进零出数量。 */
function itemQuantity(it, m) {
  if (isSplitPack(m) && (it.qty_whole !== undefined || it.qty_sub !== undefined)) {
    return (Number(it.qty_whole) || 0) * (Number(m.base_width) || 1) + (Number(it.qty_sub) || 0);
  }
  return Number(it.qty) || 0;
}

function itemAmount(m, it, key) {
  const quantity = itemQuantity(it, m);
  if (isSplitPack(m) && (key === 'in' || key === 'pret')) {
    if ((key === 'in' && (it.price_basis ? it.price_basis === 'sub' : Number(it.qty_sub) > 0))
        || (key === 'pret' && it.price_basis === 'sub')) {
      return quantity * (Number(it.price) || 0);
    }
    return (quantity / (Number(m.base_width) || 1)) * (Number(it.price) || 0);
  }
  return quantity * (Number(it.price) || 0);
}

function itemPriceLabel(m, it, key) {
  if (!isSplitPack(m)) return key === 'in' || key === 'pret' ? '进货单价' : '销售单价';
  if (key === 'in') {
    const perSubUnit = it.price_basis ? it.price_basis === 'sub' : Number(it.qty_sub) > 0;
    return perSubUnit ? `采购单价/${m.sub_unit}` : `采购单价/${m.unit}`;
  }
  if (key === 'pret') return `采购单价/${it.price_basis === 'sub' ? m.sub_unit : m.unit}`;
  return `销售单价/${m.sub_unit}`;
}

function splitQtyParts(total, m) {
  const perPack = Number(m.base_width) || 1;
  const whole = Math.floor((Number(total || 0) + 1e-8) / perPack);
  const scale = m.sub_unit === '米' ? 10 : 1000;
  const loose = Math.round(((Number(total || 0) - whole * perPack) + 1e-8) * scale) / scale;
  return { whole, loose };
}

function formatItemQuantity(it, key) {
  const m = {
    type: it.material_type,
    sub_unit: it.sub_unit,
    base_width: it.base_width,
    unit: it.unit
  };
  if (!isSplitPack(m)) return `${qty(it.qty)} ${esc(it.unit || '')}`;
  let parts;
  if (it.qty_whole != null || it.qty_sub != null) {
    parts = { whole: Number(it.qty_whole) || 0, loose: Number(it.qty_sub) || 0 };
  } else if (key === 'in') {
    // 升级前入库单 qty 记录整单位数量。
    return `${qty(it.qty)} ${esc(it.unit)}`;
  } else {
    parts = splitQtyParts(it.qty, m);
  }
  return `${qty(parts.whole)} ${esc(it.unit)} + ${qty(parts.loose)} ${esc(it.sub_unit)}`;
}

function formatItemPrice(it, key) {
  const isPurchase = key === 'in' || key === 'pret';
  const isPackSplit = isSplitPack({ type: it.material_type, sub_unit: it.sub_unit });
  const unit = isPackSplit
    ? ((key === 'in' || key === 'pret') && it.price_basis === 'sub'
      ? it.sub_unit
      : isPurchase ? it.unit : it.sub_unit)
    : it.unit;
  return `${money(it.price)} / ${esc(unit || '')}`;
}

function returnAmount(it, key, quantity) {
  const q = Number(quantity) || 0;
  if (key === 'pret' && isSplitPack(it)) {
    return it.price_basis === 'sub'
      ? q * (Number(it.price) || 0)
      : q / (Number(it.base_width) || 1) * (Number(it.price) || 0);
  }
  return q * (Number(it.price) || 0);
}

function computeCostPrice(m, it, key) {
  if (!m || !m.id) return 0;
  if (m.type === 'master' && key === 'out' && Number(it.cut_width) > 0) {
    const share = Number(it.cut_width) / (m.base_width || 1200);
    return (Number(m.cost) || 0) * share + (Number(m.cut_fee) || 0);
  }
  if (isSplitPack(m)) return Number(m.cost) || 0;
  return Number(m.cost) || 0;
}

function setItem(i, field, val, key) {
  const it = Draft.data.items[i];
  it[field] = Number(val);
  if (field === 'price') it._priceWarn = false;

  // 只更新当前行的金额和成本,不重建整个表单(避免焦点跳转)
  const m = Draft.materials.find(x => x.id === Number(it.material_id)) || {};
  if (key === 'in' && isSplitPack(m) && (field === 'qty_whole' || field === 'qty_sub')) {
    it.price_basis = Number(it.qty_sub) > 0 ? 'sub' : 'pack';
  }
  const quantity = itemQuantity(it, m);
  if (isSplitPack(m)) it.qty = quantity;
  const amount = itemAmount(m, it, key);
  const costPrice = computeCostPrice(m, it, key);
  const costAmount = costPrice * quantity;
  const showCost = can('cost.view');

  // 用 data-row 属性精确定位当前行,避免 nth-child 在行数变化时出错
  const row = document.querySelector(`.items tbody tr[data-row="${i}"]`);
  if (row) {
    const amountCell = row.querySelector('.cell-amount');
    const qtyTotalCell = row.querySelector('.cell-qty-total');
    const costPriceCell = row.querySelector('.cell-cost-price');
    const costAmountCell = row.querySelector('.cell-cost-amount');
    const priceInput = row.querySelector('input[title]');
    const priceUnitHint = row.querySelector('.cell-price-unit');
    const priceLabel = itemPriceLabel(m, it, key);
    if (amountCell) amountCell.textContent = money(amount);
    if (qtyTotalCell) qtyTotalCell.textContent = `合计 ${qty(quantity)} ${m.sub_unit}`;
    if (priceInput) priceInput.title = priceLabel;
    if (priceUnitHint) priceUnitHint.textContent = priceLabel;
    if (showCost && costPriceCell) costPriceCell.textContent = formatCostWithUnit(costPrice, m);
    if (showCost && costAmountCell) costAmountCell.textContent = formatCost(costAmount);
  }

  // 更新底部合计
  updateTotals(key);
}

function updateTotals(key) {
  const totals = Draft.data.items.reduce((a, it) => {
    const m = Draft.materials.find(x => x.id === Number(it.material_id)) || {};
    const quantity = itemQuantity(it, m);
    const amt = itemAmount(m, it, key);
    const cp = computeCostPrice(m, it, key);
    a.amount += amt; a.cost += cp * quantity;
    return a;
  }, { amount: 0, cost: 0 });
  const profit = totals.amount - totals.cost;
  const showCost = can('cost.view') && key !== 'in' && key !== 'pret';

  const sumArea = document.querySelector('.totals-area');
  if (!sumArea) return;

  const spans = sumArea.querySelectorAll('b.num');
  if (showCost) {
    // 有成本权限: 3个数字 [成本合计, 毛利, 金额合计]
    if (spans[0]) spans[0].textContent = money(totals.cost);
    if (spans[1]) {
      spans[1].textContent = money(profit);
      spans[1].style.color = profit >= 0 ? 'var(--brand)' : 'var(--rust)';
    }
    if (spans[2]) spans[2].textContent = money(totals.amount);
  } else {
    // 无成本权限: 只有1个数字 [金额合计]
    if (spans[0]) spans[0].textContent = money(totals.amount);
  }
}


function addItem(key) {
  const newIndex = Draft.data.items.length;
  Draft.data.items.push({ material_id: '', qty: 1, price: 0, cut_width: 0, remark: '' });
  renderDocForm(key);
  // 直接弹出物料选择器
  setTimeout(() => pickMaterial(newIndex, key), 50);
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
        <table><thead><tr><th>编号</th><th>名称</th><th>规格</th><th>类型</th><th class="r">所选仓库存</th><th class="r">参考价</th><th></th></tr></thead>
        <tbody id="pk-body">${materialRows(list, '', key, index)}</tbody></table>
      </div>`,
    size: 'lg',
    footer: `<button class="btn" onclick="closeMaterialPicker('${key}')">关闭</button>`,
    onMount: root => {
      const closeButton = root.querySelector('.dlg-head .x');
      if (closeButton) closeButton.onclick = () => closeMaterialPicker(key);
    }
  });
  setTimeout(() => document.getElementById('pk-kw')?.focus(), 50);
}

function closeMaterialPicker(key) {
  renderDocForm(key);
}

function materialRows(list, kw, key, index) {
  const k = kw.toLowerCase();
  const filtered = list.filter(m => !k || [m.name, m.code, m.model, m.spec, m.brand, m.barcode].join(' ').toLowerCase().includes(k));
  if (!filtered.length) return `<tr><td colspan="7" class="empty">没有匹配的物料</td></tr>`;
  return filtered.map(m => {
    // 三种口径分开：胶带母卷看支数/宽度，箱装小卷看箱+散卷，普通物料看数量
    const stock = stockOf(m);
    const modelAndSpec = materialModelSpec(m);
    const measureHint = materialMeasureHint(m);
    const refPrice = m.cost ? (Number(m.cost) * 1.3).toFixed(2) : '';
    return `<tr onclick="applyMaterial(${index},${m.id},'${key}')" style="cursor:pointer">
      <td class="mono">${esc(m.code)}</td>
      <td>${esc(m.name)}</td>
      <td>${modelAndSpec}${measureHint ? `<br><small class="hint">${esc(measureHint)}</small>` : ''}</td>
      <td>${esc(m.typeName || '')}</td>
      <td class="r num">${esc(stock)}</td>
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
  const changedMaterial = Number(it.material_id) !== Number(materialId);
  if (changedMaterial) {
    delete it.qty_whole;
    delete it.qty_sub;
    delete it.price_basis;
    it.qty = 1;
  }
  it.material_id = materialId;
  if (isSplitPack(m) && it.qty_whole === undefined && it.qty_sub === undefined) {
    // 默认不预填整箱/整卷；只输入拆分数量时应只按零散货计数。
    it.qty_whole = '';
    it.qty_sub = '';
    it.qty = 0;
  }
  const cost = Number(m.cost) || 0;
  it.price = it.price || (key === 'in' ? 0
    : m.type === 'master' ? Math.round(cost * 1.25 * 100) / 100
      : Math.round(cost * 1.4 * 100) / 100);
  closeDialog();
  renderDocForm(key);
}

async function saveDoc(key, submit) {
  const conf = DOC_CONF[key];
  const d = Draft.data;
  if (!d.partner_id) return toast('请选择' + conf.partnerLabel, 'err');
  if (!d.warehouse_id) return toast('请选择仓库', 'err');
  if (!d.items.length) return toast('至少添加一行明细', 'err');

  // 同一物料可能分成多行，先按物料合并本单需求，库存校验用合并后的量。
  // 数量为 0 的行不占库存，跳过，也不计入「N 行合计」的行数。
  const docNeed = new Map();
  for (const it of d.items) {
    if (!it.material_id) continue;
    const m = Draft.materials.find(x => x.id === Number(it.material_id)) || {};
    const q = itemQuantity(it, m);
    if (q <= 0) continue;
    const key = Number(it.material_id);
    let agg = docNeed.get(key);
    if (!agg) {
      agg = { rows: 0, qty: 0, cutWidth: 0, wholeQty: 0 };
      docNeed.set(key, agg);
    }
    const cw = Number(it.cut_width) || 0;
    agg.rows += 1;
    agg.qty += q;
    if (cw > 0) agg.cutWidth += cw * q;
    else agg.wholeQty += q;
  }
  const checkedMaterials = new Set();

  // 逐行校验：物料、数量、单价必填；整数限制；库存是否够
  for (let i = 0; i < d.items.length; i++) {
    const it = d.items[i];
    const no = i + 1;
    if (!it.material_id) return toast(`第 ${no} 行还没选物料`, 'err');
    const m = Draft.materials.find(x => x.id === Number(it.material_id)) || {};
    const q = itemQuantity(it, m);
    if (q <= 0) return toast(`第 ${no} 行「${m.name || ''}」数量必须大于 0`, 'err');
    if (isSplitPack(m)) {
      const whole = Number(it.qty_whole) || 0;
      const loose = Number(it.qty_sub) || 0;
      const step = m.sub_unit === '米' ? 0.1 : 1;
      if (whole < 0 || (key !== 'in' && !Number.isInteger(whole))) return toast(`「${m.name}」整单位数量必须是整数`, 'err');
      if (loose < 0 || Math.abs(loose / step - Math.round(loose / step)) > 1e-6) {
        return toast(`「${m.name}」${m.sub_unit}数量最小按 ${step} 递增`, 'err');
      }
    } else if (key !== 'in' && m.type !== 'master' && !Number.isInteger(q)) {
      return toast(`「${m.name}」为整进整出物料，数量必须是整数`, 'err');
    }
    if (m.type === 'master' && m.sub_unit === 'mm' && !Number.isInteger(q)) {
      return toast(`「${m.name}」整支数或分切卷数必须是整数`, 'err');
    }
    if (!(Number(it.price) > 0)) return toast(`第 ${no} 行「${m.name || ''}」单价必须填写`, 'err');

    // 出库和采购退货要扣库存，提交前先核对（同一物料只报一次，用本单合计量）
    if ((key === 'out' || key === 'pret') && !checkedMaterials.has(Number(it.material_id))) {
      checkedMaterials.add(Number(it.material_id));
      const agg = docNeed.get(Number(it.material_id)) || { rows: 1, qty: q, cutWidth: 0, wholeQty: q };
      const rowNote = agg.rows > 1 ? `（本单 ${agg.rows} 行合计）` : '';

      // 胶带母卷（按 mm 分切）：比宽度或整支数
      if (m.type === 'master' && m.sub_unit === 'mm') {
        const cw = Number(it.cut_width) || 0;
        if (cw > 0 && m.base_width && cw > m.base_width) {
          return toast(`「${m.name}」分切宽度 ${cw}mm 超过母卷宽度 ${m.base_width}mm`, 'err');
        }
        const wholeNeed = Math.round(agg.wholeQty);
        if (wholeNeed > (Number(m.roll_count) || 0)) {
          return toast(`「${m.name}」只有 ${m.roll_count || 0} 支整卷，不够出 ${wholeNeed} 支${rowNote}`, 'err');
        }
        if (agg.cutWidth > 0) {
          // 本单先出掉的整支不能再用来分切
          const availWidth = (Number(m.open_width) || 0) - wholeNeed * (Number(m.base_width) || 0);
          if (agg.cutWidth > availWidth + 1e-6) {
            return toast(`「${m.name}」可用宽度只有 ${qty(Math.max(0, availWidth))}mm，本单需要 ${qty(agg.cutWidth)}mm${rowNote}，库存不足`, 'err');
          }
        }
      }
      // 箱装小卷：数量按最小单位（卷）算，可用 = 箱数 × 每箱卷数 + 散卷
      else if (m.type === 'master' && m.sub_unit) {
        const perBox = Number(m.base_width) || 1;
        const availTotal = (Number(m.stock_qty) || 0) * perBox + (Number(m.sub_qty) || 0);
        if (agg.qty > availTotal + 1e-9) {
          return toast(`「${m.name}」可用 ${qty(m.stock_qty || 0)} ${m.unit || ''}`
            + ` + ${m.sub_qty || 0} ${m.sub_unit}（共 ${qty(availTotal)} ${m.sub_unit}），不够出 ${qty(agg.qty)} ${m.sub_unit}${rowNote}`, 'err');
        }
      }
      else if (agg.qty > (Number(m.stock_qty) || 0) + 1e-9) {
        return toast(`「${m.name}」库存只有 ${qty(m.stock_qty || 0)} ${m.unit || ''}，不够出 ${qty(agg.qty)}${rowNote}`, 'err');
      }
    }
  }

  if (submit && !can(conf.permNew) && !can(conf.permEdit)) return toast('没有提交权限', 'err');

  const payload = {
    doc_date: d.doc_date, partner_id: d.partner_id, warehouse_id: d.warehouse_id,
    contract_sn: d.contract_sn, salesperson_id: d.salesperson_id || App.user.id,
    invoice_status: d.invoice_status, carrier: d.carrier, receiver: d.receiver,
    receiver_phone: d.receiver_phone, receiver_addr: d.receiver_addr, remark: d.remark,
    submit,
    items: d.items.map(i => {
      const m = Draft.materials.find(x => x.id === Number(i.material_id)) || {};
      return {
        material_id: i.material_id, qty: itemQuantity(i, m), price: i.price,
        ...(isSplitPack(m) ? {
          qty_whole: Number(i.qty_whole) || 0,
          qty_sub: Number(i.qty_sub) || 0,
          ...(key === 'in' ? { price_basis: i.price_basis || (Number(i.qty_sub) > 0 ? 'sub' : 'pack') } : {})
        } : {}),
        cut_width: i.cut_width || 0, remark: i.remark || ''
      };
    })
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
    // 入库单和采购退货单不显示成本与毛利
    const showCost = can('cost.view') && key !== 'in' && key !== 'pret';
    const items = d.items.map(it => `<tr>
      <td>${esc(it.material_name)}</td>
      <td class="mono">${esc(it.material_code)}</td>
      <td>${materialModelSpec(it)}</td>
      ${key === 'out' && it.material_type === 'master' ? `<td class="num">${it.cut_width ? it.cut_width + 'mm' : '整支'}</td>` : ''}
      <td class="num">${formatItemQuantity(it, key)}</td>
      <td class="r num">${formatItemPrice(it, key)}</td>
      <td class="r num"><b>${money(it.amount)}</b></td>
      ${showCost ? `<td class="r num" style="color:var(--muted)">${formatCostWithUnit(it.cost_price, it)}</td>
      <td class="r num" style="color:var(--muted)">${formatCost(it.cost_amount)}</td>` : ''}
    </tr>`).join('');

    const totalAmount = d.total_amount || 0;
    const totalCost = d.total_cost || 0;
    const profit = totalAmount - totalCost;

    const actions = [];
    // 导出按钮：所有单据都能导出 Excel
    actions.push(`<button class="btn" onclick="exportDoc('${key}',${d.id},'doc')">导出 Excel</button>`);
    if (key === 'out' || key === 'sret') {
      actions.push(`<button class="btn" onclick="exportDoc('${key}',${d.id},'delivery')">导出送货单</button>`);
    }

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
          ${statusTag(d.status)}
          ${key !== 'in' && key !== 'pret' ? payTag(d.pay_status) : ''}
          ${key === 'out' && d.invoice_status ? '<span class="tag info">已开票</span>' : key === 'out' ? '<span class="tag mute">未开票</span>' : ''}
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
          <thead><tr><th>物料</th><th>编号</th><th>型号 / 规格</th>
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
        ${d.status === 'approved' && (key === 'out' || key === 'sret') ? `<div class="hint" style="margin-top:12px">已收付款 ${money(d.paid_amount)}，未结 ${money(totalAmount - (d.paid_amount || 0))}</div>` : ''}
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

/* ---------------- 审核 ---------------- */
async function openAudit(key, id, sn) {
  const conf = DOC_CONF[key];
  try {
    const doc = await api(`${conf.api}/${id}`);
    const rows = (doc.items || []).map((it, i) => `<tr>
      <td class="num" style="color:var(--faint)">${i + 1}</td>
      <td><b>${esc(it.material_name || '')}</b><br><small class="hint">${esc(it.material_code || '')}${materialModelSpec(it) ? ' · ' + materialModelSpec(it) : ''}</small>${materialMeasureHint(it) ? `<br><small class="hint">${esc(materialMeasureHint(it))}</small>` : ''}</td>
      <td class="r num">${formatItemQuantity(it, key)}</td>
      ${it.cut_width ? `<td class="r num">${qty(it.cut_width)}mm</td>` : '<td class="hint">—</td>'}
      <td class="r num">${money(it.price)}</td>
      <td class="r num"><b>${money(it.amount)}</b></td>
    </tr>`);

    openDialog({
      title: `审核 ${conf.title} ${sn}`,
      size: 'lg',
      body: `
        <div class="form-grid" style="margin-bottom:14px">
          <div class="field"><label>日期</label><div>${esc(doc.doc_date)}</div></div>
          <div class="field"><label>${conf.partnerLabel}</label><div>${esc(doc.partner?.name || '')}</div></div>
          <div class="field"><label>制单人</label><div>${esc(doc.creator_name || '')}</div></div>
          <div class="field"><label>金额</label><div><b>${money(doc.total_amount)}</b></div></div>
        </div>
        <table class="items">
          <thead><tr><th style="width:34px"></th><th>物料</th><th class="r">数量</th><th class="r">分切</th><th class="r">单价</th><th class="r">金额</th></tr></thead>
          <tbody>${rows.join('') || '<tr><td colspan="6" class="empty">没有明细</td></tr>'}</tbody>
        </table>
        ${doc.remark ? `<div class="hint" style="margin-top:10px">备注：${esc(doc.remark)}</div>` : ''}
        <div class="field" style="margin-top:16px">
          <label>审核意见（驳回时必填）</label>
          <input class="inp" id="audit-reason" placeholder="通过可不填；驳回请说明原因">
        </div>
        <div class="hint" style="margin-top:8px">通过后库存立即变动；驳回后退回制单人修改。</div>`,
      footer: `
        <button class="btn" onclick="closeDialog()">关闭</button>
        <button class="btn danger" onclick="doAudit(${id},'${key}','reject')">驳回</button>
        <button class="btn primary" onclick="doAudit(${id},'${key}','approve')">审核通过</button>`
    });
  } catch (e) { toast(e.message, 'err'); }
}

async function doAudit(id, key, action) {
  const reason = document.getElementById('audit-reason')?.value || '';
  if (action === 'reject' && !reason.trim()) return toast('驳回必须填写原因', 'err');
  try {
    await api(`/docs/${id}/${action}`, 'POST', { reason });
    closeDialog();
    toast(action === 'approve' ? '审核通过，库存已变动' : '已驳回', 'ok');
    loadDocList(key);
  } catch (e) { toast(e.message, 'err'); }
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

/* ---------------- 导出单据 ---------------- */
/**
 * @param {string} key - out / in / sret / pret
 * @param {number} id - 单据 ID
 * @param {string} kind - 'doc'（正式单据）或 'delivery'（送货单，无金额）
 */
async function exportDoc(key, id, kind) {
  try {
    const url = `/api/export/docs/${key}/${id}?kind=${kind}`;
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + App.token } });
    if (!res.ok) throw new Error('导出失败');

    const blob = await res.blob();
    const disposition = res.headers.get('Content-Disposition') || '';
    let filename = `单据_${id}.xlsx`;
    const match = disposition.match(/filename[^;=\n]*=["']?([^"';\n]*)["']?/);
    if (match && match[1]) filename = decodeURIComponent(match[1]);

    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objUrl;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(objUrl);
    }, 100);
    toast(kind === 'delivery' ? '送货单已导出' : 'Excel 已导出', 'ok');
  } catch (e) {
    toast(e.message, 'err');
  }
}

/* 注册页面 */
page('out', makeDocListPage('out'));
page('in', makeDocListPage('in'));
page('sret', makeDocListPage('sret'));
page('pret', makeDocListPage('pret'));
