# L0 路由与 User/Assistant 抽取说明（Codex / Claude Code）

> 状态：调研记录 + 目标方案（2026-09-08 追加 §6/§7：用于指导**当前仍在运行的旧项目**按新口径改造）。
> 范围：只讲“哪些请求会写 L0，以及 L0 的 User / Assistant 是怎么从原始请求/响应里抽出来的”。
> 提示：§6 目标方案内容完整、独立可执行，改造只以本文件 §6 为准。
> 不涉及：L0 的 SQLite/JSONL 存储、L1/L2/L3 调度、summary_tips 入库细节。
> 关联文件：
> - `MemoryProxy/src/server.ts`
> - `MemoryProxy/src/handler.ts`（OpenAI / Codex）
> - `MemoryProxy/src/anthropicHandler.ts`（Claude Code）
> - `MemoryProxy/src/tdai/recorder.ts`（L0 抽取与写入）
> - `MemoryProxy/src/common/cc-request-classifier.ts`
> - `MemoryProxy/src/agent-adapters/claude-code.ts`
> - `MemoryProxy/src/agent-adapters/codebuddy.ts`

---

## 1. 总原则

L0 只应该记录：

```text
真实用户输入（User）
+
模型给真实用户看的最终文本回答（Assistant）
```

以下内容不应该进 L0：

- 客户端内部请求（标题生成、安全审批、压缩、总结等）
- 子代理 / sidequery 请求
- tool_use / tool_call 本身
- tool_result 的正文
- system prompt、注入块、system-reminder
- 客户端塞进 User 消息里的 harness 上下文

因此 L0 写入链路实际分两步：

```text
1. 路由/分类：这个请求是不是“主对话轮”？
2. 内容抽取：从请求里抽出真实 User，从响应流里抽出真实 Assistant 文本。
```

### 1.1 三条主链路速览

#### Codex Responses 链路

```text
/v1/responses
  → 识别 Responses API
  → 保存原始 input[]
  → 生成临时 messages[] 视图
  → session / injection / L0 抽取
  → 系统注入合并回 instructions
  → 动态提醒插回 input[]
  → 恢复原始 input[]，删除临时 messages
  → 工具保持 Responses 扁平格式
  → 转发 /responses
  → SSE 解析 response.output_text.delta / response.usage
```

#### Codex 内部请求过滤链路

```text
extractLatestUserMessage()
  → isCodexGuardSession()
  → isNewCodexGuardSession()
  → codexInternal.promptPrefixes 前缀过滤
  → 命中任一 → 不写 L0
```

#### Chat Completions 旧链路

```text
/v1/chat/completions
  → OpenAI handler
  → messages[] 直接进入 session / injection / L0 抽取
  → 扁平 tool 包装为 {type:"function", function:{name,...}}
  → 缺 name 工具剔除
  → 转发 /chat/completions
  → SSE 解析 choices[0].delta.content / usage
```

---

## 2. Codex / OpenAI 链路

### 2.1 入口路由

`server.ts` 中与 Codex/OpenAI 相关：

```text
POST /v1/chat/completions
POST /:agent/:spaceId/v1/chat/completions
POST /:agent/:spaceId/v1/responses        ← 当前 Codex 实际走这里
POST /*                                    ← 未匹配路径兜底到 OpenAI handler
```

最终都进入 `handler.ts::handleChatCompletions()`。

### 2.2 Responses API 支持

Codex 当前配置是 `wire_api = "responses"`，所以实际请求为：

```text
POST /codebuddy/default/v1/responses
```

处理流程：

1. `isResponsesApiRequest()` 识别该路径。
2. 保存原始 `body.input[]`。
3. `responsesBodyToMessages()` 生成一个临时 `messages[]` 视图，只供 session-init / injection / L0 User 抽取使用。
4. 注入完成后：
   - 系统注入合并回 `instructions`；
   - 动态 User 提醒插回 `input[]`；
   - 删除临时 `messages`；
   - 原始 `input[]` 保持原样转发。
5. 上游转发到 `/v1/responses`，不再错误降级到 `/v1/chat/completions`。

### 2.3 Codex 内部请求识别

Codex 会复用同一路径和同一组 session header 发送内部请求。当前识别分三层：

1. `isCodexGuardSession()`
   - 旧版 guard，assistant 精确输出：
     ```json
     {"outcome":"allow"}
     {"outcome":"deny"}
     ```

