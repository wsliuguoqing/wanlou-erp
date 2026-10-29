/* 系统管理页面：员工、角色权限、操作日志、系统设置、我的账号 */
'use strict';

const AdminState = { users: [], roles: null, logs: [], settings: {} };

/* ==================== 员工管理 ==================== */
page('users', () => {
  const rows = (AdminState.users || []).map(u => `<tr>
    <td class="mono">${esc(u.username)}</td>
    <td>${esc(u.name)}</td>
    <td class="mono">${esc(u.employee_no || '—')}</td>
    <td><span class="tag ${u.role === 'admin' ? 'no' : 'info'}">${ROLE_NAME[u.role] || u.role}</span></td>
    <td class="num">${esc(u.phone || '')}</td>
    <td>${u.status ? '<span class="tag ok">启用</span>' : '<span class="tag mute">停用</span>'}</td>
    <td class="num">${esc(u.last_login_at || '从未登录')}</td>
    <td>
      <button class="btn sm" onclick="editUser(${u.id})">编辑</button>
      <button class="btn sm" onclick="resetPwd(${u.id},'${esc(u.username)}')">重置密码</button>
      <button class="btn sm" onclick="toggleUser(${u.id},${u.status ? 0 : 1},'${esc(u.username)}')">${u.status ? '停用' : '启用'}</button>
      ${u.role !== 'admin' ? `<button class="btn sm danger" onclick="delUser(${u.id},'${esc(u.username)}')">删除</button>` : ''}
    </td>
  </tr>`);
  return `
    <h1 class="pg">员工管理</h1>
    <p class="pg-sub">只有超级管理员可以管理员工账号。新增员工时设定初始密码，员工登录后可自行修改。</p>
    <div class="bar">
      <input class="inp" style="width:200px" placeholder="搜索账号、姓名、工号、电话" id="u-kw" onkeydown="if(event.key==='Enter')loadUsers(this.value)">
      <select class="inp" style="width:140px" id="u-role" onchange="loadUsers(document.getElementById('u-kw').value)">
        <option value="">全部角色</option>
        ${Object.entries(ROLE_NAME).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}
      </select>
      <button class="btn" onclick="loadUsers(document.getElementById('u-kw').value)">搜索</button>
      <div class="spacer"></div>
      <button class="btn primary" onclick="editUser()">＋ 新增员工</button>
    </div>
    ${tableWrap([{ label: '账号' }, { label: '姓名' }, { label: '工号' }, { label: '角色' }, { label: '电话' }, { label: '状态' }, { label: '最后登录' }, { label: '操作' }],
      rows, '还没有员工')}`;
});
page('users').afterRender = () => loadUsers();

async function loadUsers(kw = '') {
  const role = document.getElementById('u-role')?.value || '';
  try {
    const d = await api(`/users?keyword=${encodeURIComponent(kw)}&role=${role}`);
    AdminState.users = d.list;
    if (App.route === 'users') document.getElementById('page').innerHTML = PAGES.users();
  } catch (e) { toast(e.message, 'err'); }
}

function editUser(id) {
  const u = id ? AdminState.users.find(x => x.id === id) : {};
  openDialog({
    title: id ? '编辑员工' : '新增员工',
    body: `<div class="form-grid">
      <div class="field"><label>登录账号 *</label>
        <input class="inp" id="u-username" value="${esc(u.username || '')}" ${id ? 'readonly' : ''} placeholder="字母或数字，3-20位"></div>
      <div class="field"><label>姓名 *</label><input class="inp" id="u-name" value="${esc(u.name || '')}"></div>
      <div class="field"><label>员工工号 *</label><input class="inp" id="u-employee-no" value="${esc(u.employee_no || '')}" placeholder="用于生成出库单号"></div>
      <div class="field"><label>角色 *</label>
        <select class="inp" id="u-role-sel">
          ${Object.entries(ROLE_NAME).map(([k, v]) => `<option value="${k}" ${u.role === k ? 'selected' : ''}>${v}</option>`).join('')}
        </select></div>
      <div class="field"><label>手机号</label><input class="inp" id="u-phone" value="${esc(u.phone || '')}"
        placeholder="11 位手机号" maxlength="11" oninput="onlyMobile(this)"></div>
      ${!id ? `<div class="field"><label>初始密码 *</label><input class="inp" id="u-pwd" value="123456" placeholder="至少6位"></div>` : ''}
    </div>
    <div class="hint" style="margin-top:12px">角色决定这个账号能看什么、能做什么。可在「角色权限」页面调整各角色的具体权限。</div>`,
    footer: `<button class="btn" onclick="closeDialog()">取消</button>
      <button class="btn primary" onclick="saveUser(${id || 0})">保存</button>`
  });
}

