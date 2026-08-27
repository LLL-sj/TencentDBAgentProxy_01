# 新 Agent 工作交接（TencentDB-Agent-Memory · 第七轮 · L0/L0.5/L1/L2 调研结论与待修复任务）

> 本文件是第七轮交接。**第八轮已完成 §3 验证并已按 §4 实施 A–E；实施记录与运行时验证见 §4.8。**
> 新 Agent 的任务不是重新调研，而是：**先读 §4.8 的实施结果，再按 §6 继续维护。**
> 先读本文件，再按 §2 的文件索引按需深入，不需要全文通读仓库。
> 历史背景以 `NEW_AGENT_HANDOFF6.md` 和 `FINAL.md` 为准。

---

## 0. 当前现场快照

- 仓库：
  - Linux：`/home/luuu/Desktop/TencentDB-Agent-Memory`
  - Windows：`\\wsl.localhost\Ubuntu-24.04\home\luuu\Desktop\TencentDB-Agent-Memory`
- Git：分支 `feat/server_team`，HEAD `fe3230f`
- `git status --short` 约 101 项未提交改动；**没有用户指示前不要 git commit**
- 三容器当前 healthy（第八轮修复后已重启）：
  - `tdai-memory-core`：8420
  - `tdai-memory-hub`：8125 + 8424
  - `tdai-proxy`：8096
- 当前 `.env` 关键值：
  ```env
  MEMORY_PROMPT_MODE=code
  MEMORY_CODE_MEMORY_VERSION=v2
  MEMORY_PROJECT_MEMORY_ENABLED=true
  MEMORY_SESSION_ACTIVE_WINDOW_HOURS=3

  MEMORY_LLM_BASE_URL=https://api.zhongjx.xyz/v1
  MEMORY_LLM_MODEL=gpt-5.6-luna
  MEMORY_LLM_PROTOCOL=openai

  PROXY_UPSTREAM_URL=https://api.zhongjx.xyz/v1
  PROXY_UPSTREAM_MODEL=gpt-5.6-luna
  ```
- 本轮未改代码；上一轮改过的只有 `.env` 和文档。
- 所以新 Agent **不要假设下面的问题已经被修复**，先按 §5 的清单逐条验证 §3 的结论，再决定是否按 §4 实施。

---

## 1. 本轮调研结论摘要（新 Agent 先验证这些）

用一句话说：

> code v2 下，L1 已经有大量记录，但当前目标团队/Agent 的 L2 为空；根因是 L0.5 未被可靠触发，而 L2 又被错误地硬绑定在 L0.5 上。

已形成的三个核心结论：

1. **L0 + L0.5 应该作为一条按时间排序的输入流，不重复、不丢失地喂给 L1；当前实现做不到。**
2. **L2 应该只消费 L1，不再依赖 L0.5；当前 packager 错误地以 pending tips 为硬门槛。**
3. **L0.5 提醒机制需要重新设计：可靠触发、短提醒、可配置、跨服务重启有效。**

新 Agent 要做的是：

1. 先验证上面三个结论以及 §3 的细节是否成立；
2. 结论不成立的地方先修正结论，再继续；
3. 结论成立后，按 §4 的实施任务改代码。

---

## 2. 必须先读的文件索引

### 2.1 总览与索引

| 文件 | 读它干什么 |
|---|---|
| `AGENT_INDEX.md` | 项目文件快速定位索引；改完代码后要同步维护它 |
| `memory-agent/FINAL.md` | 最终交接口径、当前部署快照、已知问题 |
| `memory-agent/NEW_AGENT_HANDOFF6.md` | 第六轮总交接；Phase 1–6 已完成的内容 |
| `memory-agent/MEMORY_MECHANISM.md` | L0/L0.5/L1/L2/L3 机制说明与排查方法 |
| `memory-agent/05_TeamNotes_CodeMemoryV2_目标与计划.md` | Code Memory v2 的分阶段设计意图 |
| `memory-agent/TEAM_NOTES.md` | Team Notes 设计，和 summary_tips 容易混淆，必须分清 |

### 2.2 L0 / L0.5 / L1 加载与消费

| 文件 | 重点看什么 |
|---|---|
| `MemoryCore/src/utils/pipeline-factory.ts` | L0 游标、L1 批大小、同毫秒边界扩展、project packager 调用位置 |
| `MemoryCore/src/core/record/l1-extractor.ts` | L1 v2 如何读取 pending tips、如何调 LLM、成功/失败后的返回 |
| `MemoryCore/src/core/prompts/code-v2/l1-extraction-with-tips.ts` | `<SUMMARY_TIP>` 如何插入 L0 流；当前提示词对 L0.5 的约束 |
| `MemoryCore/src/core/tips/summary-tips.ts` | summary_tips 表结构、submit 锚点解析、status 生命周期 |
| `MemoryCore/src/core/store/sqlite.ts` | L0 查询 SQL：`queryL0ForL1` / `queryL0GroupedBySessionId` |
| `MemoryCore/src/gateway/v2-router.ts` | `/v3/tips/submit|list|get` 和 project memory 路由 |

