'use strict';
/**
 * 外贸业务路由：报价、工厂询价子模块、送样与改样新货号闭环
 * Sales routes: quotations, factory inquiry sub-module, sample sending & new item number workflow.
 * @module server/routes/sales
 */
const { HttpError } = require('../http');
const { need, can, log, nextNo, tx, num, round, required, assertSampleUsable, setting, today } = require('../core');
const { buildXlsx } = require('../xlsx');

/**
 * 单据级数据范围（业务员看本人，设计师看含本人样品的单据）
 * Document-level data scope: sales see own docs, designers see docs containing their samples.
 * @param {object} ctx
 * @param {string} alias 主表别名 / header alias
 * @param {string} itemTable 明细表 / item table
 * @param {string} fk 明细外键 / foreign key
 * @returns {{sql:string, params:any[]}}
 */
function docScope(ctx, alias, itemTable, fk) {
  const emp = ctx.user.employee_id || -1;
  if (ctx.user.scope === 'own') return { sql: `${alias}.salesman_id = ?`, params: [emp] };
  if (ctx.user.scope === 'designer') {
    return { sql: `EXISTS (SELECT 1 FROM ${itemTable} i JOIN samples s ON s.id=i.sample_id WHERE i.${fk}=${alias}.id AND s.designer_id=?)`, params: [emp] };
  }
  return { sql: '', params: [] };
}

/**
 * 设计师仅保留本人样品明细 / For designers keep only lines of their own samples.
 * @param {object} ctx
 * @param {object[]} items
 * @returns {object[]}
 */
function filterItemsForDesigner(ctx, items) {
  if (ctx.user.scope !== 'designer') return items;
  return items.filter((i) => i.designer_id === ctx.user.employee_id);
}

/**
 * 外箱体积（立方米）/ Carton volume in m³ (stored CBM first, else from outer dimensions).
 * @param {object} s 样品或含外箱字段的明细 / sample-like row
 * @returns {number}
 */
function cartonCbm(s) {
  if (num(s.cbm) > 0) return num(s.cbm);
  return s.outer_l && s.outer_w && s.outer_h ? num(s.outer_l) * num(s.outer_w) * num(s.outer_h) / 1e6 : 0;
}

/**
 * 计算报价单价与利润（参照亿星：单价 = 报价基准 ÷ 换汇成本 × (1+利润率)）
 * Compute quote prices and profit, as in 亿星: price = cost base ÷ FX cost × (1 + profit rate).
 *  - 报价基准 = 成本 + 工艺加价 + 物流报关费分摊 / cost base = cost + craft add-on + allocated fees
 *  - 费用分摊：按数量，或按体积（每行体积 = 数量 ÷ 装箱数 × 每箱CBM）/ fees by quantity or by volume
 *  - 每行可单独设利润率（空 = 整单目标利润率）；锁定单价的行不重算，反算实际利润率
 *    per-line profit rate (blank = header rate); locked lines keep their price and the rate is derived
 * @param {object} q 报价单头 / quote header (rate, fx_cost, profit_rate, freight, customs_fee, fee_alloc)
 * @param {object[]} items 明细 / items (qty, cost_cny, craft_add, price, profit_rate, price_locked, pcs_per_carton, cbm/outer_*)
 * @param {boolean} auto 是否重算未锁定行的单价 / recompute prices of unlocked lines
 * @returns {{items:object[], totalQty:number, amount:number, profit:number, fee_alloc:string, fee_fallback:boolean}}
 */
function priceQuote(q, items, auto) {
  const rate = num(q.rate) || 1;
  const divisor = num(q.fx_cost) > 0 ? num(q.fx_cost) : rate;
  const fees = num(q.freight) + num(q.customs_fee);
  const totalQty = items.reduce((s, i) => s + num(i.qty), 0);
  // 按体积分摊：每行体积 = 箱数 × 每箱CBM；任一行缺装箱资料则退回按数量 / volume allocation, falls back to quantity
  let byVolume = q.fee_alloc === '按体积';
  const vols = items.map((i) => (num(i.pcs_per_carton) > 0 && cartonCbm(i) > 0 ? Math.ceil(num(i.qty) / num(i.pcs_per_carton)) * cartonCbm(i) : 0));
  const totalVol = vols.reduce((s, v) => s + v, 0);
  const fallback = byVolume && (totalVol <= 0 || items.some((i, k) => num(i.qty) > 0 && vols[k] <= 0));
  if (fallback) byVolume = false;
  let amount = 0;
  let profit = 0;
  items.forEach((i, k) => {
    const qty = num(i.qty);
    const perFee = !fees || !qty ? 0 : byVolume ? fees * (vols[k] / totalVol) / qty : (totalQty > 0 ? fees / totalQty : 0);
    const unitCost = num(i.cost_cny) + num(i.craft_add) + perFee;
    const pr = i.profit_rate === null || i.profit_rate === undefined || i.profit_rate === '' ? num(q.profit_rate) : num(i.profit_rate);
    const locked = !!Number(i.price_locked) && num(i.price) > 0;
    if (!locked && (auto || !num(i.price))) i.price = round(unitCost * (1 + pr / 100) / divisor, 2);
    i.unit_cost = round(unitCost, 4);
    i.fee_share = round(perFee, 4);
    // 实际利润率按换汇成本口径反算（与亿星“利润率与单价互算”一致）/ actual rate on the FX-cost basis
    i.actual_profit_rate = unitCost > 0 ? round((num(i.price) * divisor / unitCost - 1) * 100, 2) : null;
    amount += num(i.price) * qty;
    profit += (num(i.price) * rate - unitCost) * qty;
  });
  return { items, totalQty, amount: round(amount), profit: round(profit), fee_alloc: byVolume ? '按体积' : '按数量', fee_fallback: fallback };
}

/**
 * 样品明细与每只成本（每箱用量按默认包装方案或装箱数折算）/ Sample BOM with per-piece cost.
 * @param {object} ctx
 * @param {number|string} id 样品ID / sample id
 * @returns {object}
 */
function sampleBom(ctx, id) {
  const s = require('./base').getEntity(ctx, 'sample', id);
  const { db } = ctx;
  const plan = db.prepare("SELECT * FROM sample_packages WHERE sample_id=? ORDER BY is_default='是' DESC, id LIMIT 1").get(s.id);
  const perCarton = num(plan && plan.outer_qty) || num(s.pcs_per_carton) || 0;
  const parts = db.prepare('SELECT p.*, sp.name supplier_name FROM sample_parts p LEFT JOIN suppliers sp ON sp.id=p.supplier_id WHERE p.sample_id=? ORDER BY p.kind, p.id').all(s.id);
  const warnings = [];
  for (const p of parts) {
    const lineCost = num(p.qty) * num(p.unit_price);
    if (p.per === '每箱') {
      if (!perCarton) warnings.push(`${p.name} 按“每箱”计，但样品没有装箱数，未计入成本`);
      p.cost_per_pc = perCarton ? round(lineCost / perCarton, 4) : 0;
    } else p.cost_per_pc = round(lineCost, 4);
  }
  const processes = db.prepare('SELECT p.*, sp.name supplier_name FROM sample_processes p LEFT JOIN suppliers sp ON sp.id=p.supplier_id WHERE p.sample_id=? ORDER BY p.seq, p.id').all(s.id);
  const sum = (arr) => round(arr.reduce((a, x) => a + x, 0), 4);
  const partsCost = sum(parts.filter((p) => p.kind !== '包材').map((p) => p.cost_per_pc));
  const packCost = sum(parts.filter((p) => p.kind === '包材').map((p) => p.cost_per_pc));
  const procCost = sum(processes.map((p) => num(p.price)));
  return {
    sample_id: s.id, company_no: s.company_no, per_carton: perCarton, parts, processes, warnings,
    packages: db.prepare('SELECT * FROM sample_packages WHERE sample_id=? ORDER BY id').all(s.id),
    cost: { parts: partsCost, packaging: packCost, material: round(partsCost + packCost, 4), process: procCost, total: round(partsCost + packCost + procCost, 4) },
    current: { material_cost: s.material_cost, labor_cost: s.labor_cost },
  };
}

/**
 * 读取报价单详情 / Load quote with items.
 * @param {object} ctx
 * @param {number|string} id
 * @returns {object}
 */
