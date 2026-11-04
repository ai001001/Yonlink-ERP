'use strict';
/**
 * 外部集成路由：企业邮箱收发、文件与样品图片、汇率自动更新
 * Integration routes: company mailbox send/receive, files & sample images, automatic exchange rates.
 * @module server/routes/integrations
 */
const { HttpError } = require('../http');
const { need, can, log, num, required, today } = require('../core');
const { ENTITIES } = require('../entities');
const { scopeClause } = require('./base');
const mail = require('../mail');
const { updateRates } = require('../rates');

/** 演示版拦截真实邮箱操作 / Block real-mailbox operations in the browser demo */
function assertNotDemo() {
  if (globalThis.__ERP_DEMO) throw new HttpError(400, '在线演示版运行在浏览器中，无法连接真实邮箱服务器。请在正式服务器版本中配置邮箱账户。');
}

/** 单个附件/图片大小上限 / Size limits */
const MAX_ATTACHMENT = 15 * 1024 * 1024;
const MAX_IMAGE = 5 * 1024 * 1024;

/**
 * 读取邮箱账户（校验使用权）/ Load a mailbox account and check usage rights.
 * @param {object} ctx
 * @param {number|string} id
 * @returns {object}
 */
function getAccount(ctx, id) {
  const a = ctx.db.prepare('SELECT * FROM mail_accounts WHERE id=?').get(id);
  if (!a) throw new HttpError(404, '邮箱账户不存在');
  if (!can(ctx.user, 'system', 'edit') && a.owner_user_id !== ctx.user.id) throw new HttpError(403, '只能使用本人的邮箱账户');
  return a;
}

/** 返回给前端的账户（隐藏密码）/ Account as returned to clients (password hidden) */
const publicAccount = (a) => {
  const { password_enc: pw, ...rest } = a;
  return { ...rest, has_password: !!pw };
};

/**
 * 解密得到可连接的账户 / Account with decrypted password for connecting.
 * @param {object} ctx
 * @param {object} a
 * @returns {object}
 */
function plainAccount(config, a) {
  let password = '';
  try { password = mail.decryptSecret(a.password_enc, config.secret); } catch { throw new HttpError(400, `邮箱 ${a.email} 的密码无法解密（系统密钥已变更），请重新填写密码`); }
  return { ...a, password };
}

/** 按关键词判断邮件分类 / Guess a mail category from keywords */
function guessCategory(text) {
  const t = String(text).toLowerCase();
  if (/询价|inquiry|enquiry|rfq|request for quot/.test(t)) return '询盘';
  if (/报价|quotation|price list|\bquote\b|qt\d{8}/.test(t)) return '报价';
  if (/样品|送样|sample/.test(t)) return '样品';
  if (/出货|发货|shipment|shipping|b\/l|bill of lading|装柜/.test(t)) return '出货';
  if (/订单|purchase order|\bp\.?o\.?\b|so\d{8}|order/.test(t)) return '订单';
  if (/投诉|破损|complain|damage|claim/.test(t)) return '售后';
  return '其它';
}

/**
 * 根据地址与内容自动绑定客户/报价/订单/样品
 * Auto-bind customer, quote, order and sample from addresses and content.
 * @param {object} db
 * @param {string[]} addresses 往来邮箱 / counterpart addresses
 * @param {string} text 主题+正文 / subject + body
 * @returns {{customer_id:number|null, quote_id:number|null, order_id:number|null, sample_id:number|null}}
 */
