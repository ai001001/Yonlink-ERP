'use strict';
/**
 * 订单与出货路由（含订单变更强制风控联动）
 * Order & shipment routes, including the mandatory change-risk control workflow.
 * @module server/routes/orders
 */
const { HttpError } = require('../http');
const { need, can, log, nextNo, tx, num, round, required, assertSampleUsable, assertSampleShippable, today, setting } = require('../core');
const { docScope, filterItemsForDesigner, syncItems } = require('./sales');

/** 订单头关键字段 / Key header fields watched by risk control */
const HEADER_KEYS = { delivery_date: '交期', package_req: '包装要求', craft: '工艺要求' };
/** 订单明细关键字段 / Key item fields watched by risk control */
const ITEM_KEYS = { qty: '数量', craft: '工艺', spec: '规格', package: '包装', package_plan_id: '包装方案' };

/** 订单概要/合同条款/唛头字段（非风控关键字段）/ order summary, contract-term and shipping-mark fields (not risk-controlled) */
const SUMMARY_FIELDS = ['po_no', 'pay_terms', 'deposit_rate', 'port_loading', 'port_dest', 'transport', 'partial_shipment', 'transshipment', 'insurance',
  'pi_no', 'sign_place', 'contract_terms', 'factory_terms', 'front_mark', 'side_mark', 'inner_mark'];

/**
 * 订单加减项合计（加为正、减为负）/ Net of order additions (+) and deductions (−).
 * @param {object} db
 * @param {number} orderId
 * @returns {number}
 */
function chargesTotal(db, orderId) {
  return round(db.prepare("SELECT COALESCE(SUM(CASE WHEN kind='减' THEN -amount ELSE amount END),0) v FROM order_charges WHERE order_id=?").get(orderId).v);
}

/**
 * 新订单从客户档案带出默认资料（付款方式、目的港、默认唛头）/ Defaults for a new order taken from the customer record.
 * @param {object} db
 * @param {number} customerId
 * @returns {object}
 */
function customerDefaults(db, customerId) {
  const c = db.prepare('SELECT pay_terms, dest_port FROM customers WHERE id=?').get(customerId) || {};
  const m = db.prepare("SELECT front_mark, side_mark, inner_mark FROM customer_marks WHERE customer_id=? ORDER BY is_default='是' DESC, id LIMIT 1").get(customerId) || {};
  return { pay_terms: c.pay_terms || null, port_dest: c.dest_port || null, front_mark: m.front_mark || null, side_mark: m.side_mark || null, inner_mark: m.inner_mark || null };
}

/** 部门 → 处理权限 / department → permission needed to handle a change task */
const DEPT_PERM = { 采购: ['purchase', 'edit'], 生产: ['production', 'edit'], 财务: ['receivable', 'edit'], 业务: ['order', 'edit'] };

/**
 * 评估订单变更风险等级 / Evaluate the change-risk level of an order.
 * @param {object} db
 * @param {number} orderId
 * @returns {{level:string, purchases:object[], productions:object[], reasons:string[]}}
 */
function evaluateRisk(db, orderId) {
  const purchases = db.prepare(`SELECT p.id, p.po_no, p.status, p.type, s.name supplier_name,
      (SELECT COALESCE(SUM(qty*price),0) FROM purchase_items WHERE po_id=p.id) amount,
      (SELECT COALESCE(SUM(received_qty),0) FROM purchase_items WHERE po_id=p.id) received_qty,
      (SELECT COALESCE(SUM(amount),0) FROM payments WHERE po_id=p.id AND status='已付款') paid
    FROM purchases p LEFT JOIN suppliers s ON s.id=p.supplier_id WHERE p.order_id=?`).all(orderId);
  // worked：任一工序已报工；reported：包装完成的成品数 / worked = any process reported; reported = finished (packed) goods
  const productions = db.prepare(`SELECT p.id, p.prod_no, p.item_no, p.plan_qty, p.status,
      (SELECT COALESCE(SUM(good_qty),0) FROM production_reports r WHERE r.production_id=p.id) worked,
      (SELECT COALESCE(SUM(good_qty),0) FROM production_reports r WHERE r.production_id=p.id AND r.process='包装') reported
    FROM productions p WHERE p.order_id=?`).all(orderId);
  const reasons = [];
  for (const p of purchases) {
    if (p.received_qty > 0) reasons.push(`采购单${p.po_no}已入库${p.received_qty}`);
    if (p.paid > 0) reasons.push(`采购单${p.po_no}已付款¥${round(p.paid)}`);
  }
  for (const p of productions) if (p.worked > 0) reasons.push(`布产单${p.prod_no}已开工，已完工良品${p.reported}`);
  let level = '无';
  if (reasons.length) level = '高';
  else if (purchases.length || productions.length) {
    level = '中';
    if (purchases.length) reasons.push(`已下采购单${purchases.length}张（未入库未付款）`);
    if (productions.length) reasons.push(`已布产${productions.length}张（未报工）`);
  }
  return { level, purchases, productions, reasons };
}

/**
 * 读取订单详情 / Load an order with items, changes, shipments and linked data.
 * @param {object} ctx
 * @param {number|string} id
 * @returns {object}
 */