### 2.3 L2 / Project Memory

| 文件 | 重点看什么 |
|---|---|
| `MemoryCore/src/utils/project-memory-packager.ts` | 当前 packager 的触发条件、tips 硬门槛、`queryRecentL1`、状态落盘 |
| `MemoryCore/src/core/prompts/code-v2/l2-project-packager.ts` | L2 packager 的 system/user prompt，当前同时接收 tips + L1 |
| `MemoryCore/src/gateway/server.ts` | `executeL2` 中 code v2 直接 skip L2 的错误逻辑 |
| `MemoryCore/src/services/pipeline-worker.ts` | L1 完成后的 L2 timer 级联调度 |

### 2.4 Proxy 侧 L0.5 提醒与提交

| 文件 | 重点看什么 |
|---|---|
| `MemoryProxy/src/injection/injectors/summary-tips-contract-injector.ts` | 静态契约、动态提醒、`lastAssistantIsFinal` 判断 |
| `MemoryProxy/src/tips-bridge.ts` | Agent 提交 summary_tips 的 bridge、默认身份/锚点处理 |
| `MemoryProxy/src/injection/index.ts` | summary-tips 两个 injector 的注册和配置来源 |
| `MemoryProxy/src/injection/pipeline.ts` | 注入点顺序：`system.before_tools` / `user.before` 等 |
| `MemoryProxy/src/injection/adapters/anthropic.ts` | Claude Code 消息 blocks 如何解析（用于判断 final turn） |
| `MemoryProxy/src/config.ts` + `MemoryProxy/src/types.ts` | `tips` 配置段当前有哪些参数 |

### 2.5 部署与配置

| 文件 | 重点看什么 |
|---|---|
| `deploy/global-images/.env` | 实际生效配置；新增参数应该从这里开始 |
| `deploy/global-images/start-proxy.sh` | proxy `config.yaml` 生成逻辑；新配置要写进 `tips:` 段 |
| `deploy/global-images/start-memory-core.sh` | core gateway 配置生成逻辑 |
| `deploy/global-images/.env.example` | 新参数模板说明 |

---

## 3. 调研结果（每一条都需要新 Agent 验证合理性）

### 3.1 code v2 下目标团队 L2 为什么一条都没有

日志同时出现两句互相矛盾的话：

```text
Project packager team=... ran=false reason=no pending tips
L2 skipped for code v2 session ...; project packager already ran after L1
```

代码事实：

1. `.env` 里 `MEMORY_CODE_MEMORY_VERSION=v2`。
2. `gateway/server.ts` 的 `executeL2` 对 `code + v2` **无条件跳过经典 L2**，并假设 packager 已经在 L1 后运行。
3. `project-memory-packager.ts` 开头有硬门槛：

```ts
if (pending.length === 0) return reason(false, "no pending tips");
```

4. 当前目标团队/Agent 没有 pending tips，所以 packager 从未运行。
5. 结论：L1 正常产出，但 L2 的经典路径被跳过，v2 替代路径又没触发，所以 L2 为空。

### 3.2 为什么目标 Agent 一直不提交 L0.5

Proxy 日志里：

- `<summary_tips_contract>` 静态契约：**每次请求都成功注入**；
- 动态 `<system-reminder>`：长期只有 1 次真正注入，其余 `blockCount=0`；
- 当前会话的 `/memory-bridge/v3/tips/submit`：**0 次调用**。

原因定位：

```ts
function lastAssistantIsFinal(ctx: AgentContext): boolean {
  ...
  return !asst.blocks.some((b) => b.type === "tool_use");
}
```

这个判断要求最后一个 assistant 消息里“完全没有任何 tool_use”。Claude Code 的 tool 循环中，assistant 消息经常是 `text + tool_use`，因此大量轮次被判为“不是 final”，动态提醒不注入。

补充事实：

- `summary_tips` 表里只有 3 条旧 tip，全部来自 2026-08-20 的另一个 session，状态 `consumed`；
- 当前大量 L1 的 team/agent/session 一条 tip 都没有。

### 3.3 当前 L0/L0.5 加载方式的漏洞

#### L0 侧

- L1 runner 查询 20 条，处理前 10 条。
- 如果第 10 条和第 11 条同毫秒，会扩展处理超过 10 条。
- 但 `extractL1Memories` 内部又把最后 10 条当“新消息”，多出来的会变成“背景消息”。
- 背景消息不允许提取，而 cursor 已经推进，因此同毫秒扩展出来的消息可能被永久跳过。