async function saveUser(id) {
  const body = {
    name: document.getElementById('u-name').value.trim(),
    employee_no: document.getElementById('u-employee-no').value.trim(),
    role: document.getElementById('u-role-sel').value,
    phone: document.getElementById('u-phone').value
  };
  if (!id) {
    body.username = document.getElementById('u-username').value.trim();
    body.password = document.getElementById('u-pwd').value;
    if (!body.username) return toast('请填写登录账号', 'err');
    if (!body.password || body.password.length < 6) return toast('初始密码至少 6 位', 'err');
  }
  if (!body.name) return toast('请填写姓名', 'err');
  if (!body.employee_no) return toast('请填写员工工号', 'err');
  try {
    if (id) await api('/users/' + id, 'PUT', body);
    else await api('/users', 'POST', body);
    closeDialog(); toast('已保存', 'ok'); loadUsers();
  } catch (e) { toast(e.message, 'err'); }
}

function resetPwd(id, username) {
  promptDialog({
    title: `重置 ${username} 的密码`, label: '新密码（至少6位）', value: '123456',
    onOk: async (pwd) => {
      if (!pwd || pwd.length < 6) return toast('密码至少 6 位', 'err');
      try {
        await api(`/users/${id}/reset-password`, 'POST', { password: pwd });
        toast(`密码已重置为 ${pwd}`, 'ok');
      } catch (e) { toast(e.message, 'err'); }
    }
  });
}

async function toggleUser(id, status, username) {
  confirmDialog(`确定${status ? '启用' : '停用'}账号「${username}」？`, async () => {
    try { await api(`/users/${id}/status`, 'POST', { status }); toast('已更新', 'ok'); loadUsers(); }
    catch (e) { toast(e.message, 'err'); }
  });
}

function delUser(id, username) {
  confirmDialog(`确定删除账号「${username}」？有单据记录的账号无法删除，请改为停用。`, async () => {
    try { await api('/users/' + id, 'DELETE'); toast('已删除', 'ok'); loadUsers(); }
    catch (e) { toast(e.message, 'err'); }
  }, '确认删除');
}

/* ==================== 角色权限 ==================== */
const PERM_GROUP = {
  outbound: '出库单', inbound: '入库单', sret: '销售退货', pret: '采购退货',
  customer: '客户', supplier: '供应商', material: '物料', warehouse: '仓库',
  inventory: '库存', check: '盘点', report: '报表', ar: '应收', ap: '应付',
  payment: '收付款', cost: '成本利润', user: '员工', log: '日志',
  setting: '系统设置', backup: '备份', migration: '迁移'
};
const PERM_ACTION = {
  view: '查看', create: '新增', edit: '编辑', delete: '删除', audit: '审核',
  void: '作废', invoice: '开票', pay: '付款', manage: '管理', receive: '收款'
};

