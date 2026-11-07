'use strict';
/**
 * 数据迁移引擎：识别亿星导出表格的列名，校验后批量导入，支持按批次回滚
 * Data-migration engine: recognises 亿星 (Esun) export column names, validates, imports in batches and supports rollback.
 * @module server/migrate
 */
const { HttpError } = require('./http');
const { num, round, log, syncDefaultPackage } = require('./core');
const { CHILDREN, RATING, USE_STATUS, CUSTOMER_SOURCES, PURCHASE_TYPES, COOP_STATUS } = require('./entities');

/**
 * 列定义快捷函数 / Column definition helper.
 * @param {string} field 系统字段 / column in our table
 * @param {string} label 模板列名（采用亿星叫法）/ template header, using 亿星 wording
 * @param {string[]} [aliases] 亿星/常见表格中的其它叫法 / other names seen in 亿星 or common sheets
 * @param {object} [o] 其它属性 / type: text|number|int|ref|select|status|size, required, ref, options, fallback
 * @returns {object}
 */
const c = (field, label, aliases = [], o = {}) => ({ field, label, aliases, type: 'text', ...o });

/**
 * 可导入的资料类型。导入顺序建议：厂家 → 客户 → 样品（样品需引用厂家）
 * Importable profiles. Suggested order: suppliers → customers → samples (samples reference suppliers).
 */
