/**
 * Summary Tips contract injectors (Code Memory v2 L0.5).
 *
 * - SummaryTipsContractInjector: static system block, cacheStrategy=session_init.
 * - SummaryTipsReminderInjector: dynamic user.before reminder with persistent
 *   stage counters (count1/count2), cooldown, time cadence and session TTL.
 */

import type {
  AgentContext,
  CacheStrategy,
  ContextBlock,
  HookPriority,
  InjectionHook,
  PrewarmInput,
} from "../types.js";
import { HOOK_PRIORITY } from "../types.js";
import { getTdaiIdentity } from "../../tdai/identity.js";
import { normalizeMemoryCaptureMode, type MemoryCaptureMode } from "../../tdai/memory-mode.js";
import {
  loadTipsReminderState,
  resetTipsReminderStage,
  saveTipsReminderState,
  tipsReminderStateKey,
  type TipsReminderState,
} from "../../db/tips-reminder-repo.js";

export interface SummaryTipsInjectorConfig {
  proxyBaseUrl: string;
  submitPath?: string;
  enabled?: boolean;
  reminderEnabled?: boolean;
  maxReminderPerTask?: number;
  reminderCooldownSeconds?: number;
  firstUserReminder?: boolean;
  count1Threshold?: number;
  count2Threshold?: number;
  timeReminderSeconds?: number;
  sessionTtlSeconds?: number;
  defaultMode?: MemoryCaptureMode;
}

function modeFor(ctx: AgentContext, config: SummaryTipsInjectorConfig): MemoryCaptureMode {
  const custom = (ctx.metadata.custom ?? {}) as Record<string, unknown>;
  const session = custom.session as { memory_mode?: string } | undefined;
  return normalizeMemoryCaptureMode(session?.memory_mode)
    ?? normalizeMemoryCaptureMode(custom.memoryMode)
    ?? config.defaultMode
    ?? "code";
}

function modeActive(mode: MemoryCaptureMode): boolean {
  return mode === "code" || mode === "all";
}

function tipsSubmitUrl(config: SummaryTipsInjectorConfig): string {
  const base = config.proxyBaseUrl.replace(/\/$/, "");
  const submitPath = config.submitPath ?? "/memory-bridge/v3/tips/submit";
  return submitPath.startsWith("http") ? submitPath : `${base}${submitPath}`;
}

export function renderSummaryTipsContractBlock(config: SummaryTipsInjectorConfig, sessionId?: string, spaceId?: string): string {
  const submitUrl = tipsSubmitUrl(config);
  const sessionHeader = sessionId ? ` -H 'x-conversation-id: ${sessionId}'` : "";
  const tenantHeader = spaceId ? ` -H 'x-tdai-service-id: ${spaceId}'` : "";
  const headers = `${tenantHeader}${sessionHeader}`;
  return [
    "<summary_tips_contract>",
    "【作用】每完成一个任务或阶段，立即把可复用结果提交为 summary_tips；不提交，这些经验以后无法被记忆复用。",
    "",
    "【提交条件】必须同时满足：",
    "1. 已完成明确任务或流程；",
    "2. 有可复用的步骤、产物、经验、注意事项或用户反馈；",
    "3. 对未来项目经验有价值。",
    "",
    "【不要提交】普通问答、小改动、没有完整任务/流程，或无长期复用价值。",
    "【不要混淆】<summary>/<analysis> 是上下文压缩；本地 MEMORY.md/# Memory、Team Notes 都不是 summary_tips 提交。",
    "【失败处理】提交失败（40101/422xx/网络错误）时按错误修正后重试一次并确认成功；不得静默放弃。",
    "",
    "【要求】**满足条件必须立即主动提交，不等用户确认**。",
    "",
    "【提交】中文内容不要用 Git Bash 的 `curl -d` 直接内联，否则会乱码。",
    "1. 先用 Write 工具把 JSON 写到 `.summary_tips_payload.json`（UTF-8）；",
    `2. 执行：curl -sS -X POST ${submitUrl} -H 'content-type: application/json'${headers} --data-binary @.summary_tips_payload.json`,
    `JSON 示例：{"summary":"...","steps":["..."],"artifacts":["..."],"tags":["部署"]}`,
    "（proxy 自动注入 team/user/agent/session。）",
    "</summary_tips_contract>",
  ].join("\n");
}

