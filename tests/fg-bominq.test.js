'use strict';
/**
 * 成品库存（按订单入库、销售出库、退货、出运前须出库参数）、样品明细 Excel 导入、配件/包材/工序询价 测试
 * Tests: finished goods per order (in, issue, return, optional departure rule), sample-detail Excel imports,
 * parts/packaging/process inquiries.
 * 用例编号与 docs/03-测试用例.md 对应 / Case IDs map to docs/03-测试用例.md
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');
const { buildXlsx } = require('../server/xlsx');
const { audit } = require('../scripts/audit-data');

let srv;
let admin;
let sales1;
let sales2;
let purchaser;
let prod;
let designer1;
const S = {};
const auditOk = () => assert.deepEqual(audit(srv.app.db).filter((x) => !x.ok).map((x) => `${x.name}：${x.detail}`), []);
const xlsx = (rows) => buildXlsx({ rows }).toString('base64');

test.before(async () => {
  srv = await startServer();
  [admin, sales1, sales2, purchaser, prod, designer1] = await Promise.all(['admin', 'sales1', 'sales2', 'purchase1', 'prod1', 'designer1'].map((u) => srv.login(u)));
  const o = await sales1.post('/api/orders', { customer_id: 1, currency: 'USD', delivery_date: '2027-02-01', items: [{ sample_id: 1, qty: 100, unit_price: 9 }, { sample_id: 3, qty: 240, unit_price: 4 }] });
  assert.equal(o.status, 200, JSON.stringify(o.data));
  S.o = o.data;
});
test.after(() => srv.close());

// ===================== 成品库存 / finished goods =====================
test('TC-FG-01 产品入库：按订单明细入库，自动建成品档案，合计不超过订单数量，权限', async () => {
  const [a, b] = S.o.items;
  assert.equal((await sales1.post(`/api/orders/${S.o.id}/fg-in`, { items: [{ order_item_id: a.id, qty: 10 }] })).status, 403, '业务员不能入库');
  const r = await prod.post(`/api/orders/${S.o.id}/fg-in`, { items: [{ order_item_id: a.id, qty: 60 }, { order_item_id: b.id, qty: 240 }], remark: '包装完工' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const la = r.data.lines.find((l) => l.order_item_id === a.id);
  assert.equal(la.in_qty, 60);
  assert.equal(la.stock, 60);
  const inv = (await purchaser.get('/api/e/inventory?l_code=YL-V001')).data.rows[0];
  assert.equal(inv.category, '成品');
  assert.equal(inv.sample_id, 1);
  assert.equal(inv.qty, 60);
  assert.equal((await prod.post(`/api/orders/${S.o.id}/fg-in`, { items: [{ order_item_id: a.id, qty: 41 }] })).status, 409, '超过订单数量');
  assert.equal((await prod.post(`/api/orders/${S.o.id}/fg-in`, { items: [] })).status, 400);
  assert.equal((await designer1.get(`/api/orders/${S.o.id}/fg`)).status, 403);
  auditOk();
});

test('TC-FG-02 销售出库：按出货单出库，不超过本订单在库；退货回库；按发票出库', async () => {
  const [a, b] = S.o.items;
  const sh = await sales1.post(`/api/orders/${S.o.id}/shipments`, { items: [{ order_item_id: a.id, qty: 80 }, { order_item_id: b.id, qty: 120 }] });
  assert.equal(sh.status, 200);
  S.sh = sh.data;
  const bad = await sales1.post(`/api/shipments/${sh.data.id}/fg-out`);
  assert.equal(bad.status, 409, '在库60不够出80');
  assert.match(bad.data.error, /YL-V001.*在库 60/);
  await prod.post(`/api/orders/${S.o.id}/fg-in`, { items: [{ order_item_id: a.id, qty: 20 }] });
  const ok = await sales1.post(`/api/shipments/${sh.data.id}/fg-out`);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const la = ok.data.lines.find((l) => l.order_item_id === a.id);
  assert.equal(la.out_qty, 80);
  assert.equal(la.stock, 0);
  assert.equal(ok.data.shipments[0].out_done, true);
  assert.equal((await sales1.post(`/api/shipments/${sh.data.id}/fg-out`)).status, 409, '已全部出库');
  assert.equal((await sales2.post(`/api/shipments/${sh.data.id}/fg-out`)).status, 404);
  // 退货 / returns
  assert.equal((await sales1.post(`/api/shipments/${sh.data.id}/fg-return`, { items: [{ order_item_id: a.id, qty: 5 }] })).status, 400, '必须写原因');
  assert.equal((await sales1.post(`/api/shipments/${sh.data.id}/fg-return`, { reason: '破损', items: [{ order_item_id: a.id, qty: 81 }] })).status, 409);
  const ret = await sales1.post(`/api/shipments/${sh.data.id}/fg-return`, { reason: '客户退回破损品', items: [{ order_item_id: a.id, qty: 5 }] });
  assert.equal(ret.status, 200, JSON.stringify(ret.data));
  assert.equal(ret.data.lines.find((l) => l.order_item_id === a.id).stock, 5, '退回后计入本订单在库');
  // 按发票出库 / issue by invoice
  const sh2 = await sales1.post(`/api/orders/${S.o.id}/shipments`, { items: [{ order_item_id: b.id, qty: 120 }] });
  const inv = await sales1.post('/api/ship-invoices', { customer_id: 1, currency: 'USD', shipment_ids: [sh2.data.id] });
  assert.equal(inv.status, 200, JSON.stringify(inv.data));
  const io = await sales1.post(`/api/ship-invoices/${inv.data.id}/fg-out`);
  assert.equal(io.status, 200, JSON.stringify(io.data));
  assert.equal(io.data.lines, 1);
  const fg = (await sales1.get(`/api/orders/${S.o.id}/fg`)).data;
  assert.equal(fg.lines.find((l) => l.order_item_id === b.id).stock, 0);
  const moves = (await purchaser.get('/api/stock/moves')).data.rows.map((m) => m.type);
  for (const t of ['产品入库', '销售出库', '销售退货']) assert.ok(moves.includes(t), t);
  auditOk();
});

test('TC-FG-03 系统参数“出运前必须先出库”：开启后未出库的出货单不能出运；参数可在系统参数中修改', async () => {
  const [a] = S.o.items;
  assert.equal((await admin.put('/api/settings', { fg_require_out_before_ship: '2' })).status, 400);
  assert.equal((await admin.put('/api/settings', { fg_require_out_before_ship: '1', ar_writeoff_max: '80' })).status, 200);
  assert.equal((await admin.get('/api/settings')).data.ar_writeoff_max, '80', '销账上限也可在系统参数中修改');
  const sh = await sales1.post(`/api/orders/${S.o.id}/shipments`, { items: [{ order_item_id: a.id, qty: 5 }] });
  await sales1.put(`/api/shipments/${sh.data.id}`, { inspection_status: '合格' });
  const blocked = await sales1.put(`/api/shipments/${sh.data.id}`, { status: '已出运', customs_no: 'C1' });
  assert.equal(blocked.status, 409);
  assert.match(blocked.data.error, /销售出库/);
  assert.equal((await sales1.post(`/api/shipments/${sh.data.id}/fg-out`)).status, 200, '用退回的5只出库');
  assert.equal((await sales1.put(`/api/shipments/${sh.data.id}`, { status: '已出运', customs_no: 'C1' })).status, 200);
  await admin.put('/api/settings', { fg_require_out_before_ship: '0', ar_writeoff_max: '50' });
  auditOk();
});

// ===================== 样品明细导入 / sample-detail imports =====================
test('TC-IMP-01 配件/包材明细导入：按“货号+类别+名称”识别，货号不存在不导入，覆盖与跳过', async () => {
  const data = xlsx([
    ['货号', '类别', '材料编号', '材料名称', '规格', '数量', '用量按', '单位', '单价', '厂家'],
    ['YL-V002', '配件', 'PJ-01', '铜底座', 'Φ8cm', '1', '每只', '个', '3.5', '厦门华美包装'],
    ['YL-V002', '包材', 'BC-01', '外箱', '5层', '1', '每箱', '个', '7', ''],
    ['YL-V002', '包材', 'BC-01', '外箱', '5层', '1', '每箱', '个', '7', ''],
    ['NOPE-01', '配件', '', '螺丝', '', '2', '', '', '0.1', ''],
    ['YL-V002', '', '', '泡沫', '', '', '', '', '0.3', '不存在厂'],
  ]);
  const r = await admin.post('/api/migrate/import', { entity: 'sample_part', file_name: 'parts.xlsx', data });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.counts.created, 3);
  assert.equal(r.data.buckets.duplicate.length, 1);
  assert.equal(r.data.buckets.ref_missing.length, 1);
  assert.match(r.data.buckets.ref_missing[0].msg, /货号“NOPE-01”/);
  assert.ok(r.data.warnings.some((w) => /不存在厂/.test(w.msg)), '供应商不存在只提示');
  const bom = (await admin.get('/api/samples/2/bom')).data;
  const foam = bom.parts.find((p) => p.name === '泡沫');
  assert.equal(foam.kind, '配件', '类别为空默认配件');
  assert.equal(foam.qty, 1, '数量为空默认1');
  const again = await admin.post('/api/migrate/import', { entity: 'sample_part', file_name: 'parts2.xlsx', data: xlsx([['货号', '类别', '材料名称', '单价'], ['YL-V002', '配件', '铜底座', '3.8']]) });
  assert.equal(again.data.counts.updated, 1);
  assert.equal((await admin.get('/api/samples/2/bom')).data.parts.find((p) => p.name === '铜底座').unit_price, 3.8);
  const skip = await admin.post('/api/migrate/import', { entity: 'sample_part', mode: 'skip', data: xlsx([['货号', '类别', '材料名称', '单价'], ['YL-V002', '配件', '铜底座', '9']]) });
  assert.equal(skip.data.counts.skipped, 1);
  assert.equal((await admin.post(`/api/migrate/batches/${again.data.batch.id}/rollback`)).status, 400, '须先回滚更晚的批次');
  assert.equal((await admin.post(`/api/migrate/batches/${skip.data.batch.id}/rollback`)).status, 200);
  const rb = await admin.post(`/api/migrate/batches/${again.data.batch.id}/rollback`);
  assert.equal(rb.status, 200, JSON.stringify(rb.data));
  assert.equal((await admin.get('/api/samples/2/bom')).data.parts.find((p) => p.name === '铜底座').unit_price, 3.5, '回滚恢复覆盖前单价');
});

test('TC-IMP-02 工序明细与包装方案导入：外箱规格拆分、CBM自动算、“默认=是”同步样品', async () => {
  const proc = await admin.post('/api/migrate/import', { entity: 'sample_process', data: xlsx([['货号', '顺序', '工序名称', '工价', '加工厂'], ['YL-V002', '1', '注浆', '2.5', ''], ['YL-V002', '2', '施釉', '1.8', '']]) });
  assert.equal(proc.data.counts.created, 2);
  const pk = await admin.post('/api/migrate/import', { entity: 'sample_package', data: xlsx([
    ['货号', '包装方案', '内', '中', '外', '外箱规格', '毛重', '净重', '包装说明', '默认'],
    ['YL-V002', '出口彩盒装', '1', '0', '6', '52 × 40 × 70', '16', '13', '单只彩盒+泡沫', '是'],
    ['YL-V002', '白盒装', '', '', '12', '60×45×50', '', '', '', ''],
  ]) });
  assert.equal(pk.status, 200, JSON.stringify(pk.data));
  assert.equal(pk.data.counts.created, 2);
  const s = (await admin.get('/api/e/sample/2')).data;
  assert.deepEqual([s.pcs_per_carton, s.outer_l, s.outer_w, s.outer_h, s.cbm, s.gross_weight], [6, 52, 40, 70, 0.1456, 16]);
  const plans = (await admin.get('/api/e/sample_package?f_sample_id=2')).data.rows;
  assert.equal(plans.find((p) => p.name === '白盒装').cbm, 0.135);
  assert.equal(plans.find((p) => p.name === '白盒装').is_default, '否');
  const tpl = await admin.get('/api/migrate/template/sample_package');
  assert.equal(tpl.status, 200);
});

// ===================== 配件/工序询价 / BOM inquiries =====================
test('TC-XJ-01 配件/包材/工序询价：新建、发送、回价、比价、采用写回样品明细与历史价格、权限', async () => {
  const bom = (await admin.get('/api/samples/2/bom')).data;
  const base = bom.parts.find((p) => p.name === '铜底座');
  const proc = bom.processes.find((p) => p.name === '施釉');
  const sups = (await admin.get('/api/options/supplier')).data;
  const s1 = sups.find((x) => x.label.includes('华美'));
  const s2 = sups.find((x) => x.label.includes('外购'));
  assert.equal((await designer1.post('/api/bom-inquiries', { supplier_id: s1.id, lines: [{ source_type: 'part', source_id: base.id }] })).status, 403);
  assert.equal((await purchaser.post('/api/bom-inquiries', { supplier_id: s1.id, lines: [] })).status, 400);
  const q1 = await purchaser.post('/api/bom-inquiries', { supplier_id: s1.id, lines: [{ source_type: 'part', source_id: base.id, qty: 1000 }, { source_type: 'process', source_id: proc.id }] });
  assert.equal(q1.status, 200, JSON.stringify(q1.data));
  assert.equal(q1.data.status, '待发送');
  assert.equal(q1.data.items[0].old_price, 3.5);
  const q2 = await purchaser.post('/api/bom-inquiries', { supplier_id: s2.id, lines: [{ source_type: 'part', source_id: base.id, qty: 1000 }] });
  assert.equal((await purchaser.post(`/api/bom-inquiries/${q1.data.id}/sent`)).data.status, '已发送');
  assert.equal((await purchaser.put(`/api/bom-inquiries/${q1.data.id}/reply`, { items: [{ id: q1.data.items[0].id, price: -1 }] })).status, 400);
  const rp = await purchaser.put(`/api/bom-inquiries/${q1.data.id}/reply`, { items: [{ id: q1.data.items[0].id, price: 3.2, lead_days: 10 }, { id: q1.data.items[1].id, price: 1.6 }] });
  assert.equal(rp.data.status, '已回价');
  await purchaser.put(`/api/bom-inquiries/${q2.data.id}/reply`, { items: [{ id: q2.data.items[0].id, price: 3.0, lead_days: 15 }] });
  const cmp = (await purchaser.get(`/api/bom-inquiries/${q1.data.id}`)).data.items[0];
  assert.equal(cmp.others.length, 1);
  assert.equal(cmp.others[0].price, 3);
  assert.equal(cmp.lowest, false, '另一家更便宜');
  assert.equal((await purchaser.post(`/api/bom-inquiries/${q2.data.id}/adopt`, { item_ids: [] })).status, 400);
  const ad = await purchaser.post(`/api/bom-inquiries/${q2.data.id}/adopt`, { item_ids: [q2.data.items[0].id] });
  assert.equal(ad.status, 200, JSON.stringify(ad.data));
  const after = (await admin.get('/api/samples/2/bom')).data.parts.find((p) => p.name === '铜底座');
  assert.equal(after.unit_price, 3);
  assert.equal(after.supplier_id, s2.id);
  const ad2 = await purchaser.post(`/api/bom-inquiries/${q1.data.id}/adopt`, { item_ids: [q1.data.items[1].id] });
  assert.equal(ad2.status, 200);
  assert.equal((await admin.get('/api/samples/2/bom')).data.processes.find((p) => p.name === '施釉').price, 1.6);
  const prices = (await admin.get('/api/e/supplier_price?l_ref_no=XJ')).data.rows;
  assert.ok(prices.some((p) => p.source === '配件询价' && p.price === 3));
  assert.ok(prices.some((p) => p.source === '工序询价'));
  const rev = (await admin.get('/api/e/sample_revision?f_sample_id=2')).data.rows;
  assert.ok(rev.some((r) => /采用询价单/.test(r.content)));
  assert.equal((await purchaser.del(`/api/bom-inquiries/${q2.data.id}`)).status, 409, '已采用不能删除');
  const list = (await sales1.get('/api/bom-inquiries')).data.rows;
  assert.ok(list.length >= 2);
});
