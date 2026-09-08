# MAINTENANCE_AND_CHANGELOG.md — TencentDB-Agent-Memory 历史修改与长期维护记录（原 FINAL.md）

> 更新日期：2026-09-08
> 状态：`tdai-memory-core` / `tdai-memory-hub` / `tdai-proxy` healthy；远程 Proxy 已切换为轻量 JSONL 日志；ClickHouse 已停止新写入，并经用户确认移除容器/镜像及旧回滚镜像/tar 包，数据卷保留；Codex Ambient Suggestions L0 过滤已部署，污染 L0/L1 已清理；上游兜底模型已切换为 qwen3.8-flash。
> Git：相关改动已提交并推送到 `feat/server_team`。
> 本文是“历史修改 + 交接”的唯一档案。此前零散 handoff/执行计划/报告已清理，不再单独维护。
>
> 说明：本文位于 `memory-agent/`，以下文件路径均相对本文所在目录（`memory-agent/`）。

---

## 0. 维护记录规范

- 只记录有实际影响的改动结果：改了什么、为什么、影响面、验证状态、剩余事项。
- 每条记录应能支撑后续 Agent 直接判断“是否要做/是否已完成”，不搬运完整命令日志。
- 历史 handoff / execution plan / report 不再单独保留；如需要更细粒度的过程，回 Git history 查看。
- 新增修改时按轮次追加到第 3 节末尾，格式见已有条目。

## 1. 相关文件（先读这些）

| 文件 | 用途 |
|---|---|
| `CURRENT_STATUS_功能实现与当前阶段.md` | 当前阶段总览：功能实现 / 目前阶段（先读） |
| `AGENT_INDEX.md` | **部署与运维唯一入口**：服务器部署、重启、挂载、日志、升级、排障 |
| `MEMORY_MECHANISM.md` | 记忆机制最终口径 |
| `L0_ROUTING_AND_EXTRACTION.md` | Codex / Claude Code 的 L0 路由与 User/Assistant 抽取 |
| `TEAM_NOTES.md` | Team Notes 机制与编码校验 |
| `INVESTIGATION_MEMORY_AND_SKILL_FLOW_20260907.md` | 后续记忆/Skill 统一方案指导（目标设计，尚未整体实现） |
| `HANDOFF_MEMORY_PARAMETER_UNIFICATION_20260907.md` | 当前活动交接：记忆参数与统一模型改造实施手册 |
| `ISSUES_AND_RESOLUTIONS.md` | 问题汇总与排障记录（原 `问题汇总.md`） |
| `../deploy/global-images/.env.example` | 全部部署参数模板 |
| `../deploy/global-images/start-*.sh` / `stop-all.sh` | 启动、停止、卷管理脚本 |

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
- **怎么改**：`../MemoryCore/src/core/prompts/{chat,code}/`；`../deploy/global-images/start-memory-core.sh` 与 `../deploy/global-images/start-proxy.sh` 生成 `promptMode`。

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
- **镜像**：三个 `:local` 镜像从当前源码重建，已运行验证；`docker save` 导出 `../backups/tdai-images-local-20260827.tar.gz`。

### 3.11 第十二轮：ClickHouse 停写与 Proxy 轻量 JSONL 日志（当前轮）

- **ClickHouse 高频小 INSERT 导致 CPU 高占用**：每个请求写 `usage_logs` + `usage_raw` + `request_stage_timings`，其中 credit report 失败还额外写一条 `report_failed`。
- **决策**：不再让 ClickHouse 承担当前小规模统计写入；改为 Proxy 本地 JSONL 日志。
- **Proxy 文件日志**：`report/file-logger.ts` 改为纯 JSONL；`start-proxy.sh` 默认 `PROXY_LOG_FILE=/data/tdai-memory-proxy/logs`。
- **查询脚本**：新增 `MemoryProxy/scripts/query_usage_stats.mjs`，可统计 Token/耗时/P50/P90。
- **远程状态**：`CLICKHOUSE_ENABLED=0`，`tdai-proxy` 已重启到新镜像。
- **后续清理（用户确认后）**：远程移除已停止的 `tdai-clickhouse` 容器和 `clickhouse/clickhouse-server:24.8` 镜像，释放约 807MB；之后再次清理 `local-before-*` 回滚镜像与 `/root/tdai-memory/images/` 下全部 tar.gz，远程磁盘使用从约 16G 降到约 9.5G；`tdai-clickhouse-data` 数据卷保留。
- **Git**：相关改动已提交并推送 `feat/server_team`。