export class SummaryTipsContractInjector implements InjectionHook {
  id = "summary-tips-contract-injector";
  point = "system.before_tools" as const;
  anchor = { slot: "knowledge", relation: "before" } as const;
  priority: HookPriority = HOOK_PRIORITY.WIKI - 2;
  description = "Inject the static <summary_tips_contract> block.";
  cacheStrategy: CacheStrategy = "session_init";

  constructor(private config: SummaryTipsInjectorConfig) {}

  execute(ctx: AgentContext): ContextBlock[] {
    if (this.config.enabled === false || !modeActive(modeFor(ctx, this.config))) return [];
    return this.renderBlocks(ctx);
  }

  prewarm(input: PrewarmInput): ContextBlock[] {
    const mode = normalizeMemoryCaptureMode(input.sessionInfo.memory_mode)
      ?? this.config.defaultMode
      ?? "code";
    if (this.config.enabled === false || !modeActive(mode)) return [];
    return this.renderBlocks(undefined, input.sessionInfo.session_id, input.sessionInfo.space_id);
  }

  private renderBlocks(ctx?: AgentContext, prewarmSessionId?: string, prewarmSpaceId?: string): ContextBlock[] {
    let sessionId = prewarmSessionId;
    let spaceId = prewarmSpaceId;
    if (ctx) {
      const custom = ctx.metadata.custom as Record<string, unknown> | undefined;
      const session = custom?.session as Record<string, unknown> | undefined;
      if (typeof session?.session_id === "string") sessionId = session.session_id;
      if (typeof session?.space_id === "string") spaceId = session.space_id;
    }
    return [{
      type: "text",
      content: renderSummaryTipsContractBlock(this.config, sessionId, spaceId),
      metadata: {
        source: this.id,
        cacheKey: `summary-tips-contract:${this.config.submitPath ?? "/memory-bridge/v3/tips/submit"}`,
      },
    }];
  }
}

// ── Dynamic reminder analysis ─────────────────────────────────────────────

interface ReminderTurnAnalysis {
  isHumanTextTurn: boolean;
  /** Last assistant message exists and its last effective block is text. */
  count1: boolean;
  /** count1 is true and the assistant answer has no unfinished tool_use. */
  count2: boolean;
  hasContract: boolean;
  /** Last user message contains a Claude Code <summary>...</summary> handoff. */
  hasSummaryTag: boolean;
}

/**
 * Match `<summary>...</summary>` anywhere in the text. `summary_tips_contract`
 * must not match (`_` is a word char, so `summary_tips` has no word boundary).
 */
function containsSummaryHandoff(text: string): boolean {
  return /<summary\b[^>]*>[\s\S]*?<\/summary\s*>/i.test(text);
}