function getOrder(ctx, id) {
  const { db } = ctx;
  const sc = docScope(ctx, 'o', 'order_items', 'order_id');
  const o = db.prepare(`SELECT o.*, c.name customer_name, c.country, e.name salesman_name, q.quote_no FROM orders o LEFT JOIN customers c ON c.id=o.customer_id
    LEFT JOIN employees e ON e.id=o.salesman_id LEFT JOIN quotes q ON q.id=o.quote_id WHERE o.id=?${sc.sql ? ' AND ' + sc.sql : ''}`).get(id, ...sc.params);
  if (!o) throw new HttpError(404, '订单不存在或无权查看');
  o.items = filterItemsForDesigner(ctx, db.prepare(`SELECT i.*, s.name sample_name, s.designer_id, s.status sample_status, d.name designer_name,
      (SELECT name FROM sample_packages WHERE id=i.package_plan_id) package_plan_name,
      (SELECT COALESCE(SUM(si.qty),0) FROM shipment_items si JOIN shipments sh ON sh.id=si.shipment_id WHERE si.order_item_id=i.id AND sh.status<>'已取消') shipped_qty,
      (SELECT COALESCE(SUM(si.qty),0) FROM shipment_items si JOIN shipments sh ON sh.id=si.shipment_id WHERE si.order_item_id=i.id AND sh.status='已出运') departed_qty,
      (SELECT COALESCE(SUM(r.good_qty),0) FROM production_reports r JOIN productions p ON p.id=r.production_id WHERE p.order_item_id=i.id AND r.process='包装') produced_qty
    FROM order_items i LEFT JOIN samples s ON s.id=i.sample_id LEFT JOIN employees d ON d.id=s.designer_id WHERE i.order_id=? ORDER BY i.id`).all(o.id));
  // 货款 = Σ数量×单价；合同总额 = 货款 + 加减项（应收、收款、开票均以合同总额为准）
  // goods = Σ qty × price; contract total = goods + charges (basis for receivables, receipts and invoices)
  o.goods_amount = round(o.items.reduce((s, i) => s + num(i.qty) * num(i.unit_price), 0));
  if (ctx.user.scope === 'designer') { o.amount = o.goods_amount; return o; }
  o.charges = db.prepare('SELECT * FROM order_charges WHERE order_id=? ORDER BY id').all(o.id);
  o.charges_amount = chargesTotal(db, o.id);
  o.amount = round(o.goods_amount + o.charges_amount);
  o.changes = db.prepare('SELECT * FROM order_changes WHERE order_id=? ORDER BY id DESC').all(o.id);
  for (const c of o.changes) {
    c.diff = JSON.parse(c.diff || '[]');
    c.risk_detail = JSON.parse(c.risk_detail || '{}');
    c.tasks = db.prepare('SELECT * FROM change_tasks WHERE change_id=? ORDER BY id').all(c.id);
  }
  o.shipments = db.prepare(`SELECT s.*, a.name forwarder_name, iv.invoice_no FROM shipments s LEFT JOIN agencies a ON a.id=s.forwarder_id LEFT JOIN ship_invoices iv ON iv.id=s.invoice_id WHERE s.order_id=? ORDER BY s.id`).all(o.id);
  for (const s of o.shipments) {
    s.items = db.prepare('SELECT si.*, oi.item_no, oi.description FROM shipment_items si JOIN order_items oi ON oi.id=si.order_item_id WHERE si.shipment_id=?').all(s.id);
  }
  const risk = evaluateRisk(db, o.id);
  o.risk = { level: risk.level, reasons: risk.reasons };
  o.purchases = risk.purchases;
  o.productions = risk.productions;
  const rec = db.prepare('SELECT COALESCE(SUM(amount),0) received FROM receipts WHERE order_id=?').get(o.id);
  const inv = db.prepare('SELECT COALESCE(SUM(amount),0) invoiced FROM sales_invoices WHERE order_id=?').get(o.id);
  o.received = round(rec.received);
  o.invoiced = round(inv.invoiced);
  o.cost = orderCost(db, o);
  o.estimate = orderEstimate(db, o);
  return o;
}

/**
 * 订单效益测算（预估）：按报价单的报价基准或样品成本估算成本，扣除客户佣金
 * Order profit estimate: cost from the source quote's cost base (or sample cost), minus customer commission.
 * @param {object} db
 * @param {object} o 订单（含明细、合同总额、汇率）/ order with items, total and rate
 * @returns {object}
 */
function orderEstimate(db, o) {
  const fromQuote = new Map();
  if (o.quote_id) {
    const q = db.prepare('SELECT * FROM quotes WHERE id=?').get(o.quote_id);
    if (q) {
      const qi = db.prepare(`SELECT i.*, s.pcs_per_carton, s.cbm, s.outer_l, s.outer_w, s.outer_h FROM quote_items i LEFT JOIN samples s ON s.id=i.sample_id WHERE i.quote_id=? ORDER BY i.id`).all(q.id);
      const { priceQuote } = require('./sales');
      priceQuote(q, qi, false).items.forEach((i) => {
        fromQuote.set(i.item_no, i.unit_cost);
        if (i.new_item_no) fromQuote.set(i.new_item_no, i.unit_cost);
      });
    }
  }
  const lines = o.items.map((i) => {
    const s = db.prepare('SELECT factory_price, material_cost, labor_cost FROM samples WHERE id=?').get(i.sample_id) || {};
    const fromSample = num(s.factory_price) > 0 ? num(s.factory_price) : num(s.material_cost) + num(s.labor_cost);
    const unit = fromQuote.has(i.item_no) ? fromQuote.get(i.item_no) : fromSample;
    return { item_no: i.item_no, qty: i.qty, unit_cost: round(unit, 4), source: fromQuote.has(i.item_no) ? '报价基准' : (num(s.factory_price) > 0 ? '样品工厂报价' : '样品材料+人工'), cost: round(unit * num(i.qty)) };
  });
  const revenue = round(num(o.amount) * num(o.rate));
  const cost = round(lines.reduce((a, l) => a + l.cost, 0));
  const c = db.prepare('SELECT commission_rate FROM customers WHERE id=?').get(o.customer_id) || {};
  const commission = round(revenue * num(c.commission_rate) / 100);
  const profit = round(revenue - cost - commission);
  return { revenue_cny: revenue, cost, commission, commission_rate: num(c.commission_rate), profit, profit_rate: revenue > 0 ? round(profit / revenue * 100, 2) : null, lines };
}