### 3.12 第十三轮：L0 Session 化 + 记忆/Skill CRUD + Agent 受控写（A-E）

> 日期：2026-09-07；范围：阶段 A/B/C/D/E；已同步到远程并验证。

- **A：L0 Session 化**
  - Core/TCVDB 新增 `listL0Sessions()`；新增 `/v3/conversation/sessions`。
  - Panel `/chat-memory/l0-sessions`；Chat/Code L0 均按 session 列表 + 当前 session 消息展示，旧无 session 数据归默认 session。
- **B：Chat L2/L3 + Skill UI**
  - Chat L2 可编辑/删除，Chat L3 可编辑不删除；权限仅 asset owner。
  - Skill 面板支持编辑 SKILL.md、删除 Skill、在线编辑/删除已有文本文件。
- **C：Code L2/L3 CRUD**
  - Core 新增 `/v3/project/write|rm`，路径沙箱限制扁平 `project/topics/*.md`，写/删后自动重建 `project/MEMORY.md`。
  - Panel 新增 `/api/v1/project/write|delete`；Code L2 UI 暴露 owner 编辑/删除。
- **D：Agent 受控写**
  - Proxy `memory-bridge` 拆成读/写 allowlist；开放 `scenario/write|rm`、`core/write`、`project/write|rm`，写操作强制 self-only。
  - `<tdai_memory_tools>` 更新为读 + 受控写说明；`skillRuntime.allowLlmWrite` 默认开启。
- **E：镜像**
  - 三个 `:local` 镜像从当前源码重建并部署远程。
- **权限口径**：Chat/Code L2、Chat L3 面板写操作仅限 owner；Skill 共享=团队只读，修改/删除仅 owner，非 owner 后端返回 `SKILL_NOT_OWNER`。
- **未完成**：Code L3 手动编辑未做；Skill 启用/停用未做；Skill 源更新后 Fork 副本同步机制未做；Code L2 并发锁目前仅进程内；前端非 owner 的 Skill 编辑按钮仍显示。

### 3.13 Proxy 分阶段耗时统计与异步收尾

> 日期：2026-09-07；范围：MemoryProxy 耗时统计、流式 EOF、非流式 L0 异步。

- 新增 Proxy 侧请求阶段耗时统计，记录 `request.timing`/ClickHouse `request_stage_timings`；字段含 total、local_prepare、upstream_ttfb、upstream_stream、proxy_tail、client_network_tail、postprocess。
- OpenAI 流式 EOF 改为先 `controller.close()` 再异步 finalize，避免后处理阻塞客户端结束。
- OpenAI 非流式 L0 改为 `trackWrite()` 异步执行，与流式行为一致。
- 后续 ClickHouse 停写后，这些耗时改由本地 `proxy.log` + `query_usage_stats.mjs` 统计，见 3.11 与 `AGENT_INDEX.md` 4.5。
- 已知：`postprocess_ms` 基本为 0，因为 timing 在 Node `finish` 时发出，异步后处理更晚。

### 3.14 记忆触发参数微调与统一方案交接

> 日期：2026-09-07；范围：L1/L2/L3/Skill 触发参数。

- 已改并部署：
  - L1 单批 L0：`10 → 25`（`L1_BATCH_PROCESS=25`）
  - L1 单次最多：`10` 条
  - Skill：`toolCallThreshold=15`、`archiveBytes=61440`
  - 远程 `.env`：`MEMORY_L1_IDLE_TIMEOUT_SECONDS=300`、`MEMORY_L2_DELAY_AFTER_L1_SECONDS=120`、`MEMORY_SESSION_ACTIVE_WINDOW_HOURS=2`、`MEMORY_L3_TRIGGER_EVERY_N=7`
