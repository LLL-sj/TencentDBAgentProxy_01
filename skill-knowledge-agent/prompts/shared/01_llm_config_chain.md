# LLM 配置链路对照（Skill vs Knowledge）

> 两侧所有 LLM 调用的配置来源与解析路径，含失败策略。这是本文件夹的"一条规则"落地页。

---

## 1. Skill 侧（memory-core 进程内，与记忆 L1-L3 共用）

```text
gateway YAML 顶层 llm 块
  llm:
    baseUrl:   ${MEMORY_LLM_BASE_URL}
    apiKey:    ${MEMORY_LLM_API_KEY}
    model:     ${MEMORY_LLM_MODEL}
    provider:  openai | proxy          # gateway/config.ts 读 TDAI_LLM_PROVIDER 或 yaml
    maxTokens / timeoutMs
      │
      ▼
resolveStandaloneLlmForRuntime(llmCfg, instanceId)
  provider=openai → baseUrl/apiKey 直接用
  provider=proxy  → baseUrl = ${baseUrl}/proxy/${instanceId}/v1，Authorization 用 memory 系统用户 key
      │
      ▼
StandaloneLLMRunner（@ai-sdk/openai，OpenAI 兼容 /chat/completions）
      │
      ▼
SkillExtractor（Skill Review Agent 工具循环）
```

- 环境变量：`TDAI_LLM_PROVIDER / TDAI_LLM_BASE_URL / TDAI_LLM_API_KEY / TDAI_LLM_MODEL / TDAI_LLM_MAX_TOKENS / TDAI_LLM_TIMEOUT_MS`（env 优先级高于 yaml）。
- 本部署 `.env`：`MEMORY_LLM_BASE_URL=https://api.zhongjx.xyz/v1`、`MEMORY_LLM_MODEL=deepseek-v4-pro`、`MEMORY_LLM_PROTOCOL=openai`。
- 失败策略：`llm.baseUrl` 缺失 → `LLM_UNAVAILABLE`（"LLM baseUrl not configured for skill extraction"）；`provider=openai` 且无 apiKey → 同样报错。

## 2. Knowledge 侧（MemoryKnowledge 独立进程，8421）

```text
环境变量（config.ts loadConfig）
  LLM_MODE=proxy|custom   LLM_PROTOCOL=openai|anthropic
  LLM_API_KEY  LLM_MODEL(=Memory-Model)  LLM_BASE_URL
  LLM_MAX_TOKENS(=32768)  LLM_TIMEOUT_MS(=1200000)
      │
      ▼
resolveLlmConfig(serviceId, llmBindingStore.get(serviceId), fallback)
  ├─ binding.mode=proxy（默认推荐）
  │    baseUrl = trim(proxy_base_url) + /proxy/${serviceId}/v1
  │    apiKey  = binding.api_key
  ├─ binding.mode=byo
  │    用 binding 自带端点/密钥
  └─ 无 binding
       fallback.mode=custom → 用 env 的 baseUrl/apiKey（BYO）
       fallback.mode=proxy  → baseUrl/apiKey 置空 → createLlmClient 抛错（fail loudly，不静默直连）
      │
      ▼
normalizeLlmConfig（ingest-v2/llm.ts，兼容 customEndpoint/baseUrl/maxTokens/timeoutMs 别名）
      │
      ▼
generateText：protocol=openai → createOpenAI（compatibility: compatible）
             protocol=anthropic → createAnthropic
```

- binding 写入：`POST /v3/internal/llm-binding/set`（TMC 控制面/运维；`x-tdai-service-id` 头必填；幂等 upsert）。
- binding 查询：`POST /v3/internal/llm-binding/status`（不回传 api_key）、`POST /v3/internal/llm-binding/list`。
- 失败策略：proxy 模式缺 binding → **大声失败**（wiki ingest 报错），而不是偷偷走直连。

## 3. 对照表

| 维度 | Skill | Knowledge |
|---|---|---|
| 配置位置 | 内核 gateway YAML `llm:`（启动脚本由 `.env` 生成） | KS 服务环境变量 + 每 instance `llm_binding`（DB 行） |
| 动态路由 | `provider=proxy` 按 instanceId 拼 `/proxy/<iid>/v1` | `binding.mode=proxy` 按 serviceId 拼 `/proxy/<sid>/v1` |
| 协议 | OpenAI 兼容（固定） | openai / anthropic（可切） |
| 缺配置行为 | 报错 `LLM_UNAVAILABLE` | proxy 模式缺 binding → ingest 抛错 |
| 与记忆的关系 | 与 L1-L3 共用同一 llm 块 | 独立（KS 自己的进程与配置） |
