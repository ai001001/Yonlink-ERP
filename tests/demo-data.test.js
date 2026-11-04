'use strict';
/**
 * 全流程业务模拟测试：模拟半年运营（数千次接口调用）后做一致性审计与报表交叉核对
 * Full business-simulation test: replays six months of operations, then audits consistency and cross-checks reports.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { seedDemo } = require('../scripts/seed-demo');
const { audit } = require('../scripts/audit-data');
const { loadUser } = require('../server/routes/base');

let result;
let db;
let router;
let config;

/**
 * 以某账号直接调用接口 / Call a route directly as a user.
 * @param {string} username
 * @param {string} url
 * @returns {Promise<any>}
 */
async function as(username, url) {
  const u = db.prepare('SELECT id FROM users WHERE username=?').get(username);
  const token = `test-${username}`;
  db.prepare('INSERT OR REPLACE INTO sessions(token,user_id,expires_at) VALUES(?,?,?)').run(token, u.id, Date.now() + 3600000);
  const p = new URL(url, 'http://t');
  const m = router.match('GET', p.pathname);
  const ctx = { db, config, params: m.params, query: Object.fromEntries(p.searchParams), token, body: {} };
  ctx.user = loadUser(db, token);
  return m.handler(ctx);
}

test.before(async () => {
  result = await seedDemo({ dbFile: ':memory:', days: 180 });
  ({ db, router, config } = result.app);
});

test('TC-SIM-01 半年业务模拟全部通过接口校验，各版块均有数据', () => {
  const s = result.stats;
  assert.ok(result.calls > 3000, `接口调用 ${result.calls} 次`);
  for (const [k, min] of Object.entries({ customers: 18, suppliers: 12, agencies: 10, employees: 17, samples: 30, files: 30, mails: 200, quotes: 30, inquiries: 40,
    sample_sends: 3, orders: 15, order_changes: 15, change_tasks: 8, shipments: 15, purchases: 50, payments: 50, purchase_invoices: 30, receipts: 20, sales_invoices: 5,
    productions: 20, production_reports: 200, material_issues: 40, rate_history: 12, customer_follows: 50, approvals: 50, supplier_prices: 100, agency_records: 10 })) {
    assert.ok(s[k] >= min, `${k} = ${s[k]}，应 ≥ ${min}`);
  }
  const statuses = (t, col) => db.prepare(`SELECT DISTINCT ${col} v FROM ${t}`).all().map((r) => r.v);
  assert.ok(statuses('quotes', 'status').length >= 4, '报价状态多样：' + statuses('quotes', 'status'));
  assert.ok(statuses('orders', 'status').length >= 3, '订单状态多样：' + statuses('orders', 'status'));
  assert.ok(statuses('approvals', 'status').length >= 2);
});

test('TC-SIM-02 数据一致性审计全部通过', () => {
  const res = audit(db);
  const bad = res.filter((r) => !r.ok);
  assert.deepEqual(bad, [], bad.map((r) => `${r.name}：${r.detail}`).join('\n'));
  assert.ok(res.length >= 25);
  // 缺陷S3回归：联动任务中的“已完工”不超过计划数 / S3 regression: finished qty in task text never exceeds plan
  for (const t of db.prepare("SELECT content FROM change_tasks WHERE dept='生产'").all()) {
    for (const m of t.content.matchAll(/计划(\d+)，已完工(\d+)/g)) assert.ok(Number(m[2]) <= Number(m[1]), t.content);
  }
});

test('TC-SIM-03 时间轴真实：业务日期分布在近半年，订单处于不同阶段', () => {
  const months = db.prepare("SELECT COUNT(DISTINCT substr(created_at,1,7)) c FROM quotes").get().c;
  assert.ok(months >= 5, `报价分布在 ${months} 个月`);
  const minDate = db.prepare('SELECT MIN(created_at) m FROM logs').get().m;
  assert.ok(minDate.slice(0, 10) === result.start.slice(0, 10), `最早日志 ${minDate}`);
  const reportDays = db.prepare('SELECT COUNT(DISTINCT report_date) c FROM production_reports').get().c;
  assert.ok(reportDays > 30, `报工分布在 ${reportDays} 天`);
});