#### L0.5 侧

- 每次 L1 都读取该 scope 的**全部 pending tips**。
- tip 按 `l0_end_ref` 插入；锚点不在当前批次时，当前实现会**追加到末尾**。
- L1 完成后 tip 仍保持 `pending`；只有 packager 成功后才标记 `consumed`。
- 所以同一个 tip 可能被后续 L1 反复加载、错位加载，或者因为锚点过期而失去作用。

#### 提交锚点

- Agent 提交 tip 时不带 refs，默认锚定 `last_turn`，只覆盖最后两条 L0 消息（不是严格意义的两轮）。
- 如果改成“阶段结束后再提交”，这个默认锚点是错误的，必须改为后端自动计算范围。

### 3.4 提示词边界结论

- chat / code 的记忆边界清晰：一个侧重用户画像，一个侧重项目内容。
- L1 → L2 → L3 的蒸馏关系明确：
  - chat：L1 会话级原子记忆 → L2 去重场景记忆 → L3 用户画像。
  - code v2：L0 会话原文 + L0.5 任务总结 → L1 会话级工作记忆 → L2 项目级 `project/topics/*.md` → L3 `project/MEMORY.md` 索引。
- 当前 code v2 的主要设计错误：L2 错误地依赖 L0.5，且 packager 把 tips 和 L1 同时当输入。

### 3.5 Windows 编码问题

- 这是**目标 Agent 在 Windows Git Bash 用 curl 发中文 JSON** 导致的编码问题，不是后台 Agent 的问题。
- 不需要改后台编码逻辑。
- 只需要在 `<note_tools>` 注入文案里加一句提醒：UTF-8、写后回读校验、发现乱码用 `note_delete` 删除重建。

---

## 4. 验证结论后的实施任务

> 以下均未实现。新 Agent 必须先完成 §3 的结论验证，确认合理后再动手。

### 4.1 任务 A：L0 + L0.5 统一成按时间排序的输入流

目标：

```text
L0 和 L0.5 按时间排序，合并成一条流；
每条 L0 / 每条 L0.5 最多被 L1 消费一次；
不重复、不丢失、不追加到错误位置。
```

要改的点：

1. L0 同毫秒扩展不能丢消息：
   - 方案 A：本批实际处理多少条，`maxMessagesPerExtraction` 就临时扩到多少条。
   - 方案 B：游标升级为 `(recorded_at, record_id)` 复合游标，彻底消除同毫秒边界问题。
   - 建议先实现 A，评估后再做 B。

2. L0.5 按时间定位：
   - `summary_tips` 增加 `l0_start_at` / `l0_end_at`。
   - 提交 tip 时后端自动解析并保存这两个时间。
   - L1 构建 prompt 时按 `l0_end_at` 与当前 L0 批次的时间范围比较。

3. tip 消费规则：

```text
tip 时间在当前批次内
  → 插到最后一个 timestamp <= tip.l0_end_at 的 L0 之后

tip 时间在当前批次之前（迟到的 tip）
  → 仍要消费；放在当前批次最前面
  → 提示词允许以 tip 为主进行提取

tip 时间在当前批次之后
  → 本轮不注入，保持 pending
```

4. tip 状态：

```text
L1 LLM 调用成功后，本批注入的 tip 全部标记 consumed
L1 LLM 调用失败，tip 保持 pending
不再由 packager 标记 tips
```

5. 删除“锚点不匹配就追加到末尾”的旧逻辑。

### 4.2 任务 B：放宽 L1 v2 提示词对 L0.5 的约束

当前提示词把 L0.5 定义为“只能提高优先级，不能作为独立事实”，L0 截断时 tip 会失去作用。

改为：

```text
L0.5 是 Agent 对一段 L0 的高质量压缩总结，默认可信。

L0 完整可见时：
  - L0 为主，L0.5 用于确认重点和补全归纳

L0 不完整、已被截断或已经消费过时：
  - 可以直接以 L0.5 为主提取
  - source_refs 使用 tip_id
  - confidence 给 0.8-0.95

只有 L0 和 L0.5 直接冲突时，才以 L0 为准
```

### 4.3 任务 C：L2 只消费 L1

1. `runProjectMemoryPackager`：
   - 删除 `if (pending.length === 0) return no pending tips`。
   - 改为查询 `lastRunAt` 之后的新 L1。
   - prompt 只接收 L1，不再接收 tips。
2. `.packager-state.json` 的 `lastRunAt` 作为 L1 查询游标。
3. `gateway/server.ts`：
   - 修正 code v2 下 L2 skip 的语义，只有 packager 真正运行过才允许 skip。
   - 或者把 v2 的 L2 task 改为直接执行 packager。
