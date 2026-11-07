'use strict';
/**
 * 档案类实体元数据（通用增删改查 + 前端自动生成表单）
 * Master-data entity metadata driving generic CRUD and auto-generated UI forms.
 * @module server/entities
 */

/**
 * 字段定义快捷函数 / Field definition helper.
 * @param {string} name 字段名 / column
 * @param {string} label 中文名 / label
 * @param {object} [o] 其它属性 / extra props (type, options, ref, required, list, readonly)
 * @returns {object}
 */
const f = (name, label, o = {}) => ({ name, label, type: 'text', list: true, ...o });

const RATING = ['A', 'B', 'C', 'D'];
/** 使用状态（亿星“停用”）/ Active flag, maps 亿星's 停用 checkbox */
const USE_STATUS = ['启用', '停用'];
/** 客户来源 / Customer sources */
const CUSTOMER_SOURCES = ['展会', '广交会', '阿里巴巴', '官网', '老客户介绍', '社媒', '其它'];
/** 厂家采购类型（亿星）/ 亿星 supplier purchase types */
const PURCHASE_TYPES = ['产品', '配件', '包材', '工序', '其它'];
/** 厂家状态（亿星）/ 亿星 supplier cooperation status */
const COOP_STATUS = ['战略供应商', '优先供应商', '一般供应商', '考察供应商', '停止合作'];

