'use strict';

/* ================= state ================= */

const STORAGE_KEY = 'kanban.state.v1';
const PRIORITIES = { none: '无', low: '低', medium: '中', high: '高' };
const ACCENTS = ['#4f6ef7', '#f59e0b', '#8b5cf6', '#06b6d4', '#ec4899', '#ef4444'];
/* 主项标题栏底色：相邻卡片错色（淡色），[常态, 悬停] */
const CARD_TINTS = [
  ['#ecf0fe', '#dfe7fd'],
  ['#fdf2dc', '#fbe8c0'],
  ['#f2ecfe', '#e5d9fd'],
  ['#ddf6f9', '#c2eef4'],
  ['#fde0ee', '#fbc9e0'],
  ['#fddcdc', '#fbc9c9'],
];
const DONE_ACCENT = '#10b981';
const DONE_TITLE = '已完成';
const PAGE_SIZE = 10;

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function defaultState() {
  const c1 = uid(), c2 = uid(), c3 = uid();
  const now = Date.now();
  return {
    columns: [
      { id: c1, title: '待办' },
      { id: c2, title: '进行中' },
      { id: c3, title: '已完成' },
    ],
    tasks: [
      {
        id: uid(), columnId: c1,
        title: '示例：设计看板数据模型',
        description: '点击卡片打开详情，可编辑描述、截止日期、优先级和标签。',
        dueDate: '', priority: 'medium', tags: ['示例'],
        createdAt: now, updatedAt: now,
        subtasks: [
          { id: uid(), title: '定义任务字段', done: true },
          { id: uid(), title: '定义子项结构', done: false },
        ],
      },
      {
        id: uid(), columnId: c2,
        title: '示例：体验拖拽',
        description: '按住 ⠿ 拖动卡片到其它列；子项可以直接拖到别的任务里。',
        dueDate: '', priority: 'high', tags: [],
        createdAt: now, updatedAt: now,
        subtasks: [
          { id: uid(), title: '任务跨列拖动', done: false },
          { id: uid(), title: '子项跨任务拖动', done: false },
        ],
      },
    ],
    assignees: [],
  };
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || !Array.isArray(s.columns) || !Array.isArray(s.tasks)) return null;
    return s;
  } catch {
    return null;
  }
}

let state = null; // assigned in boot()

function apiFetch(path, opts = {}) {
  return fetch(path, Object.assign({ cache: 'no-store' }, opts));
}

let serverMode = false;
let serverUpdatedAt = 0;
let localDirty = false;
let pushTimer = null;
let pushRetryTimer = null;

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    console.error('[kanban] localStorage 写入失败（配额不足？）:', err);
  }
  if (!serverMode) return;
  localDirty = true;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(pushToServer, 400);
}

async function pushToServer() {
  if (!serverMode || !localDirty) return;
  pushTimer = null;
  try {
    const r = await apiFetch('/api/state', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'if-match': String(serverUpdatedAt) },
      body: JSON.stringify(state),
    });
    const data = await r.json();
    if (r.status === 409) {
      if (data && data.state) {
        adoptServerState(data.state, data.updatedAt);
        flashConflict();
      } else {
        schedulePushRetry();
      }
      return;
    }
    if (data && data.ok) {
      serverUpdatedAt = data.updatedAt;
      localDirty = false;
    } else {
      schedulePushRetry();
    }
  } catch {
    schedulePushRetry();
  }
}

function schedulePushRetry() {
  if (pushRetryTimer || !localDirty) return;
  pushRetryTimer = setTimeout(() => {
    pushRetryTimer = null;
    pushToServer();
  }, 5000);
}

/* 采用服务器最新版本（轮询更新 / 冲突 409 共用） */
function adoptServerState(newState, newUpdatedAt) {
  if (!newState) return;
  serverUpdatedAt = newUpdatedAt || 0;
  state = newState;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* 忽略 */ }
  localDirty = false;
  if (openTaskId && !findTask(openTaskId)) {
    openTaskId = null;
    detailEl.classList.remove('open');
    backdropEl.classList.remove('open');
  } else {
    refreshDetailInputs();
  }
  render();
}

async function pollServer() {
  if (!serverMode || localDirty || document.visibilityState !== 'visible') return;
  try {
    const r = await apiFetch('/api/state');
    const data = await r.json();
    if (data && data.updatedAt && data.updatedAt !== serverUpdatedAt) {
      if (data.state) adoptServerState(data.state, data.updatedAt);
      else serverUpdatedAt = data.updatedAt;
    }
  } catch {
    serverMode = false;
    updateConnUI();
  }
}

async function initFromServer() {
  try {
    const r = await apiFetch('/api/state');
    if (!r.ok) throw new Error(String(r.status));
    const data = await r.json();
    if (!data || data.ok === false) throw new Error('bad response');
    serverMode = true;
    serverUpdatedAt = data.updatedAt || 0;
    return data.state || null;
  } catch {
    serverMode = false;
    return null;
  }
}

function updateConnUI() {
  const el = document.getElementById('conn');
  if (!el) return;
  if (serverMode) {
    el.textContent = '已连接服务器';
    el.className = 'conn on';
    el.title = '数据保存在服务器 SQLite，多设备同步';
  } else {
    el.textContent = '本地模式';
    el.className = 'conn off';
    el.title = '未连接服务器（node server.js），数据仅保存在本浏览器';
  }
}

/* 远程更新后刷新详情面板输入框（跳过正在编辑的字段） */
function refreshDetailInputs() {
  if (!openTaskId) return;
  const t = findTask(openTaskId);
  if (!t) return;
  const values = {
    'd-title': t.title,
    'd-desc': t.description || '',
    'd-due': t.dueDate || '',
    'd-priority': t.priority || 'none',
    'd-tags': (t.tags || []).join(', '),
    'd-completion': t.completionNote || '',
  };
  for (const id of Object.keys(values)) {
    const el = document.getElementById(id);
    if (el && document.activeElement !== el) el.value = values[id];
  }
}

