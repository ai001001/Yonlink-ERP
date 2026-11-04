'use strict';
/**
 * 测试辅助：启动内存数据库实例、登录、请求
 * Test helpers: start an in-memory instance, log in, send requests.
 */
const { createApp } = require('../server/app');

/**
 * 启动测试服务 / Start a test server on a random port.
 * @returns {Promise<{base:string, app:object, close:Function, login:Function}>}
 */
async function startServer() {
  const app = createApp({ dbFile: ':memory:' });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;

  /**
   * 以某账号登录，返回请求客户端 / Log in and return a request client.
   * @param {string} username
   * @param {string} [password]
   */
  async function login(username, password = '123456') {
    const res = await fetch(base + '/api/login', { method: 'POST', body: JSON.stringify({ username, password }) });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error);
    const call = async (method, url, body) => {
      const r = await fetch(base + url, { method, headers: { Authorization: 'Bearer ' + j.token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      const ct = r.headers.get('content-type') || '';
      const data = ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer());
      return { status: r.status, data, headers: r.headers };
    };
    return {
      token: j.token,
      get: (u) => call('GET', u),
      post: (u, b) => call('POST', u, b || {}),
      put: (u, b) => call('PUT', u, b || {}),
      del: (u) => call('DELETE', u),
    };
  }
  return { base, app, login, close: () => new Promise((r) => app.server.close(r)) };
}

module.exports = { startServer };