/** @type {Object<string, object>} */
const ENTITIES = {
  department: {
    module: 'hr', table: 'departments', title: '部门', search: ['name'],
    fields: [f('name', '部门名称', { required: true }), f('manager', '负责人'), f('remark', '备注', { type: 'textarea' })],
  },
  employee: {
    module: 'hr', table: 'employees', title: '员工档案', search: ['emp_no', 'name', 'phone'],
    fields: [
      f('emp_no', '工号', { required: true }), f('name', '姓名', { required: true }),
      f('dept_id', '部门', { type: 'ref', ref: 'department' }), f('position', '岗位'),
      f('phone', '电话'), f('email', '邮箱', { list: false }), f('hire_date', '入职日期', { type: 'date' }),
      f('status', '状态', { type: 'select', options: ['在职', '离职'], default: '在职' }), f('remark', '备注', { type: 'textarea', list: false }),
    ],
  },
  supplier: {
    module: 'supplier', table: 'suppliers', title: '供应商', search: ['code', 'name', 'item_range', 'contact'],
    fields: [
      f('code', '编码', { required: true }), f('name', '名称', { required: true }),
      f('type', '类型', { type: 'select', options: ['原辅材料供应商', '成品生产工厂', '外购成品供应商'], required: true }),
      f('contact', '联系人'), f('phone', '电话'), f('email', '邮箱（询价单邮件发送）', { list: false }), f('address', '地址', { list: false }), f('settlement', '结算方式'),
      f('item_range', '生产货号/品类范围'), f('rating', '评级', { type: 'select', options: RATING }),
      f('pass_rate', '供货合格率%', { type: 'number' }), f('qualification', '资质说明', { type: 'textarea', list: false }),
      // 亿星兼容字段 / 亿星-compatible fields
      f('full_name', '厂家全称', { list: false }), f('purchase_type', '采购类型', { type: 'select', options: PURCHASE_TYPES, list: false }),
      f('coop_status', '厂家状态', { type: 'select', options: COOP_STATUS, list: false }),
      f('mobile', '移动电话', { list: false }), f('fax', '传真', { list: false }), f('province', '省份', { list: false }), f('city', '城市', { list: false }),
      f('tax_no', '税号', { list: false }), f('bank_name', '开户银行', { list: false }), f('bank_account', '银行账号', { list: false }),
      f('tax_rate', '开票税率%', { type: 'number', list: false }), f('partner_supplier_id', '合作厂家(包材厂随产品厂开票)', { type: 'ref', ref: 'supplier', list: false }),
      f('use_status', '使用状态', { type: 'select', options: USE_STATUS, default: '启用', list: false }),
      f('remark', '备注', { type: 'textarea', list: false }),
    ],
  },
  supplier_price: {
    module: 'supplier', table: 'supplier_prices', title: '历史供货价格台账', readonly: true, search: ['item_no', 'ref_no'], order: 'id DESC',
    fields: [
      f('supplier_id', '供应商', { type: 'ref', ref: 'supplier' }), f('item_no', '货号/物料'), f('price', '单价', { type: 'number' }),
      f('currency', '币种'), f('source', '来源'), f('ref_no', '关联单号'), f('price_date', '日期', { type: 'date' }),
    ],
  },
  agency: {
    module: 'agency', table: 'agencies', title: '服务机构', search: ['name', 'contact'],
    fields: [
      f('name', '机构名称', { required: true }),
      f('type', '类型', { type: 'select', options: ['产品设计机构', '打样工厂', '货代公司', '报关行', '验货机构'], required: true }),
      f('contact', '联系人'), f('phone', '电话'), f('price_note', '合作价格'), f('service_days', '服务时效(天)', { type: 'number' }),
      f('rating', '合作评价', { type: 'select', options: RATING }), f('remark', '备注', { type: 'textarea', list: false }),
    ],
  },
  agency_record: {
    module: 'agency', table: 'agency_records', title: '对接记录', order: 'id DESC', search: ['content'],
    fields: [f('agency_id', '服务机构', { type: 'ref', ref: 'agency', required: true }), f('content', '对接内容', { type: 'textarea', required: true }),
      f('user_name', '记录人', { readonly: true }), f('created_at', '时间', { readonly: true })],
  },
  customer: {
    module: 'customer', table: 'customers', title: '客户档案', search: ['code', 'name', 'country', 'contact', 'email'],
    scope: { own: 'salesman_id = :emp' }, ownField: 'salesman_id',
    fields: [
      f('code', '客户编码', { required: true }), f('name', '客户名称', { required: true }), f('country', '国别', { required: true }),
      f('contact', '联系人'), f('email', '邮箱'), f('phone', '电话', { list: false }), f('address', '地址', { list: false }),
      f('salesman_id', '业务员', { type: 'ref', ref: 'employee' }), f('level', '等级', { type: 'select', options: RATING }),
      f('source', '来源', { type: 'select', options: CUSTOMER_SOURCES }),
      // 亿星兼容字段 / 亿星-compatible fields
      f('full_name_en', '英文全称', { list: false }), f('full_name_cn', '中文全称', { list: false }), f('address_cn', '中文地址', { list: false }),
      f('province', '省/州', { list: false }), f('city', '城市', { list: false }), f('zip_code', '邮编', { list: false }),
      f('mobile', '移动电话', { list: false }), f('fax', '传真', { list: false }), f('website', '网址', { list: false }),
      f('merchandiser_id', '跟单员', { type: 'ref', ref: 'employee', list: false }),
      f('dest_port', '目的港', { list: false }), f('price_term', '价格条款', { list: false }), f('currency', '币种', { list: false }),
      f('pay_terms', '付款方式', { list: false }), f('commission_rate', '佣金%', { type: 'number', list: false }),
      f('customer_type', '客户类型', { list: false }), f('express_co', '快递公司', { list: false }), f('express_account', '快递账号', { list: false }),
      f('package_req', '包装要求', { type: 'textarea', list: false }), f('inspection_req', '验货要求', { type: 'textarea', list: false }),
      f('use_status', '使用状态', { type: 'select', options: USE_STATUS, default: '启用', list: false }),
      f('remark', '备注', { type: 'textarea', list: false }),
    ],
  },
  customer_follow: {
    module: 'customer', table: 'customer_follows', title: '客户跟进日志', order: 'id DESC', search: ['content'],
    scope: { own: 'customer_id IN (SELECT id FROM customers WHERE salesman_id = :emp)' },
    fields: [
      f('customer_id', '客户', { type: 'ref', ref: 'customer', required: true }),
      f('type', '类型', { type: 'select', options: ['询盘', '跟进', '拜访', '投诉', '其它'] }),
      f('content', '内容', { type: 'textarea', required: true }), f('next_date', '下次跟进', { type: 'date' }),
      f('user_name', '记录人', { readonly: true }), f('created_at', '时间', { readonly: true }),
    ],
  },
  mail: {
    module: 'mail', table: 'mails', title: '业务邮件', order: 'id DESC', search: ['subject', 'mail_from', 'mail_to', 'body'],
    scope: { own: '(account_id IN (SELECT id FROM mail_accounts WHERE owner_user_id = :uid) OR customer_id IN (SELECT id FROM customers WHERE salesman_id = :emp) OR (account_id IS NULL AND customer_id IS NULL))' },
    fields: [
      f('direction', '方向', { type: 'select', options: ['收件', '发件'], required: true }),
      f('mail_from', '发件人', { required: true }), f('mail_to', '收件人', { required: true }), f('subject', '主题', { required: true }),
      f('category', '分类', { type: 'select', options: ['询盘', '报价', '样品', '订单', '出货', '售后', '其它'] }),
      f('body', '正文', { type: 'textarea', list: false }),
      f('customer_id', '绑定客户', { type: 'ref', ref: 'customer' }), f('sample_id', '绑定样品', { type: 'ref', ref: 'sample' }),
      f('quote_id', '绑定报价单', { type: 'ref', ref: 'quote', list: false }), f('order_id', '绑定订单', { type: 'ref', ref: 'order', list: false }),
      f('status', '状态', { readonly: true }), f('created_at', '时间', { readonly: true }),
    ],
  },
  // ---- 客户页签（亿星：联系人、唛头、货代、银行账号）/ customer tabs modelled on 亿星 ----
  customer_contact: {
    module: 'customer', table: 'customer_contacts', title: '客户联系人', search: ['name', 'email', 'phone', 'mobile'], child: true,
    parent: { entity: 'customer', field: 'customer_id' }, scope: { own: 'customer_id IN (SELECT id FROM customers WHERE salesman_id = :emp)' },
    fields: [
      f('customer_id', '客户', { type: 'ref', ref: 'customer', required: true }), f('name', '姓名', { required: true }), f('title', '职务'),
      f('email', 'Email'), f('phone', '电话'), f('mobile', '手机'), f('im', 'WhatsApp/微信/Skype'),
      f('birthday', '生日', { type: 'date', list: false }), f('hobby', '爱好/特点', { list: false }),
      f('is_main', '主联系人', { type: 'select', options: ['是', '否'], default: '否' }), f('remark', '备注', { type: 'textarea', list: false }),
    ],
  },
  customer_mark: {
    module: 'customer', table: 'customer_marks', title: '客户唛头', search: ['name', 'front_mark', 'side_mark'], child: true,
    parent: { entity: 'customer', field: 'customer_id' }, scope: { own: 'customer_id IN (SELECT id FROM customers WHERE salesman_id = :emp)' },
    fields: [
      f('customer_id', '客户', { type: 'ref', ref: 'customer', required: true }), f('name', '唛头名称', { required: true }),
      f('front_mark', '正唛', { type: 'textarea' }), f('side_mark', '侧唛', { type: 'textarea' }), f('inner_mark', '内盒唛', { type: 'textarea' }),
      f('is_default', '默认唛头', { type: 'select', options: ['是', '否'], default: '否' }), f('remark', '备注', { type: 'textarea', list: false }),
    ],
  },
  customer_forwarder: {
    module: 'customer', table: 'customer_forwarders', title: '客户指定货代', search: ['name', 'contact'], child: true,
    parent: { entity: 'customer', field: 'customer_id' }, scope: { own: 'customer_id IN (SELECT id FROM customers WHERE salesman_id = :emp)' },
    fields: [
      f('customer_id', '客户', { type: 'ref', ref: 'customer', required: true }), f('agency_id', '服务机构档案', { type: 'ref', ref: 'agency' }),
      f('name', '货代名称', { required: true }), f('contact', '联系人'), f('phone', '电话'), f('email', 'Email'),
      f('port', '起运港'), f('remark', '备注', { type: 'textarea', list: false }),
    ],
  },
  customer_bank: {
    module: 'customer', table: 'customer_banks', title: '客户银行账号', search: ['bank_name', 'account_no', 'account_name'], child: true,
    parent: { entity: 'customer', field: 'customer_id' }, scope: { own: 'customer_id IN (SELECT id FROM customers WHERE salesman_id = :emp)' },
    fields: [
      f('customer_id', '客户', { type: 'ref', ref: 'customer', required: true }), f('bank_name', '开户银行', { required: true }),
      f('account_name', '账户名称'), f('account_no', '银行账号', { required: true }), f('swift', 'SWIFT代码'), f('currency', '币种'),
      f('bank_address', '银行地址', { list: false }), f('remark', '备注', { type: 'textarea', list: false }),
    ],
  },
  sample: {
    module: 'sample', table: 'samples', title: '样品档案', search: ['company_no', 'customer_no', 'factory_no', 'name', 'name_en'],
    scope: { designer: 'designer_id = :emp' },
    fields: [
      f('company_no', '公司货号', { required: true }), f('customer_no', '客户货号'), f('factory_no', '工厂货号'),
      f('name', '品名', { required: true }), f('name_en', '英文品名', { list: false }),
      f('length_cm', '长cm', { type: 'number', list: false }), f('width_cm', '宽cm', { type: 'number', list: false }), f('height_cm', '高cm', { type: 'number', list: false }),
      f('material', '材质'), f('craft', '工艺'), f('color', '花色'), f('consumables', '耗材', { list: false }),
      f('material_cost', '材料成本¥', { type: 'number', list: false }), f('labor_cost', '人工成本¥', { type: 'number', list: false }), f('sample_fee', '打样费用¥', { type: 'number', list: false }),
      f('designer_id', '设计师', { type: 'ref', ref: 'employee', required: true }), f('supplier_id', '生产工厂', { type: 'ref', ref: 'supplier' }),
      f('package_req', '包装要求', { list: false }), f('label_req', '标签规范', { list: false }), f('inner_box', '内盒标准', { list: false }),
      f('outer_l', '外箱长cm', { type: 'number', list: false }), f('outer_w', '外箱宽cm', { type: 'number', list: false }), f('outer_h', '外箱高cm', { type: 'number', list: false }),
      f('pcs_per_carton', '装箱数', { type: 'number', list: false }), f('moq', 'MOQ', { type: 'number', list: false }),
      f('stock_qty', '样品库存', { type: 'number', list: false }),
      f('progress', '打样进度', { type: 'select', options: ['待打样', '打样中', '已完成', '重做中'] }),
      f('status', '状态', { type: 'select', options: ['正常', '已锁定'], readonly: true }), f('parent_no', '原货号(改样来源)', { readonly: true }),
      // 亿星兼容字段 / 亿星-compatible fields
      f('series', '系列', { list: false }), f('unit', '单位', { list: false, default: 'PC' }), f('set_qty', '套数', { type: 'number', list: false }),
      f('compose_type', '组成方式', { type: 'select', options: ['单件', '组件', '套件'], default: '单件', list: false }),
      f('pack_inner', '包装率-内', { type: 'number', list: false }), f('pack_middle', '包装率-中', { type: 'number', list: false }),
      f('cbm', '外箱体积CBM', { type: 'number', list: false }), f('net_weight', '净重kg/箱', { type: 'number', list: false }), f('gross_weight', '毛重kg/箱', { type: 'number', list: false }),
      f('factory_price', '工厂报价¥', { type: 'number', list: false }), f('tax_rate', '进项税率%', { type: 'number', list: false }), f('hs_code', '海关编码', { list: false }),
      f('desc_cn', '中文描述', { type: 'textarea', list: false }), f('desc_en', '英文描述', { type: 'textarea', list: false }),
      f('use_status', '使用状态', { type: 'select', options: USE_STATUS, default: '启用', list: false }),
      f('images', '图片链接(多张用逗号分隔)', { type: 'textarea', list: false }), f('remark', '备注', { type: 'textarea', list: false }),
    ],
  },
  // ---- 样品明细（亿星：配件明细、包材明细、工序明细、多包装方案）/ sample BOM tabs modelled on 亿星 ----
  sample_part: {
    module: 'sample', table: 'sample_parts', title: '配件/包材明细', search: ['code', 'name', 'spec'], child: true,
    parent: { entity: 'sample', field: 'sample_id' }, scope: { designer: 'sample_id IN (SELECT id FROM samples WHERE designer_id = :emp)' },
    fields: [
      f('sample_id', '样品', { type: 'ref', ref: 'sample', required: true }), f('kind', '类别', { type: 'select', options: ['配件', '包材'], default: '配件', required: true }),
      f('code', '物料编码'), f('name', '名称', { required: true }), f('spec', '规格'),
      f('qty', '用量', { type: 'number', default: 1 }), f('per', '用量按', { type: 'select', options: ['每只', '每箱'], default: '每只' }), f('unit', '单位'),
      f('unit_price', '单价¥', { type: 'number' }), f('supplier_id', '供应商', { type: 'ref', ref: 'supplier' }), f('remark', '备注', { type: 'textarea', list: false }),
    ],
  },
  sample_process: {
    module: 'sample', table: 'sample_processes', title: '工序明细', search: ['name'], child: true, order: 'seq',
    parent: { entity: 'sample', field: 'sample_id' }, scope: { designer: 'sample_id IN (SELECT id FROM samples WHERE designer_id = :emp)' },
    fields: [
      f('sample_id', '样品', { type: 'ref', ref: 'sample', required: true }), f('seq', '顺序', { type: 'number' }), f('name', '工序', { required: true }),
      f('price', '工价¥/只', { type: 'number' }), f('supplier_id', '外发加工厂', { type: 'ref', ref: 'supplier' }), f('remark', '备注', { type: 'textarea', list: false }),
    ],
  },
  sample_package: {
    module: 'sample', table: 'sample_packages', title: '包装方案', search: ['name', 'package_req'], child: true,
    parent: { entity: 'sample', field: 'sample_id' }, scope: { designer: 'sample_id IN (SELECT id FROM samples WHERE designer_id = :emp)' },
    fields: [
      f('sample_id', '样品', { type: 'ref', ref: 'sample', required: true }), f('name', '方案名称', { required: true }),
      f('inner_qty', '内', { type: 'number' }), f('middle_qty', '中', { type: 'number' }), f('outer_qty', '外（装箱数）', { type: 'number', required: true }),
      f('outer_l', '外箱长cm', { type: 'number' }), f('outer_w', '外箱宽cm', { type: 'number' }), f('outer_h', '外箱高cm', { type: 'number' }),
      f('cbm', 'CBM（空=按尺寸算）', { type: 'number' }), f('gw', '毛重kg/箱', { type: 'number' }), f('nw', '净重kg/箱', { type: 'number' }),
      f('package_req', '包装说明', { type: 'textarea' }), f('is_default', '默认方案', { type: 'select', options: ['是', '否'], default: '否' }),
      f('remark', '备注', { type: 'textarea', list: false }),
    ],
  },
  sample_revision: {
    module: 'sample', table: 'sample_revisions', title: '改样日志', order: 'id DESC', search: ['content'],
    scope: { designer: 'sample_id IN (SELECT id FROM samples WHERE designer_id = :emp)' },
    fields: [f('sample_id', '样品', { type: 'ref', ref: 'sample', required: true }),
      f('stage', '阶段', { type: 'select', options: ['打样', '报价改样', '送样改样', '核验', '转正', '其它'] }),
      f('content', '改样内容', { type: 'textarea', required: true }), f('user_name', '记录人', { readonly: true }), f('created_at', '时间', { readonly: true })],
  },
  currency: {
    module: 'trade', table: 'currencies', title: '币种汇率', pk: 'code', search: ['code', 'name'],
    fields: [f('code', '币种代码', { required: true }), f('name', '名称', { required: true }), f('rate', '对人民币汇率', { type: 'number', required: true }),
      f('updated_at', '更新时间', { readonly: true })],
  },
  rate_history: {
    module: 'trade', table: 'rate_history', title: '汇率波动记录', readonly: true, order: 'id DESC', search: ['code'],
    fields: [f('code', '币种'), f('old_rate', '原汇率', { type: 'number' }), f('new_rate', '新汇率', { type: 'number' }), f('user_name', '操作人'), f('created_at', '时间')],
  },
  trade_term: {
    module: 'trade', table: 'trade_terms', title: '贸易术语', pk: 'code', search: ['code', 'name'],
    fields: [f('code', '术语代码', { required: true }), f('name', '中文名称', { required: true }), f('description', '说明', { type: 'textarea' })],
  },
  warehouse: {
    module: 'purchase', table: 'warehouses', title: '仓库', search: ['code', 'name', 'keeper'],
    fields: [
      f('code', '仓库编码', { required: true }), f('name', '仓库名称', { required: true }),
      f('type', '类型', { type: 'select', options: ['综合仓', '原料仓', '包材仓', '成品仓', '样品室', '外协仓'] }),
      f('keeper', '仓管员'), f('address', '地址', { list: false }), f('use_status', '使用状态', { type: 'select', options: USE_STATUS, default: '启用' }),
      f('remark', '备注', { type: 'textarea', list: false }),
    ],
  },
  inventory: {
    module: 'purchase', table: 'inventory', title: '物料库存', search: ['code', 'name', 'category'],
    fields: [
      f('code', '物料编码', { required: true }), f('name', '物料名称', { required: true }),
      f('category', '类别', { type: 'select', options: ['陶土', '釉料', '色料', '包装耗材', '配件', '成品', '外购成品', '其它'] }),
      f('unit', '单位'), f('qty', '库存数量（直接修改记为库存调整）', { type: 'number' }), f('unit_cost', '单位成本¥', { type: 'number' }),
      f('warehouse_id', '默认仓库', { type: 'ref', ref: 'warehouse' }),
      f('safety_qty', '安全库存(缺料预警)', { type: 'number' }), f('max_qty', '最高库存(积压预警)', { type: 'number' }), f('remark', '备注', { type: 'textarea', list: false }),
    ],
  },
  log: {
    module: 'system', table: 'logs', title: '系统日志', readonly: true, order: 'id DESC', search: ['user_name', 'action', 'target', 'module'],
    fields: [f('type', '类型'), f('user_name', '用户'), f('module', '模块'), f('action', '操作'), f('target', '对象'), f('detail', '详情'), f('ip', 'IP'), f('created_at', '时间')],
  },
};


