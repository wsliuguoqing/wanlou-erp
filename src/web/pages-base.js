/* 基础资料与库存页面：客户、供应商、物料、仓库、库存查询、库存流水、盘点 */
'use strict';

const BaseState = { customers: [], suppliers: [], materials: [], warehouses: [], inv: null };

/* ==================== 客户 ==================== */
page('customers', () => {
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
    <p class="pg-sub">共 ${rows.length} 个客户${App.user.role === 'sales' ? '（只显示你负责的客户）' : ''}</p>
    <div class="bar">
      <input class="inp" style="width:220px" placeholder="搜索名称、联系人、电话" id="cust-kw"
        onkeydown="if(event.key==='Enter')loadCustomers(this.value)">
      <button class="btn" onclick="loadCustomers(document.getElementById('cust-kw').value)">搜索</button>
      <div class="spacer"></div>
      ${can('customer.create') ? `<button class="btn primary" onclick="editCustomer()">＋ 新增客户</button>` : ''}
    </div>
    ${tableWrap([
      { label: '编号' }, { label: '客户名称' }, { label: '联系人' }, { label: '电话' },
      { label: '负责销售' }, { label: '级别' }, { label: '应收余额', r: 1 }, { label: '操作' }
    ], rows, '还没有客户，点右上角新增')}`;
});
page('customers').afterRender = () => loadCustomers();

async function loadCustomers(kw = '') {
  try {
    const d = await api('/customers?keyword=' + encodeURIComponent(kw));
    BaseState.customers = d.list;
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
    <p class="pg-sub">共 ${rows.length} 个供应商</p>
    <div class="bar">
      <input class="inp" style="width:220px" placeholder="搜索名称、联系人" id="sup-kw"
        onkeydown="if(event.key==='Enter')loadSuppliers(this.value)">
      <button class="btn" onclick="loadSuppliers(document.getElementById('sup-kw').value)">搜索</button>
      <div class="spacer"></div>
      ${can('supplier.create') ? `<button class="btn primary" onclick="editSupplier()">＋ 新增供应商</button>` : ''}
    </div>
    ${tableWrap([{ label: '编号' }, { label: '供应商名称' }, { label: '联系人' }, { label: '电话' }, { label: '应付余额', r: 1 }, { label: '操作' }],
      rows, '还没有供应商')}`;
});
page('suppliers').afterRender = () => loadSuppliers();

async function loadSuppliers(kw = '') {
  try {
    const d = await api('/suppliers?keyword=' + encodeURIComponent(kw));
    BaseState.suppliers = d.list;
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
  const rows = (BaseState.materials || []).map(m => `<tr>
    <td class="mono">${esc(m.code)}</td>
    <td>${esc(m.name)}</td>
    <td>${esc(m.brand || '')}</td>
    <td>${esc(m.spec || '')}</td>
    <td>${esc(m.unit)}</td>
    <td><span class="tag ${m.type === 'master' ? 'info' : m.type === 'sub' ? 'wait' : 'mute'}">${esc(m.typeName || '')}</span></td>
    <td class="r num">${m.type === 'master' ? `${m.roll_count || 0} 支` : qty(m.stock_qty)}</td>
    ${showCost ? `<td class="r num">${money(m.cost)}</td>` : ''}
    <td>
      ${can('material.edit') ? `<button class="btn sm" onclick="editMaterial(${m.id})">编辑</button>` : ''}
      ${App.user.role === 'admin' ? `<button class="btn sm danger" onclick="delMaterial(${m.id},'${esc(m.name)}')">删除</button>` : ''}
    </td>
  </tr>`);
  return `
    <h1 class="pg">物料管理</h1>
    <p class="pg-sub">共 ${rows.length} 个物料。母卷可分切，子卷由系统在分切出库时自动创建。</p>
    <div class="bar">
      <input class="inp" style="width:220px" placeholder="搜索名称、编号、规格、条码" id="mat-kw"
        onkeydown="if(event.key==='Enter')loadMaterials(this.value)">
      <select class="inp" style="width:120px" id="mat-type" onchange="loadMaterials(document.getElementById('mat-kw').value,this.value)">
        <option value="">全部类型</option>
        <option value="normal">普通</option>
        <option value="master">母卷</option>
        <option value="sub">子卷</option>
        <option value="product">成品</option>
      </select>
      <button class="btn" onclick="loadMaterials(document.getElementById('mat-kw').value,document.getElementById('mat-type').value)">搜索</button>
      <div class="spacer"></div>
      ${can('material.create') ? `<button class="btn primary" onclick="editMaterial()">＋ 新增物料</button>` : ''}
    </div>
    ${tableWrap([
      { label: '编号' }, { label: '名称' }, { label: '品牌' }, { label: '规格' }, { label: '单位' },
      { label: '类型' }, { label: '库存', r: 1 }, ...(showCost ? [{ label: '成本', r: 1 }] : []), { label: '操作' }
    ], rows, '还没有物料')}`;
});
page('materials').afterRender = () => loadMaterials();

