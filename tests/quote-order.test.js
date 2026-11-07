'use strict';
/**
 * 批次2（报价/订单，对标亿星）测试：按行利润率、单价锁定、换汇成本、按体积分摊费用、复制/另存为、
 * 历史记录导入、订单概要/合同条款/唛头、加减项、效益测算、翻单
 * Batch-2 tests (quotes & orders modelled on 亿星).
 * 用例编号与 docs/03-测试用例.md 对应 / Case IDs map to docs/03-测试用例.md
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

let srv;
let admin;
let sales1;
let sales2;
let manager;
let finance;
let designer1;
const S = {};
const near = (a, b, eps = 0.0001) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);

test.before(async () => {
  srv = await startServer();
  [admin, sales1, sales2, manager, finance, designer1] = await Promise.all(['admin', 'sales1', 'sales2', 'manager1', 'finance1', 'designer1'].map((u) => srv.login(u)));
});
test.after(() => srv.close());

// ===================== 报价计价 / quote pricing =====================
test('TC-QP-01 亿星计价公式：单价 = 报价基准 ÷ 换汇成本 × (1+利润率)，并反算实际利润率', async () => {
  const r = await sales1.post('/api/quotes/calc', { currency: 'USD', term: 'FOB', fx_cost: 6, profit_rate: 20, items: [{ sample_id: 1, qty: 100, cost_cny: 42.76 }] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.items[0].price, 8.55, '42.76 ÷ 6 × 1.2 = 8.552 → 8.55');
  near(r.data.items[0].actual_profit_rate, 19.97, 0.005);
  assert.equal(r.data.divisor, 6);
  // 不填换汇成本时沿用汇率（原有公式不变）/ without FX cost the exchange rate is used as before
  const r2 = await sales1.post('/api/quotes/calc', { currency: 'USD', term: 'FOB', profit_rate: 20, items: [{ sample_id: 1, qty: 100, cost_cny: 42.76 }] });
  assert.equal(r2.data.items[0].price, Math.round(42.76 * 1.2 / 7.12 * 100) / 100);
  assert.equal((await sales1.post('/api/quotes/calc', { currency: 'USD', fx_cost: -1, items: [] })).status, 400, '换汇成本必须大于0');
  assert.equal((await sales1.post('/api/quotes/calc', { currency: 'USD', fee_alloc: '按重量', items: [] })).status, 400);
});

test('TC-QP-02 费用分摊：按体积（箱数×每箱CBM）与按数量；缺装箱资料时自动退回按数量', async () => {
  const items = [{ sample_id: 1, qty: 600, cost_cny: 43 }, { sample_id: 3, qty: 2400, cost_cny: 25 }];
  // YL-V001：100箱×0.1456=14.56m³；YL-T001：100箱×0.0525=5.25m³；总 19.81m³，费用 1981
  const vol = await sales1.post('/api/quotes/calc', { currency: 'USD', profit_rate: 20, freight: 1981, fee_alloc: '按体积', items });
  assert.equal(vol.data.fee_alloc, '按体积');
  near(vol.data.items[0].fee_share, 1456 / 600);
  near(vol.data.items[1].fee_share, 525 / 2400);
  near(vol.data.items[0].unit_cost, 43 + 1456 / 600);
  const qty = await sales1.post('/api/quotes/calc', { currency: 'USD', profit_rate: 20, freight: 1981, fee_alloc: '按数量', items });
  near(qty.data.items[0].fee_share, 1981 / 3000);
  near(qty.data.items[1].fee_share, 1981 / 3000);
  // 两种方式分摊总额相同 / both allocate the same total
  near(vol.data.items[0].fee_share * 600 + vol.data.items[1].fee_share * 2400, 1981, 0.2);
  // 新建一个没有外箱资料的样品 → 退回按数量 / sample without carton data → fallback
  const emps = (await admin.get('/api/options/employee')).data;
  const des = emps.find((e) => e.label.startsWith('张雕塑'));
  const ns = await admin.post('/api/e/sample', { company_no: 'QP-NOCTN', name: '无箱规样品', designer_id: des.id, material_cost: 10, labor_cost: 2 });
  assert.equal(ns.status, 200, JSON.stringify(ns.data));
  S.noCtn = ns.data.id;
  const fb = await sales1.post('/api/quotes/calc', { currency: 'USD', profit_rate: 20, freight: 1000, fee_alloc: '按体积', items: [...items, { sample_id: S.noCtn, qty: 100 }] });
  assert.equal(fb.data.fee_alloc, '按数量');
  assert.equal(fb.data.fee_fallback, true);
});

test('TC-QP-03 按行利润率与单价锁定：锁定行保存时不重算，其他行按各自利润率计算；提交审批按行预警', async () => {
  const body = {
    customer_id: 1, currency: 'USD', term: 'FOB', profit_rate: 20, fx_cost: 6.5, fee_alloc: '按体积', freight: 1981,
    items: [
      { sample_id: 1, qty: 600, cost_cny: 43, profit_rate: 30 },
      { sample_id: 3, qty: 2400, cost_cny: 25, price: 4.2, price_locked: true },
    ],
  };
  const q = await sales1.post('/api/quotes', body);
  assert.equal(q.status, 200, JSON.stringify(q.data));
  S.quote = q.data;
  const [a, b] = q.data.items;
  assert.equal(a.profit_rate, 30);
  assert.equal(a.price, Math.round((43 + 1456 / 600) * 1.3 / 6.5 * 100) / 100, '第一行按本行30%计算');
  near(a.actual_profit_rate, 30, 0.2);
  assert.equal(b.price_locked, 1);
  assert.equal(b.price, 4.2, '锁定单价不变');
  near(b.actual_profit_rate, (4.2 * 6.5 / (25 + 525 / 2400) - 1) * 100, 0.01);
  assert.equal(q.data.fx_cost, 6.5);
  assert.equal(q.data.fee_alloc, '按体积');
  // 再次保存（自动计价）锁定行仍不变 / re-save keeps the locked price
  const again = await sales1.put(`/api/quotes/${q.data.id}`, { ...body, items: q.data.items.map((i) => ({ ...i })) });
  assert.equal(again.data.items[1].price, 4.2);
  // 第二行实际利润率约 8%，低于最低 15% → 提交审批时预警 / line below minimum → warning
  const sub = await sales1.post(`/api/quotes/${q.data.id}/submit`);
  assert.equal(sub.status, 200);
  assert.equal(sub.data.low_profit, true);
  assert.deepEqual(sub.data.low_lines.map((x) => x.item_no), ['YL-T001']);
  const appr = (await manager.get('/api/approvals')).data.rows.find((x) => x.target_no === q.data.quote_no && x.status === '待审批');
  assert.match(appr.title, /YL-T001/);
});

test('TC-QP-04 复制为新报价、另存为送样单、历史记录导入（含数据范围）', async () => {
  const cp = await sales1.post(`/api/quotes/${S.quote.id}/copy`);
  assert.equal(cp.status, 200, JSON.stringify(cp.data));
  assert.notEqual(cp.data.quote_no, S.quote.quote_no);
  assert.equal(cp.data.status, '草稿');
  assert.equal(cp.data.items.length, 2);
  assert.equal(cp.data.items[1].price_locked, 1);
  assert.equal(cp.data.items[1].price, 4.2);
  assert.match(cp.data.remark, new RegExp(S.quote.quote_no));
  assert.equal((await sales2.post(`/api/quotes/${S.quote.id}/copy`)).status, 404, '他人报价不能复制');
  const send = await sales1.post(`/api/quotes/${S.quote.id}/to-send`, { item_ids: [S.quote.items[0].id] });
  assert.equal(send.status, 200, JSON.stringify(send.data));
  assert.equal(send.data.quote_id, S.quote.id);
  assert.equal(send.data.items.length, 1);
  assert.equal(send.data.status, '申请中');
  const hist = await sales1.get('/api/customers/1/history-items');
  assert.equal(hist.status, 200);
  assert.ok(hist.data.rows.some((r) => r.src === '报价' && r.doc_no === S.quote.quote_no && r.price === 4.2));
  assert.equal((await sales2.get('/api/customers/1/history-items')).status, 404, '看不到别人的客户历史');
});

// ===================== 订单 / orders =====================
test('TC-OD-01 订单概要/合同条款/唛头：新单从客户档案带出默认值；只改这些字段不触发变更风控；参数校验', async () => {
  assert.equal((await admin.put('/api/e/customer/1', { pay_terms: 'T/T 30% DEPOSIT, 70% BEFORE SHIPMENT', dest_port: 'HAMBURG' })).status, 200);
  assert.equal((await sales1.post('/api/e/customer_mark', { customer_id: 1, name: '主唛', front_mark: 'HOMEDECOR\nC/NO.1-UP', side_mark: 'MADE IN CHINA', is_default: '是' })).status, 200);
  const o = await sales1.post('/api/orders', { customer_id: 1, currency: 'USD', term: 'FOB', delivery_date: '2027-01-20', items: [{ sample_id: 1, qty: 600, unit_price: 9 }, { sample_id: 3, qty: 2400, unit_price: 4.5 }] });
  assert.equal(o.status, 200, JSON.stringify(o.data));
  S.order = o.data;
  assert.equal(o.data.pay_terms, 'T/T 30% DEPOSIT, 70% BEFORE SHIPMENT');
  assert.equal(o.data.port_dest, 'HAMBURG');
  assert.equal(o.data.front_mark, 'HOMEDECOR\nC/NO.1-UP');
  const upd = await sales1.put(`/api/orders/${o.data.id}`, {
    customer_id: 1, currency: 'USD', delivery_date: '2027-01-20', po_no: 'PO-HD-2027-01', deposit_rate: 30, port_loading: 'XIAMEN', transport: '海运', partial_shipment: '不允许', transshipment: '允许',
    insurance: '由买方投保', pi_no: 'PI-2027-001', sign_place: 'XIAMEN', contract_terms: '1. 质量以确认样为准\n2. 交货期以订金到账起算', factory_terms: '按我司包装要求', side_mark: 'MADE IN CHINA / FRAGILE', items: o.data.items,
  });
  assert.equal(upd.status, 200, JSON.stringify(upd.data));
  assert.equal(upd.data.po_no, 'PO-HD-2027-01');
  assert.equal(upd.data.deposit_rate, 30);
  assert.equal(upd.data.side_mark, 'MADE IN CHINA / FRAGILE');
  assert.equal(upd.data.front_mark, 'HOMEDECOR\nC/NO.1-UP', '未提交的字段保留原值');
  assert.equal(upd.data.changes.length, 0, '概要/条款/唛头不属于风控关键字段');
  // 只提交明细（如旧客户端）不会清空概要 / items-only update keeps the summary
  const keep = await sales1.put(`/api/orders/${o.data.id}`, { customer_id: 1, currency: 'USD', delivery_date: '2027-01-20', items: o.data.items });
  assert.equal(keep.data.po_no, 'PO-HD-2027-01');
  assert.equal(keep.data.contract_terms, '1. 质量以确认样为准\n2. 交货期以订金到账起算');
  const bad = await sales1.put(`/api/orders/${o.data.id}`, { customer_id: 1, currency: 'USD', delivery_date: '2027-01-20', deposit_rate: 120, items: o.data.items });
  assert.equal(bad.status, 400);
  const list = (await sales1.get('/api/orders')).data.rows.find((x) => x.id === o.data.id);
  assert.equal(list.po_no, 'PO-HD-2027-01');
});

test('TC-OD-02 加减项：计入合同总额、应收、收款与开票上限、订单完结；扣减不能低于已收款；权限', async () => {
  const id = S.order.id;
  const goods = 600 * 9 + 2400 * 4.5;
  assert.equal((await sales1.post(`/api/orders/${id}/charges`, { kind: '加', name: '模具费', amount: 800 })).status, 200);
  const d = await sales1.post(`/api/orders/${id}/charges`, { kind: '减', name: '老客户折扣', amount: 300 });
  assert.equal(d.status, 200);
  assert.equal(d.data.amount, goods + 500);
  let o = (await sales1.get(`/api/orders/${id}`)).data;
  assert.equal(o.goods_amount, goods);
  assert.equal(o.charges_amount, 500);
  assert.equal(o.amount, goods + 500);
  assert.equal(o.charges.length, 2);
  const rec = (await finance.get(`/api/receivables/${id}`)).data;
  assert.equal(rec.amount, goods + 500, '应收 = 合同总额');
  // 收款到“货款+400”（超过货款但未超过合同总额）可以 / receipt above goods but within total is allowed
  assert.equal((await finance.post('/api/receipts', { order_id: id, type: '预收', amount: goods + 400, rate: 7.12 })).status, 200);
  assert.equal((await finance.post('/api/receipts', { order_id: id, type: '尾款', amount: 200, rate: 7.12 })).status, 409, '超过合同总额不能收');
  // 再扣减 200 会让合同总额低于已收款 → 拒绝 / a deduction below received is refused
  const tooMuch = await sales1.post(`/api/orders/${id}/charges`, { kind: '减', name: '再折扣', amount: 200 });
  assert.equal(tooMuch.status, 409);
  assert.match(tooMuch.data.error, /低于已收款/);
  const mold = o.charges.find((c) => c.name === '模具费');
  assert.equal((await sales1.del(`/api/orders/${id}/charges/${mold.id}`)).status, 409, '删除加项会低于已收款');
  assert.equal((await sales1.post(`/api/orders/${id}/charges`, { kind: '乘', name: 'x', amount: 1 })).status, 400);
  assert.equal((await sales1.post(`/api/orders/${id}/charges`, { kind: '加', name: 'x', amount: 0 })).status, 400);
  assert.equal((await designer1.post(`/api/orders/${id}/charges`, { kind: '加', name: 'x', amount: 1 })).status, 403);
  assert.equal((await sales2.post(`/api/orders/${id}/charges`, { kind: '加', name: 'x', amount: 1 })).status, 404);
  const disc = o.charges.find((c) => c.name === '老客户折扣');
  assert.equal((await sales1.del(`/api/orders/${id}/charges/${disc.id}`)).status, 200, '删除减项使总额变大，允许');
  o = (await sales1.get(`/api/orders/${id}`)).data;
  assert.equal(o.amount, goods + 800);
  const ar = (await admin.get('/api/reports/business')).data;
  assert.ok(ar, '统计报表正常');
});

test('TC-OD-03 效益测算：报价转订单时按报价基准估成本，扣除客户佣金；无报价时按样品成本', async () => {
  await admin.put('/api/e/customer/1', { commission_rate: 3 });
  const q = await sales1.post('/api/quotes', { customer_id: 1, currency: 'USD', term: 'FOB', profit_rate: 25, fx_cost: 6.8, items: [{ sample_id: 2, qty: 500, cost_cny: 34, craft_add: 2 }] });
  assert.equal(q.status, 200, JSON.stringify(q.data));
  await sales1.post(`/api/quotes/${q.data.id}/submit`);
  const ap = (await manager.get('/api/approvals')).data.rows.find((x) => x.target_no === q.data.quote_no && x.status === '待审批');
  assert.equal((await manager.post(`/api/approvals/${ap.id}/decide`, { pass: true })).status, 200);
  const to = await manager.post(`/api/quotes/${q.data.id}/to-order`);
  assert.equal(to.status, 200, JSON.stringify(to.data));
  const o = (await sales1.get(`/api/orders/${to.data.id}`)).data;
  assert.equal(o.pay_terms, 'T/T 30% DEPOSIT, 70% BEFORE SHIPMENT', '报价转订单也带出客户默认值');
  assert.equal(o.front_mark, 'HOMEDECOR\nC/NO.1-UP');
  const e = o.estimate;
  assert.equal(e.lines[0].source, '报价基准');
  assert.equal(e.lines[0].unit_cost, 36);
  assert.equal(e.cost, 36 * 500);
  near(e.revenue_cny, o.amount * o.rate, 0.01);
  near(e.commission, e.revenue_cny * 0.03, 0.01);
  near(e.profit, e.revenue_cny - e.cost - e.commission, 0.01);
  // 无报价的订单：样品“材料+人工” / no quote → sample cost
  const plain = (await sales1.get(`/api/orders/${S.order.id}`)).data.estimate;
  assert.equal(plain.lines[0].source, '样品材料+人工');
  assert.equal(plain.lines[0].unit_cost, 43);
  // 设计师看不到效益测算 / designers do not see the estimate
  const forDesigner = await designer1.get(`/api/orders/${S.order.id}`);
  assert.equal(forDesigner.data.estimate, undefined);
});

test('TC-OD-04 翻单（复制为新订单）：明细、条款、唛头带过来，PO号/PI号/加减项不复制；他人订单不能翻', async () => {
  const cp = await sales1.post(`/api/orders/${S.order.id}/copy`, { delivery_date: '2027-03-01' });
  assert.equal(cp.status, 200, JSON.stringify(cp.data));
  assert.notEqual(cp.data.order_no, S.order.order_no);
  assert.equal(cp.data.status, '待确认');
  assert.equal(cp.data.delivery_date, '2027-03-01');
  assert.equal(cp.data.items.length, 2);
  assert.equal(cp.data.items[0].unit_price, 9);
  assert.equal(cp.data.contract_terms, '1. 质量以确认样为准\n2. 交货期以订金到账起算');
  assert.equal(cp.data.side_mark, 'MADE IN CHINA / FRAGILE');
  assert.equal(cp.data.po_no, null);
  assert.equal(cp.data.pi_no, null);
  assert.equal(cp.data.charges.length, 0);
  assert.match(cp.data.remark, new RegExp(S.order.order_no));
  assert.equal((await sales2.post(`/api/orders/${S.order.id}/copy`)).status, 404);
  assert.equal((await designer1.post(`/api/orders/${S.order.id}/copy`)).status, 403);
});
