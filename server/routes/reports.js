'use strict';
/**
 * 统计报表与设计师速查中心路由
 * Statistical reports and the designer self-service query center.
 * @module server/routes/reports
 */
const { HttpError } = require('../http');
const { need, num, round, today } = require('../core');
const { productionRows } = require('./finance');

/**
 * 构造报表分节 / Build a report section.
 * @param {string} title 分节标题 / section title
 * @param {string[]} headers 表头 / headers
 * @param {any[][]} rows 数据 / rows
 * @param {object} [chart] 图表配置 {label: 列序号, value: 列序号} / chart config
 * @returns {object}
 */
const section = (title, headers, rows, chart) => ({ title, headers, rows, chart });

/**
 * 日期过滤条件 / Date range filter.
 * @param {object} q 查询参数 / query
 * @param {string} col 日期列 / date column
 * @returns {{sql:string, params:string[]}}
 */
function range(q, col) {
  const parts = [];
  const params = [];
  if (q.from) { parts.push(`date(${col}) >= ?`); params.push(q.from); }
  if (q.to) { parts.push(`date(${col}) <= ?`); params.push(q.to); }
  return { sql: parts.length ? parts.join(' AND ') : '1=1', params };
}

const pct = (a, b) => (b ? round(a * 100 / b, 1) + '%' : '-');

