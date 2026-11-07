'use strict';
/**
 * 仓库作业与验货（参照亿星“库存管理”“质量管理”）：其他入库/出库、调拨、盘点、分仓库存、出入库明细；验货单
 * Warehouse operations and inspections modelled on 亿星: other receipts/issues, transfers, stocktakes,
 * per-warehouse balances, stock ledger; inspection orders linked to shipments.
 * @module server/routes/stock
 */
const { HttpError } = require('../http');
const { need, log, nextNo, tx, num, round, today, setting } = require('../core');
const stock = require('../stock');

/**
 * 读取并校验仓库 / Load an active warehouse.
 * @param {object} db
 * @param {any} id
 * @returns {object}
 */
function warehouse(db, id) {
  const w = db.prepare('SELECT * FROM warehouses WHERE id=?').get(Number(id));
  if (!w) throw new HttpError(400, '请选择仓库');
  if (w.use_status === '停用') throw new HttpError(400, `仓库「${w.name}」已停用`);
  return w;
}

/**
 * 读取物料 / Load an inventory item.
 * @param {object} db
 * @param {any} id
 * @returns {object}
 */
function item(db, id) {
  const i = db.prepare('SELECT * FROM inventory WHERE id=?').get(Number(id));
  if (!i) throw new HttpError(400, '物料不存在');
  return i;
}

/**
 * 读取盘点单 / Load a stocktake with lines (current book quantities refreshed).
 * @param {object} db
 * @param {any} id
 * @returns {object}
 */
function getStocktake(db, id) {
  const st = db.prepare('SELECT s.*, w.name warehouse_name FROM stocktakes s LEFT JOIN warehouses w ON w.id=s.warehouse_id WHERE s.id=?').get(id);
  if (!st) throw new HttpError(404, '盘点单不存在');
  st.items = db.prepare('SELECT t.*, i.code, i.name, i.unit, i.unit_cost FROM stocktake_items t JOIN inventory i ON i.id=t.inventory_id WHERE t.stocktake_id=? ORDER BY i.code').all(st.id);
  for (const t of st.items) {
    if (st.status === '盘点中') t.book_qty = stock.balance(db, t.inventory_id, st.warehouse_id);
    t.diff = t.actual_qty === null || t.actual_qty === undefined ? null : round(num(t.actual_qty) - num(t.book_qty), 4);
  }
  return st;
}

/** 验货结果 / inspection results */
const RESULTS = ['待验货', '合格', '不合格', '待复验'];
const INSP_TYPES = ['产前验货', '中期验货', '尾期验货', '出货验货', '复验'];

/**
 * 读取验货单（业务员只能看本人订单）/ Load an inspection (sales see their own orders only).
 * @param {object} ctx
 * @param {any} id
 * @returns {object}
 */
function getInspection(ctx, id) {
  const v = ctx.db.prepare(`SELECT v.*, o.order_no, o.salesman_id, c.name customer_name, s.ship_no, s.status ship_status FROM inspections v JOIN orders o ON o.id=v.order_id
    LEFT JOIN customers c ON c.id=o.customer_id LEFT JOIN shipments s ON s.id=v.shipment_id WHERE v.id=?`).get(id);
  if (!v || (ctx.user.scope === 'own' && v.salesman_id !== ctx.user.employee_id)) throw new HttpError(404, '验货单不存在或无权查看');
  v.items = ctx.db.prepare('SELECT * FROM inspection_items WHERE inspection_id=? ORDER BY id').all(v.id);
  return v;
}

/**
 * 保存验货单；关联出货单时把结果同步为出货单的验货状态 / Save an inspection; results sync to the linked shipment.
 * @param {object} ctx
 * @param {any} [id]
 * @returns {object}
 */