let conflictTimer = null;
function flashConflict() {
  let el = document.getElementById('conflict-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'conflict-toast';
    el.className = 'conflict-toast';
    document.body.appendChild(el);
  }
  el.textContent = '同步冲突：服务器有更新，已采用服务器版本，本地未推送的修改被覆盖';
  el.classList.add('show');
  clearTimeout(conflictTimer);
  conflictTimer = setTimeout(() => el.classList.remove('show'), 6000);
}

function findTask(id) { return state.tasks.find(t => t.id === id); }
function tasksInColumn(colId) {
  const tasks = state.tasks.filter(t => t.columnId === colId && !t.discarded);
  const done = state.columns.find(c => c.id === colId)?.title === DONE_TITLE;
  if (done) tasks.sort((a, b) => (b.completedAt || b.updatedAt) - (a.completedAt || a.updatedAt)); // 已完成列：最新完成在上
  else tasks.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)); // 其他列：新任务在下面
  return tasks;
}
function progressOf(t) {
  return { total: t.subtasks.length, done: t.subtasks.filter(s => s.done).length };
}
function findSubtask(subId) {
  for (const t of state.tasks) {
    const s = t.subtasks.find(x => x.id === subId);
    if (s) return { task: t, sub: s };
  }
  return null;
}
function fmtDate(iso) {
  const p = iso.split('-');
  return p.length === 3 ? `${p[1]}-${p[2]}` : iso;
}
function fmtDateTime(ms) {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ================= dom refs ================= */

const boardEl = document.getElementById('board');
const detailEl = document.getElementById('detail');
const discardedEl = document.getElementById('discarded');
const backdropEl = document.getElementById('backdrop');

let sortables = [];
let openTaskId = null;
let justDragged = false;
const visibleCounts = {}; // columnId -> 已渲染任务数

function markDragged() {
  justDragged = true;
  setTimeout(() => { justDragged = false; }, 80);
}

/* ================= rendering ================= */

function accentFor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return ACCENTS[h % ACCENTS.length];
}

function assigneeAvatar(name) {
  return `<i class="assignee-avatar" style="background:${accentFor(name)}">${esc(name.slice(0, 1))}</i>`;
}

function subMeta(s) {
  const parts = [];
  if (s.createdAt) parts.push(`创建于 ${fmtDateTime(s.createdAt)}`);
  if (s.completedAt) parts.push(`完成于 ${fmtDateTime(s.completedAt)}`);
  return parts.join(' · ');
}

function subHTML(s) {
  const a = s.assignee
    ? `<span class="sub-assignee" title="负责人：${esc(s.assignee)}">${assigneeAvatar(s.assignee)}<span class="sa-name">${esc(s.assignee)}</span></span>`
    : '';
  const meta = subMeta(s);
  return `<li class="subtask-row${s.done ? ' done' : ''}" data-id="${s.id}">
    <label class="subtask-check-wrap">
      <input type="checkbox" class="subtask-check"${s.done ? ' checked' : ''}>
    </label>
    <span class="subtask-title" data-full="${esc(s.title)}"${meta ? ` data-meta="${esc(meta)}"` : ''}>${esc(s.title)}</span>
    ${a}
    <button class="subtask-more" title="分配 / 更多">⋯</button>
    <button class="subtask-del" title="删除子项">×</button>
  </li>`;
}

function cardHTML(t, idx) {
  const p = progressOf(t);
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
  const pri = t.priority !== 'none' ? `<span class="chip chip-${t.priority}">${PRIORITIES[t.priority]}</span>` : '';
  let due = '';
  if (t.dueDate) {
    const overdue = new Date(t.dueDate + 'T23:59:59') < new Date();
    due = `<span class="chip chip-due${overdue ? ' overdue' : ''}">截止 ${fmtDate(t.dueDate)}</span>`;
  }
  const assignee = t.assignee
    ? `<span class="chip chip-assignee" title="负责人：${esc(t.assignee)}">${assigneeAvatar(t.assignee)}${esc(t.assignee)}</span>`
    : '';
  const created = t.createdAt
    ? `<span class="chip chip-created" title="创建于 ${fmtDateTime(t.createdAt)}">创建 ${fmtDate(new Date(t.createdAt).toISOString().slice(0, 10))}</span>`
    : '';
  const completion = (t.completionNote || '').trim()
    ? `<p class="task-completion">${esc(t.completionNote.trim())}</p>`
    : '';
  const tags = (t.tags || []).map(tag => `<span class="chip chip-tag">${esc(tag)}</span>`).join('');
  const tint = CARD_TINTS[idx % CARD_TINTS.length];
  return `<article class="task-card" data-id="${t.id}" tabindex="-1" style="--card-tint:${tint[0]};--card-tint-hover:${tint[1]}">
    <div class="card-top">
      <span class="task-handle" title="拖动移动任务">⠿</span>
      <h3 class="task-title">${esc(t.title)}</h3>
      <button class="card-more" title="分配 / 更多">⋯</button>
    </div>
    ${t.description ? `<p class="task-desc">${esc(t.description)}</p>` : ''}
    ${completion}
    ${pri || due || assignee || created ? `<div class="card-chips">${pri}${due}${assignee}${created}</div>` : ''}
    ${t.subtasks.length ? `<div class="subtask-wrap"><ul class="subtask-list">${t.subtasks.map(subHTML).join('')}</ul></div>` : ''}
    ${p.total ? `<div class="card-progress"><div class="progress-bar"><i style="width:${pct}%"></i></div><span class="progress-text">${p.done}/${p.total}</span></div>` : ''}
    ${tags ? `<div class="card-tags">${tags}</div>` : ''}
    <input class="subtask-add-input" placeholder="＋ 添加子项，回车确认" maxlength="200">
  </article>`;
}

