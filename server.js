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
 *   KANBAN_USER   登录用户名，默认 admin
 *   KANBAN_PASS   登录密码，默认 admin321
 *   KANBAN_TOKEN  AI 接口（MCP/CLI/REST /ai/）静态 token；不设置时 /ai/ 免鉴权（仅限内网自用）
 *   KANBAN_TZ     逾期判断用的「今天」时区，默认 Asia/Shanghai
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 8787);
const DB_PATH = process.env.KANBAN_DB || path.join(__dirname, 'kanban.db');
const MAX_BODY = 5 * 1024 * 1024; // 5MB

/* ---- 鉴权：登录签发 7 天有效 token（auth_tokens 表）；AI 用静态 token KANBAN_TOKEN ---- */
const AUTH_USER = process.env.KANBAN_USER || 'admin';
const AUTH_PASS = process.env.KANBAN_PASS || 'admin321';
const AI_TOKEN = process.env.KANBAN_TOKEN || '';
const AUTH_TOKEN_TTL = 7 * 24 * 3600 * 1000; // 7 天

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

db.exec(`CREATE TABLE IF NOT EXISTS auth_tokens (
  token TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
)`);
const stmtTokenGet = db.prepare('SELECT expires_at FROM auth_tokens WHERE token = ?');
const stmtTokenDel = db.prepare('DELETE FROM auth_tokens WHERE token = ?');
const stmtTokenAdd = db.prepare('INSERT INTO auth_tokens (token, username, created_at, expires_at) VALUES (?, ?, ?, ?)');
const stmtTokenClean = db.prepare('DELETE FROM auth_tokens WHERE expires_at <= ?');
stmtTokenClean.run(Date.now()); // 启动时清过期

function timingSafeEq(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) {
    crypto.timingSafeEqual(ba, ba); // 长度不等也烧相同时间，避免长度时序差异
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

function extractToken(req) {
  const h = req.headers['authorization'];
  if (typeof h === 'string') {
    const m = /^Bearer\s+(\S+)/i.exec(h);
    if (m) return m[1];
  }
  const t = req.headers['x-kanban-token'];
  return typeof t === 'string' ? t.trim() : '';
}

/* 有效凭证：AI 静态 token（KANBAN_TOKEN）或已登录且未过期的会话 token */
function authOk(req) {
  const token = extractToken(req);
  if (!token) return false;
  if (AI_TOKEN && timingSafeEq(token, AI_TOKEN)) return true;
  const row = stmtTokenGet.get(token);
  return !!row && row.expires_at > Date.now();
}

function send401(res) {
  res.writeHead(401, {
    'content-type': 'application/json; charset=utf-8',
    'www-authenticate': 'Kanban',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
}

function readBodyJSON(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let overflow = false;
    req.on('data', c => {
      if (overflow) return;
      size += c.length;
      if (size > MAX_BODY) {
        overflow = true;
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (overflow) return;
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', () => {});
  });
}

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

/* AI 接口（agent/CLI/MCP）：路由模块见 ai/api.js，复用本服务 DB 连接 */
const aiHandle = require('./ai/api').init({ stmtGet, stmtSet, validState, sendJSON });

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
      'access-control-allow-methods': 'GET,PUT,POST,OPTIONS',
      'access-control-allow-headers': 'content-type,if-match,authorization,x-kanban-token',
    });
    res.end();
    return;
  }

  /* AI 接口（/ai/ 前缀）：/ai/health 公开，其余需 token（AI 静态 token 或登录 token） */
  if (url.pathname.startsWith('/ai/')) {
    const isHealth = url.pathname === '/ai/health' && req.method === 'GET';
    if (!isHealth && !authOk(req)) return send401(res);
    return aiHandle(req, res, url);
  }

  /* ---------- 鉴权 API（登录/登出，公开） ---------- */
  if (url.pathname === '/api/login' && req.method === 'POST') {
    readBodyJSON(req).then(body => {
      const u = body && typeof body.username === 'string' ? body.username : '';
      const p = body && typeof body.password === 'string' ? body.password : '';
      if (!timingSafeEq(u, AUTH_USER) || !timingSafeEq(p, AUTH_PASS)) {
        return sendJSON(res, 401, { ok: false, error: '用户名或密码错误' });
      }
      const now = Date.now();
      const token = crypto.randomBytes(24).toString('hex');
      stmtTokenAdd.run(token, AUTH_USER, now, now + AUTH_TOKEN_TTL);
      return sendJSON(res, 200, { ok: true, user: AUTH_USER, token, expiresAt: now + AUTH_TOKEN_TTL });
    }).catch(() => sendJSON(res, 400, { ok: false, error: 'invalid JSON body' }));
    return;
  }
  if (url.pathname === '/api/logout' && req.method === 'POST') {
    const token = extractToken(req);
    if (token) stmtTokenDel.run(token);
    return sendJSON(res, 200, { ok: true });
  }

  /* ---------- 看板 API（需 token） ---------- */
  if (url.pathname === '/api/state') {
    if (!authOk(req)) return send401(res);
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
process.on('unhandledRejection', err => {
  console.error('[kanban] 未处理的 Promise 拒绝（进程继续运行）:', err);
});

server.listen(PORT, () => {
  console.log(`[kanban] http://0.0.0.0:${PORT}`);
  console.log(`[kanban] db: ${DB_PATH}`);
});
