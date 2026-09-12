'use strict';

/*
 * Kanban MCP 服务器 — 零依赖，stdio JSON-RPC（Model Context Protocol）
 *
 * 让任意 MCP 客户端（Claude 等 AI）直接操作看板。
 * 客户端配置示例（mcpServers）：
 *   {
 *     "kanban": {
 *       "command": "node",
 *       "args": ["D:/AI/kanban/mcp/server.js"],
 *       "env": { "KANBAN_URL": "http://108.186.246.232:8787" }
 *     }
 *   }
 *
 * 环境变量：
 *   KANBAN_URL  看板 AI API 地址（ai/server.js），默认 http://127.0.0.1:8788
 */

const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');

const BASE = (process.env.KANBAN_URL || 'http://127.0.0.1:8788').replace(/\/$/, '');

function apiRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE + path);
    const mod = u.protocol === 'https:' ? https : http;
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = mod.request(u, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}),
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = JSON.parse(text); } catch { /* 非 JSON 响应按原文返回 */ }
        resolve({ status: res.statusCode, data: data !== null ? data : text });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function callApi(method, path, body) {
  const { status, data } = await apiRequest(method, path, body);
  if (status >= 400) {
    const msg = data && data.error ? data.error : JSON.stringify(data);
    throw new Error(`HTTP ${status}: ${msg}`);
  }
  return data;
}

/* ---------- 工具定义 ---------- */

const T = (name, description, properties, required = []) => ({
  name,
  description,
  inputSchema: { type: 'object', properties, required },
});

const taskFields = {
  title: { type: 'string', description: '任务标题' },
  description: { type: 'string', description: '描述' },
  priority: { type: 'string', enum: ['none', 'low', 'medium', 'high'], description: '优先级' },
  dueDate: { type: 'string', description: '截止日期 YYYY-MM-DD（空字符串清除）' },
  tags: { type: 'array', items: { type: 'string' }, description: '标签' },
  assignee: { type: 'string', description: '负责人' },
  completionNote: { type: 'string', description: '完成情况备注' },
};

const TOOLS = [
  T('board_digest', '获取看板概览：每列任务（标题/优先级/截止/进度/负责人）与全局统计（总数/已完成/逾期/废弃）。了解看板现状先调这个。', {}),
  T('board_search', '搜索任务（标题/描述/负责人/标签）和子项标题。返回命中任务及命中来源（task|subtask）。', {
    q: { type: 'string', description: '搜索词，多词用空格分隔（全部需命中）' },
  }, ['q']),
  T('list_tasks', '获取任务完整列表（含子项、描述等全部字段），可按列过滤。', {
    columnId: { type: 'string', description: '列 ID（可选，省略=所有列）' },
  }),
  T('create_column', '新建一列。', {
    title: { type: 'string', description: '列名称' },
  }, ['title']),
  T('rename_column', '重命名列。', {
    columnId: { type: 'string', description: '列 ID' },
    title: { type: 'string', description: '新名称' },
  }, ['columnId', 'title']),
  T('delete_column', '删除列。列内有任务时不允许删除；「已完成」列不可删除。', {
    columnId: { type: 'string', description: '列 ID' },
  }, ['columnId']),
  T('create_task', '在指定列新建任务。', {
    columnId: { type: 'string', description: '目标列 ID' },
    ...taskFields,
  }, ['columnId', 'title']),
  T('update_task', '更新任务字段（只传要改的）。传 columnId 即跨列移动：移入「已完成」自动记完成时间，移出自动清除。', {
    taskId: { type: 'string', description: '任务 ID' },
    columnId: { type: 'string', description: '移动到该列（可选）' },
    ...taskFields,
  }, ['taskId']),
  T('delete_task', '删除任务。默认移入「废弃」（可恢复）；hard=true 永久删除（含子项）。', {
    taskId: { type: 'string', description: '任务 ID' },
    hard: { type: 'boolean', description: '永久删除（默认 false=废弃）' },
  }, ['taskId']),
  T('restore_task', '恢复已废弃的任务。', {
    taskId: { type: 'string', description: '任务 ID' },
  }, ['taskId']),
  T('add_subtask', '给任务添加子项。', {
    taskId: { type: 'string', description: '任务 ID' },
    title: { type: 'string', description: '子项标题' },
    assignee: { type: 'string', description: '负责人（可选）' },
  }, ['taskId', 'title']),
  T('update_subtask', '更新子项：done=true 勾选 / false 取消勾选；可改标题、负责人。', {
    subtaskId: { type: 'string', description: '子项 ID' },
    done: { type: 'boolean', description: '勾选状态' },
    title: { type: 'string', description: '子项标题' },
    assignee: { type: 'string', description: '负责人' },
  }, ['subtaskId']),
  T('delete_subtask', '删除子项。', {
    subtaskId: { type: 'string', description: '子项 ID' },
  }, ['subtaskId']),
];

