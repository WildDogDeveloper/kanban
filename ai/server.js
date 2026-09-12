'use strict';

/*
 * Kanban AI API 服务器 — 与主服务完全解耦，仅供 agent / CLI / MCP 使用
 *
 * 与主服务共享同一个 kanban.db（WAL 模式并发安全）：
 *   - 本进程崩溃/重启不影响主服务与前端
 *   - 主服务代码零改动
 *
 * 环境变量：
 *   AI_PORT     监听端口，默认 8788
 *   KANBAN_DB   数据库文件路径，默认 ./kanban.db（与主服务相同）
 *
 * 端点（语义与前端操作一致）：
 *   GET    /health                      健康检查
 *   GET    /api/digest                  看板概览（列/任务/进度/逾期/统计）
 *   GET    /api/search?q=               搜索任务与子项
 *   GET    /api/columns                 列列表
 *   POST   /api/columns                 建列 {title}
 *   PATCH  /api/columns/:id             改列名 {title}
 *   DELETE /api/columns/:id             删列（有任务时 409；已完成列 400）
 *   GET    /api/tasks?columnId=         任务完整列表（含子项）
 *   POST   /api/tasks                   建任务 {columnId,title,...}
 *   PATCH  /api/tasks/:id               改任务（传 columnId 即跨列移动）
 *   DELETE /api/tasks/:id?hard=1        删任务（默认废弃可恢复；hard=1 永久）
 *   POST   /api/tasks/:id/restore       恢复废弃任务
 *   POST   /api/tasks/:id/subtasks      加子项 {title,assignee?}
 *   PATCH  /api/subtasks/:id            改子项 {done?,title?,assignee?}
 *   DELETE /api/subtasks/:id            删子项
 */

const http = require('node:http');
const path = require('node:path');

const PORT = Number(process.env.AI_PORT || 8788);
const DB_PATH = process.env.KANBAN_DB || path.join(__dirname, '..', 'kanban.db');
const MAX_BODY = 5 * 1024 * 1024; // 5MB

let Database;
try {
  ({ DatabaseSync: Database } = require('node:sqlite'));
} catch {
  try {
    Database = require('better-sqlite3');
  } catch {
    console.error('[kanban-ai] 缺少 SQLite 驱动：需要 Node >= 22.5（内置 node:sqlite），或执行 npm i better-sqlite3');
    process.exit(1);
  }
}

const db = new Database(DB_PATH);
db.exec('PRAGMA journal_mode=WAL');   // 读写并发：主服务与本服务可安全共存
db.exec('PRAGMA busy_timeout=5000');  // 锁被占用时最多等 5 秒，而不是立即报错
db.exec(`CREATE TABLE IF NOT EXISTS state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
)`);

const stmtGet = db.prepare('SELECT value, updated_at FROM state WHERE key = ?');
const stmtSet = db.prepare(`INSERT INTO state (key, value, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`);

function sendJSON(res, code, obj) {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
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

/* ---------- 资源级 API（语义与前端一致） ---------- */

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const API_DONE_TITLE = '已完成';
const API_PRIORITIES = new Set(['none', 'low', 'medium', 'high']);
const API_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function apiUid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function loadBoard() {
  const row = stmtGet.get('board');
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return undefined; }
}

function apiFindColumn(state, id) { return state.columns.find(c => c.id === id); }
function apiFindTask(state, id) { return state.tasks.find(t => t.id === id); }
function apiFindSubtask(state, id) {
  for (const t of state.tasks) {
    const s = t.subtasks.find(x => x.id === id);
    if (s) return { task: t, sub: s };
  }
  return null;
}

/* 列内任务显示顺序（与前端 tasksInColumn 一致） */
function apiTasksInColumn(state, colId) {
  const tasks = state.tasks.filter(t => t.columnId === colId && !t.discarded);
  const done = state.columns.find(c => c.id === colId)?.title === API_DONE_TITLE;
  if (done) tasks.sort((a, b) => (b.completedAt || b.updatedAt) - (a.completedAt || a.updatedAt));
  else tasks.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  return tasks;
}