- 仍为 chat/code 共用全局参数；未做 per-mode 独立触发。
- 后续较重任务：按 `memory_mode=chat|code` 拆分触发参数；L3 触发改由 L2 文件变化驱动；L2/Skill 统一“多文件维护模型”；L3 统一拆成索引自动重建 + LLM/用户维护总结。完整目标设计见 `INVESTIGATION_MEMORY_AND_SKILL_FLOW_20260907.md`，实施交接见 `HANDOFF_MEMORY_PARAMETER_UNIFICATION_20260907.md`。

### 3.15 Codex Ambient Suggestions 过滤与 L0/L1 污染清理

> 日期：2026-09-08；范围：MemoryProxy L0 内部请求过滤 + 历史污染数据清理 + 部署。

- **问题**：Codex Desktop ambient suggestions 后台请求与真实会话使用同一套 `team/agent/user/task` 身份头；请求内容以 `# Overview` + `Generate 0 to 3 hyperpersonalized suggestions for what this user can do with Codex...` 开头，并包含大量旧任务历史，导致 L0/L1 出现“伪新 session”。
- **代码/配置修改**：
  - `MemoryProxy/src/tdai/recorder.ts`：`isCodexInternalPrompt()` 增加“先剥首个 Markdown 标题再匹配”的逻辑，使 `Generate 0 to 3...` 特征句前缀也能命中当前 `# Overview` 开头格式。
  - `MemoryProxy/src/config.ts`、`MemoryProxy/config.example.yaml`、`deploy/global-images/start-proxy.sh`、`deploy/global-images/.env.example`：默认 `codexInternal.promptPrefixes` 加入：
    - `# Overview\n\nGenerate 0 to 3 hyperpersonalized suggestions for what this user can do with Codex`
    - `Generate 0 to 3 hyperpersonalized suggestions for what this user can do with Codex`
- **验证**：TypeScript 编译通过；Ambient 样本返回 `null`（不写 L0）；普通用户消息正常保留；YAML 解析通过。
- **部署**：新 `agentmemory/memory-proxy:local` 镜像 `5d6c8eceb473` 已构建、上传远程、`tdai-proxy` 已重启 healthy；远程 config 已包含新增前缀。Git commit `1f8f7b7` 已推送 `origin/feat/server_team`。
- **数据清理**：
  - 删除污染 session `01a07bd8-4de7-7e63-9089-fe9019acc249` 的 L0 3 条、L1 3 条；
  - 同步清理 SQLite `l0_conversations/l1_records/l1_fts`、`conversations/*.jsonl`、`records/*.jsonl`、`checkpoint.json`；
  - 真实会话 `01a07bd8-988f-7dd0-aab4-ab9be9301f97` 保留；
  - 清理前备份：`/root/tdai-memory/backups/l0-cleanup-20260908-024410/`。
- **剩余事项**：仍建议按 `L0_ROUTING_AND_EXTRACTION_NEW.md` 抓 Ambient 原始 body，尝试将文本前缀升格为结构信号；旧的 WebSearch 等污染问题仍按 §5.1 继续处理。

### 3.16 上游兜底模型切换为 qwen3.8-flash

> 日期：2026-09-08；范围：远程/本地 Proxy 兜底模型。

- 将 `PROXY_UPSTREAM_MODEL` 从 `gpt-5.6-luna` 切换为 `qwen3.8-flash`。
- 先直接请求上游验证 `qwen3.8-flash` 返回 `HTTP 200`，确认可用后再切换。
- 已更新本地 `.env` 与远程 `.env`，并重启远程 `tdai-proxy`。
- 远程生成的 `.proxy-config/config.yaml` 中 `defaultModel` 已变为 `qwen3.8-flash`，`tdai-proxy` healthy。
- 说明：客户端显式带 model 时仍透传客户端模型；只有客户端不带 model 时才使用该兜底模型。

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
13. **ClickHouse 不适合当前小规模高频逐请求小写入**：如只做轻量 Token/耗时统计，使用 Proxy 数据卷 JSONL + 脚本即可，避免 ClickHouse 压缩/merge 的 CPU 开销。
14. **Codex Ambient Suggestions 会伪装成“旧会话复活”污染 L0**：它不是旧 session 被重放，而是后台自动建议把旧任务历史作为上下文生成一条新请求；若请求走同一代理身份头，必须加内部请求过滤或禁用该功能。