2. `isNewCodexGuardSession()`
   - 新版 guard，assistant 输出带扩展字段：
     ```json
     {"risk_level":"low","user_authorization":"high","outcome":"allow","rationale":"..."}
     ```

3. `codexInternal.promptPrefixes` 配置前缀
   - 标题生成：
     ```text
     You are a helpful assistant. You will be presented with a user prompt, and your job is to provide a short title
     ```
   - 安全审批 transcript：
     ```text
     The following is the Codex agent history whose request action you are assessing
     The following is the Codex agent history added since your last approval assessment
     ```

命中任意一层 → `extractLatestUserMessage()` 返回 `null` → 不写 L0。

配置位置：

```yaml
codexInternal:
  promptPrefixes:
    - ...
```

可用 `.env` 变量 `MEMORY_CODEX_INTERNAL_PROMPT_PREFIXES` 覆盖，多个前缀用 `|` 分隔。

### 2.4 User 抽取

`extractLatestUserMessage(messages, agentSource, codexInternalPromptPrefixes)`：

1. 先执行上面两个 guard 判断。
2. `agentSource = "codebuddy"` 时使用 `codebuddyAdapter.extractUserText()`：
   - 优先提取 `<user_query>...</user_query>`；
   - 否则调用 `extractUserQueryText()` 剥离 CB wrapper 和 harness 内容。
3. 再检查是否命中 `codexInternal.promptPrefixes`。
4. 只取最后一条有效 User 消息。

### 2.5 Assistant 抽取

流式 SSE：

- Chat Completions 格式：
  ```text
  choices[0].delta.content
  ```

- Responses 格式：
  ```text
  response.output_text.delta
  ```

`finalizeStreamTap()` 拿到纯文本后写入 L0 Assistant。tool_call 参数不会写入 L0。

### 2.6 Codex 本轮修复落地文件

- `MemoryProxy/src/routes/whitelist.ts`：新增 `/v1/responses → /responses`。
- `MemoryProxy/src/guard-adapter.ts`：URL 拼接支持 `/responses`。
- `MemoryProxy/src/handler.ts`：Responses 视图/合并/工具格式/SSE 解析。
- `MemoryProxy/src/tdai/recorder.ts`：旧 guard 保留 + 新增 `isNewCodexGuardSession()` + 配置前缀过滤。
- `MemoryProxy/src/types.ts` / `src/config.ts`：新增 `codexInternal.promptPrefixes` 配置。
- `MemoryProxy/config.example.yaml`：配置示例。
- `deploy/global-images/start-proxy.sh`：生成 `codexInternal` 配置，并挂载 `whitelist.ts` / `guard-adapter.ts`。
- `deploy/global-images/.env` / `.env.example`：可选 `MEMORY_CODEX_INTERNAL_PROMPT_PREFIXES`。

验证结论：真实 Codex 多次工具调用后 L0 干净；合成 Responses 与 Chat Completions 冒烟均通过。

---

## 3. Claude Code / Anthropic 链路

### 3.1 入口路由

```text
POST /v1/messages
POST /:agent/:spaceId/v1/messages
POST /claude-code/:spaceId/v1/messages
```

进入 `anthropicHandler.ts::handleAnthropicMessages()`。

### 3.2 请求分类：main / fork / sidequery

`classifyCcRequest()` 按以下规则三分类：

| 类型 | 含义 | 当前判定 |
|---|---|---|
| `main` | 主对话 | `cache_control` 在最后一条消息；或无 marker 但不像 sidequery |
| `fork` | 复用缓存的内部 fork | `cache_control` 在倒数第二条消息 |
| `sidequery` | 独立内部查询 | 无 marker 且 `tools=[]` 且 `thinking.disabled` |

当前副作用策略：

- 只有 `main` 写 L0 / skill buffer；
- `fork` 走注入但 `readOnly=true`，不写 L0；
- `sidequery` 跳过注入，不写 L0。

### 3.3 User 抽取

`claudeCodeAdapter.extractUserText()`：

1. 只取最后一个 `type:"text"` block；
2. 再用 `extractUserQueryText()` 剥离：
   - `<system-reminder>`、`<additional_data>`、`<user_info>` 等 wrapper；
   - `tool_result` / `tool_use_error` 伪 wrapper；
   - session-init 回执；
   - CC 内部 prompt（`[TITLE MODE]`、`The user stepped away...` 等）。

### 3.4 Assistant 抽取

