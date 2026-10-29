'use strict';
/**
 * 零依赖的 Excel(.xlsx) 读写
 * 写：手工拼 OpenXML，用 stored(不压缩) 方式打包 zip，Node 原生 zlib 只用于读
 * 读：解 zip 后取共享字符串与第一张表；.csv 直接按文本解析（兼容 GBK）
 *
 * 单元格样式索引见下方 STYLES，调用方只用 S 常量：
 *   S.text 左对齐带边框 | S.num 右对齐两位小数 | S.int 右对齐整数
 *   S.head 表头 | S.title 大标题 | S.sub 副标题加粗 | S.total 合计加粗
 */
const zlib = require('node:zlib');

/* ---------------- CRC32 ---------------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/* ---------------- ZIP（仅存储，不压缩） ---------------- */
function zipStore(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const body = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    const crc = crc32(body);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0x0800, 6);      // UTF-8 文件名
    local.writeUInt16LE(0, 8);           // method: stored
    local.writeUInt16LE(0, 10);          // time
    local.writeUInt16LE(0x21, 12);       // date: 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, end]);
}

/* ---------------- XML 片段 ---------------- */
function escXml(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // 去掉 XML 不允许的控制字符，否则 Excel 打不开
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}
function colName(n) { // 1 -> A
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

const S = { text: 3, num: 4, int: 5, head: 2, title: 1, sub: 6, total: 7 };

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="176" formatCode="0.00"/></numFmts>
<fonts count="5">
  <font><sz val="11"/><name val="宋体"/></font>
  <font><b/><sz val="16"/><name val="宋体"/></font>
  <font><b/><sz val="11"/><name val="宋体"/></font>
  <font><sz val="11"/><color rgb="FF555555"/><name val="宋体"/></font>
  <font><sz val="11"/><color rgb="FF666666"/><name val="宋体"/></font>
</fonts>
<fills count="3">
  <fill><patternFill patternType="none"/></fill>
  <fill><patternFill patternType="gray125"/></fill>
  <fill><patternFill patternType="solid"><fgColor rgb="FFF2F4F2"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
  <border><left/><right/><top/><bottom/><diagonal/></border>
  <border>
    <left style="thin"><color rgb="FF999999"/></left>
    <right style="thin"><color rgb="FF999999"/></right>
    <top style="thin"><color rgb="FF999999"/></top>
    <bottom style="thin"><color rgb="FF999999"/></bottom>
    <diagonal/>
  </border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="8">
  <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
  <xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
  <xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
  <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
  <xf numFmtId="176" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
  <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
  <xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
  <xf numFmtId="176" fontId="2" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

/* ---------------- 生成表格 ---------------- */
/**
 * sheets: [{ name, cols: [数字=列宽] 或 [{w:列宽}], rows: [[单元格...]], merges:[{s:{r,c},e:{r,c}}] }]
 * 单元格：字符串 / 数字 / 布尔 / null / { v, s: S.text } / { f: 'SUM(A1:A2)', s }
 * 行/列下标 r、c 均从 0 开始
 */
function buildXlsx(sheets) {
  const sheetXmls = sheets.map(sh => buildSheet(sh));
  const files = [
    { name: '[Content_Types].xml', data: contentTypes(sheets.length) },
    { name: '_rels/.rels', data: ROOT_RELS },
    { name: 'xl/workbook.xml', data: workbook(sheets) },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRels(sheets.length) },
    { name: 'xl/styles.xml', data: STYLES_XML }
  ];
  sheetXmls.forEach((xml, i) => files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: xml }));
  return zipStore(files);
}

function buildSheet(sh) {
  const cols = (sh.cols || []).map((c, i) => {
    const w = typeof c === 'number' ? c : (c?.w || 12);
    return `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`;
  }).join('');

  const lines = [];
  (sh.rows || []).forEach((row, r) => {
    if (!row || !row.length) return;
    const cells = [];
    row.forEach((cell, c) => {
      if (cell === null || cell === undefined || cell === '') return;
      const ref = colName(c + 1) + (r + 1);
      if (typeof cell === 'object' && !(cell instanceof Date)) {
        const st = cell.s !== undefined ? ` s="${cell.s}"` : '';
        if (cell.f) { cells.push(`<c r="${ref}"${st}><f>${escXml(cell.f)}</f></c>`); return; }
        if (typeof cell.v === 'number') { cells.push(`<c r="${ref}"${st}><v>${cell.v}</v></c>`); return; }
        cells.push(`<c r="${ref}"${st} t="inlineStr"><is><t xml:space="preserve">${escXml(cell.v)}</t></is></c>`);
        return;
      }
      if (typeof cell === 'number' && Number.isFinite(cell)) {
        cells.push(`<c r="${ref}"><v>${cell}</v></c>`);
        return;
      }
      cells.push(`<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escXml(cell)}</t></is></c>`);
    });
    const h = row._h ? ` ht="${row._h}" customHeight="1"` : '';
    lines.push(`<row r="${r + 1}"${h}>${cells.join('')}</row>`);
  });

  const merges = (sh.merges || []).length
    ? `<mergeCells count="${sh.merges.length}">${sh.merges.map(m =>
        `<mergeCell ref="${colName(m.s.c + 1)}${m.s.r + 1}:${colName(m.e.c + 1)}${m.e.r + 1}"/>`).join('')}</mergeCells>`
    : '';

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<cols>${cols}</cols>
<sheetData>${lines.join('')}</sheetData>
${merges}
<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>
</worksheet>`;
}

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

function contentTypes(n) {
  const overrides = Array.from({ length: n }, (_, i) =>
    `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${overrides}
</Types>`;
}

function workbook(sheets) {
  const list = sheets.map((s, i) =>
    `<sheet name="${escXml(s.name || 'Sheet' + (i + 1))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${list}</sheets>
</workbook>`;
}

function workbookRels(n) {
  const rels = Array.from({ length: n }, (_, i) =>
    `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${rels}
<Relationship Id="rId${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
}

