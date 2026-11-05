'use strict';
/**
 * 业务模拟器：模拟公司约半年的真实运营，全部通过系统接口录入（同时作为全流程测试）
 * Business simulator: replays ~6 months of company operations through the real API (doubles as an end-to-end test).
 *
 * 用法 / usage:
 *   node scripts/seed-demo.js                 # 生成到 data/erp.db（原库自动备份）/ write data/erp.db (backs up existing)
 *   node scripts/seed-demo.js --out x.db      # 指定输出文件 / custom output
 *   node scripts/seed-demo.js --days 120      # 模拟天数 / simulated days
 * @module scripts/seed-demo
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createApp } = require('../server/app');
const { loadUser } = require('../server/routes/base');
const { buildMessage } = require('../server/mail');
const { startMockMail, USERS: MOCK_USERS } = require('../tests/mock-mail-server');
const { renderSamplePng } = require('./sample-art');
const C = require('./demo-catalog');

const DAY = 86400000;
const HOUR = 3600000;
const PROCESSES = ['制坯', '上釉', '烧制', '彩绘', '包装'];

/**
 * 可复现随机数 / Reproducible PRNG (mulberry32).
 * @param {number} seed
 */
function makeRng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    chance: (p) => next() < p,
    float: (lo, hi) => lo + next() * (hi - lo),
    sample: (arr, n) => {
      const copy = arr.slice();
      const out = [];
      while (copy.length && out.length < n) out.push(copy.splice(Math.floor(next() * copy.length), 1)[0]);
      return out;
    },
  };
}

/**
 * 运行业务模拟 / Run the business simulation.
 * @param {object} opt
 * @param {string} opt.dbFile 输出数据库 / output database file
 * @param {number} [opt.days] 模拟天数 / simulated days
 * @param {number} [opt.seed] 随机种子 / random seed
 * @param {(msg:string)=>void} [opt.log] 日志 / logger
 * @returns {Promise<{stats:object, start:string, end:string, calls:number}>}
 */