function getQuote(ctx, id) {
  const sc = docScope(ctx, 'q', 'quote_items', 'quote_id');
  const q = ctx.db.prepare(`SELECT q.*, c.name customer_name, c.code customer_code, c.country, e.name salesman_name FROM quotes q
    LEFT JOIN customers c ON c.id=q.customer_id LEFT JOIN employees e ON e.id=q.salesman_id WHERE q.id=?${sc.sql ? ' AND ' + sc.sql : ''}`).get(id, ...sc.params);
  if (!q) throw new HttpError(404, '报价单不存在或无权查看');
  let items = ctx.db.prepare(`SELECT i.*, s.name sample_name, s.name_en, s.designer_id, s.status sample_status, s.length_cm, s.width_cm, s.height_cm, s.material, s.craft, s.color,
    s.pcs_per_carton, s.cbm, s.outer_l, s.outer_w, s.outer_h, sp.name factory_name, d.name designer_name FROM quote_items i LEFT JOIN samples s ON s.id=i.sample_id LEFT JOIN suppliers sp ON sp.id=i.factory_id
    LEFT JOIN employees d ON d.id=s.designer_id WHERE i.quote_id=? ORDER BY i.id`).all(q.id);
  items = filterItemsForDesigner(ctx, items);
  const calc = priceQuote(q, items.map((x) => ({ ...x })), false);
  // 每行的报价基准、费用分摊、实际利润率 / per-line cost base, fee share and actual profit rate
  items.forEach((it, k) => { it.unit_cost = calc.items[k].unit_cost; it.fee_share = calc.items[k].fee_share; it.actual_profit_rate = calc.items[k].actual_profit_rate; });
  q.fee_alloc_used = calc.fee_alloc;
  q.fee_fallback = calc.fee_fallback;
  q.items = items;
  q.total_qty = calc.totalQty;
  q.amount = calc.amount;
  q.est_profit = calc.profit;
  q.inquiries = ctx.db.prepare('SELECT i.*, s.name supplier_name FROM inquiries i LEFT JOIN suppliers s ON s.id=i.supplier_id WHERE quote_id=? ORDER BY i.id').all(q.id);
  return q;
}

/**
 * 校验新货号未与已有样品冲突 / Ensure a new item number does not collide with existing samples.
 * @param {object} db
 * @param {string} newNo 新货号 / new item number
 * @param {object} sample 原样品 / original sample
 */
function checkNewItemNo(db, newNo, sample) {
  if (!newNo) return;
  if (newNo === sample.company_no) throw new HttpError(400, `新货号不能与原货号【${sample.company_no}】相同`);
  const exist = db.prepare('SELECT * FROM samples WHERE company_no=?').get(newNo);
  if (exist && exist.parent_no !== sample.company_no) throw new HttpError(409, `新货号【${newNo}】已被其它样品占用`);
}

/**
 * 同步明细行（有id更新、无id新增、缺失删除）/ Sync item rows: update with id, insert without, delete missing.
 * @param {object} db
 * @param {string} table 明细表 / item table
 * @param {string} fk 外键字段 / foreign key
 * @param {number} parentId 主表ID / parent id
 * @param {object[]} items 明细 / items
 * @param {string[]} cols 允许写入的字段 / writable columns
 * @param {(row:object)=>void} [onDelete] 删除前检查 / pre-delete check
 */
function syncItems(db, table, fk, parentId, items, cols, onDelete) {
  const existing = db.prepare(`SELECT * FROM ${table} WHERE ${fk}=?`).all(parentId);
  const keep = new Set();
  for (const it of items) {
    const vals = cols.map((c) => (it[c] === '' || it[c] === undefined ? null : it[c]));
    if (it.id && existing.some((e) => e.id === Number(it.id))) {
      keep.add(Number(it.id));
      db.prepare(`UPDATE ${table} SET ${cols.map((c) => `${c}=?`).join(',')} WHERE id=?`).run(...vals, it.id);
    } else {
      const r = db.prepare(`INSERT INTO ${table}(${fk},${cols.join(',')}) VALUES(?,${cols.map(() => '?').join(',')})`).run(parentId, ...vals);
      keep.add(Number(r.lastInsertRowid));
    }
  }
  for (const e of existing) {
    if (!keep.has(e.id)) {
      if (onDelete) onDelete(e);
      db.prepare(`DELETE FROM ${table} WHERE id=?`).run(e.id);
    }
  }
}

/** 费用分摊方式 / fee allocation methods */
const FEE_ALLOC = ['按数量', '按体积'];

/**
 * 报价单头中的计价参数 / Pricing parameters of a quote header.
 * @param {object} b 请求体 / body
 * @param {object} cur 币种 / currency row
 * @returns {object}
 */
function quoteHeader(b, cur) {
  const feeAlloc = b.fee_alloc || '按数量';
  if (!FEE_ALLOC.includes(feeAlloc)) throw new HttpError(400, '费用分摊方式无效');
  if (b.fx_cost !== undefined && b.fx_cost !== '' && b.fx_cost !== null && !(num(b.fx_cost) > 0)) throw new HttpError(400, '换汇成本必须大于0');
  return {
    currency: b.currency, term: b.term, rate: num(b.rate) || cur.rate, profit_rate: num(b.profit_rate ?? 20),
    fx_cost: num(b.fx_cost) > 0 ? num(b.fx_cost) : null, fee_alloc: feeAlloc, freight: num(b.freight), customs_fee: num(b.customs_fee),
  };
}

/**
 * 报价明细行（校验样品、带出成本与装箱资料）/ Build quote rows: validate samples, default costs, carton data.
 * @param {object} db
 * @param {object[]} items 前端提交的明细 / submitted items
 * @param {boolean} strict 是否校验样品可用与新货号 / validate usability & new item numbers
 * @returns {object[]}
 */
function quoteRows(db, items, strict) {
  return items.map((it) => {
    const s = strict ? assertSampleUsable(db, Number(it.sample_id), '报价') : db.prepare('SELECT * FROM samples WHERE id=?').get(Number(it.sample_id));
    if (!s) throw new HttpError(400, '样品不存在');
    if (strict) checkNewItemNo(db, it.new_item_no, s);
    const pr = it.profit_rate;
    return {
      id: it.id, sample_id: s.id, item_no: s.company_no, description: it.description || `${s.name} ${s.name_en || ''}`.trim(),
      qty: num(it.qty) || s.moq || 0, factory_id: it.factory_id ? Number(it.factory_id) : s.supplier_id,
      cost_cny: it.cost_cny === undefined || it.cost_cny === '' || it.cost_cny === null ? num(s.material_cost) + num(s.labor_cost) : num(it.cost_cny),
      craft_add: num(it.craft_add), price: num(it.price), new_item_no: it.new_item_no || null, revise_req: it.revise_req || null,
      profit_rate: pr === undefined || pr === null || pr === '' ? null : num(pr),
      price_locked: it.price_locked === true || it.price_locked === 1 || it.price_locked === '1' || it.price_locked === 'true' ? 1 : 0,
      pcs_per_carton: s.pcs_per_carton, cbm: s.cbm, outer_l: s.outer_l, outer_w: s.outer_w, outer_h: s.outer_h,
    };
  });
}

/**
 * 保存报价单 / Save a quotation (create or update).
 * @param {object} ctx
 * @param {number|string} [id]
 * @returns {object}
 */
function saveQuote(ctx, id) {
  const b = ctx.body;
  const { db } = ctx;
  required(b, { customer_id: '客户', currency: '币种', term: '贸易术语' });
  const items = Array.isArray(b.items) ? b.items : [];
  if (!items.length) throw new HttpError(400, '请至少添加一个报价产品');
  let old = null;
  if (id) {
    old = getQuote(ctx, id);
    if (old.status === '已成交') throw new HttpError(409, '已成交报价单不允许修改，请复制为新报价');
    if (ctx.user.scope === 'own' && old.salesman_id !== ctx.user.employee_id) throw new HttpError(403, '只能修改本人报价单');
  }
  const cur = db.prepare('SELECT * FROM currencies WHERE code=?').get(b.currency);
  if (!cur) throw new HttpError(400, '币种不存在');
  const header = quoteHeader(b, cur);
  header.customer_id = Number(b.customer_id);
  header.salesman_id = b.salesman_id ? Number(b.salesman_id) : (old ? old.salesman_id : ctx.user.employee_id);
  header.valid_until = b.valid_until || today(30);
  header.remark = b.remark || '';
  if (ctx.user.scope === 'own') header.salesman_id = ctx.user.employee_id;
  const rows = quoteRows(db, items, true);
  priceQuote(header, rows, b.auto_price !== false);
  return tx(db, () => {
    let qid = id ? Number(id) : null;
    const hcols = Object.keys(header);
    if (old) {
      const status = ['待审批', '已审批', '已发客户'].includes(old.status) ? '草稿' : (old.status === '已驳回' ? '草稿' : old.status);
      db.prepare(`UPDATE quotes SET ${hcols.map((c) => `${c}=?`).join(',')}, status=? WHERE id=?`).run(...hcols.map((c) => header[c]), status, qid);
      db.prepare("UPDATE approvals SET status='已撤回' WHERE target_type='quote' AND target_id=? AND status='待审批'").run(qid);
    } else {
      const no = nextNo(db, 'QT', 'quotes', 'quote_no');
      const r = db.prepare(`INSERT INTO quotes(quote_no,${hcols.join(',')},created_by) VALUES(?,${hcols.map(() => '?').join(',')},?)`).run(no, ...hcols.map((c) => header[c]), ctx.user.name);
      qid = Number(r.lastInsertRowid);
    }
    syncItems(db, 'quote_items', 'quote_id', qid, rows, ['sample_id', 'item_no', 'description', 'qty', 'factory_id', 'cost_cny', 'craft_add', 'price', 'new_item_no', 'revise_req', 'profit_rate', 'price_locked'], (e) => {
      const used = db.prepare('SELECT COUNT(*) c FROM inquiry_items WHERE quote_item_id=?').get(e.id).c;
      if (used) db.prepare('UPDATE inquiry_items SET quote_item_id=NULL WHERE quote_item_id=?').run(e.id);
    });
    // 改样新货号写入样品改样日志，建立旧-新货号关联 / record old→new item no in revision log
    const q = db.prepare('SELECT quote_no FROM quotes WHERE id=?').get(qid);
    for (const it of rows.filter((x) => x.new_item_no)) {
      const exists = db.prepare("SELECT 1 FROM sample_revisions WHERE sample_id=? AND stage='报价改样' AND content LIKE ?").get(it.sample_id, `%${q.quote_no}%新货号【${it.new_item_no}】%`);
      if (!exists) {
        db.prepare("INSERT INTO sample_revisions(sample_id,stage,content,user_name) VALUES(?,'报价改样',?,?)")
          .run(it.sample_id, `报价单${q.quote_no}：预创新货号【${it.new_item_no}】，改样要求：${it.revise_req || '-'}`, ctx.user.name);
      }
    }
    log(ctx, 'quote', old ? '修改报价单' : '新增报价单', q.quote_no);
    return getQuote(ctx, qid);
  });
}

