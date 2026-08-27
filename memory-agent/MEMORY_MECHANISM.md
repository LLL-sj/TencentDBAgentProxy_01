# 当前记忆机制说明（最终口径）

> 本文档只讲“现在是怎么工作的”，不涉及历史版本设计稿。

---

## 1. 总体链路

```text
Agent 对话
  → Proxy 会话初始化（team/agent/task）
  → 写入 L0 原始对话
  → 后台按触发条件运行 L1 / L2 / L3
  → 后续会话按模式注入记忆上下文
```

---

## 2. 记忆层级

| 层 | 内容 | 存储 | 说明 |
|---|---|---|---|
| L0 | 原始对话 | `l0_conversations` | 唯一事实来源，不调 LLM |
| L0.5 | summary_tips | `summary_tips` | Agent 主动提交的任务总结，带 L0 锚点 |
| L1 | 原子记忆 | `l1_records` + JSONL | LLM 从 L0/L0.5 抽取 |
| L2 | 场景/项目经验 | chat: `scene_blocks/*.md`；code v2: `project/topics/*.md` | code v2 的 L2.5 就是 L2 |
| L3 | 核心记忆 | chat: `persona.md`；code v2: `project/MEMORY.md` | code v2 不调 LLM |

---

## 3. 记忆模式

### 3.1 模式选择

请求头：

```text
x-tdai-memory-mode: chat | code | all | none
```

优先级：

```text
会话冻结值 > 当前请求头 > .env MEMORY_PROMPT_MODE
```

- 会话第一次初始化时锁定模式，后续请求头不能改变该会话模式。
- 换新 session 才能换模式。
- `all` 只支持 `codeMemoryVersion=v2`。
- `none` 不写 L0，不注入 TDAI 记忆。

### 3.2 chat 模式

- L1 类型：`persona / episodic / instruction`
- L2：`scene_blocks/*.md`
- L3：`persona.md`
- 注入：L3 全文 + L2 索引 + chat 工具指南
- 不处理 L0.5

### 3.3 code 模式（当前 v2）

- L1 类型：`work_fact / work_task / work_method / work_artifact`
- L1 v2 会把 pending tips 按 `l0_start_at/l0_end_at` 时间锚点合并进 L0 流：批内按时间插入、迟到 tip 置顶、未来 tip 暂缓；L1 LLM 成功后本批注入的 tip 标记 `consumed`
- L2 = L2.5 = `project/topics/*.md`
- L3 = `project/MEMORY.md`
- 注入：`project/MEMORY.md` 索引 + project 工具指南 + code 工具指南
- 旧 scene L2 / Doctrine L3 不注入

### 3.4 all 模式

- L0 只写一份
- L1 同一批 L0 跑两遍：chat 抽取 + code v2 抽取
- chat 链：scene_blocks / persona
- code 链：project topics / MEMORY.md
- 两套上下文都注入
- 两种 L1 类型都会产生，面板已按类型分开显示

### 3.5 none 模式

- 不写 L0
- 不触发任何记忆抽取
- 不注入任何 TDAI memory / summary-tips 上下文
- skill / Team Notes 不受影响

---

## 4. 触发与兜底

### 4.1 L0

- 会话初始化后，每轮 user/assistant 写入。
- Proxy 内按 session + 内容 hash 去重。

### 4.2 L1

- 触发：
  - 新会话 warmup：`1 → 2 → 4 → 5`
  - 稳定后每 5 个 user 轮触发
  - idle 240s 兜底
- 每批最多处理 10 条 L0。
- 积压会连续跑。
- 失败不会阻断对话，下轮重试。
- L1 内部去重。

### 4.3 L0.5 summary_tips

- 不是每轮自动写。
- Agent 完成明确任务/流程后，通过：

```text
POST <proxy>/memory-bridge/v3/tips/submit
```

