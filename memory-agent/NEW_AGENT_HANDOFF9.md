# 新 Agent 工作交接（TencentDB-Agent-Memory · 第十轮维护 · 编码 / summary / 40101 / topics / Codex）

> 状态：本文是 HANDOFF8 之后新增的第十轮交接。HANDOFF8 保持原样，请先读 HANDOFF8 再读本文。
> Git：仍未 commit，HEAD `fe3230f`。三容器当前 healthy。
> 纪律：Codex 流式问题当前只排查记录，不加临时日志、不修代码，等待用户安排。

---

## 0. 本轮已完成并验证的内容

### 0.1 GBK/GB18030 原始字节识别（HANDOFF8 §2.1）

- 新增 `MemoryProxy/src/common/request-body-encoding.ts`。
- `tips-bridge.ts`：先读原始字节，严格 UTF-8 解码。
- `notes-bridge.ts`：只对 `create|update|delete` 写子路径启用；read 路径保持旧逻辑。
- 错误码：
  - UTF-8 成功但 JSON 含 `U+FFFD` → `42201`；
  - UTF-8 失败但 GB18030 可解码 → `42202`，响应带 GB18030 解码 preview，日志打印 preview，不落库；
  - 两种都失败 → `42203`。
- `start-proxy.sh` 增加 `request-body-encoding.ts` 源码挂载。
- 已实测：GBK tips/notes 返回 42202，非法字节返回 42203，UTF-8 正常入库。

### 0.2 `<summary>` 第三种动态提醒（HANDOFF8 §2.2）

- 只检测最后一条有效 User 消息，扫描其**全部 text block 拼接文本**。
- 不检测 Assistant 文本；`<summary>...</summary>` 在开头/中间/结尾都能命中。
- 命中后立即注入专门提醒。
- 状态重置使用 `resetTipsReminderStage(key, { lastReminderAt: now })`：
  - `count1=0`、`count2=0`、`reminderCount=0`；
  - `stageStartedAt=now`、`lastReminderAt=now`、`lastActiveAt=now`。
- 原成功提交路径仍默认 `lastReminderAt=0`，互不影响。
- 已实测：构造 summary User 消息后日志出现专门提醒，SQLite 状态按预期重置。

### 0.3 静态/动态提示词补强（HANDOFF8 §2.3）

- 静态契约新增【不要混淆】【失败处理】。
- 普通动态提醒新增“提交对象是 summary_tips；`<summary>/<analysis>` 和本地 MEMORY.md/# Memory 不是提交”。

### 0.4 tips-bridge 40101 日志（HANDOFF8 §2.4）

- 已打印：
  `[tips-bridge] 40101 session=... hasAuth=... hasConversationHeader=... hasSpaceHeader=...`
- 已实测无会话请求日志正常。

### 0.5 project topics 嵌套路径与 maxTopics（HANDOFF8 §3.5 第 2 条 / H-03 / H-04）

- 根因：packager LLM 把文件写进 `project/topics/topics/*.md`，旧列表只扫一级目录，导致 packager 看不到旧文件，把同一主题重复创建多个文件。
- 修复：
  - `project-memory-packager.ts` 自动扁平化嵌套 topic（本地与 storage 两条路径）；
  - `project/list` 前自愈重建过期的 `project/MEMORY.md`；
  - `MEMORY.md` 顶部增加生成时间；
  - 新增 `.env`：`MEMORY_PROJECT_MEMORY_MAX_TOPICS=15`；
  - prompt 强制 UPDATE/MERGE 优先，同主题只保留一个文件；
  - 被合并旧文件写 `[DELETED]` 后由工程代码自动清理；
  - 放宽 safeTopicName：只禁止 `batch/report/chatlog/summary.md` 泛化文件名，允许 `summary-tips-memory-workflow.md` 这类具体主题。
- 数据修复：`team-inv48xvsc3 / agt-m53rbwxxd0` 的 6 个 Claude Code 记忆/上下文 topic 已合并为 1 个 `claude-code-memory-context-mechanism.md`；该 agent topic 数从 12 降到 7。
- 面板：
  - `CodeMemoryDetail.tsx` 增加 L2 updated 展示。
  - web 已重新构建并 `docker cp` 热更新进当前 hub 容器。
  - 但 `agentmemory/memory-hub:local` 镜像未重打；容器重建后会回退旧前端。

### 0.6 Codex/codebuddy OpenAI tools 规范化（HANDOFF8 §2.4 之后新发现问题）

