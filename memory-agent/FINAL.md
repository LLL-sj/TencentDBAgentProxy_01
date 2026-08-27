# FINAL.md — TencentDB-Agent-Memory 历史修改与长期维护记录

> 更新日期：2026-08-27
> 状态：三容器 healthy；三个镜像已从当前源码重建并完成冒烟；proxy 数据卷挂载已修复。
> Git：功能改动仍未 commit，HEAD `fe3230f`。
> 当前最新交接：`memory-agent/NEW_AGENT_HANDOFF11.md`。

---

## 1. 相关文件（先读这些）

| 文件 | 用途 |
|---|---|
| `AGENT_INDEX.md` | **部署与运维唯一入口**：服务器部署、重启、挂载、日志、升级、排障 |
| `memory-agent/NEW_AGENT_HANDOFF11.md` | 当前最新交接：镜像重建 / H-08 / 部署脚本 |
| `memory-agent/NEW_AGENT_HANDOFF10.md` | 上一轮：Codex Responses + L0 内部请求过滤 |
| `memory-agent/MEMORY_MECHANISM.md` | 记忆机制最终口径 |
| `memory-agent/L0_ROUTING_AND_EXTRACTION.md` | Codex / Claude Code 的 L0 路由与 User/Assistant 抽取 |
| `memory-agent/TEAM_NOTES.md` | Team Notes 机制与编码校验 |
| `memory-agent/NEW_AGENT_HANDOFF6.md` | 前六轮总交接与 code v2 完整背景 |
| `memory-agent/NEW_AGENT_HANDOFF7~9.md` | 第七至十轮实施记录 |
| `deploy/global-images/.env.example` | 全部部署参数模板 |
| `deploy/global-images/start-*.sh` / `stop-all.sh` | 启动、停止、卷管理脚本 |

---

## 2. 整体作用

TencentDB-Agent-Memory 是面向 Coding Agent 的记忆系统：

1. 通过 proxy 接收 Codex / Claude Code 请求，转发给上游 LLM。
2. 把真实 User/Assistant 对话写入 L0；后台抽 L1 原子记忆、L2 项目经验、L3 项目索引。
3. 后续会话自动注入记忆上下文、Team Notes 工具、summary-tips 提醒、skill/knowledge 工具。
4. Panel 管理团队/Agent/Task/记忆/知识资产。

---

## 3. 全部修改（按轮次，只记结论）

### 3.1 第一轮：code 模式开关

- **改了什么**：新增唯一开关 `MEMORY_PROMPT_MODE=chat|code`，core/proxy 都从同一个 `.env` 生成配置；chat/code 提示词物理拆分。
- **为什么**：项目 Agent 需要抽取工作事实/方法，不应混入个人画像。
- **怎么改**：`MemoryCore/src/core/prompts/{chat,code}/`；`start-memory-core.sh` 与 `start-proxy.sh` 生成 `promptMode`。

### 3.2 第二轮：Agent 记忆资产挂载

- 资产 `chat_memory-{team}-{agent}`；`agent-fixed-asset/set` 全量替换绑定；限制借入 ≤2、同 team、不能借自己；新会话生效。

### 3.3 Phase 1：Team Notes

- Knowledge `/v3/notes/*`、Panel `/api/v1/notes/*`、Proxy `/notes-bridge/v3/notes/*`、前端页面和 `<note_tools>` 注入。
- 之后补 UTF-8/回读校验，中文必须 `curl --data-binary @file` 提交。

### 3.4 Phase 2：L0.5 summary_tips

- `summary_tips` 表；Core `/v3/tips/*`；Proxy `/memory-bridge/v3/tips/submit`；静态契约 + 动态提醒；去重和 L0 时间锚点。

### 3.5 Phase 3–5：L1 v2 与 Project Memory

- `codeMemoryVersion=v1|v2`；L1 v2 把 pending tips 按时间锚点合入 L0 流。
- `project-memory-packager.ts` 用 LLM 维护 `project/topics/*.md`，代码确定性重建 `project/MEMORY.md`。
- Panel 增加 code 记忆页、tips 页，后合并进统一 Memory 页面。

### 3.6 第六轮及之后：面板视图与会话级模式

- 统一 Memory 页面按 chat/code 展示不同层级。
- 新增 `x-tdai-memory-mode: chat|code|all|none`；优先级：会话冻结值 > 请求头 > `.env`。

### 3.7 第八轮：L0/L0.5/L1/L2 修复

- L0.5 按 `l0_start_at/l0_end_at` 时间锚点插入 L1 输入；LLM 成功后 `consumed`。
- L2 只消费新 L1，按 `.packager-state.json` 的 `lastL1UpdatedAt` 游标执行，不再依赖 pending tips。
- proxy SQLite 增加 `tips_reminder_state`，提醒状态跨重启保留。

### 3.8 第九轮：触发节奏与外部地址

- L1/L2/L3 触发参数改由 `.env` 控制；修复 L2 兜底 timer 丢失 team/agent 的问题。
- 新增 `MEMORY_PROXY_PUBLIC_BASE_URL`，注入给 Agent 的 curl 地址不再 fallback 到容器内网 IP。

### 3.9 第十轮：编码、summary、topics、Codex 工具

