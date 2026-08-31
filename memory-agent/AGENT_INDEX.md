# AGENT_INDEX.md — TDAI 三件套部署与运维手册

> 本文是部署/运维的唯一入口：服务器首次部署、改配置、重启、挂载、看日志、升级镜像、排障只看这一篇。
> 本文件位于 `memory-agent/`，文中相对路径均以仓库根目录 `TencentDB-Agent-Memory/` 为基准；若当前在 `memory-agent/` 目录，请先 `cd ..` 再执行命令。
> 记忆机制细节看 `memory-agent/MEMORY_MECHANISM.md`；历史修改与经验看 `memory-agent/MAINTENANCE_AND_CHANGELOG.md`（原 `memory-agent/FINAL.md`）。

---

## 1. 三件套总览

| 容器 | 镜像 | 端口 | 作用 |
|---|---|---|---|
| `tdai-memory-core` | `agentmemory/memory-core` | 8420 | 记忆内核：L0/L0.5/L1/L2/L3、鉴权、skill |
| `tdai-memory-hub` | `agentmemory/memory-hub` | 8125 / 8424 | Panel 管理端 + Knowledge/Team Notes |
| `tdai-proxy` | `agentmemory/memory-proxy` | 8096 | Agent 请求入口：转发 LLM + 注入记忆 |

所有启动/停止/配置脚本都在 `deploy/global-images/`。

---

## 2. 服务器首次部署

### 2.1 需要准备什么

只准备两样，**不要拷贝本机数据**：

1. 镜像包：`tdai-images-local-20260827.tar.gz`
2. 目录：`deploy/global-images/`（脚本 + `.env.example`，不需要仓库源码目录）

不要拷贝本机的 `.env`、`.admin-key`、`backups/`、Docker volumes；服务器会生成自己的一套。

### 2.2 导入镜像

```bash
docker load -i tdai-images-local-20260827.tar.gz
docker images | grep agentmemory/memory
```

应看到三个 `agentmemory/memory-*:local`。

### 2.3 生成自己的 .env

```bash
cd deploy/global-images
cp .env.example .env
```

编辑 `.env`，最少确认 3 组值：

```bash
# 1) 镜像 tag
MEMORY_CORE_IMAGE=agentmemory/memory-core:local
MEMORY_HUB_IMAGE=agentmemory/memory-hub:local
PROXY_IMAGE=agentmemory/memory-proxy:local

# 2) 两组 LLM（后台记忆组 + Agent 转发组）
MEMORY_LLM_BASE_URL=...
MEMORY_LLM_API_KEY=...
MEMORY_LLM_MODEL=...
PROXY_UPSTREAM_URL=...
PROXY_UPSTREAM_API_KEY=...
PROXY_UPSTREAM_MODEL=...

# 3) 服务器实际可达地址
MEMORY_PROXY_PUBLIC_BASE_URL=http://<服务器IP或域名>:8096
MEMORY_HUB_PROXY_PUBLIC_URL=http://<服务器IP或域名>:8096
```

### 2.4 服务器运行模式（关键）

`.env.example` 默认就是服务器模式：

```bash
TDAI_DEV_SOURCE_MOUNTS=0     # 镜像自包含，不挂载仓库源码
TDAI_RESTART_POLICY=unless-stopped
TDAI_TZ=Asia/Shanghai
```

- `TDAI_DEV_SOURCE_MOUNTS=0`：只挂配置文件和三个数据卷，不依赖源码目录。
- 本机开发才改成 `1`，此时要求仓库目录存在且脚本在仓库内运行。

### 2.5 预检与启动

```bash
./verify.sh                 # 校验 .env、端口、LLM 通路
./start-all.sh              # 按 core -> hub -> proxy 启动
```

首次启动会自动生成服务器自己的 `.admin-key`（admin user_key）。之后：

```bash
cat .admin-key              # 拿 admin key，登录 Panel / 配置 Agent
```

### 2.6 防火墙

服务器需放行：`8420`、`8125`、`8424`、`8096`。Panel/Core/Knowledge 不建议直接公网暴露。

---

## 3. 配置：只改 .env

所有手工配置只改 `deploy/global-images/.env`。

| 区块 | 变量 | 说明 |
|---|---|---|
| 镜像 | `*_IMAGE` | 升级时改 tag |
| 后台 LLM | `MEMORY_LLM_BASE_URL/API_KEY/MODEL/PROTOCOL` | memory-core + hub 内部抽取/总结 |
| 转发 LLM | `PROXY_UPSTREAM_URL/API_KEY/MODEL` | proxy 把 Agent 请求转到这里 |
| 对外地址 | `MEMORY_PROXY_PUBLIC_BASE_URL` | 注入给 Agent 的 curl 地址，不能是 127.0.0.1 |
| 端口 | `MEMORY_CORE_PORT/PANEL_PORT/KNOWLEDGE_PORT/PROXY_PORT` | 有冲突才改 |
| 数据卷 | `MEMORY_CORE_VOLUME/PANEL_VOLUME/PROXY_VOLUME` | 默认不要改 |
| 记忆模式 | `MEMORY_PROMPT_MODE=chat/code` | 项目场景用 `code` |
| Code Memory | `MEMORY_CODE_MEMORY_VERSION=v1/v2`、`MEMORY_PROJECT_MEMORY_*` | v2 项目记忆 |
| L1 触发 | `MEMORY_L1_EVERY_N/IDLE_TIMEOUT` | 抽取频率 |
| L0.5 | `MEMORY_TIPS_*` | summary tips 提醒 |
| 部署 | `TDAI_DEV_SOURCE_MOUNTS/RESTART_POLICY/TZ` | 服务器保持默认 |

