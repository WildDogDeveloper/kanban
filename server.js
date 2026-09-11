'use strict';

/*
 * 任务看板服务器 — 零框架 HTTP + SQLite
 *
 * SQLite 驱动：优先 Node >= 22.5 内置 node:sqlite（云端 Docker 推荐 node:24 镜像，零依赖），
 *              回退 better-sqlite3（本地 Node 20：npm i better-sqlite3）。
 *
 * 环境变量：
 *   PORT          监听端口，默认 8787
 *   KANBAN_DB     数据库文件路径，默认 ./kanban.db
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT || 8787);
const DB_PATH = process.env.KANBAN_DB || path.join(__dirname, 'kanban.db');
const MAX_BODY = 5 * 1024 * 1024; // 5MB

let Database;
try {
  ({ DatabaseSync: Database } = require('node:sqlite'));
} catch {
  try {
    Database = require('better-sqlite3');
  } catch {
    console.error('[kanban] 缺少 SQLite 驱动：需要 Node >= 22.5（内置 node:sqlite），或执行 npm i better-sqlite3');
    process.exit(1);
  }
}

const db = new Database(DB_PATH);
db.exec(`CREATE TABLE IF NOT EXISTS state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
)`);

const stmtGet = db.prepare('SELECT value, updated_at FROM state WHERE key = ?');
const stmtSet = db.prepare(`INSERT INTO state (key, value, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

function sendJSON(res, code, obj) {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(JSON.stringify(obj));
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function validState(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return false;
  if (!Array.isArray(s.columns) || !Array.isArray(s.tasks)) return false;
  const isId = v => typeof v === 'string' && ID_RE.test(v);
  const colIds = new Set();
  for (const c of s.columns) {
    if (!c || typeof c !== 'object' || !isId(c.id) || typeof c.title !== 'string') return false;
    colIds.add(c.id);
  }
  for (const t of s.tasks) {
    if (!t || typeof t !== 'object' || !isId(t.id) || !isId(t.columnId) || typeof t.title !== 'string') return false;
    if (!colIds.has(t.columnId) || !Array.isArray(t.subtasks)) return false;
    for (const st of t.subtasks) {
      if (!st || typeof st !== 'object' || !isId(st.id) || typeof st.title !== 'string') return false;
    }
  }
  return true;
}

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,PUT,OPTIONS',
      'access-control-allow-headers': 'content-type,if-match',
    });
    res.end();
    return;
  }

  /* ---------- API ---------- */
  if (url.pathname === '/api/state') {
    if (req.method === 'GET') {
      const row = stmtGet.get('board');
      if (!row) return sendJSON(res, 200, { ok: true, state: null, updatedAt: 0 });
      let state;
      try {
        state = JSON.parse(row.value);
      } catch (err) {
        console.error('[kanban] board 状态损坏（JSON 解析失败），返回 500:', err.message);
        return sendJSON(res, 500, { ok: false, error: 'corrupt state' });
      }
      return sendJSON(res, 200, { ok: true, state, updatedAt: row.updated_at });
    }
    if (req.method === 'PUT') {
      const ifMatch = req.headers['if-match'];
      let chunks = [];
      let size = 0;
      let overflow = false;
      req.on('data', c => {
        if (overflow) return;
        size += c.length;
        if (size > MAX_BODY) {
          overflow = true;
          res.writeHead(413);
          res.end();
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (overflow) return;
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!validState(parsed)) throw new Error('invalid');
          const row = stmtGet.get('board');
          const current = row ? row.updated_at : 0;
          if (ifMatch !== undefined && Number(ifMatch) !== current) {
            let serverState = null;
            if (row) {
              try { serverState = JSON.parse(row.value); } catch { /* 损坏行不附带 */ }
            }
            return sendJSON(res, 409, { ok: false, error: 'conflict', updatedAt: current, state: serverState });
          }
          const now = Date.now();
          stmtSet.run('board', JSON.stringify(parsed), now);
          sendJSON(res, 200, { ok: true, updatedAt: now });
        } catch {
          sendJSON(res, 400, { ok: false, error: 'invalid state' });
        }
      });
      req.on('error', () => {});
      return;
    }
    res.writeHead(405, { allow: 'GET,PUT' });
    res.end();
    return;
  }

  /* ---------- static（白名单：仅 index.html 与 css/ js/ 目录） ---------- */
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    res.end();
    return;
  }

  const rel = path.normalize(url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, ''));
  const allowed = rel === 'index.html'
    || (rel.startsWith('css' + path.sep) && path.extname(rel) === '.css')
    || (rel.startsWith('js' + path.sep) && path.extname(rel) === '.js');
  if (!allowed) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }
  const file = path.resolve(__dirname, rel);
  if (!file.startsWith(__dirname + path.sep)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('forbidden');
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
});

server.on('error', err => {
  console.error('[kanban] 服务器错误:', err.message);
  if (err.code === 'EADDRINUSE') {
    console.error(`[kanban] 端口 ${PORT} 已被占用`);
    process.exit(1);
  }
});

process.on('uncaughtException', err => {
  console.error('[kanban] 未捕获异常（进程继续运行）:', err);
});

server.listen(PORT, () => {
  console.log(`[kanban] http://0.0.0.0:${PORT}`);
  console.log(`[kanban] db: ${DB_PATH}`);
});
