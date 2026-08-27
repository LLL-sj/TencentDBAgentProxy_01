import type { AgentContext, AnchorTarget, CacheStrategy, ContextBlock, InjectionHook, HookPriority, PrewarmInput } from "../types.js";
import { HOOK_PRIORITY } from "../types.js";
import { TdaiClient } from "../../tdai/client.js";
import type { TdaiMemoryConfig } from "../../tdai/types.js";
import { getTdaiIdentity } from "../../tdai/identity.js";
import { normalizeMemoryCaptureMode, type MemoryCaptureMode } from "../../tdai/memory-mode.js";
import type { CoreSkillConfig } from "../../types.js";
import { getMetadataClient } from "../../meta/client.js";
import { resolveFixedAssetCtxs, type FixedAssetCtx } from "./tdai-fixed-asset.js";

/**
 * L2/L3 注入（按 openclaw / hermes 官方做法重构）：
 *   - L3 (persona) → 注入完整内容（稳定且通常较短，作为长期画像）
 *   - L2 (scenarios) → **只注入 Scene Navigation 索引（路径列表 + summary）**，
 *     不预读全文。LLM 需要细节时主动调 `tdai_read_scene` 工具按 path 拉取。
 *   - 同时附 memory-tools-guide 文案，告诉 LLM 怎么用工具 + 调用上限。
 *
 * 这样可以：
 *   1. 大幅降低首轮 token 消耗（L2 全文经常上千 chars × N 个）
 *   2. 让 LLM 按需取文，而不是被无关的场景污染上下文
 *
 * 跨 agent："自有 + 借入"按 agent 分段；每段下面 L3 + Scene 索引并列。
 *
 * 控制面不可达时降级：仅注入当前 agent 的 L3 + Scene 索引。
 */
export class TdaiProfileMemoryInjector implements InjectionHook {
  id = "tdai-profile-memory-injector";
  point = "system.suffix" as const;
  anchor: AnchorTarget = { slot: "memory", relation: "inside_append" };
  priority: HookPriority = HOOK_PRIORITY.MEMORY + 10;
  description = "Inject TDAI L3 (persona) + L2 scene index (path-only, agent reads via tool)";
  /** L2/L3 profile snapshot is injected once after session registration, like skill listing. */
  cacheStrategy: CacheStrategy = "session_init";

  /**
   * @param baseConfig  starter TdaiClient config; per-request `serviceId` will
   *   be overridden with `session.space_id` in `renderBlocksForContext`. This
   *   config's `serviceId` acts as a fallback when no `space_id` is present.
   * @param coreSkillCfg  kernel gateway config for MetadataClient (fixed-asset
   *   agent resolution).
   */
  constructor(
    private baseConfig: TdaiMemoryConfig,
    private coreSkillCfg: Pick<CoreSkillConfig, "endpoint" | "serviceToken" | "serviceId" | "timeoutMs"> | null = null,
    private proxyBaseUrl?: string,
  ) {}

  async execute(ctx: AgentContext): Promise<ContextBlock[]> {
    const caps = ctx.metadata.custom?.assetCapabilities as { chat_memory?: boolean } | undefined;
    if (caps?.chat_memory === false) return [];
    return this.renderBlocksForContext(ctx);
  }

  async prewarm(input: PrewarmInput): Promise<ContextBlock[]> {
    if (input.assetCapabilities?.chat_memory === false) return [];
    return this.renderBlocksForContext(createPrewarmAgentContext(input));
  }