改完 `.env` 后重启对应服务或全部：

```bash
./start-all.sh
```

`.proxy-config/config.yaml` 和 `.memory-core-config/tdai-gateway.yaml` 由脚本每次自动生成，**不要手改**。

---

## 4. 日常运维命令

### 4.1 启动 / 停止 / 重启

```bash
cd deploy/global-images
./start-all.sh              # 启动全部（会重建容器，数据卷保留）
./stop-all.sh               # 停止并删除容器，保留数据卷
./stop-all.sh --purge       # 危险：连三个数据卷一起删
./start-memory-core.sh      # 单启 core
./start-memory-hub.sh       # 单启 hub
./start-proxy.sh            # 单启 proxy
```

“重启服务” = `./start-all.sh`。脚本会移除旧容器再建新容器，挂载的 named volume 不丢。

### 4.2 健康检查

```bash
docker ps                   # 三个容器都应为 (healthy)
curl -fsS http://localhost:8420/health
curl -fsS http://localhost:8125/health
curl -fsS http://localhost:8424/health
curl -fsS http://localhost:8096/health
```

### 4.3 看日志

```bash
docker logs -f tdai-memory-core
docker logs -f tdai-memory-hub
docker logs -f tdai-proxy
docker logs --since 10m tdai-proxy
```

常用 grep 关键字：

```bash
docker logs tdai-proxy | grep -E 'session-init|write-l0|hook-cache|openai-tools|FOREIGN'
docker logs tdai-memory-core | grep -E 'pipeline|packager|extraction|project'
docker logs tdai-memory-hub | grep -E 'ERROR|WARN|404'
```

---

## 5. 数据持久化与服务器独立性

### 5.1 三个 named volume

| Volume | 挂载到 | 内容 |
|---|---|---|
| `tdai-memory-core-data` | `/data/tdai-memory` | L0-L3、SQLite、JSONL、project/topics、checkpoint |
| `tdai-panel-data` | `/data/knowledge` | Knowledge SQLite、Wiki、日志、panel 配置 |
| `tdai-proxy-data` | `/data/tdai-memory-proxy` | proxy SQLite：sessions、hook_cache、tips_reminder_state |

容器删除/重建、服务重启都不会丢；只有 `--purge` 或手动删 volume 才丢。

### 5.2 本机数据不会进镜像

`docker save` 只导出镜像层，不包含任何 volume、`.env`、`.admin-key`。服务器首次启动会创建**全新的空数据卷**和**新的 admin key**，与本机完全独立。

### 5.3 备份

```bash
# 备份某个卷（在任意有 docker 的机器）
docker run --rm -v tdai-memory-core-data:/data -v $PWD:/backup alpine \
  tar czf /backup/tdai-memory-core-data-$(date +%Y%m%d).tar.gz -C /data .

# 恢复
docker run --rm -v tdai-memory-core-data:/data -v $PWD:/backup alpine \
  sh -c 'tar xzf /backup/<backup>.tar.gz -C /data'
```

### 5.4 升级代码且保留旧数据

1. 构建/导入新镜像（新 tag）。
2. `.env` 里把三个 `*_IMAGE` 改成新 tag。
3. `./start-all.sh`。
4. 数据卷名不变，旧数据自动继续使用。

---

## 6. 镜像构建 / 导出 / 回滚

### 6.1 构建（在源码仓库机器上）

```bash
cd MemoryCore && DOCKER_BUILDKIT=1 docker build -t agentmemory/memory-core:local .
cd MemoryProxy && DOCKER_BUILDKIT=1 docker build -t agentmemory/memory-proxy:local .
cd deploy/panel-knowledge-combined && IMAGE_NAME=agentmemory/memory-hub IMAGE_TAG=local ./build.sh
```

### 6.2 导出 / 导入

```bash
docker save agentmemory/memory-core:local agentmemory/memory-hub:local agentmemory/memory-proxy:local | gzip > tdai-images-local.tar.gz
docker load -i tdai-images-local.tar.gz
```

### 6.3 回滚