- 流式：从 Anthropic SSE 的 `content_block_delta.text_delta` 累加纯文本；
- `tool_use` 只计数，不写 L0；
- 非流式：从 `content[].type=="text"` 中取文本。

---

## 4. 当前缺口 / 待办

### 4.1 Claude Code WebSearch 内部请求仍可能污染 L0

**现象：**

L0 中曾出现：

```text
Perform a web search for the query: MV-CU120-10GC 使用说明书 MVS GigE Vision 官方
Perform a web search for the query: "MV-CU120-10GC"
Perform a web search for the query: 海康机器人 MV-CU120-10GC PDF
```

**已确认的事实：**

- Claude Code 主 transcript 中确实有对应 `WebSearch` 工具调用。
- 但本地 transcript 的 tool_result 是：
  ```text
  Web search results for query: ...
  ```
- L0 里的文本是：
  ```text
  Perform a web search for the query: ...
  ```
- 说明 proxy 收到的是 WebSearch 相关的内部请求/合成 User prompt，不是主对话 transcript 原样。
- 旧 proxy 日志已不可得，尚未抓到该请求的原始 body，因此还没最终确认它被 `classifyCcRequest()` 分成 main 还是 sidequery/fork。

**处理决定：**

- 暂不修改 Claude Code 相关代码。
- 不采用“匹配 `Perform a web search for the query:`”这类工具专属正则，因为换一个工具就失效。
- 后续正确方向应该是结构/分类层面识别：
  - 抓一次真实 WebSearch 请求原始 body；
  - 看它的 `cache_control`、`tools`、`thinking`、system prompt 结构；
  - 判断应归入 `sidequery` / `fork`，或新增通用的“子代理请求”识别；
  - 再做内容层通用过滤，而不是针对具体 query 文案。

### 4.2 Codex 前缀过滤的边界

- 当前 `codexInternal.promptPrefixes` 对 Codex 是合适的，因为标题生成和审批 prompt 是稳定系统提示词。
- 副作用：如果真实用户消息恰好以这些前缀开头，会被当作内部请求过滤。已记录在配置注释中，需要告知团队。
- 如果 Codex 未来新增内部 prompt，需要在配置中增加前缀。

### 4.3 需要后续补抓的数据

- Claude Code WebSearch 请求的：
  - 原始 body（system/messages/tools/thinking/cache_control）
  - `requestKind` 日志
  - 最后一条 User 消息的 block 结构
- 用于设计通用子代理/内部请求分类规则。

### 4.4 Codex Ambient Suggestions（后台自动建议）会污染 L0

**现象（2026-09-07 远程实际复现）：**

- Team：`team-8gwmoyog60`
- Agent：`agt-94thzs7gt7`
- User：`usr-8gye8bzara`
- Task：`task-94uylzmks9`

该 agent 的 L0 中出现了两个 session：

| session | 时间（CST） | 来源 |
|---|---|---|
| `01a07bd8-988f-7dd0-aab4-ab9be9301f97` | 2026-09-07 20:31:52 起 | 真实用户对话 |
| `01a07bd8-4de7-7e63-9089-fe9019acc249` | 2026-09-07 20:29:58 | Codex Ambient Suggestions 自动建议请求，**误入 L0** |

污染 session 的 User 内容开头为：

```text
# Overview

Generate 0 to 3 hyperpersonalized suggestions for what this user can do with Codex in this local project: ...
```

该 prompt 后续还拼接了大量“最近 Codex 任务”历史，因此看起来像旧会话重新出现，实际是后台建议功能拿旧任务历史当上下文。

**已确认触发来源：**

- 本地 Codex Desktop 配置中：
  ```toml
  [desktop]
  ambient-suggestions-enabled = true
  ```
- 本地 `.codex/ambient-suggestions/` 中有对应 JSON：
  ```text
  generatedAtMs: 1788784168302
  生成时间：2026-09-07 20:29:28
  projectRoot：\\wsl.localhost\Ubuntu-24.04\home\luuu\Desktop\TencentDB-Agent-Memory
  ```
- Proxy 日志显示：
  - 20:29:46 收到 `/codebuddy/default/v1/responses` 请求；
  - model=`gpt-5.6-terra`；
  - 使用与真实对话相同的 `team/agent/user/task` 身份头；
  - 20:29:58 写入 L0；
  - 该 session 后续还被抽取成 3 条 L1 记忆。

**为什么现有过滤没拦住：**