- 提交条件由 `<summary_tips_contract>` 注入说明；动态提醒本身也自带三条提交条件，满足后必须立即主动提交。
- 中文提交必须使用 UTF-8 JSON 文件 + `curl --data-binary @file`；proxy 现在先读原始字节再严格 UTF-8 解码：
  - 严格 UTF-8 通过但 JSON 含 `U+FFFD` → `42201`；
  - UTF-8 失败但 GB18030 可解码 → `42202`，响应带 GB18030 解码预览，不落库、不自动转码；
  - 两种都失败 → `42203`。
- 状态：`pending → consuming → consumed | duplicate | expired`；L1 LLM 成功后消费，失败保持 pending。
- 动态提醒：每阶段首条 user 消息注入初始提醒；之后按 count1/count2 阈值、时间间隔或冷却触发；阶段内每次都要重新判断是否满足提交条件。
- 第三种触发：最后一条有效 User 消息的任意 text block 中包含 `<summary>...</summary>` 时，立即注入专门的上下文压缩摘要提醒，并重置该阶段 count1/count2/reminderCount（`lastReminderAt=now`）。
- 当前提醒配置（proxy `tips:`）：`maxReminderPerTask=50`、`firstUserReminder=true`、`count1Threshold=2`、`count2Threshold=2`、`timeReminderSeconds=480`、`reminderCooldownSeconds=600`、`sessionTtlSeconds=7200`。
- 提醒计数持久化在 proxy SQLite `tips_reminder_state`，跨进程重启保留；tip 提交成功后重置并进入下一阶段。
- 相同锚点 + 相同 summary 去重。

### 4.4 L2

chat / code v1 的 L2：

- L1 成功完成后 30s 触发
- 距上次 L2 至少 180s
- 每 600s 兜底扫描
- 3h 不活跃的 session 停止扫描
- 没有新增 L1 时跳过

code v2 的 L2（L2.5）：

- 不再在 L1 完成回调里直接调用 packager，统一由配置驱动的 L2 timer 触发（L1 完成 30s 后）。
- packager 实际执行条件：`lastL1UpdatedAt` 游标之后有新 L1，且距上次运行 ≥ 300s。
- 600s 周期兜底 timer 已携带 team/agent，可正确执行 packager 兜底检查。
- 不依赖 pending tips，也不再要求相同 tag 数量 / 不同 session 数量。
- LLM 只读取新 L1，合并相似内容，更新 topics；`executeL2` 对 code v2 直接执行 packager，不再假跳过。
- `maxTopics=15`（`MEMORY_PROJECT_MEMORY_MAX_TOPICS`）：同一主题只允许一个文件，默认 UPDATE/MERGE；达到上限必须先合并；被合并旧文件写 `[DELETED]` 后由工程代码清理。
- 历史教训：LLM 曾把文件写进 `project/topics/topics/*.md`，而列表只扫一级目录，导致 packager 看不到旧文件、把同一主题重复建成多个文件。现已自动扁平化并修复 MEMORY.md。

### 4.5 L3

chat / code v1 的 L3：

- L2 完成后排队检查
- 条件：
  - 首次有 scene 文件
  - 首个 scene block
  - 距上次 persona 的新 L1 记忆数 ≥ 10

code v2 的 L3：

- 不调 LLM
- topics 变化后由工程代码重建 `project/MEMORY.md`

---

## 5. 注入给 Agent 的上下文

### 5.0 注入模型：每请求动态组装，不会累积

- Claude Code 每一轮都会在本地重新构建自己的 system prompt，请求进入 proxy 后，proxy 在固定位置注入**一份** `<summary_tips_contract>`。
- 动态 `<system-reminder>` 按触发条件在 `user.before` 注入，每次请求重新判断。
- `cacheStrategy=session_init` 只表示同一会话内该静态块的内容固定不变，以便命中 prompt cache；**不是**把上一轮注入过的 prompt 存起来再拼到下一轮。
- 上游响应结束后，注入的 prompt 不会留在 Claude Code 本地，也不会被当成历史消息累积。
- 因此真正的 system prompt 中每个注入块最多一份，token 数量固定，不会因为压缩或长会话而滚雪球；`/compact` 也不会导致本系统提示词丢失。