```bash
# 构建前先打备份 tag
docker tag agentmemory/memory-core:local agentmemory/memory-core:local-backup-YYYYMMDD
docker tag agentmemory/memory-proxy:local agentmemory/memory-proxy:local-backup-YYYYMMDD
docker tag agentmemory/memory-hub:local agentmemory/memory-hub:local-backup-YYYYMMDD
# 回滚时把 .env 的 *_IMAGE 改回 backup tag，再 start-all.sh
```

---

## 7. 排障

### 7.1 服务起不来

1. `docker ps -a` 看状态，`docker logs <容器>` 看报错。
2. 缺配置：`.env` 是否漏填 `REPLACE_ME`。
3. 端口冲突：改 `.env` 端口后重启。
4. LLM 配置错：先跑 `./verify.sh`。

### 7.2 记忆类问题

| 现象 | 先查 |
|---|---|
| L0 为空 | proxy 日志 `preset hit` / `preset mismatch`，检查 team/agent/task 是否有效 |
| L1 为空 | core 日志 `extraction failed` 还是未触发；检查 `MEMORY_LLM_*` |
| Agent 不提交 tips | 注入里是否有 `<summary_tips_contract>`；`MEMORY_PROXY_PUBLIC_BASE_URL` 是否可达 |
| L2 少 topic | 是否曾误写入 `project/topics/topics/*.md`；刷新 panel 或查 packager 日志 |
| Codex tools 报错 | proxy 日志 `[openai-tools]` |
| hook-cache 外键错误 | 应已被修复；仍出现则查 `MemoryProxy/src/injection/prewarm.ts` 的 spaceId 传递 |

### 7.3 已知日志噪音（不影响功能，按需处理）

| 日志 | 含义 | 处理 |
|---|---|---|
| `CREDIT_REPORT ... fetch failed` | credit 上报 URL 未配置，默认占位地址必然失败 | 可在 config 显式关闭 credit report |
| `agent-fixed-asset/list-with-detail HTTP 404` | proxy 向 Knowledge 问了一个 Panel/Core 侧接口 | 注入器捕获为空，待路由修正 |
| `joinUrl.fallback` | `/responses` 已能正确拼接，只是多打 warning | 可让 joinUrl 识别已知后缀后不打 warning |
| `hook-cache ... FOREIGN KEY` | 历史 bug，当前镜像已修 | 升级后仍出现再报 |

---

## 8. 源码与文档索引（开发时用）

### 8.1 总览文档

| 文件 | 内容 |
|---|---|
| `memory-agent/CURRENT_STATUS_功能实现与当前阶段.md` | 当前阶段：功能实现 / 目前阶段（新 Agent 先读） |
| `memory-agent/AGENT_INDEX.md` | 本文件：部署与运维唯一入口 |
| `memory-agent/MEMORY_MECHANISM.md` | 记忆机制最终口径 |
| `memory-agent/L0_ROUTING_AND_EXTRACTION.md` | Codex/Claude Code L0 抽取 |
| `memory-agent/TEAM_NOTES.md` | Team Notes 机制 |
| `memory-agent/MAINTENANCE_AND_CHANGELOG.md` | 历史修改、经验、剩余问题（原 `FINAL.md`） |
| `memory-agent/ISSUES_AND_RESOLUTIONS.md` | 问题汇总与排障记录（原 `问题汇总.md`） |
| `memory-agent/NEW_AGENT_HANDOFF11.md` | 当前最新交接（镜像重建 / H-08 / 部署脚本） |
| `memory-agent/NEW_AGENT_HANDOFF10.md` | 上一轮：Codex Responses + L0 内部请求过滤 |
| `memory-agent/NEW_AGENT_HANDOFF6~9.md` | 历轮交接实施记录（需要历史背景时再看） |

### 8.2 部署与配置

| 文件 | 内容 |
|---|---|
| `deploy/global-images/.env` | 实际配置（本机/服务器各自独立） |
| `deploy/global-images/.env.example` | 配置模板 |
| `deploy/global-images/start-all.sh` | 启动三件套 |
| `deploy/global-images/start-{core,hub,proxy}.sh` | 单服务启动 |
| `deploy/global-images/stop-all.sh` | 停止/清理 |

### 8.3 核心代码

| 模块 | 入口文件 |
|---|---|
| Core 记忆流水线 | `MemoryCore/src/core/tdai-core.ts`、`core/record/l1-extractor.ts`、`utils/stateful-pipeline-manager.ts` |
| Code v2 / Tips | `MemoryCore/src/utils/project-memory-packager.ts`、`core/tips/summary-tips.ts` |
| Proxy 转发/注入 | `MemoryProxy/src/handler.ts`、`anthropicHandler.ts`、`injection/` |
| L0 写入 | `MemoryProxy/src/tdai/recorder.ts` |
| Tips/Notes bridge | `MemoryProxy/src/tips-bridge.ts`、`notes-bridge.ts` |
| Knowledge | `MemoryKnowledge/src/server.ts`、`routes/notes.ts` |
| Panel | `MemoryPanel/src/panel/http/app.ts`、`MemoryPanel/web/` |