function autoBind(db, addresses, text) {
  const out = { customer_id: null, quote_id: null, order_id: null, sample_id: null };
  const addrs = addresses.filter(Boolean).map((a) => a.toLowerCase());
  if (addrs.length) {
    const c = db.prepare(`SELECT id FROM customers WHERE lower(email) IN (${addrs.map(() => '?').join(',')}) LIMIT 1`).get(...addrs);
    if (c) out.customer_id = c.id;
  }
  const q = /QT\d{8}-\d{3}/.exec(text);
  if (q) {
    const r = db.prepare('SELECT id, customer_id FROM quotes WHERE quote_no=?').get(q[0]);
    if (r) { out.quote_id = r.id; out.customer_id = out.customer_id || r.customer_id; }
  }
  const o = /SO\d{8}-\d{3}/.exec(text);
  if (o) {
    const r = db.prepare('SELECT id, customer_id FROM orders WHERE order_no=?').get(o[0]);
    if (r) { out.order_id = r.id; out.customer_id = out.customer_id || r.customer_id; }
  }
  const upper = String(text).toUpperCase();
  const samples = db.prepare('SELECT id, company_no FROM samples ORDER BY length(company_no) DESC').all();
  const s = samples.find((x) => x.company_no && new RegExp(`(^|[^A-Z0-9-])${x.company_no.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Z0-9-])`).test(upper));
  if (s) out.sample_id = s.id;
  return out;
}

/**
 * 保存文件到数据库 / Store a file in the database.
 * @param {object} db
 * @param {{name:string, mime:string, data:Uint8Array, owner_type:string, owner_id:number, user:string}} f
 * @returns {number} 文件ID / file id
 */
function saveFile(db, f) {
  return Number(db.prepare('INSERT INTO files(name,mime,size,data,owner_type,owner_id,created_by) VALUES(?,?,?,?,?,?,?)')
    .run(f.name, f.mime, f.data.length, f.data, f.owner_type, f.owner_id, f.user).lastInsertRowid);
}

/**
 * 收取一个账户的新邮件并入库 / Fetch an account's new mail and store it.
 * @param {object} db
 * @param {object} config 应用配置（含 secret）/ app config with secret
 * @param {object} acc 账户行 / account row
 * @param {string} userName 操作人 / operator
 * @returns {Promise<{fetched:number, duplicates:number}>}
 */
async function fetchAccount(db, config, acc, userName) {
  assertNotDemo();
  const setting = (k, d) => (db.prepare('SELECT value FROM settings WHERE key=?').get(k) || {}).value || d;
  const now = () => new Date().toLocaleString('sv-SE');
  try {
    const res = await mail.fetchNew(plainAccount(config, acc), { initialSync: num(setting('mail_initial_sync', '50')) || 50 });
    let fetched = 0;
    let duplicates = 0;
    for (const m of res.messages) {
      const p = mail.parseMessage(m.raw);
      if (p.messageId && db.prepare('SELECT 1 FROM mails WHERE account_id=? AND message_id=?').get(acc.id, p.messageId)) { duplicates++; continue; }
      const text = `${p.subject}\n${p.text}`;
      const counterpart = [p.from.address, ...p.to.map((x) => x.address), ...p.cc.map((x) => x.address)].filter((a) => a && a !== acc.email.toLowerCase());
      const bind = autoBind(db, counterpart, text);
      const fmt = (a) => (a.name ? `${a.name} <${a.address}>` : a.address);
      const id = Number(db.prepare(`INSERT INTO mails(direction,mail_from,mail_to,mail_cc,subject,body,category,customer_id,sample_id,quote_id,order_id,user_name,account_id,status,message_id,uid,mail_date)
        VALUES('收件',?,?,?,?,?,?,?,?,?,?,?,?,'已接收',?,?,?)`).run(fmt(p.from), p.to.map(fmt).join(', '), p.cc.map(fmt).join(', '), p.subject || '(无主题)', p.text.slice(0, 100000),
        guessCategory(text), bind.customer_id, bind.sample_id, bind.quote_id, bind.order_id, userName, acc.id, p.messageId || null, m.uid, p.date || now()).lastInsertRowid);
      const atts = [];
      for (const a of p.attachments) {
        if (a.content.length > MAX_ATTACHMENT) { atts.push({ name: a.filename, size: a.content.length, skipped: '超过15MB未保存' }); continue; }
        const fid = saveFile(db, { name: a.filename, mime: a.contentType, data: a.content, owner_type: 'mail', owner_id: id, user: userName });
        atts.push({ file_id: fid, name: a.filename, size: a.content.length });
      }
      if (atts.length) db.prepare('UPDATE mails SET attachments=? WHERE id=?').run(JSON.stringify(atts), id);
      fetched++;
    }
    db.prepare('UPDATE mail_accounts SET last_uid=?, uidvalidity=?, last_fetch_at=?, last_error=NULL WHERE id=?').run(res.lastUid, res.uidvalidity, now(), acc.id);
    return { fetched, duplicates };
  } catch (e) {
    db.prepare('UPDATE mail_accounts SET last_fetch_at=?, last_error=? WHERE id=?').run(now(), e.message, acc.id);
    throw e;
  }
}