async function loadMaterials(kw = '', type = '') {
  try {
    const d = await api(`/materials?keyword=${encodeURIComponent(kw)}&type=${type}`);
    BaseState.materials = d.list;
    if (d.units) BaseState.units = d.units;
    if (d.types) BaseState.matTypes = d.types;
    if (App.route === 'materials') document.getElementById('page').innerHTML = PAGES.materials();
  } catch (e) { toast(e.message, 'err'); }
}

function editMaterial(id) {
  const m = id ? BaseState.materials.find(x => x.id === id) : {};
  const units = BaseState.units || ['个', '只', '套', '台', '件', '箱', '盒', '包', '卷', '支', '米', '千克', '吨', '付', '张', '片'];
  const isSub = m.type === 'sub' || m.type === 'waste';
  openDialog({
    title: id ? '编辑物料' : '新增物料',
    body: `
    ${isSub ? '<div class="banner" style="margin-bottom:12px">这是系统自动生成的子卷或料头，只能改名称和安全库存。</div>' : ''}
    <div class="form-grid">
      <div class="field"><label>物料名称 *</label>
        <input class="inp" id="m-name" value="${esc(m.name || '')}" placeholder="如 10kV冷缩中间接头"></div>
      <div class="field"><label>型号</label>
        <input class="inp" id="m-spec" value="${esc(m.spec || '')}" placeholder="如 JLS-10/3.1"></div>
      <div class="field"><label>品牌</label>
        <input class="inp" id="m-brand" value="${esc(m.brand || '')}" placeholder="如 3M、长园"></div>
      <div class="field"><label>计量单位 *</label>
        <select class="inp" id="m-unit">
          ${units.map(u => `<option value="${u}" ${(m.unit || '个') === u ? 'selected' : ''}>${u}</option>`).join('')}
        </select></div>
      <div class="field"><label>是否可分割 *</label>
        <select class="inp" id="m-type" onchange="toggleMasterFields()" ${isSub ? 'disabled' : ''}>
          <option value="normal" ${(m.type || 'normal') === 'normal' ? 'selected' : ''}>不可分割（整件出库）</option>
          <option value="master" ${m.type === 'master' ? 'selected' : ''}>可分割（整支按宽度分切）</option>
          ${isSub ? `<option value="${m.type}" selected>${m.type === 'sub' ? '已分切子卷' : '料头'}</option>` : ''}
        </select></div>
      <div class="field"><label>条码</label>
        <input class="inp" id="m-barcode" value="${esc(m.barcode || '')}" placeholder="扫码枪可直接扫入"></div>
      <div class="field"><label>安全库存</label>
        <input class="inp num" id="m-safety" type="number" min="0" step="1" value="${m.safety_stock ?? 0}"
          oninput="onlyPositive(this,0)" onblur="normalizeNum(this)"></div>
      <div class="field" id="m-width-f" style="display:${m.type === 'master' ? 'flex' : 'none'}">
        <label>整支宽度 mm *</label>
        <input class="inp num" id="m-width" type="number" min="0" step="1" value="${m.base_width ?? 1200}"
          oninput="onlyPositive(this,0)"></div>
      <div class="field" id="m-fee-f" style="display:${m.type === 'master' ? 'flex' : 'none'}">
        <label>分切费 元/卷</label>
        <input class="inp num" id="m-fee" type="number" min="0" step="0.01" value="${m.cut_fee ?? 0.5}"
          oninput="onlyPositive(this,2)"></div>
      <div class="field" id="m-waste-f" style="display:${m.type === 'master' ? 'flex' : 'none'}">
        <label>料头阈值 mm</label>
        <input class="inp num" id="m-waste" type="number" min="0" step="1" value="${m.min_waste ?? 10}"
          oninput="onlyPositive(this,0)"></div>
    </div>
    <div class="hint" style="margin-top:12px">
      成本由入库单的进货价自动计算，这里不需要填。可分割物料出库时会按「宽度 × 卷数」扣减整支宽度。
    </div>`,
    footer: `<button class="btn" onclick="closeDialog()">取消</button>
      <button class="btn primary" onclick="saveMaterial(${id || 0})">保存</button>`
  });
}