  private async renderBlocksForContext(ctx: AgentContext): Promise<ContextBlock[]> {
    const identity = getTdaiIdentity(ctx.metadata.custom);
    if (!identity) return [];

    const session = (ctx.metadata.custom as any)?.session as { user_key?: string; space_id?: string; memory_mode?: string } | undefined;
    const userKey = session?.user_key;
    // spaceId 来自 session 注册时保存的 URL path 中的 `/proxy/<spaceId>/...`；
    // 用作内核的 `x-tdai-service-id` 头做租户路由。空字符串会被内核拒绝（invalid_user_key）
    // —— caller 已在 session-init 阶段做 bypass 处理。
    const spaceId = session?.space_id ?? "";
    const mc = this.coreSkillCfg && userKey
      ? getMetadataClient(this.coreSkillCfg, spaceId, userKey)
      : null;
    const ctxs = await resolveFixedAssetCtxs(ctx, identity, mc);

    const custom = (ctx.metadata.custom ?? {}) as Record<string, unknown>;
    const mode: MemoryCaptureMode = normalizeMemoryCaptureMode(session?.memory_mode)
      ?? normalizeMemoryCaptureMode(custom.memoryMode)
      ?? this.baseConfig.promptMode;
    if (mode === "none") return [];

    // Build a per-request TdaiClient with the correct tenant. Falls back to
    // baseConfig.serviceId (config value) when spaceId is empty.
    const client = new TdaiClient({
      ...this.baseConfig,
      promptMode: mode,
      serviceId: spaceId || this.baseConfig.serviceId,
    });

    if (mode === "all") {
      const chatClient = new TdaiClient({
        ...this.baseConfig,
        promptMode: "chat",
        codeMemoryVersion: "v1",
        serviceId: spaceId || this.baseConfig.serviceId,
      });
      const projectClient = new TdaiClient({
        ...this.baseConfig,
        promptMode: "code",
        codeMemoryVersion: "v2",
        serviceId: spaceId || this.baseConfig.serviceId,
      });
      return [
        ...await this.renderV2ProjectMemoryBlocks(ctxs, projectClient),
        ...await this.renderV1ProfileMemoryBlocks(ctxs, chatClient, "chat"),
      ];
    }

    if (mode === "code" && this.baseConfig.codeMemoryVersion === "v2") {
      return this.renderV2ProjectMemoryBlocks(ctxs, client);
    }

    return this.renderV1ProfileMemoryBlocks(
      ctxs,
      client,
      mode === "chat" ? "chat" : "code",
    );
  }

  private async renderV1ProfileMemoryBlocks(
    ctxs: FixedAssetCtx[],
    client: TdaiClient,
    promptMode: "chat" | "code",
  ): Promise<ContextBlock[]> {
    // 对每个 agent 独立拉 L3 + L2 索引（不读 L2 全文）
    const groups = await Promise.all(ctxs.map((c) => loadAgentProfile(client, c)));

    // 全部为空 → 仍注入 tools-guide（LLM 可主动 search L1 / 读 L2）
    const hasAnything = groups.some((g) => g.l3 || g.l2Entries.length > 0);
    if (!hasAnything) {
      return [{
        type: "text",
        content: getMemoryToolsGuide(promptMode),
        metadata: { source: this.id, agentCount: 0, l3Count: 0, l2Count: 0, mode: "tools-only", promptMode },
      }];
    }

    const lines: string[] = [
      "<tdai_profile_memory>",
      "以下是 TDAI 为当前 agent 维护的长期工作记忆（自有 + 借入分段；L2 仅给索引，按需用工具读全文）：",
    ];

    let l2TotalCount = 0;
    let l3Count = 0;
    for (const g of groups) {
      if (!g.l3 && g.l2Entries.length === 0) continue;
      const tag = g.ctx.isSelf ? "self" : "imported_from";
      lines.push(
        `<agent name=${JSON.stringify(g.ctx.agentName)} role=${JSON.stringify(tag)} agent_id=${JSON.stringify(g.ctx.agentId)}>`,
      );
      if (g.l3?.content) {
        l3Count++;
        lines.push("<l3_core_memory>", truncate(g.l3.content, 6000), "</l3_core_memory>");
      }
      if (g.l2Entries.length > 0) {
        lines.push("<l2_scene_index>");
        for (const e of g.l2Entries) {
          l2TotalCount++;
          // 索引行：路径 + summary（如果有）；正文用 tool 拉
          if (e.summary) {
            lines.push(`- \`${e.path}\` — ${truncate(e.summary, 200)}`);
          } else {
            lines.push(`- \`${e.path}\``);
          }
        }
        lines.push("</l2_scene_index>");
      }
      lines.push("</agent>");
    }

    lines.push("</tdai_profile_memory>");
    // 紧跟一段 memory-tools-guide，告诉 LLM 三个工具的用法 + 调用上限
    lines.push("");
    lines.push(getMemoryToolsGuide(promptMode));

    return [
      {
        type: "text",
        content: lines.join("\n"),
        metadata: {
          source: this.id,
          agentCount: groups.length,
          l3Count,
          l2IndexCount: l2TotalCount,
          mode: "index+tools",
          promptMode,
        },
      },
    ];
  }

