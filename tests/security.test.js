'use strict';
/**
 * 安全测试：密码策略、暴力破解防护、强制改密、会话、安全响应头、路径穿越、限流、SSRF、演示账号展示
 * Security tests: password policy, brute-force protection, forced change, sessions, headers, traversal, rate limits, SSRF, demo account display.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { startServer } = require('./helpers');
const { passwordProblems, generatePassword, DEMO_ACCOUNTS } = require('../server/security');
const { hashPassword } = require('../server/db');

let srv;
let admin;
const post = (path, body, headers = {}) => fetch(srv.base + path, { method: 'POST', headers, body: JSON.stringify(body) });

/** 原始 HTTP 请求（不做路径规范化）/ Raw HTTP request without path normalisation */
function rawGet(path) {
  return new Promise((resolve) => {
    const u = new URL(srv.base);
    const s = net.connect(Number(u.port), u.hostname, () => s.write(`GET ${path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`));
    let d = '';
    s.on('data', (c) => { d += c; });
    s.on('end', () => resolve(Number(d.split(' ')[1])));
  });
}

test.before(async () => {
  srv = await startServer();
  admin = await srv.login('admin');
});
test.after(() => srv.close());

test('TC-SEC-03 密码策略：弱密码全部拒绝，演示密码与系统生成密码均合规', () => {
  for (const w of ['123456', '12345678', 'password', 'Password1!', 'admin@123', 'Abcdef123!', 'Aaaa@1234x', 'Short1!a', 'NoDigits!!xx', 'nouppercase1!', 'NOLOWER1!@#X']) {
    assert.ok(passwordProblems(w, 'tester').length > 0, `${w} 应被拒绝`);
  }
  assert.ok(passwordProblems('Tester#9482Kq', 'tester').includes('不能包含账号名'));
  for (const [u, a] of Object.entries(DEMO_ACCOUNTS)) assert.deepEqual(passwordProblems(a.password, u), [], `${u} 演示密码合规`);
  for (let i = 0; i < 50; i++) assert.deepEqual(passwordProblems(generatePassword('admin'), 'admin'), []);
});

test('TC-SEC-04 防暴力破解：连续5次错误锁定账号，锁定期间正确密码也不能登录，管理员可解锁', async () => {
  const msgs = [];
  for (let i = 0; i < 5; i++) {
    const r = await post('/api/login', { username: 'prod1', password: 'Wrong#Pass' + i });
    msgs.push([r.status, (await r.json()).error]);
  }
  assert.deepEqual(msgs.slice(0, 4).map((m) => m[0]), [401, 401, 401, 401]);
  assert.match(msgs[0][1], /再错 4 次将锁定/);
  assert.equal(msgs[4][0], 423);
  const locked = await post('/api/login', { username: 'prod1', password: DEMO_ACCOUNTS.prod1.password });
  assert.equal(locked.status, 423, '锁定期间正确密码也拒绝');
  const users = (await admin.get('/api/users')).data.rows;
  const prod = users.find((u) => u.username === 'prod1');
  assert.equal(prod.locked, true);
  assert.ok((await admin.get('/api/dashboard')).data.alerts.some((a) => a.type === '安全提醒' && /锁定/.test(a.text)));
  await admin.put('/api/users/' + prod.id, { unlock: true });
  assert.ok((await srv.login('prod1')).token, '解锁后可登录');
  const logs = (await admin.get('/api/e/log?q=' + encodeURIComponent('账号锁定'))).data.rows;
  assert.ok(logs.length >= 1, '锁定事件写入日志');
});

test('TC-SEC-05 不泄露账号是否存在；同一IP失败过多被限流', async () => {
  const a = await (await post('/api/login', { username: 'nobody-xyz', password: 'Whatever#1x' })).json();
  assert.equal(a.error, '账号或密码错误');
  const s2 = await startServer();
  let last;
  for (let i = 0; i < 21; i++) last = await fetch(s2.base + '/api/login', { method: 'POST', body: JSON.stringify({ username: 'ghost' + i, password: 'Nope#1234x' }) });
  assert.equal(last.status, 429);
  const ok = await fetch(s2.base + '/api/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: DEMO_ACCOUNTS.admin.password }) });
  assert.equal(ok.status, 429, '限流期间该IP暂停登录');
  await s2.close();
});

test('TC-SEC-06 旧弱密码登录后强制修改；修改前业务接口被拦截', async () => {
  const { hash, salt } = hashPassword('123456');
  srv.app.db.prepare("UPDATE users SET password_hash=?, salt=? WHERE username='hr1'").run(hash, salt);
  const hr = await srv.login('hr1', '123456');
  assert.equal(hr.must_change, true);
  const r = await hr.get('/api/e/employee');
  assert.equal(r.status, 403);
  assert.equal(r.data.code, 'MUST_CHANGE_PASSWORD');
  assert.equal((await hr.get('/api/meta')).status, 200, '仍可获取基本信息以显示改密窗口');
  assert.equal((await hr.post('/api/password', { old_password: '123456', new_password: '12345678' })).status, 400);
  assert.equal((await hr.post('/api/password', { old_password: '123456', new_password: 'Ren#Shi$7351v' })).status, 200);
  assert.equal((await hr.get('/api/e/employee')).status, 200);
});

test('TC-SEC-07 修改密码后其它设备的登录全部失效；退出登录令牌作废', async () => {
  const a = await srv.login('finance1');
  const b = await srv.login('finance1');
  assert.equal((await a.post('/api/password', { old_password: DEMO_ACCOUNTS.finance1.password, new_password: 'Cai$Wu#6402n' })).status, 200);
  assert.equal((await b.get('/api/meta')).status, 401, '另一设备被踢出');
  assert.equal((await a.get('/api/meta')).status, 200, '当前设备保持登录');
  await a.post('/api/logout');
  assert.equal((await a.get('/api/meta')).status, 401);
});

test('TC-SEC-08 安全响应头：CSP、防点击劫持、禁止嗅探；下载文件在沙箱中', async () => {
  for (const p of ['/', '/api/meta', '/js/core.js']) {
    const r = await fetch(srv.base + p);
    assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/, p);
    assert.match(r.headers.get('content-security-policy'), /script-src 'self'(;|$)/, p);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  }
  const x = await admin.post('/api/export', { module: 'report', title: 't', headers: ['a'], rows: [[1]] });
  assert.match(x.headers.get('content-security-policy'), /sandbox/);
  const html = await (await fetch(srv.base + '/')).text();
  assert.ok(!/\son[a-z]+=|javascript:/i.test(html), '首页无内联事件脚本');
});