/**
 * 订单料工费成本核算 / Order cost accounting (materials, purchases, profit).
 * @param {object} db
 * @param {object} o 订单（含 amount、rate）/ order with amount & rate
 * @returns {object}
 */
function orderCost(db, o) {
  const purchase = db.prepare('SELECT COALESCE(SUM(pi.qty*pi.price),0) v FROM purchase_items pi JOIN purchases p ON p.id=pi.po_id WHERE p.order_id=?').get(o.id).v;
  const material = db.prepare('SELECT COALESCE(SUM(qty*unit_cost),0) v FROM material_issues WHERE order_id=?').get(o.id).v;
  const revenue = round(num(o.amount) * num(o.rate));
  const fx = db.prepare('SELECT COALESCE(SUM(fx_gain),0) v FROM receipts WHERE order_id=?').get(o.id).v;
  return { revenue_cny: revenue, purchase_cost: round(purchase), material_cost: round(material), fx_gain: round(fx), profit: round(revenue - purchase - material + fx) };
}

/**
 * 计算订单变更差异 / Compute the change diff between old and new order data.
 * @param {object} old 原订单 / old order
 * @param {object} header 新订单头 / new header
 * @param {object[]} items 新明细 / new items
 * @returns {{field:string, item_no?:string, before:any, after:any, key:boolean}[]}
 */
function diffOrder(old, header, items) {
  const diff = [];
  for (const [k, label] of Object.entries(HEADER_KEYS)) {
    if (header[k] !== undefined && String(header[k] ?? '') !== String(old[k] ?? '')) diff.push({ field: label, before: old[k], after: header[k], key: true });
  }
  const oldById = new Map(old.items.map((i) => [i.id, i]));
  const seen = new Set();
  for (const it of items) {
    const prev = it.id ? oldById.get(Number(it.id)) : null;
    if (!prev) { diff.push({ field: '新增产品', item_no: it.item_no, before: '', after: `${it.item_no} × ${it.qty}`, key: true }); continue; }
    seen.add(prev.id);
    if (Number(it.sample_id) !== prev.sample_id) diff.push({ field: '货号', item_no: prev.item_no, before: prev.item_no, after: it.item_no, key: true });
    for (const [k, label] of Object.entries(ITEM_KEYS)) {
      const a = k === 'qty' ? num(it[k]) : String(it[k] ?? '');
      const b = k === 'qty' ? num(prev[k]) : String(prev[k] ?? '');
      if (a !== b) diff.push({ field: label, item_no: prev.item_no, before: prev[k], after: it[k], key: true });
    }
    if (num(it.unit_price) !== num(prev.unit_price)) diff.push({ field: '单价', item_no: prev.item_no, before: prev.unit_price, after: it.unit_price, key: false });
  }
  for (const prev of old.items) if (!seen.has(prev.id)) diff.push({ field: '删除产品', item_no: prev.item_no, before: `${prev.item_no} × ${prev.qty}`, after: '', key: true });
  return diff;
}

/**
 * 保存订单（修改时执行变更风控）/ Save an order; updates run the change-risk control.
 * @param {object} ctx
 * @param {number|string} [id]
 * @returns {object}
 */