  /**
   * Code Memory v2 injection:
   *   - inject only project/MEMORY.md index (no old L3 Doctrine, no L2 scene index);
   *   - topic bodies stay on demand via project/read|list|search bridge tools.
   */
  private async renderV2ProjectMemoryBlocks(ctxs: FixedAssetCtx[], client: TdaiClient): Promise<ContextBlock[]> {
    const groups = await Promise.all(ctxs.map(async (c) => ({
      ctx: c,
      index: await client.readProjectIndexForCtx(c),
    })));

    const hasIndex = groups.some((g) => g.index.trim().length > 0);
    const guide = getCodeV2ProjectMemoryToolsGuide(this.proxyBaseUrl);

    if (!hasIndex) {
      return [{
        type: "text",
        content: guide,
        metadata: { source: this.id, agentCount: groups.length, projectIndexCount: 0, mode: "v2-tools-only" },
      }];
    }

    const lines: string[] = [
      "<tdai_project_memory>",
      "以下是 TDAI 为当前 agent 维护的项目经验索引（project/MEMORY.md）。topic 正文不自动注入，按需用 project/read 读取。",
    ];

    let projectIndexCount = 0;
    for (const g of groups) {
      if (!g.index.trim()) continue;
      projectIndexCount++;
      const tag = g.ctx.isSelf ? "self" : "imported_from";
      lines.push(
        `<agent name=${JSON.stringify(g.ctx.agentName)} role=${JSON.stringify(tag)} agent_id=${JSON.stringify(g.ctx.agentId)}>`,
        "<project_memory_index>",
        truncate(g.index, 6000),
        "</project_memory_index>",
        "</agent>",
      );
    }
    lines.push("</tdai_project_memory>", "", guide);

    return [{
      type: "text",
      content: lines.join("\n"),
      metadata: {
        source: this.id,
        agentCount: groups.length,
        projectIndexCount,
        mode: "v2-index+tools",
      },
    }];
  }
}

function createPrewarmAgentContext(input: PrewarmInput): AgentContext {
  return {
    messages: [],
    tools: [],
    requestParams: {},
    metadata: {
      protocol: "anthropic",
      traceId: `prewarm:${input.keyId}`,
      keyId: input.keyId,
      modelId: "prewarm",
      stream: false,
      agentSource: "session-init",
      custom: { session: input.sessionInfo },
    },
  };
}

/** chat 模式记忆使用指南。L0/L1 按需用工具检索（不再自动召回），L3 直注、L2 索引直注。 */
export const CHAT_MEMORY_TOOLS_GUIDE = `<memory-tools-guide>
## ⚠️ 重要：这不是文档，这是你的可用能力

以下 \`<tdai_memory_tools>\` 中列出的 tdai_memory_search / tdai_conversation_search
等，是**你可以主动调用的能力**（不是仅供参考的文档）。它们通过 **Bash + curl**
使用（见上方 \`<tdai_memory_tools>\` 段里的完整调用说明与 URL）。

**禁止**回答类似"我没有这个工具 / 需要 MCP / 需要斜杠命令"。
**正确做法**：判定需要查记忆时，直接在 Bash 里执行 curl，proxy 会自动注入身份与鉴权。

## 记忆使用规则（遇到以下场景必须先查再答）

L3（persona 长期画像）与 L2 场景索引已直接注入 system。L0/L1 需要用工具主动检索。

### 必须先查记忆再回答的场景（命中任一条即触发工具调用）

1. **用户提及历史/过去/之前**：如 "我之前说过 / 我告诉过你 / 上次 / 你还记不记得 / 我们聊过 / 之前那个"
   → 用 \`tdai_conversation_search\`（L0 原文找具体消息）
2. **用户涉及自己身份/偏好/习惯**：如 "我叫什么 / 我的名字 / 我喜欢 / 我的团队 / 我常用 / 我不喜欢 / 我不允许"
   → 用 \`tdai_memory_search\`（L1 原子记忆查偏好/规则）
3. **用户要求你回忆/找**：如 "回忆一下 / 想起 / 找出 / 有没有关于 X 的记录 / 查我们之前"
   → 直接触发工具，不要凭空回答
4. **答案强依赖历史事实**：如 "那个 bug 我们怎么修的 / 上次方案是啥 / 我们的约定是什么"
   → 关键词化后 \`tdai_memory_search\`

**典型流程**（用户："我叫什么"）：
\`\`\`bash
# Step 1: 先查
curl -sfk -X POST <bridge>/atomic/search \\
  -H 'Content-Type: application/json' -H 'x-conversation-id: <sid>' \\
  -d '{"query": "用户姓名 name 身份", "limit": 5}'
# Step 2: 从 items[].content 里提取答案后回复
# 若为空: 明确告诉用户 "我在记忆里没找到，你叫什么？" —— 不要装作知道
\`\`\`

### 不需要查的场景

- 用户问 "你是谁" / "帮我改代码" / "写个脚本" / 通用编程问题
- 当前会话上下文（同轮消息）里已能回答
- 已经在 \`<l3_core_memory>\` 段落里直接看到答案

### ⚠️ 调用约束

- 每轮 \`tdai_memory_search\` + \`tdai_conversation_search\` **合计 ≤ 3 次**（\`tdai_read_scene\` / \`tdai_scenario_ls\` / \`tdai_atomic_query\` 不计入）
- 检索无果时**明确说明**"我在记忆里没找到 X"，不要幻想
- 同一 L2 path 不要重复读
</memory-tools-guide>`;

