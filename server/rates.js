'use strict';
/**
 * 汇率自动更新：从公开接口获取并写入币种表与波动记录
 * Automatic exchange-rate update from public APIs into currencies and rate history.
 * @module server/rates
 */
const { round, setting } = require('./core');

/** 备用接口（主接口失败时依次尝试）/ Fallback sources tried when the primary fails */
const FALLBACKS = ['https://open.er-api.com/v6/latest/CNY', 'https://api.frankfurter.app/latest?from=CNY'];

/**
 * 获取汇率 JSON（兼容 open.er-api 与 frankfurter 格式）
 * Fetch rate JSON; supports open.er-api and frankfurter formats.
 * @param {string} url
 * @returns {Promise<{base:string, rates:Object<string,number>, date:string}>}
 */
async function fetchRates(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  if (j.result && j.result !== 'success') throw new Error(j['error-type'] || '接口返回失败');
  const base = String(j.base_code || j.base || '').toUpperCase();
  if (!base || !j.rates || typeof j.rates !== 'object') throw new Error('接口数据格式无法识别');
  return { base, rates: { ...j.rates, [base]: 1 }, date: j.time_last_update_utc || j.date || '' };
}

/**
 * 更新所有币种对人民币汇率 / Update every currency's rate to CNY.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{user?:string, fallbacks?:string[]}} [opts] 操作人、备用接口（测试可覆盖）/ operator, fallback sources (overridable in tests)
 * @returns {Promise<{source:string, date:string, updated:object[], skipped:object[], unchanged:number}>}
 */
async function updateRates(db, opts = {}) {
  const primary = setting(db, 'rate_api_url', FALLBACKS[0]);
  const maxChange = Number(setting(db, 'rate_max_change', '30')) / 100 || 0.3;
  const sources = [primary, ...(opts.fallbacks || FALLBACKS).filter((u) => u !== primary)];
  const errors = [];
  let data = null;
  let source = '';
  for (const url of sources) {
    try {
      data = await fetchRates(url);
      source = url;
      break;
    } catch (e) {
      errors.push(`${url}：${e.message}`);
    }
  }
  if (!data) throw new Error('所有汇率接口均获取失败：' + errors.join('；'));
  if (!data.rates.CNY) throw new Error('接口未提供人民币(CNY)汇率');
  const user = opts.user || '汇率自动更新';
  const updated = [];
  const skipped = [];
  let unchanged = 0;
  const now = new Date().toLocaleString('sv-SE');
  for (const c of db.prepare('SELECT * FROM currencies').all()) {
    if (c.code === 'CNY') continue;
    const per = data.rates[c.code];
    if (!(per > 0)) { skipped.push({ code: c.code, reason: '接口无此币种' }); continue; }
    // 1 单位外币折合人民币 = CNY汇率 / 外币汇率 / CNY per unit = rates.CNY / rates[code]
    const rate = round(data.rates.CNY / per, c.code === 'JPY' || data.rates.CNY / per < 0.1 ? 6 : 4);
    const old = Number(c.rate) || 0;
    if (old > 0 && Math.abs(rate - old) / old > maxChange) {
      skipped.push({ code: c.code, old, new: rate, reason: `波动超过${Math.round(maxChange * 100)}%，疑似数据异常，未更新` });
      continue;
    }
    if (rate === old) { unchanged++; continue; }
    db.prepare('UPDATE currencies SET rate=?, updated_at=? WHERE code=?').run(rate, now, c.code);
    db.prepare('INSERT INTO rate_history(code,old_rate,new_rate,user_name) VALUES(?,?,?,?)').run(c.code, old, rate, user);
    updated.push({ code: c.code, old, new: rate });
  }
  const setS = (k, v) => db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));
  setS('rate_last_auto', now);
  setS('rate_last_source', source);
  db.prepare("INSERT INTO logs(type,user_name,module,action,target,detail) VALUES('sys',?,'trade','汇率自动更新',?,?)")
    .run(user, source, JSON.stringify({ updated, skipped }));
  return { source, date: data.date, updated, skipped, unchanged, errors };
}

module.exports = { updateRates, fetchRates, FALLBACKS };