4. tips 的使命在 L1 完成时结束，不再参与 L2。

### 4.4 任务 D：L0.5 提醒机制

#### 4.4.1 静态契约

`<summary_tips_contract>` 要写清楚完整标准：

- 什么算可复用阶段成果；
- 什么时候提交；
- 什么时候不提交；
- 满足条件后要主动执行提交；
- 长任务可以分多个小阶段提交。

#### 4.4.2 动态提醒

- 控制在 50 token 内。
- 不要写“自上次总结以来”。
- 建议文案：

```text
<system-reminder>
如果当前阶段已经形成可复用的成果，请按 summary_tips_contract 提交；否则忽略。
</system-reminder>
```

#### 4.4.3 触发条件

```text
count1 = 最后一条 assistant 消息，最后一个有效 block 是 text 的次数
count2 = count1 成立，且之后没有未完成 tool_use 的次数
```

触发规则：

```text
1. 每个活跃阶段的第一条 user 消息，注入一次初始提醒。
   不是“会话初始化”，旧会话再次活跃时也要对最新 user 注入。

2. 之后满足任一条件就注入：
   - count2 增量 >= count2Threshold
   - count1 增量 >= count1Threshold
   - 距上次提醒超过 timeReminderSeconds，且 count1 有新增

3. 保留 cooldown。

4. 成功提交 tip 后：
   - count1 / count2 清零
   - 进入下一阶段
```

#### 4.4.4 配置化

所有参数写入配置，不要硬编码：

```text
firstUserReminder
count1Threshold
count2Threshold
timeReminderSeconds
reminderCooldownSeconds
sessionTtlSeconds
```

建议先在 `deploy/global-images/.env` 定义，再由 `start-proxy.sh` 生成到 proxy `tips:` 段。

#### 4.4.5 会话过期

- 不能依赖 proxy 进程重启。
- 状态需要持久化，并记录 `lastActiveAt`。
- 超过 `sessionTtlSeconds`（默认对齐 `MEMORY_SESSION_ACTIVE_WINDOW_HOURS=3`）视为新活跃阶段。
- 过期后系统提示词不能补加（系统提示词只在会话初始化时注入），动态提醒如何处理过期需要和用户确认后实现。

### 4.5 任务 E：Team Notes 编码提醒

在 `note-tools-injector.ts` 中：

1. 加一句：

```text
创建/更新笔记前请确保请求体为 UTF-8 编码；完成后用 note_get 回读校验，发现乱码先用 note_delete 删除后重新创建。
```

2. 在 `<note_tools>` 中补上 `note_delete` 工具说明。

---

### 4.6 第八轮验证结论（2026-08-21 已完成；代码仍未修改）

验证方式：源码逐处核对 + `docker logs` + `vectors.db`（L0/L1/tips）+ `profiles` 产物检查。验证当时三容器 healthy。

- [x] **§3.1 成立（需限定范围）**
  - 日志实测：`ran=false reason=no pending tips` 10 次，`L2 skipped for code v2` 9 次。
  - 代码确认：`gateway/server.ts` 对 code+v2 无条件跳过经典 L2；`project-memory-packager.ts` 有 `pending.length === 0` 硬门槛。
  - 数据确认：目标团队 `team-d7xz528cuo` 已有 19 条 L1，但 0 条 pending tip、0 个 `project/*` 产物，根因成立。
  - **口径修正**：“L2 为空”只对当前目标团队成立。老团队 `team-ceynoshv7x` 因 8-20 有 3 条 tip，已生成过 topics/MEMORY.md，并非全库从未生成过 L2。

- [x] **§3.2 基本成立（归因需弱化）**
  - 日志实测：静态契约在已完成请求管线中 37/37 次 `blockCount=1`；动态提醒 37 次中 36 次 `blockCount=0`、1 次 `blockCount=1`；`tips-bridge/tip_bytes` 0 次。
  - 代码确认：`lastAssistantIsFinal` 要求最后一个 assistant 消息完全不含 `tool_use`。
  - **口径修正**：日志没有记录每次 `blockCount=0` 命中的具体分支，因此不能断言 36 次全部是 `tool_use` 导致。更严谨表述：触发条件过严 + 无首轮提醒/阶段计数/持久化，`tool_use` 判断是主要原因之一；这也正是 §4.4 要重设计的原因。

