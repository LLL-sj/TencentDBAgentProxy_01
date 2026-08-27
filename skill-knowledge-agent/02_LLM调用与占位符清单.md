# LLM 调用与占位符清单（Skill + Knowledge）

> 本清单覆盖 **3 个真实 LLM 调用点**（skill review 1 个、knowledge wiki ingest 与摘要 2 类）+ 全部注入模板。
> 注入模板（skill listing / knowledge tools / memory tools）不调用 LLM，只拼文本。

---

## 0. 调用链速览

| # | 调用点 | 代码入口 | System Prompt | User Prompt |
|---|---|---|---|---|
| 1 | Skill Review | `core/skill/skill-extractor.ts` → `runSkillReview()` | `SKILL_REVIEW_PROMPT`（`core/skill/prompts/skill-review-prompt.ts`） | 代码拼接：hint + 会话切片 + `<<end-of-transcript>>` |
| 2 | Wiki 摄取（单阶段） | `MemoryKnowledge/engines/wiki/ingest-v2/llm.ts` → `generateText` | `buildSystemPrompt(template)` | `buildGeneratePrompt({sourceName, sourceText, existingPages, pagesToUpdate})` |
| 3 | Wiki 摄取（两阶段 OQ-4） | 同上 | ① `buildAnalysisSystemPrompt(template)` ② `buildSystemPrompt(template)` | ① `buildAnalysisPrompt(...)` ② `buildGenerateFromAnalysisPrompt({sourceName, sourceText, analysis, existingPages})` |
| 4 | Wiki 摘要 | `MemoryKnowledge/src/callback.ts` → `generateWikiSummary()` | 无（单 prompt） | 内联 prompt（见 `prompts/knowledge/02_wiki_summary_prompt.md`） |
| — | skill listing 注入 | `MemoryProxy/src/injection/injectors/skill-injector.ts` | 非 LLM | 非 LLM（`SKILL_LISTING_HEADER/FOOTER`） |
| — | knowledge tools 注入 | `MemoryProxy/src/injection/injectors/knowledge-tools-injector.ts` | 非 LLM | 非 LLM（只读工具说明） |

---

## 1. Skill Review（LLM 调用 #1）

### 1.1 配置链路

```text
gateway YAML 顶层 llm: { provider: openai|proxy, baseUrl, apiKey, model, maxTokens, timeoutMs }
  → resolveStandaloneLlmForRuntime(llmCfg, instanceId)
      provider=openai → 直接用 baseUrl/apiKey
      provider=proxy   → baseUrl = <context_proxy>/proxy/<instanceId>/v1（apiKey 走 memory system user key）
  → StandaloneLLMRunner（@ai-sdk/openai，OpenAI 兼容协议）
  → SkillExtractor
```

- 与记忆 L1/L2/L3 **共用同一 `llm` 配置块**（`gateway/config.ts` 会把它 splice 给 memory）。
- 未配置 `llm.baseUrl` → 抛 `SkillCoreError("LLM_UNAVAILABLE", "LLM baseUrl not configured for skill extraction")`；`provider=openai` 且无 apiKey 同样报错。

### 1.2 System Prompt

| 项 | 值 |
|---|---|
| 常量 | `SKILL_REVIEW_PROMPT` |
| 源码 | `MemoryCore/src/core/skill/prompts/skill-review-prompt.ts` |
| 文档 | `prompts/skill/01_skill_review_agent.md` |
| 占位符 | **无**（纯静态；工具名写死在提示词里） |

### 1.3 User Prompt 构造（`skill-extractor.ts`）

```text
[hintBlock（可选，主 Agent 注入的抽取提示，reason 非空时放最前）]
--- 
[recentBlock + truncated 会话切片]
<<end-of-transcript>>
Above is the past conversation to review. Now decide, and respond only per the output contract in the system prompt.
```

| 占位符/变量 | 含义 | 来源 |
|---|---|---|
| `recentBlock` | 最近一段归档上下文 | `prepare-archive` 产物 |
| `truncated` | 按 head/tail chars 截断的切片 | `skill.extraction.headChars / tailChars`（缺省走 `SkillExtractor` 内部默认） |
| `hint` | 主 Agent 的抽取提示 | 请求方传入（`extract` 时 reason 字段） |
| `maxTokens` | review 输出 token 上限 | `skill.extraction.maxTokens`（**独立于** `llm.maxTokens`） |
| `maxIterations` | 工具循环最大轮数 | `skill.extraction.maxIterations`（本部署 YAML=16；代码缺省 5） |

### 1.4 工具集（AI SDK tool-calling，模型驱动决策）

| 工具 | 用途 |
|---|---|
| `skill_list` / `skill_view` | 读（先 list 后 view，view 拿 `expected_version`） |
| `skill_create` / `skill_update` / `skill_patch` | 写（update/patch 需 `expected_version`，乐观锁） |
| `skill_files_write` | 写技能支撑文件（scripts/SQL/模板） |