function saveOrder(ctx, id) {
  const { db } = ctx;
  const b = ctx.body;
  required(b, { customer_id: '客户', currency: '币种', delivery_date: '交期' });
  const items = Array.isArray(b.items) ? b.items : [];
  if (!items.length) throw new HttpError(400, '请至少添加一个订单产品');
  let old = null;
  if (id) {
    if (ctx.user.scope === 'designer') throw new HttpError(403, '设计师无权修改订单');
    old = getOrder(ctx, id);
    if (ctx.user.scope === 'own' && old.salesman_id !== ctx.user.employee_id) throw new HttpError(403, '只能修改本人订单');
    if (['已出货', '已完成'].includes(old.status)) throw new HttpError(409, `订单${old.status}，不允许修改`);
    if (old.risk_lock) throw new HttpError(423, '订单存在未完成的变更联动修正任务，已被风控锁定。请采购/生产/财务/业务各部门处理完毕后再修改');
  }
  const cur = db.prepare('SELECT * FROM currencies WHERE code=?').get(b.currency);
  if (!cur) throw new HttpError(400, '币种不存在');
  const header = {
    customer_id: Number(b.customer_id), currency: b.currency, term: b.term || 'FOB', rate: num(b.rate) || cur.rate,
    order_date: b.order_date || (old ? old.order_date : today()), delivery_date: b.delivery_date, package_req: b.package_req || '', craft: b.craft || '',
    invoice_due_days: num(b.invoice_due_days) || 30, remark: b.remark || '',
  };
  const defs = old ? {} : customerDefaults(db, header.customer_id);
  for (const k of SUMMARY_FIELDS) {
    let v = b[k] !== undefined ? b[k] : (old ? old[k] : defs[k]);
    if (v === '' || v === undefined) v = null;
    if (k === 'deposit_rate' && v !== null) {
      v = num(v);
      if (v < 0 || v > 100) throw new HttpError(400, '预收订金比率应在 0～100% 之间');
    }
    header[k] = v;
  }
  const rows = items.map((it) => {
    const prev = old && old.items.find((x) => x.id === Number(it.id));
    const s = prev && prev.sample_id === Number(it.sample_id) ? db.prepare('SELECT * FROM samples WHERE id=?').get(prev.sample_id) : assertSampleUsable(db, Number(it.sample_id), '下单');
    if (!(num(it.qty) > 0)) throw new HttpError(400, `货号 ${s.company_no} 数量必须大于0`);
    if (prev && num(it.qty) < num(prev.shipped_qty)) throw new HttpError(409, `货号 ${s.company_no} 已出货${prev.shipped_qty}，数量不能小于已出货数量`);
    // 包装方案：未提交时保留原值；必须属于该样品 / package plan: kept when omitted, must belong to the sample
    let planId = it.package_plan_id !== undefined ? (it.package_plan_id === '' || it.package_plan_id === null ? null : Number(it.package_plan_id)) : (prev && prev.sample_id === s.id ? prev.package_plan_id : null);
    let plan = null;
    if (planId) {
      plan = db.prepare('SELECT * FROM sample_packages WHERE id=? AND sample_id=?').get(planId, s.id);
      if (!plan) throw new HttpError(400, `货号 ${s.company_no} 的包装方案无效`);
    }
    // 新增行或换了方案且包装栏为空时，用方案说明填充；其余情况保持原逻辑，避免产生无关的“包装”变更
    // fill from the plan only for new lines or a changed plan with a blank package text
    const planText = plan ? [plan.name, plan.package_req].filter(Boolean).join('：') : '';
    const planChanged = !prev || (prev.package_plan_id || null) !== planId;
    const pkgText = plan && planChanged && !String(it.package ?? '').trim() ? planText : (it.package ?? (plan ? planText : s.package_req) ?? '');
    return { id: prev ? prev.id : undefined, sample_id: s.id, item_no: s.company_no, description: it.description || s.name, qty: num(it.qty), unit_price: num(it.unit_price),
      craft: it.craft ?? s.craft ?? '', spec: it.spec ?? '', package: pkgText, package_plan_id: planId };
  });
  if (!old) {
    return tx(db, () => {
      const no = nextNo(db, 'SO', 'orders', 'order_no');
      const hc = Object.keys(header);
      const rr = db.prepare(`INSERT INTO orders(order_no,salesman_id,status,${hc.join(',')}) VALUES(?,?,'待确认',${hc.map(() => '?').join(',')})`)
        .run(no, b.salesman_id && ctx.user.scope !== 'own' ? Number(b.salesman_id) : ctx.user.employee_id, ...hc.map((c) => header[c]));
      const oid = Number(rr.lastInsertRowid);
      syncItems(db, 'order_items', 'order_id', oid, rows, ['sample_id', 'item_no', 'description', 'qty', 'unit_price', 'craft', 'spec', 'package', 'package_plan_id']);
      log(ctx, 'order', '新增订单', no);
      return getOrder(ctx, oid);
    });
  }
  // ---- 变更风控 / change-risk control ----
  const diff = diffOrder(old, header, rows);
  const keyDiff = diff.filter((d) => d.key);
  const risk = evaluateRisk(db, old.id);
  const needConfirm = keyDiff.length > 0 && risk.level !== '无';
  if (needConfirm && !b.confirm_risk) {
    throw new HttpError(409, `订单变更风险提醒（风险等级：${risk.level}）`, {
      risk: true, level: risk.level, reasons: risk.reasons, diff,
      purchases: risk.purchases, productions: risk.productions,
      notice: '确认变更后，系统将锁定本订单的出货/新增采购/新增布产，并强制向采购、生产、财务、业务部门派发联动修正任务，全部处理完毕后解锁。',
    });
  }
  if (needConfirm && !String(b.change_reason || '').trim()) throw new HttpError(400, '高风险变更必须填写变更原因（客户变更依据）');
  return tx(db, () => {
    const hc = Object.keys(header);
    db.prepare(`UPDATE orders SET ${hc.map((c) => `${c}=?`).join(',')} WHERE id=?`).run(...hc.map((c) => header[c]), old.id);
    syncItems(db, 'order_items', 'order_id', old.id, rows, ['sample_id', 'item_no', 'description', 'qty', 'unit_price', 'craft', 'spec', 'package', 'package_plan_id'], (e) => {
      const used = db.prepare('SELECT (SELECT COUNT(*) FROM shipment_items WHERE order_item_id=?) + (SELECT COUNT(*) FROM productions WHERE order_item_id=?) c').get(e.id, e.id).c;
      if (used) throw new HttpError(409, `货号 ${e.item_no} 已有出货/布产记录，不能删除，请改为调整数量`);
    });
    if (diff.length) {
      const changeNo = nextNo(db, 'CH', 'order_changes', 'change_no');
      const newAmount = round(rows.reduce((s, i) => s + i.qty * i.unit_price, 0) + chargesTotal(db, old.id));
      const summary = diff.map((d) => `${d.item_no ? d.item_no + ' ' : ''}${d.field}: ${d.before ?? ''}→${d.after ?? ''}`).join('；');
      const rc = db.prepare('INSERT INTO order_changes(change_no,order_id,diff,reason,risk_level,risk_detail,status,user_name) VALUES(?,?,?,?,?,?,?,?)')
        .run(changeNo, old.id, JSON.stringify(diff), b.change_reason || '', needConfirm ? risk.level : '无',
          JSON.stringify({ reasons: risk.reasons, old_amount: old.amount, new_amount: newAmount }), needConfirm ? '待联动修正' : '已记录', ctx.user.name);
      const cid = Number(rc.lastInsertRowid);
      if (needConfirm) {
        const addTask = (dept, content) => db.prepare('INSERT INTO change_tasks(change_id,order_id,dept,content) VALUES(?,?,?,?)').run(cid, old.id, dept, content);
        if (risk.purchases.length) {
          addTask('采购', `订单${old.order_no}变更【${summary}】。关联采购单：${risk.purchases.map((p) => `${p.po_no}(${p.status}，已入库${p.received_qty}，已付¥${round(p.paid)})`).join('、')}。请核对冗余/短缺物料，处理追加采购、退货、转库存或转他单。`);
        }
        if (risk.productions.length) {
          addTask('生产', `订单${old.order_no}变更【${summary}】。关联布产单：${risk.productions.map((p) => `${p.prod_no}(计划${p.plan_qty}，已完工${p.reported})`).join('、')}。请调整布产计划与工序安排。`);
        }
        addTask('财务', `订单${old.order_no}变更，订单金额 ${old.amount} → ${newAmount} ${header.currency}。请更新成本核算、应收与开票计划。`);
        addTask('业务', `订单${old.order_no}变更【${summary}】。请与客户书面确认变更内容并归档确认依据。`);
        db.prepare('UPDATE orders SET risk_lock=1 WHERE id=?').run(old.id);
      }
      log(ctx, 'order', needConfirm ? `订单高风险变更(${risk.level})` : '订单变更', old.order_no, summary);
    } else {
      log(ctx, 'order', '修改订单', old.order_no);
    }
    return getOrder(ctx, old.id);
  });
}

