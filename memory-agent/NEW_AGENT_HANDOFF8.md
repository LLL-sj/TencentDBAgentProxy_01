# 新 Agent 工作交接（TencentDB-Agent-Memory · 第九轮维护 · summary_tips / 编码 / 触发机制 待实施清单）

> 状态：本文件只做交接要求，**当前不要实施代码**。待用户明确授权后再由后续 Agent 实施。
> 背景：第九轮已完成触发节奏与 L0.5 提醒调整；本轮又发现 summary_tips 提交乱码、40101、Claude Code 压缩摘要与 summary_tips 混淆等问题。
> 基线交接：先读 `NEW_AGENT_HANDOFF7.md`，再读本文件。所有改动仍未 git commit，继续不要 commit。

---

## 0. 当前现场快照

- 仓库：`/home/luuu/Desktop/TencentDB-Agent-Memory`
- 分支：`feat/server_team`，HEAD `fe3230f`，工作区有大量未提交改动。
- 三容器当前 healthy：
  - `tdai-memory-core`：8420
  - `tdai-memory-hub`：8125 + 8424
  - `tdai-proxy`：8096
- 当前 `.env` 已生效的关键值：
  ```env
  MEMORY_L1_EVERY_N=5
  MEMORY_L1_IDLE_TIMEOUT_SECONDS=240
  MEMORY_L2_DELAY_AFTER_L1_SECONDS=30
  MEMORY_L2_MIN_INTERVAL_SECONDS=180
  MEMORY_L2_MAX_INTERVAL_SECONDS=600
  MEMORY_L3_TRIGGER_EVERY_N=10
  MEMORY_PROJECT_MEMORY_MIN_INTERVAL_SECONDS=300
  MEMORY_SESSION_ACTIVE_WINDOW_HOURS=3

  MEMORY_TIPS_MAX_REMINDER_PER_TASK=50
  MEMORY_TIPS_REMINDER_COOLDOWN_SECONDS=600
  MEMORY_TIPS_FIRST_USER_REMINDER=true
  MEMORY_TIPS_COUNT1_THRESHOLD=2
  MEMORY_TIPS_COUNT2_THRESHOLD=2
  MEMORY_TIPS_TIME_REMINDER_SECONDS=480
  MEMORY_TIPS_SESSION_TTL_SECONDS=7200

  MEMORY_PROXY_PUBLIC_BASE_URL=http://127.0.0.1:8096
  ```
- 当前日期/时区注意：容器内日志是 **UTC**，北京时间 = 日志时间 + 8 小时。

---

## 1. 已经完成并验证的内容（不要重复做）

1. L1/L2/L3 触发节奏已调整为上述 `.env` 值。
2. `pipeline-factory.ts` 已删除 L1 完成后立即调用 project packager 的逻辑；packager 统一走 L2 timer 配置驱动。
3. `stateful-pipeline-manager.ts` 的周期 L2 timer 已补 team/agent。
4. L0.5 静态契约已压缩，并已改为：
   - 要求满足条件立即主动提交；
   - 中文提交使用 Write 写 UTF-8 JSON 文件 + `curl --data-binary @file`；
   - 带上 `x-conversation-id` 与 `x-tdai-service-id`。
5. L0.5 动态提醒已改为自带三条提交条件，并且“当前不满足则后续持续判断”，不再说“否则忽略”。
6. `tips-bridge.ts` / `notes-bridge.ts` 已加入第一层乱码防护：
   - 解析后的 JSON 若含 `U+FFFD`，写请求返回 `42201`，不落库；
   - Team Notes 只有写子路径受此检查。
7. 历史乱码 pending tip `tip-751a1e4a390d4411` 已标记 `expired`。
8. `MEMORY_PROXY_PUBLIC_BASE_URL` 已加入 `.env` 和 `start-proxy.sh`，proxy 不再 fallback 到容器内网 IP。

---

## 2. 待实施需求（用户已确认方向，但当前不要动代码）

### 2.1 GBK/GB18030 原始字节识别，非 UTF-8 拒绝重发

目标：

```text
只对前台 Agent 提交端点生效：
  - POST /memory-bridge/v3/tips/submit
  - POST /notes-bridge/v3/notes/create|update|delete
后台端点不要改。
```

实现要点：

