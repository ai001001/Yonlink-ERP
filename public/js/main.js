'use strict';
/**
 * 启动：登录、岗位化菜单、待办角标
 * Bootstrap: login, role-based menu and pending badges.
 */
(() => {
  const { esc, get, post, toast, modal, readForm, can } = ERP;
  const origLogout = ERP.logout;
  ERP.logout = async (silent) => { await origLogout(silent); renderDemoAccounts(); };

  /** 菜单（按业务流程排序）/ Menu ordered by business flow: [label, href, module] */
  const MENU = [
    ['工作台', [['工作台首页', '#/', null], ['审批中心', '#/approvals', '*audit'], ['变更联动任务', '#/change-tasks', '*task']]],
    ['一期 · 基础档案', [['系统权限管理', '#/system', 'system'], ['部门', '#/e/department', 'hr'], ['员工档案', '#/e/employee', 'hr'],
      ['供应商', '#/e/supplier', 'supplier'], ['历史供货价格', '#/e/supplier_price', 'supplier'], ['服务机构', '#/e/agency', 'agency'], ['机构对接记录', '#/e/agency_record', 'agency'],
      ['客户档案', '#/e/customer', 'customer'], ['客户跟进/询盘', '#/e/customer_follow', 'customer']]],
    ['二期 · 外贸开发', [['业务邮件', '#/mails', 'mail'], ['邮箱账户', '#/mail-accounts', 'mail'], ['样品档案', '#/e/sample', 'sample'], ['改样日志', '#/e/sample_revision', 'sample'],
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
      box.innerHTML = `<div class="muted small" style="margin-bottom:6px">演示账号（仅供体验，正式使用请由管理员关闭展示并修改密码）：</div>
        <table class="demo-table"><thead><tr><th>岗位</th><th>账号</th><th>密码</th><th></th></tr></thead><tbody>
        ${info.accounts.map((a) => `<tr><td>${esc(a.role_name)}<span class="muted">　${esc(a.name)}</span></td><td><code>${esc(a.username)}</code></td><td><code>${esc(a.password)}</code></td>
          <td><button type="button" class="btn small" data-fill="${esc(a.username)}">填入</button></td></tr>`).join('')}</tbody></table>`;
      box.classList.remove('hidden');
      box.querySelectorAll('[data-fill]').forEach((b) => {
        b.onclick = () => {
          const a = info.accounts.find((x) => x.username === b.dataset.fill);
          const f = document.getElementById('loginForm');
          f.username.value = a.username;
          f.password.value = a.password;
          f.querySelector('button[type=submit]').focus();
        };
      });
    } catch {
      box.classList.add('hidden');
    }
  }

  document.getElementById('loginForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const btn = f.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const r = await post('/api/login', { username: f.username.value.trim(), password: f.password.value });
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
  document.getElementById('menuToggle').onclick = () => {
    document.getElementById('sidebar').classList.toggle('open');
    document.getElementById('backdrop').classList.toggle('show');
  };
  document.getElementById('backdrop').onclick = () => {
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('backdrop').classList.remove('show');
  };
  window.addEventListener('hashchange', () => { if (ERP.state.meta) { ERP.navigate(); refreshBadges(); } });

  renderDemoAccounts();
  if (ERP.state.token) enter(); else ERP.logout(true);
})();
