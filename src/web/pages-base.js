/* 基础资料与库存页面：客户、供应商、物料、仓库、库存查询、库存流水、盘点 */
'use strict';

const BaseState = { customers: [], suppliers: [], materials: [], warehouses: [], salespeople: [], inv: null };

/* ==================== 客户 ==================== */
page('customers', () => {
  const f = filterState('customers');
  const meta = BaseState.custPage;
  const rows = (BaseState.customers || []).map(c => `<tr>
    <td class="mono">${esc(c.code)}</td>
    <td>${esc(c.name)}</td>
    <td>${esc(c.contact || '')}</td>
    <td class="num">${esc(c.phone || '')}</td>
    <td>${esc(c.salesperson_name || '—')}</td>
    <td>${esc(c.level || '')}</td>
    <td class="r num" style="color:${c.receivable > 0 ? 'var(--amber)' : 'inherit'}">${money(c.receivable)}</td>
    <td>
      ${can('customer.edit') ? `<button class="btn sm" onclick="editCustomer(${c.id})">编辑</button>` : ''}
      ${App.user.role === 'admin' ? `<button class="btn sm danger" onclick="delCustomer(${c.id},'${esc(c.name)}')">删除</button>` : ''}
    </td>
  </tr>`);
  return `
    <h1 class="pg">客户管理</h1>
    <p class="pg-sub">共 ${meta ? meta.total : rows.length} 个客户${App.user.role === 'sales' ? '（只显示你负责的客户）' : ''}</p>
    <div class="bar">
      <input class="inp" style="width:220px" placeholder="搜索名称、联系人、电话" id="cust-kw" value="${esc(f.keyword || '')}"
        onkeydown="if(event.key==='Enter')loadCustomers(this.value)">
      ${App.user.role !== 'sales' ? `<select class="inp" style="width:170px" id="cust-sales" onchange="setFilter('customers',{salesperson_id:this.value});loadCustomers()">
        <option value="">全部负责销售</option>
        ${(BaseState.salespeople || []).map(u => `<option value="${u.id}" ${String(f.salesperson_id || '') === String(u.id) ? 'selected' : ''}>${esc(u.name)}${u.employee_no ? `（${esc(u.employee_no)}）` : ''}</option>`).join('')}
      </select>` : ''}
      <button class="btn" onclick="loadCustomers(document.getElementById('cust-kw').value)">搜索</button>
      <div class="spacer"></div>
      ${can('customer.create') ? `<button class="btn primary" onclick="editCustomer()">＋ 新增客户</button>` : ''}
    </div>
    ${tableWrap([
      { label: '编号' }, { label: '客户名称' }, { label: '联系人' }, { label: '电话' },
      { label: '负责销售' }, { label: '级别' }, { label: '应收余额', r: 1 }, { label: '操作' }
    ], rows, '还没有客户，点右上角新增')}
    ${pagerBar('customers', meta, 'loadCustomers', '个')}`;
});
page('customers').afterRender = () => loadCustomers();

async function loadCustomers(kw) {
  if (kw !== undefined) setFilter('customers', { keyword: kw });
  const f = filterState('customers');
  try {
    const qs = new URLSearchParams({ keyword: f.keyword || '', salesperson_id: f.salesperson_id || '', page: pgState('customers').page, size: pgState('customers').size });
    const d = await api('/customers?' + qs);
    BaseState.customers = d.list;
    BaseState.salespeople = d.salespeople || [];
    BaseState.custPage = d.page;
    if (App.route === 'customers') document.getElementById('page').innerHTML = PAGES.customers();
  } catch (e) { toast(e.message, 'err'); }
}

function editCustomer(id) {
  const c = id ? BaseState.customers.find(x => x.id === id) : {};
  const isSales = App.user.role === 'sales';
  openDialog({
    title: id ? '编辑客户' : '新增客户',
    body: `<div class="form-grid">
      <div class="field"><label>客户名称 *</label><input class="inp" id="c-name" value="${esc(c.name || '')}"></div>
      <div class="field"><label>联系人</label><input class="inp" id="c-contact" value="${esc(c.contact || '')}"></div>
      <div class="field"><label>电话</label><input class="inp" id="c-phone" value="${esc(c.phone || '')}"
        placeholder="手机或固话，可带横线" oninput="onlyPhone(this)"></div>
      <div class="field"><label>地址</label><input class="inp" id="c-addr" value="${esc(c.address || '')}"></div>
      <div class="field"><label>客户级别</label>
        <select class="inp" id="c-level">
          ${['A', 'B', 'C'].map(l => `<option ${c.level === l ? 'selected' : ''}>${l}</option>`).join('')}
        </select></div>
      ${!isSales ? `<div class="field"><label>负责销售</label><input class="inp" id="c-sales" value="${c.salesperson_id || ''}" placeholder="用户ID，可留空"></div>` : ''}
      <div class="field" style="grid-column:1/-1"><label>备注</label><input class="inp" id="c-remark" value="${esc(c.remark || '')}"></div>
    </div>`,
    footer: `<button class="btn" onclick="closeDialog()">取消</button>
      <button class="btn primary" onclick="saveCustomer(${id || 0})">保存</button>`
  });
}

async function saveCustomer(id) {
  const body = {
    name: document.getElementById('c-name').value.trim(),
    contact: document.getElementById('c-contact').value,
    phone: document.getElementById('c-phone').value,
    address: document.getElementById('c-addr').value,
    level: document.getElementById('c-level').value,
    remark: document.getElementById('c-remark').value
  };
  const sp = document.getElementById('c-sales');
  if (sp && sp.value) body.salesperson_id = Number(sp.value);
  if (!body.name) return toast('请填写客户名称', 'err');
  try {
    if (id) await api('/customers/' + id, 'PUT', body);
    else await api('/customers', 'POST', body);
    closeDialog(); toast('已保存', 'ok'); loadCustomers();
  } catch (e) { toast(e.message, 'err'); }
}

function delCustomer(id, name) {
  confirmDialog(`确定删除客户「${name}」？有单据记录的客户不允许删除，只能停用。`, async () => {
    try { await api('/customers/' + id, 'DELETE'); toast('已删除', 'ok'); loadCustomers(); }
    catch (e) { toast(e.message, 'err'); }
  }, '确认删除');
}