/**
 * 断言订单未被风控锁定 / Assert the order is not risk-locked.
 * @param {object} db
 * @param {number} orderId
 * @param {string} action 被阻止的动作 / blocked action
 */
function assertNotLocked(db, orderId, action) {
  const o = db.prepare('SELECT order_no, risk_lock FROM orders WHERE id=?').get(orderId);
  if (!o) throw new HttpError(404, '订单不存在');
  if (o.risk_lock) throw new HttpError(423, `订单${o.order_no}存在未完成的变更联动修正任务，已锁定，暂不能${action}`);
}

/**
 * 根据出货情况刷新订单状态 / Refresh order status from shipments.
 * @param {object} db
 * @param {number} orderId
 */
function refreshOrderStatus(db, orderId) {
  const items = db.prepare(`SELECT i.qty, (SELECT COALESCE(SUM(si.qty),0) FROM shipment_items si JOIN shipments s ON s.id=si.shipment_id WHERE si.order_item_id=i.id AND s.status='已出运') shipped
    FROM order_items i WHERE i.order_id=?`).all(orderId);
  const total = items.reduce((s, i) => s + i.qty, 0);
  const shipped = items.reduce((s, i) => s + i.shipped, 0);
  const o = db.prepare('SELECT status FROM orders WHERE id=?').get(orderId);
  if (o.status === '已完成') return;
  if (shipped > 0 && shipped >= total) db.prepare("UPDATE orders SET status='已出货' WHERE id=?").run(orderId);
  else if (shipped > 0) db.prepare("UPDATE orders SET status='部分出货' WHERE id=?").run(orderId);
}

/**
 * 注册订单出货路由 / Register order routes.
 * @param {import('../http').Router} r
 */
