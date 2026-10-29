#!/usr/bin/env node
'use strict';
/**
 * 端到端验证：导出功能
 * 1. 登录拿 token
 * 2. 找一张已审核单据
 * 3. 调用导出接口，验证返回的是 xlsx 二进制（前 4 字节 PK\x03\x04）
 */
const http = require('node:http');

let token = '';
const API = 'http://localhost:3000';

function api(path, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const opts = {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {})
      }
    };
    const req = http.request(API + path, opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.headers['content-type']?.includes('json')) {
          const json = JSON.parse(buf.toString());
          if (!json.ok) return reject(new Error(json.message));
          resolve(json.data);
        } else {
          resolve(buf);
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

let failed = 0;
const ok = m => console.log('  ✓ ' + m);
const no = m => { console.log('  ✗ ' + m); failed++; };

(async () => {
  console.log('\n===== 导出功能端到端测试 =====\n');

  try {
    const login = await api('/api/auth/login', 'POST', { username: 'admin', password: 'admin123' });
    token = login.token;
    ok('超管登录');

    // 找一张已审核的出库单
    const docs = await api('/api/docs/out?page=1&size=10');
    const approved = docs.list.find(d => d.status === 'approved');
    if (!approved) {
      console.log('\n  ! 没有已审核的出库单，跳过导出测试');
      process.exit(0);
    }
    ok(`找到已审核出库单: ${approved.sn} (ID ${approved.id})`);

    // 导出单据正本
    const docBuf = await api(`/api/export/docs/out/${approved.id}?kind=doc`);
    if (docBuf[0] === 0x50 && docBuf[1] === 0x4B && docBuf[2] === 0x03 && docBuf[3] === 0x04) {
      ok(`导出单据正本成功 (${docBuf.length} 字节，xlsx 签名正确)`);
    } else {
      no(`导出单据正本失败：签名不符 (前4字节: ${docBuf.slice(0, 4).toString('hex')})`);
    }

    // 导出送货单
    const deliveryBuf = await api(`/api/export/docs/out/${approved.id}?kind=delivery`);
    if (deliveryBuf[0] === 0x50 && deliveryBuf[1] === 0x4B && deliveryBuf[2] === 0x03 && deliveryBuf[3] === 0x04) {
      ok(`导出送货单成功 (${deliveryBuf.length} 字节，xlsx 签名正确)`);
    } else {
      no(`导出送货单失败：签名不符 (前4字节: ${deliveryBuf.slice(0, 4).toString('hex')})`);
    }

    // 找一张入库单
    const inDocs = await api('/api/docs/in?page=1&size=10');
    const inApproved = inDocs.list.find(d => d.status === 'approved');
    if (inApproved) {
      const inBuf = await api(`/api/export/docs/in/${inApproved.id}?kind=doc`);
      if (inBuf[0] === 0x50 && inBuf[1] === 0x4B && inBuf[2] === 0x03 && inBuf[3] === 0x04) {
        ok(`导出入库单成功 (${inBuf.length} 字节)`);
      } else {
        no(`导出入库单失败：签名不符`);
      }
    }

  } catch (e) {
    no(`异常: ${e.message}`);
  }

  console.log(failed ? `\n❌ ${failed} 项失败\n` : '\n✅ 全部通过\n');
  process.exit(failed ? 1 : 0);
})();