- [x] **§3.3 成立（两处细化）**
  - L0：查询 20 条、处理前 10 条、同毫秒扩展后 cursor 按最大 `recordedAtMs` 推进；`extractL1Memories` 默认 `maxMessagesPerExtraction=10`、`maxBackgroundMessages=5`，扩展消息只能成为背景或完全不进入窗口，存在永久跳过风险。源码 TODO 也承认需复合游标。
  - **细化 1**：若同毫秒扩展超过 15 条，多出消息既不是新消息也不在背景窗口，风险比“只变成背景消息”更严重；当前 DB 目标团队无同毫秒冲突，目前是隐患、尚未实际发生。
  - L0.5：锚点不在当前批次会追加到末尾；L1 成功后 tip 仍 pending；只有 packager 成功后 consumed，均已确认。
  - **细化 2**：默认 `last_turn` 锚点实际取“最后两条 L0 消息”（`rows[-2]` / `rows[-1]`），不是严格意义的“最后两轮”。
  - **补充发现**：`SummaryTipsStore.list` 未按 `agent_id` 过滤，存在同 team 同 session 跨 agent 读取 pending tip 的隐患，实施 A 时应一并修复。

- [x] **§3.4 成立**
  - chat/code 的 L1 提示词与类型分离、chat 走 persona/episodic/instruction、code v2 走 work_* 与 project topics、v2 的 L3 由代码生成 MEMORY.md，均与代码一致。

- [x] **§3.5 基本成立（来源只能侧面印证）**
  - DB 中 3 条旧 tip 有 1 条中文 summary 为 `�` 乱码，另两条正常；bridge 按 UTF-8 解析，符合“客户端提交非 UTF-8 字节”的特征。
  - “具体是 Windows Git Bash curl”无法从仓库/日志直接证明，但结论方向正确；`note-tools-injector` 确实缺少 UTF-8 提醒和 `note_delete` 说明，且 notes-bridge 已支持 `/delete`，任务 E 可实施。

- **额外发现（应纳入实施）**
  - `projectMemory.minPendingTips / minDistinctSessions / packagerMaxIntervalSeconds` 已配置但 packager 未使用，当前触发只看 pending tips 和最小间隔。
  - `queryRecentL1` 固定取最近 60 条 L1，没有按 `lastRunAt` 游标，与 §4.3 修改方向一致。

---

### 4.7 实施思路（按 A→E 落地；已实施完成）

总原则：只改源码与启动配置，不 git commit；core/proxy 有源码挂载，改完分别重启验证；验证通过后更新 `AGENT_INDEX.md` / `FINAL.md` / `MEMORY_MECHANISM.md` / 本文件状态。

### A. L0 + L0.5 统一输入流（先做，依赖面最大）

1. **L0 同毫秒不丢消息（短期方案）**
   - 文件：`MemoryCore/src/utils/pipeline-factory.ts`
   - 在 `createL1Runner` 按 group 调用 `extractL1Memories` 时传 `maxMessagesPerExtraction: Math.max(10, group.messages.length)`，保证本批扩展进来的消息全部按“新消息”进入 LLM。
   - 保留源码 TODO；复合游标 `(recorded_at, record_id)` 作为后续第二阶段，不在本轮强制做。

2. **summary_tips 增加时间锚点**
   - 文件：`MemoryCore/src/core/tips/summary-tips.ts`
   - 表结构新增 `l0_start_at INTEGER`、`l0_end_at INTEGER`（毫秒）；`ensureSummaryTipsSchema` 用 `PRAGMA table_info` 做幂等 ALTER TABLE 迁移，兼容存量 3 条旧 tip（旧数据时间留空，按“迟到 tip”处理）。
   - `submit()` 解析 refs 时同时保存起止消息的 `timestamp`；`SummaryTipDetail` 和 prompt item 增加对应字段。
   - 顺手修复 `list()` 支持按 `agentId` 过滤，L1 加载时同时按 team/agent/session/task 过滤。

3. **L0.5 按时间定位与消费**
   - 文件：`MemoryCore/src/core/record/l1-extractor.ts`、`MemoryCore/src/core/prompts/code-v2/l1-extraction-with-tips.ts`
   - 计算本批新消息时间范围：
     - tip 时间在当前批次内 → 插到最后一个 `timestamp <= tip.l0_end_at` 的 L0 之后（ref 命中时优先按 ref）；
     - tip 时间在当前批次之前（迟到 tip）→ 放在新消息流最前面，提示词允许以 tip 为主提取；
     - tip 时间在当前批次之后 → 本轮不注入，保持 pending。
   - 删除“锚点不匹配就追加到末尾”的旧逻辑。
   - L1 LLM 调用成功后，**只把本批实际注入的 tip** 标记 `consumed`；调用失败保持 `pending`；空提取但 LLM 调用成功也按成功消费（与 §4.1 口径一致，实现时用日志明确记录）。
   - `project-memory-packager.ts` 不再标记任何 tip。

4. **测试**
   - 新增/更新 `MemoryCore` 单测：同毫秒 >10 条不丢；tip 三种时间位置；L1 成功/失败后 tip 状态。

