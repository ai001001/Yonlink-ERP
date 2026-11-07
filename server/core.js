'use strict';
/**
 * 公共能力：权限校验、操作日志、单号生成、事务
 * Shared helpers: permission checks, audit logs, document numbering, transactions.
 * @module server/core
 */
const { HttpError } = require('./http');

/**
 * 当前日期 YYYY-MM-DD（本地时区）/ Today's date in local time.
 * @param {number} [offsetDays] 偏移天数 / day offset
 * @returns {string}
 */
function today(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 判断用户是否拥有某模块某操作权限（模块停用则一律无权限）
 * Whether the user may perform an action on a module (disabled modules deny all).
 * @param {object} user 当前用户 / current user
 * @param {string} module 模块键 / module key
 * @param {string} action 动作 / action
 * @returns {boolean}
 */
function can(user, module, action) {
  if (!user) return false;
  if (!user.enabledModules.has(module)) return false;
  return (user.perms[module] || []).includes(action);
}

/**
 * 强制权限校验，不满足抛出 403 / Assert permission or throw 403.
 * @param {object} ctx 请求上下文 / request context
 * @param {string} module
 * @param {string} action
 */
function need(ctx, module, action) {
  if (!ctx.user.enabledModules.has(module)) {
    const m = ctx.db.prepare('SELECT name FROM modules WHERE key=?').get(module);
    throw new HttpError(403, `【${m ? m.name : module}】模块已停用，请联系管理员启用`);
  }
  if (!can(ctx.user, module, action)) {
    const names = { view: '查看', add: '新增', edit: '修改', delete: '删除', export: '导出', print: '打印', audit: '审核' };
    throw new HttpError(403, `无权限：您的岗位没有该模块的【${names[action] || action}】权限`);
  }
}

/**
 * 记录操作日志 / Write an audit log entry.
 * @param {object} ctx
 * @param {string} module 模块 / module
 * @param {string} action 动作描述 / action
 * @param {string} [target] 对象（单号等）/ target
 * @param {any} [detail] 详情 / detail
 */
function log(ctx, module, action, target = '', detail = '') {
  ctx.db.prepare('INSERT INTO logs(type,user_name,module,action,target,detail,ip) VALUES(?,?,?,?,?,?,?)').run(
    'op', ctx.user ? ctx.user.name : '', module, action, String(target ?? ''),
    typeof detail === 'string' ? detail : JSON.stringify(detail), ctx.ip || '',
  );
}

/**
 * 生成单号：前缀+日期+3位流水 / Generate a document number: prefix + date + 3-digit sequence.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} prefix 前缀，如 QT / prefix
 * @param {string} table 表名 / table
 * @param {string} col 单号字段 / number column
 * @returns {string}
 */
function nextNo(db, prefix, table, col) {
  const base = prefix + today().replace(/-/g, '');
  const row = db.prepare(`SELECT ${col} AS no FROM ${table} WHERE ${col} LIKE ? ORDER BY ${col} DESC LIMIT 1`).get(base + '-%');
  const seq = row ? parseInt(String(row.no).slice(base.length + 1), 10) + 1 : 1;
  return `${base}-${String(seq).padStart(3, '0')}`;
}

/**
 * 在事务中执行 / Run a function inside a transaction.
 * @template T
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {() => T} fn
 * @returns {T}
 */
function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * 数字取值（空值为0）/ Coerce to number (empty → 0).
 * @param {any} v
 * @returns {number}
 */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 四舍五入保留小数 / Round to given decimals.
 * @param {number} v
 * @param {number} [d]
 * @returns {number}
 */
function round(v, d = 2) {
  const f = 10 ** d;
  return Math.round((num(v) + Number.EPSILON) * f) / f;
}

/**
 * 必填校验 / Validate required fields.
 * @param {object} obj 数据 / data
 * @param {Object<string,string>} fields 字段→中文名 / field → label
 */
function required(obj, fields) {
  for (const [k, label] of Object.entries(fields)) {
    if (obj[k] === undefined || obj[k] === null || String(obj[k]).trim() === '') {
      throw new HttpError(400, `请填写【${label}】`);
    }
  }
}

/**
 * 读取样品并校验是否被新货号锁定 / Load a sample and reject it if locked by a new item number.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} sampleId 样品ID / sample id
 * @param {string} usage 用途描述（报价/下单/出货）/ usage label
 * @returns {object} 样品 / sample row
 */
function assertSampleUsable(db, sampleId, usage) {
  const s = db.prepare('SELECT * FROM samples WHERE id=?').get(sampleId);
  if (!s) throw new HttpError(400, `样品不存在（ID ${sampleId}）`);
  if (s.status === '已锁定') {
    const repl = db.prepare('SELECT company_no FROM samples WHERE parent_no=? ORDER BY id DESC LIMIT 1').get(s.company_no);
    throw new HttpError(409, `旧货号【${s.company_no}】已被新货号【${repl ? repl.company_no : '-'}】替代并锁定，禁止用于${usage}，请改用新货号`);
  }
  return s;
}

/**
 * 出货校验：旧货号锁定只约束锁定之后创建的订单；锁定前已确认的订单可继续出货
 * Shipping check: a locked item only blocks orders created after the lock; orders confirmed earlier may still ship.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} sampleId 样品ID / sample id
 * @param {{created_at:string, order_no:string}} order 订单 / order
 */
function assertSampleShippable(db, sampleId, order) {
  const s = db.prepare('SELECT * FROM samples WHERE id=?').get(sampleId);
  if (s && s.status === '已锁定' && s.locked_at && String(order.created_at) < String(s.locked_at)) return s;
  return assertSampleUsable(db, sampleId, '出货');
}

/**
 * 读取系统参数 / Read a system setting.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} key
 * @param {string} [def]
 * @returns {string}
 */
function setting(db, key, def = '') {
  const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return r ? r.value : def;
}

/**
 * 默认包装方案同步到样品档案的包装资料，并取消同一样品的其它默认方案
 * Sync a default package plan to the sample's packing fields and clear other defaults of that sample.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} m 方案（合并后的完整字段）/ the plan with all fields
 * @param {number} [planId] 方案ID（新增时为空）/ plan id (empty when inserting)
 */
function syncDefaultPackage(db, m, planId) {
  db.prepare("UPDATE sample_packages SET is_default='否' WHERE sample_id=? AND id<>?").run(m.sample_id, planId || -1);
  db.prepare(`UPDATE samples SET pack_inner=?, pack_middle=?, pcs_per_carton=?, outer_l=?, outer_w=?, outer_h=?, cbm=?, gross_weight=?, net_weight=?,
    package_req=COALESCE(?, package_req) WHERE id=?`).run(m.inner_qty ?? null, m.middle_qty ?? null, m.outer_qty, m.outer_l ?? null, m.outer_w ?? null, m.outer_h ?? null,
    m.cbm ?? null, m.gw ?? null, m.nw ?? null, m.package_req || m.name || null, m.sample_id);
}

module.exports = { today, can, need, log, nextNo, tx, num, round, required, assertSampleUsable, assertSampleShippable, setting, syncDefaultPackage };
