'use strict';
/**
 * 库存流水公共函数：所有库存数量变化都记一条流水（入库为正、出库为负），按仓库可查余额；
 * 物料档案的 qty 始终等于全部流水之和（数据审计校验）
 * Stock-move helpers: every quantity change writes a move (+in / −out) so balances per warehouse can be queried;
 * inventory.qty always equals the sum of its moves (checked by the data audit).
 * @module server/stock
 */
const { HttpError } = require('./http');
const { num, round } = require('./core');

/**
 * 默认仓库（物料自身默认仓库，否则第一个仓库）/ Default warehouse of an item, else the first warehouse.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} [inv] 物料 / inventory row
 * @returns {number}
 */
function defaultWarehouse(db, inv) {
  if (inv && inv.warehouse_id) return inv.warehouse_id;
  const w = db.prepare("SELECT id FROM warehouses WHERE COALESCE(use_status,'启用')='启用' ORDER BY id LIMIT 1").get() || db.prepare('SELECT id FROM warehouses ORDER BY id LIMIT 1').get();
  if (!w) throw new HttpError(400, '请先建立仓库');
  return w.id;
}

/**
 * 某物料在某仓库的余额 / Balance of an item in a warehouse.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} invId
 * @param {number} whId
 * @returns {number}
 */
function balance(db, invId, whId) {
  return round(db.prepare('SELECT COALESCE(SUM(qty),0) v FROM stock_moves WHERE inventory_id=? AND warehouse_id=?').get(invId, whId).v, 4);
}

/**
 * 写一条流水 / Write one stock move.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} m {move_no, type, inventory_id, warehouse_id, qty, unit_cost, ref_no, remark, user_name}
 */
function writeMove(db, m) {
  db.prepare('INSERT INTO stock_moves(move_no,type,inventory_id,warehouse_id,qty,unit_cost,ref_no,remark,user_name) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(m.move_no || '', m.type, m.inventory_id, m.warehouse_id, round(m.qty, 4), num(m.unit_cost), m.ref_no || '', m.remark || '', m.user_name || '');
}

/**
 * 入库：加权平均更新单位成本 / Stock in with weighted-average cost.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} inv 物料 / inventory row
 * @param {number} whId 仓库 / warehouse
 * @param {number} qty 数量（>0）/ quantity
 * @param {number|null} cost 单位成本，空则沿用 / unit cost (null keeps the current cost)
 * @param {object} meta {move_no, type, ref_no, remark, user_name}
 */
function stockIn(db, inv, whId, qty, cost, meta) {
  const q = num(qty);
  if (!(q > 0)) throw new HttpError(400, `${inv.name} 入库数量必须大于0`);
  const c = cost === null || cost === undefined || cost === '' ? num(inv.unit_cost) : num(cost);
  const newQty = num(inv.qty) + q;
  const avg = newQty > 0 ? round((num(inv.qty) * num(inv.unit_cost) + q * c) / newQty, 4) : c;
  db.prepare('UPDATE inventory SET qty=?, unit_cost=? WHERE id=?').run(round(newQty, 4), avg, inv.id);
  writeMove(db, { ...meta, inventory_id: inv.id, warehouse_id: whId, qty: q, unit_cost: c });
}

/**
 * 出库：指定仓库时只从该仓库出；未指定时先默认仓库再其它仓库 / Stock out from a warehouse, or greedily across warehouses.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} inv 物料 / inventory row
 * @param {number|null} whId 仓库（空=自动）/ warehouse or null for automatic
 * @param {number} qty 数量（>0）/ quantity
 * @param {object} meta {move_no, type, ref_no, remark, user_name}
 */
function stockOut(db, inv, whId, qty, meta) {
  let left = num(qty);
  if (!(left > 0)) throw new HttpError(400, `${inv.name} 出库数量必须大于0`);
  const order = whId ? [whId] : [defaultWarehouse(db, inv), ...db.prepare('SELECT id FROM warehouses ORDER BY id').all().map((w) => w.id)].filter((v, i, a) => a.indexOf(v) === i);
  const avail = order.map((w) => [w, balance(db, inv.id, w)]);
  const total = avail.reduce((a, [, b]) => a + Math.max(0, b), 0);
  if (total + 1e-9 < left) {
    const wn = whId ? (db.prepare('SELECT name FROM warehouses WHERE id=?').get(whId) || {}).name : '各仓库';
    throw new HttpError(409, `${inv.code} ${inv.name} 在${wn}的库存不足（可用 ${round(total, 4)}${inv.unit || ''}，需要 ${left}）`);
  }
  for (const [w, b] of avail) {
    if (left <= 1e-9) break;
    const take = Math.min(left, Math.max(0, b));
    if (take <= 0) continue;
    writeMove(db, { ...meta, inventory_id: inv.id, warehouse_id: w, qty: -take, unit_cost: inv.unit_cost });
    left = round(left - take, 6);
  }
  db.prepare('UPDATE inventory SET qty=? WHERE id=?').run(round(num(inv.qty) - num(qty), 4), inv.id);
}

/**
 * 手工调整物料数量（档案界面直接改库存数）记为“库存调整”流水 / Record a manual quantity change from the item form.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} inv 修改后的物料 / item after the change
 * @param {number} before 修改前数量 / quantity before
 * @param {string} user
 */
function recordAdjust(db, inv, before, user) {
  const diff = round(num(inv.qty) - num(before), 4);
  if (Math.abs(diff) < 1e-9) return;
  writeMove(db, { move_no: 'ADJ', type: num(before) === 0 && !db.prepare('SELECT 1 FROM stock_moves WHERE inventory_id=?').get(inv.id) ? '期初' : '库存调整',
    inventory_id: inv.id, warehouse_id: defaultWarehouse(db, inv), qty: diff, unit_cost: inv.unit_cost, remark: '物料档案中直接修改库存数量', user_name: user });
}

module.exports = { defaultWarehouse, balance, writeMove, stockIn, stockOut, recordAdjust };
