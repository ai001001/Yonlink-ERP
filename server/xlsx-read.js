'use strict';
/**
 * 零依赖 Excel(xlsx) / CSV 读取器（用于亿星等旧系统数据迁移导入）
 * Zero-dependency .xlsx / .csv reader, used for importing data migrated from legacy systems such as 亿星.
 * @module server/xlsx-read
 */
const zlib = require('node:zlib');

/**
 * 解压 ZIP，返回 文件名→内容 / Unzip an archive into a name → Buffer map (stored or deflate entries).
 * @param {Buffer} buf ZIP 文件内容 / zip bytes
 * @returns {Map<string, Buffer>}
 */
function unzip(buf) {
  // 从尾部查找“中央目录结束”记录 / locate the end-of-central-directory record
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 xlsx 文件（ZIP 结构损坏）');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('xlsx 文件目录损坏');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    // 本地文件头的扩展字段长度可能与中央目录不同 / local header extra length may differ from the central one
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const data = buf.subarray(start, start + compSize);
    if (method === 0) out.set(name, Buffer.from(data));
    else if (method === 8) out.set(name, Buffer.from(zlib.inflateRawSync(data)));
    // 其它压缩方式忽略 / other compression methods are skipped
  }
  return out;
}

/**
 * 解码 XML 实体 / Decode XML entities.
 * @param {string} s
 * @returns {string}
 */
function unescapeXml(s) {
  return s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (m, e) => {
    if (e === 'lt') return '<';
    if (e === 'gt') return '>';
    if (e === 'amp') return '&';
    if (e === 'quot') return '"';
    if (e === 'apos') return "'";
    const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : m;
  });
}

/**
 * 取出 <t> 文本（含富文本分段）/ Concatenate all <t> runs inside an XML fragment.
 * @param {string} xml
 * @returns {string}
 */
function textOf(xml) {
  let s = '';
  // 排除拼音注音 <rPh> / skip phonetic runs
  const clean = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  for (const m of clean.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) s += m[1];
  return unescapeXml(s);
}

/**
 * 列字母转序号 / Convert column letters (A, AB…) to a zero-based index.
 * @param {string} letters
 * @returns {number}
 */
function colIndex(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * 读取 xlsx 的工作表 / Read worksheets of an .xlsx file.
 * @param {Buffer} buf 文件内容 / file bytes
 * @param {object} [opt]
 * @param {number} [opt.sheet] 第几个工作表（从0开始，默认第一个）/ zero-based sheet index
 * @returns {{sheets:string[], rows:string[][]}} 所有单元格均为字符串 / every cell as a string
 */
function readXlsx(buf, opt = {}) {
  const files = unzip(buf);
  const get = (n) => (files.get(n) || Buffer.alloc(0)).toString('utf8');
  const wb = get('xl/workbook.xml');
  if (!wb) throw new Error('不是有效的 xlsx 文件（缺少 workbook）');
  const sheets = [...wb.matchAll(/<sheet\b[^>]*>/g)].map((m) => ({
    name: unescapeXml((m[0].match(/\bname="([^"]*)"/) || [])[1] || ''),
    rid: (m[0].match(/\br:id="([^"]*)"/) || m[0].match(/\bid="([^"]*)"/) || [])[1],
  }));
  if (!sheets.length) throw new Error('xlsx 文件中没有工作表');
  const idx = Math.min(Math.max(0, opt.sheet || 0), sheets.length - 1);
  const rels = get('xl/_rels/workbook.xml.rels');
  let target = '';
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    if ((m[0].match(/\bId="([^"]*)"/) || [])[1] === sheets[idx].rid) target = (m[0].match(/\bTarget="([^"]*)"/) || [])[1] || '';
  }
  const sheetPath = target ? (target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '')) : `xl/worksheets/sheet${idx + 1}.xml`;
  const sheetXml = get(sheetPath);
  if (!sheetXml) throw new Error('读取工作表失败');

  const shared = [...get('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]));
  const rows = [];
  for (const rm of sheetXml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b([^>]*)\/>/g)) {
    const attrs = rm[1] || rm[3] || '';
    const rNo = parseInt((attrs.match(/\br="(\d+)"/) || [])[1], 10);
    const ri = Number.isFinite(rNo) ? rNo - 1 : rows.length;
    const row = [];
    let next = 0;
    for (const cm of (rm[2] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ca = cm[1];
      const ref = (ca.match(/\br="([A-Z]+)\d+"/) || [])[1];
      const ci = ref ? colIndex(ref) : next;
      next = ci + 1;
      const t = (ca.match(/\bt="([^"]*)"/) || [])[1];
      const body = cm[2] || '';
      let v = '';
      if (t === 'inlineStr') v = textOf(body);
      else {
        const raw = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        if (raw !== undefined) {
          if (t === 's') v = shared[parseInt(raw, 10)] ?? '';
          else if (t === 'b') v = raw === '1' ? 'TRUE' : 'FALSE';
          else v = unescapeXml(raw);
        }
      }
      row[ci] = v;
    }
    for (let i = 0; i < row.length; i++) if (row[i] === undefined) row[i] = '';
    rows[ri] = row;
  }
  for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
  return { sheets: sheets.map((s) => s.name), rows };
}

/**
 * 解析 CSV（支持引号、逗号/制表符分隔、UTF-8 BOM、GBK 回退）/ Parse CSV or TSV text.
 * @param {Buffer} buf 文件内容 / file bytes
 * @returns {string[][]}
 */
function readCsv(buf) {
  let text = buf.toString('utf8');
  // 含大量替换字符说明不是 UTF-8，尝试 GBK（亿星等国产软件常见）/ fall back to GBK for legacy Chinese exports
  if ((text.match(/�/g) || []).length > 2 && typeof TextDecoder !== 'undefined') {
    try { text = new TextDecoder('gbk').decode(buf); } catch { /* 环境不支持 GBK 时保留原文 / keep UTF-8 */ }
  }
  text = text.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/, 1)[0];
  const sep = (firstLine.match(/\t/g) || []).length > (firstLine.match(/,/g) || []).length ? '\t' : ',';
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else q = false;
      } else cell += ch;
    } else if (ch === '"' && cell === '') q = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/**
 * 按文件内容自动识别并读取表格 / Read a spreadsheet file, detecting xlsx vs csv.
 * @param {Buffer} buf 文件内容 / file bytes
 * @param {string} [fileName] 文件名 / file name (used for the .xls hint)
 * @returns {string[][]} 行数组（已去除首尾空白）/ trimmed rows
 */
function readTable(buf, fileName = '') {
  if (!buf || !buf.length) throw new Error('文件为空');
  let rows;
  if (buf[0] === 0x50 && buf[1] === 0x4b) rows = readXlsx(buf).rows;
  else if (buf[0] === 0xd0 && buf[1] === 0xcf) {
    throw new Error(`「${fileName || '该文件'}」是旧版 .xls 格式，请在 Excel/WPS 中“另存为 .xlsx”后再导入`);
  } else rows = readCsv(buf);
  return rows.map((r) => r.map((c) => String(c ?? '').trim()));
}

module.exports = { readTable, readXlsx, readCsv, unzip };
