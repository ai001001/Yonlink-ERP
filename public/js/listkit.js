'use strict';
/**
 * 通用列表组件（参照亿星操作习惯）：左侧导航树（可自定义多级分组并显示数量）、快速查找区、
 * 列排序、列自动过滤、列设置、筛选条件标签、分页、导出/打印。
 * Shared list grid modelled on 亿星: configurable multi-level navigation tree with counts, quick-search panel,
 * column sorting, Excel-style auto filters, column chooser, filter chips, paging, export and print.
 *
 * 两种数据模式 / two data modes:
 *  - client：单据列表一次取回全部行，在浏览器内分组/排序/过滤 / all rows loaded, processed in the browser
 *  - server：档案列表分页查询，由服务器分组/排序/过滤 / paged, grouped and filtered on the server
 */
(() => {
  const { esc, get, put, modal, toast, optHtml, exportTable, printHtml, can } = ERP;
  const BLANK = '__BLANK__';
  const prefCache = {};

  /**
   * 读取个人设置 / Load a per-user preference (cached).
   * @param {string} key
   * @returns {Promise<object|null>}
   */
  async function loadPref(key) {
    if (key in prefCache) return prefCache[key];
    try { prefCache[key] = (await get('/api/prefs/' + encodeURIComponent(key))).value; } catch { prefCache[key] = null; }
    return prefCache[key];
  }

  /**
   * 保存个人设置（失败不影响使用）/ Save a per-user preference; failures are non-fatal.
   * @param {string} key
   * @param {object} value
   */
  function savePref(key, value) {
    prefCache[key] = value;
    put('/api/prefs/' + encodeURIComponent(key), { value }).catch(() => {});
  }

  /** 单元格文本（空值统一为 BLANK）/ Cell text with blanks normalised */
  const norm = (v) => (v === null || v === undefined || String(v).trim() === '' ? BLANK : String(v));
  const show = (v) => (v === BLANK ? '(空)' : v);

  /**
   * 创建列表 / Create a grid inside a container.
   * @param {HTMLElement} root 容器 / container
   * @param {object} o 配置 / options
   * @param {string} o.key 设置保存键 / preference key
   * @param {string} o.title 标题 / title
   * @param {'client'|'server'} o.mode 数据模式 / data mode
   * @param {object[]} [o.rows] client 模式的全部行 / all rows (client mode)
   * @param {string} [o.entity] server 模式的实体键 / entity key (server mode)
   * @param {object[]} o.columns 全部可选列 {key,label,text(r),html(r),num,nofilter} / all columns
   * @param {string[]} [o.defaultCols] 默认显示列 / default visible columns
   * @param {object[]} o.tree 可分组字段 {key,label,text(r)} / tree fields
   * @param {string[][]} o.schemes 默认导航方案 / default tree schemes
   * @param {object[]} o.quick 快速查找字段 {key,label} / quick-search fields
   * @param {string} [o.toolbar] 额外按钮 HTML / extra toolbar html
   * @param {string} [o.headHtml] 表格上方提示 HTML / html above the table
   * @param {Function} [o.actions] 操作列 HTML (r)=>string / action column html
   * @param {Function} [o.bind] 渲染后绑定事件 (root, rows) / bind events after render
   * @param {string} [o.module] 导出/打印权限模块 / module for export & print permissions
   * @param {number} [o.pageSize]
   * @param {string} [o.q] 初始关键字 / initial keyword
   * @param {Function} [o.onKeyword] 关键字提交（server 模式由服务器检索）/ keyword callback
   * @returns {Promise<{reload:Function}>}
   */
  async function grid(root, o) {
    const pageSize = o.pageSize || (o.mode === 'server' ? 50 : 100);
    const prefKey = 'grid.' + o.key;
    const defaults = { schemes: o.schemes.map((levels) => ({ name: levels.map((k) => labelOf(k)).join(' → '), levels })), active: 0, cols: null, sort: null, side: true };
    const saved = await loadPref(prefKey);
    const pref = { ...defaults, ...(saved || {}) };
    // 只有用户自定义过导航方案才使用保存的方案，否则始终用系统默认（便于以后改进默认方案）/ saved schemes only when customised
    if (!pref.customSchemes || !Array.isArray(pref.schemes) || !pref.schemes.length) { pref.schemes = defaults.schemes; pref.customSchemes = false; }
    pref.schemes = pref.schemes.map((s) => ({ ...s, levels: (s.levels || []).filter((k) => o.tree.some((t) => t.key === k)) })).filter((s) => s.levels.length);
    if (pref.active >= pref.schemes.length) pref.active = 0;
    const st = { node: [], quick: {}, filters: { ...(o.initFilters || {}) }, q: o.q || '', page: 1, sort: pref.sort, expanded: new Set(['[]']) };
    const labelCache = {};
    const isMobile = () => window.matchMedia('(max-width: 900px)').matches;
    let sideOpen = isMobile() ? false : pref.side !== false;

    /** 字段显示名 / label of a field */
    function labelOf(k) {
      const t = o.tree.find((x) => x.key === k) || o.columns.find((x) => x.key === k) || o.quick.find((x) => x.key === k);
      return t ? t.label : k;
    }
    const visibleCols = () => {
      const keys = Array.isArray(pref.cols) && pref.cols.length ? pref.cols : (o.defaultCols || o.columns.map((c) => c.key));
      return keys.map((k) => o.columns.find((c) => c.key === k)).filter(Boolean);
    };
    const scheme = () => pref.schemes[pref.active] || null;
    const persist = () => savePref(prefKey, { schemes: pref.customSchemes ? pref.schemes : null, customSchemes: !!pref.customSchemes, active: pref.active, cols: pref.cols, sort: st.sort, side: pref.side });

    // ---------- 数据访问 / data access ----------
    const colText = (key, r) => {
      const c = o.columns.find((x) => x.key === key) || o.tree.find((x) => x.key === key);
      return c && c.text ? c.text(r) : r[key];
    };

    /**
     * client 模式：按条件过滤 / client mode filtering
     * @param {object} opt skipNode/skipCol 排除的条件 / conditions to skip
     * @returns {object[]}
     */
    function clientRows(opt = {}) {
      // 关键字由服务器检索时（如报价按货号）不在本地重复过滤 / keyword already applied by the server
      const kw = o.onKeyword ? '' : st.q.trim().toLowerCase();
      const levels = scheme() ? scheme().levels : [];
      return o.rows.filter((r) => {
        if (kw && !o.columns.some((c) => String(colText(c.key, r) ?? '').toLowerCase().includes(kw))) return false;
        if (!opt.skipNode) for (let i = 0; i < st.node.length; i++) if (norm(colText(levels[i], r)) !== String(st.node[i])) return false;
        for (const [k, v] of Object.entries(st.quick)) if (v && !String(colText(k, r) ?? '').toLowerCase().includes(v.toLowerCase())) return false;
        for (const [k, vals] of Object.entries(st.filters)) if (k !== opt.skipCol && vals.length && !vals.includes(norm(colText(k, r)))) return false;
        return true;
      });
    }

    /**
     * server 模式查询参数 / server-mode query string
     * @param {object} opt skipNode/skipCol
     * @returns {URLSearchParams}
     */
    function serverParams(opt = {}) {
      const p = new URLSearchParams();
      if (st.q) p.set('q', st.q);
      const levels = scheme() ? scheme().levels : [];
      if (!opt.skipNode) st.node.forEach((v, i) => p.set('f_' + levels[i], v));
      for (const [k, v] of Object.entries(st.quick)) if (v) p.set('l_' + k, v);
      for (const [k, vals] of Object.entries(st.filters)) if (k !== opt.skipCol && vals.length) p.set('in_' + k, JSON.stringify(vals));
      return p;
    }

    /** 当前页数据 / rows of the current page */
    async function pageRows() {
      if (o.mode === 'client') {
        let rows = clientRows();
        if (st.sort) {
          const c = o.columns.find((x) => x.key === st.sort.key);
          const dir = st.sort.dir === 'desc' ? -1 : 1;
          const val = (r) => { const v = colText(st.sort.key, r); return c && c.num ? Number(v) : String(v ?? ''); };
          rows = rows.slice().sort((a, b) => {
            const x = val(a); const y = val(b);
            const ex = x === '' || x === null || Number.isNaN(x); const ey = y === '' || y === null || Number.isNaN(y);
            if (ex !== ey) return ex ? 1 : -1;
            return (typeof x === 'number' ? x - y : x.localeCompare(y, 'zh-CN', { numeric: true })) * dir;
          });
        }
        return { all: rows, rows: rows.slice((st.page - 1) * pageSize, st.page * pageSize), total: rows.length };
      }
      const p = serverParams();
      p.set('page', st.page); p.set('size', pageSize);
      if (st.sort) { p.set('sort', st.sort.key); p.set('dir', st.sort.dir); }
      const d = await get(`/api/e/${o.entity}?${p}`);
      return { rows: d.rows, total: d.total };
    }

    /** 导航树分组 / tree groups */
    async function treeGroups() {
      const sc = scheme();
      if (!sc) return { groups: [], total: 0 };
      if (o.mode === 'server') {
        const p = serverParams({ skipNode: true });
        p.set('by', sc.levels.join(','));
        return get(`/api/e-groups/${o.entity}?${p}`);
      }
      const map = new Map();
      for (const r of clientRows({ skipNode: true })) {
        const v = sc.levels.map((k) => norm(colText(k, r)));
        const id = JSON.stringify(v);
        if (!map.has(id)) map.set(id, { v, l: v.map(show), n: 0 });
        map.get(id).n++;
      }
      const groups = [...map.values()].sort((a, b) => {
        for (let i = 0; i < a.l.length; i++) {
          if ((a.v[i] === BLANK) !== (b.v[i] === BLANK)) return a.v[i] === BLANK ? 1 : -1;
          const c = a.l[i].localeCompare(b.l[i], 'zh-CN', { numeric: true });
          if (c) return c;
        }
        return 0;
      });
      return { groups, total: groups.reduce((s, g) => s + g.n, 0) };
    }

    /** 某列的可选值 / distinct values of a column */
    async function columnValues(key) {
      if (o.mode === 'server') {
        const p = serverParams({ skipCol: key });
        p.set('field', key);
        return get(`/api/e-values/${o.entity}?${p}`);
      }
      const map = new Map();
      for (const r of clientRows({ skipCol: key })) {
        const v = norm(colText(key, r));
        map.set(v, (map.get(v) || 0) + 1);
      }
      return [...map.entries()].map(([v, n]) => ({ v, l: show(v), n }))
        .sort((a, b) => (a.v === BLANK) - (b.v === BLANK) || a.l.localeCompare(b.l, 'zh-CN', { numeric: true }));
    }

    // ---------- 渲染 / rendering ----------
    root.innerHTML = `<div class="panel grid-panel">
      <div class="panel-head"><h2>${esc(o.title)} <span class="muted small" data-g="count"></span></h2>
        <div class="toolbar">
          <button class="btn" type="button" data-g="side" title="显示/隐藏导航树与快速查找">☰ 导航</button>
          <input class="search" data-g="q" placeholder="关键字，回车查询" value="${esc(st.q)}">
          ${o.toolbar || ''}
          <button class="btn" type="button" data-g="cols">列设置</button>
          ${!o.module || can(o.module, 'export') ? '<button class="btn" type="button" data-g="exp">导出Excel</button>' : ''}
          ${!o.module || can(o.module, 'print') ? '<button class="btn" type="button" data-g="prt">打印</button>' : ''}
        </div></div>
      ${o.headHtml || ''}
      <div class="grid-body" data-g="body">
        <aside class="grid-side">
          <div class="side-sec">
            <div class="side-head"><b>导航树</b><span><select data-g="scheme" title="导航方案"></select><button class="btn small" type="button" data-g="treecfg" title="设置导航方案">⚙</button></span></div>
            <div class="tree" data-g="tree"></div>
          </div>
          <div class="side-sec">
            <div class="side-head"><b>快速查找</b></div>
            <form class="quick" data-g="quick">${o.quick.map((f) => `<label><span>${esc(f.label)}</span><input name="${esc(f.key)}" autocomplete="off"></label>`).join('')}
              <div class="toolbar"><button class="btn small primary" type="submit">查找</button><button class="btn small" type="button" data-g="qreset">重置</button></div></form>
          </div>
        </aside>
        <section class="grid-main"><div class="chips" data-g="chips"></div><div data-g="table"></div><div class="pager" data-g="pager"></div></section>
      </div></div>`;
    const $ = (n) => root.querySelector(`[data-g="${n}"]`);
    const applySide = () => { $('body').classList.toggle('side-off', !sideOpen); $('side').classList.toggle('active', sideOpen); };
    applySide();

    /** 渲染导航方案下拉 / render scheme selector */
    const renderSchemes = () => {
      $('scheme').innerHTML = pref.schemes.length ? optHtml(pref.schemes.map((s, i) => ({ id: i, label: s.name })), pref.active, false) : '<option>（无）</option>';
    };

    /** 渲染导航树 / render the tree */
    async function renderTree() {
      const box = $('tree');
      if (!scheme()) { box.innerHTML = '<div class="muted small">没有导航方案，点 ⚙ 新建</div>'; return; }
      const { groups, total } = await treeGroups();
      // 记录节点显示名（server 模式下引用字段的值是ID）/ remember node labels (ref values are ids in server mode)
      for (const g of groups) g.v.forEach((v, i) => { labelCache[`n${i}:${v}`] = g.l[i]; });
      const levels = scheme().levels.length;
      // 组装树 / build nested nodes
      const top = { children: new Map(), n: total };
      for (const g of groups) {
        let cur = top;
        for (let i = 0; i < levels; i++) {
          const id = JSON.stringify(g.v.slice(0, i + 1));
          if (!cur.children.has(id)) cur.children.set(id, { id, v: g.v.slice(0, i + 1), l: g.l[i], n: 0, children: new Map() });
          cur = cur.children.get(id);
          cur.n += g.n;
        }
      }
      const sel = JSON.stringify(st.node);
      // 选中节点的上级自动展开 / expand ancestors of the selected node
      for (let i = 1; i < st.node.length; i++) st.expanded.add(JSON.stringify(st.node.slice(0, i)));
      const nodeHtml = (node, depth) => [...node.children.values()].map((c) => {
        const has = c.children.size > 0;
        const open = st.expanded.has(c.id);
        return `<div class="tnode ${c.id === sel ? 'on' : ''}" style="padding-left:${depth * 14 + 4}px" data-node='${esc(c.id)}'>
          ${has ? `<i class="tog" data-tog='${esc(c.id)}'>${open ? '▾' : '▸'}</i>` : '<i class="tog"></i>'}<span class="tl">${esc(c.l)}</span><span class="tn">${c.n}</span></div>
          ${has && open ? nodeHtml(c, depth + 1) : ''}`;
      }).join('');
      box.innerHTML = `<div class="tnode ${sel === '[]' ? 'on' : ''}" data-node="[]"><i class="tog"></i><span class="tl">全部</span><span class="tn">${total}</span></div>${nodeHtml(top, 1)}`;
      box.querySelectorAll('[data-tog]').forEach((t) => {
        t.onclick = (e) => { e.stopPropagation(); const id = t.dataset.tog; if (st.expanded.has(id)) st.expanded.delete(id); else st.expanded.add(id); renderTree(); };
      });
      box.querySelectorAll('[data-node]').forEach((n) => {
        n.onclick = () => {
          st.node = JSON.parse(n.dataset.node);
          st.expanded.add(n.dataset.node);
          st.page = 1;
          refresh(false);
          if (isMobile()) { sideOpen = false; applySide(); }
        };
      });
    }

    /** 筛选条件标签 / filter chips */
    function renderChips() {
      const chips = [];
      if (st.node.length) {
        const levels = scheme().levels;
        const names = st.node.map((v, i) => `${labelOf(levels[i])}=${show(nodeLabel(i, v))}`);
        chips.push(['node', '', `导航：${names.join(' / ')}`]);
      }
      for (const [k, v] of Object.entries(st.quick)) if (v) chips.push(['quick', k, `${labelOf(k)} 含“${v}”`]);
      for (const [k, vals] of Object.entries(st.filters)) if (vals.length) chips.push(['filter', k, `${labelOf(k)}：${vals.slice(0, 3).map((v) => show(filterLabel(k, v))).join('、')}${vals.length > 3 ? ` 等${vals.length}项` : ''}`]);
      if (st.q) chips.push(['q', '', `关键字“${st.q}”`]);
      $('chips').innerHTML = chips.length ? `${chips.map(([t, k, text]) => `<span class="chip">${esc(text)}<button type="button" data-chip="${t}" data-k="${esc(k)}" title="取消该条件">×</button></span>`).join('')}<button class="link-btn" type="button" data-g="clear">清除全部条件</button>` : '';
      $('chips').querySelectorAll('[data-chip]').forEach((b) => {
        b.onclick = () => {
          const t = b.dataset.chip;
          if (t === 'node') st.node = [];
          if (t === 'quick') { delete st.quick[b.dataset.k]; const inp = $('quick').querySelector(`[name="${CSS.escape(b.dataset.k)}"]`); if (inp) inp.value = ''; }
          if (t === 'filter') delete st.filters[b.dataset.k];
          if (t === 'q') { st.q = ''; $('q').value = ''; if (o.onKeyword) { o.onKeyword(''); return; } }
          st.page = 1;
          refresh(true);
        };
      });
      const cl = $('clear');
      if (cl) {
        cl.onclick = () => {
          const hadQ = !!st.q;
          st.node = []; st.quick = {}; st.filters = {}; st.q = ''; $('q').value = ''; $('quick').reset(); st.page = 1;
          if (hadQ && o.onKeyword) { o.onKeyword(''); return; }
          refresh(true);
        };
      }
    }
    const nodeLabel = (i, v) => (labelCache[`n${i}:${v}`] ?? v);
    const filterLabel = (k, v) => (labelCache[`f${k}:${v}`] ?? v);

    /** 渲染表格 / render the table */
    async function renderTable() {
      const cols = visibleCols();
      const { rows, total, all } = await pageRows();
      $('count').textContent = `共 ${total} 条`;
      const ths = cols.map((c) => {
        const sorted = st.sort && st.sort.key === c.key ? st.sort.dir : '';
        const filtered = (st.filters[c.key] || []).length > 0;
        return `<th class="${c.num ? 'num' : ''}"><span class="th"><button type="button" class="th-sort" data-sort="${esc(c.key)}" title="点击排序">${esc(c.label)}${sorted ? `<i>${sorted === 'asc' ? '▲' : '▼'}</i>` : ''}</button>${c.nofilter ? '' : `<button type="button" class="th-flt ${filtered ? 'on' : ''}" data-flt="${esc(c.key)}" title="自动过滤">▾</button>`}</span></th>`;
      }).join('') + (o.actions ? '<th>操作</th>' : '');
      const body = rows.map((r) => `<tr>${cols.map((c) => `<td class="${c.num ? 'num' : ''}">${c.html ? c.html(r) : esc(c.text ? c.text(r) : r[c.key])}</td>`).join('')}${o.actions ? `<td class="nowrap">${o.actions(r)}</td>` : ''}</tr>`).join('');
      $('table').innerHTML = `<div class="table-wrap"><table><thead><tr>${ths}</tr></thead><tbody>${body}</tbody></table>${rows.length ? '' : '<div class="empty">暂无数据</div>'}</div>`;
      const pages = Math.max(1, Math.ceil(total / pageSize));
      if (st.page > pages) st.page = pages;
      $('pager').innerHTML = pages > 1 ? `<span>第 ${st.page}/${pages} 页</span><button class="btn small" type="button" data-pg="${st.page - 1}" ${st.page <= 1 ? 'disabled' : ''}>上一页</button><button class="btn small" type="button" data-pg="${st.page + 1}" ${st.page >= pages ? 'disabled' : ''}>下一页</button>` : '';
      $('pager').querySelectorAll('[data-pg]').forEach((b) => { b.onclick = () => { st.page = Number(b.dataset.pg); renderTable(); root.scrollIntoView({ block: 'start' }); }; });
      $('table').querySelectorAll('[data-sort]').forEach((b) => {
        b.onclick = () => {
          const k = b.dataset.sort;
          st.sort = !st.sort || st.sort.key !== k ? { key: k, dir: 'asc' } : st.sort.dir === 'asc' ? { key: k, dir: 'desc' } : null;
          st.page = 1;
          persist();
          renderTable();
        };
      });
      $('table').querySelectorAll('[data-flt]').forEach((b) => { b.onclick = (e) => { e.stopPropagation(); openFilter(b.dataset.flt, b); }; });
      state.rows = rows;
      state.all = all;
      if (o.bind) o.bind(root, rows);
    }
    const state = { rows: [], all: null };

    /**
     * 列自动过滤弹出框 / Excel-style auto-filter popover
     * @param {string} key 列 / column
     * @param {HTMLElement} anchor 按钮 / anchor button
     */
    async function openFilter(key, anchor) {
      document.querySelectorAll('.flt-pop').forEach((x) => x.remove());
      const vals = await columnValues(key);
      for (const v of vals) labelCache[`f${key}:${v.v}`] = v.l;
      const cur = new Set((st.filters[key] || []).map(String));
      const pop = document.createElement('div');
      pop.className = 'flt-pop';
      pop.innerHTML = `<input class="flt-q" placeholder="搜索值">
        <div class="flt-list">${vals.map((v, i) => `<label data-l="${esc(v.l.toLowerCase())}"><input type="checkbox" data-i="${i}" ${cur.size === 0 || cur.has(String(v.v)) ? 'checked' : ''}><span>${esc(v.l)}</span><em>${v.n}</em></label>`).join('') || '<div class="muted small">无数据</div>'}</div>
        <div class="flt-foot"><button class="link-btn" type="button" data-a="all">全选</button><button class="link-btn" type="button" data-a="none">全不选</button>
        <span><button class="btn small" type="button" data-a="cancel">取消</button><button class="btn small primary" type="button" data-a="ok">确定</button></span></div>`;
      document.body.appendChild(pop);
      const r = anchor.getBoundingClientRect();
      const w = Math.min(280, window.innerWidth - 16);
      pop.style.width = w + 'px';
      pop.style.left = Math.max(8, Math.min(r.left + window.scrollX, window.scrollX + window.innerWidth - w - 8)) + 'px';
      pop.style.top = (r.bottom + window.scrollY + 4) + 'px';
      const close = () => { pop.remove(); document.removeEventListener('mousedown', outside, true); };
      const outside = (e) => { if (!pop.contains(e.target)) close(); };
      setTimeout(() => document.addEventListener('mousedown', outside, true), 0);
      pop.querySelector('.flt-q').oninput = (e) => { const t = e.target.value.trim().toLowerCase(); pop.querySelectorAll('.flt-list label').forEach((l) => { l.style.display = !t || l.dataset.l.includes(t) ? '' : 'none'; }); };
      pop.querySelector('[data-a="all"]').onclick = () => pop.querySelectorAll('.flt-list input').forEach((c) => { if (c.closest('label').style.display !== 'none') c.checked = true; });
      pop.querySelector('[data-a="none"]').onclick = () => pop.querySelectorAll('.flt-list input').forEach((c) => { if (c.closest('label').style.display !== 'none') c.checked = false; });
      pop.querySelector('[data-a="cancel"]').onclick = close;
      pop.querySelector('[data-a="ok"]').onclick = () => {
        const checked = [...pop.querySelectorAll('.flt-list input')].filter((c) => c.checked).map((c) => vals[Number(c.dataset.i)].v);
        if (!checked.length) { toast('请至少勾选一个值', 'error'); return; }
        if (checked.length === vals.length) delete st.filters[key]; else st.filters[key] = checked;
        close();
        st.page = 1;
        refresh(true);
      };
    }

    /**
     * 刷新 / refresh
     * @param {boolean} tree 是否重算导航树 / also recount the tree
     */
    async function refresh(tree) {
      try {
        if (tree) await renderTree(); else root.querySelectorAll('.tnode').forEach((n) => n.classList.toggle('on', n.dataset.node === JSON.stringify(st.node)));
        renderChips();
        await renderTable();
      } catch (e) { toast(e.message, 'error'); }
    }

    /** 导航方案设置 / tree scheme settings */
    function openTreeCfg() {
      const opts = o.tree.map((t) => ({ id: t.key, label: t.label }));
      const rowHtml = (s, i) => `<tr data-row="${i}"><td><input data-name value="${esc(s.name)}" placeholder="方案名称"></td>
        ${[0, 1, 2].map((k) => `<td><select data-lv="${k}">${optHtml(opts, s.levels[k] || '', true)}</select></td>`).join('')}
        <td><button class="btn small danger" type="button" data-del="${i}">删除</button></td></tr>`;
      let list = pref.schemes.map((s) => ({ name: s.name, levels: s.levels.slice() }));
      const m = modal({
        title: `设置导航方案：${o.title}`, wide: true,
        body: `<p class="muted small">每个方案最多 3 级，例如“业务员 → 国别 → 客户等级”。设置按账号保存，换电脑登录也有效。</p>
          <div class="table-wrap"><table><thead><tr><th>方案名称</th><th>第1级</th><th>第2级</th><th>第3级</th><th></th></tr></thead><tbody data-rows></tbody></table></div>
          <div class="toolbar" style="margin-top:8px"><button class="btn small" type="button" data-add>＋ 新增方案</button><button class="btn small" type="button" data-reset>恢复默认方案</button></div>`,
        buttons: [{
          text: '保存', cls: 'primary', onClick: async (mm) => {
            read(mm.el);
            const clean = list.map((s) => ({ name: s.name.trim(), levels: [...new Set(s.levels.filter(Boolean))] })).filter((s) => s.levels.length)
              .map((s) => ({ ...s, name: s.name || s.levels.map(labelOf).join(' → ') }));
            if (!clean.length) throw new Error('至少保留一个有分级字段的方案');
            pref.schemes = clean;
            // 与默认方案相同则视为未自定义 / identical to defaults → not customised
            pref.customSchemes = JSON.stringify(clean) !== JSON.stringify(defaults.schemes);
            if (pref.active >= clean.length) pref.active = 0;
            persist();
            mm.close();
            st.node = [];
            renderSchemes();
            refresh(true);
            toast('导航方案已保存', 'ok');
          },
        }],
      });
      const tbody = m.el.querySelector('[data-rows]');
      function read(el) {
        list = [...el.querySelectorAll('[data-row]')].map((tr) => ({ name: tr.querySelector('[data-name]').value, levels: [0, 1, 2].map((k) => tr.querySelector(`[data-lv="${k}"]`).value) }));
      }
      function draw() {
        tbody.innerHTML = list.map(rowHtml).join('');
        tbody.querySelectorAll('[data-del]').forEach((b) => { b.onclick = () => { read(m.el); list.splice(Number(b.dataset.del), 1); draw(); }; });
      }
      draw();
      m.el.querySelector('[data-add]').onclick = () => { read(m.el); list.push({ name: '', levels: [] }); draw(); };
      m.el.querySelector('[data-reset]').onclick = () => { list = defaults.schemes.map((s) => ({ name: s.name, levels: s.levels.slice() })); draw(); };
    }

    /** 列设置 / column chooser */
    function openColCfg() {
      const vis = visibleCols().map((c) => c.key);
      const order = [...vis, ...o.columns.map((c) => c.key).filter((k) => !vis.includes(k))];
      const m = modal({
        title: `列设置：${o.title}`,
        body: `<p class="muted small">勾选要显示的列，用 ↑↓ 调整顺序。设置按账号保存。</p><div class="col-list" data-cols>${order.map((k) => `<div class="col-item" data-k="${esc(k)}"><label><input type="checkbox" ${vis.includes(k) ? 'checked' : ''}> ${esc(labelOf(k))}</label>
          <span><button class="btn small" type="button" data-up>↑</button><button class="btn small" type="button" data-down>↓</button></span></div>`).join('')}</div>
          <div class="toolbar" style="margin-top:8px"><button class="btn small" type="button" data-reset>恢复默认列</button></div>`,
        buttons: [{
          text: '保存', cls: 'primary', onClick: async (mm) => {
            const keys = [...mm.el.querySelectorAll('.col-item')].filter((d) => d.querySelector('input').checked).map((d) => d.dataset.k);
            if (!keys.length) throw new Error('至少显示一列');
            pref.cols = keys;
            persist();
            mm.close();
            renderTable();
          },
        }],
      });
      const box = m.el.querySelector('[data-cols]');
      box.addEventListener('click', (e) => {
        const item = e.target.closest('.col-item');
        if (!item) return;
        if (e.target.matches('[data-up]') && item.previousElementSibling) box.insertBefore(item, item.previousElementSibling);
        if (e.target.matches('[data-down]') && item.nextElementSibling) box.insertBefore(item.nextElementSibling, item);
      });
      m.el.querySelector('[data-reset]').onclick = () => {
        const def = o.defaultCols || o.columns.map((c) => c.key);
        box.querySelectorAll('.col-item').forEach((d) => { d.querySelector('input').checked = def.includes(d.dataset.k); });
      };
    }

    /** 导出/打印的全部筛选结果 / all filtered rows for export & print */
    async function allRows() {
      if (o.mode === 'client') return (await pageRows()).all;
      const out = [];
      for (let page = 1; page <= 20; page++) {
        const p = serverParams();
        p.set('page', page); p.set('size', 500);
        if (st.sort) { p.set('sort', st.sort.key); p.set('dir', st.sort.dir); }
        const d = await get(`/api/e/${o.entity}?${p}`);
        out.push(...d.rows);
        if (out.length >= d.total || !d.rows.length) break;
      }
      return out;
    }
    const plain = (rows) => rows.map((r) => visibleCols().map((c) => { const v = c.text ? c.text(r) : r[c.key]; return v === null || v === undefined ? '' : v; }));

    // ---------- 事件 / events ----------
    $('side').onclick = () => { sideOpen = !sideOpen; if (!isMobile()) { pref.side = sideOpen; persist(); } applySide(); };
    $('q').onkeydown = (e) => {
      if (e.key !== 'Enter') return;
      st.q = e.target.value.trim();
      if (o.onKeyword) { o.onKeyword(st.q); return; }
      st.page = 1;
      refresh(true);
    };
    $('scheme').onchange = () => { pref.active = Number($('scheme').value); st.node = []; persist(); refresh(true); };
    $('treecfg').onclick = openTreeCfg;
    $('cols').onclick = openColCfg;
    $('quick').onsubmit = (e) => {
      e.preventDefault();
      st.quick = Object.fromEntries([...new FormData($('quick')).entries()].map(([k, v]) => [k, String(v).trim()]).filter(([, v]) => v));
      st.page = 1;
      refresh(true);
      if (isMobile()) { sideOpen = false; applySide(); }
    };
    $('qreset').onclick = () => { $('quick').reset(); st.quick = {}; st.page = 1; refresh(true); };
    const eb = $('exp');
    if (eb) eb.onclick = async () => { try { const rows = await allRows(); exportTable(o.module || 'system', o.title, visibleCols().map((c) => c.label), plain(rows)); } catch (e) { toast(e.message, 'error'); } };
    const pb = $('prt');
    if (pb) pb.onclick = async () => { const rows = await allRows(); printHtml(`<h1>${esc(o.title)}</h1><div class="sub">打印时间：${new Date().toLocaleString()}　共 ${rows.length} 条</div>${ERP.tableHtml(visibleCols().map((c) => c.label), plain(rows).map((r) => r.map(esc)))}`); };

    renderSchemes();
    await refresh(true);
    return { reload: () => refresh(true), state };
  }

  ERP.grid = grid;
  ERP.GRID_BLANK = BLANK;
})();