function toggleMasterFields() {
  const isMaster = document.getElementById('m-type').value === 'master';
  ['m-width-f', 'm-fee-f', 'm-waste-f'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = isMaster ? 'flex' : 'none';
  });
}

async function saveMaterial(id) {
  const type = document.getElementById('m-type').value;
  const body = {
    name: document.getElementById('m-name').value.trim(),
    brand: document.getElementById('m-brand').value,
    spec: document.getElementById('m-spec').value,
    unit: document.getElementById('m-unit').value.trim(),
    type,
    barcode: document.getElementById('m-barcode').value,
    safety_stock: Number(document.getElementById('m-safety').value) || 0
  };
  if (type === 'master') {
    body.base_width = Number(document.getElementById('m-width').value) || 1200;
    body.cut_fee = Number(document.getElementById('m-fee').value) || 0;
    body.min_waste = Number(document.getElementById('m-waste').value) || 10;
  }
  if (!body.name || !body.unit) return toast('名称和单位必填', 'err');
  try {
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
  const showCost = can('cost.view');
  const rows = d.list.map(r => `<tr>
    <td class="mono">${esc(r.code)}</td>
    <td>${esc(r.name)}</td>
    <td>${esc(r.spec || '')}</td>
    <td>${esc(r.unit)}</td>
    <td><span class="tag ${r.type === 'master' ? 'info' : r.type === 'sub' ? 'wait' : 'mute'}">${esc(r.typeName)}</span></td>
    <td class="r num">${r.type === 'master' ? `${r.roll_count} 支` : qty(r.qty)}</td>
    ${r.type === 'master' ? `<td class="r num" style="color:var(--muted)">${qty(r.available_width)} mm</td>` : '<td></td>'}
    ${showCost ? `<td class="r num">${money(r.cost)}</td><td class="r num">${money(r.amount)}</td>` : ''}
    <td>${can('inventory.log') ? `<button class="btn sm" onclick="openInventoryLog(${r.material_id},'${esc(r.name)}')">流水</button>` : ''}
      ${r.type === 'master' ? `<button class="btn sm" onclick="openRolls(${r.material_id},'${esc(r.name)}')">母卷明细</button>` : ''}</td>
  </tr>`);
  return `
    <h1 class="pg">库存查询</h1>
    <p class="pg-sub">母卷按支统计并显示可用总宽度；子卷与普通物料按数量统计</p>
    <div class="stats">
      <div class="stat"><div class="stat-label">物料种类</div><div class="stat-val">${d.stats.kindCount || 0}</div></div>
      ${showCost ? `<div class="stat"><div class="stat-label">库存总金额</div><div class="stat-val green">${money(d.stats.totalAmount)}</div></div>` : ''}
      <div class="stat"><div class="stat-label">低于安全库存</div><div class="stat-val ${d.stats.lowCount ? 'red' : ''}">${d.stats.lowCount || 0}</div></div>
      <div class="stat"><div class="stat-label">零库存物料</div><div class="stat-val">${d.stats.zeroCount || 0}</div></div>
    </div>
    <div class="bar">
      <input class="inp" style="width:220px" placeholder="搜索物料" id="inv-kw" onkeydown="if(event.key==='Enter')loadInventory()">
      <select class="inp" style="width:150px" id="inv-wh">
        <option value="">全部仓库</option>
        ${(d.warehouses || []).map(w => `<option value="${w.id}">${esc(w.name)}</option>`).join('')}
      </select>
      <select class="inp" style="width:120px" id="inv-type">
        <option value="">全部类型</option><option value="master">母卷</option><option value="sub">子卷</option><option value="normal">普通</option>
      </select>
      <button class="btn" onclick="loadInventory()">查询</button>
      <div class="spacer"></div>
      <label class="hint"><input type="checkbox" id="inv-low" onchange="loadInventory()"> 只看低库存</label>
    </div>
    ${tableWrap([
      { label: '编号' }, { label: '名称' }, { label: '规格' }, { label: '单位' }, { label: '类型' },
      { label: '库存', r: 1 }, { label: '可用宽度', r: 1 },
      ...(showCost ? [{ label: '成本', r: 1 }, { label: '金额', r: 1 }] : []),
      { label: '操作' }
    ], rows, '暂无库存数据')}`;
});
page('inventory').afterRender = () => loadInventory();

