'use strict';
/**
 * 启动：登录、岗位化菜单、待办角标
 * Bootstrap: login, role-based menu and pending badges.
 */
(() => {
  const { esc, get, post, toast, modal, readForm, can } = ERP;

  /** 菜单（按业务流程排序）/ Menu ordered by business flow: [label, href, module] */
  const MENU = [
    ['工作台', [['工作台首页', '#/', null], ['审批中心', '#/approvals', '*audit'], ['变更联动任务', '#/change-tasks', '*task']]],
    ['一期 · 基础档案', [['系统权限管理', '#/system', 'system'], ['部门', '#/e/department', 'hr'], ['员工档案', '#/e/employee', 'hr'],
      ['供应商', '#/e/supplier', 'supplier'], ['历史供货价格', '#/e/supplier_price', 'supplier'], ['服务机构', '#/e/agency', 'agency'], ['机构对接记录', '#/e/agency_record', 'agency'],
      ['客户档案', '#/e/customer', 'customer'], ['客户跟进/询盘', '#/e/customer_follow', 'customer']]],
    ['二期 · 外贸开发', [['业务邮件', '#/e/mail', 'mail'], ['样品档案', '#/e/sample', 'sample'], ['改样日志', '#/e/sample_revision', 'sample'],
      ['币种汇率', '#/e/currency', 'trade'], ['汇率波动记录', '#/e/rate_history', 'trade'], ['贸易术语', '#/e/trade_term', 'trade'],
      ['报价单', '#/quotes', 'quote'], ['工厂询价台账', '#/inquiries', 'quote:noDesigner'], ['送样单', '#/sends', 'sendsample']]],
    ['三期 · 订单出货', [['销售订单', '#/orders', 'order'], ['出货台账', '#/shipments', 'order']]],
    ['四期 · 财务收付', [['应收款与开票', '#/receivables', 'receivable'], ['采购单', '#/purchases', 'purchase'], ['应付与进项票', '#/payables', 'purchase'], ['物料库存', '#/e/inventory', 'purchase']]],
    ['五期 · 生产管控', [['布产进度', '#/production', 'production']]],
    ['六期 · 统计分析', [['统计报表', '#/reports/business', 'report'], ['设计师速查中心', '#/designer', 'designer']]],
  ];

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
    const html = MENU.map(([g, items]) => {
      const vis = items.filter(([, , m]) => visible(m));
      if (!vis.length) return '';
      return `<div class="menu-group"><div>${esc(g)}</div>${vis.map(([l, h]) => `<a class="menu-item" href="${h}">${esc(l)}<span class="badge hidden" data-badge="${h}"></span></a>`).join('')}</div>`;
    }).join('');
    document.getElementById('menu').innerHTML = html;
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
    document.getElementById('brandName').textContent = m.company.name || '陶瓷工贸ERP';
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
    ERP.navigate();
  }

  const demo = [['admin', '超级管理员'], ['sales1', '业务员林晓明'], ['sales2', '业务员王芳'], ['manager1', '业务经理'], ['designer1', '设计师张雕塑'], ['designer2', '设计师李彩绘'],
    ['purchase1', '采购'], ['prod1', '生产'], ['finance1', '财务'], ['hr1', '人事']];
  document.getElementById('demoAccounts').innerHTML = demo.map(([u, l]) => `<button type="button" class="chip" data-u="${u}">${esc(l)}</button>`).join('');
  document.querySelectorAll('[data-u]').forEach((b) => {
    b.onclick = () => { const f = document.getElementById('loginForm'); f.username.value = b.dataset.u; f.password.value = '123456'; f.querySelector('button[type=submit]').focus(); };
  });
  document.getElementById('loginForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const r = await post('/api/login', { username: f.username.value.trim(), password: f.password.value });
      ERP.state.token = r.token;
      localStorage.setItem('erp_token', r.token);
      location.hash = '#/';
      await enter();
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  document.getElementById('logoutBtn').onclick = () => ERP.logout();
  document.getElementById('pwdBtn').onclick = () => modal({
    title: '修改密码', body: '<div class="form-grid"><label>原密码<input type="password" name="old_password"></label><label>新密码（至少6位）<input type="password" name="new_password"></label></div>',
    buttons: [{ text: '保存', cls: 'primary', onClick: async (m) => { await post('/api/password', readForm(m.el)); m.close(); toast('密码已修改', 'ok'); } }],
  });
  document.getElementById('menuToggle').onclick = () => {
    document.getElementById('sidebar').classList.toggle('open');
    document.getElementById('backdrop').classList.toggle('show');
  };
  document.getElementById('backdrop').onclick = () => {
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('backdrop').classList.remove('show');
  };
  window.addEventListener('hashchange', () => { if (ERP.state.meta) { ERP.navigate(); refreshBadges(); } });

  if (ERP.state.token) enter(); else ERP.logout(true);
})();
