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
const searchInput = document.getElementById('search');
const searchPanel = document.getElementById('search-panel');
const searchClearBtn = document.getElementById('search-clear');
const searchKbd = document.getElementById('search-kbd');
const aiHelpEl = document.getElementById('ai-help');

let sortables = [];
let openTaskId = null;
let justDragged = false;
const visibleCounts = {}; // columnId -> 已渲染任务数
let mobileActiveColId = null; // 移动端单列视图：当前激活列 ID（无效时回退第一列）
function activeMobileColId() {
  return state.columns.some(c => c.id === mobileActiveColId) ? mobileActiveColId : (state.columns[0] && state.columns[0].id);
}

function markDragged() {
  justDragged = true;
  setTimeout(() => { justDragged = false; }, 80);
}

/* ================= 任务检索 ================= */

let searchResults = []; // [{ t, col }]
let searchActive = -1;

/* 高亮文本中每个词的所有出现位置（忽略大小写） */
function highlightHTML(text, words) {
  if (!words.length) return esc(text);
  const lower = String(text).toLowerCase();
  const ranges = [];
  for (const w of words) {
    let i = lower.indexOf(w);
    while (i !== -1) {
      ranges.push([i, i + w.length]);
      i = lower.indexOf(w, i + w.length);
    }
  }
  if (!ranges.length) return esc(text);
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  let out = '';
  let pos = 0;
  for (const [s, e] of merged) {
    out += esc(text.slice(pos, s)) + '<mark>' + esc(text.slice(s, e)) + '</mark>';
    pos = e;
  }
  return out + esc(text.slice(pos));
}

function runSearch() {
  const q = searchInput.value.trim().toLowerCase();
  if (!q) { closeSearchPanel(); return; }
  const words = q.split(/\s+/);
  const matchAll = (hay) => words.every(w => hay.includes(w));
  searchResults = [];
  for (const col of state.columns) {
    for (const t of tasksInColumn(col.id)) {
      const hay = [t.title, t.description, t.assignee, ...(t.tags || [])].filter(Boolean).join('\n').toLowerCase();
      if (matchAll(hay)) { searchResults.push({ t, col, sub: null }); continue; }
      const sub = t.subtasks.find(s => matchAll((s.title || '').toLowerCase()));
      if (sub) searchResults.push({ t, col, sub });
    }
  }
  searchActive = searchResults.length ? 0 : -1;
  renderSearchPanel();
}

function renderSearchPanel() {
  const q = searchInput.value.trim();
  if (!q) { searchPanel.hidden = true; return; }
  const words = q.toLowerCase().split(/\s+/);
  const shown = searchResults.slice(0, 100);
  const rows = shown.map((r, i) => {
    const accent = r.col.title === DONE_TITLE ? DONE_ACCENT : ACCENTS[state.columns.indexOf(r.col) % ACCENTS.length];
    const badge = r.sub ? '<span class="search-sub-badge">子项</span>' : '';
    const title = r.sub ? r.sub.title : r.t.title;
    return `<li class="search-item${i === searchActive ? ' active' : ''}" data-col="${r.col.id}" data-id="${r.t.id}">
      <span class="search-col" style="color:${accent}">${esc(r.col.title)}</span>
      ${badge}
      <span class="search-title">${highlightHTML(title, words)}</span>
    </li>`;
  }).join('');
  searchPanel.innerHTML =
    `<div class="search-count">${searchResults.length} 个结果${searchResults.length > shown.length ? `（显示前 ${shown.length} 个）` : ''}</div>` +
    (rows || '<div class="search-empty">没有匹配的任务或子项</div>');
  searchPanel.hidden = false;
}

function closeSearchPanel() {
  searchPanel.hidden = true;
  searchResults = [];
  searchActive = -1;
}

function syncSearchClearBtn() {
  const hasText = !!searchInput.value;
  searchClearBtn.hidden = !hasText;
  searchKbd.hidden = hasText;
}

function clearSearch() {
  searchInput.value = '';
  closeSearchPanel();
  syncSearchClearBtn();
}