/* ==================== 供应商 ==================== */
page('suppliers', () => {
  const f = filterState('suppliers');
  const meta = BaseState.supPage;
  const rows = (BaseState.suppliers || []).map(s => `<tr>
    <td class="mono">${esc(s.code)}</td>
    <td>${esc(s.name)}</td>
    <td>${esc(s.contact || '')}</td>
    <td class="num">${esc(s.phone || '')}</td>
    <td class="r num">${money(s.payable)}</td>
    <td>
      ${can('supplier.edit') ? `<button class="btn sm" onclick="editSupplier(${s.id})">编辑</button>` : ''}
      ${App.user.role === 'admin' ? `<button class="btn sm danger" onclick="delSupplier(${s.id},'${esc(s.name)}')">删除</button>` : ''}
    </td>
  </tr>`);
  return `
    <h1 class="pg">供应商管理</h1>
    <p class="pg-sub">共 ${meta ? meta.total : rows.length} 个供应商</p>
    <div class="bar">
      <input class="inp" style="width:220px" placeholder="搜索名称、联系人" id="sup-kw" value="${esc(f.keyword || '')}"
        onkeydown="if(event.key==='Enter')loadSuppliers(this.value)">
      <button class="btn" onclick="loadSuppliers(document.getElementById('sup-kw').value)">搜索</button>
      <div class="spacer"></div>
      ${can('supplier.view') ? `<button class="btn" onclick="downloadMasterFile('suppliers')">导出 Excel</button>` : ''}
      ${can('supplier.create') ? `<button class="btn" onclick="downloadMasterFile('suppliers/template')">下载模板</button>
      <button class="btn" onclick="openMasterImport('suppliers')">批量导入</button>` : ''}
      ${can('supplier.create') ? `<button class="btn primary" onclick="editSupplier()">＋ 新增供应商</button>` : ''}
    </div>
    ${tableWrap([{ label: '编号' }, { label: '供应商名称' }, { label: '联系人' }, { label: '电话' }, { label: '应付余额', r: 1 }, { label: '操作' }],
      rows, '还没有供应商')}
    ${pagerBar('suppliers', meta, 'loadSuppliers', '个')}`;
});
page('suppliers').afterRender = () => loadSuppliers();

async function loadSuppliers(kw) {
  if (kw !== undefined) setFilter('suppliers', { keyword: kw });
  const f = filterState('suppliers');
  try {
    const d = await api('/suppliers?keyword=' + encodeURIComponent(f.keyword || '') + '&' + pgQuery('suppliers'));
    BaseState.suppliers = d.list;
    BaseState.supPage = d.page;
    if (App.route === 'suppliers') document.getElementById('page').innerHTML = PAGES.suppliers();
  } catch (e) { toast(e.message, 'err'); }
}

function editSupplier(id) {
  const s = id ? BaseState.suppliers.find(x => x.id === id) : {};
  openDialog({
    title: id ? '编辑供应商' : '新增供应商',
    body: `<div class="form-grid">
      <div class="field"><label>供应商名称 *</label><input class="inp" id="s-name" value="${esc(s.name || '')}"></div>
      <div class="field"><label>联系人</label><input class="inp" id="s-contact" value="${esc(s.contact || '')}"></div>
      <div class="field"><label>电话</label><input class="inp" id="s-phone" value="${esc(s.phone || '')}"
        placeholder="手机或固话，可带横线" oninput="onlyPhone(this)"></div>
      <div class="field"><label>地址</label><input class="inp" id="s-addr" value="${esc(s.address || '')}"></div>
      <div class="field" style="grid-column:1/-1"><label>备注</label><input class="inp" id="s-remark" value="${esc(s.remark || '')}"></div>
    </div>`,
    footer: `<button class="btn" onclick="closeDialog()">取消</button>
      <button class="btn primary" onclick="saveSupplier(${id || 0})">保存</button>`
  });
}

async function saveSupplier(id) {
  const body = {
    name: document.getElementById('s-name').value.trim(),
    contact: document.getElementById('s-contact').value,
    phone: document.getElementById('s-phone').value,
    address: document.getElementById('s-addr').value,
    remark: document.getElementById('s-remark').value
  };
  if (!body.name) return toast('请填写供应商名称', 'err');
  try {
    if (id) await api('/suppliers/' + id, 'PUT', body);
    else await api('/suppliers', 'POST', body);
    closeDialog(); toast('已保存', 'ok'); loadSuppliers();
  } catch (e) { toast(e.message, 'err'); }
}

function delSupplier(id, name) {
  confirmDialog(`确定删除供应商「${name}」？`, async () => {
    try { await api('/suppliers/' + id, 'DELETE'); toast('已删除', 'ok'); loadSuppliers(); }
    catch (e) { toast(e.message, 'err'); }
  }, '确认删除');
}

/* ==================== 物料 ==================== */
page('materials', () => {
  const showCost = can('cost.view');
  const f = filterState('materials');
  const meta = BaseState.matPage;
  const rows = (BaseState.materials || []).map(m => `<tr>
    <td>${esc(m.name)}</td>
    <td>${esc(m.model_edited ? m.model || '' : m.spec || '')}</td>
    <td>${esc(m.model_edited ? m.spec || '' : '')}</td>
    <td>${esc(m.brand || '')}</td>
    <td>${esc(m.unit)}${m.type === 'master' && m.sub_unit ? `<small class="hint" style="display:block">${m.sub_unit === 'mm' ? `母卷宽度 ${qty(m.base_width)} mm` : `1 ${esc(m.unit)} = ${qty(m.base_width)} ${esc(m.sub_unit)}`}</small>` : ''}</td>
    <td class="mono">${esc(m.code)}</td>
    <td><span class="tag ${m.type === 'master' ? 'info' : m.type === 'sub' ? 'wait' : 'mute'}">${esc(m.typeName || '')}</span></td>
    <td class="r num">${esc(stockOf(m))}</td>
    ${showCost ? `<td class="r num">${money(m.cost)} / ${esc(m.type === 'master' && m.sub_unit && m.sub_unit !== 'mm' ? m.sub_unit : m.unit)}</td>` : ''}
    <td>
      ${can('material.edit') ? `<button class="btn sm" onclick="editMaterial(${m.id})">编辑</button>` : ''}
      ${App.user.role === 'admin' ? `<button class="btn sm danger" onclick="delMaterial(${m.id},'${esc(m.name)}')">删除</button>` : ''}
    </td>
  </tr>`);
  return `
    <h1 class="pg">物料管理</h1>
    <p class="pg-sub">共 ${meta ? meta.total : rows.length} 个物料。整进整出使用一个单位；整进零出按整单位和零单位换算库存。</p>
    <div class="bar">
      <input class="inp" style="width:220px" placeholder="搜索名称、型号、规格、品牌、编号" id="mat-kw" value="${esc(f.keyword || '')}"
        onkeydown="if(event.key==='Enter')loadMaterials(this.value)">
      <select class="inp" style="width:140px" id="mat-type" onchange="loadMaterials(undefined,this.value)">
        <option value="">全部类型</option>
        <option value="normal" ${f.type === 'normal' ? 'selected' : ''}>整进整出</option>
        <option value="master" ${f.type === 'master' ? 'selected' : ''}>整进零出</option>
        <option value="sub" ${f.type === 'sub' ? 'selected' : ''}>已分切子卷</option>
        <option value="waste" ${f.type === 'waste' ? 'selected' : ''}>料头</option>
      </select>
      <button class="btn" onclick="loadMaterials(document.getElementById('mat-kw').value,document.getElementById('mat-type').value)">搜索</button>
      <div class="spacer"></div>
      ${can('material.view') ? `<button class="btn" onclick="downloadMasterFile('materials')">导出 Excel</button>` : ''}
      ${can('material.create') ? `<button class="btn" onclick="downloadMasterFile('materials/template')">下载模板</button>
      <button class="btn" onclick="openMasterImport('materials')">批量导入</button>` : ''}
      ${can('material.create') ? `<button class="btn primary" onclick="editMaterial()">＋ 新增物料</button>` : ''}
    </div>
    ${tableWrap([
      { label: '名称' }, { label: '型号' }, { label: '规格' }, { label: '品牌' }, { label: '单位' }, { label: '编号' },
      { label: '类型' }, { label: '库存', r: 1 }, ...(showCost ? [{ label: '成本', r: 1 }] : []), { label: '操作' }
    ], rows, '还没有物料')}
    ${pagerBar('materials', meta, 'loadMaterials', '个')}`;
});
page('materials').afterRender = () => loadMaterials();

