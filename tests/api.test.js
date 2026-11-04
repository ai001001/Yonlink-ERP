'use strict';
/**
 * 接口自动化测试：覆盖全业务流程（基础档案→报价询价→送样改样→订单风控→生产采购→财务→统计→设计师）
 * API automated tests covering the full business flow.
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
let designer1;
let designer2;
let purchaser;
let producer;
let finance;
let hr;
const S = {};

test.before(async () => {
  srv = await startServer();
  [admin, sales1, sales2, manager, designer1, designer2, purchaser, producer, finance, hr] = await Promise.all(
    ['admin', 'sales1', 'sales2', 'manager1', 'designer1', 'designer2', 'purchase1', 'prod1', 'finance1', 'hr1'].map((u) => srv.login(u)),
  );
});
test.after(() => srv.close());

// ===================== 系统权限 / system =====================
test('TC-SYS-01 登录：正确密码成功，错误密码失败，未登录访问返回401', async () => {
  const bad = await fetch(srv.base + '/api/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'wrong' }) });
  assert.equal(bad.status, 401);
  const anon = await fetch(srv.base + '/api/meta');
  assert.equal(anon.status, 401);
  const me = await admin.get('/api/meta');
  assert.equal(me.status, 200);
  assert.equal(me.data.user.role_code, 'admin');
});

test('TC-SYS-02 账号禁用后无法登录、重置密码', async () => {
  const users = (await admin.get('/api/users')).data.rows;
  const hrUser = users.find((u) => u.username === 'hr1');
  assert.equal((await admin.put('/api/users/' + hrUser.id, { status: '禁用' })).status, 200);
  await assert.rejects(srv.login('hr1'), /禁用/);
  assert.equal((await admin.put('/api/users/' + hrUser.id, { status: '启用' })).status, 200);
  assert.equal((await admin.post(`/api/users/${hrUser.id}/reset-password`, { password: '654321' })).status, 200);
  hr = await srv.login('hr1', '654321');
  assert.ok(hr.token);
});

test('TC-SYS-03 岗位权限：人事无权访问报价，业务员无删除客户权限', async () => {
  assert.equal((await hr.get('/api/quotes')).status, 403);
  assert.equal((await hr.get('/api/e/employee')).status, 200);
  assert.equal((await sales1.del('/api/e/customer/1')).status, 403);
});

test('TC-SYS-04 模块一键启停：停用邮件模块后接口403，启用后恢复', async () => {
  assert.equal((await admin.put('/api/modules/mail', { enabled: false })).status, 200);
  const r = await sales1.get('/api/e/mail');
  assert.equal(r.status, 403);
  assert.match(r.data.error, /模块已停用/);
  assert.equal((await admin.put('/api/modules/system', { enabled: false })).status, 400);
  assert.equal((await admin.put('/api/modules/mail', { enabled: true })).status, 200);
  assert.equal((await sales1.get('/api/e/mail')).status, 200);
});

test('TC-SYS-05 角色权限矩阵新增与批量授权', async () => {
  const r = await admin.post('/api/roles', { code: 'qc', name: '验货员', data_scope: 'all', perms: { order: ['view'] } });
  assert.equal(r.status, 200);
  const bad = await admin.post('/api/roles', { code: 'x', name: 'x', perms: { order: ['fly'] } });
  assert.equal(bad.status, 400);
  const u = await admin.post('/api/users', { username: 'qc1', name: '验货员1', role_id: r.data.id });
  assert.equal(u.status, 200);
  const b = await admin.post('/api/users/batch-role', { ids: [u.data.id], role_id: r.data.id });
  assert.equal(b.data.count, 1);
  const qc = await srv.login('qc1');
  assert.equal((await qc.get('/api/orders')).status, 200);
  assert.equal((await qc.get('/api/quotes')).status, 403);
});

test('TC-SYS-06 登录与操作日志自动记录', async () => {
  const logs = (await admin.get('/api/e/log?size=200')).data.rows;
  assert.ok(logs.some((l) => l.type === 'login' && l.action === '登录失败(密码错误)'));
  assert.ok(logs.some((l) => l.action === '停用模块'));
});

// ===================== 基础档案 / master data =====================
test('TC-MD-01 客户档案：新增、编码重复校验、业务员数据隔离', async () => {
  const c = await sales2.post('/api/e/customer', { code: 'C900', name: 'Nordic Home AB', country: 'Sweden', email: 'buyer@nordichome.se' });
  assert.equal(c.status, 200);
  assert.equal(c.data.salesman_id, 3, '业务员新增客户自动归属本人');
  S.nordic = c.data.id;
  assert.equal((await sales2.post('/api/e/customer', { code: 'C900', name: 'dup', country: 'X' })).status, 409);
  assert.equal((await sales1.get('/api/e/customer/' + S.nordic)).status, 404, '林晓明看不到王芳客户');
  const list1 = (await sales1.get('/api/e/customer')).data.rows;
  assert.ok(list1.every((x) => x.salesman_id === 2));
  assert.equal((await admin.get('/api/e/customer')).data.total, 4);
});

test('TC-MD-02 必填校验与被引用删除保护', async () => {
  const r = await admin.post('/api/e/supplier', { code: 'S999', name: '' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /名称|类型/);
});

test('TC-MD-03 邮件按客户邮箱自动绑定客户', async () => {
  const r = await sales2.post('/api/e/mail', { direction: '收件', mail_from: 'buyer@nordichome.se', mail_to: 'sales@yonlink.com', subject: 'RFQ ceramic vases', category: '询盘' });
  assert.equal(r.status, 200);
  assert.equal(r.data.customer_id, S.nordic);
});

test('TC-MD-04 汇率修改自动记录波动历史', async () => {
  assert.equal((await finance.put('/api/e/currency/EUR', { code: 'EUR', name: '欧元', rate: 7.8 })).status, 200);
  const h = (await finance.get('/api/e/rate_history')).data.rows;
  assert.equal(h[0].code, 'EUR');
  assert.equal(h[0].old_rate, 7.75);
  assert.equal(h[0].new_rate, 7.8);
});

test('TC-MD-05 样品工艺修改自动写入改样日志；三货号存档', async () => {
  const r = await admin.put('/api/e/sample/2', { craft: '冰裂釉+描金' });
  assert.equal(r.status, 200);
  const logs = (await admin.get('/api/e/sample_revision?f_sample_id=2')).data.rows;
  assert.ok(logs.some((l) => l.content.includes('冰裂釉 → 冰裂釉+描金')));
  const s1 = (await admin.get('/api/e/sample/1')).data;
  assert.equal(s1.company_no, 'YL-V001');
  assert.equal(s1.customer_no, 'HD-2026-01');
  assert.equal(s1.factory_no, 'HS-881');
});

// ===================== 报价与工厂询价 / quotation & inquiry =====================
test('TC-QT-01 报价单自动调取样品成本并按公式计算单价', async () => {
  const r = await sales1.post('/api/quotes', {
    customer_id: 1, currency: 'USD', term: 'FOB', profit_rate: 20, freight: 3000, customs_fee: 200,
    items: [
      { sample_id: 1, qty: 500, new_item_no: 'YL-V001A', revise_req: '浮雕牡丹改为玫瑰，高度32→35cm，颜色改哑光白' },
      { sample_id: 3, qty: 1000 },
    ],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  S.quote = r.data;
  assert.match(r.data.quote_no, /^QT\d{8}-\d{3}$/);
  const [a, b] = r.data.items;
  assert.equal(a.cost_cny, 43);
  assert.equal(a.price, 7.61);
  assert.equal(b.price, 4.57);
  assert.equal(a.factory_id, 1);
  assert.equal(b.factory_id, 2);
  assert.equal(r.data.status, '草稿');
});

test('TC-QT-02 报价阶段改新货号：旧-新货号写入改样日志，冲突货号拦截', async () => {
  const logs = (await admin.get('/api/e/sample_revision?f_sample_id=1')).data.rows;
  assert.ok(logs.some((l) => l.stage === '报价改样' && l.content.includes('YL-V001A')));
  const dup = await sales1.post('/api/quotes', { customer_id: 1, currency: 'USD', term: 'FOB', items: [{ sample_id: 1, qty: 1, new_item_no: 'YL-V002' }] });
  assert.equal(dup.status, 409);
  const same = await sales1.post('/api/quotes', { customer_id: 1, currency: 'USD', term: 'FOB', items: [{ sample_id: 1, qty: 1, new_item_no: 'YL-V001' }] });
  assert.equal(same.status, 400);
});

test('TC-QT-03 一键按厂家拆分询价单，单号=报价单号-厂家名称', async () => {
  const r = await sales1.post(`/api/quotes/${S.quote.id}/split`);
  assert.equal(r.status, 200);
  assert.equal(r.data.rows.length, 2);
  const nos = r.data.rows.map((x) => x.inquiry_no).sort();
  assert.deepEqual(nos, [`${S.quote.quote_no}-德化鸿盛陶瓷厂`, `${S.quote.quote_no}-潮州雅艺陶瓷厂`].sort());
  S.inqA = r.data.rows.find((x) => x.inquiry_no.endsWith('德化鸿盛陶瓷厂')).id;
  const d = (await sales1.get('/api/inquiries/' + S.inqA)).data;
  assert.equal(d.items.length, 1);
  assert.equal(d.items[0].item_no, 'YL-V001');
  assert.equal(d.items[0].cbm, 0.1456, '外箱52×40×70自动计算CBM');
  assert.equal(d.items[0].new_item_no, 'YL-V001A');
  // 重复拆分不产生重复询价单 / re-split is idempotent
  const again = await sales1.post(`/api/quotes/${S.quote.id}/split`);
  assert.equal(again.data.rows.length, 2);
  assert.equal((await admin.get(`/api/inquiries?quote_no=${S.quote.quote_no}`)).data.rows.length, 2);
});

test('TC-QT-04 询价单导出Excel：厘米版与英寸版', async () => {
  const cm = await sales1.get(`/api/inquiries/${S.inqA}/export?unit=cm`);
  assert.equal(cm.status, 200);
  assert.equal(cm.data.slice(0, 2).toString(), 'PK');
  assert.match(decodeURIComponent(cm.headers.get('content-disposition')), /厘米版\.xlsx/);
  const inch = await sales1.get(`/api/inquiries/${S.inqA}/export?unit=inch`);
  assert.match(decodeURIComponent(inch.headers.get('content-disposition')), /英寸版\.xlsx/);
  // 解析 xlsx 内容验证尺寸换算 18cm → 7.1inch / verify cm→inch conversion
  const zlib = require('node:zlib');
  const buf = inch.data;
  let off = 0;
  let sheet = '';
  while (buf.readUInt32LE(off) === 0x04034b50) {
    const csize = buf.readUInt32LE(off + 18);
    const nlen = buf.readUInt16LE(off + 26);
    const name = buf.slice(off + 30, off + 30 + nlen).toString();
    const data = buf.slice(off + 30 + nlen, off + 30 + nlen + csize);
    if (name === 'xl/worksheets/sheet1.xml') sheet = zlib.inflateRawSync(data).toString();
    off += 30 + nlen + csize;
  }
  assert.ok(sheet.includes('7.1×7.1×12.6'), '产品尺寸已换算为英寸');
  assert.ok(sheet.includes('本次新创货号'));
  assert.ok(sheet.includes('YL-V001A'));
});

test('TC-QT-05 工厂回价回填留档 → 供应商价格台账', async () => {
  const inq = (await purchaser.get('/api/inquiries/' + S.inqA)).data;
  assert.equal((await purchaser.post(`/api/inquiries/${S.inqA}/sent`)).status, 200);
  const r = await purchaser.put(`/api/inquiries/${S.inqA}/reply`, { reply_date: '2026-11-05', valid_until: '2026-12-31', items: [{ id: inq.items[0].id, factory_price: 40, delivery_days: 35 }] });
  assert.equal(r.status, 200);
  assert.equal(r.data.status, '已回价');
  const bad = await purchaser.put(`/api/inquiries/${S.inqA}/reply`, { items: [{ id: inq.items[0].id, factory_price: -1 }] });
  assert.equal(bad.status, 400);
  const prices = (await purchaser.get('/api/e/supplier_price')).data.rows;
  assert.ok(prices.some((p) => p.item_no === 'YL-V001' && p.price === 40 && p.ref_no.endsWith('德化鸿盛陶瓷厂')));
});

test('TC-QT-06 同货号追加其它厂家询价 → 多厂家对比 → 采用最低价重算报价', async () => {
  const itemA = S.quote.items.find((i) => i.item_no === 'YL-V001');
  const r = await sales1.post('/api/inquiries', { quote_id: S.quote.id, supplier_id: 5, quote_item_ids: [itemA.id] });
  assert.equal(r.status, 200);
  assert.equal(r.data.inquiry_no, `${S.quote.quote_no}-佛山外购精品`);
  await purchaser.put(`/api/inquiries/${r.data.id}/reply`, { items: [{ id: r.data.items[0].id, factory_price: 38.5, delivery_days: 45 }] });
  const cmp = (await sales1.get(`/api/quotes/${S.quote.id}/compare`)).data;
  const row = cmp.rows.find((x) => x.item_no === 'YL-V001');
  assert.equal(row.offers.length, 2);
  assert.equal(row.offers[0].supplier_name, '佛山外购精品', '最低价排第一');
  assert.equal(row.offers[1].diff_vs_best, 1.5);
  const ap = await sales1.post(`/api/quotes/${S.quote.id}/apply-offer`, { quote_item_id: itemA.id, inquiry_item_id: row.offers[0].inquiry_item_id });
  assert.equal(ap.status, 200);
  const it = ap.data.items.find((x) => x.id === itemA.id);
  assert.equal(it.cost_cny, 38.5);
  assert.equal(it.factory_id, 5);
  assert.equal(it.price, 6.85, '(38.5+2.1333)×1.2÷7.12');
  S.quote = ap.data;
});

test('TC-QT-07 报价审批：低利润预警；业务员不能审批；经理审批后可转订单', async () => {
  assert.equal((await sales1.post(`/api/quotes/${S.quote.id}/to-order`)).status, 409, '未审批不能转订单');
  await sales1.put(`/api/quotes/${S.quote.id}`, { ...S.quote, profit_rate: 10, items: S.quote.items });
  const sub = await sales1.post(`/api/quotes/${S.quote.id}/submit`);
  assert.equal(sub.status, 200);
  assert.equal(sub.data.low_profit, true);
  const ap = (await manager.get('/api/approvals')).data.rows.find((a) => a.target_no === S.quote.quote_no && a.status === '待审批');
  assert.ok(ap.title.includes('低于最低利润率'));
  assert.equal((await sales1.post(`/api/approvals/${ap.id}/decide`, { pass: true })).status, 403);
  assert.equal((await manager.post(`/api/approvals/${ap.id}/decide`, { pass: true, note: '同意，量大' })).status, 200);
  assert.equal((await manager.post(`/api/approvals/${ap.id}/decide`, { pass: true })).status, 409, '重复审批被拦截');
  S.quote = (await sales1.get('/api/quotes/' + S.quote.id)).data;
  assert.equal(S.quote.status, '已审批');
});

test('TC-QT-08 报价单数据隔离：王芳看不到林晓明报价', async () => {
  assert.equal((await sales2.get('/api/quotes/' + S.quote.id)).status, 404);
  assert.equal((await sales2.get('/api/quotes')).data.rows.length, 0);
});

// ===================== 送样与改样新货号 / sample sending =====================
test('TC-SS-01 送样单：改新货号、寄出（扣样品库存）、客户确认', async () => {
  const r = await sales1.post('/api/sample-sends', { customer_id: 2, cost: 350, items: [{ sample_id: 3, qty: 2, new_item_no: 'YL-T001B', revise_req: '描金改为描银，杯柄加粗2mm' }, { sample_id: 4, qty: 1 }] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  S.send = r.data;
  assert.match(S.send.send_no, /^SS\d{8}-\d{3}$/);
  assert.equal(S.send.items[0].verify_status, '待核验');
  assert.equal((await sales1.post(`/api/sample-sends/${S.send.id}/status`, { status: '已寄出', express_co: 'DHL' })).status, 400, '必须填快递单号');
  assert.equal((await sales1.post(`/api/sample-sends/${S.send.id}/status`, { status: '客户确认' })).status, 409, '未寄出不能确认');
  const sent = await sales1.post(`/api/sample-sends/${S.send.id}/status`, { status: '已寄出', express_co: 'DHL', tracking_no: '1234567890' });
  assert.equal(sent.data.status, '已寄出');
  assert.equal((await admin.get('/api/e/sample/3')).data.stock_qty, 1, '样品库存3-2=1');
  assert.equal((await sales1.post(`/api/sample-sends/${S.send.id}/status`, { status: '客户确认', customer_feedback: 'OK' })).data.status, '客户确认');
});

test('TC-SS-02 改样核验：不通过必须填整改意见并计重做次数；通过前不能转正', async () => {
  const it = S.send.items[0];
  assert.equal((await manager.post(`/api/send-items/${it.id}/convert`)).status, 409, '未核验通过不能转正');
  assert.equal((await sales1.post(`/api/send-items/${it.id}/verify`, { pass: false })).status, 400);
  const ng = await sales1.post(`/api/send-items/${it.id}/verify`, { pass: false, note: '描银色差偏黄，重做' });
  assert.equal(ng.data.items[0].redo_count, 1);
  assert.equal(ng.data.items[0].verify_status, '不通过-重做中');
  assert.equal((await admin.get('/api/e/sample/3')).data.progress, '重做中');
  const ok = await sales1.post(`/api/send-items/${it.id}/verify`, { pass: true, note: '符合客户要求' });
  assert.equal(ok.data.items[0].verify_status, '通过');
});

test('TC-SS-03 新货号一键转正：继承设计师/改样记录，旧货号锁定；旧货号禁止报价/下单', async () => {
  const it = S.send.items[0];
  assert.equal((await sales1.post(`/api/send-items/${it.id}/convert`)).status, 403, '业务员无样品新增权限');
  const r = await manager.post(`/api/send-items/${it.id}/convert`, { color: '描银' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.company_no, 'YL-T001B');
  S.newSample = r.data.id;
  const ns = (await admin.get('/api/e/sample/' + r.data.id)).data;
  assert.equal(ns.parent_no, 'YL-T001');
  assert.equal(ns.designer_id, 5, '继承原设计师李彩绘');
  assert.equal(ns.color, '描银');
  const old = (await admin.get('/api/e/sample/3')).data;
  assert.equal(old.status, '已锁定');
  const ov = (await admin.get('/api/samples/' + r.data.id + '/overview')).data;
  assert.ok(ov.revisions.some((x) => x.content.startsWith('[继承自YL-T001]')));
  const q = await sales1.post('/api/quotes', { customer_id: 1, currency: 'USD', term: 'FOB', items: [{ sample_id: 3, qty: 10 }] });
  assert.equal(q.status, 409);
  assert.match(q.data.error, /YL-T001B/);
  const o = await sales1.post('/api/orders', { customer_id: 1, currency: 'USD', delivery_date: '2027-01-30', items: [{ sample_id: 3, qty: 10, unit_price: 5 }] });
  assert.equal(o.status, 409);
  assert.equal((await manager.post(`/api/send-items/${it.id}/convert`)).status, 409, '不能重复转正');
  const opts = (await sales1.get('/api/options/sample?usable=1')).data;
  assert.ok(!opts.some((x) => x.id === 3), '下拉框不再出现锁定旧货号');
});

// ===================== 订单与变更风控 / orders & risk control =====================
test('TC-OR-01 含已锁定旧货号的报价禁止转订单；改用新货号重新审批后转订单', async () => {
  const blocked = await sales1.post(`/api/quotes/${S.quote.id}/to-order`);
  assert.equal(blocked.status, 409);
  assert.match(blocked.data.error, /YL-T001B/);
  const items = S.quote.items.map((i) => (i.item_no === 'YL-T001' ? { ...i, sample_id: S.newSample } : { ...i }));
  const ed = await sales1.put('/api/quotes/' + S.quote.id, { ...S.quote, profit_rate: 20, items, auto_price: false });
  assert.equal(ed.status, 200, JSON.stringify(ed.data));
  assert.equal(ed.data.status, '草稿', '已审批报价修改后退回草稿需重新审批');
  assert.ok(ed.data.items.some((i) => i.item_no === 'YL-T001B'));
  await sales1.post(`/api/quotes/${S.quote.id}/submit`);
  const ap = (await manager.get('/api/approvals')).data.rows.find((a) => a.target_no === S.quote.quote_no && a.status === '待审批');
  await manager.post(`/api/approvals/${ap.id}/decide`, { pass: true });
  const r = await sales1.post(`/api/quotes/${S.quote.id}/to-order`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  S.order = (await sales1.get('/api/orders/' + r.data.id)).data;
  assert.equal(S.order.items.length, 2);
  assert.equal(S.order.status, '待确认');
  assert.equal((await sales1.get('/api/quotes/' + S.quote.id)).data.status, '已成交');
  assert.equal((await sales1.put('/api/quotes/' + S.quote.id, { ...S.quote })).status, 409, '已成交报价不允许修改');
});

test('TC-OR-02 无采购/布产时修改订单：直接保存，仅记录变更', async () => {
  const o = S.order;
  const items = o.items.map((i) => ({ ...i }));
  items[0].qty = 520;
  const r = await sales1.put('/api/orders/' + o.id, { ...o, items });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.risk_lock, 0);
  assert.equal(r.data.changes[0].risk_level, '无');
  assert.equal(r.data.changes[0].diff[0].field, '数量');
  S.order = r.data;
});

test('TC-PU-01 关联订单采购原辅材料、入库（库存加权平均）、付款审批', async () => {
  const r = await purchaser.post('/api/purchases', { supplier_id: 4, type: '原辅材料', order_id: S.order.id, items: [{ inventory_id: 3, qty: 600, price: 2.5 }] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  S.po = r.data;
  assert.equal(S.po.amount, 1500);
  const rc = await purchaser.post(`/api/purchases/${S.po.id}/receive`, { items: [{ id: S.po.items[0].id, qty: 600 }] });
  assert.equal(rc.data.status, '已入库');
  const inv = (await purchaser.get('/api/e/inventory/3')).data;
  assert.equal(inv.qty, 680);
  assert.equal(inv.unit_cost, Math.round(((80 * 2.2 + 600 * 2.5) / 680) * 10000) / 10000);
  assert.equal((await purchaser.post(`/api/purchases/${S.po.id}/receive`, { items: [{ id: S.po.items[0].id, qty: 1 }] })).status, 409, '超量入库拦截');
  const pay = await purchaser.post(`/api/purchases/${S.po.id}/payments`, { amount: 1000 });
  assert.equal(pay.status, 200);
  assert.equal((await purchaser.post(`/api/purchases/${S.po.id}/payments`, { amount: 600 })).status, 409, '付款申请超出采购金额');
  const ap = (await finance.get('/api/approvals')).data.rows.find((a) => a.target_type === 'payment' && a.status === '待审批');
  assert.equal((await purchaser.post(`/api/approvals/${ap.id}/decide`, { pass: true })).status, 403, '采购不能审批付款');
  assert.equal((await finance.post(`/api/approvals/${ap.id}/decide`, { pass: true })).status, 200);
  assert.equal((await purchaser.get('/api/purchases/' + S.po.id)).data.paid, 1000);
});

test('TC-OR-03 已采购入库付款后变更订单数量：弹窗风险提醒(高)，须填原因确认', async () => {
  const o = (await sales1.get('/api/orders/' + S.order.id)).data;
  const items = o.items.map((i) => ({ ...i }));
  items[0].qty = 300;
  const r = await sales1.put('/api/orders/' + o.id, { ...o, items });
  assert.equal(r.status, 409);
  assert.equal(r.data.risk, true);
  assert.equal(r.data.level, '高');
  assert.ok(r.data.reasons.some((x) => x.includes('已入库600')));
  assert.ok(r.data.reasons.some((x) => x.includes('已付款¥1000')));
  assert.equal(r.data.purchases[0].po_no, S.po.po_no);
  const noReason = await sales1.put('/api/orders/' + o.id, { ...o, items, confirm_risk: true });
  assert.equal(noReason.status, 400);
  const ok = await sales1.put('/api/orders/' + o.id, { ...o, items, confirm_risk: true, change_reason: '客户邮件要求减量至300' });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.risk_lock, 1);
  const ch = ok.data.changes[0];
  assert.equal(ch.status, '待联动修正');
  assert.deepEqual(ch.tasks.map((t) => t.dept).sort(), ['业务', '财务', '采购'].sort());
  S.order = ok.data;
});

test('TC-OR-04 风控锁定期间：禁止再改订单/新增采购/布产/出货', async () => {
  const o = S.order;
  assert.equal((await sales1.put('/api/orders/' + o.id, { ...o, items: o.items })).status, 423);
  assert.equal((await purchaser.post('/api/purchases', { supplier_id: 3, type: '原辅材料', order_id: o.id, items: [{ inventory_id: 1, qty: 1, price: 1 }] })).status, 423);
  assert.equal((await producer.post(`/api/orders/${o.id}/produce`, {})).status, 423);
  assert.equal((await sales1.post(`/api/orders/${o.id}/shipments`, { items: [{ order_item_id: o.items[0].id, qty: 1 }] })).status, 423);
  const dash = (await purchaser.get('/api/dashboard')).data;
  assert.ok(dash.alerts.some((a) => a.type === '订单变更联动' && a.text.startsWith('【采购】')));
});

test('TC-OR-05 联动任务须由对应部门处理，全部处理后自动解锁', async () => {
  const tasks = S.order.changes[0].tasks;
  const buy = tasks.find((t) => t.dept === '采购');
  const fin = tasks.find((t) => t.dept === '财务');
  const biz = tasks.find((t) => t.dept === '业务');
  assert.equal((await sales1.post(`/api/change-tasks/${buy.id}/handle`, { note: 'x' })).status, 403, '业务员不能处理采购任务');
  assert.equal((await purchaser.post(`/api/change-tasks/${buy.id}/handle`, {})).status, 400, '须填写处理说明');
  assert.equal((await purchaser.post(`/api/change-tasks/${buy.id}/handle`, { note: '冗余彩盒220个转库存备用' })).status, 200);
  assert.equal((await finance.post(`/api/change-tasks/${fin.id}/handle`, { note: '已更新应收金额与成本' })).status, 200);
  let o = (await sales1.get('/api/orders/' + S.order.id)).data;
  assert.equal(o.risk_lock, 1, '仍有业务任务未处理');
  const last = await sales1.post(`/api/change-tasks/${biz.id}/handle`, { note: '客户已书面确认' });
  assert.equal(last.data.change_completed, true);
  o = (await sales1.get('/api/orders/' + S.order.id)).data;
  assert.equal(o.risk_lock, 0);
  assert.equal(o.changes[0].status, '已完成');
  S.order = o;
});

// ===================== 生产 / production =====================
test('TC-PR-01 一键布产 → 工序报工校验 → 完工自动同步订单状态', async () => {
  const r = await producer.post(`/api/orders/${S.order.id}/produce`, { due_date: '2026-10-01' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.created.length, 2);
  assert.equal((await producer.post(`/api/orders/${S.order.id}/produce`, {})).status, 409, '不能重复布产');
  const list = (await producer.get('/api/productions?order_id=' + S.order.id)).data.rows;
  const p1 = list.find((p) => p.item_no === 'YL-V001');
  assert.equal(p1.plan_qty, 300);
  assert.equal(p1.delayed, true, '计划完工日早于今天 → 延期');
  assert.equal((await producer.post(`/api/productions/${p1.id}/reports`, { process: '上釉', good_qty: 10 })).status, 409, '上釉不能超过制坯良品');
  assert.equal((await producer.post(`/api/productions/${p1.id}/reports`, { process: '制坯', good_qty: 400 })).status, 409, '制坯不能超过计划');
  for (const proc of ['制坯', '上釉', '烧制', '彩绘', '包装']) {
    const rr = await producer.post(`/api/productions/${p1.id}/reports`, { process: proc, good_qty: 300, bad_qty: proc === '烧制' ? 12 : 0 });
    assert.equal(rr.status, 200, JSON.stringify(rr.data));
  }
  const done = (await producer.get('/api/productions/' + p1.id)).data;
  assert.equal(done.status, '已完工');
  assert.equal(done.completion, 100);
  const p2 = list.find((p) => p.item_no !== 'YL-V001');
  for (const proc of ['制坯', '上釉', '烧制', '彩绘', '包装']) await producer.post(`/api/productions/${p2.id}/reports`, { process: proc, good_qty: p2.plan_qty });
  assert.equal((await sales1.get('/api/orders/' + S.order.id)).data.status, '待出货');
  S.prod = p1.id;
});

test('TC-PR-02 生产订单变更风险等级：已报工 → 高，任务含生产部门', async () => {
  const r = await sales1.get(`/api/orders/${S.order.id}/risk`);
  assert.equal(r.data.level, '高');
  assert.ok(r.data.reasons.some((x) => x.includes('已完工良品')));
  for (const p of r.data.productions) assert.ok(p.reported <= p.plan_qty, `完工数(${p.reported})不应超过计划数(${p.plan_qty})——模拟发现的缺陷S3`);
});

test('TC-INV-01 按单领料：库存不足拦截，成本归集到订单', async () => {
  assert.equal((await producer.post('/api/material-issues', { inventory_id: 1, order_id: S.order.id, qty: 99999 })).status, 409);
  assert.equal((await producer.post('/api/material-issues', { inventory_id: 1, order_id: S.order.id, production_id: S.prod, qty: 20 })).status, 200);
  const o = (await admin.get('/api/orders/' + S.order.id)).data;
  assert.equal(o.cost.material_cost, 360, '20kg × ¥18');
  assert.equal(o.cost.purchase_cost, 1500);
  const inv = (await admin.get('/api/e/inventory?q=P-CTN-01')).data.rows[0];
  assert.equal(inv.alert, '积压预警');
});

// ===================== 出货与验货 / shipments =====================
test('TC-SH-01 出货：超量拦截；验货合格前不能出运；出运后订单状态联动', async () => {
  const o = S.order;
  const [i1, i2] = o.items;
  assert.equal((await sales1.post(`/api/orders/${o.id}/shipments`, { items: [{ order_item_id: i1.id, qty: 301 }] })).status, 409);
  const sh = await sales1.post(`/api/orders/${o.id}/shipments`, { ship_date: '2026-09-01', dest_port: 'Hamburg', forwarder_id: 3, items: [{ order_item_id: i1.id, qty: 300 }, { order_item_id: i2.id, qty: i2.qty }] });
  assert.equal(sh.status, 200, JSON.stringify(sh.data));
  S.ship = sh.data.id;
  assert.equal((await sales1.put('/api/shipments/' + S.ship, { status: '已出运', customs_no: 'CN123' })).status, 409, '未验货不能出运');
  assert.equal((await sales1.put('/api/shipments/' + S.ship, { inspection_status: '不合格' })).status, 400, '不合格须写整改');
  assert.equal((await sales1.put('/api/shipments/' + S.ship, { inspection_status: '不合格', inspection_note: '外箱唛头错误，已整改' })).status, 200);
  assert.equal((await sales1.put('/api/shipments/' + S.ship, { inspection_status: '合格', inspection_note: 'SGS复验合格' })).status, 200);
  assert.equal((await sales1.put('/api/shipments/' + S.ship, { status: '已出运' })).status, 400, '需报关单号');
  assert.equal((await sales1.put('/api/shipments/' + S.ship, { status: '已出运', customs_no: '530120260901001' })).status, 200);
  const after = (await sales1.get('/api/orders/' + o.id)).data;
  assert.equal(after.status, '已出货');
  const ships = (await sales1.get('/api/shipments')).data.rows;
  assert.ok(ships[0].cbm > 0, '自动按外箱计算CBM');
  assert.equal((await sales1.put('/api/shipments/' + S.ship, { remark: 'x' })).status, 409, '已出运不可修改');
  S.order = after;
});

// ===================== 财务 / finance =====================
test('TC-FI-01 收款：超额拦截、汇兑损益自动核算；订单未收齐不能完结', async () => {
  const o = S.order;
  assert.equal((await sales1.post(`/api/orders/${o.id}/status`, { status: '已完成' })).status, 409);
  assert.equal((await finance.post('/api/receipts', { order_id: o.id, type: '预收', amount: o.amount + 1 })).status, 409);
  const r1 = await finance.post('/api/receipts', { order_id: o.id, type: '预收', amount: 1000, rate: 7.2 });
  assert.equal(r1.status, 200);
  const d = (await finance.get('/api/receivables/' + o.id)).data;
  assert.equal(d.receipts[0].amount_cny, 7200);
  assert.equal(d.receipts[0].fx_gain, 80, '1000×(7.20-7.12)');
  assert.equal(d.receive_status, '部分收款');
  assert.equal((await finance.post('/api/receipts', { order_id: o.id, type: '尾款', amount: d.unreceived, rate: 7.1 })).status, 200);
  assert.equal((await finance.get('/api/receivables/' + o.id)).data.receive_status, '已收齐');
  assert.equal((await sales1.post(`/api/orders/${o.id}/status`, { status: '已完成' })).status, 200);
});

test('TC-FI-02 销项开票：开票逾期预警、重复发票号拦截、超开拦截', async () => {
  const o = S.order;
  const rows = (await finance.get('/api/receivables')).data.rows;
  const row = rows.find((x) => x.id === o.id);
  assert.equal(row.invoice_overdue, true, '2026-09-01出运，30天未开票');
  const dash = (await finance.get('/api/dashboard')).data;
  assert.ok(dash.alerts.some((a) => a.type === '开票逾期'));
  assert.equal((await finance.post('/api/sales-invoices', { order_id: o.id, invoice_no: 'INV001', amount: 1000 })).status, 200);
  assert.equal((await finance.post('/api/sales-invoices', { order_id: o.id, invoice_no: 'INV001', amount: 1 })).status, 409);
  assert.equal((await finance.post('/api/sales-invoices', { order_id: o.id, invoice_no: 'INV002', amount: o.amount })).status, 409);
  assert.equal((await finance.post('/api/sales-invoices', { order_id: o.id, invoice_no: 'INV002', amount: row.uninvoiced - 1000 })).status, 200);
  assert.equal((await finance.get('/api/receivables')).data.rows.find((x) => x.id === o.id).invoice_overdue, false);
});

test('TC-FI-03 外购成品：质检合格前禁止入库；进项发票登记与核销；供应商合格率更新；应付台账', async () => {
  const r = await purchaser.post('/api/purchases', { supplier_id: 5, type: '外购成品', items: [{ code: 'WG-001', name: '金属底座', unit: '个', qty: 100, price: 12 }] });
  assert.equal(r.status, 200);
  const id = r.data.id;
  assert.equal((await purchaser.post(`/api/purchases/${id}/receive`, { items: [{ id: r.data.items[0].id, qty: 100 }] })).status, 409);
  assert.equal((await purchaser.post(`/api/purchases/${id}/qc`, { qc_status: '不合格' })).status, 400);
  await purchaser.post(`/api/purchases/${id}/qc`, { qc_status: '不合格', note: '电镀起泡' });
  assert.equal((await admin.get('/api/e/supplier/5')).data.pass_rate, 0);
  await purchaser.post(`/api/purchases/${id}/qc`, { qc_status: '合格', note: '返工后合格' });
  assert.equal((await purchaser.post(`/api/purchases/${id}/receive`, { items: [{ id: r.data.items[0].id, qty: 100 }] })).status, 200);
  assert.ok((await purchaser.get('/api/e/inventory?q=WG-001')).data.rows.length === 1, '外购成品自动建库存档案');
  const inv = await purchaser.post('/api/purchase-invoices', { po_id: id, invoice_no: 'JX-001', amount: 1200 });
  assert.equal(inv.status, 200);
  assert.equal((await purchaser.post('/api/purchase-invoices', { po_id: id, invoice_no: 'JX-002', amount: 1 })).status, 409, '进项超开');
  assert.equal((await purchaser.post(`/api/purchase-invoices/${inv.data.id}/verify`)).status, 403);
  assert.equal((await finance.post(`/api/purchase-invoices/${inv.data.id}/verify`)).status, 200);
  const pay = (await finance.get('/api/payables')).data.rows.find((x) => x.code === 'S005');
  assert.equal(pay.amount, 1200);
  assert.equal(pay.verified, 1200);
  assert.equal(pay.unpaid, 1200);
});

// ===================== 设计师 / designer =====================
test('TC-DS-01 设计师数据隔离：只看本人样品，不能新增修改', async () => {
  const mine = (await designer1.get('/api/e/sample')).data.rows;
  assert.ok(mine.length >= 2 && mine.every((s) => s.designer_id === 4));
  assert.equal((await designer1.get('/api/e/sample/3')).status, 404, '看不到李彩绘的样品');
  assert.equal((await designer1.post('/api/e/sample', { company_no: 'X', name: 'x', designer_id: 4 })).status, 403);
  assert.equal((await designer1.put('/api/e/sample/1', { name: 'x' })).status, 403);
  assert.equal((await designer1.get('/api/e/customer')).status, 403);
  assert.equal((await designer1.get('/api/inquiries')).status, 403);
  assert.equal((await designer1.get('/api/receivables')).status, 403);
});

test('TC-DS-02 设计师报价/订单只显示本人样品行；金额与提成基数准确', async () => {
  const q = (await designer1.get('/api/quotes/' + S.quote.id)).data;
  assert.ok(q.items.every((i) => i.designer_id === 4));
  assert.equal(q.items.length, 1);
  const o = (await designer2.get('/api/orders/' + S.order.id)).data;
  assert.ok(o.items.length === 1 && o.items.every((i) => i.item_no === 'YL-T001B'));
  assert.equal(o.changes, undefined, '设计师看不到变更/采购等敏感信息');
  const s1 = (await designer1.get('/api/designer/summary?designer_id=5')).data;
  assert.equal(s1.designer.name, '张雕塑', 'designer_id 参数被忽略，只能看本人');
  assert.equal(s1.summary.order_qty, 300);
  assert.equal(s1.summary.shipped_qty, 300);
  const price = S.order.items.find((i) => i.item_no === 'YL-V001').unit_price;
  assert.equal(s1.summary.shipped_amount_cny, Math.round(300 * price * 7.12 * 100) / 100);
  for (const k of ['samples', 'quotes', 'sends', 'orders', 'shipments']) {
    const d = (await designer1.get('/api/designer/detail/' + k)).data;
    assert.ok(Array.isArray(d.rows), k);
  }
  const ords = (await designer1.get('/api/designer/detail/orders')).data.rows;
  assert.equal(ords[0][9], '已出货');
  const sends = (await designer2.get('/api/designer/detail/sends')).data.rows;
  assert.ok(sends.some((r) => r[5] === 'YL-T001B'));
  const adminView = (await admin.get('/api/designer/summary?designer_id=5')).data;
  assert.equal(adminView.designer.name, '李彩绘');
  assert.equal((await designer1.post('/api/export', { module: 'designer', title: '对账', headers: ['a'], rows: [[1]] })).status, 200);
});

// ===================== 统计报表 / reports =====================
test('TC-RP-01 全部统计口径可查询，数据与业务一致', async () => {
  const kinds = (await admin.get('/api/reports')).data.map((x) => x.key);
  assert.deepEqual(kinds, ['business', 'sample', 'production', 'supply', 'finance', 'trade', 'designer', 'revision']);
  for (const k of kinds) {
    const r = await admin.get('/api/reports/' + k);
    assert.equal(r.status, 200, k);
    assert.ok(r.data.sections.length > 0, k);
  }
  const trade = (await admin.get('/api/reports/trade')).data;
  assert.equal(trade.sections[0].rows[0][0], 'Germany');
  const rev = (await admin.get('/api/reports/revision')).data;
  assert.ok(rev.sections[0].rows.some((r) => r[1] === 'YL-T001B' && r[6] === '已转正'));
  assert.ok(rev.sections[0].rows.some((r) => r[1] === 'YL-V001A' && r[6] === '临时货号'));
  assert.deepEqual(rev.sections[1].rows[0].slice(0, 3), ['YL-T001', '已锁定', 'YL-T001B']);
  const prod = (await admin.get('/api/reports/production')).data;
  assert.ok(prod.sections[0].rows.some((r) => r[1] === '烧制' && r[4] === 12));
  assert.equal((await hr.get('/api/reports/business')).status, 200);
  assert.equal((await designer1.get('/api/reports/business')).status, 403, '设计师无统计报表模块权限');
});

test('TC-RP-02 Excel 导出接口：无导出权限拦截', async () => {
  const r = await admin.post('/api/export', { module: 'report', title: '测试', headers: ['A', 'B'], rows: [[1, '中文']] });
  assert.equal(r.status, 200);
  assert.equal(r.data.slice(0, 2).toString(), 'PK');
  assert.equal((await hr.post('/api/export', { module: 'order', title: 't', headers: [], rows: [] })).status, 403);
});

test('TC-SEC-01 搜索参数注入安全、未知接口404、错误JSON 400', async () => {
  const r = await admin.get("/api/e/customer?q=' OR 1=1 --");
  assert.equal(r.status, 200);
  assert.equal(r.data.total, 0);
  assert.equal((await admin.get('/api/nope')).status, 404);
  const bad = await fetch(srv.base + '/api/quotes', { method: 'POST', headers: { Authorization: 'Bearer ' + admin.token }, body: '{bad' });
  assert.equal(bad.status, 400);
});

test('TC-SH-02 旧货号锁定前已确认的订单可继续出货；锁定后的新订单仍被禁止（模拟发现的缺陷S1）', async () => {
  const early = await sales2.post('/api/orders', { customer_id: 3, currency: 'EUR', delivery_date: '2027-02-01', items: [{ sample_id: 4, qty: 800, unit_price: 3.2 }] });
  assert.equal(early.status, 200, JSON.stringify(early.data));
  const send = await sales2.post('/api/sample-sends', { customer_id: 3, items: [{ sample_id: 4, qty: 1, new_item_no: 'YL-D001N', revise_req: '耳朵加长' }] });
  const it = send.data.items[0];
  await sales2.post(`/api/send-items/${it.id}/verify`, { pass: true });
  srv.app.db.prepare("UPDATE orders SET created_at=datetime('now','localtime','-1 minute') WHERE id=?").run(early.data.id);
  assert.equal((await manager.post(`/api/send-items/${it.id}/convert`)).status, 200);
  assert.ok(srv.app.db.prepare('SELECT locked_at FROM samples WHERE id=4').get().locked_at, '记录锁定时间');
  const sh = await sales2.post(`/api/orders/${early.data.id}/shipments`, { items: [{ order_item_id: early.data.items[0].id, qty: 800 }] });
  assert.equal(sh.status, 200, '锁定前已确认的订单可出货：' + JSON.stringify(sh.data));
  const late = await sales2.post('/api/orders', { customer_id: 3, currency: 'EUR', delivery_date: '2027-02-01', items: [{ sample_id: 4, qty: 10, unit_price: 3.2 }] });
  assert.equal(late.status, 409, '锁定后不能再用旧货号下单');
});

test('TC-SEC-02 删除保护：被订单引用的客户/样品不能删除', async () => {
  const r = await admin.del('/api/e/customer/1');
  assert.equal(r.status, 409);
  assert.equal((await admin.del('/api/e/sample/1')).status, 409);
});
