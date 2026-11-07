'use strict';
/**
 * 应收应付台账与水单（参照亿星“应收管理/应付管理/其他账款”）：
 *  - 应收台账按来源单据生成：预收订金、出货应收（按发票/出货单）、订单加减项、其他应收（样品费、快递费等）
 *  - 收款按到期日先后冲抵，显示账龄；水单登记后由业务员认领到本人订单，自动生成收款；小额差异可销账
 *  - 应付台账按采购单生成，到期日 = 交货期 + 供应商账期
 * AR/AP ledgers and bank slips modelled on 亿星: receivables generated from source documents, receipts applied by due date
 * with ageing; bank slips claimed by sales onto their own orders (creating receipts); small differences written off;
 * payables per purchase order with due date = delivery date + supplier credit days.
 * @module server/routes/ledger
 */
const { HttpError } = require('../http');
const { need, can, log, nextNo, tx, num, round, required, today, setting } = require('../core');
const { receivableRows, addReceipt } = require('./finance');
const { addDays } = require('./shipping');

/** 账龄分段 / ageing buckets */
const BUCKETS = ['未到期', '1-30天', '31-60天', '61-90天', '90天以上'];

/**
 * 逾期天数与账龄段 / Overdue days and ageing bucket.
 * @param {string} due 到期日 / due date
 * @param {number} outstanding 未收/未付 / outstanding
 * @returns {{overdue_days:number, bucket:string}}
 */
function ageing(due, outstanding) {
  if (!(outstanding > 0.005) || !due) return { overdue_days: 0, bucket: outstanding > 0.005 ? '未到期' : '' };
  const days = Math.floor((new Date(today()).getTime() - new Date(due).getTime()) / 86400000);
  const bucket = days <= 0 ? '未到期' : days <= 30 ? '1-30天' : days <= 60 ? '31-60天' : days <= 90 ? '61-90天' : '90天以上';
  return { overdue_days: Math.max(0, days), bucket };
}

/**
 * 应收台账明细 / Receivable ledger entries.
 * 每张订单：预收订金（订金比率×合同总额，下单日到期）+ 出运的出货应收（扣除已列入的订金）+ 加减项；
 * 实收与销账按到期日先后冲抵，多收部分显示为“预收余额”。另加“其他应收”。
 * Per order: deposit + departed shipments (net of the deposit already listed) + charges; receipts and write-offs applied by due date.
 * @param {object} ctx
 * @returns {{entries:object[], advances:object[]}}
 */
