'use strict';
/**
 * 批次4（样品明细，对标亿星）测试：配件/包材/工序明细、多包装方案（默认方案同步样品）、成本汇总与回写、
 * 订单选用包装方案（出货按方案算箱数）、订单材料需求分解与生成采购单
 * Batch-4 tests: sample parts/packaging/processes, package plans, cost roll-up, order package plans, BOM purchasing.
 * 用例编号与 docs/03-测试用例.md 对应 / Case IDs map to docs/03-测试用例.md
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

let srv;
let admin;
let sales1;
let manager;
let designer1;
let purchaser;
const S = {};
const SID = 2; // YL-V002（设计师张雕塑）/ designed by designer1

test.before(async () => {
  srv = await startServer();
  [admin, sales1, manager, designer1, purchaser] = await Promise.all(['admin', 'sales1', 'manager1', 'designer1', 'purchase1'].map((u) => srv.login(u)));
});
test.after(() => srv.close());

test('TC-BOM-01 多包装方案：默认方案同步到样品包装资料，CBM自动算，只能有一个默认；参数校验', async () => {
  const a = await manager.post('/api/e/sample_package', { sample_id: SID, name: '彩盒装', inner_qty: 1, outer_qty: 6, outer_l: 50, outer_w: 40, outer_h: 60, gw: 15, nw: 12, package_req: '单只彩盒+泡沫', is_default: '是' });
  assert.equal(a.status, 200, JSON.stringify(a.data));
  assert.equal(a.data.cbm, 0.12, '50×40×60 = 0.12 m³');
  let s = (await admin.get(`/api/e/sample/${SID}`)).data;
  assert.deepEqual([s.pcs_per_carton, s.outer_l, s.outer_w, s.outer_h, s.cbm, s.gross_weight, s.net_weight], [6, 50, 40, 60, 0.12, 15, 12]);
  assert.equal(s.package_req, '单只彩盒+泡沫');
  const b = await manager.post('/api/e/sample_package', { sample_id: SID, name: '白盒装', outer_qty: 12, outer_l: 60, outer_w: 45, outer_h: 50, gw: 20, nw: 17 });
  assert.equal(b.status, 200);
  S.planA = a.data.id;
  S.planB = b.data.id;
  s = (await admin.get(`/api/e/sample/${SID}`)).data;
  assert.equal(s.pcs_per_carton, 6, '非默认方案不影响样品');
  assert.equal((await manager.put(`/api/e/sample_package/${b.data.id}`, { is_default: '是' })).status, 200);
  const plans = (await manager.get(`/api/e/sample_package?f_sample_id=${SID}`)).data.rows;
  assert.deepEqual(plans.filter((p) => p.is_default === '是').map((p) => p.name), ['白盒装']);
  assert.equal((await admin.get(`/api/e/sample/${SID}`)).data.pcs_per_carton, 12);
  await manager.put(`/api/e/sample_package/${a.data.id}`, { is_default: '是' });
  assert.equal((await manager.post('/api/e/sample_package', { sample_id: SID, name: 'x', outer_qty: 0 })).status, 400);
  assert.equal((await manager.post('/api/e/sample_package', { sample_id: SID, name: 'x', outer_qty: 6, gw: 5, nw: 6 })).status, 400, '净重不能大于毛重');
  assert.equal((await designer1.post('/api/e/sample_package', { sample_id: SID, name: 'x', outer_qty: 6 })).status, 403, '设计师只读');
});

test('TC-BOM-02 配件/包材/工序明细与成本汇总：每箱用量按装箱数折算，可回写样品成本并记录改样日志', async () => {
  const sup = (await admin.get('/api/options/supplier')).data;
  const box = sup.find((x) => x.label.includes('华美'));
  for (const p of [
    { kind: '配件', code: 'PJ-001', name: '金属底座', qty: 2, per: '每只', unit: '个', unit_price: 1.5 },
    { kind: '包材', code: 'BC-001', name: '五层瓦楞外箱', qty: 1, per: '每箱', unit: '个', unit_price: 6, supplier_id: box.id },
    { kind: '包材', code: 'BC-002', name: '彩盒', qty: 1, per: '每只', unit: '个', unit_price: 0.8, supplier_id: box.id },
  ]) assert.equal((await manager.post('/api/e/sample_part', { sample_id: SID, ...p })).status, 200);
  assert.equal((await manager.post('/api/e/sample_part', { sample_id: SID, kind: '配件', name: 'x', qty: 0 })).status, 400, '用量必须大于0');
  for (const p of [{ seq: 1, name: '注浆成型', price: 3 }, { seq: 2, name: '手工描金', price: 2.5 }]) assert.equal((await manager.post('/api/e/sample_process', { sample_id: SID, ...p })).status, 200);
  const bom = await manager.get(`/api/samples/${SID}/bom`);
  assert.equal(bom.status, 200);
  assert.equal(bom.data.per_carton, 6);
  assert.equal(bom.data.cost.parts, 3, '金属底座 2×1.5');
  assert.equal(bom.data.cost.packaging, 1.8, '外箱 6÷6 + 彩盒 0.8');
  assert.equal(bom.data.cost.process, 5.5);
  assert.equal(bom.data.cost.total, 10.3);
  assert.deepEqual(bom.data.processes.map((p) => p.name), ['注浆成型', '手工描金']);
  assert.equal((await designer1.get(`/api/samples/${SID}/bom`)).status, 200, '设计师可看本人样品明细');
  assert.equal((await sales1.post(`/api/samples/${SID}/apply-bom-cost`)).status, 403);
  const ap = await manager.post(`/api/samples/${SID}/apply-bom-cost`);
  assert.equal(ap.status, 200, JSON.stringify(ap.data));
  const s = (await admin.get(`/api/e/sample/${SID}`)).data;
  assert.equal(s.material_cost, 4.8);
  assert.equal(s.labor_cost, 5.5);
  const rev = (await admin.get(`/api/e/sample_revision?f_sample_id=${SID}`)).data.rows;
  assert.ok(rev.some((r) => /按明细更新成本/.test(r.content)));
  // 删除样品时明细一并删除 / children are removed with the sample
  const des = (await admin.get('/api/options/employee')).data.find((e) => e.label.startsWith('张雕塑'));
  const tmp = await admin.post('/api/e/sample', { company_no: 'BOM-TMP', name: '临时', designer_id: des.id });
  await admin.post('/api/e/sample_part', { sample_id: tmp.data.id, kind: '配件', name: '螺丝', qty: 1 });
  assert.equal((await admin.del(`/api/e/sample/${tmp.data.id}`)).status, 200);
  assert.equal((await admin.get(`/api/e/sample_part?f_sample_id=${tmp.data.id}`)).data.total, 0);
});

test('TC-BOM-03 订单选用包装方案：出货按方案装箱数算箱数与体积；方案必须属于该货号；改方案属于风控关键字段', async () => {
  const bad = await sales1.post('/api/orders', { customer_id: 1, currency: 'USD', delivery_date: '2027-01-30', items: [{ sample_id: 1, qty: 10, unit_price: 9, package_plan_id: S.planB }] });
  assert.equal(bad.status, 400, '方案不属于该货号');
  const o = await sales1.post('/api/orders', { customer_id: 1, currency: 'USD', delivery_date: '2027-01-30', items: [{ sample_id: SID, qty: 600, unit_price: 8, package_plan_id: S.planB }] });
  assert.equal(o.status, 200, JSON.stringify(o.data));
  S.order = o.data;
  assert.equal(o.data.items[0].package_plan_name, '白盒装');
  assert.match(o.data.items[0].package, /白盒装/);
  const blank = await sales1.post('/api/orders', { customer_id: 1, currency: 'USD', delivery_date: '2027-01-30', items: [{ sample_id: SID, qty: 12, unit_price: 8, package: '', package_plan_id: S.planB }] });
  assert.match(blank.data.items[0].package, /白盒装/, '包装栏为空时用方案说明填充');
  const same = await sales1.put(`/api/orders/${blank.data.id}`, { customer_id: 1, currency: 'USD', delivery_date: '2027-01-30', items: blank.data.items });
  assert.equal(same.data.changes.length, 0, '原样保存不产生变更');
  const keep = await sales1.put(`/api/orders/${o.data.id}`, { customer_id: 1, currency: 'USD', delivery_date: '2027-01-30', items: o.data.items.map(({ package_plan_id: _, ...i }) => i) });
  assert.equal(keep.data.items[0].package_plan_id, S.planB, '未提交时保留原方案');
  const sh = await sales1.post(`/api/orders/${o.data.id}/shipments`, { items: [{ order_item_id: o.data.items[0].id, qty: 120 }] });
  assert.equal(sh.status, 200, JSON.stringify(sh.data));
  const ord = (await sales1.get(`/api/orders/${o.data.id}`)).data;
  const it = ord.shipments[0].items[0];
  assert.equal(it.cartons, 10, '120 ÷ 白盒装12只/箱');
  assert.equal(it.cbm, 1.35, '10箱 × 0.135');
  const diff = await sales1.put(`/api/orders/${o.data.id}`, { customer_id: 1, currency: 'USD', delivery_date: '2027-01-30', items: ord.items.map((i) => ({ ...i, package_plan_id: S.planA })) });
  assert.equal(diff.status, 200);
  assert.ok(diff.data.changes[0].diff.some((d) => d.field === '包装方案'), '改方案记录到变更');
  await sales1.put(`/api/orders/${o.data.id}`, { customer_id: 1, currency: 'USD', delivery_date: '2027-01-30', items: diff.data.items.map((i) => ({ ...i, package_plan_id: S.planB })) });
});

test('TC-BOM-04 订单材料需求分解：按用量与箱数计算，扣除已采购；一键生成采购单；权限', async () => {
  const bom = await purchaser.get(`/api/orders/${S.order.id}/bom`);
  assert.equal(bom.status, 200, JSON.stringify(bom.data));
  const by = Object.fromEntries(bom.data.lines.map((l) => [l.code, l]));
  assert.equal(by['PJ-001'].need, 1200, '600只 × 2');
  assert.equal(by['BC-001'].need, 50, '600 ÷ 12只/箱 = 50箱 × 1');
  assert.equal(by['BC-002'].need, 600);
  assert.equal(by['BC-001'].remain, 50);
  const sup = by['BC-001'].supplier_id;
  assert.equal((await sales1.post(`/api/orders/${S.order.id}/bom-purchase`, { supplier_id: sup, keys: [by['BC-001'].key] })).status, 403, '业务员不能生成采购单');
  assert.equal((await purchaser.post(`/api/orders/${S.order.id}/bom-purchase`, { supplier_id: sup, keys: [] })).status, 400);
  const po = await purchaser.post(`/api/orders/${S.order.id}/bom-purchase`, { supplier_id: sup, keys: [by['BC-001'].key, by['BC-002'].key], qty: { [by['BC-002'].key]: 300 }, due_date: '2026-12-20' });
  assert.equal(po.status, 200, JSON.stringify(po.data));
  assert.equal(po.data.order_id, S.order.id);
  assert.deepEqual(po.data.items.map((i) => [i.code, i.qty]).sort(), [['BC-001', 50], ['BC-002', 300]]);
  const after = Object.fromEntries((await purchaser.get(`/api/orders/${S.order.id}/bom`)).data.lines.map((l) => [l.code, l]));
  assert.equal(after['BC-001'].remain, 0);
  assert.equal(after['BC-002'].purchased, 300);
  assert.equal(after['BC-002'].remain, 300, '部分采购后剩余300');
  assert.equal((await purchaser.post(`/api/orders/${S.order.id}/bom-purchase`, { supplier_id: sup, keys: [after['BC-001'].key] })).status, 400, '已采购完的不能再勾选');
});
