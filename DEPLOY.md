# 部署指南

一台 Linux 云主机即可（1C1G 足够；阿里云/腾讯云轻量服务器、ECS 都行，Ubuntu 22.04 / Debian 12）。
**IP 直接访问，不需要域名、不需要 Docker**。全部数据在 `kanban.db` 一个文件里，**备份 = 复制这个文件**。

## 当前服务器（美国 VPS，已部署）

- **IP**：`108.186.246.232`（tianliyun.cn 美国个人主机，Ubuntu 24.04）
- **登录**：`ssh root@108.186.246.232`（端口 22；本机已配置密钥登录，密钥 `~/.ssh/id_ed25519`）
- **代码目录**：`/opt/kanban`（**scp 部署，非 git 仓库**）
- **服务**：`systemctl restart kanban`（`PORT=8787`）
- **访问**：`http://108.186.246.232:8787/`
- **数据**：`/opt/kanban/kanban.db`（备份 = 复制此文件）
- **AI 服务**：`systemctl restart kanban-ai`（`AI_PORT=8788`，独立进程，与主服务共享 kanban.db，WAL 并发安全；崩溃不影响主服务）

### 更新代码（本地执行：上库 → scp → 重启 → 验证）

1. **本地改完代码，先上库**（在仓库目录 `D:/AI/kanban`）：
   ```bash
   cd /d/AI/kanban
   git add -A && git commit -m "改动说明" && git push origin main
   ```

2. **传改动文件到服务器**（只传改动的即可；全量覆盖也行）：
   ```bash
   # 只传改动文件（示例：前端改动）
   scp -o StrictHostKeyChecking=accept-new css/style.css root@108.186.246.232:/opt/kanban/css/style.css
   scp -o StrictHostKeyChecking=accept-new js/app.js    root@108.186.246.232:/opt/kanban/js/app.js
   # 全量覆盖（改了 server.js/index.html 等时用这条）
   scp -o StrictHostKeyChecking=accept-new index.html server.js backup.js css js ai mcp kanban.js package.json root@108.186.246.232:/opt/kanban/
   ```

3. **重启服务并确认**（期望输出 `active` + `HTTP 200`）：
   ```bash
   ssh root@108.186.246.232 "systemctl restart kanban && systemctl is-active kanban && curl -s -o /dev/null -w 'HTTP %{http_code}\n' http://127.0.0.1:8787/"
   ```

4. **浏览器验证**：打开 `http://108.186.246.232:8787/`，**强制刷新**（`Ctrl+Shift+R`）清掉旧的 JS/CSS 缓存。

> 数据在 `/opt/kanban/kanban.db`，更新代码不影响数据。

> 安全提醒：登录密码/密钥请勿提交到仓库；密码在 VPS 控制台（tianliyun.cn）管理。

## AI 接口（agent / CLI / MCP，独立进程）

AI 功能与主服务**完全解耦**：独立进程 `ai/server.js`（端口 8788），共享同一个 `kanban.db`（WAL 模式并发安全）。
主服务 `server.js` 零改动；AI 服务崩溃/重启不影响前端。数据源唯一：两边写的都是同一个库。

### 文件

- `ai/server.js` — AI API 服务器（资源级 REST，语义与前端操作一致）
- `mcp/server.js` — MCP 服务器（stdio，零依赖），把 API 包装成 13 个结构化工具
- `kanban.js` — CLI（终端 AI / 脚本 / cron 入口）

### AI API 端点（端口 8788）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康检查 |
| GET | `/api/digest` | 看板概览：列/任务/进度/逾期/统计（AI 读板首选） |
| GET | `/api/search?q=` | 搜索任务与子项（多词空格分隔，全部需命中） |
| GET | `/api/columns` | 列列表（含任务数） |
| POST | `/api/columns` | 建列 `{title}` |
| PATCH | `/api/columns/:id` | 改列名 `{title}` |
| DELETE | `/api/columns/:id` | 删列（列内有任务 409；已完成列 400） |
| GET | `/api/tasks?columnId=` | 任务完整列表（含子项） |
| POST | `/api/tasks` | 建任务 `{columnId, title, description?, priority?, dueDate?, tags?, assignee?}` |
| PATCH | `/api/tasks/:id` | 改任务字段（只传要改的；传 `columnId` 即跨列移动，移入已完成自动记完成时间） |
| DELETE | `/api/tasks/:id?hard=1` | 删任务（默认废弃可恢复；`hard=1` 永久删除） |
| POST | `/api/tasks/:id/restore` | 恢复废弃任务 |
| POST | `/api/tasks/:id/subtasks` | 加子项 `{title, assignee?}` |
| PATCH | `/api/subtasks/:id` | 改子项 `{done?, title?, assignee?}` |
| DELETE | `/api/subtasks/:id` | 删子项 |