/**
 * 列表导航树可分组字段、默认导航方案、快速查找字段（参照亿星“导航树”“快速查找区”）
 * Navigation-tree group fields, default tree schemes and quick-search fields per entity (modelled on 亿星).
 */
const NAV = {
  department: { tree: ['manager'], schemes: [['manager']], quick: ['name'] },
  employee: { tree: ['dept_id', 'position', 'status'], schemes: [['dept_id', 'status'], ['status']], quick: ['emp_no', 'name', 'phone'] },
  supplier: { tree: ['type', 'purchase_type', 'coop_status', 'rating', 'province', 'city', 'settlement', 'use_status'], schemes: [['type', 'rating'], ['purchase_type', 'coop_status'], ['province', 'city'], ['rating']], quick: ['code', 'name', 'contact', 'phone', 'item_range'] },
  supplier_price: { tree: ['supplier_id', 'currency', 'source'], schemes: [['supplier_id'], ['source']], quick: ['item_no', 'ref_no'] },
  agency: { tree: ['type', 'rating'], schemes: [['type'], ['rating']], quick: ['name', 'contact', 'phone'] },
  agency_record: { tree: ['agency_id', 'user_name'], schemes: [['agency_id']], quick: ['content'] },
  customer: { tree: ['salesman_id', 'merchandiser_id', 'country', 'level', 'source', 'customer_type', 'province', 'city', 'price_term', 'currency', 'use_status'], schemes: [['salesman_id', 'country'], ['country', 'level'], ['source'], ['level'], ['use_status']], quick: ['code', 'name', 'contact', 'email', 'phone', 'full_name_en'] },
  customer_follow: { tree: ['customer_id', 'type', 'user_name'], schemes: [['customer_id', 'type'], ['type']], quick: ['content'] },
  mail: { tree: ['direction', 'category', 'customer_id', 'status'], schemes: [['category'], ['direction'], ['customer_id']], quick: ['subject', 'mail_from', 'mail_to'] },
  sample: { tree: ['series', 'material', 'craft', 'color', 'supplier_id', 'designer_id', 'progress', 'status', 'compose_type', 'unit', 'use_status'], schemes: [['supplier_id', 'material'], ['designer_id', 'progress'], ['series', 'material'], ['status'], ['use_status']], quick: ['company_no', 'customer_no', 'factory_no', 'name', 'name_en'] },
  sample_revision: { tree: ['sample_id', 'stage', 'user_name'], schemes: [['stage'], ['sample_id']], quick: ['content'] },
  currency: { tree: [], schemes: [], quick: ['code', 'name'] },
  rate_history: { tree: ['code', 'user_name'], schemes: [['code']], quick: ['code'] },
  trade_term: { tree: [], schemes: [], quick: ['code', 'name'] },
  inventory: { tree: ['category', 'unit', 'warehouse_id'], schemes: [['category'], ['warehouse_id', 'category']], quick: ['code', 'name'] },
  warehouse: { tree: ['type', 'use_status'], schemes: [['type']], quick: ['code', 'name'] },
  log: { tree: ['type', 'module', 'user_name', 'action'], schemes: [['module', 'action'], ['user_name'], ['type']], quick: ['user_name', 'action', 'target', 'ip'] },
  customer_contact: { tree: ['customer_id', 'is_main'], schemes: [['customer_id']], quick: ['name', 'email', 'phone'] },
  customer_mark: { tree: ['customer_id'], schemes: [['customer_id']], quick: ['name'] },
  customer_forwarder: { tree: ['customer_id'], schemes: [['customer_id']], quick: ['name', 'contact'] },
  customer_bank: { tree: ['customer_id', 'currency'], schemes: [['customer_id']], quick: ['bank_name', 'account_no'] },
  sample_part: { tree: ['kind', 'supplier_id', 'unit'], schemes: [['kind', 'supplier_id']], quick: ['code', 'name'] },
  sample_process: { tree: ['name', 'supplier_id'], schemes: [['name']], quick: ['name'] },
  sample_package: { tree: ['name', 'is_default'], schemes: [['name']], quick: ['name'] },
};
for (const [k, v] of Object.entries(NAV)) if (ENTITIES[k]) Object.assign(ENTITIES[k], v);