async function loadInventory() {
  const kw = document.getElementById('inv-kw')?.value || '';
  const wh = document.getElementById('inv-wh')?.value || '';
  const type = document.getElementById('inv-type')?.value || '';
  const low = document.getElementById('inv-low')?.checked ? '1' : '';
  try {
    BaseState.inv = await api(`/inventory?keyword=${encodeURIComponent(kw)}&warehouse_id=${wh}&type=${type}&low=${low}`);
    if (App.route === 'inventory') {
      document.getElementById('page').innerHTML = PAGES.inventory();
      document.getElementById('inv-kw').value = kw;
    }
  } catch (e) { toast(e.message, 'err'); }
}

async function openRolls(materialId, name) {
  try {
    const d = await api('/inventory/rolls?material_id=' + materialId);
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
        ...(showCost ? [{ label: '成本', r: 1 }] : [])], rows, '没有母卷'),
      footer: `<button class="btn" onclick="closeDialog()">关闭</button>`
    });
  } catch (e) { toast(e.message, 'err'); }
}

/* ==================== 库存流水 ==================== */
page('logs', () => {
  const d = BaseState.logs || { list: [] };
  const showCost = can('cost.view');
  const rows = d.list.map(l => `<tr>
    <td class="num">${esc(l.created_at)}</td>
    <td>${esc(l.material_name || '')}</td>
    <td><span class="tag info">${esc(l.doc_type || '')}</span></td>
    <td class="mono">${esc(l.doc_sn || '')}</td>
    <td class="r num">${l.qty_change > 0 ? '+' + qty(l.qty_change) : qty(l.qty_change)}</td>
    <td class="r num">${qty(l.qty_before)}</td>
    <td class="r num">${qty(l.qty_after)}</td>
    ${showCost ? `<td class="r num">${money(l.amount)}</td>` : ''}
    <td class="hint">${esc(l.remark || '')}</td>
  </tr>`);
  return `
    <h1 class="pg">库存流水</h1>
    <p class="pg-sub">记录每一次库存变动，可追溯来源单据</p>
    <div class="bar">
      <select class="inp" style="width:220px" id="log-mat">
        <option value="">全部物料</option>
        ${(BaseState.materials || []).map(m => `<option value="${m.id}">${esc(m.name)} ${esc(m.spec || '')}</option>`).join('')}
      </select>
      <input class="inp" type="date" style="width:150px" id="log-from" value="${monthStart()}">
      <span class="hint">至</span>
      <input class="inp" type="date" style="width:150px" id="log-to" value="${todayStr()}">
      <button class="btn" onclick="loadLogs()">查询</button>
    </div>
    ${tableWrap([
      { label: '时间' }, { label: '物料' }, { label: '类型' }, { label: '单据号' },
      { label: '变动', r: 1 }, { label: '变动前', r: 1 }, { label: '变动后', r: 1 },
      ...(showCost ? [{ label: '金额', r: 1 }] : []), { label: '备注' }
    ], rows, '所选条件下没有流水')}`;
});
page('logs').afterRender = async () => {
  if (!BaseState.materials || !BaseState.materials.length) {
    try { BaseState.materials = (await api('/materials')).list; } catch {}
  }
  loadLogs();
};

