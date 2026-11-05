'use strict';
/**
 * 前端核心：接口调用、路由、弹窗、表格、表单、导出、打印
 * Front-end core: API calls, routing, modals, tables, forms, export and print.
 */
// 防点击劫持：静态托管（如 GitHub Pages）无法发送 X-Frame-Options，被他站嵌入时拒绝运行
// anti-clickjacking for static hosting (e.g. GitHub Pages) where X-Frame-Options cannot be sent
if (window.top !== window.self) {
  document.documentElement.innerHTML = '';
  throw new Error('该系统禁止被嵌入到其它网页中 / framing is not allowed');
}

const ERP = (() => {
  const state = { token: localStorage.getItem('erp_token') || '', meta: null, optCache: {} };
  const routes = [];
  let navSeq = 0;
  // 所有表单由脚本处理，阻止浏览器默认提交（替代内联 onsubmit，满足 CSP）/ scripts handle every form; replaces inline onsubmit for CSP
  document.addEventListener('submit', (e) => e.preventDefault(), true);

  /**
   * HTML 转义 / Escape HTML.
   * @param {any} s
   * @returns {string}
   */
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /**
   * 金额格式化 / Format a number with 2 decimals.
   * @param {any} v
   * @returns {string}
   */
  const money = (v) => (v === null || v === undefined || v === '' ? '' : Number(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

  /**
   * 调用后端接口 / Call the backend API.
   * @param {string} method HTTP 方法 / method
   * @param {string} url 地址 / url
   * @param {object} [body] 请求体 / body
   * @returns {Promise<any>}
   */
  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + state.token },
      body: body ? JSON.stringify(body) : undefined,
    });
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : await res.blob();
    if (!res.ok) {
      if (res.status === 401 && url !== '/api/login') { logout(true); }
      if (res.status === 403 && data && data.code === 'MUST_CHANGE_PASSWORD' && ERP.forcePasswordChange) ERP.forcePasswordChange();
      const err = new Error((data && data.error) || `请求失败(${res.status})`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }
  const get = (u) => api('GET', u);
  const post = (u, b) => api('POST', u, b || {});
  const put = (u, b) => api('PUT', u, b || {});
  const del = (u) => api('DELETE', u);

  /**
   * 下载文件（带令牌）/ Download a file with auth.
   * @param {string} url
   * @param {object} [body] 有则用 POST / POST body when given
   */
  async function download(url, body) {
    const res = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + state.token },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || '下载失败');
    }
    const cd = res.headers.get('content-disposition') || '';
    const m = /filename\*=UTF-8''([^;]+)/.exec(cd);
    const name = m ? decodeURIComponent(m[1]) : 'export.xlsx';
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    toast(`已导出：${name}`, 'ok');
  }

  /**
   * 导出表格为 Excel / Export a table to Excel.
   * @param {string} module 模块键（校验导出权限）/ module key
   * @param {string} title 标题 / title
   * @param {string[]} headers 表头 / headers
   * @param {any[][]} rows 数据 / rows
   */
  function exportTable(module, title, headers, rows) {
    return download('/api/export', { module, title, headers, rows }).catch((e) => toast(e.message, 'error'));
  }

  /**
   * 提示消息 / Show a toast.
   * @param {string} msg
   * @param {'info'|'ok'|'error'} [type]
   */
  function toast(msg, type = 'info') {
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = msg;
    document.getElementById('toastRoot').appendChild(el);
    setTimeout(() => el.remove(), type === 'error' ? 5000 : 2800);
  }

  /**
   * 弹窗 / Open a modal dialog.
   * @param {object} o
   * @param {string} o.title 标题 / title
   * @param {string} o.body HTML 内容 / body html
   * @param {{text:string, cls?:string, onClick:(m:object)=>any}[]} [o.buttons] 按钮 / buttons
   * @param {boolean} [o.wide] 宽弹窗 / wide
   * @param {string} [o.cls] 额外样式 / extra class
   * @returns {{el:HTMLElement, close:Function}}
   */
  function modal({ title, body, buttons = [], wide = false, cls = '' }) {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `<div class="modal ${wide ? 'wide' : ''} ${cls}" role="dialog" aria-modal="true">
      <div class="modal-head"><h3>${esc(title)}</h3><button class="btn small" data-x>✕</button></div>
      <div class="modal-body">${body}</div>
      <div class="modal-foot"></div></div>`;
    const m = { el: mask.querySelector('.modal'), close: () => mask.remove() };
    const foot = mask.querySelector('.modal-foot');
    const all = [...buttons, { text: buttons.length ? '取消' : '关闭', onClick: () => m.close() }];
    for (const b of all) {
      const btn = document.createElement('button');
      btn.className = 'btn ' + (b.cls || '');
      btn.textContent = b.text;
      btn.onclick = async () => {
        btn.disabled = true;
        try { await b.onClick(m); } catch (e) { toast(e.message, 'error'); } finally { btn.disabled = false; }
      };
      foot.appendChild(btn);
    }
    mask.querySelector('[data-x]').onclick = m.close;
    document.getElementById('modalRoot').appendChild(mask);
    const first = mask.querySelector('input,select,textarea');
    if (first) first.focus();
    return m;
  }

  /**
   * 确认框 / Confirm dialog.
   * @param {string} msg
   * @returns {Promise<boolean>}
   */
  function confirmBox(msg) {
    return new Promise((resolve) => {
      const m = modal({ title: '请确认', body: `<p>${esc(msg)}</p>`, buttons: [{ text: '确定', cls: 'primary', onClick: () => { m.close(); resolve(true); } }] });
      m.el.querySelector('.modal-foot .btn:last-child').addEventListener('click', () => resolve(false));
    });
  }

  /**
   * 获取下拉选项（带缓存）/ Load select options with cache.
   * @param {string} ref
   * @param {boolean} [fresh] 是否强制刷新 / force reload
   * @returns {Promise<{id:any,label:string}[]>}
   */
  async function options(ref, fresh) {
    if (!fresh && state.optCache[ref]) return state.optCache[ref];
    const list = await get('/api/options/' + ref + (ref === 'sample' ? '?usable=1' : ''));
    state.optCache[ref] = list;
    return list;
  }
  const clearOptions = () => { state.optCache = {}; };

  /**
   * 生成下拉框 HTML / Build select options html.
   * @param {{id:any,label:string}[]|string[]} list
   * @param {any} value 当前值 / current value
   * @param {boolean} [blank] 是否含空项 / include blank
   * @returns {string}
   */
  function optHtml(list, value, blank = true) {
    const items = list.map((x) => (typeof x === 'object' ? x : { id: x, label: x }));
    return (blank ? '<option value="">-- 请选择 --</option>' : '') + items.map((x) => `<option value="${esc(x.id)}" ${String(x.id) === String(value ?? '') ? 'selected' : ''}>${esc(x.label)}</option>`).join('');
  }

  /**
   * 根据字段元数据生成表单 / Render a form from field metadata.
   * @param {object[]} fields 字段 / fields
   * @param {object} values 值 / values
   * @returns {Promise<string>}
   */
  async function formHtml(fields, values = {}) {
    const parts = [];
    for (const f of fields) {
      if (f.readonly && values[f.name] === undefined) continue;
      const v = values[f.name] ?? (values.id ? '' : (f.default ?? ''));
      const req = f.required ? 'req' : '';
      const dis = f.readonly ? 'disabled' : '';
      let input;
      if (f.type === 'textarea') input = `<textarea name="${f.name}" ${dis}>${esc(v)}</textarea>`;
      else if (f.type === 'select') input = `<select name="${f.name}" ${dis}>${optHtml(f.options, v)}</select>`;
      else if (f.type === 'ref') input = `<select name="${f.name}" ${dis}>${optHtml(await options(f.ref), v)}</select>`;
      else input = `<input name="${f.name}" type="${f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'}" ${f.type === 'number' ? 'step="any"' : ''} value="${esc(v)}" ${dis}>`;
      parts.push(`<label class="${f.type === 'textarea' ? 'wide' : ''}"><span class="${req}">${esc(f.label)}</span>${input}</label>`);
    }
    return `<form class="form-grid">${parts.join('')}</form>`;
  }

  /**
   * 读取表单值 / Read values from a form element.
   * @param {HTMLElement} root
   * @returns {object}
   */
  function readForm(root) {
    const out = {};
    root.querySelectorAll('input[name],select[name],textarea[name]').forEach((el) => {
      if (el.disabled) return;
      out[el.name] = el.type === 'checkbox' ? el.checked : el.value;
    });
    return out;
  }

  /**
   * 生成表格 HTML / Build a table html.
   * @param {string[]} headers 表头 / headers
   * @param {string[][]} rows 已转义的单元格 HTML / cell html rows
   * @param {Set<number>} [numCols] 数字列 / numeric column indexes
   * @returns {string}
   */
  function tableHtml(headers, rows, numCols = new Set()) {
    if (!rows.length) return `<div class="table-wrap"><table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead></table><div class="empty">暂无数据</div></div>`;
    return `<div class="table-wrap"><table><thead><tr>${headers.map((h, i) => `<th class="${numCols.has(i) ? 'num' : ''}">${esc(h)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td class="${numCols.has(i) ? 'num' : ''}">${c ?? ''}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }

  /**
   * 状态标签 / Status tag html.
   * @param {string} s 状态 / status
   * @returns {string}
   */
  function tag(s) {
    if (!s) return '';
    const ok = ['已审批', '已成交', '已完成', '已出货', '已出运', '已入库', '已付款', '合格', '通过', '已处理', '客户确认', '正常', '已收齐', '已核销', '已完工', '启用', '在职', '已转正', '已回价', '已通过'];
    const danger = ['已锁定', '已驳回', '不合格', '客户拒绝', '待处理', '待联动修正', '高', '缺料预警', '延期', '禁用', '离职', '已失效', '不通过-重做中', '未收款'];
    const warn = ['待审批', '部分出货', '部分入库', '部分收款', '待核验', '中', '积压预警', '待验货', '已发送', '待发送', '申请中', '计划中', '已报关', '重做中', '打样中'];
    const cls = ok.includes(s) ? 'ok' : danger.includes(s) ? 'danger' : warn.includes(s) ? 'warn' : 'info';
    return `<span class="tag ${cls}">${esc(s)}</span>`;
  }

  /**
   * 是否有权限 / Permission check on the client side (display only).
   * @param {string} module
   * @param {string} action
   * @returns {boolean}
   */
  const can = (module, action) => !!(state.meta && (state.meta.perms[module] || []).includes(action));

  /**
   * 注册页面路由 / Register a page route.
   * @param {RegExp} re 路径正则 / path regex
   * @param {(params:string[], main:HTMLElement)=>Promise<void>|void} render 渲染函数 / renderer
   */
  const route = (re, render) => routes.push({ re, render });

  /**
   * 按当前 hash 渲染页面 / Render the page for the current hash.
   */
  async function navigate() {
    const hash = location.hash.slice(1) || '/';
    const [path, qs] = hash.split('?');
    const main = document.getElementById('main');
    document.querySelectorAll('.menu-item').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === '#' + path));
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('backdrop').classList.remove('show');
    // 导航序号：只有最新一次导航的结果才会挂载，防止慢请求覆盖当前页面
    // Navigation sequence: only the latest navigation is mounted, so slow responses never overwrite the current page
    const seq = ++navSeq;
    for (const r of routes) {
      const m = r.re.exec(path);
      if (m) {
        main.innerHTML = '<div class="muted">加载中…</div>';
        const view = document.createElement('div');
        view.className = 'view';
        try {
          await r.render(m.slice(1), view, new URLSearchParams(qs || ''));
        } catch (e) {
          view.innerHTML = `<div class="panel"><div class="alert danger">${esc(e.message)}</div></div>`;
        }
        if (seq !== navSeq) return;
        main.replaceChildren(view);
        window.scrollTo(0, 0);
        return;
      }
    }
    main.innerHTML = '<div class="panel">页面不存在</div>';
  }

  /** 设置页面标题 / Set the breadcrumb title */
  const setTitle = (t) => { document.getElementById('crumb').textContent = t; document.title = `${t} - 陶瓷工艺品外贸ERP`; };

  /**
   * 打印单据 / Print a document html.
   * @param {string} html
   */
  function printHtml(html) {
    const area = document.getElementById('printArea');
    area.innerHTML = `<div class="doc">${html}</div>`;
    setTimeout(() => window.print(), 50);
  }

  /**
   * 退出登录 / Log out.
   * @param {boolean} [silent] 不调用接口 / skip API call
   */
  async function logout(silent) {
    if (!silent && state.token) await post('/api/logout').catch(() => {});
    state.token = '';
    state.meta = null;
    state.optCache = {};
    localStorage.removeItem('erp_token');
    // 清除上一位用户的页面内容，防止共用电脑时泄露 / wipe the previous user's screen content on shared computers
    navSeq++;
    for (const id of ['main', 'menu', 'modalRoot', 'printArea']) { const el = document.getElementById(id); if (el) el.innerHTML = ''; }
    for (const id of ['userName', 'roleTag', 'crumb']) { const el = document.getElementById(id); if (el) el.textContent = ''; }
    document.getElementById('app').classList.add('hidden');
    document.getElementById('login').classList.remove('hidden');
  }

  /**
   * 简易条形图 / Simple horizontal bar chart.
   * @param {{label:string, value:number}[]} data
   * @returns {string}
   */
  function barChart(data) {
    const max = Math.max(1, ...data.map((d) => Math.abs(Number(d.value) || 0)));
    return `<div class="bar-chart">${data.slice(0, 12).map((d) => `<div class="bar-row"><span class="lbl" title="${esc(d.label)}">${esc(d.label)}</span>
      <span><span class="bar" style="display:block;width:${(Math.abs(Number(d.value) || 0) / max) * 100}%"></span></span><span class="val">${money(d.value)}</span></div>`).join('')}</div>`;
  }

  const blobCache = {};
  /**
   * 加载需要登录的图片（file:ID）或外链图片 / Load images that need auth (file:ID) or external links.
   * @param {HTMLElement} root 含 img[data-ref] 的容器 / container with img[data-ref]
   */
  async function loadImages(root) {
    for (const img of root.querySelectorAll('img[data-ref]')) {
      const ref = img.dataset.ref;
      if (!ref.startsWith('file:')) { img.src = ref; continue; }
      try {
        if (!blobCache[ref]) {
          const res = await fetch('/api/files/' + ref.slice(5), { headers: { Authorization: 'Bearer ' + state.token } });
          if (!res.ok) throw new Error();
          blobCache[ref] = URL.createObjectURL(await res.blob());
        }
        img.src = blobCache[ref];
      } catch {
        img.alt = '图片加载失败';
      }
    }
  }

  /**
   * 压缩图片为 JPEG（最长边不超过 maxSide）/ Downscale an image file to JPEG.
   * @param {File} file
   * @param {number} [maxSide]
   * @returns {Promise<string>} dataURL
   */
  function compressImage(file, maxSide = 1600) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('读取文件失败'));
      reader.onload = () => {
        if (file.type === 'image/gif' || (file.size < 400 * 1024 && file.type !== 'image/bmp')) { resolve(reader.result); return; }
        const img = new Image();
        img.onerror = () => reject(new Error(`${file.name} 不是有效的图片`));
        img.onload = () => {
          const k = Math.min(1, maxSide / Math.max(img.width, img.height));
          const c = document.createElement('canvas');
          c.width = Math.round(img.width * k);
          c.height = Math.round(img.height * k);
          const g = c.getContext('2d');
          g.fillStyle = '#fff';
          g.fillRect(0, 0, c.width, c.height);
          g.drawImage(img, 0, 0, c.width, c.height);
          resolve(c.toDataURL('image/jpeg', 0.85));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  return {
    loadImages, compressImage,
    state, esc, money, api, get, post, put, del, download, exportTable, toast, modal, confirmBox, options, clearOptions,
    optHtml, formHtml, readForm, tableHtml, tag, can, route, navigate, setTitle, printHtml, logout, barChart,
  };
})();
