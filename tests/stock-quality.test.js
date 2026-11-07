'use strict';
/**
 * 批次6（库存与验货，对标亿星）测试：仓库、期初、采购入库/领料出库流水、其他入库出库、调拨、分仓库存、盘点、验货单
 * Batch-6 tests: warehouses, opening balances, stock moves from receipts/issues, other in/out, transfers, stocktakes, inspections.
 * 用例编号与 docs/03-测试用例.md 对应 / Case IDs map to docs/03-测试用例.md
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');
const { audit } = require('../scripts/audit-data');

let srv;
let admin;
let sales1;
let sales2;
let purchaser;
let finance;
let designer1;
const S = {};

test.before(async () => {
  srv = await startServer();
  [admin, sales1, sales2, purchaser, finance, designer1] = await Promise.all(['admin', 'sales1', 'sales2', 'purchase1', 'finance1', 'designer1'].map((u) => srv.login(u)));
});
test.after(() => srv.close());

const bal = async (code) => {
  const d = (await purchaser.get('/api/stock/balances')).data;
  const r = d.rows.find((x) => x.code === code);
  return { ...r, wh: Object.fromEntries(d.warehouses.map((w) => [w.name, r.by[w.id] || 0])) };
};
const auditOk = () => {
  const bad = audit(srv.app.db).filter((x) => !x.ok);
  assert.deepEqual(bad.map((x) => `${x.name}：${x.detail}`), []);
};

test('TC-ST-01 期初与仓库：系统自动建“主仓库”，现有库存记为期初流水；新建仓库；档案中直接改数量记“库存调整”', async () => {
  const whs = (await purchaser.get('/api/e/warehouse')).data.rows;
  assert.equal(whs[0].name, '主仓库');
  S.main = whs[0].id;
  const w2 = await purchaser.post('/api/e/warehouse', { code: 'WH02', name: '包材仓', type: '包材仓', keeper: '赵采购' });
  assert.equal(w2.status, 200, JSON.stringify(w2.data));
  S.pack = w2.data.id;
  const inv = (await purchaser.get('/api/e/inventory?l_code=P-CTN-01')).data.rows[0] || (await purchaser.get('/api/e/inventory?size=1')).data.rows[0];
  S.inv = inv;
  const b = await bal(inv.code);
  assert.equal(b.wh['主仓库'], inv.qty, '期初全部在主仓库');
  const moves = (await purchaser.get('/api/stock/moves')).data.rows.filter((m) => m.inventory_id === inv.id);
  assert.ok(moves.some((m) => m.type === '期初'));
  assert.equal((await purchaser.put(`/api/e/inventory/${inv.id}`, { qty: inv.qty + 5 })).status, 200);
  const m2 = (await purchaser.get('/api/stock/moves')).data.rows.find((m) => m.inventory_id === inv.id && m.type === '库存调整');
  assert.equal(m2.qty, 5);
  const created = await purchaser.post('/api/e/inventory', { code: 'NEW-01', name: '新物料', unit: '个', qty: 30, unit_cost: 2, warehouse_id: S.pack });
  assert.equal(created.status, 200);
  assert.equal((await bal('NEW-01')).wh['包材仓'], 30, '新建物料带数量记为期初，进默认仓库');
  assert.equal((await admin.del(`/api/e/warehouse/${S.pack}`)).status, 409, '有流水的仓库不能删除');
  auditOk();
});

test('TC-ST-02 其他入库（加权平均成本）、其他出库（需用途、按仓库校验库存）、调拨（总数不变）', async () => {
  const before = (await purchaser.get(`/api/e/inventory/${S.inv.id}`)).data;
  const rin = await purchaser.post('/api/stock/in', { warehouse_id: S.pack, items: [{ inventory_id: S.inv.id, qty: 100, unit_cost: 4 }], remark: '供应商补货' });
  assert.equal(rin.status, 200, JSON.stringify(rin.data));
  const after = (await purchaser.get(`/api/e/inventory/${S.inv.id}`)).data;
  assert.equal(after.qty, before.qty + 100);
  assert.equal(after.unit_cost, Math.round((before.qty * before.unit_cost + 400) / (before.qty + 100) * 10000) / 10000, '加权平均');
  assert.equal((await bal(S.inv.code)).wh['包材仓'], 100);
  assert.equal((await purchaser.post('/api/stock/out', { warehouse_id: S.pack, items: [{ inventory_id: S.inv.id, qty: 10 }] })).status, 400, '出库需填写用途');
  const tooMuch = await purchaser.post('/api/stock/out', { warehouse_id: S.pack, items: [{ inventory_id: S.inv.id, qty: 101 }], remark: '报废' });
  assert.equal(tooMuch.status, 409);
  assert.match(tooMuch.data.error, /包材仓/);
  assert.equal((await purchaser.post('/api/stock/out', { warehouse_id: S.pack, items: [{ inventory_id: S.inv.id, qty: 10 }], remark: '破损报废' })).status, 200);
  const t = await purchaser.post('/api/stock/transfer', { from_id: S.pack, to_id: S.main, items: [{ inventory_id: S.inv.id, qty: 30 }] });
  assert.equal(t.status, 200, JSON.stringify(t.data));
  const b = await bal(S.inv.code);
  assert.equal(b.wh['包材仓'], 60);
  assert.equal(b.qty, before.qty + 90, '调拨不改变总数');
  assert.equal((await purchaser.post('/api/stock/transfer', { from_id: S.pack, to_id: S.pack, items: [{ inventory_id: S.inv.id, qty: 1 }] })).status, 400);
  assert.equal((await purchaser.post('/api/stock/transfer', { from_id: S.pack, to_id: S.main, items: [{ inventory_id: S.inv.id, qty: 61 }] })).status, 409);
  assert.equal((await sales1.post('/api/stock/in', { warehouse_id: S.main, items: [{ inventory_id: S.inv.id, qty: 1 }] })).status, 403);
  auditOk();
});

test('TC-ST-03 采购入库进指定仓库、按单领料自动从有货的仓库出库并写流水', async () => {
  const o = await sales1.post('/api/orders', { customer_id: 1, currency: 'USD', delivery_date: '2027-02-01', items: [{ sample_id: 1, qty: 60, unit_price: 9 }] });
  S.order = o.data;
  const po = await purchaser.post('/api/purchases', { supplier_id: 4, type: '原辅材料', order_id: o.data.id, items: [{ inventory_id: S.inv.id, qty: 50, price: 3 }] });
  assert.equal(po.status, 200, JSON.stringify(po.data));
  const rc = await purchaser.post(`/api/purchases/${po.data.id}/receive`, { warehouse_id: S.pack, items: [{ id: po.data.items[0].id, qty: 50 }] });
  assert.equal(rc.status, 200, JSON.stringify(rc.data));
  assert.equal((await bal(S.inv.code)).wh['包材仓'], 110);
  const mv = (await purchaser.get('/api/stock/moves')).data.rows.find((m) => m.type === '采购入库' && m.ref_no === po.data.po_no);
  assert.equal(mv.warehouse_name, '包材仓');
  const total = (await bal(S.inv.code)).qty;
  const iss = await purchaser.post('/api/material-issues', { inventory_id: S.inv.id, order_id: o.data.id, qty: total - 5 });
  assert.equal(iss.status, 200, JSON.stringify(iss.data));
  const b = await bal(S.inv.code);
  assert.equal(b.qty, 5);
  const outs = (await purchaser.get('/api/stock/moves')).data.rows.filter((m) => m.type === '领料出库' && m.inventory_id === S.inv.id);
  assert.ok(outs.length >= 1);
  assert.equal(Math.round(outs.reduce((a, m) => a + m.qty, 0) * 1000) / 1000, -(total - 5));
  assert.equal((await purchaser.post('/api/material-issues', { inventory_id: S.inv.id, order_id: o.data.id, qty: 6 })).status, 409, '库存不足');
  auditOk();
});

test('TC-ST-04 盘点：生成盘点表、录入实盘、未录完不能确认、需审核权限、盘盈盘亏自动调整、同仓库不能同时两张', async () => {
  const st = await purchaser.post('/api/stocktakes', { warehouse_id: S.pack });
  assert.equal(st.status, 200, JSON.stringify(st.data));
  assert.ok(st.data.items.length >= 2);
  assert.equal((await purchaser.post('/api/stocktakes', { warehouse_id: S.pack })).status, 409);
  const lines = st.data.items;
  const a = lines.find((x) => x.code === 'NEW-01');
  const b = lines.find((x) => x.inventory_id === S.inv.id);
  assert.equal((await purchaser.put(`/api/stocktakes/${st.data.id}`, { items: [{ id: a.id, actual_qty: 28, remark: '破损2个' }] })).status, 200);
  assert.equal((await finance.post(`/api/stocktakes/${st.data.id}/confirm`)).status, 400, '还有未录入的');
  assert.equal((await purchaser.put(`/api/stocktakes/${st.data.id}`, { items: [{ id: b.id, actual_qty: -1 }] })).status, 400);
  const rest = lines.filter((x) => x.id !== a.id).map((x) => ({ id: x.id, actual_qty: x.id === b.id ? x.book_qty + 3 : x.book_qty }));
  await purchaser.put(`/api/stocktakes/${st.data.id}`, { items: rest });
  assert.equal((await purchaser.post(`/api/stocktakes/${st.data.id}/confirm`)).status, 403, '采购员无审核权限');
  const c = await finance.post(`/api/stocktakes/${st.data.id}/confirm`);
  assert.equal(c.status, 200, JSON.stringify(c.data));
  assert.equal(c.data.status, '已完成');
  assert.equal((await bal('NEW-01')).wh['包材仓'], 28);
  const types = (await purchaser.get('/api/stock/moves')).data.rows.filter((m) => m.move_no === st.data.st_no).map((m) => m.type).sort();
  assert.deepEqual(types, ['盘亏', '盘盈']);
  assert.equal((await purchaser.put(`/api/stocktakes/${st.data.id}`, { items: [] })).status, 409, '完成后不能修改');
  auditOk();
});

test('TC-QC-01 验货单：不合格需写问题、结果同步出货单（验货闭环）、数据范围与权限', async () => {
  const o = (await sales1.get(`/api/orders/${S.order.id}`)).data;
  const sh = await sales1.post(`/api/orders/${o.id}/shipments`, { items: [{ order_item_id: o.items[0].id, qty: 60 }] });
  assert.equal(sh.status, 200);
  assert.equal((await sales1.post('/api/inspections', { order_id: o.id, shipment_id: sh.data.id, result: '不合格' })).status, 400, '不合格需写问题');
  assert.equal((await sales1.post('/api/inspections', { order_id: o.id, lot_qty: 10, sample_size: 20 })).status, 400, '抽样数不能大于批量');
  const bad = await sales1.post('/api/inspections', { order_id: o.id, shipment_id: sh.data.id, type: '尾期验货', inspector: '第三方SGS', aql: 'II/2.5', lot_qty: 60, sample_size: 13, major: 2, minor: 3, result: '不合格', defects: '釉面缩釉2只、底部毛刺3只',
    items: [{ order_item_id: o.items[0].id, check_qty: 13, defect_qty: 5, result: '不合格' }] });
  assert.equal(bad.status, 200, JSON.stringify(bad.data));
  let s = (await sales1.get(`/api/orders/${o.id}`)).data.shipments.find((x) => x.id === sh.data.id);
  assert.equal(s.inspection_status, '不合格');
  assert.match(s.inspection_note, /缩釉/);
  assert.equal((await sales1.put(`/api/shipments/${sh.data.id}`, { status: '已报关', customs_no: 'X' })).status, 409, '不合格不能报关');
  const re = await sales1.post('/api/inspections', { order_id: o.id, shipment_id: sh.data.id, type: '复验', lot_qty: 60, sample_size: 13, result: '合格' });
  assert.equal(re.status, 200);
  s = (await sales1.get(`/api/orders/${o.id}`)).data.shipments.find((x) => x.id === sh.data.id);
  assert.equal(s.inspection_status, '合格');
  assert.equal(re.data.ship_no, s.ship_no);
  assert.equal((await sales2.get(`/api/inspections/${bad.data.id}`)).status, 404, '他人订单的验货单看不到');
  assert.equal((await designer1.get('/api/inspections')).status, 403);
  const list = (await sales1.get('/api/inspections')).data.rows;
  assert.equal(list.filter((x) => x.order_id === o.id).length, 2);
  const upd = await sales1.put(`/api/inspections/${bad.data.id}`, { remark: '工厂已返工' });
  assert.equal(upd.status, 200);
  assert.equal(upd.data.items.length, 1, '未提交明细时保留原明细');
  assert.equal((await sales1.post('/api/inspections', { order_id: o.id, result: '优秀' })).status, 400);
});
