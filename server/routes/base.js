'use strict';
/**
 * 基础路由：登录鉴权、元数据、通用档案增删改查、系统管理、导出、审批、工作台
 * Base routes: auth, metadata, generic CRUD, system admin, export, approvals, dashboard.
 * @module server/routes/base
 */
const crypto = require('node:crypto');
const { HttpError } = require('../http');
const { can, need, log, tx, required, today, num } = require('../core');
const { ENTITIES, REF_LABEL } = require('../entities');
const { hashPassword, ACTIONS } = require('../db');
const { tableXlsx } = require('../xlsx');

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
    id: u.id, username: u.username, name: u.name, role_code: u.role_code, role_name: u.role_name,
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

/**
 * 查询实体列表（含引用字段显示名）/ List entity rows with ref labels.
 * @param {object} ctx
 * @param {string} key 实体键 / entity key
 * @param {object} q 查询参数 / query params
 * @returns {{rows:object[], total:number}}
 */
function listEntity(ctx, key, q) {
  const ent = ENTITIES[key];
  const where = [];
  const params = [];
  const sc = scopeClause(ctx, ent.scope, 't');
  if (sc.sql) { where.push(sc.sql); params.push(...sc.params); }
  if (q.q && ent.search) {
    where.push('(' + ent.search.map((c) => `t.${c} LIKE ?`).join(' OR ') + ')');
    for (let i = 0; i < ent.search.length; i++) params.push(`%${q.q}%`);
  }
  for (const fd of ent.fields) {
    const v = q['f_' + fd.name];
    if (v !== undefined && v !== '') { where.push(`t.${fd.name} = ?`); params.push(v); }
  }
  const refCols = ent.fields.filter((fd) => fd.type === 'ref').map((fd) => {
    const r = REF_LABEL[fd.ref];
    return `(SELECT ${r.label} FROM ${r.table} x WHERE x.${r.pk || 'id'} = t.${fd.name}) AS ${fd.name}_label`;
  });
  const pk = ent.pk || 'id';
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = ctx.db.prepare(`SELECT COUNT(*) c FROM ${ent.table} t ${w}`).get(...params).c;
  const size = Math.min(500, Math.max(1, parseInt(q.size || '50', 10)));
  const page = Math.max(1, parseInt(q.page || '1', 10));
  const order = ent.order ? ent.order.replace(/(\w+)/, 't.$1') : `t.${pk}`;
  const rows = ctx.db.prepare(`SELECT t.*${pk === 'id' ? '' : `, t.${pk} AS id`}${refCols.length ? ', ' + refCols.join(', ') : ''} FROM ${ent.table} t ${w} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(...params, size, (page - 1) * size);
  if (key === 'inventory') {
    for (const r of rows) r.alert = r.qty < r.safety_qty ? '缺料预警' : (r.max_qty > 0 && r.qty > r.max_qty ? '积压预警' : '正常');
  }
  return { rows, total };
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
  if (['agency_record', 'customer_follow', 'sample_revision'].includes(key) && !old) data.user_name = ctx.user.name;
  if (key === 'customer' && ctx.user.scope === 'own' && !old) data.salesman_id = ctx.user.employee_id;
  if (key === 'mail' && !data.customer_id) {
    // 邮件自动按邮箱绑定客户 / auto-bind mail to a customer by email address
    const addr = [data.mail_from, data.mail_to].filter(Boolean).map((s) => String(s).toLowerCase().trim());
    const c = addr.length && db.prepare(`SELECT id FROM customers WHERE lower(email) IN (${addr.map(() => '?').join(',')}) LIMIT 1`).get(...addr);
    if (c) data.customer_id = c.id;
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
      log(ctx, ent.module, `修改${ent.title}`, id, data);
      return getEntity(ctx, key, id);
    }
    const r = ctx.db.prepare(`INSERT INTO ${ent.table}(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`).run(...cols.map((c) => data[c]));
    const newId = pk === 'id' ? Number(r.lastInsertRowid) : data[pk];
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
  inventory: [['purchase_items', 'inventory_id', '采购明细']],
};

/**
 * 注册基础路由 / Register base routes.
 * @param {import('../http').Router} r
 */
function register(r) {
  // ---------- 登录鉴权 / auth ----------
  r.post('/api/login', (ctx) => {
    const { username, password } = ctx.body;
    required(ctx.body, { username: '账号', password: '密码' });
    const u = ctx.db.prepare('SELECT * FROM users WHERE username=?').get(username);
    const ok = u && hashPassword(password, u.salt).hash === u.password_hash;
    ctx.db.prepare("INSERT INTO logs(type,user_name,module,action,target,ip) VALUES('login',?,'system',?,?,?)")
      .run(username, ok ? (u.status === '启用' ? '登录成功' : '登录失败(账号已禁用)') : '登录失败(密码错误)', username, ctx.ip);
    if (!ok) throw new HttpError(401, '账号或密码错误');
    if (u.status !== '启用') throw new HttpError(403, '账号已被禁用，请联系管理员');
    const token = crypto.randomBytes(24).toString('hex');
    ctx.db.prepare('INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)').run(token, u.id, Date.now() + SESSION_TTL);
    return { token };
  }, { public: true });

  r.post('/api/logout', (ctx) => {
    ctx.db.prepare('DELETE FROM sessions WHERE token=?').run(ctx.token);
    return { ok: true };
  });

  r.post('/api/password', (ctx) => {
    required(ctx.body, { old_password: '原密码', new_password: '新密码' });
    const u = ctx.db.prepare('SELECT * FROM users WHERE id=?').get(ctx.user.id);
    if (hashPassword(ctx.body.old_password, u.salt).hash !== u.password_hash) throw new HttpError(400, '原密码错误');
    if (String(ctx.body.new_password).length < 6) throw new HttpError(400, '新密码至少6位');
    const { hash, salt } = hashPassword(ctx.body.new_password);
    ctx.db.prepare('UPDATE users SET password_hash=?, salt=? WHERE id=?').run(hash, salt, u.id);
    log(ctx, 'system', '修改本人密码', u.username);
    return { ok: true };
  });

  // ---------- 元数据 / metadata ----------
  r.get('/api/meta', (ctx) => {
    const u = ctx.user;
    const modules = ctx.db.prepare('SELECT * FROM modules ORDER BY sort').all();
    const entities = {};
    for (const [k, e] of Object.entries(ENTITIES)) {
      if (can(u, e.module, 'view')) entities[k] = { key: k, module: e.module, title: e.title, fields: e.fields, readonly: !!e.readonly, pk: e.pk || 'id' };
    }
    return {
      user: { id: u.id, username: u.username, name: u.name, role_code: u.role_code, role_name: u.role_name, scope: u.scope, employee_id: u.employee_id },
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
    need(ctx, e.module, 'delete');
    if (e.readonly) throw new HttpError(400, '只读台账不允许删除');
    getEntity(ctx, key, ctx.params.id);
    for (const [t, c, label] of DELETE_GUARDS[key] || []) {
      const n = ctx.db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE ${c}=?`).get(ctx.params.id).c;
      if (n) throw new HttpError(409, `该${e.title}已被${n}条${label}引用，不能删除（可改为停用/离职状态）`);
    }
    ctx.db.prepare(`DELETE FROM ${e.table} WHERE ${e.pk || 'id'}=?`).run(ctx.params.id);
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
    return { rows: ctx.db.prepare(`SELECT u.id,u.username,u.name,u.role_id,u.employee_id,u.status,u.created_at, r.name role_name, e.name employee_name
      FROM users u LEFT JOIN roles r ON r.id=u.role_id LEFT JOIN employees e ON e.id=u.employee_id ORDER BY u.id`).all() };
  });
  r.post('/api/users', (ctx) => {
    need(ctx, 'system', 'add');
    required(ctx.body, { username: '账号', name: '姓名', role_id: '角色' });
    const { hash, salt } = hashPassword(ctx.body.password || '123456');
    try {
      const res = ctx.db.prepare("INSERT INTO users(username,name,password_hash,salt,role_id,employee_id,status) VALUES(?,?,?,?,?,?,'启用')")
        .run(ctx.body.username, ctx.body.name, hash, salt, ctx.body.role_id, ctx.body.employee_id || null);
      log(ctx, 'system', '新增账号', ctx.body.username);
      return { id: Number(res.lastInsertRowid) };
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
    if (b.status === '禁用') ctx.db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
    log(ctx, 'system', '修改账号', u.username, b);
    return { ok: true };
  });
  r.post('/api/users/:id/reset-password', (ctx) => {
    need(ctx, 'system', 'edit');
    const u = ctx.db.prepare('SELECT * FROM users WHERE id=?').get(ctx.params.id);
    if (!u) throw new HttpError(404, '账号不存在');
    const { hash, salt } = hashPassword(ctx.body.password || '123456');
    ctx.db.prepare('UPDATE users SET password_hash=?, salt=? WHERE id=?').run(hash, salt, u.id);
    ctx.db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
    log(ctx, 'system', '重置密码', u.username);
    return { ok: true };
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

module.exports = { register, loadUser, scopeClause, listEntity };
