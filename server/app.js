'use strict';
/**
 * 应用装配：路由注册、请求分发、错误处理
 * Application assembly: route registration, request dispatch and error handling.
 * @module server/app
 */
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { Router, HttpError, readBody, sendJson, sendFile, serveStatic } = require('./http');
const { openDb } = require('./db');
const { loadUser, assertPasswordFresh } = require('./routes/base');
const { securityHeaders, rateLimiter } = require('./security');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

/**
 * 创建应用 / Create the ERP application.
 * @param {{dbFile?: string, reset?: boolean, secret?: string, rateLimit?: number}} [opts] 数据库文件、是否重置、密钥、
 *   匿名请求每IP每分钟上限（登录后按账号计，上限为其3倍；0=不限）
 *   / DB file, reset flag, secret, anonymous requests per IP per minute (logged-in requests are counted per account at 3x; 0 = unlimited)
 * @returns {{server: import('node:http').Server, db: import('node:sqlite').DatabaseSync, router: Router}}
 */
function createApp(opts = {}) {
  const db = openDb(opts.dbFile || ':memory:', { reset: opts.reset });
  const config = { secret: opts.secret || loadSecret(opts.dbFile) };
  const router = new Router();
  for (const m of ['base', 'sales', 'orders', 'finance', 'reports', 'integrations', 'migrate', 'handover']) require(`./routes/${m}`).register(router);
  // 匿名请求按 IP 限流；登录后按令牌限流，避免同一办公室共用出口 IP 时互相影响
  // anonymous requests are limited per IP; authenticated ones per token so an office sharing one public IP is not throttled together
  const anonLimit = opts.rateLimit === undefined ? 300 : opts.rateLimit;
  const anonLimiter = rateLimiter(anonLimit, 60000);
  const userLimiter = rateLimiter(anonLimit * 3, 60000);

  const server = http.createServer(async (req, res) => {
    securityHeaders(req, res);
    let pathname;
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
      pathname = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Bad Request');
      return;
    }
    const bearer = String(req.headers.authorization || '').startsWith('Bearer ') ? String(req.headers.authorization).slice(7, 80) : '';
    if (bearer ? userLimiter.hit(bearer) : anonLimiter.hit(req.socket.remoteAddress || '')) {
      res.setHeader('Retry-After', '60');
      sendJson(res, 429, { error: '请求过于频繁，请稍后再试' });
      return;
    }
    if (!pathname.startsWith('/api/')) {
      if ((req.method === 'GET' || req.method === 'HEAD') && serveStatic(PUBLIC_DIR, pathname, res)) return;
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    try {
      const m = router.match(req.method, pathname);
      if (!m) throw new HttpError(404, '接口不存在');
      // 令牌只接受请求头，不接受网址参数（避免泄露到日志/浏览历史）/ tokens only via header, never in URLs
      const auth = req.headers.authorization || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      const ctx = {
        db, config, req, res, params: m.params, query: Object.fromEntries(url.searchParams), token,
        ip: req.socket.remoteAddress, body: ['POST', 'PUT'].includes(req.method) ? await readBody(req) : {},
      };
      ctx.user = loadUser(db, token);
      if (!m.opts.public && !ctx.user) throw new HttpError(401, '登录已失效，请重新登录');
      assertPasswordFresh(ctx, pathname);
      const result = await m.handler(ctx);
      if (result && result.__file) sendFile(res, result.__file.buf, result.__file.name, result.__file.type);
      else sendJson(res, 200, result ?? { ok: true });
    } catch (e) {
      if (e instanceof HttpError) {
        sendJson(res, e.status, { error: e.message, ...(e.extra || {}) });
      } else {
        // 不向浏览器暴露内部错误细节，只给错误编号便于排查 / never expose internals; return a reference id for troubleshooting
        const ref = crypto.randomBytes(4).toString('hex');
        console.error(`[ERROR ${ref}]`, req.method, pathname, e);
        sendJson(res, 500, { error: `服务器内部错误（编号 ${ref}），请联系管理员` });
      }
    }
  });
  // 防慢速连接攻击 / mitigate slow-loris style attacks
  server.headersTimeout = 15000;
  server.requestTimeout = 120000;
  server.keepAliveTimeout = 5000;
  return { server, db, router, config };
}

/**
 * 读取或生成用于加密邮箱密码的系统密钥（环境变量 ERP_SECRET_KEY 优先，其次 data/secret.key）
 * Load or create the system secret used to encrypt mailbox passwords (env ERP_SECRET_KEY first, then data/secret.key).
 * @param {string} [dbFile] 数据库文件 / database file
 * @returns {string}
 */
function loadSecret(dbFile) {
  if (process.env.ERP_SECRET_KEY) return process.env.ERP_SECRET_KEY;
  if (!dbFile || dbFile === ':memory:') return crypto.randomBytes(32).toString('hex');
  const file = path.join(path.dirname(dbFile), 'secret.key');
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  return fs.readFileSync(file, 'utf8').trim();
}

module.exports = { createApp };