### B. 放宽 L1 v2 提示词对 L0.5 的约束

1. 文件：`MemoryCore/src/core/prompts/code-v2/l1-extraction-with-tips.ts`
   - 按 §4.2 修改 system prompt 核心优先级规则：L0.5 默认可信；L0 完整时 L0 为主、L0.5 确认/补全；L0 不完整/已截断/已消费过时可直接以 L0.5 为主，`source_refs` 用 `tip_id`、confidence 0.8-0.95；仅直接冲突时以 L0 为准。
2. 文件：`MemoryCore/src/config.ts`、`deploy/global-images/start-memory-core.sh`、`deploy/global-images/.memory-core-config/tdai-gateway.yaml`、`.env.example`
   - 同步更新默认 `summaryTipRuleText` 和实际生成配置，避免“改了代码默认值、线上配置仍旧约束”的偏差；v1 路径保持不变。

### C. L2 只消费 L1

1. 文件：`MemoryCore/src/utils/project-memory-packager.ts`、`MemoryCore/src/core/prompts/code-v2/l2-project-packager.ts`
   - 删除 `pending tips` 硬门槛和 tipsStore 依赖；触发条件改为：`projectMemory.enabled=true`、有 LLM runner、`lastRunAt` 之后存在新 L1。
   - prompt 只接收 L1；system prompt 的 sources 改为 `l1_*`，移除“tip 支撑”表述。
   - `.packager-state.json` 的 `lastRunAt` 作为 L1 查询游标；建议同时记录 `lastL1UpdatedAt`，查询用严格 `updated_time >` 避免边界重复/丢失。
2. 文件：`MemoryCore/src/core/store/types.ts`、`store/sqlite.ts`
   - 增加按 `(team_id, agent_id, updated_time)` 严格游标查询新 L1 的方法；SQLite 是当前部署路径，TCVDB 给出同接口实现或安全空实现。
3. 文件：`MemoryCore/src/gateway/server.ts`、`MemoryCore/src/core/tdai-core.ts`
   - code+v2 的 `executeL2` 不再无条件 skip，改为调用 `runProjectMemoryPackager`（新增 core 层入口，复用 team/agent 计算 scoped dataDir/storage）；只有确认“无新 L1”才标 `_l2Skipped`。
   - 保留 L1 完成后立即尝试 packager 的快路径，两次调用之间由 minInterval/无新 L1 自然去重。
4. **测试**：packager 无 tips 但有新 L1 时运行并写 topics；无新 L1 时返回 no new L1；tips 不再被消费。

### D. L0.5 提醒机制重设计

1. 文件：`MemoryProxy/src/types.ts`、`config.ts`、`injection/injectors/summary-tips-contract-injector.ts`
   - 新增配置：`firstUserReminder`、`count1Threshold`、`count2Threshold`、`timeReminderSeconds`、`sessionTtlSeconds`（保留 `reminderEnabled`、`reminderCooldownSeconds`、`maxReminderPerTask` 兼容旧配置）。
   - 触发逻辑按 §4.4.3 实现：
     - count1 = 最后一条 assistant 消息的最后一个有效 block 是 text；
     - count2 = count1 成立且该 assistant 之后没有未完成 `tool_use`；
     - 每阶段第一条 user 消息注入初始提醒；之后按 count1/count2 增量或超时触发；保留 cooldown。
   - 动态提醒文案缩短到 50 token 内，不写“自上次总结以来”。
2. 文件：`MemoryProxy/src/db/schema.ts` + 新增 `MemoryProxy/src/db/tips-reminder-repo.ts`（或等价 repo）
   - 新增 `tips_reminder_state` 表：`state_key`、`count1`、`count2`、`last_reminder_at`、`last_active_at`、`stage_started_at`、`updated_at`；proxy 单机 SQLite 持久化即可跨进程重启，`getDb()===null` 时降级内存。
   - `state_key` 用 `spaceId/userId/agentSource/sessionId/taskId` 组合，避免跨会话串状态。
3. 文件：`MemoryProxy/src/tips-bridge.ts`
   - 上游 `/v3/tips/submit` 返回成功后，调用 repo 重置 count1/count2 并进入下一阶段。
4. 文件：`deploy/global-images/start-proxy.sh`、`.env`、`.env.example`
   - 生成新 `tips:` 配置；默认：`firstUserReminder=true`、`count1Threshold=3`、`count2Threshold=2`、`timeReminderSeconds=600`、`reminderCooldownSeconds=900`、`sessionTtlSeconds=10800`（对齐 `MEMORY_SESSION_ACTIVE_WINDOW_HOURS=3`）。