const PROFILES = {
  supplier: {
    title: '厂家档案', table: 'suppliers', key: 'code', module: 'supplier', order: 1,
    hint: '对应亿星【基础数据 → 公共资料 → 厂家管理】，在厂家管理列表用“单据输出/Excel导出”得到表格。',
    columns: [
      c('code', '厂家编号', ['厂家代码', '厂家编码', '供应商编号', '供应商编码', '编号', '代码'], { required: true }),
      c('name', '厂家简称', ['简称', '厂家名称', '供应商名称', '供应商简称', '厂名', '名称'], { required: true }),
      c('full_name', '厂家全称', ['全称', '中文全称', '公司全称', '工厂全称']),
      c('purchase_type', '采购类型', ['供应类型', '厂家类型'], { type: 'select', options: PURCHASE_TYPES, fallback: '其它' }),
      c('type', '供应商类型', ['本系统供应商类型'], { type: 'select', options: ['原辅材料供应商', '成品生产工厂', '外购成品供应商'] }),
      c('coop_status', '厂家状态', ['供应商状态', '合作状态', '合作等级'], { type: 'select', options: COOP_STATUS, fallback: '一般供应商' }),
      c('rating', '评级', ['厂家等级', '供应商等级', '等级'], { type: 'select', options: RATING }),
      c('contact', '联系人', ['主联系人', '主要联系人']),
      c('phone', '联系电话', ['电话', '固定电话']),
      c('mobile', '移动电话', ['手机', '手机号']),
      c('fax', '传真', ['传真号码']),
      c('email', 'Email', ['E-mail', '邮箱', '电子邮件', '邮件地址']),
      c('province', '省份', ['省', '省/州']),
      c('city', '城市', ['市']),
      c('address', '地址', ['厂家地址', '工厂地址', '中文地址']),
      c('item_range', '主营产品', ['主营', '经营范围', '生产范围', '主要产品']),
      c('settlement', '付款方式', ['结算方式', '付款条件']),
      c('tax_no', '税号', ['纳税人识别号', '统一社会信用代码']),
      c('bank_name', '开户银行', ['开户行', '银行名称']),
      c('bank_account', '银行账号', ['账号', '银行帐号']),
      c('tax_rate', '开票税率', ['税率', '进项税率', '开票税率%'], { type: 'number' }),
      c('partner_supplier_id', '合作厂家', ['合作厂家编号', '合作包材厂'], { type: 'ref', ref: 'supplier', soft: true }),
      c('use_status', '停用', ['使用状态', '是否停用'], { type: 'status' }),
      c('remark', '备注', ['资料说明', '说明']),
    ],
  },
  customer: {
    title: '客户档案', table: 'customers', key: 'code', module: 'customer', order: 2,
    hint: '对应亿星【基础数据 → 公共资料 → 客户管理】，在客户管理列表用“单据输出/Excel导出”得到表格。业务员、跟单员按员工姓名或工号匹配。',
    columns: [
      c('code', '客户编号', ['客户代码', '客户编码', '编号', 'Customer No', 'Code'], { required: true }),
      c('name', '客户简称', ['简称', '客户名称', '客户名', 'Customer', 'Short Name'], { required: true }),
      c('full_name_en', '英文全称', ['英文名称', '客户全称', '公司全称', 'Company Name']),
      c('full_name_cn', '中文全称', ['中文名称']),
      c('country', '国别', ['国家', '国家/地区', '国家地区', 'Country'], { required: true, fallback: '未填写' }),
      c('province', '省/州', ['省州', '省', '州', '省份']),
      c('city', '城市', ['市', 'City']),
      c('zip_code', '邮编', ['邮政编码', 'Zip']),
      c('address', '英文地址', ['地址', 'Address']),
      c('address_cn', '中文地址', []),
      c('contact', '主联系人', ['联系人', '主要联系人', 'Contact']),
      c('phone', '联系电话', ['电话', 'Tel', 'Phone']),
      c('mobile', '移动电话', ['手机', 'Mobile']),
      c('fax', '传真', ['传真号码', 'Fax']),
      c('email', 'Email', ['E-mail', '邮箱', '电子邮件']),
      c('website', '网址', ['网站', 'Website']),
      c('salesman_id', '业务员', ['业务', '负责业务员'], { type: 'ref', ref: 'employee' }),
      c('merchandiser_id', '跟单员', ['跟单'], { type: 'ref', ref: 'employee' }),
      c('dest_port', '目的港', ['目的港口']),
      c('price_term', '价格条款', ['贸易术语', '成交方式', '价格术语']),
      c('currency', '币种', ['币别', '结算币种']),
      c('pay_terms', '付款方式', ['付款条件', '收款方式']),
      c('commission_rate', '佣金', ['佣金%', '佣金比例', '佣金率'], { type: 'number' }),
      c('level', '客户等级', ['等级', '客户分级', '级别'], { type: 'select', options: RATING }),
      c('customer_type', '客户类型', ['客户分类', '类型']),
      c('source', '客户来源', ['来源'], { type: 'select', options: CUSTOMER_SOURCES, fallback: '其它' }),
      c('express_co', '快递公司', []),
      c('express_account', '快递账号', ['快递帐号']),
      c('package_req', '包装要求', []),
      c('inspection_req', '验货要求', []),
      c('use_status', '停用', ['使用状态', '是否停用'], { type: 'status' }),
      c('remark', '备注', ['说明']),
    ],
  },
  sample: {
    title: '样品档案（货号）', table: 'samples', key: 'company_no', module: 'sample', order: 3,
    hint: '对应亿星【基础数据 → 样品管理 → 样品档案】，用“Excel操作 → Excel导出”或“单据输出”得到表格。请先导入厂家档案，厂家按编号或简称匹配；表格中没有设计师时使用下方“默认设计师”。',
    columns: [
      c('company_no', '货号', ['公司货号', '产品编号', '产品货号', 'Item No', 'Item'], { required: true }),
      c('customer_no', '客号', ['客户货号', '客人货号']),
      c('factory_no', '厂号', ['工厂货号', '厂家货号']),
      c('name', '中文品名', ['品名', '产品名称', '中文名称', '品名(中文)'], { required: true }),
      c('name_en', '英文品名', ['英文名称', '英文名', 'Description', '品名(英文)']),
      c('desc_cn', '中文品名描述', ['中文描述']),
      c('desc_en', '英文品名描述', ['英文描述']),
      c('series', '系列', ['产品系列']),
      c('material', '材质', ['材料']),
      c('craft', '工艺', ['生产工艺']),
      c('color', '颜色', ['花色', '颜色/花色']),
      c('unit', '单位', ['报价单位', '计量单位']),
      c('set_qty', '套数', ['每套件数'], { type: 'int' }),
      c('compose_type', '组成方式', [], { type: 'select', options: ['单件', '组件', '套件'], fallback: '单件' }),
      c('length_cm', '产品长CM', ['产品长', '长CM', '长'], { type: 'number' }),
      c('width_cm', '产品宽CM', ['产品宽', '宽CM', '宽'], { type: 'number' }),
      c('height_cm', '产品高CM', ['产品高', '高CM', '高'], { type: 'number' }),
      c('product_size', '产品尺寸', ['产品尺寸CM', '产品规格'], { type: 'size', into: ['length_cm', 'width_cm', 'height_cm'] }),
      c('pack_inner', '内', ['包装率-内', '内盒装数', '内装数'], { type: 'int' }),
      c('pack_middle', '中', ['包装率-中', '中盒装数', '中装数'], { type: 'int' }),
      c('pcs_per_carton', '外', ['包装率-外', '外箱装数', '装箱数', '装箱率'], { type: 'int' }),
      c('outer_l', '外箱长CM', ['外箱长'], { type: 'number' }),
      c('outer_w', '外箱宽CM', ['外箱宽'], { type: 'number' }),
      c('outer_h', '外箱高CM', ['外箱高'], { type: 'number' }),
      c('carton_size', '外箱规格', ['外箱规格CM', '外箱尺寸'], { type: 'size', into: ['outer_l', 'outer_w', 'outer_h'] }),
      c('cbm', 'CBM', ['体积', 'CBM/CTN', '外箱体积'], { type: 'number' }),
      c('net_weight', '净重', ['净重KG', '净重/箱'], { type: 'number' }),
      c('gross_weight', '毛重', ['毛重KG', '毛重/箱'], { type: 'number' }),
      c('factory_price', '工厂报价', ['厂价', '单价', '采购价', '成本价'], { type: 'number' }),
      c('tax_rate', '进项税率', ['税率', '进项税率%'], { type: 'number' }),
      c('hs_code', '海关编码', ['HS编码', 'HS Code', '商品编码']),
      c('moq', 'MOQ', ['起订量', '最小起订量'], { type: 'int' }),
      c('supplier_id', '厂家', ['厂家简称', '厂家编号', '工厂', '供应商', '生产厂家'], { type: 'ref', ref: 'supplier' }),
      c('designer_id', '设计师', ['开发人员', '设计'], { type: 'ref', ref: 'employee' }),
      c('package_req', '包装方式', ['包装要求', '包装说明']),
      c('label_req', '标签要求', ['标签规范']),
      c('use_status', '停用', ['使用状态', '是否停用'], { type: 'status' }),
      c('remark', '产品备注', ['备注']),
    ],
  },
  sample_part: {
    title: '样品配件/包材明细', table: 'sample_parts', key: 'name', match: ['sample_id', 'kind', 'name'], module: 'sample', order: 4,
    defaults: { kind: '配件', per: '每只', qty: 1 },
    hint: '对应亿星样品档案的“配件明细Excel导入”“包材明细Excel导入”。同一货号下按“类别+名称”识别同一条明细；请先导入样品档案。',
    columns: [
      c('sample_id', '货号', ['公司货号', '产品编号', '主货号'], { type: 'ref', ref: 'sample', required: true }),
      c('kind', '类别', ['明细类别', '类型', '配件/包材'], { type: 'select', options: ['配件', '包材'], fallback: '配件' }),
      c('code', '材料编号', ['物料编码', '材料编码', '配件编号', '包材编号']),
      c('name', '材料名称', ['名称', '配件名称', '包材名称', '物料名称'], { required: true }),
      c('spec', '规格', ['规格型号']),
      c('qty', '数量', ['用量', '单件用量'], { type: 'number' }),
      c('per', '用量按', ['计量方式'], { type: 'select', options: ['每只', '每箱'], fallback: '每只' }),
      c('unit', '单位', ['计量单位']),
      c('unit_price', '单价', ['单价¥', '价格', '采购价'], { type: 'number' }),
      c('supplier_id', '厂家', ['供应商', '厂家简称'], { type: 'ref', ref: 'supplier', soft: true }),
      c('remark', '备注', ['说明']),
    ],
  },
  sample_process: {
    title: '样品工序明细', table: 'sample_processes', key: 'name', match: ['sample_id', 'name'], module: 'sample', order: 5,
    hint: '对应亿星样品档案的“工序明细Excel导入”。同一货号下按工序名称识别同一条明细。',
    columns: [
      c('sample_id', '货号', ['公司货号', '产品编号'], { type: 'ref', ref: 'sample', required: true }),
      c('seq', '顺序', ['序号', '工序顺序'], { type: 'int' }),
      c('name', '工序名称', ['工序', '加工工序'], { required: true }),
      c('price', '工价', ['单价', '加工单价', '工价¥'], { type: 'number' }),
      c('supplier_id', '加工厂', ['厂家', '外发厂', '外发加工厂'], { type: 'ref', ref: 'supplier', soft: true }),
      c('remark', '备注', ['说明']),
    ],
  },
  sample_package: {
    title: '样品包装方案', table: 'sample_packages', key: 'name', match: ['sample_id', 'name'], module: 'sample', order: 6,
    defaults: { is_default: '否' },
    hint: '对应亿星样品“多包装方案”。“默认”列为“是”的方案会同步到样品档案的装箱数、箱规、CBM、毛净重。',
    columns: [
      c('sample_id', '货号', ['公司货号', '产品编号'], { type: 'ref', ref: 'sample', required: true }),
      c('name', '包装方案', ['方案名称', '包装方式', '包装名称'], { required: true }),
      c('inner_qty', '内', ['包装率-内', '内盒装数'], { type: 'int' }),
      c('middle_qty', '中', ['包装率-中', '中盒装数'], { type: 'int' }),
      c('outer_qty', '外', ['包装率-外', '装箱数', '外箱装数'], { type: 'int', required: true }),
      c('outer_l', '外箱长CM', ['外箱长'], { type: 'number' }),
      c('outer_w', '外箱宽CM', ['外箱宽'], { type: 'number' }),
      c('outer_h', '外箱高CM', ['外箱高'], { type: 'number' }),
      c('carton_size', '外箱规格', ['外箱规格CM', '外箱尺寸'], { type: 'size', into: ['outer_l', 'outer_w', 'outer_h'] }),
      c('cbm', 'CBM', ['体积'], { type: 'number' }),
      c('gw', '毛重', ['毛重KG'], { type: 'number' }),
      c('nw', '净重', ['净重KG'], { type: 'number' }),
      c('package_req', '包装说明', ['包装要求']),
      c('is_default', '默认', ['默认方案', '是否默认'], { type: 'yesno' }),
      c('remark', '备注', ['说明']),
    ],
  },
};