test('TC-SEC-09 令牌不能放在网址中；路径穿越与隐藏文件被拒绝', async () => {
  assert.equal((await fetch(srv.base + '/api/meta?token=' + admin.token)).status, 401);
  for (const p of ['/../server/db.js', '/%2e%2e/server/app.js', '/..%2fserver%2fapp.js', '/.git/config', '/js/../../package.json', '/%00']) {
    assert.ok([400, 404].includes(await rawGet(p)), p);
  }
  assert.equal((await fetch(srv.base + '/js/core.js')).status, 200);
});

test('TC-SEC-10 全局请求限流', async () => {
  const s3 = await startServer({ rateLimit: 30 });
  const codes = [];
  for (let i = 0; i < 32; i++) codes.push((await fetch(s3.base + '/api/public/login-info')).status);
  assert.equal(codes.slice(0, 30).every((c) => c === 200), true);
  assert.equal(codes[31], 429);
  // 同一出口IP的已登录同事不受匿名限流影响（缺陷P2）/ a logged-in colleague on the same IP is unaffected (defect P2)
  const r = await fetch(s3.base + '/api/login', { method: 'POST', body: JSON.stringify({ username: 'sales1', password: DEMO_ACCOUNTS.sales1.password }) });
  assert.equal(r.status, 429, '匿名登录请求同属该IP，被限流');
  s3.app.db.prepare("INSERT INTO sessions(token,user_id,expires_at) VALUES('office-colleague', 2, ?)").run(Date.now() + 60000);
  const ok = await fetch(s3.base + '/api/meta', { headers: { Authorization: 'Bearer office-colleague' } });
  assert.equal(ok.status, 200, '已登录用户按账号计数');
  await s3.close();
});

test('TC-SEC-11 演示账号表：开启时展示仍为演示密码的账号；改过密码的不再展示；关闭后不展示', async () => {
  const info = await (await fetch(srv.base + '/api/public/login-info')).json();
  assert.equal(info.show_demo_accounts, true);
  assert.ok(info.policy.includes('至少10位'));
  const names = info.accounts.map((a) => a.username);
  assert.ok(!names.includes('finance1') && !names.includes('hr1'), '已改密码的账号不再展示');
  assert.ok(names.includes('admin') && names.includes('sales3') && names.includes('designer3'));
  const s1 = await srv.login('sales1');
  assert.ok(!(await s1.get('/api/dashboard')).data.alerts.some((a) => a.type === '安全提醒'), '非管理员不显示安全提醒');
  assert.ok((await admin.get('/api/dashboard')).data.alerts.some((a) => /公开展示演示账号/.test(a.text)));
  await admin.put('/api/settings', { show_demo_accounts: '0' });
  const off = await (await fetch(srv.base + '/api/public/login-info')).json();
  assert.deepEqual(off.accounts, []);
  await admin.put('/api/settings', { show_demo_accounts: '1' });
});

test('TC-SEC-12 邮箱服务器防 SSRF：默认禁止内网/本机地址与非邮件端口', async () => {
  const s1 = await srv.login('sales1');
  const base = { email: 'x1@316191099.xyz', password: 'Mail#Pass9x', smtp_port: 465, imap_port: 993, smtp_secure: 'ssl', imap_secure: 'ssl' };
  for (const host of ['127.0.0.1', 'localhost', '10.0.0.5', '192.168.1.10', '169.254.169.254']) {
    const r = await s1.post('/api/mail-accounts', { ...base, smtp_host: host, imap_host: host });
    assert.equal(r.status, 400, host);
    assert.match(r.data.error, /内网|找不到/, host);
  }
  const port = await s1.post('/api/mail-accounts', { ...base, smtp_host: '8.8.8.8', imap_host: '8.8.8.8', smtp_port: 22 });
  assert.equal(port.status, 400);
  assert.match(port.data.error, /端口 22/);
});

test('TC-SEC-13 系统参数校验：未知参数、非 https 汇率接口、非法阈值均拒绝', async () => {
  assert.equal((await admin.put('/api/settings', { evil: '1' })).status, 400);
  assert.equal((await admin.put('/api/settings', { rate_api_url: 'http://169.254.169.254/latest' })).status, 400);
  assert.equal((await admin.put('/api/settings', { rate_api_url: 'file:///etc/passwd' })).status, 400);
  assert.equal((await admin.put('/api/settings', { lockout_threshold: '1' })).status, 400);
  assert.equal((await admin.put('/api/settings', { rate_api_url: 'https://open.er-api.com/v6/latest/CNY' })).status, 200);
  assert.equal((await admin.post('/api/users', { username: "x' OR 1=1", name: 'x', role_id: 2 })).status, 400, '账号名格式校验');
});
