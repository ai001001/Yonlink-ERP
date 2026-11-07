'use strict';
/**
 * 数据迁移（亿星导入）测试：表格读取、列识别、校验、导入、覆盖/跳过、关联缺失、回滚、权限
 * Data-migration (亿星 import) tests: sheet reading, column recognition, validation, import, overwrite/skip,
 * missing references, rollback and permissions.
 * 用例编号与 docs/03-测试用例.md 对应 / Case IDs map to docs/03-测试用例.md
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { startServer } = require('./helpers');
const { buildXlsx, zip } = require('../server/xlsx');
const { readTable, readXlsx, readCsv } = require('../server/xlsx-read');
const { parseSize, parseNum } = require('../server/migrate');

let srv;
let admin;
let sales1;

test.before(async () => {
  srv = await startServer();
  [admin, sales1] = await Promise.all(['admin', 'sales1'].map((u) => srv.login(u)));
});
test.after(() => srv.close());

/**
 * 生成 xlsx 的 base64 / Build an xlsx file as base64.
 * @param {any[][]} rows
 * @returns {string}
 */
const xlsxB64 = (rows) => buildXlsx({ rows }).toString('base64');

// ===================== 表格读取 / sheet reading =====================
test('TC-MIG-01 xlsx读取：本系统导出的xlsx可原样读回（含中文、数字、空单元格）', () => {
  const buf = buildXlsx({ rows: [['客户编号', '客户简称', '佣金'], ['KH001', 'WAL', 5], ['KH002', '', 3.5]] });
  const rows = readTable(buf, 'a.xlsx');
  assert.deepEqual(rows, [['客户编号', '客户简称', '佣金'], ['KH001', 'WAL', '5'], ['KH002', '', '3.5']]);
});