/**
 * 读取询价单详情（含样品与供应商资料）/ Load an inquiry with sample & supplier details.
 * @param {object} ctx
 * @param {number|string} id
 * @returns {object}
 */
function getInquiry(ctx, id) {
  const inq = ctx.db.prepare(`SELECT i.*, q.quote_no, q.customer_id, q.salesman_id, s.name supplier_name, s.contact supplier_contact, s.phone supplier_phone, s.email supplier_email, s.settlement, s.code supplier_code
    FROM inquiries i JOIN quotes q ON q.id=i.quote_id LEFT JOIN suppliers s ON s.id=i.supplier_id WHERE i.id=?`).get(id);
  if (!inq) throw new HttpError(404, '询价单不存在');
  if (ctx.user.scope === 'own' && inq.salesman_id !== ctx.user.employee_id) throw new HttpError(403, '无权查看该询价单');
  inq.items = ctx.db.prepare(`SELECT ii.*, s.name, s.name_en, s.factory_no, s.length_cm, s.width_cm, s.height_cm, s.material, s.craft, s.color, s.package_req, s.label_req, s.inner_box,
    s.outer_l, s.outer_w, s.outer_h, s.pcs_per_carton, s.moq, qi.new_item_no, qi.revise_req,
    (SELECT price FROM supplier_prices p WHERE p.supplier_id=? AND p.item_no=ii.item_no ORDER BY p.id DESC LIMIT 1) last_price
    FROM inquiry_items ii LEFT JOIN samples s ON s.id=ii.sample_id LEFT JOIN quote_items qi ON qi.id=ii.quote_item_id WHERE ii.inquiry_id=? ORDER BY ii.id`).all(inq.supplier_id, inq.id);
  for (const it of inq.items) it.cbm = it.outer_l && it.outer_w && it.outer_h ? round(it.outer_l * it.outer_w * it.outer_h / 1e6, 4) : null;
  return inq;
}

/**
 * 生成询价单 Excel（厘米版/英寸版模板）/ Build the factory inquiry Excel (cm or inch template).
 * @param {object} db
 * @param {object} inq 询价单 / inquiry
 * @param {'cm'|'inch'} unit 单位 / unit
 * @returns {Buffer}
 */
function inquiryXlsx(db, inq, unit) {
  const k = unit === 'inch' ? 1 / 2.54 : 1;
  const u = unit === 'inch' ? 'inch' : 'cm';
  const d = (v) => (v ? round(v * k, 1) : '');
  const dims = (a, b, c) => (a ? `${d(a)}×${d(b)}×${d(c)}` : '');
  const company = setting(db, 'company_name');
  const companyEn = setting(db, 'company_name_en');
  const headers = ['序号\nNo.', '公司货号\nItem No.', '工厂货号\nFactory No.', '品名/描述\nDescription', `产品尺寸(${u})\nL×W×H`, '材质\nMaterial', '工艺/花色\nCraft/Color',
    '包装要求\nPacking', '标签要求\nLabel', '内盒\nInner Box', `外箱尺寸(${u})\nCarton`, '装箱数\nPcs/Ctn', 'CBM/箱', 'MOQ', '询价数量\nQty', '工厂单价(¥)\nPrice', '交期(天)\nLead Time', '备注\nRemark'];
  const H = (v) => ({ v, s: 4 });
  const rows = [
    [{ v: `${company}  ${companyEn}`, s: 3 }],
    [{ v: `工厂询价单 FACTORY INQUIRY SHEET（${unit === 'inch' ? '英寸版 INCH' : '厘米版 CM'}）`, s: 3 }],
    [H('询价单号：'), inq.inquiry_no, '', H('报价单号：'), inq.quote_no, '', H('询价日期：'), (inq.created_at || '').slice(0, 10), '', H('回复期限：'), inq.valid_until || today(7)],
    [H('厂家：'), inq.supplier_name, '', H('联系人：'), inq.supplier_contact || '', '', H('电话：'), inq.supplier_phone || '', '', H('结算方式：'), inq.settlement || ''],
    headers.map((h) => ({ v: h, s: 1 })),
  ];
  inq.items.forEach((it, idx) => {
    rows.push([idx + 1, it.item_no, it.factory_no || '', `${it.name || ''} ${it.name_en || ''}\n${it.description || ''}`.trim(), dims(it.length_cm, it.width_cm, it.height_cm),
      it.material || '', [it.craft, it.color].filter(Boolean).join('/'), it.package_req || '', it.label_req || '', it.inner_box || '', dims(it.outer_l, it.outer_w, it.outer_h),
      it.pcs_per_carton || '', it.cbm || '', it.moq || '', it.qty || '', it.factory_price ?? '', it.delivery_days ?? '', it.remark || ''].map((v) => ({ v, s: 2 })));
  });
  const revs = inq.items.filter((x) => x.new_item_no);
  rows.push([]);
  const left = revs.length ? revs.map((x) => `${x.item_no} → ${x.new_item_no}`).join('\n') : '无';
  const right = revs.length ? revs.map((x) => `${x.new_item_no}：${x.revise_req || ''}`).join('\n') : '无';
  rows.push([{ v: '本次新创货号 New Item No.', s: 1 }, '', '', '', '', '', '', '', '', { v: '详细改样要求 Revision Requirements', s: 1 }]);
  rows.push([{ v: left, s: 2 }, '', '', '', '', '', '', '', '', { v: right, s: 2 }]);
  rows.push([]);
  rows.push([H('说明：请贵厂在回复期限内填写“工厂单价”与“交期”后回传，报价含税/不含税请在备注注明。')]);
  const last = rows.length;
  const revRow = last - 2;
  return buildXlsx({
    sheet: unit === 'inch' ? '询价单(英寸)' : '询价单(厘米)', rows,
    widths: [6, 13, 12, 28, 16, 10, 14, 16, 16, 12, 16, 8, 8, 8, 9, 11, 9, 16],
    merges: ['A1:R1', 'A2:R2', `A${revRow - 1}:I${revRow - 1}`, `J${revRow - 1}:R${revRow - 1}`, `A${revRow}:I${revRow}`, `J${revRow}:R${revRow}`, `A${last}:R${last}`],
  });
}

/**
 * 读取送样单详情 / Load a sample-send document.
 * @param {object} ctx
 * @param {number|string} id
 * @returns {object}
 */
function getSend(ctx, id) {
  const sc = docScope(ctx, 'd', 'sample_send_items', 'send_id');
  const d = ctx.db.prepare(`SELECT d.*, c.name customer_name, c.country, e.name salesman_name FROM sample_sends d LEFT JOIN customers c ON c.id=d.customer_id
    LEFT JOIN employees e ON e.id=d.salesman_id WHERE d.id=?${sc.sql ? ' AND ' + sc.sql : ''}`).get(id, ...sc.params);
  if (!d) throw new HttpError(404, '送样单不存在或无权查看');
  d.items = filterItemsForDesigner(ctx, ctx.db.prepare(`SELECT i.*, s.name sample_name, s.designer_id, s.status sample_status, s.craft, s.color, de.name designer_name,
    ns.company_no new_sample_no FROM sample_send_items i LEFT JOIN samples s ON s.id=i.sample_id LEFT JOIN employees de ON de.id=s.designer_id
    LEFT JOIN samples ns ON ns.id=i.new_sample_id WHERE i.send_id=? ORDER BY i.id`).all(d.id));
  return d;
}