/* ==================== 供应商与物料批量导入导出 ==================== */
const MasterImportConfig = {
  suppliers: { label: '供应商', endpoint: '/import/suppliers', template: '/export/suppliers/template', export: '/export/suppliers', reload: loadSuppliers },
  materials: { label: '物料', endpoint: '/import/materials', template: '/export/materials/template', export: '/export/materials', reload: loadMaterials }
};
const MasterImportState = {};

async function downloadMasterFile(path) {
  try {
    const res = await fetch('/api/export/' + path, {
      headers: App.token ? { Authorization: 'Bearer ' + App.token } : {}
    });
    if (res.status === 401) { logout(true); throw new Error('登录已过期，请重新登录'); }
    if (!res.ok) {
      let message = '下载失败';
      try { message = (await res.json()).message || message; } catch {}
      throw new Error(message);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = decodeURIComponent((res.headers.get('Content-Disposition') || '').match(/filename\*=UTF-8''([^;]+)/i)?.[1] || '')
      || (path.includes('template') ? path.split('/')[1] + '导入模板.xlsx' : path.split('/')[1] + '导出.xlsx');
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  } catch (e) { toast(e.message, 'err'); }
}

function openMasterImport(kind) {
  const conf = MasterImportConfig[kind];
  if (!conf) return;
  MasterImportState[kind] = { filename: '', content: '', preview: null };
  openDialog({
    title: `${conf.label}批量导入`, size: 'lg',
    body: `<p class="hint">请选择按新系统模板填写的 Excel 文件（.xlsx 或 .csv，最大 15MB）。系统会先预览新增、更新和错误行；确认导入前不会写入数据。</p>
      <div class="field" style="margin-top:12px"><label>导入文件</label><input class="inp" id="master-import-file" type="file" accept=".xlsx,.csv" onchange="readMasterImportFile('${kind}',this)"></div>
      <div id="master-import-preview" style="margin-top:14px"></div>`,
    footer: `<button class="btn" onclick="closeDialog()">取消</button>
      <button class="btn" onclick="downloadMasterFile('${kind}/template')">下载导入模板</button>
      <button class="btn primary" id="master-import-preview-btn" disabled onclick="previewMasterImport('${kind}')">检查文件</button>`
  });
}

function readMasterImportFile(kind, input) {
  const file = input.files?.[0];
  const state = MasterImportState[kind];
  const button = document.getElementById('master-import-preview-btn');
  const preview = document.getElementById('master-import-preview');
  if (!file || !state) return;
  state.preview = null;
  if (file.size > 15 * 1024 * 1024) {
    state.content = ''; if (button) button.disabled = true;
    if (preview) preview.innerHTML = '<div class="banner danger">文件超过 15MB，请拆分后导入。</div>';
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    state.filename = file.name;
    state.content = String(reader.result || '').split(',')[1] || '';
    if (button) button.disabled = !state.content;
    if (preview) preview.innerHTML = `<div class="banner">已选择：${esc(file.name)}（${(file.size / 1024).toFixed(1)} KB），点击“检查文件”查看导入结果。</div>`;
  };
  reader.onerror = () => { if (preview) preview.innerHTML = '<div class="banner danger">读取文件失败，请重新选择。</div>'; };
  reader.readAsDataURL(file);
}

function renderMasterImportResult(result, kind, isPreview) {
  const errors = result.errors || [];
  const warnings = result.warnings || [];
  const blocked = errors.length > 0 || result.aborted;
  const importableCount = Number(result.added || 0) + Number(result.updated || 0);
  const summary = `<div class="banner ${blocked ? 'warn' : ''}">
    ${isPreview ? '预览完成' : (result.aborted ? '导入已取消，数据未写入' : '导入完成')}：新增 ${result.added || 0} 条，更新 ${result.updated || 0} 条，跳过 ${result.skipped || 0} 条。
    ${blocked ? '请先修正错误后重新检查；本次不会部分写入。' : (isPreview ? '确认后才会写入数据。' : '')}
  </div>`;
  const errorList = errors.length ? `<div style="max-height:180px;overflow:auto;margin-top:8px"><b>需要处理的行</b><ul>${errors.map(e => `<li>${esc(e)}</li>`).join('')}</ul></div>` : '';
  const warningList = warnings.length ? `<div style="max-height:180px;overflow:auto;margin-top:8px"><b>已跳过的示例行</b><ul>${warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul></div>` : '';
  const emptyMessage = isPreview && !blocked && importableCount === 0
    ? `<div class="banner warn" style="margin-top:8px">没有可导入的实际物料。请删除示例行，或填写实际物料名称（移除“示例：”前缀）后重新检查。</div>` : '';
  const action = isPreview && !blocked && importableCount > 0
    ? `<button class="btn primary" onclick="applyMasterImport('${kind}')">确认导入 ${importableCount} 条</button>`
    : (!isPreview && !result.aborted ? '<button class="btn primary" onclick="closeDialog()">完成</button>' : '');
  return { html: summary + errorList + warningList + emptyMessage, action, blocked };
}

async function previewMasterImport(kind) {
  const state = MasterImportState[kind];
  if (!state?.content) return toast('请先选择导入文件', 'err');
  const box = document.getElementById('master-import-preview');
  if (box) box.innerHTML = '<div class="hint">正在检查文件…</div>';
  try {
    const result = await api(MasterImportConfig[kind].endpoint, 'POST', { filename: state.filename, content: state.content, dryRun: true });
    state.preview = result;
    const rendered = renderMasterImportResult(result, kind, true);
    if (box) box.innerHTML = rendered.html;
    const footer = document.querySelector('#modal-root .dlg-foot');
    if (footer) footer.innerHTML = `<button class="btn" onclick="closeDialog()">取消</button>
      <button class="btn" onclick="downloadMasterFile('${kind}/template')">下载导入模板</button>
      ${rendered.action || `<button class="btn" onclick="previewMasterImport('${kind}')">重新检查</button>`}`;
  } catch (e) {
    if (box) box.innerHTML = `<div class="banner danger">检查失败：${esc(e.message)}</div>`;
  }
}

async function applyMasterImport(kind) {
  const state = MasterImportState[kind];
  if (!state?.preview || (state.preview.errors || []).length || state.preview.aborted) return toast('请先修正文件错误并重新检查', 'err');
  const button = document.querySelector('#modal-root .dlg-foot .btn.primary');
  if (button) { button.disabled = true; button.textContent = '正在导入…'; }
  try {
    const result = await api(MasterImportConfig[kind].endpoint, 'POST', { filename: state.filename, content: state.content, dryRun: false });
    const rendered = renderMasterImportResult(result, kind, false);
    const box = document.getElementById('master-import-preview');
    if (box) box.innerHTML = rendered.html;
    const footer = document.querySelector('#modal-root .dlg-foot');
    if (footer) footer.innerHTML = `<button class="btn" onclick="closeDialog()">${result.aborted ? '关闭' : '完成'}</button>`;
    if (!result.aborted) {
      toast(`${MasterImportConfig[kind].label}导入完成`, 'ok');
      MasterImportConfig[kind].reload();
    }
  } catch (e) {
    if (button) { button.disabled = false; button.textContent = '重试导入'; }
    toast(e.message, 'err');
  }
}

async function loadMaterials(kw, type) {
  if (kw !== undefined || type !== undefined) {
    setFilter('materials', { ...(kw !== undefined ? { keyword: kw } : {}), ...(type !== undefined ? { type } : {}) });
  }
  const f = filterState('materials');
  try {
    const d = await api(`/materials?keyword=${encodeURIComponent(f.keyword || '')}&type=${f.type || ''}&${pgQuery('materials')}`);
    BaseState.materials = d.list;
    BaseState.matPage = d.page;
    if (d.units) BaseState.units = d.units;
    if (d.types) BaseState.matTypes = d.types;
    if (App.route === 'materials') document.getElementById('page').innerHTML = PAGES.materials();
  } catch (e) { toast(e.message, 'err'); }
}

function editMaterial(id) {
  const m = id ? BaseState.materials.find(x => x.id === id) : {};
  const units = BaseState.units || ['个', '只', '套', '台', '件', '箱', '盒', '包', '卷', '支', '米', '千克', '吨', '付', '张', '片'];
  const isSub = m.type === 'sub' || m.type === 'waste';
  // 记住上次选择的单位，新建时默认用它
  const lastUnit = id ? m.unit : (localStorage.getItem('wl_last_unit') || '个');
  openDialog({
    title: id ? '编辑物料' : '新增物料',
    onMount: () => {
      if (id && m.type) document.getElementById('m-type').value = m.type;
      toggleMasterFields();
    },
    body: `
    ${isSub ? '<div class="banner" style="margin-bottom:12px">这是系统自动生成的子卷或料头，只能改名称和安全库存。</div>' : ''}
    <div class="form-grid">
      <div class="field"><label>物料名称 *</label>
        <input class="inp" id="m-name" value="${esc(m.name || '')}" placeholder="如 10kV冷缩中间接头"></div>
      <div class="field"><label>型号</label>
        <input class="inp" id="m-model" value="${esc(m.model_edited ? m.model || '' : m.spec || '')}" placeholder="如 JLS-10/3.1"></div>
      <div class="field"><label>规格</label>
        <input class="inp" id="m-spec" value="${esc(m.model_edited ? m.spec || '' : '')}" placeholder="如 10kV、3.1级"></div>
      <div class="field"><label>品牌</label>
        <input class="inp" id="m-brand" value="${esc(m.brand || '')}" placeholder="如 3M、长园"></div>
      <div class="field"><label id="m-unit-label">计量单位 *</label>
        <select class="inp" id="m-unit">
          ${units.map(u => `<option value="${u}" ${lastUnit === u ? 'selected' : ''}>${u}</option>`).join('')}
        </select></div>
      <div class="field"><label>物料形态 *</label>
        <select class="inp" id="m-type" onchange="toggleMasterFields()" ${isSub ? 'disabled' : ''}>
          <option value="normal" ${!isSub && m.type !== 'master' ? 'selected' : ''}>整进整出（单一单位）</option>
          <option value="master" ${m.type === 'master' ? 'selected' : ''}>整进零出（支持换算拆零）</option>
          ${isSub ? `<option value="${m.type}" selected>${m.type === 'sub' ? '已拆分' : '余料'}</option>` : ''}
        </select>
        <span class="hint">电缆附件等按同一单位进出的选「整进整出」；整箱拆零、整卷按米卖的选「整进零出」。母卷胶带选择 mm 后继续按分切宽度和卷数出库。</span></div>
      <div class="field"><label>条码</label>
        <input class="inp" id="m-barcode" value="${esc(m.barcode || '')}" placeholder="扫码枪可直接扫入"></div>
      <div class="field"><label>安全库存</label>
        <input class="inp num" id="m-safety" type="number" min="0" step="1" value="${m.safety_stock ?? 0}"
          oninput="onlyPositive(this,0)" onblur="normalizeNum(this)"></div>
      <div class="field" id="m-subunit-f" style="display:none">
        <label>零单位 *</label>
        <select class="inp" id="m-subunit" onchange="updateConvHint()">
          ${SUB_UNITS.map(u => `<option value="${u}" ${m.sub_unit === u ? 'selected' : ''}>${u}</option>`).join('')}
        </select>
        <span class="hint">拆零或分切后使用的单位：电工胶带按卷，线缆按米，母卷分切按 mm</span></div>
      <div class="field" id="m-conv-f" style="display:none">
        <label id="m-conv-label">换算比例 *</label>
        <input class="inp num" id="m-conv" type="number" min="0" step="1" value="${m.base_width ?? ''}"
          oninput="onlyPositive(this,0)" placeholder="如 300">
        <span class="hint" id="m-conv-hint"></span></div>
    </div>
    <div class="hint" style="margin-top:12px">
      成本由入库单的进货价自动计算，这里不需要填。
    </div>`,
    footer: `<button class="btn" onclick="closeDialog()">取消</button>
      <button class="btn primary" onclick="saveMaterial(${id || 0})">保存</button>`
  });
}

/** 可分割零售的最小单位选项 */
const SUB_UNITS = ['mm', '卷', '米', '个', '只', '套', '片', '支'];

function toggleMasterFields() {
  const isMaster = document.getElementById('m-type').value === 'master';
  ['m-subunit-f', 'm-conv-f'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = isMaster ? 'flex' : 'none';
  });
  const unitLabel = document.getElementById('m-unit-label');
  if (unitLabel) unitLabel.textContent = isMaster ? '整单位 *' : '计量单位 *';
  if (isMaster) updateConvHint();
}

