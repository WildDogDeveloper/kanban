'use strict';

/*
 * Kanban CLI — 终端 AI / 脚本 / cron 入口
 *
 * 环境变量：
 *   KANBAN_URL  看板 AI API 地址（主服务 /ai/ 前缀），默认 http://127.0.0.1:8787
 *
 * 用法：node kanban.js <命令> [参数] [--json]
 *   digest                          看板概览
 *   search <关键词>                  搜索任务/子项
 *   tasks [--col <列ID>]             任务完整列表（含子项）
 *   columns                         列列表
 *   rename-column <列ID> <新名称>
 *   del-column <列ID>
 *   add-task <列ID> <标题> [--desc] [--prio low|medium|high] [--due YYYY-MM-DD] [--tags a,b] [--assignee] [--note]
 *   update-task <任务ID> [--title] [--desc] [--prio] [--due] [--tags] [--assignee] [--note] [--col <列ID>]
 *   del-task <任务ID> [--hard]       默认废弃（可恢复），--hard 永久删除
 *   restore-task <任务ID>
 *   add-sub <任务ID> <标题> [--assignee]
 *   sub <子项ID> done|undone|del [--title] [--assignee]
 *   help
 */

const BASE = (process.env.KANBAN_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');


function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    fail(`无法连接 ${BASE}（${err.message}）`);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) fail(`${method} ${path} → ${data && data.error ? data.error : `HTTP ${res.status}`}`);
  return data;
}

function parseArgs(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') { flags.json = true; continue; }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else { flags[key] = next; i++; }
    } else pos.push(a);
  }
  return { pos, flags };
}

const PRIO_CN = { none: '', low: '低', medium: '中', high: '高' };

function fmtDigest(d) {
  const t = d.totals;
  const lines = [`看板概览：${t.columns} 列 / ${t.tasks} 任务 / ${t.done} 已完成 / ${t.overdue} 逾期 / ${t.discarded} 废弃`];
  for (const col of d.columns) {
    lines.push(`  ${col.title} (${col.count})`);
    for (const x of col.tasks) {
      const bits = [x.title];
      if (PRIO_CN[x.priority]) bits.push(`[${PRIO_CN[x.priority]}]`);
      if (x.progress) bits.push(x.progress);
      if (x.dueDate) bits.push(`截止 ${x.dueDate}${x.overdue ? '(逾期)' : ''}`);
      if (x.assignee) bits.push(`@${x.assignee}`);
      bits.push(`#${x.id}`);
      lines.push(`    · ${bits.join('  ')}`);
    }
  }
  return lines.join('\n');
}

function fmtSearch(d) {
  if (!d.count) return '没有匹配的任务或子项';
  return d.results.map((r, i) => {
    const via = r.via === 'subtask' ? `（子项：${r.subtask} #${r.subtaskId}）` : '';
    return `${i + 1}. [${r.column}] ${r.task}${via}  #${r.taskId}`;
  }).join('\n');
}

function fmtTasks(d) {
  if (!d.count) return '没有任务';
  return d.tasks.map(t => {
    const subs = t.subtasks.length
      ? '\n' + t.subtasks.map(s => `      ${s.done ? '✓' : '○'} ${s.title}${s.assignee ? ` @${s.assignee}` : ''}  #${s.id}`).join('\n')
      : '';
    const bits = [t.title];
    if (PRIO_CN[t.priority]) bits.push(`[${PRIO_CN[t.priority]}]`);
    const total = t.subtasks.length;
    const done = t.subtasks.filter(s => s.done).length;
    if (total) bits.push(`${done}/${total}`);
    if (t.dueDate) bits.push(`截止 ${t.dueDate}`);
    if (t.assignee) bits.push(`@${t.assignee}`);
    bits.push(`#${t.id}  列：${t.column}`);
    return `· ${bits.join('  ')}${subs}`;
  }).join('\n');
}

function out(data, text, json) {
  if (json) console.log(JSON.stringify(data, null, 2));
  else console.log(text);
}