function columnHTML(col, idx) {
  const tasks = tasksInColumn(col.id);
  const done = col.title === DONE_TITLE;
  const accent = done ? DONE_ACCENT : ACCENTS[idx % ACCENTS.length];
  const shown = tasks.slice(0, visibleCounts[col.id] || PAGE_SIZE);
  const hidden = tasks.length - shown.length;
  const head = done
    ? '<span class="col-done-icon">✓</span>'
    : `<span class="col-dot" style="background:${accent}"></span>`;
  const title = done
    ? `<span class="col-title">${esc(col.title)}</span>`
    : `<span class="col-title" title="双击重命名">${esc(col.title)}</span>`;
  const del = done ? '' : '<button class="col-del" title="删除列">×</button>';
  const nav = tasks.length > PAGE_SIZE
    ? `<div class="col-nav-wrap">
        <button class="col-nav" title="快速导航">☰</button>
        <div class="col-nav-panel">
          <ul class="col-nav-list">${tasks.map(t => `<li class="col-nav-item" data-id="${t.id}" data-full="${esc(t.title)}">${esc(t.title)}</li>`).join('')}</ul>
        </div>
       </div>`
    : '';
  return `<section class="column${done ? ' column-done' : ''}" data-id="${col.id}" style="--col-accent:${accent}">
    <header class="col-header">
      ${head}
      ${title}
      <span class="col-count">${tasks.length}</span>
      ${nav}
      ${del}
    </header>
    <input class="task-add-input" placeholder="＋ 添加任务，回车确认" maxlength="200">
    <div class="task-list" data-col="${col.id}">${shown.map((t, i) => cardHTML(t, i)).join('') || '<div class="empty-hint">拖拽任务到这里</div>'}</div>
    ${hidden > 0 ? `<button class="load-more" data-col="${col.id}">还有 ${hidden} 个任务</button>` : ''}
  </section>`;
}

function renderDetailSubtasks() {
  const t = findTask(openTaskId);
  if (!t) return;
  const list = document.getElementById('d-subtask-list');
  list.innerHTML = t.subtasks.map(subHTML).join('') || '<li class="d-empty">暂无子项</li>';
  const p = progressOf(t);
  document.getElementById('d-progress').textContent = `${p.done}/${p.total}`;
  document.getElementById('d-progress-bar').style.width = p.total ? (p.done / p.total) * 100 + '%' : '0%';
  updateScrollFades();
}

function render() {
  destroySortables();
  boardEl.innerHTML = state.columns.map((col, i) => columnHTML(col, i)).join('') +
    '<button class="add-column" id="add-column">＋ 新建列</button>';
  if (openTaskId) renderDetailSubtasks();
  renderDiscarded();
  initSortables();
  updateScrollFades();
}

function updateScrollFades() {
  document.querySelectorAll('.subtask-wrap, .detail-body-wrap').forEach(w => {
    const el = w.firstElementChild;
    if (!el) return;
    const can = el.scrollHeight > el.clientHeight + 1;
    w.classList.toggle('fade-top', can && el.scrollTop > 4);
    w.classList.toggle('fade-bottom', can && el.scrollTop + el.clientHeight < el.scrollHeight - 4);
  });
}

/* ================= drag & drop ================= */

function destroySortables() {
  sortables.forEach(s => s.destroy());
  sortables = [];
}

function initSortables() {
  sortables.push(new Sortable(boardEl, {
    group: 'columns',
    handle: '.col-header',
    draggable: '.column',
    filter: '#add-column, .col-rename-input, .col-nav-wrap',
    animation: 150,
    ghostClass: 'drag-ghost',
    onEnd: onColumnMove,
  }));
  boardEl.querySelectorAll('.task-list').forEach(el => {
    sortables.push(new Sortable(el, {
      group: 'tasks',
      handle: '.task-handle',
      filter: '.empty-hint',
      animation: 150,
      ghostClass: 'drag-ghost',
      onEnd: onTaskMove,
    }));
  });
  boardEl.querySelectorAll('.subtask-list').forEach(el => {
    sortables.push(new Sortable(el, {
      group: 'subtasks',
      animation: 150,
      ghostClass: 'drag-ghost',
      onEnd: onSubtaskMove,
    }));
  });
  if (openTaskId) {
    sortables.push(new Sortable(document.getElementById('d-subtask-list'), {
      group: 'subtasks',
      filter: '.d-empty',
      animation: 150,
      ghostClass: 'drag-ghost',
      onEnd: onSubtaskMove,
    }));
  }
}

function onTaskMove(evt) {
  const task = findTask(evt.item.dataset.id);
  const colEl = evt.to.closest('.column');
  if (!task || !colEl) return;
  const colId = colEl.dataset.id;
  task.columnId = colId;
  task.updatedAt = Date.now();
  const isDone = state.columns.find(c => c.id === colId)?.title === DONE_TITLE;
  if (isDone) task.completedAt = Date.now();
  else delete task.completedAt;
  const order = [...evt.to.querySelectorAll('.task-card')].map(el => el.dataset.id);
  const rendered = order.map(findTask).filter(Boolean);
  const hidden = state.tasks.filter(t => t.columnId === colId && !order.includes(t.id));
  const others = state.tasks.filter(t => t.columnId !== colId);
  state.tasks = [...others, ...rendered, ...hidden];
  visibleCounts[colId] = Math.max(visibleCounts[colId] || PAGE_SIZE, order.length);
  markDragged();
  save();
  render();
}

function onColumnMove() {
  const order = [...boardEl.querySelectorAll('.column')].map(el => el.dataset.id);
  const cols = order.map(id => state.columns.find(c => c.id === id)).filter(Boolean);
  if (cols.length !== state.columns.length) return;
  state.columns = cols;
  markDragged();
  save();
  render();
}

