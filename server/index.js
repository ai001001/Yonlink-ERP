'use strict';
/**
 * 启动入口 / Server entry point.
 * 用法 / usage: node server/index.js [--port 8080] [--reset] [--reset-only]
 * @module server/index
 */
const path = require('node:path');
const { createApp } = require('./app');

const args = process.argv.slice(2);
const portIdx = args.indexOf('--port');
const port = Number(portIdx >= 0 ? args[portIdx + 1] : process.env.PORT || 8080);
const dbFile = process.env.ERP_DB || path.join(__dirname, '..', 'data', 'erp.db');
const resetOnly = args.includes('--reset-only');

const { server, db } = createApp({ dbFile, reset: args.includes('--reset') || resetOnly });
if (resetOnly) {
  db.close();
  console.log('数据库已重置为演示数据 / Database reset to demo data:', dbFile);
  process.exit(0);
}
server.listen(port, '0.0.0.0', () => {
  console.log(`陶瓷工贸外贸ERP已启动 / ERP running: http://localhost:${port}`);
  console.log(`数据库 / database: ${dbFile}`);
});