function arLedger(ctx) {
  const { db } = ctx;
  const own = ctx.user.scope === 'own' ? Number(ctx.user.employee_id || -1) : null;
  const orders = receivableRows(ctx);
  const entries = [];
  const advances = [];
  for (const r of orders) {
    const o = db.prepare('SELECT order_date, delivery_date, deposit_rate, customer_id, salesman_id FROM orders WHERE id=?').get(r.id);
    const base = { order_id: r.id, order_no: r.order_no, customer_id: o.customer_id, customer_name: r.customer_name, salesman_name: r.salesman_name, currency: r.currency };
    const list = [];
    const deposit = num(o.deposit_rate) > 0 ? round(r.amount * num(o.deposit_rate) / 100) : 0;
    if (deposit > 0) list.push({ ...base, kind: '预收订金', source_no: r.order_no, doc_date: o.order_date, due_date: o.order_date, amount: deposit });
    // 已出运的出货：有发票按发票合并，没有发票按出货单 / departed shipments grouped by invoice (or by shipment)
    const ships = db.prepare(`SELECT COALESCE(iv.invoice_no, s.ship_no) source_no, COALESCE(iv.invoice_date, s.ship_date) doc_date, iv.due_date inv_due,
        ROUND(SUM(si.qty*oi.unit_price),2) amount FROM shipments s JOIN shipment_items si ON si.shipment_id=s.id JOIN order_items oi ON oi.id=si.order_item_id
        LEFT JOIN ship_invoices iv ON iv.id=s.invoice_id WHERE s.order_id=? AND s.status='已出运' GROUP BY COALESCE(iv.invoice_no, s.ship_no) ORDER BY doc_date, source_no`).all(r.id);
    let offset = deposit;
    for (const s of ships) {
      const off = Math.min(offset, s.amount);
      offset = round(offset - off);
      list.push({ ...base, kind: '出货应收', source_no: s.source_no, doc_date: s.doc_date, due_date: s.inv_due || addDays(s.doc_date, 30), amount: round(s.amount - off), gross: s.amount, deposit_offset: round(off) });
    }
    const charges = round(db.prepare("SELECT COALESCE(SUM(CASE WHEN kind='减' THEN -amount ELSE amount END),0) v FROM order_charges WHERE order_id=?").get(r.id).v);
    if (charges > 0) list.push({ ...base, kind: '加减项', source_no: r.order_no, doc_date: o.delivery_date, due_date: o.delivery_date, amount: charges });
    else if (charges < 0) {
      // 净扣减从最后的出货应收（再到订金）中扣除 / net deductions reduce the latest entries
      let left = -charges;
      for (let i = list.length - 1; i >= 0 && left > 0.005; i--) {
        const d = Math.min(left, list[i].amount);
        list[i].amount = round(list[i].amount - d);
        left = round(left - d);
      }
    }
    // 冲抵：实收+销账按到期日先后分配 / apply received + written-off by due date
    let pool = round(r.received + r.written_off);
    list.sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)));
    for (const e of list) {
      const applied = Math.min(pool, e.amount);
      pool = round(pool - applied);
      e.received = round(applied);
      e.outstanding = round(e.amount - applied);
      Object.assign(e, ageing(e.due_date, e.outstanding));
      e.status = e.outstanding <= 0.005 ? '已收' : (e.received > 0 ? '部分收款' : '未收');
      entries.push(e);
    }
    if (pool > 0.005) advances.push({ ...base, advance: pool });
  }
  // 其他应收 / other receivables
  const others = db.prepare(`SELECT a.*, c.name customer_name, e.name salesman_name,
      (SELECT COALESCE(SUM(amount),0) FROM slip_claims WHERE target_type='other' AND target_id=a.id) received
    FROM ar_others a LEFT JOIN customers c ON c.id=a.customer_id LEFT JOIN employees e ON e.id=c.salesman_id
    ${own !== null ? 'WHERE c.salesman_id=' + own : ''} ORDER BY a.id`).all();
  for (const a of others) {
    const outstanding = round(a.amount - a.received);
    entries.push({
      other_id: a.id, customer_id: a.customer_id, customer_name: a.customer_name, salesman_name: a.salesman_name, currency: a.currency, kind: a.kind, source_no: a.other_no,
      order_no: a.source_no || '', doc_date: String(a.created_at).slice(0, 10), due_date: a.due_date, amount: round(a.amount), received: round(a.received), outstanding,
      ...ageing(a.due_date, outstanding), status: outstanding <= 0.005 ? '已收' : (a.received > 0 ? '部分收款' : '未收'), remark: a.remark,
    });
  }
  return { entries, advances };
}

/**
 * 账龄汇总（按币种）/ Ageing summary per currency.
 * @param {object[]} entries
 * @param {string} key 金额字段 / outstanding field
 * @returns {object[]}
 */
function ageingSummary(entries, key = 'outstanding') {
  const map = new Map();
  for (const e of entries) {
    if (!(e[key] > 0.005)) continue;
    if (!map.has(e.currency)) map.set(e.currency, { currency: e.currency, total: 0, ...Object.fromEntries(BUCKETS.map((b) => [b, 0])) });
    const m = map.get(e.currency);
    m.total = round(m.total + e[key]);
    m[e.bucket] = round(m[e.bucket] + e[key]);
  }
  return [...map.values()];
}

/**
 * 供应商账期天数（从结算方式中识别“月结30天”“30天”等，款到发货/预付为0）
 * Supplier credit days parsed from the settlement text.
 * @param {string} s
 * @returns {number}
 */
function creditDays(s) {
  const m = String(s || '').match(/(\d+)\s*天/);
  return m ? Number(m[1]) : 0;
}

/**
 * 水单及已认领金额 / Load a bank slip with claimed totals.
 * @param {object} db
 * @param {number|string} id
 * @returns {object}
 */
