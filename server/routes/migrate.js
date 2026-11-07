'use strict';
/**
 * 数据迁移接口：亿星等旧系统资料导入、导入记录与回滚
 * Data-migration routes: import from legacy systems such as 亿星, import history and rollback.
 * @module server/routes/migrate
 */
const { HttpError } = require('../http');
const { need } = require('../core');
const { buildXlsx } = require('../xlsx');
const { readTable } = require('../xlsx-read');
const mig = require('../migrate');

/** 导入文件大小上限 / Max import file size */
const MAX_FILE = 6 * 1024 * 1024;

/**
 * 解码上传的表格文件并读取 / Decode an uploaded (base64) sheet and read its rows.
 * @param {object} body 请求体 / request body {file_name, data}
 * @returns {string[][]}
 */
function readUpload(body) {
  if (!body || !body.data) throw new HttpError(400, '请先选择要导入的 Excel(.xlsx) 或 CSV 文件');
  const buf = Buffer.from(String(body.data).replace(/^data:[^;]*;base64,/, ''), 'base64');
  if (buf.length > MAX_FILE) throw new HttpError(400, '文件超过 6MB，请分多个文件导入');
  try {
    return readTable(buf, body.file_name);
  } catch (e) {
    throw new HttpError(400, e.message || '无法读取文件');
  }
}

/**
 * 表头行：用户指定（从1开始）或自动识别 / Header row: user-given (1-based) or auto-detected.
 * @param {object} profile
 * @param {string[][]} rows
 * @param {any} given
 * @returns {number} 从0开始 / zero-based
 */
function headerRowOf(profile, rows, given) {
  const n = parseInt(given, 10);
  if (Number.isFinite(n) && n >= 1) {
    if (n > rows.length) throw new HttpError(400, `表头行 ${n} 超出表格行数（共 ${rows.length} 行）`);
    return n - 1;
  }
  return mig.detectHeader(profile, rows);
}

/**
 * 注册数据迁移路由 / Register data-migration routes.
 * @param {import('../http').Router} r
 */
function register(r) {
  // 可导入的资料类型与列说明 / importable profiles and their columns
  r.get('/api/migrate/profiles', (ctx) => {
    need(ctx, 'system', 'view');
    return mig.profileList();
  });

  // 下载导入模板（亿星列名）/ download an import template using 亿星 column names
  r.get('/api/migrate/template/:entity', (ctx) => {
    need(ctx, 'system', 'view');
    const p = mig.profileOf(ctx.params.entity);
    const headers = mig.templateHeaders(ctx.params.entity);
    const buf = buildXlsx({ sheet: p.title, rows: [headers.map((h) => ({ v: h, s: 1 }))], widths: headers.map((h) => Math.max(10, h.length * 2 + 4)) });
    return { __file: { buf, name: `${p.title}-亿星迁移导入模板.xlsx`, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } };
  });

  // 读取文件并识别列 / read the file and auto-detect columns
  r.post('/api/migrate/preview', (ctx) => {
    need(ctx, 'system', 'add');
    const p = mig.profileOf(ctx.body.entity);
    const rows = readUpload(ctx.body);
    const headerRow = headerRowOf(p, rows, ctx.body.header_row);
    const headers = rows[headerRow] || [];
    const width = Math.max(headers.length, ...rows.slice(headerRow + 1, headerRow + 30).map((x) => x.length));
    const fullHeaders = Array.from({ length: width }, (_, i) => headers[i] || '');
    const dataRows = rows.slice(headerRow + 1).filter((x) => x.some((v) => v !== ''));
    return {
      header_row: headerRow + 1,
      headers: fullHeaders,
      mapping: mig.autoMap(p, fullHeaders),
      sample: dataRows.slice(0, 8).map((x) => fullHeaders.map((_, i) => x[i] ?? '')),
      data_rows: dataRows.length,
      total_rows: rows.length,
    };
  });

  // 校验（dry_run）或正式导入 / validate (dry_run) or import
  r.post('/api/migrate/import', (ctx) => {
    need(ctx, 'system', 'add');
    const p = mig.profileOf(ctx.body.entity);
    const rows = readUpload(ctx.body);
    const headerRow = headerRowOf(p, rows, ctx.body.header_row);
    return mig.runImport(ctx, {
      entity: ctx.body.entity,
      rows,
      headerRow,
      mapping: ctx.body.mapping,
      mode: ctx.body.mode,
      dryRun: !!ctx.body.dry_run,
      defaults: ctx.body.defaults,
      fileName: String(ctx.body.file_name || '').slice(0, 200),
    });
  });

  // 导入记录 / import history
  r.get('/api/migrate/batches', (ctx) => {
    need(ctx, 'system', 'view');
    return ctx.db.prepare('SELECT id,batch_no,entity,source,file_name,mode,total,created,updated,skipped,failed,status,user_name,created_at,rolled_back_at FROM import_batches ORDER BY id DESC LIMIT 200').all()
      .map((b) => ({ ...b, entity_title: (mig.PROFILES[b.entity] || {}).title || b.entity }));
  });

  r.get('/api/migrate/batches/:id', (ctx) => {
    need(ctx, 'system', 'view');
    const b = ctx.db.prepare('SELECT * FROM import_batches WHERE id=?').get(ctx.params.id);
    if (!b) throw new HttpError(404, '导入批次不存在');
    const detail = JSON.parse(b.result || '{}');
    return { ...b, result: undefined, buckets: detail.buckets || {}, warnings: detail.warnings || [], bucket_names: mig.BUCKETS, entity_title: (mig.PROFILES[b.entity] || {}).title };
  });

  r.post('/api/migrate/batches/:id/rollback', (ctx) => {
    need(ctx, 'system', 'delete');
    return mig.rollbackBatch(ctx, ctx.params.id);
  });
}

module.exports = { register };