5. **待用户确认点**：会话过期后静态契约无法补注入，动态提醒引用契约可能失效；实现时先采用“过期只重置计数，提醒文案自带一句提交条件摘要”的保守方案，验证后再决定是否改静态缓存策略。
6. **测试**：注入决策单测；提交成功重置；repo 写入后进程重启可恢复。

### E. Team Notes 编码提醒

1. 文件：`MemoryProxy/src/injection/injectors/note-tools-injector.ts`
   - 增加 UTF-8 与回读校验提醒（§4.5 文案）。
   - 在 `allowLlmWrite=true` 时补充 `note_delete` 工具说明：`path=/notes-bridge/v3/notes/delete`，`body={"note_id":"note-xxx","expected_version":1}`。
2. **测试**：渲染快照测试，确认只读模式仍不出现写工具、写模式出现 note_delete 且 UTF-8 提示存在。

### 实施后验证与重启

1. 单测：`cd MemoryCore && npm test`；`cd MemoryProxy && npm test`。
2. 静态检查：`npx tsc --noEmit`（或仓库既有构建命令）确认无类型错误。
3. 重启顺序：按改动范围 `./start-all.sh` 或 core/proxy 分别重启；重启后确认三容器 healthy。
4. 运行时验证：
   - 新产生 pending tip → L1 注入一次并 consumed，不再进 L2；
   - 无新 tip 但已有 L1 的 team/agent → packager 首次运行处理积压 L1、生成 topics/MEMORY.md；
   - code v2 的 `executeL2` 日志不再出现“packager already ran”的假跳过；
   - proxy 动态提醒按新阈值触发，重启 proxy 后计数不丢失。
5. 文档同步：`AGENT_INDEX.md`、`FINAL.md`、`MEMORY_MECHANISM.md` 与本文件 §3/§4 状态。

### 4.8 第八轮实施完成记录（2026-08-21 已实施并验证）

**代码与配置改动**
- A（L0+L0.5 统一输入流）：
  - `MemoryCore/src/utils/pipeline-factory.ts`：L1 批扩展时按 `group.messages.length` 传 `maxMessagesPerExtraction`，同毫秒扩展不再降级为背景。
  - `MemoryCore/src/core/tips/summary-tips.ts`：`summary_tips` 新增 `l0_start_at` / `l0_end_at`（毫秒），`ensureSummaryTipsSchema` 幂等 ALTER TABLE 迁移；`submit` 写入时间锚点；`list` 支持 `agentId` 过滤。
  - `MemoryCore/src/core/record/l1-extractor.ts` + `code-v2/l1-extraction-with-tips.ts`：pending tips 按时间分区（批内按时间插入 / 迟到置顶 / 未来暂缓），删除“锚点不匹配追加末尾”；L1 LLM 成功后只消费本批实际注入的 tip，失败保持 pending。
  - `MemoryCore/src/core/store/sqlite.ts`：store 初始化时执行 `ensureSummaryTipsSchema`，重启即迁移。
- B（放宽 L1 v2 提示词）：
  - `code-v2/l1-extraction-with-tips.ts` 按 §4.2 更新核心优先级、source_refs/confidence 规则与默认 `summaryTipRuleText`。
  - `deploy/global-images/start-memory-core.sh` / `.memory-core-config/tdai-gateway.yaml` / `.env.example` 同步更新线上配置。
- C（L2 只消费 L1）：
  - `MemoryCore/src/utils/project-memory-packager.ts`：删除 tips 硬门槛和 tipsStore 依赖；改为读取 `.packager-state.json` 的 `lastL1UpdatedAt` 严格游标查询新 L1；prompt 只接收 L1。
  - `MemoryCore/src/core/prompts/code-v2/l2-project-packager.ts`：sources 改为 `l1_xxx`，L1 行带 `record_id`。
  - `MemoryCore/src/gateway/server.ts` + `tdai-core.ts`：code v2 的 `executeL2` 不再假 skip，直接执行 project packager；仅“无新 L1”才标 `_l2Skipped`。
- D（L0.5 提醒机制）：
  - `MemoryProxy` 新增 `tips.` 配置：`firstUserReminder`、`count1Threshold`、`count2Threshold`、`timeReminderSeconds`、`sessionTtlSeconds`。
  - 新增 `MemoryProxy/src/db/tips-reminder-repo.ts` + `schema.ts` 的 `tips_reminder_state` 表：count1/count2/reminder_count/last_reminder_at/last_active_at/stage_started_at 持久化，跨 proxy 重启保留。
  - `summary-tips-contract-injector.ts`：静态契约补齐“满足条件主动提交、长任务分阶段”；动态提醒改为 count1/count2 阈值 + 首轮提醒 + 时间提醒 + 冷却 + TTL；契约不在上下文时注入自包含提交说明。
  - `tips-bridge.ts`：tip 提交成功后重置当前阶段计数。
  - `start-proxy.sh` / `.env` / `.env.example` / `.proxy-config/config.yaml`：生成并挂载新配置、新 repo、新 schema。