function loadMoreTasks(colId) {
  const tasks = tasksInColumn(colId);
  const prev = visibleCounts[colId] || PAGE_SIZE;
  const next = Math.min(prev + PAGE_SIZE, tasks.length);
  if (next <= prev) return;
  visibleCounts[colId] = next;
  const listEl = boardEl.querySelector(`.task-list[data-col="${colId}"]`);
  if (!listEl) return;
  const frag = document.createElement('div');
  frag.innerHTML = tasks.slice(prev, next).map((t, i) => cardHTML(t, prev + i)).join('');
  [...frag.children].forEach(el => listEl.appendChild(el));
  const btn = boardEl.querySelector(`.load-more[data-col="${colId}"]`);
  const hidden = tasks.length - next;
  if (btn) {
    if (hidden > 0) btn.textContent = `还有 ${hidden} 个任务`;
    else btn.remove();
  }
}

function flashCard(cardEl) {
  cardEl.classList.add('flash');
  setTimeout(() => cardEl.classList.remove('flash'), 900);
}

/* 快速导航：滚动到指定主项并高亮；未渲染则先加载 */
function jumpToTask(colId, taskId) {
  const tasks = tasksInColumn(colId);
  const idx = tasks.findIndex(t => t.id === taskId);
  if (idx < 0) return;
  const prev = visibleCounts[colId] || PAGE_SIZE;
  if (idx >= prev) {
    visibleCounts[colId] = Math.min(idx + 1, tasks.length);
    render();
  }
  const card = boardEl.querySelector(`.task-card[data-id="${taskId}"]`);
  if (!card) return;
  const list = boardEl.querySelector(`.task-list[data-col="${colId}"]`);
  void list?.offsetHeight; // 强制重排，确保新渲染的卡片已布局
  card.scrollIntoView({ behavior: 'auto', block: 'center' });
  flashCard(card);
}

function onSubtaskMove(evt) {
  const subId = evt.item.dataset.id;
  const card = evt.to.closest('.task-card');
  const targetTaskId = card ? card.dataset.id : (evt.to.id === 'd-subtask-list' ? openTaskId : null);
  const targetTask = targetTaskId ? findTask(targetTaskId) : null;
  if (!targetTask) return;
  const found = findSubtask(subId);
  if (!found) return;
  found.task.subtasks = found.task.subtasks.filter(s => s.id !== subId);
  const order = [...evt.to.querySelectorAll('.subtask-row')].map(el => el.dataset.id);
  const rest = targetTask.subtasks;
  targetTask.subtasks = order
    .map(sid => (sid === subId ? found.sub : rest.find(s => s.id === sid)))
    .filter(Boolean);
  targetTask.updatedAt = Date.now();
  markDragged();
  save();
  render();
}

/* ================= mutations ================= */

function addTask(colId, title) {
  const now = Date.now();
  const t = {
    id: uid(), columnId: colId, title,
    description: '', dueDate: '', priority: 'none', tags: [],
    assignee: '', completionNote: '',
    createdAt: now, updatedAt: now, subtasks: [],
  };
  const colTasks = state.tasks.filter(x => x.columnId === colId);
  state.tasks = [...state.tasks.filter(x => x.columnId !== colId), t, ...colTasks];
  save();
  // 新任务排在列底部，确保它被渲染（必要时加载整列）
  const total = tasksInColumn(colId).length;
  visibleCounts[colId] = Math.max(visibleCounts[colId] || PAGE_SIZE, total);
  render();
  const card = boardEl.querySelector(`.task-card[data-id="${t.id}"]`);
  if (card) {
    card.scrollIntoView({ behavior: 'auto', block: 'center' });
    flashCard(card);
    card.focus({ preventScroll: true });
  }
}

function addSubtask(taskId, title) {
  const t = findTask(taskId);
  if (!t) return;
  const sub = { id: uid(), title, done: false, assignee: '', createdAt: Date.now() };
  const firstDone = t.subtasks.findIndex(s => s.done);
  if (firstDone >= 0) t.subtasks.splice(firstDone, 0, sub); // 新子项上浮到已完成子项之上
  else t.subtasks.push(sub);
  t.updatedAt = Date.now();
  save();
  render();
  document.querySelectorAll(`.subtask-row[data-id="${sub.id}"]`).forEach(row => {
    row.scrollIntoView({ behavior: 'auto', block: 'nearest' });
  });
}

function toggleSubtask(subId, done) {
  const f = findSubtask(subId);
  if (!f) return;
  f.sub.done = done;
  if (done) f.sub.completedAt = Date.now();
  else delete f.sub.completedAt;
  const arr = f.task.subtasks;
  const i = arr.indexOf(f.sub);
  if (i >= 0) {
    const s = arr.splice(i, 1)[0];
    if (done) arr.push(s);
    else arr.unshift(s);
  }
  f.task.updatedAt = Date.now();
  save();
  render();
}

function deleteSubtask(subId) {
  const f = findSubtask(subId);
  if (!f) return;
  f.task.subtasks = f.task.subtasks.filter(s => s.id !== subId);
  f.task.updatedAt = Date.now();
  save();
  render();
}

function deleteTask(taskId) {
  const t = findTask(taskId);
  if (!t) return;
  if (!confirm(`删除任务「${t.title}」及其子项？`)) return;
  state.tasks = state.tasks.filter(x => x.id !== taskId);
  if (openTaskId === taskId) closeDetail();
  save();
  render();
}

function deleteColumn(colId) {
  const col = state.columns.find(c => c.id === colId);
  if (!col || col.title === DONE_TITLE) return;
  const n = tasksInColumn(colId).length;
  if (n > 0) { alert(`「${col.title}」还有 ${n} 个任务，请先移走。`); return; }
  if (!confirm(`删除列「${col.title}」？`)) return;
  state.columns = state.columns.filter(c => c.id !== colId);
  save();
  render();
}