/** 回滚时检查的引用（被引用的新增记录不能删除）/ References checked before deleting rows during rollback */
const ROLLBACK_GUARDS = {
  customer: [['quotes', 'customer_id', '报价单'], ['orders', 'customer_id', '订单'], ['sample_sends', 'customer_id', '送样单']],
  supplier: [['purchases', 'supplier_id', '采购单'], ['inquiries', 'supplier_id', '询价单'], ['samples', 'supplier_id', '样品档案']],
  sample: [['quote_items', 'sample_id', '报价明细'], ['order_items', 'sample_id', '订单明细'], ['sample_send_items', 'sample_id', '送样明细']],
};

/** 结果分类（参照亿星导入结果窗口）/ Result buckets, modelled on 亿星's import result window */
const BUCKETS = {
  created: '新增到系统的记录',
  updated: '系统中已存在且已覆盖的记录',
  skipped: '系统中已存在、未覆盖的记录',
  duplicate: 'Excel中重复的记录',
  ref_missing: '关联资料不存在未导入的记录',
  locked: '已锁定未导入的记录',
  invalid: '数据不完整/格式错误未导入的记录',
};

/**
 * 列名标准化：去掉空格、星号、括号、冒号等 / Normalise a header for alias matching.
 * @param {string} s
 * @returns {string}
 */