输出契约：工具调用若干 + **一句摘要行**；无变更必须精确回 `Nothing to save.`。

---

## 2. Wiki Ingest（LLM 调用 #2 / #3）

### 2.1 配置链路

```text
环境变量 LLM_MODE / LLM_PROTOCOL / LLM_API_KEY / LLM_MODEL / LLM_BASE_URL / LLM_MAX_TOKENS / LLM_TIMEOUT_MS
  → resolveLlmConfig(serviceId, llmBindingStore.get(serviceId), fallback)
      binding.mode=proxy → baseUrl = trim(<proxy_base_url>)/proxy/<serviceId>/v1，apiKey = binding.api_key
      binding.mode=byo   → binding 自带 baseUrl/apiKey
      无 binding 且 fallback.mode=proxy → baseUrl/apiKey 置空 → createLlmClient 直接抛错（fail loudly）
  → normalizeLlmConfig（ingest-v2/llm.ts：兼容 customEndpoint/baseUrl/maxTokens/timeoutMs 别名）
  → createOpenAI 或 createAnthropic → generateText
```

- binding 写入方：`POST /v3/internal/llm-binding/set`（TMC 控制面 / 运维 curl，`x-tdai-service-id` 头必填）。

### 2.2 归一化默认值（`ingest-v2/llm.ts`）

| 项 | 默认 |
|---|---|
| model | `Memory-Model` |
| maxTokens | 8192（上层 env 默认 32768 覆盖） |
| timeoutMs | 1,200,000（20min） |
| protocol | `openai`（`/chat/completions`，compatibility: compatible）；`anthropic` → `/messages` |

### 2.3 提示词与占位符

| Builder | 角色 | 占位符 | 类型 | 来源 |
|---|---|---|---|---|
| `buildAnalysisSystemPrompt(template)` | 抽取规划者，只出计划不出页面 | `template.purpose`、`template.schema` | 模板注入 | wiki 模板（`ingest-v2/template.ts`） |
| `buildAnalysisPrompt(args)` | 分析阶段 user | `sourceName`、`existingPages[]`、`sourceText` | 工程填充 | 源文件 + 已有页清单 |
| `buildSystemPrompt(template)` | 生成阶段 system（格式契约 + FILE 块协议） | `template.purpose`、`template.schema` | 模板注入 | wiki 模板 |
| `buildGeneratePrompt(args)` | 单阶段生成 user | `sourceName`、`sourceText`、`existingPages[]`、`pagesToUpdate[]`（dedup 命中且未锁定的页原文） | 工程填充 | 同上 + dedup 结果 |
| `buildGenerateFromAnalysisPrompt(args)` | 两阶段生成 user | `sourceName`、`sourceText`、`analysis`、`existingPages[]` | 工程填充 | 分析阶段输出 + 源全文（查证用） |

### 2.4 内置输出协议（LLM 侧自填，工程侧只解析）

- `<<<FILE path="wiki/<dir>/<slug>.md">>>` ... `<<<END>>>` 多块输出；
- frontmatter `type` ∈ source|entity|concept|comparison|synthesis（决定目录）；
- 目录约定 `wiki/{sources,entities,concepts,comparisons,synthesis}/`；
- `[[wikilink]]` 只写页面标题（不带 `.md`、不带路径）；输出语言跟随源文档。

---

## 3. Wiki 摘要（LLM 调用 #4）

| 项 | 值 |
|---|---|
| 入口 | `MemoryKnowledge/src/callback.ts` → `generateWikiSummary()` |
| 时机 | wiki 就绪（ready）回调；code-graph 走模板，无 LLM |
| Prompt | 内联单 prompt：读页面标题+描述，要求 ≤100 字中文摘要 |
| 全文 | `prompts/knowledge/02_wiki_summary_prompt.md` |
| 配置 | 复用 `createLlmClient`（同一条 llm_binding 配置链，自动协议切换 + Langfuse 追踪 + 超时） |

---

## 4. 非 LLM 注入模板（对照，避免误判为 LLM 调用）

| 模板 | 常量/文件 | 注入时机 |
|---|---|---|
| `<available_skills>` header/footer | `SKILL_LISTING_HEADER` / `SKILL_LISTING_FOOTER`（`skill-listing-prompt.ts`）；内核 M5 路由层包好条目，proxy `SkillInjector` 原样注入 | session_init |
| `SKILLS_GUIDANCE` | 同上文件 | 可选（tool_guidance 区） |
| `<skill_tools>` 说明 | `MemoryProxy/src/injection/injectors/skill-tools-injector.ts` | system prompt |
| `<knowledge_tools>` 只读工具说明 | `MemoryProxy/src/injection/injectors/knowledge-tools-injector.ts` | system prompt |
