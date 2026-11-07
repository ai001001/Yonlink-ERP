'use strict';
/**
 * 配件/包材/工序询价（参照亿星“配件询价、包材询价、工序询价”）：从样品明细选行向供应商询价，回价后比价，
 * “采用”时把单价/工价与供应商写回样品明细并记入历史供货价格
 * Parts / packaging / process inquiries modelled on 亿星: inquire selected sample-BOM lines, record replies, compare,
 * and adopt a reply back into the sample BOM and the supplier price ledger.
 * @module server/routes/bominquiry
 */
const { HttpError } = require('../http');
const { need, log, nextNo, tx, num, round, today } = require('../core');

/**
 * 读取询价单（含每行的其它供应商回价，用于比价）/ Load an inquiry with competing replies per line.
 * @param {object} ctx
 * @param {any} id
 * @returns {object}
 */
function getBomInquiry(ctx, id) {
  if (ctx.user.scope === 'designer') throw new HttpError(403, '设计师无权查看询价单');
  const { db } = ctx;
  const q = db.prepare('SELECT b.*, s.name supplier_name, s.contact supplier_contact, s.phone supplier_phone FROM bom_inquiries b LEFT JOIN suppliers s ON s.id=b.supplier_id WHERE b.id=?').get(id);
  if (!q) throw new HttpError(404, '询价单不存在');
  q.items = db.prepare('SELECT * FROM bom_inquiry_items WHERE inquiry_id=? ORDER BY id').all(q.id);
  for (const it of q.items) {
    it.others = db.prepare(`SELECT i.price, i.lead_days, b.inq_no, s.name supplier_name FROM bom_inquiry_items i JOIN bom_inquiries b ON b.id=i.inquiry_id LEFT JOIN suppliers s ON s.id=b.supplier_id
      WHERE i.source_type=? AND i.source_id=? AND i.id<>? AND i.price IS NOT NULL ORDER BY i.price`).all(it.source_type, it.source_id, it.id);
    it.lowest = it.price !== null && it.price !== undefined && it.others.every((o) => o.price >= it.price);
  }
  return q;
}

/**
 * 注册询价路由 / Register routes.
 * @param {import('../http').Router} r
 */