/** 客户的子表（删除客户时一并删除）/ Child tables removed together with a customer */
const CHILDREN = {
  customer: [['customer_contacts', 'customer_id'], ['customer_marks', 'customer_id'], ['customer_forwarders', 'customer_id'], ['customer_banks', 'customer_id']],
  sample: [['sample_parts', 'sample_id'], ['sample_processes', 'sample_id'], ['sample_packages', 'sample_id']],
};

/** 引用实体显示字段 / Display expression for referenced entities */
const REF_LABEL = {
  department: { table: 'departments', label: 'name' },
  employee: { table: 'employees', label: "name || '(' || emp_no || ')'" },
  supplier: { table: 'suppliers', label: 'name' },
  agency: { table: 'agencies', label: 'name' },
  customer: { table: 'customers', label: "name || ' / ' || code" },
  sample: { table: 'samples', label: "company_no || ' ' || name" },
  quote: { table: 'quotes', label: 'quote_no' },
  order: { table: 'orders', label: 'order_no' },
  role: { table: 'roles', label: 'name' },
  inventory: { table: 'inventory', label: "code || ' ' || name" },
  warehouse: { table: 'warehouses', label: 'name' },
  currency: { table: 'currencies', label: "code || ' ' || name", pk: 'code' },
  trade_term: { table: 'trade_terms', label: "code || ' ' || name", pk: 'code' },
};

module.exports = { ENTITIES, REF_LABEL, CHILDREN, RATING, USE_STATUS, CUSTOMER_SOURCES, PURCHASE_TYPES, COOP_STATUS };
