# 新 Agent 工作交接（TencentDB-Agent-Memory · 第十一轮维护 · Codex Responses / L0 过滤）

> 状态：本文是 HANDOFF9 之后的新交接，当前最新。
> Git：仍未 commit，HEAD `fe3230f`。三容器 healthy。
> 纪律：不 git commit；保留旧 `.bak`；重启 proxy 前先确认 `start-proxy.sh` 会挂载改动的源码。

---

## 0. 本轮完成内容（均已验证）

### 0.1 Codex OpenAI 流式断开：根因已修复

**根因不是流式转发丢字节，而是协议路由错误：**

- Codex 当前配置 `wire_api = "responses"`，请求路径：
  ```text
  POST /codebuddy/default/v1/responses
  ```
- 旧白名单没有 `/v1/responses`，`joinUrl` 兜底把它转发到了：
  ```text
  /v1/chat/completions
  ```
- Codex 等待 Responses SSE 的 `response.completed`，但上游返回 Chat Completions SSE 的 `data: [DONE]`，于是报：
  ```text
  stream disconnected before completion: stream closed before response.completed
  ```
- proxy 侧当时能看到 `doneSeen=true`、EOF 正常，说明不是 A/B/C 三种原猜想，而是 D：**协议端点映射错误**。

**修复：**

- `MemoryProxy/src/routes/whitelist.ts`：新增 `/v1/responses → /responses`。
- `MemoryProxy/src/guard-adapter.ts`：`joinUrl` 支持 `/responses`，完整 endpoint base 也识别 `/responses`。
- `MemoryProxy/src/handler.ts`：
  - `isResponsesApiRequest()` 识别 Responses 请求。
  - `responsesBodyToMessages()` 从 `input[]` 生成临时 `messages[]` 视图，仅用于 session/injection/L0 抽取。
  - `mergeResponsesBodyAfterInjection()` 把注入后的 system 文本合并回 `instructions`，动态 User 提醒插回 `input[]`，并删除临时 `messages`，原始 `input[]` 保留转发。
  - `normalizeResponsesTools()`：Responses 工具保持扁平格式，只移除无 `name` 工具；不再错误包装成 Chat Completions `function.name`。
  - SSE 解析支持：
    - usage：`response.completed.response.usage`
    - assistant 文本：`response.output_text.delta`
    - 工具参数：`response.function_call_arguments.delta`
  - 流式临时调试日志已移除；保留轻量 `[openai-stream]` 读错误/客户端 cancel/ finalize 失败日志。
- `deploy/global-images/start-proxy.sh`：增加 `routes/whitelist.ts` 和 `guard-adapter.ts` 源码挂载。

**验证：**

- 合成 Responses 请求返回 `response.completed`，模型输出正常。
- 真实 Codex 已跑多次工具调用，不再出现 `stream disconnected`，链路通。
- Chat Completions 旧路径 smoke test 仍返回 `data: [DONE]`。

### 0.2 Codex 内部请求污染 L0：已修复并配置化

**现象：** L0 出现标题生成 prompt、安全审批 transcript，transcript 内含大量工具调用参数/结果/浏览器内容。

**根因：**

- Codex 通过同一 Responses 路径发送标题生成、安全审批等内部请求。
- 旧 `isCodexGuardSession()` 只识别精确 `{"outcome":"allow"|"deny"}`；新版审批 JSON 带 `risk_level/user_authorization/rationale`，因此漏判。
- 标题生成和审批 transcript 前缀没有被过滤，最终作为 User 写入 L0。

**修复：**

- 保留旧 `isCodexGuardSession()`。
- 新增 `isNewCodexGuardSession()`：
  ```json
  {"risk_level":"low","user_authorization":"high","outcome":"allow","rationale":"..."}
  ```
- 两个 guard 一起调用：
  ```ts
  isCodexGuardSession(messages) || isNewCodexGuardSession(messages)
  ```
- 新增配置段：
  ```yaml
  codexInternal:
    promptPrefixes:
      - "You are a helpful assistant. You will be presented with a user prompt, and your job is to provide a short title"
      - "The following is the Codex agent history whose request action you are assessing"
      - "The following is the Codex agent history added since your last approval assessment"
  ```
- `extractLatestUserMessage()` 在 Codex 路径增加前缀过滤，命中任意前缀返回 `null`，整轮不写 L0。
- `.env` 可选覆盖变量：
  ```env
  MEMORY_CODEX_INTERNAL_PROMPT_PREFIXES
  ```
  多个前缀用 `|` 分隔；留空使用内置默认值。

**验证：**

- 合成标题前缀请求 → 无 `tdai-recorder:write-l0`。
- 合成新版 guard JSON 请求 → 无 `tdai-recorder:write-l0`。
- 普通用户消息 → 正常写 L0。
- 真实 Codex 多次工具调用后，用户确认最新 L0 已干净。

### 0.3 文档记录

新增/更新：

- `memory-agent/L0_ROUTING_AND_EXTRACTION.md`：Codex / Claude Code 的 L0 路由分类、User/Assistant 抽取调研，以及三条主链路速览（已吸收原 Codex 内部请求修复记录的精髓）。
- `memory-agent/MEMORY_MECHANISM.md`：
  - 新增 §9：L0 路由与真实 User/Assistant 抽取最终口径。
  - §5.2 更新 Codex Responses/Chat Completions 工具兼容说明。
- `memory-agent/TEAM_NOTES.md`：维护 Team Notes 当前口径（含原始字节编码校验）。
- `AGENT_INDEX.md`：增加/更新文件索引。

> 原 `memory-agent/CODEX_INTERNAL_REQUEST_L0_FIX.md` 已删除；其精华已合并进本交接和 `L0_ROUTING_AND_EXTRACTION.md`。

