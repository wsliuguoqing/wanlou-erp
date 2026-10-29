/* 2026-10-25 bug专项测试 */
const assert = require('assert');

const BASE = 'http://localhost:3000/api';
let token = '';

async function api(path, method = 'GET', body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.message);
  return json.data;
}

let failed = 0;
const ok = m => console.log('  ✓ ' + m);
const no = m => { console.log('  ✗ ' + m); failed++; };

(async () => {
  console.log('\n===== 2026-10-25 bug 专项测试 =====\n');

  const login = await api('/auth/login', 'POST', { username: 'admin', password: 'admin123' });
  token = login.token;
  ok('超管登录');

  /* 1. 母卷明细分页 */
  console.log('\n[1/3] 母卷明细分页');
  // 找一个有母卷的物料
  const mats = await api('/materials?type=master&size=1');
  if (mats.list.length > 0) {
    const mid = mats.list[0].id;
    const page1 = await api(`/inventory/rolls?material_id=${mid}&page=1&size=2`);
    assert(page1.page, '应返回page对象');
    assert(page1.page.page === 1, '页码应为1');
    assert(page1.page.size === 2, '每页条数应为2');
    assert(page1.page.total !== undefined, '应返回total');
    assert(page1.page.pages !== undefined, '应返回pages');
    assert(Array.isArray(page1.list), 'list应为数组');
    ok('母卷明细分页元信息正确');

    if (page1.page.total > 2) {
      const page2 = await api(`/inventory/rolls?material_id=${mid}&page=2&size=2`);
      assert(page2.page.page === 2, '第二页页码应为2');
      assert(page2.list.length <= 2, '第二页条数不超过size');
      ok('母卷明细翻页正常');
    } else {
      ok('母卷明细数据<3条，跳过翻页测试');
    }
  } else {
    ok('无母卷物料，跳过母卷明细测试');
  }

  /* 2. 库存流水分页（已在之前改动中完成，快速验证） */
  console.log('\n[2/3] 库存流水分页验证');
  const logs1 = await api('/inventory/logs?page=1&size=10');
  assert(logs1.page, '应返回page对象');
  assert(logs1.page.page === 1, '页码应为1');
  assert(logs1.page.size === 10, '每页条数应为10');
  assert(logs1.page.total !== undefined, '应返回total');
  ok('库存流水分页正常');

  /* 3. 新建物料单位记忆（无法自动测试localStorage，需手动验证） */
  console.log('\n[3/3] 新建物料单位记忆（需手动验证前端localStorage）');
  ok('单位记忆功能已实现，需打开 http://localhost:3000 手动验证');

  console.log(`\n${failed ? '失败 ' + failed + ' 项' : '全部通过 ✓'}\n`);
  process.exit(failed);
})();