function discardTask(taskId) {
  const t = findTask(taskId);
  if (!t) return;
  t.discarded = true;
  t.discardedAt = Date.now();
  t.updatedAt = t.discardedAt;
  if (openTaskId === taskId) closeDetail();
  save();
  render();
}

function restoreTask(taskId) {
  const t = findTask(taskId);
  if (!t) return;
  t.discarded = false;
  delete t.discardedAt;
  if (!state.columns.find(c => c.id === t.columnId) && state.columns[0]) t.columnId = state.columns[0].id;
  if (state.columns.find(c => c.id === t.columnId)?.title === DONE_TITLE && !t.completedAt) t.completedAt = Date.now();
  t.updatedAt = Date.now();
  visibleCounts[t.columnId] = Math.max(visibleCounts[t.columnId] || PAGE_SIZE, tasksInColumn(t.columnId).length);
  save();
  render();
}

function purgeTask(taskId) {
  const t = findTask(taskId);
  if (!t) return;
  if (!confirm(`彻底删除任务「${t.title}」及其子项？此操作不可撤销。`)) return;
  state.tasks = state.tasks.filter(x => x.id !== taskId);
  save();
  render();
}

function renderDiscarded() {
  const list = document.getElementById('disc-list');
  const count = document.getElementById('disc-count');
  const items = state.tasks.filter(t => t.discarded);
  count.textContent = items.length;
  if (!items.length) {
    list.innerHTML = '<p class="disc-empty">暂无废弃任务</p>';
    return;
  }
  list.innerHTML = items.map(t => {
    const col = state.columns.find(c => c.id === t.columnId);
    const when = new Date(t.discardedAt || t.updatedAt).toLocaleDateString('zh-CN');
    return `<div class="disc-item">
      <div class="disc-item-top">
        <span class="disc-title">${esc(t.title)}</span>
        <span class="disc-meta">原在「${col ? esc(col.title) : '—'}」 · 废弃于 ${when}</span>
      </div>
      <div class="disc-item-actions">
        <button class="btn small" data-act="restore" data-id="${t.id}">恢复</button>
        <button class="btn small danger" data-act="purge" data-id="${t.id}">彻底删除</button>
      </div>
    </div>`;
  }).join('');
}

function syncBackdrop() {
  const anyOpen = detailEl.classList.contains('open') || discardedEl.classList.contains('open');
  backdropEl.classList.toggle('open', anyOpen);
}

function closeDiscarded() {
  discardedEl.classList.remove('open');
  syncBackdrop();
}

/* ================= detail panel ================= */

function openDetail(taskId) {
  const t = findTask(taskId);
  if (!t) return;
  openTaskId = taskId;
  document.getElementById('d-title').value = t.title;
  const createdEl = document.getElementById('d-created');
  if (t.createdAt) {
    createdEl.textContent = `创建于 ${fmtDateTime(t.createdAt)}`;
    createdEl.style.display = '';
  } else {
    createdEl.style.display = 'none';
  }
  document.getElementById('d-desc').value = t.description || '';
  document.getElementById('d-due').value = t.dueDate || '';
  document.getElementById('d-priority').value = t.priority || 'none';
  document.getElementById('d-tags').value = (t.tags || []).join(', ');
  document.getElementById('d-completion').value = t.completionNote || '';
  renderDetailSubtasks();
  discardedEl.classList.remove('open');
  detailEl.classList.add('open');
  syncBackdrop();
  updateScrollFades();
}

function closeDetail() {
  openTaskId = null;
  detailEl.classList.remove('open');
  syncBackdrop();
  destroySortables();
  initSortables();
}

/* ================= 长文本悬浮全量展示（tooltip） ================= */

const tipEl = document.createElement('div');
tipEl.className = 'text-tip';
document.body.appendChild(tipEl);

function showTip(el) {
  const full = el.dataset.full || el.textContent;
  const meta = el.dataset.meta || '';
  if (el.scrollWidth <= el.clientWidth + 1 && !meta) return; // 未截断且无时间信息
  tipEl.innerHTML = `<div class="tip-title">${esc(full)}</div>${meta ? `<div class="tip-meta">${esc(meta)}</div>` : ''}`;
  tipEl.classList.add('show');
  const r = el.getBoundingClientRect();
  const tw = tipEl.offsetWidth, th = tipEl.offsetHeight;
  const left = Math.max(8, Math.min(r.left, window.innerWidth - tw - 8));
  let top = r.bottom + 6;
  if (top + th > window.innerHeight - 8) top = Math.max(8, r.top - th - 6);
  tipEl.style.left = left + 'px';
  tipEl.style.top = top + 'px';
}

function hideTip() {
  tipEl.classList.remove('show');
}

document.addEventListener('mouseover', e => {
  const el = e.target.closest('.subtask-title, .col-nav-item');
  if (el) showTip(el);
});
document.addEventListener('mouseout', e => {
  const el = e.target.closest('.subtask-title, .col-nav-item');
  if (el && !(e.relatedTarget && el.contains(e.relatedTarget))) hideTip();
});
document.addEventListener('mousedown', hideTip);
document.addEventListener('scroll', hideTip, true);

/* ================= 分配到人：右键 / ⋯ 菜单 ================= */

const ctxMenu = document.createElement('div');
ctxMenu.className = 'ctx-menu';
document.body.appendChild(ctxMenu);

let ctxTarget = null; // { kind: 'task' | 'sub', id, item, task }
let ctxPos = { x: 0, y: 0 };
let ctxSuggest = null; // { all: string[], matched: string[], active: number }