function norm(s) {
  return String(s || '').toLowerCase().replace(/[\s*:：()（）[\]【】/_\-－.。、]/g, '');
}

/**
 * 取导入资料类型 / Get a profile or throw.
 * @param {string} entity
 * @returns {object}
 */
function profileOf(entity) {
  const p = PROFILES[entity];
  if (!p) throw new HttpError(400, `不支持导入的资料类型：${entity}`);
  return p;
}

/**
 * 按表头自动识别列 / Auto-map spreadsheet headers to profile columns.
 * @param {object} profile
 * @param {string[]} headers
 * @returns {string[]} 每列对应的系统字段（无法识别为空串）/ field per column ('' when unknown)
 */
function autoMap(profile, headers) {
  const dict = new Map();
  // 先登记标准列名，再登记别名，标准列名优先 / labels first so they win over aliases
  for (const col of profile.columns) if (!dict.has(norm(col.label))) dict.set(norm(col.label), col.field);
  for (const col of profile.columns) for (const a of col.aliases) if (!dict.has(norm(a))) dict.set(norm(a), col.field);
  const used = new Set();
  return headers.map((h) => {
    const f = dict.get(norm(h));
    if (!f || used.has(f)) return '';
    used.add(f);
    return f;
  });
}

/**
 * 在前 15 行中找表头行（识别到的列最多的一行）/ Find the header row among the first 15 rows.
 * @param {object} profile
 * @param {string[][]} rows
 * @returns {number} 行序号（从0开始）/ zero-based row index
 */
function detectHeader(profile, rows) {
  let best = 0;
  let bestHits = 0;
  for (let i = 0; i < Math.min(15, rows.length); i++) {
    const hits = autoMap(profile, rows[i] || []).filter(Boolean).length;
    if (hits > bestHits) { best = i; bestHits = hits; }
  }
  return best;
}

/**
 * 解析数字（允许千分位、百分号、单位）/ Parse a number tolerating thousands separators, %, units.
 * @param {string} v
 * @returns {number|null|undefined} 空为 null，无法解析为 undefined / null for blank, undefined when invalid
 */
