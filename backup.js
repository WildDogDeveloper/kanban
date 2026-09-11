'use strict';

/*
 * 在线一致性备份：VACUUM INTO（SQLite >= 3.27），比直接 cp 运行中的库安全。
 *
 * 用法：node backup.js <目标文件>
 * 例：  node backup.js /opt/backup/kanban-2026-09-07.db
 * 定时：0 3 * * * node /opt/kanban/backup.js /opt/backup/kanban-$(date +\%F).db
 */

const path = require('node:path');

const src = process.env.KANBAN_DB || path.join(__dirname, 'kanban.db');
const dst = process.argv[2];
if (!dst) {
  console.error('用法: node backup.js <目标文件>');
  process.exit(1);
}

let Database;
try {
  ({ DatabaseSync: Database } = require('node:sqlite'));
} catch {
  Database = require('better-sqlite3');
}

const db = new Database(src);
db.exec(`VACUUM INTO '${dst.replace(/'/g, "''")}'`);
db.close();
console.log(`[backup] ${src} -> ${dst}`);