/** 报表定义 / Report builders */
const REPORTS = {
  business: {
    title: '业务口径统计',
    build(db, q) {
      const ro = range(q, 'o.order_date');
      const rq = range(q, 'q.created_at');
      const sales = db.prepare(`SELECT e.id, e.name FROM employees e WHERE e.id IN (SELECT salesman_id FROM customers UNION SELECT salesman_id FROM quotes UNION SELECT salesman_id FROM orders)`).all();
      const s1 = sales.map((e) => {
        const qs = db.prepare(`SELECT COUNT(*) c, SUM(status='已成交') won FROM quotes q WHERE salesman_id=? AND ${rq.sql}`).get(e.id, ...rq.params);
        const os = db.prepare(`SELECT COUNT(*) c, COALESCE(SUM((SELECT SUM(qty*unit_price) FROM order_items WHERE order_id=o.id)*o.rate),0) amt FROM orders o WHERE salesman_id=? AND ${ro.sql}`).get(e.id, ...ro.params);
        const rec = db.prepare(`SELECT COALESCE(SUM(r.amount_cny),0) v FROM receipts r JOIN orders o ON o.id=r.order_id WHERE o.salesman_id=? AND ${ro.sql}`).get(e.id, ...ro.params).v;
        const inq = db.prepare(`SELECT COUNT(*) c FROM customer_follows f JOIN customers c ON c.id=f.customer_id WHERE c.salesman_id=? AND f.type='询盘'`).get(e.id).c;
        const ss = db.prepare('SELECT COUNT(*) c FROM sample_sends WHERE salesman_id=?').get(e.id).c;
        return [e.name, inq, qs.c, qs.won || 0, pct(qs.won || 0, qs.c), ss, os.c, round(os.amt), round(rec)];
      });
      const s2 = db.prepare(`SELECT c.code, c.name, c.country, COUNT(o.id) orders,
          COALESCE(SUM((SELECT SUM(qty*unit_price) FROM order_items WHERE order_id=o.id)*o.rate),0) amt,
          (SELECT COALESCE(SUM(r.amount_cny),0) FROM receipts r JOIN orders o2 ON o2.id=r.order_id WHERE o2.customer_id=c.id) rec,
          (SELECT COUNT(*) FROM quotes WHERE customer_id=c.id) quotes, (SELECT COUNT(*) FROM sample_sends WHERE customer_id=c.id) sends
        FROM customers c LEFT JOIN orders o ON o.customer_id=c.id AND ${ro.sql} GROUP BY c.id ORDER BY amt DESC`).all(...ro.params)
        .map((x) => [x.code, x.name, x.country, x.quotes, x.sends, x.orders, round(x.amt), round(x.rec)]);
      const sendCust = db.prepare('SELECT COUNT(DISTINCT customer_id) c FROM sample_sends').get().c;
      const sendWon = db.prepare('SELECT COUNT(DISTINCT s.customer_id) c FROM sample_sends s WHERE EXISTS (SELECT 1 FROM orders o WHERE o.customer_id=s.customer_id AND o.order_date >= date(s.created_at))').get().c;
      const qAll = db.prepare('SELECT COUNT(*) c, SUM(status=\'已成交\') w FROM quotes').get();
      return [
        section('业务员业绩', ['业务员', '询盘数', '报价单数', '成交报价', '报价成交率', '送样单数', '订单数', '订单金额(¥)', '实收(¥)'], s1, { label: 0, value: 7 }),
        section('客户业绩', ['客户编码', '客户', '国别', '报价数', '送样数', '订单数', '订单金额(¥)', '实收(¥)'], s2, { label: 1, value: 6 }),
        section('转化率汇总', ['指标', '分子', '分母', '比率'], [
          ['报价成交率', qAll.w || 0, qAll.c, pct(qAll.w || 0, qAll.c)],
          ['送样成交率(送样客户后续下单)', sendWon, sendCust, pct(sendWon, sendCust)],
        ]),
      ];
    },
  },
  sample: {
    title: '样品口径统计',
    build(db) {
      const rows = db.prepare(`SELECT s.company_no, s.name, d.name designer, s.status, s.progress,
          (SELECT COUNT(*) FROM sample_revisions r WHERE r.sample_id=s.id) revs,
          ROUND(COALESCE(s.material_cost,0)+COALESCE(s.labor_cost,0)+COALESCE(s.sample_fee,0),2) cost,
          (SELECT COUNT(*) FROM sample_send_items i WHERE i.sample_id=s.id) sends,
          (SELECT COUNT(DISTINCT order_id) FROM order_items i WHERE i.sample_id=s.id) orders
        FROM samples s LEFT JOIN employees d ON d.id=s.designer_id ORDER BY s.id`).all()
        .map((x) => [x.company_no, x.name, x.designer, x.status, x.progress, x.revs, x.cost, x.sends, x.orders, pct(x.orders, x.sends)]);
      const tot = db.prepare(`SELECT COUNT(*) n, SUM(progress='已完成') done, ROUND(SUM(COALESCE(sample_fee,0)),2) fee FROM samples`).get();
      const sendCost = db.prepare('SELECT ROUND(COALESCE(SUM(cost),0),2) v FROM sample_sends').get().v;
      return [
        section('样品汇总', ['指标', '数值'], [['样品总数', tot.n], ['已完成打样', tot.done || 0], ['打样费用合计(¥)', tot.fee || 0], ['送样费用合计(¥)', sendCost],
          ['改样记录总数', db.prepare('SELECT COUNT(*) c FROM sample_revisions').get().c]]),
        section('样品明细（改样次数/成本/送样转化）', ['公司货号', '品名', '设计师', '状态', '打样进度', '改样次数', '样品成本(¥)', '送样次数', '成交订单数', '送样转化率'], rows, { label: 0, value: 5 }),
      ];
    },
  },
  production: {
    title: '生产口径统计',
    build(db, q) {
      const rr = range(q, 'report_date');
      const daily = db.prepare(`SELECT report_date, process, SUM(qty) qty, SUM(good_qty) good, SUM(bad_qty) bad FROM production_reports WHERE ${rr.sql} GROUP BY report_date, process ORDER BY report_date DESC, process`)
        .all(...rr.params).map((x) => [x.report_date, x.process, x.qty, x.good, x.bad, pct(x.good, x.qty)]);
      const prods = productionRows(db).map((p) => [p.prod_no, p.order_no, p.item_no, p.plan_qty, p.process['制坯'].good || 0, p.process['烧制'].good || 0, p.process['包装'].good || 0,
        p.completion + '%', p.bad_rate + '%', p.due_date, p.status, p.delayed ? '延期' : '正常']);
      const mat = db.prepare(`SELECT o.order_no, i.code, i.name, SUM(m.qty) qty, i.unit, ROUND(SUM(m.qty*m.unit_cost),2) amt FROM material_issues m JOIN inventory i ON i.id=m.inventory_id
        JOIN orders o ON o.id=m.order_id GROUP BY o.id, i.id ORDER BY o.order_no`).all().map((x) => [x.order_no, x.code, x.name, x.qty, x.unit, x.amt]);
      return [
        section('每日产能（按工序）', ['日期', '工序', '产量', '良品', '不良', '良品率'], daily),
        section('布产完工率与延期', ['布产单', '订单', '货号', '计划数', '制坯良品', '烧制良品', '包装良品', '完工率', '不良率', '计划完工', '状态', '延期'], prods),
        section('物料耗用（按订单核算）', ['订单', '物料编码', '物料', '数量', '单位', '金额(¥)'], mat),
      ];
    },
  },
  supply: {
    title: '供应链口径统计',
    build(db, q) {
      const rp = range(q, 'p.order_date');
      const bySup = db.prepare(`SELECT s.name, p.type, COUNT(DISTINCT p.id) n, ROUND(COALESCE(SUM(pi.qty*pi.price),0),2) amt, ROUND(COALESCE(SUM(pi.received_qty*pi.price),0),2) recv, s.pass_rate, s.rating
        FROM purchases p JOIN suppliers s ON s.id=p.supplier_id LEFT JOIN purchase_items pi ON pi.po_id=p.id WHERE ${rp.sql} GROUP BY s.id, p.type ORDER BY amt DESC`).all(...rp.params)
        .map((x) => [x.name, x.type, x.n, x.amt, x.recv, x.pass_rate + '%', x.rating]);
      const inv = db.prepare('SELECT * FROM inventory ORDER BY code').all()
        .map((i) => [i.code, i.name, i.category, i.qty, i.unit, i.unit_cost, round(i.qty * i.unit_cost), i.safety_qty, i.max_qty, i.qty < i.safety_qty ? '缺料预警' : (i.max_qty > 0 && i.qty > i.max_qty ? '积压预警' : '正常')]);
      return [
        section('供应商采购统计（原辅材料/外购成品）', ['供应商', '采购类型', '采购单数', '采购金额(¥)', '已入库金额(¥)', '供货合格率', '评级'], bySup, { label: 0, value: 3 }),
        section('物料库存与预警', ['编码', '物料', '类别', '库存', '单位', '单位成本', '库存金额(¥)', '安全库存', '最高库存', '预警'], inv),
      ];
    },
  },
  finance: {
    title: '财务口径统计',
    build(db) {
      const ar = db.prepare(`SELECT o.currency, ROUND(SUM((SELECT COALESCE(SUM(qty*unit_price),0) FROM order_items WHERE order_id=o.id)),2) amt,
          ROUND(SUM((SELECT COALESCE(SUM(amount),0) FROM receipts WHERE order_id=o.id)),2) rec,
          ROUND(SUM((SELECT COALESCE(SUM(fx_gain),0) FROM receipts WHERE order_id=o.id)),2) fx,
          ROUND(SUM((SELECT COALESCE(SUM(amount),0) FROM sales_invoices WHERE order_id=o.id)),2) inv
        FROM orders o GROUP BY o.currency`).all().map((x) => [x.currency, x.amt, x.rec, round(x.amt - x.rec), x.fx, x.inv, round(x.amt - x.inv)]);
      const ap = db.prepare(`SELECT ROUND(COALESCE(SUM(qty*price),0),2) amt FROM purchase_items`).get().amt;
      const paid = db.prepare(`SELECT ROUND(COALESCE(SUM(amount),0),2) v FROM payments WHERE status='已付款'`).get().v;
      const pin = db.prepare(`SELECT ROUND(COALESCE(SUM(amount),0),2) v, ROUND(COALESCE(SUM(CASE WHEN verify_status='已核销' THEN amount END),0),2) ver FROM purchase_invoices`).get();
      return [
        section('订单应收/实收/未收/汇兑损益/销项开票（原币）', ['币种', '应收', '实收', '未收', '汇兑损益(¥)', '已开票', '未开票'], ar),
        section('采购应付/实付/进项开票（¥）', ['指标', '金额'], [['采购应付', ap], ['实付', paid], ['未付', round(ap - paid)], ['进项已开票', pin.v], ['进项已核销', pin.ver], ['进项未开票', round(ap - pin.v)]]),
      ];
    },
  },
  trade: {
    title: '外贸口径统计',
    build(db, q) {
      const ro = range(q, 'o.order_date');
      const byCountry = db.prepare(`SELECT c.country, COUNT(o.id) n, ROUND(COALESCE(SUM((SELECT SUM(qty*unit_price) FROM order_items WHERE order_id=o.id)*o.rate),0),2) amt
        FROM orders o JOIN customers c ON c.id=o.customer_id WHERE ${ro.sql} GROUP BY c.country ORDER BY amt DESC`).all(...ro.params).map((x) => [x.country, x.n, x.amt]);
      const ships = db.prepare(`SELECT s.ship_no, o.order_no, c.name, c.country, s.ship_date, s.port, s.dest_port, s.container_no, s.customs_no,
          (SELECT SUM(qty) FROM shipment_items WHERE shipment_id=s.id) qty, (SELECT ROUND(SUM(cbm),3) FROM shipment_items WHERE shipment_id=s.id) cbm, s.inspection_status, s.status
        FROM shipments s JOIN orders o ON o.id=s.order_id JOIN customers c ON c.id=o.customer_id ORDER BY s.id DESC`).all()
        .map((x) => [x.ship_no, x.order_no, x.name, x.country, x.ship_date, x.port, x.dest_port, x.container_no, x.customs_no, x.qty, x.cbm, x.inspection_status, x.status]);
      return [
        section('国别订单统计', ['国别', '订单数', '订单金额(¥)'], byCountry, { label: 0, value: 2 }),
        section('报关出货/海运出口明细', ['出货单', '订单', '客户', '国别', '出货日期', '起运港', '目的港', '柜号', '报关单号', '数量', 'CBM', '验货', '状态'], ships),
      ];
    },
  },
  designer: {
    title: '设计师口径统计',
    build(db) {
      const rows = db.prepare(`SELECT e.id, e.name FROM employees e WHERE e.id IN (SELECT designer_id FROM samples)`).all().map((e) => {
        const s = designerSummary(db, e.id);
        return [e.name, s.samples, s.quote_lines, s.send_lines, s.order_lines, s.order_qty, s.order_amount_cny, s.shipped_qty, s.shipped_amount_cny];
      });
      return [section('设计师作品业绩与提成基数', ['设计师', '设计样品数', '报价次数', '送样次数', '下单次数', '下单数量', '下单金额(¥)', '已出货数量', '已出货金额(¥)=提成基数'], rows, { label: 0, value: 8 })];
    },
  },
  revision: {
    title: '改样新货号溯源',
    build(db) {
      const lines = [
        ...db.prepare(`SELECT '报价' stage, q.quote_no doc, i.item_no, i.new_item_no, i.revise_req, NULL verify, q.created_at dt FROM quote_items i JOIN quotes q ON q.id=i.quote_id WHERE i.new_item_no IS NOT NULL`).all(),
        ...db.prepare(`SELECT '送样' stage, d.send_no doc, i.item_no, i.new_item_no, i.revise_req, i.verify_status verify, d.created_at dt FROM sample_send_items i JOIN sample_sends d ON d.id=i.send_id WHERE i.new_item_no IS NOT NULL`).all(),
      ].sort((a, b) => String(b.dt).localeCompare(String(a.dt)));
      const rows = lines.map((x) => {
        const ns = db.prepare('SELECT id, status FROM samples WHERE company_no=?').get(x.new_item_no);
        const cnt = (t) => (ns ? db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE sample_id=?`).get(ns.id).c : 0);
        return [x.item_no, x.new_item_no, x.stage, x.doc, x.revise_req || '', x.verify || '-', ns ? '已转正' : '临时货号', cnt('quote_items'), cnt('sample_send_items'), cnt('order_items')];
      });
      const chains = db.prepare(`SELECT n.company_no new_no, n.parent_no old_no, o.status old_status, n.created_at FROM samples n LEFT JOIN samples o ON o.company_no=n.parent_no WHERE n.parent_no IS NOT NULL ORDER BY n.id DESC`).all()
        .map((x) => [x.old_no, x.old_status, x.new_no, x.created_at]);
      return [
        section('改样新货号台账（报价/送样阶段）', ['原货号', '新货号', '改样阶段', '来源单据', '改样要求', '核验', '转正状态', '新货号报价', '新货号送样', '新货号订单'], rows),
        section('新旧货号关联（转正归档）', ['原货号', '原货号状态', '新货号', '转正时间'], chains),
      ];
    },
  },
};

/**
 * 设计师汇总数据 / Designer summary metrics.
 * @param {object} db
 * @param {number} designerId 设计师员工ID / designer employee id
 * @returns {object}
 */
function designerSummary(db, designerId) {
  const one = (sql) => db.prepare(sql).get(designerId);
  const ord = one(`SELECT COUNT(*) n, COALESCE(SUM(i.qty),0) qty, COALESCE(SUM(i.qty*i.unit_price*o.rate),0) amt FROM order_items i JOIN orders o ON o.id=i.order_id JOIN samples s ON s.id=i.sample_id WHERE s.designer_id=?`);
  const shp = one(`SELECT COALESCE(SUM(si.qty),0) qty, COALESCE(SUM(si.qty*oi.unit_price*o.rate),0) amt FROM shipment_items si JOIN shipments sh ON sh.id=si.shipment_id AND sh.status='已出运'
    JOIN order_items oi ON oi.id=si.order_item_id JOIN orders o ON o.id=oi.order_id JOIN samples s ON s.id=oi.sample_id WHERE s.designer_id=?`);
  return {
    samples: one('SELECT COUNT(*) c FROM samples WHERE designer_id=?').c,
    quote_lines: one('SELECT COUNT(*) c FROM quote_items i JOIN samples s ON s.id=i.sample_id WHERE s.designer_id=?').c,
    send_lines: one('SELECT COUNT(*) c FROM sample_send_items i JOIN samples s ON s.id=i.sample_id WHERE s.designer_id=?').c,
    order_lines: ord.n, order_qty: ord.qty, order_amount_cny: round(ord.amt),
    shipped_qty: shp.qty, shipped_amount_cny: round(shp.amt),
    unshipped_qty: ord.qty - shp.qty,
  };
}

/**
 * 解析当前要查询的设计师 / Resolve which designer to query.
 * @param {object} ctx
 * @returns {number}
 */
function resolveDesigner(ctx) {
  need(ctx, 'designer', 'view');
  if (ctx.user.scope === 'designer') {
    if (!ctx.user.employee_id) throw new HttpError(400, '账号未绑定员工档案，无法识别设计师身份');
    return ctx.user.employee_id;
  }
  const id = Number(ctx.query.designer_id);
  if (!id) throw new HttpError(400, '请选择设计师');
  return id;
}

/**
 * 设计师明细查询 / Designer detail queries.
 * @param {object} db
 * @param {string} kind 查询类型 / kind
 * @param {number} did 设计师ID / designer id
 * @param {object} q 过滤 / filters
 * @returns {{headers:string[], rows:any[][]}}
 */
function designerDetail(db, kind, did, q) {
  const f = [];
  const p = [did];
  const like = (col) => { if (q.item_no) { f.push(`${col} LIKE ?`); p.push(`%${q.item_no}%`); } };
  const dr = (col) => {
    if (q.from) { f.push(`date(${col}) >= ?`); p.push(q.from); }
    if (q.to) { f.push(`date(${col}) <= ?`); p.push(q.to); }
  };
  const and = () => (f.length ? ' AND ' + f.join(' AND ') : '');
  switch (kind) {
    case 'samples': {
      like('s.company_no'); dr('s.created_at');
      if (q.status) { f.push('s.status=?'); p.push(q.status); }
      return {
        title: '个人样品档案', headers: ['公司货号', '客户货号', '品名', '材质', '工艺', '尺寸(cm)', '设计时间', '改样次数', '原货号', '状态'],
        rows: db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM sample_revisions r WHERE r.sample_id=s.id) revs FROM samples s WHERE s.designer_id=?${and()} ORDER BY s.id DESC`).all(...p)
          .map((s) => [s.company_no, s.customer_no || '', s.name, s.material || '', s.craft || '', s.length_cm ? `${s.length_cm}×${s.width_cm}×${s.height_cm}` : '', s.created_at, s.revs, s.parent_no || '', s.status]),
      };
    }
    case 'quotes':
      like('i.item_no'); dr('q.created_at');
      if (q.status) { f.push('q.status=?'); p.push(q.status); }
      return {
        title: '关联报价单', headers: ['报价单号', '报价日期', '客户', '业务员', '货号', '新货号', '数量', '单价', '币种', '状态'],
        rows: db.prepare(`SELECT q.quote_no, q.created_at, c.name cname, e.name sname, i.item_no, i.new_item_no, i.qty, i.price, q.currency, q.status FROM quote_items i JOIN quotes q ON q.id=i.quote_id
          JOIN samples s ON s.id=i.sample_id LEFT JOIN customers c ON c.id=q.customer_id LEFT JOIN employees e ON e.id=q.salesman_id WHERE s.designer_id=?${and()} ORDER BY q.id DESC`).all(...p)
          .map((x) => [x.quote_no, String(x.created_at).slice(0, 10), x.cname, x.sname, x.item_no, x.new_item_no || '', x.qty, x.price, x.currency, x.status]),
      };
    case 'sends':
      like('i.item_no'); dr('d.created_at');
      if (q.status) { f.push('d.status=?'); p.push(q.status); }
      return {
        title: '关联送样单', headers: ['送样单号', '送样客户', '送样日期', '货号', '数量', '新货号', '快递单号', '送样状态'],
        rows: db.prepare(`SELECT d.send_no, c.name cname, d.send_date, i.item_no, i.qty, i.new_item_no, d.tracking_no, d.status FROM sample_send_items i JOIN sample_sends d ON d.id=i.send_id
          JOIN samples s ON s.id=i.sample_id LEFT JOIN customers c ON c.id=d.customer_id WHERE s.designer_id=?${and()} ORDER BY d.id DESC`).all(...p)
          .map((x) => [x.send_no, x.cname, x.send_date || '', x.item_no, x.qty, x.new_item_no || '', x.tracking_no || '', x.status]),
      };
    case 'orders':
      like('i.item_no'); dr('o.order_date');
      if (q.status) { f.push('o.status=?'); p.push(q.status); }
      return {
        title: '关联客户订单', headers: ['订单号', '下单日期', '客户', '货号', '数量', '单价', '币种', '金额', '已出运数量', '出货状态'],
        rows: db.prepare(`SELECT o.order_no, o.order_date, c.name cname, i.item_no, i.qty, i.unit_price, o.currency,
            (SELECT COALESCE(SUM(si.qty),0) FROM shipment_items si JOIN shipments sh ON sh.id=si.shipment_id WHERE si.order_item_id=i.id AND sh.status='已出运') shipped
          FROM order_items i JOIN orders o ON o.id=i.order_id JOIN samples s ON s.id=i.sample_id LEFT JOIN customers c ON c.id=o.customer_id WHERE s.designer_id=?${and()} ORDER BY o.id DESC`).all(...p)
          .map((x) => [x.order_no, x.order_date, x.cname, x.item_no, x.qty, x.unit_price, x.currency, round(x.qty * x.unit_price), x.shipped,
            x.shipped <= 0 ? '已下单未出货' : (x.shipped < x.qty ? '部分出货' : '已出货')]),
      };
    case 'shipments':
      like('oi.item_no'); dr('sh.ship_date');
      return {
        title: '关联出货记录', headers: ['出货单号', '订单号', '客户', '出货日期', '货号', '出货数量', '单价', '币种', '金额', '出货状态'],
        rows: db.prepare(`SELECT sh.ship_no, o.order_no, c.name cname, sh.ship_date, oi.item_no, si.qty, oi.unit_price, o.currency, sh.status FROM shipment_items si
          JOIN shipments sh ON sh.id=si.shipment_id JOIN order_items oi ON oi.id=si.order_item_id JOIN orders o ON o.id=oi.order_id JOIN samples s ON s.id=oi.sample_id
          LEFT JOIN customers c ON c.id=o.customer_id WHERE s.designer_id=?${and()} ORDER BY sh.id DESC`).all(...p)
          .map((x) => [x.ship_no, x.order_no, x.cname, x.ship_date, x.item_no, x.qty, x.unit_price, x.currency, round(x.qty * x.unit_price), x.status]),
      };
    default:
      throw new HttpError(404, '未知查询类型');
  }
}

/**
 * 注册报表路由 / Register report routes.
 * @param {import('../http').Router} r
 */
function register(r) {
  r.get('/api/reports', (ctx) => {
    need(ctx, 'report', 'view');
    return Object.entries(REPORTS).map(([key, v]) => ({ key, title: v.title }));
  });
  r.get('/api/reports/:kind', (ctx) => {
    need(ctx, 'report', 'view');
    const rep = REPORTS[ctx.params.kind];
    if (!rep) throw new HttpError(404, '未知报表');
    return { title: rep.title, generated_at: new Date().toLocaleString('sv-SE'), sections: rep.build(ctx.db, ctx.query) };
  });
  r.get('/api/designer/summary', (ctx) => {
    const did = resolveDesigner(ctx);
    const e = ctx.db.prepare('SELECT id, name FROM employees WHERE id=?').get(did);
    if (!e) throw new HttpError(404, '设计师不存在');
    const perSample = ctx.db.prepare(`SELECT s.id, s.company_no, s.name, s.status, s.parent_no,
        (SELECT COUNT(*) FROM quote_items WHERE sample_id=s.id) quotes,
        (SELECT COUNT(*) FROM sample_send_items WHERE sample_id=s.id) sends,
        (SELECT COALESCE(SUM(qty),0) FROM order_items WHERE sample_id=s.id) order_qty,
        (SELECT COALESCE(SUM(si.qty),0) FROM shipment_items si JOIN shipments sh ON sh.id=si.shipment_id AND sh.status='已出运' JOIN order_items oi ON oi.id=si.order_item_id WHERE oi.sample_id=s.id) shipped_qty,
        (SELECT ROUND(COALESCE(SUM(si.qty*oi.unit_price*o.rate),0),2) FROM shipment_items si JOIN shipments sh ON sh.id=si.shipment_id AND sh.status='已出运' JOIN order_items oi ON oi.id=si.order_item_id JOIN orders o ON o.id=oi.order_id WHERE oi.sample_id=s.id) shipped_amount_cny
      FROM samples s WHERE s.designer_id=? ORDER BY s.id`).all(did);
    return { designer: e, summary: designerSummary(ctx.db, did), samples: perSample, as_of: today() };
  });
  r.get('/api/designer/detail/:kind', (ctx) => {
    const did = resolveDesigner(ctx);
    return designerDetail(ctx.db, ctx.params.kind, did, ctx.query);
  });
}

module.exports = { register, REPORTS, designerSummary };