page('roles', () => {
  const roles = ['sales', 'purchaser', 'finance', 'manager', 'admin'];
  return `
    <h1 class="pg">角色权限</h1>
    <p class="pg-sub">勾选每个角色可以做什么。超级管理员拥有全部权限且不可修改。</p>
    <div class="bar">
      ${roles.map(r => `<button class="btn ${window._curRole === r ? 'primary' : ''}" onclick="window._curRole='${r}';loadRoleEditor('${r}')">${ROLE_NAME[r]}</button>`).join('')}
    </div>
    <div id="role-editor"><div class="empty">选择上方角色开始配置</div></div>`;
});
page('roles').afterRender = () => {
  if (!window._curRole) window._curRole = 'sales';
  loadRoleEditor(window._curRole);
};

async function loadRoleEditor(role) {
  try {
    const d = await api('/roles');
    const enabled = new Set(d.roles[role].permissions);
    const all = d.allPermissions;
    const grouped = {};
    for (const p of all) {
      const [mod, act] = p.split('.');
      grouped[mod] = grouped[mod] || [];
      grouped[mod].push({ perm: p, act });
    }
    const isAdmin = role === 'admin';
    const html = `
      <div class="card pad">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
          <b style="font-size:14px">${ROLE_NAME[role]}</b>
          ${isAdmin ? '<span class="tag no">超级管理员拥有全部权限</span>' : ''}
          <div class="spacer"></div>
          ${!isAdmin ? `<button class="btn sm" onclick="resetRole('${role}')">恢复默认</button>` : ''}
        </div>
        ${Object.entries(grouped).map(([mod, list]) => `
          <div style="margin-bottom:16px">
            <div class="hint" style="margin-bottom:6px;font-weight:600;color:var(--text)">${PERM_GROUP[mod] || mod}</div>
            <div class="perm-grid">
              ${list.map(({ perm, act }) => `
                <label class="perm-item ${isAdmin ? 'locked' : ''}">
                  <input type="checkbox" value="${perm}" ${enabled.has(perm) || isAdmin ? 'checked' : ''} ${isAdmin ? 'disabled' : ''}>
                  <span>${PERM_ACTION[act] || act}<small>${perm}</small></span>
                </label>`).join('')}
            </div>
          </div>`).join('')}
        ${!isAdmin ? `<div style="display:flex;gap:10px;justify-content:flex-end;margin-top:8px">
          <button class="btn primary" onclick="saveRole('${role}')">保存权限</button></div>` : ''}
      </div>`;
    const el = document.getElementById('role-editor');
    if (el) el.innerHTML = html;
  } catch (e) { toast(e.message, 'err'); }
}

async function saveRole(role) {
  const checks = [...document.querySelectorAll('#role-editor input[type=checkbox]:checked')];
  const permissions = checks.map(c => c.value);
  try {
    await api('/roles/' + role, 'PUT', { permissions });
    toast('权限已保存，相关用户下次操作立即生效', 'ok');
    App.perms = new Set((await api('/auth/me')).permissions);
    render();
  } catch (e) { toast(e.message, 'err'); }
}

async function resetRole(role) {
  confirmDialog(`确定把「${ROLE_NAME[role]}」的权限恢复为系统默认？`, async () => {
    try { await api(`/roles/${role}/reset`, 'POST'); toast('已恢复默认', 'ok'); loadRoleEditor(role); }
    catch (e) { toast(e.message, 'err'); }
  });
}

/* ==================== 操作日志 ==================== */
page('oplogs', () => {
  const f = filterState('oplogs');
  const rows = (AdminState.logs || []).map(l => `<tr>
    <td class="num">${esc(l.created_at)}</td>
    <td>${esc(l.username || '')}</td>
    <td><span class="tag info">${esc(l.action || '')}</span></td>
    <td>${esc(l.module || '')}</td>
    <td class="hint" style="white-space:normal;max-width:420px">${esc(l.detail || '')}</td>
    <td class="mono">${esc(l.ip || '')}</td>
  </tr>`);
  return `
    <h1 class="pg">操作日志</h1>
    <p class="pg-sub">记录谁在什么时间做了什么，出问题时用来追溯</p>
    <div class="bar">
      <input class="inp" style="width:220px" placeholder="搜索操作人、动作、内容" id="lg-kw" value="${esc(f.keyword || '')}"
        onkeydown="if(event.key==='Enter')loadOpLogs(true)">
      <button class="btn" onclick="loadOpLogs(true)">搜索</button>
    </div>
    ${tableWrap([{ label: '时间' }, { label: '操作人' }, { label: '动作' }, { label: '模块' }, { label: '详情' }, { label: 'IP' }],
      rows, '没有日志')}
    ${pagerBar('oplogs', AdminState.logPage, 'loadOpLogs')}`;
});
page('oplogs').afterRender = () => loadOpLogs();

