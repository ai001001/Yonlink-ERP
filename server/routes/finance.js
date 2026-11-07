'use strict';
/**
 * 财务、采购、生产路由：应收开票、采购付款进项票、库存领料、布产报工
 * Finance, purchasing and production routes: receivables & invoices, purchases & payments,
 * inventory issues, production planning & reporting.
 * @module server/routes/finance
 */
const { HttpError } = require('../http');
const { need, can, log, nextNo, tx, num, round, required, today } = require('../core');
const { syncItems } = require('./sales');

/** 生产工序顺序 / Production process order */
const PROCESSES = ['制坯', '上釉', '烧制', '彩绘', '包装'];

/**
 * 应收台账（按订单）/ Receivable ledger per order.
 * @param {object} ctx
 * @returns {object[]}
 */
function receivableRows(ctx) {
  const own = ctx.user.scope === 'own' ? 'WHERE o.salesman_id=' + Number(ctx.user.employee_id || -1) : '';
  const rows = ctx.db.prepare(`SELECT o.id, o.order_no, o.currency, o.rate, o.status, o.invoice_due_days, c.name customer_name, c.country, e.name salesman_name,
      ROUND((SELECT COALESCE(SUM(qty*unit_price),0) FROM order_items WHERE order_id=o.id) + (SELECT COALESCE(SUM(CASE WHEN kind='减' THEN -amount ELSE amount END),0) FROM order_charges WHERE order_id=o.id),2) amount,
      (SELECT ROUND(COALESCE(SUM(amount),0),2) FROM receipts WHERE order_id=o.id) received,
      (SELECT ROUND(COALESCE(SUM(amount_cny),0),2) FROM receipts WHERE order_id=o.id) received_cny,
      (SELECT ROUND(COALESCE(SUM(fx_gain),0),2) FROM receipts WHERE order_id=o.id) fx_gain,
      (SELECT ROUND(COALESCE(SUM(amount),0),2) FROM ar_writeoffs WHERE order_id=o.id) written_off,
      (SELECT ROUND(COALESCE(SUM(amount),0),2) FROM sales_invoices WHERE order_id=o.id) invoiced,
      (SELECT MIN(ship_date) FROM shipments WHERE order_id=o.id AND status='已出运') first_ship_date
    FROM orders o LEFT JOIN customers c ON c.id=o.customer_id LEFT JOIN employees e ON e.id=o.salesman_id ${own} ORDER BY o.id DESC`).all();
  const now = new Date(today()).getTime();
  for (const r of rows) {
    // 未收 = 合同总额 − 实收 − 销账 / outstanding = total − received − written off
    r.unreceived = round(r.amount - r.received - r.written_off);
    r.uninvoiced = round(r.amount - r.invoiced);
    r.receive_status = r.received <= 0 && r.written_off <= 0 ? '未收款' : (r.unreceived > 0.005 ? '部分收款' : '已收齐');
    r.overdue_days = 0;
    r.invoice_overdue = false;
    if (r.first_ship_date && r.uninvoiced > 0.005) {
      const days = Math.floor((now - new Date(r.first_ship_date).getTime()) / 86400000);
      r.overdue_days = days - num(r.invoice_due_days);
      r.invoice_overdue = r.overdue_days > 0;
    }
  }
  return rows;
}

/**
 * 登记订单收款（校验未收余额，计算人民币与汇兑损益）/ Record a receipt against an order.
 * @param {object} ctx
 * @param {object} b {order_id, type:'预收'|'尾款'|'分期', amount, rate?, receipt_date?, voucher?, remark?}
 * @returns {{id:number}}
 */