function jumpToSearchResult(i) {
  const r = searchResults[i];
  if (!r) return;
  searchActive = i;
  jumpToTask(r.col.id, r.t.id, r.sub && r.sub.id);
  clearSearch(); // 已找到：清空搜索
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

function cardHTML(t, idx, colIdx = 0) {
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
  const canLeft = colIdx > 0;
  const canRight = colIdx < state.columns.length - 1;
  return `<article class="task-card" data-id="${t.id}" tabindex="-1" style="--card-tint:${tint[0]};--card-tint-hover:${tint[1]}">
    <div class="card-top">
      <span class="task-handle" title="拖动移动任务">⠿</span>
      <button type="button" class="task-move" data-dir="-1"${canLeft ? '' : ' disabled'} title="移到左列（相邻一列）">‹</button>
      <h3 class="task-title">${esc(t.title)}</h3>
      <button type="button" class="task-move" data-dir="1"${canRight ? '' : ' disabled'} title="移到右列（相邻一列）">›</button>
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
  const nav = `<div class="col-nav-wrap">
    <button class="col-nav" title="快速导航：跳转任务 / 回顶部">☰</button>
    <div class="col-nav-panel">
      <input class="col-nav-filter" placeholder="筛选本列任务…" maxlength="50" autocomplete="off">
      <ul class="col-nav-list">
        <li class="col-nav-item col-nav-top" data-top="1">↑ 回到列顶部</li>
        ${tasks.map(t => {
          const p = progressOf(t);
          const dot = p.total === 0 ? '' : p.done === p.total ? '<span class="col-nav-dot done"></span>' : '<span class="col-nav-dot part"></span>';
          return `<li class="col-nav-item" data-id="${t.id}" data-full="${esc(t.title)}">${dot}${esc(t.title)}</li>`;
        }).join('')}
        <li class="col-nav-empty" hidden>没有匹配的任务</li>
      </ul>
    </div>
   </div>`;
  return `<section class="column${done ? ' column-done' : ''}" data-id="${col.id}" style="--col-accent:${accent}">
    <header class="col-header">
      ${head}
      ${title}
      <span class="col-count">${tasks.length}</span>
      <button class="col-move" data-dir="-1" title="左移一列">‹</button><button class="col-move" data-dir="1" title="右移一列">›</button>
      ${nav}
      ${del}
    </header>
    <input class="task-add-input" placeholder="＋ 添加任务，回车确认" maxlength="200">
    <div class="task-list" data-col="${col.id}">${shown.map((t, i) => cardHTML(t, i, idx)).join('') || '<div class="empty-hint"><svg class="empty-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>暂无任务，拖拽或输入添加</div>'}</div>
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
  boardEl.innerHTML = state.columns.map((col, i) => columnHTML(col, i)).join('');
  // 移动端单列视图：高亮激活列 + 渲染 tab 栏（桌面端 .m-tabs 为 display:none，无副作用）
  const activeColEl = boardEl.querySelector('.column[data-id="' + activeMobileColId() + '"]');
  if (activeColEl) activeColEl.classList.add('m-active');
  mTabsEl.innerHTML = state.columns.map((col, i) => {
    const done = col.title === DONE_TITLE;
    const accent = done ? DONE_ACCENT : ACCENTS[i % ACCENTS.length];
    const count = tasksInColumn(col.id).length;
    return '<button class="m-tab' + (col.id === activeMobileColId() ? ' active' : '') + '" data-col-id="' + col.id + '" style="--tab-accent:' + accent + '"><span class="m-tab-dot"></span><span class="m-tab-title">' + esc(col.title) + '</span><span class="m-tab-count">' + count + '</span></button>';
  }).join('');
  if (openTaskId) { renderDetailSubtasks(); renderDetailMove(); }
  renderDiscarded();
  initSortables();
  updateScrollFades();
  updateColNavVisibility();
  if (activeTaskId) {
    const el = activeCardEl();
    if (el) el.classList.add('card-active');
    else activeTaskId = null;
  }
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

/* 触屏设备：子项拖拽改用 ⋯ 按钮作手柄，避免与任务列表纵向滚动冲突 */
const TOUCH_UI = matchMedia('(hover: none)').matches;
function initSortables() {
  const isMobile = matchMedia('(max-width: 720px)').matches;
  // 列排序：移动端用列头 ‹ › 按钮，不建列拖拽实例（单列视图下列拖拽无意义且与按钮冲突）
  if (!isMobile) {
    sortables.push(new Sortable(boardEl, {
      group: 'columns',
      handle: '.col-header',
      draggable: '.column',
      filter: '.col-rename-input, .col-nav-wrap',
      animation: 150,
      ghostClass: 'drag-ghost',
      onEnd: onColumnMove,
    }));
  }
  // 任务卡：移动端用顶部手柄左右横滑换列（见下方横滑逻辑），不建 Sortable 实例
  if (!isMobile) {
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
  }
  boardEl.querySelectorAll('.subtask-list').forEach(el => {
    sortables.push(new Sortable(el, {
      group: 'subtasks',
      handle: TOUCH_UI ? '.subtask-more' : undefined,
      animation: 150,
      ghostClass: 'drag-ghost',
      onEnd: onSubtaskMove,
    }));
  });
  if (openTaskId) {
    sortables.push(new Sortable(document.getElementById('d-subtask-list'), {
      group: 'subtasks',
      handle: TOUCH_UI ? '.subtask-more' : undefined,
      filter: '.d-empty',
      animation: 150,
      ghostClass: 'drag-ghost',
      onEnd: onSubtaskMove,
    }));
  }
}

function onTaskMove(evt) {
  const task = findTask(evt.item.dataset.id);
  if (!task) return;
  const colEl = evt.to.closest('.column');
  if (!colEl) return;
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

/* 列左/右移一位（移动端列头 ‹ › 按钮；桌面端列排序仍用拖拽） */
function moveColumn(colId, dir) {
  const i = state.columns.findIndex(c => c.id === colId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= state.columns.length) return;
  const [col] = state.columns.splice(i, 1);
  state.columns.splice(j, 0, col);
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
  frag.innerHTML = tasks.slice(prev, next).map((t, i) => cardHTML(t, prev + i, state.columns.findIndex(c => c.id === colId))).join('');
  [...frag.children].forEach(el => listEl.appendChild(el));
  const btn = boardEl.querySelector(`.load-more[data-col="${colId}"]`);
  const hidden = tasks.length - next;
  if (btn) {
    if (hidden > 0) btn.textContent = `还有 ${hidden} 个任务`;
    else btn.remove();
  }
  updateColNavVisibility();
}

function flashCard(cardEl) {
  cardEl.classList.add('flash');
  setTimeout(() => cardEl.classList.remove('flash'), 900);
}

/* 快速导航：滚动到指定主项并高亮；未渲染则先加载；subId 存在时额外定位并高亮该子项 */
function jumpToTask(colId, taskId, subId) {
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
  if (subId) {
    const row = card.querySelector(`.subtask-row[data-id="${subId}"]`);
    if (row) {
      row.scrollIntoView({ behavior: 'auto', block: 'nearest' });
      row.classList.add('sub-flash');
      setTimeout(() => row.classList.remove('sub-flash'), 900);
    }
  }
}

/* 超长列判定：任务数超过一页，或列内容超出可视高度（卡片多且长） */
function updateColNavVisibility() {
  boardEl.querySelectorAll('.column').forEach(colEl => {
    const list = colEl.querySelector('.task-list');
    const n = tasksInColumn(colEl.dataset.id).length;
    const overflow = !!list && list.scrollHeight > list.clientHeight + 40;
    colEl.classList.toggle('nav-visible', n > PAGE_SIZE || overflow);
  });
}

/* ================= 键盘快速导航：↑↓ / j k 在卡片间移动，Enter 打开详情 ================= */

let activeTaskId = null;

function activeCardEl() {
  return activeTaskId ? boardEl.querySelector(`.task-card[data-id="${activeTaskId}"]`) : null;
}

function clearActiveCard() {
  const el = activeCardEl();
  if (el) el.classList.remove('card-active');
  activeTaskId = null;
}

function setActiveCard(taskId) {
  const prev = activeCardEl();
  if (prev) prev.classList.remove('card-active');
  activeTaskId = taskId;
  const el = activeCardEl();
  if (!el) { activeTaskId = null; return; }
  el.classList.add('card-active');
  el.scrollIntoView({ block: 'nearest' });
}

function stepActiveCard(dir) {
  let el = activeCardEl();
  if (!el) {
    const first = boardEl.querySelector('.task-card');
    if (first) setActiveCard(first.dataset.id);
    return;
  }
  const colEl = el.closest('.column');
  const cards = [...colEl.querySelectorAll('.task-card')];
  const idx = cards.indexOf(el);
  let next = cards[idx + dir];
  if (!next && dir > 0) {
    // 已到渲染区底部：还有未加载的任务则继续加载并跟进
    const more = colEl.querySelector('.load-more');
    if (more) {
      loadMoreTasks(more.dataset.col);
      next = [...colEl.querySelectorAll('.task-card')][idx + 1];
    }
  }
  if (next) setActiveCard(next.dataset.id);
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
  if (mobileActiveColId === colId) mobileActiveColId = null; // 删除当前列后回退第一列（activeMobileColId() 兜底）
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
  const anyOpen = detailEl.classList.contains('open') || discardedEl.classList.contains('open') || aiHelpEl.classList.contains('open');
  backdropEl.classList.toggle('open', anyOpen);
}

function closeDiscardedCore() {
  discardedEl.classList.remove('open');
  syncBackdrop();
}
function closeDiscarded() {
  closeDiscardedCore();
  retractPanelHistory();
}

/* ================= detail panel ================= */

function openDetail(taskId, subId = null) {
  const t = findTask(taskId);
  if (!t) return;
  const wasOpen = detailEl.classList.contains('open');
  clearActiveCard();
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
  renderDetailMove();
  discardedEl.classList.remove('open');
  detailEl.classList.add('open');
  syncBackdrop();
  updateScrollFades();
  if (!wasOpen) pushPanelHistory(); // 返回键拦截：开面板压一条历史记录
  // 定位：从子项位置打开则滚动到该子项并高亮，否则滚动到顶部
  const body = document.querySelector('#detail .detail-body');
  if (body) {
    if (subId) {
      const row = body.querySelector(`.subtask-row[data-id="${subId}"]`);
      if (row) {
        const bodyRect = body.getBoundingClientRect();
        const rowRect = row.getBoundingClientRect();
        body.scrollTop += rowRect.top - bodyRect.top - body.clientHeight / 2 + row.clientHeight / 2;
        row.classList.add('sub-flash');
        setTimeout(() => row.classList.remove('sub-flash'), 900);
        return;
      }
    }
    body.scrollTop = 0;
  }
}

function closeDetailCore() {
  openTaskId = null;
  detailEl.classList.remove('open');
  syncBackdrop();
  destroySortables();
  initSortables();
}
function closeDetail() {
  closeDetailCore();
  retractPanelHistory();
}

/* 主任务换列（移动端详情页「移到」按钮；语义与拖拽换列一致：completedAt / 顺序） */
function moveTaskToColumn(taskId, colId) {
  const t = findTask(taskId);
  const col = state.columns.find(c => c.id === colId);
  if (!t || !col || t.columnId === colId) return;
  t.columnId = colId;
  t.updatedAt = Date.now();
  if (col.title === DONE_TITLE) t.completedAt = Date.now();
  else delete t.completedAt;
  state.tasks = [...state.tasks.filter(x => x.id !== taskId), t];
  save();
  render();
}

/* 详情页「移到」按钮行（仅移动端显示，桌面端由 CSS 隐藏）：左右各移一列（弹确认，不跳列） */
function renderDetailMove() {
  const opts = document.getElementById('d-move-opts');
  const t = findTask(openTaskId);
  if (!opts || !t) return;
  const i = state.columns.findIndex(c => c.id === t.columnId);
  const left = i > 0 ? state.columns[i - 1] : null;
  const right = i >= 0 && i < state.columns.length - 1 ? state.columns[i + 1] : null;
  opts.innerHTML =
    `<button class="d-move-opt" data-dir="-1"${left ? '' : ' disabled'}>${left ? '‹ ' + esc(left.title) : '‹ 无左列'}</button>` +
    `<button class="d-move-opt" data-dir="1"${right ? '' : ' disabled'}>${right ? esc(right.title) + ' ›' : '无右列 ›'}</button>`;
}
document.getElementById('d-move-opts').addEventListener('click', e => {
  const btn = e.target.closest('.d-move-opt');
  if (!btn || btn.disabled || !openTaskId) return;
  const t = findTask(openTaskId);
  if (!t) return;
  const i = state.columns.findIndex(c => c.id === t.columnId);
  const target = state.columns[i + Number(btn.dataset.dir)];
  if (!target || t.columnId === target.id) return;
  if (!confirm(`将「${t.title}」移到「${target.title}」列？`)) return;
  mobileActiveColId = target.id; // 移完聚焦目标列
  moveTaskToColumn(t.id, target.id);
});

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
  // 触屏：长按不呼出任何菜单（系统菜单干扰拖拽；分配操作走卡片 ⋯ 按钮）
  if (TOUCH_UI) { e.preventDefault(); return; }
  if (document.querySelector('.sortable-fallback')) return; // 拖拽进行中不弹分配菜单
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

/* ================= 移动端顶栏溢出菜单（≤720px 显示 ⋮；条目转发点击给原按钮） ================= */

(function initMobileMenu() {
  const btn = document.getElementById('mobile-menu-btn');
  if (!btn) return;
  const ITEMS = [
    ['add-column', '新建列'],
    ['discarded-btn', '废弃任务'],
    ['export-btn', '导出 JSON 备份'],
    ['import-btn', '导入 JSON 备份'],
    ['ai-btn', 'AI 说明'],
  ];
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  ITEMS.forEach(([id, label]) => {
    const el = document.createElement('div');
    el.className = 'ctx-item';
    el.textContent = label;
    el.addEventListener('click', () => {
      menu.classList.remove('open');
      document.getElementById(id).click();
    });
    menu.appendChild(el);
  });
  document.body.appendChild(menu);
  btn.addEventListener('click', e => {
    e.stopPropagation();
    if (menu.classList.contains('open')) {
      menu.classList.remove('open');
      return;
    }
    menu.classList.add('open');
    const r = btn.getBoundingClientRect();
    const w = menu.offsetWidth;
    menu.style.left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)) + 'px';
    menu.style.top = r.bottom + 6 + 'px';
  });
  document.addEventListener('click', e => {
    if (menu.classList.contains('open') && !menu.contains(e.target)) menu.classList.remove('open');
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') menu.classList.remove('open');
  });
})();

/* ================= 移动端 tab 列切换（≤720px：tab 栏切换单列视图） ================= */

const mTabsEl = document.getElementById('m-tabs');

// 点击 tab 切换激活列（事件委托，只绑一次；tab 栏 innerHTML 每次 render 重建）
mTabsEl.addEventListener('click', e => {
  const tab = e.target.closest('.m-tab');
  if (!tab) return;
  mobileActiveColId = tab.dataset.colId;
  render();
});

/* ================= 移动端任务左右横移（≤720px：卡片顶部 ‹ › 按钮，弹确认，只移相邻一列，不跳列） ================= */
boardEl.addEventListener('click', e => {
  const btn = e.target.closest('.task-move');
  if (!btn || btn.disabled) return;
  const card = btn.closest('.task-card');
  const task = card ? findTask(card.dataset.id) : null;
  if (!task) return;
  const i = state.columns.findIndex(c => c.id === task.columnId);
  const target = state.columns[i + Number(btn.dataset.dir)];
  if (!target || task.columnId === target.id) return;
  if (!confirm(`将「${task.title}」移到「${target.title}」列？`)) return;
  mobileActiveColId = target.id; // 移完聚焦目标列
  moveTaskToColumn(task.id, target.id);
});

/* ================= events: board ================= */

boardEl.addEventListener('click', e => {
  if (justDragged) return;
  const navBtn = e.target.closest('.col-nav');
  if (navBtn) {
    const wrap = navBtn.closest('.col-nav-wrap');
    const open = wrap.classList.toggle('open');
    if (open) {
      const f = wrap.querySelector('.col-nav-filter');
      if (f) f.focus();
    }
    return;
  }
  const navTop = e.target.closest('.col-nav-top');
  if (navTop) {
    const list = navTop.closest('.column').querySelector('.task-list');
    if (list) list.scrollTo({ top: 0 });
    return;
  }
  const navItem = e.target.closest('.col-nav-item');
  if (navItem && navItem.dataset.id) {
    jumpToTask(navItem.closest('.column').dataset.id, navItem.dataset.id);
    return;
  }
  const colMove = e.target.closest('.col-move');
  if (colMove) {
    moveColumn(colMove.closest('.column').dataset.id, Number(colMove.dataset.dir));
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
    const subRow = e.target.closest('.subtask-row');
    openDetail(card.dataset.id, subRow ? subRow.dataset.id : null);
  }
});

boardEl.addEventListener('change', e => {
  if (e.target.classList.contains('subtask-check')) {
    toggleSubtask(e.target.closest('.subtask-row').dataset.id, e.target.checked);
  }
});

boardEl.addEventListener('input', e => {
  if (!e.target.classList.contains('col-nav-filter')) return;
  const q = e.target.value.trim().toLowerCase();
  const list = e.target.closest('.col-nav-panel').querySelector('.col-nav-list');
  let visible = 0;
  list.querySelectorAll('.col-nav-item:not(.col-nav-top)').forEach(li => {
    const show = !q || (li.dataset.full || '').toLowerCase().includes(q);
    li.hidden = !show;
    if (show) visible++;
  });
  const empty = list.querySelector('.col-nav-empty');
  if (empty) empty.hidden = visible > 0;
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

function startColRename(colEl) {
  const col = state.columns.find(c => c.id === colEl.dataset.id);
  if (!col || col.title === DONE_TITLE) return;
  const titleEl = colEl.querySelector('.col-title');
  if (!titleEl) return;
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
}

boardEl.addEventListener('dblclick', e => {
  const titleEl = e.target.closest('.col-title');
  if (!titleEl) return;
  startColRename(titleEl.closest('.column'));
});

/* 触屏无双击：点按列标题直接重命名 */
if (TOUCH_UI) {
  boardEl.addEventListener('click', e => {
    if (justDragged) return;
    const titleEl = e.target.closest('.col-title');
    if (!titleEl) return;
    startColRename(titleEl.closest('.column'));
  });
}

/* 双击子项标题就地编辑（看板卡片 + 详情面板通用）；已完成的子项需先取消完成才可编辑 */
document.addEventListener('dblclick', e => {
  if (justDragged) return;
  const titleEl = e.target.closest('.subtask-title');
  if (!titleEl) return;
  const row = titleEl.closest('.subtask-row');
  if (!row) return;
  const f = findSubtask(row.dataset.id);
  if (!f || f.sub.done) return; // 已完成的子项不允许编辑
  hideTip();
  const input = document.createElement('input');
  input.className = 'subtask-edit-input';
  input.value = f.sub.title;
  input.maxLength = 200;
  titleEl.replaceWith(input);
  input.focus();
  input.select();
  let settled = false;
  const commit = () => {
    if (settled) return;
    settled = true;
    const v = input.value.trim();
    if (v && v !== f.sub.title) {
      f.sub.title = v;
      f.task.updatedAt = Date.now();
      save();
    }
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

/* ================= 任务检索：事件 ================= */

searchInput.addEventListener('input', () => { syncSearchClearBtn(); runSearch(); });
searchClearBtn.addEventListener('click', () => {
  clearSearch();
  searchInput.focus();
});
searchInput.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!searchResults.length) return;
    const dir = e.key === 'ArrowDown' ? 1 : -1;
    searchActive = (searchActive + dir + searchResults.length) % searchResults.length;
    renderSearchPanel();
    const el = searchPanel.querySelector('.search-item.active');
    if (el) el.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') {
    e.preventDefault();
    jumpToSearchResult(searchActive < 0 ? 0 : searchActive);
  } else if (e.key === 'Escape') {
    if (searchInput.value) clearSearch();
    else searchInput.blur();
  }
});
searchPanel.addEventListener('mousedown', e => {
  const item = e.target.closest('.search-item');
  if (!item) return;
  e.preventDefault(); // 防止搜索框失焦
  const i = [...searchPanel.querySelectorAll('.search-item')].indexOf(item);
  jumpToSearchResult(i);
});
document.addEventListener('click', e => {
  if (!searchPanel.hidden && !e.target.closest('.search-wrap')) closeSearchPanel();
  document.querySelectorAll('.col-nav-wrap.open').forEach(w => {
    if (!w.contains(e.target)) w.classList.remove('open');
  });
});

/* 全局快捷键：Ctrl+K / “/” 聚焦搜索；↑↓ / j k 卡片间移动；Enter 打开详情 */
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    searchInput.focus();
    searchInput.select();
    return;
  }
  const t = e.target;
  const typing = !!(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable));
  if (e.key === '/' && !typing) {
    e.preventDefault();
    searchInput.focus();
    return;
  }
  if (typing) return;
  if (openTaskId || discardedEl.classList.contains('open')) {
    if (e.key === 'Escape') clearActiveCard();
    return;
  }
  if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); stepActiveCard(1); }
  else if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); stepActiveCard(-1); }
  else if (e.key === 'Enter') {
    const el = activeCardEl();
    if (el) { e.preventDefault(); openDetail(el.dataset.id); }
  } else if (e.key === 'Escape') {
    clearActiveCard();
    document.querySelectorAll('.col-nav-wrap.open').forEach(w => w.classList.remove('open'));
  }
});

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(updateColNavVisibility, 150);
});