- 已存在的 `isCodexGuardSession()` / `isNewCodexGuardSession()` 只针对安全审批；
- `codexInternal.promptPrefixes` 当前只覆盖标题生成和审批 transcript；
- Ambient Suggestions 的 prompt 前缀是 `# Overview` + `Generate 0 to 3 hyperpersonalized suggestions...`，不在当前配置中。

**建议的过滤方向（待丰富）：**

1. 在 `MEMORY_CODEX_INTERNAL_PROMPT_PREFIXES` / `codexInternal.promptPrefixes` 中增加稳定前缀，例如：
   ```text
   # Overview

   Generate 0 to 3 hyperpersonalized suggestions for what this user can do with Codex
   ```
   注意：实际 prompt 首行可能是 `# Overview`，需要确认以哪一行作为最稳妥前缀。
2. 更稳妥的方向是找 Codex Ambient Suggestions 请求的结构性特征，而不是只匹配英文提示词：
   - 请求是否不来自真实用户点击/输入，而是后台 UI 自动任务；
   - 请求是否在 `input[]`/`messages[]` 中缺少用户本轮真实输入；
   - 是否带有特定 `x-*` header、system prompt 标识、或 `input` 结构（如纯 system + 旧任务历史）。
3. 与 Claude Code WebSearch 一样，先抓真实原始 body 再设计通用“非主对话内部请求”分类，避免一个功能一个正则。
4. 已知同类风险还包括：Codex 其他后台提示词功能（标题生成、安全审批、Ambient Suggestions，以及未来可能新增的自动功能），只要它们复用同一 provider 身份头，都可能进入 L0；应形成一个可扩展的内部请求识别清单/配置。

---

## 5. 当前处理小结

| 客户端 | 已处理 | 方法 | 是否硬编码 |
|---|---|---|---|
| Codex | 旧版 guard 审批 | `isCodexGuardSession()` 精确 JSON | 保留兼容 |
| Codex | 新版 guard 审批 | `isNewCodexGuardSession()` 扩展 JSON | 代码 |
| Codex | 标题 / 审批 transcript | `codexInternal.promptPrefixes` 配置 | 配置化 |
| Codex | Ambient Suggestions 自动建议 | **未修，待设计方案/抓包补前缀** | 待定 |
| Claude Code | main/fork/sidequery 分类 | `cache_control` + tools + thinking | 代码 |
| Claude Code | harness wrapper 剥离 | `extractUserQueryText()` | 部分代码 |
| Claude Code | WebSearch 内部请求 | **未修，待抓包** | 待定 |

> §2–§5 为现状与历史案例基线；**目标方案见 §6，改造按 §6 执行**。

---

## 6. 目标方案（旧项目改造按此执行，2026-09-08）

> 本章是定稿方案（2026-09-08），用于指导**旧项目**修改 L0 抽取与内部请求识别。内容完整、独立可执行，按旧项目实际（现行路由、命名、代码结构）表述；**只以本章为准**。
> **概念统一：Codex 就是 Codex。** 旧项目 URL 路径中的 `codebuddy` 只是现行路由别名，不是独立 Agent；改造期间内部命名（adapter / 配置 / 日志）逐步从 `codebuddy`、`codexInternal` 统一为 `codex`，URL 路径可在迁移窗口内保留别名转发，但**不新增任何别名用法**。

### 6.1 两层架构与判定铁律

```text
第 1 层 净化抽取（协议层，与客户端无关）
   → 按 content block / item type 白名单抽"候选 User 文本"与"候选 Assistant 文本"
第 2 层 回合分类（客户端层）
   → 结构信号（硬，代码） > 前缀列表（软，配置文件） > 低置信启发式（只保留不扩展）
   → 命中内部请求 → 不算一轮 → 不写 L0
```

铁律：**能结构就别靠文本；结构够不到的才进前缀列表；前缀命中必须打审计日志**（哪条前缀命中哪条消息，前 80 字符）。

### 6.2 配置与缓存（跨 Agent 通用）

- 两套前缀列表集中到一个配置文件节（替换/收编现有 `codexInternal.promptPrefixes` 与代码内嵌黑名单），作为唯一真源，**不进数据库**：

```yaml
internalRequest:
  claudeCode: { promptPrefixes: [...] }
  codex:       { promptPrefixes: [...] }
```