/* ---------------- 读取表格 ---------------- */
function unzip(buf) {
  const out = {};
  let endPos = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { endPos = i; break; }
  }
  if (endPos < 0) throw new Error('不是有效的 xlsx 文件');
  const count = buf.readUInt16LE(endPos + 10);
  let p = buf.readUInt32LE(endPos + 16);

  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    const lnlen = buf.readUInt16LE(lho + 26);
    const lelen = buf.readUInt16LE(lho + 28);
    const start = lho + 30 + lnlen + lelen;
    const raw = buf.slice(start, start + csize);
    try { out[name] = method === 8 ? zlib.inflateRawSync(raw) : raw; } catch { out[name] = Buffer.alloc(0); }
    p += 46 + nlen + elen + clen;
  }
  return out;
}

function xmlUnesc(s) {
  return String(s || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');
}
function textOf(xml) {
  return [...String(xml).matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(m => xmlUnesc(m[1])).join('');
}
function refToCol(ref) {
  const letters = /^([A-Z]+)/.exec(ref)?.[1] || 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** 读第一张工作表，返回二维字符串数组（空单元格保留为空字符串，列不会错位） */
function readSheet(buf) {
  const z = unzip(buf);
  const ssBuf = z['xl/sharedStrings.xml'];
  const shared = ssBuf
    ? [...ssBuf.toString('utf8').matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => textOf(m[1]))
    : [];

  let sheetKey = Object.keys(z).find(k => /^xl\/worksheets\/sheet1\.xml$/.test(k));
  if (!sheetKey) {
    // 有些软件第一张表不叫 sheet1，按关系文件找
    const wb = z['xl/workbook.xml'] ? z['xl/workbook.xml'].toString('utf8') : '';
    const firstRid = /<sheet[^>]*r:id="(rId\d+)"/.exec(wb)?.[1];
    const rels = z['xl/_rels/workbook.xml.rels'] ? z['xl/_rels/workbook.xml.rels'].toString('utf8') : '';
    const target = firstRid && new RegExp(`Id="${firstRid}"[^>]*Target="([^"]+)"`).exec(rels)?.[1];
    if (target) sheetKey = 'xl/' + target.replace(/^\/?xl\//, '');
  }
  if (!sheetKey) throw new Error('文件里没有找到工作表');
  const sheet = z[sheetKey].toString('utf8');

  const rows = [];
  for (const rm of sheet.matchAll(/<row[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const rowIdx = Number(rm[1]) - 1;
    const cells = [];
    for (const cm of rm[2].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cm[1];
      const body = cm[2];
      const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1] || '';
      const type = /t="(\w+)"/.exec(attrs)?.[1];
      let val = '';
      if (type === 'inlineStr') val = textOf(body);
      else if (type === 's') {
        const idx = Number(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1]);
        val = shared[idx] ?? '';
      } else {
        val = xmlUnesc(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '');
      }
      cells[ref ? refToCol(ref) : cells.length] = val;
    }
    // 稀疏数组会留下 undefined，统一填空串，保证列号对齐
    for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = '';
    rows[rowIdx] = cells;
  }
  return Array.from(rows, r => r || []);
}

/** CSV 文本 -> 二维数组，处理引号与换行 */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuote) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuote = false;
      } else field += ch;
    } else if (ch === '"') inQuote = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch === '\r') { /* 忽略 */ }
    else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** 任意上传文件 -> 二维数组：xlsx 或 csv（GBK 自动识别） */
function readTable(buf, filename = '') {
  const isCsv = /\.csv$/i.test(filename) || buf.slice(0, 2).toString('latin1') !== 'PK';
  if (!isCsv) return readSheet(buf);

  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    text = new TextDecoder('gbk').decode(buf); // 老系统导出的 csv 常是 GBK
  }
  text = text.replace(/^﻿/, '');
  return parseCsv(text);
}

module.exports = { buildXlsx, readSheet, readTable, parseCsv, S, colName };