/* 记住用过的姓名（state.assignees 历史 + 当前仍在用的人），清空分配后依然可推荐 */
function knownAssignees() {
  const names = new Set(Array.isArray(state.assignees) ? state.assignees : []);
  for (const t of state.tasks) {
    if (t.assignee) names.add(t.assignee);
    for (const s of t.subtasks) if (s.assignee) names.add(s.assignee);
  }
  return [...names].sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

function rememberAssignee(name) {
  if (!name) return;
  if (!Array.isArray(state.assignees)) state.assignees = [];
  if (!state.assignees.includes(name)) state.assignees.push(name);
}

function getAssignTarget(kind, id) {
  if (kind === 'task') {
    const t = findTask(id);
    return t ? { kind, id, item: t, task: t } : null;
  }
  const f = findSubtask(id);
  return f ? { kind, id, item: f.sub, task: f.task } : null;
}

function positionFixed(el, x, y) {
  const w = el.offsetWidth, h = el.offsetHeight;
  let left = x, top = y;
  if (left + w > window.innerWidth - 8) left = Math.max(8, window.innerWidth - w - 8);
  if (top + h > window.innerHeight - 8) top = Math.max(8, window.innerHeight - h - 8);
  el.style.left = left + 'px';
  el.style.top = top + 'px';
}

function closeAssignMenu() {
  ctxTarget = null;
  ctxSuggest = null;
  ctxMenu.classList.remove('open');
}

function showAssignMenu(x, y, target) {
  ctxTarget = target;
  ctxPos = { x, y };
  const name = target.item.assignee;
  ctxMenu.innerHTML = `
    <button class="ctx-item" data-act="assign">分配给…</button>
    ${name ? `<button class="ctx-item danger" data-act="clear">取消分配（${esc(name)}）</button>` : ''}`;
  ctxMenu.classList.add('open');
  positionFixed(ctxMenu, x, y);
}

function showAssignInput() {
  const target = ctxTarget;
  if (!target) return;
  ctxMenu.innerHTML = `
    <div class="ctx-label">分配给（留空即清除）</div>
    <input id="ctx-assign-input" class="ctx-input" placeholder="输入姓名，回车确认" maxlength="30" value="${esc(target.item.assignee || '')}">
    <div class="ctx-suggest-list" id="ctx-suggest-list"></div>
  `;
  ctxMenu.classList.add('open');
  ctxSuggest = { all: knownAssignees(), matched: [], active: -1 };
  renderSuggestList();
  positionFixed(ctxMenu, ctxPos.x, ctxPos.y);
  const input = ctxMenu.querySelector('#ctx-assign-input');
  input.focus();
  input.select();
  input.addEventListener('input', () => {
    if (!ctxSuggest) return;
    ctxSuggest.active = -1;
    renderSuggestList();
    positionFixed(ctxMenu, ctxPos.x, ctxPos.y);
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (ctxSuggest && ctxSuggest.active >= 0) applyAssignee(ctxSuggest.matched[ctxSuggest.active]);
      else applyAssignee(input.value);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!ctxSuggest || !ctxSuggest.matched.length) return;
      e.preventDefault();
      const n = ctxSuggest.matched.length;
      ctxSuggest.active = e.key === 'ArrowDown'
        ? (ctxSuggest.active + 1) % n
        : (ctxSuggest.active - 1 + n) % n;
      paintSuggestActive();
    }
  });
}

/* 按输入内容过滤建议（子串匹配，忽略大小写）；空输入显示全部记住的姓名 */
function renderSuggestList() {
  if (!ctxSuggest) return;
  const listEl = ctxMenu.querySelector('#ctx-suggest-list');
  const input = ctxMenu.querySelector('#ctx-assign-input');
  if (!listEl || !input) return;
  const q = input.value.trim().toLowerCase();
  ctxSuggest.matched = (q ? ctxSuggest.all.filter(n => n.toLowerCase().includes(q)) : ctxSuggest.all).slice(0, 12);
  if (!ctxSuggest.matched.length) {
    listEl.classList.remove('show');
    listEl.innerHTML = '';
    return;
  }
  listEl.classList.add('show');
  listEl.innerHTML = ctxSuggest.matched.map((n, i) =>
    `<button class="ctx-suggest-item${i === ctxSuggest.active ? ' active' : ''}" data-name="${esc(n)}">${esc(n)}</button>`
  ).join('');
}

function paintSuggestActive() {
  if (!ctxSuggest) return;
  const items = [...ctxMenu.querySelectorAll('.ctx-suggest-item')];
  items.forEach((el, i) => el.classList.toggle('active', i === ctxSuggest.active));
  const act = items[ctxSuggest.active];
  if (act) act.scrollIntoView({ block: 'nearest' });
}

function applyAssignee(name) {
  if (!ctxTarget) return;
  const v = String(name || '').trim().slice(0, 30);
  ctxTarget.item.assignee = v;
  if (v) rememberAssignee(v);
  ctxTarget.task.updatedAt = Date.now();
  closeAssignMenu();
  save();
  render();
}

ctxMenu.addEventListener('click', e => {
  const item = e.target.closest('.ctx-item');
  if (item) {
    if (!ctxTarget) return;
    if (item.dataset.act === 'assign') showAssignInput();
    else if (item.dataset.act === 'clear') applyAssignee('');
    return;
  }
  const sug = e.target.closest('.ctx-suggest-item');
  if (sug) applyAssignee(sug.dataset.name);
});

document.addEventListener('click', e => {
  if (justDragged) return;
  const cardMore = e.target.closest('.card-more');
  if (cardMore) {
    const r = cardMore.getBoundingClientRect();
    const target = getAssignTarget('task', cardMore.closest('.task-card').dataset.id);
    if (target) showAssignMenu(r.left, r.bottom + 4, target);
    return;
  }
  const subMore = e.target.closest('.subtask-more');
  if (subMore) {
    const r = subMore.getBoundingClientRect();
    const target = getAssignTarget('sub', subMore.closest('.subtask-row').dataset.id);
    if (target) showAssignMenu(r.left, r.bottom + 4, target);
  }
});

