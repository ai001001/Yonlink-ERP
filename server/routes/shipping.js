'use strict';
/**
 * 出货中心（参照亿星“出货管理/出货中心”）：按商业发票出货，一张发票可合并同一客户的多张订单、分多个柜；
 * 装箱明细（柜号、箱数、体积、毛净重）、报关明细（按海关编码汇总）、装运资料，整票报关/出运
 * Shipping centre modelled on 亿星: one commercial invoice may combine several orders of the same customer and several containers;
 * packing list, customs lines grouped by HS code, shipping documents, and invoice-level customs/departure status.
 * @module server/routes/shipping
 */
const { HttpError } = require('../http');
const { need, log, nextNo, tx, num, round, today } = require('../core');
const { getOrder, createShipment, updateShipment } = require('./orders');

/** 发票头可编辑字段 / editable invoice header fields */
const HEADER = ['invoice_date', 'due_date', 'port_loading', 'port_dest', 'transport', 'vessel', 'etd', 'eta', 'bl_no', 'container_nos', 'seal_nos',
  'consignee', 'notify', 'shipping_marks', 'forwarder_id', 'customs_no', 'trade_term', 'remark'];

/**
 * 日期加天数 / Add days to a yyyy-mm-dd date.
 * @param {string} d
 * @param {number} n
 * @returns {string}
 */