function register(r) {
  r.get('/api/orders', (ctx) => {
    need(ctx, 'order', 'view');
    const where = [];
    const params = [];
    const sc = docScope(ctx, 'o', 'order_items', 'order_id');
    if (sc.sql) { where.push(sc.sql); params.push(...sc.params); }
    if (ctx.query.q) { where.push('(o.order_no LIKE ? OR c.name LIKE ? OR EXISTS (SELECT 1 FROM order_items i WHERE i.order_id=o.id AND i.item_no LIKE ?))'); params.push(...Array(3).fill(`%${ctx.query.q}%`)); }
    if (ctx.query.status) { where.push('o.status=?'); params.push(ctx.query.status); }
    return { rows: ctx.db.prepare(`SELECT o.*, c.name customer_name, c.country, e.name salesman_name,
      ROUND((SELECT COALESCE(SUM(qty*unit_price),0) FROM order_items WHERE order_id=o.id)
        + (SELECT COALESCE(SUM(CASE WHEN kind='减' THEN -amount ELSE amount END),0) FROM order_charges WHERE order_id=o.id),2) amount,
      o.po_no,
      (SELECT group_concat(item_no, '、') FROM order_items WHERE order_id=o.id) item_nos,
      (SELECT COUNT(*) FROM change_tasks t WHERE t.order_id=o.id AND t.status='待处理') pending_tasks
      FROM orders o LEFT JOIN customers c ON c.id=o.customer_id LEFT JOIN employees e ON e.id=o.salesman_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY o.id DESC LIMIT 500`).all(...params) };
  });
  r.get('/api/orders/:id', (ctx) => { need(ctx, 'order', 'view'); return getOrder(ctx, ctx.params.id); });
  r.post('/api/orders', (ctx) => { need(ctx, 'order', 'add'); return saveOrder(ctx); });
  r.put('/api/orders/:id', (ctx) => { need(ctx, 'order', 'edit'); return saveOrder(ctx, ctx.params.id); });
  r.get('/api/orders/:id/risk', (ctx) => {
    need(ctx, 'order', 'view');
    const o = getOrder(ctx, ctx.params.id);
    return evaluateRisk(ctx.db, o.id);
  });
  // ---- 加减项（亿星“加减项”：模具费、样品费、折扣、佣金扣减等）/ order additions & deductions ----
  r.post('/api/orders/:id/charges', (ctx) => {
    need(ctx, 'order', 'edit');
    const o = getOrder(ctx, ctx.params.id);
    if (ctx.user.scope === 'designer') throw new HttpError(403, '设计师无权修改订单');
    if (o.status === '已完成') throw new HttpError(409, '订单已完成，不能再登记加减项');
    const b = ctx.body;
    required(b, { kind: '加/减', name: '费用名称', amount: '金额' });
    if (!['加', '减'].includes(b.kind)) throw new HttpError(400, '类型只能是“加”或“减”');
    const amount = round(num(b.amount));
    if (!(amount > 0)) throw new HttpError(400, '金额必须大于0');
    const newTotal = round(o.amount + (b.kind === '减' ? -amount : amount));
    if (newTotal < o.received - 0.005) throw new HttpError(409, `扣减后合同总额 ${newTotal} 将低于已收款 ${o.received}，不能登记`);
    if (newTotal < o.invoiced - 0.005) throw new HttpError(409, `扣减后合同总额 ${newTotal} 将低于已开票 ${o.invoiced}，不能登记`);
    if (newTotal < 0) throw new HttpError(409, '扣减后合同总额不能为负数');
    const rr = ctx.db.prepare('INSERT INTO order_charges(order_id,kind,name,amount,remark,user_name) VALUES(?,?,?,?,?,?)').run(o.id, b.kind, String(b.name).slice(0, 100), amount, b.remark || '', ctx.user.name);
    log(ctx, 'order', `订单${b.kind}项`, o.order_no, `${b.name} ${amount} ${o.currency}，合同总额 ${o.amount} → ${newTotal}`);
    return { id: Number(rr.lastInsertRowid), amount: newTotal };
  });
  r.del('/api/orders/:id/charges/:cid', (ctx) => {
    need(ctx, 'order', 'edit');
    const o = getOrder(ctx, ctx.params.id);
    if (ctx.user.scope === 'designer') throw new HttpError(403, '设计师无权修改订单');
    if (o.status === '已完成') throw new HttpError(409, '订单已完成，不能删除加减项');
    const c = ctx.db.prepare('SELECT * FROM order_charges WHERE id=? AND order_id=?').get(ctx.params.cid, o.id);
    if (!c) throw new HttpError(404, '加减项不存在');
    const newTotal = round(o.amount - (c.kind === '减' ? -c.amount : c.amount));
    if (newTotal < o.received - 0.005 || newTotal < o.invoiced - 0.005) throw new HttpError(409, `删除后合同总额 ${newTotal} 将低于已收款/已开票金额，不能删除`);
    ctx.db.prepare('DELETE FROM order_charges WHERE id=?').run(c.id);
    log(ctx, 'order', `删除订单${c.kind}项`, o.order_no, `${c.name} ${c.amount}`);
    return { ok: true, amount: newTotal };
  });

  // ---- 复制为新订单（历史翻单）/ copy as a new order (repeat order) ----
  r.post('/api/orders/:id/copy', (ctx) => {
    need(ctx, 'order', 'add');
    if (ctx.user.scope === 'designer') throw new HttpError(403, '设计师无权新建订单');
    const o = getOrder(ctx, ctx.params.id);
    const items = o.items.map((i) => {
      let sid = i.sample_id;
      if (i.sample_status === '已锁定') {
        const ns = ctx.db.prepare("SELECT id FROM samples WHERE parent_no=? AND status<>'已锁定' ORDER BY id DESC").get(i.item_no);
        if (!ns) throw new HttpError(409, `货号 ${i.item_no} 已锁定且没有可用的新货号，无法翻单`);
        sid = ns.id;
      }
      return { sample_id: sid, description: i.description, qty: i.qty, unit_price: i.unit_price, craft: i.craft, spec: i.spec, package: i.package, package_plan_id: sid === i.sample_id ? i.package_plan_id : null };
    });
    const body = {
      customer_id: o.customer_id, currency: o.currency, term: o.term, delivery_date: ctx.body.delivery_date || today(60), package_req: o.package_req, craft: o.craft,
      invoice_due_days: o.invoice_due_days, remark: `翻单自 ${o.order_no}${o.remark ? '；' + o.remark : ''}`, items,
      ...Object.fromEntries(SUMMARY_FIELDS.filter((k) => k !== 'po_no' && k !== 'pi_no').map((k) => [k, o[k]])),
    };
    const n = saveOrder({ ...ctx, body });
    log(ctx, 'order', '翻单（复制订单）', n.order_no, `来源 ${o.order_no}`);
    return n;
  });

  r.post('/api/orders/:id/status', (ctx) => {
    need(ctx, 'order', 'edit');
    const o = getOrder(ctx, ctx.params.id);
    const to = ctx.body.status;
    const flow = { 生产中: ['待确认'], 已完成: ['已出货'], 待出货: ['待确认', '生产中'] };
    if (!flow[to]) throw new HttpError(400, '不支持的状态');
    if (!flow[to].includes(o.status)) throw new HttpError(409, `当前状态【${o.status}】不能变更为【${to}】`);
    if (to === '已完成') {
      const wo = ctx.db.prepare('SELECT COALESCE(SUM(amount),0) v FROM ar_writeoffs WHERE order_id=?').get(o.id).v;
      if (o.received + wo + 0.001 < o.amount) throw new HttpError(409, `订单尚未收齐货款（应收${o.amount}，已收${o.received}${wo ? `，销账${round(wo)}` : ''}），不能完结`);
    }
    ctx.db.prepare('UPDATE orders SET status=? WHERE id=?').run(to, o.id);
    log(ctx, 'order', `订单状态→${to}`, o.order_no);
    return { ok: true };
  });

  // ---- 变更联动任务处理 / change task handling ----
  r.get('/api/change-tasks', (ctx) => {
    const rows = ctx.db.prepare(`SELECT t.*, o.order_no, c.change_no, c.reason, c.risk_level FROM change_tasks t JOIN orders o ON o.id=t.order_id JOIN order_changes c ON c.id=t.change_id
      ${ctx.query.status ? 'WHERE t.status=?' : ''} ORDER BY t.id DESC LIMIT 500`).all(...(ctx.query.status ? [ctx.query.status] : []));
    return { rows: rows.filter((t) => can(ctx.user, ...DEPT_PERM[t.dept])) };
  });
  r.post('/api/change-tasks/:id/handle', (ctx) => {
    const t = ctx.db.prepare('SELECT * FROM change_tasks WHERE id=?').get(ctx.params.id);
    if (!t) throw new HttpError(404, '任务不存在');
    const [m, a] = DEPT_PERM[t.dept];
    if (!can(ctx.user, m, a)) throw new HttpError(403, `该任务需由【${t.dept}】部门处理`);
    if (t.status !== '待处理') throw new HttpError(409, '任务已处理');
    if (!String(ctx.body.note || '').trim()) throw new HttpError(400, '请填写处理结果说明');
    const done = tx(ctx.db, () => {
      ctx.db.prepare("UPDATE change_tasks SET status='已处理', handler=?, handle_note=?, handled_at=datetime('now','localtime') WHERE id=?").run(ctx.user.name, ctx.body.note, t.id);
      const left = ctx.db.prepare("SELECT COUNT(*) c FROM change_tasks WHERE change_id=? AND status='待处理'").get(t.change_id).c;
      if (!left) {
        ctx.db.prepare("UPDATE order_changes SET status='已完成' WHERE id=?").run(t.change_id);
        const pending = ctx.db.prepare("SELECT COUNT(*) c FROM change_tasks WHERE order_id=? AND status='待处理'").get(t.order_id).c;
        if (!pending) ctx.db.prepare('UPDATE orders SET risk_lock=0 WHERE id=?').run(t.order_id);
      }
      return !left;
    });
    const o = ctx.db.prepare('SELECT order_no FROM orders WHERE id=?').get(t.order_id);
    log(ctx, 'order', `处理变更联动任务(${t.dept})`, o.order_no, ctx.body.note);
    return { ok: true, change_completed: done };
  });

  // ---- 出货 / shipments ----
  r.get('/api/shipments', (ctx) => {
    need(ctx, 'order', 'view');
    const sc = docScope(ctx, 'o', 'order_items', 'order_id');
    return { rows: ctx.db.prepare(`SELECT s.*, o.order_no, c.name customer_name, c.country, a.name forwarder_name, (SELECT invoice_no FROM ship_invoices WHERE id=s.invoice_id) invoice_no,
      (SELECT SUM(qty) FROM shipment_items WHERE shipment_id=s.id) qty, (SELECT ROUND(SUM(cbm),3) FROM shipment_items WHERE shipment_id=s.id) cbm
      FROM shipments s JOIN orders o ON o.id=s.order_id LEFT JOIN customers c ON c.id=o.customer_id LEFT JOIN agencies a ON a.id=s.forwarder_id
      ${sc.sql ? 'WHERE ' + sc.sql : ''} ORDER BY s.id DESC`).all(...sc.params) };
  });
  r.post('/api/orders/:id/shipments', (ctx) => {
    need(ctx, 'order', 'edit');
    const o = getOrder(ctx, ctx.params.id);
    return tx(ctx.db, () => createShipment(ctx, o, ctx.body));
  });
  r.put('/api/shipments/:id', (ctx) => {
    need(ctx, 'order', 'edit');
    const s = ctx.db.prepare('SELECT * FROM shipments WHERE id=?').get(ctx.params.id);
    if (!s) throw new HttpError(404, '出货单不存在');
    getOrder(ctx, s.order_id);
    return tx(ctx.db, () => updateShipment(ctx, s, ctx.body));
  });
}