- 前缀规则：候选 User 文本开头 startsWith（先 trim）；以**特征句**为锚（Ambient 用 `Generate 0 to 3 hyperpersonalized suggestions for what this user can do with Codex`，不用首行 `# Overview`）；命中即止、命中打日志；
- 缓存：服务启动从配置构建**不可变快照**进进程缓存；改配置后**手动删缓存重建**（纯派生数据，删除安全、重建幂等、并发 miss 只建一次）；**不做**轮询 / stat 校验 / 热更新 / DB 存储；
- 前缀只判"候选 User 文本"，不参与 Assistant 判定。

### 6.3 Claude Code（Anthropic）改造

**净化抽取（保持并收紧）：** assistant 只取 `content[].type=="text"`（流式只累加 `text_delta`，tool_use 只计数、thinking 跳过）；user 剔除 content 全为 `tool_result` 块的消息（混有 text 的保留）；剥离 system-reminder 等 wrapper；**压缩摘要**固定前缀命中即不算用户输入（即使它是最后一条 user）：

```text
This session is being continued from a previous conversation that ran out of context.
```

**内部请求识别（新增，按优先级）：**

1. 子代理请求：第一条 system 块以 `x-anthropic-billing-header` 开头且 JSON 元数据含 `cc_is_subagent === true` → 不写 L0（CCR v3 实测实现；**块格式随版本可变，待真实抓包复核**）；辅助信号：`thinking: {"type":"disabled"}`（v2.1.166+ 子代理；主请求 adaptive/enabled，需校准）；
2. WebSearch 内部再入：**三重结构信号** → 不写 L0（可单独计模型调用）：① system 第二段固定 `You are an assistant for performing a web search tool use`（第一段继承主对话，勿用）；② tools 含 `{"type":"web_search_20250305","name":"web_search","max_uses":8}`；③ 唯一 user 消息以 `Perform a web search for the query: ` 开头。双源独立实测一致（quercle.dev；OmniRoute issue #1882），**落地前抓一次真实 body 复核**；
3. 现有 main/fork/sidequery（cache_control 位置 / tools=[] / thinking disabled）**定位为低置信启发式**：保留兼容，不扩展依赖、不新增基于它的新规则；
4. headers（UA `claude-cli/…`、`anthropic-beta`、`x-app: cli`、`x-claude-code-session-id` 等）仅辅助观测，可伪造，不作唯一判据；
5. 前缀列表 `internalRequest.claudeCode.promptPrefixes`：标题生成（community 逆向 SESSION_TITLE_PROMPT 特征，非官方，以真实 body 校准）、本地命令回执等结构覆盖不到的文本特征。

**判定顺序：** ①headers 记录 → ②billing 块 `cc_is_subagent` → ③thinking disabled → ④WebSearch 三重 → ⑤main/fork/sidequery（非 main 不写 L0）→ ⑥抽取候选 User → ⑦压缩前缀 → ⑧claudeCode 前缀列表 → ⑨通过才写 L0。

### 6.4 Codex 改造

**净化抽取（保持并收紧）：** Responses 按 item `type` 过滤——只有 `type=message && role=user` 是用户输入候选；`function_call / function_call_output / web_search_call / reasoning / message(role=assistant)` 均非（function_call_output 无 role，按 call_id 配对）；Chat Completions 包装成 function 后同语义。流式只累加 `response.output_text.delta` / `choices[0].delta.content`，工具参数不进 L0。IDE 注入解包：命中 IDE 模板包裹时取**最后一个** `My request for` 标题后的文本为真 prompt。

**内部请求识别（新增，按优先级）：**

1. 结构（已有，代码级保留）：旧版 guard 精确 `{"outcome":"allow"/"deny"}`；新版 guard 含 `risk_level / user_authorization / outcome / rationale` 扩展 JSON；
2. 前缀列表 `internalRequest.codex.promptPrefixes`（沿用现有 `codexInternal` 并补齐）：
   - 标题生成：`You are a helpful assistant. You will be presented with a user prompt, and your job is to provide a short title`
   - 审批 transcript：`The following is the Codex agent history whose request action you are assessing`、`The following is the Codex agent history added since your last approval assessment`
   - **Ambient Suggestions（新增条目）**：`Generate 0 to 3 hyperpersonalized suggestions for what this user can do with Codex`
3. Ambient 专项状态：仅文本前缀可用，无公开结构信号；OSS codex 源码该提示词已消失（疑似移往 Desktop/服务端，可能漂移）。**待办：抓一次真实 Ambient 请求 body**，确认三点——① instructions/system 有无稳定结构；② input[] 是否缺少"本轮新鲜 user 输入"（有 → 可升格结构信号）；③ 是否透传 `thread_source=system` / `request_kind=turn`（社区实测有此元数据，是否透传到本网关无证据）。抓到结构 → 升格 1；抓不到 → 维持 2。