function analyzeReminderTurn(ctx: AgentContext): ReminderTurnAnalysis {
  const last = ctx.messages[ctx.messages.length - 1];
  const hasContract = ctx.messages.some((m) =>
    m.role === "system" && m.blocks.some((b) => b.type === "text" && b.content.includes("<summary_tips_contract>")),
  );

  if (!last || last.role !== "user") {
    return { isHumanTextTurn: false, count1: false, count2: false, hasContract, hasSummaryTag: false };
  }
  const userText = last.blocks
    .filter((b) => b.type === "text")
    .map((b) => b.content)
    .join("\n");
  const isToolResultTurn = last.blocks.some((b) => b.type === "tool_result");
  if (isToolResultTurn || userText.trim().length === 0) {
    return { isHumanTextTurn: false, count1: false, count2: false, hasContract, hasSummaryTag: false };
  }
  const hasSummaryTag = containsSummaryHandoff(userText);

  let lastAssistantIdx = -1;
  for (let i = ctx.messages.length - 2; i >= 0; i--) {
    if (ctx.messages[i].role === "assistant") {
      lastAssistantIdx = i;
      break;
    }
  }
  if (lastAssistantIdx < 0) {
    // First human message of a brand-new conversation.
    return { isHumanTextTurn: true, count1: false, count2: false, hasContract, hasSummaryTag };
  }

  const asst = ctx.messages[lastAssistantIdx];
  const effective = asst.blocks.filter((b) => b.type !== "thinking");
  const count1 = effective.length > 0 && effective[effective.length - 1].type === "text";
  const count2 = count1 && !asst.blocks.some((b) => b.type === "tool_use");
  return { isHumanTextTurn: true, count1, count2, hasContract, hasSummaryTag };
}

function emptyReminderState(now: number): TipsReminderState {
  return {
    reminderCount: 0,
    count1: 0,
    count2: 0,
    lastReminderAt: 0,
    lastActiveAt: now,
    stageStartedAt: now,
    updatedAt: now,
  };
}

function renderReminderBlock(config: SummaryTipsInjectorConfig, hasContract: boolean, sessionId?: string, spaceId?: string): ContextBlock {
  const sessionHeader = sessionId ? ` -H 'x-conversation-id: ${sessionId}'` : "";
  const tenantHeader = spaceId ? ` -H 'x-tdai-service-id: ${spaceId}'` : "";
  const headers = `${tenantHeader}${sessionHeader}`;
  const baseLines = [
    "<system-reminder>",
    hasContract
      ? "【必须检查，本阶段持续生效】如果当前阶段已经产出可复用成果，必须现在按 summary_tips_contract 提交。"
      : "【必须检查，本阶段持续生效】如果当前阶段已经产出可复用成果，必须现在提交 summary_tips。",
    "注意：提交对象是 summary_tips 接口；<summary>/<analysis> 和本地 MEMORY.md / # Memory 都不是提交。",
    "",
    "判定条件，必须同时满足：",
    "1. 已完成明确任务或流程；",
    "2. 有步骤、产物、经验、注意事项或用户反馈；",
    "3. 对未来项目经验有价值。",
    "",
    "满足 → **立即提交**。",
  ];
  const actionLines = hasContract
    ? []
    : [
        "中文内容不要用 Git Bash 的 `curl -d` 直接内联。先用 Write 工具把 JSON 写到 `.summary_tips_payload.json`（UTF-8），再执行：",
        `curl -sS -X POST ${tipsSubmitUrl(config)} -H 'content-type: application/json'${headers} --data-binary @.summary_tips_payload.json`,
        `JSON 示例：{"summary":"...","steps":["..."],"artifacts":["..."],"tags":["..."]}`,
        "",
      ];
  const content = [
    ...baseLines,
    ...actionLines,
    "当前还不满足 → 继续当前任务，但后续每完成一个子任务，都要重新按这 3 条判断；一旦满足，立即提交。",
    "</system-reminder>",
  ].join("\n");

  return { type: "text", content, metadata: { source: "summary-tips-reminder-injector" } };
}

function renderSummaryHandoffReminderBlock(): ContextBlock {
  const content = [
    "<system-reminder>",
    "【检测到上下文压缩摘要】这是 Claude Code 的 <summary> 交接摘要，不等于已经提交 summary_tips。",
    "如果当前阶段已经产出可复用成果，必须现在调用 summary_tips 提交接口；",
    "本地 MEMORY.md / # Memory 文件也不能替代。",
    "提交方式见 summary_tips_contract。",
    "</system-reminder>",
  ].join("\n");
  return { type: "text", content, metadata: { source: "summary-tips-reminder-injector" } };
}