const TOOL_HANDLERS = {
  board_digest: async () => callApi('GET', '/api/digest'),
  board_search: async (a) => callApi('GET', `/api/search?q=${encodeURIComponent(a.q)}`),
  list_tasks: async (a) => callApi('GET', `/api/tasks${a.columnId ? `?columnId=${encodeURIComponent(a.columnId)}` : ''}`),
  create_column: async (a) => callApi('POST', '/api/columns', a),
  rename_column: async (a) => callApi('PATCH', `/api/columns/${encodeURIComponent(a.columnId)}`, { title: a.title }),
  delete_column: async (a) => callApi('DELETE', `/api/columns/${encodeURIComponent(a.columnId)}`),
  create_task: async (a) => callApi('POST', '/api/tasks', a),
  update_task: async (a) => callApi('PATCH', `/api/tasks/${encodeURIComponent(a.taskId)}`, a),
  delete_task: async (a) => callApi('DELETE', `/api/tasks/${encodeURIComponent(a.taskId)}${a.hard ? '?hard=1' : ''}`),
  restore_task: async (a) => callApi('POST', `/api/tasks/${encodeURIComponent(a.taskId)}/restore`),
  add_subtask: async (a) => callApi('POST', `/api/tasks/${encodeURIComponent(a.taskId)}/subtasks`, a),
  update_subtask: async (a) => callApi('PATCH', `/api/subtasks/${encodeURIComponent(a.subtaskId)}`, a),
  delete_subtask: async (a) => callApi('DELETE', `/api/subtasks/${encodeURIComponent(a.subtaskId)}`),
};

/* ---------- JSON-RPC over stdio ---------- */

const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function handle(msg) {
  const { id, method, params } = msg;
  const reply = result => { if (id !== undefined) send({ jsonrpc: '2.0', id, result }); };
  const fail = (code, message) => { if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code, message } }); };

  switch (method) {
    case 'initialize': {
      const want = params && params.protocolVersion;
      reply({
        protocolVersion: SUPPORTED_PROTOCOLS.includes(want) ? want : SUPPORTED_PROTOCOLS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'kanban', version: '1.0.0' },
      });
      return;
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return; // 通知无需响应
    case 'ping':
      reply({});
      return;
    case 'tools/list':
      reply({ tools: TOOLS });
      return;
    case 'tools/call': {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      const handler = TOOL_HANDLERS[name];
      if (!handler) { fail(-32601, `unknown tool: ${name}`); return; }
      pending++;
      handler(args)
        .then(data => reply({
          content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
          isError: false,
        }))
        .catch(err => reply({
          content: [{ type: 'text', text: `错误：${err.message}` }],
          isError: true,
        }))
        .finally(() => { pending--; maybeExit(); });
      return;
    }
    default:
      if (id !== undefined) fail(-32601, `method not found: ${method}`);
  }
}

let buf = '';
let pending = 0;
let stdinEnded = false;
function maybeExit() { if (stdinEnded && pending === 0) process.exit(0); }
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    try {
      handle(msg);
    } catch (err) {
      if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: err.message } });
    }
  }
});
process.stdin.on('end', () => { stdinEnded = true; maybeExit(); });
