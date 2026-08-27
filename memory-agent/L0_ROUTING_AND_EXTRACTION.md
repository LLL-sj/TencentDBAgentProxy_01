# L0 路由与 User/Assistant 抽取说明（Codex / Claude Code）

> 状态：调研记录，当前口径。
> 范围：只讲“哪些请求会写 L0，以及 L0 的 User / Assistant 是怎么从原始请求/响应里抽出来的”。
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

---

## 5. 当前处理小结

| 客户端 | 已处理 | 方法 | 是否硬编码 |
|---|---|---|---|
| Codex | 旧版 guard 审批 | `isCodexGuardSession()` 精确 JSON | 保留兼容 |
| Codex | 新版 guard 审批 | `isNewCodexGuardSession()` 扩展 JSON | 代码 |
| Codex | 标题 / 审批 transcript | `codexInternal.promptPrefixes` 配置 | 配置化 |
| Claude Code | main/fork/sidequery 分类 | `cache_control` + tools + thinking | 代码 |
| Claude Code | harness wrapper 剥离 | `extractUserQueryText()` | 部分代码 |
| Claude Code | WebSearch 内部请求 | **未修，待抓包** | 待定 |
