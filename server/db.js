'use strict';
/**
 * 数据底座：建表与初始化演示数据
 * Data foundation: schema creation and demo seed data.
 * @module server/db
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

/** 功能权限动作 / Permission actions */
const ACTIONS = ['view', 'add', 'edit', 'delete', 'export', 'print', 'audit'];

/**
 * 模块清单（按业务流程排序，可一键启停）
 * Module list, ordered by business flow; each can be toggled on/off.
 */
const MODULES = [
  ['system', '系统权限管理', 1, 1],
  ['hr', '员工人事管理', 1, 2],
  ['supplier', '供应商管理', 1, 3],
  ['agency', '服务机构管理', 1, 4],
  ['customer', '客户管理', 1, 5],
  ['mail', '业务邮件管理', 2, 6],
  ['sample', '样品管理', 2, 7],
  ['trade', '贸易术语与汇率', 2, 8],
  ['quote', '报价与工厂询价', 2, 9],
  ['sendsample', '送样管理', 2, 10],
  ['order', '订单与出货', 3, 11],
  ['receivable', '应收款与开票', 4, 12],
  ['purchase', '采购付款与进项票', 4, 13],
  ['production', '生产布产进度', 5, 14],
  ['report', '统计报表', 6, 15],
  ['designer', '设计师速查中心', 6, 16],
];

/**
 * 密码哈希（scrypt）/ Hash a password with scrypt.
 * @param {string} password 明文密码 / plain password
 * @param {string} [salt] 盐值 / salt
 * @returns {{hash:string, salt:string}}
 */
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return { hash, salt };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS modules (key TEXT PRIMARY KEY, name TEXT, stage INTEGER, sort INTEGER, enabled INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS roles (id INTEGER PRIMARY KEY, code TEXT UNIQUE, name TEXT, data_scope TEXT DEFAULT 'all', perms TEXT DEFAULT '{}', remark TEXT);
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT UNIQUE, name TEXT, password_hash TEXT, salt TEXT, role_id INTEGER, employee_id INTEGER, status TEXT DEFAULT '启用', created_at TEXT DEFAULT (datetime('now','localtime')));
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER, expires_at INTEGER);
CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY, type TEXT, user_name TEXT, module TEXT, action TEXT, target TEXT, detail TEXT, ip TEXT, created_at TEXT DEFAULT (datetime('now','localtime')));
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS departments (id INTEGER PRIMARY KEY, name TEXT UNIQUE, manager TEXT, remark TEXT);
CREATE TABLE IF NOT EXISTS employees (id INTEGER PRIMARY KEY, emp_no TEXT UNIQUE, name TEXT, dept_id INTEGER, position TEXT, phone TEXT, email TEXT, hire_date TEXT, status TEXT DEFAULT '在职', remark TEXT);

CREATE TABLE IF NOT EXISTS suppliers (id INTEGER PRIMARY KEY, code TEXT UNIQUE, name TEXT, type TEXT, contact TEXT, phone TEXT, address TEXT, settlement TEXT, item_range TEXT, rating TEXT DEFAULT 'B', pass_rate REAL DEFAULT 100, qualification TEXT, remark TEXT);
CREATE TABLE IF NOT EXISTS supplier_prices (id INTEGER PRIMARY KEY, supplier_id INTEGER, item_no TEXT, price REAL, currency TEXT DEFAULT 'CNY', source TEXT, ref_no TEXT, price_date TEXT DEFAULT (date('now','localtime')));

CREATE TABLE IF NOT EXISTS agencies (id INTEGER PRIMARY KEY, name TEXT, type TEXT, contact TEXT, phone TEXT, price_note TEXT, service_days INTEGER, rating TEXT DEFAULT 'B', remark TEXT);
CREATE TABLE IF NOT EXISTS agency_records (id INTEGER PRIMARY KEY, agency_id INTEGER, content TEXT, user_name TEXT, created_at TEXT DEFAULT (datetime('now','localtime')));