/**
 * 发送邮件并记录 / Send an email and record it.
 * @param {object} ctx
 * @param {object} acc 账户行 / account row
 * @param {object} m {to, cc, subject, body, customer_id, sample_id, quote_id, order_id, attachments}
 * @returns {Promise<object>} 邮件记录 / mail row
 */
async function sendAndRecord(ctx, acc, m) {
  assertNotDemo();
  const to = mail.parseAddresses(m.to);
  const cc = mail.parseAddresses(m.cc);
  if (!to.length) throw new HttpError(400, '请填写收件人');
  const bad = [...to, ...cc].filter((a) => !mail.isEmail(a.address));
  if (bad.length) throw new HttpError(400, `邮箱地址格式错误：${bad.map((a) => a.address).join('、')}`);
  if (!String(m.subject || '').trim()) throw new HttpError(400, '请填写邮件主题');
  const atts = m.attachments || [];
  const text = `${m.subject}\n${m.body || ''}`;
  const auto = autoBind(ctx.db, [...to, ...cc].map((a) => a.address), text);
  const pick = (k) => (m[k] ? Number(m[k]) : auto[k]);
  const fmt = (a) => (a.name ? `${a.name} <${a.address}>` : a.address);
  const id = Number(ctx.db.prepare(`INSERT INTO mails(direction,mail_from,mail_to,mail_cc,subject,body,category,customer_id,sample_id,quote_id,order_id,user_name,account_id,status,mail_date)
    VALUES('发件',?,?,?,?,?,?,?,?,?,?,?,?,'发送中',?)`).run(acc.display_name ? `${acc.display_name} <${acc.email}>` : acc.email, to.map(fmt).join(', '), cc.map(fmt).join(', '),
    m.subject, m.body || '', m.category || guessCategory(text), pick('customer_id'), pick('sample_id'), pick('quote_id'), pick('order_id'), ctx.user.name, acc.id,
    new Date().toLocaleString('sv-SE')).lastInsertRowid);
  const saved = atts.map((a) => ({ file_id: saveFile(ctx.db, { name: a.filename, mime: a.contentType, data: a.content, owner_type: 'mail', owner_id: id, user: ctx.user.name }), name: a.filename, size: a.content.length }));
  if (saved.length) ctx.db.prepare('UPDATE mails SET attachments=? WHERE id=?').run(JSON.stringify(saved), id);
  try {
    const r = await mail.sendMail(plainAccount(ctx.config, acc), { from: { name: acc.display_name || '', address: acc.email }, to, cc, subject: m.subject, text: m.body || '', attachments: atts });
    ctx.db.prepare("UPDATE mails SET status='已发送', message_id=?, error=NULL WHERE id=?").run(r.messageId, id);
    log(ctx, 'mail', '发送邮件', m.subject, `${acc.email} → ${to.map((a) => a.address).join(',')}`);
  } catch (e) {
    ctx.db.prepare("UPDATE mails SET status='发送失败', error=? WHERE id=?").run(e.message, id);
    log(ctx, 'mail', '邮件发送失败', m.subject, e.message);
    throw new HttpError(502, '邮件发送失败：' + e.message, { mail_id: id });
  }
  return ctx.db.prepare('SELECT * FROM mails WHERE id=?').get(id);
}