/** code / 项目 Agent 模式记忆使用指南。 */
export const CODE_MEMORY_TOOLS_GUIDE = `<memory-tools-guide>
## ⚠️ 重要：这不是文档，这是你的可用能力

以下 \`<tdai_memory_tools>\` 中列出的 tdai_memory_search / tdai_conversation_search
等，是**你可以主动调用的能力**（不是仅供参考的文档）。它们通过 **Bash + curl**
使用（见上方 \`<tdai_memory_tools>\` 段里的完整调用说明与 URL）。

**禁止**回答类似"我没有这个工具 / 需要 MCP / 需要斜杠命令"。
**正确做法**：判定需要查项目记忆时，直接在 Bash 里执行 curl，proxy 会自动注入身份与鉴权。

## 记忆使用规则（遇到以下场景必须先查再答）

本 Agent 使用项目工作记忆模式：L1 记忆类型为 \`work_fact\`（项目事实/决策/约束）、
\`work_task\`（任务/owner/deadline）、\`work_method\`（SOP/原则/禁忌/经验）、
\`work_artifact\`（文档/PR/Prompt/报告等资产）。
L3（Team Operating Doctrine）与 L2 场景索引已直接注入 system。L0/L1 需要用工具主动检索。

职责区分：
- 项目历史/经验/任务 → 用下面的 tdai_memory_* 工具查；
- 团队共享文档/纪要 → 用 <note_tools> 的 note_* 工具；
- 刚完成任务要沉淀总结 → 按 <summary_tips_contract> 提交 summary_tips。

### 必须先查记忆再回答的场景（命中任一条即触发工具调用）

1. **用户提到历史/之前/上次**：如 "我之前说过 / 上次 / 我们之前定的 / 你还记不记得 / 之前那个"
   → 用 \`tdai_conversation_search\`（L0 原文找具体消息）
2. **用户询问项目事实、决策、约束、状态**：如 "这个项目为什么用 X / 架构约束是什么 / 当前进度 / 线上风险"
   → 用 \`tdai_memory_search\`（L1 查 work_fact / work_task）
3. **用户询问任务、责任人或排期**：如 "谁在负责 / deadline / 下一步要做什么 / 还有什么没做完"
   → 用 \`tdai_memory_search\`（L1 查 work_task）
4. **用户询问该怎么做、有什么规矩/禁忌/经验**：如 "按什么流程 / 为什么这样取舍 / 不能怎么做 / 以前怎么处理的"
   → 用 \`tdai_memory_search\`（L1 查 work_method），必要时再用 \`tdai_read_scene\` 读 L2 正文
5. **用户要求回忆/找某个具体记录**：如 "回忆一下 / 找出 / 有没有关于 X 的记录 / 查我们之前"
   → 直接触发工具，不要凭空回答

**典型流程**（用户："上次那个超时问题后来怎么修的？"）：
\`\`\`bash
# Step 1: 先查 L1 工作记忆
curl -sfk -X POST <bridge>/atomic/search \\
  -H 'Content-Type: application/json' -H 'x-conversation-id: <sid>' \\
  -d '{"query": "超时问题 修复方案 work_method", "limit": 5}'
# Step 2: 如果 L1 只给了结论、需要原始上下文，再查 L0 原文
# Step 3: 从 items[].content 里提取答案后回复
# 若为空: 明确告诉用户 "我在项目记忆里没找到 X" —— 不要装作知道
\`\`\`

### 不需要查的场景

- 用户问 "你是谁" / 通用编程语法问题，且当前会话上下文已足够回答
- 当前会话上下文（同轮消息）里已能回答
- 已经在 \`<l3_core_memory>\` 或 \`<l2_scene_index>\` 段落里直接看到答案

### ⚠️ 调用约束

- 每轮 \`tdai_memory_search\` + \`tdai_conversation_search\` **合计 ≤ 3 次**（\`tdai_read_scene\` / \`tdai_scenario_ls\` / \`tdai_atomic_query\` 不计入）
- 检索无果时**明确说明**"我在项目记忆里没找到 X"，不要幻想
- 同一 L2 path 不要重复读
</memory-tools-guide>`;