### 5.1 当前会注入哪些块

- `<summary_tips_contract>`：静态契约，说明什么时候/怎么提交任务总结
- `<system-reminder>`：动态提醒，自带提交条件摘要，满足后必须立即提交
- `<note_tools>`：Team Notes 工具（写模式下含 note_delete，且要求 UTF-8/回读校验）
- `<tdai_memory_tools>`：L0/L1/L2 检索工具
- `<project-memory-tools-guide>`：project topics 使用说明
- `<tdai_project_memory>`：有索引时注入 MEMORY.md

### 5.2 OpenAI/Codex 工具兼容

- codebuddy/Codex 当前实际走 OpenAI `/v1/responses`；旧的 `/v1/chat/completions` 仍兼容。
- `/v1/chat/completions`：扁平 `{type,name,...}` 自动包装为标准 `{type:"function",function:{name,...}}`；完全缺 `name` 的工具会被剔除并打日志。
- `/v1/responses`：保持 Responses API 的扁平工具格式，只剔除无 `name` 的工具。
- 排查日志关键字：`[openai-tools] wrapped/removed`（chat）与 `[openai-tools] responses removed`（responses）。

### 5.3 职责区分

- 刚完成任务要沉淀成记忆 → `summary_tips`
- 团队共享文档/纪要 → `note_create`
- 查项目历史经验 → `project/*` 工具
- 查原始对话/L1 → `tdai_memory_search / tdai_conversation_search`

---

## 6. 存储与状态

- L0/L1：SQLite 主表 + JSONL 文件。
- L0.5：SQLite `summary_tips`（含 `l0_start_at/l0_end_at` 时间锚点）。
- L0.5 提醒状态：proxy SQLite `tips_reminder_state`。
- Proxy 注入给 Agent 的 curl 地址来自 `.env` 的 `MEMORY_PROXY_PUBLIC_BASE_URL`（当前 `http://127.0.0.1:8096`），跨机/公网部署时必须改成实际可达地址。
- chat L2/L3：`scene_blocks/`、`persona.md`。
- code v2：`project/topics/`、`project/MEMORY.md`、`project/.packager-state.json`（含 `lastL1UpdatedAt` L1 游标）。
  - packager 会把 LLM 误写到 `project/topics/topics/*.md` 的嵌套文件自动扁平化回 `project/topics/*.md`，并修复因此过期的 `project/MEMORY.md`。
  - topics 数量上限 `MEMORY_PROJECT_MEMORY_MAX_TOPICS=15`：默认 UPDATE/MERGE，同一主题只保留一个文件；被合并旧文件写 `[DELETED]` 后自动清理。
- 调度状态：`stateBackend=local`；运行中的定时器在内存，L1 游标/L2 时间等持久化到 checkpoint JSON。

---

## 7. 面板展示（2026-08-26 更新）

- L2 列表与详情会展示 topic frontmatter 的 `updated` 时间；L3 `project/MEMORY.md` 顶部包含生成时间。
- 注意：当前 hub 容器前端是 `docker cp` 热更新；执行 `start-memory-hub.sh` 重建容器后会回到旧镜像，需要重打 `agentmemory/memory-hub:local` 或重新热更新。
- chat 模式页：L0 / L1 / L2 / L3
- code 模式页：L0 / L0.5 / L1 / L2 / L3
- chat L1 只显示 `persona / episodic / instruction`
- code L1 只显示 `work_fact / work_task / work_method / work_artifact`
- code L2 显示 `project/topics/*.md`
- code L3 显示 `project/MEMORY.md`

---

## 8. 常见问题

1. L0 为空：
   - 检查 session 是否初始化成功，日志应出现 `preset hit`。
   - 若 `preset mismatch → bypass`，说明 team/agent/task 头不在当前用户可见范围。