1. 不要使用 `c.req.text()` 后再判断，因为此时字节已经被 UTF-8 解码替换。
2. 先读原始字节：`Buffer.from(await c.req.arrayBuffer())`。
3. 先 `new TextDecoder("utf-8", { fatal: true })` 严格解码。
   - 成功 → 继续 JSON 解析，并保留现有 `U+FFFD` 检查。
4. UTF-8 严格解码失败 → 再尝试 `new TextDecoder("gb18030", { fatal: true })`。
   - 成功 → 证明是 GBK/非 UTF-8，**拒绝入库**，返回 `42202`；
   - 返回信息带 GB18030 解码后的前 80–120 字符预览；
   - 日志打印 `preview`，不回写任何内容。
5. 两种都失败 → 返回 `42203`（非法编码）。
6. 不要服务端自动转码后落库，必须让 Agent 按 UTF-8 重发。
7. Node 容器已验证支持 `gbk` / `gb18030` 的 `TextDecoder`。

文件：

- `MemoryProxy/src/tips-bridge.ts`
- `MemoryProxy/src/notes-bridge.ts`

### 2.2 新增第三种动态提醒触发：User 消息里检测到 `<summary>...</summary>`

背景已查清：

```text
Claude Code 压缩阶段：
  User 收到 "CRITICAL: Respond with TEXT ONLY..." 的压缩指令
  → Assistant 输出 <analysis> / <summary>
  → 后续上下文里，Claude Code 会用 User 消息承载 <summary>...</summary> 交接摘要。
```

所以**不要检测 Assistant 文本**，只检测 **User 消息里的 `<summary>...</summary>`**。

触发规则：

```text
当前注入点为 user.before，最后一条是有效 User 消息；
且该 User 消息包含 <summary>...</summary>；
→ 立即注入专门动态提醒（与 firstUserReminder / count1 / count2 / time 并列的第三种触发）。
```

专门提醒建议文案：

```text
<system-reminder>
【检测到上下文压缩摘要】这是 Claude Code 的 <summary> 交接摘要，不等于已经提交 summary_tips。
如果当前阶段已经产出可复用成果，必须现在调用 summary_tips 提交接口；
本地 MEMORY.md / # Memory 文件也不能替代。
提交方式见 summary_tips_contract。
</system-reminder>
```

触发后状态处理：

```text
发完这条提醒后，重置当前 summary_tips 提醒阶段：
  count1 = 0
  count2 = 0
  reminderCount = 0
  stageStartedAt = now
  lastReminderAt = now
  lastActiveAt = now
```

这样压缩后的新阶段可以重新从第一条用户消息开始提醒。

文件：

- `MemoryProxy/src/injection/injectors/summary-tips-contract-injector.ts`
- `MemoryProxy/src/db/tips-reminder-repo.ts`（如需要新的重置语义）

### 2.3 静态/动态提示词继续补强

静态 `<summary_tips_contract>` 需要增加：

1. `【不要混淆】`：
   ```text
   - <summary> / <analysis> 是 Claude Code 的上下文压缩，不是提交；
   - 本地 # Memory / MEMORY.md 是 Claude Code 自己的记忆文件，也不能替代提交；
   - Team Notes 是团队文档；summary_tips 是任务总结接口。
   ```
2. `【失败处理】`：
   ```text
   提交失败（40101 / 422xx / 网络错误）时，按错误提示修正后重试一次并验证成功；不得静默放弃。
   ```

普通动态 `<system-reminder>` 需要增加一句：

```text
注意：提交的是 summary_tips 接口；
<summary> / <analysis> 不是提交；
本地 MEMORY.md / # Memory 也不是提交。
```

文件：

- `MemoryProxy/src/injection/injectors/summary-tips-contract-injector.ts`

### 2.4 tips-bridge 40101 增加日志

现在 40101 直接返回，日志里看不到。需要打印：

```text
[tips-bridge] 40101 session=<sessionKey>
hasAuth=<true|false>
hasConversationHeader=<true|false>
hasSpaceHeader=<true|false>
```

至少覆盖以下 header 的检测：

- Authorization
- `x-conversation-id` / `x-claude-code-session-id` / `x-session-id`
- `x-tdai-service-id`

文件：

- `MemoryProxy/src/tips-bridge.ts`

### 2.5 start-proxy.sh 未持久化 proxy SQLite：只记录，暂不实施

问题：

- `MemoryProxy/Dockerfile` 和 README 都写了：
  ```bash
  -v tdai-proxy-data:/data/tdai-memory-proxy
  ```
