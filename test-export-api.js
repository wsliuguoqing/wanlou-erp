const http = require('node:http');
const fs = require('node:fs');

function testExport(path, filename) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://localhost:3000${path}`, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        fs.writeFileSync(filename, buf);
        console.log(`✓ ${filename} - ${buf.length} 字节`);
        resolve();
      });
    });
    req.on('error', reject);
  });
}

(async () => {
  try {
    console.log('测试导出功能...\n');
    await testExport('/api/export/docs/in/31?kind=doc', 'test-inbound.xlsx');
    await testExport('/api/export/docs/out/29?kind=doc', 'test-outbound.xlsx');
    await testExport('/api/export/docs/out/29?kind=delivery', 'test-delivery.xlsx');
    console.log('\n导出测试通过，请手工打开三个 .xlsx 文件验证内容');
  } catch (e) {
    console.error('✗ 测试失败:', e.message);
    process.exit(1);
  }
})();