async function seedDemo({ dbFile, days = 180, seed = 20261104, log = () => {} }) {
  const RealDate = Date;
  const realNow = RealDate.now();
  const fmt = (ms) => new RealDate(ms).toLocaleString('sv-SE');
  const realStartStr = fmt(realNow - 60000);
  const realDateStr = realStartStr.slice(0, 10);
  // 模拟时间轴：结束于昨天 / timeline ends yesterday
  const today0 = new RealDate(new RealDate(realNow).toDateString()).getTime();
  const endTime = today0 - DAY + 20 * HOUR;
  const startTime = today0 - days * DAY;
  let simNow = startTime + 8 * HOUR;
  const rng = makeRng(seed);

  // ---------- 时间机器：让系统以为“今天”是模拟日期 / time machine ----------
  class SimDate extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(simNow); }
    static now() { return simNow; }
  }
  globalThis.Date = SimDate;

  const mock = await startMockMail();
  let app;
  let calls = 0;
  try {
    app = createApp({ dbFile, reset: true });
    const { db, router, config } = app;

    // 时间戳校正：把数据库默认的“真实当前时间”改为模拟时间 / rewrite DB-default timestamps to simulated time
    const tsCols = [];
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
      for (const c of db.prepare(`PRAGMA table_info(${name})`).all()) {
        if (['created_at', 'updated_at', 'handled_at', 'decided_at', 'sent_at', 'last_fetch_at'].includes(c.name)) tsCols.push([name, c.name, 'dt']);
        if (c.name === 'price_date') tsCols.push([name, c.name, 'd']);
      }
    }
    // 只插入不修改的列按 rowid 增量处理，其它列全表处理（这些表很小）/ insert-only columns are processed incrementally by rowid
    const lastRow = {};
    const stamp = () => {
      const s = fmt(simNow);
      for (const [t, c, k] of tsCols) {
        const insertOnly = c === 'created_at' || c === 'price_date';
        const from = insertOnly ? (lastRow[t] || 0) : 0;
        if (k === 'dt') db.prepare(`UPDATE ${t} SET ${c}=? WHERE rowid > ? AND ${c} >= ?`).run(s, from, realStartStr);
        else db.prepare(`UPDATE ${t} SET ${c}=? WHERE rowid > ? AND ${c} >= ?`).run(s.slice(0, 10), from, realDateStr);
      }
      for (const [t] of tsCols) lastRow[t] = db.prepare(`SELECT COALESCE(MAX(rowid),0) m FROM ${t}`).get().m;
    };

    // ---------- 以各岗位身份调用接口 / call the API as a given user ----------
    const tokens = {};
    const tokenFor = (u) => {
      if (!tokens[u]) {
        const user = db.prepare('SELECT id FROM users WHERE username=?').get(u);
        if (!user) throw new Error('用户不存在：' + u);
        tokens[u] = crypto.randomBytes(16).toString('hex');
        db.prepare('INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)').run(tokens[u], user.id, 8e15);
      }
      return tokens[u];
    };
    /**
     * @param {string} u 账号 / username
     * @param {string} method
     * @param {string} url
     * @param {object} [body]
     * @param {{allow?:number[]}} [o] 允许的错误码（返回错误而不中断）/ tolerated error codes
     */
    const api = async (u, method, url, body, o = {}) => {
      calls++;
      const parsed = new URL(url, 'http://seed');
      const m = router.match(method, decodeURIComponent(parsed.pathname));
      if (!m) throw new Error(`接口不存在 ${method} ${url}`);
      const token = m.opts.public ? '' : tokenFor(u);
      const ctx = { db, config, params: m.params, query: Object.fromEntries(parsed.searchParams), token, ip: '10.0.0.' + (calls % 200), body: body ? JSON.parse(JSON.stringify(body)) : {} };
      ctx.user = loadUser(db, token);
      try {
        return await m.handler(ctx);
      } catch (e) {
        if (o.allow && o.allow.includes(e.status)) return { __error: e.status, message: e.message, extra: e.extra };
        throw new Error(`[${fmt(simNow)}] ${u} ${method} ${url} 失败：${e.message}`);
      }
    };

    // ---------- 事件队列 / event queue ----------
    const queue = [];
    let seq = 0;
    const at = (t, fn) => { queue.push({ t, s: seq++, fn }); };
    const day = (d, h = 9) => startTime + d * DAY + h * HOUR;
    const later = (dDays, h) => { const t = simNow + dDays * DAY; const base = new RealDate(t); return h === undefined ? t + rng.int(-60, 60) * 60000 : new RealDate(base.getFullYear(), base.getMonth(), base.getDate(), Math.floor(h), Math.round((h % 1) * 60)).getTime(); };
    const dateStr = (t = simNow) => fmt(t).slice(0, 10);

    // ---------- 引用数据 / lookups ----------
    const ref = { emp: {}, cust: {}, sup: {}, sample: {}, inv: {}, acct: {}, fwd: [], role: {} };
    const custOf = (code) => ref.cust[code];
    const sampleRow = (id) => db.prepare('SELECT * FROM samples WHERE id=?').get(id);
    const usableSamples = () => db.prepare("SELECT * FROM samples WHERE status='正常'").all();
    const successor = (s) => db.prepare('SELECT * FROM samples WHERE parent_no=? ORDER BY id DESC LIMIT 1').get(s.company_no);
    const rate = (code) => db.prepare('SELECT rate FROM currencies WHERE code=?').get(code).rate;
    const usedNewNos = new Set();
    const newItemNo = (base) => {
      for (const L of 'ABCDEFGHJK') {
        const no = `${base.replace(/[A-Z]$/, '')}${L}`;
        if (!usedNewNos.has(no) && no !== base && !db.prepare('SELECT 1 FROM samples WHERE company_no=?').get(no)) { usedNewNos.add(no); return no; }
      }
      throw new Error('无可用新货号：' + base);
    };

    // ---------- 邮件 / mail ----------
    const inbound = async (salesUser, from, subject, text, attachments = []) => {
      const to = C.MAILBOX[salesUser];
      const { raw } = buildMessage({ from, to: [{ address: to }], subject, text, attachments });
      mock.store.deliver(to, raw);
      await api(salesUser, 'POST', `/api/mail-accounts/${ref.acct[salesUser]}/fetch`);
    };
    const outbound = (salesUser, to, subject, body, binds = {}) => api(salesUser, 'POST', '/api/mails/send', { account_id: ref.acct[salesUser], to, subject, body, ...binds });
    const follow = (salesUser, custId, type, content, nextDays) => api(salesUser, 'POST', '/api/e/customer_follow', { customer_id: custId, type, content, next_date: nextDays ? dateStr(simNow + nextDays * DAY) : '' });

    // ======================= 第0天：基础档案 / day 0: master data =======================
    at(day(0, 8.5), async () => {
      for (const r of (await api('admin', 'GET', '/api/roles')).rows) ref.role[r.code] = r.id;
      const depts = Object.fromEntries((await api('hr1', 'GET', '/api/e/department')).rows.map((d) => [d.name, d.id]));
      for (const [no, name, dept, pos, username, role] of C.STAFF) {
        let e = db.prepare('SELECT id FROM employees WHERE emp_no=?').get(no);
        if (!e) e = await api('hr1', 'POST', '/api/e/employee', { emp_no: no, name, dept_id: depts[dept], position: pos, phone: '1390000' + no.slice(1), hire_date: dateStr(simNow - rng.int(200, 900) * DAY), status: '在职' });
        if (username && !db.prepare('SELECT 1 FROM users WHERE username=?').get(username)) await api('admin', 'POST', '/api/users', { username, name, role_id: ref.role[role], employee_id: e.id, password: '123456' });
      }
      for (const e of (await api('hr1', 'GET', '/api/e/employee?size=100')).rows) ref.emp[e.emp_no] = e.id;
      await api('hr1', 'PUT', `/api/e/employee/${ref.emp.E009}`, { remark: '负责员工入离职与考勤' });
    });
    at(day(0, 9), async () => {
      for (const s of C.SUPPLIERS) {
        await api('purchase1', 'POST', '/api/e/supplier', { code: s[0], name: s[1], type: s[2], contact: s[3], phone: s[4], settlement: s[5], item_range: s[6], rating: s[7], email: s[8], qualification: '营业执照、出口质量许可齐全', pass_rate: 100 });
      }
      for (const s of (await api('purchase1', 'GET', '/api/e/supplier?size=100')).rows) ref.sup[s.code] = s;
      for (const a of C.AGENCIES) await api('admin', 'POST', '/api/e/agency', { name: a[0], type: a[1], contact: a[2], phone: a[3], price_note: a[4], service_days: a[5], rating: a[6] });
      ref.fwd = (await api('admin', 'GET', '/api/e/agency?size=100')).rows.filter((a) => a.type === '货代公司').map((a) => a.id);
      const inv = (await api('purchase1', 'GET', '/api/e/inventory?size=100')).rows;
      for (const m of C.MATERIALS) await api('purchase1', 'POST', '/api/e/inventory', { code: m[0], name: m[1], category: m[2], unit: m[3], qty: m[4], unit_cost: m[5], safety_qty: m[6], max_qty: m[7] });
      const boxRow = inv.find((i) => i.code === 'P-BOX-01');
      await api('purchase1', 'PUT', `/api/e/inventory/${boxRow.id}`, { qty: 1200, safety_qty: 500 });
      const ctn = inv.find((i) => i.code === 'P-CTN-01');
      await api('purchase1', 'PUT', `/api/e/inventory/${ctn.id}`, { qty: 600, max_qty: 3000 });
      for (const i of (await api('purchase1', 'GET', '/api/e/inventory?size=100')).rows) ref.inv[i.code] = i;
    });
    at(day(0, 10), async () => {
      for (const s of C.SAMPLES) {
        const [no, name, en, l, w, h, mat, craft, color, emp, sup, mc, lc, fee, ol, ow, oh, pcs, moq] = s;
        await api('admin', 'POST', '/api/e/sample', {
          company_no: no, customer_no: '', factory_no: `${sup}-${no.slice(3)}`, name, name_en: en, length_cm: l, width_cm: w, height_cm: h, material: mat, craft, color,
          consumables: /LED/.test(en) ? 'LED灯串、电池盒' : '彩盒、珍珠棉', material_cost: mc, labor_cost: lc, sample_fee: fee, designer_id: ref.emp[emp], supplier_id: ref.sup[sup].id,
          package_req: pcs >= 24 ? '单个珍珠棉袋+彩盒，内盒4只装' : '单个泡沫+彩盒', label_req: '底部贴 Made in China 防水标，外箱双唛', inner_box: pcs >= 24 ? '内盒4只装' : '彩盒单只装',
          outer_l: ol, outer_w: ow, outer_h: oh, pcs_per_carton: pcs, moq, stock_qty: 5, progress: '已完成',
        });
      }
      for (const s of usableSamples()) {
        ref.sample[s.company_no] = s.id;
        await api('admin', 'POST', `/api/samples/${s.id}/images`, { name: `${s.company_no}-正面.png`, data: renderSamplePng(s).toString('base64') });
      }
    });
    at(day(0, 11), async () => {
      for (const [code, name, country, contact, email, sales, level, source, cur, port] of C.CUSTOMERS) {
        let row = db.prepare('SELECT * FROM customers WHERE code=?').get(code);
        if (!row) row = await api(sales, 'POST', '/api/e/customer', { code, name, country, contact, email, phone: '+' + rng.int(10, 99) + ' ' + rng.int(100000000, 999999999), address: `${port}`, level, source, remark: `常用目的港：${port}` });
        ref.cust[code] = { id: row.id, code, name: row.name, sales, cur, port, contact, email, level };
      }
      for (const [u, email] of Object.entries(C.MAILBOX)) {
        const name = db.prepare('SELECT name FROM users WHERE username=?').get(u).name;
        const a = await api(u, 'POST', '/api/mail-accounts', { email, display_name: `${name} | Yonlink Ceramics`, smtp_host: '127.0.0.1', smtp_port: mock.ports.smtp, smtp_secure: 'none', imap_host: '127.0.0.1', imap_port: mock.ports.imap, imap_secure: 'none', password: MOCK_USERS[email] });
        ref.acct[u] = a.id;
      }
      await api('admin', 'PUT', '/api/settings', { company_name: '永联陶瓷工艺品有限公司', quote_min_profit: '15' });
    });

    // ======================= 周期性事件 / recurring events =======================
    const users = ['admin', 'sales1', 'sales2', 'sales3', 'manager1', 'designer1', 'designer2', 'designer3', 'purchase1', 'prod1', 'finance1', 'hr1'];
    for (let d = 1; d < days; d += 14) {
      at(day(d, 8.4), async () => {
        for (const u of users) await api(u, 'POST', '/api/login', { username: u, password: '123456' });
        if (rng.chance(0.5)) await api('x', 'POST', '/api/login', { username: rng.pick(users), password: 'wrong-pass' }, { allow: [401] });
      });
    }
    // 每月1日更新汇率（随机游走）/ monthly rate update on the 1st (random walk)
    for (let d = 1; d < days; d++) {
      if (new RealDate(day(d)).getDate() !== 1) continue;
      at(day(d, 9.2), async () => {
        for (const code of ['USD', 'EUR', 'GBP', 'JPY']) {
          const r = rate(code);
          const nr = code === 'JPY' ? Math.round(r * (1 + rng.float(-0.015, 0.015)) * 1e6) / 1e6 : Math.round(r * (1 + rng.float(-0.012, 0.012)) * 1e4) / 1e4;
          const cur = db.prepare('SELECT * FROM currencies WHERE code=?').get(code);
          await api('finance1', 'PUT', `/api/e/currency/${code}`, { code, name: cur.name, rate: nr });
        }
      });
    }
    // 客户日常跟进 / routine follow-ups
    for (let d = 2; d < days; d += 5) {
      at(day(d, 16), async () => {
        const c = rng.pick(Object.values(ref.cust));
        await follow(c.sales, c.id, rng.pick(['跟进', '拜访', '其它']), rng.pick([
          '视频会议沟通明年春夏系列开发方向，客户关注哑光釉与自然色系。', '客户反馈上批货包装完好，零售端动销良好。',
          '提醒客户确认新年度价格表，原材料上涨约3%。', '客户询问圣诞季备货时间，建议8月前下单。', '发送新品目录PDF，客户将转给采购团队评估。',
        ]), 7);
      });
    }

    // ======================= 业务流程 / business flows =======================
    const custCodes = C.CUSTOMERS.map((c) => c[0]);
    const quoteOf = async (u, id) => api(u, 'GET', `/api/quotes/${id}`);
    const approvePending = async (quoteNo) => {
      const ap = (await api('manager1', 'GET', '/api/approvals')).rows.find((a) => a.target_no === quoteNo && a.status === '待审批');
      if (ap) await api('manager1', 'POST', `/api/approvals/${ap.id}/decide`, { pass: true, note: '同意' });
    };
    /** 把报价中已锁定的旧货号替换为新货号并重新审批 / swap locked samples for successors and re-approve */
    const swapLocked = async (deal) => {
      const q = await quoteOf(deal.u, deal.quoteId);
      let changed = false;
      const items = q.items.map((it) => {
        const s = sampleRow(it.sample_id);
        if (s.status !== '已锁定') return { ...it };
        const n = successor(s);
        changed = true;
        return { ...it, sample_id: n.id, new_item_no: null, revise_req: null };
      });
      if (!changed) return;
      await api(deal.u, 'PUT', `/api/quotes/${q.id}`, { ...q, items, auto_price: false });
      await api(deal.u, 'POST', `/api/quotes/${q.id}/submit`);
      await approvePending(q.quote_no);
      await api(deal.u, 'POST', `/api/quotes/${q.id}/status`, { status: '已发客户' });
    };

    let dealNo = 0;
    const startDeal = async (custCode) => {
      const c = custOf(custCode);
      const deal = { n: ++dealNo, c, u: c.sales };
      const pool = usableSamples();
      const picks = rng.sample(pool, rng.int(1, 3));
      deal.items = picks.map((s) => ({ sample_id: s.id, qty: Math.max(s.moq, Math.round((s.moq * rng.float(1, 3)) / (s.pcs_per_carton || 1)) * (s.pcs_per_carton || 1)) }));
      if (rng.chance(0.3)) {
        const it = deal.items[0];
        it.new_item_no = newItemNo(sampleRow(it.sample_id).company_no);
        it.revise_req = rng.pick(['造型改为更修长，高度+3cm', '主色改为哑光鼠尾草绿，去掉描金', '浮雕图案改为客户提供的橄榄枝', '底部加客户LOGO刻印，口沿加厚1mm', '把手改为圆环形，容量增加至400ml']);
      }
      const r = rng.next();
      deal.fate = r < 0.6 ? 'won' : r < 0.82 ? 'lost' : 'pending';
      deal.samplePath = deal.fate !== 'pending' && rng.chance(0.35);
      deal.lowProfit = rng.chance(0.12);
      const names = picks.map((s) => s.name_en).join(', ');
      await inbound(deal.u, { name: c.contact, address: c.email }, `Inquiry: ${names}`, `Dear team,\n\nWe are planning our next collection and are interested in: ${names}.\nPlease quote ${c.cur} prices for about ${deal.items.map((i) => i.qty).join('/')} pcs with packing details (carton size, CBM).\n\nBest regards,\n${c.contact}\n${c.name}`);
      await follow(deal.u, c.id, '询盘', `客户询价：${picks.map((s) => s.company_no).join('、')}，数量约 ${deal.items.map((i) => i.qty).join('/')} 只`, 2);
      if (rng.chance(0.15)) {
        at(later(2, 15), () => follow(deal.u, c.id, '跟进', rng.pick(['客户只是比价，目标价远低于成本，暂不报价。', '客户需求量低于MOQ，建议改为现货款，暂不报价。']), 30));
        return;
      }
      at(later(1, 9.5), () => createQuote(deal));
    };

    const createQuote = async (deal) => {
      const c = deal.c;
      const q = await api(deal.u, 'POST', '/api/quotes', {
        customer_id: c.id, currency: c.cur, term: c.cur === 'USD' && rng.chance(0.3) ? 'CIF' : 'FOB', profit_rate: deal.lowProfit ? rng.int(8, 11) : rng.int(16, 26),
        freight: rng.int(0, 2) * 1500, customs_fee: 200, valid_until: dateStr(simNow + 30 * DAY), items: deal.items,
        remark: c.cur === 'USD' ? '价格有效期30天，大货交期45-60天' : 'Prices valid for 30 days; lead time 45-60 days',
      });
      deal.quoteId = q.id;
      deal.quoteNo = q.quote_no;
      const split = await api(deal.u, 'POST', `/api/quotes/${q.id}/split`);
      for (const inq of split.rows) await api(deal.u, 'POST', `/api/inquiries/${inq.id}/email`, { account_id: ref.acct[deal.u], unit: rng.chance(0.3) ? 'inch' : 'cm' });
      if (rng.chance(0.4)) {
        const first = q.items[0];
        const s = sampleRow(first.sample_id);
        const sameType = Object.values(ref.sup).filter((x) => x.type === '成品生产工厂' && x.id !== s.supplier_id);
        const other = rng.pick(sameType);
        const ex = await api(deal.u, 'POST', '/api/inquiries', { quote_id: q.id, supplier_id: other.id, quote_item_ids: [first.id] });
        await api(deal.u, 'POST', `/api/inquiries/${ex.id}/email`, { account_id: ref.acct[deal.u] });
      }
      at(later(rng.int(2, 3), 14), () => factoryReplies(deal));
    };

    const factoryReplies = async (deal) => {
      const q = await quoteOf(deal.u, deal.quoteId);
      for (const inqRow of q.inquiries) {
        const inq = await api('purchase1', 'GET', `/api/inquiries/${inqRow.id}`);
        const items = inq.items.map((it) => {
          const s = sampleRow(it.sample_id);
          return { id: it.id, factory_price: Math.round((s.material_cost + s.labor_cost) * rng.float(0.9, 1.12) * 10) / 10, delivery_days: rng.int(30, 55), remark: rng.pick(['含税', '不含税', '含税，MOQ以下加收10%']) };
        });
        await api('purchase1', 'PUT', `/api/inquiries/${inq.id}/reply`, { reply_date: dateStr(), valid_until: dateStr(simNow + 45 * DAY), items });
        const sup = ref.sup[inq.supplier_code];
        await inbound(deal.u, { name: sup.contact, address: sup.email }, `回复：询价单 ${inq.inquiry_no}`, `您好，\n\n询价单 ${inq.inquiry_no} 报价如下：\n${items.map((x, i) => `${inq.items[i].item_no}：¥${x.factory_price}，交期${x.delivery_days}天（${x.remark}）`).join('\n')}\n\n${sup.name} ${sup.contact}`);
      }
      const cmp = await api(deal.u, 'GET', `/api/quotes/${deal.quoteId}/compare`);
      for (const row of cmp.rows) {
        if (row.offers.length > 1 || (row.offers[0] && rng.chance(0.5))) await api(deal.u, 'POST', `/api/quotes/${deal.quoteId}/apply-offer`, { quote_item_id: row.quote_item_id, inquiry_item_id: row.offers[0].inquiry_item_id });
      }
      at(later(1, 10), async () => { await api(deal.u, 'POST', `/api/quotes/${deal.quoteId}/submit`); at(later(1, 9), () => approve(deal)); });
    };

    const approve = async (deal) => {
      const ap = (await api('manager1', 'GET', '/api/approvals')).rows.find((a) => a.target_no === deal.quoteNo && a.status === '待审批');
      if (!ap) return;
      if (deal.lowProfit && !deal.rejected) {
        deal.rejected = true;
        await api('manager1', 'POST', `/api/approvals/${ap.id}/decide`, { pass: false, note: '利润率低于公司最低要求15%，请调整到18%以上再提交' });
        at(later(0.3), async () => {
          const q = await quoteOf(deal.u, deal.quoteId);
          await api(deal.u, 'PUT', `/api/quotes/${q.id}`, { ...q, profit_rate: 18, items: q.items });
          await api(deal.u, 'POST', `/api/quotes/${q.id}/submit`);
          at(later(1, 9), () => approve(deal));
        });
        return;
      }
      await api('manager1', 'POST', `/api/approvals/${ap.id}/decide`, { pass: true, note: rng.pick(['同意', '同意，注意交期', '可以，争取客户样品确认']) });
      at(later(0, 16), () => sendQuote(deal));
    };

    const sendQuote = async (deal) => {
      const q = await quoteOf(deal.u, deal.quoteId);
      if (q.status !== '已审批') return;
      await api(deal.u, 'POST', `/api/quotes/${q.id}/status`, { status: '已发客户' });
      await outbound(deal.u, `${deal.c.contact} <${deal.c.email}>`, `Quotation ${q.quote_no} - Yonlink Ceramics`,
        `Dear ${deal.c.contact.split(' ')[0]},\n\nPlease find our quotation ${q.quote_no}:\n${q.items.map((i) => `${i.item_no} ${i.description}: ${q.currency} ${i.price} x ${i.qty} pcs`).join('\n')}\nTerm: ${q.term}, valid until ${q.valid_until}.\n\nBest regards`, { quote_id: q.id });
      await follow(deal.u, deal.c.id, '跟进', `已发送报价 ${q.quote_no}，总额 ${q.amount} ${q.currency}`, 5);
      if (deal.samplePath) at(later(2, 10), () => sendSamples(deal));
      else if (deal.fate === 'won') at(later(rng.int(5, 12), 11), () => customerPO(deal));
      else if (deal.fate === 'lost') at(later(rng.int(18, 30), 15), () => loseDeal(deal));
      else at(later(rng.int(33, 40), 15), () => loseDeal(deal));
    };

    const loseDeal = async (deal) => {
      const q = await quoteOf(deal.u, deal.quoteId);
      if (['已成交', '已失效'].includes(q.status)) return;
      await api(deal.u, 'POST', `/api/quotes/${q.id}/status`, { status: '已失效' });
      await follow(deal.u, deal.c.id, '跟进', rng.pick(['客户反馈价格高于其他供应商约8%，本次未成交。', '客户项目推迟到明年，报价作废。', '客户最终选择了其他设计，保持联系。']), 30);
    };

    const sendSamples = async (deal) => {
      const q = await quoteOf(deal.u, deal.quoteId);
      const items = q.items.slice(0, 2).map((it) => {
        const s = sampleRow(it.sample_id);
        if (s.status === '已锁定') return null;
        return { sample_id: it.sample_id, qty: 2, new_item_no: it.new_item_no || null, revise_req: it.revise_req || null };
      }).filter(Boolean);
      if (!items.length) { at(later(3, 11), () => customerPO(deal)); return; }
      const send = await api(deal.u, 'POST', '/api/sample-sends', { customer_id: deal.c.id, quote_id: q.id, cost: rng.int(180, 650), items, remark: '样品单独打木架' });
      deal.sendId = send.id;
      const hasNew = send.items.some((i) => i.new_item_no);
      const dispatch = async () => {
        const tracking = String(rng.int(1000000000, 9999999999));
        await api(deal.u, 'POST', `/api/sample-sends/${send.id}/status`, { status: '已寄出', express_co: rng.pick(['DHL', 'FedEx', 'UPS']), tracking_no: tracking });
        await outbound(deal.u, deal.c.email, `Samples dispatched for ${q.quote_no} - tracking ${tracking}`, `Dear ${deal.c.contact.split(' ')[0]},\n\nSamples have been dispatched today, tracking no. ${tracking}.\n\nBest regards`, { quote_id: q.id });
        at(later(rng.int(5, 8), 10), feedback);
      };
      const feedback = async () => {
        const ok = deal.fate === 'won';
        await inbound(deal.u, { name: deal.c.contact, address: deal.c.email }, `RE: Samples for ${q.quote_no}`, ok ? 'Samples received in good condition, quality approved. PO will follow.' : 'Samples received, unfortunately the glaze colour does not match our range.');
        await api(deal.u, 'POST', `/api/sample-sends/${send.id}/status`, { status: ok ? '客户确认' : '客户拒绝', customer_feedback: ok ? '样品质量认可，准备下单' : '釉色与系列不符' });
        if (ok) at(later(rng.int(3, 6), 11), () => customerPO(deal));
        else at(later(4, 15), () => loseDeal(deal));
      };
      if (hasNew) {
        const verify = async (round) => {
          const s = await api(deal.u, 'GET', `/api/sample-sends/${send.id}`);
          for (const it of s.items.filter((x) => x.new_item_no && !x.new_sample_id)) {
            const fail = round === 1 && rng.chance(0.35);
            await api(deal.u, 'POST', `/api/send-items/${it.id}/verify`, fail ? { pass: false, note: rng.pick(['釉色偏深，与客户色卡不符', '浮雕线条不够清晰，需修模', '高度超差2mm']) } : { pass: true, note: '与客户改样要求一致' });
            if (!fail) {
              const conv = await api('manager1', 'POST', `/api/send-items/${it.id}/convert`, {});
              const ns = sampleRow(conv.id);
              await api('admin', 'POST', `/api/samples/${ns.id}/images`, { name: `${ns.company_no}-正面.png`, data: renderSamplePng({ ...ns, color: ns.color + rng.pick(['', '星空', '粉']) }).toString('base64') });
            } else {
              at(later(3, 10), () => verify(2));
              return;
            }
          }
          at(later(1, 10), dispatch);
        };
        at(later(4, 10), () => verify(1));
      } else {
        at(later(1, 10), dispatch);
      }
    };

    const customerPO = async (deal) => {
      const q0 = await quoteOf(deal.u, deal.quoteId);
      if (!['已审批', '已发客户'].includes(q0.status)) return;
      const poNo = `PO-${deal.c.code}-${rng.int(1000, 9999)}`;
      await inbound(deal.u, { name: deal.c.contact, address: deal.c.email }, `Purchase Order ${poNo} for ${q0.quote_no}`, `Please find attached our purchase order ${poNo} based on quotation ${q0.quote_no}. Kindly confirm the delivery date.`);
      let r = await api(deal.u, 'POST', `/api/quotes/${deal.quoteId}/to-order`, null, { allow: [409] });
      if (r.__error) {
        await swapLocked(deal);
        r = await api(deal.u, 'POST', `/api/quotes/${deal.quoteId}/to-order`);
      }
      const o = await api(deal.u, 'GET', `/api/orders/${r.id}`);
      const delivery = dateStr(simNow + rng.int(45, 60) * DAY);
      await api(deal.u, 'PUT', `/api/orders/${o.id}`, { ...o, delivery_date: delivery, package_req: '彩盒+五层外箱，外箱双唛', remark: `客户PO：${poNo}`, items: o.items });
      await outbound(deal.u, deal.c.email, `Order confirmation ${o.order_no} / your ${poNo}`, `Dear ${deal.c.contact.split(' ')[0]},\n\nThank you for your order ${poNo}. Our sales confirmation is ${o.order_no}, ETD ${delivery}.\nDeposit 30% please.\n\nBest regards`, { order_id: o.id });
      await follow(deal.u, deal.c.id, '跟进', `客户下单 ${poNo}，生成订单 ${o.order_no}`, 10);
      runOrder({ id: o.id, u: deal.u, c: deal.c });
    };

    /** 订单全流程 / full order lifecycle */
    const riskOrders = new Set();
    const delayedOrders = new Set();
    let orderCount = 0;
    const runOrder = (ord) => {
      orderCount++;
      ord.risk = orderCount % 5 === 3;
      ord.delayed = orderCount % 7 === 4;
      if (ord.risk) riskOrders.add(ord.id);
      if (ord.delayed) delayedOrders.add(ord.id);
      ord.speed = ord.delayed ? 1.6 : rng.float(0.9, 1.2);
      at(later(2, 10), () => deposit(ord));
      at(later(2, 14), () => purchaseMaterials(ord));
      at(later(3, 9), () => startProduction(ord));
    };

    const deposit = async (ord) => {
      const rv = await api('finance1', 'GET', `/api/receivables/${ord.id}`);
      const amt = Math.round(rv.amount * 0.3 * 100) / 100;
      if (amt > 0) await api('finance1', 'POST', '/api/receipts', { order_id: ord.id, type: '预收', amount: amt, voucher: 'TT' + rng.int(100000, 999999), remark: '30%定金' });
      await inbound(ord.u, { name: ord.c.contact, address: ord.c.email }, `Deposit payment ${rv.order_no}`, `We have remitted the 30% deposit (${rv.currency} ${amt}) for order ${rv.order_no}. Please check.`);
    };

    const purchaseMaterials = async (ord) => {
      const o = await api(ord.u, 'GET', `/api/orders/${ord.id}`);
      const qty = o.items.reduce((s, i) => s + i.qty, 0);
      const cartons = o.items.reduce((s, i) => s + Math.ceil(i.qty / (sampleRow(i.sample_id).pcs_per_carton || 1)), 0);
      const zisha = o.items.some((i) => /紫砂/.test(sampleRow(i.sample_id).material));
      const plans = [
        [ref.sup.S009.id, [[zisha ? 'M-CL-02' : 'M-CL-01', Math.ceil(qty * 0.6), zisha ? 12 : 3.5]]],
        [ref.sup.S010.id, [['M-GL-01', Math.ceil(qty * 0.06), 18.5], ['M-GL-04', Math.ceil(qty * 0.02), 26]]],
        [ref.sup.S011.id, [['P-BOX-01', qty, rng.pick([2.2, 2.3, 2.4])], ['P-INS-01', qty, 0.6]]],
        [ref.sup.S004.id, [['P-CTN-01', cartons, 6.5], ['P-LBL-01', qty + cartons, 0.08]]],
      ];
      ord.pos = [];
      ord.needs = {};
      for (const [sid, lines] of plans) {
        const items = lines.map(([code, q, price]) => { ord.needs[code] = q; return { inventory_id: ref.inv[code].id, qty: q, price }; });
        const po = await api('purchase1', 'POST', '/api/purchases', { supplier_id: sid, type: '原辅材料', order_id: ord.id, due_date: dateStr(simNow + 6 * DAY), items, remark: `订单${o.order_no}专用` });
        ord.pos.push(po.id);
      }
      const lamp = o.items.find((i) => /LED|Lamp/i.test(i.description || ''));
      if (lamp || rng.chance(0.25)) {
        const acc = lamp ? ['A-LED-01', lamp.qty, 3.8] : ['A-MTL-01', Math.ceil(qty / 10), 5.5];
        ord.needs[acc[0]] = acc[1];
        const po = await api('purchase1', 'POST', '/api/purchases', {
          supplier_id: ref.sup.S012.id, type: '外购成品', order_id: ord.id, due_date: dateStr(simNow + 5 * DAY),
          items: [{ inventory_id: ref.inv[acc[0]].id, qty: acc[1], price: acc[2] }],
        });
        ord.outsourced = po.id;
        ord.pos.push(po.id);
      }
      at(later(5, 10), () => receivePurchases(ord));
    };

    const receivePurchases = async (ord) => {
      for (const id of ord.pos) {
        const p = await api('purchase1', 'GET', `/api/purchases/${id}`);
        if (p.type === '外购成品') {
          if (rng.chance(0.2) && !ord.qcFailed) {
            ord.qcFailed = true;
            await api('purchase1', 'POST', `/api/purchases/${id}/qc`, { qc_status: '不合格', note: '抽检5%有电镀脱落，退回返工' });
            at(later(3, 10), () => receivePurchases(ord));
            continue;
          }
          await api('purchase1', 'POST', `/api/purchases/${id}/qc`, { qc_status: '合格', note: 'AQL2.5抽检合格' });
        }
        if (p.status !== '已入库') await api('purchase1', 'POST', `/api/purchases/${id}/receive`, { items: p.items.map((i) => ({ id: i.id, qty: i.qty - i.received_qty })) });
      }
      if (!ord.issueScheduled) { ord.issueScheduled = true; at(later(1, 9), () => issueMaterials(ord)); }
      if (!ord.payScheduled) { ord.payScheduled = true; at(later(3, 10), () => payPurchases(ord)); }
      if (ord.risk && !ord.riskScheduled) { ord.riskScheduled = true; at(later(rng.int(3, 4), 11), () => riskChange(ord)); }
    };

    const issueMaterials = async (ord) => {
      const prods = (await api('prod1', 'GET', `/api/productions?order_id=${ord.id}`)).rows;
      for (const [code, q] of Object.entries(ord.needs)) {
        const stock = db.prepare('SELECT qty FROM inventory WHERE code=?').get(code).qty;
        const n = Math.min(q, Math.floor(stock));
        if (n > 0) await api('prod1', 'POST', '/api/material-issues', { inventory_id: ref.inv[code].id, order_id: ord.id, production_id: prods[0] ? prods[0].id : null, qty: n });
      }
    };

    const payPurchases = async (ord) => {
      for (const id of ord.pos) {
        const p = await api('purchase1', 'GET', `/api/purchases/${id}`);
        const committed = p.payments.filter((x) => x.status !== '已驳回').reduce((s, x) => s + x.amount, 0);
        const left = Math.round((p.amount - committed) * 100) / 100;
        if (left > 0) await api('purchase1', 'POST', `/api/purchases/${id}/payments`, { amount: left, voucher: 'FK' + rng.int(10000, 99999), remark: p.settlement || '' });
      }
      at(later(1, 15), () => financeApprovals(ord));
    };

    const financeApprovals = async (ord) => {
      const pos = ord.pos.map((id) => db.prepare('SELECT po_no FROM purchases WHERE id=?').get(id).po_no);
      const pend = (await api('finance1', 'GET', '/api/approvals')).rows.filter((a) => a.target_type === 'payment' && a.status === '待审批' && pos.includes(a.target_no));
      let rejected = false;
      for (const a of pend) {
        if (!ord.payRejected && rng.chance(0.1)) {
          ord.payRejected = true;
          rejected = true;
          await api('finance1', 'POST', `/api/approvals/${a.id}/decide`, { pass: false, note: '发票未到，暂缓付款' });
        } else {
          await api('finance1', 'POST', `/api/approvals/${a.id}/decide`, { pass: true, note: '同意付款' });
        }
      }
      if (rejected) at(later(2, 10), () => payPurchases(ord));
      else at(later(rng.int(2, 6), 10), () => purchaseInvoices(ord));
    };

    const purchaseInvoices = async (ord) => {
      for (const id of ord.pos) {
        if (!rng.chance(0.85)) continue;
        const p = await api('purchase1', 'GET', `/api/purchases/${id}`);
        const left = Math.round((p.amount - p.invoiced) * 100) / 100;
        if (left <= 0) continue;
        const inv = await api('purchase1', 'POST', '/api/purchase-invoices', { po_id: id, invoice_no: 'JX' + rng.int(10000000, 99999999), amount: left });
        if (rng.chance(0.75)) at(later(rng.int(1, 5), 14), () => api('finance1', 'POST', `/api/purchase-invoices/${inv.id}/verify`));
      }
    };

    const riskChange = async (ord, onlyDepts) => {
      ord.changed = true;
      const o = await api(ord.u, 'GET', `/api/orders/${ord.id}`);
      if (o.risk_lock || ['已出货', '已完成'].includes(o.status)) return;
      const it = o.items[0];
      const pcs = sampleRow(it.sample_id).pcs_per_carton || 1;
      const newQty = Math.ceil((it.qty * 1.15) / pcs) * pcs;
      await inbound(ord.u, { name: ord.c.contact, address: ord.c.email }, `Change request for ${o.order_no}`, `Due to strong sell-through, please increase ${it.item_no} from ${it.qty} to ${newQty} pcs and postpone ETD by 10 days if needed.`);
      const items = o.items.map((x) => (x.id === it.id ? { ...x, qty: newQty } : { ...x }));
      const body = { ...o, items, delivery_date: dateStr(new RealDate(o.delivery_date).getTime() + 10 * DAY) };
      const first = await api(ord.u, 'PUT', `/api/orders/${o.id}`, body, { allow: [409] });
      if (!first.__error) return;
      await api(ord.u, 'PUT', `/api/orders/${o.id}`, { ...body, confirm_risk: true, change_reason: `客户邮件要求追加 ${it.item_no} 至 ${newQty} 只，交期顺延10天` });
      ord.changedItem = it.id;
      ord.newQty = newQty;
      const handle = async (dept, user) => {
        const t = (await api(user, 'GET', '/api/change-tasks?status=' + encodeURIComponent('待处理'))).rows.find((x) => x.order_id === ord.id && x.dept === dept);
        if (!t) return;
        if (dept === '生产') {
          for (const p of (await api('prod1', 'GET', `/api/productions?order_id=${ord.id}`)).rows.filter((x) => x.order_item_id === ord.changedItem)) {
            await api('prod1', 'PUT', `/api/productions/${p.id}`, { plan_qty: ord.newQty, due_date: p.due_date, remark: '客户追加数量，计划已调整' });
          }
        }
        const notes = { 采购: '追加部分包材从现有库存调拨，原料余量充足，无需追加采购', 生产: '布产计划已按新数量调整，加开一窑', 财务: '已更新应收金额与成本预估，定金差额已通知业务', 业务: '客户邮件确认已归档，交期顺延10天' };
        await api(user, 'POST', `/api/change-tasks/${t.id}/handle`, { note: notes[dept] });
      };
      const plan = [['采购', 'purchase1', 1, 10], ['生产', 'prod1', 1, 15], ['财务', 'finance1', 2, 10], ['业务', ord.u, 2, 16]];
      for (const [dept, user, dd, hh] of plan) {
        if (onlyDepts && !onlyDepts.includes(dept)) continue;
        if (onlyDepts) await handle(dept, user); else at(later(dd, hh), () => handle(dept, user));
      }
    };

    const startProduction = async (ord) => {
      const o = await api(ord.u, 'GET', `/api/orders/${ord.id}`);
      const due = ord.delayed ? dateStr(simNow + 20 * DAY) : dateStr(new RealDate(o.delivery_date).getTime() - 7 * DAY);
      await api('prod1', 'POST', `/api/orders/${ord.id}/produce`, { due_date: due });
      PROCESSES.forEach((proc, pi) => {
        for (const k of [1, 2]) at(later((1 + pi * 5 + (k - 1) * 3) * ord.speed, 17), () => report(ord, proc, k));
      });
      at(later(30 * ord.speed + 2, 10), () => tryShip(ord, 0));
    };

    const report = async (ord, proc, k) => {
      for (const p of (await api('prod1', 'GET', `/api/productions?order_id=${ord.id}`)).rows) {
        if (p.status === '已完工') continue;
        const pi = PROCESSES.indexOf(proc);
        const prevGood = pi === 0 ? p.plan_qty : (p.process[PROCESSES[pi - 1]].good || 0);
        const target = Math.min(prevGood, k === 2 ? p.plan_qty : Math.round(p.plan_qty / 2));
        const good = target - (p.process[proc].good || 0);
        if (good <= 0) continue;
        const bad = proc === '烧制' ? Math.round(good * rng.float(0.01, 0.05)) : Math.round(good * rng.float(0, 0.015));
        await api('prod1', 'POST', `/api/productions/${p.id}/reports`, { process: proc, good_qty: good, bad_qty: bad, worker: rng.pick(C.WORKERS), remark: bad > 0 ? rng.pick(['少量开裂', '釉面针孔', '变形']) : '' });
      }
    };

    const tryShip = async (ord, attempt) => {
      const o = await api(ord.u, 'GET', `/api/orders/${ord.id}`);
      const prods = (await api('prod1', 'GET', `/api/productions?order_id=${ord.id}`)).rows;
      if (o.risk_lock || prods.some((p) => p.status !== '已完工')) {
        if (prods.some((p) => p.status !== '已完工')) {
          for (const proc of PROCESSES) await report(ord, proc, 2);
        }
        if (attempt < 8) at(later(3, 10), () => tryShip(ord, attempt + 1));
        return;
      }
      const remaining = o.items.map((i) => ({ order_item_id: i.id, qty: i.qty - i.shipped_qty })).filter((x) => x.qty > 0);
      if (!remaining.length) return;
      const total = remaining.reduce((s, x) => s + x.qty, 0);
      const split = total > 1500 && !ord.splitDone;
      const items = split ? remaining.map((x) => ({ ...x, qty: Math.floor(x.qty * 0.6) })).filter((x) => x.qty > 0) : remaining;
      ord.splitDone = ord.splitDone || split;
      const sh = await api(ord.u, 'POST', `/api/orders/${ord.id}/shipments`, {
        ship_date: dateStr(simNow + 5 * DAY), port: '厦门', dest_port: ord.c.port, vessel: rng.pick(C.VESSELS), forwarder_id: rng.pick(ref.fwd),
        container_no: `${rng.pick(['TGHU', 'MSKU', 'CSNU', 'OOLU'])}${rng.int(1000000, 9999999)}`, items, remark: split ? '分批出货第一批' : '',
      });
      await api('admin', 'POST', '/api/e/agency_record', { agency_id: rng.pick(ref.fwd), content: `订舱 ${o.order_no} / ${sh.ship_no}，目的港 ${ord.c.port}` });
      at(later(1, 10), async () => {
        if (rng.chance(0.12)) {
          await api(ord.u, 'PUT', `/api/shipments/${sh.id}`, { inspection_status: '不合格', inspection_note: rng.pick(['外箱唛头印刷错误，已重新贴唛', '抽检发现3只釉面针孔，已挑出补货']) });
          at(later(2, 10), async () => { await api(ord.u, 'PUT', `/api/shipments/${sh.id}`, { inspection_status: '合格', inspection_note: '复验合格' }); at(later(1, 10), () => customs(ord, sh)); });
        } else {
          await api(ord.u, 'PUT', `/api/shipments/${sh.id}`, { inspection_status: '合格', inspection_note: '第三方验货合格 AQL2.5' });
          at(later(2, 10), () => customs(ord, sh));
        }
      });
      if (split) at(later(8, 10), () => tryShip(ord, 0));
    };

    const customs = async (ord, sh) => {
      const cno = `5301${rng.int(10000000, 99999999)}${rng.int(100000, 999999)}`;
      await api(ord.u, 'PUT', `/api/shipments/${sh.id}`, { status: '已报关', customs_no: cno });
      at(later(2, 15), async () => {
        await api(ord.u, 'PUT', `/api/shipments/${sh.id}`, { status: '已出运', ship_date: dateStr() });
        const o = await api(ord.u, 'GET', `/api/orders/${ord.id}`);
        await outbound(ord.u, ord.c.email, `Shipment advice ${o.order_no} - ${sh.ship_no}`, `Dear ${ord.c.contact.split(' ')[0]},\n\nGoods for ${o.order_no} have been shipped today to ${ord.c.port}.\nPlease arrange the balance payment against B/L copy.\n\nBest regards`, { order_id: o.id });
        if (o.status === '已出货' && !ord.closing) {
          ord.closing = true;
          at(later(rng.chance(0.85) ? rng.int(4, 20) : rng.int(36, 55), 10), () => salesInvoice(ord));
          const r = rng.next();
          if (r < 0.85) at(later(rng.int(10, 35), 11), () => balance(ord, 1));
          else if (r < 0.95) at(later(rng.int(10, 30), 11), () => balance(ord, 0.5));
        }
      });
    };

    const salesInvoice = async (ord) => {
      const rv = await api('finance1', 'GET', `/api/receivables/${ord.id}`);
      if (rv.uninvoiced > 0) await api('finance1', 'POST', '/api/sales-invoices', { order_id: ord.id, invoice_no: 'XS' + rng.int(10000000, 99999999), amount: rv.uninvoiced, remark: '出口发票' });
    };

    const balance = async (ord, part) => {
      const rv = await api('finance1', 'GET', `/api/receivables/${ord.id}`);
      const amt = Math.round(rv.unreceived * part * 100) / 100;
      if (amt <= 0) return;
      await inbound(ord.u, { name: ord.c.contact, address: ord.c.email }, `Balance payment ${rv.order_no}`, `Balance ${rv.currency} ${amt} has been remitted for ${rv.order_no}.`);
      await api('finance1', 'POST', '/api/receipts', { order_id: ord.id, type: part < 1 ? '分期' : '尾款', amount: amt, voucher: 'TT' + rng.int(100000, 999999) });
      if (part >= 1) at(later(1, 10), async () => {
        const o = await api(ord.u, 'GET', `/api/orders/${ord.id}`);
        if (o.status === '已出货') await api(ord.u, 'POST', `/api/orders/${ord.id}/status`, { status: '已完成' });
      });
    };

    /** 老客户返单（不经报价）/ repeat orders without a quote */
    const repeatOrder = async (custCode, run = true) => {
      const c = custOf(custCode);
      const last = db.prepare(`SELECT oi.sample_id, oi.unit_price, oi.qty FROM order_items oi JOIN orders o ON o.id=oi.order_id JOIN samples s ON s.id=oi.sample_id
        WHERE o.customer_id=? AND s.status='正常' ORDER BY oi.id DESC LIMIT 2`).all(c.id);
      if (!last.length) return;
      await inbound(c.sales, { name: c.contact, address: c.email }, 'Repeat order', `Please repeat our last order: ${last.map((l) => `${sampleRow(l.sample_id).company_no} x ${l.qty}`).join(', ')}.`);
      const o = await api(c.sales, 'POST', '/api/orders', { customer_id: c.id, currency: c.cur, term: 'FOB', delivery_date: dateStr(simNow + 50 * DAY), package_req: '同上批', remark: '老客户返单', items: last.map((l) => ({ sample_id: l.sample_id, qty: l.qty, unit_price: l.unit_price })) });
      await outbound(c.sales, c.email, `Order confirmation ${o.order_no} (repeat)`, 'Thank you for your repeat order.', { order_id: o.id });
      if (run) runOrder({ id: o.id, u: c.sales, c });
    };

    /** 期末场景：保证各种在途状态都有数据 / end-of-period scenarios so every in-flight status is represented */
    const closing = async () => {
      const mk = async (u, code, profit) => {
        const c = custOf(code);
        const picks = rng.sample(usableSamples(), 2);
        return api(u, 'POST', '/api/quotes', { customer_id: c.id, currency: c.cur, term: 'FOB', profit_rate: profit, valid_until: dateStr(simNow + 30 * DAY), items: picks.map((x) => ({ sample_id: x.id, qty: x.moq })) });
      };
      const q1 = await mk('sales1', 'C005', 20);
      await api('sales1', 'POST', `/api/quotes/${q1.id}/submit`);
      const q2 = await mk('sales2', 'C012', 9);
      await api('sales2', 'POST', `/api/quotes/${q2.id}/submit`);
      const ap2 = (await api('manager1', 'GET', '/api/approvals')).rows.find((a) => a.target_no === q2.quote_no && a.status === '待审批');
      await api('manager1', 'POST', `/api/approvals/${ap2.id}/decide`, { pass: false, note: '利润率9%低于公司下限15%，请重新核算' });
      const q3 = await mk('sales3', 'C017', 22);
      await api('sales3', 'POST', `/api/quotes/${q3.id}/submit`);
      await approvePending(q3.quote_no);
      await mk('sales2', 'C013', 18);
      // 生产中的订单发生客户变更，仅采购已处理 → 订单保持风控锁定 / a risk change left partly handled → order stays locked
      const cand = db.prepare(`SELECT o.id, o.customer_id FROM orders o WHERE o.status='生产中' AND o.risk_lock=0
        AND EXISTS (SELECT 1 FROM purchases p JOIN purchase_items i ON i.po_id=p.id WHERE p.order_id=o.id AND i.received_qty>0) ORDER BY o.id DESC LIMIT 1`).get();
      if (cand) {
        const c = Object.values(ref.cust).find((x) => x.id === cand.customer_id);
        await riskChange({ id: cand.id, u: c.sales, c }, ['采购']);
      }
      // 送样在途 / samples in transit
      const sp = rng.sample(usableSamples(), 2);
      const ss1 = await api('sales1', 'POST', '/api/sample-sends', { customer_id: custOf('C006').id, cost: 320, items: [{ sample_id: sp[0].id, qty: 2 }] });
      await api('sales1', 'POST', `/api/sample-sends/${ss1.id}/status`, { status: '已寄出', express_co: 'DHL', tracking_no: String(rng.int(1000000000, 9999999999)) });
      await api('sales3', 'POST', '/api/sample-sends', { customer_id: custOf('C016').id, cost: 280, items: [{ sample_id: sp[1].id, qty: 3, new_item_no: newItemNo(sp[1].company_no), revise_req: '客户要求改为哑光黑釉，底部加客户LOGO' }] });
      // 新返单待确认、付款申请待审批 / new repeat order awaiting confirmation, payment awaiting approval
      await repeatOrder('C002', false);
      const po = db.prepare(`SELECT p.id FROM purchases p WHERE NOT EXISTS (SELECT 1 FROM payments m WHERE m.po_id=p.id) ORDER BY p.id DESC LIMIT 1`).get();
      if (po) await api('purchase1', 'POST', `/api/purchases/${po.id}/payments`, { amount: (await api('purchase1', 'GET', `/api/purchases/${po.id}`)).amount, voucher: 'FK' + rng.int(10000, 99999) });
    };
    at(day(days - 1, 14), closing);

    // 排期：约每 4 天一个新询盘；A 级客户偶尔返单 / schedule deals and repeat orders
    let d = 2;
    let ci = 0;
    while (d < days - 1) {
      const code = custCodes[ci++ % custCodes.length];
      at(day(d, 10), () => startDeal(code));
      d += rng.int(3, 5);
    }
    for (const rd of [70, 95, 118, 140, 160]) at(day(rd, 11), () => repeatOrder(rng.pick(['C001', 'C002', 'C004', 'C006', 'C009', 'C016'])));

    // ---------- 运行 / run ----------
    while (queue.length) {
      let bi = 0;
      for (let i = 1; i < queue.length; i++) if (queue[i].t < queue[bi].t || (queue[i].t === queue[bi].t && queue[i].s < queue[bi].s)) bi = i;
      const ev = queue.splice(bi, 1)[0];
      if (ev.t > endTime) continue;
      simNow = Math.max(simNow, ev.t);
      await ev.fn();
      stamp();
    }

    // ---------- 收尾 / finish ----------
    simNow = endTime;
    stamp();
    db.prepare('DELETE FROM sessions').run();
    db.prepare("UPDATE mail_accounts SET smtp_port=2525, imap_port=2143, auto_fetch=0, last_uid=0, uidvalidity=NULL, last_error=NULL, last_fetch_at=NULL").run();
    db.prepare("UPDATE settings SET value='0' WHERE key='rate_auto_hours'").run();
    const tables = ['employees', 'users', 'customers', 'customer_follows', 'suppliers', 'supplier_prices', 'agencies', 'agency_records', 'samples', 'sample_revisions', 'files', 'mails',
      'currencies', 'rate_history', 'quotes', 'quote_items', 'inquiries', 'sample_sends', 'orders', 'order_changes', 'change_tasks', 'shipments', 'purchases', 'payments',
      'purchase_invoices', 'receipts', 'sales_invoices', 'productions', 'production_reports', 'material_issues', 'inventory', 'approvals', 'logs'];
    const stats = Object.fromEntries(tables.map((t) => [t, db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c]));
    stats.risk_orders = riskOrders.size;
    stats.delayed_orders = delayedOrders.size;
    log(`模拟完成：${fmt(startTime).slice(0, 10)} ~ ${fmt(endTime).slice(0, 10)}，接口调用 ${calls} 次`);
    if (dbFile !== ':memory:') {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE; VACUUM;');
    }
    return { stats, start: fmt(startTime), end: fmt(endTime), calls, app };
  } finally {
    globalThis.Date = RealDate;
    await mock.close();
  }
}

module.exports = { seedDemo };

if (require.main === module) {
  const args = process.argv.slice(2);
  const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  const out = path.resolve(arg('--out', path.join(__dirname, '..', 'data', 'erp.db')));
  if (fs.existsSync(out) && !args.includes('--no-backup')) {
    // 用 SQLite 自身导出完整副本（含 WAL 中未合并的数据）/ export a complete copy via SQLite (includes un-checkpointed WAL data)
    const bak = `${out}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const { DatabaseSync } = require('node:sqlite');
    const src = new DatabaseSync(out);
    src.exec(`VACUUM INTO '${bak.replace(/'/g, "''")}'`);
    src.close();
    console.log('原数据库已完整备份 / backed up:', bak, '（请先停止正在运行的服务器 / stop the running server first）');
  }
  for (const f of [out, out + '-wal', out + '-shm']) if (fs.existsSync(f)) fs.rmSync(f);
  const t0 = Date.now();
  seedDemo({ dbFile: out, days: Number(arg('--days', 180)), log: console.log }).then((r) => {
    r.app.db.close();
    console.log(JSON.stringify(r.stats));
    console.log(`已生成模拟数据 / done: ${out}（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
    process.exit(0);
  }).catch((e) => { console.error(e); process.exit(1); });
}