function getSlip(db, id) {
  const s = db.prepare(`SELECT b.*, c.name customer_name, c.salesman_id,
      (SELECT COALESCE(SUM(amount),0) FROM slip_claims WHERE slip_id=b.id) claimed FROM bank_slips b LEFT JOIN customers c ON c.id=b.customer_id WHERE b.id=?`).get(id);
  if (!s) throw new HttpError(404, '水单不存在');
  s.claimed = round(s.claimed);
  s.claimable = round(num(s.amount) + num(s.fee));
  s.remaining = round(s.claimable - s.claimed);
  s.status = s.claimed <= 0.005 ? '未认领' : (s.remaining > 0.005 ? '部分认领' : '已认领');
  return s;
}

/**
 * 注册台账与水单路由 / Register ledger & bank-slip routes.
 * @param {import('../http').Router} r
 */
function register(r) {
  // ---------- 应收台账 / receivable ledger ----------
  r.get('/api/ar-ledger', (ctx) => {
    need(ctx, 'receivable', 'view');
    const { entries, advances } = arLedger(ctx);
    return { entries, advances, ageing: ageingSummary(entries), buckets: BUCKETS };
  });

  // 其他应收（样品费、快递费、索赔等）/ other receivables
  r.post('/api/ar-others', (ctx) => {
    need(ctx, 'receivable', 'add');
    const b = ctx.body;
    required(b, { customer_id: '客户', kind: '费用名称', currency: '币种', amount: '金额' });
    if (!(num(b.amount) > 0)) throw new HttpError(400, '金额必须大于0');
    if (!ctx.db.prepare('SELECT 1 FROM currencies WHERE code=?').get(b.currency)) throw new HttpError(400, '币种不存在');
    if (!ctx.db.prepare('SELECT 1 FROM customers WHERE id=?').get(Number(b.customer_id))) throw new HttpError(400, '客户不存在');
    const no = nextNo(ctx.db, 'AR', 'ar_others', 'other_no');
    const rr = ctx.db.prepare('INSERT INTO ar_others(other_no,customer_id,kind,currency,amount,due_date,source_no,remark,user_name) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(no, Number(b.customer_id), String(b.kind).slice(0, 50), b.currency, round(num(b.amount)), b.due_date || today(30), b.source_no || '', b.remark || '', ctx.user.name);
    log(ctx, 'receivable', '登记其他应收', no, `${b.kind} ${b.amount} ${b.currency}`);
    return { id: Number(rr.lastInsertRowid), other_no: no };
  });
  r.del('/api/ar-others/:id', (ctx) => {
    need(ctx, 'receivable', 'edit');
    const a = ctx.db.prepare('SELECT * FROM ar_others WHERE id=?').get(ctx.params.id);
    if (!a) throw new HttpError(404, '其他应收不存在');
    if (ctx.db.prepare("SELECT 1 FROM slip_claims WHERE target_type='other' AND target_id=?").get(a.id)) throw new HttpError(409, '该笔应收已有水单认领，不能删除');
    ctx.db.prepare('DELETE FROM ar_others WHERE id=?').run(a.id);
    log(ctx, 'receivable', '删除其他应收', a.other_no);
    return { ok: true };
  });

  // ---------- 销账（小额差异，如银行扣费）/ write-offs ----------
  r.post('/api/orders/:id/writeoff', (ctx) => {
    need(ctx, 'receivable', 'audit');
    const row = receivableRows(ctx).find((x) => x.id === Number(ctx.params.id));
    if (!row) throw new HttpError(404, '订单不存在或无权查看');
    const amount = round(num(ctx.body.amount));
    const max = num(setting(ctx.db, 'ar_writeoff_max', '50'));
    if (!(amount > 0)) throw new HttpError(400, '销账金额必须大于0');
    if (!String(ctx.body.reason || '').trim()) throw new HttpError(400, '请填写销账原因（如：银行手续费、汇率尾差）');
    if (amount > row.unreceived + 0.005) throw new HttpError(409, `销账金额超过未收余额（未收 ${row.unreceived} ${row.currency}）`);
    if (amount > max + 0.005) throw new HttpError(409, `单笔销账不能超过 ${max} ${row.currency}（可在系统参数 ar_writeoff_max 中调整）`);
    const rr = ctx.db.prepare('INSERT INTO ar_writeoffs(order_id,amount,reason,user_name) VALUES(?,?,?,?)').run(row.id, amount, String(ctx.body.reason).slice(0, 200), ctx.user.name);
    log(ctx, 'receivable', '应收销账', row.order_no, `${amount} ${row.currency}：${ctx.body.reason}`);
    return { id: Number(rr.lastInsertRowid) };
  });
  r.get('/api/orders/:id/writeoffs', (ctx) => {
    need(ctx, 'receivable', 'view');
    const row = receivableRows(ctx).find((x) => x.id === Number(ctx.params.id));
    if (!row) throw new HttpError(404, '订单不存在或无权查看');
    return { rows: ctx.db.prepare('SELECT * FROM ar_writeoffs WHERE order_id=? ORDER BY id').all(row.id) };
  });
  r.del('/api/writeoffs/:id', (ctx) => {
    need(ctx, 'receivable', 'audit');
    const w = ctx.db.prepare('SELECT * FROM ar_writeoffs WHERE id=?').get(ctx.params.id);
    if (!w) throw new HttpError(404, '销账记录不存在');
    const o = ctx.db.prepare('SELECT order_no, status FROM orders WHERE id=?').get(w.order_id);
    if (o.status === '已完成') throw new HttpError(409, '订单已完成，不能撤销销账');
    ctx.db.prepare('DELETE FROM ar_writeoffs WHERE id=?').run(w.id);
    log(ctx, 'receivable', '撤销销账', o.order_no, `${w.amount}`);
    return { ok: true };
  });

  // ---------- 水单 / bank slips ----------
  r.get('/api/bank-slips', (ctx) => {
    need(ctx, 'receivable', 'view');
    const own = ctx.user.scope === 'own' ? ` WHERE (b.customer_id IS NULL OR c.salesman_id=${Number(ctx.user.employee_id || -1)})` : '';
    const rows = ctx.db.prepare(`SELECT b.id FROM bank_slips b LEFT JOIN customers c ON c.id=b.customer_id${own} ORDER BY b.id DESC LIMIT 1000`).all().map((x) => getSlip(ctx.db, x.id));
    return { rows };
  });
  r.get('/api/bank-slips/:id', (ctx) => {
    need(ctx, 'receivable', 'view');
    const s = getSlip(ctx.db, ctx.params.id);
    if (ctx.user.scope === 'own' && s.customer_id && s.salesman_id !== ctx.user.employee_id) throw new HttpError(404, '水单不存在或无权查看');
    s.claims = ctx.db.prepare(`SELECT sc.*, CASE WHEN sc.target_type='order' THEN (SELECT order_no FROM orders WHERE id=sc.target_id) ELSE (SELECT other_no || ' ' || kind FROM ar_others WHERE id=sc.target_id) END target_no
      FROM slip_claims sc WHERE sc.slip_id=? ORDER BY sc.id`).all(s.id);
    // 可认领对象：同币种、有未收余额的订单与其他应收 / claimable targets in the same currency
    const { entries } = arLedger(ctx);
    const orderRows = receivableRows(ctx).filter((x) => x.currency === s.currency && x.unreceived > 0.005 && (!s.customer_id || ctx.db.prepare('SELECT customer_id FROM orders WHERE id=?').get(x.id).customer_id === s.customer_id));
    s.targets = [
      ...orderRows.map((x) => ({ target_type: 'order', target_id: x.id, no: x.order_no, customer_name: x.customer_name, outstanding: x.unreceived, kind: '订单货款' })),
      ...entries.filter((e) => e.other_id && e.currency === s.currency && e.outstanding > 0.005 && (!s.customer_id || e.customer_id === s.customer_id))
        .map((e) => ({ target_type: 'other', target_id: e.other_id, no: e.source_no, customer_name: e.customer_name, outstanding: e.outstanding, kind: e.kind })),
    ];
    return s;
  });
  r.post('/api/bank-slips', (ctx) => {
    need(ctx, 'receivable', 'add');
    const b = ctx.body;
    required(b, { currency: '币种', amount: '到账金额', receive_date: '到账日期' });
    if (!(num(b.amount) > 0)) throw new HttpError(400, '到账金额必须大于0');
    if (num(b.fee) < 0) throw new HttpError(400, '手续费不能为负数');
    if (!ctx.db.prepare('SELECT 1 FROM currencies WHERE code=?').get(b.currency)) throw new HttpError(400, '币种不存在');
    if (b.customer_id && !ctx.db.prepare('SELECT 1 FROM customers WHERE id=?').get(Number(b.customer_id))) throw new HttpError(400, '客户不存在');
    const no = String(b.slip_no || '').trim() || nextNo(ctx.db, 'SL', 'bank_slips', 'slip_no');
    if (ctx.db.prepare('SELECT 1 FROM bank_slips WHERE slip_no=?').get(no)) throw new HttpError(409, `水单号 ${no} 已登记`);
    const rr = ctx.db.prepare('INSERT INTO bank_slips(slip_no,receive_date,payer,customer_id,currency,amount,fee,bank,remark,user_name) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(no, b.receive_date, b.payer || '', b.customer_id ? Number(b.customer_id) : null, b.currency, round(num(b.amount)), round(num(b.fee)), b.bank || '', b.remark || '', ctx.user.name);
    log(ctx, 'receivable', '登记水单', no, `${b.amount} ${b.currency}${num(b.fee) ? ' 手续费' + b.fee : ''}`);
    return getSlip(ctx.db, Number(rr.lastInsertRowid));
  });
  r.del('/api/bank-slips/:id', (ctx) => {
    need(ctx, 'receivable', 'audit');
    const s = getSlip(ctx.db, ctx.params.id);
    if (s.claimed > 0) throw new HttpError(409, '水单已有认领，请先撤销认领');
    ctx.db.prepare('DELETE FROM bank_slips WHERE id=?').run(s.id);
    log(ctx, 'receivable', '删除水单', s.slip_no);
    return { ok: true };
  });

  // 认领：业务员可认领到本人订单；财务可认领到任何订单 / claim: sales onto their own orders, finance onto any
  r.post('/api/bank-slips/:id/claim', (ctx) => {
    need(ctx, 'receivable', 'view');
    const s = getSlip(ctx.db, ctx.params.id);
    if (ctx.user.scope === 'own' && s.customer_id && s.salesman_id !== ctx.user.employee_id) throw new HttpError(404, '水单不存在或无权查看');
    const claims = (Array.isArray(ctx.body.claims) ? ctx.body.claims : []).filter((c) => num(c.amount) > 0);
    if (!claims.length) throw new HttpError(400, '请填写认领金额');
    const total = round(claims.reduce((a, c) => a + num(c.amount), 0));
    if (total > s.remaining + 0.005) throw new HttpError(409, `认领合计 ${total} 超过水单可认领余额 ${s.remaining} ${s.currency}`);
    const finance = can(ctx.user, 'receivable', 'add');
    return tx(ctx.db, () => {
      for (const c of claims) {
        const amount = round(num(c.amount));
        let receiptId = null;
        if (c.target_type === 'order') {
          const o = ctx.db.prepare('SELECT * FROM orders WHERE id=?').get(Number(c.target_id));
          if (!o) throw new HttpError(404, '订单不存在');
          if (!finance && !(can(ctx.user, 'order', 'edit') && (ctx.user.scope !== 'own' || o.salesman_id === ctx.user.employee_id))) throw new HttpError(403, `无权认领到订单 ${o.order_no}（只能认领到本人订单）`);
          if (o.currency !== s.currency) throw new HttpError(409, `订单${o.order_no}币种为${o.currency}，与水单币种${s.currency}不同`);
          if (s.customer_id && o.customer_id !== s.customer_id) throw new HttpError(409, `订单${o.order_no}不属于水单付款客户`);
          const shipped = ctx.db.prepare("SELECT COUNT(*) n FROM shipments WHERE order_id=? AND status='已出运'").get(o.id).n;
          receiptId = addReceipt(ctx, { order_id: o.id, type: shipped ? '尾款' : '预收', amount, receipt_date: s.receive_date, voucher: s.slip_no, remark: `水单认领（${ctx.user.name}）` }).id;
        } else if (c.target_type === 'other') {
          const a = ctx.db.prepare(`SELECT a.*, c.salesman_id, (SELECT COALESCE(SUM(amount),0) FROM slip_claims WHERE target_type='other' AND target_id=a.id) received
            FROM ar_others a LEFT JOIN customers c ON c.id=a.customer_id WHERE a.id=?`).get(Number(c.target_id));
          if (!a) throw new HttpError(404, '其他应收不存在');
          if (!finance && !(ctx.user.scope !== 'own' || a.salesman_id === ctx.user.employee_id)) throw new HttpError(403, `无权认领到 ${a.other_no}`);
          if (a.currency !== s.currency) throw new HttpError(409, `${a.other_no}币种为${a.currency}，与水单币种${s.currency}不同`);
          if (amount > round(a.amount - a.received) + 0.005) throw new HttpError(409, `认领金额超过 ${a.other_no} 未收余额 ${round(a.amount - a.received)}`);
        } else throw new HttpError(400, '认领对象无效');
        ctx.db.prepare('INSERT INTO slip_claims(slip_id,target_type,target_id,amount,receipt_id,user_name) VALUES(?,?,?,?,?,?)').run(s.id, c.target_type, Number(c.target_id), amount, receiptId, ctx.user.name);
      }
      log(ctx, 'receivable', '认领水单', s.slip_no, `${claims.length}笔 合计${total} ${s.currency}`);
      return getSlip(ctx.db, s.id);
    });
  });
  r.del('/api/slip-claims/:id', (ctx) => {
    need(ctx, 'receivable', 'audit');
    const c = ctx.db.prepare('SELECT * FROM slip_claims WHERE id=?').get(ctx.params.id);
    if (!c) throw new HttpError(404, '认领记录不存在');
    tx(ctx.db, () => {
      if (c.receipt_id) {
        const o = ctx.db.prepare('SELECT o.status FROM receipts r JOIN orders o ON o.id=r.order_id WHERE r.id=?').get(c.receipt_id);
        if (o && o.status === '已完成') throw new HttpError(409, '订单已完成，不能撤销认领');
        ctx.db.prepare('DELETE FROM receipts WHERE id=?').run(c.receipt_id);
      }
      ctx.db.prepare('DELETE FROM slip_claims WHERE id=?').run(c.id);
    });
    const s = ctx.db.prepare('SELECT slip_no FROM bank_slips WHERE id=?').get(c.slip_id);
    log(ctx, 'receivable', '撤销水单认领', s ? s.slip_no : c.slip_id, `${c.amount}`);
    return { ok: true };
  });

  // ---------- 应付台账 / payable ledger ----------
  r.get('/api/ap-ledger', (ctx) => {
    need(ctx, 'purchase', 'view');
    const rows = ctx.db.prepare(`SELECT p.id, p.po_no, p.type, p.status, p.order_date, p.due_date delivery_date, s.name supplier_name, s.settlement, o.order_no,
        (SELECT ROUND(COALESCE(SUM(qty*price),0),2) FROM purchase_items WHERE po_id=p.id) amount,
        (SELECT ROUND(COALESCE(SUM(amount),0),2) FROM payments WHERE po_id=p.id AND status='已付款') paid,
        (SELECT ROUND(COALESCE(SUM(amount),0),2) FROM payments WHERE po_id=p.id AND status='待审批') pending,
        (SELECT ROUND(COALESCE(SUM(amount),0),2) FROM purchase_invoices WHERE po_id=p.id) invoiced
      FROM purchases p LEFT JOIN suppliers s ON s.id=p.supplier_id LEFT JOIN orders o ON o.id=p.order_id ORDER BY p.id DESC`).all();
    const entries = rows.map((p) => {
      const days = creditDays(p.settlement);
      const prepay = /预付|款到/.test(String(p.settlement || ''));
      const due = prepay ? p.order_date : addDays(p.delivery_date || p.order_date || today(), days);
      const outstanding = round(p.amount - p.paid);
      return { ...p, currency: 'CNY', credit_days: days, pay_due_date: due, outstanding, uninvoiced: round(p.amount - p.invoiced), ...ageing(due, outstanding), pay_status: outstanding <= 0.005 ? '已付清' : (p.paid > 0 ? '部分付款' : '未付') };
    });
    return { entries, ageing: ageingSummary(entries), buckets: BUCKETS };
  });
}

module.exports = { register, arLedger, creditDays, ageing };
