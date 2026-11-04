'use strict';
/**
 * 定时任务：自动收取邮件、自动更新汇率（仅服务器版运行）
 * Scheduled jobs: auto-fetch mail and auto-update exchange rates (server build only).
 * @module server/scheduler
 */
const { updateRates } = require('./rates');
const { fetchAccount } = require('./routes/integrations');

/**
 * 读取参数（数字）/ Read a numeric setting.
 * @param {object} db
 * @param {string} key
 * @returns {number}
 */
const num = (db, key) => Number((db.prepare('SELECT value FROM settings WHERE key=?').get(key) || {}).value) || 0;

/**
 * 执行一次到期任务 / Run all due jobs once.
 * @param {object} db
 * @param {object} config 含 secret / with secret
 * @param {Date} [now]
 * @returns {Promise<{rates?:object, mail:object[]}>}
 */
async function runDueJobs(db, config, now = new Date()) {
  const out = { mail: [] };
  const hours = num(db, 'rate_auto_hours');
  if (hours > 0) {
    const last = (db.prepare("SELECT value FROM settings WHERE key='rate_last_auto'").get() || {}).value;
    if (!last || now - new Date(last.replace(' ', 'T')) >= hours * 3600000) {
      try { out.rates = await updateRates(db, { user: '汇率自动更新' }); } catch (e) { out.rates = { error: e.message }; }
    }
  }
  const minutes = num(db, 'mail_fetch_minutes');
  if (minutes > 0) {
    for (const a of db.prepare('SELECT * FROM mail_accounts WHERE enabled=1 AND auto_fetch=1').all()) {
      if (a.last_fetch_at && now - new Date(a.last_fetch_at.replace(' ', 'T')) < minutes * 60000) continue;
      try { out.mail.push({ email: a.email, ...(await fetchAccount(db, config, a, '自动收信')) }); } catch (e) { out.mail.push({ email: a.email, error: e.message }); }
    }
  }
  return out;
}

/**
 * 启动定时器（每分钟检查一次）/ Start the scheduler (checks every minute).
 * @param {object} db
 * @param {object} config
 * @returns {NodeJS.Timeout}
 */
function startScheduler(db, config) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await runDueJobs(db, config); } catch (e) { console.error('[定时任务]', e.message); } finally { running = false; }
  };
  setTimeout(tick, 5000);
  return setInterval(tick, 60000);
}

module.exports = { startScheduler, runDueJobs };