document.addEventListener('contextmenu', e => {
  if (e.target.closest('input, textarea, select')) return;
  const row = e.target.closest('.subtask-row');
  const card = row ? null : e.target.closest('.task-card');
  const target = row
    ? getAssignTarget('sub', row.dataset.id)
    : (card ? getAssignTarget('task', card.dataset.id) : null);
  if (!target) return;
  e.preventDefault();
  showAssignMenu(e.clientX, e.clientY, target);
});

document.addEventListener('mousedown', e => {
  if (ctxMenu.classList.contains('open') && !ctxMenu.contains(e.target)) closeAssignMenu();
});
document.addEventListener('scroll', () => {
  if (ctxMenu.classList.contains('open')) closeAssignMenu();
}, true);

/* ================= events: board ================= */

boardEl.addEventListener('click', e => {
  if (justDragged) return;
  if (e.target.id === 'add-column') {
    const title = prompt('列名称', '新列');
    if (title && title.trim()) {
      state.columns.push({ id: uid(), title: title.trim() });
      save();
      render();
    }
    return;
  }
  const navItem = e.target.closest('.col-nav-item');
  if (navItem) {
    jumpToTask(navItem.closest('.column').dataset.id, navItem.dataset.id);
    return;
  }
  const colDel = e.target.closest('.col-del');
  if (colDel) {
    deleteColumn(colDel.closest('.column').dataset.id);
    return;
  }
  const more = e.target.closest('.load-more');
  if (more) {
    loadMoreTasks(more.dataset.col);
    return;
  }
  const del = e.target.closest('.subtask-del');
  if (del) {
    deleteSubtask(del.closest('.subtask-row').dataset.id);
    return;
  }
  const card = e.target.closest('.task-card');
  if (card && !e.target.closest('input, button, .task-handle')) {
    openDetail(card.dataset.id);
  }
});

boardEl.addEventListener('change', e => {
  if (e.target.classList.contains('subtask-check')) {
    toggleSubtask(e.target.closest('.subtask-row').dataset.id, e.target.checked);
  }
});

boardEl.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  if (e.target.classList.contains('task-add-input')) {
    const v = e.target.value.trim();
    if (v) addTask(e.target.closest('.column').dataset.id, v);
  } else if (e.target.classList.contains('subtask-add-input')) {
    const v = e.target.value.trim();
    if (v) {
      const cardId = e.target.closest('.task-card').dataset.id;
      addSubtask(cardId, v);
      const card = boardEl.querySelector(`.task-card[data-id="${cardId}"]`);
      const input = card && card.querySelector('.subtask-add-input');
      if (input) input.focus();
    }
  }
});

boardEl.addEventListener('dblclick', e => {
  const titleEl = e.target.closest('.col-title');
  if (!titleEl) return;
  const colEl = titleEl.closest('.column');
  const col = state.columns.find(c => c.id === colEl.dataset.id);
  if (!col || col.title === DONE_TITLE) return;
  const input = document.createElement('input');
  input.className = 'col-rename-input';
  input.value = col.title;
  input.maxLength = 50;
  titleEl.replaceWith(input);
  input.focus();
  input.select();
  let settled = false;
  const commit = () => {
    if (settled) return;
    settled = true;
    const v = input.value.trim();
    if (v) col.title = v;
    save();
    render();
  };
  input.addEventListener('keydown', ev => {
    if (ev.key === 'Enter') commit();
    else if (ev.key === 'Escape') { settled = true; render(); }
  });
  input.addEventListener('blur', commit);
});

boardEl.addEventListener('scroll', e => {
  updateScrollFades();
  const t = e.target;
  if (!t.classList || !t.classList.contains('task-list')) return;
  if (t.scrollTop + t.clientHeight >= t.scrollHeight - 60) loadMoreTasks(t.dataset.col);
}, true);
document.addEventListener('scroll', updateScrollFades, true);

/* ================= events: detail panel ================= */

document.getElementById('d-close').addEventListener('click', closeDetail);
backdropEl.addEventListener('click', () => {
  if (discardedEl.classList.contains('open')) closeDiscarded();
  else closeDetail();
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (ctxMenu.classList.contains('open')) { closeAssignMenu(); return; }
  if (discardedEl.classList.contains('open')) closeDiscarded();
  else if (openTaskId) closeDetail();
});

document.getElementById('d-title').addEventListener('input', e => {
  const t = findTask(openTaskId);
  if (!t) return;
  t.title = e.target.value;
  t.updatedAt = Date.now();
  save();
  const card = boardEl.querySelector(`.task-card[data-id="${openTaskId}"]`);
  if (card) {
    const el = card.querySelector('.task-title');
    if (el) el.textContent = t.title;
  }
});

document.getElementById('d-desc').addEventListener('input', e => {
  const t = findTask(openTaskId);
  if (!t) return;
  t.description = e.target.value;
  save();
  const card = boardEl.querySelector(`.task-card[data-id="${openTaskId}"]`);
  if (card) {
    const val = t.description.trim();
    let el = card.querySelector('.task-desc');
    if (val) {
      if (!el) {
        el = document.createElement('p');
        el.className = 'task-desc';
        card.querySelector('.card-top').after(el);
      }
      el.textContent = val;
    } else if (el) {
      el.remove();
    }
  }
  updateScrollFades();
});

document.getElementById('d-due').addEventListener('change', e => {
  const t = findTask(openTaskId);
  if (!t) return;
  t.dueDate = e.target.value;
  t.updatedAt = Date.now();
  save();
  render();
});

document.getElementById('d-priority').addEventListener('change', e => {
  const t = findTask(openTaskId);
  if (!t) return;
  t.priority = e.target.value;
  t.updatedAt = Date.now();
  save();
  render();
});

document.getElementById('d-tags').addEventListener('change', e => {
  const t = findTask(openTaskId);
  if (!t) return;
  t.tags = e.target.value.split(/[,，]/).map(s => s.trim()).filter(Boolean);
  t.updatedAt = Date.now();
  save();
  render();
});

