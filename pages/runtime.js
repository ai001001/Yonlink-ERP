'use strict';
/**
 * 浏览器演示版运行时：加载后台模块、拦截 /api 请求、IndexedDB 持久化
 * Browser demo runtime: loads the server modules, intercepts /api requests, persists to IndexedDB.
 * 依赖打包时注入的 MODULE_DEFS 与 shims.js / Relies on MODULE_DEFS injected at build time and shims.js.
 */
(() => {
  /** 演示数据版本，结构变化时递增以重置旧数据 / bump to reset stored demo data after schema changes */
  const DEMO_VERSION = '4';
  const IDB_NAME = 'yonlink-erp-demo';
  const cache = {};
  const nativeFetch = window.fetch.bind(window);

  /**
   * 解析相对路径 / Resolve a relative module path.
   * @param {string} from 当前模块路径 / current module path
   * @param {string} spec 引用路径 / specifier
   * @returns {string}
   */
  function resolve(from, spec) {
    const parts = from.split('/').slice(0, -1);
    for (const seg of spec.split('/')) {
      if (seg === '..') parts.pop();
      else if (seg !== '.') parts.push(seg);
    }
    const p = parts.join('/');
    return p.endsWith('.js') ? p : p + '.js';
  }

  /**
   * CommonJS 风格的 require / CommonJS-style require.
   * @param {string} id 模块路径 / module id
   * @returns {any}
   */
  function load(id) {
    if (cache[id]) return cache[id].exports;
    const def = MODULE_DEFS[id];
    if (!def) throw new Error('模块未打包：' + id);
    const module = { exports: {} };
    cache[id] = module;
    def(module, module.exports, (spec) => (NODE_SHIMS[spec] ? NODE_SHIMS[spec] : load(resolve(id, spec))));
    return module.exports;
  }

  // ---------- IndexedDB 持久化 / persistence ----------
  /** @returns {Promise<IDBDatabase>} */
  function idb() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(IDB_NAME, 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function idbGet(key) {
    const d = await idb();
    return new Promise((res, rej) => {
      const r = d.transaction('kv').objectStore('kv').get(key);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function idbSet(key, val) {
    const d = await idb();
    return new Promise((res, rej) => {
      const t = d.transaction('kv', 'readwrite');
      t.objectStore('kv').put(val, key);
      t.oncomplete = () => res();
      t.onerror = () => rej(t.error);
    });
  }

  let saveChain = Promise.resolve();
  /**
   * 立即保存数据库（串行写入，返回在写入完成后才结束，保证刷新不丢数据）
   * Save the database now; writes are serialized and resolve after commit so a reload never loses data.
   * @returns {Promise<void>}
   */
  function saveNow() {
    const bytes = globalThis.__SQL_DB.export();
    saveChain = saveChain.then(() => idbSet('db', bytes)).catch((e) => console.warn('演示数据保存失败', e));
    return saveChain;
  }

  // ---------- 启动后台 / boot backend ----------
  let router;
  let loadUser;
  let assertPasswordFresh;
  let HttpError;
  let db;
  const ready = (async () => {
    const SQL = await initSqlJs({ locateFile: (f) => new URL('vendor/' + f, document.baseURI).href });
    let data = null;
    try {
      if ((await idbGet('version')) === DEMO_VERSION) data = await idbGet('db');
    } catch (e) {
      console.warn('无法读取浏览器存储，将使用临时数据', e);
    }
    let fromDemo = false;
    if (!data) {
      // 首次打开：载入构建时生成的半年模拟业务数据 / first visit: load the six-month simulated dataset built at deploy time
      try {
        const r = await nativeFetch(new URL('demo.db', document.baseURI));
        if (r.ok) { data = new Uint8Array(await r.arrayBuffer()); fromDemo = true; }
      } catch (e) {
        console.warn('未能加载演示数据，将使用基础数据', e);
      }
    }
    globalThis.__SQL_DB = data ? new SQL.Database(data) : new SQL.Database();
    globalThis.__ERP_DEMO = true;
    const http = load('server/http.js');
    HttpError = http.HttpError;
    db = load('server/db.js').openDb(':memory:');
    router = new http.Router();
    for (const m of ['base', 'sales', 'orders', 'finance', 'reports', 'integrations']) load(`server/routes/${m}.js`).register(router);
    ({ loadUser, assertPasswordFresh } = load('server/routes/base.js'));
    if (fromDemo) {
      // 演示版密码算法与服务器不同：统一重置为 123456；清除会话与真实邮箱账户 / reset passwords for the demo hash, drop sessions & mailbox accounts
      const { hashPassword } = load('server/db.js');
      const { DEMO_ACCOUNTS } = load('server/security.js');
      for (const u of db.prepare('SELECT id, username FROM users').all()) {
        if (!DEMO_ACCOUNTS[u.username]) continue;
        const { hash, salt } = hashPassword(DEMO_ACCOUNTS[u.username].password);
        db.prepare('UPDATE users SET password_hash=?, salt=? WHERE id=?').run(hash, salt, u.id);
      }
      db.exec('DELETE FROM sessions; DELETE FROM mail_accounts;');
    }
    if (!data || fromDemo) {
      await saveNow();
      await idbSet('version', DEMO_VERSION).catch(() => {});
    }
  })();

  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

  /**
   * 分发一个 /api 请求（与 server/app.js 逻辑一致）
   * Dispatch one /api request, mirroring server/app.js.
   * @param {string} method
   * @param {URL} url
   * @param {object} headers
   * @param {string} [bodyText]
   * @returns {Promise<Response>}
   */
  async function dispatch(method, url, headers, bodyText) {
    await ready;
    const res = await handle(method, url, headers, bodyText);
    if (method !== 'GET') await saveNow();
    return res;
  }

  /**
   * 执行路由处理并转换为 Response / Run the route handler and convert the result to a Response.
   * @param {string} method
   * @param {URL} url
   * @param {object} headers
   * @param {string} [bodyText]
   * @returns {Promise<Response>}
   */
  async function handle(method, url, headers, bodyText) {
    try {
      const m = router.match(method, decodeURIComponent(url.pathname));
      if (!m) throw new HttpError(404, '接口不存在');
      const auth = headers.authorization || headers.Authorization || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      let body = {};
      if (['POST', 'PUT'].includes(method) && bodyText) {
        try { body = JSON.parse(bodyText); } catch { throw new HttpError(400, '请求数据格式错误（需要 JSON）'); }
      }
      const ctx = { db, config: { secret: 'browser-demo' }, params: m.params, query: Object.fromEntries(url.searchParams), token, ip: 'browser', body };
      ctx.user = loadUser(db, token);
      if (!m.opts.public && !ctx.user) throw new HttpError(401, '登录已失效，请重新登录');
      assertPasswordFresh(ctx, url.pathname);
      const result = await m.handler(ctx);
      if (result && result.__file) {
        const f = result.__file;
        return new Response(new Blob([f.buf], { type: f.type }), {
          status: 200,
          headers: { 'Content-Type': f.type, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}` },
        });
      }
      return json(200, result ?? { ok: true });
    } catch (e) {
      if (e instanceof HttpError) return json(e.status, { error: e.message, ...(e.extra || {}) });
      console.error('[演示版后台错误]', e);
      return json(500, { error: '内部错误，请刷新页面或重置演示数据后重试' });
    }
  }

  // ---------- 拦截 fetch / intercept fetch ----------
  window.fetch = async (input, init = {}) => {
    const raw = typeof input === 'string' ? input : input.url;
    const url = new URL(raw, location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return nativeFetch(input, init);
    const h = init.headers instanceof Headers ? Object.fromEntries(init.headers.entries()) : (init.headers || {});
    return dispatch((init.method || 'GET').toUpperCase(), url, h, typeof init.body === 'string' ? init.body : '');
  };

  /** 重置演示数据 / Reset demo data */
  async function resetDemo() {
    if (!confirm('确定清空本浏览器中的演示数据并恢复初始数据吗？')) return;
    await saveChain;
    await idbSet('version', 'reset').catch(() => {});
    localStorage.removeItem('erp_token');
    location.hash = '';
    location.reload();
  }

  // ---------- 演示版提示 / demo notice ----------
  document.addEventListener('DOMContentLoaded', () => {
    const card = document.getElementById('loginForm');
    if (card) {
      const note = document.createElement('div');
      note.className = 'alert info small';
      note.style.margin = '0';
      note.className = 'alert info small demo-note';
      note.innerHTML = '<span>在线演示版：数据仅保存在当前浏览器，不同设备间不共享</span>';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn small';
      btn.textContent = '重置演示数据';
      btn.onclick = resetDemo;
      note.appendChild(btn);
      card.appendChild(note);
    }
    const userbox = document.querySelector('.userbox');
    if (userbox) {
      const tagEl = document.createElement('span');
      tagEl.className = 'tag warn';
      tagEl.textContent = '演示版';
      tagEl.title = '数据保存在本浏览器；可在登录页重置演示数据';
      userbox.prepend(tagEl);
    }
  });
})();
