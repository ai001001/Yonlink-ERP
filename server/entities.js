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
      f('source', '来源', { type: 'select', options: ['展会', '阿里巴巴', '官网', '老客户介绍', '社媒', '其它'] }),
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
      f('images', '图片链接(多张用逗号分隔)', { type: 'textarea', list: false }), f('remark', '备注', { type: 'textarea', list: false }),
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
  inventory: {
    module: 'purchase', table: 'inventory', title: '物料库存', search: ['code', 'name', 'category'],
    fields: [
      f('code', '物料编码', { required: true }), f('name', '物料名称', { required: true }),
      f('category', '类别', { type: 'select', options: ['陶土', '釉料', '色料', '包装耗材', '配件', '外购成品', '其它'] }),
      f('unit', '单位'), f('qty', '库存数量', { type: 'number' }), f('unit_cost', '单位成本¥', { type: 'number' }),
      f('safety_qty', '安全库存(缺料预警)', { type: 'number' }), f('max_qty', '最高库存(积压预警)', { type: 'number' }), f('remark', '备注', { type: 'textarea', list: false }),
    ],
  },
  log: {
    module: 'system', table: 'logs', title: '系统日志', readonly: true, order: 'id DESC', search: ['user_name', 'action', 'target', 'module'],
    fields: [f('type', '类型'), f('user_name', '用户'), f('module', '模块'), f('action', '操作'), f('target', '对象'), f('detail', '详情'), f('ip', 'IP'), f('created_at', '时间')],
  },
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
  currency: { table: 'currencies', label: "code || ' ' || name", pk: 'code' },
  trade_term: { table: 'trade_terms', label: "code || ' ' || name", pk: 'code' },
};

module.exports = { ENTITIES, REF_LABEL };