**判定顺序：** ①guard 精确 JSON → ②抽取候选 User（item type + IDE 解包）→ ③codex 前缀列表 → ④通过才写 L0。

**已知取舍：** 真实用户消息恰好以某前缀开头会被误过滤（概率极低）——命中日志 + 配置注释知会团队。

### 6.5 新增 Agent 产品的接入指引（简版）

```text
1. 确认 API 形态：Anthropic Messages → 净化和分类复用 §6.3；
   OpenAI Responses / Chat Completions → 复用 §6.4；其他格式 → 按同一两层设计新写
2. 抓真实样本留档：主对话 ≥3 个 + 该产品所有内部请求（标题/审批/后台建议/搜索/子代理/压缩）各 ≥1
3. 逐个内部请求做结构信号检查：
   □ 专用 system 段/特征句  □ 专用 server tool 类型  □ 专用标记字段（如 cc_is_subagent）
   □ thinking 是否 disabled  □ cache_control/tools/max_tokens 差异  □ headers 专属值（可伪造，仅辅助）
   □ 消息组合：input[] 是否缺少"本轮新鲜 user 输入"（纯旧历史回放 = 强信号）
4. 归类：稳定结构 → 写代码硬规则；仅文本 → 该 Agent 前缀配置节；都无 → 暂不识别并记录
5. 验证：合成冒烟 + 真实运行观察 L0；误伤审计（命中日志）
6. 沉淀：登记 §6.6，内部请求类型写进该 Agent 配置节注释
```

### 6.6 当前使用的 Agent 产品（旧项目现状）

| Agent | 现行入口 | 已知内部请求类型 | 收口状态（改造后） |
|---|---|---|---|
| **Codex**（= 现行 `codebuddy` 路由别名，概念统一为 Codex） | `/codebuddy/default/v1/responses`（Responses，实走） | 旧/新 guard、标题生成、审批 transcript、**Ambient** | guard 已收口；标题/审批已收口；**Ambient 待抓包收口** |
| **Claude Code** | `/v1/messages`、`/:agent/:spaceId/v1/messages` | WebSearch 再入、压缩摘要、标题生成、fork/sidequery/subagent | WebSearch 三重信号待复核收口；压缩前缀待加；子代理标记待复核 |
| OpenAI 兼容兜底 | `POST /*` catch-all | 无专属清单 | 仅结构过滤；新网关将删除 catch-all，旧项目不扩大其用法 |

> cc-switch 仅作代理前端/配置切换器，代理层不抽取内容（已调研核实），不参与本方案。
> 除上述两类外当前无其他 Agent 产品接入；新增按 §6.5 执行。

### 6.7 改造待办闭环（落地前逐项完成）

1. 抓 Claude Code WebSearch 真实请求原始 body → 复核三重信号；
2. 抓 Claude Code 子代理（Agent/Task）真实请求 → 确认 billing 块 `cc_is_subagent` 实际形态、主请求 thinking 实际取值；
3. 抓 Codex Ambient 真实请求 body → 按 §6.4-3 三点决定升格结构 or 维持前缀；
4. 用真实 body 校准 §6.3/§6.4 各前缀条目的首行形态（含标题生成 prompt 当前版本）；
5. 合成冒烟 + 真实运行验证 L0 干净后，将 §4 未修项逐条闭环、§6.6 收口状态置为"已收口"。

---

## 7. 主要依据（调研来源，2026-09-08）

- cc-switch（Session Manager 块级净化手法）：github.com/farion1231/cc-switch —— `session_manager/providers/claude.rs`、`codex.rs`、`utils.rs`（代理层只记元数据不抽文本，已核实）
- claude-code-router（cc_is_subagent 判定）：`packages/core/src/gateway/claude-code-router-plugin.ts`
- Claude Code WebSearch 双源实测：quercle.dev/blog/claude-code-web-tools、github.com/diegosouzapw/OmniRoute/issues/1882
- 压缩摘要固定前缀实录：github.com/anthropics/claude-code/issues/82509
- 子代理 thinking disabled：github.com/anthropics/claude-code/issues/65863；fork 与主请求结构同构：issues/88755
- Codex Ambient 社区实测（thread_source=system 等）：community.openai.com/t/1385208
- headers 抓包实录：anthropics/claude-agent-sdk-python/issues/335