---

## 1. 当前未解决 / 留给下一轮

### 1.1 Claude Code WebSearch 内部请求可能污染 L0（未修，只记录）

- L0 曾出现：
  ```text
  Perform a web search for the query: ...
  ```
- 已确认与 Claude Code `WebSearch` 工具调用相关。
- 本地 transcript 中 tool_result 是 `Web search results for query: ...`，L0 中却是 `Perform a web search for the query: ...`，说明 proxy 收到的是 WebSearch 内部请求/合成 User prompt。
- 旧 proxy 日志已不可得，尚未抓到原始请求 body，无法最终确认其 `main/fork/sidequery` 分类。
- **决定：不采用工具专属正则**（换一个工具就失效）。后续应从请求结构/子代理分类层面做通用识别。
- 详见 `memory-agent/L0_ROUTING_AND_EXTRACTION.md` §4。

### 1.2 Responses 路径的已知边界

- Codex 实际始终 `stream=true`；**Responses 非流式** usage/assistant 解析尚未做完整适配，当前不使用。
- 新 Responses session 若进入 session-init 表单拦截，仍可能返回 Chat Completions 格式的伪造响应；当前线上都是已初始化会话，未暴露。
- Codex 内部请求目前过滤的是 L0 写入，但仍会走 injection pipeline；功能正确，token 上有优化空间。
- `costGuard` 当前 `enabled=false`；开启后 `/responses` 的 cost-guard 扩展路由未验证。

### 1.3 数据清理待办

- 历史 L0 污染记录仍在：
  - Codex 审批/标题旧记录（session `01a03eb0-*`）
  - Claude Code WebSearch 旧记录（session `e43b09f6-7933-4193-be4a-6b3a32fb8cf1`）
  - 本轮合成 smoke 测试记录 `final smoke responses 001`
- Core 已有 `/conversation/delete`，支持 `message_ids` 或 `session_id` 删除；清理前确认隔离字段和会话归属，不要直接手改 JSONL。

### 1.4 从 HANDOFF8 / HANDOFF9 继承的已知问题（摘要，仍有效）

| 编号 | 问题 | 当前状态 |
|---|---|---|
| H-13 | `start-proxy.sh` **没有挂载** `tdai-proxy-data:/data/tdai-memory-proxy`；重建 proxy 会丢 session / `tips_reminder_state` / hook cache | 仍未修；正式使用前必须加 |
| hub 前端 | hub 容器前端是 `docker cp` 热更新，不是镜像重建 | 未重打镜像；重建容器会回退旧前端 |
| hub 镜像 | 全量 hub 镜像构建曾在 knowledge `npm install` 卡住 | 尚未完成 |
| H-14 | 三个容器 `RestartPolicy=no`，WSL 重启后不会自动拉起 | 待用户确认是否改 `unless-stopped` |
| H-15 | `MEMORY_PROXY_PUBLIC_BASE_URL=http://127.0.0.1:8096` 仅同机可达 | 跨机/公网部署必须改实际地址 |
| H-16 | 容器日志 UTC，宿主机 CST(+8) | 可选挂载时区 |
| H-08 | proxy 日志反复出现 `[hook-cache] putMany failed ... FOREIGN KEY constraint failed` | 已记录未修，可能影响 hook 缓存命中 |
| H-09 | proxy 反复请求 `/v3/meta/agent-fixed-asset/list-with-detail`，hub 返回 404 | 已记录未修 |
| H-10 | 每次请求后 `CREDIT_REPORT ... fetch failed` | 非阻断，但日志噪音大 |

> 完整背景见 `NEW_AGENT_HANDOFF8.md` §3.6 和 `NEW_AGENT_HANDOFF9.md` §2。

---

## 2. 运维注意

- `start-proxy.sh` 现在生成 `codexInternal.promptPrefixes`；当前运行中的 `.proxy-config/config.yaml` 已手工插入该段。下次脚本重建会按脚本重新生成。
- `start-proxy.sh` 已新增挂载：
  - `MemoryProxy/src/routes/whitelist.ts`
  - `MemoryProxy/src/guard-adapter.ts`
- 仍沿用 HANDOFF9 注意事项：
  - proxy SQLite 卷仍未挂载：正式使用前必须在 `start-proxy.sh` 的 `docker run` 增加：
    ```bash
    -v tdai-proxy-data:/data/tdai-memory-proxy
    ```
    否则重建 proxy 会丢 session / `tips_reminder_state` / hook cache。
  - hub 前端仍是 `docker cp` 热更新，容器重建会回退旧镜像。
  - 日志时区 UTC，排查时 +8 小时。

---

## 3. 测试与状态

- `MemoryProxy npx tsc --noEmit`：通过。
- `MemoryProxy npm test`：当前无测试文件，vitest 返回 no test files（不是新增失败）。
- 三容器 healthy。
- proxy 最终重启时间：2026-08-26T16:19Z（移除临时调试日志后的最终冒烟验证），当前 healthy。
- 冒烟验证：
  - Responses API → `response.completed`
  - Chat Completions → `data: [DONE]`
- Git 未 commit，HEAD `fe3230f`。

---

## 4. 下轮建议优先级

1. 抓一次 Claude Code WebSearch 真实请求 body，确认分类与消息结构，再设计通用子代理/内部请求过滤。
2. 评估是否让 Codex 内部请求直接跳过 injection（当前只是 L0 不写）。
3. 按 §1.3 清理历史污染 L0。
4. 正式重跑 `start-proxy.sh` 重建一次 proxy，验证新挂载和 `codexInternal` 生成配置完全来自脚本。
