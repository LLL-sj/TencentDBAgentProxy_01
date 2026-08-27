# 新 Agent 工作交接（TencentDB-Agent-Memory · 第十二轮维护 · 镜像重建 / H-08 / 部署脚本整理）

> 状态：本文是 HANDOFF10 之后的最新交接，当前最新。
> Git：仍未 commit，HEAD `fe3230f`。三容器 healthy，且已运行在本轮重建的新镜像上。
> 纪律：不 git commit；保留旧 `.bak`；本机开发模式才启用源码挂载，服务器模式必须关闭源码挂载。

---

## 0. 本轮完成内容（均已验证）

### 0.1 H-08 hook-cache 外键失败：根因已修复

**根因：**

- `sessions` 表主键使用 `spaceId`，本环境为 `default:user:agent:session`。
- prewarm 写 `hook_cache` 时没有拿到请求的 `spaceId`，缺省后写成 `_default:...`。
- 两边前缀不一致，触发 `FOREIGN KEY constraint failed`，导致 hook 缓存 prewarm 写入失败。

**修复：**

- `MemoryProxy/src/handler.ts`：prewarm 入参透传 `spaceId`。
- `MemoryProxy/src/anthropicHandler.ts`：prewarm 入参透传 `spaceId`。
- `MemoryProxy/src/injection/prewarm.ts`：
  - `spaceId = input.spaceId ?? input.sessionInfo.space_id ?? ""`
  - `repo.putMany(spaceId, ...)`。

**验证：**

- 新会话冒烟：session 注册成功，prewarm `cached=2`。
- 数据库中 `sessions.session_id` 与 `hook_cache.session_id` 前缀一致，均为 `default:...`。
- 不再出现 `[hook-cache] putMany failed ... FOREIGN KEY constraint failed`。
- 冒烟测试产生的临时 session 已从 proxy SQLite 清理。

### 0.2 proxy 数据卷挂载：已修复并完成数据迁移

- `deploy/global-images/start-proxy.sh` 恢复：
  ```bash
  -v "$PROXY_VOLUME:/data/tdai-memory-proxy"
  ```
- `.env` / `.env.example` 增加 `PROXY_VOLUME=tdai-proxy-data`。
- 当前 proxy SQLite 已从旧容器可写层迁移到命名卷 `tdai-proxy-data`。
- 迁移后数据保留：16 sessions / 8 tips_reminder_state / 75 hook_cache。
- 旧卷迁移前备份：
  `backups/tdai-proxy-data-before-migrate-20260827.tar.gz`
- `stop-all.sh --purge` 已同步增加 proxy 卷清理。

### 0.3 三个镜像已从当前源码重建

旧镜像先打备份 tag `*-local-backup-20260827-pre`，然后重建：

| 镜像 | 新 Image ID | 大小 |
|---|---|---|
| `agentmemory/memory-core:local` | `511e332e9453` | 1.34GB |
| `agentmemory/memory-proxy:local` | `86391d45face` | 1.27GB |
| `agentmemory/memory-hub:local` | `d34101e691a3` | 2.01GB |

- hub 全量镜像构建本轮已成功（knowledge `npm install` 耗时约 8 分钟但完成）。
- 镜像包已导出并校验：
  - `backups/tdai-images-local-20260827.tar.gz`
  - 大小 751MB
  - sha256：`e8c05b988067f95e5779ea9f23911008e78f88be9115336fcff3b4580be58073`
- `docker save` 只含镜像层，**不含本机 SQLite / volumes / .env / .admin-key**。
- proxy 镜像已确认不包含 `src/*.bak*`（`.dockerignore` 改为 `**/*.bak*`）。

### 0.4 部署脚本支持服务器独立运行

新增/修改 `.env.example` 和三个启动脚本：

```bash
TDAI_DEV_SOURCE_MOUNTS=0      # 服务器：不挂源码，镜像自包含
TDAI_RESTART_POLICY=unless-stopped
TDAI_TZ=Asia/Shanghai
```

- `start-memory-core.sh` / `start-proxy.sh` 增加有/无源码挂载两个分支。
- 三个启动脚本都支持 `--restart` 和 `TZ`。
- 服务器只需要：镜像包 + `deploy/global-images/`，不需要仓库源码目录。
- 本机 `.env` 目前仍为 `TDAI_DEV_SOURCE_MOUNTS=1`（开发热更新）。

### 0.5 文档整理

