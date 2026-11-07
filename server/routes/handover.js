'use strict';
/**
 * 业务交接（参照亿星“业务交接/人员交接”）：员工离职或调岗时，把客户、跟单、单据一键转交给其他员工
 * Business handover (modelled on 亿星): transfer customers, merchandising and documents from one employee to another in one step.
 * @module server/routes/handover
 */
const { HttpError } = require('../http');
const { need, log, tx } = require('../core');

/**
 * 可交接的内容。open 为“未完结”条件，只交接未完结单据时使用
 * Transferable items; `open` is the "not finished" condition used when history is excluded.
 */
const SCOPES = {
  customers: { label: '客户（业务员）', table: 'customers', field: 'salesman_id' },
  merchandise: { label: '客户（跟单员）', table: 'customers', field: 'merchandiser_id' },
  quotes: { label: '报价单', table: 'quotes', field: 'salesman_id', open: "status NOT IN ('已成交','已失效')" },
  orders: { label: '销售订单', table: 'orders', field: 'salesman_id', open: "status NOT IN ('已完成')" },
  sends: { label: '送样单', table: 'sample_sends', field: 'salesman_id', open: "status NOT IN ('客户确认','客户拒绝')" },
  samples: { label: '样品（设计师）', table: 'samples', field: 'designer_id', note: '会改变设计师提成归属，请谨慎' },
};

/**
 * 统计各项可交接数量 / Count transferable records per scope.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} from 交出员工 / employee handing over
 * @returns {object[]}
 */
function countScopes(db, from) {
  return Object.entries(SCOPES).map(([key, s]) => ({
    key, label: s.label, note: s.note || '', has_open: !!s.open,
    all: db.prepare(`SELECT COUNT(*) c FROM ${s.table} WHERE ${s.field}=?`).get(from).c,
    open: s.open ? db.prepare(`SELECT COUNT(*) c FROM ${s.table} WHERE ${s.field}=? AND ${s.open}`).get(from).c : null,
  }));
}

/**
 * 读取员工 / Load an employee or fail.
 * @param {object} ctx
 * @param {any} id
 * @param {string} role 角色说明 / role wording for the error
 * @returns {object}
 */
function employee(ctx, id, role) {
  const e = ctx.db.prepare('SELECT id, name, emp_no, status FROM employees WHERE id=?').get(Number(id));
  if (!e) throw new HttpError(400, `请选择${role}`);
  return e;
}

/**
 * 注册业务交接路由 / Register handover routes.
 * @param {import('../http').Router} r
 */
function register(r) {
  r.get('/api/handover/preview', (ctx) => {
    need(ctx, 'system', 'edit');
    const from = employee(ctx, ctx.query.from, '交出人');
    return { from, scopes: countScopes(ctx.db, from.id) };
  });

  r.post('/api/handover', (ctx) => {
    need(ctx, 'system', 'edit');
    const b = ctx.body;
    const from = employee(ctx, b.from_emp_id, '交出人');
    const to = employee(ctx, b.to_emp_id, '接收人');
    if (from.id === to.id) throw new HttpError(400, '交出人和接收人不能是同一个人');
    if (to.status === '离职') throw new HttpError(400, `接收人「${to.name}」已离职，不能接收业务`);
    const keys = (Array.isArray(b.scopes) ? b.scopes : []).filter((k) => SCOPES[k]);
    if (!keys.length) throw new HttpError(400, '请至少选择一项要交接的内容');
    const history = b.include_history !== false;
    const counts = {};
    tx(ctx.db, () => {
      for (const k of keys) {
        const s = SCOPES[k];
        const cond = !history && s.open ? ` AND ${s.open}` : '';
        counts[k] = Number(ctx.db.prepare(`UPDATE ${s.table} SET ${s.field}=? WHERE ${s.field}=?${cond}`).run(to.id, from.id).changes);
      }
      if (b.mark_left) ctx.db.prepare("UPDATE employees SET status='离职' WHERE id=?").run(from.id);
      ctx.db.prepare('INSERT INTO handovers(from_emp_id,to_emp_id,from_name,to_name,scopes,counts,reason,user_name) VALUES(?,?,?,?,?,?,?,?)')
        .run(from.id, to.id, from.name, to.name, JSON.stringify({ keys, history, mark_left: !!b.mark_left }), JSON.stringify(counts), String(b.reason || '').slice(0, 500), ctx.user.name);
    });
    const text = keys.map((k) => `${SCOPES[k].label}${counts[k]}`).join('、');
    log(ctx, 'system', '业务交接', `${from.name} → ${to.name}`, `${history ? '含历史单据' : '仅未完结单据'}：${text}${b.mark_left ? '；交出人已设为离职' : ''}`);
    return { ok: true, counts, labels: Object.fromEntries(keys.map((k) => [k, SCOPES[k].label])) };
  });

  r.get('/api/handovers', (ctx) => {
    need(ctx, 'system', 'view');
    return ctx.db.prepare('SELECT * FROM handovers ORDER BY id DESC LIMIT 200').all().map((h) => {
      const sc = JSON.parse(h.scopes || '{}');
      const counts = JSON.parse(h.counts || '{}');
      return { ...h, history: sc.history, mark_left: sc.mark_left, detail: Object.entries(counts).map(([k, n]) => `${(SCOPES[k] || {}).label || k} ${n}`).join('、') };
    });
  });
}

module.exports = { register, SCOPES };