function parseNum(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const cleaned = s.replace(/[,，\s]/g, '').replace(/(%|cm|CM|kg|KG|pcs|PCS|¥|￥|\$)$/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * 解析“长×宽×高”尺寸 / Parse a "L x W x H" size string.
 * @param {string} v
 * @returns {number[]|null}
 */
function parseSize(v) {
  const parts = String(v || '').split(/\s*[x×X*＊]\s*/).map((p) => parseNum(p.replace(/[^\d.]/g, '')));
  return parts.length === 3 && parts.every((n) => typeof n === 'number') ? parts : null;
}

/**
 * 解析“停用”列 / Parse the 停用 (disabled) column into 启用/停用.
 * @param {string} v
 * @returns {string|null}
 */
function parseStatus(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (USE_STATUS.includes(s)) return s;
  return /^(是|y|yes|true|1|√|✓|已停用|停)$/i.test(s) ? '停用' : '启用';
}

/**
 * 建立关联资料查找表（员工按姓名/工号，厂家按编号/简称/全称）/ Build lookup maps for referenced records.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {{employee:Map<string,number>, supplier:Map<string,number>}}
 */
function buildLookups(db) {
  const employee = new Map();
  for (const e of db.prepare('SELECT id, emp_no, name FROM employees').all()) {
    if (e.emp_no) employee.set(norm(e.emp_no), e.id);
    if (e.name && !employee.has(norm(e.name))) employee.set(norm(e.name), e.id);
  }
  for (const u of db.prepare('SELECT username, employee_id FROM users WHERE employee_id IS NOT NULL').all()) {
    if (!employee.has(norm(u.username))) employee.set(norm(u.username), u.employee_id);
  }
  const supplier = new Map();
  for (const s of db.prepare('SELECT id, code, name, full_name FROM suppliers').all()) {
    for (const k of [s.code, s.name, s.full_name]) if (k && !supplier.has(norm(k))) supplier.set(norm(k), s.id);
  }
  const sample = new Map();
  for (const s of db.prepare('SELECT id, company_no FROM samples').all()) sample.set(norm(s.company_no), s.id);
  return { employee, supplier, sample };
}

/**
 * 把一行表格数据转换为字段值 / Convert one spreadsheet row into field values.
 * @param {object} profile
 * @param {string[]} row
 * @param {string[]} mapping
 * @param {object} lookups
 * @returns {{data:object, errors:string[], missing:string[], warnings:string[], soft:object}}
 */
function convertRow(profile, row, mapping, lookups) {
  const data = {};
  const errors = [];
  const missing = [];
  const warnings = [];
  const soft = {};
  const notes = [];
  const byField = Object.fromEntries(profile.columns.map((col) => [col.field, col]));
  mapping.forEach((field, i) => {
    const col = byField[field];
    if (!col) return;
    const raw = String(row[i] ?? '').trim();
    if (raw === '') return;
    if (col.type === 'number' || col.type === 'int') {
      const n = parseNum(raw);
      if (n === undefined) errors.push(`【${col.label}】不是数字：${raw}`);
      else data[field] = col.type === 'int' ? Math.round(n) : n;
    } else if (col.type === 'size') {
      const s = parseSize(raw);
      if (!s) warnings.push(`【${col.label}】无法拆分为长×宽×高：${raw}`);
      else col.into.forEach((f, k) => { if (data[f] === undefined) data[f] = s[k]; });
    } else if (col.type === 'status') {
      data[field] = parseStatus(raw);
    } else if (col.type === 'yesno') {
      data[field] = /^(是|y|yes|true|1|√|✓|默认)$/i.test(raw) ? '是' : '否';
    } else if (col.type === 'select') {
      if (col.options.includes(raw)) data[field] = raw;
      else {
        // 不在可选项中的原值写入备注，避免迁移丢失信息 / keep non-standard values in the remark so nothing is lost
        notes.push(`${col.label}：${raw}`);
        if (col.fallback) { data[field] = col.fallback; warnings.push(`【${col.label}】“${raw}”不在可选项中，已记为“${col.fallback}”，原值写入备注`); }
        else warnings.push(`【${col.label}】“${raw}”不在可选项（${col.options.join('/')}）中，原值已写入备注`);
      }
    } else if (col.type === 'ref') {
      const id = lookups[col.ref].get(norm(raw));
      if (id) data[field] = id;
      else if (col.soft) soft[field] = raw;
      else missing.push(`${col.label}“${raw}”`);
    } else data[field] = raw;
  });
  return { data, errors, missing, warnings, soft, notes };
}

/**
 * 导入（或校验）表格数据 / Import (or dry-run) spreadsheet rows.
 * @param {object} ctx 请求上下文 / request context (db, user)
 * @param {object} opt
 * @param {string} opt.entity 资料类型 / profile key
 * @param {string[][]} opt.rows 表格行 / sheet rows
 * @param {number} opt.headerRow 表头行序号 / zero-based header row
 * @param {string[]} [opt.mapping] 列映射（缺省自动识别）/ column mapping (auto when omitted)
 * @param {'overwrite'|'skip'} [opt.mode] 已存在时覆盖或跳过 / overwrite or skip existing records
 * @param {boolean} [opt.dryRun] 仅校验不写入 / validate only
 * @param {object} [opt.defaults] 默认值，如 designer_id / defaults such as designer_id
 * @param {string} [opt.fileName]
 * @returns {object} 结果汇总 / result summary
 */
function runImport(ctx, opt) {
  const { db } = ctx;
  const profile = profileOf(opt.entity);
  const headers = opt.rows[opt.headerRow] || [];
  const mapping = Array.isArray(opt.mapping) && opt.mapping.length ? opt.mapping.map((f) => (profile.columns.some((col) => col.field === f) ? f : '')) : autoMap(profile, headers);
  const keyCol = profile.columns.find((col) => col.field === profile.key);
  if (!mapping.includes(profile.key)) throw new HttpError(400, `表格中没有识别到关键列【${keyCol.label}】，请检查表头行或手动指定列对应关系`);
  const mode = opt.mode === 'skip' ? 'skip' : 'overwrite';
  const defaults = opt.defaults || {};
  const lookups = buildLookups(db);
  const result = Object.fromEntries(Object.keys(BUCKETS).map((k) => [k, []]));
  const warnings = [];
  const seen = new Set();
  const batchRows = [];
  const pendingSoft = [];
  const requiredCols = profile.columns.filter((col) => col.required);
  let total = 0;

  db.exec('BEGIN');
  try {
    for (let r = opt.headerRow + 1; r < opt.rows.length; r++) {
      const row = opt.rows[r] || [];
      if (!row.some((v) => String(v ?? '').trim() !== '')) continue;
      total++;
      const excelRow = r + 1;
      const { data, errors, missing, warnings: w, soft, notes } = convertRow(profile, row, mapping, lookups);
      const key = data[profile.key];
      // 复合键（如 货号+类别+名称）：先补默认值再比对 / composite keys: apply defaults before matching
      if (profile.defaults) for (const [k, v] of Object.entries(profile.defaults)) if (data[k] === undefined || data[k] === '') data[k] = v;
      const keyText = profile.match ? `${row[mapping.indexOf('sample_id')] || ''} ${key || ''}`.trim() : key;
      const tagOf = (msg) => ({ row: excelRow, key: keyText || '', msg });
      w.forEach((m) => warnings.push(tagOf(m)));
      if (!key) { result.invalid.push(tagOf(`缺少【${keyCol.label}】`)); continue; }
      const dupKey = profile.match ? profile.match.map((f) => norm(f === 'sample_id' ? row[mapping.indexOf('sample_id')] : data[f])).join('|') : norm(key);
      if (seen.has(dupKey)) { result.duplicate.push(tagOf(`${profile.match ? '同一货号下' : `【${keyCol.label}】`}${key} 在表格中重复出现，只导入第一行`)); continue; }
      seen.add(dupKey);
      if (errors.length) { result.invalid.push(tagOf(errors.join('；'))); continue; }
      if (missing.length) { result.ref_missing.push(tagOf(`${missing.join('、')}在系统中不存在`)); continue; }

      const old = profile.match
        ? db.prepare(`SELECT * FROM ${profile.table} WHERE ${profile.match.map((f) => `${f}=?`).join(' AND ')}`).get(...profile.match.map((f) => data[f]))
        : db.prepare(`SELECT * FROM ${profile.table} WHERE ${profile.key}=?`).get(key);
      if (notes.length) {
        const base = String(data.remark ?? (old ? old.remark : '') ?? '');
        const note = `【亿星原值】${notes.join('；')}`;
        data.remark = base.includes(note) ? base : [base, note].filter(Boolean).join('\n');
      }
      if (old && mode === 'skip') { result.skipped.push(tagOf('系统中已存在，按“跳过”方式未覆盖')); continue; }
      if (old && opt.entity === 'sample' && old.status === '已锁定') { result.locked.push(tagOf('货号已被订单锁定，不允许导入覆盖')); continue; }

      if (!old) {
        // 新增记录补默认值 / fill defaults for new records
        for (const col of requiredCols) {
          if ((data[col.field] === undefined || data[col.field] === '') && col.fallback) {
            data[col.field] = col.fallback;
            warnings.push(tagOf(`【${col.label}】为空，已记为“${col.fallback}”`));
          }
        }
        if (opt.entity === 'sample') {
          if (!data.designer_id && defaults.designer_id) data.designer_id = Number(defaults.designer_id);
          if (!data.designer_id) { result.invalid.push(tagOf('缺少【设计师】，请在表格中填写或选择“默认设计师”')); continue; }
          data.progress = '已完成';
        }
        if (opt.entity === 'customer' && !data.salesman_id && defaults.salesman_id) data.salesman_id = Number(defaults.salesman_id);
        if (opt.entity === 'supplier' && !data.type) {
          data.type = data.purchase_type && data.purchase_type !== '产品' ? '原辅材料供应商' : '成品生产工厂';
        }
        const lack = requiredCols.filter((col) => data[col.field] === undefined || data[col.field] === null || data[col.field] === '');
        if (lack.length) { result.invalid.push(tagOf(`缺少必填项：${lack.map((col) => col.label).join('、')}`)); continue; }
        if (opt.entity === 'sample_package' && !(num(data.cbm) > 0) && data.outer_l && data.outer_w && data.outer_h) data.cbm = round(data.outer_l * data.outer_w * data.outer_h / 1e6, 4);
        const cols = Object.keys(data);
        const ins = db.prepare(`INSERT INTO ${profile.table}(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`).run(...cols.map((k) => data[k]));
        const id = Number(ins.lastInsertRowid);
        if (opt.entity === 'sample_package' && data.is_default === '是') syncDefaultPackage(db, { ...data }, id);
        batchRows.push([id, '新增', null]);
        result.created.push(tagOf('新增'));
        if (Object.keys(soft).length) pendingSoft.push({ id, soft, tag: tagOf });
        if (opt.entity === 'supplier') for (const k of [data.code, data.name, data.full_name]) if (k && !lookups.supplier.has(norm(k))) lookups.supplier.set(norm(k), id);
      } else {
        // 覆盖：只更新表格中有值的列，空单元格不清空原数据 / overwrite only non-blank cells
        if (opt.entity === 'supplier' && data.type === undefined && data.purchase_type && !old.type) data.type = data.purchase_type !== '产品' ? '原辅材料供应商' : '成品生产工厂';
        const cols = Object.keys(data).filter((k) => k !== profile.key && String(old[k] ?? '') !== String(data[k] ?? ''));
        if (cols.length) {
          const before = Object.fromEntries(cols.map((k) => [k, old[k]]));
          db.prepare(`UPDATE ${profile.table} SET ${cols.map((k) => `${k}=?`).join(',')} WHERE id=?`).run(...cols.map((k) => data[k]), old.id);
          if (opt.entity === 'sample_package' && { ...old, ...data }.is_default === '是') syncDefaultPackage(db, { ...old, ...data }, old.id);
          batchRows.push([old.id, '覆盖', JSON.stringify(before)]);
        }
        result.updated.push(tagOf(cols.length ? `已覆盖 ${cols.length} 个字段` : '内容相同，无需修改'));
        if (Object.keys(soft).length) pendingSoft.push({ id: old.id, soft, tag: tagOf, old });
      }
    }
    // 第二遍：解析同一批次内的“合作厂家”等软关联 / second pass: resolve soft references within the same batch
    for (const p of pendingSoft) {
      for (const [field, raw] of Object.entries(p.soft)) {
        const col = profile.columns.find((x) => x.field === field);
        const id = lookups[col.ref].get(norm(raw));
        if (!id) { warnings.push(p.tag(`【${col.label}】“${raw}”在系统中不存在，已忽略`)); continue; }
        if (p.old) {
          const prev = batchRows.find((b) => b[0] === p.id && b[1] === '覆盖');
          if (prev) { const before = JSON.parse(prev[2]); if (!(field in before)) { before[field] = p.old[field]; prev[2] = JSON.stringify(before); } } else batchRows.push([p.id, '覆盖', JSON.stringify({ [field]: p.old[field] })]);
        }
        db.prepare(`UPDATE ${profile.table} SET ${field}=? WHERE id=?`).run(id, p.id);
      }
    }

    const counts = {
      total, created: result.created.length, updated: result.updated.length, skipped: result.skipped.length,
      failed: result.duplicate.length + result.ref_missing.length + result.locked.length + result.invalid.length,
    };
    let batch = null;
    if (!opt.dryRun) {
      const summary = JSON.stringify({ buckets: result, warnings: warnings.slice(0, 500) }, (k, v) => (Array.isArray(v) && v.length > 500 ? v.slice(0, 500) : v));
      const b = db.prepare(`INSERT INTO import_batches(batch_no,entity,file_name,mode,total,created,updated,skipped,failed,result,user_name)
        VALUES(NULL,?,?,?,?,?,?,?,?,?,?)`).run(opt.entity, opt.fileName || '', mode, counts.total, counts.created, counts.updated, counts.skipped, counts.failed, summary, ctx.user.name);
      const bid = Number(b.lastInsertRowid);
      // 批次号 = 时间 + 批次ID，同一秒内多次导入也不会重复 / time + row id, unique even for imports within the same second
      const no = 'IMP' + new Date().toLocaleString('sv-SE').replace(/\D/g, '').slice(2, 14) + String(bid).padStart(4, '0');
      db.prepare('UPDATE import_batches SET batch_no=? WHERE id=?').run(no, bid);
      const insRow = db.prepare('INSERT INTO import_batch_rows(batch_id,record_id,action,before_json) VALUES(?,?,?,?)');
      for (const [id, action, before] of batchRows) insRow.run(bid, id, action, before);
      batch = { id: bid, batch_no: no };
      log(ctx, profile.module, `数据迁移导入${profile.title}`, no, `${opt.fileName || ''}：新增${counts.created} 覆盖${counts.updated} 跳过${counts.skipped} 未导入${counts.failed}`);
    }
    if (opt.dryRun) db.exec('ROLLBACK'); else db.exec('COMMIT');
    return { dry_run: !!opt.dryRun, batch, counts, buckets: result, bucket_names: BUCKETS, warnings: warnings.slice(0, 500), mapping };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * 回滚某次导入（仅允许回滚该资料类型最近一次未回滚的导入）
 * Roll back an import batch (only the latest active batch of its type).
 * @param {object} ctx
 * @param {number|string} id 批次ID / batch id
 * @returns {{deleted:number, restored:number, kept:object[]}}
 */
function rollbackBatch(ctx, id) {
  const { db } = ctx;
  const b = db.prepare('SELECT * FROM import_batches WHERE id=?').get(id);
  if (!b) throw new HttpError(404, '导入批次不存在');
  if (b.status !== '已导入') throw new HttpError(400, '该批次已经回滚过了');
  const latest = db.prepare("SELECT id FROM import_batches WHERE entity=? AND status='已导入' ORDER BY id DESC LIMIT 1").get(b.entity);
  if (latest.id !== b.id) throw new HttpError(400, '只能回滚该资料类型最近一次的导入，请先回滚更晚的批次');
  const profile = profileOf(b.entity);
  const rows = db.prepare('SELECT * FROM import_batch_rows WHERE batch_id=? ORDER BY id DESC').all(b.id);
  const kept = [];
  let deleted = 0;
  let restored = 0;
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      if (r.action === '新增') {
        const refs = (ROLLBACK_GUARDS[b.entity] || []).map(([t, col, label]) => [label, db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE ${col}=?`).get(r.record_id).c]).filter(([, n]) => n);
        if (refs.length) {
          const rec = db.prepare(`SELECT ${profile.key} k FROM ${profile.table} WHERE id=?`).get(r.record_id);
          kept.push({ key: rec ? rec.k : r.record_id, msg: `已被${refs.map(([l, n]) => `${n}条${l}`).join('、')}引用，保留未删除` });
          continue;
        }
        for (const [t, col] of CHILDREN[b.entity] || []) db.prepare(`DELETE FROM ${t} WHERE ${col}=?`).run(r.record_id);
        deleted += Number(db.prepare(`DELETE FROM ${profile.table} WHERE id=?`).run(r.record_id).changes);
      } else if (r.action === '覆盖' && r.before_json) {
        const before = JSON.parse(r.before_json);
        const cols = Object.keys(before).filter((k) => /^\w+$/.test(k));
        if (cols.length) {
          db.prepare(`UPDATE ${profile.table} SET ${cols.map((k) => `${k}=?`).join(',')} WHERE id=?`).run(...cols.map((k) => before[k]), r.record_id);
          restored++;
        }
      }
    }
    db.prepare("UPDATE import_batches SET status='已回滚', rolled_back_at=datetime('now','localtime') WHERE id=?").run(b.id);
    log(ctx, profile.module, `回滚数据迁移导入${profile.title}`, b.batch_no, `删除新增${deleted} 恢复覆盖${restored} 保留${kept.length}`);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { deleted, restored, kept };
}

/**
 * 导入模板的表头（亿星叫法，必填列带 *）/ Template headers in 亿星 wording, required ones starred.
 * @param {string} entity
 * @returns {string[]}
 */
function templateHeaders(entity) {
  return profileOf(entity).columns.map((col) => col.label + (col.required ? '*' : ''));
}

/** 供前端展示的资料类型说明 / Profile descriptions for the UI */
function profileList() {
  return Object.entries(PROFILES).sort((a, b) => a[1].order - b[1].order).map(([key, p]) => ({
    key, title: p.title, hint: p.hint, module: p.module,
    columns: p.columns.map((col) => ({ field: col.field, label: col.label, required: !!col.required, aliases: col.aliases, type: col.type })),
  }));
}

module.exports = { PROFILES, BUCKETS, profileOf, profileList, autoMap, detectHeader, runImport, rollbackBatch, templateHeaders, parseNum, parseSize, norm };