2. L1 为空：
   - 先看 core 日志是“没触发”还是 `LLM extraction failed`。
   - 若是 LLM 失败，检查 `.env` 的 URL/KEY/模型。
3. chat/code L1 看起来一样：
   - 已修复；如果还一样，检查是否刷新了 hub 镜像。
4. Agent 不提交 summary_tips：
   - 检查 system prompt 是否出现 `<summary_tips_contract>`。
   - 检查注入的 curl 地址是否是 Agent 可访问的 `MEMORY_PROXY_PUBLIC_BASE_URL`；容器内网 IP（如 172.18.x.x）通常是错误 fallback。
   - 检查 proxy 日志 `summary-tips-reminder-injector` 的 `blockCount`；长期为 0 是触发条件问题，长期为 1 但没有 `tips-bridge` 调用是提示词/模型执行问题。
   - 新会话测试，不要复用旧 session 缓存。
5. code L2 面板只看到少数 topic：
   - 先确认文件是否被写进 `project/topics/topics/*.md` 嵌套目录（历史根因）。
   - 当前 project/list 会自动扁平化并重建 MEMORY.md，刷新面板即可；若仍少，检查 packager 日志是否报错。
6. Codex/codebuddy 报 `Missing required parameter: 'tools[i].name'`：
   - 这是上游不认扁平/缺名 tool，proxy 已自动修复或剔除坏 tool。
   - 看 proxy 日志 `[openai-tools]`，确认 index 对应的工具是被 wrapped 还是 removed。

---

## 9. L0 路由与真实 User/Assistant 抽取（Codex / Claude Code）

> 详细调研与文件索引见 `memory-agent/L0_ROUTING_AND_EXTRACTION.md`。本节只保留最终口径。

L0 只应记录：

- 真实用户输入（User）
- 模型给用户看的最终文本回答（Assistant）

不应记录：客户端内部请求、子代理/sidequery、tool_use/tool_call、tool_result 正文、system/注入块。

### 9.1 Codex / OpenAI

- 入口：`/v1/chat/completions` 或 `/v1/responses`（当前 Codex 实际走 responses）。
- Responses 请求会生成临时 `messages[]` 视图用于 session/injection/L0 抽取；注入完成后合并回 `instructions` 和原始 `input[]`，上游仍转发 `/responses`。
- User 抽取：`codebuddyAdapter` + `extractUserQueryText()`，取最后一条有效 User。
- Assistant 抽取：chat 格式取 `choices[0].delta.content`；responses 格式取 `response.output_text.delta`。
- Codex 内部请求过滤三层：
  1. 旧版 guard 精确 JSON `{"outcome":"allow"|"deny"}`；
  2. 新版 guard JSON（含 `risk_level` / `user_authorization` / `outcome`）；
  3. 配置前缀 `codexInternal.promptPrefixes`（标题生成、安全审批 transcript）。

### 9.2 Claude Code / Anthropic

- 入口：`/v1/messages`。
- 请求三分类：`main` / `fork` / `sidequery`，依据 `cache_control` 位置、`tools`、`thinking`。
- 只有 `main` 写 L0 和 skill buffer；`fork`/`sidequery` 不写 L0。
- User 抽取：`claudeCodeAdapter` 只取最后一个 `text` block，再经 `extractUserQueryText()` 剥离 harness wrapper。
- Assistant 抽取：Anthropic SSE `content_block_delta.text_delta`；tool_use 只计数，不写 L0。

### 9.3 当前缺口

- **Claude Code WebSearch 内部请求仍可能污染 L0**：曾出现 `Perform a web search for the query: ...`。已确认与 WebSearch 工具调用相关，但尚未抓到原始请求 body 确认其 main/fork/sidequery 归属。
- **不采用工具专属正则**：`Perform a web search for the query:` 这类规则换工具就失效；后续应从请求结构/子代理分类层面做通用识别。
- **Codex 前缀过滤的边界**：配置中的内部 prompt 前缀是稳定系统提示词，因此可配置化；真实用户消息不要以这些前缀开头。