/**
 * 邮件可见性校验 / Check that a mail is visible to the current user.
 * @param {object} ctx
 * @param {number|string} id
 * @returns {object}
 */
function getMail(ctx, id) {
  const sc = scopeClause(ctx, ENTITIES.mail.scope);
  const m = ctx.db.prepare(`SELECT * FROM mails WHERE id=?${sc.sql ? ' AND ' + sc.sql : ''}`).get(id, ...sc.params);
  if (!m) throw new HttpError(404, '邮件不存在或无权查看');
  return m;
}

/** 根据文件头识别图片类型 / Detect image type from magic bytes */
function imageMime(b) {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

/**
 * 读取有权限的样品 / Load a sample visible to the current user.
 * @param {object} ctx
 * @param {number|string} id
 * @returns {object}
 */
function getSample(ctx, id) {
  const sc = scopeClause(ctx, ENTITIES.sample.scope);
  const s = ctx.db.prepare(`SELECT * FROM samples WHERE id=?${sc.sql ? ' AND ' + sc.sql : ''}`).get(id, ...sc.params);
  if (!s) throw new HttpError(404, '样品不存在或无权查看');
  return s;
}

const imageList = (s) => String(s.images || '').split(/[,，\s]+/).filter(Boolean);

/**
 * 注册集成路由 / Register integration routes.
 * @param {import('../http').Router} r
 */
function register(r) {
  // ---------- 邮箱账户 / mailbox accounts ----------
  r.get('/api/mail-accounts', (ctx) => {
    need(ctx, 'mail', 'view');
    const all = can(ctx.user, 'system', 'edit');
    const rows = ctx.db.prepare(`SELECT a.*, u.name owner_name FROM mail_accounts a LEFT JOIN users u ON u.id=a.owner_user_id ${all ? '' : 'WHERE a.owner_user_id=?'} ORDER BY a.id`)
      .all(...(all ? [] : [ctx.user.id]));
    return { rows: rows.map(publicAccount), demo: !!globalThis.__ERP_DEMO };
  });
  r.get('/api/mail-presets', async (ctx) => {
    need(ctx, 'mail', 'view');
    const presets = Object.fromEntries(Object.entries(mail.PRESETS).map(([k, v]) => { const { mx, ...rest } = v; return [k, rest]; }));
    const email = String(ctx.query.email || '').trim().toLowerCase();
    const out = { presets, suggestion: null, mx: [], note: '' };
    if (!email.includes('@') || globalThis.__ERP_DEMO) return out;
    const domain = email.split('@')[1];
    try {
      const dns = require('node:dns').promises;
      out.mx = (await dns.resolveMx(domain)).sort((a, b) => a.priority - b.priority).map((x) => x.exchange.toLowerCase());
    } catch {
      out.note = `无法查询 ${domain} 的邮件服务器（MX）记录`;
      return out;
    }
    const hit = Object.entries(mail.PRESETS).find(([, v]) => out.mx.some((m) => v.mx.test(m)));
    if (hit) {
      out.suggestion = hit[0];
      out.note = `已根据 MX 记录识别为【${hit[0]}】，已填入服务器参数。多数服务商需在邮箱设置中开启 IMAP/SMTP 并使用“授权码”作为密码。`;
    } else if (out.mx.some((m) => /mx\.cloudflare\.net/.test(m))) {
      out.note = `${domain} 使用 Cloudflare 邮件路由：该服务只把邮件转发到您的另一个真实邮箱，本身不提供收件箱(IMAP)与发信(SMTP)。`
        + '请：① 收信服务器填写“转发目标邮箱”（如 QQ/Gmail）的 IMAP 参数；② 发信服务器填写支持以本地址发信的 SMTP 服务（如 Gmail“以其他地址发送”、阿里云邮件推送、SendGrid 等）。';
    } else {
      out.note = `未识别的邮件服务商（MX：${out.mx.join(', ')}），请向服务商获取 SMTP/IMAP 服务器地址与端口。`;
    }
    return out;
  });
  const saveAccount = (ctx, id) => {
    assertNotDemo();
    const b = ctx.body;
    required(b, { email: '邮箱地址', smtp_host: 'SMTP 服务器', smtp_port: 'SMTP 端口', imap_host: 'IMAP 服务器', imap_port: 'IMAP 端口' });
    const email = String(b.email).trim().toLowerCase();
    if (!mail.isEmail(email)) throw new HttpError(400, '邮箱地址格式错误');
    for (const k of ['smtp_secure', 'imap_secure']) if (b[k] && !['ssl', 'starttls', 'none'].includes(b[k])) throw new HttpError(400, '加密方式无效');
    const old = id ? getAccount(ctx, id) : null;
    if (!old && !b.password) throw new HttpError(400, '请填写邮箱密码或授权码');
    const owner = can(ctx.user, 'system', 'edit') && b.owner_user_id ? Number(b.owner_user_id) : (old ? old.owner_user_id : ctx.user.id);
    const row = {
      email, display_name: b.display_name || '', owner_user_id: owner,
      smtp_host: String(b.smtp_host).trim(), smtp_port: num(b.smtp_port), smtp_secure: b.smtp_secure || 'ssl',
      imap_host: String(b.imap_host).trim(), imap_port: num(b.imap_port), imap_secure: b.imap_secure || 'ssl',
      username: String(b.username || email).trim(),
      tls_reject_unauthorized: b.tls_reject_unauthorized === false || b.tls_reject_unauthorized === 0 || b.tls_reject_unauthorized === '0' ? 0 : 1,
      enabled: b.enabled === false || b.enabled === 0 || b.enabled === '0' ? 0 : 1,
      auto_fetch: b.auto_fetch === false || b.auto_fetch === 0 || b.auto_fetch === '0' ? 0 : 1,
    };
    if (b.password) row.password_enc = mail.encryptSecret(b.password, ctx.config.secret);
    const cols = Object.keys(row);
    try {
      if (old) {
        const serverChanged = old.imap_host !== row.imap_host || old.username !== row.username;
        ctx.db.prepare(`UPDATE mail_accounts SET ${cols.map((c) => `${c}=?`).join(',')}${serverChanged ? ', last_uid=0, uidvalidity=NULL' : ''} WHERE id=?`).run(...cols.map((c) => row[c]), old.id);
        log(ctx, 'mail', '修改邮箱账户', email);
        return publicAccount(ctx.db.prepare('SELECT * FROM mail_accounts WHERE id=?').get(old.id));
      }
      const res = ctx.db.prepare(`INSERT INTO mail_accounts(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`).run(...cols.map((c) => row[c]));
      log(ctx, 'mail', '新增邮箱账户', email);
      return publicAccount(ctx.db.prepare('SELECT * FROM mail_accounts WHERE id=?').get(res.lastInsertRowid));
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) throw new HttpError(409, '该邮箱账户已存在');
      throw e;
    }
  };
  r.post('/api/mail-accounts', (ctx) => { need(ctx, 'mail', 'add'); return saveAccount(ctx); });
  r.put('/api/mail-accounts/:id', (ctx) => { need(ctx, 'mail', 'edit'); return saveAccount(ctx, ctx.params.id); });
  r.del('/api/mail-accounts/:id', (ctx) => {
    need(ctx, 'mail', 'edit');
    const a = getAccount(ctx, ctx.params.id);
    ctx.db.prepare('DELETE FROM mail_accounts WHERE id=?').run(a.id);
    log(ctx, 'mail', '删除邮箱账户', a.email);
    return { ok: true };
  });
  r.post('/api/mail-accounts/:id/test', async (ctx) => {
    need(ctx, 'mail', 'view');
    assertNotDemo();
    const a = plainAccount(ctx.config, getAccount(ctx, ctx.params.id));
    const out = {};
    try { await mail.testSmtp(a); out.smtp = { ok: true, message: `SMTP ${a.smtp_host}:${a.smtp_port} 登录成功` }; } catch (e) { out.smtp = { ok: false, message: e.message }; }
    try { await mail.testImap(a); out.imap = { ok: true, message: `IMAP ${a.imap_host}:${a.imap_port} 登录成功` }; } catch (e) { out.imap = { ok: false, message: e.message }; }
    return out;
  });
  r.post('/api/mail-accounts/:id/fetch', async (ctx) => {
    need(ctx, 'mail', 'view');
    const a = getAccount(ctx, ctx.params.id);
    try {
      const res = await fetchAccount(ctx.db, ctx.config, a, ctx.user.name);
      log(ctx, 'mail', '收取邮件', a.email, res);
      return res;
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(502, `收取 ${a.email} 失败：${e.message}`);
    }
  });
  r.post('/api/mail-fetch-all', async (ctx) => {
    need(ctx, 'mail', 'view');
    assertNotDemo();
    const all = can(ctx.user, 'system', 'edit');
    const accs = ctx.db.prepare(`SELECT * FROM mail_accounts WHERE enabled=1 ${all ? '' : 'AND owner_user_id=?'}`).all(...(all ? [] : [ctx.user.id]));
    if (!accs.length) throw new HttpError(400, '还没有可用的邮箱账户，请先在「邮箱账户」中添加');
    const results = [];
    for (const a of accs) {
      try { results.push({ email: a.email, ok: true, ...(await fetchAccount(ctx.db, ctx.config, a, ctx.user.name)) }); } catch (e) { results.push({ email: a.email, ok: false, error: e.message }); }
    }
    return { results };
  });

  // ---------- 邮件 / mails ----------
  r.get('/api/mails', (ctx) => {
    need(ctx, 'mail', 'view');
    const q = ctx.query;
    const where = [];
    const params = [];
    const sc = scopeClause(ctx, ENTITIES.mail.scope);
    if (sc.sql) { where.push(`m.id IN (SELECT id FROM mails WHERE ${sc.sql})`); params.push(...sc.params); }
    if (q.folder === '收件' || q.folder === '发件') { where.push('m.direction=?'); params.push(q.folder); }
    if (q.folder === '发送失败') where.push("m.status='发送失败'");
    if (q.folder === '未绑定') where.push('m.customer_id IS NULL');
    if (q.account_id) { where.push('m.account_id=?'); params.push(q.account_id); }
    if (q.customer_id) { where.push('m.customer_id=?'); params.push(q.customer_id); }
    if (q.q) { where.push('(m.subject LIKE ? OR m.mail_from LIKE ? OR m.mail_to LIKE ? OR m.body LIKE ?)'); params.push(...Array(4).fill(`%${q.q}%`)); }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const size = Math.min(200, num(q.size) || 50);
    const page = Math.max(1, num(q.page) || 1);
    const total = ctx.db.prepare(`SELECT COUNT(*) c FROM mails m ${w}`).get(...params).c;
    const rows = ctx.db.prepare(`SELECT m.id, m.direction, m.mail_from, m.mail_to, m.subject, m.category, m.status, m.error, m.attachments, m.created_at, m.mail_date, m.account_id,
        c.name customer_name, q.quote_no, o.order_no, s.company_no sample_no, a.email account_email
      FROM mails m LEFT JOIN customers c ON c.id=m.customer_id LEFT JOIN quotes q ON q.id=m.quote_id LEFT JOIN orders o ON o.id=m.order_id
      LEFT JOIN samples s ON s.id=m.sample_id LEFT JOIN mail_accounts a ON a.id=m.account_id ${w}
      ORDER BY COALESCE(m.mail_date, m.created_at) DESC, m.id DESC LIMIT ? OFFSET ?`).all(...params, size, (page - 1) * size);
    for (const x of rows) x.attachment_count = x.attachments ? JSON.parse(x.attachments).length : 0;
    return { rows, total };
  });
  r.get('/api/mails/:id', (ctx) => {
    need(ctx, 'mail', 'view');
    const m = getMail(ctx, ctx.params.id);
    m.attachments = m.attachments ? JSON.parse(m.attachments) : [];
    // 绑定对象名称（即使不在当前用户可选范围内也要显示，避免误清空）/ labels of bound records, shown even outside the user's options
    const one = (sql, id) => (id ? (ctx.db.prepare(sql).get(id) || {}).label : null);
    m.labels = {
      customer_id: one("SELECT name || ' / ' || code label FROM customers WHERE id=?", m.customer_id),
      sample_id: one("SELECT company_no || ' ' || name label FROM samples WHERE id=?", m.sample_id),
      quote_id: one('SELECT quote_no label FROM quotes WHERE id=?', m.quote_id),
      order_id: one('SELECT order_no label FROM orders WHERE id=?', m.order_id),
    };
    return m;
  });
  r.post('/api/mails/send', async (ctx) => {
    need(ctx, 'mail', 'add');
    required(ctx.body, { account_id: '发件邮箱' });
    const acc = getAccount(ctx, ctx.body.account_id);
    if (!acc.enabled) throw new HttpError(400, '该邮箱账户已停用');
    return sendAndRecord(ctx, acc, ctx.body);
  });
  r.post('/api/mails/:id/resend', async (ctx) => {
    need(ctx, 'mail', 'add');
    const m = getMail(ctx, ctx.params.id);
    if (m.status !== '发送失败') throw new HttpError(409, '只有发送失败的邮件可以重发');
    const acc = getAccount(ctx, m.account_id);
    const atts = (m.attachments ? JSON.parse(m.attachments) : []).filter((a) => a.file_id).map((a) => {
      const f = ctx.db.prepare('SELECT * FROM files WHERE id=?').get(a.file_id);
      return { filename: f.name, contentType: f.mime, content: Buffer.from(f.data) };
    });
    const sent = await sendAndRecord(ctx, acc, { to: m.mail_to, cc: m.mail_cc, subject: m.subject, body: m.body, customer_id: m.customer_id, sample_id: m.sample_id, quote_id: m.quote_id, order_id: m.order_id, attachments: atts, category: m.category });
    ctx.db.prepare('DELETE FROM files WHERE owner_type=? AND owner_id=?').run('mail', m.id);
    ctx.db.prepare('DELETE FROM mails WHERE id=?').run(m.id);
    return sent;
  });
  r.post('/api/inquiries/:id/email', async (ctx) => {
    need(ctx, 'quote', 'edit');
    need(ctx, 'mail', 'add');
    const { getInquiry, inquiryXlsx } = require('./sales');
    const inq = getInquiry(ctx, ctx.params.id);
    required(ctx.body, { account_id: '发件邮箱' });
    const acc = getAccount(ctx, ctx.body.account_id);
    const sup = ctx.db.prepare('SELECT * FROM suppliers WHERE id=?').get(inq.supplier_id);
    const to = ctx.body.to || sup.email;
    if (!to) throw new HttpError(400, `厂家【${sup.name}】没有登记邮箱，请先在供应商档案中填写或手动输入收件人`);
    const unit = ctx.body.unit === 'inch' ? 'inch' : 'cm';
    const file = { filename: `${inq.inquiry_no}_${unit === 'inch' ? '英寸版' : '厘米版'}.xlsx`, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', content: inquiryXlsx(ctx.db, inq, unit) };
    const sent = await sendAndRecord(ctx, acc, {
      to, cc: ctx.body.cc, subject: ctx.body.subject || `询价单 ${inq.inquiry_no}`, category: '报价', quote_id: inq.quote_id,
      body: ctx.body.body || `${sup.contact || sup.name} 您好：\n\n附件为询价单 ${inq.inquiry_no}，请在 ${inq.valid_until || today(7)} 前回复工厂单价与交期。\n\n谢谢！\n${ctx.user.name}`,
      attachments: [file],
    });
    if (inq.status === '待发送') ctx.db.prepare("UPDATE inquiries SET status='已发送', sent_at=datetime('now','localtime') WHERE id=?").run(inq.id);
    log(ctx, 'quote', '邮件发送询价单', inq.inquiry_no, to);
    return sent;
  });

  // ---------- 文件 / files ----------
  r.get('/api/files/:id', (ctx) => {
    const f = ctx.db.prepare('SELECT * FROM files WHERE id=?').get(ctx.params.id);
    if (!f) throw new HttpError(404, '文件不存在');
    if (f.owner_type === 'sample') { need(ctx, 'sample', 'view'); getSample(ctx, f.owner_id); }
    else if (f.owner_type === 'mail') { need(ctx, 'mail', 'view'); getMail(ctx, f.owner_id); }
    else throw new HttpError(403, '无权访问该文件');
    return { __file: { buf: f.data, name: f.name, type: f.mime || 'application/octet-stream' } };
  });
  r.post('/api/samples/:id/images', (ctx) => {
    need(ctx, 'sample', 'edit');
    const s = getSample(ctx, ctx.params.id);
    required(ctx.body, { data: '图片数据' });
    const b64 = String(ctx.body.data).replace(/^data:[^;]+;base64,/, '');
    const data = Buffer.from(b64, 'base64');
    if (!data.length) throw new HttpError(400, '图片数据为空');
    if (data.length > MAX_IMAGE) throw new HttpError(413, `图片过大（${(data.length / 1048576).toFixed(1)}MB），单张不超过5MB`);
    const mime = imageMime(data);
    if (!mime) throw new HttpError(400, '仅支持 JPG、PNG、GIF、WEBP 格式的图片');
    const name = String(ctx.body.name || 'image').slice(0, 120);
    const fid = saveFile(ctx.db, { name, mime, data, owner_type: 'sample', owner_id: s.id, user: ctx.user.name });
    const images = [...imageList(s), `file:${fid}`];
    ctx.db.prepare('UPDATE samples SET images=? WHERE id=?').run(images.join(','), s.id);
    ctx.db.prepare("INSERT INTO sample_revisions(sample_id,stage,content,user_name) VALUES(?,'其它',?,?)").run(s.id, `上传样品图片：${name}`, ctx.user.name);
    log(ctx, 'sample', '上传样品图片', s.company_no, name);
    return { file_id: fid, images };
  });
  r.del('/api/samples/:id/images/:fid', (ctx) => {
    need(ctx, 'sample', 'edit');
    const s = getSample(ctx, ctx.params.id);
    const ref = `file:${Number(ctx.params.fid)}`;
    const images = imageList(s);
    if (!images.includes(ref)) throw new HttpError(404, '该图片不属于此样品');
    ctx.db.prepare('UPDATE samples SET images=? WHERE id=?').run(images.filter((x) => x !== ref).join(','), s.id);
    ctx.db.prepare("DELETE FROM files WHERE id=? AND owner_type='sample' AND owner_id=?").run(Number(ctx.params.fid), s.id);
    log(ctx, 'sample', '删除样品图片', s.company_no, ref);
    return { images: images.filter((x) => x !== ref) };
  });

  // ---------- 汇率自动更新 / automatic exchange rates ----------
  r.get('/api/rates/status', (ctx) => {
    need(ctx, 'trade', 'view');
    const g = (k) => (ctx.db.prepare('SELECT value FROM settings WHERE key=?').get(k) || {}).value || '';
    return { last: g('rate_last_auto'), source: g('rate_last_source'), api: g('rate_api_url'), hours: g('rate_auto_hours'), max_change: g('rate_max_change') };
  });
  r.post('/api/rates/update', async (ctx) => {
    need(ctx, 'trade', 'edit');
    try {
      return await updateRates(ctx.db, { user: ctx.user.name });
    } catch (e) {
      throw new HttpError(502, e.message);
    }
  });
}

module.exports = { register, fetchAccount, autoBind, guessCategory, imageMime };