- `AGENT_INDEX.md`：重写为部署运维手册（部署、.env、启停、日志、数据卷、镜像、排障、文件索引）。
- `memory-agent/FINAL.md`：重写为长期维护记录（相关文件、整体作用、全部修改、经验、剩余问题）。
- `L0_ROUTING_AND_EXTRACTION.md` / `TEAM_NOTES.md` / `MEMORY_MECHANISM.md`：本轮没有改到对应代码，保持原样。
- 新增本交接文档 `NEW_AGENT_HANDOFF11.md`。

### 0.6 冒烟验证

- Claude Code `/v1/messages` 新会话：200，`pong`，session-init `preset hit`，hook 缓存命中。
- Codex `/v1/responses`：200 SSE，正常 `response.completed` 链路，usage 解析正常。
- 三容器 healthy。

---

## 1. 当前遗留问题（从 HANDOFF10 继承，状态已更新）

### 1.1 功能类

- Claude Code WebSearch 内部请求可能污染 L0：仍未修，仍需抓一次真实请求 body。
- Codex 内部请求目前只过滤 L0 写入，仍会走 injection pipeline；token 有优化空间。
- Responses 非流式 usage/assistant 解析未做完整适配，当前不使用。
- 历史 L0 污染记录待清理（见 HANDOFF10 §1.3）。

### 1.2 日志噪音（不影响功能，已记录到 FINAL.md）

| 日志 | 状态 |
|---|---|
| `CREDIT_REPORT ... fetch failed` | 未修；credit report URL 未配置 |
| `agent-fixed-asset/list-with-detail 404` | 未修；Knowledge 无此路由 |
| `joinUrl.fallback` warning | 未修；Responses 实际路由正确，仅多打 warning |

### 1.3 部署类

| 项 | 状态 |
|---|---|
| proxy 数据卷 H-13 | ✅ 已修 |
| hub 前端 docker cp 热更新 | ✅ 已通过重建 hub 镜像解决 |
| hub 全量镜像构建卡住 | ✅ 本轮构建成功 |
| RestartPolicy | 本机仍 `no`；服务器 `.env.example` 已用 `unless-stopped` |
| `MEMORY_PROXY_PUBLIC_BASE_URL` | 本机仍 `127.0.0.1`；服务器部署时改实际地址 |
| 时区 | 脚本已支持 `TDAI_TZ`；当前 core/hub 需下次重启后生效 |
| 服务器首次部署 | 未执行；按 `AGENT_INDEX.md` 第 2 章操作 |

---

## 2. 运维注意

- **不要**把本机 `.env`、`.admin-key`、volumes、`backups/` 拷到服务器。
- 服务器模式必须 `TDAI_DEV_SOURCE_MOUNTS=0`；本机开发才设为 `1`。
- `.env` 新增项：
  ```bash
  PROXY_VOLUME=tdai-proxy-data
  TDAI_DEV_SOURCE_MOUNTS=0|1
  TDAI_RESTART_POLICY=no|unless-stopped
  TDAI_TZ=Asia/Shanghai
  ```
- `start-proxy.sh` 测试服务器模式时若用临时 `ENV_FILE`，会覆盖 `.proxy-config/config.yaml`；测完必须用本机 `.env` 重新执行 `./start-proxy.sh` 恢复。
- 镜像回滚可用 tag：
  ```text
  agentmemory/memory-core:local-backup-20260827-pre
  agentmemory/memory-proxy:local-backup-20260827-pre
  agentmemory/memory-hub:local-backup-20260827-pre
  ```

---

## 3. 测试与状态

- `MemoryProxy npx tsc --noEmit`：通过。
- `MemoryCore vitest`：25/25 通过。
- `MemoryKnowledge vitest`：6/6 通过。
- `MemoryPanel typecheck/build`、`web build`：通过。
- `MemoryCore npm run build`：仍会在 `scripts/seed-v2/tsconfig.json` 失败（不影响 Docker 镜像，需后续修 build 脚本）。
- 三容器 healthy，运行新镜像。

---

## 4. 下轮建议优先级

1. 执行服务器首次部署（按 `AGENT_INDEX.md` 第 2 章），确认服务器模式端到端。
2. 抓 Claude Code WebSearch 真实请求，设计通用子代理/内部请求过滤。
3. 清理三个日志噪音：
   - credit report 未配置时跳过请求；
   - knowledge 404 修正路由或请求目标；
   - `joinUrl` 识别已知后缀后不再打 fallback warning。
4. 修复 `MemoryCore npm run build` 缺少 `scripts/seed-v2` 的问题。
5. Git：推到用户自建 private 仓库（本机仍未 commit，HEAD `fe3230f`）。