/**
 * 注册外贸业务路由 / Register sales routes.
 * @param {import('../http').Router} r
 */
function register(r) {
  // ---------- 报价 / quotations ----------
  r.get('/api/quotes', (ctx) => {
    need(ctx, 'quote', 'view');
    const q = ctx.query;
    const where = [];
    const params = [];
    const sc = docScope(ctx, 'q', 'quote_items', 'quote_id');
    if (sc.sql) { where.push(sc.sql); params.push(...sc.params); }
    if (q.q) { where.push('(q.quote_no LIKE ? OR c.name LIKE ? OR EXISTS (SELECT 1 FROM quote_items i WHERE i.quote_id=q.id AND (i.item_no LIKE ? OR i.new_item_no LIKE ?)))'); params.push(...Array(4).fill(`%${q.q}%`)); }
    if (q.status) { where.push('q.status=?'); params.push(q.status); }
    const rows = ctx.db.prepare(`SELECT q.*, c.name customer_name, e.name salesman_name,
      (SELECT COUNT(*) FROM quote_items i WHERE i.quote_id=q.id) item_count,
      (SELECT ROUND(SUM(i.price*i.qty),2) FROM quote_items i WHERE i.quote_id=q.id) amount,
      (SELECT COUNT(*) FROM inquiries x WHERE x.quote_id=q.id) inquiry_count
      FROM quotes q LEFT JOIN customers c ON c.id=q.customer_id LEFT JOIN employees e ON e.id=q.salesman_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY q.id DESC LIMIT 500`).all(...params);
    return { rows };
  });
  r.get('/api/quotes/:id', (ctx) => { need(ctx, 'quote', 'view'); return getQuote(ctx, ctx.params.id); });
  r.post('/api/quotes', (ctx) => { need(ctx, 'quote', 'add'); return saveQuote(ctx); });

  // 试算：利润率与单价互算（不保存）/ live calculation: profit rate ⇄ unit price, nothing saved
  r.post('/api/quotes/calc', (ctx) => {
    need(ctx, 'quote', 'view');
    const b = ctx.body;
    const cur = ctx.db.prepare('SELECT * FROM currencies WHERE code=?').get(b.currency || 'USD');
    if (!cur) throw new HttpError(400, '币种不存在');
    const header = quoteHeader(b, cur);
    const items = (Array.isArray(b.items) ? b.items : []).filter((x) => x.sample_id);
    const calc = priceQuote(header, quoteRows(ctx.db, items, false), b.auto_price !== false);
    return {
      rate: header.rate, divisor: header.fx_cost || header.rate, total_qty: calc.totalQty, amount: calc.amount, profit: calc.profit,
      fee_alloc: calc.fee_alloc, fee_fallback: calc.fee_fallback,
      items: calc.items.map((i) => ({ price: i.price, unit_cost: i.unit_cost, fee_share: i.fee_share, actual_profit_rate: i.actual_profit_rate })),
    };
  });

  // 复制为新报价（亿星“另存为/历史翻单”）/ copy as a new quote (亿星 "save as")
  r.post('/api/quotes/:id/copy', (ctx) => {
    need(ctx, 'quote', 'add');
    const q = getQuote(ctx, ctx.params.id);
    if (ctx.user.scope === 'designer') throw new HttpError(403, '设计师无权复制报价单');
    const items = q.items.map((i) => {
      // 旧货号已锁定时改用转正的新货号 / use the archived new item when the old one is locked
      let sid = i.sample_id;
      if (i.sample_status === '已锁定') {
        const ns = ctx.db.prepare('SELECT id FROM samples WHERE parent_no=? AND status<>? ORDER BY id DESC').get(i.item_no, '已锁定');
        if (!ns) throw new HttpError(409, `货号 ${i.item_no} 已锁定且没有可用的新货号，无法复制`);
        sid = ns.id;
      }
      return { sample_id: sid, description: i.description, qty: i.qty, factory_id: i.factory_id, cost_cny: i.cost_cny, craft_add: i.craft_add, price: i.price, profit_rate: i.profit_rate, price_locked: i.price_locked };
    });
    const body = {
      customer_id: ctx.body.customer_id || q.customer_id, currency: q.currency, term: q.term, profit_rate: q.profit_rate, fx_cost: q.fx_cost, fee_alloc: q.fee_alloc,
      freight: q.freight, customs_fee: q.customs_fee, remark: `复制自报价单 ${q.quote_no}${q.remark ? '；' + q.remark : ''}`, items, auto_price: false,
    };
    const r2 = saveQuote({ ...ctx, body });
    log(ctx, 'quote', '复制报价单', r2.quote_no, `来源 ${q.quote_no}`);
    return r2;
  });

  // 客户历史报价/订单明细（历史记录导入）/ customer's historical quote & order lines for re-use
  r.get('/api/customers/:id/history-items', (ctx) => {
    if (!can(ctx.user, 'quote', 'view') && !can(ctx.user, 'order', 'view')) throw new HttpError(403, '无权查看');
    require('./base').getEntity(ctx, 'customer', ctx.params.id);
    const own = ctx.user.scope === 'own' ? ' AND x.salesman_id=' + Number(ctx.user.employee_id || -1) : '';
    const quotes = can(ctx.user, 'quote', 'view') ? ctx.db.prepare(`SELECT '报价' src, x.quote_no doc_no, substr(x.created_at,1,10) doc_date, x.currency, i.sample_id, i.item_no, i.description, i.qty, i.price,
        i.profit_rate, i.price_locked, i.cost_cny, i.craft_add, i.factory_id, s.status sample_status FROM quote_items i JOIN quotes x ON x.id=i.quote_id LEFT JOIN samples s ON s.id=i.sample_id
        WHERE x.customer_id=?${own} ORDER BY x.id DESC, i.id LIMIT 300`).all(ctx.params.id) : [];
    const orders = can(ctx.user, 'order', 'view') ? ctx.db.prepare(`SELECT '订单' src, x.order_no doc_no, x.order_date doc_date, x.currency, i.sample_id, i.item_no, i.description, i.qty, i.unit_price price,
        i.craft, i.spec, i.package, s.status sample_status FROM order_items i JOIN orders x ON x.id=i.order_id LEFT JOIN samples s ON s.id=i.sample_id
        WHERE x.customer_id=?${own} ORDER BY x.id DESC, i.id LIMIT 300`).all(ctx.params.id) : [];
    return { rows: [...orders, ...quotes].sort((a, b) => String(b.doc_date).localeCompare(String(a.doc_date))) };
  });
  r.put('/api/quotes/:id', (ctx) => { need(ctx, 'quote', 'edit'); return saveQuote(ctx, ctx.params.id); });
  r.del('/api/quotes/:id', (ctx) => {
    need(ctx, 'quote', 'delete');
    const q = getQuote(ctx, ctx.params.id);
    if (q.status === '已成交') throw new HttpError(409, '已成交报价单不能删除');
    tx(ctx.db, () => {
      ctx.db.prepare('DELETE FROM inquiry_items WHERE inquiry_id IN (SELECT id FROM inquiries WHERE quote_id=?)').run(q.id);
      ctx.db.prepare('DELETE FROM inquiries WHERE quote_id=?').run(q.id);
      ctx.db.prepare('DELETE FROM quote_items WHERE quote_id=?').run(q.id);
      ctx.db.prepare('DELETE FROM quotes WHERE id=?').run(q.id);
    });
    log(ctx, 'quote', '删除报价单', q.quote_no);
    return { ok: true };
  });

  r.post('/api/quotes/:id/submit', (ctx) => {
    need(ctx, 'quote', 'edit');
    const q = getQuote(ctx, ctx.params.id);
    if (!['草稿', '已驳回'].includes(q.status)) throw new HttpError(409, `当前状态【${q.status}】不能提交审批`);
    const min = num(setting(ctx.db, 'quote_min_profit', '15'));
    // 按行检查：整单目标或任一行实际利润率低于最低要求都预警 / warn if the header or any line is below the minimum
    const lowLines = q.items.filter((i) => i.actual_profit_rate !== null && i.actual_profit_rate < min - 0.005);
    const low = num(q.profit_rate) < min || lowLines.length > 0;
    const lowText = lowLines.length ? `（${lowLines.map((i) => `${i.item_no} ${i.actual_profit_rate}%`).join('、')}）` : '';
    tx(ctx.db, () => {
      ctx.db.prepare("UPDATE quotes SET status='待审批' WHERE id=?").run(q.id);
      ctx.db.prepare("INSERT INTO approvals(target_type,target_id,target_no,title,applicant) VALUES('quote',?,?,?,?)")
        .run(q.id, q.quote_no, `报价单 ${q.quote_no} ${q.customer_name} 金额 ${q.amount} ${q.currency} 利润率 ${q.profit_rate}%${low ? ` ⚠低于最低利润率${min}%${lowText}` : ''}`, ctx.user.name);
    });
    log(ctx, 'quote', '提交报价审批', q.quote_no);
    return { ok: true, low_profit: low, low_lines: lowLines.map((i) => ({ item_no: i.item_no, rate: i.actual_profit_rate })) };
  });
  r.post('/api/quotes/:id/status', (ctx) => {
    need(ctx, 'quote', 'edit');
    const q = getQuote(ctx, ctx.params.id);
    const to = ctx.body.status;
    const allowed = { 已发客户: ['已审批'], 已失效: ['草稿', '已审批', '已发客户', '已驳回'] };
    if (!allowed[to]) throw new HttpError(400, '不支持的状态');
    if (!allowed[to].includes(q.status)) throw new HttpError(409, `当前状态【${q.status}】不能变更为【${to}】${to === '已发客户' ? '（需先审批通过）' : ''}`);
    ctx.db.prepare('UPDATE quotes SET status=? WHERE id=?').run(to, q.id);
    log(ctx, 'quote', `报价单${to}`, q.quote_no);
    return { ok: true };
  });
  r.post('/api/quotes/:id/to-order', (ctx) => {
    need(ctx, 'order', 'add');
    const q = getQuote(ctx, ctx.params.id);
    if (!['已审批', '已发客户'].includes(q.status)) throw new HttpError(409, '报价单审批通过后才能转订单');
    const { db } = ctx;
    return tx(db, () => {
      const no = nextNo(db, 'SO', 'orders', 'order_no');
      const r2 = db.prepare(`INSERT INTO orders(order_no,customer_id,salesman_id,quote_id,currency,term,rate,order_date,delivery_date,status) VALUES(?,?,?,?,?,?,?,?,?,'待确认')`)
        .run(no, q.customer_id, q.salesman_id, q.id, q.currency, q.term, q.rate, today(), today(60));
      const oid = Number(r2.lastInsertRowid);
      // 从客户档案带出付款方式、目的港、默认唛头 / defaults from the customer record
      const defs = require('./orders').customerDefaults(db, q.customer_id);
      db.prepare('UPDATE orders SET pay_terms=?, port_dest=?, front_mark=?, side_mark=?, inner_mark=? WHERE id=?')
        .run(defs.pay_terms, defs.port_dest, defs.front_mark, defs.side_mark, defs.inner_mark, oid);
      for (const it of q.items) {
        // 有新货号且已转正，则使用新货号样品 / use the new formal sample if the new item no was archived
        let s = db.prepare('SELECT * FROM samples WHERE id=?').get(it.sample_id);
        if (it.new_item_no) {
          const ns = db.prepare('SELECT * FROM samples WHERE company_no=?').get(it.new_item_no);
          if (ns) s = ns;
        }
        assertSampleUsable(db, s.id, '下单');
        db.prepare('INSERT INTO order_items(order_id,sample_id,item_no,description,qty,unit_price,craft,spec,package) VALUES(?,?,?,?,?,?,?,?,?)')
          .run(oid, s.id, s.company_no, it.description, it.qty, it.price, s.craft, s.length_cm ? `${s.length_cm}×${s.width_cm}×${s.height_cm}cm` : '', s.package_req);
      }
      db.prepare("UPDATE quotes SET status='已成交' WHERE id=?").run(q.id);
      log(ctx, 'order', '报价转订单', no, q.quote_no);
      return { id: oid, order_no: no };
    });
  });

  // ---------- 工厂询价子模块 / factory inquiries ----------
  r.post('/api/quotes/:id/split', (ctx) => {
    need(ctx, 'quote', 'edit');
    const q = getQuote(ctx, ctx.params.id);
    const { db } = ctx;
    const noFactory = q.items.filter((i) => !i.factory_id);
    if (noFactory.length) throw new HttpError(400, `货号 ${noFactory.map((i) => i.item_no).join('、')} 未指定生产厂家，无法拆分`);
    const groups = new Map();
    for (const it of q.items) {
      if (!groups.has(it.factory_id)) groups.set(it.factory_id, []);
      groups.get(it.factory_id).push(it);
    }
    const result = tx(db, () => {
      const out = [];
      for (const [sid, items] of groups) {
        const sup = db.prepare('SELECT * FROM suppliers WHERE id=?').get(sid);
        const inqNo = `${q.quote_no}-${sup.name}`;
        let inq = db.prepare('SELECT * FROM inquiries WHERE inquiry_no=?').get(inqNo);
        if (inq && inq.status === '已回价') { out.push({ ...inq, skipped: true }); continue; }
        if (!inq) {
          const rr = db.prepare('INSERT INTO inquiries(inquiry_no,quote_id,supplier_id,valid_until) VALUES(?,?,?,?)').run(inqNo, q.id, sid, today(7));
          inq = db.prepare('SELECT * FROM inquiries WHERE id=?').get(rr.lastInsertRowid);
        }
        db.prepare('DELETE FROM inquiry_items WHERE inquiry_id=?').run(inq.id);
        for (const it of items) {
          db.prepare('INSERT INTO inquiry_items(inquiry_id,quote_item_id,sample_id,item_no,description,qty) VALUES(?,?,?,?,?,?)').run(inq.id, it.id, it.sample_id, it.item_no, it.description, it.qty);
        }
        out.push({ ...inq, item_count: items.length });
      }
      return out;
    });
    log(ctx, 'quote', '按厂家拆分询价单', q.quote_no, result.map((x) => x.inquiry_no).join('、'));
    return { rows: result };
  });
  r.post('/api/inquiries', (ctx) => {
    need(ctx, 'quote', 'edit');
    required(ctx.body, { quote_id: '报价单', supplier_id: '厂家' });
    const q = getQuote(ctx, ctx.body.quote_id);
    const ids = (ctx.body.quote_item_ids || []).map(Number);
    const items = q.items.filter((i) => ids.includes(i.id));
    if (!items.length) throw new HttpError(400, '请选择要询价的货号');
    const sup = ctx.db.prepare('SELECT * FROM suppliers WHERE id=?').get(ctx.body.supplier_id);
    if (!sup) throw new HttpError(400, '厂家不存在');
    const inqNo = `${q.quote_no}-${sup.name}`;
    return tx(ctx.db, () => {
      let inq = ctx.db.prepare('SELECT * FROM inquiries WHERE inquiry_no=?').get(inqNo);
      if (!inq) {
        const rr = ctx.db.prepare('INSERT INTO inquiries(inquiry_no,quote_id,supplier_id,valid_until) VALUES(?,?,?,?)').run(inqNo, q.id, sup.id, today(7));
        inq = ctx.db.prepare('SELECT * FROM inquiries WHERE id=?').get(rr.lastInsertRowid);
      }
      for (const it of items) {
        const dup = ctx.db.prepare('SELECT 1 FROM inquiry_items WHERE inquiry_id=? AND quote_item_id=?').get(inq.id, it.id);
        if (!dup) ctx.db.prepare('INSERT INTO inquiry_items(inquiry_id,quote_item_id,sample_id,item_no,description,qty) VALUES(?,?,?,?,?,?)').run(inq.id, it.id, it.sample_id, it.item_no, it.description, it.qty);
      }
      log(ctx, 'quote', '追加厂家询价', inqNo);
      return getInquiry(ctx, inq.id);
    });
  });
  r.get('/api/inquiries', (ctx) => {
    need(ctx, 'quote', 'view');
    if (ctx.user.scope === 'designer') throw new HttpError(403, '设计师无权查看工厂询价台账');
    const q = ctx.query;
    const where = [];
    const params = [];
    if (ctx.user.scope === 'own') { where.push('qt.salesman_id=?'); params.push(ctx.user.employee_id); }
    if (q.quote_no) { where.push('qt.quote_no LIKE ?'); params.push(`%${q.quote_no}%`); }
    if (q.supplier) { where.push('s.name LIKE ?'); params.push(`%${q.supplier}%`); }
    if (q.item_no) { where.push('EXISTS (SELECT 1 FROM inquiry_items ii WHERE ii.inquiry_id=i.id AND ii.item_no LIKE ?)'); params.push(`%${q.item_no}%`); }
    if (q.from) { where.push('date(i.created_at) >= ?'); params.push(q.from); }
    if (q.to) { where.push('date(i.created_at) <= ?'); params.push(q.to); }
    if (q.status) { where.push('i.status=?'); params.push(q.status); }
    return { rows: ctx.db.prepare(`SELECT i.*, qt.quote_no, s.name supplier_name, (SELECT COUNT(*) FROM inquiry_items ii WHERE ii.inquiry_id=i.id) item_count,
      (SELECT group_concat(item_no, '、') FROM inquiry_items ii WHERE ii.inquiry_id=i.id) item_nos
      FROM inquiries i JOIN quotes qt ON qt.id=i.quote_id LEFT JOIN suppliers s ON s.id=i.supplier_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY i.id DESC`).all(...params) };
  });
  r.get('/api/inquiries/:id', (ctx) => {
    need(ctx, 'quote', 'view');
    if (ctx.user.scope === 'designer') throw new HttpError(403, '设计师无权查看工厂询价单');
    return getInquiry(ctx, ctx.params.id);
  });
  r.post('/api/inquiries/:id/sent', (ctx) => {
    need(ctx, 'quote', 'edit');
    const inq = getInquiry(ctx, ctx.params.id);
    if (inq.status === '已回价') throw new HttpError(409, '已回价询价单无需再次发送');
    ctx.db.prepare("UPDATE inquiries SET status='已发送', sent_at=datetime('now','localtime') WHERE id=?").run(inq.id);
    log(ctx, 'quote', '询价单已发送厂家', inq.inquiry_no);
    return { ok: true };
  });
  r.put('/api/inquiries/:id/reply', (ctx) => {
    need(ctx, 'quote', 'edit');
    const inq = getInquiry(ctx, ctx.params.id);
    const items = ctx.body.items || [];
    for (const it of items) {
      if (it.factory_price !== undefined && it.factory_price !== '' && !(Number(it.factory_price) >= 0)) throw new HttpError(400, '工厂单价必须是非负数字');
    }
    tx(ctx.db, () => {
      for (const it of items) {
        const row = inq.items.find((x) => x.id === Number(it.id));
        if (!row) continue;
        const price = it.factory_price === '' || it.factory_price === undefined ? null : Number(it.factory_price);
        ctx.db.prepare('UPDATE inquiry_items SET factory_price=?, delivery_days=?, remark=? WHERE id=?').run(price, it.delivery_days ? Number(it.delivery_days) : null, it.remark || null, row.id);
        if (price !== null) {
          ctx.db.prepare("INSERT INTO supplier_prices(supplier_id,item_no,price,currency,source,ref_no) VALUES(?,?,?,'CNY','工厂询价回价',?)").run(inq.supplier_id, row.item_no, price, inq.inquiry_no);
        }
      }
      ctx.db.prepare("UPDATE inquiries SET status='已回价', reply_date=?, valid_until=?, remark=? WHERE id=?")
        .run(ctx.body.reply_date || today(), ctx.body.valid_until || inq.valid_until, ctx.body.remark ?? inq.remark, inq.id);
    });
    log(ctx, 'quote', '回填工厂报价', inq.inquiry_no);
    return getInquiry(ctx, inq.id);
  });
  r.get('/api/inquiries/:id/export', (ctx) => {
    need(ctx, 'quote', 'export');
    const inq = getInquiry(ctx, ctx.params.id);
    const unit = ctx.query.unit === 'inch' ? 'inch' : 'cm';
    log(ctx, 'quote', `导出询价单(${unit})`, inq.inquiry_no);
    return { __file: { buf: inquiryXlsx(ctx.db, inq, unit), name: `${inq.inquiry_no}_${unit === 'inch' ? '英寸版' : '厘米版'}.xlsx`, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } };
  });
  r.get('/api/quotes/:id/compare', (ctx) => {
    need(ctx, 'quote', 'view');
    if (ctx.user.scope === 'designer') throw new HttpError(403, '设计师无权查看厂家报价对比');
    const q = getQuote(ctx, ctx.params.id);
    const rows = q.items.map((it) => {
      const offers = ctx.db.prepare(`SELECT ii.id inquiry_item_id, ii.factory_price, ii.delivery_days, ii.remark, i.inquiry_no, i.reply_date, i.valid_until, i.supplier_id, s.name supplier_name, s.rating, s.pass_rate
        FROM inquiry_items ii JOIN inquiries i ON i.id=ii.inquiry_id LEFT JOIN suppliers s ON s.id=i.supplier_id
        WHERE ii.item_no=? AND ii.factory_price IS NOT NULL ORDER BY ii.factory_price ASC, ii.id DESC`).all(it.item_no);
      const best = offers.length ? offers[0].factory_price : null;
      for (const o of offers) {
        o.diff_vs_best = round(o.factory_price - best);
        o.diff_vs_current = round(o.factory_price - num(it.cost_cny));
        o.est_margin = it.price ? round((it.price * q.rate - o.factory_price - num(it.craft_add)) * num(it.qty)) : null;
      }
      return { quote_item_id: it.id, item_no: it.item_no, description: it.description, qty: it.qty, current_cost: it.cost_cny, current_factory: it.factory_name, price: it.price, offers };
    });
    return { quote_no: q.quote_no, currency: q.currency, rate: q.rate, rows };
  });
  r.post('/api/quotes/:id/apply-offer', (ctx) => {
    need(ctx, 'quote', 'edit');
    const q = getQuote(ctx, ctx.params.id);
    const qi = q.items.find((x) => x.id === Number(ctx.body.quote_item_id));
    if (!qi) throw new HttpError(404, '报价明细不存在');
    const off = ctx.db.prepare('SELECT ii.*, i.supplier_id FROM inquiry_items ii JOIN inquiries i ON i.id=ii.inquiry_id WHERE ii.id=?').get(ctx.body.inquiry_item_id);
    if (!off || off.item_no !== qi.item_no || off.factory_price === null) throw new HttpError(400, '所选工厂报价无效');
    const items = q.items.map((x) => (x.id === qi.id ? { ...x, cost_cny: off.factory_price, factory_id: off.supplier_id } : { ...x }));
    priceQuote(q, items, true);
    tx(ctx.db, () => {
      for (const it of items) ctx.db.prepare('UPDATE quote_items SET cost_cny=?, factory_id=?, price=? WHERE id=?').run(it.cost_cny, it.factory_id, it.price, it.id);
      if (q.status !== '草稿') ctx.db.prepare("UPDATE quotes SET status='草稿' WHERE id=?").run(q.id);
    });
    log(ctx, 'quote', '采用工厂报价作为成本', q.quote_no, `${qi.item_no} ¥${off.factory_price}`);
    return getQuote(ctx, q.id);
  });

  // ---------- 客户/样品全景 / customer & sample overview ----------
  r.get('/api/customers/:id/overview', (ctx) => {
    need(ctx, 'customer', 'view');
    const { db } = ctx;
    const c = db.prepare('SELECT c.*, e.name salesman_name FROM customers c LEFT JOIN employees e ON e.id=c.salesman_id WHERE c.id=?').get(ctx.params.id);
    if (!c || (ctx.user.scope === 'own' && c.salesman_id !== ctx.user.employee_id)) throw new HttpError(404, '客户不存在或无权查看');
    return {
      customer: c,
      follows: db.prepare('SELECT * FROM customer_follows WHERE customer_id=? ORDER BY id DESC').all(c.id),
      mails: db.prepare('SELECT id, direction, subject, category, created_at FROM mails WHERE customer_id=? ORDER BY id DESC').all(c.id),
      quotes: db.prepare('SELECT q.*, (SELECT ROUND(SUM(price*qty),2) FROM quote_items WHERE quote_id=q.id) amount FROM quotes q WHERE customer_id=? ORDER BY id DESC').all(c.id),
      sends: db.prepare("SELECT d.*, (SELECT group_concat(item_no,'、') FROM sample_send_items WHERE send_id=d.id) item_nos FROM sample_sends d WHERE customer_id=? ORDER BY id DESC").all(c.id),
      orders: db.prepare(`SELECT o.*, ROUND((SELECT COALESCE(SUM(qty*unit_price),0) FROM order_items WHERE order_id=o.id) + (SELECT COALESCE(SUM(CASE WHEN kind='减' THEN -amount ELSE amount END),0) FROM order_charges WHERE order_id=o.id),2) amount FROM orders o WHERE customer_id=? ORDER BY id DESC`).all(c.id),
      receipts: db.prepare('SELECT r.*, o.order_no FROM receipts r JOIN orders o ON o.id=r.order_id WHERE o.customer_id=? ORDER BY r.id DESC').all(c.id),
    };
  });
  // 样品明细汇总：配件/包材/工序成本（每只），可回写样品成本 / sample BOM cost roll-up per piece
  r.get('/api/samples/:id/bom', (ctx) => {
    need(ctx, 'sample', 'view');
    return sampleBom(ctx, ctx.params.id);
  });
  r.post('/api/samples/:id/apply-bom-cost', (ctx) => {
    need(ctx, 'sample', 'edit');
    const b = sampleBom(ctx, ctx.params.id);
    if (!b.parts.length && !b.processes.length) throw new HttpError(400, '没有配件/包材/工序明细，无法计算成本');
    const s = ctx.db.prepare('SELECT * FROM samples WHERE id=?').get(b.sample_id);
    tx(ctx.db, () => {
      ctx.db.prepare('UPDATE samples SET material_cost=?, labor_cost=? WHERE id=?').run(b.cost.material, b.cost.process, s.id);
      ctx.db.prepare("INSERT INTO sample_revisions(sample_id,stage,content,user_name) VALUES(?,'打样',?,?)")
        .run(s.id, `按明细更新成本：材料 ${s.material_cost ?? 0} → ${b.cost.material}，人工 ${s.labor_cost ?? 0} → ${b.cost.process}`, ctx.user.name);
    });
    log(ctx, 'sample', '按明细更新样品成本', s.company_no, b.cost);
    return b;
  });
  r.get('/api/samples/:id/overview', (ctx) => {
    need(ctx, 'sample', 'view');
    const { db } = ctx;
    const s = db.prepare('SELECT s.*, d.name designer_name, sp.name supplier_name FROM samples s LEFT JOIN employees d ON d.id=s.designer_id LEFT JOIN suppliers sp ON sp.id=s.supplier_id WHERE s.id=?').get(ctx.params.id);
    if (!s || (ctx.user.scope === 'designer' && s.designer_id !== ctx.user.employee_id)) throw new HttpError(404, '样品不存在或无权查看');
    const own = ctx.user.scope === 'own' ? ` AND h.salesman_id=${Number(ctx.user.employee_id || -1)}` : '';
    const out = {
      sample: s,
      revisions: db.prepare('SELECT * FROM sample_revisions WHERE sample_id=? ORDER BY id DESC').all(s.id),
      children: db.prepare('SELECT id, company_no FROM samples WHERE parent_no=?').all(s.company_no),
    };
    if (can(ctx.user, 'quote', 'view')) {
      out.quotes = db.prepare(`SELECT i.*, h.id quote_id, h.quote_no, h.currency, h.status, c.name customer_name FROM quote_items i JOIN quotes h ON h.id=i.quote_id
        LEFT JOIN customers c ON c.id=h.customer_id WHERE i.sample_id=?${own} ORDER BY h.id DESC`).all(s.id);
    }
    if (can(ctx.user, 'sendsample', 'view')) {
      out.sends = db.prepare(`SELECT i.*, h.id send_id, h.send_no, h.status, c.name customer_name FROM sample_send_items i JOIN sample_sends h ON h.id=i.send_id
        LEFT JOIN customers c ON c.id=h.customer_id WHERE i.sample_id=?${own} ORDER BY h.id DESC`).all(s.id);
    }
    if (can(ctx.user, 'order', 'view')) {
      out.orders = db.prepare(`SELECT i.*, h.id order_id, h.order_no, h.currency, h.status, c.name customer_name FROM order_items i JOIN orders h ON h.id=i.order_id
        LEFT JOIN customers c ON c.id=h.customer_id WHERE i.sample_id=?${own} ORDER BY h.id DESC`).all(s.id);
    }
    const sends = db.prepare('SELECT COUNT(*) c FROM sample_send_items WHERE sample_id=?').get(s.id).c;
    const orders = db.prepare('SELECT COUNT(DISTINCT order_id) c FROM order_items WHERE sample_id=?').get(s.id).c;
    out.stats = { sends, orders, rate: sends ? `${round(orders * 100 / sends, 1)}%` : '-' };
    return out;
  });

  // ---------- 送样 / sample sending ----------
  r.get('/api/sample-sends', (ctx) => {
    need(ctx, 'sendsample', 'view');
    const where = [];
    const params = [];
    const sc = docScope(ctx, 'd', 'sample_send_items', 'send_id');
    if (sc.sql) { where.push(sc.sql); params.push(...sc.params); }
    if (ctx.query.q) { where.push('(d.send_no LIKE ? OR c.name LIKE ? OR d.tracking_no LIKE ? OR EXISTS (SELECT 1 FROM sample_send_items i WHERE i.send_id=d.id AND (i.item_no LIKE ? OR i.new_item_no LIKE ?)))'); params.push(...Array(5).fill(`%${ctx.query.q}%`)); }
    if (ctx.query.status) { where.push('d.status=?'); params.push(ctx.query.status); }
    return { rows: ctx.db.prepare(`SELECT d.*, c.name customer_name, e.name salesman_name,
      (SELECT group_concat(item_no, '、') FROM sample_send_items i WHERE i.send_id=d.id) item_nos,
      (SELECT group_concat(new_item_no, '、') FROM sample_send_items i WHERE i.send_id=d.id AND new_item_no IS NOT NULL) new_item_nos
      FROM sample_sends d LEFT JOIN customers c ON c.id=d.customer_id LEFT JOIN employees e ON e.id=d.salesman_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY d.id DESC`).all(...params) };
  });
  r.get('/api/sample-sends/:id', (ctx) => { need(ctx, 'sendsample', 'view'); return getSend(ctx, ctx.params.id); });
  const saveSend = (ctx, id) => {
    const b = ctx.body;
    required(b, { customer_id: '客户' });
    const items = Array.isArray(b.items) ? b.items : [];
    if (!items.length) throw new HttpError(400, '请至少添加一个送样货号');
    let old = null;
    if (id) {
      old = getSend(ctx, id);
      if (ctx.user.scope === 'own' && old.salesman_id !== ctx.user.employee_id) throw new HttpError(403, '只能修改本人送样单');
    }
    const rows = items.map((it) => {
      const prev = old && old.items.find((x) => x.id === Number(it.id));
      // 已转正的明细保持原样 / keep archived lines untouched
      if (prev && prev.new_sample_id) return { ...prev };
      const s = assertSampleUsable(ctx.db, Number(it.sample_id), '送样');
      checkNewItemNo(ctx.db, it.new_item_no, s);
      return { id: it.id, sample_id: s.id, item_no: s.company_no, qty: num(it.qty) || 1, new_item_no: it.new_item_no || null, revise_req: it.revise_req || null,
        verify_status: it.new_item_no ? (prev && prev.new_item_no === it.new_item_no ? prev.verify_status : '待核验') : null,
        verify_note: prev ? prev.verify_note : null, redo_count: prev ? prev.redo_count : 0, new_sample_id: null };
    });
    return tx(ctx.db, () => {
      let sid = id ? Number(id) : null;
      const h = [b.customer_id, b.quote_id || null, num(b.cost), b.remark || ''];
      if (old) {
        ctx.db.prepare('UPDATE sample_sends SET customer_id=?, quote_id=?, cost=?, remark=? WHERE id=?').run(...h, sid);
      } else {
        const no = nextNo(ctx.db, 'SS', 'sample_sends', 'send_no');
        const rr = ctx.db.prepare("INSERT INTO sample_sends(send_no,customer_id,quote_id,cost,remark,salesman_id,status) VALUES(?,?,?,?,?,?,'申请中')").run(no, ...h, ctx.user.employee_id);
        sid = Number(rr.lastInsertRowid);
      }
      syncItems(ctx.db, 'sample_send_items', 'send_id', sid, rows, ['sample_id', 'item_no', 'qty', 'new_item_no', 'revise_req', 'verify_status', 'verify_note', 'redo_count', 'new_sample_id'], (e) => {
        if (e.new_sample_id) throw new HttpError(409, `货号 ${e.new_item_no} 已转正，不能删除该明细`);
      });
      const d = ctx.db.prepare('SELECT send_no FROM sample_sends WHERE id=?').get(sid);
      for (const it of rows.filter((x) => x.new_item_no && !x.new_sample_id)) {
        const exists = ctx.db.prepare("SELECT 1 FROM sample_revisions WHERE sample_id=? AND stage='送样改样' AND content LIKE ?").get(it.sample_id, `%${d.send_no}%新货号【${it.new_item_no}】%`);
        if (!exists) {
          ctx.db.prepare("INSERT INTO sample_revisions(sample_id,stage,content,user_name) VALUES(?,'送样改样',?,?)")
            .run(it.sample_id, `送样单${d.send_no}：预创新货号【${it.new_item_no}】，改样要求：${it.revise_req || '-'}`, ctx.user.name);
        }
      }
      log(ctx, 'sendsample', old ? '修改送样单' : '新增送样单', d.send_no);
      return getSend(ctx, sid);
    });
  };
  r.post('/api/sample-sends', (ctx) => { need(ctx, 'sendsample', 'add'); return saveSend(ctx); });
  // 报价单另存为送样单 / save a quote as a sample-send
  r.post('/api/quotes/:id/to-send', (ctx) => {
    need(ctx, 'sendsample', 'add');
    const q = getQuote(ctx, ctx.params.id);
    const ids = Array.isArray(ctx.body.item_ids) && ctx.body.item_ids.length ? new Set(ctx.body.item_ids.map(Number)) : null;
    const items = q.items.filter((i) => !ids || ids.has(i.id)).map((i) => ({ sample_id: i.sample_id, qty: 1, new_item_no: i.new_item_no, revise_req: i.revise_req }));
    if (!items.length) throw new HttpError(400, '请选择要送样的货号');
    const d = saveSend({ ...ctx, body: { customer_id: q.customer_id, quote_id: q.id, remark: `由报价单 ${q.quote_no} 生成`, items } });
    log(ctx, 'sendsample', '报价单另存为送样单', d.send_no, q.quote_no);
    return d;
  });
  r.put('/api/sample-sends/:id', (ctx) => { need(ctx, 'sendsample', 'edit'); return saveSend(ctx, ctx.params.id); });
  r.post('/api/sample-sends/:id/status', (ctx) => {
    need(ctx, 'sendsample', 'edit');
    const d = getSend(ctx, ctx.params.id);
    const to = ctx.body.status;
    const flow = { 已寄出: ['申请中'], 客户确认: ['已寄出'], 客户拒绝: ['已寄出'] };
    if (!flow[to]) throw new HttpError(400, '不支持的状态');
    if (!flow[to].includes(d.status)) throw new HttpError(409, `当前状态【${d.status}】不能变更为【${to}】`);
    if (to === '已寄出') {
      required(ctx.body, { express_co: '快递公司', tracking_no: '快递单号' });
      ctx.db.prepare('UPDATE sample_sends SET status=?, express_co=?, tracking_no=?, send_date=?, cost=COALESCE(?,cost) WHERE id=?')
        .run(to, ctx.body.express_co, ctx.body.tracking_no, ctx.body.send_date || today(), ctx.body.cost ?? null, d.id);
      for (const it of d.items) ctx.db.prepare('UPDATE samples SET stock_qty=MAX(0, stock_qty-?) WHERE id=?').run(it.qty, it.sample_id);
    } else {
      ctx.db.prepare('UPDATE sample_sends SET status=?, customer_feedback=? WHERE id=?').run(to, ctx.body.customer_feedback || '', d.id);
    }
    log(ctx, 'sendsample', `送样单${to}`, d.send_no);
    return getSend(ctx, d.id);
  });
  r.post('/api/send-items/:id/verify', (ctx) => {
    need(ctx, 'sendsample', 'edit');
    const it = ctx.db.prepare('SELECT * FROM sample_send_items WHERE id=?').get(ctx.params.id);
    if (!it) throw new HttpError(404, '送样明细不存在');
    const d = getSend(ctx, it.send_id);
    if (!it.new_item_no) throw new HttpError(400, '该明细没有改样新货号，无需核验');
    if (it.new_sample_id) throw new HttpError(409, '新货号已转正归档');
    const pass = !!ctx.body.pass;
    if (!pass && !ctx.body.note) throw new HttpError(400, '核验不通过时请填写整改意见');
    tx(ctx.db, () => {
      if (pass) {
        ctx.db.prepare("UPDATE sample_send_items SET verify_status='通过', verify_note=? WHERE id=?").run(ctx.body.note || '', it.id);
      } else {
        ctx.db.prepare("UPDATE sample_send_items SET verify_status='不通过-重做中', verify_note=?, redo_count=redo_count+1 WHERE id=?").run(ctx.body.note, it.id);
        ctx.db.prepare("UPDATE samples SET progress='重做中' WHERE id=?").run(it.sample_id);
      }
      ctx.db.prepare("INSERT INTO sample_revisions(sample_id,stage,content,user_name) VALUES(?,'核验',?,?)")
        .run(it.sample_id, `新货号【${it.new_item_no}】核验${pass ? '通过' : '不通过，发起重做'}：${ctx.body.note || ''}`, ctx.user.name);
    });
    log(ctx, 'sendsample', pass ? '改样核验通过' : '改样核验不通过-重做', d.send_no, it.new_item_no);
    return getSend(ctx, d.id);
  });
  r.post('/api/send-items/:id/convert', (ctx) => {
    need(ctx, 'sendsample', 'edit');
    need(ctx, 'sample', 'add');
    const it = ctx.db.prepare('SELECT * FROM sample_send_items WHERE id=?').get(ctx.params.id);
    if (!it) throw new HttpError(404, '送样明细不存在');
    const d = getSend(ctx, it.send_id);
    if (it.new_sample_id) throw new HttpError(409, '该新货号已转正');
    if (it.verify_status !== '通过') throw new HttpError(409, '改样核验通过后才能转正归档');
    const old = ctx.db.prepare('SELECT * FROM samples WHERE id=?').get(it.sample_id);
    checkNewItemNo(ctx.db, it.new_item_no, old);
    if (ctx.db.prepare('SELECT 1 FROM samples WHERE company_no=?').get(it.new_item_no)) throw new HttpError(409, `新货号【${it.new_item_no}】已存在样品档案`);
    const b = ctx.body || {};
    const newId = tx(ctx.db, () => {
      const copy = ['customer_no', 'factory_no', 'name', 'name_en', 'length_cm', 'width_cm', 'height_cm', 'material', 'craft', 'color', 'consumables', 'material_cost', 'labor_cost',
        'sample_fee', 'designer_id', 'supplier_id', 'package_req', 'label_req', 'inner_box', 'outer_l', 'outer_w', 'outer_h', 'pcs_per_carton', 'moq', 'images'];
      const vals = copy.map((c) => (b[c] !== undefined && b[c] !== '' ? b[c] : old[c]));
      const rr = ctx.db.prepare(`INSERT INTO samples(company_no,parent_no,progress,status,stock_qty,remark,${copy.join(',')}) VALUES(?,?,'已完成','正常',0,?,${copy.map(() => '?').join(',')})`)
        .run(it.new_item_no, old.company_no, `由${old.company_no}改样转正。改样要求：${it.revise_req || ''}`, ...vals);
      const nid = Number(rr.lastInsertRowid);
      // 复制图片文件给新样品，避免新旧货号共用同一文件 / copy image files so old and new samples never share a file
      const imgs = String(vals[copy.indexOf('images')] || '').split(/[,，\s]+/).filter(Boolean).map((ref) => {
        if (!ref.startsWith('file:')) return ref;
        const f = ctx.db.prepare("SELECT * FROM files WHERE id=? AND owner_type='sample'").get(Number(ref.slice(5)));
        if (!f) return null;
        const fid = ctx.db.prepare("INSERT INTO files(name,mime,size,data,owner_type,owner_id,created_by) VALUES(?,?,?,?,'sample',?,?)").run(f.name, f.mime, f.size, f.data, nid, ctx.user.name).lastInsertRowid;
        return `file:${fid}`;
      }).filter(Boolean);
      ctx.db.prepare('UPDATE samples SET images=? WHERE id=?').run(imgs.join(','), nid);
      // 继承改样记录 / inherit revision history
      for (const rv of ctx.db.prepare('SELECT * FROM sample_revisions WHERE sample_id=? ORDER BY id').all(old.id)) {
        ctx.db.prepare('INSERT INTO sample_revisions(sample_id,stage,content,user_name,created_at) VALUES(?,?,?,?,?)').run(nid, rv.stage, `[继承自${old.company_no}] ${rv.content}`, rv.user_name, rv.created_at);
      }
      ctx.db.prepare("INSERT INTO sample_revisions(sample_id,stage,content,user_name) VALUES(?,'转正',?,?)").run(nid, `新货号转正归档，原货号${old.company_no}，改样要求：${it.revise_req || ''}`, ctx.user.name);
      ctx.db.prepare("INSERT INTO sample_revisions(sample_id,stage,content,user_name) VALUES(?,'转正',?,?)").run(old.id, `已被新货号【${it.new_item_no}】替代，旧货号锁定，禁止报价/下单/出货`, ctx.user.name);
      ctx.db.prepare("UPDATE samples SET status='已锁定', locked_at=datetime('now','localtime') WHERE id=?").run(old.id);
      ctx.db.prepare('UPDATE sample_send_items SET new_sample_id=? WHERE id=?').run(nid, it.id);
      return nid;
    });
    log(ctx, 'sample', '新货号转正归档并锁定旧货号', it.new_item_no, `原货号 ${old.company_no}`);
    return { id: newId, company_no: it.new_item_no, send: getSend(ctx, d.id) };
  });
}

module.exports = { register, docScope, filterItemsForDesigner, syncItems, priceQuote, inquiryXlsx, getInquiry, sampleBom };