- 但 `deploy/global-images/start-proxy.sh` 当前没有这个 volume 挂载。
- 后果：每次重建 `tdai-proxy` 容器，session 状态、`tips_reminder_state`、hook cache 都会丢失；重启后立即提交 summary_tips 可能再次 40101。

用户要求：**记录下来，不要现在改**。

后续真正实施时：

```bash
# start-proxy.sh 的 docker run 增加：
-v tdai-proxy-data:/data/tdai-memory-proxy \
```

同时注意历史容器内已有数据不会自动迁移，需要接受重建后会话重新初始化。

### 2.6 其他已记录但本轮不做的项

- code v2 project topics 数量上限：不做。
- `maxMemoriesPerSession=20`：行为不改，语义为“单次 L1 LLM 调用最多保留 20 条”。
- 静态契约是否锚到 Claude Code `# Memory` 段后：**待用户确认**，本轮不要自行改。

---

## 3. 与 Claude Code 原生机制的关系（后续排查必读）

### 3.0 注入模型：每请求动态组装，不会累积

- Claude Code 每轮本地重建 system prompt；请求经过 proxy 时，proxy 在固定位置注入**一份**静态 `<summary_tips_contract>`，`user.before` 按条件注入动态 `<system-reminder>`。
- `session_init` 缓存只固定内容、提高 cache 命中率，不表示注入内容会在 Claude Code 本地累积。
- 响应结束后注入块不会写入 Claude Code 本地，下一轮由 proxy 重新注入。
- 因此每轮 system prompt 中每个注入块最多一份，token 固定；`/compact` 或长会话不会造成提示词膨胀或丢失。


- Claude Code 有自己的：
  - `# Memory` 本地文件记忆；
  - `<summary>` / `<analysis>` 上下文压缩；
  - `/compact` 或自动 compact 生成的 User 消息：
    ```text
    This session is being continued from a previous conversation that ran out of context...
    ```
- 那段英文指令：
  ```text
  CRITICAL: Respond with TEXT ONLY...
  Your entire response must be plain text: an <analysis> block followed by a <summary> block.
  ```
  来自 Claude Code 压缩阶段的用户消息，**不是 TencentDB-Agent-Memory 注入的**。
- 我们只注入：
  - 静态 `<summary_tips_contract>`
  - 动态 `<system-reminder>`
- 所以后续提示词必须明确区分：`<summary>`、本地 `MEMORY.md`、Team Notes、`summary_tips`。

---

## 3.5 待探索问题（只记录，不探索）

以下问题由用户提出，后续 Agent 自行调查，本文件不做结论。

1. code 与 chat 不同：code 模式的 L2-L3 层没有显示更新时间。
   - 排查方向建议：面板展示链路是否对 code v2 的 project topics / MEMORY.md 没有读取或渲染 `updated` 时间字段。

2. 当前对话中，L1 层明显包含至少两类主题：Claude Code 记忆机制、工业相机；但 L2 层只有一个相机相关文件。
   - 因为第 1 条缺少更新时间，无法判断是“没有触发”还是“这是早期记忆”。
   - L2 层触发存疑，需要重点排查：packager 是否消费了全部新 L1、游标是否正确、topics 是否遗漏主题。

3. （用户尚未补充第 3 条内容，待后续追加。）

## 3.6 历史未解决 / 待解决问题汇总

> 只记录，不探索。后续 Agent 按编号逐条排查/推动。

### 3.6.1 功能与数据一致性

| 编号 | 问题 | 备注 |
|---|---|---|
| H-01 | code 模式 L2/L3 层没有显示更新时间 | 同 §3.5 第 1 条；疑似面板未读取/渲染 `updated` |
| H-02 | 当前会话 L1 至少包含“Claude Code 记忆机制 / 工业相机”两类主题，但 L2 只有一个相机文件 | 同 §3.5 第 2 条；L2 触发/游标/主题合并存疑 |
| H-03 | 目标 team 曾出现 `project/topics/topics/packager-e2e-verification.md` 嵌套路径 | packager 对 LLM 文件路径缺少强校验；该嵌套文件不会被索引 |
| H-04 | code v2 topics 无数量上限 | 用户决定暂缓，后续补 `maxTopics` 与合并整理 |
| H-05 | `maxMemoriesPerSession=20` 语义与字段名不一致 | 当前行为是“单次 L1 LLM 调用最多保留 20 条”，不是 session 全局上限 |
| H-06 | `projectMemory.minPendingTips / minDistinctSessions / packagerMaxIntervalSeconds` 已解析但 packager 未使用 | FINAL.md 已知问题 |
| H-07 | `summary_tips` 没有删除接口 | 误提交只能 SQLite 手动清理 |