CREATE TABLE IF NOT EXISTS customers (id INTEGER PRIMARY KEY, code TEXT UNIQUE, name TEXT, country TEXT, contact TEXT, email TEXT, phone TEXT, address TEXT, salesman_id INTEGER, level TEXT DEFAULT 'B', source TEXT, remark TEXT, created_at TEXT DEFAULT (datetime('now','localtime')));
CREATE TABLE IF NOT EXISTS customer_follows (id INTEGER PRIMARY KEY, customer_id INTEGER, type TEXT DEFAULT '跟进', content TEXT, next_date TEXT, user_name TEXT, created_at TEXT DEFAULT (datetime('now','localtime')));

CREATE TABLE IF NOT EXISTS mails (id INTEGER PRIMARY KEY, direction TEXT, mail_from TEXT, mail_to TEXT, subject TEXT, body TEXT, category TEXT, customer_id INTEGER, sample_id INTEGER, quote_id INTEGER, order_id INTEGER, user_name TEXT, created_at TEXT DEFAULT (datetime('now','localtime')));

CREATE TABLE IF NOT EXISTS samples (id INTEGER PRIMARY KEY, company_no TEXT UNIQUE, customer_no TEXT, factory_no TEXT, name TEXT, name_en TEXT,
  length_cm REAL, width_cm REAL, height_cm REAL, material TEXT, craft TEXT, color TEXT, consumables TEXT,
  material_cost REAL DEFAULT 0, labor_cost REAL DEFAULT 0, sample_fee REAL DEFAULT 0,
  designer_id INTEGER, supplier_id INTEGER, package_req TEXT, label_req TEXT, inner_box TEXT,
  outer_l REAL, outer_w REAL, outer_h REAL, pcs_per_carton INTEGER, moq INTEGER,
  stock_qty INTEGER DEFAULT 0, progress TEXT DEFAULT '打样中', status TEXT DEFAULT '正常', parent_no TEXT, images TEXT, remark TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime')));
CREATE TABLE IF NOT EXISTS sample_revisions (id INTEGER PRIMARY KEY, sample_id INTEGER, stage TEXT, content TEXT, user_name TEXT, created_at TEXT DEFAULT (datetime('now','localtime')));

CREATE TABLE IF NOT EXISTS currencies (code TEXT PRIMARY KEY, name TEXT, rate REAL, updated_at TEXT DEFAULT (datetime('now','localtime')));
CREATE TABLE IF NOT EXISTS rate_history (id INTEGER PRIMARY KEY, code TEXT, old_rate REAL, new_rate REAL, user_name TEXT, created_at TEXT DEFAULT (datetime('now','localtime')));
CREATE TABLE IF NOT EXISTS trade_terms (code TEXT PRIMARY KEY, name TEXT, description TEXT);

CREATE TABLE IF NOT EXISTS quotes (id INTEGER PRIMARY KEY, quote_no TEXT UNIQUE, customer_id INTEGER, salesman_id INTEGER, currency TEXT DEFAULT 'USD', term TEXT DEFAULT 'FOB', rate REAL,
  profit_rate REAL DEFAULT 20, freight REAL DEFAULT 0, customs_fee REAL DEFAULT 0, valid_until TEXT, status TEXT DEFAULT '草稿', audit_note TEXT, remark TEXT,
  created_by TEXT, created_at TEXT DEFAULT (datetime('now','localtime')));
CREATE TABLE IF NOT EXISTS quote_items (id INTEGER PRIMARY KEY, quote_id INTEGER, sample_id INTEGER, item_no TEXT, description TEXT, qty INTEGER DEFAULT 0,
  factory_id INTEGER, cost_cny REAL DEFAULT 0, craft_add REAL DEFAULT 0, price REAL DEFAULT 0, new_item_no TEXT, revise_req TEXT);
CREATE TABLE IF NOT EXISTS inquiries (id INTEGER PRIMARY KEY, inquiry_no TEXT UNIQUE, quote_id INTEGER, supplier_id INTEGER, status TEXT DEFAULT '待发送',
  sent_at TEXT, reply_date TEXT, valid_until TEXT, remark TEXT, created_at TEXT DEFAULT (datetime('now','localtime')));
CREATE TABLE IF NOT EXISTS inquiry_items (id INTEGER PRIMARY KEY, inquiry_id INTEGER, quote_item_id INTEGER, sample_id INTEGER, item_no TEXT, description TEXT, qty INTEGER,
  factory_price REAL, delivery_days INTEGER, remark TEXT);

CREATE TABLE IF NOT EXISTS sample_sends (id INTEGER PRIMARY KEY, send_no TEXT UNIQUE, customer_id INTEGER, salesman_id INTEGER, quote_id INTEGER, status TEXT DEFAULT '申请中',
  express_co TEXT, tracking_no TEXT, send_date TEXT, cost REAL DEFAULT 0, customer_feedback TEXT, remark TEXT, created_at TEXT DEFAULT (datetime('now','localtime')));
CREATE TABLE IF NOT EXISTS sample_send_items (id INTEGER PRIMARY KEY, send_id INTEGER, sample_id INTEGER, item_no TEXT, qty INTEGER DEFAULT 1, new_item_no TEXT, revise_req TEXT,
  verify_status TEXT, verify_note TEXT, redo_count INTEGER DEFAULT 0, new_sample_id INTEGER);

CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY, order_no TEXT UNIQUE, customer_id INTEGER, salesman_id INTEGER, quote_id INTEGER, currency TEXT DEFAULT 'USD', term TEXT DEFAULT 'FOB', rate REAL,
  order_date TEXT, delivery_date TEXT, package_req TEXT, craft TEXT, status TEXT DEFAULT '待确认', risk_lock INTEGER DEFAULT 0, invoice_due_days INTEGER DEFAULT 30, remark TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime')));
CREATE TABLE IF NOT EXISTS order_items (id INTEGER PRIMARY KEY, order_id INTEGER, sample_id INTEGER, item_no TEXT, description TEXT, qty INTEGER, unit_price REAL, craft TEXT, spec TEXT, package TEXT);
CREATE TABLE IF NOT EXISTS order_changes (id INTEGER PRIMARY KEY, change_no TEXT, order_id INTEGER, diff TEXT, reason TEXT, risk_level TEXT, risk_detail TEXT, status TEXT, user_name TEXT, created_at TEXT DEFAULT (datetime('now','localtime')));
CREATE TABLE IF NOT EXISTS change_tasks (id INTEGER PRIMARY KEY, change_id INTEGER, order_id INTEGER, dept TEXT, content TEXT, status TEXT DEFAULT '待处理', handler TEXT, handle_note TEXT, handled_at TEXT);
CREATE TABLE IF NOT EXISTS shipments (id INTEGER PRIMARY KEY, ship_no TEXT UNIQUE, order_id INTEGER, ship_date TEXT, port TEXT, dest_port TEXT, vessel TEXT, container_no TEXT, customs_no TEXT, forwarder_id INTEGER,
  status TEXT DEFAULT '计划中', inspection_status TEXT DEFAULT '待验货', inspection_note TEXT, remark TEXT, created_at TEXT DEFAULT (datetime('now','localtime')));
CREATE TABLE IF NOT EXISTS shipment_items (id INTEGER PRIMARY KEY, shipment_id INTEGER, order_item_id INTEGER, qty INTEGER, cartons INTEGER, cbm REAL);

CREATE TABLE IF NOT EXISTS receipts (id INTEGER PRIMARY KEY, order_id INTEGER, type TEXT, amount REAL, currency TEXT, rate REAL, amount_cny REAL, fx_gain REAL DEFAULT 0, receipt_date TEXT, voucher TEXT, remark TEXT);
CREATE TABLE IF NOT EXISTS sales_invoices (id INTEGER PRIMARY KEY, order_id INTEGER, invoice_no TEXT UNIQUE, amount REAL, invoice_date TEXT, remark TEXT);

CREATE TABLE IF NOT EXISTS inventory (id INTEGER PRIMARY KEY, code TEXT UNIQUE, name TEXT, category TEXT, unit TEXT, qty REAL DEFAULT 0, unit_cost REAL DEFAULT 0, safety_qty REAL DEFAULT 0, max_qty REAL DEFAULT 0, remark TEXT);
CREATE TABLE IF NOT EXISTS purchases (id INTEGER PRIMARY KEY, po_no TEXT UNIQUE, supplier_id INTEGER, order_id INTEGER, type TEXT, status TEXT DEFAULT '已下单', order_date TEXT, due_date TEXT, qc_status TEXT DEFAULT '待质检', remark TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime')));
CREATE TABLE IF NOT EXISTS purchase_items (id INTEGER PRIMARY KEY, po_id INTEGER, inventory_id INTEGER, order_item_id INTEGER, code TEXT, name TEXT, unit TEXT, qty REAL, price REAL, received_qty REAL DEFAULT 0);
CREATE TABLE IF NOT EXISTS payments (id INTEGER PRIMARY KEY, po_id INTEGER, amount REAL, pay_date TEXT, voucher TEXT, status TEXT DEFAULT '待审批', applicant TEXT, remark TEXT);
CREATE TABLE IF NOT EXISTS purchase_invoices (id INTEGER PRIMARY KEY, po_id INTEGER, supplier_id INTEGER, invoice_no TEXT UNIQUE, amount REAL, invoice_date TEXT, verify_status TEXT DEFAULT '未核销', remark TEXT);
CREATE TABLE IF NOT EXISTS material_issues (id INTEGER PRIMARY KEY, inventory_id INTEGER, order_id INTEGER, production_id INTEGER, qty REAL, unit_cost REAL, user_name TEXT, created_at TEXT DEFAULT (datetime('now','localtime')));

CREATE TABLE IF NOT EXISTS productions (id INTEGER PRIMARY KEY, prod_no TEXT UNIQUE, order_id INTEGER, order_item_id INTEGER, item_no TEXT, plan_qty INTEGER, start_date TEXT, due_date TEXT, status TEXT DEFAULT '生产中', remark TEXT);
CREATE TABLE IF NOT EXISTS production_reports (id INTEGER PRIMARY KEY, production_id INTEGER, process TEXT, report_date TEXT, qty INTEGER, good_qty INTEGER, bad_qty INTEGER, worker TEXT, remark TEXT);

CREATE TABLE IF NOT EXISTS mail_accounts (id INTEGER PRIMARY KEY, email TEXT UNIQUE, display_name TEXT, owner_user_id INTEGER,
  smtp_host TEXT, smtp_port INTEGER, smtp_secure TEXT DEFAULT 'ssl', imap_host TEXT, imap_port INTEGER, imap_secure TEXT DEFAULT 'ssl',
  username TEXT, password_enc TEXT, tls_reject_unauthorized INTEGER DEFAULT 1, enabled INTEGER DEFAULT 1, auto_fetch INTEGER DEFAULT 1,
  uidvalidity INTEGER, last_uid INTEGER DEFAULT 0, last_fetch_at TEXT, last_error TEXT, created_at TEXT DEFAULT (datetime('now','localtime')));
CREATE TABLE IF NOT EXISTS files (id INTEGER PRIMARY KEY, name TEXT, mime TEXT, size INTEGER, data BLOB, owner_type TEXT, owner_id INTEGER, created_by TEXT, created_at TEXT DEFAULT (datetime('now','localtime')));

CREATE TABLE IF NOT EXISTS approvals (id INTEGER PRIMARY KEY, target_type TEXT, target_id INTEGER, target_no TEXT, title TEXT, status TEXT DEFAULT '待审批', applicant TEXT, approver TEXT, note TEXT, created_at TEXT DEFAULT (datetime('now','localtime')), decided_at TEXT);
`;

/**
 * 生成角色权限 JSON / Build permission map for a role.
 * @param {Object<string,string[]>} map 模块→动作 / module → actions
 * @returns {string}
 */
function perms(map) {
  return JSON.stringify(map);
}

/** 全权限 / all actions on all modules */
function allPerms() {
  const m = {};
  for (const [key] of MODULES) m[key] = [...ACTIONS];
  return m;
}

/**
 * 写入演示数据 / Insert demo seed data.
 * @param {DatabaseSync} db
 */
function seed(db) {
  const ins = (sql, ...args) => db.prepare(sql).run(...args);
  for (const [key, name, stage, sort] of MODULES) {
    ins('INSERT INTO modules(key,name,stage,sort,enabled) VALUES(?,?,?,?,1)', key, name, stage, sort);
  }
  const crud = ['view', 'add', 'edit', 'export', 'print'];
  const ro = ['view', 'export', 'print'];
  const roles = [
    ['admin', '超级管理员', 'all', allPerms(), '全部权限'],
    ['sales', '外贸业务员', 'own', {
      customer: crud, mail: crud, sample: ro, trade: ro, quote: crud, sendsample: crud, order: crud, receivable: ro, report: ro,
    }, '仅查看本人客户与业务单据'],
    ['purchaser', '采购', 'all', { supplier: crud, sample: ro, quote: ['view', 'edit', 'export', 'print'], purchase: crud, order: ro, production: ro, report: ro }, ''],
    ['producer', '生产管理', 'all', { production: crud, order: ro, purchase: ro, sample: ro, report: ro }, ''],
    ['finance', '财务', 'all', { receivable: [...crud, 'audit'], purchase: ['view', 'edit', 'export', 'print', 'audit'], order: ro, trade: crud, report: ro }, ''],
    ['hr', '人事', 'all', { hr: [...crud, 'delete'], report: ro }, ''],
    ['designer', '陶瓷设计师', 'designer', { designer: ro, sample: ro, quote: ro, sendsample: ro, order: ro }, '仅可查询本人设计样品及关联数据'],
    ['manager', '业务经理', 'all', {
      customer: [...crud, 'audit'], mail: crud, sample: [...crud, 'audit'], trade: crud, quote: [...crud, 'audit'], sendsample: [...crud, 'audit'], order: [...crud, 'audit'], receivable: ro, purchase: ro, production: ro, report: ro,
    }, '可审批报价/订单'],
  ];
  for (const [code, name, scope, p, remark] of roles) {
    ins('INSERT INTO roles(code,name,data_scope,perms,remark) VALUES(?,?,?,?,?)', code, name, scope, perms(p), remark);
  }
  const roleId = (code) => db.prepare('SELECT id FROM roles WHERE code=?').get(code).id;

  const depts = ['总经办', '外贸业务部', '设计部', '采购部', '生产部', '财务部', '人事行政部'];
  for (const d of depts) ins('INSERT INTO departments(name) VALUES(?)', d);
  const deptId = (n) => db.prepare('SELECT id FROM departments WHERE name=?').get(n).id;
  const emps = [
    ['E001', '陈总', '总经办', '总经理'],
    ['E002', '林晓明', '外贸业务部', '外贸业务员'],
    ['E003', '王芳', '外贸业务部', '外贸业务员'],
    ['E004', '张雕塑', '设计部', '陶瓷设计师'],
    ['E005', '李彩绘', '设计部', '陶瓷设计师'],
    ['E006', '赵采购', '采购部', '采购员'],
    ['E007', '孙厂长', '生产部', '生产经理'],
    ['E008', '周会计', '财务部', '会计'],
    ['E009', '吴人事', '人事行政部', '人事专员'],
    ['E010', '郑经理', '外贸业务部', '业务经理'],
  ];
  for (const [no, name, d, pos] of emps) {
    ins("INSERT INTO employees(emp_no,name,dept_id,position,phone,hire_date,status) VALUES(?,?,?,?,?,'2024-03-01','在职')", no, name, deptId(d), pos, '1380000' + no.slice(1));
  }
  const empId = (no) => db.prepare('SELECT id FROM employees WHERE emp_no=?').get(no).id;
  const users = [
    ['admin', '系统管理员', 'admin', 'E001'],
    ['sales1', '林晓明', 'sales', 'E002'],
    ['sales2', '王芳', 'sales', 'E003'],
    ['designer1', '张雕塑', 'designer', 'E004'],
    ['designer2', '李彩绘', 'designer', 'E005'],
    ['purchase1', '赵采购', 'purchaser', 'E006'],
    ['prod1', '孙厂长', 'producer', 'E007'],
    ['finance1', '周会计', 'finance', 'E008'],
    ['hr1', '吴人事', 'hr', 'E009'],
    ['manager1', '郑经理', 'manager', 'E010'],
  ];
  for (const [u, name, role, emp] of users) {
    const { hash, salt } = hashPassword('123456');
    ins('INSERT INTO users(username,name,password_hash,salt,role_id,employee_id) VALUES(?,?,?,?,?,?)', u, name, hash, salt, roleId(role), empId(emp));
  }

  const sups = [
    ['S001', '德化鸿盛陶瓷厂', '成品生产工厂', '黄厂长', '0595-2350001', '月结30天', '花瓶/摆件', 'A', 98.5],
    ['S002', '潮州雅艺陶瓷厂', '成品生产工厂', '许经理', '0768-6880002', '款到发货', '餐具/杯碟', 'A', 97],
    ['S003', '景德镇釉料供应站', '原辅材料供应商', '刘老板', '0798-8200003', '月结60天', '釉料/色料', 'B', 95],
    ['S004', '厦门华美包装', '原辅材料供应商', '蔡经理', '0592-5600004', '月结30天', '彩盒/外箱', 'B', 99],
    ['S005', '佛山外购精品', '外购成品供应商', '冯总', '0757-8300005', '预付30%', '金属配件摆件', 'C', 92],
  ];
  for (const s of sups) ins('INSERT INTO suppliers(code,name,type,contact,phone,settlement,item_range,rating,pass_rate,email) VALUES(?,?,?,?,?,?,?,?,?,?)', ...s, `${s[0].toLowerCase()}@supplier.example.com`);

  const ags = [
    ['泉州意匠设计工作室', '产品设计机构', '谢设计', '13900000001', '单款800-2000元', 7, 'A'],
    ['德化快样打样中心', '打样工厂', '曾师傅', '13900000002', '单款300-600元', 5, 'B'],
    ['厦门顺航国际货代', '货代公司', 'Amy', '13900000003', '海运按柜报价', 3, 'A'],
    ['厦门通关报关行', '报关行', '陈报关', '13900000004', '200元/票', 1, 'A'],
    ['SGS厦门验货', '验货机构', 'Kevin', '13900000005', '2800元/人天', 2, 'A'],
  ];
  for (const a of ags) ins('INSERT INTO agencies(name,type,contact,phone,price_note,service_days,rating) VALUES(?,?,?,?,?,?,?)', ...a);

  const custs = [
    ['C001', 'HomeDecor GmbH', 'Germany', 'Hans Müller', 'hans@homedecor.de', 'E002', 'A', '展会'],
    ['C002', 'Garden Living LLC', 'USA', 'Emily Brown', 'emily@gardenliving.com', 'E002', 'A', '阿里巴巴'],
    ['C003', 'Maison Céramique SARL', 'France', 'Pierre Martin', 'pierre@maisonc.fr', 'E003', 'B', '老客户介绍'],
  ];
  for (const [code, name, country, contact, email, emp, level, src] of custs) {
    ins('INSERT INTO customers(code,name,country,contact,email,salesman_id,level,source) VALUES(?,?,?,?,?,?,?,?)', code, name, country, contact, email, empId(emp), level, src);
  }

  const curs = [['CNY', '人民币', 1], ['USD', '美元', 7.12], ['EUR', '欧元', 7.75], ['GBP', '英镑', 9.05], ['JPY', '日元', 0.047]];
  for (const c of curs) ins('INSERT INTO currencies(code,name,rate) VALUES(?,?,?)', ...c);
  const terms = [
    ['EXW', '工厂交货', '卖方在其所在地将货物交给买方处置'],
    ['FOB', '装运港船上交货', '卖方负责将货物装上买方指定船只'],
    ['CFR', '成本加运费', '卖方支付到目的港运费'],
    ['CIF', '成本加保险费加运费', '卖方支付运费和保险费'],
    ['DDP', '完税后交货', '卖方承担至目的地全部费用及税费'],
  ];
  for (const t of terms) ins('INSERT INTO trade_terms(code,name,description) VALUES(?,?,?)', ...t);

  const supId = (c) => db.prepare('SELECT id FROM suppliers WHERE code=?').get(c).id;
  const samples = [
    ['YL-V001', 'HD-2026-01', 'HS-881', '浮雕牡丹花瓶', 'Peony Relief Vase', 18, 18, 32, '高白瓷', '浮雕+手绘', '青花', 'E004', 'S001', 28, 15, 300, 52, 40, 70, 6, 300],
    ['YL-V002', '', 'HS-882', '冰裂釉梅瓶', 'Crackle Glaze Plum Vase', 15, 15, 28, '陶瓷', '冰裂釉', '米黄', 'E004', 'S001', 22, 12, 260, 48, 36, 62, 8, 500],
    ['YL-T001', 'GL-CUP-07', 'YY-101', '手绘咖啡杯碟套装', 'Hand-painted Coffee Set', 12, 12, 9, '骨瓷', '手绘描金', '多彩', 'E005', 'S002', 15, 10, 180, 50, 35, 30, 24, 1000],
    ['YL-D001', '', 'YY-205', '卡通动物摆件', 'Cartoon Animal Figurine', 10, 8, 14, '陶瓷', '彩绘', '多彩', 'E005', 'S002', 9, 6, 150, 45, 30, 40, 36, 800],
  ];
  for (const s of samples) {
    const [cno, custNo, fno, name, en, l, w, h, mat, craft, color, emp, sup, mc, lc, fee, ol, ow, oh, pcs, moq] = s;
    ins(`INSERT INTO samples(company_no,customer_no,factory_no,name,name_en,length_cm,width_cm,height_cm,material,craft,color,designer_id,supplier_id,material_cost,labor_cost,sample_fee,
      outer_l,outer_w,outer_h,pcs_per_carton,moq,package_req,label_req,inner_box,progress,stock_qty) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'已完成',3)`,
    cno, custNo, fno, name, en, l, w, h, mat, craft, color, empId(emp), supId(sup), mc, lc, fee, ol, ow, oh, pcs, moq,
    '单个泡沫袋+彩盒', '底部贴Made in China标', '彩盒单只装');
  }
  db.prepare("INSERT INTO sample_revisions(sample_id,stage,content,user_name) VALUES(1,'打样','首版打样完成，牡丹浮雕加深0.5mm','张雕塑')").run();

  const inv = [
    ['M-GL-01', '透明釉', '釉料', 'kg', 200, 18, 100, 1000],
    ['M-CL-01', '高白泥', '陶土', 'kg', 1500, 3.5, 500, 5000],
    ['P-BOX-01', '彩盒（花瓶用）', '包装耗材', '个', 80, 2.2, 200, 3000],
    ['P-CTN-01', '五层外箱', '包装耗材', '个', 4000, 6.5, 300, 2000],
  ];
  for (const i of inv) ins('INSERT INTO inventory(code,name,category,unit,qty,unit_cost,safety_qty,max_qty) VALUES(?,?,?,?,?,?,?,?)', ...i);

  ins("INSERT INTO settings(key,value) VALUES('quote_min_profit','15')");
  ins("INSERT INTO settings(key,value) VALUES('company_name','永联陶瓷工艺品有限公司')");
  ins("INSERT INTO settings(key,value) VALUES('company_name_en','YONLINK CERAMIC CRAFTS CO., LTD.')");
}

/** 新增字段（旧库自动补齐）/ Columns added after v1, auto-added to older databases */
const ADDED_COLUMNS = [
  ['suppliers', 'email', 'TEXT'],
  ['mails', 'account_id', 'INTEGER'],
  ['mails', 'mail_cc', 'TEXT'],
  ['mails', 'status', 'TEXT'],
  ['mails', 'error', 'TEXT'],
  ['mails', 'message_id', 'TEXT'],
  ['mails', 'uid', 'INTEGER'],
  ['mails', 'mail_date', 'TEXT'],
  ['mails', 'attachments', 'TEXT'],
];

/** 新增系统参数默认值 / Default values for settings added after v1 */
const DEFAULT_SETTINGS = {
  rate_api_url: 'https://open.er-api.com/v6/latest/CNY',
  rate_auto_hours: '24',
  rate_max_change: '30',
  mail_fetch_minutes: '10',
  mail_initial_sync: '50',
};

/**
 * 数据库结构升级：补字段、补参数 / Schema migration: add missing columns and settings.
 * @param {DatabaseSync} db
 */
function migrate(db) {
  for (const [table, col, type] of ADDED_COLUMNS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  }
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)').run(k, v);
}

/**
 * 打开数据库（不存在则建表并写入演示数据）
 * Open the database, creating schema and seed data on first run.
 * @param {string} file 数据库文件路径，':memory:' 表示内存库 / DB file path or ':memory:'
 * @param {{reset?: boolean}} [opts]
 * @returns {DatabaseSync}
 */
function openDb(file, opts = {}) {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (opts.reset && fs.existsSync(file)) fs.rmSync(file);
  }
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=OFF;');
  db.exec(SCHEMA);
  migrate(db);
  const has = db.prepare('SELECT COUNT(*) c FROM modules').get().c;
  if (!has) {
    db.exec('BEGIN');
    try {
      seed(db);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  return db;
}

module.exports = { openDb, hashPassword, ACTIONS, MODULES };