- Agent bridge 原始字节严格 UTF-8/GB18030 校验，错误码 42201/42202/42203。
- User 消息含 `<summary>...</summary>` 立即触发 L0.5 提醒。
- project topics 自动扁平化 `topics/topics/*.md`，`maxTopics=15` 合并，`[DELETED]` 清理。
- OpenAI 扁平/缺名 tool 规范化，解决 Codex `tools[i].name` 报错。

### 3.10 第十一轮：Codex Responses 与 L0 过滤（当前轮）

- **Codex 流式断开根因**：`/v1/responses` 被错误路由到 `/chat/completions`。新增 whitelist、guard-adapter、handler Responses 视图/合并/SSE 解析。
- **Codex 内部请求污染 L0**：旧/新 guard JSON + 可配置 `codexInternal.promptPrefixes` 三层过滤。
- **H-08 hook-cache FK 修复**：prewarm 统一使用请求 `spaceId`（handler 透传 + `sessionInfo.space_id` 兜底），消除 `_default`/`default` 不一致。
- **部署修复**：`start-proxy.sh` 恢复 `PROXY_VOLUME` 挂载；`TDAI_DEV_SOURCE_MOUNTS` 支持服务器模式；`stop-all.sh --purge` 包含 proxy 卷；时区/重启策略可配。
- **镜像**：三个 `:local` 镜像从当前源码重建，已运行验证；`docker save` 导出 `backups/tdai-images-local-20260827.tar.gz`。

---

## 4. 经验与坑（已解决）

1. **Codex “stream disconnected” 不是丢字节，而是端点路由错**：Responses 请求被降级到 Chat Completions。协议端点表要单一数据源维护。
2. **Codex 标题/审批请求会走同一 session 路径写 L0**：不能只过滤 assistant JSON，还要按稳定 system prompt 前缀过滤；配置化前缀便于后续扩展。
3. **L0 只能写真实 User/Assistant**：tool_use/tool_result、sidequery、fork、内部 prompt 都不能进 L0。
4. **hook_cache 外键失败是 spaceId 不一致**：session 用 `default`，prewarm 用 `_default`；所有持久化层必须传同一个 `spaceId`。
5. **proxy SQLite 不挂卷会随容器删除丢失**：sessions/hook_cache/tips_reminder_state 必须落到 `tdai-proxy-data`。
6. **L2 空的原因是 packager 等 pending tips**：改成按 L1 更新游标消费新 L1 后恢复。
7. **L0.5 迟到/未来 tip 会打乱时间顺序**：必须按 `l0_start_at/l0_end_at` 锚点插入，LLM 成功才 `consumed`。
8. **中文乱码来自 Git Bash 内联 JSON 编码**：用 UTF-8 文件 + `--data-binary @file`；proxy 做原始字节校验，不服务端转码。
9. **project topics 曾被写进 `topics/topics/*.md`**：LLM 路径不稳定，工程代码要扁平化并修复 MEMORY.md。
10. **Codex 扁平工具会被上游拒绝**：proxy 对 Chat Completions 包装、对 Responses 保持扁平并剔除无 `name` 工具。
11. **hub 前端只 `docker cp` 会随容器重建回退**：最终必须把前端 build 打进 hub 镜像。
12. **本地源码挂载不能带到服务器**：镜像重建后必须可无源码运行；部署脚本用 `TDAI_DEV_SOURCE_MOUNTS` 切换。

---

## 5. 剩余问题（待办）

### 5.1 功能/数据

1. Claude Code WebSearch 内部请求仍可能污染 L0；需抓一次真实 body 确认 `main/fork/sidequery`，再做通用过滤。
2. 历史 L0 污染记录待清理：Codex 审批/标题旧记录、WebSearch 旧记录、历史 smoke 记录。
3. `summary_tips` 暂无删除接口；误提交只能手工处理。
4. L1 未落 `memory_mode` 字段，面板暂按 type 过滤。
5. `projectMemory.minPendingTips/minDistinctSessions/packagerMaxIntervalSeconds` 解析但 packager 未完全使用。

### 5.2 日志噪音（不影响功能，影响运维观感）

| 日志 | 原因 | 建议 |
|---|---|---|
| `CREDIT_REPORT ... fetch failed` | credit 上报 URL 未配置，默认占位地址必失败 | config 显式关闭 credit report |
| `agent-fixed-asset/list-with-detail 404` | proxy 向 Knowledge 调了 Panel/Core 侧接口 | 改请求目标或补路由 |
| `joinUrl.fallback` warning | Responses 已被正确识别，但路径已是 `/responses`，走了一次 fallback | 识别已知后缀后不 warn |
| hub/codex 相关 404 日志 | 见 H-09 | 同上 |

### 5.3 部署与发布

1. 功能改动仍未 git commit；原仓库无 push 权限，计划推到用户自建 private 仓库。
2. 服务器部署尚未执行；需按 `AGENT_INDEX.md` 第 2 章初始化独立 `.env`/数据卷/admin key。
3. 服务器应使用 `TDAI_DEV_SOURCE_MOUNTS=0`、`unless-stopped`、`Asia/Shanghai`。
4. 后续代码升级走新镜像 tag + 保留原数据卷，不拷贝本机 `.env`/volume。

### 5.4 历史数据

- 旧乱码笔记 `note-79ut1azx` 的 v1 乱码 revision 是否保留待用户决定。
- 第八轮 E2E session `8a2dbcca-*` 留有少量测试数据，需要时再清。