/** 换算比例的提示跟着单位走：1 箱 = 多少 卷 */
function updateConvHint() {
  const unit = document.getElementById('m-unit')?.value || '';
  const sub = document.getElementById('m-subunit')?.value || '';
  const label = document.getElementById('m-conv-label');
  const hint = document.getElementById('m-conv-hint');
  if (label) label.textContent = `1 ${unit} = 多少 ${sub} *`;
  const input = document.getElementById('m-conv');
  if (input) input.step = sub === '米' ? '0.1' : '1';
  if (hint) {
    hint.textContent = sub === 'mm'
      ? `整支宽度，如 1200`
      : `如一箱 300 ${sub}，填 300；如一卷 50 ${sub}，填 50`;
  }
}

async function saveMaterial(id) {
  const type = document.getElementById('m-type').value;
  const body = {
    name: document.getElementById('m-name').value.trim(),
    model: document.getElementById('m-model').value.trim(),
    brand: document.getElementById('m-brand').value,
    spec: document.getElementById('m-spec').value,
    unit: document.getElementById('m-unit').value.trim(),
    type,
    barcode: document.getElementById('m-barcode').value,
    safety_stock: Number(document.getElementById('m-safety').value) || 0
  };
  if (type === 'master') {
    body.sub_unit = document.getElementById('m-subunit').value;
    body.base_width = Number(document.getElementById('m-conv').value) || 0;
    if (!body.base_width) return toast(`请填写 1 ${body.unit} = 多少 ${body.sub_unit}`, 'err');
  }
  if (!body.name || !body.unit) return toast('名称和单位必填', 'err');
  try {
    // 保存成功后记住单位
    localStorage.setItem('wl_last_unit', body.unit);
    if (id) await api('/materials/' + id, 'PUT', body);
    else await api('/materials', 'POST', body);
    closeDialog(); toast('已保存', 'ok'); loadMaterials();
  } catch (e) { toast(e.message, 'err'); }
}