function addReceipt(ctx, b) {
  if (!['预收', '尾款', '分期'].includes(b.type)) throw new HttpError(400, '收款类型无效');
  const o = ctx.db.prepare('SELECT * FROM orders WHERE id=?').get(b.order_id);
  if (!o) throw new HttpError(404, '订单不存在');
  const amount = round(num(b.amount));
  if (amount <= 0) throw new HttpError(400, '收款金额必须大于0');
  const row = receivableRows({ ...ctx, user: { ...ctx.user, scope: 'all' } }).find((x) => x.id === o.id);
  if (amount > row.unreceived + 0.005) throw new HttpError(409, `收款金额超出订单${o.order_no}未收余额（未收 ${row.unreceived} ${o.currency}）`);
  const cur = ctx.db.prepare('SELECT rate FROM currencies WHERE code=?').get(o.currency);
  const rate = num(b.rate) || (cur ? cur.rate : o.rate);
  const rr = ctx.db.prepare('INSERT INTO receipts(order_id,type,amount,currency,rate,amount_cny,fx_gain,receipt_date,voucher,remark) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(o.id, b.type, amount, o.currency, rate, round(amount * rate), round(amount * (rate - num(o.rate))), b.receipt_date || today(), b.voucher || '', b.remark || '');
  log(ctx, 'receivable', `登记${b.type}`, o.order_no, `${amount} ${o.currency} @${rate}${b.voucher ? ' 凭证' + b.voucher : ''}`);
  return { id: Number(rr.lastInsertRowid) };
}

/**
 * 读取采购单 / Load a purchase order with items, payments and invoices.
 * @param {object} ctx
 * @param {number|string} id
 * @returns {object}
 */
function getPurchase(ctx, id) {
  const p = ctx.db.prepare(`SELECT p.*, s.name supplier_name, s.settlement, o.order_no FROM purchases p LEFT JOIN suppliers s ON s.id=p.supplier_id
    LEFT JOIN orders o ON o.id=p.order_id WHERE p.id=?`).get(id);
  if (!p) throw new HttpError(404, '采购单不存在');
  p.items = ctx.db.prepare('SELECT * FROM purchase_items WHERE po_id=? ORDER BY id').all(p.id);
  p.amount = round(p.items.reduce((s, i) => s + num(i.qty) * num(i.price), 0));
  p.payments = ctx.db.prepare('SELECT * FROM payments WHERE po_id=? ORDER BY id').all(p.id);
  p.paid = round(p.payments.filter((x) => x.status === '已付款').reduce((s, x) => s + x.amount, 0));
  p.invoices = ctx.db.prepare('SELECT * FROM purchase_invoices WHERE po_id=? ORDER BY id').all(p.id);
  p.invoiced = round(p.invoices.reduce((s, x) => s + x.amount, 0));
  return p;
}

/**
 * 刷新供应商合格率（按质检结果）/ Refresh supplier pass rate from QC results.
 * @param {object} db
 * @param {number} supplierId
 */
function refreshPassRate(db, supplierId) {
  const r = db.prepare("SELECT SUM(qc_status='合格') ok, SUM(qc_status IN ('合格','不合格')) total FROM purchases WHERE supplier_id=?").get(supplierId);
  if (r.total) db.prepare('UPDATE suppliers SET pass_rate=? WHERE id=?').run(round(r.ok * 100 / r.total, 1), supplierId);
}

/**
 * 布产进度 / Production progress rows.
 * @param {object} db
 * @param {string} [where] 过滤条件 / filter
 * @param {any[]} [params]
 * @returns {object[]}
 */
function productionRows(db, where = '', params = []) {
  const rows = db.prepare(`SELECT p.*, o.order_no, o.risk_lock, c.name customer_name FROM productions p JOIN orders o ON o.id=p.order_id LEFT JOIN customers c ON c.id=o.customer_id
    ${where} ORDER BY p.id DESC`).all(...params);
  for (const p of rows) {
    const sums = db.prepare('SELECT process, SUM(qty) qty, SUM(good_qty) good, SUM(bad_qty) bad FROM production_reports WHERE production_id=? GROUP BY process').all(p.id);
    p.process = Object.fromEntries(PROCESSES.map((k) => [k, sums.find((s) => s.process === k) || { qty: 0, good: 0, bad: 0 }]));
    const packed = p.process['包装'].good || 0;
    p.completion = p.plan_qty ? round(packed * 100 / p.plan_qty, 1) : 0;
    const totalQty = sums.reduce((s, x) => s + (x.qty || 0), 0);
    const totalBad = sums.reduce((s, x) => s + (x.bad || 0), 0);
    p.bad_rate = totalQty ? round(totalBad * 100 / totalQty, 1) : 0;
    p.delayed = p.status !== '已完工' && p.due_date && p.due_date < today();
  }
  return rows;
}

/**
 * 注册财务/采购/生产路由 / Register finance, purchase and production routes.
 * @param {import('../http').Router} r
 */
function register(r) {
  // ---------- 应收与销项开票 / receivables & sales invoices ----------
  r.get('/api/receivables', (ctx) => {
    need(ctx, 'receivable', 'view');
    return { rows: receivableRows(ctx) };
  });
  r.get('/api/receivables/:orderId', (ctx) => {
    need(ctx, 'receivable', 'view');
    const row = receivableRows(ctx).find((x) => x.id === Number(ctx.params.orderId));
    if (!row) throw new HttpError(404, '订单不存在或无权查看');
    row.receipts = ctx.db.prepare('SELECT * FROM receipts WHERE order_id=? ORDER BY id').all(row.id);
    row.invoices = ctx.db.prepare('SELECT * FROM sales_invoices WHERE order_id=? ORDER BY id').all(row.id);
    return row;
  });
  r.post('/api/receipts', (ctx) => {
    need(ctx, 'receivable', 'add');
    required(ctx.body, { order_id: '订单', type: '收款类型', amount: '收款金额' });
    return addReceipt(ctx, ctx.body);
  });
  r.post('/api/sales-invoices', (ctx) => {
    need(ctx, 'receivable', 'add');
    const b = ctx.body;
    required(b, { order_id: '订单', invoice_no: '发票号码', amount: '开票金额' });
    const o = ctx.db.prepare('SELECT * FROM orders WHERE id=?').get(b.order_id);
    if (!o) throw new HttpError(404, '订单不存在');
    if (ctx.db.prepare('SELECT 1 FROM sales_invoices WHERE invoice_no=?').get(b.invoice_no)) throw new HttpError(409, `发票号码 ${b.invoice_no} 已登记，禁止重复开票`);
    const row = receivableRows({ ...ctx, user: { ...ctx.user, scope: 'all' } }).find((x) => x.id === o.id);
    if (num(b.amount) <= 0) throw new HttpError(400, '开票金额必须大于0');
    if (num(b.amount) > row.uninvoiced + 0.005) throw new HttpError(409, `开票金额超出未开票余额（未开票 ${row.uninvoiced} ${o.currency}）`);
    const rr = ctx.db.prepare('INSERT INTO sales_invoices(order_id,invoice_no,amount,invoice_date,remark) VALUES(?,?,?,?,?)').run(o.id, b.invoice_no, num(b.amount), b.invoice_date || today(), b.remark || '');
    log(ctx, 'receivable', '登记销项发票', o.order_no, `${b.invoice_no} ${b.amount}`);
    return { id: Number(rr.lastInsertRowid) };
  });
  r.del('/api/sales-invoices/:id', (ctx) => {
    need(ctx, 'receivable', 'delete');
    const inv = ctx.db.prepare('SELECT * FROM sales_invoices WHERE id=?').get(ctx.params.id);
    if (!inv) throw new HttpError(404, '发票不存在');
    ctx.db.prepare('DELETE FROM sales_invoices WHERE id=?').run(inv.id);
    log(ctx, 'receivable', '作废销项发票', inv.invoice_no);
    return { ok: true };
  });

  // ---------- 采购 / purchases ----------
  r.get('/api/purchases', (ctx) => {
    need(ctx, 'purchase', 'view');
    const where = [];
    const params = [];
    if (ctx.query.q) { where.push('(p.po_no LIKE ? OR s.name LIKE ? OR o.order_no LIKE ?)'); params.push(...Array(3).fill(`%${ctx.query.q}%`)); }
    if (ctx.query.order_id) { where.push('p.order_id=?'); params.push(ctx.query.order_id); }
    if (ctx.query.status) { where.push('p.status=?'); params.push(ctx.query.status); }
    return { rows: ctx.db.prepare(`SELECT p.*, s.name supplier_name, o.order_no,
      (SELECT ROUND(COALESCE(SUM(qty*price),0),2) FROM purchase_items WHERE po_id=p.id) amount,
      (SELECT ROUND(COALESCE(SUM(amount),0),2) FROM payments WHERE po_id=p.id AND status='已付款') paid,
      (SELECT ROUND(COALESCE(SUM(amount),0),2) FROM purchase_invoices WHERE po_id=p.id) invoiced
      FROM purchases p LEFT JOIN suppliers s ON s.id=p.supplier_id LEFT JOIN orders o ON o.id=p.order_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY p.id DESC`).all(...params) };
  });
  r.get('/api/purchases/:id', (ctx) => { need(ctx, 'purchase', 'view'); return getPurchase(ctx, ctx.params.id); });
  const savePurchase = (ctx, id) => {
    const b = ctx.body;
    required(b, { supplier_id: '供应商', type: '采购类型' });
    if (!['原辅材料', '外购成品'].includes(b.type)) throw new HttpError(400, '采购类型无效');
    const items = (b.items || []).filter((x) => num(x.qty) > 0);
    if (!items.length) throw new HttpError(400, '请至少添加一条采购明细');
    let old = null;
    if (id) {
      old = getPurchase(ctx, id);
      if (old.status !== '已下单' || old.items.some((i) => i.received_qty > 0) || old.paid > 0) throw new HttpError(409, '采购单已入库或已付款，不能修改明细');
    }
    if (b.order_id) {
      const { assertNotLocked } = require('./orders');
      assertNotLocked(ctx.db, Number(b.order_id), '新增或修改关联采购');
    }
    const rows = items.map((x) => {
      let code = x.code;
      let name = x.name;
      let unit = x.unit;
      if (x.inventory_id) {
        const inv = ctx.db.prepare('SELECT * FROM inventory WHERE id=?').get(x.inventory_id);
        if (!inv) throw new HttpError(400, '物料不存在');
        code = inv.code; name = inv.name; unit = inv.unit;
      }
      if (!code || !name) throw new HttpError(400, '采购明细需选择物料或填写编码/名称');
      if (!(num(x.price) >= 0)) throw new HttpError(400, '单价无效');
      return { id: x.id, inventory_id: x.inventory_id || null, order_item_id: x.order_item_id || null, code, name, unit: unit || '个', qty: num(x.qty), price: num(x.price), received_qty: 0 };
    });
    return tx(ctx.db, () => {
      let pid = id ? Number(id) : null;
      const h = [Number(b.supplier_id), b.order_id ? Number(b.order_id) : null, b.type, b.order_date || today(), b.due_date || today(15), b.remark || ''];
      if (old) ctx.db.prepare('UPDATE purchases SET supplier_id=?, order_id=?, type=?, order_date=?, due_date=?, remark=? WHERE id=?').run(...h, pid);
      else {
        const no = nextNo(ctx.db, 'PO', 'purchases', 'po_no');
        pid = Number(ctx.db.prepare('INSERT INTO purchases(po_no,supplier_id,order_id,type,order_date,due_date,remark) VALUES(?,?,?,?,?,?,?)').run(no, ...h).lastInsertRowid);
      }
      syncItems(ctx.db, 'purchase_items', 'po_id', pid, rows, ['inventory_id', 'order_item_id', 'code', 'name', 'unit', 'qty', 'price', 'received_qty']);
      const p = getPurchase(ctx, pid);
      log(ctx, 'purchase', old ? '修改采购单' : '新增采购单', p.po_no);
      return p;
    });
  };
  r.post('/api/purchases', (ctx) => { need(ctx, 'purchase', 'add'); return savePurchase(ctx); });
  r.put('/api/purchases/:id', (ctx) => { need(ctx, 'purchase', 'edit'); return savePurchase(ctx, ctx.params.id); });
  r.post('/api/purchases/:id/qc', (ctx) => {
    need(ctx, 'purchase', 'edit');
    const p = getPurchase(ctx, ctx.params.id);
    if (!['合格', '不合格'].includes(ctx.body.qc_status)) throw new HttpError(400, '质检结果无效');
    if (ctx.body.qc_status === '不合格' && !ctx.body.note) throw new HttpError(400, '质检不合格请填写问题说明');
    ctx.db.prepare('UPDATE purchases SET qc_status=?, remark=? WHERE id=?').run(ctx.body.qc_status, [p.remark, ctx.body.note ? `质检：${ctx.body.note}` : ''].filter(Boolean).join('；'), p.id);
    refreshPassRate(ctx.db, p.supplier_id);
    log(ctx, 'purchase', `采购质检${ctx.body.qc_status}`, p.po_no, ctx.body.note);
    return getPurchase(ctx, p.id);
  });
  r.post('/api/purchases/:id/receive', (ctx) => {
    need(ctx, 'purchase', 'edit');
    const p = getPurchase(ctx, ctx.params.id);
    if (p.type === '外购成品' && p.qc_status !== '合格') throw new HttpError(409, '外购成品须质检合格后才能入库');
    const lines = (ctx.body.items || []).filter((x) => num(x.qty) > 0);
    if (!lines.length) throw new HttpError(400, '请填写入库数量');
    tx(ctx.db, () => {
      for (const l of lines) {
        const it = p.items.find((i) => i.id === Number(l.id));
        if (!it) throw new HttpError(400, '采购明细不存在');
        if (it.received_qty + num(l.qty) > it.qty + 1e-9) throw new HttpError(409, `${it.name}入库数量超出采购数量（剩余${it.qty - it.received_qty}）`);
        ctx.db.prepare('UPDATE purchase_items SET received_qty=received_qty+? WHERE id=?').run(num(l.qty), it.id);
        let invId = it.inventory_id;
        if (!invId) {
          const ex = ctx.db.prepare('SELECT id FROM inventory WHERE code=?').get(it.code);
          invId = ex ? ex.id : Number(ctx.db.prepare("INSERT INTO inventory(code,name,category,unit,qty,unit_cost) VALUES(?,?,?,?,0,0)").run(it.code, it.name, p.type === '外购成品' ? '外购成品' : '其它', it.unit).lastInsertRowid);
        }
        const inv = ctx.db.prepare('SELECT * FROM inventory WHERE id=?').get(invId);
        const newQty = num(inv.qty) + num(l.qty);
        const avg = newQty > 0 ? round((num(inv.qty) * num(inv.unit_cost) + num(l.qty) * it.price) / newQty, 4) : it.price;
        ctx.db.prepare('UPDATE inventory SET qty=?, unit_cost=? WHERE id=?').run(newQty, avg, invId);
        ctx.db.prepare("INSERT INTO supplier_prices(supplier_id,item_no,price,currency,source,ref_no) VALUES(?,?,?,'CNY','采购入库',?)").run(p.supplier_id, it.code, it.price, p.po_no);
      }
      const after = ctx.db.prepare('SELECT SUM(qty) q, SUM(received_qty) r FROM purchase_items WHERE po_id=?').get(p.id);
      ctx.db.prepare('UPDATE purchases SET status=? WHERE id=?').run(after.r >= after.q - 1e-9 ? '已入库' : '部分入库', p.id);
    });
    log(ctx, 'purchase', '采购入库', p.po_no, lines);
    return getPurchase(ctx, p.id);
  });
  r.post('/api/purchases/:id/payments', (ctx) => {
    need(ctx, 'purchase', 'edit');
    const p = getPurchase(ctx, ctx.params.id);
    const amount = num(ctx.body.amount);
    if (amount <= 0) throw new HttpError(400, '付款金额必须大于0');
    const committed = p.payments.filter((x) => x.status !== '已驳回').reduce((s, x) => s + x.amount, 0);
    if (committed + amount > p.amount + 0.005) throw new HttpError(409, `付款申请超出采购金额（采购 ${p.amount}，已申请/已付 ${round(committed)}）`);
    return tx(ctx.db, () => {
      const id = Number(ctx.db.prepare("INSERT INTO payments(po_id,amount,pay_date,voucher,status,applicant,remark) VALUES(?,?,?,?,'待审批',?,?)")
        .run(p.id, amount, ctx.body.pay_date || today(), ctx.body.voucher || '', ctx.user.name, ctx.body.remark || '').lastInsertRowid);
      ctx.db.prepare("INSERT INTO approvals(target_type,target_id,target_no,title,applicant) VALUES('payment',?,?,?,?)")
        .run(id, p.po_no, `付款申请 ${p.po_no} ${p.supplier_name} ¥${amount}`, ctx.user.name);
      log(ctx, 'purchase', '提交付款申请', p.po_no, amount);
      return { id };
    });
  });
  r.post('/api/purchase-invoices', (ctx) => {
    need(ctx, 'purchase', 'edit');
    required(ctx.body, { po_id: '采购单', invoice_no: '发票号码', amount: '发票金额' });
    const p = getPurchase(ctx, ctx.body.po_id);
    if (ctx.db.prepare('SELECT 1 FROM purchase_invoices WHERE invoice_no=?').get(ctx.body.invoice_no)) throw new HttpError(409, `进项发票 ${ctx.body.invoice_no} 已登记`);
    if (num(ctx.body.amount) <= 0 || p.invoiced + num(ctx.body.amount) > p.amount + 0.005) throw new HttpError(409, `进项发票金额超出采购未开票余额（${round(p.amount - p.invoiced)}）`);
    const id = Number(ctx.db.prepare('INSERT INTO purchase_invoices(po_id,supplier_id,invoice_no,amount,invoice_date,remark) VALUES(?,?,?,?,?,?)')
      .run(p.id, p.supplier_id, ctx.body.invoice_no, num(ctx.body.amount), ctx.body.invoice_date || today(), ctx.body.remark || '').lastInsertRowid);
    log(ctx, 'purchase', '登记进项发票', p.po_no, ctx.body.invoice_no);
    return { id };
  });
  r.post('/api/purchase-invoices/:id/verify', (ctx) => {
    need(ctx, 'purchase', 'audit');
    const inv = ctx.db.prepare('SELECT * FROM purchase_invoices WHERE id=?').get(ctx.params.id);
    if (!inv) throw new HttpError(404, '发票不存在');
    ctx.db.prepare("UPDATE purchase_invoices SET verify_status='已核销' WHERE id=?").run(inv.id);
    log(ctx, 'purchase', '核销进项发票', inv.invoice_no);
    return { ok: true };
  });
  r.get('/api/payables', (ctx) => {
    need(ctx, 'purchase', 'view');
    const rows = ctx.db.prepare(`SELECT s.id, s.code, s.name, s.type, s.settlement,
      (SELECT ROUND(COALESCE(SUM(pi.qty*pi.price),0),2) FROM purchase_items pi JOIN purchases p ON p.id=pi.po_id WHERE p.supplier_id=s.id) amount,
      (SELECT ROUND(COALESCE(SUM(pm.amount),0),2) FROM payments pm JOIN purchases p ON p.id=pm.po_id WHERE p.supplier_id=s.id AND pm.status='已付款') paid,
      (SELECT ROUND(COALESCE(SUM(amount),0),2) FROM purchase_invoices WHERE supplier_id=s.id) invoiced,
      (SELECT ROUND(COALESCE(SUM(amount),0),2) FROM purchase_invoices WHERE supplier_id=s.id AND verify_status='已核销') verified
      FROM suppliers s ORDER BY s.id`).all();
    for (const x of rows) { x.unpaid = round(x.amount - x.paid); x.uninvoiced = round(x.amount - x.invoiced); }
    return { rows: rows.filter((x) => x.amount > 0) };
  });

  // ---------- 领料（按单核算）/ material issues ----------
  r.get('/api/material-issues', (ctx) => {
    if (!can(ctx.user, 'production', 'view') && !can(ctx.user, 'purchase', 'view')) need(ctx, 'production', 'view');
    return { rows: ctx.db.prepare(`SELECT m.*, i.code, i.name, i.unit, o.order_no, p.prod_no, ROUND(m.qty*m.unit_cost,2) amount FROM material_issues m
      JOIN inventory i ON i.id=m.inventory_id LEFT JOIN orders o ON o.id=m.order_id LEFT JOIN productions p ON p.id=m.production_id
      ${ctx.query.order_id ? 'WHERE m.order_id=?' : ''} ORDER BY m.id DESC`).all(...(ctx.query.order_id ? [ctx.query.order_id] : [])) };
  });
  r.post('/api/material-issues', (ctx) => {
    if (!can(ctx.user, 'production', 'edit')) need(ctx, 'purchase', 'edit');
    required(ctx.body, { inventory_id: '物料', order_id: '订单', qty: '数量' });
    const inv = ctx.db.prepare('SELECT * FROM inventory WHERE id=?').get(ctx.body.inventory_id);
    if (!inv) throw new HttpError(404, '物料不存在');
    const qty = num(ctx.body.qty);
    if (qty <= 0) throw new HttpError(400, '领料数量必须大于0');
    if (qty > inv.qty) throw new HttpError(409, `库存不足：${inv.name} 当前库存 ${inv.qty}${inv.unit}`);
    const o = ctx.db.prepare('SELECT * FROM orders WHERE id=?').get(ctx.body.order_id);
    if (!o) throw new HttpError(404, '订单不存在');
    tx(ctx.db, () => {
      ctx.db.prepare('UPDATE inventory SET qty=qty-? WHERE id=?').run(qty, inv.id);
      ctx.db.prepare('INSERT INTO material_issues(inventory_id,order_id,production_id,qty,unit_cost,user_name) VALUES(?,?,?,?,?,?)')
        .run(inv.id, o.id, ctx.body.production_id || null, qty, inv.unit_cost, ctx.user.name);
    });
    log(ctx, 'production', '按单领料', o.order_no, `${inv.code} ${qty}${inv.unit}`);
    return { ok: true };
  });

  // ---------- 生产布产 / production ----------
  r.get('/api/productions', (ctx) => {
    need(ctx, 'production', 'view');
    const where = [];
    const params = [];
    if (ctx.query.order_id) { where.push('p.order_id=?'); params.push(ctx.query.order_id); }
    if (ctx.query.q) { where.push('(p.prod_no LIKE ? OR o.order_no LIKE ? OR p.item_no LIKE ?)'); params.push(...Array(3).fill(`%${ctx.query.q}%`)); }
    return { rows: productionRows(ctx.db, where.length ? 'WHERE ' + where.join(' AND ') : '', params), processes: PROCESSES };
  });
  r.get('/api/productions/:id', (ctx) => {
    need(ctx, 'production', 'view');
    const p = productionRows(ctx.db, 'WHERE p.id=?', [ctx.params.id])[0];
    if (!p) throw new HttpError(404, '布产单不存在');
    p.reports = ctx.db.prepare('SELECT * FROM production_reports WHERE production_id=? ORDER BY id DESC').all(p.id);
    p.issues = ctx.db.prepare('SELECT m.*, i.code, i.name, i.unit FROM material_issues m JOIN inventory i ON i.id=m.inventory_id WHERE m.production_id=?').all(p.id);
    return p;
  });
  r.post('/api/orders/:id/produce', (ctx) => {
    need(ctx, 'production', 'add');
    const { assertNotLocked } = require('./orders');
    const o = ctx.db.prepare('SELECT * FROM orders WHERE id=?').get(ctx.params.id);
    if (!o) throw new HttpError(404, '订单不存在');
    assertNotLocked(ctx.db, o.id, '新增布产');
    if (['已出货', '已完成'].includes(o.status)) throw new HttpError(409, '订单已出货，无需布产');
    const items = ctx.db.prepare(`SELECT i.*, (SELECT COALESCE(SUM(plan_qty),0) FROM productions WHERE order_item_id=i.id) planned FROM order_items i WHERE i.order_id=?`).all(o.id);
    const created = tx(ctx.db, () => {
      const out = [];
      for (const it of items) {
        const left = it.qty - it.planned;
        if (left <= 0) continue;
        const no = nextNo(ctx.db, 'MO', 'productions', 'prod_no');
        ctx.db.prepare("INSERT INTO productions(prod_no,order_id,order_item_id,item_no,plan_qty,start_date,due_date,status) VALUES(?,?,?,?,?,?,?,'生产中')")
          .run(no, o.id, it.id, it.item_no, left, ctx.body.start_date || today(), ctx.body.due_date || o.delivery_date);
        out.push(no);
      }
      if (out.length && o.status === '待确认') ctx.db.prepare("UPDATE orders SET status='生产中' WHERE id=?").run(o.id);
      return out;
    });
    if (!created.length) throw new HttpError(409, '订单所有产品已全部布产');
    log(ctx, 'production', '订单一键布产', o.order_no, created.join('、'));
    return { created };
  });
  r.put('/api/productions/:id', (ctx) => {
    need(ctx, 'production', 'edit');
    const p = ctx.db.prepare('SELECT * FROM productions WHERE id=?').get(ctx.params.id);
    if (!p) throw new HttpError(404, '布产单不存在');
    const plan = ctx.body.plan_qty !== undefined ? num(ctx.body.plan_qty) : p.plan_qty;
    if (plan <= 0) throw new HttpError(400, '计划数量必须大于0');
    ctx.db.prepare('UPDATE productions SET plan_qty=?, due_date=?, remark=? WHERE id=?').run(plan, ctx.body.due_date || p.due_date, ctx.body.remark ?? p.remark, p.id);
    log(ctx, 'production', '调整布产计划', p.prod_no, ctx.body);
    return { ok: true };
  });
  r.post('/api/productions/:id/reports', (ctx) => {
    need(ctx, 'production', 'edit');
    const p = productionRows(ctx.db, 'WHERE p.id=?', [ctx.params.id])[0];
    if (!p) throw new HttpError(404, '布产单不存在');
    const b = ctx.body;
    if (!PROCESSES.includes(b.process)) throw new HttpError(400, '工序无效');
    const good = num(b.good_qty);
    const bad = num(b.bad_qty);
    if (good < 0 || bad < 0 || good + bad <= 0) throw new HttpError(400, '请填写良品数/不良数');
    const idx = PROCESSES.indexOf(b.process);
    const already = p.process[b.process].good || 0;
    if (idx > 0) {
      const prevGood = p.process[PROCESSES[idx - 1]].good || 0;
      if (already + good > prevGood) throw new HttpError(409, `【${b.process}】累计良品(${already + good})不能超过上道工序【${PROCESSES[idx - 1]}】良品(${prevGood})`);
    } else if (already + good > p.plan_qty) {
      throw new HttpError(409, `【制坯】累计良品(${already + good})不能超过计划数量(${p.plan_qty})`);
    }
    tx(ctx.db, () => {
      ctx.db.prepare('INSERT INTO production_reports(production_id,process,report_date,qty,good_qty,bad_qty,worker,remark) VALUES(?,?,?,?,?,?,?,?)')
        .run(p.id, b.process, b.report_date || today(), good + bad, good, bad, b.worker || ctx.user.name, b.remark || '');
      if (b.process === '包装' && already + good >= p.plan_qty) {
        ctx.db.prepare("UPDATE productions SET status='已完工' WHERE id=?").run(p.id);
        const left = ctx.db.prepare("SELECT COUNT(*) c FROM productions WHERE order_id=? AND status<>'已完工'").get(p.order_id).c;
        if (!left) ctx.db.prepare("UPDATE orders SET status='待出货' WHERE id=? AND status IN ('待确认','生产中')").run(p.order_id);
      }
    });
    log(ctx, 'production', `工序报工-${b.process}`, p.prod_no, `良品${good} 不良${bad}`);
    return productionRows(ctx.db, 'WHERE p.id=?', [p.id])[0];
  });
}

module.exports = { register, receivableRows, productionRows, PROCESSES, addReceipt };
