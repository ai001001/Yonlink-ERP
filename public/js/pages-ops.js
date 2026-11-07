'use strict';
/**
 * 运营页面：订单出货（变更风控）、采购付款、应收开票、生产布产
 * Operations pages: orders & shipments (change risk control), purchasing, receivables, production.
 */
(() => {
  const { esc, money, get, post, put, del, toast, modal, tableHtml, tag, can, route, setTitle, exportTable, printHtml, confirmBox, optHtml, options, readForm } = ERP;
  const today = () => new Date().toISOString().slice(0, 10);
  /** 部门 → 处理权限（与后端一致）/ department → permission, mirrors the backend */
  const DEPT_PERM = { 采购: ['purchase', 'edit'], 生产: ['production', 'edit'], 财务: ['receivable', 'edit'], 业务: ['order', 'edit'] };
  const canHandle = (dept) => can(...DEPT_PERM[dept]);

  /**
   * 小按钮工厂 / Toolbar button factory.
   * @param {HTMLElement} box 容器 / container
   * @returns {(text:string, cls:string, fn:Function)=>void}
   */
  const btnFactory = (box) => (text, cls, fn) => {
    const b = document.createElement('button');
    b.className = 'btn ' + cls;
    b.textContent = text;
    b.onclick = async () => { try { await fn(); } catch (e) { toast(e.message, 'error'); } };
    box.appendChild(b);
  };

  // ---------- 订单列表 / order list ----------
  route(/^\/orders$/, async (_, main, qs) => {
    setTitle('订单管理');
    const q = qs.get('q') || '';
    const { rows } = await get(`/api/orders?q=${encodeURIComponent(q)}`);
    await ERP.grid(main, {
      key: 'doc.orders', title: '销售订单', mode: 'client', rows, module: 'order', q,
      onKeyword: (kw) => { location.hash = '#/orders?q=' + encodeURIComponent(kw); },
      toolbar: can('order', 'add') ? '<a class="btn primary" href="#/order/new">＋ 新建订单</a>' : '',
      columns: [
        { key: 'order_no', label: '订单号', html: (r) => `<a href="#/order/${r.id}">${esc(r.order_no)}</a>` },
        { key: 'customer_name', label: '客户' }, { key: 'country', label: '国别' }, { key: 'salesman_name', label: '业务员' }, { key: 'item_nos', label: '货号' },
        { key: 'amount', label: '金额', num: true, html: (r) => `${money(r.amount)} ${esc(r.currency)}` }, { key: 'currency', label: '币种' }, { key: 'term', label: '术语' },
        { key: 'order_date', label: '下单日期' }, { key: 'delivery_date', label: '交期' },
        { key: 'risk', label: '风控', text: (r) => (r.risk_lock ? '锁定' : ''), html: (r) => (r.risk_lock ? `<span class="tag danger">锁定·待办${r.pending_tasks}</span>` : '') },
        { key: 'status', label: '状态', html: (r) => tag(r.status) },
      ],
      defaultCols: ['order_no', 'customer_name', 'country', 'salesman_name', 'item_nos', 'amount', 'order_date', 'delivery_date', 'risk', 'status'],
      tree: [{ key: 'salesman_name', label: '业务员' }, { key: 'customer_name', label: '客户' }, { key: 'country', label: '国别' }, { key: 'status', label: '状态' },
        { key: 'currency', label: '币种' }, { key: 'month', label: '下单月份', text: (r) => String(r.order_date || '').slice(0, 7) }, { key: 'risk', label: '风控', text: (r) => (r.risk_lock ? '锁定' : '正常') }],
      schemes: [['salesman_name', 'customer_name'], ['status'], ['country', 'customer_name'], ['month']],
      quick: [{ key: 'order_no', label: '订单号' }, { key: 'customer_name', label: '客户' }, { key: 'item_nos', label: '货号' }, { key: 'salesman_name', label: '业务员' }],
    });
  });

  /**
   * 订单变更风险弹窗 / Order change risk confirmation modal.
   * @param {object} risk 后端返回的风控详情 / risk detail
   * @returns {Promise<string|null>} 变更原因，取消返回 null / change reason or null
   */
  function riskModal(risk) {
    return new Promise((resolve) => {
      const m = modal({
        title: `⚠ ${risk.error}`, wide: true, cls: 'risk',
        body: `<div class="alert danger"><span class="t">风险依据</span><div>${risk.reasons.map(esc).join('<br>')}</div></div>
          <h3 style="margin:10px 0 6px">本次变更内容</h3>
          ${tableHtml(['货号', '变更项', '变更前', '变更后', '关键参数'], risk.diff.map((d) => [esc(d.item_no || '订单'), esc(d.field), esc(d.before), esc(d.after), d.key ? '<span class="tag danger">是</span>' : '否']))}
          ${risk.purchases.length ? `<h3 style="margin:10px 0 6px">受影响采购单</h3>${tableHtml(['采购单', '供应商', '类型', '状态', '金额¥', '已入库', '已付款¥'], risk.purchases.map((p) => [esc(p.po_no), esc(p.supplier_name), esc(p.type), tag(p.status), money(p.amount), esc(p.received_qty), money(p.paid)]))}` : ''}
          ${risk.productions.length ? `<h3 style="margin:10px 0 6px">受影响布产单</h3>${tableHtml(['布产单', '货号', '计划数', '已完工', '状态'], risk.productions.map((p) => [esc(p.prod_no), esc(p.item_no), p.plan_qty, p.reported, tag(p.status)]))}` : ''}
          <div class="alert warn" style="margin-top:12px">${esc(risk.notice)}</div>
          <label class="field"><span class="req">变更原因 / 客户变更依据</span><textarea id="reason" placeholder="例如：客户邮件 2026-11-04 要求数量由500减为300"></textarea></label>`,
        buttons: [{
          text: '我已知晓风险，确认变更并派发联动任务', cls: 'danger solid', onClick: async (mm) => {
            const v = mm.el.querySelector('#reason').value.trim();
            if (!v) throw new Error('请填写变更原因');
            mm.close();
            resolve(v);
          },
        }],
      });
      m.el.querySelector('.modal-foot .btn:last-child').addEventListener('click', () => resolve(null));
      m.el.querySelector('[data-x]').addEventListener('click', () => resolve(null));
    });
  }

  /**
   * 订单成品库存面板：产品入库、按出货单销售出库、销售退货 / Finished goods of an order: in, issue per shipment, returns.
   * @param {HTMLElement} box
   * @param {object} o 订单 / order
   */
  async function loadFg(box, o) {
    const fg = await get(`/api/orders/${o.id}/fg`);
    const canIn = can('production', 'edit') || can('purchase', 'edit');
    const canOut = can('order', 'edit');
    box.innerHTML = `<div class="panel-head"><h3>成品库存（按订单）</h3>${canIn && !['已完成'].includes(o.status) ? '<button class="btn small primary" type="button" id="fgIn">产品入库</button>' : ''}</div>
      <p class="muted small">生产完工或外购成品到货后做“产品入库”，出货时按出货单“出库”。${fg.require_out ? '<b>系统参数要求出运前必须完成出库。</b>' : '是否出库不影响出运（可在系统参数中改为必须先出库）。'}</p>
      ${tableHtml(['货号', '订单数', '包装完工', '已入库', '已出库', '退货', '本订单在库', '已排出货', '已出运'], fg.lines.map((l) => [esc(l.item_no), l.qty, l.produced_qty, l.in_qty, l.out_qty, l.return_qty,
    `<b>${l.stock}</b>`, l.shipped_qty, l.departed_qty]), new Set([1, 2, 3, 4, 5, 6, 7, 8]))}
      ${fg.shipments.length ? `<h4 class="mig-sub">出货单出库情况</h4>${tableHtml(['出货单', '状态', '明细（出货/已出库/退货）', '出库', ''], fg.shipments.map((s) => [esc(s.ship_no), tag(s.status),
    s.lines.map((l) => `${esc(l.item_no)}：${l.qty} / ${l.out} / ${l.returned}`).join('<br>'), s.out_done ? tag('已完成') : '<span class="tag warn">未出库</span>',
    `${canOut && !s.out_done ? `<button class="btn small" type="button" data-fgout="${s.id}">出库</button> ` : ''}${canOut && s.lines.some((l) => l.out - l.returned > 0) ? `<button class="btn small" type="button" data-fgret="${s.id}">退货</button>` : ''}`]))}` : ''}`;
    const whs = async () => (await get('/api/e/warehouse?size=100')).rows.filter((w) => w.use_status !== '停用').map((w) => ({ id: w.id, label: w.name }));
    const ib = box.querySelector('#fgIn');
    if (ib) {
      ib.onclick = async () => modal({
        title: '产品入库（按订单）', wide: true,
        body: `<div class="form-grid"><label><span>仓库</span><select name="warehouse_id">${optHtml(await whs(), '', false)}</select></label><label><span>备注</span><input name="remark" placeholder="如：工厂交货/包装完工"></label></div>
          ${tableHtml(['货号', '订单数', '已入库', '本次入库', '单位成本¥（空=按样品成本）'], fg.lines.map((l) => [esc(l.item_no), l.qty, l.in_qty,
  `<input type="number" style="width:100px" data-fq="${l.order_item_id}" value="${Math.max(0, Math.min(l.qty - l.in_qty, Math.max(0, l.produced_qty - l.in_qty)) || '')}">`, `<input type="number" step="any" style="width:110px" data-fc="${l.order_item_id}">`]))}`,
        buttons: [{
          text: '确认入库', cls: 'primary', onClick: async (m) => {
            const items = fg.lines.map((l) => ({ order_item_id: l.order_item_id, qty: m.el.querySelector(`[data-fq="${l.order_item_id}"]`).value, unit_cost: m.el.querySelector(`[data-fc="${l.order_item_id}"]`).value })).filter((x) => Number(x.qty) > 0);
            await post(`/api/orders/${o.id}/fg-in`, { ...readForm(m.el.querySelector('.form-grid')), items });
            m.close(); toast('产品已入库', 'ok'); loadFg(box, o);
          },
        }],
      });
    }
    box.querySelectorAll('[data-fgout]').forEach((b) => {
      b.onclick = async () => { try { await post(`/api/shipments/${b.dataset.fgout}/fg-out`, {}); toast('已出库', 'ok'); loadFg(box, o); } catch (e) { toast(e.message, 'error'); } };
    });
    box.querySelectorAll('[data-fgret]').forEach((b) => {
      const s = fg.shipments.find((x) => x.id === Number(b.dataset.fgret));
      b.onclick = async () => modal({
        title: `销售退货：${s.ship_no}`, body: `<div class="form-grid"><label><span>退回仓库</span><select name="warehouse_id">${optHtml(await whs(), '', false)}</select></label>
          <label class="wide"><span class="req">退货原因</span><input name="reason" placeholder="如：客户退回破损品"></label></div>
          ${tableHtml(['货号', '已出库', '已退', '本次退货'], s.lines.map((l) => [esc(l.item_no), l.out, l.returned, `<input type="number" style="width:90px" data-rq="${l.order_item_id}">`]))}`,
        buttons: [{
          text: '确认退货', cls: 'primary', onClick: async (m) => {
            const items = s.lines.map((l) => ({ order_item_id: l.order_item_id, qty: m.el.querySelector(`[data-rq="${l.order_item_id}"]`).value })).filter((x) => Number(x.qty) > 0);
            await post(`/api/shipments/${s.id}/fg-return`, { ...readForm(m.el.querySelector('.form-grid')), items });
            m.close(); toast('已退货入库', 'ok'); loadFg(box, o);
          },
        }],
      });
    });
  }

  /**
   * 订单材料需求面板：按供应商分组，勾选后一键生成采购单 / Order material requirements grouped by supplier.
   * @param {HTMLElement} box
   * @param {object} o 订单 / order
   */
  async function loadBom(box, o) {
    const bom = await get(`/api/orders/${o.id}/bom`);
    if (!bom.lines.length) {
      box.innerHTML = '<h3 class="section-title">材料需求（按样品配件/包材明细分解）</h3><div class="muted small">订单货号还没有维护配件/包材明细（在样品详情“配件明细/包材明细”页签维护后，这里会自动算出需求）。</div>';
      return;
    }
    const canBuy = can('purchase', 'add') && !o.risk_lock;
    const groups = new Map();
    for (const l of bom.lines) {
      const k = l.supplier_id || 0;
      if (!groups.has(k)) groups.set(k, { id: l.supplier_id, name: l.supplier_name || '（未指定供应商）', lines: [] });
      groups.get(k).lines.push(l);
    }
    const suppliers = canBuy ? await options('supplier') : [];
    box.innerHTML = `<h3 class="section-title">材料需求（按样品配件/包材明细分解）</h3>
      <p class="muted small">需求 = 订单数量 × 用量（“每箱”按订单所选包装方案或样品装箱数折算箱数），已扣除本订单已下采购的数量。${o.risk_lock ? '订单被风控锁定，暂不能生成采购单。' : ''}</p>
      ${[...groups.values()].map((g, gi) => `<div style="border:1px solid var(--line);border-radius:6px;padding:8px;margin-bottom:8px">
        <div class="toolbar" style="margin-bottom:6px"><b>${esc(g.name)}</b>${canBuy ? `<select data-gsup="${gi}" style="width:180px">${optHtml(suppliers, g.id || '')}</select><button class="btn small primary" type="button" data-gbuy="${gi}">生成采购单</button>` : ''}</div>
        ${tableHtml(['', '货号', '类别', '物料编码', '名称', '规格', '用量', '需求', '已采购', '待采购', '本次采购', '单价¥'], g.lines.map((l) => [
    canBuy && l.remain > 0 ? `<input type="checkbox" data-gk="${gi}" value="${esc(l.key)}" checked>` : '', esc(l.item_no), esc(l.kind), esc(l.code), esc(l.name), esc(l.spec),
    `${l.usage}${l.per === '每箱' ? '/箱' : '/只'}`, l.need + (l.warn ? ` <span class="tag warn" title="${esc(l.warn)}">!</span>` : ''), l.purchased, l.remain > 0 ? `<b>${l.remain}</b>` : '0',
    canBuy && l.remain > 0 ? `<input type="number" step="any" style="width:90px" data-gq="${esc(l.key)}" value="${l.remain}">` : '', money(l.unit_price)]))}</div>`).join('')}`;
    box.querySelectorAll('[data-gbuy]').forEach((b) => {
      b.onclick = async () => {
        const gi = b.dataset.gbuy;
        const keys = [...box.querySelectorAll(`[data-gk="${gi}"]:checked`)].map((c) => c.value);
        const qty = Object.fromEntries(keys.map((k) => [k, Number(box.querySelector(`[data-gq="${CSS.escape(k)}"]`).value)]));
        try {
          const r = await post(`/api/orders/${o.id}/bom-purchase`, { supplier_id: box.querySelector(`[data-gsup="${gi}"]`).value, keys, qty });
          toast(`已生成采购单 ${r.po_no}`, 'ok');
          ERP.navigate();
        } catch (e) { toast(e.message, 'error'); }
      };
    });
  }

  // ---------- 订单详情/编辑 / order editor ----------
  route(/^\/order\/(new|\d+)$/, async ([id], main) => {
    const isNew = id === 'new';
    const o = isNew ? { items: [], status: '待确认', currency: 'USD', term: 'FOB', order_date: today(), invoice_due_days: 30, changes: [], shipments: [], purchases: [], productions: [] } : await get('/api/orders/' + id);
    setTitle(isNew ? '新建订单' : `订单 ${o.order_no}`);
    const designer = ERP.state.meta.user.scope === 'designer';
    const editable = !designer && (isNew ? can('order', 'add') : can('order', 'edit')) && !['已出货', '已完成'].includes(o.status) && !o.risk_lock;
    const [customers, samples, currencies, terms] = await Promise.all([options('customer'), options('sample'), options('currency'), options('trade_term')]);
    const dis = editable ? '' : 'disabled';
    const row = (it) => `<tr data-id="${it.id || ''}">
      <td style="min-width:190px"><select data-f="sample_id" ${dis}>${optHtml(it.sample_id && !samples.some((s) => s.id === it.sample_id) ? [{ id: it.sample_id, label: it.item_no + (it.sample_status === '已锁定' ? '（旧货号已锁定）' : '') }, ...samples] : samples, it.sample_id)}</select></td>
      <td style="min-width:140px"><input data-f="description" value="${esc(it.description)}" ${dis}></td>
      <td style="width:80px"><input data-f="qty" type="number" value="${esc(it.qty)}" ${dis}></td>
      <td style="width:90px"><input data-f="unit_price" type="number" step="any" value="${esc(it.unit_price)}" ${dis}></td>
      <td style="min-width:100px"><input data-f="craft" value="${esc(it.craft)}" ${dis}></td>
      <td style="min-width:100px"><input data-f="spec" value="${esc(it.spec)}" ${dis}></td>
      <td style="min-width:110px"><input data-f="package" value="${esc(it.package)}" ${dis}></td>
      <td style="min-width:120px"><select data-f="package_plan_id" data-plan="${esc(it.package_plan_id || '')}" ${dis}><option value="${esc(it.package_plan_id || '')}">${esc(it.package_plan_name || '（样品默认）')}</option></select></td>
      <td class="num">${it.id ? `${it.produced_qty || 0} / ${it.shipped_qty || 0}` : ''}</td>
      <td>${editable ? '<button class="btn small danger" data-rm type="button">删</button>' : ''}</td></tr>`;
    const tasksHtml = (c) => tableHtml(['部门', '联动修正内容', '状态', '处理人', '处理说明', ''], c.tasks.map((t) => [esc(t.dept), esc(t.content), tag(t.status), esc(t.handler), esc(t.handle_note),
      t.status === '待处理' ? (canHandle(t.dept) ? `<button class="btn small primary" data-task="${t.id}">处理</button>` : `<span class="muted small">待${esc(t.dept)}处理</span>`) : esc(t.handled_at)]));
    main.innerHTML = `${o.risk_lock ? '<div class="lock-banner">🔒 订单已被变更风控锁定：存在未处理的联动修正任务。锁定期间禁止再次修改订单、新增采购、新增布产、安排出货/报关出运。各部门处理完毕后自动解锁。</div>' : ''}
      <div class="panel"><div class="panel-head"><h2>${isNew ? '新建订单' : esc(o.order_no)} ${tag(o.status)} ${!isNew && !designer ? `<span class="tag ${o.risk.level === '高' ? 'danger' : o.risk.level === '中' ? 'warn' : 'ok'}">变更风险：${esc(o.risk.level)}</span>` : ''}</h2>
        <div class="toolbar" id="actions"></div></div>
        <form class="form-grid" id="hdr">
          <label><span class="req">客户</span><select name="customer_id" ${dis}>${optHtml(customers, o.customer_id)}</select></label>
          <label><span class="req">币种</span><select name="currency" ${dis}>${optHtml(currencies, o.currency, false)}</select></label>
          <label><span>贸易术语</span><select name="term" ${dis}>${optHtml(terms, o.term, false)}</select></label>
          <label><span>汇率（空=最新）</span><input name="rate" type="number" step="any" value="${esc(o.rate)}" ${dis}></label>
          <label><span>下单日期</span><input name="order_date" type="date" value="${esc(o.order_date)}" ${dis}></label>
          <label><span class="req">交期</span><input name="delivery_date" type="date" value="${esc(o.delivery_date)}" ${dis}></label>
          <label><span>包装要求</span><input name="package_req" value="${esc(o.package_req)}" ${dis}></label>
          <label><span>工艺要求</span><input name="craft" value="${esc(o.craft)}" ${dis}></label>
          <label><span>出货后开票期限(天)</span><input name="invoice_due_days" type="number" value="${esc(o.invoice_due_days)}" ${dis}></label>
          <label class="wide"><span>备注</span><input name="remark" value="${esc(o.remark)}" ${dis}></label></form>
        ${!isNew ? `<div class="kv" style="margin-top:10px">${designer ? `<div><b>订单金额</b><span>${money(o.amount)} ${esc(o.currency)}</span></div>` : `<div><b>货款</b><span>${money(o.goods_amount)} ${esc(o.currency)}</span></div>
          <div><b>加减项</b><span>${money(o.charges_amount)}</span></div><div><b>合同总额</b><span><b>${money(o.amount)} ${esc(o.currency)}</b></span></div>`}${designer ? '' : `<div><b>已收款</b><span>${money(o.received)}</span></div><div><b>已开票</b><span>${money(o.invoiced)}</span></div>`}
          <div><b>业务员</b><span>${esc(o.salesman_name)}</span></div><div><b>来源报价</b><span>${o.quote_no ? `<a href="#/quote/${o.quote_id}">${esc(o.quote_no)}</a>` : '-'}</span></div></div>` : ''}</div>
      ${designer ? '' : `<div class="panel"><div class="panel-head"><h3>订单概要 / 合同条款 / 唛头</h3>${editable ? '<button class="btn small" type="button" id="markFromCust">从客户唛头带入</button>' : ''}</div>
        <form class="form-grid" id="sum">
          <label><span>客户PO号</span><input name="po_no" value="${esc(o.po_no)}" ${dis}></label>
          <label><span>形式发票号(PI)</span><input name="pi_no" value="${esc(o.pi_no)}" ${dis}></label>
          <label><span>付款方式</span><input name="pay_terms" value="${esc(o.pay_terms)}" placeholder="如 T/T 30% DEPOSIT" ${dis}></label>
          <label><span>预收订金比率%</span><input name="deposit_rate" type="number" step="any" value="${esc(o.deposit_rate)}" ${dis}></label>
          <label><span>起运港</span><input name="port_loading" value="${esc(o.port_loading)}" ${dis}></label>
          <label><span>目的港</span><input name="port_dest" value="${esc(o.port_dest)}" ${dis}></label>
          <label><span>运输方式</span><input name="transport" value="${esc(o.transport)}" placeholder="海运/空运/快递" ${dis}></label>
          <label><span>分批装运</span><select name="partial_shipment" ${dis}>${optHtml(['允许', '不允许'], o.partial_shipment)}</select></label>
          <label><span>转运</span><select name="transshipment" ${dis}>${optHtml(['允许', '不允许'], o.transshipment)}</select></label>
          <label><span>保险</span><input name="insurance" value="${esc(o.insurance)}" ${dis}></label>
          <label><span>签约地点</span><input name="sign_place" value="${esc(o.sign_place)}" ${dis}></label>
          <label class="wide"><span>合同条款</span><textarea name="contract_terms" rows="3" ${dis}>${esc(o.contract_terms)}</textarea></label>
          <label class="wide"><span>工厂条款（给工厂的要求）</span><textarea name="factory_terms" rows="2" ${dis}>${esc(o.factory_terms)}</textarea></label>
          <label><span>正唛</span><textarea name="front_mark" rows="4" ${dis}>${esc(o.front_mark)}</textarea></label>
          <label><span>侧唛</span><textarea name="side_mark" rows="4" ${dis}>${esc(o.side_mark)}</textarea></label>
          <label><span>内盒唛</span><textarea name="inner_mark" rows="4" ${dis}>${esc(o.inner_mark)}</textarea></label>
        </form>${isNew ? '<p class="muted small">新订单留空的付款方式、目的港、唛头会自动从客户档案带出。</p>' : ''}</div>`}
      <div class="panel"><div class="panel-head"><h3>订单产品 ${designer ? '<span class="muted small">（仅显示本人设计样品）</span>' : ''}</h3>${editable ? '<span class="toolbar"><button class="btn" id="histItem" type="button">历史记录导入</button><button class="btn" id="addItem" type="button">＋ 添加产品</button></span>' : ''}</div>
        <div class="table-wrap items-table"><table><thead><tr><th>货号</th><th>描述</th><th>数量</th><th>单价</th><th>工艺</th><th>规格</th><th>包装</th><th>包装方案</th><th class="num">完工/已排出货</th><th></th></tr></thead><tbody id="items">${o.items.map(row).join('')}</tbody></table></div></div>
      ${isNew || designer ? '' : `
      <div class="panel"><h3 class="section-title">订单变更记录与联动修正任务</h3>
        ${o.changes.length ? o.changes.map((c) => `<div style="border:1px solid var(--line);border-radius:6px;padding:10px;margin-bottom:10px">
          <div class="toolbar" style="margin-bottom:6px"><b>${esc(c.change_no)}</b> ${tag(c.status)} <span class="tag ${c.risk_level === '高' ? 'danger' : c.risk_level === '中' ? 'warn' : 'info'}">风险${esc(c.risk_level)}</span>
          <span class="muted small">${esc(c.user_name)} ${esc(c.created_at)}</span></div>
          <div class="small">变更：${c.diff.map((d) => `${esc(d.item_no || '')} ${esc(d.field)} <s>${esc(d.before)}</s> → <b>${esc(d.after)}</b>`).join('；')}</div>
          ${c.reason ? `<div class="small muted">原因：${esc(c.reason)}</div>` : ''}
          ${c.tasks.length ? `<div style="margin-top:8px">${tasksHtml(c)}</div>` : ''}</div>`).join('') : '<div class="empty">暂无变更</div>'}</div>
      <div class="panel"><div class="panel-head"><h3>出货与验货</h3>${can('order', 'edit') && !o.risk_lock && !['已出货', '已完成'].includes(o.status) ? '<button class="btn" id="newShip">＋ 安排出货</button>' : ''}</div>
        ${tableHtml(['出货单', '发票', '出货日期', '起运/目的港', '货代', '柜号', '报关单号', '明细', '验货', '状态', ''], o.shipments.map((s) => [esc(s.ship_no), s.invoice_id ? `<a href="#/invoice/${s.invoice_id}">${esc(s.invoice_no)}</a>` : '-', esc(s.ship_date), `${esc(s.port)} → ${esc(s.dest_port)}`, esc(s.forwarder_name), esc(s.container_no), esc(s.customs_no),
    s.items.map((i) => `${esc(i.item_no)}×${i.qty}(${i.cartons}箱/${i.cbm}m³)`).join('<br>'), tag(s.inspection_status) + (s.inspection_note ? `<div class="small muted">${esc(s.inspection_note)}</div>` : ''), tag(s.status),
    can('order', 'edit') && s.status !== '已出运' && s.status !== '已取消' ? `<button class="btn small" data-ship="${s.id}">更新</button> <a class="btn small" href="#/inspection/new?order_id=${o.id}&shipment_id=${s.id}">验货单</a>` : '']))}</div>
      <div class="grid2">
        <div class="panel"><div class="panel-head"><h3>关联采购</h3>${can('purchase', 'add') && !o.risk_lock ? `<a class="btn small" href="#/purchase/new?order_id=${o.id}">＋ 新建采购</a>` : ''}</div>
          ${tableHtml(['采购单', '供应商', '状态', '金额¥', '已入库', '已付¥'], o.purchases.map((p) => [can('purchase', 'view') ? `<a href="#/purchase/${p.id}">${esc(p.po_no)}</a>` : esc(p.po_no), esc(p.supplier_name), tag(p.status), money(p.amount), esc(p.received_qty), money(p.paid)]))}</div>
        <div class="panel"><div class="panel-head"><h3>布产进度</h3>${can('production', 'add') && !o.risk_lock && !['已出货', '已完成'].includes(o.status) ? '<button class="btn small" id="produce">一键布产</button>' : ''}</div>
          ${tableHtml(['布产单', '货号', '计划', '完工', '状态'], o.productions.map((p) => [can('production', 'view') ? `<a href="#/production/${p.id}">${esc(p.prod_no)}</a>` : esc(p.prod_no), esc(p.item_no), p.plan_qty, p.reported, tag(p.status)]))}</div>
      </div>
      <div class="panel" id="fgPanel"><h3 class="section-title">成品库存（按订单）</h3><div class="muted small">加载中…</div></div>
      <div class="panel" id="bomPanel"><h3 class="section-title">材料需求（按样品配件/包材明细分解）</h3><div class="muted small">加载中…</div></div>
      <div class="panel"><div class="panel-head"><h3>加减项（模具费、样品费、折扣、佣金扣减等）</h3>${can('order', 'edit') && o.status !== '已完成' ? '<button class="btn small" type="button" id="addCharge">＋ 登记加减项</button>' : ''}</div>
        ${tableHtml(['类型', '费用名称', '金额', '备注', '登记人', '时间', ''], o.charges.map((c) => [c.kind === '减' ? '<span class="tag warn">减</span>' : '<span class="tag ok">加</span>', esc(c.name), money(c.amount), esc(c.remark), esc(c.user_name), esc(c.created_at),
    can('order', 'edit') && o.status !== '已完成' ? `<button class="btn small danger" type="button" data-delc="${c.id}">删除</button>` : '']))}
        <div class="kv" style="margin-top:8px"><div><b>货款</b><span>${money(o.goods_amount)}</span></div><div><b>加减合计</b><span>${money(o.charges_amount)}</span></div><div><b>合同总额（应收）</b><span><b>${money(o.amount)} ${esc(o.currency)}</b></span></div></div></div>
      <div class="panel"><h3 class="section-title">效益测算（预估 vs 实际）</h3>
        ${tableHtml(['项目', '预估（下单时）', '实际（按采购/领料）'], [
    ['销售收入¥', money(o.estimate.revenue_cny), money(o.cost.revenue_cny)],
    ['产品成本¥', money(o.estimate.cost), money(o.cost.purchase_cost + o.cost.material_cost)],
    [`客户佣金¥（${o.estimate.commission_rate}%）`, money(o.estimate.commission), '-'],
    ['汇兑损益¥', '-', money(o.cost.fx_gain)],
    ['<b>毛利¥</b>', `<b>${money(o.estimate.profit)}</b>`, `<b>${money(o.cost.profit)}</b>`],
    ['毛利率', o.estimate.profit_rate === null ? '-' : `${o.estimate.profit_rate}%`, o.cost.revenue_cny > 0 ? `${Math.round(o.cost.profit / o.cost.revenue_cny * 10000) / 100}%` : '-'],
  ])}
        <details style="margin-top:8px"><summary class="small">预估成本明细（按货号）</summary>${tableHtml(['货号', '数量', '单位成本¥', '成本来源', '成本¥'], o.estimate.lines.map((l) => [esc(l.item_no), l.qty, money(l.unit_cost), esc(l.source), money(l.cost)]))}</details></div>`}`;
    const tbody = main.querySelector('#items');
    // 包装方案下拉：按货号加载该样品的方案 / package-plan dropdown loaded per sample
    const planCache = {};
    const fillPlans = async (tr) => {
      const sid = tr.querySelector('[data-f="sample_id"]').value;
      const sel = tr.querySelector('[data-f="package_plan_id"]');
      if (!sel) return;
      if (!sid) { sel.innerHTML = '<option value="">（样品默认）</option>'; return; }
      if (!planCache[sid]) planCache[sid] = get(`/api/e/sample_package?f_sample_id=${sid}&size=50`).then((d) => d.rows).catch(() => []);
      const plans = await planCache[sid];
      const curVal = sel.dataset.plan || sel.value;
      sel.innerHTML = `<option value="">（样品默认）</option>${plans.map((pl) => `<option value="${pl.id}" ${String(pl.id) === String(curVal) ? 'selected' : ''}>${esc(pl.name)}（${pl.outer_qty}只/箱）</option>`).join('')}`;
    };
    const bindRm = () => {
      tbody.querySelectorAll('[data-rm]').forEach((b) => { b.onclick = () => b.closest('tr').remove(); });
      tbody.querySelectorAll('tr').forEach((tr) => {
        const ss = tr.querySelector('[data-f="sample_id"]');
        if (ss && !ss.dataset.planBound) { ss.dataset.planBound = '1'; ss.addEventListener('change', () => { const sel = tr.querySelector('[data-f="package_plan_id"]'); if (sel) sel.dataset.plan = ''; fillPlans(tr); }); fillPlans(tr); }
      });
    };
    bindRm();
    const ai = main.querySelector('#addItem');
    if (ai) ai.onclick = () => { tbody.insertAdjacentHTML('beforeend', row({})); bindRm(); };
    const hi = main.querySelector('#histItem');
    if (hi) {
      hi.onclick = () => {
        const cid = main.querySelector('#hdr [name="customer_id"]').value;
        if (!cid) { toast('请先选择客户', 'error'); return; }
        ERP.historyPicker(cid, (rows) => {
          for (const r of rows) tbody.insertAdjacentHTML('beforeend', row({ sample_id: r.sample_id, description: r.description, qty: r.qty, unit_price: r.price, craft: r.craft, spec: r.spec, package: r.package }));
          bindRm();
        });
      };
    }
    const mfc = main.querySelector('#markFromCust');
    if (mfc) {
      mfc.onclick = async () => {
        const cid = main.querySelector('#hdr [name="customer_id"]').value;
        if (!cid) { toast('请先选择客户', 'error'); return; }
        const { rows } = await get(`/api/e/customer_mark?f_customer_id=${cid}&size=50`);
        if (!rows.length) { toast('该客户还没有维护唛头（客户详情 → 唛头页签）', 'error'); return; }
        const fill = (m) => { for (const k of ['front_mark', 'side_mark', 'inner_mark']) main.querySelector(`#sum [name="${k}"]`).value = m[k] || ''; toast(`已带入唛头「${m.name}」`, 'ok'); };
        if (rows.length === 1) { fill(rows[0]); return; }
        const mm = modal({
          title: '选择客户唛头', body: tableHtml(['唛头名称', '正唛', '默认', ''], rows.map((m, i) => [esc(m.name), `<span class="pre">${esc(m.front_mark)}</span>`, esc(m.is_default), `<button class="btn small primary" type="button" data-pick="${i}">选用</button>`])),
        });
        mm.el.querySelectorAll('[data-pick]').forEach((b) => { b.onclick = () => { fill(rows[Number(b.dataset.pick)]); mm.close(); }; });
      };
    }
    const collect = () => {
      const h = Object.fromEntries([...main.querySelectorAll('#hdr [name], #sum [name]')].map((el) => [el.name, el.value]));
      h.items = [...tbody.querySelectorAll('tr')].map((tr) => ({ id: tr.dataset.id ? Number(tr.dataset.id) : undefined, ...Object.fromEntries([...tr.querySelectorAll('[data-f]')].map((el) => [el.dataset.f, el.value])) })).filter((x) => x.sample_id);
      return h;
    };
    const btn = btnFactory(main.querySelector('#actions'));
    if (editable) {
      btn(isNew ? '保存订单' : '保存变更', 'primary', async () => {
        const body = collect();
        if (isNew) { const r = await post('/api/orders', body); toast('订单已创建', 'ok'); location.hash = '#/order/' + r.id; return; }
        try {
          await put('/api/orders/' + id, body);
          toast('订单已保存', 'ok');
        } catch (e) {
          if (e.status !== 409 || !e.data || !e.data.risk) throw e;
          const reason = await riskModal(e.data);
          if (!reason) { toast('已取消变更'); return; }
          await put('/api/orders/' + id, { ...body, confirm_risk: true, change_reason: reason });
          toast('变更已保存，联动修正任务已派发至采购/生产/财务/业务，订单已锁定', 'ok');
        }
        ERP.navigate();
      });
    }
    if (!isNew && !designer) {
      if (can('order', 'edit') && o.status === '待确认') btn('确认订单(生产中)', '', async () => { await post(`/api/orders/${id}/status`, { status: '生产中' }); ERP.navigate(); });
      if (can('order', 'edit') && o.status === '已出货') btn('订单完结', '', async () => { await post(`/api/orders/${id}/status`, { status: '已完成' }); ERP.navigate(); });
      if (can('order', 'add')) {
        btn('翻单（复制为新订单）', '', () => modal({
          title: `翻单：复制 ${o.order_no} 为新订单`,
          body: '<p class="small muted">复制货号、数量、单价、条款与唛头；客户PO号、PI号、加减项不复制。已锁定的旧货号自动换成转正后的新货号。</p><label class="field"><span>新订单交期</span><input type="date" name="delivery_date"></label>',
          buttons: [{ text: '生成新订单', cls: 'primary', onClick: async (m) => { const r = await post(`/api/orders/${id}/copy`, readForm(m.el)); m.close(); toast(`已生成新订单 ${r.order_no}`, 'ok'); location.hash = '#/order/' + r.id; } }],
        }));
      }
      const fp = main.querySelector('#fgPanel');
      if (fp) loadFg(fp, o).catch((e) => { fp.innerHTML = `<div class="alert warn"><span>${esc(e.message)}</span></div>`; });
      const bp = main.querySelector('#bomPanel');
      if (bp) loadBom(bp, o).catch((e) => { bp.innerHTML = `<div class="alert warn"><span>${esc(e.message)}</span></div>`; });
      const ac = main.querySelector('#addCharge');
      if (ac) {
        ac.onclick = () => modal({
          title: '登记加减项', body: `<div class="form-grid"><label><span class="req">类型</span><select name="kind">${optHtml(['加', '减'], '加', false)}</select></label>
            <label><span class="req">费用名称</span><input name="name" placeholder="模具费 / 样品费 / 折扣 / 佣金扣减"></label>
            <label><span class="req">金额（${esc(o.currency)}）</span><input name="amount" type="number" step="any"></label><label class="wide"><span>备注</span><input name="remark"></label></div>`,
          buttons: [{ text: '保存', cls: 'primary', onClick: async (m) => { const r = await post(`/api/orders/${id}/charges`, readForm(m.el)); m.close(); toast(`已登记，合同总额 ${money(r.amount)} ${o.currency}`, 'ok'); ERP.navigate(); } }],
        });
      }
      main.querySelectorAll('[data-delc]').forEach((b) => {
        b.onclick = async () => { if (!(await confirmBox('删除这条加减项？'))) return; try { await del(`/api/orders/${id}/charges/${b.dataset.delc}`); toast('已删除', 'ok'); ERP.navigate(); } catch (e) { toast(e.message, 'error'); } };
      });
      if (can('order', 'print')) {
        btn('打印订单(PI)', '', () => printHtml(`<h1>${esc(ERP.state.meta.company.name)}</h1><div class="sub">${esc(ERP.state.meta.company.name_en)}<br><b style="font-size:15px">形式发票 / 销售确认书 PROFORMA INVOICE</b></div>
          <table style="margin-bottom:8px"><tr><td>订单号 No.: ${esc(o.order_no)}</td><td>客户: ${esc(o.customer_name)}（${esc(o.country)}）</td><td>日期: ${esc(o.order_date)}</td></tr>
          <tr><td>贸易术语: ${esc(o.term)}</td><td>交期: ${esc(o.delivery_date)}</td><td>包装: ${esc(o.package_req)}</td></tr></table>
          <table><thead><tr><th>No.</th><th>货号</th><th>描述</th><th>工艺</th><th>规格</th><th>包装</th><th>数量</th><th>单价</th><th>金额</th></tr></thead><tbody>
          ${o.items.map((i, n) => `<tr><td>${n + 1}</td><td>${esc(i.item_no)}</td><td>${esc(i.description)}</td><td>${esc(i.craft)}</td><td>${esc(i.spec)}</td><td>${esc(i.package)}</td><td>${i.qty}</td><td>${money(i.unit_price)}</td><td>${money(i.qty * i.unit_price)}</td></tr>`).join('')}
          <tr><td colspan="8" style="text-align:right">货款 Goods ${esc(o.currency)}</td><td>${money(o.goods_amount)}</td></tr>
          ${o.charges.map((c) => `<tr><td colspan="8" style="text-align:right">${c.kind === '减' ? '减 Less' : '加 Add'}：${esc(c.name)}</td><td>${c.kind === '减' ? '-' : ''}${money(c.amount)}</td></tr>`).join('')}
          <tr><td colspan="8" style="text-align:right"><b>合同总额 Total ${esc(o.currency)}</b></td><td><b>${money(o.amount)}</b></td></tr></tbody></table>
          <table style="margin-top:8px"><tr><td>客户PO No.: ${esc(o.po_no)}</td><td>PI No.: ${esc(o.pi_no)}</td><td>付款方式 Payment: ${esc(o.pay_terms)}${o.deposit_rate ? `（订金 ${o.deposit_rate}%）` : ''}</td></tr>
          <tr><td>起运港 Loading: ${esc(o.port_loading)}</td><td>目的港 Destination: ${esc(o.port_dest)}</td><td>运输 Transport: ${esc(o.transport)}　分批: ${esc(o.partial_shipment)}　转运: ${esc(o.transshipment)}</td></tr></table>
          ${o.contract_terms ? `<h3>合同条款 Terms</h3><div class="pre">${esc(o.contract_terms)}</div>` : ''}
          ${o.front_mark || o.side_mark ? `<h3>唛头 Shipping Marks</h3><table><tr><th>正唛 Front</th><th>侧唛 Side</th><th>内盒 Inner</th></tr><tr><td class="pre">${esc(o.front_mark)}</td><td class="pre">${esc(o.side_mark)}</td><td class="pre">${esc(o.inner_mark)}</td></tr></table>` : ''}`));
      }
      if (can('order', 'export')) btn('导出Excel', '', () => exportTable('order', `订单${o.order_no}`, ['货号', '描述', '数量', '单价', '金额', '工艺', '规格', '包装', '已出货'], o.items.map((i) => [i.item_no, i.description, i.qty, i.unit_price, i.qty * i.unit_price, i.craft, i.spec, i.package, i.shipped_qty])));
      main.querySelectorAll('[data-task]').forEach((b) => {
        b.onclick = () => modal({ title: '处理联动修正任务', body: '<label class="field"><span class="req">处理结果说明</span><textarea name="note" placeholder="例如：冗余彩盒200个转入库存，已通知供应商停止后续交货"></textarea></label>',
          buttons: [{ text: '提交处理', cls: 'primary', onClick: async (m) => { const r = await post(`/api/change-tasks/${b.dataset.task}/handle`, readForm(m.el)); m.close(); toast(r.change_completed ? '该变更全部联动任务已完成' : '已处理', 'ok'); ERP.navigate(); } }] });
      });
      const pb = main.querySelector('#produce');
      if (pb) pb.onclick = async () => { try { const r = await post(`/api/orders/${id}/produce`, {}); toast(`已生成布产单：${r.created.join('、')}`, 'ok'); ERP.navigate(); } catch (e) { toast(e.message, 'error'); } };
      const ns = main.querySelector('#newShip');
      if (ns) {
        ns.onclick = async () => {
          const fwd = (await get('/api/e/agency?f_type=' + encodeURIComponent('货代公司')).catch(() => ({ rows: [] }))).rows.map((a) => ({ id: a.id, label: a.name }));
          modal({
            title: '安排出货', wide: true,
            body: `<div class="form-grid"><label>出货日期<input type="date" name="ship_date" value="${today()}"></label><label>起运港<input name="port" value="厦门"></label>
              <label>目的港<input name="dest_port"></label><label>货代<select name="forwarder_id">${optHtml(fwd, '')}</select></label><label>船名航次<input name="vessel"></label><label>柜号<input name="container_no"></label></div>
              <h3 style="margin:12px 0 6px">出货数量</h3>${tableHtml(['货号', '订单数', '已排出货', '本次出货', '箱数(空=按装箱数自动)'], o.items.map((i) => [esc(i.item_no), i.qty, i.shipped_qty,
  `<input type="number" data-oi="${i.id}" value="${Math.max(0, i.qty - i.shipped_qty)}">`, `<input type="number" data-ct="${i.id}">`]))}`,
            buttons: [{
              text: '生成出货单', cls: 'primary', onClick: async (m) => {
                const items = [...m.el.querySelectorAll('[data-oi]')].map((el) => ({ order_item_id: Number(el.dataset.oi), qty: el.value, cartons: m.el.querySelector(`[data-ct="${el.dataset.oi}"]`).value }));
                const f = {};
                m.el.querySelectorAll('.form-grid [name]').forEach((el) => { f[el.name] = el.value; });
                const r = await post(`/api/orders/${id}/shipments`, { ...f, items });
                m.close(); toast(`出货单 ${r.ship_no} 已生成`, 'ok'); ERP.navigate();
              },
            }],
          });
        };
      }
      main.querySelectorAll('[data-ship]').forEach((b) => {
        const s = o.shipments.find((x) => x.id === Number(b.dataset.ship));
        b.onclick = () => modal({
          title: `更新出货单 ${s.ship_no}（验货闭环）`,
          body: `<div class="form-grid"><label>验货结果<select name="inspection_status">${optHtml(['待验货', '合格', '不合格'], s.inspection_status, false)}</select></label>
            <label>出货状态<select name="status">${optHtml(['计划中', '已报关', '已出运', '已取消'], s.status, false)}</select></label>
            <label>报关单号<input name="customs_no" value="${esc(s.customs_no)}"></label><label>柜号<input name="container_no" value="${esc(s.container_no)}"></label>
            <label>出货日期<input type="date" name="ship_date" value="${esc(s.ship_date)}"></label><label>目的港<input name="dest_port" value="${esc(s.dest_port)}"></label>
            <label class="wide">验货问题/整改记录<textarea name="inspection_note">${esc(s.inspection_note)}</textarea></label></div>`,
          buttons: [{ text: '保存', cls: 'primary', onClick: async (m) => { await put('/api/shipments/' + s.id, readForm(m.el)); m.close(); toast('出货单已更新', 'ok'); ERP.navigate(); } }],
        });
      });
    }
  });

  // ---------- 变更联动任务中心 / change tasks ----------
  route(/^\/change-tasks$/, async (_, main, qs) => {
    setTitle('订单变更联动任务');
    const st = qs.get('status') ?? '待处理';
    const { rows } = await get('/api/change-tasks?status=' + encodeURIComponent(st));
    main.innerHTML = `<div class="panel"><div class="panel-head"><h2>订单变更联动修正任务</h2><select id="st" style="width:140px">${optHtml(['待处理', '已处理'], st)}</select></div>
      <div class="alert info">订单在已采购/已入库/已付款/已报工后发生关键参数变更时，系统强制派发本部门任务；全部处理完毕后订单自动解锁。</div>
      ${tableHtml(['订单', '变更单', '风险', '部门', '内容', '状态', '处理人', '处理说明', ''], rows.map((t) => [`<a href="#/order/${t.order_id}">${esc(t.order_no)}</a>`, esc(t.change_no), tag(t.risk_level), esc(t.dept), esc(t.content), tag(t.status), esc(t.handler), esc(t.handle_note),
    t.status === '待处理' ? `<button class="btn small primary" data-task="${t.id}">处理</button>` : '']))}</div>`;
    main.querySelector('#st').onchange = (e) => { location.hash = '#/change-tasks?status=' + encodeURIComponent(e.target.value); };
    main.querySelectorAll('[data-task]').forEach((b) => {
      b.onclick = () => modal({ title: '处理联动修正任务', body: '<label class="field"><span class="req">处理结果说明</span><textarea name="note"></textarea></label>',
        buttons: [{ text: '提交处理', cls: 'primary', onClick: async (m) => { await post(`/api/change-tasks/${b.dataset.task}/handle`, readForm(m.el)); m.close(); toast('已处理', 'ok'); ERP.navigate(); } }] });
    });
  });

  // ---------- 出货台账 / shipments ----------
  route(/^\/shipments$/, async (_, main) => {
    setTitle('出货台账');
    const { rows } = await get('/api/shipments');
    await ERP.grid(main, {
      key: 'doc.shipments', title: '出货台账（报关/海运）', mode: 'client', rows, module: 'order',
      columns: [
        { key: 'ship_no', label: '出货单' }, { key: 'invoice_no', label: '发票号', html: (s) => (s.invoice_id ? `<a href="#/invoice/${s.invoice_id}">${esc(s.invoice_no)}</a>` : '') },
        { key: 'order_no', label: '订单', html: (s) => `<a href="#/order/${s.order_id}">${esc(s.order_no)}</a>` },
        { key: 'customer_name', label: '客户' }, { key: 'country', label: '国别' }, { key: 'ship_date', label: '出货日期' },
        { key: 'port', label: '港口', text: (s) => `${s.port || ''}→${s.dest_port || ''}` }, { key: 'forwarder_name', label: '货代' }, { key: 'container_no', label: '柜号' },
        { key: 'customs_no', label: '报关单号' }, { key: 'qty', label: '数量', num: true }, { key: 'cbm', label: 'CBM', num: true },
        { key: 'inspection_status', label: '验货', html: (s) => tag(s.inspection_status) }, { key: 'status', label: '状态', html: (s) => tag(s.status) },
      ],
      tree: [{ key: 'customer_name', label: '客户' }, { key: 'country', label: '国别' }, { key: 'status', label: '状态' }, { key: 'inspection_status', label: '验货' },
        { key: 'forwarder_name', label: '货代' }, { key: 'month', label: '出货月份', text: (s) => String(s.ship_date || '').slice(0, 7) }],
      schemes: [['customer_name'], ['status'], ['month'], ['inspection_status']],
      quick: [{ key: 'ship_no', label: '出货单' }, { key: 'order_no', label: '订单' }, { key: 'container_no', label: '柜号' }, { key: 'customs_no', label: '报关单号' }],
    });
  });

  // ---------- 应收与开票 / receivables ----------
  route(/^\/receivables$/, async (_, main) => {
    setTitle('订单应收款与应开票');
    const { rows } = await get('/api/receivables');
    const remind = (r) => (r.invoice_overdue ? `逾期${r.overdue_days}天` : (r.first_ship_date && r.uninvoiced > 0 ? '待开票' : ''));
    await ERP.grid(main, {
      key: 'doc.receivables', title: '应收与开票台账', mode: 'client', rows, module: 'receivable',
      columns: [
        { key: 'order_no', label: '订单', html: (r) => `<a href="#/receivable/${r.id}">${esc(r.order_no)}</a>` }, { key: 'customer_name', label: '客户' }, { key: 'currency', label: '币种' },
        { key: 'amount', label: '应收', num: true, html: (r) => money(r.amount) }, { key: 'received', label: '实收', num: true, html: (r) => money(r.received) },
        { key: 'unreceived', label: '未收', num: true, html: (r) => money(r.unreceived) }, { key: 'fx_gain', label: '汇兑损益¥', num: true, html: (r) => money(r.fx_gain) },
        { key: 'invoiced', label: '已开票', num: true, html: (r) => money(r.invoiced) }, { key: 'uninvoiced', label: '未开票', num: true, html: (r) => money(r.uninvoiced) },
        { key: 'receive_status', label: '收款状态', html: (r) => tag(r.receive_status) },
        { key: 'remind', label: '开票提醒', text: remind, html: (r) => (r.invoice_overdue ? `<span class="tag danger">逾期${r.overdue_days}天</span>` : (remind(r) ? '<span class="tag warn">待开票</span>' : '')) },
      ],
      tree: [{ key: 'customer_name', label: '客户' }, { key: 'currency', label: '币种' }, { key: 'receive_status', label: '收款状态' }, { key: 'remind_type', label: '开票提醒', text: (r) => (r.invoice_overdue ? '开票逾期' : remind(r) || '无') }],
      schemes: [['receive_status', 'customer_name'], ['customer_name'], ['remind_type']],
      quick: [{ key: 'order_no', label: '订单' }, { key: 'customer_name', label: '客户' }],
      actions: (r) => `<a class="btn small" href="#/receivable/${r.id}">收款/开票</a>`,
    });
  });
  route(/^\/receivable\/(\d+)$/, async ([id], main) => {
    const [r, wo] = await Promise.all([get('/api/receivables/' + id), get(`/api/orders/${id}/writeoffs`)]);
    setTitle('应收开票：' + r.order_no);
    main.innerHTML = `<div class="panel"><div class="panel-head"><h2>${esc(r.order_no)} ${tag(r.receive_status)}</h2><div class="toolbar">
        ${can('receivable', 'add') ? '<button class="btn primary" id="rec">登记收款</button><button class="btn" id="inv">登记销项发票</button>' : ''}${can('receivable', 'audit') && r.unreceived > 0 ? '<button class="btn" id="wo">销账</button>' : ''}<a class="btn" href="#/receivables">返回</a></div></div>
      ${r.invoice_overdue ? `<div class="alert danger">已出货 ${r.overdue_days} 天未开票，请尽快开票！</div>` : ''}
      <div class="kv"><div><b>客户</b><span>${esc(r.customer_name)}</span></div><div><b>订单汇率</b><span>${esc(r.rate)}</span></div><div><b>应收</b><span>${money(r.amount)} ${esc(r.currency)}</span></div>
      <div><b>实收</b><span>${money(r.received)}</span></div>${r.written_off ? `<div><b>销账</b><span>${money(r.written_off)}</span></div>` : ''}<div><b>未收</b><span>${money(r.unreceived)}</span></div><div><b>汇兑损益¥</b><span>${money(r.fx_gain)}</span></div>
      <div><b>已开票</b><span>${money(r.invoiced)}</span></div><div><b>未开票余额</b><span>${money(r.uninvoiced)}</span></div><div><b>首次出运</b><span>${esc(r.first_ship_date)}</span></div></div></div>
      <div class="panel"><h3 class="section-title">收款记录</h3>${tableHtml(['日期', '类型', '金额', '收款汇率', '折人民币', '汇兑损益¥', '凭证', '备注'], r.receipts.map((x) => [esc(x.receipt_date), esc(x.type), `${money(x.amount)} ${esc(x.currency)}`, esc(x.rate), money(x.amount_cny), money(x.fx_gain), esc(x.voucher), esc(x.remark)]))}</div>
      ${wo.rows.length ? `<div class="panel"><h3 class="section-title">销账记录（小额差异）</h3>${tableHtml(['时间', '金额', '原因', '操作人', ''], wo.rows.map((x) => [esc(x.created_at), money(x.amount), esc(x.reason), esc(x.user_name),
    can('receivable', 'audit') ? `<button class="btn small danger" type="button" data-dwo="${x.id}">撤销</button>` : '']))}</div>` : ''}
      <div class="panel"><h3 class="section-title">销项发票台账</h3>${tableHtml(['发票号码', '开票日期', '金额', '备注', ''], r.invoices.map((x) => [esc(x.invoice_no), esc(x.invoice_date), money(x.amount), esc(x.remark), can('receivable', 'delete') ? `<button class="btn small danger" data-dinv="${x.id}">作废</button>` : '']))}</div>`;
    const rb = main.querySelector('#rec');
    if (rb) {
      rb.onclick = () => modal({ title: '登记收款', body: `<div class="form-grid"><label><span class="req">类型</span><select name="type">${optHtml(['预收', '尾款', '分期'], '预收', false)}</select></label>
        <label><span class="req">金额(${esc(r.currency)})</span><input name="amount" type="number" step="any" value="${r.unreceived}"></label><label>收款汇率（空=最新）<input name="rate" type="number" step="any"></label>
        <label>收款日期<input type="date" name="receipt_date" value="${today()}"></label><label>凭证号<input name="voucher"></label><label>备注<input name="remark"></label></div>`,
      buttons: [{ text: '保存', cls: 'primary', onClick: async (m) => { await post('/api/receipts', { order_id: r.id, ...readForm(m.el) }); m.close(); toast('收款已登记', 'ok'); ERP.navigate(); } }] });
    }
    const ib = main.querySelector('#inv');
    if (ib) {
      ib.onclick = () => modal({ title: '登记销项发票', body: `<div class="form-grid"><label><span class="req">发票号码</span><input name="invoice_no"></label><label><span class="req">金额</span><input name="amount" type="number" step="any" value="${r.uninvoiced}"></label>
        <label>开票日期<input type="date" name="invoice_date" value="${today()}"></label><label>备注<input name="remark"></label></div>`,
      buttons: [{ text: '保存', cls: 'primary', onClick: async (m) => { await post('/api/sales-invoices', { order_id: r.id, ...readForm(m.el) }); m.close(); toast('发票已登记', 'ok'); ERP.navigate(); } }] });
    }
    const wb = main.querySelector('#wo');
    if (wb) {
      wb.onclick = () => modal({ title: '销账（银行扣费、汇率尾差等小额差异）', body: `<div class="form-grid"><label><span class="req">销账金额(${esc(r.currency)})</span><input name="amount" type="number" step="any" value="${r.unreceived}"></label>
        <label class="wide"><span class="req">原因</span><input name="reason" placeholder="例如：客户付款被中间行扣费"></label></div><p class="muted small">单笔上限由系统参数 ar_writeoff_max 控制（默认 50）。</p>`,
      buttons: [{ text: '确认销账', cls: 'primary', onClick: async (m) => { await post(`/api/orders/${id}/writeoff`, readForm(m.el)); m.close(); toast('已销账', 'ok'); ERP.navigate(); } }] });
    }
    main.querySelectorAll('[data-dwo]').forEach((b) => { b.onclick = async () => { if (await confirmBox('撤销这笔销账？')) { try { await del('/api/writeoffs/' + b.dataset.dwo); ERP.navigate(); } catch (e) { toast(e.message, 'error'); } } }; });
    main.querySelectorAll('[data-dinv]').forEach((b) => { b.onclick = async () => { if (await confirmBox('作废该发票登记？')) { await del('/api/sales-invoices/' + b.dataset.dinv); ERP.navigate(); } }; });
  });

  // ---------- 采购 / purchases ----------
  route(/^\/purchases$/, async (_, main, qs) => {
    setTitle('采购管理');
    const q = qs.get('q') || '';
    const { rows } = await get('/api/purchases?q=' + encodeURIComponent(q));
    await ERP.grid(main, {
      key: 'doc.purchases', title: '采购单（原辅材料/外购成品）', mode: 'client', rows, module: 'purchase', q,
      onKeyword: (kw) => { location.hash = '#/purchases?q=' + encodeURIComponent(kw); },
      toolbar: can('purchase', 'add') ? '<a class="btn primary" href="#/purchase/new">＋ 新建采购</a>' : '',
      columns: [
        { key: 'po_no', label: '采购单', html: (p) => `<a href="#/purchase/${p.id}">${esc(p.po_no)}</a>` }, { key: 'type', label: '类型' }, { key: 'supplier_name', label: '供应商' },
        { key: 'order_no', label: '关联订单', html: (p) => (p.order_no ? `<a href="#/order/${p.order_id}">${esc(p.order_no)}</a>` : '-') },
        { key: 'amount', label: '金额¥', num: true, html: (p) => money(p.amount) }, { key: 'paid', label: '已付¥', num: true, html: (p) => money(p.paid) },
        { key: 'invoiced', label: '已收票¥', num: true, html: (p) => money(p.invoiced) }, { key: 'order_date', label: '下单日期' }, { key: 'due_date', label: '交货期' },
        { key: 'qc_status', label: '质检', html: (p) => tag(p.qc_status) }, { key: 'status', label: '状态', html: (p) => tag(p.status) },
      ],
      defaultCols: ['po_no', 'type', 'supplier_name', 'order_no', 'amount', 'paid', 'invoiced', 'due_date', 'qc_status', 'status'],
      tree: [{ key: 'supplier_name', label: '供应商' }, { key: 'type', label: '类型' }, { key: 'status', label: '状态' }, { key: 'qc_status', label: '质检' },
        { key: 'month', label: '下单月份', text: (p) => String(p.order_date || p.created_at || '').slice(0, 7) }],
      schemes: [['supplier_name'], ['type', 'status'], ['qc_status'], ['month']],
      quick: [{ key: 'po_no', label: '采购单' }, { key: 'supplier_name', label: '供应商' }, { key: 'order_no', label: '关联订单' }],
    });
  });
  route(/^\/purchase\/(new|\d+)$/, async ([id], main, qs) => {
    const isNew = id === 'new';
    const p = isNew ? { items: [], type: '原辅材料', status: '已下单', order_id: qs.get('order_id') || '', payments: [], invoices: [] } : await get('/api/purchases/' + id);
    setTitle(isNew ? '新建采购单' : '采购单 ' + p.po_no);
    const [suppliers, orders, inv] = await Promise.all([options('supplier'), options('order'), options('inventory', true)]);
    const editable = (isNew ? can('purchase', 'add') : can('purchase', 'edit')) && p.status === '已下单' && !(p.paid > 0) && !p.items.some((i) => i.received_qty > 0);
    const dis = editable ? '' : 'disabled';
    const row = (it) => `<tr data-id="${it.id || ''}"><td style="min-width:180px"><select data-f="inventory_id" ${dis}>${optHtml(inv, it.inventory_id)}</select></td>
      <td><input data-f="code" value="${esc(it.code)}" placeholder="外购成品填货号" ${dis}></td><td><input data-f="name" value="${esc(it.name)}" ${dis}></td>
      <td style="width:70px"><input data-f="unit" value="${esc(it.unit || '个')}" ${dis}></td><td style="width:90px"><input data-f="qty" type="number" step="any" value="${esc(it.qty)}" ${dis}></td>
      <td style="width:90px"><input data-f="price" type="number" step="any" value="${esc(it.price)}" ${dis}></td><td class="num">${esc(it.received_qty || 0)}</td>
      <td>${editable ? '<button class="btn small danger" data-rm type="button">删</button>' : ''}</td></tr>`;
    main.innerHTML = `<div class="panel"><div class="panel-head"><h2>${isNew ? '新建采购单' : esc(p.po_no)} ${tag(p.status)} ${isNew ? '' : tag(p.qc_status)}</h2><div class="toolbar" id="actions"></div></div>
      <form class="form-grid" id="hdr">
        <label><span class="req">供应商</span><select name="supplier_id" ${dis}>${optHtml(suppliers, p.supplier_id)}</select></label>
        <label><span class="req">采购类型</span><select name="type" ${dis}>${optHtml(['原辅材料', '外购成品'], p.type, false)}</select></label>
        <label><span>关联销售订单（按单核算）</span><select name="order_id" ${dis}>${optHtml(orders, p.order_id)}</select></label>
        <label><span>下单日期</span><input type="date" name="order_date" value="${esc(p.order_date || today())}" ${dis}></label>
        <label><span>交货期</span><input type="date" name="due_date" value="${esc(p.due_date)}" ${dis}></label>
        <label class="wide"><span>备注</span><input name="remark" value="${esc(p.remark)}" ${dis}></label></form>
      ${isNew ? '' : `<div class="kv" style="margin-top:10px"><div><b>采购金额</b><span>¥${money(p.amount)}</span></div><div><b>已付款</b><span>¥${money(p.paid)}</span></div><div><b>未付款</b><span>¥${money(p.amount - p.paid)}</span></div>
        <div><b>进项已开票</b><span>¥${money(p.invoiced)}</span></div><div><b>结算方式</b><span>${esc(p.settlement)}</span></div></div>`}</div>
      <div class="panel"><div class="panel-head"><h3>采购明细</h3>${editable ? '<button class="btn" id="addItem" type="button">＋ 添加</button>' : ''}</div>
        <div class="table-wrap items-table"><table><thead><tr><th>库存物料（原辅料选择）</th><th>编码/货号</th><th>名称</th><th>单位</th><th>数量</th><th>单价¥</th><th class="num">已入库</th><th></th></tr></thead><tbody id="items">${p.items.map(row).join('')}</tbody></table></div></div>
      ${isNew ? '' : `<div class="grid2"><div class="panel"><h3 class="section-title">付款记录（需财务审批）</h3>${tableHtml(['日期', '金额¥', '凭证', '申请人', '状态'], p.payments.map((x) => [esc(x.pay_date), money(x.amount), esc(x.voucher), esc(x.applicant), tag(x.status)]))}</div>
        <div class="panel"><h3 class="section-title">进项发票</h3>${tableHtml(['发票号', '日期', '金额¥', '核销', ''], p.invoices.map((x) => [esc(x.invoice_no), esc(x.invoice_date), money(x.amount), tag(x.verify_status),
    x.verify_status === '未核销' && can('purchase', 'audit') ? `<button class="btn small" data-ver="${x.id}">核销</button>` : '']))}</div></div>`}`;
    const tbody = main.querySelector('#items');
    const bind = () => {
      tbody.querySelectorAll('[data-rm]').forEach((b) => { b.onclick = () => b.closest('tr').remove(); });
      tbody.querySelectorAll('select[data-f="inventory_id"]').forEach((s) => {
        s.onchange = () => { const opt = inv.find((x) => String(x.id) === s.value); if (opt) { const [code, ...name] = opt.label.split(' '); const tr = s.closest('tr'); tr.querySelector('[data-f="code"]').value = code; tr.querySelector('[data-f="name"]').value = name.join(' '); } };
      });
    };
    bind();
    const ai = main.querySelector('#addItem');
    if (ai) ai.onclick = () => { tbody.insertAdjacentHTML('beforeend', row({})); bind(); };
    const btn = btnFactory(main.querySelector('#actions'));
    if (editable) {
      btn('保存', 'primary', async () => {
        const h = Object.fromEntries([...main.querySelectorAll('#hdr [name]')].map((el) => [el.name, el.value]));
        h.items = [...tbody.querySelectorAll('tr')].map((tr) => ({ id: tr.dataset.id ? Number(tr.dataset.id) : undefined, ...Object.fromEntries([...tr.querySelectorAll('[data-f]')].map((el) => [el.dataset.f, el.value])) }));
        const r = isNew ? await post('/api/purchases', h) : await put('/api/purchases/' + id, h);
        toast('采购单已保存', 'ok');
        if (isNew) location.hash = '#/purchase/' + r.id; else ERP.navigate();
      });
    }
    if (!isNew && can('purchase', 'edit')) {
      btn('质检', '', () => modal({ title: '质检登记', body: `<div class="form-grid"><label>结果<select name="qc_status">${optHtml(['合格', '不合格'], '合格', false)}</select></label><label class="wide">问题说明<textarea name="note"></textarea></label></div>`,
        buttons: [{ text: '保存', cls: 'primary', onClick: async (m) => { await post(`/api/purchases/${id}/qc`, readForm(m.el)); m.close(); ERP.navigate(); } }] }));
      if (p.status !== '已入库') {
        btn('入库', '', () => modal({ title: '采购入库', body: tableHtml(['物料', '采购数', '已入库', '本次入库'], p.items.map((i) => [esc(i.name), i.qty, i.received_qty, `<input type="number" step="any" data-rid="${i.id}" value="${i.qty - i.received_qty}">`])),
          buttons: [{ text: '确认入库', cls: 'primary', onClick: async (m) => { await post(`/api/purchases/${id}/receive`, { items: [...m.el.querySelectorAll('[data-rid]')].map((el) => ({ id: Number(el.dataset.rid), qty: el.value })) }); m.close(); toast('已入库并更新库存', 'ok'); ERP.navigate(); } }] }));
      }
      btn('申请付款', '', () => modal({ title: '付款申请（提交财务审批）', body: `<div class="form-grid"><label><span class="req">金额¥</span><input name="amount" type="number" step="any" value="${Math.max(0, p.amount - p.paid)}"></label>
        <label>付款日期<input type="date" name="pay_date" value="${today()}"></label><label>凭证号<input name="voucher"></label><label>备注<input name="remark"></label></div>`,
      buttons: [{ text: '提交审批', cls: 'primary', onClick: async (m) => { await post(`/api/purchases/${id}/payments`, readForm(m.el)); m.close(); toast('付款申请已提交，待财务审批', 'ok'); ERP.navigate(); } }] }));
      btn('登记进项发票', '', () => modal({ title: '登记供应商进项发票', body: `<div class="form-grid"><label><span class="req">发票号码</span><input name="invoice_no"></label><label><span class="req">金额¥</span><input name="amount" type="number" step="any" value="${Math.max(0, p.amount - p.invoiced)}"></label>
        <label>开票日期<input type="date" name="invoice_date" value="${today()}"></label></div>`,
      buttons: [{ text: '保存', cls: 'primary', onClick: async (m) => { await post('/api/purchase-invoices', { po_id: Number(id), ...readForm(m.el) }); m.close(); ERP.navigate(); } }] }));
    }
    if (!isNew && can('purchase', 'print')) {
      btn('打印采购单', '', () => printHtml(`<h1>${esc(ERP.state.meta.company.name)}</h1><div class="sub"><b style="font-size:15px">采购单 PURCHASE ORDER</b></div>
        <table style="margin-bottom:8px"><tr><td>采购单号: ${esc(p.po_no)}</td><td>供应商: ${esc(p.supplier_name)}</td><td>交货期: ${esc(p.due_date)}</td></tr><tr><td>类型: ${esc(p.type)}</td><td>关联订单: ${esc(p.order_no || '-')}</td><td>结算: ${esc(p.settlement)}</td></tr></table>
        <table><thead><tr><th>编码</th><th>名称</th><th>单位</th><th>数量</th><th>单价</th><th>金额</th></tr></thead><tbody>${p.items.map((i) => `<tr><td>${esc(i.code)}</td><td>${esc(i.name)}</td><td>${esc(i.unit)}</td><td>${i.qty}</td><td>${money(i.price)}</td><td>${money(i.qty * i.price)}</td></tr>`).join('')}
        <tr><td colspan="5" style="text-align:right"><b>合计¥</b></td><td><b>${money(p.amount)}</b></td></tr></tbody></table>`));
    }
    main.querySelectorAll('[data-ver]').forEach((b) => { b.onclick = async () => { await post(`/api/purchase-invoices/${b.dataset.ver}/verify`); toast('已核销', 'ok'); ERP.navigate(); }; });
  });
  route(/^\/payables$/, async (_, main) => {
    setTitle('供应商应付与进项票');
    const { rows } = await get('/api/payables');
    await ERP.grid(main, {
      key: 'doc.payables', title: '供应商应付与进项开票台账', mode: 'client', rows, module: 'purchase',
      columns: [
        { key: 'name', label: '供应商' }, { key: 'type', label: '类型' }, { key: 'settlement', label: '结算方式' },
        ...[['amount', '应付¥'], ['paid', '已付¥'], ['unpaid', '未付¥'], ['invoiced', '已收票¥'], ['verified', '已核销¥'], ['uninvoiced', '未开票¥']].map(([k, l]) => ({ key: k, label: l, num: true, html: (r) => money(r[k]) })),
      ],
      tree: [{ key: 'type', label: '类型' }, { key: 'settlement', label: '结算方式' }, { key: 'pay_state', label: '付款情况', text: (r) => (Number(r.unpaid) > 0 ? '有未付' : '已付清') }],
      schemes: [['type'], ['pay_state'], ['settlement']],
      quick: [{ key: 'name', label: '供应商' }],
    });
  });

  // ---------- 生产 / production ----------
  route(/^\/production$/, async (_, main) => {
    setTitle('生产布产进度');
    const { rows, processes } = await get('/api/productions');
    await ERP.grid(main, {
      key: 'doc.production', title: '布产进度看板', mode: 'client', rows, module: 'production',
      toolbar: '<span class="muted small">在订单详情页点击「一键布产」生成布产单</span>',
      columns: [
        { key: 'prod_no', label: '布产单', html: (p) => `<a href="#/production/${p.id}">${esc(p.prod_no)}</a>` },
        { key: 'order_no', label: '订单', html: (p) => `<a href="#/order/${p.order_id}">${esc(p.order_no)}</a>` }, { key: 'customer_name', label: '客户' },
        { key: 'item_no', label: '货号' }, { key: 'plan_qty', label: '计划', num: true },
        ...processes.map((k) => ({ key: 'p_' + k, label: k + '良品', num: true, nofilter: true, text: (p) => p.process[k].good || 0 })),
        { key: 'completion', label: '完工率', num: true, nofilter: true, html: (p) => `<div class="progress" title="${p.completion}%"><i style="width:${Math.min(100, p.completion)}%"></i></div><span class="small">${p.completion}%</span>` },
        { key: 'bad_rate', label: '不良率', num: true, nofilter: true, html: (p) => `${p.bad_rate}%` },
        { key: 'due_date', label: '计划完工', html: (p) => esc(p.due_date) + (p.delayed ? ' <span class="tag danger">延期</span>' : '') },
        { key: 'status', label: '状态', html: (p) => tag(p.status) },
      ],
      tree: [{ key: 'status', label: '状态' }, { key: 'customer_name', label: '客户' }, { key: 'order_no', label: '订单' }, { key: 'delay', label: '是否延期', text: (p) => (p.delayed ? '延期' : '正常') }],
      schemes: [['status'], ['customer_name', 'order_no'], ['delay']],
      quick: [{ key: 'prod_no', label: '布产单' }, { key: 'order_no', label: '订单' }, { key: 'item_no', label: '货号' }],
      actions: can('production', 'edit') ? (p) => (p.status !== '已完工' ? `<button class="btn small primary" type="button" data-rep="${p.id}">报工</button>` : '') : null,
      bind: (root) => { root.querySelectorAll('[data-rep]').forEach((b) => { b.onclick = () => reportModal(b.dataset.rep, processes); }); },
    });
  });

  /**
   * 工序报工弹窗 / Process reporting modal.
   * @param {string|number} pid 布产单ID / production id
   * @param {string[]} processes 工序 / processes
   */
  function reportModal(pid, processes) {
    modal({
      title: '车间工序报工', body: `<div class="form-grid"><label><span class="req">工序</span><select name="process">${optHtml(processes, processes[0], false)}</select></label>
        <label>日期<input type="date" name="report_date" value="${today()}"></label><label><span class="req">良品数</span><input type="number" name="good_qty"></label>
        <label>不良数<input type="number" name="bad_qty" value="0"></label><label>操作工<input name="worker"></label><label>备注<input name="remark"></label></div>`,
      buttons: [{ text: '提交报工', cls: 'primary', onClick: async (m) => { await post(`/api/productions/${pid}/reports`, readForm(m.el)); m.close(); toast('报工成功，进度已同步订单', 'ok'); ERP.navigate(); } }],
    });
  }
  route(/^\/production\/(\d+)$/, async ([id], main) => {
    const p = await get('/api/productions/' + id);
    setTitle('布产单 ' + p.prod_no);
    const inv = await options('inventory', true);
    main.innerHTML = `<div class="panel"><div class="panel-head"><h2>${esc(p.prod_no)} ${tag(p.status)} ${p.delayed ? '<span class="tag danger">延期</span>' : ''}</h2><div class="toolbar" id="actions"></div></div>
      <div class="kv"><div><b>订单</b><span><a href="#/order/${p.order_id}">${esc(p.order_no)}</a></span></div><div><b>货号</b><span>${esc(p.item_no)}</span></div><div><b>计划数</b><span>${p.plan_qty}</span></div>
      <div><b>计划完工</b><span>${esc(p.due_date)}</span></div><div><b>完工率</b><span>${p.completion}%</span></div><div><b>不良率</b><span>${p.bad_rate}%</span></div></div>
      <div class="cards" style="margin-top:12px">${Object.entries(p.process).map(([k, v]) => `<div class="card"><div class="l">${esc(k)} 良品/不良</div><div class="v">${v.good || 0}<span class="muted small"> / ${v.bad || 0}</span></div></div>`).join('')}</div></div>
      <div class="grid2"><div class="panel"><h3 class="section-title">报工记录</h3>${tableHtml(['日期', '工序', '良品', '不良', '操作工', '备注'], p.reports.map((r) => [esc(r.report_date), esc(r.process), r.good_qty, r.bad_qty, esc(r.worker), esc(r.remark)]))}</div>
      <div class="panel"><h3 class="section-title">领料记录（按单核算）</h3>${tableHtml(['时间', '物料', '数量', '单位成本', '金额'], p.issues.map((r) => [esc(r.created_at), `${esc(r.code)} ${esc(r.name)}`, `${r.qty}${esc(r.unit)}`, money(r.unit_cost), money(r.qty * r.unit_cost)]))}</div></div>`;
    const btn = btnFactory(main.querySelector('#actions'));
    if (can('production', 'edit') && p.status !== '已完工') {
      btn('报工', 'primary', () => reportModal(id, Object.keys(p.process)));
      btn('领料', '', () => modal({ title: '按单领料', body: `<div class="form-grid"><label><span class="req">物料</span><select name="inventory_id">${optHtml(inv, '')}</select></label><label><span class="req">数量</span><input type="number" step="any" name="qty"></label></div>`,
        buttons: [{ text: '确认领料', cls: 'primary', onClick: async (m) => { await post('/api/material-issues', { ...readForm(m.el), order_id: p.order_id, production_id: p.id }); m.close(); toast('领料成功，成本已归集到订单', 'ok'); ERP.navigate(); } }] }));
      btn('调整计划', '', () => modal({ title: '调整布产计划', body: `<div class="form-grid"><label>计划数量<input type="number" name="plan_qty" value="${p.plan_qty}"></label><label>计划完工<input type="date" name="due_date" value="${esc(p.due_date)}"></label><label class="wide">备注<input name="remark" value="${esc(p.remark)}"></label></div>`,
        buttons: [{ text: '保存', cls: 'primary', onClick: async (m) => { await put('/api/productions/' + p.id, readForm(m.el)); m.close(); ERP.navigate(); } }] }));
    }
  });
})();