test('TC-SIM-04 报表与台账交叉核对一致', async () => {
  const fin = await as('finance1', '/api/reports/finance');
  const rec = (await as('finance1', '/api/receivables')).rows;
  for (const row of fin.sections[0].rows) {
    const [cur, amt, received] = row;
    const sumAmt = rec.filter((r) => r.currency === cur).reduce((a, r) => a + r.amount, 0);
    const sumRec = rec.filter((r) => r.currency === cur).reduce((a, r) => a + r.received, 0);
    assert.ok(Math.abs(sumAmt - amt) < 0.05, `${cur} 应收 ${amt} vs 台账 ${sumAmt}`);
    assert.ok(Math.abs(sumRec - received) < 0.05, `${cur} 实收 ${received} vs 台账 ${sumRec}`);
  }
  const des = (await as('admin', '/api/reports/designer')).sections[0].rows;
  const totalQty = db.prepare('SELECT COALESCE(SUM(oi.qty),0) q FROM order_items oi JOIN samples s ON s.id=oi.sample_id WHERE s.designer_id IS NOT NULL').get().q;
  assert.equal(des.reduce((a, r) => a + r[5], 0), totalQty, '各设计师下单数量之和 = 订单总量');
  for (const u of ['designer1', 'designer2', 'designer3']) {
    const s = await as(u, '/api/designer/summary');
    const row = des.find((r) => r[0] === s.designer.name);
    assert.equal(s.summary.order_qty, row ? row[5] : 0, `${u} 速查中心与报表一致`);
    assert.ok(s.samples.every((x) => db.prepare('SELECT designer_id FROM samples WHERE id=?').get(x.id).designer_id === s.designer.id), '只含本人样品');
  }
  const pay = (await as('finance1', '/api/payables')).rows.reduce((a, r) => a + r.amount, 0);
  const finPay = (await as('finance1', '/api/reports/finance')).sections[1].rows.find((r) => r[0] === '采购应付')[1];
  assert.ok(Math.abs(pay - finPay) < 0.05, `应付台账 ${pay} vs 报表 ${finPay}`);
});

test('TC-SIM-05 各岗位在满数据下的页面接口均正常且响应快', async () => {
  const urls = ['/api/dashboard', '/api/quotes', '/api/orders', '/api/shipments', '/api/mails', '/api/sample-sends', '/api/purchases', '/api/payables', '/api/receivables',
    '/api/productions', '/api/change-tasks', '/api/approvals', '/api/inquiries', '/api/e/customer', '/api/e/sample', '/api/e/log', '/api/designer/summary',
    ...['business', 'sample', 'production', 'supply', 'finance', 'trade', 'designer', 'revision'].map((k) => '/api/reports/' + k)];
  const users = ['admin', 'sales1', 'sales2', 'sales3', 'manager1', 'designer1', 'designer3', 'purchase1', 'prod1', 'finance1', 'hr1'];
  let ok = 0;
  for (const u of users) {
    for (const url of urls) {
      const t0 = Date.now();
      try {
        await as(u, url);
        ok++;
        assert.ok(Date.now() - t0 < 1500, `${u} ${url} 耗时 ${Date.now() - t0}ms`);
      } catch (e) {
        assert.ok([403, 400].includes(e.status), `${u} ${url}：${e.message}`);
      }
    }
  }
  assert.ok(ok > 120, `成功调用 ${ok} 次`);
});

test('TC-SIM-06 工作台预警真实可见：风控锁定、待审批、缺料/积压、开票逾期或生产延期', async () => {
  const types = new Set((await as('admin', '/api/dashboard')).alerts.map((a) => a.type));
  assert.ok(types.size >= 3, '预警类型：' + [...types].join('、'));
  const s1 = (await as('sales1', '/api/quotes')).rows;
  assert.ok(s1.every((q) => q.salesman_id === db.prepare("SELECT employee_id e FROM users WHERE username='sales1'").get().e), '业务员仅见本人报价');
  const mails = (await as('sales3', '/api/mails')).rows;
  assert.ok(mails.length > 10 && mails.every((m) => m.account_id === null || m.account_email === 'ai003@316191099.xyz' || m.customer_name), '陈静邮件隔离');
});
