'use strict';
/**
 * 模拟邮件服务器（SMTP + IMAP，支持明文/SSL/STARTTLS），仅用于测试
 * Mock mail server (SMTP + IMAP; plain, SSL, STARTTLS) for testing only.
 * 单独运行 / standalone: node tests/mock-mail-server.js  → SMTP 2525/2465, IMAP 2143/2993
 */
const net = require('node:net');
const tls = require('node:tls');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

/** 测试邮箱（用户提供的三个地址）/ Test mailboxes (the user's three addresses) */
const USERS = {
  'ai001@316191099.xyz': 'Test-Pass-001',
  'ai002@316191099.xyz': 'Test-Pass-002',
  'ai003@316191099.xyz': 'Test-Pass-003',
};

/**
 * 生成自签名证书（需要 openssl）/ Create a self-signed certificate (requires openssl).
 * @returns {{key:Buffer, cert:Buffer}|null}
 */
function selfSignedCert() {
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-mock-tls-'));
    const key = path.join(dir, 'key.pem');
    const cert = path.join(dir, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=localhost'], { stdio: 'ignore' });
    return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
  } catch {
    return null;
  }
}

/**
 * 邮箱存储 / Mailbox store.
 */
class Store {
  constructor() {
    /** @type {Map<string, {uid:number, raw:Buffer}[]>} */
    this.boxes = new Map(Object.keys(USERS).map((u) => [u, []]));
    this.next = new Map(Object.keys(USERS).map((u) => [u, 1]));
    /** 发往外部地址的邮件 / messages to external recipients */
    this.outbound = [];
    this.uidvalidity = 42;
  }

  /**
   * 投递 / Deliver a message.
   * @param {string} rcpt
   * @param {Buffer} raw
   */
  deliver(rcpt, raw) {
    const box = this.boxes.get(rcpt.toLowerCase());
    if (!box) { this.outbound.push({ rcpt, raw }); return; }
    const uid = this.next.get(rcpt.toLowerCase());
    this.next.set(rcpt.toLowerCase(), uid + 1);
    box.push({ uid, raw: Buffer.from(raw) });
  }
}

/**
 * 行读取（文本协议）/ Line-based reader over a socket.
 * @param {import('node:net').Socket} sock
 * @param {(line:string)=>void} onLine
 * @returns {{raw:(fn:Function|null)=>void}} 切换为原始数据模式 / switch to raw data mode
 */
function lines(sock, onLine) {
  let buf = '';
  let rawFn = null;
  sock.on('data', (d) => {
    buf += d.toString('latin1');
    for (;;) {
      if (rawFn) { const f = rawFn; buf = f(buf); if (rawFn) return; continue; }
      const i = buf.indexOf('\r\n');
      if (i < 0) return;
      const l = buf.slice(0, i);
      buf = buf.slice(i + 2);
      onLine(Buffer.from(l, 'latin1').toString('utf8'));
    }
  });
  sock.on('error', () => {});
  return { raw: (fn) => { rawFn = fn; } };
}

/**
 * SMTP 会话处理 / Handle one SMTP session.
 * @param {import('node:net').Socket} sock
 * @param {Store} store
 * @param {{key:Buffer, cert:Buffer}|null} tlsOpts 支持 STARTTLS 时提供 / provided when STARTTLS is supported
 * @param {boolean} secure 当前是否已加密 / already encrypted
 */