function addDays(d, n) {
  const t = new Date((d || today()) + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

/**
 * 数据范围：业务员只看本人客户的发票，设计师无权 / Scope: sales see their customers' invoices; designers have no access.
 * @param {object} ctx
 * @returns {{sql:string, params:any[]}}
 */
function invScope(ctx) {
  if (ctx.user.scope === 'designer') throw new HttpError(403, '设计师无权查看出货发票');
  if (ctx.user.scope === 'own') return { sql: 'i.customer_id IN (SELECT id FROM customers WHERE salesman_id=?)', params: [ctx.user.employee_id || -1] };
  return { sql: '', params: [] };
}

/**
 * 读取出货发票（含出货单、装箱明细、报关明细、合计）/ Load an invoice with shipments, packing lines, customs lines and totals.
 * @param {object} ctx
 * @param {number|string} id
 * @returns {object}
 */
function getInvoice(ctx, id) {
  const { db } = ctx;
  const sc = invScope(ctx);
  const inv = db.prepare(`SELECT i.*, c.name customer_name, c.code customer_code, c.full_name_en, c.address, c.country, a.name forwarder_name FROM ship_invoices i
    LEFT JOIN customers c ON c.id=i.customer_id LEFT JOIN agencies a ON a.id=i.forwarder_id WHERE i.id=?${sc.sql ? ' AND ' + sc.sql : ''}`).get(id, ...sc.params);
  if (!inv) throw new HttpError(404, '出货发票不存在或无权查看');
  inv.shipments = db.prepare(`SELECT s.*, o.order_no, o.po_no, o.currency, o.risk_lock FROM shipments s JOIN orders o ON o.id=s.order_id WHERE s.invoice_id=? ORDER BY s.id`).all(inv.id);
  inv.lines = db.prepare(`SELECT si.*, s.ship_no, s.status ship_status, s.inspection_status, o.order_no, o.po_no, oi.item_no, oi.description, oi.unit_price, oi.sample_id,
      sp.name_en, sp.name sample_name, sp.hs_code, sp.unit, sp.pcs_per_carton, sp.customer_no
    FROM shipment_items si JOIN shipments s ON s.id=si.shipment_id JOIN order_items oi ON oi.id=si.order_item_id JOIN orders o ON o.id=s.order_id
    LEFT JOIN samples sp ON sp.id=oi.sample_id WHERE s.invoice_id=? ORDER BY si.id`).all(inv.id);
  for (const l of inv.lines) l.amount = round(num(l.qty) * num(l.unit_price));
  const sum = (k) => round(inv.lines.reduce((a, l) => a + num(l[k]), 0), 3);
  inv.total = { qty: sum('qty'), cartons: sum('cartons'), cbm: sum('cbm'), gw: sum('gw'), nw: sum('nw'), amount: round(inv.lines.reduce((a, l) => a + l.amount, 0)) };
  // 报关明细：按海关编码+英文品名汇总 / customs lines grouped by HS code and description
  const groups = new Map();
  for (const l of inv.lines) {
    const key = `${l.hs_code || ''}|${l.name_en || l.sample_name || ''}`;
    if (!groups.has(key)) groups.set(key, { hs_code: l.hs_code || '', name: l.name_en || l.sample_name || '', name_cn: l.sample_name || '', unit: l.unit || 'PC', qty: 0, cartons: 0, gw: 0, nw: 0, amount: 0 });
    const g = groups.get(key);
    g.qty += num(l.qty); g.cartons += num(l.cartons); g.gw = round(g.gw + num(l.gw), 2); g.nw = round(g.nw + num(l.nw), 2); g.amount = round(g.amount + l.amount);
  }
  inv.customs = [...groups.values()].map((g) => ({ ...g, unit_price: g.qty ? round(g.amount / g.qty, 4) : 0 }));
  inv.missing_hs = inv.lines.filter((l) => !l.hs_code).map((l) => l.item_no);
  inv.containers = [...new Set(inv.lines.map((l) => l.container_no).filter(Boolean))];
  return inv;
}

/**
 * 把已有出货单与新出货明细挂到发票上 / Attach existing shipments and new lines to an invoice.
 * @param {object} ctx
 * @param {object} inv 发票 / invoice row
 * @param {number[]} shipmentIds 已有出货单 / existing shipments
 * @param {object[]} newLines 新出货明细 [{order_item_id, qty, cartons, container_no}] / new lines
 */
function attach(ctx, inv, shipmentIds, newLines) {
  const { db } = ctx;
  for (const sid of shipmentIds || []) {
    const s = db.prepare('SELECT s.*, o.customer_id, o.currency, o.order_no FROM shipments s JOIN orders o ON o.id=s.order_id WHERE s.id=?').get(Number(sid));
    if (!s) throw new HttpError(404, '出货单不存在');
    getOrder(ctx, s.order_id);
    if (s.customer_id !== inv.customer_id) throw new HttpError(409, `出货单${s.ship_no}（订单${s.order_no}）不属于该客户`);
    if (s.currency !== inv.currency) throw new HttpError(409, `出货单${s.ship_no}币种为${s.currency}，与发票币种${inv.currency}不同`);
    if (s.invoice_id && s.invoice_id !== inv.id) throw new HttpError(409, `出货单${s.ship_no}已开在其它发票中`);
    if (['已出运', '已取消'].includes(s.status)) throw new HttpError(409, `出货单${s.ship_no}${s.status}，不能加入发票`);
    db.prepare('UPDATE shipments SET invoice_id=? WHERE id=?').run(inv.id, s.id);
  }
  // 新明细按订单分组，每张订单生成一张出货单 / new lines grouped by order, one shipment per order
  const byOrder = new Map();
  for (const l of (newLines || []).filter((x) => num(x.qty) > 0)) {
    const oi = db.prepare('SELECT order_id FROM order_items WHERE id=?').get(Number(l.order_item_id));
    if (!oi) throw new HttpError(400, '订单明细不存在');
    if (!byOrder.has(oi.order_id)) byOrder.set(oi.order_id, []);
    byOrder.get(oi.order_id).push(l);
  }
  for (const [oid, lines] of byOrder) {
    const o = getOrder(ctx, oid);
    if (o.customer_id !== inv.customer_id) throw new HttpError(409, `订单${o.order_no}不属于该客户`);
    if (o.currency !== inv.currency) throw new HttpError(409, `订单${o.order_no}币种为${o.currency}，与发票币种${inv.currency}不同`);
    createShipment(ctx, o, {
      items: lines, ship_date: inv.etd || inv.invoice_date, port: inv.port_loading || '厦门', dest_port: inv.port_dest || '', vessel: inv.vessel || '',
      container_no: (inv.container_nos || '').split(/[,，\s]+/)[0] || '', forwarder_id: inv.forwarder_id, invoice_id: inv.id, remark: `发票 ${inv.invoice_no}`,
    });
  }
}

/**
 * 注册出货中心路由 / Register shipping-centre routes.
 * @param {import('../http').Router} r
 */
function register(r) {
  r.get('/api/ship-invoices', (ctx) => {
    need(ctx, 'order', 'view');
    const sc = invScope(ctx);
    const rows = ctx.db.prepare(`SELECT i.*, c.name customer_name, c.country, e.name salesman_name,
        (SELECT COUNT(*) FROM shipments s WHERE s.invoice_id=i.id) ship_count,
        (SELECT group_concat(DISTINCT o.order_no) FROM shipments s JOIN orders o ON o.id=s.order_id WHERE s.invoice_id=i.id) order_nos,
        (SELECT ROUND(COALESCE(SUM(si.qty*oi.unit_price),0),2) FROM shipment_items si JOIN shipments s ON s.id=si.shipment_id JOIN order_items oi ON oi.id=si.order_item_id WHERE s.invoice_id=i.id) amount,
        (SELECT COALESCE(SUM(si.cartons),0) FROM shipment_items si JOIN shipments s ON s.id=si.shipment_id WHERE s.invoice_id=i.id) cartons,
        (SELECT ROUND(COALESCE(SUM(si.cbm),0),3) FROM shipment_items si JOIN shipments s ON s.id=si.shipment_id WHERE s.invoice_id=i.id) cbm
      FROM ship_invoices i LEFT JOIN customers c ON c.id=i.customer_id LEFT JOIN employees e ON e.id=c.salesman_id
      ${sc.sql ? 'WHERE ' + sc.sql : ''} ORDER BY i.id DESC LIMIT 1000`).all(...sc.params);
    return { rows };
  });
  r.get('/api/ship-invoices/:id', (ctx) => { need(ctx, 'order', 'view'); return getInvoice(ctx, ctx.params.id); });

  // 某客户可出货的订单明细与未开票出货单 / shippable order lines and un-invoiced shipments of a customer
  r.get('/api/customers/:id/shippable', (ctx) => {
    need(ctx, 'order', 'view');
    invScope(ctx);
    const own = ctx.user.scope === 'own' ? ' AND o.salesman_id=' + Number(ctx.user.employee_id || -1) : '';
    const lines = ctx.db.prepare(`SELECT oi.id order_item_id, o.id order_id, o.order_no, o.currency, o.risk_lock, o.delivery_date, oi.item_no, oi.description, oi.qty, oi.unit_price,
        (SELECT COALESCE(SUM(si.qty),0) FROM shipment_items si JOIN shipments s ON s.id=si.shipment_id WHERE si.order_item_id=oi.id AND s.status<>'已取消') shipped_qty,
        sp.pcs_per_carton FROM order_items oi JOIN orders o ON o.id=oi.order_id LEFT JOIN samples sp ON sp.id=oi.sample_id
      WHERE o.customer_id=? AND o.status NOT IN ('已出货','已完成')${own} ORDER BY o.id, oi.id`).all(ctx.params.id)
      .filter((l) => l.qty - l.shipped_qty > 0).map((l) => ({ ...l, remain: l.qty - l.shipped_qty }));
    const shipments = ctx.db.prepare(`SELECT s.id, s.ship_no, s.status, s.inspection_status, o.order_no, o.currency,
        (SELECT COALESCE(SUM(qty),0) FROM shipment_items WHERE shipment_id=s.id) qty FROM shipments s JOIN orders o ON o.id=s.order_id
      WHERE o.customer_id=? AND s.invoice_id IS NULL AND s.status NOT IN ('已出运','已取消')${own} ORDER BY s.id`).all(ctx.params.id);
    return { lines, shipments };
  });

  // 新建出货发票 / create an invoice
  r.post('/api/ship-invoices', (ctx) => {
    need(ctx, 'order', 'edit');
    invScope(ctx);
    const b = ctx.body;
    const c = ctx.db.prepare('SELECT * FROM customers WHERE id=?').get(Number(b.customer_id));
    if (!c) throw new HttpError(400, '请选择客户');
    if (ctx.user.scope === 'own' && c.salesman_id !== ctx.user.employee_id) throw new HttpError(404, '客户不存在或无权查看');
    if (!(b.shipment_ids || []).length && !(b.new_lines || []).some((x) => num(x.qty) > 0)) throw new HttpError(400, '请选择要出货的订单明细或已有出货单');
    const no = String(b.invoice_no || '').trim() || nextNo(ctx.db, 'INV', 'ship_invoices', 'invoice_no');
    if (ctx.db.prepare('SELECT 1 FROM ship_invoices WHERE invoice_no=?').get(no)) throw new HttpError(409, `发票号 ${no} 已存在`);
    const invoiceDate = b.invoice_date || today();
    return tx(ctx.db, () => {
      const vals = HEADER.map((k) => (b[k] === '' || b[k] === undefined ? null : b[k]));
      const rr = ctx.db.prepare(`INSERT INTO ship_invoices(invoice_no,customer_id,currency,user_name,${HEADER.join(',')}) VALUES(?,?,?,?,${HEADER.map(() => '?').join(',')})`)
        .run(no, c.id, b.currency || 'USD', ctx.user.name, ...vals);
      const id = Number(rr.lastInsertRowid);
      ctx.db.prepare('UPDATE ship_invoices SET invoice_date=?, due_date=COALESCE(due_date,?), port_dest=COALESCE(port_dest,?) WHERE id=?')
        .run(invoiceDate, addDays(invoiceDate, 30), c.dest_port || null, id);
      const inv = ctx.db.prepare('SELECT * FROM ship_invoices WHERE id=?').get(id);
      attach(ctx, inv, b.shipment_ids, b.new_lines);
      ctx.db.prepare(`UPDATE ship_invoices SET trade_term=COALESCE(trade_term,(SELECT o.term FROM shipments s JOIN orders o ON o.id=s.order_id WHERE s.invoice_id=? LIMIT 1)) WHERE id=?`).run(id, id);
      if (!ctx.db.prepare('SELECT COUNT(*) n FROM shipments WHERE invoice_id=?').get(id).n) throw new HttpError(400, '发票没有任何出货明细');
      log(ctx, 'order', '新建出货发票', no, `${c.name}`);
      return getInvoice(ctx, id);
    });
  });

  // 修改发票头 / update the invoice header
  r.put('/api/ship-invoices/:id', (ctx) => {
    need(ctx, 'order', 'edit');
    const inv = getInvoice(ctx, ctx.params.id);
    if (['已出运', '已作废'].includes(inv.status)) throw new HttpError(409, `发票${inv.status}，不能修改`);
    const b = ctx.body;
    const set = HEADER.filter((k) => b[k] !== undefined);
    if (set.length) ctx.db.prepare(`UPDATE ship_invoices SET ${set.map((k) => `${k}=?`).join(',')} WHERE id=?`).run(...set.map((k) => (b[k] === '' ? null : b[k])), inv.id);
    log(ctx, 'order', '修改出货发票', inv.invoice_no);
    return getInvoice(ctx, inv.id);
  });

  // 追加出货 / add shipments or lines
  r.post('/api/ship-invoices/:id/shipments', (ctx) => {
    need(ctx, 'order', 'edit');
    const inv = getInvoice(ctx, ctx.params.id);
    if (inv.status !== '草稿') throw new HttpError(409, '只有草稿状态的发票可以追加出货');
    return tx(ctx.db, () => {
      attach(ctx, inv, ctx.body.shipment_ids, ctx.body.new_lines);
      log(ctx, 'order', '发票追加出货', inv.invoice_no);
      return getInvoice(ctx, inv.id);
    });
  });

  // 移出出货单（出货单保留，回到“未开票”）/ remove a shipment from the invoice (the shipment itself stays)
  r.del('/api/ship-invoices/:id/shipments/:sid', (ctx) => {
    need(ctx, 'order', 'edit');
    const inv = getInvoice(ctx, ctx.params.id);
    if (inv.status !== '草稿') throw new HttpError(409, '只有草稿状态的发票可以移出出货单');
    const s = inv.shipments.find((x) => x.id === Number(ctx.params.sid));
    if (!s) throw new HttpError(404, '该出货单不在本发票中');
    if (inv.shipments.length === 1) throw new HttpError(409, '发票至少保留一张出货单，如需取消请作废发票');
    ctx.db.prepare('UPDATE shipments SET invoice_id=NULL WHERE id=?').run(s.id);
    log(ctx, 'order', '发票移出出货单', inv.invoice_no, s.ship_no);
    return getInvoice(ctx, inv.id);
  });

  // 装箱：分柜号、箱数、毛净重 / packing: container, cartons, weights
  r.put('/api/ship-invoices/:id/lines/:lid', (ctx) => {
    need(ctx, 'order', 'edit');
    const inv = getInvoice(ctx, ctx.params.id);
    if (['已出运', '已作废'].includes(inv.status)) throw new HttpError(409, `发票${inv.status}，不能修改装箱`);
    const l = inv.lines.find((x) => x.id === Number(ctx.params.lid));
    if (!l) throw new HttpError(404, '装箱明细不存在');
    const b = ctx.body;
    const upd = {};
    if (b.container_no !== undefined) upd.container_no = String(b.container_no || '').trim().toUpperCase() || null;
    for (const k of ['cartons', 'gw', 'nw', 'cbm']) {
      if (b[k] === undefined || b[k] === '') continue;
      const v = Number(b[k]);
      if (!Number.isFinite(v) || v < 0) throw new HttpError(400, `${{ cartons: '箱数', gw: '毛重', nw: '净重', cbm: '体积' }[k]}必须是非负数字`);
      upd[k] = k === 'cartons' ? Math.round(v) : round(v, 3);
    }
    // 与已保存的值合并后校验（分两次修改也能拦住）/ validate against stored values too
    const gw = upd.gw !== undefined ? upd.gw : num(l.gw);
    const nw = upd.nw !== undefined ? upd.nw : num(l.nw);
    if (gw > 0 && nw > gw) throw new HttpError(400, `净重(${nw})不能大于毛重(${gw})`);
    const keys = Object.keys(upd);
    if (keys.length) ctx.db.prepare(`UPDATE shipment_items SET ${keys.map((k) => `${k}=?`).join(',')} WHERE id=?`).run(...keys.map((k) => upd[k]), l.id);
    return getInvoice(ctx, inv.id);
  });

  // 整票报关 / 出运 / 作废 / invoice-level customs, departure, void
  r.post('/api/ship-invoices/:id/status', (ctx) => {
    need(ctx, 'order', 'edit');
    const inv = getInvoice(ctx, ctx.params.id);
    const to = ctx.body.status;
    const flow = { 已报关: ['草稿'], 已出运: ['草稿', '已报关'], 已作废: ['草稿'] };
    if (!flow[to]) throw new HttpError(400, '不支持的状态');
    if (!flow[to].includes(inv.status)) throw new HttpError(409, `当前状态【${inv.status}】不能变更为【${to}】`);
    const customsNo = String(ctx.body.customs_no || inv.customs_no || '').trim();
    return tx(ctx.db, () => {
      if (to === '已作废') {
        ctx.db.prepare('UPDATE shipments SET invoice_id=NULL WHERE invoice_id=?').run(inv.id);
      } else {
        if (!customsNo) throw new HttpError(400, '请填写报关单号');
        if (to === '已出运' && inv.lines.some((l) => !l.container_no) && !inv.container_nos) throw new HttpError(400, '请先在装箱明细中填写柜号（或在装运资料中填写柜号）');
        for (const s of inv.shipments) {
          if (s.status === '已出运') continue;
          updateShipment(ctx, s, {
            status: to, customs_no: customsNo,
            ...(to === '已出运' ? { ship_date: inv.etd || inv.invoice_date, vessel: inv.vessel || s.vessel, dest_port: inv.port_dest || s.dest_port, container_no: s.container_no || (inv.containers[0] || (inv.container_nos || '').split(/[,，\s]+/)[0] || '') } : {}),
          });
        }
      }
      ctx.db.prepare('UPDATE ship_invoices SET status=?, customs_no=COALESCE(?, customs_no) WHERE id=?').run(to, customsNo || null, inv.id);
      log(ctx, 'order', `出货发票${to}`, inv.invoice_no, `出货单${inv.shipments.map((s) => s.ship_no).join('、')}`);
      return getInvoice(ctx, inv.id);
    });
  });
}

module.exports = { register, getInvoice, addDays };
