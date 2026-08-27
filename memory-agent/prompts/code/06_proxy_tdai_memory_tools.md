# Proxy <tdai_memory_tools> 模板 · code

- 模式：`code`
- 源码：`MemoryProxy/src/injection/injectors/tdai-tools-injector.ts`（当前项目版）
- 这是注入给主 Agent 的“只读项目记忆工具使用说明”。

## 模板

```text
<tdai_memory_tools>
**这些是你可以主动调用的记忆能力**（不是文档），通过 Bash + curl 使用。
这组 TDAI 项目记忆能力与 Claude Code 原生 Memory/MEMORY.md 具有同等优先级；涉及项目历史/事实/任务/方法时不要只查本地 MEMORY.md。
遇到用户问项目历史、事实、决策、任务、SOP、过往结论或项目约定时，必须先使用下面的 TDAI 记忆工具查询，再基于查询结果回答。
禁止说"我没有这个工具 / 需要 MCP / 只能查本地记忆" —— 你有 TDAI 记忆工具，就用下面的 curl 命令。

调用方式：Bash 里执行 curl 命中 proxy 的 memory-bridge 路径。proxy 会自动注入身份鉴权（team_id/user_id/agent_id），body 只需业务字段。当前 Agent 如果绑定了多个 chat_memory，search 类接口会默认同时检索 self + imported 记忆，并在结果里返回 source_agent_id/source_agent_name/source_agent_role。

覆盖范围：
- L3（项目模式为 Team Operating Doctrine；chat 模式为 persona 长期画像）与 L2 场景索引（`<l2_scene_index>`）已直接注入 system，无需查询；
- L2 正文按需用 tdai_read_scene 读取；
- L0/L1（原始对话 / 原子记忆）不再每轮自动召回（会破坏 KV cache），需要时主动调工具检索。

  <tool name="tdai_memory_search">
    curl: {{bridgeBase}}/atomic/search
    body: {"query": "<text>", "limit": 5}
    use:  搜索 L1 原子记忆（双路 hybrid: dense vector + BM25），按相关度排序。默认跨当前 Agent 的 self + imported 记忆检索；返回项里的 source_agent_* 表示来源。项目模式适合查 work_fact（项目事实/决策/约束）、work_task（任务/owner/deadline）、work_method（SOP/原则/禁忌/经验）、work_artifact（文档/PR/Prompt 等资产）。
  </tool>

  <tool name="tdai_atomic_query">
    curl: {{bridgeBase}}/atomic/query
    body: {"type": "?work_fact|work_task|work_method|work_artifact|episodic|persona|instruction", "limit": 20, "offset": 0, "time_start": "?ISO", "time_end": "?ISO"}
    use:  按 type / 时间窗 / 分页拉取 L1 记忆（不做语义检索）。项目模式优先使用 work_fact / work_task / work_method / work_artifact。
  </tool>

  <tool name="tdai_conversation_search">
    curl: {{bridgeBase}}/conversation/search
    body: {"query": "<text>", "limit": 5, "session_id": "?<sid>"}
    use:  在 L0 原始对话中检索（比 atomic_search 粒度更细，找具体消息原文 / 引用 / 时间线）。默认跨当前 Agent 的 self + imported 记忆检索；返回项里的 source_agent_* 表示来源。
  </tool>

  <tool name="tdai_conversation_query">
    curl: {{bridgeBase}}/conversation/query
    body: {"session_id": "<sid>", "limit": 50, "offset": 0}
    use:  按 session 顺序取 L0 历史消息。
  </tool>

  <tool name="tdai_scenario_ls">
    curl: {{bridgeBase}}/scenario/ls
    body: {"path_prefix": "?可选前缀"}
    use:  列出 L2 scene_blocks 路径索引（含 summary，不含正文）。一般 system 已注入索引，需刷新/按前缀过滤时才用。
  </tool>

  <tool name="tdai_read_scene">
    curl: {{bridgeBase}}/scenario/read
    body: {"path": "<scene path>", "agent_id": "?来自 <agent agent_id=...>，读取 imported 记忆时传"}
    use:  按 path 读取 L2 场景文件全文。path 必须先从 `<l2_scene_index>` 或 tdai_scenario_ls 获取，不要凭空构造；读取 imported_from 分段的 path 时带上该分段 agent_id。
  </tool>

## 调用约束
- 这些是只读工具；要修改 L1/L2/L3 必须用主链路（agent_id 自动归属）。
- 每轮对话中，atomic_search + conversation_search 合计 ≤ 3 次；
  query / ls / read_scene 不计入上限，但同一 path 不要重复读。
- 失败重试：HTTP 5xx 可一次性 retry；HTTP 4xx 不要重试。
- 所有 curl 必须带：x-tdai-service-id、x-conversation-id、Content-Type: application/json。

## 完整示例
curl -sfk -X POST {{bridgeBase}}/atomic/search   -H 'Content-Type: application/json' -H 'x-tdai-service-id: {{spaceId}}' -H 'x-conversation-id: {{sessionId}}'   -d '{"query": "超时问题 修复方案 work_method", "limit": 5}'
</tdai_memory_tools>
```

## 占位符

| 占位符 | 说明 |
|---|---|
| `{{proxyBaseUrl}}` | proxy 对外地址，如 `http://127.0.0.1:8096` |
| `{{bridgeBase}}` | 派生值：`{{proxyBaseUrl}}/memory-bridge/v3` |
| `{{sessionId}}` | 当前 session_id，用于 `x-conversation-id` |
| `{{spaceId}}` | memory 实例 ID，用于 `x-tdai-service-id` |