function register(r) {
  r.get('/api/bom-inquiries', (ctx) => {
    need(ctx, 'quote', 'view');
    if (ctx.user.scope === 'designer') throw new HttpError(403, '设计师无权查看询价单');
    return { rows: ctx.db.prepare(`SELECT b.*, s.name supplier_name, (SELECT COUNT(*) FROM bom_inquiry_items WHERE inquiry_id=b.id) item_count,
      (SELECT COUNT(*) FROM bom_inquiry_items WHERE inquiry_id=b.id AND price IS NOT NULL) replied, (SELECT COUNT(*) FROM bom_inquiry_items WHERE inquiry_id=b.id AND adopted=1) adopted,
      (SELECT group_concat(DISTINCT item_no) FROM bom_inquiry_items WHERE inquiry_id=b.id) item_nos, (SELECT group_concat(DISTINCT kind) FROM bom_inquiry_items WHERE inquiry_id=b.id) kinds
      FROM bom_inquiries b LEFT JOIN suppliers s ON s.id=b.supplier_id ORDER BY b.id DESC LIMIT 2000`).all() };
  });
  r.get('/api/bom-inquiries/:id', (ctx) => { need(ctx, 'quote', 'view'); return getBomInquiry(ctx, ctx.params.id); });

  // 新建：选样品明细行向一家供应商询价 / create an inquiry for selected BOM lines to one supplier
  r.post('/api/bom-inquiries', (ctx) => {
    need(ctx, 'quote', 'edit');
    if (ctx.user.scope === 'designer') throw new HttpError(403, '设计师无权询价');
    const { db } = ctx;
    const b = ctx.body;
    const sup = db.prepare('SELECT * FROM suppliers WHERE id=?').get(Number(b.supplier_id));
    if (!sup) throw new HttpError(400, '请选择询价供应商');
    const lines = Array.isArray(b.lines) ? b.lines : [];
    if (!lines.length) throw new HttpError(400, '请选择要询价的配件/包材/工序');
    const rows = lines.map((l) => {
      if (l.source_type === 'part') {
        const p = db.prepare('SELECT p.*, s.company_no FROM sample_parts p JOIN samples s ON s.id=p.sample_id WHERE p.id=?').get(Number(l.source_id));
        if (!p) throw new HttpError(400, '配件/包材明细不存在');
        return { source_type: 'part', source_id: p.id, sample_id: p.sample_id, item_no: p.company_no, kind: p.kind, name: p.name, spec: [p.code, p.spec].filter(Boolean).join(' '), unit: p.unit, old_price: p.unit_price, qty: num(l.qty) || null };
      }
      if (l.source_type === 'process') {
        const p = db.prepare('SELECT p.*, s.company_no FROM sample_processes p JOIN samples s ON s.id=p.sample_id WHERE p.id=?').get(Number(l.source_id));
        if (!p) throw new HttpError(400, '工序明细不存在');
        return { source_type: 'process', source_id: p.id, sample_id: p.sample_id, item_no: p.company_no, kind: '工序', name: p.name, spec: '', unit: '只', old_price: p.price, qty: num(l.qty) || null };
      }
      throw new HttpError(400, '询价明细类型无效');
    });
    return tx(db, () => {
      const no = nextNo(db, 'XJ', 'bom_inquiries', 'inq_no');
      const id = Number(db.prepare('INSERT INTO bom_inquiries(inq_no,supplier_id,valid_until,remark,user_name) VALUES(?,?,?,?,?)').run(no, sup.id, b.valid_until || today(7), b.remark || '', ctx.user.name).lastInsertRowid);
      for (const x of rows) {
        db.prepare('INSERT INTO bom_inquiry_items(inquiry_id,source_type,source_id,sample_id,item_no,kind,name,spec,unit,qty,old_price) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
          .run(id, x.source_type, x.source_id, x.sample_id, x.item_no, x.kind, x.name, x.spec, x.unit, x.qty, x.old_price);
      }
      log(ctx, 'quote', '新建配件/工序询价', no, `${sup.name} ${rows.length}项`);
      return getBomInquiry(ctx, id);
    });
  });

  r.post('/api/bom-inquiries/:id/sent', (ctx) => {
    need(ctx, 'quote', 'edit');
    const q = getBomInquiry(ctx, ctx.params.id);
    if (q.status !== '待发送') throw new HttpError(409, `询价单${q.status}，无需再标记发送`);
    ctx.db.prepare("UPDATE bom_inquiries SET status='已发送', sent_at=datetime('now','localtime') WHERE id=?").run(q.id);
    log(ctx, 'quote', '配件/工序询价已发送', q.inq_no);
    return getBomInquiry(ctx, q.id);
  });

  // 回填供应商报价 / record the supplier's reply
  r.put('/api/bom-inquiries/:id/reply', (ctx) => {
    need(ctx, 'quote', 'edit');
    const q = getBomInquiry(ctx, ctx.params.id);
    tx(ctx.db, () => {
      for (const l of ctx.body.items || []) {
        const it = q.items.find((x) => x.id === Number(l.id));
        if (!it) throw new HttpError(400, '询价明细不存在');
        if (it.adopted) continue;
        const price = l.price === '' || l.price === null || l.price === undefined ? null : Number(l.price);
        if (price !== null && !(price >= 0)) throw new HttpError(400, `${it.name} 报价必须是非负数字`);
        const lead = l.lead_days === '' || l.lead_days === undefined || l.lead_days === null ? null : Math.round(Number(l.lead_days));
        if (lead !== null && !(lead >= 0)) throw new HttpError(400, `${it.name} 交期天数无效`);
        ctx.db.prepare('UPDATE bom_inquiry_items SET price=?, lead_days=?, remark=? WHERE id=?').run(price === null ? null : round(price, 4), lead, l.remark ?? it.remark ?? '', it.id);
      }
      const replied = ctx.db.prepare('SELECT COUNT(*) n FROM bom_inquiry_items WHERE inquiry_id=? AND price IS NOT NULL').get(q.id).n;
      if (replied && ['待发送', '已发送'].includes(q.status)) ctx.db.prepare("UPDATE bom_inquiries SET status='已回价', reply_date=? WHERE id=?").run(ctx.body.reply_date || today(), q.id);
    });
    log(ctx, 'quote', '配件/工序询价回价', q.inq_no);
    return getBomInquiry(ctx, q.id);
  });

  // 采用：写回样品明细（单价/工价、供应商）并记入历史供货价格 / adopt into the sample BOM and the price ledger
  r.post('/api/bom-inquiries/:id/adopt', (ctx) => {
    need(ctx, 'quote', 'edit');
    const q = getBomInquiry(ctx, ctx.params.id);
    const ids = new Set((ctx.body.item_ids || []).map(Number));
    const picks = q.items.filter((i) => ids.has(i.id));
    if (!picks.length) throw new HttpError(400, '请勾选要采用的报价');
    const noPrice = picks.filter((i) => i.price === null || i.price === undefined);
    if (noPrice.length) throw new HttpError(400, `${noPrice.map((i) => i.name).join('、')} 还没有回价`);
    tx(ctx.db, () => {
      for (const it of picks) {
        if (it.source_type === 'part') {
          const ok = ctx.db.prepare('UPDATE sample_parts SET unit_price=?, supplier_id=? WHERE id=?').run(it.price, q.supplier_id, it.source_id).changes;
          if (!ok) throw new HttpError(409, `${it.item_no} ${it.name} 的样品明细已被删除`);
        } else {
          const ok = ctx.db.prepare('UPDATE sample_processes SET price=?, supplier_id=? WHERE id=?').run(it.price, q.supplier_id, it.source_id).changes;
          if (!ok) throw new HttpError(409, `${it.item_no} ${it.name} 的工序明细已被删除`);
        }
        // 同一明细只保留一个“已采用”/ one adopted reply per BOM line
        ctx.db.prepare('UPDATE bom_inquiry_items SET adopted=0 WHERE source_type=? AND source_id=?').run(it.source_type, it.source_id);
        ctx.db.prepare('UPDATE bom_inquiry_items SET adopted=1 WHERE id=?').run(it.id);
        ctx.db.prepare("INSERT INTO supplier_prices(supplier_id,item_no,price,currency,source,ref_no) VALUES(?,?,?,'CNY',?,?)")
          .run(q.supplier_id, `${it.item_no}-${it.name}`, it.price, it.source_type === 'part' ? `${it.kind}询价` : '工序询价', q.inq_no);
        ctx.db.prepare("INSERT INTO sample_revisions(sample_id,stage,content,user_name) VALUES(?,'打样',?,?)")
          .run(it.sample_id, `采用询价单${q.inq_no}：${it.kind} ${it.name} 单价 ${it.old_price ?? '-'} → ${it.price}（${q.supplier_name}）`, ctx.user.name);
      }
      ctx.db.prepare("UPDATE bom_inquiries SET status='已采用' WHERE id=?").run(q.id);
    });
    log(ctx, 'quote', '采用配件/工序报价', q.inq_no, `${picks.length}项`);
    return getBomInquiry(ctx, q.id);
  });

  r.del('/api/bom-inquiries/:id', (ctx) => {
    need(ctx, 'quote', 'edit');
    const q = getBomInquiry(ctx, ctx.params.id);
    if (q.items.some((i) => i.adopted)) throw new HttpError(409, '已有采用的报价，不能删除');
    tx(ctx.db, () => {
      ctx.db.prepare('DELETE FROM bom_inquiry_items WHERE inquiry_id=?').run(q.id);
      ctx.db.prepare('DELETE FROM bom_inquiries WHERE id=?').run(q.id);
    });
    log(ctx, 'quote', '删除配件/工序询价', q.inq_no);
    return { ok: true };
  });
}

module.exports = { register };
