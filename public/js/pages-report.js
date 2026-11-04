'use strict';
/**
 * 工作台、审批中心、统计报表、设计师速查中心
 * Dashboard, approval center, statistical reports and designer quick-query center.
 */
(() => {
  const { esc, money, get, post, toast, modal, tableHtml, tag, can, route, setTitle, exportTable, printHtml, optHtml, options, readForm, barChart } = ERP;

  // ---------- 工作台 / dashboard ----------
  route(/^\/$/, async (_, main) => {
    setTitle('工作台');
    if (ERP.state.meta.user.scope === 'designer') { location.hash = '#/designer'; return; }
    const d = await get('/api/dashboard');
    const groups = {};
    for (const a of d.alerts) (groups[a.type] = groups[a.type] || []).push(a);
    main.innerHTML = `<div class="cards">${d.cards.map((c) => `<a class="card" href="${c.link}"><div class="l">${esc(c.label)}</div><div class="v">${esc(c.value)}</div></a>`).join('')}</div>
      <div class="panel"><div class="panel-head"><h2>待办与预警 <span class="muted small">${d.alerts.length} 项</span></h2></div>
        ${d.alerts.length ? Object.entries(groups).map(([type, list]) => `<h3 style="margin:10px 0 6px">${esc(type)} <span class="muted small">${list.length}</span></h3>
          ${list.map((a) => `<div class="alert ${a.level}"><span>${esc(a.text)}</span> <a href="${a.link}">去处理 →</a></div>`).join('')}`).join('') : '<div class="empty">暂无待办，一切正常 ✓</div>'}</div>
      <div class="panel"><h3 class="section-title">业务流程导航</h3>
        <div class="toolbar">${[
    ['customer', '#/e/customer', '① 客户档案'], ['sample', '#/e/sample', '② 样品档案'], ['quote', '#/quotes', '③ 报价+工厂询价'], ['sendsample', '#/sends', '④ 送样/改样'],
    ['order', '#/orders', '⑤ 订单(风控)'], ['production', '#/production', '⑥ 布产'], ['purchase', '#/purchases', '⑦ 采购付款'], ['order', '#/shipments', '⑧ 出货验货'],
    ['receivable', '#/receivables', '⑨ 收款开票'], ['report', '#/reports/business', '⑩ 统计报表'],
  ].filter(([m]) => can(m, 'view')).map(([, h, l]) => `<a class="btn" href="${h}">${l}</a>`).join('<span class="muted">→</span>')}</div></div>`;
  });

  // ---------- 审批中心（移动端友好）/ approvals ----------
  route(/^\/approvals$/, async (_, main) => {
    setTitle('审批中心');
    const { rows } = await get('/api/approvals');
    const modOf = { quote: 'quote', order: 'order', payment: 'purchase' };
    const link = (a) => (a.target_type === 'quote' ? `#/quote/${a.target_id}` : a.target_type === 'payment' ? '#/purchases' : '#/');
    main.innerHTML = `<div class="panel"><div class="panel-head"><h2>审批中心</h2><span class="muted small">手机浏览器同样可审批</span></div>
      ${tableHtml(['类型', '单号', '审批事项', '申请人', '提交时间', '状态', '审批人/意见', ''], rows.map((a) => [{ quote: '报价审批', payment: '付款审批', order: '订单审批' }[a.target_type],
    `<a href="${link(a)}">${esc(a.target_no)}</a>`, esc(a.title), esc(a.applicant), esc(a.created_at), tag(a.status), `${esc(a.approver)} ${esc(a.note)}`,
    a.status === '待审批' && can(modOf[a.target_type], 'audit') ? `<button class="btn small primary" data-ok="${a.id}">通过</button> <button class="btn small danger" data-ng="${a.id}">驳回</button>` : '']))}</div>`;
    const decide = (id, pass) => modal({ title: pass ? '审批通过' : '审批驳回', body: `<label class="field">审批意见<textarea name="note">${pass ? '同意' : ''}</textarea></label>`,
      buttons: [{ text: '确定', cls: pass ? 'primary' : 'danger', onClick: async (m) => { await post(`/api/approvals/${id}/decide`, { pass, ...readForm(m.el) }); m.close(); toast('已审批', 'ok'); ERP.navigate(); ERP.refreshBadges(); } }] });
    main.querySelectorAll('[data-ok]').forEach((b) => { b.onclick = () => decide(b.dataset.ok, true); });
    main.querySelectorAll('[data-ng]').forEach((b) => { b.onclick = () => decide(b.dataset.ng, false); });
  });

  // ---------- 统计报表 / reports ----------
  route(/^\/reports\/(\w+)$/, async ([kind], main, qs) => {
    const list = await get('/api/reports');
    const from = qs.get('from') || '';
    const to = qs.get('to') || '';
    const rep = await get(`/api/reports/${kind}?from=${from}&to=${to}`);
    setTitle(rep.title);
    main.innerHTML = `<div class="panel"><div class="tabs">${list.map((r) => `<a class="tab ${r.key === kind ? 'active' : ''}" href="#/reports/${r.key}">${esc(r.title.replace('统计', ''))}</a>`).join('')}</div>
      <div class="toolbar"><label class="small muted">开始</label><input type="date" id="from" value="${esc(from)}" style="width:150px"><label class="small muted">结束</label><input type="date" id="to" value="${esc(to)}" style="width:150px">
      <button class="btn primary" id="go">查询</button>${can('report', 'print') ? '<button class="btn" id="prt">打印</button>' : ''}<span class="muted small">生成时间 ${esc(rep.generated_at)}（实时统计）</span></div></div>
      ${rep.sections.map((s, i) => `<div class="panel"><div class="panel-head"><h3>${esc(s.title)}</h3>${can('report', 'export') ? `<button class="btn small" data-exp="${i}">导出Excel</button>` : ''}</div>
        ${s.chart && s.rows.length ? barChart(s.rows.map((r) => ({ label: r[s.chart.label], value: Number(r[s.chart.value]) || 0 }))) : ''}
        ${tableHtml(s.headers, s.rows.map((r) => r.map((c) => (typeof c === 'number' ? money(c).replace(/\.00$/, '') : esc(c)))))}</div>`).join('')}`;
    main.querySelector('#go').onclick = () => { location.hash = `#/reports/${kind}?from=${main.querySelector('#from').value}&to=${main.querySelector('#to').value}`; };
    main.querySelectorAll('[data-exp]').forEach((b) => { const s = rep.sections[b.dataset.exp]; b.onclick = () => exportTable('report', `${rep.title}-${s.title}`, s.headers, s.rows); });
    const pb = main.querySelector('#prt');
    if (pb) pb.onclick = () => printHtml(`<h1>${esc(rep.title)}</h1><div class="sub">${from || '全部'} ~ ${to || '至今'}　生成：${esc(rep.generated_at)}</div>${rep.sections.map((s) => `<h3>${esc(s.title)}</h3>${tableHtml(s.headers, s.rows.map((r) => r.map(esc)))}`).join('')}`);
  });

  // ---------- 设计师速查中心 / designer center ----------
  route(/^\/designer$/, async (_, main, qs) => {
    setTitle('设计师速查中心');
    const isDesigner = ERP.state.meta.user.scope === 'designer';
    let did = qs.get('designer_id') || '';
    let picker = '';
    if (!isDesigner) {
      const emps = await options('employee');
      picker = `<label class="small muted">选择设计师</label><select id="dsel" style="width:200px">${optHtml(emps, did)}</select>`;
      if (!did) {
        main.innerHTML = `<div class="panel"><div class="toolbar">${picker}</div><div class="empty">管理员视角：请选择要查看的设计师</div></div>`;
        main.querySelector('#dsel').onchange = (e) => { location.hash = '#/designer?designer_id=' + e.target.value; };
        return;
      }
    }
    const dq = isDesigner ? '' : `designer_id=${did}&`;
    const tab = qs.get('tab') || 'samples';
    const filters = { item_no: qs.get('item_no') || '', from: qs.get('from') || '', to: qs.get('to') || '', status: qs.get('status') || '' };
    const [sum, detail] = await Promise.all([
      get(`/api/designer/summary?${dq}`),
      get(`/api/designer/detail/${tab}?${dq}${new URLSearchParams(filters).toString()}`),
    ]);
    const s = sum.summary;
    const tabs = [['samples', '① 个人样品档案'], ['quotes', '② 关联报价单'], ['sends', '③ 关联送样单'], ['orders', '④ 关联客户订单'], ['shipments', '⑤ 关联出货记录']];
    main.innerHTML = `<div class="panel"><div class="panel-head"><h2>设计师：${esc(sum.designer.name)}</h2><div class="toolbar">${picker}<span class="muted small">数据截至 ${esc(sum.as_of)}，仅含本人设计样品，只读</span></div></div>
      <div class="cards">
        <div class="card"><div class="l">设计样品数</div><div class="v">${s.samples}</div></div><div class="card"><div class="l">被报价次数</div><div class="v">${s.quote_lines}</div></div>
        <div class="card"><div class="l">送样次数</div><div class="v">${s.send_lines}</div></div><div class="card"><div class="l">下单数量</div><div class="v">${s.order_qty}</div></div>
        <div class="card"><div class="l">下单金额¥</div><div class="v">${money(s.order_amount_cny)}</div></div><div class="card"><div class="l">已出货数量</div><div class="v">${s.shipped_qty}</div></div>
        <div class="card"><div class="l">已下单未出货</div><div class="v">${s.unshipped_qty}</div></div><div class="card" style="outline:2px solid var(--primary)"><div class="l">提成核算基数（已出货金额¥）</div><div class="v">${money(s.shipped_amount_cny)}</div></div>
      </div>
      <h3 style="margin:6px 0">按货号汇总</h3>${tableHtml(['货号', '品名', '原货号', '状态', '报价次数', '送样次数', '下单数量', '已出货数量', '已出货金额¥'], sum.samples.map((x) => [esc(x.company_no), esc(x.name), esc(x.parent_no), tag(x.status), x.quotes, x.sends, x.order_qty, x.shipped_qty, money(x.shipped_amount_cny)]), new Set([4, 5, 6, 7, 8]))}</div>
      <div class="panel"><div class="tabs">${tabs.map(([k, l]) => `<button class="tab ${k === tab ? 'active' : ''}" data-tab="${k}">${l}</button>`).join('')}</div>
        <form class="form-grid" id="flt" onsubmit="return false" style="margin-bottom:12px"><label>货号<input name="item_no" value="${esc(filters.item_no)}"></label>
          <label>开始日期<input type="date" name="from" value="${esc(filters.from)}"></label><label>结束日期<input type="date" name="to" value="${esc(filters.to)}"></label>
          <label>状态<input name="status" value="${esc(filters.status)}" placeholder="如 已成交/已锁定"></label>
          <div style="align-self:end" class="toolbar"><button class="btn primary" id="go">查询</button>${can('designer', 'export') ? '<button class="btn" id="exp">导出Excel</button>' : ''}${can('designer', 'print') ? '<button class="btn" id="prt">打印对账单</button>' : ''}</div></form>
        ${tableHtml(detail.headers, detail.rows.map((r) => r.map((c) => esc(c))))}</div>`;
    const base = isDesigner ? '#/designer?' : `#/designer?designer_id=${did}&`;
    const ds = main.querySelector('#dsel');
    if (ds) ds.onchange = (e) => { location.hash = '#/designer?designer_id=' + e.target.value; };
    main.querySelectorAll('[data-tab]').forEach((b) => { b.onclick = () => { location.hash = `${base}tab=${b.dataset.tab}`; }; });
    main.querySelector('#go').onclick = () => { location.hash = `${base}tab=${tab}&${new URLSearchParams(readForm(main.querySelector('#flt'))).toString()}`; };
    const eb = main.querySelector('#exp');
    if (eb) eb.onclick = () => exportTable('designer', `${sum.designer.name}-${detail.title}`, detail.headers, detail.rows);
    const pb = main.querySelector('#prt');
    if (pb) {
      pb.onclick = () => printHtml(`<h1>设计师提成对账单</h1><div class="sub">设计师：${esc(sum.designer.name)}　截至：${esc(sum.as_of)}</div>
        <table><tr><td>设计样品数：${s.samples}</td><td>报价次数：${s.quote_lines}</td><td>送样次数：${s.send_lines}</td><td>下单数量：${s.order_qty}</td></tr>
        <tr><td>下单金额¥：${money(s.order_amount_cny)}</td><td>已出货数量：${s.shipped_qty}</td><td>未出货数量：${s.unshipped_qty}</td><td><b>提成基数¥：${money(s.shipped_amount_cny)}</b></td></tr></table>
        <h3>${esc(detail.title)}</h3>${tableHtml(detail.headers, detail.rows.map((r) => r.map(esc)))}
        <div class="doc-foot"><div><b>设计师签字：</b></div><div><b>财务/人事签字：</b></div></div>`);
    }
  });
})();