/* 读-改-写（同步 SQLite，单进程内原子）；fn(state) 返回附加结果或抛 ApiError */
function apiMutate(fn) {
  const state = loadBoard();
  if (state === undefined) return { code: 500, body: { ok: false, error: 'corrupt state' } };
  if (!state) return { code: 404, body: { ok: false, error: 'board not initialized (open the page once first)' } };
  let result;
  try {
    result = fn(state);
  } catch (err) {
    if (err instanceof ApiError) return { code: err.status, body: { ok: false, error: err.message } };
    throw err;
  }
  if (!validState(state)) return { code: 400, body: { ok: false, error: 'invalid state after mutation' } };
  const now = Date.now();
  stmtSet.run('board', JSON.stringify(state), now);
  return { code: 200, body: { ok: true, updatedAt: now, ...(result || {}) } };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new ApiError(413, 'body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new ApiError(400, 'invalid JSON body')); }
    });
    req.on('error', () => {});
  });
}

function cleanTitle(v, field) {
  if (typeof v !== 'string' || !v.trim()) throw new ApiError(400, `${field} required (non-empty string)`);
  const t = v.trim();
  if (t.length > 100) throw new ApiError(400, `${field} too long (max 100)`);
  return t;
}

/* 任务可选字段（PATCH/POST 共用） */
function applyTaskFields(t, body) {
  if (body.title !== undefined) t.title = cleanTitle(body.title, 'title');
  if (body.description !== undefined) {
    if (typeof body.description !== 'string') throw new ApiError(400, 'description must be string');
    t.description = body.description;
  }
  if (body.priority !== undefined) {
    if (!API_PRIORITIES.has(body.priority)) throw new ApiError(400, 'priority must be one of none|low|medium|high');
    t.priority = body.priority;
  }
  if (body.dueDate !== undefined) {
    if (body.dueDate !== '' && !API_DATE_RE.test(body.dueDate)) throw new ApiError(400, 'dueDate must be YYYY-MM-DD or empty string');
    t.dueDate = body.dueDate;
  }
  if (body.tags !== undefined) {
    if (!Array.isArray(body.tags) || !body.tags.every(x => typeof x === 'string')) throw new ApiError(400, 'tags must be string[]');
    t.tags = body.tags;
  }
  if (body.assignee !== undefined) {
    if (typeof body.assignee !== 'string') throw new ApiError(400, 'assignee must be string');
    t.assignee = body.assignee;
  }
  if (body.completionNote !== undefined) {
    if (typeof body.completionNote !== 'string') throw new ApiError(400, 'completionNote must be string');
    t.completionNote = body.completionNote;
  }
}

function buildDigest(state) {
  const row = stmtGet.get('board');
  const today = new Date().toISOString().slice(0, 10);
  const columns = state.columns.map(col => {
    const tasks = apiTasksInColumn(state, col.id);
    const isDone = col.title === API_DONE_TITLE;
    return {
      id: col.id,
      title: col.title,
      count: tasks.length,
      tasks: tasks.map(t => {
        const total = t.subtasks.length;
        const done = t.subtasks.filter(s => s.done).length;
        return {
          id: t.id,
          title: t.title,
          priority: t.priority || 'none',
          dueDate: t.dueDate || null,
          overdue: !isDone && !!(t.dueDate && t.dueDate < today),
          progress: total ? `${done}/${total}` : null,
          assignee: t.assignee || null,
          tags: t.tags || [],
          completedAt: t.completedAt || null,
        };
      }),
    };
  });
  const active = state.tasks.filter(t => !t.discarded);
  const doneCount = active.filter(t => apiFindColumn(state, t.columnId)?.title === API_DONE_TITLE).length;
  const overdueCount = columns.reduce((n, c) => n + c.tasks.filter(t => t.overdue).length, 0);
  return {
    updatedAt: row ? row.updated_at : 0,
    totals: {
      columns: state.columns.length,
      tasks: active.length,
      done: doneCount,
      overdue: overdueCount,
      discarded: state.tasks.length - active.length,
    },
    columns,
  };
}

function runApiSearch(state, q) {
  const words = q.toLowerCase().split(/\s+/);
  const matchAll = hay => words.every(w => hay.includes(w));
  const results = [];
  for (const col of state.columns) {
    for (const t of apiTasksInColumn(state, col.id)) {
      const hay = [t.title, t.description, t.assignee, ...(t.tags || [])].filter(Boolean).join('\n').toLowerCase();
      if (matchAll(hay)) {
        results.push({ columnId: col.id, column: col.title, taskId: t.id, task: t.title, via: 'task' });
        continue;
      }
      const sub = t.subtasks.find(s => matchAll((s.title || '').toLowerCase()));
      if (sub) results.push({ columnId: col.id, column: col.title, taskId: t.id, task: t.title, subtaskId: sub.id, subtask: sub.title, via: 'subtask' });
    }
  }
  return results;
}