### 3.6.2 已观察到但未修复的日志异常

| 编号 | 现象 | 备注 |
|---|---|---|
| H-08 | proxy 日志反复出现 `[hook-cache] putMany failed ... FOREIGN KEY constraint failed` | 说明 hook cache 写入 session 外键时失败；可能影响缓存命中 |
| H-09 | proxy 反复请求 `POST /v3/meta/agent-fixed-asset/list-with-detail`，hub 返回 404 | 端点可能不存在或 hub 版本不匹配；每次都产生两条 404 日志 |
| H-10 | 每次请求后 `CREDIT_REPORT ... fetch failed` | 非阻断，但日志噪音大 |
| H-11 | `rate_limit.fail_open reason=redis_unavailable` | Redis 未启用时的预期降级，但需要确认是否应关闭相关检查 |
| H-12 | core 启动提示 gateway 绑定 0.0.0.0 且无 API key | 本地开发默认态；暴露前必须加固 |

### 3.6.3 部署与运维待决策

| 编号 | 问题 | 备注 |
|---|---|---|
| H-13 | `start-proxy.sh` 没有挂载 proxy SQLite 持久化卷 | 同 §2.5；重建容器会丢 session / `tips_reminder_state` / hook cache |
| H-14 | 三个容器 `RestartPolicy=no` | WSL 重启后容器不会自动拉起；已建议 `--restart unless-stopped`，待用户确认 |
| H-15 | `.env` 的 `MEMORY_PROXY_PUBLIC_BASE_URL=http://127.0.0.1:8096` 仅同机有效 | 跨机/公网部署必须改为实际可达地址 |
| H-16 | 容器日志为 UTC，宿主机为 CST(+8) | 排查时间时容易误判；可选挂载时区 |

### 3.6.4 数据清理待决策

| 编号 | 问题 | 备注 |
|---|---|---|
| H-17 | Team Note `note-79ut1azx` 的 version 1 内容为乱码；version 2 已正常且 active | 旧乱码 revision 是否保留、删除或归档，待用户决定 |
| H-18 | 乱码 pending tip `tip-751a1e4a390d4411` 已标记 `expired` | 尚未物理删除 |
| H-19 | HANDOFF7 提到的 E2E 验证数据仍在 session `8a2dbcca-...` 中 | 如需清理另行处理 |

### 3.6.5 本轮已列入 §2 的待实施项（提醒：不要现在实施）

- GBK/GB18030 原始字节识别与非 UTF-8 拒绝重发（§2.1）
- User 消息检测 `<summary>...</summary>` 第三种动态提醒触发（§2.2）
- 静态/动态提示词继续补强（§2.3）
- tips-bridge 40101 诊断日志（§2.4）
- start-proxy SQLite 卷只记录、暂不实施（§2.5）

## 4. 实施完成后的验证清单

1. `cd MemoryProxy && npx tsc --noEmit` 通过。
2. 重启 proxy。
3. 编码验证：
   - 向 tips submit 发送 GBK 字节中文 JSON → 返回 `42202`，日志有 preview，core 的 `summary_tips` 没有新记录；
   - 向 notes create 发送 GBK 字节中文 JSON → 返回 `42202`，knowledge 的 `team_notes` 没有新记录；
   - 发送 UTF-8 JSON 文件 → 正常入库。
4. 压缩摘要触发验证：
   - 构造或等待一条包含 `<summary>...</summary>` 的 User 消息；
   - proxy 日志出现第三种提醒注入；
   - `tips_reminder_state` 的 count1/count2/reminderCount 被重置。
5. 40101 日志验证：
   - 模拟无会话提交，日志出现 `hasAuth / hasConversationHeader / hasSpaceHeader`。
6. 更新文档：
   - `AGENT_INDEX.md`
   - `memory-agent/FINAL.md`
   - `memory-agent/MEMORY_MECHANISM.md`
   - 本文件状态改为“已实施”。

---

## 5. 纪律

- 未得到用户明确“开始实施”指令前，不要改代码。
- 不 git commit。
- 修改后必须重启对应容器并验证。
- 继续保留旧 `.bak` 文件。
