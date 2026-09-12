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
   scp -o StrictHostKeyChecking=accept-new index.html server.js backup.js css js root@108.186.246.232:/opt/kanban/
   ```

3. **重启服务并确认**（期望输出 `active` + `HTTP 200`）：
   ```bash
   ssh root@108.186.246.232 "systemctl restart kanban && systemctl is-active kanban && curl -s -o /dev/null -w 'HTTP %{http_code}\n' http://127.0.0.1:8787/"
   ```

4. **浏览器验证**：打开 `http://108.186.246.232:8787/`，**强制刷新**（`Ctrl+Shift+R`）清掉旧的 JS/CSS 缓存。

> 数据在 `/opt/kanban/kanban.db`，更新代码不影响数据。

> 安全提醒：登录密码/密钥请勿提交到仓库；密码在 VPS 控制台（tianliyun.cn）管理。

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