/* ---------- HTTP ---------- */

const API_PATH_RE = /^\/api\/(columns|tasks|subtasks)(?:\/([A-Za-z0-9_-]{1,64})(?:\/(restore|subtasks))?)?$/;

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }

  if (url.pathname === '/health' && req.method === 'GET') {
    return sendJSON(res, 200, { ok: true, service: 'kanban-ai' });
  }

  const apiM = url.pathname.match(API_PATH_RE);
  if (url.pathname === '/api/digest' || url.pathname === '/api/search' || apiM) {
    const state = loadBoard();
    if (state === undefined) return sendJSON(res, 500, { ok: false, error: 'corrupt state' });
    if (!state) return sendJSON(res, 404, { ok: false, error: 'board not initialized (open the page once first)' });

    if (url.pathname === '/api/digest' && req.method === 'GET') {
      return sendJSON(res, 200, { ok: true, digest: buildDigest(state) });
    }
    if (url.pathname === '/api/search' && req.method === 'GET') {
      const q = (url.searchParams.get('q') || '').trim();
      if (!q) return sendJSON(res, 400, { ok: false, error: 'q required' });
      const results = runApiSearch(state, q);
      return sendJSON(res, 200, { ok: true, q, count: results.length, results });
    }

    const [ , kind, id, action ] = apiM;
    const reply = (r) => sendJSON(res, r.code, r.body);
    const withBody = (fn) => readJsonBody(req).then(fn).catch(err => sendJSON(res, err.status || 500, { ok: false, error: err.message }));

    /* ---- columns ---- */
    if (kind === 'columns' && !id) {
      if (req.method === 'GET') {
        const columns = state.columns.map(c => ({
          id: c.id,
          title: c.title,
          count: state.tasks.filter(t => t.columnId === c.id && !t.discarded).length,
        }));
        return sendJSON(res, 200, { ok: true, count: columns.length, columns });
      }
      if (req.method === 'POST') {
        return withBody(body => reply(apiMutate(s => {
          const col = { id: apiUid(), title: cleanTitle(body.title, 'title') };
          s.columns.push(col);
          return { column: col };
        })));
      }
    }
    if (kind === 'columns' && id) {
      if (req.method === 'PATCH') {
        return withBody(body => reply(apiMutate(s => {
          const col = apiFindColumn(s, id);
          if (!col) throw new ApiError(404, 'column not found');
          col.title = cleanTitle(body.title, 'title');
          return { column: col };
        })));
      }
      if (req.method === 'DELETE') {
        return reply(apiMutate(s => {
          const col = apiFindColumn(s, id);
          if (!col) throw new ApiError(404, 'column not found');
          if (col.title === API_DONE_TITLE) throw new ApiError(400, '「已完成」列不可删除');
          const n = s.tasks.filter(t => t.columnId === id && !t.discarded).length;
          if (n > 0) throw new ApiError(409, `该列还有 ${n} 个任务，请先移走`);
          s.columns = s.columns.filter(c => c.id !== id);
          return {};
        }));
      }
    }

    /* ---- tasks ---- */
    if (kind === 'tasks' && !id) {
      if (req.method === 'GET') {
        const colId = url.searchParams.get('columnId');
        if (colId && !apiFindColumn(state, colId)) return sendJSON(res, 400, { ok: false, error: 'columnId not found' });
        const tasks = (colId
          ? apiTasksInColumn(state, colId)
          : state.columns.flatMap(c => apiTasksInColumn(state, c.id))
        ).map(t => ({ ...t, column: apiFindColumn(state, t.columnId)?.title || null }));
        return sendJSON(res, 200, { ok: true, count: tasks.length, tasks });
      }
      if (req.method === 'POST') {
        return withBody(body => reply(apiMutate(s => {
          const col = apiFindColumn(s, body.columnId);
          if (!col) throw new ApiError(400, 'columnId not found');
          const now = Date.now();
          const t = {
            id: apiUid(), columnId: col.id,
            title: cleanTitle(body.title, 'title'),
            description: '', dueDate: '', priority: 'none', tags: [],
            assignee: '', completionNote: '',
            createdAt: now, updatedAt: now, subtasks: [],
          };
          applyTaskFields(t, body);
          s.tasks.push(t);
          return { task: t };
        })));
      }
    }
    if (kind === 'tasks' && id) {
      if (req.method === 'PATCH') {
        return withBody(body => reply(apiMutate(s => {
          const t = apiFindTask(s, id);
          if (!t) throw new ApiError(404, 'task not found');
          applyTaskFields(t, body);
          if (body.columnId !== undefined) {
            const col = apiFindColumn(s, body.columnId);
            if (!col) throw new ApiError(400, 'columnId not found');
            const now = Date.now();
            t.columnId = col.id;
            t.updatedAt = now;
            if (col.title === API_DONE_TITLE) t.completedAt = now;
            else delete t.completedAt;
          } else {
            t.updatedAt = Date.now();
          }
          return { task: t };
        })));
      }
      if (req.method === 'DELETE') {
        const hard = url.searchParams.get('hard') === '1';
        return reply(apiMutate(s => {
          const t = apiFindTask(s, id);
          if (!t) throw new ApiError(404, 'task not found');
          if (hard) {
            s.tasks = s.tasks.filter(x => x.id !== id);
            return { deleted: 'hard' };
          }
          const now = Date.now();
          t.discarded = true;
          t.discardedAt = now;
          t.updatedAt = now;
          return { deleted: 'discarded' };
        }));
      }
      if (action === 'restore' && req.method === 'POST') {
        return reply(apiMutate(s => {
          const t = apiFindTask(s, id);
          if (!t) throw new ApiError(404, 'task not found');
          t.discarded = false;
          delete t.discardedAt;
          if (!apiFindColumn(s, t.columnId) && s.columns[0]) t.columnId = s.columns[0].id;
          if (apiFindColumn(s, t.columnId)?.title === API_DONE_TITLE && !t.completedAt) t.completedAt = Date.now();
          t.updatedAt = Date.now();
          return { task: t };
        }));
      }
      if (action === 'subtasks' && req.method === 'POST') {
        return withBody(body => reply(apiMutate(s => {
          const t = apiFindTask(s, id);
          if (!t) throw new ApiError(404, 'task not found');
          const sub = { id: apiUid(), title: cleanTitle(body.title, 'title'), done: false, assignee: '', createdAt: Date.now() };
          if (typeof body.assignee === 'string' && body.assignee) sub.assignee = body.assignee;
          const firstDone = t.subtasks.findIndex(x => x.done);
          if (firstDone >= 0) t.subtasks.splice(firstDone, 0, sub);
          else t.subtasks.push(sub);
          t.updatedAt = Date.now();
          return { subtask: sub };
        })));
      }
    }

    /* ---- subtasks ---- */
    if (kind === 'subtasks' && id) {
      if (req.method === 'PATCH') {
        return withBody(body => reply(apiMutate(s => {
          const f = apiFindSubtask(s, id);
          if (!f) throw new ApiError(404, 'subtask not found');
          if (body.title !== undefined) f.sub.title = cleanTitle(body.title, 'title');
          if (typeof body.assignee === 'string') f.sub.assignee = body.assignee;
          if (body.done !== undefined) {
            if (typeof body.done !== 'boolean') throw new ApiError(400, 'done must be boolean');
            f.sub.done = body.done;
            if (body.done) f.sub.completedAt = Date.now();
            else delete f.sub.completedAt;
            const arr = f.task.subtasks;
            const i = arr.indexOf(f.sub);
            if (i >= 0) {
              const x = arr.splice(i, 1)[0];
              if (body.done) arr.push(x);
              else arr.unshift(x);
            }
          }
          f.task.updatedAt = Date.now();
          return { subtask: f.sub };
        })));
      }
      if (req.method === 'DELETE') {
        return reply(apiMutate(s => {
          const f = apiFindSubtask(s, id);
          if (!f) throw new ApiError(404, 'subtask not found');
          f.task.subtasks = f.task.subtasks.filter(x => x.id !== id);
          f.task.updatedAt = Date.now();
          return {};
        }));
      }
    }

    return sendJSON(res, 405, { ok: false, error: 'method not allowed' });
  }

  sendJSON(res, 404, { ok: false, error: 'not found' });
});

server.on('error', err => {
  console.error('[kanban-ai] 服务器错误:', err.message);
  if (err.code === 'EADDRINUSE') process.exit(1);
});

process.on('uncaughtException', err => {
  console.error('[kanban-ai] 未捕获异常（进程继续运行）:', err);
});

server.listen(PORT, () => {
  console.log(`[kanban-ai] http://0.0.0.0:${PORT} (db: ${DB_PATH})`);
});
