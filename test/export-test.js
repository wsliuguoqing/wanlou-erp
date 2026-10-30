/* 分页功能测试 */
const http = require('http');
const fs = require('fs');

let token;
async function api(path, method = 'GET', body) {
  const res = await fetch('http://localhost:3000/api' + path, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.message);
  return json.data;
}

function download(path, outFile) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost', port: 3000, path: '/api' + path,
      headers: { Authorization: 'Bearer ' + token }
    }, res => {
      const bufs = [];
      res.on('data', c => bufs.push(c));
      res.on('end', () => {
        fs.writeFileSync(outFile, Buffer.concat(bufs));
        resolve();
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function upload(path, filePath) {
  return new Promise((resolve, reject) => {
    const buf = fs.readFileSync(filePath);
    const form = `------WKB\r\nContent-Disposition: form-data; name="file"; filename="test.xlsx"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`;
    const end = `\r\n------WKB--\r\n`;
    const payload = Buffer.concat([Buffer.from(form), buf, Buffer.from(end)]);
    const req = http.request({
      hostname: 'localhost', port: 3000, path: '/api' + path, method: 'POST',
      headers: {
        'Content-Type': 'multipart/form-data; boundary=----WKB',
        'Content-Length': payload.length,
        Authorization: 'Bearer ' + token
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

let failed = 0;
const ok = m => console.log('  ✓ ' + m);
const no = m => { console.log('  ✗ ' + m); failed++; };
function assert(c, m) { c ? ok(m) : no(m); }

(async () => {
  console.log('\n===== 导出导入测试 =====\n');
  const tmpDir = '.tmp-export-test';
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  token = await require('./login-helper').loginAt('http://localhost:3000/api/auth/login', 'admin', 'admin123');
  ok('超管登录');

  /* 准备基础数据 */
  const rnd = Date.now().toString(36);
  const cust = await api('/customers', 'POST', { name: `导出测试客户${rnd}`, contact: '张工', phone: '13800000001' });
  const supp = await api('/suppliers', 'POST', { name: `导出测试供应商${rnd}`, contact: '李工', phone: '010-12345678' });
  const mat1 = await api('/materials', 'POST', { name: `测试物料A${rnd}`, spec: '10kV', unit: '套', type: 'normal', cost: 100 });
  const mat2 = await api('/materials', 'POST', { name: `测试胶带${rnd}`, spec: '50mm×100m', unit: '卷', type: 'master', cost: 50, base_width: 500, min_waste: 10, cut_fee: 0.5 });
  ok('准备了 2 个物料');

  /* 1. 下载物料模板 */
  await download('/export/materials/template', `${tmpDir}/物料模板.xlsx`);
  assert(fs.existsSync(`${tmpDir}/物料模板.xlsx`), '物料模板下载成功');

  /* 2. 导入物料（包含占位符） */
  const impRes = await upload('/export/materials/import?dryRun=0', `${tmpDir}/物料模板.xlsx`);
  assert(impRes.ok, '物料导入成功');
  assert(impRes.data.added >= 2, `新增物料 ${impRes.data.added} 条（应 ≥2）`);

  const matList = await api('/materials?all=1');
  const imported = matList.list.filter(m => m.name.includes('示例'));
  assert(imported.length >= 2, `导入后能查到示例物料（${imported.length} 条）`);
  assert(imported.every(m => m.code && m.code !== '（可留空）'), '编号占位符已替换为系统生成编号');

  /* 3. 导出物料清单 */
  await download('/export/materials', `${tmpDir}/物料清单.xlsx`);
  assert(fs.existsSync(`${tmpDir}/物料清单.xlsx`), '物料清单导出成功');

  /* 4. 创建单据并导出 */
  const docOut = await api('/docs', 'POST', {
    type: 'out', customer_id: cust.id, contact: '张工', phone: '13800000001',
    items: [{ material_id: mat1.id, qty: 10, price: 120, amount: 1200 }]
  });
  await api(`/docs/${docOut.id}/submit`, 'POST');
  await api(`/docs/${docOut.id}/approve`, 'POST');
  ok('创建并审核出库单');

  await download(`/export/docs/${docOut.id}/delivery`, `${tmpDir}/送货单.xlsx`);
  assert(fs.existsSync(`${tmpDir}/送货单.xlsx`), '送货单导出成功');

  await download(`/export/docs/${docOut.id}`, `${tmpDir}/出库单.xlsx`);
  assert(fs.existsSync(`${tmpDir}/出库单.xlsx`), '出库单导出成功');

  const docIn = await api('/docs', 'POST', {
    type: 'in', supplier_id: supp.id, contact: '李工', phone: '010-12345678',
    items: [{ material_id: mat2.id, qty: 20, price: 50, amount: 1000 }]
  });
  await api(`/docs/${docIn.id}/submit`, 'POST');
  await api(`/docs/${docIn.id}/approve`, 'POST');
  ok('创建并审核入库单');

  await download(`/export/docs/${docIn.id}`, `${tmpDir}/入库单.xlsx`);
  assert(fs.existsSync(`${tmpDir}/入库单.xlsx`), '入库单导出成功');

  /* 5. 导出待结转清单 */
  await download('/export/pending-balance', `${tmpDir}/待结转清单.xlsx`);
  assert(fs.existsSync(`${tmpDir}/待结转清单.xlsx`), '待结转清单导出成功');

  /* 6. 导出库存明细 */
  await download('/export/inventory', `${tmpDir}/库存明细.xlsx`);
  assert(fs.existsSync(`${tmpDir}/库存明细.xlsx`), '库存明细导出成功');

  /* 7. 导出收付款流水 */
  await download('/export/payments', `${tmpDir}/收付款流水.xlsx`);
  assert(fs.existsSync(`${tmpDir}/收付款流水.xlsx`), '收付款流水导出成功');

  console.log(`\n测试完成，生成的文件在 ${tmpDir}/`);
  console.log(failed ? `\n❌ ${failed} 项失败` : '\n✅ 全部通过');
  process.exit(failed);
})().catch(e => {
  console.error('\n💥 测试异常：', e.message);
  process.exit(1);
});
