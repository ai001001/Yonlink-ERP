'use strict';
/**
 * 零依赖邮件库：SMTP 发信、IMAP 收信、MIME 编码与解析、邮箱密码加密
 * Zero-dependency mail library: SMTP sending, IMAP fetching, MIME build/parse, password encryption.
 * @module server/mail
 */
const net = require('node:net');
const tls = require('node:tls');
const crypto = require('node:crypto');

const TIMEOUT = 20000;

// ======================= 加密 / encryption =======================

/**
 * 加密邮箱密码（AES-256-GCM）/ Encrypt a mailbox password with AES-256-GCM.
 * @param {string} text 明文 / plain text
 * @param {string} secret 系统密钥 / system secret
 * @returns {string}
 */
function encryptSecret(text, secret) {
  const key = crypto.createHash('sha256').update(String(secret)).digest();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return 'v1:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

/**
 * 解密邮箱密码 / Decrypt a mailbox password.
 * @param {string} enc 密文 / cipher text
 * @param {string} secret 系统密钥 / system secret
 * @returns {string}
 */
function decryptSecret(enc, secret) {
  if (!enc) return '';
  const raw = Buffer.from(String(enc).replace(/^v1:/, ''), 'base64');
  const key = crypto.createHash('sha256').update(String(secret)).digest();
  const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}

// ======================= MIME 编码 / MIME building =======================

/**
 * RFC 2047 编码（非 ASCII 时用 UTF-8 Base64）/ RFC 2047 encode non-ASCII header text.
 * @param {string} s
 * @returns {string}
 */
function encodeWord(s) {
  s = String(s ?? '');
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  const chunks = [];
  let cur = '';
  for (const ch of s) {
    if (Buffer.byteLength(cur + ch) > 45) { chunks.push(cur); cur = ''; }
    cur += ch;
  }
  if (cur) chunks.push(cur);
  return chunks.map((c) => `=?UTF-8?B?${Buffer.from(c).toString('base64')}?=`).join('\r\n ');
}

/**
 * 解析地址列表 / Parse an address list into objects.
 * @param {string} s 例如 "张三 <a@x.com>, b@y.com" / e.g. "Name <a@x.com>, b@y.com"
 * @returns {{name:string, address:string}[]}
 */
function parseAddresses(s) {
  const out = [];
  for (const part of String(s || '').split(/[,;，；](?=(?:[^"]*"[^"]*")*[^"]*$)/)) {
    const p = part.trim();
    if (!p) continue;
    const m = /^(.*)<\s*([^>]+?)\s*>\s*$/.exec(p);
    if (m) out.push({ name: m[1].trim().replace(/^"|"$/g, ''), address: m[2].trim().toLowerCase() });
    else out.push({ name: '', address: p.replace(/^mailto:/i, '').toLowerCase() });
  }
  return out;
}

/** 邮箱格式校验 / Email address validation */
const isEmail = (a) => /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]+$/.test(a);

/**
 * 格式化地址 / Format an address for a header.
 * @param {{name?:string, address:string}} a
 * @returns {string}
 */
const fmtAddr = (a) => (a.name ? `${encodeWord(a.name)} <${a.address}>` : a.address);

/** Base64 按 76 字符换行 / Base64 wrapped at 76 chars */
const b64lines = (buf) => Buffer.from(buf).toString('base64').replace(/.{76}(?=.)/g, '$&\r\n');

/**
 * 生成邮件原文 / Build a raw RFC 5322 message.
 * @param {object} m
 * @param {{name?:string,address:string}} m.from 发件人 / sender
 * @param {{name?:string,address:string}[]} m.to 收件人 / recipients
 * @param {{name?:string,address:string}[]} [m.cc] 抄送 / cc
 * @param {string} m.subject 主题 / subject
 * @param {string} m.text 正文 / plain-text body
 * @param {{filename:string, contentType:string, content:Buffer}[]} [m.attachments] 附件 / attachments
 * @returns {{raw:Buffer, messageId:string}}
 */
function buildMessage({ from, to, cc = [], subject, text, attachments = [] }) {
  const domain = from.address.split('@')[1] || 'localhost';
  const messageId = `<${crypto.randomBytes(12).toString('hex')}@${domain}>`;
  const head = [
    `From: ${fmtAddr(from)}`,
    `To: ${to.map(fmtAddr).join(', ')}`,
    ...(cc.length ? [`Cc: ${cc.map(fmtAddr).join(', ')}`] : []),
    `Subject: ${encodeWord(subject)}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    'X-Mailer: Yonlink-Ceramic-ERP',
  ];
  const textPart = ['Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64lines(Buffer.from(String(text || ''), 'utf8'))];
  let body;
  if (!attachments.length) {
    body = [...head, ...textPart].join('\r\n');
  } else {
    const boundary = '----=_ERP_' + crypto.randomBytes(8).toString('hex');
    const parts = [`--${boundary}`, ...textPart];
    for (const a of attachments) {
      const enc = encodeURIComponent(a.filename);
      parts.push(`--${boundary}`, `Content-Type: ${a.contentType || 'application/octet-stream'}; name="${encodeWord(a.filename)}"`,
        `Content-Disposition: attachment; filename*=UTF-8''${enc}`, 'Content-Transfer-Encoding: base64', '', b64lines(a.content));
    }
    parts.push(`--${boundary}--`, '');
    body = [...head, `Content-Type: multipart/mixed; boundary="${boundary}"`, '', ...parts].join('\r\n');
  }
  return { raw: Buffer.from(body + '\r\n', 'utf8'), messageId };
}

// ======================= MIME 解析 / MIME parsing =======================

/**
 * 按字符集解码 / Decode bytes with a charset (falls back to UTF-8).
 * @param {Buffer} buf
 * @param {string} [charset]
 * @returns {string}
 */
function decodeCharset(buf, charset) {
  let cs = String(charset || 'utf-8').toLowerCase().replace(/^"|"$/g, '');
  if (['gb2312', 'gbk', 'x-gbk', 'cp936'].includes(cs)) cs = 'gb18030';
  try {
    return new TextDecoder(cs).decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

/**
 * Quoted-Printable 解码 / Decode quoted-printable.
 * @param {string} s
 * @param {boolean} [header] 头部 Q 编码（下划线=空格）/ header Q-encoding
 * @returns {Buffer}
 */
function decodeQP(s, header = false) {
  if (header) s = s.replace(/_/g, ' ');
  s = s.replace(/=\r?\n/g, '');
  const bytes = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(s.substr(i + 1, 2))) {
      bytes.push(parseInt(s.substr(i + 1, 2), 16));
      i += 2;
    } else {
      bytes.push(...Buffer.from(s[i], 'latin1'));
    }
  }
  return Buffer.from(bytes);
}

/**
 * 解码 RFC 2047 编码词 / Decode RFC 2047 encoded words.
 * @param {string} s
 * @returns {string}
 */
function decodeWords(s) {
  return String(s || '')
    .replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?)/g, '$1')
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, cs, enc, txt) => {
      const buf = enc.toUpperCase() === 'B' ? Buffer.from(txt, 'base64') : decodeQP(txt, true);
      return decodeCharset(buf, cs.split('*')[0]);
    });
}

/**
 * 解析头部 / Parse a header block into a map of lowercase name → values.
 * @param {string} block
 * @returns {Object<string,string[]>}
 */
function parseHeaders(block) {
  const out = {};
  for (const line of block.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    (out[k] = out[k] || []).push(line.slice(i + 1).trim());
  }
  return out;
}

/**
 * 解析 Content-Type 等带参数的头 / Parse a header value with parameters.
 * @param {string} v
 * @returns {{value:string, params:Object<string,string>}}
 */
function parseParams(v) {
  const parts = String(v || '').split(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  const params = {};
  for (const p of parts.slice(1)) {
    const i = p.indexOf('=');
    if (i < 0) continue;
    const k = p.slice(0, i).trim().toLowerCase();
    let val = p.slice(i + 1).trim().replace(/^"|"$/g, '');
    if (k.endsWith('*')) {
      // RFC 2231：charset''pct-encoded
      const m = /^([^']*)'[^']*'(.*)$/.exec(val);
      if (m) {
        const bytes = Buffer.from(m[2].replace(/%([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
        val = decodeCharset(bytes, m[1] || 'utf-8');
      }
      params[k.slice(0, -1)] = val;
    } else if (!params[k]) {
      params[k] = decodeWords(val);
    }
  }
  return { value: parts[0].trim().toLowerCase(), params };
}

/**
 * 解析 MIME 实体（递归）/ Parse a MIME entity recursively.
 * @param {Buffer} buf
 * @param {{text:string[], html:string[], attachments:object[]}} acc 累积结果 / accumulator
 * @returns {Object<string,string[]>} 头部 / headers
 */
function parseEntity(buf, acc) {
  const str = buf.toString('latin1');
  let sep = str.indexOf('\r\n\r\n');
  let sepLen = 4;
  if (sep < 0) { sep = str.indexOf('\n\n'); sepLen = 2; }
  // 头部可能含未编码的 UTF-8（RFC 6532），能按 UTF-8 解码则优先 / headers may carry raw UTF-8 (RFC 6532)
  const headRaw = sep < 0 ? buf : buf.subarray(0, sep);
  let headBlock;
  try { headBlock = new TextDecoder('utf-8', { fatal: true }).decode(headRaw); } catch { headBlock = headRaw.toString('latin1'); }
  const bodyBuf = sep < 0 ? Buffer.alloc(0) : buf.subarray(sep + sepLen);
  const headers = parseHeaders(headBlock);
  const ct = parseParams((headers['content-type'] || ['text/plain'])[0]);
  const cte = String((headers['content-transfer-encoding'] || ['7bit'])[0]).toLowerCase();
  const disp = parseParams((headers['content-disposition'] || [''])[0]);
  if (ct.value.startsWith('multipart/') && ct.params.boundary) {
    const b = '--' + ct.params.boundary;
    const body = bodyBuf.toString('latin1');
    const pieces = body.split(new RegExp(`\\r?\\n?${b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?[ \\t]*\\r?\\n?`));
    for (const piece of pieces.slice(1)) {
      if (piece.trim() === '') continue;
      parseEntity(Buffer.from(piece, 'latin1'), acc);
    }
    return headers;
  }
  let data;
  if (cte === 'base64') data = Buffer.from(bodyBuf.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  else if (cte === 'quoted-printable') data = decodeQP(bodyBuf.toString('latin1'));
  else data = bodyBuf;
  const filename = disp.params.filename || ct.params.name;
  if (filename || disp.value === 'attachment' || (!ct.value.startsWith('text/') && !ct.value.startsWith('message/'))) {
    acc.attachments.push({ filename: filename || 'attachment', contentType: ct.value, content: data });
  } else if (ct.value === 'text/html') {
    acc.html.push(decodeCharset(data, ct.params.charset));
  } else {
    acc.text.push(decodeCharset(data, ct.params.charset));
  }
  return headers;
}

/**
 * 解析完整邮件 / Parse a complete raw message.
 * @param {Buffer} raw
 * @returns {{subject:string, from:object, to:object[], cc:object[], date:string, messageId:string, text:string, attachments:object[]}}
 */
function parseMessage(raw) {
  const acc = { text: [], html: [], attachments: [] };
  const h = parseEntity(Buffer.from(raw), acc);
  const get = (k) => decodeWords((h[k] || [''])[0]);
  let text = acc.text.join('\n\n').trim();
  if (!text && acc.html.length) {
    text = acc.html.join('\n').replace(/<(style|script)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n').replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\n{3,}/g, '\n\n').trim();
  }
  const d = new Date(get('date'));
  return {
    subject: get('subject'), from: parseAddresses(get('from'))[0] || { name: '', address: '' },
    to: parseAddresses(get('to')), cc: parseAddresses(get('cc')),
    date: Number.isNaN(d.getTime()) ? '' : d.toLocaleString('sv-SE'), messageId: get('message-id'), text, attachments: acc.attachments,
  };
}

// ======================= 网络连接 / connections =======================

/**
 * 建立 TCP/TLS 连接 / Open a TCP or TLS connection.
 * @param {string} host
 * @param {number} port
 * @param {boolean} secure 是否 SSL 直连 / implicit TLS
 * @param {boolean} rejectUnauthorized 是否校验证书 / verify certificates
 * @returns {Promise<import('node:net').Socket>}
 */
function connect(host, port, secure, rejectUnauthorized) {
  return new Promise((resolve, reject) => {
    const opts = { host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized };
    const sock = secure ? tls.connect(opts) : net.connect(opts);
    sock.setTimeout(TIMEOUT, () => sock.destroy(new Error(`连接 ${host}:${port} 超时`)));
    sock.once(secure ? 'secureConnect' : 'connect', () => resolve(sock));
    sock.once('error', (e) => reject(new Error(netError(e, host, port))));
  });
}

/**
 * 把底层网络错误翻译成中文 / Translate low-level network errors into Chinese.
 * @param {Error & {code?:string}} e
 * @param {string} host
 * @param {number} port
 * @returns {string}
 */
function netError(e, host, port) {
  const map = {
    ENOTFOUND: `找不到服务器 ${host}，请检查服务器地址`,
    ECONNREFUSED: `服务器 ${host}:${port} 拒绝连接，请检查端口`,
    ETIMEDOUT: `连接 ${host}:${port} 超时`,
    DEPTH_ZERO_SELF_SIGNED_CERT: `服务器 ${host} 使用自签名证书（可在账户中关闭证书校验）`,
    SELF_SIGNED_CERT_IN_CHAIN: `服务器 ${host} 证书不受信任（可在账户中关闭证书校验）`,
    ERR_TLS_CERT_ALTNAME_INVALID: `服务器证书与地址 ${host} 不匹配`,
    EPROTO: `与 ${host}:${port} 的加密协商失败，请检查加密方式（SSL/STARTTLS）与端口是否对应`,
  };
  return map[e.code] || `${host}:${port} ${e.message}`;
}

/**
 * 在已有连接上升级 TLS（STARTTLS）/ Upgrade an existing socket to TLS.
 * @param {import('node:net').Socket} socket
 * @param {string} host
 * @param {boolean} rejectUnauthorized
 * @returns {Promise<import('node:tls').TLSSocket>}
 */
function upgradeTls(socket, host, rejectUnauthorized) {
  socket.removeAllListeners('data');
  return new Promise((resolve, reject) => {
    const s = tls.connect({ socket, servername: net.isIP(host) ? undefined : host, rejectUnauthorized });
    s.setTimeout(TIMEOUT, () => s.destroy(new Error('TLS 握手超时')));
    s.once('secureConnect', () => resolve(s));
    s.once('error', (e) => reject(new Error(netError(e, host, 0))));
  });
}

/**
 * 字节流读取器：按行或按字节数读取 / Byte stream reader by line or by length.
 */
class Reader {
  /** @param {import('node:net').Socket} sock */
  constructor(sock) {
    this.buf = Buffer.alloc(0);
    this.waiter = null;
    this.error = null;
    this.ended = false;
    sock.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this.wake(); });
    sock.on('error', (e) => { this.error = e; this.wake(); });
    sock.on('close', () => { this.ended = true; this.wake(); });
  }

  wake() {
    const w = this.waiter;
    this.waiter = null;
    if (w) w();
  }

  async wait() {
    if (this.error) throw this.error;
    if (this.ended) throw new Error('服务器已断开连接');
    await new Promise((r) => { this.waiter = r; });
  }

  /** @returns {Promise<string>} 不含换行的一行 / one line without CRLF */
  async line() {
    for (;;) {
      const i = this.buf.indexOf('\n');
      if (i >= 0) {
        const l = this.buf.subarray(0, i).toString('utf8').replace(/\r$/, '');
        this.buf = this.buf.subarray(i + 1);
        return l;
      }
      await this.wait();
    }
  }

  /** @param {number} n @returns {Promise<Buffer>} */
  async bytes(n) {
    while (this.buf.length < n) await this.wait();
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return Buffer.from(out);
  }
}

// ======================= SMTP =======================

/**
 * SMTP 会话 / SMTP session helper.
 */
class Smtp {
  /**
   * @param {object} acc 邮箱账户（含明文 password）/ account with plain password
   */
  constructor(acc) {
    this.acc = acc;
  }

  /** 读取一个完整响应 / Read one complete (possibly multi-line) reply */
  async reply() {
    const lines = [];
    for (;;) {
      const l = await this.r.line();
      lines.push(l);
      if (/^\d{3} /.test(l) || /^\d{3}$/.test(l)) return { code: Number(l.slice(0, 3)), text: lines.map((x) => x.slice(4)).join('\n') };
    }
  }

  /**
   * 发送命令并校验返回码 / Send a command and check the reply code.
   * @param {string|null} cmd 命令（null 表示只读响应）/ command or null
   * @param {number[]} ok 期望返回码 / accepted codes
   * @param {string} [label] 用于报错的步骤名 / step name for errors
   */
  async cmd(cmd, ok, label) {
    if (cmd !== null) this.sock.write(cmd + '\r\n');
    const res = await this.reply();
    if (!ok.includes(res.code)) {
      const hint = res.code === 535 || res.code === 534 ? '（账号或密码/授权码错误）' : '';
      throw new Error(`SMTP ${label || cmd.split(' ')[0]} 失败：${res.code} ${res.text}${hint}`);
    }
    return res;
  }

  /** 连接并登录 / Connect and authenticate */
  async open() {
    const a = this.acc;
    const reject = a.tls_reject_unauthorized !== 0;
    this.sock = await connect(a.smtp_host, a.smtp_port, a.smtp_secure === 'ssl', reject);
    this.r = new Reader(this.sock);
    await this.cmd(null, [220], '连接');
    let ehlo = await this.cmd('EHLO yonlink-erp.local', [250]);
    if (a.smtp_secure === 'starttls') {
      if (!/STARTTLS/i.test(ehlo.text)) throw new Error('SMTP 服务器不支持 STARTTLS，请改用 SSL 或检查端口');
      await this.cmd('STARTTLS', [220]);
      this.sock = await upgradeTls(this.sock, a.smtp_host, reject);
      this.r = new Reader(this.sock);
      ehlo = await this.cmd('EHLO yonlink-erp.local', [250]);
    }
    if (a.username) {
      if (/AUTH[ =][^\n]*PLAIN/i.test(ehlo.text)) {
        await this.cmd('AUTH PLAIN ' + Buffer.from(`\0${a.username}\0${a.password}`).toString('base64'), [235], '登录');
      } else {
        await this.cmd('AUTH LOGIN', [334], '登录');
        await this.cmd(Buffer.from(a.username).toString('base64'), [334], '登录');
        await this.cmd(Buffer.from(a.password).toString('base64'), [235], '登录');
      }
    }
  }

  /**
   * 投递邮件 / Deliver one message.
   * @param {string} from 信封发件人 / envelope sender
   * @param {string[]} rcpts 信封收件人 / envelope recipients
   * @param {Buffer} raw 原文 / raw message
   */
  async send(from, rcpts, raw) {
    await this.cmd(`MAIL FROM:<${from}>`, [250]);
    for (const r of rcpts) await this.cmd(`RCPT TO:<${r}>`, [250, 251], `收件人 ${r}`);
    await this.cmd('DATA', [354]);
    const body = raw.toString('utf8').replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
    this.sock.write(body.endsWith('\r\n') ? body : body + '\r\n');
    await this.cmd('.', [250], '投递');
  }

  async close() {
    try { this.sock.write('QUIT\r\n'); } catch { /* 忽略 / ignore */ }
    this.sock.end();
  }
}

/**
 * 发送一封邮件 / Send one email.
 * @param {object} acc 账户（明文密码）/ account with plain password
 * @param {object} msg 见 buildMessage / see buildMessage
 * @returns {Promise<{messageId:string, raw:Buffer}>}
 */
async function sendMail(acc, msg) {
  const built = buildMessage(msg);
  const s = new Smtp(acc);
  try {
    await s.open();
    await s.send(msg.from.address, [...msg.to, ...(msg.cc || [])].map((x) => x.address), built.raw);
  } finally {
    if (s.sock) await s.close();
  }
  return built;
}

/**
 * 仅测试 SMTP 登录 / Test SMTP login only.
 * @param {object} acc
 */
async function testSmtp(acc) {
  const s = new Smtp(acc);
  try { await s.open(); } finally { if (s.sock) await s.close(); }
}

// ======================= IMAP =======================

/** IMAP 字符串加引号 / Quote an IMAP string */
const iq = (s) => '"' + String(s).replace(/[\\"]/g, '\\$&') + '"';

/**
 * IMAP 会话 / IMAP session helper.
 */
class Imap {
  /** @param {object} acc 账户（明文密码）/ account with plain password */
  constructor(acc) {
    this.acc = acc;
    this.seq = 0;
  }

  async open() {
    const a = this.acc;
    const reject = a.tls_reject_unauthorized !== 0;
    this.sock = await connect(a.imap_host, a.imap_port, a.imap_secure === 'ssl', reject);
    this.r = new Reader(this.sock);
    const greet = await this.r.line();
    if (!/^\* (OK|PREAUTH)/i.test(greet)) throw new Error('IMAP 服务器响应异常：' + greet);
    if (a.imap_secure === 'starttls') {
      await this.cmd('STARTTLS');
      this.sock = await upgradeTls(this.sock, a.imap_host, reject);
      this.r = new Reader(this.sock);
    }
    try {
      await this.cmd(`LOGIN ${iq(a.username || a.email)} ${iq(a.password)}`);
    } catch (e) {
      throw new Error('IMAP 登录失败（账号或密码/授权码错误，或未开启 IMAP 服务）：' + e.message.replace(/^IMAP 命令失败：/, ''));
    }
  }

  /**
   * 执行命令，返回未标记响应（含字面量）/ Run a command and collect untagged responses with literals.
   * @param {string} command
   * @returns {Promise<{text:string, literals:Buffer[]}[]>}
   */
  async cmd(command) {
    const tag = 'E' + (++this.seq);
    this.sock.write(`${tag} ${command}\r\n`);
    const items = [];
    for (;;) {
      let line = await this.r.line();
      if (line.startsWith(tag + ' ')) {
        if (!/^\S+ OK/i.test(line)) throw new Error('IMAP 命令失败：' + line.slice(tag.length + 1));
        return items;
      }
      const item = { text: '', literals: [] };
      for (;;) {
        const m = /\{(\d+)\}$/.exec(line);
        item.text += line;
        if (!m) break;
        item.literals.push(await this.r.bytes(Number(m[1])));
        line = await this.r.line();
      }
      items.push(item);
    }
  }

  async close() {
    try { this.sock.write(`E${++this.seq} LOGOUT\r\n`); } catch { /* 忽略 / ignore */ }
    this.sock.end();
  }
}

/**
 * 收取新邮件 / Fetch new messages from INBOX.
 * @param {object} acc 账户（明文密码，含 last_uid/uidvalidity）/ account with plain password and sync state
 * @param {{initialSync?:number, max?:number}} [opts] 首次同步封数、单次上限 / initial sync count, per-run cap
 * @returns {Promise<{uidvalidity:number, lastUid:number, messages:{uid:number, raw:Buffer}[]}>}
 */
async function fetchNew(acc, opts = {}) {
  const im = new Imap(acc);
  try {
    await im.open();
    const sel = await im.cmd('SELECT INBOX');
    const uv = Number((/UIDVALIDITY (\d+)/i.exec(sel.map((x) => x.text).join('\n')) || [])[1] || 0);
    let last = acc.uidvalidity && uv && Number(acc.uidvalidity) !== uv ? 0 : Number(acc.last_uid || 0);
    const search = last > 0 ? await im.cmd(`UID SEARCH UID ${last + 1}:*`) : await im.cmd('UID SEARCH ALL');
    let uids = search.filter((x) => /^\* SEARCH/i.test(x.text)).flatMap((x) => x.text.replace(/^\* SEARCH/i, '').trim().split(/\s+/)).filter(Boolean).map(Number)
      .filter((u) => u > last).sort((a, b) => a - b);
    if (last === 0) uids = uids.slice(-(opts.initialSync || 50));
    uids = uids.slice(0, opts.max || 200);
    const messages = [];
    for (const uid of uids) {
      const res = await im.cmd(`UID FETCH ${uid} (UID BODY.PEEK[])`);
      const item = res.find((x) => x.literals.length);
      if (item) messages.push({ uid, raw: item.literals[0] });
      last = Math.max(last, uid);
    }
    return { uidvalidity: uv, lastUid: last, messages };
  } finally {
    if (im.sock) await im.close();
  }
}

/**
 * 仅测试 IMAP 登录 / Test IMAP login only.
 * @param {object} acc
 */
async function testImap(acc) {
  const im = new Imap(acc);
  try { await im.open(); await im.cmd('SELECT INBOX'); } finally { if (im.sock) await im.close(); }
}

/** 常用企业邮箱服务器 / Well-known provider presets */
const PRESETS = {
  腾讯企业邮: { smtp_host: 'smtp.exmail.qq.com', smtp_port: 465, smtp_secure: 'ssl', imap_host: 'imap.exmail.qq.com', imap_port: 993, imap_secure: 'ssl', mx: /exmail\.qq\.com|mxbiz\d?\.qq\.com/ },
  QQ邮箱: { smtp_host: 'smtp.qq.com', smtp_port: 465, smtp_secure: 'ssl', imap_host: 'imap.qq.com', imap_port: 993, imap_secure: 'ssl', mx: /^mx\d?\.qq\.com/ },
  阿里企业邮: { smtp_host: 'smtp.qiye.aliyun.com', smtp_port: 465, smtp_secure: 'ssl', imap_host: 'imap.qiye.aliyun.com', imap_port: 993, imap_secure: 'ssl', mx: /mxhichina\.com|qiye\.aliyun/ },
  网易企业邮: { smtp_host: 'smtp.qiye.163.com', smtp_port: 465, smtp_secure: 'ssl', imap_host: 'imap.qiye.163.com', imap_port: 993, imap_secure: 'ssl', mx: /qiye\.163\.com|ym\.163\.com/ },
  '163邮箱': { smtp_host: 'smtp.163.com', smtp_port: 465, smtp_secure: 'ssl', imap_host: 'imap.163.com', imap_port: 993, imap_secure: 'ssl', mx: /163mx/ },
  Gmail: { smtp_host: 'smtp.gmail.com', smtp_port: 465, smtp_secure: 'ssl', imap_host: 'imap.gmail.com', imap_port: 993, imap_secure: 'ssl', mx: /google\.com|googlemail/ },
  'Outlook/Microsoft 365': { smtp_host: 'smtp.office365.com', smtp_port: 587, smtp_secure: 'starttls', imap_host: 'outlook.office365.com', imap_port: 993, imap_secure: 'ssl', mx: /outlook\.com|protection\.outlook/ },
  Zoho: { smtp_host: 'smtp.zoho.com', smtp_port: 465, smtp_secure: 'ssl', imap_host: 'imap.zoho.com', imap_port: 993, imap_secure: 'ssl', mx: /zoho/ },
};

module.exports = {
  encryptSecret, decryptSecret, encodeWord, parseAddresses, isEmail, buildMessage, parseMessage, decodeWords,
  sendMail, testSmtp, fetchNew, testImap, PRESETS,
};