document.getElementById('d-completion').addEventListener('input', e => {
  const t = findTask(openTaskId);
  if (!t) return;
  t.completionNote = e.target.value;
  t.updatedAt = Date.now();
  save();
  const card = boardEl.querySelector(`.task-card[data-id="${openTaskId}"]`);
  if (card) {
    const val = t.completionNote.trim();
    let el = card.querySelector('.task-completion');
    if (val) {
      if (!el) {
        el = document.createElement('p');
        el.className = 'task-completion';
        (card.querySelector('.task-desc') || card.querySelector('.card-top')).after(el);
      }
      el.textContent = val;
    } else if (el) {
      el.remove();
    }
  }
  updateScrollFades();
});

document.getElementById('d-subtask-add').addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  const v = e.target.value.trim();
  if (v) {
    addSubtask(openTaskId, v);
    e.target.value = '';
  }
});

const dList = document.getElementById('d-subtask-list');
dList.addEventListener('change', e => {
  if (e.target.classList.contains('subtask-check')) {
    toggleSubtask(e.target.closest('.subtask-row').dataset.id, e.target.checked);
  }
});
dList.addEventListener('click', e => {
  if (justDragged) return;
  const del = e.target.closest('.subtask-del');
  if (del) deleteSubtask(del.closest('.subtask-row').dataset.id);
});

document.getElementById('d-delete').addEventListener('click', () => deleteTask(openTaskId));
document.getElementById('d-discard').addEventListener('click', () => discardTask(openTaskId));

document.getElementById('discarded-btn').addEventListener('click', () => {
  if (openTaskId) closeDetail();
  renderDiscarded();
  discardedEl.classList.add('open');
  syncBackdrop();
});
document.getElementById('disc-close').addEventListener('click', closeDiscarded);
document.getElementById('disc-list').addEventListener('click', e => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  if (btn.dataset.act === 'restore') restoreTask(btn.dataset.id);
  else purgeTask(btn.dataset.id);
});

/* ================= export / import ================= */

document.getElementById('export-btn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `kanban-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

const IMPORT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/* 校验并规范化导入的备份；不合格返回 null（防 XSS / 防坏数据） */
function normalizeImportedState(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
  if (!Array.isArray(s.columns) || !Array.isArray(s.tasks)) return null;
  const isId = v => typeof v === 'string' && IMPORT_ID_RE.test(v);
  const colIds = new Set();
  for (const c of s.columns) {
    if (!c || typeof c !== 'object' || !isId(c.id) || typeof c.title !== 'string') return null;
    colIds.add(c.id);
  }
  for (const t of s.tasks) {
    if (!t || typeof t !== 'object' || !isId(t.id) || !isId(t.columnId) || typeof t.title !== 'string') return null;
    if (!colIds.has(t.columnId) || !Array.isArray(t.subtasks)) return null;
    for (const st of t.subtasks) {
      if (!st || typeof st !== 'object' || !isId(st.id) || typeof st.title !== 'string') return null;
    }
  }
  for (const t of s.tasks) {
    t.description = typeof t.description === 'string' ? t.description : '';
    t.dueDate = typeof t.dueDate === 'string' ? t.dueDate : '';
    t.priority = ['none', 'low', 'medium', 'high'].includes(t.priority) ? t.priority : 'none';
    t.assignee = typeof t.assignee === 'string' ? t.assignee : '';
    t.completionNote = typeof t.completionNote === 'string' ? t.completionNote : '';
    t.tags = Array.isArray(t.tags) ? t.tags.filter(x => typeof x === 'string') : [];
    t.createdAt = Number.isFinite(t.createdAt) ? t.createdAt : Date.now();
    t.updatedAt = Number.isFinite(t.updatedAt) ? t.updatedAt : t.createdAt;
    t.completedAt = Number.isFinite(t.completedAt) ? t.completedAt : null;
    t.subtasks = t.subtasks.map(st => ({
      id: st.id, title: st.title, done: !!st.done,
      assignee: typeof st.assignee === 'string' ? st.assignee : '',
      createdAt: Number.isFinite(st.createdAt) ? st.createdAt : null,
      completedAt: Number.isFinite(st.completedAt) ? st.completedAt : null,
    }));
  }
  s.assignees = Array.isArray(s.assignees) ? s.assignees.filter(x => typeof x === 'string') : [];
  return s;
}

const importFile = document.getElementById('import-file');
document.getElementById('import-btn').addEventListener('click', () => importFile.click());
importFile.addEventListener('change', e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const s = normalizeImportedState(JSON.parse(String(reader.result)));
      if (!s) throw new Error('invalid');
      if (!confirm('导入将覆盖当前看板，确定继续？')) return;
      state = s;
      save();
      closeDetail();
      render();
    } catch {
      alert('导入失败：不是有效的看板备份文件。');
    }
  };
  reader.readAsText(f);
});

/* 关页前同步刷写未推送的修改（防抖窗口内的最后一次编辑） */
window.addEventListener('pagehide', () => {
  if (!serverMode || !localDirty) return;
  try {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', '/api/state', false);
    xhr.setRequestHeader('content-type', 'application/json');
    xhr.setRequestHeader('if-match', String(serverUpdatedAt));
    xhr.send(JSON.stringify(state));
    if (xhr.status === 200) {
      const d = JSON.parse(xhr.responseText);
      if (d && d.ok) { serverUpdatedAt = d.updatedAt; localDirty = false; }
    }
  } catch { /* 放弃刷写 */ }
});

/* ================= boot ================= */

async function boot() {
  const serverState = await initFromServer();
  const local = load();
  if (serverMode) {
    state = serverState || local || defaultState();
    if (!serverState) save(); // 首次连接：把本地数据（或默认模板）灌入服务器
  } else {
    state = local || defaultState();
  }
  updateConnUI();
  render();
  setInterval(pollServer, 3000);
}

boot();