async function loadLogs() {
  const mid = document.getElementById('log-mat')?.value || '';
  const from = document.getElementById('log-from')?.value || '';
  const to = document.getElementById('log-to')?.value || '';
  try {
    BaseState.logs = await api(`/inventory/logs?material_id=${mid}&from=${from}&to=${to}`);
    if (App.route === 'logs') document.getElementById('page').innerHTML = PAGES.logs();
  } catch (e) { toast(e.message, 'err'); }
}

async function openInventoryLog(materialId, name) {
  try {
    const d = await api('/inventory/logs?material_id=' + materialId);
    const showCost = can('cost.view');
    const rows = d.list.map(l => `<tr>
      <td class="num">${esc(l.created_at)}</td>
      <td>${esc(l.doc_type || '')}</td>
      <td class="mono">${esc(l.doc_sn || '')}</td>
      <td class="r num">${l.qty_change > 0 ? '+' + qty(l.qty_change) : qty(l.qty_change)}</td>
      <td class="r num">${qty(l.qty_after)}</td>
      ${showCost ? `<td class="r num">${money(l.amount)}</td>` : ''}
      <td class="hint">${esc(l.remark || '')}</td>
    </tr>`);
    openDialog({
      title: `${name} 库存流水`, size: 'lg',
      body: tableWrap([{ label: '时间' }, { label: '类型' }, { label: '单据号' }, { label: '变动', r: 1 },
        { label: '结存', r: 1 }, ...(showCost ? [{ label: '金额', r: 1 }] : []), { label: '备注' }], rows, '没有流水'),
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
      <td class="r num">${qty(it.book_qty)}</td>
      <td class="r num" style="width:110px">${editable
        ? `<input class="inp num" style="text-align:right;padding:4px 6px" type="number" step="0.001" value="${it.real_qty ?? ''}"
             onchange="setCheckItem(${it.id},this.value)">`
        : qty(it.real_qty)}</td>
      <td class="r num" style="color:${it.diff_qty > 0 ? 'var(--brand)' : it.diff_qty < 0 ? 'var(--rust)' : 'inherit'}">${qty(it.diff_qty)}</td>
    </tr>`);
    const btn = c.status === 'pending' && can('check.audit')
      ? `<button class="btn primary" onclick="approveCheck(${c.id})">审核通过并调整库存</button>`
      : editable ? `<button class="btn primary" onclick="saveCheck(${c.id},true)">保存并提交审核</button>` : '';
    openDialog({
      title: `盘点单 ${c.sn}`, size: 'lg',
      body: `<div class="hint" style="margin-bottom:12px">仓库 ${esc(c.warehouse_name)} · 日期 ${esc(c.check_date)} · ${statusTag(c.status)}</div>
        ${tableWrap([{ label: '物料' }, { label: '编号' }, { label: '规格' }, { label: '账面', r: 1 }, { label: '实盘', r: 1 }, { label: '差异', r: 1 }], rows, '没有盘点明细')}`,
      footer: `${btn}<button class="btn" onclick="closeDialog()">关闭</button>`
    });
    window._checkCache = c;
  } catch (e) { toast(e.message, 'err'); }
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