test('TC-MIG-02 xlsx读取：共享字符串、跳列、富文本、Excel/WPS常见结构', () => {
  const sheet = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>
    <row r="3"><c r="A3" t="s"><v>2</v></c><c r="B3"><v>12.5</v></c><c r="C3" t="b"><v>1</v></c></row></sheetData></worksheet>`;
  const sst = `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
    <si><t>货号</t></si><si><r><t>中文</t></r><r><t xml:space="preserve">品名</t></r></si><si><t>A&amp;B</t><rPh><t>ignore</t></rPh></si></sst>`;
  const wb = '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="样品" sheetId="1" r:id="rId1"/></sheets></workbook>';
  const rels = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/></Relationships>';
  const buf = zip([{ name: 'xl/workbook.xml', data: wb }, { name: 'xl/_rels/workbook.xml.rels', data: rels }, { name: 'xl/worksheets/sheet1.xml', data: sheet }, { name: 'xl/sharedStrings.xml', data: sst }]);
  const { sheets, rows } = readXlsx(buf);
  assert.deepEqual(sheets, ['样品']);
  assert.deepEqual(rows, [['货号', '', '中文品名'], [], ['A&B', '12.5', 'TRUE']]);
  assert.ok(zlib.inflateRawSync, 'node 环境自带解压');
});

test('TC-MIG-03 CSV读取：BOM、引号内逗号与换行、制表符分隔；旧版xls给出明确提示', () => {
  const csv = Buffer.from('﻿客户编号,客户简称,备注\r\nKH001,"WAL, Inc","第一行\n第二行"\r\n');
  assert.deepEqual(readCsv(csv), [['客户编号', '客户简称', '备注'], ['KH001', 'WAL, Inc', '第一行\n第二行']]);
  assert.deepEqual(readCsv(Buffer.from('货号\t品名\nA1\t杯')), [['货号', '品名'], ['A1', '杯']]);
  assert.throws(() => readTable(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), 'old.xls'), /另存为 \.xlsx/);
  assert.deepEqual(parseSize('13.00 × 6.00 × 31.00'), [13, 6, 31]);
  assert.equal(parseNum('1,200.5'), 1200.5);
  assert.equal(parseNum('5%'), 5);
  assert.equal(parseNum('abc'), undefined);
});

// ===================== 列识别与校验 / mapping and validation =====================
test('TC-MIG-04 预览：自动跳过标题行找到表头，按亿星列名识别字段', async () => {
  const data = xlsxB64([['客户资料导出（亿星）'], ['客户编号', '客户简称', '英文全称', '国家', '业务员', '佣金%', '奇怪的列'], ['KH001', 'WAL', 'Wal-Mart Stores,Inc', '美国', '林晓明', '5%', 'x']]);
  const r = await admin.post('/api/migrate/preview', { entity: 'customer', file_name: 'c.xlsx', data });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.header_row, 2);
  assert.deepEqual(r.data.mapping, ['code', 'name', 'full_name_en', 'country', 'salesman_id', 'commission_rate', '']);
  assert.equal(r.data.data_rows, 1);
});

test('TC-MIG-05 校验不写入：dry_run 给出分类结果但数据库无变化', async () => {
  const data = xlsxB64([['客户编号', '客户简称', '国别', '业务员'], ['KH101', 'IKEA', '瑞典', '王芳'], ['KH102', 'KMART', '', '不存在的人'], ['KH101', 'IKEA2', '瑞典', '']]);
  const r = await admin.post('/api/migrate/import', { entity: 'customer', file_name: 'c.xlsx', data, dry_run: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.dry_run, true);
  assert.equal(r.data.counts.created, 1);
  assert.equal(r.data.buckets.ref_missing.length, 1);
  assert.match(r.data.buckets.ref_missing[0].msg, /业务员“不存在的人”/);
  assert.equal(r.data.buckets.duplicate.length, 1);
  assert.equal(r.data.batch, null);
  const list = await admin.get('/api/e/customer?q=KH101');
  assert.equal(list.data.total, 0, '校验模式不应写入数据');
});

// ===================== 正式导入 / import =====================
let supplierBatch;
test('TC-MIG-06 厂家导入：采购类型推导供应商类型、合作厂家同批次关联、停用列', async () => {
  const data = xlsxB64([
    ['厂家编号', '厂家简称', '采购类型', '厂家状态', '联系人', '移动电话', '主营产品', '合作厂家', '停用'],
    ['CJ001', '武义恒隆', '产品', '战略供应商', '丁工', '13800000001', '陶瓷花瓶', '日扬包装', ''],
    ['CJ002', '日扬包装', '包材', '优先供应商', '王工', '13800000002', '彩盒外箱', '', ''],
    ['CJ003', '旧厂', '产品', '奇怪状态', '', '', '', '', '是'],
  ]);
  const r = await admin.post('/api/migrate/import', { entity: 'supplier', file_name: '厂家.xlsx', data });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.counts.created, 3);
  assert.ok(r.data.batch.batch_no.startsWith('IMP'));
  supplierBatch = r.data.batch.id;
  const rows = (await admin.get('/api/e/supplier?q=CJ00')).data.rows;
  const by = Object.fromEntries(rows.map((x) => [x.code, x]));
  assert.equal(by.CJ001.type, '成品生产工厂');
  assert.equal(by.CJ002.type, '原辅材料供应商');
  assert.equal(by.CJ001.partner_supplier_id, by.CJ002.id, '合作厂家应在同一批次内关联');
  assert.equal(by.CJ003.use_status, '停用');
  assert.equal(by.CJ003.coop_status, '一般供应商');
  assert.ok(r.data.warnings.some((w) => /奇怪状态/.test(w.msg)));
});

let customerBatch;
test('TC-MIG-07 客户导入：业务员/跟单员按姓名或工号匹配，国别为空记为“未填写”', async () => {
  const data = xlsxB64([
    ['客户编号', '客户简称', '英文全称', '国别', '城市', '业务员', '跟单员', '价格条款', '币种', '佣金', '客户等级', '客户来源', 'Email'],
    ['KH001', 'WAL', 'Wal-Mart Stores,Inc', '美国', 'Bentonville', '林晓明', 'E003', 'FOB', 'USD', '5%', 'A', '广交会', 'lwl@example.com'],
    ['KH002', 'IKEA', '', '', '', 'sales2', '', 'CIF', 'EUR', '', '白金客户', '朋友', ''],
  ]);
  const r = await admin.post('/api/migrate/import', { entity: 'customer', file_name: '客户.xlsx', data });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.counts.created, 2);
  customerBatch = r.data.batch.id;
  const rows = (await admin.get('/api/e/customer?q=KH00')).data.rows;
  const by = Object.fromEntries(rows.map((x) => [x.code, x]));
  assert.equal(by.KH001.salesman_id_label.startsWith('林晓明'), true);
  assert.ok(by.KH001.merchandiser_id_label.startsWith('王芳'));
  assert.equal(by.KH001.commission_rate, 5);
  assert.equal(by.KH001.source, '广交会');
  assert.equal(by.KH002.country, '未填写');
  assert.equal(by.KH002.source, '其它');
  assert.equal(by.KH002.level, 'B', '无效等级保持默认值');
  assert.match(by.KH002.remark, /【亿星原值】客户等级：白金客户；客户来源：朋友/, '不在可选项中的原值写入备注，不丢信息');
});

let sampleBatch;
test('TC-MIG-08 样品导入：尺寸拆分、包装率、厂家匹配、默认设计师；厂家不存在则不导入', async () => {
  const emps = (await admin.get('/api/options/employee')).data;
  const designer = emps.find((e) => e.label.startsWith('张雕塑'));
  const data = xlsxB64([
    ['货号', '厂号', '中文品名', '英文品名', '材质', '单位', '套数', '组成方式', '产品尺寸', '内', '中', '外', '外箱规格', 'CBM', '单价', '厂家', '系列'],
    ['XX003', 'XX003', '香精香料', 'Vehicle essential oil', '玻璃', 'PC', '1', '单件', '13.00 × 6.00 × 31.00', '1', '0', '16', '55.0 × 24.3 × 35.0', '0.047', '7.412', '武义恒隆', '香薰系列'],
    ['BL017', 'BL017', '玻璃盘', 'Glass panel', '玻璃', 'PC', '1', '单件', '10 × 8 × 5', '1', '0', '12', '', '', '3.88', 'CJ002', ''],
    ['LB023', 'LB023', '提篮', 'Basket', '编织', 'PC', '1', '单件', '', '1', '0', '2', '', '', '10.038', '不存在厂', ''],
    ['GSZ007', '', '', 'no name', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  ]);
  const noDesigner = await admin.post('/api/migrate/import', { entity: 'sample', file_name: '样品.xlsx', data, dry_run: true });
  assert.equal(noDesigner.data.counts.created, 0, '没有设计师时不应新增');
  const r = await admin.post('/api/migrate/import', { entity: 'sample', file_name: '样品.xlsx', data, defaults: { designer_id: designer.id } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.counts.created, 2);
  assert.equal(r.data.buckets.ref_missing.length, 1);
  assert.match(r.data.buckets.ref_missing[0].msg, /厂家“不存在厂”/);
  assert.equal(r.data.buckets.invalid.length, 1);
  sampleBatch = r.data.batch.id;
  const s = (await admin.get('/api/e/sample?q=XX003')).data.rows[0];
  assert.deepEqual([s.length_cm, s.width_cm, s.height_cm], [13, 6, 31]);
  assert.deepEqual([s.outer_l, s.outer_w, s.outer_h], [55, 24.3, 35]);
  assert.equal(s.pcs_per_carton, 16);
  assert.equal(s.factory_price, 7.412);
  assert.equal(s.series, '香薰系列');
  assert.equal(s.progress, '已完成');
  assert.ok(s.supplier_id_label.includes('武义恒隆'));
});

test('TC-MIG-09 覆盖/跳过：覆盖只改有值的列，空单元格不清空；跳过方式不修改', async () => {
  const data = xlsxB64([['客户编号', '客户简称', '城市', '币种'], ['KH001', 'WAL', 'New York', '']]);
  const skip = await admin.post('/api/migrate/import', { entity: 'customer', file_name: 'c2.xlsx', data, mode: 'skip' });
  assert.equal(skip.data.counts.skipped, 1);
  let c = (await admin.get('/api/e/customer?q=KH001')).data.rows[0];
  assert.equal(c.city, 'Bentonville');
  const over = await admin.post('/api/migrate/import', { entity: 'customer', file_name: 'c3.xlsx', data, mode: 'overwrite' });
  assert.equal(over.data.counts.updated, 1);
  c = (await admin.get('/api/e/customer?q=KH001')).data.rows[0];
  assert.equal(c.city, 'New York');
  assert.equal(c.currency, 'USD', '空单元格不应清空原有币种');
  // 回滚覆盖批次恢复原值 / rolling back the overwrite batch restores the old value
  const rb = await admin.post(`/api/migrate/batches/${over.data.batch.id}/rollback`);
  assert.equal(rb.status, 200, JSON.stringify(rb.data));
  assert.equal(rb.data.restored, 1);
  c = (await admin.get('/api/e/customer?q=KH001')).data.rows[0];
  assert.equal(c.city, 'Bentonville');
});

test('TC-MIG-10 回滚：只能回滚最近一次；被业务单据/样品引用的新增记录保留', async () => {
  // 客户：KH001 的“跳过”批次比首次导入更晚，必须先回滚它 / the later "skip" batch must be rolled back first
  const older = await admin.post(`/api/migrate/batches/${customerBatch}/rollback`);
  assert.equal(older.status, 400);
  assert.match(older.data.error, /最近一次/);
  const hist0 = (await admin.get('/api/migrate/batches')).data;
  const skipBatch = hist0.find((b) => b.entity === 'customer' && b.mode === 'skip' && b.status === '已导入');
  assert.equal((await admin.post(`/api/migrate/batches/${skipBatch.id}/rollback`)).status, 200);

  // 厂家：被样品引用的两个厂家保留，未被引用的旧厂删除 / suppliers referenced by samples are kept
  const rsup = await admin.post(`/api/migrate/batches/${supplierBatch}/rollback`);
  assert.equal(rsup.status, 200, JSON.stringify(rsup.data));
  assert.equal(rsup.data.deleted, 1);
  assert.equal(rsup.data.kept.length, 2);
  assert.match(rsup.data.kept[0].msg, /样品档案/);

  // 样品：删除本批次新增的两个货号 / samples created by the batch are deleted
  const rs = await admin.post(`/api/migrate/batches/${sampleBatch}/rollback`);
  assert.equal(rs.status, 200, JSON.stringify(rs.data));
  assert.equal(rs.data.deleted, 2);
  assert.equal((await admin.get('/api/e/sample?q=XX003')).data.total, 0);
  assert.equal((await admin.post(`/api/migrate/batches/${sampleBatch}/rollback`)).status, 400, '不能重复回滚');

  // 客户：被报价单引用的客户保留 / a customer referenced by a quote is kept
  const kh2 = (await admin.get('/api/e/customer?q=KH002')).data.rows[0];
  const q = await admin.post('/api/quotes', { customer_id: kh2.id, currency: 'USD', term: 'FOB', items: [{ sample_id: 1, qty: 100 }] });
  assert.equal(q.status, 200, JSON.stringify(q.data));
  const rc = await admin.post(`/api/migrate/batches/${customerBatch}/rollback`);
  assert.equal(rc.status, 200, JSON.stringify(rc.data));
  assert.equal(rc.data.deleted, 1);
  assert.equal(rc.data.kept.length, 1);
  assert.match(rc.data.kept[0].msg, /报价单/);

  const hist = await admin.get('/api/migrate/batches');
  assert.ok(hist.data.some((b) => b.id === sampleBatch && b.status === '已回滚'));
  const detail = await admin.get(`/api/migrate/batches/${sampleBatch}`);
  assert.equal(detail.data.buckets.ref_missing.length, 1);
});

test('TC-MIG-12 批次号唯一：同一秒内连续多次导入不会因批次号重复而失败', async () => {
  const data = xlsxB64([['厂家编号', '厂家简称'], ['CJ-SEQ', '连续导入测试厂']]);
  const res = await Promise.all(Array.from({ length: 12 }, () => admin.post('/api/migrate/import', { entity: 'supplier', file_name: 'seq.xlsx', data, mode: 'skip' })));
  assert.ok(res.every((r) => r.status === 200), JSON.stringify(res.map((r) => r.data.error).filter(Boolean)));
  const nos = res.map((r) => r.data.batch.batch_no);
  assert.equal(new Set(nos).size, nos.length);
});

test('TC-MIG-11 权限与模板：非管理员不能导入；模板列名采用亿星叫法', async () => {
  const data = xlsxB64([['客户编号', '客户简称', '国别'], ['KH900', 'X', 'Y']]);
  const r = await sales1.post('/api/migrate/import', { entity: 'customer', data });
  assert.equal(r.status, 403);
  const bad = await admin.post('/api/migrate/import', { entity: 'order', data });
  assert.equal(bad.status, 400);
  const noKey = await admin.post('/api/migrate/import', { entity: 'customer', data: xlsxB64([['名字'], ['x']]) });
  assert.equal(noKey.status, 400);
  assert.match(noKey.data.error, /客户编号/);
  const t = await admin.get('/api/migrate/template/sample');
  assert.equal(t.status, 200);
  const header = readTable(t.data)[0];
  assert.ok(header.includes('货号*') && header.includes('中文品名*') && header.includes('厂号') && header.includes('外箱规格'));
  const prof = await admin.get('/api/migrate/profiles');
  assert.deepEqual(prof.data.map((p) => p.key), ['supplier', 'customer', 'sample', 'sample_part', 'sample_process', 'sample_package']);
});
