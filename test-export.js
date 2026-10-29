const { db } = require('./src/server/db');

const stmt = db.prepare(`
  SELECT id, sn, type, status FROM docs
  WHERE status='approved'
  ORDER BY id DESC LIMIT 3
`);
const docs = stmt.all();

console.log('已审核单据样本：');
docs.forEach(d => {
  console.log(`  ID ${d.id} - ${d.sn} (${d.type}) - ${d.status}`);
});

if (docs.length > 0) {
  const first = docs.find(d => d.type === 'outbound') || docs[0];
  const key = { outbound: 'out', inbound: 'in', sales_return: 'sret', purchase_return: 'pret' }[first.type] || 'out';
  console.log(`\n测试导出接口：GET /api/export/docs/${key}/${first.id}?kind=doc`);
  if (key === 'out' || key === 'sret') {
    console.log(`测试送货单：GET /api/export/docs/${key}/${first.id}?kind=delivery`);
  }
} else {
  console.log('\n暂无已审核单据，无法测试导出');
}
