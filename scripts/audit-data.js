'use strict';
/**
 * 数据一致性审计：检查账、货、单、状态之间是否自洽（可用于任何 ERP 数据库）
 * Data consistency audit: cross-checks money, stock, documents and statuses (works on any ERP database).
 * 用法 / usage: node scripts/audit-data.js [data/erp.db]
 * @module scripts/audit-data
 */
const path = require('node:path');

const EPS = 0.011;

/**
 * 执行审计 / Run the audit.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {{name:string, ok:boolean, detail:string}[]}
 */
function audit(db) {
  const out = [];
  const all = (sql, ...p) => db.prepare(sql).all(...p);
  const check = (name, bad, fmt = (r) => JSON.stringify(r)) => out.push({ name, ok: !bad.length, detail: bad.length ? `${bad.length} 条异常，例：${bad.slice(0, 3).map(fmt).join('；')}` : '' });

  check('库存数量不为负', all('SELECT code, qty FROM inventory WHERE qty < -0.0001'));
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='stock_moves'").get()) {
    check('物料库存 = 库存流水合计', all(`SELECT i.code, i.qty, (SELECT COALESCE(SUM(qty),0) FROM stock_moves WHERE inventory_id=i.id) moves FROM inventory i
      WHERE ABS(i.qty - (SELECT COALESCE(SUM(qty),0) FROM stock_moves WHERE inventory_id=i.id)) > 0.001`));
    check('各仓库库存不为负', all(`SELECT inventory_id, warehouse_id, SUM(qty) q FROM stock_moves GROUP BY inventory_id, warehouse_id HAVING q < -0.0001`));
  }
  check('出货数量不超过订单数量', all(`SELECT oi.id, oi.item_no, oi.qty, SUM(si.qty) shipped FROM order_items oi JOIN shipment_items si ON si.order_item_id=oi.id
    JOIN shipments s ON s.id=si.shipment_id AND s.status<>'已取消' GROUP BY oi.id HAVING shipped > oi.qty`));
  // 合同总额 = 货款 + 加减项（旧库没有加减项表时按 0）/ contract total = goods + charges (0 on older databases)
  const hasCharges = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='order_charges'").get();
  const charges = hasCharges ? "(SELECT COALESCE(SUM(CASE WHEN kind='减' THEN -amount ELSE amount END),0) FROM order_charges WHERE order_id=o.id)" : '0';
  const orderAmt = `((SELECT COALESCE(SUM(qty*unit_price),0) FROM order_items WHERE order_id=o.id) + ${charges})`;
  check('收款不超过订单金额', all(`SELECT o.order_no, ${orderAmt} amt, (SELECT SUM(amount) FROM receipts WHERE order_id=o.id) rec FROM orders o WHERE rec > amt + ${EPS}`));
  check('销项开票不超过订单金额', all(`SELECT o.order_no, ${orderAmt} amt, (SELECT SUM(amount) FROM sales_invoices WHERE order_id=o.id) inv FROM orders o WHERE inv > amt + ${EPS}`));
  const poAmt = '(SELECT COALESCE(SUM(qty*price),0) FROM purchase_items WHERE po_id=p.id)';
  check('已付款不超过采购金额', all(`SELECT p.po_no, ${poAmt} amt, (SELECT SUM(amount) FROM payments WHERE po_id=p.id AND status='已付款') paid FROM purchases p WHERE paid > amt + ${EPS}`));
  check('进项票不超过采购金额', all(`SELECT p.po_no, ${poAmt} amt, (SELECT SUM(amount) FROM purchase_invoices WHERE po_id=p.id) inv FROM purchases p WHERE inv > amt + ${EPS}`));
  check('入库不超过采购数量', all('SELECT po_id, code, qty, received_qty FROM purchase_items WHERE received_qty > qty + 0.0001'));
  check('采购单状态与入库一致', all(`SELECT p.po_no, p.status, SUM(i.qty) q, SUM(i.received_qty) r FROM purchases p JOIN purchase_items i ON i.po_id=p.id GROUP BY p.id
    HAVING (p.status='已入库' AND r < q - 0.0001) OR (p.status='已下单' AND r > 0)`));
  check('外购成品入库前已质检合格', all(`SELECT p.po_no, p.qc_status FROM purchases p WHERE p.type='外购成品' AND p.qc_status<>'合格' AND EXISTS (SELECT 1 FROM purchase_items i WHERE i.po_id=p.id AND i.received_qty>0)`));
  check('付款状态与审批一致', all(`SELECT a.target_no, a.status, p.status pay FROM approvals a JOIN payments p ON p.id=a.target_id WHERE a.target_type='payment'
    AND ((a.status='已通过' AND p.status<>'已付款') OR (a.status='已驳回' AND p.status<>'已驳回') OR (a.status='待审批' AND p.status<>'待审批'))`));

  // 工序顺序：后道良品 ≤ 前道良品 / later process good ≤ earlier process good
  const procs = ['制坯', '上釉', '烧制', '彩绘', '包装'];
  const badProd = [];
  for (const p of all('SELECT * FROM productions')) {
    const good = Object.fromEntries(all('SELECT process, SUM(good_qty) g FROM production_reports WHERE production_id=? GROUP BY process', p.id).map((r) => [r.process, r.g]));
    const seq = procs.map((k) => good[k] || 0);
    for (let i = 1; i < seq.length; i++) if (seq[i] > seq[i - 1]) badProd.push({ prod: p.prod_no, seq });
    if (p.status === '已完工' && seq[4] < p.plan_qty) badProd.push({ prod: p.prod_no, status: p.status, packed: seq[4], plan: p.plan_qty });
    if (p.status !== '已完工' && seq[4] >= p.plan_qty) badProd.push({ prod: p.prod_no, status: p.status, packed: seq[4], plan: p.plan_qty });
  }
  check('生产工序良品逐道递减、完工状态正确', badProd);

  check('风控锁定 ⇔ 存在待处理联动任务', all(`SELECT o.order_no, o.risk_lock, (SELECT COUNT(*) FROM change_tasks t WHERE t.order_id=o.id AND t.status='待处理') pend FROM orders o
    WHERE (o.risk_lock=1 AND pend=0) OR (o.risk_lock=0 AND pend>0)`));
  check('变更单完成 ⇔ 任务全部处理', all(`SELECT c.change_no, c.status, (SELECT COUNT(*) FROM change_tasks t WHERE t.change_id=c.id AND t.status='待处理') pend FROM order_changes c
    WHERE (c.status='已完成' AND pend>0) OR (c.status='待联动修正' AND pend=0)`));
  check('锁定旧货号都有转正的新货号', all(`SELECT s.company_no FROM samples s WHERE s.status='已锁定' AND NOT EXISTS (SELECT 1 FROM samples n WHERE n.parent_no=s.company_no)`));
  check('锁定后的新订单未使用旧货号', all(`SELECT o.order_no, s.company_no FROM order_items oi JOIN orders o ON o.id=oi.order_id JOIN samples s ON s.id=oi.sample_id
    WHERE s.status='已锁定' AND s.locked_at IS NOT NULL AND o.created_at >= s.locked_at`));
  check('已出运的出货单均验货合格且有报关单号', all(`SELECT ship_no FROM shipments WHERE status='已出运' AND (inspection_status<>'合格' OR customs_no IS NULL OR customs_no='')`));
  const shippedAll = `NOT EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id=o.id AND oi.qty > (SELECT COALESCE(SUM(si.qty),0) FROM shipment_items si JOIN shipments s ON s.id=si.shipment_id WHERE si.order_item_id=oi.id AND s.status='已出运'))`;
  check('订单“已出货/已完成”时全部出运', all(`SELECT order_no, status FROM orders o WHERE status IN ('已出货','已完成') AND NOT ${shippedAll}`));
  const hasWo = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ar_writeoffs'").get();
  const wo = hasWo ? '(SELECT COALESCE(SUM(amount),0) FROM ar_writeoffs WHERE order_id=o.id)' : '0';
  check('订单“已完成”时货款收齐（含销账）', all(`SELECT order_no FROM orders o WHERE status='已完成' AND (SELECT COALESCE(SUM(amount),0) FROM receipts WHERE order_id=o.id) + ${wo} < ${orderAmt} - ${EPS}`));
  check('收款+销账不超过订单金额', all(`SELECT o.order_no FROM orders o WHERE (SELECT COALESCE(SUM(amount),0) FROM receipts WHERE order_id=o.id) + ${wo} > ${orderAmt} + ${EPS}`));
  check('报价“已成交” ⇔ 有对应订单', all(`SELECT quote_no, status FROM quotes q WHERE (status='已成交') <> EXISTS (SELECT 1 FROM orders o WHERE o.quote_id=q.id)`));
  check('询价单号 = 报价单号-厂家名称', all(`SELECT i.inquiry_no FROM inquiries i JOIN quotes q ON q.id=i.quote_id JOIN suppliers s ON s.id=i.supplier_id WHERE i.inquiry_no <> q.quote_no || '-' || s.name`));
  const badImg = [];
  for (const s of all('SELECT id, company_no, images FROM samples')) {
    for (const ref of String(s.images || '').split(',').filter((x) => x.startsWith('file:'))) {
      const f = db.prepare('SELECT owner_type, owner_id FROM files WHERE id=?').get(Number(ref.slice(5)));
      if (!f || f.owner_type !== 'sample' || f.owner_id !== s.id) badImg.push({ sample: s.company_no, ref });
    }
  }
  check('样品图片文件存在且归属正确', badImg);
  check('邮件附件文件存在', all(`SELECT m.id, j.value FROM mails m, json_each(m.attachments) j WHERE m.attachments IS NOT NULL
    AND json_extract(j.value,'$.file_id') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM files f WHERE f.id=json_extract(j.value,'$.file_id'))`));
  check('同一邮箱内邮件不重复', all("SELECT account_id, message_id, COUNT(*) c FROM mails WHERE message_id IS NOT NULL AND direction='收件' GROUP BY account_id, message_id HAVING c>1"));
  check('邮件绑定的客户/订单/报价存在', all(`SELECT id FROM mails m WHERE (customer_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM customers c WHERE c.id=m.customer_id))
    OR (order_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.id=m.order_id)) OR (quote_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM quotes q WHERE q.id=m.quote_id))`));
  const now = new Date().toLocaleString('sv-SE');
  const future = [];
  for (const { name } of all("SELECT name FROM sqlite_master WHERE type='table'")) {
    for (const c of all(`PRAGMA table_info(${name})`).filter((x) => /created_at|_date$|handled_at|decided_at|sent_at/.test(x.name))) {
      const r = db.prepare(`SELECT MAX(${c.name}) m FROM ${name} WHERE ${c.name} > ? AND ${c.name} NOT LIKE '20__-__-__'`).get(now);
      if (r && r.m && !/delivery_date|due_date|valid_until|next_date|ship_date/.test(c.name)) future.push(`${name}.${c.name}=${r.m}`);
    }
  }
  check('业务时间戳不晚于当前时间', future, (x) => x);
  check('单号唯一', [
    ...all('SELECT quote_no n FROM quotes GROUP BY quote_no HAVING COUNT(*)>1'), ...all('SELECT order_no n FROM orders GROUP BY order_no HAVING COUNT(*)>1'),
    ...all('SELECT po_no n FROM purchases GROUP BY po_no HAVING COUNT(*)>1'), ...all('SELECT ship_no n FROM shipments GROUP BY ship_no HAVING COUNT(*)>1'),
  ]);
  return out;
}

module.exports = { audit };

if (require.main === module) {
  const { DatabaseSync } = require('node:sqlite');
  const file = path.resolve(process.argv[2] || path.join(__dirname, '..', 'data', 'erp.db'));
  const res = audit(new DatabaseSync(file, { readOnly: true }));
  for (const r of res) console.log(`${r.ok ? '✔' : '✖'} ${r.name}${r.ok ? '' : '：' + r.detail}`);
  const bad = res.filter((r) => !r.ok).length;
  console.log(bad ? `发现 ${bad} 项不一致` : `全部 ${res.length} 项检查通过`);
  process.exit(bad ? 1 : 0);
}