- E（Team Notes 编码）：
  - `note-tools-injector.ts` 增加 UTF-8/回读校验提醒，`allowLlmWrite=true` 时补充 `note_delete` 工具说明。

**验证结果**
- `MemoryCore` 单测 25/25 通过；`npx tsdown --no-write` 通过；`MemoryProxy` `tsc --noEmit` 通过。
- 三容器重启后 healthy。
- E2E 1（无 tips 的 L2）：向目标 session `8a2dbcca-8a2f-4864-ad41-4f6d23803faa` 写入 1 条验证消息 → L1 完成后日志 `Packager ready ... newL1=21 trigger=new-l1` → `Packaging complete ... topics=3`，生成：
  - `project/topics/agent-execution-rules.md`
  - `project/topics/collab-platform-config.md`
  - `project/topics/windows-chinese-http-encoding.md`
  - `project/MEMORY.md`、`project/.packager-state.json`
- E2E 2（L0.5 时间锚点与消费）：提交 tip `tip-511a94eb2102451b`（`l0_start_at=1787297582388`、`l0_end_at=1787333510136`）→ 再写入 1 条验证消息触发 L1 → 日志 `Loaded 1 pending summary tip(s), selected=1` → `Marked injected summary tip consumed` → DB status `consumed`。
- E2E 3（executeL2）：日志 `L2 code v2 project packager ... skipped=true reason=no new L1 records`，不再出现旧的假跳过文案。
- 说明：上述 2 条 E2E 验证消息及对应 L1/L2 数据**有意保留在库中**，作为修复证据；如需清理再另行处理。
- 仍未 git commit；所有改动保持工作区未提交状态。

---

## 5. 结论验证与复现方法

新 Agent 至少逐条完成以下验证，确认 §3 的结论是否合理：

- [x] 3.1：日志中同时存在 `ran=false reason=no pending tips` 和 `L2 skipped for code v2`，并且代码路径确实如此。
- [x] 3.2：静态契约持续注入，但动态提醒长期 `blockCount=0`，且 `lastAssistantIsFinal` 的 `tool_use` 判断确实导致该结果。
- [x] 3.3：L0 批处理存在“同毫秒扩展后部分消息变背景消息”的跳过风险；tip 未按时间插入、未在 L1 后标记 consumed，存在重复加载/错位风险。
- [x] 3.4：chat/code 边界和 L1→L2→L3 蒸馏关系与代码中的实际设计一致。
- [x] 3.5：编码问题来自目标 Agent 的 Windows 终端调用，而非后台链路。

### 5.1 验证 L2 为空的根因

```bash
docker logs tdai-memory-core 2>&1 | grep -E 'Project packager|L2 skipped for code v2'
```

修复前会看到：

```text
Project packager ... ran=false reason=no pending tips
L2 skipped for code v2 session ...
```

修复后应看到：

```text
Project packager ... newL1=N trigger=new-l1
Packaging complete ... topics=...
L2 code v2 project packager ... skipped=true reason=no new L1 records
```

### 5.2 检查 tips 是否触发

```bash
docker logs tdai-proxy 2>&1 | grep 'summary-tips-reminder-injector'
docker logs tdai-proxy 2>&1 | grep -E 'tips-bridge|tip_bytes'
```

关注：

- `blockCount=0` 的占比；
- 是否有 `/v3/tips/submit` 调用。

### 5.3 查询 summary_tips 表

```bash
docker exec -i tdai-memory-core node - <<'NODE'
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/data/tdai-memory/vectors.db');
console.log(db.prepare(
  "select team_id, agent_id, session_id, status, count(*) as n from summary_tips group by team_id, agent_id, session_id, status order by n desc"
).all());
NODE
```

### 5.4 检查 L2 产物

```bash
docker exec tdai-memory-core sh -c \
  'find /data/tdai-memory/profiles -path "*project*" -type f | sort'
```

应检查：

- `project/topics/*.md`
- `project/MEMORY.md`
- `project/.packager-state.json`

---

## 6. 开工前必须注意

1. 所有改动都不提交，除非用户明确要求。
2. 改 core 后重启 core；改 proxy 后重启 proxy；两边都改就 `./stop-all.sh && ./start-all.sh`。
3. core/proxy 有源码挂载，改完源码重启容器即可，不需要重新打镜像。
4. 改完功能后同步更新：
   - `AGENT_INDEX.md`
   - `memory-agent/FINAL.md`
   - 本文件相关结论
5. 当前 L1 已经有较多记录，修复后第一次 packager 会处理一批积压 L1，属预期现象。
6. 旧 `.bak` 文件不要清理，除非用户指示。