---

## 5. 剩余问题（待办）

### 5.1 功能/数据

1. Claude Code WebSearch 内部请求仍可能污染 L0；需抓一次真实 body 确认 `main/fork/sidequery`，再做通用过滤。
2. 历史 L0 污染记录待清理：Codex 审批/标题旧记录、WebSearch 旧记录、历史 smoke 记录。
3. `summary_tips` 暂无删除接口；误提交只能手工处理。
4. L1 未落 `memory_mode` 字段，面板暂按 type 过滤。
5. `projectMemory.minPendingTips/minDistinctSessions/packagerMaxIntervalSeconds` 解析但 packager 未完全使用。
6. L1/L2/L3 触发仍是 chat/code 共用全局参数；待按 `memory_mode` 独立配置（完整方案见 `INVESTIGATION_MEMORY_AND_SKILL_FLOW_20260907.md`）。
7. L3 触发当前依赖 L1 条数，后续应改为 L2 文件变化驱动。
8. L2/Skill 未统一成同一套“多文件维护”参数与规则；Skill 缺数量上限、单文件 token/总预算、强制合并。
9. L3 未统一拆成“自动索引 + 总结”两部分；chat L3 缺索引，code L3 缺 LLM 总结。
10. L1 warmup 尚未从 `1→2→4→5` 改为 `2→5`。
11. Code L3 当前只读、随 L2 自动重建，无手动编辑入口。
12. Skill 缺少启用/停用开关；团队共享 Skill 与 Fork 副本之间无源更新同步机制。
13. Code L2 并发锁为进程内锁，多副本部署需补分布式锁。
14. Skill UI 对非 owner 仍显示编辑/删除按钮，应改为按 owner 隐藏（待确认 UI 问题）。

### 5.2 日志噪音（不影响功能，影响运维观感）

| 日志 | 原因 | 建议 |
|---|---|---|
| `CREDIT_REPORT ... fetch failed` | credit 上报 URL 未配置，默认占位地址必失败 | config 显式关闭 credit report |
| `agent-fixed-asset/list-with-detail 404` | proxy 向 Knowledge 调了 Panel/Core 侧接口 | 改请求目标或补路由 |
| `joinUrl.fallback` warning | Responses 已被正确识别，但路径已是 `/responses`，走了一次 fallback | 识别已知后缀后不 warn |
| hub/codex 相关 404 日志 | 见 H-09 | 同上 |

### 5.3 部署与发布

1. 当前功能改动已 git commit 并推送到 `origin/feat/server_team`。
2. 远程已执行 Proxy 轻量 JSONL 日志部署并停止 ClickHouse 新写入，随后经用户确认移除 `tdai-clickhouse` 容器/镜像，并删除 `local-before-*` 回滚镜像与 `/root/tdai-memory/images/*.tar.gz`；`tdai-clickhouse-data` 数据卷仍保留，但本地已无 ClickHouse 离线包。若需恢复 ClickHouse，需从外部源/备份重新获取镜像，并按其 `AGENT_INDEX.md` 4.6 的恢复步骤执行。若还需同步其它 core/hub 最近改动，按 `AGENT_INDEX.md` 部署章节执行。
3. 服务器应使用 `TDAI_DEV_SOURCE_MOUNTS=0`、`unless-stopped`、`Asia/Shanghai`。
4. 后续代码升级走新镜像 tag + 保留原数据卷，不拷贝本机 `.env`/volume。

### 5.4 历史数据

- 旧乱码笔记 `note-79ut1azx` 的 v1 乱码 revision 是否保留待用户决定。
- 第八轮 E2E session `8a2dbcca-*` 留有少量测试数据，需要时再清。
