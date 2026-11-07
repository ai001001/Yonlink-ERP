'use strict';
/**
 * 启动：登录、岗位化菜单、待办角标
 * Bootstrap: login, role-based menu and pending badges.
 */
(() => {
  const { esc, get, post, toast, modal, readForm, can } = ERP;
  const origLogout = ERP.logout;
  ERP.logout = async (silent) => { await origLogout(silent); renderDemoAccounts(); };

  /** 分组图标（内联 SVG 路径）/ Group icons (inline SVG paths) */
  const ICONS = {
    home: 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
    customer: 'M16 11a4 4 0 1 0-8 0 4 4 0 0 0 8 0zM4 21c0-4 4-6 8-6s8 2 8 6',
    sample: 'M9 2h6v3c0 2 3 3 3 8 0 5-3 9-6 9s-6-4-6-9c0-5 3-6 3-8z',
    quote: 'M6 2h9l5 5v15H6zM14 2v6h6M9 13h8M9 17h6',
    order: 'M3 4h3l2 12h11l2-8H7M9 21a1 1 0 1 0 0-2 1 1 0 0 0 0 2zm9 0a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
    purchase: 'M3 7l9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10',
    production: 'M3 21V10l6 4V10l6 4V6h6v15zM7 18h2M12 18h2M17 18h2',
    finance: 'M3 6h18v12H3zM3 10h18M7 15h4',
    report: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
    base: 'M4 6c0-2 16-2 16 0v12c0 2-16 2-16 0zM4 6c0 2 16 2 16 0M4 12c0 2 16 2 16 0',
    system: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12l2-1-1-3-2 .3-1.4-1.4L17 5l-3-1-1 2h-2L10 4 7 5l.4 2L6 8.6 4 8.3 3 11l2 1v0l-2 1 1 3 2-.3 1.4 1.4L7 19l3 1 1-2h2l1 2 3-1-.4-2 1.4-1.4 2 .3 1-3z',
  };

  /**
   * 菜单：按外贸 ERP 业务板块组织 [板块, 图标, [[名称, 链接, 权限]]]
   * Menu organised by trade-ERP business domains: [group, icon, [[label, href, permission]]]
   */
  const MENU = [
    ['工作台', 'home', [['工作台首页', '#/', null], ['审批中心', '#/approvals', '*audit'], ['变更联动任务', '#/change-tasks', '*task']]],
    ['客户管理', 'customer', [['客户档案', '#/e/customer', 'customer'], ['客户跟进/询盘', '#/e/customer_follow', 'customer'], ['业务邮件', '#/mails', 'mail'], ['邮箱账户', '#/mail-accounts', 'mail']]],
    ['样品管理', 'sample', [['样品档案', '#/e/sample', 'sample'], ['改样日志', '#/e/sample_revision', 'sample'], ['送样单', '#/sends', 'sendsample']]],
    ['报价管理', 'quote', [['报价单', '#/quotes', 'quote'], ['工厂询价台账', '#/inquiries', 'quote:noDesigner']]],
    ['订单出货', 'order', [['销售订单', '#/orders', 'order'], ['出货中心（发票）', '#/invoices', 'order:noDesigner'], ['出货台账', '#/shipments', 'order']]],
    ['采购管理', 'purchase', [['采购单', '#/purchases', 'purchase'], ['供应商', '#/e/supplier', 'supplier'], ['历史供货价格', '#/e/supplier_price', 'supplier'], ['物料库存', '#/e/inventory', 'purchase']]],
    ['生产管理', 'production', [['布产进度', '#/production', 'production']]],
    ['财务管理', 'finance', [['应收款与开票', '#/receivables', 'receivable'], ['应收账款台账', '#/ar', 'receivable'], ['水单认领', '#/slips', 'receivable'], ['应付与进项票', '#/payables', 'purchase'], ['应付账款台账', '#/ap', 'purchase'], ['币种汇率', '#/e/currency', 'trade'], ['汇率波动记录', '#/e/rate_history', 'trade']]],
    ['统计分析', 'report', [['统计报表', '#/reports/business', 'report'], ['设计师速查中心', '#/designer', 'designer']]],
    ['基础资料', 'base', [['服务机构', '#/e/agency', 'agency'], ['机构对接记录', '#/e/agency_record', 'agency'], ['贸易术语', '#/e/trade_term', 'trade'], ['部门', '#/e/department', 'hr'], ['员工档案', '#/e/employee', 'hr']]],
    ['系统设置', 'system', [['系统权限管理', '#/system', 'system'], ['业务交接', '#/handover', 'system'], ['数据迁移（亿星导入）', '#/migrate', 'system']]],
  ];

  /** 详情页归属的菜单 / Menu entry that owns a detail page */
  const PARENT = [['/quote/', '#/quotes'], ['/inquiry/', '#/inquiries'], ['/send/', '#/sends'], ['/order/', '#/orders'], ['/purchase/', '#/purchases'],
    ['/receivable/', '#/receivables'], ['/invoice/', '#/invoices'], ['/slip/', '#/slips'], ['/production/', '#/production'], ['/customer/', '#/e/customer'], ['/sample/', '#/e/sample'], ['/reports/', '#/reports/business']];

  /** 折叠状态（记住在本机）/ Collapsed groups, remembered per browser */
  const store = {
    get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 忽略 / ignore */ } },
  };
  let collapsed = new Set(store.get('erp_menu_collapsed', ['基础资料', '系统设置']));
  /** 应用整栏收起状态 / apply the whole-sidebar collapsed state */
  const applySide = () => document.getElementById('app').classList.toggle('side-collapsed', !!store.get('erp_side_collapsed', false));

  /**
   * 菜单项是否可见 / Whether a menu item is visible for the current user.
   * @param {string|null} mod
   * @returns {boolean}
   */
  function visible(mod) {
    const meta = ERP.state.meta;
    if (!mod) return true;
    if (mod === '*audit') return ['quote', 'order', 'purchase'].some((m) => can(m, 'audit')) || meta.user.scope !== 'designer';
    if (mod === '*task') return ['order', 'purchase', 'production', 'receivable'].some((m) => can(m, 'edit'));
    if (mod.endsWith(':noDesigner')) return meta.user.scope !== 'designer' && can(mod.split(':')[0], 'view');
    return can(mod, 'view');
  }

  /** 渲染菜单 / Render the sidebar menu */
  function renderMenu() {
    const svg = (k) => `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="${ICONS[k]}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    const groups = MENU.map(([g, icon, items]) => {
      const vis = items.filter(([, , m]) => visible(m));
      if (!vis.length) return '';
      const open = !collapsed.has(g);
      return `<div class="menu-group ${open ? 'open' : ''}" data-group="${esc(g)}">
        <button type="button" class="menu-group-head" aria-expanded="${open}" aria-label="${esc(g)}（点击展开/收起）">${svg(icon)}<span>${esc(g)}</span><i class="chev" aria-hidden="true"></i></button>
        <div class="menu-items">${vis.map(([l, h]) => `<a class="menu-item" href="${h}"><span>${esc(l)}</span><span class="badge hidden" data-badge="${h}"></span></a>`).join('')}</div></div>`;
    }).join('');
    const menu = document.getElementById('menu');
    menu.innerHTML = `<div class="menu-tools"><button type="button" class="link-btn side-collapse-btn" id="sideCollapse" title="收起整个左侧栏，点顶部 ☰ 可再展开">« 收起侧栏</button>
      <span><button type="button" class="link-btn" data-all="close">全部收起</button><button type="button" class="link-btn" data-all="open">全部展开</button></span></div>${groups}`;
    menu.querySelector('#sideCollapse').onclick = () => { store.set('erp_side_collapsed', true); applySide(); };
    menu.querySelectorAll('.menu-group-head').forEach((b) => {
      b.onclick = () => {
        const grp = b.parentElement;
        const open = !grp.classList.contains('open');
        grp.classList.toggle('open', open);
        b.setAttribute('aria-expanded', String(open));
        if (open) collapsed.delete(grp.dataset.group); else collapsed.add(grp.dataset.group);
        store.set('erp_menu_collapsed', [...collapsed]);
      };
    });
    menu.querySelectorAll('[data-all]').forEach((b) => {
      b.onclick = () => {
        const open = b.dataset.all === 'open';
        collapsed = open ? new Set() : new Set(MENU.map(([g]) => g));
        store.set('erp_menu_collapsed', [...collapsed]);
        menu.querySelectorAll('.menu-group').forEach((grp) => {
          grp.classList.toggle('open', open);
          grp.querySelector('.menu-group-head').setAttribute('aria-expanded', String(open));
        });
        if (!open) syncMenu(true);
      };
    });
    syncMenu();
  }

  /**
   * 高亮当前页面所属菜单，并展开其所在板块 / Highlight the current entry and expand its group.
   * @param {boolean} [keepCollapsed] 不改变记忆的折叠状态 / do not persist expansion
   */
  function syncMenu(keepCollapsed) {
    const path = (location.hash.slice(1) || '/').split('?')[0];
    let href = '#' + path;
    if (!document.querySelector(`.menu-item[href="${CSS.escape(href)}"]`)) {
      const p = PARENT.find(([pre]) => path.startsWith(pre));
      if (p) href = p[1];
    }
    document.querySelectorAll('.menu-item').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === href));
    const active = document.querySelector('.menu-item.active');
    const grp = active && active.closest('.menu-group');
    if (grp && !grp.classList.contains('open')) {
      grp.classList.add('open');
      grp.querySelector('.menu-group-head').setAttribute('aria-expanded', 'true');
      if (!keepCollapsed) { collapsed.delete(grp.dataset.group); store.set('erp_menu_collapsed', [...collapsed]); }
    }
  }

  /** 刷新待办角标 / Refresh pending badges */
  async function refreshBadges() {
    try {
      const [a, t] = await Promise.all([
        get('/api/approvals').catch(() => ({ rows: [] })),
        get('/api/change-tasks?status=' + encodeURIComponent('待处理')).catch(() => ({ rows: [] })),
      ]);
      const set = (h, n) => { const el = document.querySelector(`[data-badge="${h}"]`); if (el) { el.textContent = n; el.classList.toggle('hidden', !n); } };
      const auditable = a.rows.filter((x) => x.status === '待审批' && can({ quote: 'quote', payment: 'purchase', order: 'order' }[x.target_type], 'audit'));
      set('#/approvals', auditable.length);
      set('#/change-tasks', t.rows.length);
    } catch { /* 忽略 / ignore */ }
  }

  /** 重新加载元数据 / Reload metadata and menu */
  async function reloadMeta() {
    ERP.state.meta = await get('/api/meta');
    ERP.clearOptions();
    const m = ERP.state.meta;
    document.getElementById('userName').textContent = m.user.name;
    document.getElementById('roleTag').textContent = m.user.role_name;
    document.getElementById('brandName').textContent = m.company.name || '陶瓷工艺品外贸ERP';
    renderMenu();
    refreshBadges();
  }
  ERP.reloadMeta = reloadMeta;
  ERP.refreshBadges = refreshBadges;

  /** 进入系统 / Enter the application after login */
  async function enter() {
    try {
      await reloadMeta();
    } catch {
      return ERP.logout(true);
    }
    document.getElementById('login').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    if (ERP.state.meta.user.must_change) { passwordDialog(true); return; }
    ERP.navigate();
  }

  /**
   * 前端即时检查密码规则（最终以服务器校验为准）/ Live client-side password checklist (server is authoritative).
   * @param {string} pw
   * @param {string} username
   * @returns {[string, boolean][]}
   */
  const pwChecks = (pw, username) => [
    ['至少10位', pw.length >= 10], ['大写字母', /[A-Z]/.test(pw)], ['小写字母', /[a-z]/.test(pw)], ['数字', /[0-9]/.test(pw)],
    ['特殊符号', /[^A-Za-z0-9]/.test(pw)], ['不含账号名', !username || !pw.toLowerCase().includes(username.toLowerCase())],
    ['无3个相同字符', !/(.)\1\1/.test(pw)],
  ];

  /**
   * 修改密码弹窗 / Password change dialog.
   * @param {boolean} [forced] 强制修改（不可取消）/ forced (cannot be dismissed)
   */
  function passwordDialog(forced = false) {
    if (document.querySelector('.modal.pwd')) return;
    const username = ERP.state.meta ? ERP.state.meta.user.username : '';
    const m = modal({
      title: forced ? '首次登录 / 临时密码：请先修改密码' : '修改密码', cls: 'pwd',
      body: `${forced ? '<div class="alert warn">为了账号安全，当前密码为初始密码、临时密码或不符合安全要求，必须修改后才能继续使用系统。</div>' : ''}
        <div class="form-grid"><label>原密码<input type="password" name="old_password" autocomplete="current-password"></label>
        <label>新密码<input type="password" name="new_password" autocomplete="new-password" maxlength="64"></label>
        <label>确认新密码<input type="password" name="confirm" autocomplete="new-password" maxlength="64"></label></div>
        <div class="pw-rules" id="pwRules"></div>`,
      buttons: [{
        text: '保存新密码', cls: 'primary', onClick: async (mm) => {
          const f = readForm(mm.el);
          if (f.new_password !== f.confirm) throw new Error('两次输入的新密码不一致');
          await post('/api/password', { old_password: f.old_password, new_password: f.new_password });
          mm.close();
          toast('密码已修改，其它设备上的登录已自动退出', 'ok');
          if (forced) await enter();
        },
      }],
    });
    if (forced) {
      m.el.querySelector('[data-x]').remove();
      const foot = m.el.querySelector('.modal-foot .btn:last-child');
      foot.textContent = '退出登录';
      foot.onclick = () => { m.close(); ERP.logout(); };
    }
    const rules = m.el.querySelector('#pwRules');
    const render = () => {
      const pw = m.el.querySelector('[name=new_password]').value;
      rules.innerHTML = `密码要求：${pwChecks(pw, username).map(([t, ok]) => `<span class="${pw ? (ok ? 'ok' : 'no') : ''}">${ok && pw ? '✓' : '·'} ${t}</span>`).join('　')}`;
    };
    m.el.querySelector('[name=new_password]').addEventListener('input', render);
    render();
  }
  ERP.forcePasswordChange = () => passwordDialog(true);

  /** 登录页演示账号表 / Demo account table on the login page */
  async function renderDemoAccounts() {
    const box = document.getElementById('demoAccounts');
    try {
      const info = await get('/api/public/login-info');
      if (!info.show_demo_accounts || !info.accounts.length) { box.classList.add('hidden'); return; }
      box.innerHTML = `<div class="muted small" style="margin-bottom:6px">演示账号（点「填入」后直接登录，密码不在页面显示）：</div>
        <table class="demo-table"><thead><tr><th>岗位</th><th>账号</th><th>密码</th><th></th></tr></thead><tbody>
        ${info.accounts.map((a) => `<tr><td>${esc(a.role_name)}<span class="muted">　${esc(a.name)}</span></td><td><code>${esc(a.username)}</code></td>
          <td><span class="pw-mask" aria-label="密码已隐藏">●●●●●●●●</span></td><td><button type="button" class="btn small" data-fill="${esc(a.username)}">填入</button></td></tr>`).join('')}</tbody></table>`;
      box.classList.remove('hidden');
      box.querySelectorAll('[data-fill]').forEach((b) => {
        b.onclick = () => {
          const f = document.getElementById('loginForm');
          f.username.value = b.dataset.fill;
          f.password.value = '';
          // 演示账号由服务器验证，密码框不放真实密码（浏览器密码管理器也拿不到）/ verified server-side; no real password in the field
          f.dataset.demo = b.dataset.fill;
          f.password.required = false;
          f.password.placeholder = '●●●●●●●●（演示账号，已自动填入）';
          f.querySelector('button[type=submit]').focus();
        };
      });
    } catch {
      box.classList.add('hidden');
    }
  }

  const loginForm = document.getElementById('loginForm');
  /** 手动修改账号或输入密码时取消演示登录 / typing cancels demo mode */
  const clearDemo = () => {
    if (!loginForm.dataset.demo) return;
    if (loginForm.username.value.trim() === loginForm.dataset.demo && !loginForm.password.value) return;
    delete loginForm.dataset.demo;
    loginForm.password.required = true;
    loginForm.password.placeholder = '请输入密码';
  };
  loginForm.username.addEventListener('input', clearDemo);
  loginForm.password.addEventListener('input', clearDemo);
  loginForm.onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const btn = f.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const username = f.username.value.trim();
      const demo = f.dataset.demo && f.dataset.demo === username && !f.password.value;
      const r = demo ? await post('/api/public/demo-login', { username }) : await post('/api/login', { username, password: f.password.value });
      delete f.dataset.demo;
      f.password.required = true;
      f.password.placeholder = '请输入密码';
      ERP.state.token = r.token;
      localStorage.setItem('erp_token', r.token);
      f.password.value = '';
      location.hash = '#/';
      await enter();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  };
  document.getElementById('logoutBtn').onclick = () => ERP.logout();
  document.getElementById('pwdBtn').onclick = () => passwordDialog(false);
  // 手机：抽屉菜单；电脑：整个左侧栏收起/展开（记住状态）/ phone: drawer; desktop: collapse the whole sidebar (remembered)
  applySide();
  document.getElementById('menuToggle').onclick = () => {
    if (window.matchMedia('(max-width: 860px)').matches) {
      document.getElementById('sidebar').classList.toggle('open');
      document.getElementById('backdrop').classList.toggle('show');
    } else {
      store.set('erp_side_collapsed', !store.get('erp_side_collapsed', false));
      applySide();
    }
  };

  document.getElementById('backdrop').onclick = () => {
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('backdrop').classList.remove('show');
  };
  window.addEventListener('hashchange', () => { if (ERP.state.meta) { ERP.navigate(); syncMenu(); refreshBadges(); } });

  // 咨询方式：一键复制 QQ 号 / contact: copy the QQ number
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-copy]');
    if (!b) return;
    try {
      await navigator.clipboard.writeText(b.dataset.copy);
      toast(`已复制 QQ 号 ${b.dataset.copy}，可在 QQ 中添加好友咨询`, 'ok');
    } catch {
      toast(`QQ：${b.dataset.copy}（请手动复制）`);
    }
  });

  renderDemoAccounts();
  if (ERP.state.token) enter(); else ERP.logout(true);
})();
