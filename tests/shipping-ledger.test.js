'use strict';
/**
 * 批次5（出货与财务，对标亿星）测试：按发票出货（多订单合并、分柜装箱、报关明细、整票报关/出运、作废）、
 * 应收台账（订金、出货应收、加减项、其他应收、账龄、按到期日冲抵）、水单登记与认领、销账、应付台账
 * Batch-5 tests: invoice-based shipping, AR ledger, bank slips & claims, write-offs, AP ledger.
 * 用例编号与 docs/03-测试用例.md 对应 / Case IDs map to docs/03-测试用例.md
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

let srv;
let admin;
let sales1;
let sales2;
let finance;
let designer1;
let purchaser;
const S = {};
const near = (a, b, eps = 0.011) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);

test.before(async () => {
  srv = await startServer();
  [admin, sales1, sales2, finance, designer1, purchaser] = await Promise.all(['admin', 'sales1', 'sales2', 'finance1', 'designer1', 'purchase1'].map((u) => srv.login(u)));
  // 样品补海关编码、毛净重 / HS codes and weights
  await admin.put('/api/e/sample/1', { hs_code: '6913900000', gross_weight: 18, net_weight: 15 });
  await admin.put('/api/e/sample/3', { hs_code: '6912001000', gross_weight: 12, net_weight: 10 });
  const mk = async (body) => { const r = await sales1.post('/api/orders', body); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data; };
  S.oA = await mk({ customer_id: 1, currency: 'USD', term: 'FOB', delivery_date: '2026-12-31', deposit_rate: 30, items: [{ sample_id: 1, qty: 600, unit_price: 10 }, { sample_id: 3, qty: 2400, unit_price: 5 }] });
  S.oB = await mk({ customer_id: 1, currency: 'USD', term: 'FOB', delivery_date: '2026-12-31', items: [{ sample_id: 3, qty: 24, unit_price: 5 }] });
  S.oEUR = await mk({ customer_id: 1, currency: 'EUR', term: 'FOB', delivery_date: '2026-12-31', items: [{ sample_id: 3, qty: 24, unit_price: 5 }] });
});
test.after(() => srv.close());

// ===================== 出货中心 / shipping centre =====================
test('TC-SH-01 按发票出货：一张发票合并两张订单，自动算箱数/体积/毛净重，报关明细按海关编码汇总', async () => {
  const sh = await sales1.get('/api/customers/1/shippable');
  assert.equal(sh.status, 200);
  const line = (o, k) => sh.data.lines.find((l) => l.order_item_id === o.items[k].id);
  assert.equal(line(S.oA, 0).remain, 600);
  const r = await sales1.post('/api/ship-invoices', {
    customer_id: 1, currency: 'USD', invoice_no: 'INV-T-001', invoice_date: '2026-11-01', port_loading: 'XIAMEN', vessel: 'COSCO STAR 012E',
    new_lines: [
      { order_item_id: S.oA.items[0].id, qty: 300, container_no: 'cbhu1234567' },
      { order_item_id: S.oA.items[1].id, qty: 2400, container_no: 'CBHU1234567' },
      { order_item_id: S.oB.items[0].id, qty: 24, container_no: 'TGHU7654321' },
    ],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  S.inv = r.data;
  assert.equal(r.data.invoice_no, 'INV-T-001');
  assert.equal(r.data.status, '草稿');
  assert.equal(r.data.shipments.length, 2, '两张订单各生成一张出货单');
  assert.equal(r.data.due_date, '2026-12-01', '到期日默认发票日+30天');
  const l0 = r.data.lines.find((l) => l.item_no === 'YL-V001');
  assert.equal(l0.cartons, 50, '300只÷6只/箱');
  near(l0.cbm, 7.28);
  assert.equal(l0.gw, 900);
  assert.equal(l0.nw, 750);
  assert.equal(r.data.total.amount, 300 * 10 + 2400 * 5 + 24 * 5);
  assert.equal(r.data.customs.length, 2, '两个海关编码');
  const cup = r.data.customs.find((c) => c.hs_code === '6912001000');
  assert.equal(cup.qty, 2424);
  assert.equal(cup.amount, 12120);
  assert.deepEqual(r.data.containers.sort(), ['CBHU1234567', 'TGHU7654321', 'cbhu1234567'].sort());
  // 装箱修改：柜号统一大写、毛净重校验 / packing edits
  const up = await sales1.put(`/api/ship-invoices/${r.data.id}/lines/${l0.id}`, { container_no: 'cbhu1234567', gw: 905, nw: 760 });
  assert.equal(up.status, 200);
  assert.equal(up.data.lines.find((l) => l.id === l0.id).container_no, 'CBHU1234567');
  assert.equal((await sales1.put(`/api/ship-invoices/${r.data.id}/lines/${l0.id}`, { gw: 100, nw: 200 })).status, 400, '净重不能大于毛重');
  assert.equal((await sales1.put(`/api/ship-invoices/${r.data.id}/lines/${l0.id}`, { cartons: -1 })).status, 400);
  assert.equal((await sales1.put(`/api/ship-invoices/${r.data.id}/lines/${l0.id}`, { nw: 906 })).status, 400, '单独改净重也不能超过已保存的毛重905');
  assert.equal(r.data.trade_term, 'FOB', '价格条款默认取订单');
  // 订单页的出货单带有发票号 / shipments carry the invoice
  const oa = (await sales1.get(`/api/orders/${S.oA.id}`)).data;
  assert.equal(oa.shipments[0].invoice_id, r.data.id);
});

test('TC-SH-02 发票校验：币种/客户不一致、重复发票号、超量、数据范围、设计师', async () => {
  const eur = await sales1.post(`/api/ship-invoices/${S.inv.id}/shipments`, { new_lines: [{ order_item_id: S.oEUR.items[0].id, qty: 24 }] });
  assert.equal(eur.status, 409);
  assert.match(eur.data.error, /币种/);
  assert.equal((await sales1.post('/api/ship-invoices', { customer_id: 1, invoice_no: 'INV-T-001', new_lines: [{ order_item_id: S.oA.items[0].id, qty: 1 }] })).status, 409, '发票号重复');
  assert.equal((await sales1.post(`/api/ship-invoices/${S.inv.id}/shipments`, { new_lines: [{ order_item_id: S.oA.items[0].id, qty: 301 }] })).status, 409, '超过剩余可出货数量');
  assert.equal((await sales1.post('/api/ship-invoices', { customer_id: 1, new_lines: [] })).status, 400);
  assert.equal((await sales2.get(`/api/ship-invoices/${S.inv.id}`)).status, 404, '王芳看不到林晓明客户的发票');
  assert.equal((await sales2.post('/api/ship-invoices', { customer_id: 1, new_lines: [{ order_item_id: S.oA.items[0].id, qty: 1 }] })).status, 404);
  assert.equal((await designer1.get('/api/ship-invoices')).status, 403);
  const list = (await sales1.get('/api/ship-invoices')).data.rows.find((x) => x.id === S.inv.id);
  assert.equal(list.ship_count, 2);
  assert.equal(list.amount, S.inv.total.amount);
});

test('TC-SH-03 整票报关/出运：验货闭环、报关单号、柜号；出运后订单状态更新；作废只限草稿', async () => {
  const id = S.inv.id;
  assert.equal((await sales1.post(`/api/ship-invoices/${id}/status`, { status: '已报关' })).status, 400, '缺报关单号');
  const noInsp = await sales1.post(`/api/ship-invoices/${id}/status`, { status: '已报关', customs_no: '530120261100001' });
  assert.equal(noInsp.status, 409);
  assert.match(noInsp.data.error, /验货合格/);
  for (const s of S.inv.shipments) assert.equal((await sales1.put(`/api/shipments/${s.id}`, { inspection_status: '合格' })).status, 200);
  const dec = await sales1.post(`/api/ship-invoices/${id}/status`, { status: '已报关', customs_no: '530120261100001' });
  assert.equal(dec.status, 200, JSON.stringify(dec.data));
  assert.ok(dec.data.shipments.every((s) => s.status === '已报关' && s.customs_no === '530120261100001'));
  assert.equal((await sales1.post(`/api/ship-invoices/${id}/shipments`, { new_lines: [{ order_item_id: S.oA.items[0].id, qty: 1 }] })).status, 409, '报关后不能追加');
  assert.equal((await sales1.post(`/api/ship-invoices/${id}/status`, { status: '已作废' })).status, 409, '报关后不能作废');
  await sales1.put(`/api/ship-invoices/${id}`, { etd: '2026-11-03', bl_no: 'COSU6200001', consignee: 'HOMEDECOR GMBH', notify: 'SAME AS CONSIGNEE' });
  const go = await sales1.post(`/api/ship-invoices/${id}/status`, { status: '已出运' });
  assert.equal(go.status, 200, JSON.stringify(go.data));
  assert.equal(go.data.status, '已出运');
  assert.ok(go.data.shipments.every((s) => s.status === '已出运' && s.ship_date === '2026-11-03'));
  assert.equal((await sales1.get(`/api/orders/${S.oA.id}`)).data.status, '部分出货');
  assert.equal((await sales1.get(`/api/orders/${S.oB.id}`)).data.status, '已出货');
  assert.equal((await sales1.put(`/api/ship-invoices/${id}`, { remark: 'x' })).status, 409, '已出运不能修改');
  // 作废草稿发票：出货单保留并回到未开票 / voiding a draft keeps its shipments
  const d = await sales1.post('/api/ship-invoices', { customer_id: 1, currency: 'USD', new_lines: [{ order_item_id: S.oA.items[0].id, qty: 100 }] });
  assert.equal(d.status, 200, JSON.stringify(d.data));
  assert.equal((await sales1.post(`/api/ship-invoices/${d.data.id}/status`, { status: '已作废' })).status, 200);
  const sh = (await sales1.get('/api/customers/1/shippable')).data;
  assert.ok(sh.shipments.some((s) => s.id === d.data.shipments[0].id), '作废后出货单回到未开票列表');
  // 已有出货单加入新发票 / attach an existing shipment to a new invoice
  const n = await sales1.post('/api/ship-invoices', { customer_id: 1, currency: 'USD', shipment_ids: [d.data.shipments[0].id] });
  assert.equal(n.status, 200, JSON.stringify(n.data));
  assert.equal(n.data.shipments.length, 1);
  assert.equal((await sales1.del(`/api/ship-invoices/${n.data.id}/shipments/${d.data.shipments[0].id}`)).status, 409, '至少保留一张出货单');
});

// ===================== 应收台账 / AR ledger =====================
test('TC-AR-01 应收台账：订金在下单日到期，出货应收扣除订金，按到期日冲抵收款，账龄汇总', async () => {
  const totalA = 600 * 10 + 2400 * 5;
  const l = (await finance.get('/api/ar-ledger')).data;
  const a = l.entries.filter((e) => e.order_id === S.oA.id);
  const dep = a.find((e) => e.kind === '预收订金');
  assert.equal(dep.amount, totalA * 0.3);
  assert.equal(dep.due_date, S.oA.order_date);
  const shipA = a.find((e) => e.kind === '出货应收');
  assert.equal(shipA.source_no, 'INV-T-001');
  assert.equal(shipA.gross, 300 * 10 + 2400 * 5);
  assert.equal(shipA.amount, 15000 - totalA * 0.3, '出货应收扣除已列的订金');
  assert.equal(shipA.due_date, '2026-12-01');
  const b = l.entries.find((e) => e.order_id === S.oB.id && e.kind === '出货应收');
  assert.equal(b.amount, 120);
  assert.ok(l.ageing.some((x) => x.currency === 'USD' && x.total > 0));
  assert.deepEqual(l.buckets, ['未到期', '1-30天', '31-60天', '61-90天', '90天以上']);
  // 收订金 → 先冲订金 / a deposit receipt is applied to the deposit first
  assert.equal((await finance.post('/api/receipts', { order_id: S.oA.id, type: '预收', amount: 2000, rate: 7.1 })).status, 200);
  const l2 = (await finance.get('/api/ar-ledger')).data.entries.filter((e) => e.order_id === S.oA.id);
  assert.equal(l2.find((e) => e.kind === '预收订金').received, 2000);
  assert.equal(l2.find((e) => e.kind === '预收订金').status, '部分收款');
  assert.equal(l2.find((e) => e.kind === '出货应收').received, 0);
  // 业务员只看本人 / scope
  assert.ok((await sales1.get('/api/ar-ledger')).data.entries.some((e) => e.order_id === S.oA.id));
  assert.ok(!(await sales2.get('/api/ar-ledger')).data.entries.some((e) => e.order_id === S.oA.id));
});

test('TC-AR-02 其他应收、水单登记与认领：业务员认领到本人订单生成收款，超额拒绝，财务可撤销', async () => {
  const other = await finance.post('/api/ar-others', { customer_id: 1, kind: '样品费', currency: 'USD', amount: 50, due_date: '2026-11-30', source_no: 'SS-TEST' });
  assert.equal(other.status, 200, JSON.stringify(other.data));
  assert.equal((await finance.post('/api/ar-others', { customer_id: 1, kind: 'x', currency: 'USD', amount: 0 })).status, 400);
  assert.equal((await sales1.post('/api/ar-others', { customer_id: 1, kind: 'x', currency: 'USD', amount: 5 })).status, 403, '业务员不能登记应收');
  const slip = await finance.post('/api/bank-slips', { receive_date: '2026-11-05', payer: 'HOMEDECOR GMBH', customer_id: 1, currency: 'USD', amount: 3000, fee: 20, bank: '中国银行' });
  assert.equal(slip.status, 200, JSON.stringify(slip.data));
  assert.equal(slip.data.claimable, 3020, '到账+手续费 = 客户付款额');
  assert.equal(slip.data.status, '未认领');
  S.slip = slip.data;
  assert.equal((await sales1.post('/api/bank-slips', { receive_date: '2026-11-05', currency: 'USD', amount: 1 })).status, 403);
  assert.equal((await sales2.get(`/api/bank-slips/${slip.data.id}`)).status, 404, '他人客户的水单看不到');
  const det = (await sales1.get(`/api/bank-slips/${slip.data.id}`)).data;
  assert.ok(det.targets.some((t) => t.target_type === 'order' && t.target_id === S.oA.id));
  assert.ok(det.targets.some((t) => t.target_type === 'other' && t.target_id === other.data.id));
  assert.ok(!det.targets.some((t) => t.target_id === S.oEUR.id && t.target_type === 'order'), '不同币种订单不出现');
  const over = await sales1.post(`/api/bank-slips/${slip.data.id}/claim`, { claims: [{ target_type: 'order', target_id: S.oA.id, amount: 3021 }] });
  assert.equal(over.status, 409);
  const eur = await sales1.post(`/api/bank-slips/${slip.data.id}/claim`, { claims: [{ target_type: 'order', target_id: S.oEUR.id, amount: 10 }] });
  assert.equal(eur.status, 409);
  const ok = await sales1.post(`/api/bank-slips/${slip.data.id}/claim`, { claims: [{ target_type: 'order', target_id: S.oA.id, amount: 2970 }, { target_type: 'other', target_id: other.data.id, amount: 50 }] });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.status, '已认领');
  assert.equal(ok.data.remaining, 0);
  const rec = (await finance.get(`/api/receivables/${S.oA.id}`)).data;
  const r = rec.receipts.find((x) => x.voucher === S.slip.slip_no);
  assert.equal(r.amount, 2970);
  assert.equal(r.type, '尾款', '已出运订单记为尾款');
  const led = (await finance.get('/api/ar-ledger')).data.entries;
  assert.equal(led.find((e) => e.other_id === other.data.id).status, '已收');
  // 撤销认领（需要审核权限）/ cancelling needs audit permission
  const claims = (await finance.get(`/api/bank-slips/${slip.data.id}`)).data.claims;
  assert.equal((await sales1.del(`/api/slip-claims/${claims[0].id}`)).status, 403);
  assert.equal((await finance.del(`/api/slip-claims/${claims[0].id}`)).status, 200);
  assert.ok(!(await finance.get(`/api/receivables/${S.oA.id}`)).data.receipts.some((x) => x.voucher === S.slip.slip_no), '撤销后收款同时删除');
  assert.equal((await finance.get(`/api/bank-slips/${slip.data.id}`)).data.status, '部分认领');
  assert.equal((await finance.del(`/api/bank-slips/${slip.data.id}`)).status, 409, '有认领的水单不能删除');
  assert.equal((await finance.del(`/api/ar-others/${other.data.id}`)).status, 409, '已认领的其他应收不能删除');
});

test('TC-AR-03 销账：需审核权限与原因、不超过上限和未收余额；计入已收齐与订单完结', async () => {
  // 订单B：应收120，收116 + 销账4 → 可完结 / order B: 120 = 116 received + 4 written off
  assert.equal((await finance.post('/api/receipts', { order_id: S.oB.id, type: '尾款', amount: 116, rate: 7.1 })).status, 200);
  assert.equal((await sales1.post(`/api/orders/${S.oB.id}/status`, { status: '已完成' })).status, 409, '未收齐不能完结');
  assert.equal((await sales1.post(`/api/orders/${S.oB.id}/writeoff`, { amount: 4, reason: '银行扣费' })).status, 403);
  assert.equal((await finance.post(`/api/orders/${S.oB.id}/writeoff`, { amount: 4 })).status, 400, '必须写原因');
  assert.equal((await finance.post(`/api/orders/${S.oB.id}/writeoff`, { amount: 5, reason: '银行扣费' })).status, 409, '超过未收余额');
  assert.equal((await finance.post(`/api/orders/${S.oA.id}/writeoff`, { amount: 60, reason: '尾差' })).status, 409, '超过单笔上限50');
  const w = await finance.post(`/api/orders/${S.oB.id}/writeoff`, { amount: 4, reason: '银行扣费' });
  assert.equal(w.status, 200, JSON.stringify(w.data));
  const rb = (await finance.get(`/api/receivables/${S.oB.id}`)).data;
  assert.equal(rb.written_off, 4);
  assert.equal(rb.unreceived, 0);
  assert.equal(rb.receive_status, '已收齐');
  assert.equal((await finance.post('/api/receipts', { order_id: S.oB.id, type: '尾款', amount: 1 })).status, 409, '销账后不能再多收');
  assert.equal((await sales1.post(`/api/orders/${S.oB.id}/status`, { status: '已完成' })).status, 200, '收款+销账=应收，可完结');
  assert.equal((await finance.del(`/api/writeoffs/${w.data.id}`)).status, 409, '已完成订单不能撤销销账');
  const led = (await finance.get('/api/ar-ledger')).data.entries.find((e) => e.order_id === S.oB.id);
  assert.equal(led.status, '已收');
});

// ===================== 应付台账 / AP ledger =====================
test('TC-AP-01 应付台账：到期日=交货期+账期（月结30天），预付类在下单日到期；付款后未付减少', async () => {
  const p1 = await purchaser.post('/api/purchases', { supplier_id: 4, type: '原辅材料', order_id: S.oA.id, due_date: '2026-11-10', items: [{ inventory_id: 3, qty: 100, price: 2 }] });
  assert.equal(p1.status, 200, JSON.stringify(p1.data));
  const p2 = await purchaser.post('/api/purchases', { supplier_id: 5, type: '外购成品', due_date: '2026-11-20', items: [{ inventory_id: 1, qty: 10, price: 30 }] });
  assert.equal(p2.status, 200, JSON.stringify(p2.data));
  let l = (await finance.get('/api/ap-ledger')).data;
  const e1 = l.entries.find((e) => e.id === p1.data.id);
  assert.equal(e1.credit_days, 30);
  assert.equal(e1.pay_due_date, '2026-12-10');
  assert.equal(e1.outstanding, 200);
  assert.equal(e1.pay_status, '未付');
  const e2 = l.entries.find((e) => e.id === p2.data.id);
  assert.equal(e2.pay_due_date, e2.order_date, '预付类在下单日到期');
  const pay = await purchaser.post(`/api/purchases/${p1.data.id}/payments`, { amount: 80 });
  assert.equal(pay.status, 200, JSON.stringify(pay.data));
  l = (await finance.get('/api/ap-ledger')).data;
  assert.equal(l.entries.find((e) => e.id === p1.data.id).pending, 80, '待审批付款单独显示');
  assert.equal((await sales1.get('/api/ap-ledger')).status, 403, '业务员无采购权限');
  assert.ok(l.ageing.length >= 1);
});