function saveInspection(ctx, id) {
  if (ctx.user.scope === 'designer') throw new HttpError(403, '设计师无权维护验货单');
  const { db } = ctx;
  const b = ctx.body;
  const old = id ? getInspection(ctx, id) : null;
  const { getOrder, updateShipment } = require('./orders');
  const o = getOrder(ctx, old ? old.order_id : b.order_id);
  const result = b.result || (old ? old.result : '待验货');
  if (!RESULTS.includes(result)) throw new HttpError(400, '验货结果无效');
  const type = b.type || (old ? old.type : '出货验货');
  if (!INSP_TYPES.includes(type)) throw new HttpError(400, '验货类型无效');
  const shipId = b.shipment_id !== undefined ? (b.shipment_id ? Number(b.shipment_id) : null) : (old ? old.shipment_id : null);
  let ship = null;
  if (shipId) {
    ship = db.prepare('SELECT * FROM shipments WHERE id=? AND order_id=?').get(shipId, o.id);
    if (!ship) throw new HttpError(400, '出货单不属于该订单');
  }
  const defects = b.defects !== undefined ? String(b.defects || '') : (old ? old.defects : '');
  if (result === '不合格' && !defects.trim()) throw new HttpError(400, '验货不合格请填写问题描述与整改要求');
  const ints = {};
  for (const k of ['lot_qty', 'sample_size', 'critical', 'major', 'minor']) {
    const v = b[k] !== undefined ? b[k] : (old ? old[k] : null);
    if (v !== null && v !== '' && v !== undefined && !(Number(v) >= 0)) throw new HttpError(400, '数量必须是非负数字');
    ints[k] = v === '' || v === undefined || v === null ? (['critical', 'major', 'minor'].includes(k) ? 0 : null) : Math.round(Number(v));
  }
  if (ints.sample_size && ints.lot_qty && ints.sample_size > ints.lot_qty) throw new HttpError(400, '抽样数不能大于批量');
  const items = Array.isArray(b.items) ? b.items : null;
  return tx(db, () => {
    const vals = [o.id, shipId, type, b.inspect_date || (old ? old.inspect_date : today()), b.inspector ?? (old ? old.inspector : ''), b.aql ?? (old ? old.aql : 'II/2.5'),
      ints.lot_qty, ints.sample_size, ints.critical, ints.major, ints.minor, result, defects, b.remark ?? (old ? old.remark : '')];
    let vid = old ? old.id : null;
    if (old) {
      db.prepare('UPDATE inspections SET order_id=?, shipment_id=?, type=?, inspect_date=?, inspector=?, aql=?, lot_qty=?, sample_size=?, critical=?, major=?, minor=?, result=?, defects=?, remark=? WHERE id=?').run(...vals, old.id);
    } else {
      const no = nextNo(db, 'QC', 'inspections', 'insp_no');
      vid = Number(db.prepare('INSERT INTO inspections(insp_no,order_id,shipment_id,type,inspect_date,inspector,aql,lot_qty,sample_size,critical,major,minor,result,defects,remark,user_name) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(no, ...vals, ctx.user.name).lastInsertRowid);
    }
    if (items) {
      db.prepare('DELETE FROM inspection_items WHERE inspection_id=?').run(vid);
      for (const it of items) {
        const oi = o.items.find((x) => x.id === Number(it.order_item_id));
        if (!oi) throw new HttpError(400, '验货货号不属于该订单');
        db.prepare('INSERT INTO inspection_items(inspection_id,order_item_id,item_no,check_qty,defect_qty,result,remark) VALUES(?,?,?,?,?,?,?)')
          .run(vid, oi.id, oi.item_no, Math.round(num(it.check_qty)), Math.round(num(it.defect_qty)), it.result || '', it.remark || '');
      }
    }
    // 合格/不合格同步到出货单（验货闭环）/ sync pass/fail to the shipment (inspection gate)
    if (ship && ['合格', '不合格'].includes(result) && ship.status !== '已出运' && ship.inspection_status !== result) {
      const v = db.prepare('SELECT insp_no FROM inspections WHERE id=?').get(vid);
      updateShipment(ctx, ship, { inspection_status: result, inspection_note: result === '不合格' ? `${v.insp_no}：${defects}` : `${v.insp_no} 验货合格` });
    }
    const v = getInspection(ctx, vid);
    log(ctx, 'order', old ? '修改验货单' : '新增验货单', v.insp_no, `${o.order_no} ${result}`);
    return v;
  });
}

// ===================== 成品库存（按订单）/ finished goods per order =====================

/**
 * 货号对应的成品库存档案（没有则自动建，类别“成品”）/ Finished-goods inventory row of a sample (created on demand).
 * @param {object} db
 * @param {number} sampleId
 * @returns {object}
 */
function fgItem(db, sampleId) {
  let inv = db.prepare('SELECT * FROM inventory WHERE sample_id=? ORDER BY id LIMIT 1').get(sampleId);
  if (inv) return inv;
  const s = db.prepare('SELECT * FROM samples WHERE id=?').get(sampleId);
  if (!s) throw new HttpError(400, '货号不存在');
  const ex = db.prepare('SELECT * FROM inventory WHERE code=?').get(s.company_no);
  if (ex) {
    db.prepare('UPDATE inventory SET sample_id=? WHERE id=?').run(s.id, ex.id);
    return { ...ex, sample_id: s.id };
  }
  const cost = num(s.factory_price) > 0 ? num(s.factory_price) : num(s.material_cost) + num(s.labor_cost);
  const id = Number(db.prepare("INSERT INTO inventory(code,name,category,unit,qty,unit_cost,sample_id,warehouse_id) VALUES(?,?,'成品',?,0,?,?,?)")
    .run(s.company_no, s.name, s.unit || 'PC', cost, s.id, stock.defaultWarehouse(db)).lastInsertRowid);
  return db.prepare('SELECT * FROM inventory WHERE id=?').get(id);
}

/** 某订单明细的成品在库（按订单分配）/ finished goods allocated to an order line */
const lineStock = (db, oiId) => round(db.prepare('SELECT COALESCE(SUM(qty),0) v FROM stock_moves WHERE order_item_id=?').get(oiId).v, 4);
/** 某出货单某明细已出库数量（扣除退货）/ net quantity issued for a shipment line */
const shipOut = (db, shipId, oiId, type) => round(-db.prepare('SELECT COALESCE(SUM(qty),0) v FROM stock_moves WHERE shipment_id=? AND order_item_id=? AND type=?').get(shipId, oiId, type).v, 4);

/**
 * 订单成品进出情况 / Finished-goods status of an order.
 * @param {object} ctx
 * @param {any} id 订单ID / order id
 * @returns {object}
 */
function orderFg(ctx, id) {
  const { getOrder } = require('./orders');
  const o = getOrder(ctx, id);
  const { db } = ctx;
  const sum = (oi, type) => round(db.prepare('SELECT COALESCE(SUM(qty),0) v FROM stock_moves WHERE order_item_id=? AND type=?').get(oi, type).v, 4);
  const lines = o.items.map((i) => ({
    order_item_id: i.id, item_no: i.item_no, description: i.description, qty: i.qty, produced_qty: i.produced_qty, shipped_qty: i.shipped_qty, departed_qty: i.departed_qty,
    in_qty: sum(i.id, '产品入库'), out_qty: -sum(i.id, '销售出库'), return_qty: sum(i.id, '销售退货'), stock: lineStock(db, i.id),
  }));
  const shipments = (o.shipments || []).filter((s) => s.status !== '已取消').map((s) => ({
    id: s.id, ship_no: s.ship_no, status: s.status,
    lines: s.items.map((si) => ({ order_item_id: si.order_item_id, item_no: si.item_no, qty: si.qty, out: shipOut(db, s.id, si.order_item_id, '销售出库'), returned: round(db.prepare("SELECT COALESCE(SUM(qty),0) v FROM stock_moves WHERE shipment_id=? AND order_item_id=? AND type='销售退货'").get(s.id, si.order_item_id).v, 4) })),
  }));
  for (const s of shipments) s.out_done = s.lines.every((l) => l.out >= l.qty - 1e-9);
  return { order_id: o.id, order_no: o.order_no, lines, shipments, require_out: setting(db, 'fg_require_out_before_ship', '0') === '1' };
}

/**
 * 出货单销售出库（每行出到“出货数量”为止，不超过该订单明细的在库数）/ Issue finished goods for a shipment.
 * @param {object} ctx
 * @param {object} sh 出货单 / shipment row
 * @param {number|null} whId 仓库（空=自动）/ warehouse
 * @returns {number} 出库行数 / lines issued
 */
function issueShipment(ctx, sh, whId) {
  const { db } = ctx;
  if (sh.status === '已取消') throw new HttpError(409, `出货单${sh.ship_no}已取消`);
  const items = db.prepare('SELECT si.*, oi.sample_id, oi.item_no FROM shipment_items si JOIN order_items oi ON oi.id=si.order_item_id WHERE si.shipment_id=?').all(sh.id);
  let n = 0;
  for (const si of items) {
    const need = round(num(si.qty) - shipOut(db, sh.id, si.order_item_id, '销售出库'), 4);
    if (need <= 1e-9) continue;
    const have = lineStock(db, si.order_item_id);
    if (have + 1e-9 < need) throw new HttpError(409, `货号 ${si.item_no} 本订单在库 ${have}，出货单${sh.ship_no}还需出库 ${need}，请先做“产品入库”`);
    const inv = fgItem(db, si.sample_id);
    stock.stockOut(db, db.prepare('SELECT * FROM inventory WHERE id=?').get(inv.id), whId, need,
      { move_no: sh.ship_no, type: '销售出库', ref_no: sh.ship_no, user_name: ctx.user.name, order_item_id: si.order_item_id, shipment_id: sh.id });
    n++;
  }
  return n;
}

/**
 * 注册仓库作业与验货路由 / Register warehouse & inspection routes.
 * @param {import('../http').Router} r
 */
function register(r) {
  // ---------- 分仓库存 / balances per warehouse ----------
  r.get('/api/stock/balances', (ctx) => {
    need(ctx, 'purchase', 'view');
    const whs = ctx.db.prepare('SELECT id, code, name, type, use_status FROM warehouses ORDER BY id').all();
    const rows = ctx.db.prepare(`SELECT i.id, i.code, i.name, i.category, i.unit, i.qty, i.unit_cost, i.safety_qty, i.warehouse_id, w.name default_warehouse FROM inventory i
      LEFT JOIN warehouses w ON w.id=i.warehouse_id ORDER BY i.code`).all();
    const bal = ctx.db.prepare('SELECT inventory_id, warehouse_id, ROUND(SUM(qty),4) q FROM stock_moves GROUP BY inventory_id, warehouse_id').all();
    for (const r0 of rows) {
      r0.by = {};
      for (const b of bal.filter((x) => x.inventory_id === r0.id)) r0.by[b.warehouse_id] = b.q;
      r0.amount = round(num(r0.qty) * num(r0.unit_cost));
    }
    return { warehouses: whs, rows };
  });

  // ---------- 出入库明细 / stock ledger ----------
  r.get('/api/stock/moves', (ctx) => {
    need(ctx, 'purchase', 'view');
    const rows = ctx.db.prepare(`SELECT m.*, i.code, i.name, i.unit, w.name warehouse_name, ROUND(m.qty*m.unit_cost,2) amount FROM stock_moves m
      JOIN inventory i ON i.id=m.inventory_id LEFT JOIN warehouses w ON w.id=m.warehouse_id ORDER BY m.id DESC LIMIT 5000`).all();
    return { rows };
  });

  // ---------- 其他入库 / 其他出库 / 调拨 / other receipts, issues, transfers ----------
  r.post('/api/stock/in', (ctx) => {
    need(ctx, 'purchase', 'edit');
    const w = warehouse(ctx.db, ctx.body.warehouse_id);
    const lines = (ctx.body.items || []).filter((x) => num(x.qty) > 0);
    if (!lines.length) throw new HttpError(400, '请填写入库物料与数量');
    return tx(ctx.db, () => {
      const no = nextNo(ctx.db, 'RK', 'stock_moves', 'move_no');
      for (const l of lines) stock.stockIn(ctx.db, item(ctx.db, l.inventory_id), w.id, num(l.qty), l.unit_cost === '' ? null : l.unit_cost, { move_no: no, type: ctx.body.type === '盘盈' ? '盘盈' : '其他入库', ref_no: ctx.body.ref_no, remark: ctx.body.remark, user_name: ctx.user.name });
      log(ctx, 'purchase', '其他入库', no, `${w.name} ${lines.length}项`);
      return { move_no: no };
    });
  });
  r.post('/api/stock/out', (ctx) => {
    need(ctx, 'purchase', 'edit');
    const w = warehouse(ctx.db, ctx.body.warehouse_id);
    const lines = (ctx.body.items || []).filter((x) => num(x.qty) > 0);
    if (!lines.length) throw new HttpError(400, '请填写出库物料与数量');
    if (!String(ctx.body.remark || '').trim()) throw new HttpError(400, '请填写出库用途（如：报废、样品领用、退供应商）');
    return tx(ctx.db, () => {
      const no = nextNo(ctx.db, 'CK', 'stock_moves', 'move_no');
      for (const l of lines) stock.stockOut(ctx.db, item(ctx.db, l.inventory_id), w.id, num(l.qty), { move_no: no, type: '其他出库', ref_no: ctx.body.ref_no, remark: ctx.body.remark, user_name: ctx.user.name });
      log(ctx, 'purchase', '其他出库', no, `${w.name} ${lines.length}项：${ctx.body.remark}`);
      return { move_no: no };
    });
  });
  r.post('/api/stock/transfer', (ctx) => {
    need(ctx, 'purchase', 'edit');
    const from = warehouse(ctx.db, ctx.body.from_id);
    const to = warehouse(ctx.db, ctx.body.to_id);
    if (from.id === to.id) throw new HttpError(400, '调出与调入仓库不能相同');
    const lines = (ctx.body.items || []).filter((x) => num(x.qty) > 0);
    if (!lines.length) throw new HttpError(400, '请填写调拨物料与数量');
    return tx(ctx.db, () => {
      const no = nextNo(ctx.db, 'DB', 'stock_moves', 'move_no');
      for (const l of lines) {
        const inv = item(ctx.db, l.inventory_id);
        const q = num(l.qty);
        const have = stock.balance(ctx.db, inv.id, from.id);
        if (have + 1e-9 < q) throw new HttpError(409, `${inv.code} ${inv.name} 在「${from.name}」的库存不足（可用 ${have}${inv.unit || ''}）`);
        const meta = { move_no: no, type: '调拨', ref_no: ctx.body.ref_no, remark: `${from.name} → ${to.name}${ctx.body.remark ? '；' + ctx.body.remark : ''}`, user_name: ctx.user.name, unit_cost: inv.unit_cost };
        stock.writeMove(ctx.db, { ...meta, inventory_id: inv.id, warehouse_id: from.id, qty: -q });
        stock.writeMove(ctx.db, { ...meta, inventory_id: inv.id, warehouse_id: to.id, qty: q });
      }
      log(ctx, 'purchase', '库存调拨', no, `${from.name} → ${to.name} ${lines.length}项`);
      return { move_no: no };
    });
  });

  // ---------- 盘点 / stocktakes ----------
  r.get('/api/stocktakes', (ctx) => {
    need(ctx, 'purchase', 'view');
    return { rows: ctx.db.prepare(`SELECT s.*, w.name warehouse_name, (SELECT COUNT(*) FROM stocktake_items WHERE stocktake_id=s.id) item_count,
      (SELECT COUNT(*) FROM stocktake_items WHERE stocktake_id=s.id AND actual_qty IS NOT NULL) counted FROM stocktakes s LEFT JOIN warehouses w ON w.id=s.warehouse_id ORDER BY s.id DESC`).all() };
  });
  r.get('/api/stocktakes/:id', (ctx) => { need(ctx, 'purchase', 'view'); return getStocktake(ctx.db, ctx.params.id); });
  r.post('/api/stocktakes', (ctx) => {
    need(ctx, 'purchase', 'edit');
    const w = warehouse(ctx.db, ctx.body.warehouse_id);
    if (ctx.db.prepare("SELECT 1 FROM stocktakes WHERE warehouse_id=? AND status='盘点中'").get(w.id)) throw new HttpError(409, `「${w.name}」已有进行中的盘点单，请先完成或作废`);
    return tx(ctx.db, () => {
      const no = nextNo(ctx.db, 'PD', 'stocktakes', 'st_no');
      const id = Number(ctx.db.prepare('INSERT INTO stocktakes(st_no,warehouse_id,remark,user_name) VALUES(?,?,?,?)').run(no, w.id, ctx.body.remark || '', ctx.user.name).lastInsertRowid);
      // 盘点范围：该仓库有流水的物料 + 默认仓库为该仓库的物料 / items with moves here or defaulting here
      const items = ctx.db.prepare(`SELECT id FROM inventory WHERE warehouse_id=? OR id IN (SELECT inventory_id FROM stock_moves WHERE warehouse_id=?) ORDER BY code`).all(w.id, w.id);
      for (const i of items) ctx.db.prepare('INSERT INTO stocktake_items(stocktake_id,inventory_id,book_qty) VALUES(?,?,?)').run(id, i.id, stock.balance(ctx.db, i.id, w.id));
      log(ctx, 'purchase', '新建盘点单', no, `${w.name} ${items.length}项`);
      return getStocktake(ctx.db, id);
    });
  });
  r.put('/api/stocktakes/:id', (ctx) => {
    need(ctx, 'purchase', 'edit');
    const st = getStocktake(ctx.db, ctx.params.id);
    if (st.status !== '盘点中') throw new HttpError(409, '盘点单已结束，不能修改');
    for (const l of ctx.body.items || []) {
      const t = st.items.find((x) => x.id === Number(l.id));
      if (!t) throw new HttpError(400, '盘点明细不存在');
      const v = l.actual_qty === '' || l.actual_qty === null || l.actual_qty === undefined ? null : Number(l.actual_qty);
      if (v !== null && !(v >= 0)) throw new HttpError(400, `${t.code} 实盘数量必须是非负数字`);
      ctx.db.prepare('UPDATE stocktake_items SET actual_qty=?, remark=? WHERE id=?').run(v, l.remark ?? t.remark ?? '', t.id);
    }
    return getStocktake(ctx.db, st.id);
  });
  r.post('/api/stocktakes/:id/confirm', (ctx) => {
    need(ctx, 'purchase', 'audit');
    const st = getStocktake(ctx.db, ctx.params.id);
    if (st.status !== '盘点中') throw new HttpError(409, '盘点单已结束');
    const missing = st.items.filter((t) => t.actual_qty === null);
    if (missing.length) throw new HttpError(400, `还有 ${missing.length} 项未填实盘数量（如 ${missing.slice(0, 3).map((t) => t.code).join('、')}）`);
    return tx(ctx.db, () => {
      let gain = 0;
      let loss = 0;
      for (const t of st.items) {
        const diff = round(num(t.actual_qty) - num(t.book_qty), 4);
        ctx.db.prepare('UPDATE stocktake_items SET book_qty=? WHERE id=?').run(t.book_qty, t.id);
        if (Math.abs(diff) < 1e-9) continue;
        const inv = item(ctx.db, t.inventory_id);
        if (diff > 0) { stock.stockIn(ctx.db, inv, st.warehouse_id, diff, null, { move_no: st.st_no, type: '盘盈', ref_no: st.st_no, remark: t.remark, user_name: ctx.user.name }); gain++; }
        else { stock.stockOut(ctx.db, inv, st.warehouse_id, -diff, { move_no: st.st_no, type: '盘亏', ref_no: st.st_no, remark: t.remark, user_name: ctx.user.name }); loss++; }
      }
      ctx.db.prepare("UPDATE stocktakes SET status='已完成', done_at=datetime('now','localtime') WHERE id=?").run(st.id);
      log(ctx, 'purchase', '盘点确认', st.st_no, `盘盈${gain}项 盘亏${loss}项`);
      return getStocktake(ctx.db, st.id);
    });
  });
  r.post('/api/stocktakes/:id/void', (ctx) => {
    need(ctx, 'purchase', 'edit');
    const st = getStocktake(ctx.db, ctx.params.id);
    if (st.status !== '盘点中') throw new HttpError(409, '盘点单已结束');
    ctx.db.prepare("UPDATE stocktakes SET status='已作废', done_at=datetime('now','localtime') WHERE id=?").run(st.id);
    log(ctx, 'purchase', '作废盘点单', st.st_no);
    return { ok: true };
  });

  // ---------- 成品库存 / finished goods ----------
  r.get('/api/orders/:id/fg', (ctx) => {
    if (ctx.user.scope === 'designer') throw new HttpError(403, '设计师无权查看成品库存');
    need(ctx, 'order', 'view');
    return orderFg(ctx, ctx.params.id);
  });
  // 产品入库（按订单）：入库合计不超过订单数量 / finished goods in per order, capped at the order quantity
  r.post('/api/orders/:id/fg-in', (ctx) => {
    if (!require('../core').can(ctx.user, 'production', 'edit')) need(ctx, 'purchase', 'edit');
    const fg = orderFg(ctx, ctx.params.id);
    const w = warehouse(ctx.db, ctx.body.warehouse_id || stock.defaultWarehouse(ctx.db));
    const lines = (ctx.body.items || []).filter((x) => num(x.qty) > 0);
    if (!lines.length) throw new HttpError(400, '请填写入库数量');
    return tx(ctx.db, () => {
      const no = nextNo(ctx.db, 'CP', 'stock_moves', 'move_no');
      for (const l of lines) {
        const fl = fg.lines.find((x) => x.order_item_id === Number(l.order_item_id));
        if (!fl) throw new HttpError(400, '订单明细不存在');
        if (fl.in_qty + num(l.qty) > fl.qty + 1e-9) throw new HttpError(409, `货号 ${fl.item_no} 入库合计不能超过订单数量 ${fl.qty}（已入库 ${fl.in_qty}）`);
        const oi = ctx.db.prepare('SELECT sample_id FROM order_items WHERE id=?').get(fl.order_item_id);
        const inv = fgItem(ctx.db, oi.sample_id);
        stock.stockIn(ctx.db, ctx.db.prepare('SELECT * FROM inventory WHERE id=?').get(inv.id), w.id, num(l.qty), l.unit_cost === '' || l.unit_cost === undefined ? null : l.unit_cost,
          { move_no: no, type: '产品入库', ref_no: fg.order_no, remark: ctx.body.remark, user_name: ctx.user.name, order_item_id: fl.order_item_id });
      }
      log(ctx, 'production', '产品入库', fg.order_no, `${w.name} ${lines.length}项`);
      return orderFg(ctx, ctx.params.id);
    });
  });
  // 销售出库（按出货单）/ sales issue per shipment
  r.post('/api/shipments/:id/fg-out', (ctx) => {
    need(ctx, 'order', 'edit');
    const sh = ctx.db.prepare('SELECT * FROM shipments WHERE id=?').get(ctx.params.id);
    if (!sh) throw new HttpError(404, '出货单不存在');
    require('./orders').getOrder(ctx, sh.order_id);
    const n = tx(ctx.db, () => issueShipment(ctx, sh, Number(ctx.body.warehouse_id) || null));
    if (!n) throw new HttpError(409, `出货单${sh.ship_no}已全部出库`);
    log(ctx, 'order', '销售出库', sh.ship_no, `${n}行`);
    return orderFg(ctx, sh.order_id);
  });
  // 按发票出库：发票下所有出货单一起出库 / issue all shipments of an invoice
  r.post('/api/ship-invoices/:id/fg-out', (ctx) => {
    need(ctx, 'order', 'edit');
    const inv = require('./shipping').getInvoice(ctx, ctx.params.id);
    const n = tx(ctx.db, () => inv.shipments.reduce((a, s) => a + issueShipment(ctx, ctx.db.prepare('SELECT * FROM shipments WHERE id=?').get(s.id), Number(ctx.body.warehouse_id) || null), 0));
    if (!n) throw new HttpError(409, `发票${inv.invoice_no}下的出货单已全部出库`);
    log(ctx, 'order', '按发票销售出库', inv.invoice_no, `${n}行`);
    return { ok: true, lines: n };
  });
  // 销售退货：已出库的货退回仓库，退回后重新计入该订单在库 / sales return back into stock
  r.post('/api/shipments/:id/fg-return', (ctx) => {
    need(ctx, 'order', 'edit');
    const sh = ctx.db.prepare('SELECT * FROM shipments WHERE id=?').get(ctx.params.id);
    if (!sh) throw new HttpError(404, '出货单不存在');
    require('./orders').getOrder(ctx, sh.order_id);
    if (!String(ctx.body.reason || '').trim()) throw new HttpError(400, '请填写退货原因');
    const w = warehouse(ctx.db, ctx.body.warehouse_id || stock.defaultWarehouse(ctx.db));
    const lines = (ctx.body.items || []).filter((x) => num(x.qty) > 0);
    if (!lines.length) throw new HttpError(400, '请填写退货数量');
    return tx(ctx.db, () => {
      for (const l of lines) {
        const oiId = Number(l.order_item_id);
        const si = ctx.db.prepare('SELECT si.*, oi.sample_id, oi.item_no FROM shipment_items si JOIN order_items oi ON oi.id=si.order_item_id WHERE si.shipment_id=? AND si.order_item_id=?').get(sh.id, oiId);
        if (!si) throw new HttpError(400, '退货货号不在该出货单中');
        const out = shipOut(ctx.db, sh.id, oiId, '销售出库');
        const back = round(ctx.db.prepare("SELECT COALESCE(SUM(qty),0) v FROM stock_moves WHERE shipment_id=? AND order_item_id=? AND type='销售退货'").get(sh.id, oiId).v, 4);
        if (back + num(l.qty) > out + 1e-9) throw new HttpError(409, `货号 ${si.item_no} 退货数量超过已出库数量（已出库 ${out}，已退 ${back}）`);
        const inv = fgItem(ctx.db, si.sample_id);
        stock.stockIn(ctx.db, ctx.db.prepare('SELECT * FROM inventory WHERE id=?').get(inv.id), w.id, num(l.qty), null,
          { move_no: sh.ship_no, type: '销售退货', ref_no: sh.ship_no, remark: ctx.body.reason, user_name: ctx.user.name, order_item_id: oiId, shipment_id: sh.id });
      }
      log(ctx, 'order', '销售退货', sh.ship_no, `${lines.length}行：${ctx.body.reason}`);
      return orderFg(ctx, sh.order_id);
    });
  });

  // ---------- 验货单 / inspections ----------
  r.get('/api/inspections', (ctx) => {
    need(ctx, 'order', 'view');
    if (ctx.user.scope === 'designer') throw new HttpError(403, '设计师无权查看验货单');
    const own = ctx.user.scope === 'own' ? ' WHERE o.salesman_id=' + Number(ctx.user.employee_id || -1) : '';
    return { rows: ctx.db.prepare(`SELECT v.*, o.order_no, c.name customer_name, e.name salesman_name, s.ship_no FROM inspections v JOIN orders o ON o.id=v.order_id
      LEFT JOIN customers c ON c.id=o.customer_id LEFT JOIN employees e ON e.id=o.salesman_id LEFT JOIN shipments s ON s.id=v.shipment_id${own} ORDER BY v.id DESC LIMIT 2000`).all() };
  });
  r.get('/api/inspections/:id', (ctx) => { need(ctx, 'order', 'view'); return getInspection(ctx, ctx.params.id); });
  r.post('/api/inspections', (ctx) => { need(ctx, 'order', 'edit'); return saveInspection(ctx); });
  r.put('/api/inspections/:id', (ctx) => { need(ctx, 'order', 'edit'); return saveInspection(ctx, ctx.params.id); });
}

module.exports = { register, RESULTS, INSP_TYPES, orderFg, fgItem };
