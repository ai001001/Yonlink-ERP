'use strict';
/**
 * 基础路由：登录鉴权、元数据、通用档案增删改查、系统管理、导出、审批、工作台
 * Base routes: auth, metadata, generic CRUD, system admin, export, approvals, dashboard.
 * @module server/routes/base
 */
const crypto = require('node:crypto');
const { HttpError } = require('../http');
const { can, need, log, tx, required, today, num, syncDefaultPackage } = require('../core');
const { ENTITIES, REF_LABEL, CHILDREN } = require('../entities');
const { hashPassword, ACTIONS } = require('../db');
const { tableXlsx } = require('../xlsx');
const { DEMO_ACCOUNTS, POLICY_TEXT, passwordProblems, generatePassword, safeEqual, rateLimiter } = require('../security');


/**
 * 校验密码是否正确（固定时间比较）/ Verify a password with constant-time comparison.
 * @param {object} u 用户行 / user row
 * @param {string} password
 * @returns {boolean}
 */
const verifyPassword = (u, password) => safeEqual(hashPassword(password, u.salt).hash, u.password_hash);

/**
 * 校验新密码强度，不合格抛 400 / Assert a new password is strong enough.
 * @param {string} pw
 * @param {string} username
 */
function assertStrongPassword(pw, username) {
  const p = passwordProblems(pw, username);
  if (p.length) throw new HttpError(400, `密码强度不足：${p.join('、')}。要求：${POLICY_TEXT}`);
}

/** 必须先改密码时仍允许访问的接口 / endpoints allowed while a password change is pending */
const FRESH_EXEMPT = new Set(['/api/password', '/api/logout', '/api/meta', '/api/public/login-info', '/api/public/demo-login']);

/**
 * 初始/临时/弱密码账号在修改密码前禁止使用业务功能
 * Block business endpoints until a temporary or weak password has been changed.
 * @param {object} ctx
 * @param {string} pathname
 */
function assertPasswordFresh(ctx, pathname) {
  if (ctx.user && ctx.user.must_change && !FRESH_EXEMPT.has(pathname)) {
    throw new HttpError(403, '为了账号安全，请先修改初始密码/临时密码后再使用系统', { code: 'MUST_CHANGE_PASSWORD' });
  }
}

const SESSION_TTL = 12 * 3600 * 1000;

/**
 * 根据令牌加载当前用户 / Load the current user from a session token.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} token
 * @returns {object|null}
 */
function loadUser(db, token) {
  if (!token) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE token=?').get(token);
  if (!s || s.expires_at < Date.now()) return null;
  const u = db.prepare(`SELECT u.*, r.code role_code, r.name role_name, r.data_scope, r.perms FROM users u LEFT JOIN roles r ON r.id=u.role_id WHERE u.id=?`).get(s.user_id);
  if (!u || u.status !== '启用') return null;
  const enabled = new Set(db.prepare('SELECT key FROM modules WHERE enabled=1').all().map((r) => r.key));
  enabled.add('system');
  let perms = {};
  try { perms = JSON.parse(u.perms || '{}'); } catch { perms = {}; }
  return {
    id: u.id, username: u.username, name: u.name, role_code: u.role_code, role_name: u.role_name, must_change: !!u.must_change_password,
    scope: u.data_scope || 'all', employee_id: u.employee_id, perms, enabledModules: enabled,
  };
}

/**
 * 生成数据范围过滤条件 / Build the data-scope WHERE clause for the current user.
 * @param {object} ctx
 * @param {object} [scopeDef] 实体的 scope 定义 / entity scope definition
 * @param {string} [alias] 表别名 / table alias
 * @returns {{sql:string, params:any[]}}
 */