export class SummaryTipsReminderInjector implements InjectionHook {
  id = "summary-tips-reminder-injector";
  point = "user.before" as const;
  priority: HookPriority = HOOK_PRIORITY.MEMORY - 1;
  description = "Remind the model to submit a task summary after a completed stage.";

  constructor(private config: SummaryTipsInjectorConfig) {}

  async execute(ctx: AgentContext): Promise<ContextBlock[]> {
    if (this.config.enabled === false || this.config.reminderEnabled === false) return [];
    if (!modeActive(modeFor(ctx, this.config))) return [];

    const identity = getTdaiIdentity(ctx.metadata.custom);
    if (!identity?.sessionId) return [];

    const analysis = analyzeReminderTurn(ctx);
    if (!analysis.isHumanTextTurn) return [];

    const key = tipsReminderStateKey({
      spaceId: ctx.metadata.spaceId,
      userId: identity.userId ?? ctx.metadata.userId,
      agentSource: ctx.metadata.agentSource,
      sessionId: identity.sessionId,
      taskId: identity.taskId,
    });

    const now = Date.now();
    const ttlMs = Math.max(0, this.config.sessionTtlSeconds ?? 10800) * 1000;
    const cooldownMs = Math.max(0, this.config.reminderCooldownSeconds ?? 1800) * 1000;
    const max = Math.max(0, this.config.maxReminderPerTask ?? 2);

    let state = await loadTipsReminderState(key);
    if (!state) state = emptyReminderState(now);
    const expired = state.lastActiveAt > 0 && ttlMs > 0 && now - state.lastActiveAt > ttlMs;
    if (expired || state.stageStartedAt === 0) {
      state = emptyReminderState(now);
    }

    if (analysis.hasSummaryTag) {
      // Third trigger, independent from first-user / count1 / count2 / time.
      // The handoff summary starts a new post-compaction stage, so reset all
      // counters and record that this trigger itself was just injected.
      await resetTipsReminderStage(key, { lastReminderAt: now });
      const customSession = (ctx.metadata.custom?.session ?? {}) as Record<string, unknown>;
      const reminderSpaceId = typeof customSession.space_id === "string" ? customSession.space_id : ctx.metadata.spaceId;
      console.log(`[summary-tips-reminder-injector] summary-handoff session=${identity.sessionId}`);
      return [renderSummaryHandoffReminderBlock()];
    }

    const prev = { ...state };
    if (analysis.count1) state.count1 += 1;
    if (analysis.count2) state.count2 += 1;
    state.lastActiveAt = now;

    const isFirstStageTurn = prev.count1 === 0 && prev.count2 === 0;
    let shouldInject = false;

    if (max === 0) {
      shouldInject = false;
    } else if (isFirstStageTurn && this.config.firstUserReminder !== false) {
      shouldInject = true;
    } else if (state.reminderCount >= max) {
      shouldInject = false;
    } else if (now - state.lastReminderAt < cooldownMs) {
      shouldInject = false;
    } else if (state.count2 - prev.count2 >= (this.config.count2Threshold ?? 2)) {
      shouldInject = true;
    } else if (state.count1 - prev.count1 >= (this.config.count1Threshold ?? 3)) {
      shouldInject = true;
    } else if (
      (this.config.timeReminderSeconds ?? 600) > 0
      && state.count1 > prev.count1
      && now - state.lastReminderAt >= (this.config.timeReminderSeconds ?? 600) * 1000
    ) {
      shouldInject = true;
    }

    if (shouldInject) {
      state.reminderCount += 1;
      state.lastReminderAt = now;
    }

    await saveTipsReminderState(key, state);

    if (!shouldInject) return [];

    const customSession = (ctx.metadata.custom?.session ?? {}) as Record<string, unknown>;
    const reminderSpaceId = typeof customSession.space_id === "string" ? customSession.space_id : ctx.metadata.spaceId;
    return [renderReminderBlock(this.config, analysis.hasContract, identity.sessionId, reminderSpaceId)];
  }
}