const HELP = `用法：node kanban.js <命令> [参数] [--json]

读：
  digest                          看板概览
  search <关键词>                  搜索任务/子项
  tasks [--col <列ID>]             任务完整列表（含子项）
  columns                         列列表

列：
  add-column <名称>
  rename-column <列ID> <新名称>
  del-column <列ID>

任务：
  add-task <列ID> <标题> [--desc] [--prio low|medium|high] [--due YYYY-MM-DD] [--tags a,b] [--assignee] [--note]
  update-task <任务ID> [--title] [--desc] [--prio] [--due] [--tags] [--assignee] [--note] [--col <列ID>]
  del-task <任务ID> [--hard]       默认废弃（可恢复），--hard 永久删除
  restore-task <任务ID>

子项：
  add-sub <任务ID> <标题> [--assignee]
  sub <子项ID> done|undone|del [--title] [--assignee]

环境变量：KANBAN_URL（默认 http://127.0.0.1:8787）`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, flags } = parseArgs(rest);
  const json = !!flags.json;
  const [a0, a1] = pos;

  switch (cmd) {
    case 'digest': {
      const d = await api('GET', '/ai/digest');
      out(d, fmtDigest(d.digest), json);
      break;
    }
    case 'search': {
      if (!a0) fail('用法：search <关键词>');
      const d = await api('GET', `/ai/search?q=${encodeURIComponent(a0)}`);
      out(d, fmtSearch(d), json);
      break;
    }
    case 'tasks':
    case 'list': {
      const col = flags.col;
      const d = await api('GET', `/ai/tasks${col ? `?columnId=${encodeURIComponent(col)}` : ''}`);
      out(d, fmtTasks(d), json);
      break;
    }
    case 'columns': {
      const d = await api('GET', '/ai/columns');
      out(d, d.columns.map(c => `${c.title}  (${c.count})  #${c.id}`).join('\n'), json);
      break;
    }
    case 'add-column': {
      if (!a0) fail('用法：add-column <名称>');
      const d = await api('POST', '/ai/columns', { title: a0 });
      out(d, `✓ 已建列「${d.column.title}」 #${d.column.id}`, json);
      break;
    }
    case 'rename-column': {
      if (!a0 || !a1) fail('用法：rename-column <列ID> <新名称>');
      const d = await api('PATCH', `/ai/columns/${encodeURIComponent(a0)}`, { title: a1 });
      out(d, `✓ 列已改名「${d.column.title}」`, json);
      break;
    }
    case 'del-column': {
      if (!a0) fail('用法：del-column <列ID>');
      const d = await api('DELETE', `/ai/columns/${encodeURIComponent(a0)}`);
      out(d, '✓ 列已删除', json);
      break;
    }
    case 'add-task': {
      if (!a0 || !a1) fail('用法：add-task <列ID> <标题> [选项]');
      const body = { columnId: a0, title: a1 };
      if (flags.desc !== undefined) body.description = flags.desc;
      if (flags.prio !== undefined) body.priority = flags.prio;
      if (flags.due !== undefined) body.dueDate = flags.due;
      if (flags.tags !== undefined) body.tags = String(flags.tags).split(',').map(s => s.trim()).filter(Boolean);
      if (flags.assignee !== undefined) body.assignee = flags.assignee;
      if (flags.note !== undefined) body.completionNote = flags.note;
      const d = await api('POST', '/ai/tasks', body);
      out(d, `✓ 已建任务「${d.task.title}」 #${d.task.id}`, json);
      break;
    }
    case 'update-task': {
      if (!a0) fail('用法：update-task <任务ID> [选项]');
      const body = {};
      if (flags.title !== undefined) body.title = flags.title;
      if (flags.desc !== undefined) body.description = flags.desc;
      if (flags.prio !== undefined) body.priority = flags.prio;
      if (flags.due !== undefined) body.dueDate = flags.due;
      if (flags.tags !== undefined) body.tags = String(flags.tags).split(',').map(s => s.trim()).filter(Boolean);
      if (flags.assignee !== undefined) body.assignee = flags.assignee;
      if (flags.note !== undefined) body.completionNote = flags.note;
      if (flags.col !== undefined) body.columnId = flags.col;
      if (!Object.keys(body).length) fail('没有要更新的字段');
      const d = await api('PATCH', `/ai/tasks/${encodeURIComponent(a0)}`, body);
      out(d, `✓ 已更新任务「${d.task.title}」 #${d.task.id}`, json);
      break;
    }
    case 'del-task': {
      if (!a0) fail('用法：del-task <任务ID> [--hard]');
      const d = await api('DELETE', `/ai/tasks/${encodeURIComponent(a0)}${flags.hard ? '?hard=1' : ''}`);
      out(d, d.deleted === 'hard' ? '✓ 任务已永久删除' : '✓ 任务已废弃（restore-task 可恢复）', json);
      break;
    }
    case 'restore-task': {
      if (!a0) fail('用法：restore-task <任务ID>');
      const d = await api('POST', `/ai/tasks/${encodeURIComponent(a0)}/restore`);
      out(d, `✓ 已恢复「${d.task.title}」`, json);
      break;
    }
    case 'add-sub': {
      if (!a0 || !a1) fail('用法：add-sub <任务ID> <标题> [--assignee]');
      const body = { title: a1 };
      if (flags.assignee !== undefined) body.assignee = flags.assignee;
      const d = await api('POST', `/ai/tasks/${encodeURIComponent(a0)}/subtasks`, body);
      out(d, `✓ 已加子项「${d.subtask.title}」 #${d.subtask.id}`, json);
      break;
    }
    case 'sub': {
      if (!a0 || !a1) fail('用法：sub <子项ID> done|undone|del [--title] [--assignee]');
      if (a1 === 'del') {
        const d = await api('DELETE', `/ai/subtasks/${encodeURIComponent(a0)}`);
        out(d, '✓ 子项已删除', json);
      } else {
        const body = { done: a1 === 'done' };
        if (flags.title !== undefined) body.title = flags.title;
        if (flags.assignee !== undefined) body.assignee = flags.assignee;
        const d = await api('PATCH', `/ai/subtasks/${encodeURIComponent(a0)}`, body);
        out(d, `✓ 子项「${d.subtask.title}」已${d.subtask.done ? '勾选' : '取消勾选'}`, json);
      }
      break;
    }
    case 'help':
    case undefined:
      console.log(HELP);
      break;
    default:
      fail(`未知命令：${cmd}（node kanban.js help）`);
  }
}

main().catch(err => fail(err.message));