async function loadOpLogs(reset) {
  if (reset) setFilter('oplogs', { keyword: document.getElementById('lg-kw')?.value || '' });
  const f = filterState('oplogs');
  try {
    const d = await api('/logs?keyword=' + encodeURIComponent(f.keyword || '') + '&' + pgQuery('oplogs'));
    AdminState.logs = d.list;
    AdminState.logPage = d.page;
    if (App.route === 'oplogs') document.getElementById('page').innerHTML = PAGES.oplogs();
  } catch (e) { toast(e.message, 'err'); }
}

/* ==================== 系统设置 ==================== */
page('settings', () => {
  const s = AdminState.settings || {};
  return `
    <h1 class="pg">系统设置</h1>
    <p class="pg-sub">公司信息会打印在单据上；单号前缀修改后只影响新单据</p>
    <div class="card pad" style="margin-bottom:16px">
      <div class="sec">公司信息</div>
      <div class="form-grid">
        <div class="field"><label>公司名称</label><input class="inp" id="st-company" value="${esc(s.company_name || '')}"></div>
        <div class="field"><label>联系电话</label><input class="inp" id="st-phone" value="${esc(s.company_phone || '')}"></div>
        <div class="field"><label>税号</label><input class="inp" id="st-tax" value="${esc(s.tax_no || '')}"></div>
        <div class="field" style="grid-column:1/-1"><label>公司地址</label><input class="inp" id="st-addr" value="${esc(s.company_address || '')}"></div>
      </div>
    </div>
    <div class="card pad" style="margin-bottom:16px">
      <div class="sec">单据编号前缀</div>
      <div class="form-grid">
        <div class="field"><label>入库单</label><input class="inp" id="st-p-in" value="${esc(s.sn_prefix_IN || 'RK')}"></div>
        <div class="field"><label>出库单</label><input class="inp" id="st-p-out" value="${esc(s.sn_prefix_OUT || 'CK')}"></div>
        <div class="field"><label>销售退货</label><input class="inp" id="st-p-sret" value="${esc(s.sn_prefix_SRET || 'TH')}"></div>
        <div class="field"><label>采购退货</label><input class="inp" id="st-p-pret" value="${esc(s.sn_prefix_PRET || 'CGTH')}"></div>
        <div class="field"><label>盘点单</label><input class="inp" id="st-p-check" value="${esc(s.sn_prefix_CHECK || 'PD')}"></div>
      </div>
    </div>
    <div class="card pad" style="margin-bottom:16px">
      <div class="sec">业务参数</div>
      <div class="form-grid">
        <div class="field"><label>料头阈值（mm）</label><input class="inp num" id="st-waste" type="number" value="${esc(s.min_waste || '10')}"></div>
        <div class="field"><label>是否启用审批流程</label>
          <select class="inp" id="st-approval">
            <option value="1" ${s.need_approval === '1' ? 'selected' : ''}>启用（单据需审核后才动库存）</option>
            <option value="0" ${s.need_approval !== '1' ? 'selected' : ''}>关闭（提交即生效）</option>
          </select></div>
      </div>
      <div class="hint" style="margin-top:10px">审批流程关闭后，单据提交即生效并立即改变库存，适合只有你一个人使用系统的场景。</div>
    </div>
    <div class="card pad">
      <div class="sec">数据备份</div>
      <p class="hint" style="margin-bottom:12px">建议每天下班前备份一次。备份文件是完整的数据库文件，换电脑时直接用新文件替换即可。</p>
      <button class="btn primary" onclick="downloadBackup()">立即下载备份</button>
    </div>
    <div class="bar" style="margin-top:16px;justify-content:flex-end">
      <button class="btn primary" onclick="saveSettings()">保存设置</button>
    </div>`;
});
page('settings').afterRender = () => loadSettings();