function smtpSession(sock, store, tlsOpts, secure) {
  let user = null;
  let from = null;
  let rcpts = [];
  let authStep = null;
  let loginUser = '';
  const w = (s) => sock.write(s + '\r\n');
  const reader = lines(sock, (l) => {
    if (authStep === 'user') { loginUser = Buffer.from(l, 'base64').toString(); authStep = 'pass'; w('334 UGFzc3dvcmQ6'); return; }
    if (authStep === 'pass') {
      authStep = null;
      const pw = Buffer.from(l, 'base64').toString();
      if (USERS[loginUser] === pw) { user = loginUser; w('235 2.7.0 Authentication successful'); } else w('535 5.7.8 Authentication failed');
      return;
    }
    const [verb, ...rest] = l.split(' ');
    const arg = rest.join(' ');
    switch (verb.toUpperCase()) {
      case 'EHLO':
      case 'HELO':
        w(`250-mock.316191099.xyz${tlsOpts && !secure ? '\r\n250-STARTTLS' : ''}\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME`);
        break;
      case 'STARTTLS': {
        if (!tlsOpts || secure) { w('502 not supported'); break; }
        w('220 2.0.0 Ready to start TLS');
        sock.removeAllListeners('data');
        const t = new tls.TLSSocket(sock, { isServer: true, key: tlsOpts.key, cert: tlsOpts.cert });
        smtpSession2(t, store, tlsOpts);
        break;
      }
      case 'AUTH': {
        const [mech, data] = arg.split(' ');
        if (mech.toUpperCase() === 'PLAIN') {
          const [, u, p] = Buffer.from(data || '', 'base64').toString().split('\0');
          if (USERS[u] === p) { user = u; w('235 2.7.0 Authentication successful'); } else w('535 5.7.8 Authentication failed');
        } else if (mech.toUpperCase() === 'LOGIN') { authStep = 'user'; w('334 VXNlcm5hbWU6'); } else w('504 unsupported');
        break;
      }
      case 'MAIL':
        if (!user) { w('530 5.7.0 Authentication required'); break; }
        from = /<([^>]*)>/.exec(arg)[1];
        rcpts = [];
        w('250 OK');
        break;
      case 'RCPT':
        rcpts.push(/<([^>]*)>/.exec(arg)[1]);
        w('250 OK');
        break;
      case 'DATA':
        if (!from || !rcpts.length) { w('503 bad sequence'); break; }
        w('354 End data with <CR><LF>.<CR><LF>');
        reader.raw((buf) => {
          const end = buf.indexOf('\r\n.\r\n');
          if (end < 0) return buf;
          const body = Buffer.from(buf.slice(0, end + 2).replace(/^\.\./gm, '.'), 'latin1');
          for (const r of rcpts) store.deliver(r, body);
          reader.raw(null);
          w('250 2.0.0 Queued');
          return buf.slice(end + 5);
        });
        break;
      case 'QUIT':
        w('221 Bye');
        sock.end();
        break;
      default:
        w('500 unknown command');
    }
  });
  if (!secure || sock instanceof tls.TLSSocket) { /* 问候语由调用方发送 / greeting sent by caller */ }
}

/** STARTTLS 后继续会话（不再发问候语）/ Continue a session after STARTTLS (no greeting) */
function smtpSession2(sock, store, tlsOpts) {
  smtpSession(sock, store, tlsOpts, true);
}

/** 解析 IMAP 参数（支持带引号字符串）/ Parse IMAP arguments including quoted strings */
function imapArgs(s) {
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
  let m;
  while ((m = re.exec(s))) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2]);
  return out;
}

/**
 * IMAP 会话处理 / Handle one IMAP session.
 * @param {import('node:net').Socket} sock
 * @param {Store} store
 * @param {{key:Buffer, cert:Buffer}|null} tlsOpts
 * @param {boolean} secure
 */