function getMemoryToolsGuide(promptMode: "chat" | "code" = "code"): string {
  return promptMode === "code" ? CODE_MEMORY_TOOLS_GUIDE : CHAT_MEMORY_TOOLS_GUIDE;
}

function getCodeV2ProjectMemoryToolsGuide(proxyBaseUrl?: string): string {
  const bridge = proxyBaseUrl
    ? `${proxyBaseUrl.replace(/\/$/, "")}/memory-bridge/v3`
    : "<proxy>/memory-bridge/v3";
  return `<project-memory-tools-guide>
## 功能定位
这是当前 Agent 的项目长期记忆：
- project/topics/*.md 保存项目经验（SOP / 踩坑 / 决策 / 方法）；
- project/MEMORY.md 是这些经验的索引。
它不是 Team Notes。Team Notes 是团队手动共享文档，用 <note_tools> 操作。

## 什么时候必须查
用户问到下面任何一类，先查这里再回答：
1. 这个项目以前怎么做的 / 有没有经验 / 有没有 SOP；
2. 以前踩过什么坑、怎么规避；
3. 某个方案/决策当初为什么这样定；
4. 某个任务/组件的历史背景。

## 怎么查
Code Memory v2 只把 project/MEMORY.md 索引注入 system。topic 正文需要主动用 Bash + curl 读取：
- 列出 topics：curl -sfk -X POST ${bridge}/project/list -H 'Content-Type: application/json' -H 'x-conversation-id: <sid>' -d '{}'
- 读一个 topic：curl -sfk -X POST ${bridge}/project/read -H 'Content-Type: application/json' -H 'x-conversation-id: <sid>' -d '{"path":"topics/xxx.md"}'
- 搜索 topics：curl -sfk -X POST ${bridge}/project/search -H 'Content-Type: application/json' -H 'x-conversation-id: <sid>' -d '{"query":"关键词","limit":10}'

## 规则
1. 先看 MEMORY.md 索引；命中相关 topic 后再 read 正文。
2. 没 read 到就不要声称内容存在，不要编造经验。
3. project/list 和 project/search 不计入 tdai_memory_search 的 3 次限制。
</project-memory-tools-guide>`;
}

interface AgentProfileBundle {
  ctx: FixedAssetCtx;
  l3: { content: string } | null;
  /** L2 索引：仅 path + 可选 summary，**不**读全文。 */
  l2Entries: Array<{ path: string; summary?: string }>;
}

async function loadAgentProfile(client: TdaiClient, c: FixedAssetCtx): Promise<AgentProfileBundle> {
  const tdaiCtx = { teamId: c.teamId, userId: c.userId, agentId: c.agentId, agentName: c.agentName };
  const [l3, l2Entries] = await Promise.all([client.readL3ForCtx(tdaiCtx), client.listL2ForCtx(tdaiCtx)]);
  // L3(persona) 可能在尾部内嵌一份「Scene Navigation」场景索引（plugin 侧 read 会带导航段）。
  // 我们已经单独注入 <l2_scene_index>，必须剥掉 persona 尾部这份，避免 L2 索引重复注入。
  const l3Stripped = l3 ? stripSceneNavigation(l3.content) : "";
  return {
    ctx: c,
    l3: l3Stripped.trim() ? { content: l3Stripped } : null,
    l2Entries: (l2Entries ?? []).map((e) => ({ path: e.path, summary: e.summary })),
  };
}

/**
 * 剥离 persona 尾部的「Scene Navigation (Scene Index)」段。
 * 与 plugin 端 scene-navigation.ts 的 NAV_HEADER 对齐（带或不带前置 `---` 都能命中）。
 */
export function stripSceneNavigation(personaContent: string): string {
  const idx = personaContent.indexOf("## 🗺️ Scene Navigation");
  if (idx === -1) return personaContent;
  // 连同紧邻的 `---` 分隔符与前后空白一起去掉
  let cut = personaContent.slice(0, idx);
  cut = cut.replace(/\s*-{3,}\s*$/, "");
  return cut.trimEnd();
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n...[truncated ${s.length - max} chars]` : s;
}
