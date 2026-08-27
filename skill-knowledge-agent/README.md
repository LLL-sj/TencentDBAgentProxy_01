# Skill / Knowledge 资源配置与 LLM 调用（附：Agent 挂载调研）

> 与 `memory-agent/` 同格式的调研文档：本文件夹覆盖项目里**处理 Skill 与 Knowledge 的资源配置部分**，重点梳理它们各自的 LLM 调用点、提示词与占位符；并附录 **Agent 挂载 / 记忆继承** 的原理与 API 调研。
>
> 快速入口：仓库根目录 `NEW_AGENT_HANDOFF.md`（记忆模式改造）、`memory-agent/`（L0-L3 记忆）。

## 目录

```
skill-knowledge-agent/
├── 01_机制与流程图.md            # Skill / Knowledge 机制、触发链路、LLM 数据流
├── 02_LLM调用与占位符清单.md      # 全部 LLM 调用点 + 配置链路 + 占位符
├── 03_Agent挂载与记忆继承.md      # Agent 挂载/解绑 API、继承注入原理、面板现状
└── prompts/
    ├── skill/                    # Skill 侧提示词（每份提示词一个文件）
    │   ├── 01_skill_review_agent.md
    │   └── 02_skill_listing_header_footer.md
    ├── knowledge/                # Knowledge 侧提示词
    │   ├── 01_wiki_ingest_prompts.md
    │   └── 02_wiki_summary_prompt.md
    ├── shared/                   # 两侧共用的 LLM 配置链路说明
    │   └── 01_llm_config_chain.md
    └── README.md
```

## 核心规则（只需记住两条 LLM 配置链路）

```text
① Skill 侧（内核 memory-core 进程内）
   gateway YAML 顶层 llm: { provider, baseUrl, apiKey, model, ... }
   └── resolveStandaloneLlmForRuntime(llmCfg, instanceId)   # provider=proxy 时拼 /proxy/<iid>/v1
       └── SkillExtractor（Skill Review Agent，AI SDK 工具循环）

② Knowledge 侧（MemoryKnowledge 服务，独立进程）
   环境变量 LLM_MODE / LLM_PROTOCOL / LLM_API_KEY / LLM_MODEL / LLM_BASE_URL ...
   └── resolveLlmConfig(serviceId, llm_binding, fallback)
       ├── binding.mode=proxy → baseUrl = <proxy_base_url>/proxy/<serviceId>/v1（由 TMC/运维 set 进来）
       └── binding.mode=byo   → 自定义 OpenAI 兼容端点
       └── wiki ingest（单/两阶段）+ wiki 摘要（callback）
```

- Skill 的 LLM 与记忆 L1-L3 **共用同一个内核 `llm` 配置块**，不需要单独配置；协议目前走 OpenAI 兼容（`@ai-sdk/openai`）。
- Knowledge 是独立进程（默认端口 8421），它的 LLM 路由按 instance 粒度绑定（`/v3/internal/llm-binding/*`），默认 `proxy` 模式**没有绑定就大声失败**，不会静默直连。
- 两边都有**非 LLM 的注入面**：Skill 注入 `<available_skills>` / `<skill_tools>`，Knowledge 注入只读查询工具；这些不消耗模型调用。

---

## 附录：Agent 挂载 / 记忆继承（原理摘要）

> 完整调研见 `03_Agent挂载与记忆继承.md`。

**概念**：每个 `(team, agent)` 自动拥有一个 `chat_memory` 资产（ID 稳定推导：`chat_memory-{team_id}-{agent_id}`）。「挂载别人的 agent」= 把对方 agent 的 chat_memory 资产加进自己 agent 的固定资产绑定表（`/v3/meta/agent-fixed-asset/set`，全量替换语义；解绑=重发不包含该条的 bindings）。

**继承注入（MemoryProxy pipeline）**：

```text
请求（x-team-id / x-agent-id / x-user-key）
  → resolveFixedAssetCtxs()：查本 agent 绑定表（list-with-detail, visibility 过滤）
      只留 chat_memory 且解析出的 team == 本 team；排除自己；imported ≤ 2
  → 逐 agent 注入：L3 全文（≤6000 字）+ L2 只给场景索引（正文工具按需拉）
  → L1 不预注入，靠 memory-bridge 工具按需召回（可指定借入 agent）
  → 降级：内核不可达 → 只注入 self；session_init 缓存 → 新挂载对新会话生效
```

**权限**：`canBindAsset` 按资产 visibility 判定 —— `chat_memory` 默认 `private`，仅同 owner、同 team 可挂；跨用户需先把 visibility 改为 `team`（`asset/update`）。

**面板现状**：`agent-fixed-asset/*` 在 meta pass-through 被 `501 NOT_IN_SCOPE` 拦截，但面板已有专属业务路由 `chat-memory.ts`（allocate / unbind / set-agent-fixed…，借入 ≤2 校验）与前端 `ChatMemoryPage`（3 tab + 下拉选择 agent，无需手输 ID）—— **v2.0.0 源码里功能已完整实现**，看不到入口通常是部署的面板容器是旧镜像。