function delMaterial(id, name) {
  confirmDialog(`确定删除物料「${name}」？`, async () => {
    try { await api('/materials/' + id, 'DELETE'); toast('已删除', 'ok'); loadMaterials(); }
    catch (e) { toast(e.message, 'err'); }
  }, '确认删除');
}

/* ==================== 仓库 ==================== */
page('warehouses', () => {
  const rows = (BaseState.warehouses || []).map(w => `<tr>
    <td class="mono">${w.id}</td>
    <td>${esc(w.name)}</td>
    <td>${esc(w.address || '')}</td>
    <td>${esc(w.keeper || '')}</td>
    <td>${w.status ? '<span class="tag ok">启用</span>' : '<span class="tag mute">停用</span>'}</td>
    <td>
      ${can('warehouse.manage') ? `<button class="btn sm" onclick="editWarehouse(${w.id})">编辑</button>` : ''}
      ${App.user.role === 'admin' ? `<button class="btn sm danger" onclick="delWarehouse(${w.id},'${esc(w.name)}')">删除</button>` : ''}
    </td>
  </tr>`);
  return `
    <h1 class="pg">仓库管理</h1>
    <p class="pg-sub">共 ${rows.length} 个仓库</p>
    <div class="bar">
      <div class="spacer"></div>
      ${can('warehouse.manage') ? `<button class="btn primary" onclick="editWarehouse()">＋ 新增仓库</button>` : ''}
    </div>
    ${tableWrap([{ label: '编号' }, { label: '仓库名称' }, { label: '地址' }, { label: '负责人' }, { label: '状态' }, { label: '操作' }],
      rows, '还没有仓库')}`;
});
page('warehouses').afterRender = () => loadWarehouses();

async function loadWarehouses() {
  try {
    const d = await api('/warehouses');
    BaseState.warehouses = d.list;
    if (App.route === 'warehouses') document.getElementById('page').innerHTML = PAGES.warehouses();
  } catch (e) { toast(e.message, 'err'); }
}

function editWarehouse(id) {
  const w = id ? BaseState.warehouses.find(x => x.id === id) : {};
  openDialog({
    title: id ? '编辑仓库' : '新增仓库',
    size: 'sm',
    body: `<div class="field" style="margin-bottom:12px"><label>仓库名称 *</label><input class="inp" id="w-name" value="${esc(w.name || '')}"></div>
      <div class="field" style="margin-bottom:12px"><label>地址</label><input class="inp" id="w-addr" value="${esc(w.address || '')}"></div>
      <div class="field"><label>负责人</label><input class="inp" id="w-keeper" value="${esc(w.keeper || '')}"></div>`,
    footer: `<button class="btn" onclick="closeDialog()">取消</button>
      <button class="btn primary" onclick="saveWarehouse(${id || 0})">保存</button>`
  });
}

function delWarehouse(id, name) {
  confirmDialog(`确定删除仓库「${name}」？如果该仓库有库存或关联单据，系统会拒绝并提示你改用停用。`, async () => {
    try { await api('/warehouses/' + id, 'DELETE'); toast('已删除', 'ok'); loadWarehouses(); }
    catch (e) { toast(e.message, 'err'); }
  }, '确认删除仓库');
}

async function saveWarehouse(id) {
  const body = {
    name: document.getElementById('w-name').value.trim(),
    address: document.getElementById('w-addr').value,
    keeper: document.getElementById('w-keeper').value
  };
  if (!body.name) return toast('请填写仓库名称', 'err');
  try {
    if (id) await api('/warehouses/' + id, 'PUT', body);
    else await api('/warehouses', 'POST', body);
    closeDialog(); toast('已保存', 'ok'); loadWarehouses();
  } catch (e) { toast(e.message, 'err'); }
}