### 部署 AI 服务（服务器，一次性）

```bash
ssh root@108.186.246.232 "cat > /etc/systemd/system/kanban-ai.service <<'EOF'
[Unit]
Description=Kanban AI API
After=network.target

[Service]
Environment=AI_PORT=8788
ExecStart=/usr/bin/node /opt/kanban/ai/server.js
Restart=always

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload && systemctl enable --now kanban-ai"
```

- 云安全组/防火墙放行 **8788**（TCP，仅当需要远程 AI 访问时）
- 无认证（与主服务一致：仅可信网络使用）

### MCP 客户端配置（AI 直接操作看板）

```json
{
  "mcpServers": {
    "kanban": {
      "command": "node",
      "args": ["/opt/kanban/mcp/server.js"],
      "env": { "KANBAN_URL": "http://108.186.246.232:8788" }
    }
  }
}
```

工具：`board_digest` / `board_search` / `list_tasks` / `create_column` / `rename_column` / `delete_column` / `create_task` / `update_task` / `delete_task` / `restore_task` / `add_subtask` / `update_subtask` / `delete_subtask`

### CLI

```bash
export KANBAN_URL=http://108.186.246.232:8788
node kanban.js digest                          # 看板概览
node kanban.js search 关键词                    # 搜索任务/子项
node kanban.js add-task <列ID> <标题> --prio high --due 2026-10-01
node kanban.js update-task <任务ID> --col <列ID>   # 跨列移动
node kanban.js add-sub <任务ID> <标题>
node kanban.js sub <子项ID> done                # 勾选子项
node kanban.js help                            # 全部命令；加 --json 输出原始 JSON
```

### 更新 AI 部分（本地执行）

```bash
# 传 AI 相关文件（server.js 未改则不用传）
scp -o StrictHostKeyChecking=accept-new kanban.js package.json root@108.186.246.232:/opt/kanban/
scp -o StrictHostKeyChecking=accept-new ai mcp root@108.186.246.232:/opt/kanban/
ssh root@108.186.246.232 "systemctl restart kanban-ai && systemctl is-active kanban-ai && curl -s http://127.0.0.1:8788/health"
```

## 1. 服务器装 Node

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get update && apt-get install -y nodejs
node -v    # 需要 >= 22.5（内置 node:sqlite，零 npm 依赖）
```

## 2. 传代码（本地执行）

```bash
ssh root@<服务器IP> "mkdir -p /opt/kanban"

# 方式 A：scp（node_modules 和 kanban.db 不用传）
scp -r index.html server.js backup.js css js root@<服务器IP>:/opt/kanban/

# 方式 B：git 私有仓库（以后更新方便）
#   本地：git init && git add -A && git commit -m init && git push
#   服务器：git clone <仓库地址> /opt/kanban
```

## 3. 运行

```bash
cd /opt/kanban
PORT=8787 nohup node server.js > kanban.log 2>&1 &
```

## 4. 开机自启（systemd，建议）

```bash
cat > /etc/systemd/system/kanban.service <<'EOF'
[Unit]
Description=Kanban Board
After=network.target

[Service]
Environment=PORT=8787
ExecStart=/usr/bin/node /opt/kanban/server.js
Restart=always

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload && systemctl enable --now kanban
```

## 5. 访问

- 云主机安全组/防火墙放行 **8787**（TCP）
- 浏览器打开 `http://<服务器IP>:8787/`
- 手机/平板/其他电脑，访问同一个地址即可，数据都在服务器上

## 日常运维

```bash
systemctl status kanban        # 看状态
journalctl -u kanban -f        # 看日志
systemctl restart kanban       # 重启
```

## 备份

```bash
mkdir -p /opt/backup && crontab -e
# 每天凌晨 3 点备份（VACUUM INTO 在线一致性备份，比直接 cp 运行中的库安全）：
0 3 * * * node /opt/kanban/backup.js /opt/backup/kanban-$(date +\%F).db
```

平时也可以用页面右上角「导出」按钮下载 JSON 备份，「导入」可恢复。

## 更新代码

```bash
cd /opt/kanban
git pull          # 或重新 scp 覆盖
systemctl restart kanban
```

数据在 `kanban.db`，更新代码不会丢。

## 安全提醒

- 服务**无认证**：能访问到 IP+端口的人即可查看和修改看板，只在可信网络使用
- IP 直连是 HTTP 明文（无域名就没有 HTTPS）；以后想上域名 + HTTPS，加一层 nginx + certbot 反代即可，应用本身不用改
- 只开必要端口（8787），SSH 建议密钥登录