function scopeClause(ctx, scopeDef, alias = '') {
  const s = scopeDef && scopeDef[ctx.user.scope];
  if (!s) return { sql: '', params: [] };
  const params = [];
  let sql = s.replace(/:(emp|uid)/g, (_, k) => { params.push(k === 'uid' ? ctx.user.id : (ctx.user.employee_id || -1)); return '?'; });
  if (alias) sql = sql.replace(/^(\(?)(\w+)\b/, `$1${alias}.$2`);
  return { sql, params };
}

/** 表示“空值”的筛选值 / Filter value standing for "blank" */
const BLANK = '__BLANK__';

/**
 * 解析列表筛选条件（数据范围、关键字、导航树、快速查找、自动过滤）
 * Build the WHERE clause for entity lists: scope, keyword, tree node, quick search and auto filters.
 * 参数约定 / params: q=关键字, f_字段=精确值(导航树), l_字段=包含(快速查找), in_字段=JSON数组(自动过滤)
 * @param {object} ctx
 * @param {object} ent 实体定义 / entity definition
 * @param {object} q 查询参数 / query params
 * @param {string} [skip] 不参与筛选的字段（用于计算该列的可选值）/ field excluded (when listing its own values)
 * @returns {{sql:string, params:any[]}}
 */
function entityWhere(ctx, ent, q, skip) {
  const where = [];
  const params = [];
  const sc = scopeClause(ctx, ent.scope, 't');
  if (sc.sql) { where.push(sc.sql); params.push(...sc.params); }
  if (q.q && ent.search) {
    where.push('(' + ent.search.map((c) => `t.${c} LIKE ?`).join(' OR ') + ')');
    for (let i = 0; i < ent.search.length; i++) params.push(`%${q.q}%`);
  }
  const blank = (c) => `(t.${c} IS NULL OR t.${c} = '')`;
  for (const fd of ent.fields) {
    const c = fd.name;
    const v = q['f_' + c];
    if (v !== undefined && v !== '') {
      if (v === BLANK) where.push(blank(c)); else { where.push(`t.${c} = ?`); params.push(v); }
    }
    const like = q['l_' + c];
    if (like !== undefined && String(like).trim() !== '') {
      if (fd.type === 'ref') {
        const r = REF_LABEL[fd.ref];
        where.push(`t.${c} IN (SELECT ${r.pk || 'id'} FROM ${r.table} WHERE ${r.label} LIKE ?)`);
      } else where.push(`t.${c} LIKE ?`);
      params.push(`%${String(like).trim()}%`);
    }
    const inv = q['in_' + c];
    if (inv !== undefined && inv !== '' && c !== skip) {
      let list;
      try { list = JSON.parse(inv); } catch { throw new HttpError(400, `筛选条件格式错误：${fd.label}`); }
      if (!Array.isArray(list) || !list.length) continue;
      const numeric = fd.type === 'number' || (fd.type === 'ref' && !REF_LABEL[fd.ref].pk);
      const vals = list.filter((x) => x !== BLANK).slice(0, 500).map((x) => (numeric ? Number(x) : String(x)));
      const parts = [];
      if (vals.length) { parts.push(`${numeric ? `t.${c}` : `CAST(t.${c} AS TEXT)`} IN (${vals.map(() => '?').join(',')})`); params.push(...vals); }
      if (list.includes(BLANK)) parts.push(blank(c));
      where.push('(' + parts.join(' OR ') + ')');
    }
  }
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}

/**
 * 引用字段显示名的 SQL 片段 / SQL fragments selecting display labels of ref fields.
 * @param {object} ent
 * @returns {string[]}
 */
function refCols(ent) {
  return ent.fields.filter((fd) => fd.type === 'ref').map((fd) => {
    const r = REF_LABEL[fd.ref];
    return `(SELECT ${r.label} FROM ${r.table} x WHERE x.${r.pk || 'id'} = t.${fd.name}) AS ${fd.name}_label`;
  });
}

/**
 * 查询实体列表（含引用字段显示名，支持排序）/ List entity rows with ref labels and optional sorting.
 * @param {object} ctx
 * @param {string} key 实体键 / entity key
 * @param {object} q 查询参数 / query params (sort, dir, page, size + filters)
 * @returns {{rows:object[], total:number}}
 */
function listEntity(ctx, key, q) {
  const ent = ENTITIES[key];
  const { sql: w, params } = entityWhere(ctx, ent, q);
  const rc = refCols(ent);
  const pk = ent.pk || 'id';
  const total = ctx.db.prepare(`SELECT COUNT(*) c FROM ${ent.table} t ${w}`).get(...params).c;
  const size = Math.min(500, Math.max(1, parseInt(q.size || '50', 10)));
  const page = Math.max(1, parseInt(q.page || '1', 10));
  let order = ent.order ? ent.order.replace(/(\w+)/, 't.$1') : `t.${pk}`;
  const sf = q.sort && ent.fields.find((fd) => fd.name === q.sort);
  if (sf) {
    const dir = q.dir === 'desc' ? 'DESC' : 'ASC';
    const expr = sf.type === 'ref' ? `${sf.name}_label` : `t.${sf.name}`;
    // 空值排在最后 / blanks last
    order = `(${expr} IS NULL OR ${expr} = '') ASC, ${expr} ${dir}, t.${pk} ${dir}`;
  }
  const rows = ctx.db.prepare(`SELECT t.*${pk === 'id' ? '' : `, t.${pk} AS id`}${rc.length ? ', ' + rc.join(', ') : ''} FROM ${ent.table} t ${w} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(...params, size, (page - 1) * size);
  if (key === 'inventory') {
    for (const r of rows) r.alert = r.qty < r.safety_qty ? '缺料预警' : (r.max_qty > 0 && r.qty > r.max_qty ? '积压预警' : '正常');
  }
  return { rows, total };
}

/**
 * 校验字段名属于实体 / Validate that field names belong to the entity.
 * @param {object} ent
 * @param {string[]} names
 * @returns {object[]} 字段定义 / field definitions
 */
function fieldsOf(ent, names) {
  return names.map((n) => {
    const fd = ent.fields.find((x) => x.name === n);
    if (!fd || fd.type === 'textarea') throw new HttpError(400, `不能按该字段分组/筛选：${n}`);
    return fd;
  });
}

/**
 * 导航树分组计数（最多3级）/ Group counts for the navigation tree (up to 3 levels).
 * @param {object} ctx
 * @param {string} key
 * @param {object} q 查询参数，by=字段1,字段2 / query with by=field list
 * @returns {{groups:{v:any[], l:string[], n:number}[], total:number}}
 */
function groupEntity(ctx, key, q) {
  const ent = ENTITIES[key];
  const by = String(q.by || '').split(',').filter(Boolean).slice(0, 3);
  if (!by.length) throw new HttpError(400, '请指定分组字段');
  const fds = fieldsOf(ent, by);
  const { sql: w, params } = entityWhere(ctx, ent, q);
  const sel = fds.map((fd, i) => {
    const lab = fd.type === 'ref' ? `(SELECT ${REF_LABEL[fd.ref].label} FROM ${REF_LABEL[fd.ref].table} x WHERE x.${REF_LABEL[fd.ref].pk || 'id'} = t.${fd.name})` : `t.${fd.name}`;
    return `t.${fd.name} AS v${i}, ${lab} AS l${i}`;
  }).join(', ');
  const grp = fds.map((_, i) => `v${i}`).join(', ');
  const rows = ctx.db.prepare(`SELECT ${sel}, COUNT(*) n FROM ${ent.table} t ${w} GROUP BY ${grp} ORDER BY ${fds.map((_, i) => `(l${i} IS NULL OR l${i}='') ASC, l${i}`).join(', ')} LIMIT 5000`).all(...params);
  const groups = rows.map((r) => ({
    v: fds.map((_, i) => (r[`v${i}`] === null || r[`v${i}`] === '' ? BLANK : r[`v${i}`])),
    l: fds.map((_, i) => (r[`l${i}`] === null || r[`l${i}`] === '' ? '(空)' : String(r[`l${i}`]))),
    n: r.n,
  }));
  return { groups, total: groups.reduce((a, g) => a + g.n, 0) };
}

/**
 * 某列的可选值（自动过滤下拉）/ Distinct values of one column for the auto-filter dropdown.
 * @param {object} ctx
 * @param {string} key
 * @param {object} q 查询参数，field=字段 / query with field
 * @returns {{v:any, l:string, n:number}[]}
 */
function distinctEntity(ctx, key, q) {
  const ent = ENTITIES[key];
  const [fd] = fieldsOf(ent, [String(q.field || '')]);
  const { sql: w, params } = entityWhere(ctx, ent, q, fd.name);
  const lab = fd.type === 'ref' ? `(SELECT ${REF_LABEL[fd.ref].label} FROM ${REF_LABEL[fd.ref].table} x WHERE x.${REF_LABEL[fd.ref].pk || 'id'} = t.${fd.name})` : `t.${fd.name}`;
  return ctx.db.prepare(`SELECT t.${fd.name} v, ${lab} l, COUNT(*) n FROM ${ent.table} t ${w} GROUP BY t.${fd.name} ORDER BY (l IS NULL OR l='') ASC, l LIMIT 500`).all(...params)
    .map((r) => ({ v: r.v === null || r.v === '' ? BLANK : r.v, l: r.l === null || r.l === '' ? '(空)' : String(r.l), n: r.n }));
}

/**
 * 读取一条实体（含数据范围校验）/ Get one entity row honoring data scope.
 * @param {object} ctx
 * @param {string} key
 * @param {string|number} id
 * @returns {object}
 */
function getEntity(ctx, key, id) {
  const ent = ENTITIES[key];
  const pk = ent.pk || 'id';
  const sc = scopeClause(ctx, ent.scope);
  const row = ctx.db.prepare(`SELECT * FROM ${ent.table} WHERE ${pk} = ?${sc.sql ? ' AND ' + sc.sql : ''}`).get(id, ...sc.params);
  if (!row) throw new HttpError(404, `${ent.title}不存在或无权查看`);
  return row;
}

/**
 * 实体保存前的业务钩子 / Business hooks applied before saving an entity.
 * @param {object} ctx
 * @param {string} key
 * @param {object} data 待保存数据 / data to save
 * @param {object|null} old 原记录 / previous row
 */
function beforeSave(ctx, key, data, old) {
  const { db } = ctx;
  const ent = ENTITIES[key];
  if (ent.parent || key === 'customer_follow') {
    // 只能给自己有权查看的客户添加/修改子记录 / children may only be attached to a visible parent
    const pf = ent.parent ? ent.parent.field : 'customer_id';
    const pid = data[pf] !== undefined ? data[pf] : old && old[pf];
    if (pid !== undefined && pid !== null) getEntity(ctx, ent.parent ? ent.parent.entity : 'customer', pid);
  }
  if (['agency_record', 'customer_follow', 'sample_revision'].includes(key) && !old) data.user_name = ctx.user.name;
  if (key === 'customer' && ctx.user.scope === 'own' && !old) data.salesman_id = ctx.user.employee_id;
  if (key === 'mail' && !data.customer_id) {
    // 邮件自动按邮箱绑定客户 / auto-bind mail to a customer by email address
    const addr = [data.mail_from, data.mail_to].filter(Boolean).map((s) => String(s).toLowerCase().trim());
    const c = addr.length && db.prepare(`SELECT id FROM customers WHERE lower(email) IN (${addr.map(() => '?').join(',')}) LIMIT 1`).get(...addr);
    if (c) data.customer_id = c.id;
  }
  if (key === 'customer_contact' && (data.is_main ?? (old && old.is_main)) === '是') {
    // 主联系人同步到客户档案 / sync the main contact back to the customer record
    const cid = data.customer_id ?? old.customer_id;
    const merged = { ...(old || {}), ...data };
    db.prepare("UPDATE customer_contacts SET is_main='否' WHERE customer_id=? AND id<>?").run(cid, old ? old.id : -1);
    db.prepare('UPDATE customers SET contact=?, email=COALESCE(?, email), phone=COALESCE(?, phone) WHERE id=?').run(merged.name, merged.email || null, merged.phone || null, cid);
  }
  if (key === 'sample_package') {
    const m = { ...(old || {}), ...data };
    if (!(num(m.outer_qty) > 0)) throw new HttpError(400, '外箱装箱数必须大于0');
    if (num(m.gw) > 0 && num(m.nw) > num(m.gw)) throw new HttpError(400, '净重不能大于毛重');
    // CBM 留空按外箱尺寸计算 / blank CBM computed from carton size
    if (!(num(m.cbm) > 0) && m.outer_l && m.outer_w && m.outer_h) data.cbm = Math.round(num(m.outer_l) * num(m.outer_w) * num(m.outer_h) / 1e6 * 10000) / 10000;
    if (m.is_default === '是') {
      // 默认方案同步到样品档案的包装资料 / sync the default plan to the sample's packing fields
      syncDefaultPackage(db, { ...m, cbm: data.cbm !== undefined ? data.cbm : m.cbm }, old ? old.id : null);
    }
  }
  if (key === 'sample_part' && num({ ...(old || {}), ...data }.qty) <= 0) throw new HttpError(400, '用量必须大于0');
  if (key === 'customer_mark' && (data.is_default ?? (old && old.is_default)) === '是') {
    db.prepare("UPDATE customer_marks SET is_default='否' WHERE customer_id=? AND id<>?").run(data.customer_id ?? old.customer_id, old ? old.id : -1);
  }
  if (key === 'currency' && old && num(old.rate) !== num(data.rate)) {
    db.prepare('INSERT INTO rate_history(code,old_rate,new_rate,user_name) VALUES(?,?,?,?)').run(old.code, old.rate, data.rate, ctx.user.name);
    data.updated_at = new Date().toLocaleString('sv-SE');
  }
  if (key === 'sample' && old) {
    const watch = { craft: '工艺', color: '花色', material: '材质', length_cm: '长', width_cm: '宽', height_cm: '高' };
    const changes = Object.entries(watch).filter(([k]) => data[k] !== undefined && String(data[k] ?? '') !== String(old[k] ?? ''))
      .map(([k, l]) => `${l}: ${old[k] ?? ''} → ${data[k]}`);
    if (changes.length) {
      db.prepare("INSERT INTO sample_revisions(sample_id,stage,content,user_name) VALUES(?,'打样',?,?)").run(old.id, '档案修改：' + changes.join('；'), ctx.user.name);
    }
  }
}

/**
 * 保存实体（新增或修改）/ Insert or update an entity row.
 * @param {object} ctx
 * @param {string} key
 * @param {object} body
 * @param {string|number} [id]
 * @returns {object}
 */
function saveEntity(ctx, key, body, id) {
  const ent = ENTITIES[key];
  if (ent.readonly) throw new HttpError(400, `${ent.title}为只读台账，系统自动生成`);
  const pk = ent.pk || 'id';
  const old = id !== undefined ? getEntity(ctx, key, id) : null;
  const data = {};
  for (const fd of ent.fields) {
    if (fd.readonly) continue;
    if (body[fd.name] !== undefined) {
      let v = body[fd.name];
      if (v === '') v = null;
      if (fd.type === 'number' && v !== null) {
        v = Number(v);
        if (!Number.isFinite(v)) throw new HttpError(400, `【${fd.label}】必须是数字`);
      }
      if (fd.type === 'ref' && v !== null && !REF_LABEL[fd.ref].pk) v = Number(v);
      if (fd.type === 'select' && v !== null && fd.options && !fd.options.includes(v)) throw new HttpError(400, `【${fd.label}】取值无效：${v}`);
      data[fd.name] = v;
    } else if (!old && fd.default !== undefined) {
      data[fd.name] = fd.default;
    }
  }
  const merged = { ...(old || {}), ...data };
  required(merged, Object.fromEntries(ent.fields.filter((x) => x.required).map((x) => [x.name, x.label])));
  if (ent.ownField && ctx.user.scope === 'own' && old && old[ent.ownField] !== ctx.user.employee_id) {
    throw new HttpError(403, '只能修改本人负责的数据');
  }
  beforeSave(ctx, key, data, old);
  if (old && pk !== 'id' && data[pk] !== undefined && data[pk] !== old[pk]) throw new HttpError(400, '主键代码不允许修改');
  const cols = Object.keys(data);
  try {
    if (old) {
      if (cols.length) ctx.db.prepare(`UPDATE ${ent.table} SET ${cols.map((c) => `${c}=?`).join(',')} WHERE ${pk}=?`).run(...cols.map((c) => data[c]), id);
      // 在物料档案里直接改库存数量，记“库存调整”流水 / manual quantity edits are recorded as stock moves
      if (key === 'inventory' && data.qty !== undefined) require('../stock').recordAdjust(ctx.db, ctx.db.prepare('SELECT * FROM inventory WHERE id=?').get(id), old.qty, ctx.user.name);
      log(ctx, ent.module, `修改${ent.title}`, id, data);
      return getEntity(ctx, key, id);
    }
    const r = ctx.db.prepare(`INSERT INTO ${ent.table}(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`).run(...cols.map((c) => data[c]));
    const newId = pk === 'id' ? Number(r.lastInsertRowid) : data[pk];
    if (key === 'inventory' && num(data.qty)) require('../stock').recordAdjust(ctx.db, ctx.db.prepare('SELECT * FROM inventory WHERE id=?').get(newId), 0, ctx.user.name);
    log(ctx, ent.module, `新增${ent.title}`, newId, data);
    return ctx.db.prepare(`SELECT * FROM ${ent.table} WHERE ${pk}=?`).get(newId);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new HttpError(409, `${ent.title}编码/编号重复，请检查`);
    throw e;
  }
}

/** 删除前的引用检查 / Reference checks before deletion */
const DELETE_GUARDS = {
  customer: [['quotes', 'customer_id', '报价单'], ['orders', 'customer_id', '订单']],
  supplier: [['purchases', 'supplier_id', '采购单'], ['inquiries', 'supplier_id', '询价单']],
  sample: [['quote_items', 'sample_id', '报价明细'], ['order_items', 'sample_id', '订单明细'], ['sample_send_items', 'sample_id', '送样明细']],
  employee: [['users', 'employee_id', '系统账号'], ['customers', 'salesman_id', '客户']],
  department: [['employees', 'dept_id', '员工']],
  inventory: [['purchase_items', 'inventory_id', '采购明细'], ['stock_moves', 'inventory_id', '库存流水']],
  warehouse: [['stock_moves', 'warehouse_id', '库存流水'], ['inventory', 'warehouse_id', '物料（默认仓库）']],
};

/**
 * 注册基础路由 / Register base routes.
 * @param {import('../http').Router} r
 */
function register(r) {
  /** 每个应用实例独立计数：同一 IP 10 分钟内最多 20 次登录失败 / per-instance: at most 20 failed logins per IP per 10 minutes */
  const ipFailures = rateLimiter(20, 10 * 60000);
  // ---------- 登录鉴权 / auth ----------
  r.post('/api/login', (ctx) => {
    const { username, password } = ctx.body;
    required(ctx.body, { username: '账号', password: '密码' });
    const { db } = ctx;
    const setting = (k, d) => Number((db.prepare('SELECT value FROM settings WHERE key=?').get(k) || {}).value) || d;
    const logLogin = (action) => db.prepare("INSERT INTO logs(type,user_name,module,action,target,ip) VALUES('login',?,'system',?,?,?)").run(String(username).slice(0, 60), action, String(username).slice(0, 60), ctx.ip);
    if (ipFailures.count(ctx.ip) >= 20) {
      logLogin('登录被拒绝(该IP失败次数过多)');
      throw new HttpError(429, '登录失败次数过多，请10分钟后再试');
    }
    const u = db.prepare('SELECT * FROM users WHERE username=?').get(username);
    if (u && u.locked_until && u.locked_until > Date.now()) {
      logLogin('登录被拒绝(账号锁定中)');
      throw new HttpError(423, `该账号因连续输错密码已被锁定，请 ${Math.ceil((u.locked_until - Date.now()) / 60000)} 分钟后再试，或联系管理员解锁`);
    }
    // 账号不存在时也执行一次哈希，避免通过响应时间探测账号 / hash even for unknown users to avoid timing-based enumeration
    const ok = u ? verifyPassword(u, password) : (hashPassword(password, 'no-such-user'), false);
    if (!ok) {
      ipFailures.hit(ctx.ip);
      if (u) {
        const threshold = setting('lockout_threshold', 5);
        const fails = (u.failed_count || 0) + 1;
        if (fails >= threshold) {
          db.prepare('UPDATE users SET failed_count=0, locked_until=? WHERE id=?').run(Date.now() + setting('lockout_minutes', 15) * 60000, u.id);
          logLogin(`账号锁定(连续${fails}次密码错误)`);
          throw new HttpError(423, `密码连续错误${fails}次，账号已锁定 ${setting('lockout_minutes', 15)} 分钟`);
        }
        db.prepare('UPDATE users SET failed_count=? WHERE id=?').run(fails, u.id);
        logLogin('登录失败(密码错误)');
        throw new HttpError(401, `账号或密码错误（再错 ${threshold - fails} 次将锁定账号）`);
      }
      logLogin('登录失败(账号不存在)');
      throw new HttpError(401, '账号或密码错误');
    }
    if (u.status !== '启用') {
      logLogin('登录失败(账号已禁用)');
      throw new HttpError(403, '账号已被禁用，请联系管理员');
    }
    // 旧的弱密码登录后强制修改 / weak legacy passwords must be changed after login
    const weak = passwordProblems(password, u.username).length > 0;
    db.prepare("UPDATE users SET failed_count=0, locked_until=NULL, last_login_at=datetime('now','localtime'), must_change_password=CASE WHEN ? THEN 1 ELSE must_change_password END WHERE id=?").run(weak ? 1 : 0, u.id);
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)').run(token, u.id, Date.now() + SESSION_TTL);
    logLogin(weak ? '登录成功(弱密码，要求修改)' : '登录成功');
    return { token, must_change: weak || !!u.must_change_password };
  }, { public: true });

  // 登录页信息：密码规则与演示账号表（仅在开启展示且仍为演示密码时返回）
  // login page info: password policy and demo account table (only when enabled and still on the demo password)
  r.get('/api/public/login-info', (ctx) => {
    const show = (ctx.db.prepare("SELECT value FROM settings WHERE key='show_demo_accounts'").get() || {}).value === '1';
    const accounts = show ? ctx.db.prepare(`SELECT u.username, u.name, r.name role_name FROM users u LEFT JOIN roles r ON r.id=u.role_id
      WHERE u.pw_is_default=1 AND u.status='启用' ORDER BY u.id`).all().filter((u) => DEMO_ACCOUNTS[u.username])
      .sort((a, b) => Object.keys(DEMO_ACCOUNTS).indexOf(a.username) - Object.keys(DEMO_ACCOUNTS).indexOf(b.username))
      .map((u) => ({ username: u.username, name: u.name, role_name: u.role_name })) : [];
    return { policy: POLICY_TEXT, show_demo_accounts: show, accounts };
  }, { public: true });

  // 演示账号登录：密码不经过浏览器。仅在开启展示且账号仍为演示密码时可用，同样受锁定与限流约束
  // demo login: the password never reaches the browser; only while display is enabled and the account still uses its demo password
  r.post('/api/public/demo-login', (ctx) => {
    const { db } = ctx;
    const username = String(ctx.body.username || '');
    const logLogin = (action) => db.prepare("INSERT INTO logs(type,user_name,module,action,target,ip) VALUES('login',?,'system',?,?,?)").run(username.slice(0, 60), action, username.slice(0, 60), ctx.ip);
    if ((db.prepare("SELECT value FROM settings WHERE key='show_demo_accounts'").get() || {}).value !== '1') throw new HttpError(403, '演示账号登录已关闭，请输入账号密码登录');
    const u = db.prepare('SELECT * FROM users WHERE username=?').get(username);
    if (!u || !DEMO_ACCOUNTS[username] || !u.pw_is_default) {
      logLogin('演示登录被拒绝(非演示账号或已修改密码)');
      throw new HttpError(403, '该账号已修改密码或不是演示账号，请输入账号密码登录');
    }
    if (u.locked_until && u.locked_until > Date.now()) throw new HttpError(423, `该账号已被锁定，请 ${Math.ceil((u.locked_until - Date.now()) / 60000)} 分钟后再试`);
    if (u.status !== '启用') throw new HttpError(403, '账号已被禁用，请联系管理员');
    // 二次确认存储的仍是演示密码 / double-check the stored hash still matches the demo password
    if (!verifyPassword(u, DEMO_ACCOUNTS[username].password)) {
      db.prepare('UPDATE users SET pw_is_default=0 WHERE id=?').run(u.id);
      throw new HttpError(403, '该账号已修改密码，请输入账号密码登录');
    }
    db.prepare("UPDATE users SET failed_count=0, last_login_at=datetime('now','localtime') WHERE id=?").run(u.id);
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)').run(token, u.id, Date.now() + SESSION_TTL);
    logLogin('登录成功(演示账号)');
    return { token, must_change: !!u.must_change_password };
  }, { public: true });

  r.post('/api/logout', (ctx) => {
    ctx.db.prepare('DELETE FROM sessions WHERE token=?').run(ctx.token);
    return { ok: true };
  });

  r.post('/api/password', (ctx) => {
    required(ctx.body, { old_password: '原密码', new_password: '新密码' });
    const u = ctx.db.prepare('SELECT * FROM users WHERE id=?').get(ctx.user.id);
    if (!verifyPassword(u, ctx.body.old_password)) throw new HttpError(400, '原密码错误');
    assertStrongPassword(ctx.body.new_password, u.username);
    if (ctx.body.new_password === ctx.body.old_password) throw new HttpError(400, '新密码不能与原密码相同');
    const { hash, salt } = hashPassword(ctx.body.new_password);
    ctx.db.prepare("UPDATE users SET password_hash=?, salt=?, must_change_password=0, pw_is_default=0, password_changed_at=datetime('now','localtime') WHERE id=?").run(hash, salt, u.id);
    // 其它设备上的登录全部失效 / sign out every other session
    ctx.db.prepare('DELETE FROM sessions WHERE user_id=? AND token<>?').run(u.id, ctx.token);
    log(ctx, 'system', '修改本人密码', u.username);
    return { ok: true };
  });

  // ---------- 元数据 / metadata ----------
  r.get('/api/meta', (ctx) => {
    const u = ctx.user;
    const modules = ctx.db.prepare('SELECT * FROM modules ORDER BY sort').all();
    const entities = {};
    for (const [k, e] of Object.entries(ENTITIES)) {
      if (can(u, e.module, 'view')) entities[k] = { key: k, module: e.module, title: e.title, fields: e.fields, readonly: !!e.readonly, pk: e.pk || 'id', tree: e.tree || [], schemes: e.schemes || [], quick: e.quick || e.search || [], child: !!e.child };
    }
    return {
      user: { id: u.id, username: u.username, name: u.name, role_code: u.role_code, role_name: u.role_name, scope: u.scope, employee_id: u.employee_id, must_change: u.must_change },
      password_policy: POLICY_TEXT,
      perms: Object.fromEntries(modules.map((m) => [m.key, u.enabledModules.has(m.key) ? (u.perms[m.key] || []) : []])),
      modules, entities,
      company: { name: ctx.db.prepare("SELECT value FROM settings WHERE key='company_name'").get()?.value, name_en: ctx.db.prepare("SELECT value FROM settings WHERE key='company_name_en'").get()?.value },
    };
  });

  // ---------- 通用档案 CRUD / generic CRUD ----------
  const entOf = (key) => {
    const e = ENTITIES[key];
    if (!e) throw new HttpError(404, '未知数据类型');
    return e;
  };
  // 导航树分组计数、自动过滤可选值 / tree group counts and auto-filter values
  r.get('/api/e-groups/:entity', (ctx) => {
    const e = entOf(ctx.params.entity);
    need(ctx, e.module, 'view');
    return groupEntity(ctx, ctx.params.entity, ctx.query);
  });
  r.get('/api/e-values/:entity', (ctx) => {
    const e = entOf(ctx.params.entity);
    need(ctx, e.module, 'view');
    return distinctEntity(ctx, ctx.params.entity, ctx.query);
  });

  // 个人界面设置（导航方案、列设置、排序），按账号保存 / per-user UI preferences
  r.get('/api/prefs/:key', (ctx) => {
    if (!/^[\w.-]{1,60}$/.test(ctx.params.key)) throw new HttpError(400, '设置项名称无效');
    const row = ctx.db.prepare('SELECT value FROM user_prefs WHERE user_id=? AND pkey=?').get(ctx.user.id, ctx.params.key);
    return { value: row ? JSON.parse(row.value) : null };
  });
  r.put('/api/prefs/:key', (ctx) => {
    if (!/^[\w.-]{1,60}$/.test(ctx.params.key)) throw new HttpError(400, '设置项名称无效');
    const json = JSON.stringify(ctx.body.value ?? null);
    if (json.length > 20000) throw new HttpError(400, '设置内容过大');
    ctx.db.prepare(`INSERT INTO user_prefs(user_id,pkey,value,updated_at) VALUES(?,?,?,datetime('now','localtime'))
      ON CONFLICT(user_id,pkey) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).run(ctx.user.id, ctx.params.key, json);
    return { ok: true };
  });

  r.get('/api/e/:entity', (ctx) => {
    const e = entOf(ctx.params.entity);
    need(ctx, e.module, 'view');
    return listEntity(ctx, ctx.params.entity, ctx.query);
  });
  r.get('/api/e/:entity/:id', (ctx) => {
    const e = entOf(ctx.params.entity);
    need(ctx, e.module, 'view');
    return getEntity(ctx, ctx.params.entity, ctx.params.id);
  });
  r.post('/api/e/:entity', (ctx) => {
    const e = entOf(ctx.params.entity);
    need(ctx, e.module, 'add');
    return saveEntity(ctx, ctx.params.entity, ctx.body);
  });
  r.put('/api/e/:entity/:id', (ctx) => {
    const e = entOf(ctx.params.entity);
    need(ctx, e.module, 'edit');
    return saveEntity(ctx, ctx.params.entity, ctx.body, ctx.params.id);
  });
  r.del('/api/e/:entity/:id', (ctx) => {
    const key = ctx.params.entity;
    const e = entOf(key);
    // 客户页签子记录（联系人等）随客户维护，有修改权限即可删除 / child rows are maintained with edit permission
    need(ctx, e.module, e.child ? 'edit' : 'delete');
    if (e.readonly) throw new HttpError(400, '只读台账不允许删除');
    getEntity(ctx, key, ctx.params.id);
    for (const [t, c, label] of DELETE_GUARDS[key] || []) {
      const n = ctx.db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE ${c}=?`).get(ctx.params.id).c;
      if (n) throw new HttpError(409, `该${e.title}已被${n}条${label}引用，不能删除（可改为停用/离职状态）`);
    }
    tx(ctx.db, () => {
      for (const [t, c] of CHILDREN[key] || []) ctx.db.prepare(`DELETE FROM ${t} WHERE ${c}=?`).run(ctx.params.id);
      ctx.db.prepare(`DELETE FROM ${e.table} WHERE ${e.pk || 'id'}=?`).run(ctx.params.id);
    });
    log(ctx, e.module, `删除${e.title}`, ctx.params.id);
    return { ok: true };
  });

  // 下拉选项（遵循数据范围）/ select options honoring data scope
  r.get('/api/options/:ref', (ctx) => {
    const ref = REF_LABEL[ctx.params.ref];
    if (!ref) throw new HttpError(404, '未知选项');
    const ent = ENTITIES[ctx.params.ref];
    let scope = ent ? scopeClause(ctx, ent.scope) : { sql: '', params: [] };
    if (ctx.params.ref === 'quote' || ctx.params.ref === 'order') {
      if (ctx.user.scope === 'own') scope = { sql: 'salesman_id = ?', params: [ctx.user.employee_id] };
    }
    const extra = [];
    if (ctx.params.ref === 'employee') extra.push("status='在职'");
    if (ctx.params.ref === 'sample' && ctx.query.usable) extra.push("status<>'已锁定'");
    if (scope.sql) extra.push(scope.sql);
    const w = extra.length ? 'WHERE ' + extra.join(' AND ') : '';
    return ctx.db.prepare(`SELECT ${ref.pk || 'id'} AS id, ${ref.label} AS label FROM ${ref.table} ${w} ORDER BY 1 DESC LIMIT 1000`).all(...scope.params);
  });

  // ---------- 导出 Excel / export ----------
  r.post('/api/export', (ctx) => {
    const { module, title, headers, rows } = ctx.body;
    need(ctx, module, 'export');
    if (!Array.isArray(headers) || !Array.isArray(rows)) throw new HttpError(400, '导出数据格式错误');
    log(ctx, module, '导出Excel', title, `${rows.length}行`);
    return { __file: { buf: tableXlsx(title || '导出', headers, rows), name: `${title || '导出'}_${today()}.xlsx`, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } };
  });

  // ---------- 系统管理 / system admin ----------
  r.put('/api/modules/:key', (ctx) => {
    need(ctx, 'system', 'edit');
    if (ctx.params.key === 'system') throw new HttpError(400, '系统权限模块不可停用');
    const m = ctx.db.prepare('SELECT * FROM modules WHERE key=?').get(ctx.params.key);
    if (!m) throw new HttpError(404, '模块不存在');
    ctx.db.prepare('UPDATE modules SET enabled=? WHERE key=?').run(ctx.body.enabled ? 1 : 0, m.key);
    log(ctx, 'system', ctx.body.enabled ? '启用模块' : '停用模块', m.name);
    return { ok: true };
  });

  r.get('/api/roles', (ctx) => {
    need(ctx, 'system', 'view');
    return { rows: ctx.db.prepare('SELECT r.*, (SELECT COUNT(*) FROM users u WHERE u.role_id=r.id) user_count FROM roles r ORDER BY id').all(), actions: ACTIONS };
  });
  r.post('/api/roles', (ctx) => saveRole(ctx));
  r.put('/api/roles/:id', (ctx) => saveRole(ctx, ctx.params.id));
  r.del('/api/roles/:id', (ctx) => {
    need(ctx, 'system', 'delete');
    const n = ctx.db.prepare('SELECT COUNT(*) c FROM users WHERE role_id=?').get(ctx.params.id).c;
    if (n) throw new HttpError(409, `该角色下还有${n}个账号，不能删除`);
    ctx.db.prepare('DELETE FROM roles WHERE id=?').run(ctx.params.id);
    log(ctx, 'system', '删除角色', ctx.params.id);
    return { ok: true };
  });

  r.get('/api/users', (ctx) => {
    need(ctx, 'system', 'view');
    const rows = ctx.db.prepare(`SELECT u.id,u.username,u.name,u.role_id,u.employee_id,u.status,u.created_at,u.last_login_at,u.password_changed_at,u.must_change_password,u.pw_is_default,u.locked_until,
      r.name role_name, e.name employee_name FROM users u LEFT JOIN roles r ON r.id=u.role_id LEFT JOIN employees e ON e.id=u.employee_id ORDER BY u.id`).all();
    for (const x of rows) x.locked = !!(x.locked_until && x.locked_until > Date.now());
    return { rows, policy: POLICY_TEXT };
  });
  r.post('/api/users', (ctx) => {
    need(ctx, 'system', 'add');
    required(ctx.body, { username: '账号', name: '姓名', role_id: '角色' });
    if (!/^[A-Za-z0-9_.-]{3,32}$/.test(ctx.body.username)) throw new HttpError(400, '账号只能由3-32位字母、数字、下划线、点或短横线组成');
    // 管理员可指定强密码，否则系统生成随机临时密码；首次登录必须修改 / admin may set a strong password, otherwise a random temporary one; must change on first login
    const temp = ctx.body.password ? String(ctx.body.password) : generatePassword(ctx.body.username);
    assertStrongPassword(temp, ctx.body.username);
    const { hash, salt } = hashPassword(temp);
    try {
      const res = ctx.db.prepare("INSERT INTO users(username,name,password_hash,salt,role_id,employee_id,status,must_change_password) VALUES(?,?,?,?,?,?,'启用',1)")
        .run(ctx.body.username, ctx.body.name, hash, salt, ctx.body.role_id, ctx.body.employee_id || null);
      log(ctx, 'system', '新增账号', ctx.body.username);
      return { id: Number(res.lastInsertRowid), temp_password: temp };
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) throw new HttpError(409, '账号已存在');
      throw e;
    }
  });
  r.put('/api/users/:id', (ctx) => {
    need(ctx, 'system', 'edit');
    const u = ctx.db.prepare('SELECT * FROM users WHERE id=?').get(ctx.params.id);
    if (!u) throw new HttpError(404, '账号不存在');
    const b = ctx.body;
    if (b.status && !['启用', '禁用'].includes(b.status)) throw new HttpError(400, '状态无效');
    if (u.id === ctx.user.id && b.status === '禁用') throw new HttpError(400, '不能禁用自己的账号');
    ctx.db.prepare('UPDATE users SET name=?, role_id=?, employee_id=?, status=? WHERE id=?')
      .run(b.name ?? u.name, b.role_id ?? u.role_id, b.employee_id === undefined ? u.employee_id : (b.employee_id || null), b.status ?? u.status, u.id);
    if (b.unlock || b.status === '启用') ctx.db.prepare('UPDATE users SET failed_count=0, locked_until=NULL WHERE id=?').run(u.id);
    if (b.status === '禁用') ctx.db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
    log(ctx, 'system', '修改账号', u.username, b);
    return { ok: true };
  });
  r.post('/api/users/:id/reset-password', (ctx) => {
    need(ctx, 'system', 'edit');
    const u = ctx.db.prepare('SELECT * FROM users WHERE id=?').get(ctx.params.id);
    if (!u) throw new HttpError(404, '账号不存在');
    const temp = ctx.body.password ? String(ctx.body.password) : generatePassword(u.username);
    assertStrongPassword(temp, u.username);
    const { hash, salt } = hashPassword(temp);
    ctx.db.prepare('UPDATE users SET password_hash=?, salt=?, must_change_password=1, pw_is_default=0, failed_count=0, locked_until=NULL WHERE id=?').run(hash, salt, u.id);
    ctx.db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
    log(ctx, 'system', '重置密码', u.username);
    return { ok: true, temp_password: temp };
  });
  r.post('/api/users/batch-role', (ctx) => {
    need(ctx, 'system', 'edit');
    const ids = (ctx.body.ids || []).map(Number).filter(Boolean);
    if (!ids.length || !ctx.body.role_id) throw new HttpError(400, '请选择账号和角色');
    tx(ctx.db, () => { for (const id of ids) ctx.db.prepare('UPDATE users SET role_id=? WHERE id=?').run(ctx.body.role_id, id); });
    log(ctx, 'system', '批量授权', ids.join(','), `角色ID ${ctx.body.role_id}`);
    return { ok: true, count: ids.length };
  });

  r.get('/api/settings', (ctx) => {
    need(ctx, 'system', 'view');
    return Object.fromEntries(ctx.db.prepare('SELECT key,value FROM settings').all().map((x) => [x.key, x.value]));
  });
  r.put('/api/settings', (ctx) => {
    need(ctx, 'system', 'edit');
    const b = ctx.body;
    const cur = (k) => (b[k] !== undefined ? String(b[k]) : (ctx.db.prepare('SELECT value FROM settings WHERE key=?').get(k) || {}).value);
    const allowed = new Set(['company_name', 'company_name_en', 'quote_min_profit', 'rate_api_url', 'rate_auto_hours', 'rate_max_change', 'mail_fetch_minutes', 'mail_initial_sync',
      'show_demo_accounts', 'mail_allow_private_hosts', 'lockout_threshold', 'lockout_minutes', 'ar_writeoff_max', 'fg_require_out_before_ship']);
    for (const k of Object.keys(b)) if (!allowed.has(k)) throw new HttpError(400, `未知参数：${k}`);
    for (const k of ['quote_min_profit', 'rate_auto_hours', 'rate_max_change', 'mail_fetch_minutes', 'mail_initial_sync', 'lockout_threshold', 'lockout_minutes', 'ar_writeoff_max']) {
      if (b[k] !== undefined && !(Number(b[k]) >= 0 && Number(b[k]) <= 100000)) throw new HttpError(400, `参数 ${k} 必须是非负数字`);
    }
    if (b.lockout_threshold !== undefined && Number(b.lockout_threshold) < 3) throw new HttpError(400, '锁定阈值不能小于3次');
    for (const k of ['show_demo_accounts', 'mail_allow_private_hosts', 'fg_require_out_before_ship']) if (b[k] !== undefined && !['0', '1'].includes(String(b[k]))) throw new HttpError(400, `参数 ${k} 只能是 0 或 1`);
    if (b.rate_api_url !== undefined) {
      let url;
      try { url = new URL(String(b.rate_api_url)); } catch { throw new HttpError(400, '汇率接口地址格式错误'); }
      if (url.protocol !== 'https:' && cur('mail_allow_private_hosts') !== '1') throw new HttpError(400, '汇率接口必须使用 https:// 地址');
    }
    for (const [k, v] of Object.entries(ctx.body)) ctx.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));
    log(ctx, 'system', '修改系统参数', '', ctx.body);
    return { ok: true };
  });

  // ---------- 审批（移动端可用）/ approvals ----------
  r.get('/api/approvals', (ctx) => {
    const rows = ctx.db.prepare('SELECT * FROM approvals ORDER BY id DESC LIMIT 200').all();
    const modOf = { quote: 'quote', order: 'order', payment: 'purchase' };
    return { rows: rows.filter((a) => can(ctx.user, modOf[a.target_type], 'audit') || a.applicant === ctx.user.name) };
  });
  r.post('/api/approvals/:id/decide', (ctx) => {
    const a = ctx.db.prepare('SELECT * FROM approvals WHERE id=?').get(ctx.params.id);
    if (!a) throw new HttpError(404, '审批单不存在');
    const modOf = { quote: 'quote', order: 'order', payment: 'purchase' };
    need(ctx, modOf[a.target_type], 'audit');
    if (a.status !== '待审批') throw new HttpError(409, '该审批已处理');
    const pass = !!ctx.body.pass;
    tx(ctx.db, () => {
      ctx.db.prepare("UPDATE approvals SET status=?, approver=?, note=?, decided_at=datetime('now','localtime') WHERE id=?")
        .run(pass ? '已通过' : '已驳回', ctx.user.name, ctx.body.note || '', a.id);
      if (a.target_type === 'quote') ctx.db.prepare('UPDATE quotes SET status=?, audit_note=? WHERE id=?').run(pass ? '已审批' : '已驳回', ctx.body.note || '', a.target_id);
      if (a.target_type === 'payment') ctx.db.prepare('UPDATE payments SET status=? WHERE id=?').run(pass ? '已付款' : '已驳回', a.target_id);
    });
    log(ctx, modOf[a.target_type], pass ? '审批通过' : '审批驳回', a.target_no, ctx.body.note);
    return { ok: true };
  });

  // ---------- 工作台 / dashboard ----------
  r.get('/api/dashboard', (ctx) => {
    const { db, user } = ctx;
    const out = { cards: [], alerts: [] };
    const card = (label, value, link) => out.cards.push({ label, value, link });
    if (can(user, 'customer', 'view')) {
      const sc = scopeClause(ctx, ENTITIES.customer.scope);
      card('客户数', db.prepare(`SELECT COUNT(*) c FROM customers ${sc.sql ? 'WHERE ' + sc.sql : ''}`).get(...sc.params).c, '#/e/customer');
    }
    if (can(user, 'sample', 'view')) {
      const sc = scopeClause(ctx, ENTITIES.sample.scope);
      card('样品数', db.prepare(`SELECT COUNT(*) c FROM samples ${sc.sql ? 'WHERE ' + sc.sql : ''}`).get(...sc.params).c, '#/e/sample');
    }
    const own = user.scope === 'own' ? ' AND salesman_id=' + Number(user.employee_id || -1) : '';
    if (can(user, 'quote', 'view') && user.scope !== 'designer') card('进行中报价', db.prepare(`SELECT COUNT(*) c FROM quotes WHERE status NOT IN ('已成交','已失效')${own}`).get().c, '#/quotes');
    if (can(user, 'order', 'view') && user.scope !== 'designer') card('未完成订单', db.prepare(`SELECT COUNT(*) c FROM orders WHERE status NOT IN ('已出货','已完成')${own}`).get().c, '#/orders');

    // 安全提醒（管理员）/ security reminders for administrators
    if (can(user, 'system', 'edit')) {
      if ((db.prepare("SELECT value FROM settings WHERE key='show_demo_accounts'").get() || {}).value === '1') {
        out.alerts.push({ level: 'warn', type: '安全提醒', text: '登录页正在公开展示演示账号与密码。正式使用前请在「系统权限管理 → 系统参数」中关闭，并让各账号修改密码。', link: '#/system?tab=settings' });
      }
      const demo = db.prepare("SELECT COUNT(*) c FROM users WHERE pw_is_default=1 AND status='启用'").get().c;
      if (demo) out.alerts.push({ level: 'warn', type: '安全提醒', text: `${demo} 个账号仍在使用公开的演示密码，正式使用前请逐一重置或由本人修改。`, link: '#/system?tab=users' });
      const locked = db.prepare('SELECT COUNT(*) c FROM users WHERE locked_until > ?').get(Date.now()).c;
      if (locked) out.alerts.push({ level: 'danger', type: '安全提醒', text: `${locked} 个账号因连续输错密码被锁定，请核实是否存在暴力破解。`, link: '#/system?tab=users' });
    }
    // 订单变更联动待办 / pending change tasks for my department
    const deptPerm = { 采购: ['purchase', 'edit'], 生产: ['production', 'edit'], 财务: ['receivable', 'edit'], 业务: ['order', 'edit'] };
    const tasks = db.prepare(`SELECT t.*, o.order_no, c.change_no FROM change_tasks t JOIN orders o ON o.id=t.order_id JOIN order_changes c ON c.id=t.change_id WHERE t.status='待处理' ORDER BY t.id`).all()
      .filter((t) => can(user, ...deptPerm[t.dept]));
    for (const t of tasks) out.alerts.push({ level: 'danger', type: '订单变更联动', text: `【${t.dept}】${t.content}`, link: `#/order/${t.order_id}`, task_id: t.id });
    const approvals = db.prepare("SELECT * FROM approvals WHERE status='待审批'").all().filter((a) => can(user, a.target_type === 'payment' ? 'purchase' : a.target_type, 'audit'));
    for (const a of approvals) out.alerts.push({ level: 'warn', type: '待审批', text: `${a.title}（申请人：${a.applicant}）`, link: '#/approvals' });
    if (can(user, 'purchase', 'view')) {
      for (const i of db.prepare('SELECT * FROM inventory WHERE qty < safety_qty OR (max_qty > 0 AND qty > max_qty)').all()) {
        out.alerts.push({ level: i.qty < i.safety_qty ? 'danger' : 'warn', type: i.qty < i.safety_qty ? '缺料预警' : '积压预警', text: `${i.code} ${i.name} 库存${i.qty}${i.unit}（安全${i.safety_qty}/上限${i.max_qty}）`, link: '#/e/inventory' });
      }
    }
    if (can(user, 'production', 'view')) {
      for (const p of db.prepare("SELECT p.*, o.order_no FROM productions p JOIN orders o ON o.id=p.order_id WHERE p.status<>'已完工' AND p.due_date < ?").all(today())) {
        out.alerts.push({ level: 'danger', type: '生产延期', text: `${p.prod_no}（${p.order_no} / ${p.item_no}）计划完工 ${p.due_date} 已延期`, link: '#/production' });
      }
    }
    if (can(user, 'receivable', 'view')) {
      const { receivableRows } = require('./finance');
      for (const o of receivableRows(ctx).filter((x) => x.invoice_overdue)) {
        out.alerts.push({ level: 'danger', type: '开票逾期', text: `订单 ${o.order_no} 已出货 ${o.overdue_days} 天，未开票 ${o.uninvoiced} ${o.currency}`, link: '#/receivables' });
      }
    }
    if (can(user, 'quote', 'view') && user.scope !== 'designer') {
      for (const q of db.prepare(`SELECT * FROM quotes WHERE status IN ('已审批','已发客户') AND valid_until IS NOT NULL AND valid_until <= ?${own}`).all(today(7))) {
        out.alerts.push({ level: 'warn', type: '报价失效提醒', text: `报价单 ${q.quote_no} 有效期至 ${q.valid_until}`, link: `#/quote/${q.id}` });
      }
    }
    return out;
  });
}

/**
 * 保存角色与权限矩阵 / Save a role and its permission matrix.
 * @param {object} ctx
 * @param {string|number} [id]
 * @returns {object}
 */
function saveRole(ctx, id) {
  need(ctx, 'system', id ? 'edit' : 'add');
  required(ctx.body, { code: '角色代码', name: '角色名称' });
  const p = ctx.body.perms || {};
  for (const [m, acts] of Object.entries(p)) {
    if (!Array.isArray(acts) || acts.some((a) => !ACTIONS.includes(a))) throw new HttpError(400, `模块 ${m} 的权限格式错误`);
  }
  const scope = ['all', 'own', 'designer'].includes(ctx.body.data_scope) ? ctx.body.data_scope : 'all';
  try {
    if (id) {
      ctx.db.prepare('UPDATE roles SET code=?, name=?, data_scope=?, perms=?, remark=? WHERE id=?').run(ctx.body.code, ctx.body.name, scope, JSON.stringify(p), ctx.body.remark || '', id);
      log(ctx, 'system', '修改角色权限', ctx.body.name);
      return { id: Number(id) };
    }
    const r = ctx.db.prepare('INSERT INTO roles(code,name,data_scope,perms,remark) VALUES(?,?,?,?,?)').run(ctx.body.code, ctx.body.name, scope, JSON.stringify(p), ctx.body.remark || '');
    log(ctx, 'system', '新增角色', ctx.body.name);
    return { id: Number(r.lastInsertRowid) };
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new HttpError(409, '角色代码已存在');
    throw e;
  }
}

module.exports = { register, loadUser, scopeClause, listEntity, getEntity, assertPasswordFresh, BLANK };