- 原错误：`Missing required parameter: 'tools[7].name'.`
- 定位：上游 OpenAI 兼容网关不认 Codex 的扁平 tool 或缺少 `function.name` 的 tool。
- 修复：`MemoryProxy/src/handler.ts` 新增 `normalizeOpenAITools`。
  - 扁平 `{type,name,description,parameters}` 自动包装成标准 `{type:"function",function:{...}}`；
  - 无 `function.name` 且无顶层 `name` 的 tool 自动移除；
  - 日志关键字：`[openai-tools] wrapped/removed`。
- 已用标准/扁平/缺名 tool 三种合成请求验证通过。
- 真实 Codex 请求日志显示：`removed=1 wrapped=14 finalCount=14`；被移除的是 `web_search`。

---

## 1. 当前未解决：Codex OpenAI 流式断开（重要，交给下一轮）

### 1.1 现象

- Codex 配置：
  - base：`http://127.0.0.1:8096/codebuddy/default/v1`
  - headers：`x-team-id=team-inv48xvsc3`、`x-agent-id=agt-nmbwqggci9`、`x-task-id=task-m5ly13w9c0`
- 客户端稳定复现：
  `stream disconnected before completion: stream closed before response.completed`
- 不是偶发，每次都出现。

### 1.2 已确认的事实（从 proxy 日志）

- session 初始化正常：
  - `preset hit team=team-inv48xvsc3 agent=agt-nmbwqggci9 task=task-m5ly13w9c0`
  - `→ initialized`
- tools 已通过规范化，无 `tools[i].name` 400。
- 上游转发阶段：
  - `→ FORWARD upstream=https://api.zhongjx.xyz/v1`
  - `← FORWARD status=200`
- proxy 日志没有显示 4xx/5xx，也没有 proxy 侧 stream error。

### 1.3 尚未定位

错误发生在**流式传输阶段**，当前 `handler.ts` 的 OpenAI 流式分支只是原样转发 SSE 字节，没有记录：

- 收到多少 chunk / 字节；
- 是否收到 `data: [DONE]`；
- EOF 时是否已经收到 `[DONE]`；
- 上游是否提前 EOF；
- 客户端是否中途 cancel；
- 上游 SSE 事件类型与结束方式。

### 1.4 为什么 Claude Code 正常不能反推 Codex 正常

- 两者共用注入 pipeline，但流式转发不是同一条代码：
  - Claude Code：`anthropicHandler.ts`，有 `tee()` + SSE thinking fix + tap 处理；
  - Codex：`handler.ts` 的 OpenAI stream 分支，手动 `ReadableStream` 原样转发。
- 所以 Claude Code 没问题，不代表 OpenAI 流式分支没问题。

### 1.5 下一轮排查任务（用户已授权加临时调试日志，但本轮不实施）

1. 在 `MemoryProxy/src/handler.ts` 的 OpenAI stream 分支临时记录：
   - stream start：`sessionKey / modelId / requestPath / stream=true`；
   - 每个 upstream chunk 的 bytes 数和累计 bytes；
   - SSE 解析：`data:` 行数、事件类型、是否出现 `[DONE]`；
   - reader EOF 时是否带 `[DONE]`；
   - reader error / `controller.error`；
   - ReadableStream `cancel` 是否被调用（客户端断开）。
2. 重启 proxy，用 Codex 复现一次。
3. 按日志判断三种情况：
   - A. 上游提前 EOF 且没有 `[DONE]`；
   - B. proxy 转发过程中报错或提前 `controller.close()`；
   - C. Codex 客户端主动 `cancel`。
4. 对照 `anthropicHandler.ts` 的流式实现，确定修复方案后再动手。
5. 修复后更新本文状态，并继续保留问题与解决记录。

---

## 2. 运维注意

- `start-proxy.sh` 仍未挂载 `tdai-proxy-data:/data/tdai-memory-proxy`；本机测试可暂不改，正式使用前必须加，否则重启 proxy 会丢 session / `tips_reminder_state` / hook cache。
- 当前 hub 容器前端是 `docker cp` 热更新，不是镜像重建；执行 `start-memory-hub.sh` 重建容器后前端会回退，需要重打镜像或重新热更新。
- 全量 hub 镜像构建曾在 knowledge `npm install` 阶段卡住，尚未完成；后续处理时注意该步骤。

---

## 3. 测试与状态

- `MemoryCore npm test`：25/25 通过。
- `MemoryCore npm run build:plugin`：通过。
- `MemoryProxy npx tsc --noEmit`：通过。
- `MemoryPanel/web npx tsc --noEmit` + `npm run build`：通过。
- 三容器当前 healthy。
- Git 未 commit，HEAD `fe3230f`。