/* ==================== 库存查询 ==================== */
page('inventory', () => {
  const d = BaseState.inv || { list: [], stats: {}, warehouses: [] };
  const rows = d.list.map(r => {
    // 显示：胶带母卷显示支数及余宽，整进零出显示整零库存和换算比例。
    let qtyCell, widthCell;
    if (r.type === 'master' && r.sub_unit === 'mm') {
      qtyCell = `${r.roll_count} 支`;
      widthCell = `<td class="r num" style="color:var(--muted)">${qty(r.available_width)} mm</td>`;
    } else if (r.type === 'master' && r.sub_unit) {
      qtyCell = `${qty(r.qty)} ${r.unit}` + (r.sub_qty > 0 ? ` + ${r.sub_qty} ${r.sub_unit}` : '');
      widthCell = `<td class="hint">1 ${esc(r.unit)} = ${qty(r.base_width)} ${esc(r.sub_unit)}</td>`;
    } else {
      qtyCell = qty(r.qty);
      widthCell = '<td></td>';
    }
    // 操作按钮：所有物料都有"流水"，只有胶带母卷（sub_unit='mm'）才显示"母卷明细"
    const logBtn = can('inventory.log') ? `<button class="btn sm" onclick="openInventoryLog(${r.material_id},'${esc(r.name)}')">流水</button>` : '';
    const rollBtn = (r.type === 'master' && r.sub_unit === 'mm') ? `<button class="btn sm" onclick="openRolls(${r.material_id},'${esc(r.name)}')">母卷明细</button>` : '';
    return `<tr>
    <td class="mono">${esc(r.code)}</td>
    <td>${esc(r.name)}</td>
    <td>${esc(r.model_edited ? r.model || '' : r.spec || '')}${r.model_edited && r.spec ? `<small class="hint" style="display:block">${esc(r.spec)}</small>` : ''}</td>
    ${can('material.create') ? `<td>${esc(r.uploader_name || '—')}</td>` : ''}
    <td>${esc(r.unit)}</td>
    <td><span class="tag ${r.type === 'master' ? 'info' : r.type === 'sub' ? 'wait' : 'mute'}">${esc(r.typeName)}</span></td>
    <td class="r num">${qtyCell}</td>
    ${widthCell}
    <td>${logBtn} ${rollBtn}</td>
  </tr>`;
  });
  return `
    <h1 class="pg">库存查询</h1>
    <p class="pg-sub">整进零出库存按整单位和零单位显示；胶带母卷按支数及可用宽度统计</p>
    <div class="stats">
      <div class="stat"><div class="stat-label">物料种类</div><div class="stat-val">${d.stats.kindCount || 0}</div></div>
      <div class="stat"><div class="stat-label">低于安全库存</div><div class="stat-val ${d.stats.lowCount ? 'red' : ''}">${d.stats.lowCount || 0}</div></div>
      <div class="stat"><div class="stat-label">零库存物料</div><div class="stat-val">${d.stats.zeroCount || 0}</div></div>
    </div>
    <div class="bar">
      <input class="inp" style="width:220px" placeholder="搜索物料" id="inv-kw" value="${esc(filterState('inventory').keyword || '')}"
        onkeydown="if(event.key==='Enter')loadInventory(true)">
      <input class="inp" style="width:140px" placeholder="品牌" id="inv-brand" value="${esc(filterState('inventory').brand || '')}"
        onkeydown="if(event.key==='Enter')loadInventory(true)">
      <select class="inp" style="width:150px" id="inv-wh">
        <option value="">全部仓库</option>
        ${(d.warehouses || []).map(w => `<option value="${w.id}" ${String(filterState('inventory').wh) === String(w.id) ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}
      </select>
      <select class="inp" style="width:120px" id="inv-type">
        <option value="">全部类型</option><option value="master" ${filterState('inventory').type === 'master' ? 'selected' : ''}>整进零出</option>
        <option value="sub" ${filterState('inventory').type === 'sub' ? 'selected' : ''}>已拆分</option>
        <option value="normal" ${filterState('inventory').type === 'normal' ? 'selected' : ''}>整进整出</option>
      </select>
      ${can('material.create') ? `<select class="inp" style="width:160px" id="inv-uploader">
        <option value="">全部上传员工</option>
        ${(d.uploaders || []).map(u => `<option value="${u.id}" ${String(filterState('inventory').uploaded_by || '') === String(u.id) ? 'selected' : ''}>${esc(u.name)}${u.employee_no ? `（${esc(u.employee_no)}）` : ''}</option>`).join('')}
      </select>` : ''}
      <button class="btn" onclick="loadInventory(true)">查询</button>
      <div class="spacer"></div>
      <label class="hint"><input type="checkbox" id="inv-low" ${filterState('inventory').low ? 'checked' : ''} onchange="loadInventory(true)"> 只看低库存</label>
    </div>
    ${tableWrap([
      { label: '编号' }, { label: '名称' }, { label: '规格' }, ...(can('material.create') ? [{ label: '上传员工' }] : []), { label: '单位' }, { label: '类型' },
      { label: '库存', r: 1 }, { label: '换算 / 余宽' },
      { label: '操作' }
    ], rows, '暂无库存数据')}
    ${pagerBar('inventory', d.page, 'loadInventory', '种')}`;
});
page('inventory').afterRender = () => loadInventory();

/** reset=true 表示改了筛选条件：回到第 1 页重新查 */
async function loadInventory(reset) {
  if (reset) {
    setFilter('inventory', {
      keyword: document.getElementById('inv-kw')?.value || '',
      brand: document.getElementById('inv-brand')?.value || '',
      uploaded_by: document.getElementById('inv-uploader')?.value || '',
      wh: document.getElementById('inv-wh')?.value || '',
      type: document.getElementById('inv-type')?.value || '',
      low: !!document.getElementById('inv-low')?.checked
    });
  }
  const f = filterState('inventory');
  try {
    const qs = new URLSearchParams({ keyword: f.keyword || '', brand: f.brand || '', uploaded_by: f.uploaded_by || '',
      warehouse_id: f.wh || '', type: f.type || '', low: f.low ? '1' : '' });
    BaseState.inv = await api(`/inventory?${qs}&${pgQuery('inventory')}`);
    if (App.route === 'inventory') document.getElementById('page').innerHTML = PAGES.inventory();
  } catch (e) { toast(e.message, 'err'); }
}

async function openRolls(materialId, name) {
  BaseState.rollsMat = { id: materialId, name };
  await loadRolls(true);
}

async function loadRolls(reset) {
  if (reset) setFilter('rolls', {}, 1);
  const { id, name } = BaseState.rollsMat || {};
  if (!id) return;
  try {
    const pg = filterState('rolls').page || 1;
    const sz = filterState('rolls').size || 50;
    const d = await api(`/inventory/rolls?material_id=${id}&page=${pg}&size=${sz}`);
    const showCost = can('cost.view');
    const rows = d.list.map(r => `<tr>
      <td class="mono">#${r.id}</td>
      <td>${esc(r.warehouse_name)}</td>
      <td class="num">${qty(r.width_total)}</td>
      <td class="num">${qty(r.width_used)}</td>
      <td class="num"><b>${qty(r.remain_width)}</b></td>
      <td><span class="tag ${r.status === 'open' ? 'ok' : r.status === 'waste' ? 'wait' : 'mute'}">${
        r.status === 'open' ? '可用' : r.status === 'waste' ? '料头' : '已用完'}</span></td>
      ${showCost ? `<td class="r num">${money(r.cost)}</td>` : ''}
    </tr>`);
    openDialog({
      title: `${name} 母卷明细`, size: 'lg',
      body: tableWrap([{ label: '卷号' }, { label: '仓库' }, { label: '总宽mm' }, { label: '已用mm' }, { label: '剩余mm', r: 1 }, { label: '状态' },
        ...(showCost ? [{ label: '成本', r: 1 }] : [])], rows, '没有母卷')
        + pagerBar('rolls', d.page, 'loadRolls', '支'),
      footer: `<button class="btn" onclick="closeDialog()">关闭</button>`
    });
  } catch (e) { toast(e.message, 'err'); }
}

/* ==================== 库存流水 ==================== */
page('logs', () => {
  const d = BaseState.logs || { list: [] };
  const f = filterState('logs');
  const showCost = can('cost.view');
  const rows = d.list.map(l => `<tr>
    <td class="num">${esc(l.created_at)}</td>
    <td>${esc(l.material_name || '')}</td>
    <td><span class="tag info">${esc(l.doc_type || '')}</span></td>
    <td class="mono">${esc(l.doc_sn || '')}</td>
    <td class="r num">${l.qty_change > 0 ? '+' + qty(l.qty_change) : qty(l.qty_change)}${l.material_type === 'master' && l.sub_unit && l.sub_unit !== 'mm' ? ' ' + esc(l.sub_unit) : ''}</td>
    <td class="r num">${qty(l.qty_before)}${l.material_type === 'master' && l.sub_unit && l.sub_unit !== 'mm' ? ' ' + esc(l.sub_unit) : ''}</td>
    <td class="r num">${qty(l.qty_after)}${l.material_type === 'master' && l.sub_unit && l.sub_unit !== 'mm' ? ' ' + esc(l.sub_unit) : ''}</td>
    ${showCost ? `<td class="r num">${money(l.amount)}</td>` : ''}
    <td class="hint">${esc(l.remark || '')}</td>
  </tr>`);
  return `
    <h1 class="pg">库存流水</h1>
    <p class="pg-sub">记录每一次库存变动，可追溯来源单据</p>
    <div class="bar">
      <select class="inp" style="width:220px" id="log-mat">
        <option value="">全部物料</option>
        ${(BaseState.materialOptions || []).map(m => `<option value="${m.id}" ${String(f.mid) === String(m.id) ? 'selected' : ''}>${esc(m.name)} ${esc(m.spec || '')}</option>`).join('')}
      </select>
      <input class="inp" type="date" style="width:150px" id="log-from" value="${esc(f.from || monthStart())}">
      <span class="hint">至</span>
      <input class="inp" type="date" style="width:150px" id="log-to" value="${esc(f.to || todayStr())}">
      <button class="btn" onclick="loadLogs(true)">查询</button>
    </div>
    ${tableWrap([
      { label: '时间' }, { label: '物料' }, { label: '类型' }, { label: '单据号' },
      { label: '变动', r: 1 }, { label: '变动前', r: 1 }, { label: '变动后', r: 1 },
      ...(showCost ? [{ label: '金额', r: 1 }] : []), { label: '备注' }
    ], rows, '所选条件下没有流水')}
    ${pagerBar('logs', d.page, 'loadLogs')}`;
});
page('logs').afterRender = async () => {
  if (!BaseState.materialOptions || !BaseState.materialOptions.length) {
    try { BaseState.materialOptions = (await api('/materials?all=1')).list; } catch {}
  }
  loadLogs();
};

/** reset=true 表示点了查询：读当前筛选框并回到第 1 页 */
async function loadLogs(reset) {
  if (reset) {
    setFilter('logs', {
      mid: document.getElementById('log-mat')?.value || '',
      from: document.getElementById('log-from')?.value || '',
      to: document.getElementById('log-to')?.value || ''
    });
  }
  const f = filterState('logs');
  try {
    BaseState.logs = await api(`/inventory/logs?material_id=${f.mid || ''}&from=${f.from || ''}&to=${f.to || ''}&${pgQuery('logs')}`);
    if (App.route === 'logs') document.getElementById('page').innerHTML = PAGES.logs();
  } catch (e) { toast(e.message, 'err'); }
}

async function openInventoryLog(materialId, name) {
  BaseState.invLogMat = { id: materialId, name };
  await loadInventoryLog(true);
}

async function loadInventoryLog(reset) {
  if (reset) setFilter('invLog', {}, 1);
  const { id, name } = BaseState.invLogMat || {};
  if (!id) return;
  try {
    const pg = filterState('invLog').page || 1;
    const sz = filterState('invLog').size || 50;
    const d = await api(`/inventory/logs?material_id=${id}&page=${pg}&size=${sz}`);
    const showCost = can('cost.view');
    const rows = d.list.map(l => `<tr>
      <td class="num">${esc(l.created_at)}</td>
      <td>${esc(l.doc_type || '')}</td>
      <td class="mono">${esc(l.doc_sn || '')}</td>
      <td class="r num">${l.qty_change > 0 ? '+' + qty(l.qty_change) : qty(l.qty_change)}${l.material_type === 'master' && l.sub_unit && l.sub_unit !== 'mm' ? ' ' + esc(l.sub_unit) : ''}</td>
      <td class="r num">${qty(l.qty_after)}${l.material_type === 'master' && l.sub_unit && l.sub_unit !== 'mm' ? ' ' + esc(l.sub_unit) : ''}</td>
      ${showCost ? `<td class="r num">${money(l.amount)}</td>` : ''}
      <td class="hint">${esc(l.remark || '')}</td>
    </tr>`);
    openDialog({
      title: `${name} 库存流水`, size: 'lg',
      body: tableWrap([{ label: '时间' }, { label: '类型' }, { label: '单据号' }, { label: '变动', r: 1 },
        { label: '结存', r: 1 }, ...(showCost ? [{ label: '金额', r: 1 }] : []), { label: '备注' }], rows, '没有流水')
        + pagerBar('invLog', d.page, 'loadInventoryLog', '条'),
      footer: `<button class="btn" onclick="closeDialog()">关闭</button>`
    });
  } catch (e) { toast(e.message, 'err'); }
}

/* ==================== 盘点 ==================== */
page('checks', () => {
  const d = BaseState.checks || { list: [] };
  const rows = d.list.map(c => `<tr>
    <td><a onclick="openCheck(${c.id})">${esc(c.sn)}</a></td>
    <td class="num">${esc(c.check_date)}</td>
    <td>${esc(c.warehouse_name || '')}</td>
    <td class="num">${qty(c.total_gain)}</td>
    <td class="num">${qty(c.total_loss)}</td>
    ${can('cost.view') ? `<td class="r num">${money(c.gain_amount)} / ${money(c.loss_amount)}</td>` : ''}
    <td>${statusTag(c.status)}</td>
    <td>${esc(c.creator_name || '')}</td>
    <td><button class="btn sm" onclick="openCheck(${c.id})">查看</button></td>
  </tr>`);
  return `
    <h1 class="pg">库存盘点</h1>
    <p class="pg-sub">盘点单审核通过后按差异自动调整库存</p>
    <div class="bar">
      <div class="spacer"></div>
      ${can('check.create') ? `<button class="btn primary" onclick="newCheck()">＋ 新建盘点单</button>` : ''}
    </div>
    ${tableWrap([{ label: '盘点单号' }, { label: '日期' }, { label: '仓库' }, { label: '盘盈', r: 1 }, { label: '盘亏', r: 1 },
      ...(can('cost.view') ? [{ label: '盈亏金额', r: 1 }] : []), { label: '状态' }, { label: '制单人' }, { label: '操作' }],
      rows, '还没有盘点单')}`;
});
page('checks').afterRender = () => loadChecks();

async function loadChecks() {
  try {
    BaseState.checks = await api('/checks');
    if (App.route === 'checks') document.getElementById('page').innerHTML = PAGES.checks();
  } catch (e) { toast(e.message, 'err'); }
}

async function newCheck() {
  try {
    if (!BaseState.warehouses.length) BaseState.warehouses = (await api('/warehouses')).list;
    openDialog({
      title: '新建盘点单', size: 'sm',
      body: `<div class="field" style="margin-bottom:12px"><label>盘点仓库 *</label>
        <select class="inp" id="ck-wh">${BaseState.warehouses.map(w => `<option value="${w.id}">${esc(w.name)}</option>`).join('')}</select></div>
        <div class="field" style="margin-bottom:12px"><label>盘点日期</label><input class="inp" type="date" id="ck-date" value="${todayStr()}"></div>
        <div class="field"><label>备注</label><input class="inp" id="ck-remark"></div>`,
      footer: `<button class="btn" onclick="closeDialog()">取消</button>
        <button class="btn primary" onclick="createCheck()">生成盘点单</button>`
    });
  } catch (e) { toast(e.message, 'err'); }
}

async function createCheck() {
  try {
    const d = await api('/checks', 'POST', {
      warehouse_id: Number(document.getElementById('ck-wh').value),
      check_date: document.getElementById('ck-date').value,
      remark: document.getElementById('ck-remark').value
    });
    closeDialog(); toast('盘点单已生成，请填写实盘数量', 'ok');
    openCheck(d.id);
    loadChecks();
  } catch (e) { toast(e.message, 'err'); }
}

async function openCheck(id) {
  try {
    const c = await api('/checks/' + id);
    const editable = ['draft', 'pending'].includes(c.status) && can('check.create');
    const rows = c.items.map((it, i) => `<tr>
      <td>${esc(it.material_name)}</td>
      <td class="mono">${esc(it.material_code)}</td>
      <td>${esc(it.spec || '')}</td>
      <td class="r num">${checkQtyText(it, it.book_qty)}</td>
      <td class="r num" style="width:110px">${editable
        ? `<input class="inp num" style="text-align:right;padding:4px 6px" type="number" step="${it.material_type === 'master' && it.sub_unit && it.sub_unit !== 'mm' ? (it.sub_unit === '米' ? '0.1' : '1') : '0.001'}" value="${it.real_qty ?? ''}"
             onchange="setCheckItem(${it.id},this.value)">`
        : checkQtyText(it, it.real_qty)}</td>
      <td class="r num" style="color:${it.diff_qty > 0 ? 'var(--brand)' : it.diff_qty < 0 ? 'var(--rust)' : 'inherit'}">${checkQtyText(it, it.diff_qty)}</td>
    </tr>`);
    const btn = c.status === 'pending' && can('check.audit')
      ? `<button class="btn primary" onclick="approveCheck(${c.id})">审核通过并调整库存</button>`
      : editable ? `<button class="btn primary" onclick="saveCheck(${c.id},true)">保存并提交审核</button>` : '';
    openDialog({
      title: `盘点单 ${c.sn}`, size: 'lg',
      body: `<div class="hint" style="margin-bottom:12px">仓库 ${esc(c.warehouse_name)} · 日期 ${esc(c.check_date)} · ${statusTag(c.status)}</div>
        ${tableWrap([{ label: '物料' }, { label: '编号' }, { label: '规格' }, { label: '账面（整 + 零）', r: 1 }, { label: '实盘（零单位）', r: 1 }, { label: '差异', r: 1 }], rows, '没有盘点明细')}`,
      footer: `${btn}<button class="btn" onclick="closeDialog()">关闭</button>`
    });
    window._checkCache = c;
  } catch (e) { toast(e.message, 'err'); }
}

function checkQtyText(it, value) {
  if (it.material_type === 'master' && it.sub_unit && it.sub_unit !== 'mm') {
    const perPack = Number(it.base_width) || 1;
    const total = Number(value) || 0;
    const absTotal = Math.abs(total);
    const whole = Math.floor((absTotal + 1e-8) / perPack);
    const loose = absTotal - whole * perPack;
    const sign = total < 0 ? '−' : '';
    const join = total < 0 ? ' − ' : ' + ';
    return `${sign}${whole} ${esc(it.unit)}${join}${qty(loose)} ${esc(it.sub_unit)}`;
  }
  const unit = it.material_type === 'master' && it.sub_unit === 'mm' ? '支' : (it.unit || '');
  return `${qty(value)} ${esc(unit)}`;
}

function setCheckItem(itemId, val) {
  const c = window._checkCache;
  const it = c.items.find(x => x.id === itemId);
  if (it) it.real_qty = Number(val);
}

async function saveCheck(id, submit) {
  const c = window._checkCache;
  try {
    await api('/checks/' + id, 'PUT', {
      items: c.items.map(i => ({ id: i.id, real_qty: i.real_qty })),
      submit
    });
    closeDialog(); toast(submit ? '已提交审核' : '已保存', 'ok'); loadChecks();
  } catch (e) { toast(e.message, 'err'); }
}

async function approveCheck(id) {
  try {
    await api(`/checks/${id}/approve`, 'POST');
    closeDialog(); toast('盘点已通过，库存已调整', 'ok'); loadChecks();
  } catch (e) { toast(e.message, 'err'); }
}
