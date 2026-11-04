'use strict';
/**
 * 应用装配：路由注册、请求分发、错误处理
 * Application assembly: route registration, request dispatch and error handling.
 * @module server/app
 */
const http = require('node:http');
const path = require('node:path');
const { Router, HttpError, readBody, sendJson, sendFile, serveStatic } = require('./http');
const { openDb } = require('./db');
const { loadUser } = require('./routes/base');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

/**
 * 创建应用 / Create the ERP application.
 * @param {{dbFile?: string, reset?: boolean}} [opts] 数据库文件与是否重置 / DB file and reset flag
 * @returns {{server: import('node:http').Server, db: import('node:sqlite').DatabaseSync, router: Router}}
 */
function createApp(opts = {}) {
  const db = openDb(opts.dbFile || ':memory:', { reset: opts.reset });
  const router = new Router();
  for (const m of ['base', 'sales', 'orders', 'finance', 'reports']) require(`./routes/${m}`).register(router);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    if (!pathname.startsWith('/api/')) {
      if (req.method === 'GET' && serveStatic(PUBLIC_DIR, pathname, res)) return;
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    try {
      const m = router.match(req.method, pathname);
      if (!m) throw new HttpError(404, '接口不存在');
      const auth = req.headers.authorization || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : (url.searchParams.get('token') || '');
      const ctx = {
        db, req, res, params: m.params, query: Object.fromEntries(url.searchParams), token,
        ip: req.socket.remoteAddress, body: ['POST', 'PUT'].includes(req.method) ? await readBody(req) : {},
      };
      ctx.user = loadUser(db, token);
      if (!m.opts.public && !ctx.user) throw new HttpError(401, '登录已失效，请重新登录');
      const result = await m.handler(ctx);
      if (result && result.__file) sendFile(res, result.__file.buf, result.__file.name, result.__file.type);
      else sendJson(res, 200, result ?? { ok: true });
    } catch (e) {
      if (e instanceof HttpError) {
        sendJson(res, e.status, { error: e.message, ...(e.extra || {}) });
      } else {
        console.error('[ERROR]', req.method, pathname, e);
        sendJson(res, 500, { error: '服务器内部错误：' + e.message });
      }
    }
  });
  return { server, db, router };
}

module.exports = { createApp };