/* ================= events: detail panel ================= */

document.getElementById('d-close').addEventListener('click', closeDetail);
backdropEl.addEventListener('click', () => {
  if (discardedEl.classList.contains('open')) closeDiscarded();
  else if (aiHelpEl.classList.contains('open')) closeAiHelp();
  else closeDetail();
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (ctxMenu.classList.contains('open')) { closeAssignMenu(); return; }
  if (discardedEl.classList.contains('open')) closeDiscarded();
  else if (aiHelpEl.classList.contains('open')) closeAiHelp();
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
    const body = document.querySelector('#detail .detail-body');
    if (body) body.scrollTop = body.scrollHeight;
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

document.getElementById('add-column').addEventListener('click', () => {
  const title = prompt('列名称', '新列');
  if (title && title.trim()) {
    state.columns.push({ id: uid(), title: title.trim() });
    const newCol = state.columns[state.columns.length - 1];
    if (matchMedia('(max-width: 720px)').matches) mobileActiveColId = newCol.id; // 移动端新建列后自动切到新列
    save();
    render();
  }
});

document.getElementById('discarded-btn').addEventListener('click', () => {
  if (openTaskId) closeDetail();
  const wasOpen = discardedEl.classList.contains('open');
  renderDiscarded();
  discardedEl.classList.add('open');
  syncBackdrop();
  if (!wasOpen) pushPanelHistory();
});
document.getElementById('disc-close').addEventListener('click', closeDiscarded);
document.getElementById('disc-list').addEventListener('click', e => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  if (btn.dataset.act === 'restore') restoreTask(btn.dataset.id);
  else purgeTask(btn.dataset.id);
});

/* ================= AI 使用说明（复制给 AI 助手） ================= */

function buildAiHelpText() {
  const base = location.origin;
  return `# 任务看板（Kanban）操作说明

这是一个任务看板服务，数据为列 → 任务 → 子项。请按以下任一方式读写（三选一，方式一优先）。

看板地址：${base}

## 方式一：MCP（支持 MCP 的客户端首选）
在 MCP 客户端配置中加入（mcpServers）：
{
  "kanban": {
    "command": "node",
    "args": ["/opt/kanban/mcp/server.js"],
    "env": { "KANBAN_URL": "${base}" }
  }
}
可用工具：board_digest（看板概览，读板首选）/ board_search / list_tasks / create_column / rename_column / delete_column / create_task / update_task / delete_task / restore_task / add_subtask / update_subtask / delete_subtask

## 方式二：CLI（终端 agent / 脚本）
KANBAN_URL=${base} node kanban.js <命令> [参数] [--json]
  digest                          看板概览
  search <关键词>                  搜索任务/子项
  tasks [--col <列ID>]             任务完整列表（含子项）
  columns                         列列表
  add-column <名称>
  rename-column <列ID> <新名称>
  del-column <列ID>
  add-task <列ID> <标题> [--desc] [--prio low|medium|high] [--due YYYY-MM-DD] [--tags a,b] [--assignee]
  update-task <任务ID> [--title] [--desc] [--prio] [--due] [--tags] [--assignee] [--col <列ID>]   # 传 --col 即跨列移动
  del-task <任务ID> [--hard]       默认废弃（可恢复）；--hard 永久删除
  restore-task <任务ID>            恢复废弃任务
  add-sub <任务ID> <标题> [--assignee]
  sub <子项ID> done|undone|del [--title] [--assignee]

## 方式三：REST API（${base}，JSON，/ai/ 前缀）
GET    /ai/health                 健康检查
GET    /ai/digest                 看板概览（列/任务/进度/逾期/统计，读板首选）
GET    /ai/search?q=关键词         搜索任务与子项（多词空格分隔，全部需命中）
GET    /ai/columns                列列表（含任务数）
POST   /ai/columns                建列 {title}
PATCH  /ai/columns/:id            改列名 {title}
DELETE /ai/columns/:id            删列（列内有任务 409；「已完成」列 400）
GET    /ai/tasks?columnId=        任务完整列表（含子项）
POST   /ai/tasks                  建任务 {columnId, title, description?, priority?, dueDate?, tags?, assignee?}
PATCH  /ai/tasks/:id              改任务字段（只传要改的；传 columnId 即跨列移动，移入「已完成」自动记完成时间）
DELETE /ai/tasks/:id?hard=1       删任务（默认废弃可恢复；hard=1 永久删除）
POST   /ai/tasks/:id/restore      恢复废弃任务
POST   /ai/tasks/:id/subtasks     加子项 {title, assignee?}
PATCH  /ai/subtasks/:id           改子项 {done?, title?, assignee?}
DELETE /ai/subtasks/:id           删子项

## 约定
- 优先级：none|low|medium|high；截止日期：YYYY-MM-DD
- 「已完成」列不可删除；任务移入该列自动记完成时间，移出自动清除
- 删任务默认废弃（可用 restore 恢复），只有明确要求时才永久删除（--hard / hard=1）

- 响应均为 JSON：成功 {ok:true, ...}，失败 {ok:false, error}
`;
}
function closeAiHelpCore() {
  aiHelpEl.classList.remove('open');
  syncBackdrop();
}
function closeAiHelp() {
  closeAiHelpCore();
  retractPanelHistory();
}

/* ================= 返回键拦截：开详情面板压一条历史记录，浏览器返回键先关面板而不是退出页面 =================
 * panelDepth：我们压入且尚未消费的历史条目数；
 * suppressPop：手动关闭后用 history.back() 收回条目，忽略随之而来的 popstate */
let panelDepth = 0;
let suppressPop = false;
function pushPanelHistory() {
  history.pushState({ kanbanPanel: 1 }, '');
  panelDepth++;
}
function retractPanelHistory() {
  if (panelDepth === 0) return;
  panelDepth--;
  suppressPop = true;
  history.back();
}
window.addEventListener('popstate', () => {
  if (suppressPop) { suppressPop = false; return; }
  if (panelDepth === 0) return;
  panelDepth--;
  if (detailEl.classList.contains('open')) closeDetailCore();
  else if (discardedEl.classList.contains('open')) closeDiscardedCore();
  else if (aiHelpEl.classList.contains('open')) closeAiHelpCore();
  // 无面板打开（陈旧条目）：直接消费
});

document.getElementById('ai-btn').addEventListener('click', () => {
  if (openTaskId) closeDetail();
  const wasOpen = aiHelpEl.classList.contains('open');
  document.getElementById('ai-help-text').textContent = buildAiHelpText();
  aiHelpEl.classList.add('open');
  syncBackdrop();
  if (!wasOpen) pushPanelHistory();
});
document.getElementById('ai-help-close').addEventListener('click', closeAiHelp);

/* 复制：优先 clipboard API；HTTP 非安全上下文回退 execCommand */
document.getElementById('ai-help-copy').addEventListener('click', async () => {
  const text = document.getElementById('ai-help-text').textContent;
  let ok = false;
  try {
    if (navigator.clipboard) await navigator.clipboard.writeText(text);
    else throw new Error('no clipboard api');
    ok = true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
  }
  const btn = document.getElementById('ai-help-copy');
  btn.textContent = ok ? '✓ 已复制，去粘贴给 AI 吧' : '复制失败，请手动全选复制';
  setTimeout(() => { btn.textContent = '复制使用说明'; }, 2000);
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