function imapSession(sock, store, tlsOpts, secure) {
  let user = null;
  const w = (s) => sock.write(s + '\r\n');
  lines(sock, (l) => {
    const [tag, cmd, ...rest] = l.split(' ');
    const C = (cmd || '').toUpperCase();
    if (C === 'CAPABILITY') { w(`* CAPABILITY IMAP4rev1${tlsOpts && !secure ? ' STARTTLS' : ''} AUTH=PLAIN`); w(`${tag} OK done`); return; }
    if (C === 'STARTTLS') {
      if (!tlsOpts || secure) { w(`${tag} BAD no`); return; }
      w(`${tag} OK Begin TLS`);
      sock.removeAllListeners('data');
      imapSession(new tls.TLSSocket(sock, { isServer: true, key: tlsOpts.key, cert: tlsOpts.cert }), store, tlsOpts, true);
      return;
    }
    if (C === 'LOGIN') {
      const [u, p] = imapArgs(rest.join(' '));
      if (USERS[u] === p) { user = u; w(`${tag} OK LOGIN completed`); } else w(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials`);
      return;
    }
    if (C === 'LOGOUT') { w('* BYE'); w(`${tag} OK`); sock.end(); return; }
    if (!user) { w(`${tag} NO not authenticated`); return; }
    const box = store.boxes.get(user);
    if (C === 'SELECT') {
      w(`* ${box.length} EXISTS`);
      w(`* OK [UIDVALIDITY ${store.uidvalidity}] UIDs valid`);
      w(`* OK [UIDNEXT ${store.next.get(user)}] next`);
      w(`${tag} OK [READ-WRITE] SELECT completed`);
      return;
    }
    if (C === 'UID' && (rest[0] || '').toUpperCase() === 'SEARCH') {
      let uids = box.map((m) => m.uid);
      const m = /UID (\d+):\*/i.exec(rest.join(' '));
      if (m) {
        const from = Number(m[1]);
        const hit = uids.filter((u) => u >= from);
        // RFC 3501：n:* 在 n 大于最大 UID 时仍包含最大 UID / n:* includes the max UID even when n exceeds it
        uids = hit.length ? hit : uids.slice(-1);
      }
      w(`* SEARCH ${uids.join(' ')}`.trimEnd());
      w(`${tag} OK SEARCH completed`);
      return;
    }
    if (C === 'UID' && (rest[0] || '').toUpperCase() === 'FETCH') {
      const uid = Number(rest[1]);
      const idx = box.findIndex((m) => m.uid === uid);
      if (idx >= 0) {
        const raw = box[idx].raw;
        sock.write(`* ${idx + 1} FETCH (UID ${uid} BODY[] {${raw.length}}\r\n`);
        sock.write(raw);
        sock.write(')\r\n');
      }
      w(`${tag} OK FETCH completed`);
      return;
    }
    w(`${tag} BAD unknown`);
  });
}

/**
 * 启动模拟服务器 / Start the mock servers.
 * @param {{smtpPort?:number, imapPort?:number, smtpsPort?:number, imapsPort?:number}} [ports] 0 表示随机端口 / 0 = random
 * @returns {Promise<{store:Store, ports:object, tls:boolean, close:Function}>}
 */
async function startMockMail(ports = {}) {
  const store = new Store();
  const cert = selfSignedCert();
  const servers = [];
  const listen = (srv, port) => new Promise((r) => srv.listen(port || 0, '127.0.0.1', () => { servers.push(srv); r(srv.address().port); }));
  const out = {};
  out.smtp = await listen(net.createServer((s) => { s.write('220 mock.316191099.xyz ESMTP ready\r\n'); smtpSession(s, store, cert, false); }), ports.smtpPort);
  out.imap = await listen(net.createServer((s) => { s.write('* OK IMAP4rev1 mock ready\r\n'); imapSession(s, store, cert, false); }), ports.imapPort);
  if (cert) {
    out.smtps = await listen(tls.createServer(cert, (s) => { s.write('220 mock.316191099.xyz ESMTP ready\r\n'); smtpSession(s, store, cert, true); }), ports.smtpsPort);
    out.imaps = await listen(tls.createServer(cert, (s) => { s.write('* OK IMAP4rev1 mock ready\r\n'); imapSession(s, store, cert, true); }), ports.imapsPort);
  }
  return { store, ports: out, tls: !!cert, close: () => Promise.all(servers.map((s) => new Promise((r) => { s.close(() => r()); setTimeout(r, 200); }))) };
}

module.exports = { startMockMail, USERS };

if (require.main === module) {
  startMockMail({ smtpPort: 2525, imapPort: 2143, smtpsPort: 2465, imapsPort: 2993 }).then((m) => {
    console.log('模拟邮件服务器已启动 / mock mail server:', JSON.stringify(m.ports), 'TLS:', m.tls);
    console.log('测试邮箱 / mailboxes:', Object.entries(USERS).map(([u, p]) => `${u} / ${p}`).join('  '));
  });
}
