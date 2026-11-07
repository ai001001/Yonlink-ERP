'use strict';
/**
 * 外贸业务页面：报价单、工厂询价、送样与改样新货号
 * Sales pages: quotations, factory inquiries, sample sending & new item numbers.
 */
(() => {
  const { esc, money, get, post, put, del, toast, modal, tableHtml, tag, can, route, setTitle, exportTable, printHtml, confirmBox, optHtml, options, download, readForm } = ERP;

  /**
   * 单据页脚：左下新创货号、右下改样要求 / Document footer: new item numbers (left) & revision requirements (right).
   * @param {object[]} items 含 item_no/new_item_no/revise_req 的明细 / items
   * @returns {string}
   */
  function revisionFooter(items) {
    const rv = items.filter((x) => x.new_item_no);
    const left = rv.length ? rv.map((x) => `${esc(x.item_no)} → <b style="display:inline">${esc(x.new_item_no)}</b>`).join('<br>') : '无';
    const right = rv.length ? rv.map((x) => `【${esc(x.new_item_no)}】${esc(x.revise_req || '')}`).join('<br>') : '无';
    return `<div class="doc-foot"><div><b>本次新创货号 New Item No.</b>${left}</div><div><b>详细改样要求 Revision Requirements</b>${right}</div></div>`;
  }

  /**
   * 单据抬头 / Company header for printed documents.
   * @param {string} title 标题 / title
   * @returns {string}
   */
  const docHead = (title) => `<h1>${esc(ERP.state.meta.company.name || '')}</h1><div class="sub">${esc(ERP.state.meta.company.name_en || '')}<br><b style="font-size:15px">${esc(title)}</b></div>`;

  // ---------- 报价单列表 / quote list ----------
  route(/^\/quotes$/, async (_, main, qs) => {
    setTitle('报价管理');
    const q = qs.get('q') || '';
    const { rows } = await get(`/api/quotes?q=${encodeURIComponent(q)}`);
    const month = (r) => String(r.created_at || '').slice(0, 7);
    await ERP.grid(main, {
      key: 'doc.quotes', title: '报价单', mode: 'client', rows, module: 'quote', q,
      onKeyword: (kw) => { location.hash = '#/quotes?q=' + encodeURIComponent(kw); },
      toolbar: can('quote', 'add') ? '<a class="btn primary" href="#/quote/new">＋ 新建报价</a>' : '',
      columns: [
        { key: 'quote_no', label: '报价单号', html: (r) => `<a href="#/quote/${r.id}">${esc(r.quote_no)}</a>` },
        { key: 'customer_name', label: '客户' }, { key: 'salesman_name', label: '业务员' },
        { key: 'currency', label: '币种' }, { key: 'term', label: '术语' },
        { key: 'item_count', label: '产品数', num: true }, { key: 'amount', label: '金额', num: true, html: (r) => money(r.amount) },
        { key: 'profit_rate', label: '利润率%', num: true }, { key: 'valid_until', label: '有效期' },
        { key: 'inquiry_count', label: '询价单', num: true }, { key: 'status', label: '状态', html: (r) => tag(r.status) },
        { key: 'created_at', label: '创建时间', text: (r) => String(r.created_at || '').slice(0, 10) },
      ],
      defaultCols: ['quote_no', 'customer_name', 'salesman_name', 'currency', 'term', 'item_count', 'amount', 'profit_rate', 'valid_until', 'inquiry_count', 'status'],
      tree: [{ key: 'salesman_name', label: '业务员' }, { key: 'customer_name', label: '客户' }, { key: 'status', label: '状态' }, { key: 'currency', label: '币种' }, { key: 'term', label: '术语' }, { key: 'month', label: '创建月份', text: month }],
      schemes: [['salesman_name', 'customer_name'], ['status'], ['month']],
      quick: [{ key: 'quote_no', label: '报价单号' }, { key: 'customer_name', label: '客户' }, { key: 'salesman_name', label: '业务员' }],
    });
  });

  // ---------- 报价单编辑/详情 / quote editor ----------
  route(/^\/quote\/(new|\d+)$/, async ([id], main) => {
    const isNew = id === 'new';
    const q = isNew ? { items: [], status: '草稿', currency: 'USD', term: 'FOB', profit_rate: 20, freight: 0, customs_fee: 0, inquiries: [] } : await get('/api/quotes/' + id);
    setTitle(isNew ? '新建报价单' : `报价单 ${q.quote_no}`);
    const editable = (isNew ? can('quote', 'add') : can('quote', 'edit')) && q.status !== '已成交' && ERP.state.meta.user.scope !== 'designer';
    const designer = ERP.state.meta.user.scope === 'designer';
    const [customers, samples, suppliers, currencies, terms] = await Promise.all([options('customer'), options('sample'), options('supplier'), options('currency'), options('trade_term')]);
    const dis = editable ? '' : 'disabled';
    const itemRow = (it) => `<tr data-id="${it.id || ''}">
      <td style="min-width:180px"><select data-f="sample_id" ${dis}>${optHtml(it.sample_id && !samples.some((s) => s.id === it.sample_id) ? [{ id: it.sample_id, label: it.item_no + '（已锁定）' }, ...samples] : samples, it.sample_id)}</select></td>
      <td style="min-width:160px"><input data-f="description" value="${esc(it.description)}" ${dis}></td>
      <td style="width:80px"><input data-f="qty" type="number" value="${esc(it.qty)}" ${dis}></td>
      <td style="min-width:130px"><select data-f="factory_id" ${dis}>${optHtml(suppliers, it.factory_id)}</select></td>
      <td style="width:90px"><input data-f="cost_cny" type="number" step="any" value="${esc(it.cost_cny)}" placeholder="自动" ${dis}></td>
      <td style="width:80px"><input data-f="craft_add" type="number" step="any" value="${esc(it.craft_add || 0)}" ${dis}></td>
      <td style="width:90px"><input data-f="price" type="number" step="any" value="${esc(it.price)}" ${dis}></td>
      <td style="width:110px"><input data-f="new_item_no" value="${esc(it.new_item_no)}" placeholder="改新货号" ${dis}></td>
      <td style="min-width:170px"><textarea data-f="revise_req" rows="1" placeholder="造型/尺寸/浮雕/颜色/效果变更" ${dis}>${esc(it.revise_req)}</textarea></td>
      <td>${editable ? '<button class="btn small danger" data-rm type="button">删</button>' : ''}</td></tr>`;
    main.innerHTML = `
      ${q.status === '已驳回' ? `<div class="alert danger"><span class="t">审批驳回</span>${esc(q.audit_note)}</div>` : ''}
      <div class="panel"><div class="panel-head"><h2>${isNew ? '新建报价单' : esc(q.quote_no)} ${tag(q.status)}</h2>
        <div class="toolbar" id="actions"></div></div>
        <form class="form-grid" id="hdr">
          <label><span class="req">客户</span><select name="customer_id" ${dis}>${optHtml(customers, q.customer_id)}</select></label>
          <label><span class="req">币种</span><select name="currency" ${dis}>${optHtml(currencies, q.currency, false)}</select></label>
          <label><span class="req">贸易术语</span><select name="term" ${dis}>${optHtml(terms, q.term, false)}</select></label>
          <label><span>汇率（空=取最新汇率）</span><input name="rate" type="number" step="any" value="${esc(q.rate)}" ${dis}></label>
          <label><span>目标利润率%</span><input name="profit_rate" type="number" step="any" value="${esc(q.profit_rate)}" ${dis}></label>
          <label><span>物流费¥（分摊）</span><input name="freight" type="number" step="any" value="${esc(q.freight)}" ${dis}></label>
          <label><span>报关费¥（分摊）</span><input name="customs_fee" type="number" step="any" value="${esc(q.customs_fee)}" ${dis}></label>
          <label><span>有效期至</span><input name="valid_until" type="date" value="${esc(q.valid_until)}" ${dis}></label>
          <label class="wide"><span>备注</span><input name="remark" value="${esc(q.remark)}" ${dis}></label>
        </form>
        ${editable ? '<label class="small" style="display:flex;gap:6px;align-items:center;margin-top:8px"><input type="checkbox" id="autoPrice" checked> 保存时按「(成本+工艺加价+物流报关分摊)×(1+利润率)÷汇率」自动计算单价（取消勾选可手动微调单价）</label>' : ''}
      </div>
      <div class="panel"><div class="panel-head"><h3>报价产品明细 ${designer ? '<span class="muted small">（仅显示本人设计样品）</span>' : ''}</h3>${editable ? '<button class="btn" id="addItem" type="button">＋ 添加产品</button>' : ''}</div>
        <div class="table-wrap items-table"><table><thead><tr><th>样品货号</th><th>描述</th><th>数量</th><th>生产厂家</th><th>成本¥</th><th>工艺加价¥</th><th>单价(外币)</th><th>改新货号</th><th>详细改样要求</th><th></th></tr></thead>
        <tbody id="items">${q.items.map(itemRow).join('')}</tbody></table></div>
        ${isNew ? '' : `<div class="kv" style="margin-top:10px"><div><b>总数量</b><span>${q.total_qty}</span></div><div><b>报价总额</b><span>${money(q.amount)} ${esc(q.currency)}</span></div>
          ${designer ? '' : `<div><b>预估利润</b><span>¥${money(q.est_profit)}</span></div>`}<div><b>汇率</b><span>${esc(q.rate)}</span></div><div><b>业务员</b><span>${esc(q.salesman_name)}</span></div></div>`}
      </div>
      ${isNew || designer ? '' : `<div class="panel"><div class="panel-head"><h3>工厂询价单（报价单号-厂家名称）</h3><div class="toolbar" id="inqActions"></div></div>
        ${tableHtml(['询价单号', '厂家', '状态', '发送时间', '回价日期', '有效期'], q.inquiries.map((i) => [`<a href="#/inquiry/${i.id}">${esc(i.inquiry_no)}</a>`, esc(i.supplier_name), tag(i.status), esc(i.sent_at), esc(i.reply_date), esc(i.valid_until)]))}</div>`}`;
    const tbody = main.querySelector('#items');
    const bindRows = () => {
      tbody.querySelectorAll('[data-rm]').forEach((b) => { b.onclick = () => b.closest('tr').remove(); });
      tbody.querySelectorAll('select[data-f="sample_id"]').forEach((sel) => {
        sel.onchange = async () => {
          if (!sel.value) return;
          const s = await get('/api/e/sample/' + sel.value);
          const tr = sel.closest('tr');
          tr.querySelector('[data-f="description"]').value = `${s.name} ${s.name_en || ''}`.trim();
          tr.querySelector('[data-f="factory_id"]').value = s.supplier_id || '';
          tr.querySelector('[data-f="cost_cny"]').value = (Number(s.material_cost) || 0) + (Number(s.labor_cost) || 0);
          const qty = tr.querySelector('[data-f="qty"]');
          if (!qty.value) qty.value = s.moq || '';
        };
      });
    };
    bindRows();
    const ai = main.querySelector('#addItem');
    if (ai) ai.onclick = () => { tbody.insertAdjacentHTML('beforeend', itemRow({})); bindRows(); };
    const collect = () => {
      const h = Object.fromEntries([...main.querySelectorAll('#hdr [name]')].map((el) => [el.name, el.value]));
      h.items = [...tbody.querySelectorAll('tr')].map((tr) => {
        const it = { id: tr.dataset.id ? Number(tr.dataset.id) : undefined };
        tr.querySelectorAll('[data-f]').forEach((el) => { it[el.dataset.f] = el.value; });
        return it;
      }).filter((it) => it.sample_id);
      h.auto_price = main.querySelector('#autoPrice') ? main.querySelector('#autoPrice').checked : true;
      return h;
    };
    const acts = main.querySelector('#actions');
    const btn = (text, cls, fn) => { const b = document.createElement('button'); b.className = 'btn ' + cls; b.textContent = text; b.onclick = async () => { try { await fn(); } catch (e) { toast(e.message, 'error'); } }; acts.appendChild(b); };
    if (editable) {
      btn('保存', 'primary', async () => {
        const r = isNew ? await post('/api/quotes', collect()) : await put('/api/quotes/' + id, collect());
        toast('报价单已保存', 'ok');
        if (isNew) location.hash = '#/quote/' + r.id; else ERP.navigate();
      });
    }
    if (!isNew && !designer) {
      if (can('quote', 'edit') && ['草稿', '已驳回'].includes(q.status)) {
        btn('提交审批', '', async () => { const r = await post(`/api/quotes/${id}/submit`); toast(r.low_profit ? '已提交审批（利润率低于最低要求，已预警）' : '已提交审批', 'ok'); ERP.navigate(); });
      }
      if (can('quote', 'edit') && q.status === '已审批') btn('标记已发客户', '', async () => { await post(`/api/quotes/${id}/status`, { status: '已发客户' }); ERP.navigate(); });
      if (can('order', 'add') && ['已审批', '已发客户'].includes(q.status)) {
        btn('转为订单', 'primary', async () => { if (!(await confirmBox('确认客户已下单，将报价单转为销售订单？'))) return; const r = await post(`/api/quotes/${id}/to-order`); toast(`已生成订单 ${r.order_no}`, 'ok'); location.hash = '#/order/' + r.id; });
      }
      if (can('quote', 'print')) btn('打印报价单', '', () => printQuote(q));
      if (can('quote', 'export')) {
        btn('导出Excel', '', () => exportTable('quote', `报价单${q.quote_no}`, ['货号', '描述', '数量', `单价(${q.currency})`, '金额', '本次新创货号', '详细改样要求'],
          q.items.map((i) => [i.item_no, i.description, i.qty, i.price, Math.round(i.qty * i.price * 100) / 100, i.new_item_no || '', i.revise_req || ''])));
      }
      if (can('quote', 'edit') && !['已成交', '已失效'].includes(q.status)) btn('设为失效', 'danger', async () => { await post(`/api/quotes/${id}/status`, { status: '已失效' }); ERP.navigate(); });
      if (can('quote', 'delete') && q.status !== '已成交') btn('删除', 'danger', async () => { if (await confirmBox('删除报价单及其询价单？')) { await del('/api/quotes/' + id); location.hash = '#/quotes'; } });
      const ia = main.querySelector('#inqActions');
      if (ia && can('quote', 'edit')) {
        const b1 = document.createElement('button');
        b1.className = 'btn primary'; b1.textContent = '一键按厂家拆分询价单';
        b1.onclick = async () => { try { const r = await post(`/api/quotes/${id}/split`); toast(`已生成/更新 ${r.rows.length} 张询价单`, 'ok'); ERP.navigate(); } catch (e) { toast(e.message, 'error'); } };
        const b2 = document.createElement('button');
        b2.className = 'btn'; b2.textContent = '追加其它厂家询价';
        b2.onclick = () => extraInquiry(q, suppliers);
        const b3 = document.createElement('button');
        b3.className = 'btn'; b3.textContent = '多厂家报价对比';
        b3.onclick = () => compareModal(id);
        ia.append(b1, b2, b3);
      }
    }
  });

  /**
   * 打印报价单 / Print a quotation.
   * @param {object} q
   */
  function printQuote(q) {
    printHtml(`${docHead('报价单 QUOTATION')}
      <table style="margin-bottom:8px"><tr><td>报价单号 No.: ${esc(q.quote_no)}</td><td>客户 Customer: ${esc(q.customer_name)}</td><td>日期 Date: ${esc(String(q.created_at).slice(0, 10))}</td></tr>
      <tr><td>贸易术语 Term: ${esc(q.term)}</td><td>币种 Currency: ${esc(q.currency)}</td><td>有效期 Valid Until: ${esc(q.valid_until)}</td></tr></table>
      <table><thead><tr><th>No.</th><th>货号 Item No.</th><th>描述 Description</th><th>尺寸 Size(cm)</th><th>材质/工艺</th><th>数量 Qty</th><th>单价 Unit Price</th><th>金额 Amount</th></tr></thead>
      <tbody>${q.items.map((i, n) => `<tr><td>${n + 1}</td><td>${esc(i.item_no)}</td><td>${esc(i.description)}</td><td>${i.length_cm ? `${i.length_cm}×${i.width_cm}×${i.height_cm}` : ''}</td>
        <td>${esc([i.material, i.craft, i.color].filter(Boolean).join(' / '))}</td><td>${i.qty}</td><td>${money(i.price)}</td><td>${money(i.qty * i.price)}</td></tr>`).join('')}
      <tr><td colspan="5" style="text-align:right"><b>合计 Total</b></td><td>${q.total_qty}</td><td></td><td><b>${money(q.amount)} ${esc(q.currency)}</b></td></tr></tbody></table>
      ${revisionFooter(q.items)}`);
  }

  /**
   * 追加厂家询价弹窗 / Modal to add an extra factory inquiry.
   * @param {object} q 报价单 / quote
   * @param {object[]} suppliers 供应商选项 / supplier options
   */
  function extraInquiry(q, suppliers) {
    modal({
      title: '追加厂家询价（同货号多厂家比价）',
      body: `<label class="field">厂家<select id="sup">${optHtml(suppliers, '')}</select></label><div style="margin-top:10px">${q.items.map((i) => `<label style="display:flex;gap:6px"><input type="checkbox" value="${i.id}"> ${esc(i.item_no)} ${esc(i.description)}</label>`).join('')}</div>`,
      buttons: [{
        text: '生成询价单', cls: 'primary', onClick: async (m) => {
          const ids = [...m.el.querySelectorAll('input[type=checkbox]:checked')].map((c) => Number(c.value));
          const r = await post('/api/inquiries', { quote_id: q.id, supplier_id: m.el.querySelector('#sup').value, quote_item_ids: ids });
          m.close(); toast(`已生成询价单 ${r.inquiry_no}`, 'ok'); ERP.navigate();
        },
      }],
    });
  }

  /**
   * 多厂家报价对比弹窗 / Multi-factory price comparison modal.
   * @param {string|number} quoteId
   */
  async function compareModal(quoteId) {
    const d = await get(`/api/quotes/${quoteId}/compare`);
    const body = d.rows.map((r) => `<h3 style="margin:12px 0 6px">${esc(r.item_no)} ${esc(r.description)} <span class="muted small">数量 ${r.qty}，当前成本 ¥${money(r.current_cost)}（${esc(r.current_factory || '-')}）</span></h3>
      ${tableHtml(['厂家', '询价单', '工厂单价¥', '与最低价差', '与当前成本差', '交期(天)', '评级/合格率', '按此价预估毛利¥', ''], r.offers.map((o, i) => [
    esc(o.supplier_name) + (i === 0 ? ' <span class="tag ok">最低</span>' : ''), esc(o.inquiry_no), money(o.factory_price), money(o.diff_vs_best), money(o.diff_vs_current),
    esc(o.delivery_days), `${esc(o.rating)} / ${esc(o.pass_rate)}%`, money(o.est_margin),
    can('quote', 'edit') ? `<button class="btn small primary" data-apply="${r.quote_item_id}:${o.inquiry_item_id}">采用</button>` : '']), new Set([2, 3, 4, 7]))}`).join('');
    const m = modal({ title: `多厂家报价对比 - ${d.quote_no}`, wide: true, body: body || '<div class="empty">暂无工厂回价</div>' });
    m.el.querySelectorAll('[data-apply]').forEach((b) => {
      b.onclick = async () => {
        const [qi, ii] = b.dataset.apply.split(':').map(Number);
        try { await post(`/api/quotes/${quoteId}/apply-offer`, { quote_item_id: qi, inquiry_item_id: ii }); m.close(); toast('已采用该厂家报价作为成本并重算单价（报价单退回草稿）', 'ok'); ERP.navigate(); } catch (e) { toast(e.message, 'error'); }
      };
    });
  }

  // ---------- 工厂询价台账 / inquiry ledger ----------
  route(/^\/inquiries$/, async (_, main, qs) => {
    setTitle('工厂询价台账');
    const f = ['quote_no', 'supplier', 'item_no', 'from', 'to', 'status'];
    const query = f.map((k) => `${k}=${encodeURIComponent(qs.get(k) || '')}`).join('&');
    const { rows } = await get('/api/inquiries?' + query);
    const headHtml = `<form class="form-grid" id="flt" style="margin-bottom:12px">
        <label>报价单号<input name="quote_no" value="${esc(qs.get('quote_no'))}"></label><label>厂家<input name="supplier" value="${esc(qs.get('supplier'))}"></label>
        <label>货号<input name="item_no" value="${esc(qs.get('item_no'))}"></label><label>开始日期<input type="date" name="from" value="${esc(qs.get('from'))}"></label>
        <label>结束日期<input type="date" name="to" value="${esc(qs.get('to'))}"></label><label>状态<select name="status">${optHtml(['待发送', '已发送', '已回价'], qs.get('status'))}</select></label>
        <div style="align-self:end"><button class="btn primary" id="go" type="button">查询</button></div></form>`;
    await ERP.grid(main, {
      key: 'doc.inquiries', title: '工厂询价台账', mode: 'client', rows, module: 'quote', headHtml,
      columns: [
        { key: 'inquiry_no', label: '询价单号', html: (r) => `<a href="#/inquiry/${r.id}">${esc(r.inquiry_no)}</a>` },
        { key: 'quote_no', label: '报价单号', html: (r) => `<a href="#/quote/${r.quote_id}">${esc(r.quote_no)}</a>` },
        { key: 'supplier_name', label: '厂家' }, { key: 'item_nos', label: '货号' }, { key: 'status', label: '状态', html: (r) => tag(r.status) },
        { key: 'created_at', label: '创建', text: (r) => String(r.created_at || '').slice(0, 10) }, { key: 'reply_date', label: '回价日期' }, { key: 'valid_until', label: '有效期' },
      ],
      tree: [{ key: 'supplier_name', label: '厂家' }, { key: 'status', label: '状态' }, { key: 'month', label: '创建月份', text: (r) => String(r.created_at || '').slice(0, 7) }],
      schemes: [['supplier_name', 'status'], ['status'], ['month']],
      quick: [{ key: 'inquiry_no', label: '询价单号' }, { key: 'quote_no', label: '报价单号' }, { key: 'item_nos', label: '货号' }],
    });
    main.querySelector('#go').onclick = () => { location.hash = '#/inquiries?' + new URLSearchParams(ERP.readForm(main.querySelector('#flt'))).toString(); };
  });

  // ---------- 询价单详情（回填）/ inquiry detail ----------
  route(/^\/inquiry\/(\d+)$/, async ([id], main) => {
    const inq = await get('/api/inquiries/' + id);
    setTitle('询价单 ' + inq.inquiry_no);
    const ed = can('quote', 'edit');
    main.innerHTML = `<div class="panel"><div class="panel-head"><h2>${esc(inq.inquiry_no)} ${tag(inq.status)}</h2><div class="toolbar">
        ${ed && inq.status === '待发送' ? '<button class="btn" id="sent">标记已发送厂家</button>' : ''}
        ${can('quote', 'export') ? '<button class="btn" data-exp="cm">导出询价单(厘米版)</button><button class="btn" data-exp="inch">导出询价单(英寸版)</button>' : ''}
        ${ed && can('mail', 'add') ? '<button class="btn primary" id="mailInq">✉ 邮件发送给厂家</button>' : ''}
        <a class="btn" href="#/quote/${inq.quote_id}">返回报价单</a></div></div>
      <div class="kv"><div><b>报价单号</b><span>${esc(inq.quote_no)}</span></div><div><b>厂家</b><span>${esc(inq.supplier_name)}</span></div><div><b>联系人</b><span>${esc(inq.supplier_contact)} ${esc(inq.supplier_phone)}</span></div>
        <div><b>结算方式</b><span>${esc(inq.settlement)}</span></div><div><b>发送时间</b><span>${esc(inq.sent_at)}</span></div><div><b>创建</b><span>${esc(inq.created_at)}</span></div></div></div>
      <div class="panel"><h3 class="section-title">询价明细与工厂回价</h3>
        <div class="table-wrap items-table"><table><thead><tr><th>货号</th><th>描述</th><th>尺寸cm</th><th>包装/标签</th><th>外箱cm/装箱</th><th>CBM</th><th>MOQ</th><th>数量</th><th>历史价¥</th><th>工厂单价¥</th><th>交期(天)</th><th>备注</th></tr></thead>
        <tbody>${inq.items.map((it) => `<tr data-id="${it.id}"><td>${esc(it.item_no)}${it.new_item_no ? `<br><span class="tag warn">新:${esc(it.new_item_no)}</span>` : ''}</td><td>${esc(it.description)}</td>
          <td>${it.length_cm ? `${it.length_cm}×${it.width_cm}×${it.height_cm}` : ''}</td><td>${esc(it.package_req)}<br>${esc(it.label_req)}</td>
          <td>${it.outer_l ? `${it.outer_l}×${it.outer_w}×${it.outer_h} / ${it.pcs_per_carton}` : ''}</td><td>${esc(it.cbm)}</td><td>${esc(it.moq)}</td><td>${esc(it.qty)}</td><td>${money(it.last_price)}</td>
          <td style="width:100px"><input data-f="factory_price" type="number" step="any" value="${esc(it.factory_price)}" ${ed ? '' : 'disabled'}></td>
          <td style="width:80px"><input data-f="delivery_days" type="number" value="${esc(it.delivery_days)}" ${ed ? '' : 'disabled'}></td>
          <td><input data-f="remark" value="${esc(it.remark)}" ${ed ? '' : 'disabled'}></td></tr>`).join('')}</tbody></table></div>
        ${ed ? `<div class="form-grid" style="margin-top:12px"><label>回价日期<input type="date" id="rd" value="${esc(inq.reply_date || new Date().toISOString().slice(0, 10))}"></label>
          <label>报价有效期<input type="date" id="vu" value="${esc(inq.valid_until)}"></label><label class="wide">备注<input id="rm" value="${esc(inq.remark)}"></label></div>
          <div style="margin-top:12px"><button class="btn primary" id="save">保存工厂回价（留档）</button></div>` : ''}
      </div>`;
    main.querySelectorAll('[data-exp]').forEach((b) => { b.onclick = () => download(`/api/inquiries/${id}/export?unit=${b.dataset.exp}`).catch((e) => toast(e.message, 'error')); });
    const sb = main.querySelector('#sent');
    if (sb) sb.onclick = async () => { await post(`/api/inquiries/${id}/sent`); toast('已标记发送', 'ok'); ERP.navigate(); };
    const mi = main.querySelector('#mailInq');
    if (mi) {
      mi.onclick = async () => {
        const { rows: accounts } = await get('/api/mail-accounts').catch((e) => { toast(e.message, 'error'); return { rows: null }; });
        if (!accounts) return;
        const usable = accounts.filter((a) => a.enabled);
        if (!usable.length) { toast('请先在「邮箱账户」中添加发件邮箱', 'error'); return; }
        const sup = { email: inq.supplier_email || '' };
        modal({
          title: `邮件发送询价单给 ${inq.supplier_name}`, wide: true,
          body: `<div class="form-grid"><label><span class="req">发件邮箱</span><select name="account_id">${optHtml(usable.map((a) => ({ id: a.id, label: a.email })), usable[0].id, false)}</select></label>
            <label><span class="req">厂家邮箱</span><input name="to" value="${esc(sup.email)}" placeholder="供应商档案未登记邮箱，请填写"></label>
            <label><span>抄送</span><input name="cc"></label>
            <label><span>附件模板</span><select name="unit">${optHtml([{ id: 'cm', label: '厘米版 Excel' }, { id: 'inch', label: '英寸版 Excel' }], 'cm', false)}</select></label>
            <label class="wide"><span>主题</span><input name="subject" value="询价单 ${esc(inq.inquiry_no)}"></label>
            <label class="wide"><span>正文（留空使用默认模板）</span><textarea name="body"></textarea></label></div>
            <p class="small muted">发送成功后询价单自动标记为「已发送」，邮件归档到业务邮件并关联报价单。</p>`,
          buttons: [{ text: '发送', cls: 'primary', onClick: async (m) => { await post(`/api/inquiries/${id}/email`, readForm(m.el)); m.close(); toast('询价单已通过邮件发送给厂家', 'ok'); ERP.navigate(); } }],
        });
      };
    }
    const sv = main.querySelector('#save');
    if (sv) {
      sv.onclick = async () => {
        const items = [...main.querySelectorAll('tbody tr[data-id]')].map((tr) => ({ id: Number(tr.dataset.id), ...Object.fromEntries([...tr.querySelectorAll('[data-f]')].map((el) => [el.dataset.f, el.value])) }));
        try { await put(`/api/inquiries/${id}/reply`, { items, reply_date: main.querySelector('#rd').value, valid_until: main.querySelector('#vu').value, remark: main.querySelector('#rm').value }); toast('工厂回价已保存并写入供应商价格台账', 'ok'); ERP.navigate(); } catch (e) { toast(e.message, 'error'); }
      };
    }
  });

  // ---------- 送样单 / sample sends ----------
  route(/^\/sends$/, async (_, main, qs) => {
    setTitle('送样管理');
    const q = qs.get('q') || '';
    const { rows } = await get('/api/sample-sends?q=' + encodeURIComponent(q));
    await ERP.grid(main, {
      key: 'doc.sends', title: '送样单', mode: 'client', rows, module: 'sendsample', q,
      onKeyword: (kw) => { location.hash = '#/sends?q=' + encodeURIComponent(kw); },
      toolbar: can('sendsample', 'add') ? '<a class="btn primary" href="#/send/new">＋ 新建送样</a>' : '',
      columns: [
        { key: 'send_no', label: '送样单号', html: (r) => `<a href="#/send/${r.id}">${esc(r.send_no)}</a>` },
        { key: 'customer_name', label: '客户' }, { key: 'salesman_name', label: '业务员' }, { key: 'item_nos', label: '货号' }, { key: 'new_item_nos', label: '改样新货号' },
        { key: 'express_co', label: '快递公司' }, { key: 'tracking_no', label: '快递单号' }, { key: 'cost', label: '送样费¥', num: true, html: (r) => money(r.cost) },
        { key: 'send_date', label: '寄出日期' }, { key: 'status', label: '状态', html: (r) => tag(r.status) },
      ],
      tree: [{ key: 'salesman_name', label: '业务员' }, { key: 'customer_name', label: '客户' }, { key: 'status', label: '状态' }, { key: 'express_co', label: '快递公司' }, { key: 'month', label: '寄出月份', text: (r) => String(r.send_date || '').slice(0, 7) }],
      schemes: [['salesman_name', 'customer_name'], ['status'], ['month']],
      quick: [{ key: 'send_no', label: '送样单号' }, { key: 'customer_name', label: '客户' }, { key: 'tracking_no', label: '快递单号' }, { key: 'item_nos', label: '货号' }],
    });
  });

  route(/^\/send\/(new|\d+)$/, async ([id], main) => {
    const isNew = id === 'new';
    const d = isNew ? { items: [], status: '申请中', cost: 0 } : await get('/api/sample-sends/' + id);
    setTitle(isNew ? '新建送样单' : `送样单 ${d.send_no}`);
    const designer = ERP.state.meta.user.scope === 'designer';
    const editable = !designer && (isNew ? can('sendsample', 'add') : can('sendsample', 'edit')) && d.status === '申请中';
    const [customers, samples, quotes] = await Promise.all([options('customer'), options('sample'), options('quote')]);
    const dis = editable ? '' : 'disabled';
    const row = (it) => `<tr data-id="${it.id || ''}">
      <td style="min-width:200px"><select data-f="sample_id" ${dis || (it.new_sample_id ? 'disabled' : '')}>${optHtml(it.sample_id && !samples.some((s) => s.id === it.sample_id) ? [{ id: it.sample_id, label: it.item_no + '（已锁定）' }, ...samples] : samples, it.sample_id)}</select></td>
      <td style="width:80px"><input data-f="qty" type="number" value="${esc(it.qty || 1)}" ${dis}></td>
      <td style="width:130px"><input data-f="new_item_no" value="${esc(it.new_item_no)}" placeholder="改新货号(可空)" ${dis}></td>
      <td style="min-width:220px"><textarea data-f="revise_req" rows="1" ${dis}>${esc(it.revise_req)}</textarea></td>
      <td>${it.new_item_no ? tag(it.verify_status) + (it.redo_count ? ` <span class="muted small">重做${it.redo_count}次</span>` : '') + (it.verify_note ? `<div class="small muted">${esc(it.verify_note)}</div>` : '') : '-'}</td>
      <td>${it.new_sample_id ? `<a href="#/sample/${it.new_sample_id}">${esc(it.new_sample_no)}</a> ${tag('已转正')}` : ''}</td>
      <td class="nowrap">${editable && !it.new_sample_id ? '<button class="btn small danger" data-rm type="button">删</button> ' : ''}
        ${!isNew && it.id && it.new_item_no && !it.new_sample_id && can('sendsample', 'edit') && !designer ? `<button class="btn small" data-vok="${it.id}">核验通过</button> <button class="btn small danger" data-vng="${it.id}">不通过重做</button>` : ''}
        ${!isNew && it.verify_status === '通过' && !it.new_sample_id && can('sample', 'add') && !designer ? ` <button class="btn small primary" data-conv="${it.id}">一键转正归档</button>` : ''}</td></tr>`;
    main.innerHTML = `<div class="panel"><div class="panel-head"><h2>${isNew ? '新建送样单' : esc(d.send_no)} ${tag(d.status)}</h2><div class="toolbar" id="actions"></div></div>
      <form class="form-grid" id="hdr">
        <label><span class="req">客户</span><select name="customer_id" ${dis}>${optHtml(customers, d.customer_id)}</select></label>
        <label><span>关联报价单</span><select name="quote_id" ${dis}>${optHtml(quotes, d.quote_id)}</select></label>
        <label><span>送样费用¥</span><input name="cost" type="number" step="any" value="${esc(d.cost)}" ${dis}></label>
        <label class="wide"><span>备注</span><input name="remark" value="${esc(d.remark)}" ${dis}></label></form>
      ${isNew ? '' : `<div class="kv" style="margin-top:10px"><div><b>快递</b><span>${esc(d.express_co)} ${esc(d.tracking_no)}</span></div><div><b>寄出日期</b><span>${esc(d.send_date)}</span></div>
        <div><b>客户反馈</b><span>${esc(d.customer_feedback)}</span></div><div><b>业务员</b><span>${esc(d.salesman_name)}</span></div></div>`}</div>
      <div class="panel"><div class="panel-head"><h3>送样明细（支持送样阶段改新货号）</h3>${editable ? '<button class="btn" id="addItem" type="button">＋ 添加样品</button>' : ''}</div>
        <div class="alert info">流程：录入新货号与改样要求 → 打样/雕塑按新货号制作 → 跟单员线上核验（不通过发起重做并留存整改记录）→ 核验通过一键转正为正式样品档案 → 旧货号自动锁定，禁止报价/下单/出货。</div>
        <div class="table-wrap items-table"><table><thead><tr><th>样品货号</th><th>数量</th><th>改新货号</th><th>详细改样要求</th><th>核验</th><th>转正</th><th>操作</th></tr></thead><tbody id="items">${d.items.map(row).join('')}</tbody></table></div></div>`;
    const tbody = main.querySelector('#items');
    const bindRm = () => tbody.querySelectorAll('[data-rm]').forEach((b) => { b.onclick = () => b.closest('tr').remove(); });
    bindRm();
    const ai = main.querySelector('#addItem');
    if (ai) ai.onclick = () => { tbody.insertAdjacentHTML('beforeend', row({})); bindRm(); };
    const acts = main.querySelector('#actions');
    const btn = (text, cls, fn) => { const b = document.createElement('button'); b.className = 'btn ' + cls; b.textContent = text; b.onclick = async () => { try { await fn(); } catch (e) { toast(e.message, 'error'); } }; acts.appendChild(b); };
    if (editable) {
      btn('保存', 'primary', async () => {
        const h = Object.fromEntries([...main.querySelectorAll('#hdr [name]')].map((el) => [el.name, el.value]));
        h.items = [...tbody.querySelectorAll('tr')].map((tr) => ({ id: tr.dataset.id ? Number(tr.dataset.id) : undefined, ...Object.fromEntries([...tr.querySelectorAll('[data-f]')].map((el) => [el.dataset.f, el.value])) })).filter((x) => x.sample_id);
        const r = isNew ? await post('/api/sample-sends', h) : await put('/api/sample-sends/' + id, h);
        toast('送样单已保存', 'ok');
        if (isNew) location.hash = '#/send/' + r.id; else ERP.navigate();
      });
    }
    if (!isNew && !designer && can('sendsample', 'edit')) {
      if (d.status === '申请中') {
        btn('登记寄出', '', () => modal({
          title: '登记寄出', body: `<div class="form-grid"><label><span class="req">快递公司</span><input name="express_co" value="DHL"></label><label><span class="req">快递单号</span><input name="tracking_no"></label>
            <label>寄出日期<input type="date" name="send_date" value="${new Date().toISOString().slice(0, 10)}"></label><label>送样费用¥<input type="number" name="cost" value="${esc(d.cost)}"></label></div>`,
          buttons: [{ text: '确认寄出', cls: 'primary', onClick: async (m) => { await post(`/api/sample-sends/${id}/status`, { status: '已寄出', ...ERP.readForm(m.el) }); m.close(); ERP.navigate(); } }],
        }));
      }
      if (d.status === '已寄出') {
        for (const st of ['客户确认', '客户拒绝']) {
          btn(st, st === '客户确认' ? 'primary' : 'danger', () => modal({ title: st, body: '<label class="field">客户反馈<textarea name="customer_feedback"></textarea></label>',
            buttons: [{ text: '确定', cls: 'primary', onClick: async (m) => { await post(`/api/sample-sends/${id}/status`, { status: st, ...ERP.readForm(m.el) }); m.close(); ERP.navigate(); } }] }));
        }
      }
    }
    if (!isNew && can('sendsample', 'print')) {
      btn('打印送样单', '', () => printHtml(`${docHead('送样单 SAMPLE DELIVERY NOTE')}
        <table style="margin-bottom:8px"><tr><td>送样单号: ${esc(d.send_no)}</td><td>客户: ${esc(d.customer_name)}（${esc(d.country)}）</td><td>业务员: ${esc(d.salesman_name)}</td></tr>
        <tr><td>快递: ${esc(d.express_co)} ${esc(d.tracking_no)}</td><td>寄出日期: ${esc(d.send_date)}</td><td>状态: ${esc(d.status)}</td></tr></table>
        <table><thead><tr><th>No.</th><th>原货号</th><th>品名</th><th>工艺/花色</th><th>数量</th><th>设计师</th></tr></thead><tbody>
        ${d.items.map((it, n) => `<tr><td>${n + 1}</td><td>${esc(it.item_no)}</td><td>${esc(it.sample_name)}</td><td>${esc([it.craft, it.color].filter(Boolean).join('/'))}</td><td>${it.qty}</td><td>${esc(it.designer_name)}</td></tr>`).join('')}</tbody></table>
        ${revisionFooter(d.items)}`));
    }
    tbody.querySelectorAll('[data-vok]').forEach((b) => {
      b.onclick = () => modal({ title: '改样核验通过', body: '<label class="field">核验意见<textarea name="note">样品已匹配客户变更要求</textarea></label>',
        buttons: [{ text: '确认通过', cls: 'primary', onClick: async (m) => { await post(`/api/send-items/${b.dataset.vok}/verify`, { pass: true, ...ERP.readForm(m.el) }); m.close(); ERP.navigate(); } }] });
    });
    tbody.querySelectorAll('[data-vng]').forEach((b) => {
      b.onclick = () => modal({ title: '核验不通过 - 发起重做', body: '<label class="field"><span class="req">整改意见</span><textarea name="note"></textarea></label>',
        buttons: [{ text: '发起重做', cls: 'danger', onClick: async (m) => { await post(`/api/send-items/${b.dataset.vng}/verify`, { pass: false, ...ERP.readForm(m.el) }); m.close(); ERP.navigate(); } }] });
    });
    tbody.querySelectorAll('[data-conv]').forEach((b) => {
      b.onclick = () => modal({
        title: '新货号一键转正归档',
        body: `<div class="alert warn">将自动带入原设计师、改样记录、新旧货号关联与工艺参数，生成正式样品档案；<b>旧货号将被锁定</b>，后续报价/下单/出货必须使用新货号。</div>
          <div class="form-grid"><label>转正后工艺（空=沿用）<input name="craft"></label><label>转正后花色（空=沿用）<input name="color"></label><label class="wide">最新样品图片链接<input name="images"></label></div>`,
        buttons: [{ text: '确认转正', cls: 'primary', onClick: async (m) => { const r = await post(`/api/send-items/${b.dataset.conv}/convert`, ERP.readForm(m.el)); m.close(); ERP.clearOptions(); toast(`新样品档案 ${r.company_no} 已生成，旧货号已锁定`, 'ok'); ERP.navigate(); } }],
      });
    });
  });
})();
