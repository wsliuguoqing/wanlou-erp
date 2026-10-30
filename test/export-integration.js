#!/usr/bin/env node
'use strict';
/**
 * 前端导出功能集成测试
 * 验证 pages-docs.js 中的 exportDoc 函数是否能正确执行
 */

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');

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
          resolve({ ok: json.ok, data: json.data, message: json.message });
        } else {
          resolve({ ok: true, data: buf });
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
  console.log('\n===== 前端导出代码语法检查 =====\n');

  try {
    // 1. 检查 pages-docs.js 中是否存在 Auth.token（应该已改为 App.token）
    const docsPath = path.join(__dirname, '..', 'src', 'web', 'pages-docs.js');
    const docsCode = fs.readFileSync(docsPath, 'utf8');

    if (docsCode.includes('Auth.token')) {
      no('pages-docs.js 仍包含 Auth.token，应改为 App.token');
    } else {
      ok('pages-docs.js 不包含 Auth.token');
    }

    if (docsCode.includes('App.token')) {
      ok('pages-docs.js 正确使用 App.token');
    } else {
      no('pages-docs.js 未使用 App.token');
    }

    // 2. 提取 exportDoc 函数，验证语法
    const funcMatch = docsCode.match(/async function exportDoc\([^)]*\)\s*{[\s\S]*?^}/m);
    if (!funcMatch) {
      no('未找到 exportDoc 函数');
    } else {
      ok('找到 exportDoc 函数');

      // 简单语法检查：是否包含关键步骤
      const funcCode = funcMatch[0];
      const checks = [
        ['fetch(url', '调用 fetch'],
        ['App.token', '使用 App.token'],
        ['res.blob()', '获取 blob'],
        ['URL.createObjectURL', '创建对象 URL'],
        ['createElement(\'a\')', '创建下载链接'],
        ['a.click()', '触发下载']
      ];

      for (const [keyword, desc] of checks) {
        if (funcCode.includes(keyword)) {
          ok(`${desc} ✓`);
        } else {
          no(`缺少步骤: ${desc}`);
        }
      }
    }

    // 3. 实际调用后端接口验证
    console.log('\n  --- 后端接口验证 ---\n');

    token = await require('./login-helper').loginAt(API + '/api/auth/login', 'admin', 'admin123');
    ok('登录成功');

    const docs = await api('/api/docs/out?page=1&size=10');
    if (!docs.ok) {
      no('获取单据失败');
      process.exit(1);
    }

    const approved = docs.data.list.find(d => d.status === 'approved');
    if (!approved) {
      console.log('\n  ! 无已审核单据，跳过接口测试');
    } else {
      ok(`找到单据: ${approved.sn}`);

      const exportRes = await api(`/api/export/docs/out/${approved.id}?kind=doc`);
      if (exportRes.ok && exportRes.data instanceof Buffer) {
        ok(`导出接口返回 ${exportRes.data.length} 字节`);
      } else {
        no('导出接口异常');
      }
    }

  } catch (e) {
    no(`异常: ${e.message}`);
  }

  console.log(failed ? `\n❌ ${failed} 项失败\n` : '\n✅ 全部通过\n');
  process.exit(failed ? 1 : 0);
})();
