'use strict';
/**
 * 库存与验货页面（参照亿星）：分仓库存查询、其他入库/出库/调拨、出入库明细、盘点、验货单
 * Stock & inspection pages modelled on 亿星: per-warehouse balances, other in/out and transfers, stock ledger, stocktakes, inspections.
 */
(() => {
  const { esc, money, get, post, put, toast, modal, tableHtml, tag, can, route, setTitle, confirmBox, optHtml, options, readForm } = ERP;

  /**
   * 物料明细编辑表（入库/出库/调拨共用）/ Item-line editor shared by in/out/transfer modals.
   * @param {object[]} items 物料选项 / inventory options
   * @param {boolean} withCost 是否填单位成本 / include unit cost
   * @returns {string}
   */
  const linesHtml = (items, withCost) => `<table class="lines"><thead><tr><th>物料</th><th>数量</th>${withCost ? '<th>单位成本¥（空=沿用）</th>' : ''}<th></th></tr></thead><tbody data-lines>
    ${[0, 1, 2].map(() => `<tr><td><select data-k="inventory_id">${optHtml(items, '')}</select></td><td><input type="number" step="any" data-k="qty" style="width:100px"></td>
    ${withCost ? '<td><input type="number" step="any" data-k="unit_cost" style="width:110px"></td>' : ''}<td></td></tr>`).join('')}</tbody></table>`;
  const readLines = (el) => [...el.querySelectorAll('[data-lines] tr')].map((tr) => Object.fromEntries([...tr.querySelectorAll('[data-k]')].map((i) => [i.dataset.k, i.value])))
    .filter((l) => l.inventory_id && Number(l.qty) > 0);

  /**
   * 入库/出库/调拨弹窗 / modal for stock in, out or transfer
   * @param {'in'|'out'|'transfer'} kind
   */
  async function stockModal(kind) {
    const [whs, items] = await Promise.all([get('/api/e/warehouse?size=100&f_use_status=' + encodeURIComponent('启用')), options('inventory', true)]);
    const wopt = whs.rows.map((w) => ({ id: w.id, label: w.name }));
    const title = { in: '其他入库', out: '其他出库', transfer: '库存调拨' }[kind];
    modal({
      title, wide: true,
      body: `<div class="form-grid">${kind === 'transfer'
        ? `<label><span class="req">调出仓库</span><select name="from_id">${optHtml(wopt, '')}</select></label><label><span class="req">调入仓库</span><select name="to_id">${optHtml(wopt, '')}</select></label>`
        : `<label><span class="req">仓库</span><select name="warehouse_id">${optHtml(wopt, wopt[0] && wopt[0].id, false)}</select></label>`}
        <label><span>关联单号</span><input name="ref_no"></label><label class="wide"><span ${kind === 'out' ? 'class="req"' : ''}>${kind === 'out' ? '出库用途（报废/样品领用/退供应商等）' : '备注'}</span><input name="remark"></label></div>
        <div style="margin-top:10px">${linesHtml(items, kind === 'in')}</div><button class="btn small" type="button" data-addline style="margin-top:6px">＋ 增加一行</button>`,
      buttons: [{
        text: '保存', cls: 'primary', onClick: async (m) => {
          const body = { ...readForm(m.el.querySelector('.form-grid')), items: readLines(m.el) };
          const r = await post(`/api/stock/${kind}`, body);
          m.close();
          toast(`${title}完成：${r.move_no}`, 'ok');
          ERP.navigate();
        },
      }],
    }).el.querySelector('[data-addline]').onclick = (e) => {
      const tb = e.target.closest('.modal').querySelector('[data-lines]');
      tb.insertAdjacentHTML('beforeend', tb.lastElementChild.outerHTML);
      tb.lastElementChild.querySelectorAll('input').forEach((i) => { i.value = ''; });
    };
  }

  // ===================== 库存查询（分仓）/ balances =====================
  route(/^\/stock$/, async (_, main) => {
    setTitle('库存查询（分仓库）');
    const d = await get('/api/stock/balances');
    const edit = can('purchase', 'edit');
    await ERP.grid(main, {
      key: 'doc.stock', title: '库存查询（分仓库）', mode: 'client', rows: d.rows, module: 'purchase',
      toolbar: edit ? '<button class="btn primary" type="button" id="sIn">其他入库</button><button class="btn" type="button" id="sOut">其他出库</button><button class="btn" type="button" id="sTr">调拨</button>' : '',
      headHtml: '<div class="alert info"><span>所有库存变化（期初、采购入库、领料出库、其他出入库、调拨、盘盈盘亏、档案中直接修改）都记入“出入库明细”，各仓库数量由流水汇总。</span></div>',
      columns: [
        { key: 'code', label: '物料编码' }, { key: 'name', label: '名称' }, { key: 'category', label: '类别' }, { key: 'unit', label: '单位' },
        ...d.warehouses.map((w) => ({ key: 'w' + w.id, label: w.name, num: true, text: (r) => r.by[w.id] || 0, html: (r) => (r.by[w.id] ? String(r.by[w.id]) : '<span class="muted">0</span>') })),
        { key: 'qty', label: '合计', num: true, html: (r) => `<b>${r.qty}</b>${r.safety_qty && r.qty < r.safety_qty ? ' <span class="tag danger">缺料</span>' : ''}` },
        { key: 'unit_cost', label: '单位成本¥', num: true }, { key: 'amount', label: '库存金额¥', num: true, html: (r) => money(r.amount) }, { key: 'default_warehouse', label: '默认仓库' },
      ],
      tree: [{ key: 'category', label: '类别' }, { key: 'default_warehouse', label: '默认仓库' }, { key: 'alert', label: '库存状态', text: (r) => (r.safety_qty && r.qty < r.safety_qty ? '缺料' : r.qty > 0 ? '有库存' : '零库存') }],
      schemes: [['category'], ['alert'], ['default_warehouse', 'category']],
      quick: [{ key: 'code', label: '物料编码' }, { key: 'name', label: '名称' }],
    });
    if (edit) {
      main.querySelector('#sIn').onclick = () => stockModal('in').catch((e) => toast(e.message, 'error'));
      main.querySelector('#sOut').onclick = () => stockModal('out').catch((e) => toast(e.message, 'error'));
      main.querySelector('#sTr').onclick = () => stockModal('transfer').catch((e) => toast(e.message, 'error'));
    }
  });

  // ===================== 出入库明细 / stock ledger =====================
  route(/^\/stock-moves$/, async (_, main) => {
    setTitle('出入库明细');
    const { rows } = await get('/api/stock/moves');
    await ERP.grid(main, {
      key: 'doc.stockmoves', title: '出入库明细（库存流水）', mode: 'client', rows, module: 'purchase',
      columns: [
        { key: 'created_at', label: '时间' }, { key: 'type', label: '类型', html: (m) => `<span class="tag ${m.qty > 0 ? 'ok' : 'warn'}">${esc(m.type)}</span>` }, { key: 'move_no', label: '单号' },
        { key: 'warehouse_name', label: '仓库' }, { key: 'code', label: '物料编码' }, { key: 'name', label: '名称' },
        { key: 'qty', label: '数量（+入 −出）', num: true }, { key: 'unit', label: '单位' }, { key: 'unit_cost', label: '单位成本¥', num: true }, { key: 'amount', label: '金额¥', num: true, html: (m) => money(m.amount) },
        { key: 'ref_no', label: '关联单号' }, { key: 'remark', label: '备注' }, { key: 'user_name', label: '操作人' },
      ],
      tree: [{ key: 'type', label: '类型' }, { key: 'warehouse_name', label: '仓库' }, { key: 'name', label: '物料' }, { key: 'month', label: '月份', text: (m) => String(m.created_at || '').slice(0, 7) }],
      schemes: [['type'], ['warehouse_name', 'type'], ['month', 'type'], ['name']],
      quick: [{ key: 'code', label: '物料编码' }, { key: 'move_no', label: '单号' }, { key: 'ref_no', label: '关联单号' }],
    });
  });

  // ===================== 盘点 / stocktakes =====================
  route(/^\/stocktakes$/, async (_, main) => {
    setTitle('库存盘点');
    const { rows } = await get('/api/stocktakes');
    await ERP.grid(main, {
      key: 'doc.stocktakes', title: '库存盘点', mode: 'client', rows, module: 'purchase',
      toolbar: can('purchase', 'edit') ? '<button class="btn primary" type="button" id="newSt">＋ 新建盘点单</button>' : '',
      headHtml: '<div class="alert info"><span>新建盘点单会列出该仓库的物料与账面数量；录入实盘数量后由财务（审核权限）确认，系统自动生成盘盈/盘亏并调整库存。</span></div>',
      columns: [
        { key: 'st_no', label: '盘点单', html: (s) => `<a href="#/stocktake/${s.id}">${esc(s.st_no)}</a>` }, { key: 'warehouse_name', label: '仓库' }, { key: 'item_count', label: '物料数', num: true },
        { key: 'counted', label: '已录入', num: true }, { key: 'status', label: '状态', html: (s) => tag(s.status === '已完成' ? '已完成' : s.status === '已作废' ? '已失效' : '待处理') },
        { key: 'user_name', label: '创建人' }, { key: 'created_at', label: '创建时间' }, { key: 'done_at', label: '完成时间' },
      ],
      tree: [{ key: 'status', label: '状态' }, { key: 'warehouse_name', label: '仓库' }], schemes: [['status'], ['warehouse_name']],
      quick: [{ key: 'st_no', label: '盘点单' }],
    });
    const nb = main.querySelector('#newSt');
    if (nb) {
      nb.onclick = async () => {
        const whs = (await get('/api/e/warehouse?size=100')).rows.filter((w) => w.use_status !== '停用').map((w) => ({ id: w.id, label: w.name }));
        modal({
          title: '新建盘点单', body: `<div class="form-grid"><label><span class="req">仓库</span><select name="warehouse_id">${optHtml(whs, '')}</select></label><label><span>备注</span><input name="remark" placeholder="如：月末盘点"></label></div>`,
          buttons: [{ text: '生成盘点表', cls: 'primary', onClick: async (m) => { const r = await post('/api/stocktakes', readForm(m.el)); m.close(); location.hash = '#/stocktake/' + r.id; } }],
        });
      };
    }
  });

  route(/^\/stocktake\/(\d+)$/, async ([id], main) => {
    const st = await get('/api/stocktakes/' + id);
    setTitle('盘点单 ' + st.st_no);
    const open = st.status === '盘点中';
    const edit = open && can('purchase', 'edit');
    main.innerHTML = `<div class="panel"><div class="panel-head"><h2>${esc(st.st_no)} ${tag(st.status === '已完成' ? '已完成' : st.status === '已作废' ? '已失效' : '待处理')}</h2><div class="toolbar">
        ${edit ? '<button class="btn" type="button" id="stSave">保存实盘数</button><button class="btn small" type="button" id="stFill">未录入的按账面填</button>' : ''}
        ${open && can('purchase', 'audit') ? '<button class="btn primary" type="button" id="stOk">确认盘点结果</button>' : ''}${edit ? '<button class="btn danger" type="button" id="stVoid">作废</button>' : ''}<a class="btn" href="#/stocktakes">返回</a></div></div>
      <div class="kv"><div><b>仓库</b><span>${esc(st.warehouse_name)}</span></div><div><b>创建</b><span>${esc(st.user_name)} ${esc(st.created_at)}</span></div><div><b>备注</b><span>${esc(st.remark)}</span></div>
        ${st.done_at ? `<div><b>结束</b><span>${esc(st.done_at)}</span></div>` : ''}</div>
      ${open ? '<p class="muted small">账面数量为当前实时余额；确认时按“实盘 − 账面”生成盘盈/盘亏。</p>' : ''}
      ${tableHtml(['物料编码', '名称', '单位', '账面数量', '实盘数量', '差异', '差异金额¥', '说明'], st.items.map((t) => [esc(t.code), esc(t.name), esc(t.unit), t.book_qty,
    edit ? `<input type="number" step="any" style="width:100px" data-act="${t.id}" value="${t.actual_qty ?? ''}">` : (t.actual_qty ?? ''),
    t.diff === null ? '' : `<span class="${t.diff > 0 ? 'tag ok' : t.diff < 0 ? 'tag danger' : ''}">${t.diff > 0 ? '+' : ''}${t.diff}</span>`,
    t.diff ? money(t.diff * t.unit_cost) : '', edit ? `<input style="width:140px" data-rmk="${t.id}" value="${esc(t.remark)}">` : esc(t.remark)]), new Set([3, 4, 5, 6]))}</div>`;
    const collect = () => st.items.map((t) => ({ id: t.id, actual_qty: main.querySelector(`[data-act="${t.id}"]`).value, remark: main.querySelector(`[data-rmk="${t.id}"]`).value }));
    const sv = main.querySelector('#stSave');
    if (sv) sv.onclick = async () => { try { await put('/api/stocktakes/' + id, { items: collect() }); toast('已保存', 'ok'); ERP.navigate(); } catch (e) { toast(e.message, 'error'); } };
    const fl = main.querySelector('#stFill');
    if (fl) fl.onclick = () => st.items.forEach((t) => { const el = main.querySelector(`[data-act="${t.id}"]`); if (el.value === '') el.value = t.book_qty; });
    const ok = main.querySelector('#stOk');
    if (ok) {
      ok.onclick = async () => {
        if (!(await confirmBox('确认盘点结果？将按差异生成盘盈/盘亏并调整库存，确认后不能修改。'))) return;
        try { if (edit) await put('/api/stocktakes/' + id, { items: collect() }); await post(`/api/stocktakes/${id}/confirm`); toast('盘点已确认', 'ok'); ERP.navigate(); } catch (e) { toast(e.message, 'error'); }
      };
    }
    const vd = main.querySelector('#stVoid');
    if (vd) vd.onclick = async () => { if (await confirmBox('作废该盘点单？')) { try { await post(`/api/stocktakes/${id}/void`); ERP.navigate(); } catch (e) { toast(e.message, 'error'); } } };
  });

  // ===================== 验货单 / inspections =====================
  route(/^\/inspections$/, async (_, main) => {
    setTitle('验货管理');
    const { rows } = await get('/api/inspections');
    await ERP.grid(main, {
      key: 'doc.inspections', title: '验货管理', mode: 'client', rows, module: 'order',
      toolbar: can('order', 'edit') ? '<a class="btn primary" href="#/inspection/new">＋ 新建验货单</a>' : '',
      headHtml: '<div class="alert info"><span>关联出货单的验货单，结果为“合格/不合格”时自动更新出货单的验货状态（验货合格才能报关出运）。</span></div>',
      columns: [
        { key: 'insp_no', label: '验货单', html: (v) => `<a href="#/inspection/${v.id}">${esc(v.insp_no)}</a>` }, { key: 'type', label: '类型' }, { key: 'inspect_date', label: '验货日期' },
        { key: 'order_no', label: '订单', html: (v) => `<a href="#/order/${v.order_id}">${esc(v.order_no)}</a>` }, { key: 'ship_no', label: '出货单' }, { key: 'customer_name', label: '客户' },
        { key: 'salesman_name', label: '业务员' }, { key: 'inspector', label: '验货员/机构' }, { key: 'aql', label: 'AQL' }, { key: 'lot_qty', label: '批量', num: true }, { key: 'sample_size', label: '抽样', num: true },
        { key: 'critical', label: '致命', num: true }, { key: 'major', label: '严重', num: true }, { key: 'minor', label: '轻微', num: true }, { key: 'result', label: '结果', html: (v) => tag(v.result) },
      ],
      tree: [{ key: 'result', label: '结果' }, { key: 'type', label: '类型' }, { key: 'customer_name', label: '客户' }, { key: 'inspector', label: '验货员/机构' }, { key: 'month', label: '月份', text: (v) => String(v.inspect_date || '').slice(0, 7) }],
      schemes: [['result'], ['customer_name'], ['type', 'result'], ['month']],
      quick: [{ key: 'insp_no', label: '验货单' }, { key: 'order_no', label: '订单' }, { key: 'customer_name', label: '客户' }],
    });
  });

  route(/^\/inspection\/(new|\d+)$/, async ([id], main, qs) => {
    const isNew = id === 'new';
    const v = isNew ? { type: '出货验货', aql: 'II/2.5', result: '待验货', inspect_date: new Date().toLocaleDateString('sv-SE'), order_id: qs.get('order_id') || '', shipment_id: qs.get('shipment_id') || '', items: [] } : await get('/api/inspections/' + id);
    setTitle(isNew ? '新建验货单' : '验货单 ' + v.insp_no);
    const edit = can('order', 'edit');
    const dis = edit ? '' : 'disabled';
    const orders = (await get('/api/orders')).rows.map((o) => ({ id: o.id, label: `${o.order_no} ${o.customer_name}` }));
    const order = v.order_id ? await get('/api/orders/' + v.order_id).catch(() => null) : null;
    const ships = order ? order.shipments.filter((s) => s.status !== '已取消').map((s) => ({ id: s.id, label: `${s.ship_no}（${s.status}/${s.inspection_status}）` })) : [];
    const itemVal = (oi, k) => { const it = v.items.find((x) => x.order_item_id === oi.id); return it ? it[k] ?? '' : ''; };
    main.innerHTML = `<div class="panel"><div class="panel-head"><h2>${isNew ? '新建验货单' : esc(v.insp_no)} ${isNew ? '' : tag(v.result)}</h2>
        <div class="toolbar">${edit ? '<button class="btn primary" type="button" id="vSave">保存</button>' : ''}<a class="btn" href="#/inspections">返回</a></div></div>
      <form class="form-grid" id="vf">
        <label><span class="req">订单</span><select name="order_id" ${isNew ? '' : 'disabled'}>${optHtml(orders, v.order_id)}</select></label>
        <label><span>出货单（选了会同步验货状态）</span><select name="shipment_id" ${dis}>${optHtml(ships, v.shipment_id)}</select></label>
        <label><span>验货类型</span><select name="type" ${dis}>${optHtml(['产前验货', '中期验货', '尾期验货', '出货验货', '复验'], v.type, false)}</select></label>
        <label><span>验货日期</span><input type="date" name="inspect_date" value="${esc(v.inspect_date)}" ${dis}></label>
        <label><span>验货员/机构</span><input name="inspector" value="${esc(v.inspector)}" placeholder="如：客户QC / SGS / 本公司QC" ${dis}></label>
        <label><span>AQL 水平</span><input name="aql" value="${esc(v.aql)}" placeholder="II/2.5" ${dis}></label>
        <label><span>批量</span><input type="number" name="lot_qty" value="${esc(v.lot_qty)}" ${dis}></label><label><span>抽样数</span><input type="number" name="sample_size" value="${esc(v.sample_size)}" ${dis}></label>
        <label><span>致命缺陷</span><input type="number" name="critical" value="${esc(v.critical ?? 0)}" ${dis}></label><label><span>严重缺陷</span><input type="number" name="major" value="${esc(v.major ?? 0)}" ${dis}></label>
        <label><span>轻微缺陷</span><input type="number" name="minor" value="${esc(v.minor ?? 0)}" ${dis}></label>
        <label><span class="req">结果</span><select name="result" ${dis}>${optHtml(['待验货', '合格', '不合格', '待复验'], v.result, false)}</select></label>
        <label class="wide"><span>问题描述与整改要求（不合格必填）</span><textarea name="defects" rows="3" ${dis}>${esc(v.defects)}</textarea></label>
        <label class="wide"><span>备注</span><input name="remark" value="${esc(v.remark)}" ${dis}></label></form>
      ${order ? `<h4 class="mig-sub">按货号验货</h4>${tableHtml(['货号', '描述', '订单数', '抽检数', '不良数', '结果'], order.items.map((oi) => [esc(oi.item_no), esc(oi.description), oi.qty,
    `<input type="number" style="width:90px" data-ck="${oi.id}" value="${esc(itemVal(oi, 'check_qty'))}" ${dis}>`, `<input type="number" style="width:90px" data-df="${oi.id}" value="${esc(itemVal(oi, 'defect_qty'))}" ${dis}>`,
    `<select data-rs="${oi.id}" ${dis}>${optHtml(['', '合格', '不合格'], itemVal(oi, 'result'), false)}</select>`]))}` : '<p class="muted small">选择订单后可按货号录入抽检结果。</p>'}</div>`;
    const f = main.querySelector('#vf');
    if (isNew) f.order_id.onchange = () => { location.hash = `#/inspection/new?order_id=${f.order_id.value}`; };
    const sb = main.querySelector('#vSave');
    if (sb) {
      sb.onclick = async () => {
        const body = readForm(f);
        if (!isNew) delete body.order_id;
        if (order) {
          body.items = order.items.map((oi) => ({ order_item_id: oi.id, check_qty: main.querySelector(`[data-ck="${oi.id}"]`).value, defect_qty: main.querySelector(`[data-df="${oi.id}"]`).value, result: main.querySelector(`[data-rs="${oi.id}"]`).value }))
            .filter((x) => x.check_qty || x.defect_qty || x.result);
        }
        try {
          const r = isNew ? await post('/api/inspections', body) : await put('/api/inspections/' + id, body);
          toast(r.shipment_id && ['合格', '不合格'].includes(r.result) ? `已保存，出货单验货状态已更新为“${r.result}”` : '已保存', 'ok');
          if (isNew) location.hash = '#/inspection/' + r.id; else ERP.navigate();
        } catch (e) { toast(e.message, 'error'); }
      };
    }
  });
})();
