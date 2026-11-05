'use strict';
/**
 * 轻量 HTTP 路由与工具函数（零依赖）
 * Lightweight HTTP router and helpers (zero dependencies).
 * @module server/http
 */
const fs = require('node:fs');
const path = require('node:path');

/**
 * 业务异常，携带 HTTP 状态码与附加数据
 * Business error carrying an HTTP status code and extra payload.
 */
class HttpError extends Error {
  /**
   * @param {number} status HTTP 状态码 / HTTP status
   * @param {string} message 中文提示信息 / message shown to the user
   * @param {object} [extra] 附加数据（如风控详情）/ extra payload (e.g. risk detail)
   */
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/**
 * 简易路由器 / Minimal router supporting `:param` segments.
 */
class Router {
  constructor() {
    /** @type {{method:string, re:RegExp, keys:string[], handler:Function, opts:Object}[]} */
    this.routes = [];
  }

  /**
   * 注册路由 / Register a route.
   * @param {string} method HTTP 方法 / HTTP method
   * @param {string} pattern 路径模式，如 /api/e/:entity / path pattern
   * @param {Function} handler 处理函数 (ctx) => any / handler
   * @param {{public?:boolean}} [opts] 选项，public 表示免登录 / options; public skips auth
   */
  add(method, pattern, handler, opts = {}) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => {
      keys.push(k);
      return '([^/]+)';
    }) + '$');
    this.routes.push({ method, re, keys, handler, opts });
  }

  get(p, h, o) { this.add('GET', p, h, o); }
  post(p, h, o) { this.add('POST', p, h, o); }
  put(p, h, o) { this.add('PUT', p, h, o); }
  del(p, h, o) { this.add('DELETE', p, h, o); }

  /**
   * 匹配路由 / Find a matching route.
   * @param {string} method
   * @param {string} pathname
   * @returns {{handler:Function, params:Object, opts:Object}|null}
   */
  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(pathname);
      if (m) {
        const params = {};
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        return { handler: r.handler, params, opts: r.opts };
      }
    }
    return null;
  }
}

/**
 * 读取 JSON 请求体 / Read and parse a JSON request body.
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<object>}
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 10 * 1024 * 1024) {
        reject(new HttpError(413, '请求数据过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, '请求数据格式错误（需要 JSON）'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * 输出 JSON 响应 / Send a JSON response.
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {any} data
 */
function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

/**
 * 输出文件下载 / Send a binary file download.
 * @param {import('node:http').ServerResponse} res
 * @param {Buffer} buf 文件内容 / file content
 * @param {string} filename 文件名 / filename
 * @param {string} type MIME 类型 / MIME type
 */
function sendFile(res, buf, filename, type) {
  res.writeHead(200, {
    // 下载内容在沙箱中处理，不能执行脚本 / downloaded content is sandboxed and cannot run scripts
    'Content-Security-Policy': "sandbox; default-src 'none'",
    'Content-Type': type,
    'Content-Length': buf.length,
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
  });
  res.end(buf);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

/**
 * 静态文件服务 / Serve a static file from the public directory.
 * @param {string} root 静态目录 / static root
 * @param {string} pathname 请求路径 / request path
 * @param {import('node:http').ServerResponse} res
 * @returns {boolean} 是否已处理 / whether handled
 */
function serveStatic(root, pathname, res) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  // 禁止隐藏文件与目录穿越 / block dot-files and path traversal
  if (rel.split('/').some((seg) => seg.startsWith('.')) || rel.includes('\0')) return false;
  const file = path.normalize(path.join(root, rel));
  if (!file.startsWith(root + path.sep)) return false;
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
  return true;
}

module.exports = { HttpError, Router, readBody, sendJson, sendFile, serveStatic };