async function loadSettings() {
  try {
    const d = await api('/settings');
    AdminState.settings = d.settings;
    if (App.route === 'settings') document.getElementById('page').innerHTML = PAGES.settings();
  } catch (e) { toast(e.message, 'err'); }
}

async function saveSettings() {
  const body = {
    company_name: document.getElementById('st-company').value,
    company_phone: document.getElementById('st-phone').value,
    tax_no: document.getElementById('st-tax').value,
    company_address: document.getElementById('st-addr').value,
    sn_prefix_IN: document.getElementById('st-p-in').value,
    sn_prefix_OUT: document.getElementById('st-p-out').value,
    sn_prefix_SRET: document.getElementById('st-p-sret').value,
    sn_prefix_PRET: document.getElementById('st-p-pret').value,
    sn_prefix_CHECK: document.getElementById('st-p-check').value,
    min_waste: document.getElementById('st-waste').value,
    need_approval: document.getElementById('st-approval').value
  };
  try {
    await api('/settings', 'PUT', body);
    toast('设置已保存', 'ok');
  } catch (e) { toast(e.message, 'err'); }
}

function downloadBackup() {
  const a = document.createElement('a');
  a.href = '/api/backup/download?token=' + encodeURIComponent(App.token);
  a.click();
  toast('正在下载备份', 'ok');
}

/* ==================== 我的账号 ==================== */
page('me', () => `
  <h1 class="pg">我的账号</h1>
  <p class="pg-sub">${esc(App.user.name)} · ${ROLE_NAME[App.user.role] || ''}</p>
  <div class="card pad" style="max-width:520px;margin-bottom:16px">
    <div class="form-grid">
      <div class="field"><label>登录账号</label><div>${esc(App.user.username)}</div></div>
      <div class="field"><label>姓名</label><div>${esc(App.user.name)}</div></div>
      <div class="field"><label>角色</label><div>${ROLE_NAME[App.user.role] || ''}</div></div>
      <div class="field"><label>最后登录</label><div class="num">${esc(App.user.last_login_at || '—')}</div></div>
    </div>
  </div>
  <div class="card pad" style="max-width:520px">
    <div class="sec">修改密码</div>
    <div class="field" style="margin-bottom:12px"><label>当前密码</label><input class="inp" type="password" id="me-old"></div>
    <div class="field" style="margin-bottom:12px"><label>新密码</label><input class="inp" type="password" id="me-new" placeholder="至少6位"></div>
    <div class="field" style="margin-bottom:14px"><label>确认新密码</label><input class="inp" type="password" id="me-new2"></div>
    <button class="btn primary" onclick="changeMyPassword()">保存新密码</button>
  </div>`);

async function changeMyPassword() {
  const oldP = document.getElementById('me-old').value;
  const p1 = document.getElementById('me-new').value;
  const p2 = document.getElementById('me-new2').value;
  if (!oldP || !p1) return toast('请填写当前密码和新密码', 'err');
  if (p1 !== p2) return toast('两次输入的新密码不一致', 'err');
  if (p1.length < 6) return toast('新密码至少 6 位', 'err');
  try {
    await api('/auth/change-password', 'POST', { oldPassword: oldP, newPassword: p1 });
    toast('密码已修改', 'ok');
    document.getElementById('me-old').value = '';
    document.getElementById('me-new').value = '';
    document.getElementById('me-new2').value = '';
  } catch (e) { toast(e.message, 'err'); }
}
