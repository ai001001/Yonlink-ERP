'use strict';
/**
 * 出货中心与应收应付台账页面（参照亿星）：按发票出货、装箱分柜、报关明细、单证打印；应收台账与账龄、
 * 其他应收、水单登记与认领；应付台账与账龄
 * Shipping centre and AR/AP ledger pages modelled on 亿星.
 */
(() => {
  const { esc, money, get, post, put, del, toast, modal, tableHtml, tag, can, route, setTitle, confirmBox, optHtml, options, readForm, printHtml, exportTable } = ERP;
  const today = (n = 0) => new Date(Date.now() + n * 86400000).toLocaleDateString('sv-SE');

  /**
   * 账龄卡片（按币种）/ Ageing cards per currency.
   * @param {object[]} rows 汇总 / summary rows
   * @param {string[]} buckets 账龄段 / buckets
   * @returns {string}
   */
  const ageingHtml = (rows, buckets) => (rows.length ? tableHtml(['币种', '合计', ...buckets], rows.map((r) => [esc(r.currency), `<b>${money(r.total)}</b>`,
    ...buckets.map((b) => (r[b] ? `<span class="${b === '未到期' ? '' : 'tag danger'}">${money(r[b])}</span>` : '-'))]), new Set([1, 2, 3, 4, 5, 6]))
    : '<div class="alert info"><span>没有未结清的款项。</span></div>');

  // ===================== 出货中心 / shipping centre =====================
  route(/^\/invoices$/, async (_, main) => {
    setTitle('出货中心（按发票）');
    const { rows } = await get('/api/ship-invoices');
    await ERP.grid(main, {
      key: 'doc.invoices', title: '出货中心（按商业发票）', mode: 'client', rows, module: 'order',
      toolbar: can('order', 'edit') ? '<a class="btn primary" href="#/invoice/new">＋ 新建出货发票</a>' : '',
      headHtml: '<div class="alert info"><span>一张发票可以合并同一客户、同一币种的多张订单，分多个柜；在发票里整票报关、出运，并打印商业发票、装箱单。按订单单独“安排出货”的方式仍然可用。</span></div>',
      columns: [
        { key: 'invoice_no', label: '发票号', html: (r) => `<a href="#/invoice/${r.id}">${esc(r.invoice_no)}</a>` }, { key: 'invoice_date', label: '发票日期' },
        { key: 'customer_name', label: '客户' }, { key: 'country', label: '国别' }, { key: 'salesman_name', label: '业务员' }, { key: 'order_nos', label: '订单' },
        { key: 'currency', label: '币种' }, { key: 'amount', label: '发票金额', num: true, html: (r) => money(r.amount) },
        { key: 'cartons', label: '箱数', num: true }, { key: 'cbm', label: 'CBM', num: true }, { key: 'container_nos', label: '柜号' }, { key: 'bl_no', label: '提单号' },
        { key: 'customs_no', label: '报关单号' }, { key: 'etd', label: 'ETD' }, { key: 'status', label: '状态', html: (r) => tag(r.status) },
      ],
      defaultCols: ['invoice_no', 'invoice_date', 'customer_name', 'order_nos', 'currency', 'amount', 'cartons', 'cbm', 'customs_no', 'etd', 'status'],
      tree: [{ key: 'customer_name', label: '客户' }, { key: 'status', label: '状态' }, { key: 'salesman_name', label: '业务员' }, { key: 'month', label: '发票月份', text: (r) => String(r.invoice_date || '').slice(0, 7) }],
      schemes: [['status'], ['customer_name'], ['month'], ['salesman_name', 'customer_name']],
      quick: [{ key: 'invoice_no', label: '发票号' }, { key: 'customer_name', label: '客户' }, { key: 'order_nos', label: '订单号' }, { key: 'customs_no', label: '报关单号' }],
    });
  });

  /**
   * 选择出货明细（新建发票/追加出货）/ Pick shippable lines and un-invoiced shipments.
   * @param {HTMLElement} box 容器 / container
   * @param {number} customerId 客户 / customer
   * @param {string} [currency] 只显示该币种 / currency filter
   */
  async function pickLines(box, customerId, currency) {
    if (!customerId) { box.innerHTML = '<div class="muted small">请先选择客户</div>'; return; }
    const d = await get(`/api/customers/${customerId}/shippable`);
    const lines = d.lines.filter((l) => !currency || l.currency === currency);
    const ships = d.shipments.filter((s) => !currency || s.currency === currency);
    box.innerHTML = `<h4 class="mig-sub">待出货的订单明细（填写本次出货数量）</h4>
      ${tableHtml(['订单', '币种', '交期', '货号', '描述', '订单数', '已排出货', '可出货', '本次出货', '柜号'], lines.map((l) => [esc(l.order_no) + (l.risk_lock ? ' <span class="tag danger">锁定</span>' : ''), esc(l.currency), esc(l.delivery_date),
    esc(l.item_no), esc(l.description), l.qty, l.shipped_qty, l.remain, `<input type="number" style="width:90px" data-oi="${l.order_item_id}" data-cur="${esc(l.currency)}" max="${l.remain}" ${l.risk_lock ? 'disabled title="订单被变更风控锁定"' : ''}>`,
    `<input style="width:120px" data-ct="${l.order_item_id}" placeholder="可选">`]))}
      <h4 class="mig-sub">已安排但未开发票的出货单（勾选加入）</h4>
      ${tableHtml(['', '出货单', '订单', '币种', '数量', '验货', '状态'], ships.map((s) => [`<input type="checkbox" data-sh="${s.id}" data-cur="${esc(s.currency)}">`, esc(s.ship_no), esc(s.order_no), esc(s.currency), s.qty, tag(s.inspection_status), tag(s.status)]))}`;
    box.querySelectorAll('[data-oi]').forEach((el) => {
      el.oninput = () => { if (Number(el.value) > Number(el.max)) el.value = el.max; };
    });
  }

  /**
   * 读取已选的出货明细 / Read selected lines.
   * @param {HTMLElement} box
   * @returns {{new_lines:object[], shipment_ids:number[], currencies:Set<string>}}
   */
  function readPick(box) {
    const newLines = [...box.querySelectorAll('[data-oi]')].filter((el) => Number(el.value) > 0)
      .map((el) => ({ order_item_id: Number(el.dataset.oi), qty: Number(el.value), container_no: box.querySelector(`[data-ct="${el.dataset.oi}"]`).value, cur: el.dataset.cur }));
    const ships = [...box.querySelectorAll('[data-sh]:checked')].map((el) => ({ id: Number(el.dataset.sh), cur: el.dataset.cur }));
    return { new_lines: newLines, shipment_ids: ships.map((x) => x.id), currencies: new Set([...newLines.map((x) => x.cur), ...ships.map((x) => x.cur)]) };
  }

  route(/^\/invoice\/new$/, async (_, main) => {
    setTitle('新建出货发票');
    const [customers, currencies] = await Promise.all([options('customer'), options('currency')]);
    main.innerHTML = `<div class="panel"><div class="panel-head"><h2>新建出货发票</h2><div class="toolbar"><button class="btn primary" id="save" type="button">生成发票</button><a class="btn" href="#/invoices">返回</a></div></div>
      <form class="form-grid" id="hdr">
        <label><span class="req">客户</span><select name="customer_id">${optHtml(customers, '')}</select></label>
        <label><span class="req">币种</span><select name="currency">${optHtml(currencies, 'USD', false)}</select></label>
        <label><span>发票号（空=自动）</span><input name="invoice_no" placeholder="如 INV250017"></label>
        <label><span>发票日期</span><input type="date" name="invoice_date" value="${today()}"></label>
        <label><span>收款到期日（空=发票日+30天）</span><input type="date" name="due_date"></label>
        <label><span>起运港</span><input name="port_loading" value="XIAMEN"></label><label><span>目的港（空=客户档案）</span><input name="port_dest"></label>
        <label><span>ETD</span><input type="date" name="etd"></label><label><span>船名航次</span><input name="vessel"></label>
      </form><div id="pick" style="margin-top:10px"></div></div>`;
    const hdr = main.querySelector('#hdr');
    const refresh = () => pickLines(main.querySelector('#pick'), hdr.customer_id.value, hdr.currency.value).catch((e) => toast(e.message, 'error'));
    hdr.customer_id.onchange = refresh;
    hdr.currency.onchange = refresh;
    refresh();
    main.querySelector('#save').onclick = async () => {
      const pick = readPick(main.querySelector('#pick'));
      if (!pick.new_lines.length && !pick.shipment_ids.length) { toast('请填写出货数量或勾选出货单', 'error'); return; }
      try {
        const r = await post('/api/ship-invoices', { ...readForm(hdr), new_lines: pick.new_lines, shipment_ids: pick.shipment_ids });
        toast(`已生成发票 ${r.invoice_no}`, 'ok');
        location.hash = '#/invoice/' + r.id;
      } catch (e) { toast(e.message, 'error'); }
    };
  });

  route(/^\/invoice\/(\d+)$/, async ([id], main) => {
    const v = await get('/api/ship-invoices/' + id);
    setTitle('出货发票 ' + v.invoice_no);
    const editable = can('order', 'edit') && !['已出运', '已作废'].includes(v.status);
    const dis = editable ? '' : 'disabled';
    const fwd = (await get('/api/e/agency?size=200&f_type=' + encodeURIComponent('货代公司')).catch(() => ({ rows: [] }))).rows.map((a) => ({ id: a.id, label: a.name }));
    const inp = (n, l, type = 'text') => `<label><span>${l}</span><input name="${n}" type="${type}" value="${esc(v[n])}" ${dis}></label>`;
    main.innerHTML = `<div class="panel"><div class="panel-head"><h2>${esc(v.invoice_no)} ${tag(v.status)}</h2><div class="toolbar" id="acts"></div></div>
        <div class="kv"><div><b>客户</b><span><a href="#/customer/${v.customer_id}">${esc(v.customer_name)}</a></span></div><div><b>币种</b><span>${esc(v.currency)}</span></div>
          <div><b>发票金额</b><span><b>${money(v.total.amount)}</b></span></div><div><b>数量</b><span>${v.total.qty}</span></div><div><b>箱数</b><span>${v.total.cartons}</span></div>
          <div><b>体积</b><span>${v.total.cbm} m³</span></div><div><b>毛重/净重</b><span>${v.total.gw} / ${v.total.nw} kg</span></div><div><b>柜号</b><span>${esc(v.containers.join('、') || v.container_nos || '-')}</span></div></div>
        ${v.missing_hs.length ? `<div class="alert warn" style="margin-top:8px"><span>以下货号没有海关编码，报关明细会归入空编码：${esc(v.missing_hs.join('、'))}（在样品档案中补充“海关编码”）</span></div>` : ''}</div>
      <div class="panel"><div class="panel-head"><h3>发票与装运资料</h3>${editable ? '<button class="btn small primary" id="saveHdr" type="button">保存</button>' : ''}</div>
        <form class="form-grid" id="hdr">${inp('invoice_date', '发票日期', 'date')}${inp('due_date', '收款到期日', 'date')}${inp('trade_term', '价格条款')}
          ${inp('port_loading', '起运港')}${inp('port_dest', '目的港')}${inp('transport', '运输方式')}${inp('vessel', '船名航次')}${inp('etd', 'ETD', 'date')}${inp('eta', 'ETA', 'date')}
          ${inp('bl_no', '提单号')}${inp('container_nos', '柜号（多个用逗号）')}${inp('seal_nos', '封条号')}${inp('customs_no', '报关单号')}
          <label><span>货代</span><select name="forwarder_id" ${dis}>${optHtml(fwd, v.forwarder_id)}</select></label>
          <label class="wide"><span>收货人 Consignee</span><textarea name="consignee" rows="2" ${dis}>${esc(v.consignee)}</textarea></label>
          <label class="wide"><span>通知人 Notify Party</span><textarea name="notify" rows="2" ${dis}>${esc(v.notify)}</textarea></label>
          <label class="wide"><span>唛头 Shipping Marks</span><textarea name="shipping_marks" rows="3" ${dis}>${esc(v.shipping_marks)}</textarea></label>
          <label class="wide"><span>备注</span><input name="remark" value="${esc(v.remark)}" ${dis}></label></form></div>
      <div class="panel"><div class="panel-head"><h3>出货单（每张订单一张）</h3>${v.status === '草稿' && can('order', 'edit') ? '<button class="btn small" id="addShip" type="button">＋ 追加出货</button>' : ''}</div>
        ${tableHtml(['出货单', '订单', '客户PO', '验货', '状态', '报关单号', ''], v.shipments.map((s) => [esc(s.ship_no), `<a href="#/order/${s.order_id}">${esc(s.order_no)}</a>`, esc(s.po_no), tag(s.inspection_status), tag(s.status), esc(s.customs_no),
    v.status === '草稿' && can('order', 'edit') ? `${s.inspection_status !== '合格' ? `<button class="btn small" type="button" data-insp="${s.id}">验货合格</button> ` : ''}<button class="btn small danger" type="button" data-rm="${s.id}">移出</button>` : '']))}</div>
      <div class="panel"><h3 class="section-title">装箱明细（分柜）</h3>
        ${tableHtml(['订单', '货号', '品名', '数量', '单价', '金额', '箱数', '体积m³', '毛重kg', '净重kg', '柜号'], v.lines.map((l) => [esc(l.order_no), esc(l.item_no), esc(l.name_en || l.description), l.qty, money(l.unit_price), money(l.amount),
    editable ? `<input type="number" style="width:70px" data-l="${l.id}" data-k="cartons" value="${l.cartons ?? ''}">` : l.cartons,
    editable ? `<input type="number" step="any" style="width:80px" data-l="${l.id}" data-k="cbm" value="${l.cbm ?? ''}">` : l.cbm,
    editable ? `<input type="number" step="any" style="width:80px" data-l="${l.id}" data-k="gw" value="${l.gw ?? ''}">` : l.gw,
    editable ? `<input type="number" step="any" style="width:80px" data-l="${l.id}" data-k="nw" value="${l.nw ?? ''}">` : l.nw,
    editable ? `<input style="width:120px" data-l="${l.id}" data-k="container_no" value="${esc(l.container_no)}">` : esc(l.container_no)]), new Set([3, 4, 5, 6, 7, 8, 9]))}</div>
      <div class="panel"><div class="panel-head"><h3>报关明细（按海关编码汇总）</h3><button class="btn small" id="expCustoms" type="button">导出Excel</button></div>
        ${tableHtml(['海关编码', '英文品名', '中文品名', '单位', '数量', '箱数', '毛重kg', '净重kg', '单价', '金额'], v.customs.map((c) => [esc(c.hs_code || '（未填）'), esc(c.name), esc(c.name_cn), esc(c.unit), c.qty, c.cartons, c.gw, c.nw, money(c.unit_price), money(c.amount)]), new Set([4, 5, 6, 7, 8, 9]))}</div>`;

    const acts = main.querySelector('#acts');
    const btn = (text, cls, fn) => { const b = document.createElement('button'); b.className = 'btn ' + cls; b.type = 'button'; b.textContent = text; b.onclick = async () => { try { await fn(); } catch (e) { toast(e.message, 'error'); } }; acts.appendChild(b); };
    const hdrBody = () => readForm(main.querySelector('#hdr'));
    if (can('order', 'edit')) {
      if (v.status === '草稿') {
        btn('整票报关', 'primary', () => modal({
          title: '整票报关', body: `<label class="field"><span class="req">报关单号</span><input name="customs_no" value="${esc(v.customs_no)}"></label><p class="muted small">本发票下所有出货单都必须验货合格。</p>`,
          buttons: [{ text: '确认报关', cls: 'primary', onClick: async (m) => { await put('/api/ship-invoices/' + id, hdrBody()); await post(`/api/ship-invoices/${id}/status`, { status: '已报关', ...readForm(m.el) }); m.close(); toast('已报关', 'ok'); ERP.navigate(); } }],
        }));
      }
      if (['草稿', '已报关'].includes(v.status)) {
        btn('整票出运', 'primary', async () => {
          if (!(await confirmBox('确认整票出运？出运后出货单与发票不能再修改，订单出货状态同步更新。'))) return;
          await put('/api/ship-invoices/' + id, hdrBody());
          await post(`/api/ship-invoices/${id}/status`, { status: '已出运' });
          toast('已出运', 'ok');
          ERP.navigate();
        });
      }
      if (v.status !== '已作废') {
        btn('按发票出库', '', async () => {
          if (!(await confirmBox('把本发票下所有出货单的成品做销售出库？（按各订单在库数量扣减）'))) return;
          const r = await post(`/api/ship-invoices/${id}/fg-out`, {});
          toast(`已出库 ${r.lines} 行`, 'ok');
        });
      }
      if (v.status === '草稿') btn('作废', 'danger', async () => { if (await confirmBox('作废该发票？出货单会保留，回到“未开票”状态。')) { await post(`/api/ship-invoices/${id}/status`, { status: '已作废' }); ERP.navigate(); } });
    }
    const company = ERP.state.meta.company;
    const head = (title) => `<h1>${esc(company.name_en || company.name)}</h1><div class="sub">${esc(company.name)}<br><b style="font-size:15px">${title}</b></div>
      <table style="margin-bottom:8px"><tr><td>Invoice No.: ${esc(v.invoice_no)}</td><td>Date: ${esc(v.invoice_date)}</td><td>Terms: ${esc(v.trade_term || '')}</td></tr>
      <tr><td colspan="2">To: ${esc(v.full_name_en || v.customer_name)}<br>${esc(v.address || '')}</td><td>From ${esc(v.port_loading || '')} To ${esc(v.port_dest || '')}<br>Vessel: ${esc(v.vessel || '')}　B/L: ${esc(v.bl_no || '')}</td></tr></table>`;
    const marks = v.shipping_marks ? `<h3>Shipping Marks</h3><div class="pre">${esc(v.shipping_marks)}</div>` : '';
    btn('打印商业发票', '', () => printHtml(`${head('COMMERCIAL INVOICE')}<table><thead><tr><th>Order/PO</th><th>Item No.</th><th>Description</th><th>Qty</th><th>Unit Price</th><th>Amount</th></tr></thead><tbody>
      ${v.lines.map((l) => `<tr><td>${esc(l.order_no)}${l.po_no ? '<br>' + esc(l.po_no) : ''}</td><td>${esc(l.item_no)}</td><td>${esc(l.name_en || l.description)}</td><td>${l.qty}</td><td>${money(l.unit_price)}</td><td>${money(l.amount)}</td></tr>`).join('')}
      <tr><td colspan="3" style="text-align:right"><b>TOTAL ${esc(v.currency)}</b></td><td>${v.total.qty}</td><td></td><td><b>${money(v.total.amount)}</b></td></tr></tbody></table>${marks}`));
    btn('打印装箱单', '', () => printHtml(`${head('PACKING LIST')}<table><thead><tr><th>Container</th><th>Item No.</th><th>Description</th><th>Qty</th><th>CTNS</th><th>CBM</th><th>G.W.(kg)</th><th>N.W.(kg)</th></tr></thead><tbody>
      ${v.lines.slice().sort((a, b) => String(a.container_no || '').localeCompare(String(b.container_no || ''))).map((l) => `<tr><td>${esc(l.container_no || '')}</td><td>${esc(l.item_no)}</td><td>${esc(l.name_en || l.description)}</td><td>${l.qty}</td><td>${l.cartons}</td><td>${l.cbm}</td><td>${l.gw ?? ''}</td><td>${l.nw ?? ''}</td></tr>`).join('')}
      <tr><td colspan="3" style="text-align:right"><b>TOTAL</b></td><td>${v.total.qty}</td><td>${v.total.cartons}</td><td>${v.total.cbm}</td><td>${v.total.gw}</td><td>${v.total.nw}</td></tr></tbody></table>${marks}`));
    main.querySelector('#expCustoms').onclick = () => exportTable('order', `报关明细${v.invoice_no}`, ['海关编码', '英文品名', '中文品名', '单位', '数量', '箱数', '毛重kg', '净重kg', '单价', '金额', '币种'],
      v.customs.map((c) => [c.hs_code, c.name, c.name_cn, c.unit, c.qty, c.cartons, c.gw, c.nw, c.unit_price, c.amount, v.currency]));
    const sh = main.querySelector('#saveHdr');
    if (sh) sh.onclick = async () => { try { await put('/api/ship-invoices/' + id, hdrBody()); toast('已保存', 'ok'); ERP.navigate(); } catch (e) { toast(e.message, 'error'); } };
    // 装箱明细逐格保存 / save packing cells on change
    main.querySelectorAll('[data-l]').forEach((el) => {
      el.onchange = async () => {
        try { await put(`/api/ship-invoices/${id}/lines/${el.dataset.l}`, { [el.dataset.k]: el.value }); toast('装箱明细已保存', 'ok'); } catch (e) { toast(e.message, 'error'); ERP.navigate(); }
      };
    });
    main.querySelectorAll('[data-rm]').forEach((b) => { b.onclick = async () => { if (await confirmBox('把该出货单移出本发票？')) { try { await del(`/api/ship-invoices/${id}/shipments/${b.dataset.rm}`); ERP.navigate(); } catch (e) { toast(e.message, 'error'); } } }; });
    main.querySelectorAll('[data-insp]').forEach((b) => { b.onclick = async () => { try { await put('/api/shipments/' + b.dataset.insp, { inspection_status: '合格' }); toast('已标记验货合格', 'ok'); ERP.navigate(); } catch (e) { toast(e.message, 'error'); } }; });
    const as = main.querySelector('#addShip');
    if (as) {
      as.onclick = async () => {
        const m = modal({
          title: '追加出货（同客户、同币种）', wide: true, body: '<div id="pick2"></div>',
          buttons: [{
            text: '加入发票', cls: 'primary', onClick: async (mm) => {
              const pick = readPick(mm.el.querySelector('#pick2'));
              if (!pick.new_lines.length && !pick.shipment_ids.length) throw new Error('请填写出货数量或勾选出货单');
              await post(`/api/ship-invoices/${id}/shipments`, { new_lines: pick.new_lines, shipment_ids: pick.shipment_ids });
              mm.close(); toast('已追加', 'ok'); ERP.navigate();
            },
          }],
        });
        await pickLines(m.el.querySelector('#pick2'), v.customer_id, v.currency);
      };
    }
  });

  // ===================== 应收账款台账 / receivable ledger =====================
  route(/^\/ar$/, async (_, main) => {
    setTitle('应收账款台账');
    const d = await get('/api/ar-ledger');
    const box = document.createElement('div');
    main.innerHTML = `<div class="panel"><div class="panel-head"><h3>应收账龄（未收余额，原币）</h3>${can('receivable', 'add') ? '<button class="btn" id="addOther" type="button">＋ 登记其他应收</button>' : ''}</div>
      ${ageingHtml(d.ageing, d.buckets)}
      ${d.advances.length ? `<h4 class="mig-sub">预收余额（多收、尚未冲抵的款项）</h4>${tableHtml(['订单', '客户', '币种', '预收余额'], d.advances.map((a) => [`<a href="#/receivable/${a.order_id}">${esc(a.order_no)}</a>`, esc(a.customer_name), esc(a.currency), money(a.advance)]))}` : ''}
      <p class="muted small">台账按来源单据生成：预收订金（订单“预收订金比率”，下单日到期）、出货应收（整票出运后按发票，扣除已列的订金）、订单加减项、其他应收（样品费、快递费等）。收款与销账按到期日先后冲抵。</p></div>`;
    main.appendChild(box);
    await ERP.grid(box, {
      key: 'doc.ar', title: '应收明细', mode: 'client', rows: d.entries, module: 'receivable',
      columns: [
        { key: 'kind', label: '类型' }, { key: 'source_no', label: '来源单号' },
        { key: 'order_no', label: '订单', html: (e) => (e.order_id ? `<a href="#/receivable/${e.order_id}">${esc(e.order_no)}</a>` : esc(e.order_no)) },
        { key: 'customer_name', label: '客户' }, { key: 'salesman_name', label: '业务员' }, { key: 'currency', label: '币种' },
        { key: 'amount', label: '应收', num: true, html: (e) => money(e.amount) }, { key: 'received', label: '已收', num: true, html: (e) => money(e.received) },
        { key: 'outstanding', label: '未收', num: true, html: (e) => (e.outstanding > 0 ? `<b>${money(e.outstanding)}</b>` : money(e.outstanding)) },
        { key: 'doc_date', label: '单据日期' }, { key: 'due_date', label: '到期日' },
        { key: 'overdue_days', label: '逾期天数', num: true, html: (e) => (e.overdue_days > 0 ? `<span class="tag danger">${e.overdue_days}</span>` : '') },
        { key: 'bucket', label: '账龄' }, { key: 'status', label: '状态', html: (e) => tag(e.status === '已收' ? '已收齐' : e.status === '未收' ? '未收款' : e.status) },
      ],
      tree: [{ key: 'bucket', label: '账龄' }, { key: 'customer_name', label: '客户' }, { key: 'kind', label: '类型' }, { key: 'status', label: '状态' }, { key: 'salesman_name', label: '业务员' }, { key: 'currency', label: '币种' }],
      schemes: [['status', 'bucket'], ['customer_name', 'kind'], ['bucket', 'customer_name'], ['salesman_name', 'customer_name']],
      quick: [{ key: 'customer_name', label: '客户' }, { key: 'order_no', label: '订单' }, { key: 'source_no', label: '来源单号' }],
      actions: can('receivable', 'edit') ? (e) => (e.other_id && e.received === 0 ? `<button class="btn small danger" type="button" data-dother="${e.other_id}">删除</button>` : '') : null,
      bind: (root) => root.querySelectorAll('[data-dother]').forEach((b) => { b.onclick = async () => { if (await confirmBox('删除这笔其他应收？')) { try { await del('/api/ar-others/' + b.dataset.dother); ERP.navigate(); } catch (e) { toast(e.message, 'error'); } } }; }),
    });
    const ao = main.querySelector('#addOther');
    if (ao) {
      ao.onclick = async () => {
        const [customers, currencies] = await Promise.all([options('customer'), options('currency')]);
        modal({
          title: '登记其他应收（样品费、快递费、索赔等）', body: `<div class="form-grid"><label><span class="req">客户</span><select name="customer_id">${optHtml(customers, '')}</select></label>
            <label><span class="req">费用名称</span><input name="kind" list="otherKinds" placeholder="样品费/快递费/索赔"><datalist id="otherKinds"><option>样品费</option><option>快递费</option><option>索赔</option><option>其他应收</option></datalist></label>
            <label><span class="req">币种</span><select name="currency">${optHtml(currencies, 'USD', false)}</select></label><label><span class="req">金额</span><input name="amount" type="number" step="any"></label>
            <label><span>到期日</span><input name="due_date" type="date" value="${today(30)}"></label><label><span>来源单号</span><input name="source_no" placeholder="送样单/快递单号"></label>
            <label class="wide"><span>备注</span><input name="remark"></label></div>`,
          buttons: [{ text: '保存', cls: 'primary', onClick: async (m) => { const r = await post('/api/ar-others', readForm(m.el)); m.close(); toast(`已登记 ${r.other_no}`, 'ok'); ERP.navigate(); } }],
        });
      };
    }
  });

  // ===================== 应付账款台账 / payable ledger =====================
  route(/^\/ap$/, async (_, main) => {
    setTitle('应付账款台账');
    const d = await get('/api/ap-ledger');
    const box = document.createElement('div');
    main.innerHTML = `<div class="panel"><h3 class="section-title">应付账龄（未付余额，人民币）</h3>${ageingHtml(d.ageing, d.buckets)}
      <p class="muted small">付款到期日 = 采购交货期 + 供应商结算方式中的账期（如“月结30天”）；“款到发货/预付”在下单日到期。待审批付款单独列出，审批通过后计入已付。</p></div>`;
    main.appendChild(box);
    await ERP.grid(box, {
      key: 'doc.ap', title: '应付明细（按采购单）', mode: 'client', rows: d.entries, module: 'purchase',
      columns: [
        { key: 'po_no', label: '采购单', html: (p) => `<a href="#/purchase/${p.id}">${esc(p.po_no)}</a>` }, { key: 'supplier_name', label: '供应商' }, { key: 'type', label: '类型' },
        { key: 'order_no', label: '关联订单' }, { key: 'settlement', label: '结算方式' },
        { key: 'amount', label: '应付¥', num: true, html: (p) => money(p.amount) }, { key: 'paid', label: '已付¥', num: true, html: (p) => money(p.paid) },
        { key: 'pending', label: '待审批¥', num: true, html: (p) => (p.pending ? money(p.pending) : '') },
        { key: 'outstanding', label: '未付¥', num: true, html: (p) => (p.outstanding > 0 ? `<b>${money(p.outstanding)}</b>` : money(p.outstanding)) },
        { key: 'invoiced', label: '已收票¥', num: true, html: (p) => money(p.invoiced) }, { key: 'delivery_date', label: '交货期' }, { key: 'pay_due_date', label: '付款到期日' },
        { key: 'overdue_days', label: '逾期天数', num: true, html: (p) => (p.overdue_days > 0 ? `<span class="tag danger">${p.overdue_days}</span>` : '') },
        { key: 'bucket', label: '账龄' }, { key: 'pay_status', label: '付款状态', html: (p) => tag(p.pay_status === '已付清' ? '已付款' : p.pay_status === '未付' ? '待处理' : '部分收款') },
      ],
      defaultCols: ['po_no', 'supplier_name', 'type', 'order_no', 'amount', 'paid', 'pending', 'outstanding', 'invoiced', 'pay_due_date', 'overdue_days', 'bucket', 'pay_status'],
      tree: [{ key: 'bucket', label: '账龄' }, { key: 'supplier_name', label: '供应商' }, { key: 'pay_status', label: '付款状态' }, { key: 'type', label: '类型' }],
      schemes: [['pay_status', 'bucket'], ['supplier_name'], ['bucket', 'supplier_name']],
      quick: [{ key: 'supplier_name', label: '供应商' }, { key: 'po_no', label: '采购单' }, { key: 'order_no', label: '关联订单' }],
    });
  });

  // ===================== 水单 / bank slips =====================
  route(/^\/slips$/, async (_, main) => {
    setTitle('水单认领');
    const { rows } = await get('/api/bank-slips');
    await ERP.grid(main, {
      key: 'doc.slips', title: '水单（银行到账）', mode: 'client', rows, module: 'receivable',
      toolbar: can('receivable', 'add') ? '<button class="btn primary" type="button" id="addSlip">＋ 登记水单</button>' : '',
      headHtml: '<div class="alert info"><span>财务登记银行到账（水单），业务员认领到本人订单后系统自动生成收款记录；手续费计入客户付款额，可一并认领。</span></div>',
      columns: [
        { key: 'slip_no', label: '水单号', html: (s) => `<a href="#/slip/${s.id}">${esc(s.slip_no)}</a>` }, { key: 'receive_date', label: '到账日期' },
        { key: 'payer', label: '付款人' }, { key: 'customer_name', label: '客户' }, { key: 'currency', label: '币种' },
        { key: 'amount', label: '到账金额', num: true, html: (s) => money(s.amount) }, { key: 'fee', label: '手续费', num: true, html: (s) => money(s.fee) },
        { key: 'claimed', label: '已认领', num: true, html: (s) => money(s.claimed) }, { key: 'remaining', label: '待认领', num: true, html: (s) => (s.remaining > 0 ? `<b>${money(s.remaining)}</b>` : money(s.remaining)) },
        { key: 'bank', label: '收款银行' }, { key: 'status', label: '状态', html: (s) => tag(s.status === '已认领' ? '已完成' : s.status === '未认领' ? '待处理' : '部分收款') },
      ],
      tree: [{ key: 'status', label: '状态' }, { key: 'customer_name', label: '客户' }, { key: 'currency', label: '币种' }, { key: 'month', label: '到账月份', text: (s) => String(s.receive_date || '').slice(0, 7) }],
      schemes: [['status'], ['customer_name'], ['month']],
      quick: [{ key: 'slip_no', label: '水单号' }, { key: 'payer', label: '付款人' }, { key: 'customer_name', label: '客户' }],
    });
    const ab = main.querySelector('#addSlip');
    if (ab) {
      ab.onclick = async () => {
        const [customers, currencies] = await Promise.all([options('customer'), options('currency')]);
        modal({
          title: '登记水单', body: `<div class="form-grid"><label><span>水单号（空=自动）</span><input name="slip_no"></label><label><span class="req">到账日期</span><input type="date" name="receive_date" value="${today()}"></label>
            <label><span>付款人</span><input name="payer"></label><label><span>客户（不确定可留空）</span><select name="customer_id">${optHtml(customers, '')}</select></label>
            <label><span class="req">币种</span><select name="currency">${optHtml(currencies, 'USD', false)}</select></label><label><span class="req">到账金额</span><input name="amount" type="number" step="any"></label>
            <label><span>银行手续费</span><input name="fee" type="number" step="any" value="0"></label><label><span>收款银行</span><input name="bank"></label><label class="wide"><span>备注</span><input name="remark"></label></div>`,
          buttons: [{ text: '保存', cls: 'primary', onClick: async (m) => { const r = await post('/api/bank-slips', readForm(m.el)); m.close(); toast(`已登记 ${r.slip_no}`, 'ok'); location.hash = '#/slip/' + r.id; } }],
        });
      };
    }
  });

  route(/^\/slip\/(\d+)$/, async ([id], main) => {
    const s = await get('/api/bank-slips/' + id);
    setTitle('水单 ' + s.slip_no);
    main.innerHTML = `<div class="panel"><div class="panel-head"><h2>${esc(s.slip_no)} ${tag(s.status === '已认领' ? '已完成' : s.status === '未认领' ? '待处理' : '部分收款')}</h2>
        <div class="toolbar">${can('receivable', 'audit') && s.claimed === 0 ? '<button class="btn danger" id="delSlip" type="button">删除水单</button>' : ''}<a class="btn" href="#/slips">返回</a></div></div>
      <div class="kv"><div><b>到账日期</b><span>${esc(s.receive_date)}</span></div><div><b>付款人</b><span>${esc(s.payer)}</span></div><div><b>客户</b><span>${esc(s.customer_name || '未指定')}</span></div>
        <div><b>到账金额</b><span>${money(s.amount)} ${esc(s.currency)}</span></div><div><b>手续费</b><span>${money(s.fee)}</span></div><div><b>可认领</b><span>${money(s.claimable)}</span></div>
        <div><b>已认领</b><span>${money(s.claimed)}</span></div><div><b>待认领</b><span><b>${money(s.remaining)}</b></span></div><div><b>收款银行</b><span>${esc(s.bank)}</span></div></div></div>
      <div class="panel"><h3 class="section-title">认领记录</h3>${tableHtml(['时间', '认领到', '金额', '认领人', ''], s.claims.map((c) => [esc(c.created_at), c.target_type === 'order' ? `<a href="#/receivable/${c.target_id}">${esc(c.target_no)}</a>` : esc(c.target_no), money(c.amount), esc(c.user_name),
    can('receivable', 'audit') ? `<button class="btn small danger" type="button" data-uc="${c.id}">撤销</button>` : '']))}</div>
      ${s.remaining > 0.005 ? `<div class="panel"><div class="panel-head"><h3>认领（填写认领金额，合计不超过 ${money(s.remaining)} ${esc(s.currency)}）</h3><button class="btn primary" id="claim" type="button">确认认领</button></div>
        ${s.targets.length ? tableHtml(['类型', '单号', '客户', '未收余额', '本次认领'], s.targets.map((t, i) => [esc(t.kind), esc(t.no), esc(t.customer_name), money(t.outstanding),
    `<input type="number" step="any" style="width:110px" data-t="${i}" max="${t.outstanding}">`]), new Set([3])) : '<div class="alert info"><span>没有同币种、有未收余额、您有权认领的订单或其他应收。</span></div>'}
        <p class="muted small" id="claimSum"></p></div>` : ''}`;
    const sum = () => {
      const tot = [...main.querySelectorAll('[data-t]')].reduce((a, el) => a + (Number(el.value) || 0), 0);
      const el = main.querySelector('#claimSum');
      if (el) el.textContent = `本次认领合计 ${money(tot)}，认领后剩余 ${money(s.remaining - tot)}`;
    };
    main.querySelectorAll('[data-t]').forEach((el) => { el.oninput = sum; });
    const cb = main.querySelector('#claim');
    if (cb) {
      cb.onclick = async () => {
        const claims = [...main.querySelectorAll('[data-t]')].filter((el) => Number(el.value) > 0).map((el) => ({ ...s.targets[Number(el.dataset.t)], amount: Number(el.value) }));
        if (!claims.length) { toast('请填写认领金额', 'error'); return; }
        try { await post(`/api/bank-slips/${id}/claim`, { claims }); toast('认领成功，已生成收款记录', 'ok'); ERP.navigate(); } catch (e) { toast(e.message, 'error'); }
      };
    }
    main.querySelectorAll('[data-uc]').forEach((b) => { b.onclick = async () => { if (await confirmBox('撤销这笔认领？对应的收款记录会一并删除。')) { try { await del('/api/slip-claims/' + b.dataset.uc); ERP.navigate(); } catch (e) { toast(e.message, 'error'); } } }; });
    const ds = main.querySelector('#delSlip');
    if (ds) ds.onclick = async () => { if (await confirmBox('删除该水单？')) { try { await del('/api/bank-slips/' + id); location.hash = '#/slips'; } catch (e) { toast(e.message, 'error'); } } };
  });
})();
