'use strict';
/**
 * 集成功能模拟测试：企业邮箱收发（模拟 SMTP/IMAP，含 SSL/STARTTLS）、汇率自动更新（模拟接口）、样品图片上传
 * Integration simulation tests: mailbox send/receive against mock SMTP/IMAP (incl. SSL/STARTTLS),
 * automatic rates against a mock API, sample image upload.
 * 使用用户提供的邮箱 ai001/ai002/ai003@316191099.xyz 作为模拟邮箱 / uses the user's three addresses as mock mailboxes.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const { startServer } = require('./helpers');
const { startMockMail, USERS } = require('./mock-mail-server');
const { updateRates } = require('../server/rates');
const { runDueJobs } = require('../server/scheduler');
const { parseMessage } = require('../server/mail');

const A1 = 'ai001@316191099.xyz';
const A2 = 'ai002@316191099.xyz';
const A3 = 'ai003@316191099.xyz';

let srv;
let mock;
let rateSrv;
let rateBody;
let admin;
let sales1;
let sales2;
let designer1;
let designer2;
const S = {};

/** 账户参数（指向模拟服务器）/ Account settings pointing at the mock server */
const acct = (email, extra = {}) => ({
  email, display_name: email.split('@')[0].toUpperCase(), smtp_host: '127.0.0.1', smtp_port: mock.ports.smtp, smtp_secure: 'none',
  imap_host: '127.0.0.1', imap_port: mock.ports.imap, imap_secure: 'none', username: email, password: USERS[email], ...extra,
});

/** 从 xlsx 中取出工作表 XML / Extract sheet XML from an xlsx buffer */
function sheetXml(buf) {
  let off = 0;
  while (buf.readUInt32LE(off) === 0x04034b50) {
    const csize = buf.readUInt32LE(off + 18);
    const nlen = buf.readUInt16LE(off + 26);
    const name = buf.subarray(off + 30, off + 30 + nlen).toString();
    const data = buf.subarray(off + 30 + nlen, off + 30 + nlen + csize);
    if (name === 'xl/worksheets/sheet1.xml') return zlib.inflateRawSync(data).toString();
    off += 30 + nlen + csize;
  }
  return '';
}

