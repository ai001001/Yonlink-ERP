'use strict';
/**
 * 亿星操作习惯（批次3）测试：导航树分组计数、快速查找、自动过滤、排序、个人设置、客户页签、业务交接
 * Batch-3 tests (亿星 operating habits): tree group counts, quick search, auto filters, sorting,
 * per-user preferences, customer tabs and business handover.
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
const BLANK = '__BLANK__';

test.before(async () => {
  srv = await startServer();
  [admin, sales1, sales2, manager] = await Promise.all(['admin', 'sales1', 'sales2', 'manager1'].map((u) => srv.login(u)));
  // 补充几条客户数据：不同国别、等级、空值 / extra customers covering countries, levels and blanks
  for (const [code, name, country, level, city] of [['N001', 'Alpha Co', 'USA', 'A', 'Boston'], ['N002', 'Beta Co', 'USA', 'C', ''], ['N003', 'Gamma Co', 'Japan', 'A', 'Osaka']]) {
    const r = await sales1.post('/api/e/customer', { code, name, country, level, city });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
});
test.after(() => srv.close());

const qs = (o) => new URLSearchParams(o).toString();

// ===================== 导航树 / navigation tree =====================
test('TC-NAV-01 导航树分组：两级分组计数之和等于总数，引用字段显示姓名，空值单独成组', async () => {
  const all = await admin.get('/api/e/customer?size=1');
  const g = await admin.get('/api/e-groups/customer?' + qs({ by: 'salesman_id,country' }));
  assert.equal(g.status, 200, JSON.stringify(g.data));
  assert.equal(g.data.total, all.data.total);
  assert.equal(g.data.groups.reduce((s, x) => s + x.n, 0), all.data.total);
  const usa = g.data.groups.find((x) => x.l[0].startsWith('林晓明') && x.l[1] === 'USA');
  assert.ok(usa && usa.n >= 3, '林晓明名下 USA 客户至少 3 个（含种子数据）');
  assert.equal(typeof usa.v[0], 'number', '引用字段的值是员工ID');
  const city = await admin.get('/api/e-groups/customer?' + qs({ by: 'city' }));
  assert.ok(city.data.groups.some((x) => x.v[0] === BLANK && x.l[0] === '(空)'), '空值归入“(空)”节点');
  const bad = await admin.get('/api/e-groups/customer?by=remark');
  assert.equal(bad.status, 400, '备注等长文本字段不能分组');
  const bad2 = await admin.get('/api/e-groups/customer?by=nope');
  assert.equal(bad2.status, 400);
});

test('TC-NAV-02 数据范围：业务员的导航树只统计本人客户', async () => {
  const own = await sales1.get('/api/e/customer?size=1');
  const g = await sales1.get('/api/e-groups/customer?by=country');
  assert.equal(g.data.total, own.data.total);
  const g2 = await sales2.get('/api/e-groups/customer?by=country');
  assert.ok(!g2.data.groups.some((x) => x.l[0] === 'Japan'), '王芳看不到林晓明的日本客户');
});

test('TC-NAV-03 筛选：导航节点(含空值)、快速查找(含引用字段姓名)、自动过滤多选(含空值)可叠加', async () => {
  const usa = await admin.get('/api/e/customer?' + qs({ f_country: 'USA' }));
  assert.ok(usa.data.rows.every((r) => r.country === 'USA'));
  const blankCity = await admin.get('/api/e/customer?' + qs({ f_city: BLANK }));
  assert.ok(blankCity.data.rows.every((r) => !r.city));
  assert.ok(blankCity.data.rows.some((r) => r.code === 'N002'));
  const like = await admin.get('/api/e/customer?' + qs({ l_name: ' Co', l_code: 'N0', l_salesman_id: '林晓' }));
  assert.deepEqual(like.data.rows.map((r) => r.code).sort(), ['N001', 'N002', 'N003']);
  const multi = await admin.get('/api/e/customer?' + qs({ in_level: JSON.stringify(['A', 'C']), l_code: 'N00' }));
  assert.deepEqual(multi.data.rows.map((r) => r.code).sort(), ['N001', 'N002', 'N003']);
  const onlyA = await admin.get('/api/e/customer?' + qs({ in_level: JSON.stringify(['A']), l_code: 'N00' }));
  assert.deepEqual(onlyA.data.rows.map((r) => r.code).sort(), ['N001', 'N003']);
  const withBlank = await admin.get('/api/e/customer?' + qs({ in_city: JSON.stringify(['Osaka', BLANK]), l_code: 'N00' }));
  assert.deepEqual(withBlank.data.rows.map((r) => r.code).sort(), ['N002', 'N003']);
  const emp = (await admin.get('/api/options/employee')).data.find((e) => e.label.startsWith('林晓明'));
  const byRef = await admin.get('/api/e/customer?' + qs({ in_salesman_id: JSON.stringify([emp.id]), f_country: 'Japan' }));
  assert.deepEqual(byRef.data.rows.map((r) => r.code), ['N003']);
  const bad = await admin.get('/api/e/customer?in_level=notjson');
  assert.equal(bad.status, 400);
  // 数字列多选过滤 / numeric column filter
  const samples = await admin.get('/api/e-values/sample?field=pcs_per_carton');
  const first = samples.data.find((v) => v.v !== BLANK);
  const num = await admin.get('/api/e/sample?' + qs({ in_pcs_per_carton: JSON.stringify([first.v]) }));
  assert.equal(num.data.total, first.n);
});

test('TC-NAV-04 自动过滤可选值：不受本列已选条件影响、受其它条件影响，带计数', async () => {
  const v = await admin.get('/api/e-values/customer?' + qs({ field: 'level', in_level: JSON.stringify(['A']), l_code: 'N00' }));
  assert.deepEqual(v.data.map((x) => x.l).sort(), ['A', 'C'], '本列的筛选不影响本列可选值');
  const v2 = await admin.get('/api/e-values/customer?' + qs({ field: 'level', f_country: 'Japan', l_code: 'N00' }));
  assert.deepEqual(v2.data.map((x) => [x.l, x.n]), [['A', 1]]);
  const ref = await admin.get('/api/e-values/customer?field=salesman_id');
  assert.ok(ref.data.some((x) => x.l.startsWith('林晓明') && typeof x.v === 'number'));
});

test('TC-NAV-05 排序：升序/降序、引用字段按姓名、空值总在最后、非法字段忽略', async () => {
  const asc = await admin.get('/api/e/customer?' + qs({ l_code: 'N00', sort: 'name', dir: 'asc' }));
  assert.deepEqual(asc.data.rows.map((r) => r.code), ['N001', 'N002', 'N003']);
  const desc = await admin.get('/api/e/customer?' + qs({ l_code: 'N00', sort: 'name', dir: 'desc' }));
  assert.deepEqual(desc.data.rows.map((r) => r.code), ['N003', 'N002', 'N001']);
  const cityAsc = await admin.get('/api/e/customer?' + qs({ l_code: 'N00', sort: 'city', dir: 'asc' }));
  assert.equal(cityAsc.data.rows.at(-1).code, 'N002', '空城市排最后');
  const cityDesc = await admin.get('/api/e/customer?' + qs({ l_code: 'N00', sort: 'city', dir: 'desc' }));
  assert.equal(cityDesc.data.rows.at(-1).code, 'N002', '降序时空值也排最后');
  const ref = await admin.get('/api/e/customer?' + qs({ sort: 'salesman_id', dir: 'asc', size: 200 }));
  const names = ref.data.rows.map((r) => r.salesman_id_label).filter(Boolean);
  assert.deepEqual(names, [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  const ignore = await admin.get('/api/e/customer?sort=1;DROP TABLE customers&dir=asc');
  assert.equal(ignore.status, 200, '非法排序字段被忽略');
  assert.ok((await admin.get('/api/e/customer?size=1')).data.total > 0);
});

test('TC-NAV-06 个人设置：按账号保存导航方案/列设置，互不影响；非法键与超大内容被拒绝', async () => {
  const v = { schemes: [{ name: '国别→等级', levels: ['country', 'level'] }], active: 0, cols: ['code', 'name'], sort: { key: 'name', dir: 'desc' } };
  assert.equal((await sales1.put('/api/prefs/grid.e.customer', { value: v })).status, 200);
  assert.deepEqual((await sales1.get('/api/prefs/grid.e.customer')).data.value, v);
  assert.equal((await sales2.get('/api/prefs/grid.e.customer')).data.value, null, '其他账号不受影响');
  assert.equal((await sales1.put('/api/prefs/grid.e.customer', { value: { ...v, active: 0, cols: ['code'] } })).status, 200);
  assert.deepEqual((await sales1.get('/api/prefs/grid.e.customer')).data.value.cols, ['code'], '再次保存覆盖');
  assert.equal((await sales1.get('/api/prefs/bad key!')).status, 400);
  assert.equal((await sales1.put('/api/prefs/big', { value: 'x'.repeat(30000) })).status, 400);
  const meta = await sales1.get('/api/meta');
  assert.ok(meta.data.entities.customer.tree.includes('salesman_id'));
  assert.ok(meta.data.entities.customer.schemes.length >= 3);
  assert.ok(meta.data.entities.customer.quick.includes('code'));
});

// ===================== 客户页签 / customer tabs =====================
test('TC-CT-01 客户联系人：主联系人同步到客户档案且唯一；只能给本人客户添加；业务员可删除', async () => {
  const mine = (await sales1.get('/api/e/customer?l_code=N001')).data.rows[0];
  const other = (await admin.get('/api/e/customer?l_code=C003')).data.rows[0];
  const c1 = await sales1.post('/api/e/customer_contact', { customer_id: mine.id, name: 'Tom', email: 'tom@alpha.example', phone: '001-1', is_main: '是' });
  assert.equal(c1.status, 200, JSON.stringify(c1.data));
  let cust = (await sales1.get(`/api/e/customer/${mine.id}`)).data;
  assert.equal(cust.contact, 'Tom');
  assert.equal(cust.email, 'tom@alpha.example');
  const c2 = await sales1.post('/api/e/customer_contact', { customer_id: mine.id, name: 'Ann', email: 'ann@alpha.example', is_main: '是' });
  assert.equal(c2.status, 200);
  const list = (await sales1.get(`/api/e/customer_contact?f_customer_id=${mine.id}`)).data.rows;
  assert.equal(list.filter((x) => x.is_main === '是').length, 1, '只有一个主联系人');
  cust = (await sales1.get(`/api/e/customer/${mine.id}`)).data;
  assert.equal(cust.contact, 'Ann');
  // 数据隔离 / isolation
  const forbidden = await sales1.post('/api/e/customer_contact', { customer_id: other.id, name: 'Hacker' });
  assert.equal(forbidden.status, 404, '不能给别人的客户加联系人');
  const peek = await sales2.get(`/api/e/customer_contact?f_customer_id=${mine.id}`);
  assert.equal(peek.data.total, 0, '王芳看不到林晓明客户的联系人');
  const move = await sales1.put(`/api/e/customer_contact/${c1.data.id}`, { customer_id: other.id });
  assert.equal(move.status, 404, '不能把联系人挪到别人的客户下');
  // 业务员（无删除权限）可删除子记录 / sales (no delete permission) can delete child rows
  assert.equal((await sales1.del(`/api/e/customer_contact/${c1.data.id}`)).status, 200);
  assert.equal((await sales1.del(`/api/e/customer/${mine.id}`)).status, 403, '但不能删除客户本身');
});

test('TC-CT-02 唛头/货代/银行账号：默认唛头唯一；删除客户时子记录一并删除；跟进记录也校验客户归属', async () => {
  const cust = (await sales1.get('/api/e/customer?l_code=N002')).data.rows[0];
  const m1 = await sales1.post('/api/e/customer_mark', { customer_id: cust.id, name: '主唛', front_mark: 'BETA\nPO NO.\nC/NO. 1-UP', is_default: '是' });
  const m2 = await sales1.post('/api/e/customer_mark', { customer_id: cust.id, name: '新唛', front_mark: 'BETA NEW', is_default: '是' });
  assert.equal(m1.status, 200);
  assert.equal(m2.status, 200);
  const marks = (await sales1.get(`/api/e/customer_mark?f_customer_id=${cust.id}`)).data.rows;
  assert.deepEqual(marks.filter((x) => x.is_default === '是').map((x) => x.name), ['新唛']);
  assert.equal((await sales1.post('/api/e/customer_forwarder', { customer_id: cust.id, name: 'DHL Global', contact: 'Lee', port: 'Xiamen' })).status, 200);
  assert.equal((await sales1.post('/api/e/customer_bank', { customer_id: cust.id, bank_name: 'Chase', account_no: '123456789', swift: 'CHASUS33', currency: 'USD' })).status, 200);
  assert.equal((await sales1.post('/api/e/customer_bank', { customer_id: cust.id, bank_name: 'Chase' })).status, 400, '银行账号必填');
  const other = (await admin.get('/api/e/customer?l_code=C003')).data.rows[0];
  assert.equal((await sales1.post('/api/e/customer_follow', { customer_id: other.id, content: 'x' })).status, 404, '跟进记录不能挂到别人的客户');
  // 删除客户级联 / cascade on delete
  assert.equal((await admin.del(`/api/e/customer/${cust.id}`)).status, 200);
  for (const k of ['customer_mark', 'customer_forwarder', 'customer_bank']) {
    assert.equal((await admin.get(`/api/e/${k}?f_customer_id=${cust.id}`)).data.total, 0, `${k} 应随客户删除`);
  }
});

// ===================== 业务交接 / handover =====================
test('TC-HO-01 业务交接：预览数量、参数校验、只交接未完结单据、设为离职、交接记录', async () => {
  const emps = (await admin.get('/api/options/employee')).data;
  const lin = emps.find((e) => e.label.startsWith('林晓明'));
  const wang = emps.find((e) => e.label.startsWith('王芳'));
  const chen = emps.find((e) => e.label.startsWith('陈静'));
  const pv = await admin.get('/api/handover/preview?from=' + lin.id);
  assert.equal(pv.status, 200);
  const customers = pv.data.scopes.find((s) => s.key === 'customers');
  assert.ok(customers.all >= 4);
  assert.equal((await sales1.get('/api/handover/preview?from=' + lin.id)).status, 403, '业务员无权交接');
  assert.equal((await admin.post('/api/handover', { from_emp_id: lin.id, to_emp_id: lin.id, scopes: ['customers'] })).status, 400);
  assert.equal((await admin.post('/api/handover', { from_emp_id: lin.id, to_emp_id: wang.id, scopes: [] })).status, 400);
  // 给林晓明建两张报价：一张草稿（未完结），一张标记成交前的草稿 / create quotes for 林晓明
  const n1 = (await sales1.get('/api/e/customer?l_code=N001')).data.rows[0];
  const q1 = await sales1.post('/api/quotes', { customer_id: n1.id, currency: 'USD', term: 'FOB', items: [{ sample_id: 1, qty: 100 }] });
  assert.equal(q1.status, 200, JSON.stringify(q1.data));
  // 只交接未完结单据：客户 + 报价 / open documents only
  const r = await admin.post('/api/handover', { from_emp_id: lin.id, to_emp_id: chen.id, scopes: ['customers', 'quotes'], include_history: false, reason: '调岗' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.counts.customers, customers.all);
  assert.ok(r.data.counts.quotes >= 1);
  const pv2 = await admin.get('/api/handover/preview?from=' + lin.id);
  assert.equal(pv2.data.scopes.find((s) => s.key === 'customers').all, 0, '林晓明名下客户已清空');
  // 陈静(sales3)登录后能看到接手的客户与报价 / the receiver now sees them
  const sales3 = await srv.login('sales3');
  const seen = await sales3.get('/api/e/customer?l_code=N00');
  assert.ok(seen.data.total >= 2);
  const quotes = await sales3.get('/api/quotes');
  assert.ok(quotes.data.rows.some((q) => q.id === q1.data.id));
  assert.equal((await sales1.get('/api/e/customer?l_code=N001')).data.total, 0, '交出人不再看到这些客户');
  // 接收人已离职不允许 / receiver must be active
  const left = await admin.post('/api/handover', { from_emp_id: chen.id, to_emp_id: lin.id, scopes: ['customers'], mark_left: false });
  assert.equal(left.status, 200);
  const r2 = await admin.post('/api/handover', { from_emp_id: lin.id, to_emp_id: chen.id, scopes: ['customers'], mark_left: true, reason: '离职' });
  assert.equal(r2.status, 200);
  const linEmp = (await admin.get(`/api/e/employee/${lin.id}`)).data;
  assert.equal(linEmp.status, '离职');
  assert.equal((await admin.post('/api/handover', { from_emp_id: chen.id, to_emp_id: lin.id, scopes: ['customers'] })).status, 400, '不能交给已离职员工');
  const hist = await admin.get('/api/handovers');
  assert.ok(hist.data.length >= 3);
  assert.equal(hist.data.at(-1).history, false);
  assert.match(hist.data.at(-1).detail, /客户（业务员）/);
  const logs = await admin.get('/api/e/log?q=' + encodeURIComponent('业务交接'));
  assert.ok(logs.data.total >= 3);
  assert.equal((await manager.post('/api/handover', { from_emp_id: chen.id, to_emp_id: wang.id, scopes: ['customers'] })).status, 403);
});

test('TC-HO-02 数据迁移回滚时，导入客户的联系人等子记录一并删除', async () => {
  const { buildXlsx } = require('../server/xlsx');
  const data = buildXlsx({ rows: [['客户编号', '客户简称', '国别'], ['MIGX1', 'Mig Co', 'UK']] }).toString('base64');
  const imp = await admin.post('/api/migrate/import', { entity: 'customer', data, file_name: 'x.xlsx' });
  assert.equal(imp.status, 200, JSON.stringify(imp.data));
  const cust = (await admin.get('/api/e/customer?l_code=MIGX1')).data.rows[0];
  assert.equal((await admin.post('/api/e/customer_contact', { customer_id: cust.id, name: 'Joe' })).status, 200);
  const rb = await admin.post(`/api/migrate/batches/${imp.data.batch.id}/rollback`);
  assert.equal(rb.status, 200, JSON.stringify(rb.data));
  assert.equal(rb.data.deleted, 1);
  assert.equal((await admin.get(`/api/e/customer_contact?f_customer_id=${cust.id}`)).data.total, 0);
});