/**
 * 新建出货单（按订单）：校验风控锁定、货号可出货、剩余数量，自动算箱数/体积/毛净重
 * Create a shipment for one order: lock, shippability and remaining-qty checks; cartons, CBM and weights computed.
 * 调用方负责事务 / caller wraps in a transaction
 * @param {object} ctx
 * @param {object} o 订单（getOrder 结果）/ order from getOrder
 * @param {object} b 出货信息与明细 {items:[{order_item_id, qty, cartons, container_no}], ...} / shipment data
 * @returns {{id:number, ship_no:string}}
 */
function createShipment(ctx, o, b) {
  assertNotLocked(ctx.db, o.id, '安排出货');
  const items = (b.items || []).filter((x) => num(x.qty) > 0);
  if (!items.length) throw new HttpError(400, '请填写出货数量');
  const rows = items.map((x) => {
    const oi = o.items.find((i) => i.id === Number(x.order_item_id));
    if (!oi) throw new HttpError(400, '订单明细不存在');
    assertSampleShippable(ctx.db, oi.sample_id, o);
    if (num(x.qty) > oi.qty - oi.shipped_qty) throw new HttpError(409, `货号${oi.item_no}可出货数量仅剩${oi.qty - oi.shipped_qty}`);
    const s0 = ctx.db.prepare('SELECT * FROM samples WHERE id=?').get(oi.sample_id);
    // 订单选了包装方案时按方案的装箱数、箱规、毛净重计算 / use the chosen package plan when present
    const plan = oi.package_plan_id ? ctx.db.prepare('SELECT * FROM sample_packages WHERE id=?').get(oi.package_plan_id) : null;
    const s = plan ? { ...s0, pcs_per_carton: plan.outer_qty, outer_l: plan.outer_l, outer_w: plan.outer_w, outer_h: plan.outer_h, cbm: plan.cbm, gross_weight: plan.gw, net_weight: plan.nw } : s0;
    const cartons = num(x.cartons) || (s.pcs_per_carton ? Math.ceil(num(x.qty) / s.pcs_per_carton) : 0);
    const cbm = s.outer_l ? round(cartons * s.outer_l * s.outer_w * s.outer_h / 1e6, 3) : (num(s.cbm) ? round(cartons * num(s.cbm), 3) : 0);
    return { order_item_id: oi.id, qty: num(x.qty), cartons, cbm, gw: round(cartons * num(s.gross_weight), 2), nw: round(cartons * num(s.net_weight), 2), container_no: x.container_no || b.container_no || '' };
  });
  const no = nextNo(ctx.db, 'SH', 'shipments', 'ship_no');
  const rr = ctx.db.prepare('INSERT INTO shipments(ship_no,order_id,ship_date,port,dest_port,vessel,container_no,customs_no,forwarder_id,remark,invoice_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(no, o.id, b.ship_date || today(7), b.port || '厦门', b.dest_port || '', b.vessel || '', b.container_no || '', b.customs_no || '', b.forwarder_id || null, b.remark || '', b.invoice_id || null);
  const sid = Number(rr.lastInsertRowid);
  for (const x of rows) {
    ctx.db.prepare('INSERT INTO shipment_items(shipment_id,order_item_id,qty,cartons,cbm,gw,nw,container_no) VALUES(?,?,?,?,?,?,?,?)').run(sid, x.order_item_id, x.qty, x.cartons, x.cbm, x.gw, x.nw, x.container_no);
  }
  log(ctx, 'order', '新增出货计划', no, o.order_no);
  return { id: sid, ship_no: no };
}

/**
 * 更新出货单（验货闭环：验货合格才能报关/出运，出运需报关单号）/ Update a shipment with the inspection gate.
 * 调用方负责事务 / caller wraps in a transaction
 * @param {object} ctx
 * @param {object} s 出货单 / shipment row
 * @param {object} b 更新内容 / changes
 * @returns {object}
 */
function updateShipment(ctx, s, b) {
  if (s.status === '已出运') throw new HttpError(409, `出货单${s.ship_no}已出运，不能修改`);
  if (b.inspection_status && !['待验货', '合格', '不合格'].includes(b.inspection_status)) throw new HttpError(400, '验货状态无效');
  if (b.inspection_status === '不合格' && !b.inspection_note) throw new HttpError(400, '验货不合格请填写问题与整改要求');
  if (b.status && !['计划中', '已报关', '已出运', '已取消'].includes(b.status)) throw new HttpError(400, '出货状态无效');
  const insp = b.inspection_status || s.inspection_status;
  if (['已报关', '已出运'].includes(b.status)) {
    assertNotLocked(ctx.db, s.order_id, '报关出运');
    if (insp !== '合格') throw new HttpError(409, `出货单${s.ship_no}验货合格后才能报关/出运（验货闭环）`);
    if (b.status === '已出运' && !(b.customs_no || s.customs_no)) throw new HttpError(400, '请填写报关单号');
    if (b.status === '已出运' && setting(ctx.db, 'fg_require_out_before_ship', '0') === '1') {
      // 参数开启时：出运前必须完成销售出库 / when enabled, goods must be issued from stock before departure
      const left = ctx.db.prepare(`SELECT si.qty + COALESCE((SELECT SUM(m.qty) FROM stock_moves m WHERE m.shipment_id=si.shipment_id AND m.order_item_id=si.order_item_id AND m.type='销售出库'),0) r
        FROM shipment_items si WHERE si.shipment_id=?`).all(s.id).filter((x) => x.r > 1e-9);
      if (left.length) throw new HttpError(409, `出货单${s.ship_no}尚未完成销售出库，不能出运（系统参数要求先出库）`);
    }
  }
  const fields = ['ship_date', 'port', 'dest_port', 'vessel', 'container_no', 'customs_no', 'forwarder_id', 'status', 'inspection_status', 'inspection_note', 'remark'];
  const set = fields.filter((f) => b[f] !== undefined);
  if (set.length) ctx.db.prepare(`UPDATE shipments SET ${set.map((f) => `${f}=?`).join(',')} WHERE id=?`).run(...set.map((f) => (b[f] === '' ? null : b[f])), s.id);
  if (b.inspection_status && b.inspection_status !== s.inspection_status) {
    const o = ctx.db.prepare('SELECT order_no FROM orders WHERE id=?').get(s.order_id);
    log(ctx, 'order', `验货${b.inspection_status}`, s.ship_no, `${o.order_no} ${b.inspection_note || ''}`);
  }
  refreshOrderStatus(ctx.db, s.order_id);
  log(ctx, 'order', '更新出货单', s.ship_no, b);
  return ctx.db.prepare('SELECT * FROM shipments WHERE id=?').get(s.id);
}

module.exports = { register, getOrder, evaluateRisk, assertNotLocked, orderCost, refreshOrderStatus, customerDefaults, chargesTotal, SUMMARY_FIELDS, createShipment, updateShipment };