test.before(async () => {
  srv = await startServer();
  mock = await startMockMail();
  rateSrv = http.createServer((req, res) => {
    if (req.url.startsWith('/fail')) { res.writeHead(500); res.end('down'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(rateBody));
  });
  await new Promise((r) => rateSrv.listen(0, '127.0.0.1', r));
  S.rateUrl = `http://127.0.0.1:${rateSrv.address().port}/latest`;
  [admin, sales1, sales2, designer1, designer2] = await Promise.all(['admin', 'sales1', 'sales2', 'designer1', 'designer2'].map((u) => srv.login(u)));
  // 模拟邮件服务器在本机，需开启“允许内网邮件服务器” / mock mail server runs locally, so allow private hosts
  await admin.put('/api/settings', { mail_allow_private_hosts: '1' });
});
test.after(async () => {
  await srv.close();
  await mock.close();
  rateSrv.close();
});

// ===================== 企业邮箱 / mail =====================
test('TC-ML-01 邮箱自动识别：316191099.xyz 识别为 Cloudflare 邮件转发并给出配置指引', async (t) => {
  const r = await admin.get('/api/mail-presets?email=' + encodeURIComponent(A1));
  assert.equal(r.status, 200);
  assert.ok(Object.keys(r.data.presets).includes('腾讯企业邮'));
  if (!r.data.mx.length) { t.skip('当前环境无法进行 DNS 查询'); return; }
  assert.ok(r.data.mx.every((m) => m.includes('mx.cloudflare.net')));
  assert.match(r.data.note, /Cloudflare 邮件路由/);
  assert.equal(r.data.suggestion, null);
});

test('TC-ML-02 新增邮箱账户：密码加密存储且不回传；格式/重复校验；账户归属隔离', async () => {
  const a1 = await sales1.post('/api/mail-accounts', acct(A1));
  assert.equal(a1.status, 200, JSON.stringify(a1.data));
  assert.equal(a1.data.has_password, true);
  assert.equal(a1.data.password_enc, undefined, '接口不返回密码密文');
  assert.equal(a1.data.password, undefined);
  S.acc1 = a1.data.id;
  S.acc2 = (await sales2.post('/api/mail-accounts', acct(A2))).data.id;
  S.acc3 = (await admin.post('/api/mail-accounts', acct(A3))).data.id;
  const enc = srv.app.db.prepare('SELECT password_enc FROM mail_accounts WHERE id=?').get(S.acc1).password_enc;
  assert.match(enc, /^v1:/);
  assert.ok(!enc.includes(USERS[A1]), '数据库中不出现明文密码');
  assert.equal((await sales1.post('/api/mail-accounts', acct('not-an-email'))).status, 400);
  assert.equal((await sales1.post('/api/mail-accounts', acct(A1))).status, 409);
  assert.equal((await sales1.post('/api/mail-accounts', { ...acct('x@316191099.xyz'), password: '' })).status, 400, '新增必须填写密码');
  const list2 = (await sales2.get('/api/mail-accounts')).data.rows;
  assert.deepEqual(list2.map((x) => x.email), [A2], '业务员只看到本人邮箱');
  assert.equal((await admin.get('/api/mail-accounts')).data.rows.length, 3, '管理员看到全部');
  assert.equal((await sales2.post(`/api/mail-accounts/${S.acc1}/test`)).status, 403, '不能使用他人邮箱');
  assert.equal((await designer1.get('/api/mail-accounts')).status, 403, '设计师无邮件模块权限');
});

test('TC-ML-03 测试连接：正确密码成功；错误密码给出中文原因', async () => {
  const ok = (await sales1.post(`/api/mail-accounts/${S.acc1}/test`)).data;
  assert.equal(ok.smtp.ok, true, ok.smtp.message);
  assert.equal(ok.imap.ok, true, ok.imap.message);
  const bad = await admin.post('/api/mail-accounts', acct('ai009@316191099.xyz', { password: 'wrong' }));
  const r = (await admin.post(`/api/mail-accounts/${bad.data.id}/test`)).data;
  assert.equal(r.smtp.ok, false);
  assert.match(r.smtp.message, /535.*授权码/);
  assert.equal(r.imap.ok, false);
  assert.match(r.imap.message, /IMAP 登录失败/);
  await admin.del('/api/mail-accounts/' + bad.data.id);
});

test('TC-ML-04 发送邮件：ai001 → ai002 抄送 ai003 与客户，中文主题；自动绑定客户/报价/样品', async () => {
  const q = await sales1.post('/api/quotes', { customer_id: 1, currency: 'USD', term: 'FOB', items: [{ sample_id: 1, qty: 300 }] });
  S.quote = q.data;
  const r = await sales1.post('/api/mails/send', {
    account_id: S.acc1, to: `王芳 <${A2}>, Hans Müller <hans@homedecor.de>`, cc: A3,
    subject: `报价单 ${S.quote.quote_no} — 浮雕牡丹花瓶 YL-V001 最新报价`, body: '您好：\n附上最新报价，单价含 FOB 厦门。\n谢谢！\n林晓明',
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.status, '已发送');
  assert.match(r.data.message_id, /^<[0-9a-f]+@316191099\.xyz>$/);
  assert.equal(r.data.customer_id, 1, '按收件人 hans@homedecor.de 绑定客户');
  assert.equal(r.data.quote_id, S.quote.id, '按主题中的报价单号绑定');
  assert.equal(r.data.sample_id, 1, '按货号绑定样品');
  assert.equal(r.data.category, '报价');
  S.sent = r.data.id;
  assert.equal(mock.store.boxes.get(A2).length, 1);
  assert.equal(mock.store.boxes.get(A3).length, 1, '抄送送达');
  assert.equal(mock.store.outbound.length, 1, '外部客户地址已投递');
  assert.equal(mock.store.outbound[0].rcpt, 'hans@homedecor.de');
  const v = await sales1.post('/api/mails/send', { account_id: S.acc1, to: 'bad@', subject: 'x' });
  assert.equal(v.status, 400);
  assert.equal((await sales1.post('/api/mails/send', { account_id: S.acc1, to: A2, subject: '' })).status, 400);
});

test('TC-ML-05 收取邮件：ai002 解码中文主题与正文，自动绑定；增量收取不重复；ai003 收到抄送', async () => {
  const r = await sales2.post(`/api/mail-accounts/${S.acc2}/fetch`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.fetched, 1);
  const list = (await sales2.get('/api/mails?folder=收件')).data.rows;
  const m = (await sales2.get('/api/mails/' + list[0].id)).data;
  assert.equal(m.subject, `报价单 ${S.quote.quote_no} — 浮雕牡丹花瓶 YL-V001 最新报价`);
  assert.match(m.body, /单价含 FOB 厦门/);
  assert.match(m.mail_from, /AI001 <ai001@316191099\.xyz>/);
  assert.match(m.mail_to, /王芳 <ai002@316191099\.xyz>/);
  assert.equal(m.quote_id, S.quote.id);
  assert.equal(m.customer_id, 1);
  assert.equal(m.status, '已接收');
  assert.match(m.labels.customer_id, /HomeDecor/, '缺陷U2回归：非本人客户的绑定也返回名称，避免下拉框误清空');
  assert.equal(m.labels.quote_id, S.quote.quote_no);
  assert.equal((await sales2.post(`/api/mail-accounts/${S.acc2}/fetch`)).data.fetched, 0, '增量收取不重复');
  assert.equal((await admin.post(`/api/mail-accounts/${S.acc3}/fetch`)).data.fetched, 1);
  const acc = (await sales2.get('/api/mail-accounts')).data.rows[0];
  assert.equal(acc.last_uid, 1);
  assert.equal(acc.last_error, null);
});

test('TC-ML-06 复杂邮件解析：GBK 主题、QP 正文、中文附件名；附件可下载且内容一致；按订单号绑定', async () => {
  const o = await sales1.post(`/api/quotes/${S.quote.id}/submit`);
  assert.equal(o.status, 200);
  const ap = (await admin.get('/api/approvals')).data.rows.find((a) => a.target_no === S.quote.quote_no && a.status === '待审批');
  await admin.post(`/api/approvals/${ap.id}/decide`, { pass: true });
  S.order = (await sales1.post(`/api/quotes/${S.quote.id}/to-order`)).data;
  const pdf = Buffer.from('%PDF-1.4 模拟规格书 test attachment', 'utf8');
  const qp = Buffer.from(`Dear 林先生，订单 ${S.order.order_no} 请安排验货。`, 'utf8').toString('latin1').replace(/[^\x20-\x7e]/g, (c) => '=' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
  const raw = [
    'From: "Hans Müller" <hans@homedecor.de>', `To: ${A2}`, 'Subject: =?GB2312?B?0fnGt7GovNs=?= ' + S.order.order_no,
    'Date: Wed, 04 Nov 2026 09:30:00 +0100', 'Message-ID: <hans-001@homedecor.de>', 'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="XYZ"', '', '--XYZ', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable', '', qp,
    '--XYZ', 'Content-Type: application/pdf', "Content-Disposition: attachment; filename*=UTF-8''%E8%A7%84%E6%A0%BC%E4%B9%A6.pdf", 'Content-Transfer-Encoding: base64', '',
    pdf.toString('base64'), '--XYZ--', '',
  ].join('\r\n');
  mock.store.deliver(A2, Buffer.from(raw, 'utf8'));
  mock.store.deliver(A2, Buffer.from(raw, 'utf8'));
  const r = (await sales2.post(`/api/mail-accounts/${S.acc2}/fetch`)).data;
  assert.equal(r.fetched, 1);
  assert.equal(r.duplicates, 1, '相同 Message-ID 去重');
  const m = (await admin.get('/api/mails?q=hans-001')).data.rows[0] || (await admin.get('/api/mails?folder=收件')).data.rows.find((x) => x.mail_from.includes('hans'));
  const d = (await admin.get('/api/mails/' + m.id)).data;
  assert.equal(d.subject, `样品报价 ${S.order.order_no}`);
  assert.match(d.body, /Dear 林先生，订单 SO\d{8}-\d{3} 请安排验货。/);
  assert.equal(d.mail_from, 'Hans Müller <hans@homedecor.de>');
  assert.equal(d.customer_id, 1, '发件人为客户邮箱 → 自动绑定客户');
  assert.equal(d.order_id, S.order.id, '按订单号绑定');
  assert.equal(d.mail_date, new Date('2026-11-04T08:30:00Z').toLocaleString('sv-SE'));
  assert.equal(d.attachments.length, 1);
  assert.equal(d.attachments[0].name, '规格书.pdf');
  const f = await admin.get('/api/files/' + d.attachments[0].file_id);
  assert.equal(f.status, 200);
  assert.ok(Buffer.compare(f.data, pdf) === 0, '附件内容与原件一致');
  S.hansMail = d.id;
  S.hansFile = d.attachments[0].file_id;
});

test('TC-ML-07 邮件数据隔离：客户邮件归属客户负责人；他人邮箱的邮件不可见', async () => {
  assert.equal((await sales1.get('/api/mails/' + S.hansMail)).status, 200, '客户 C001 归林晓明 → 可见（客户资源公司沉淀）');
  assert.equal((await sales1.get('/api/files/' + S.hansFile)).status, 200);
  const own = (await sales2.get('/api/mails')).data.rows;
  assert.ok(own.every((x) => x.account_id === S.acc2 || x.account_id === null), '王芳只看到本人邮箱邮件');
  assert.equal((await sales2.get('/api/mails/' + S.sent)).status, 404, '看不到林晓明邮箱的发件');
  const a3mail = (await admin.get(`/api/mails?account_id=${S.acc3}`)).data.rows[0];
  assert.equal((await sales2.get('/api/mails/' + a3mail.id)).status, 404);
});

test('TC-ML-08 发送失败留痕与重发：服务器不可达 → 发送失败；修正后重发成功', async () => {
  const broken = await sales1.put(`/api/mail-accounts/${S.acc1}`, { ...acct(A1), password: '', smtp_port: 1 });
  assert.equal(broken.status, 200);
  const r = await sales1.post('/api/mails/send', { account_id: S.acc1, to: A2, subject: '样品寄出通知', body: 'DHL 1234567890' });
  assert.equal(r.status, 502);
  assert.match(r.data.error, /拒绝连接|ECONNREFUSED/);
  const failed = (await sales1.get('/api/mails/' + r.data.mail_id)).data;
  assert.equal(failed.status, '发送失败');
  assert.equal((await sales1.get('/api/mails?folder=发送失败')).data.total, 1);
  await sales1.put(`/api/mail-accounts/${S.acc1}`, { ...acct(A1), password: '' });
  const re = await sales1.post(`/api/mails/${r.data.mail_id}/resend`);
  assert.equal(re.status, 200, JSON.stringify(re.data));
  assert.equal(re.data.status, '已发送');
  assert.equal((await sales1.get('/api/mails?folder=发送失败')).data.total, 0);
  const delivered = parseMessage(mock.store.boxes.get(A2).at(-1).raw);
  assert.equal(delivered.subject, '样品寄出通知');
  assert.equal(delivered.text, 'DHL 1234567890', '重发的邮件内容完整送达');
});

test('TC-ML-09 询价单邮件直发厂家：自动附带 Excel 询价单，询价单状态变为已发送', async () => {
  await admin.put('/api/e/supplier/1', { email: A3 });
  const split = await sales1.post(`/api/quotes/${S.quote.id}/split`);
  const quote2 = (await sales1.post('/api/quotes', { customer_id: 2, currency: 'USD', term: 'FOB', items: [{ sample_id: 2, qty: 500 }] })).data;
  const inq = (await sales1.post(`/api/quotes/${quote2.id}/split`)).data.rows[0];
  assert.ok(split.status === 409 || split.status === 200);
  assert.equal((await sales1.get('/api/inquiries/' + inq.id)).data.supplier_email, A3, '缺陷U3回归：业务员无供应商模块权限也能取得厂家邮箱');
  assert.equal((await sales1.get('/api/e/supplier/1')).status, 403);
  const r = await sales1.post(`/api/inquiries/${inq.id}/email`, { account_id: S.acc1, unit: 'inch' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(JSON.parse(r.data.attachments)[0].name, `${inq.inquiry_no}_英寸版.xlsx`);
  assert.equal((await sales1.get('/api/inquiries/' + inq.id)).data.status, '已发送');
  assert.equal((await admin.post(`/api/mail-accounts/${S.acc3}/fetch`)).data.fetched, 1);
  const got = (await admin.get(`/api/mails?account_id=${S.acc3}&q=${encodeURIComponent(inq.inquiry_no)}`)).data.rows[0];
  const d = (await admin.get('/api/mails/' + got.id)).data;
  assert.equal(d.attachments[0].name, `${inq.inquiry_no}_英寸版.xlsx`);
  const x = (await admin.get('/api/files/' + d.attachments[0].file_id)).data;
  assert.ok(sheetXml(x).includes('英寸版 INCH'), '厂家收到的附件是有效的询价单 Excel');
  assert.equal((await admin.post(`/api/inquiries/${inq.id}/email`, { account_id: S.acc1 })).status, 200, '管理员可使用任一账户');
});

test('TC-ML-10 加密连接：SSL 与 STARTTLS；自签名证书需关闭校验', async (t) => {
  if (!mock.tls) { t.skip('无 openssl，跳过 TLS 测试'); return; }
  const strict = await sales2.put(`/api/mail-accounts/${S.acc2}`, { ...acct(A2), password: '', smtp_port: mock.ports.smtps, smtp_secure: 'ssl', imap_port: mock.ports.imaps, imap_secure: 'ssl' });
  assert.equal(strict.status, 200);
  const t1 = (await sales2.post(`/api/mail-accounts/${S.acc2}/test`)).data;
  assert.equal(t1.smtp.ok, false);
  assert.match(t1.smtp.message, /自签名证书|不受信任/);
  await sales2.put(`/api/mail-accounts/${S.acc2}`, { ...acct(A2), password: '', smtp_port: mock.ports.smtps, smtp_secure: 'ssl', imap_port: mock.ports.imaps, imap_secure: 'ssl', tls_reject_unauthorized: 0 });
  const t2 = (await sales2.post(`/api/mail-accounts/${S.acc2}/test`)).data;
  assert.ok(t2.smtp.ok && t2.imap.ok, JSON.stringify(t2));
  const sent = await sales2.post('/api/mails/send', { account_id: S.acc2, to: A1, subject: 'SSL 加密发送测试', body: '经 SSL 发送' });
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  await sales2.put(`/api/mail-accounts/${S.acc2}`, { ...acct(A2), password: '', smtp_secure: 'starttls', imap_secure: 'starttls', tls_reject_unauthorized: 0 });
  const t3 = (await sales2.post(`/api/mail-accounts/${S.acc2}/test`)).data;
  assert.ok(t3.smtp.ok && t3.imap.ok, JSON.stringify(t3));
  const sent2 = await sales2.post('/api/mails/send', { account_id: S.acc2, to: A1, subject: 'STARTTLS 加密发送测试', body: '经 STARTTLS 发送' });
  assert.equal(sent2.status, 200, JSON.stringify(sent2.data));
  const f = (await sales1.post(`/api/mail-accounts/${S.acc1}/fetch`)).data;
  assert.equal(f.fetched, 2, 'ai001 收到两封加密通道发来的邮件');
});

test('TC-ML-11 定时任务：到期自动收信', async () => {
  mock.store.deliver(A1, Buffer.from(`From: ${A3}\r\nTo: ${A1}\r\nSubject: auto fetch\r\nMessage-ID: <auto-1@x>\r\n\r\nhello\r\n`));
  srv.app.db.prepare("UPDATE settings SET value='1' WHERE key='mail_fetch_minutes'").run();
  srv.app.db.prepare("UPDATE settings SET value='0' WHERE key='rate_auto_hours'").run();
  srv.app.db.prepare("UPDATE mail_accounts SET last_fetch_at='2026-01-01 00:00:00'").run();
  const out = await runDueJobs(srv.app.db, srv.app.config);
  const a1 = out.mail.find((x) => x.email === A1);
  assert.equal(a1.fetched, 1, JSON.stringify(out));
  const again = await runDueJobs(srv.app.db, srv.app.config);
  assert.equal(again.mail.length, 0, '未到间隔不重复收取');
});

// ===================== 汇率 / rates =====================
test('TC-RT-01 汇率自动更新（open.er-api 格式）：折算正确、写波动记录与日志', async () => {
  await admin.put('/api/settings', { rate_api_url: S.rateUrl });
  rateBody = { result: 'success', base_code: 'CNY', time_last_update_utc: 'Wed, 04 Nov 2026 00:00:00 +0000', rates: { CNY: 1, USD: 0.1404, EUR: 0.1298, GBP: 0.1105, JPY: 21.5 } };
  const r = await admin.post('/api/rates/update');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const cur = Object.fromEntries((await admin.get('/api/e/currency')).data.rows.map((c) => [c.code, c.rate]));
  assert.equal(cur.USD, 7.1225);
  assert.equal(cur.EUR, 7.7042);
  assert.equal(cur.GBP, 9.0498);
  assert.equal(cur.JPY, 0.046512);
  assert.equal(cur.CNY, 1);
  assert.equal(r.data.updated.length, 4);
  const h = (await admin.get('/api/e/rate_history')).data.rows;
  assert.equal(h[0].user_name, '系统管理员');
  const st = (await admin.get('/api/rates/status')).data;
  assert.equal(st.source, S.rateUrl);
  assert.ok(st.last);
});

test('TC-RT-02 兼容其它基准货币格式（frankfurter，base=USD）；新报价自动使用新汇率', async () => {
  rateBody = { base: 'USD', date: '2026-11-04', rates: { CNY: 7.1, EUR: 0.92, GBP: 0.785, JPY: 152.4 } };
  const r = await admin.post('/api/rates/update');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const cur = Object.fromEntries((await admin.get('/api/e/currency')).data.rows.map((c) => [c.code, c.rate]));
  assert.equal(cur.USD, 7.1);
  assert.equal(cur.EUR, 7.7174);
  const q = await sales1.post('/api/quotes', { customer_id: 1, currency: 'EUR', term: 'FOB', items: [{ sample_id: 1, qty: 10 }] });
  assert.equal(q.data.rate, 7.7174);
});

test('TC-RT-03 异常波动保护：单次变化超过阈值不更新', async () => {
  rateBody = { base: 'USD', rates: { CNY: 7.1, EUR: 0.5, GBP: 0.785, JPY: 152.4 } };
  const r = (await admin.post('/api/rates/update')).data;
  const sk = r.skipped.find((x) => x.code === 'EUR');
  assert.match(sk.reason, /波动超过30%/);
  assert.equal((await admin.get('/api/e/currency/EUR')).data.rate, 7.7174, '欧元保持原值');
});

test('TC-RT-04 接口故障：全部失败给出中文原因；主接口失败自动切换备用接口', async () => {
  srv.app.db.prepare("UPDATE settings SET value=? WHERE key='rate_api_url'").run(S.rateUrl.replace('/latest', '/fail'));
  await assert.rejects(updateRates(srv.app.db, { fallbacks: [] }), /所有汇率接口均获取失败/);
  rateBody = { base_code: 'CNY', rates: { USD: 0.1408, EUR: 0.1297, GBP: 0.1104, JPY: 21.6 } };
  const r = await updateRates(srv.app.db, { fallbacks: [S.rateUrl] });
  assert.equal(r.source, S.rateUrl, '已切换到备用接口');
  assert.ok(r.errors[0].includes('HTTP 500'));
});

test('TC-RT-05 权限：只读岗位不能触发汇率更新；定时任务到期自动更新', async () => {
  assert.equal((await sales1.post('/api/rates/update')).status, 403);
  srv.app.db.prepare("UPDATE settings SET value=? WHERE key='rate_api_url'").run(S.rateUrl);
  srv.app.db.prepare("UPDATE settings SET value='24' WHERE key='rate_auto_hours'").run();
  srv.app.db.prepare("UPDATE settings SET value='2026-01-01 00:00:00' WHERE key='rate_last_auto'").run();
  srv.app.db.prepare("UPDATE settings SET value='0' WHERE key='mail_fetch_minutes'").run();
  rateBody = { base_code: 'CNY', rates: { USD: 0.141, EUR: 0.1296, GBP: 0.1103, JPY: 21.7 } };
  const out = await runDueJobs(srv.app.db, srv.app.config);
  assert.ok(out.rates && out.rates.updated.length > 0, JSON.stringify(out));
  const h = (await admin.get('/api/e/rate_history')).data.rows[0];
  assert.equal(h.user_name, '汇率自动更新');
  assert.equal((await runDueJobs(srv.app.db, srv.app.config)).rates, undefined, '未满24小时不重复更新');
});

// ===================== 样品图片 / sample images =====================
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000' + '1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

test('TC-IMG-01 上传样品图片：保存并可读取，内容一致，写入改样日志', async () => {
  const r = await admin.post('/api/samples/1/images', { name: '正面.png', data: 'data:image/png;base64,' + PNG.toString('base64') });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.images.includes(`file:${r.data.file_id}`));
  S.img = r.data.file_id;
  const f = await admin.get('/api/files/' + S.img);
  assert.equal(f.headers.get('content-type'), 'image/png');
  assert.ok(Buffer.compare(f.data, PNG) === 0);
  const ov = (await admin.get('/api/samples/1/overview')).data;
  assert.ok(ov.revisions.some((x) => x.content === '上传样品图片：正面.png'));
});

test('TC-IMG-02 图片校验：非图片格式拒绝、超过5MB拒绝、空数据拒绝', async () => {
  const txt = await admin.post('/api/samples/1/images', { name: 'a.exe', data: Buffer.from('MZ fake executable').toString('base64') });
  assert.equal(txt.status, 400);
  assert.match(txt.data.error, /JPG、PNG/);
  const big = Buffer.alloc(5 * 1024 * 1024 + 10);
  PNG.copy(big);
  assert.equal((await admin.post('/api/samples/1/images', { name: 'big.png', data: big.toString('base64') })).status, 413);
  assert.equal((await admin.post('/api/samples/1/images', { name: 'e.png', data: '' })).status, 400);
});

test('TC-IMG-03 图片权限：设计师可看本人样品图片、看不到他人；只读岗位不能上传/删除', async () => {
  assert.equal((await designer1.get('/api/files/' + S.img)).status, 200);
  assert.equal((await designer2.get('/api/files/' + S.img)).status, 404);
  assert.equal((await designer1.post('/api/samples/1/images', { name: 'x.png', data: PNG.toString('base64') })).status, 403);
  assert.equal((await sales1.del(`/api/samples/1/images/${S.img}`)).status, 403);
  assert.equal((await sales1.get('/api/files/' + S.img)).status, 200, '业务员可查看样品图片');
});

test('TC-IMG-05 改样转正：新样品获得独立的图片副本，删除旧图不影响新样品（模拟发现的缺陷S2）', async () => {
  const up = await admin.post('/api/samples/2/images', { name: '梅瓶.png', data: PNG.toString('base64') });
  const send = await sales1.post('/api/sample-sends', { customer_id: 1, items: [{ sample_id: 2, qty: 1, new_item_no: 'YL-V002Z', revise_req: '改色' }] });
  await sales1.post(`/api/send-items/${send.data.items[0].id}/verify`, { pass: true });
  const conv = await admin.post(`/api/send-items/${send.data.items[0].id}/convert`, {});
  assert.equal(conv.status, 200, JSON.stringify(conv.data));
  const ns = (await admin.get('/api/e/sample/' + conv.data.id)).data;
  const ref = ns.images.split(',').find((x) => x.startsWith('file:'));
  assert.ok(ref && ref !== `file:${up.data.file_id}`, '新样品引用独立文件');
  await admin.del(`/api/samples/2/images/${up.data.file_id}`);
  const f = await admin.get('/api/files/' + ref.slice(5));
  assert.equal(f.status, 200);
  assert.ok(Buffer.compare(f.data, PNG) === 0);
});

test('TC-IMG-04 删除图片：从样品移除且文件删除；不能删除其它样品的图片', async () => {
  assert.equal((await admin.del(`/api/samples/2/images/${S.img}`)).status, 404);
  const r = await admin.del(`/api/samples/1/images/${S.img}`);
  assert.equal(r.status, 200);
  assert.ok(!r.data.images.includes(`file:${S.img}`));
  assert.equal((await admin.get('/api/files/' + S.img)).status, 404);
});
