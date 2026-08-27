
import type { ConversationMessage } from "../../conversation/l0-recorder.js";
import type { SummaryTipDetail } from "../../tips/summary-tips.js";

/**
 * Code Memory v2 — L1 extraction prompt with L0.5 summary tips.
 *
 * Prompt text approved in:
 *   memory-agent/08_Phase3_L1v2_提示词评审稿.md
 *
 * Placement policy (NEW_AGENT_HANDOFF7 §4.7-A):
 *   - tips are filtered as status="pending" by team/agent/session/task by the caller;
 *   - tips inside the current L0 batch time range are inserted after the last
 *     message with timestamp <= l0_end_at (record_id refs remain a fallback);
 *   - late tips (end before this batch) are placed at the front and may be
 *     extracted tip-first;
 *   - future tips are deferred by the caller and are not injected this round;
 *   - the dedicated summary section below the new messages contains the
 *     configured rule line when tips exist, or the configured no-tips text.
 */

export const EXTRACT_WORK_MEMORIES_WITH_TIPS_SYSTEM_PROMPT = `你是专业的“工作情境切分与团队共享记忆提取专家”。
你的任务是分析多人工作消息和 Agent 提交的任务总结（SUMMARY_TIP），判断工作情境切换，并从中提取可在项目团队内共享的结构化工作记忆。

本任务面向工作场合的团队协作场景。你应重点提取项目事实、任务进展、决策结论、工作方法、SOP、禁忌、设计思路、交付物等对团队后续协作和 Agent 执行有长期价值的信息。

**输出语言**：所有自由文本字段（scene_name、memory content）使用与待提取消息主导语言相同的语言；JSON 字段名、枚举值、ISO 时间戳保持英文。

---

### 输入说明

你会收到三类内容：

1. 对话原文：事实来源（ground truth），按时间顺序排列，每条带 record_id。
2. SUMMARY_TIP：Agent 在任务结束后主动提交的总结，表示“这段对话完成了一个明确任务/流程，可能具有长期价值”。
3. 背景对话：仅用于理解上下文，不用于提取。

**核心优先级规则：**

- SUMMARY_TIP 是 Agent 对一段 L0 的高质量压缩总结，默认可信；没有 SUMMARY_TIP 的消息，按普通 L1 抽取规则处理，行为与 v1 完全一致。
- 当对应 L0 原文完整可见时：以 L0 原文为主，SUMMARY_TIP 用于确认重点、补全归纳和校准情境边界。
- 当对应 L0 不完整、已被截断或已在更早批次消费过时：可以直接以 SUMMARY_TIP 为主提取；此时 source_refs 使用 tip_id，confidence 给 0.8-0.95。
- 只有当 L0 原文与 SUMMARY_TIP 直接冲突时，才以 L0 原文为准。
- 不得仅根据 SUMMARY_TIP 编造原文没有的事实、时间、owner、deadline 或结论；原文缺失时只提取 tip 中已经明确陈述且适合团队共享的内容。

---

### 任务一：工作情境切分（Work Scene Segmentation）

分析【待提取的新消息】，结合【上一个情境】和【背景消息】，判断当前消息属于哪个工作情境。

【情境定义】
一个情境是围绕同一个项目、任务、模块、需求、问题、决策、事故、客户场景或工作目标展开的一组消息。

【继承条件】
如果新消息仍在延续上一个项目、任务、需求、问题或工作目标，则沿用上一个情境。

【切换条件】
出现以下情况之一，应切换或创建新的情境：
1. 讨论对象变成另一个项目、模块、需求、客户、Issue、PR、实验、事故或交付物。
2. 工作目标发生明显变化，例如从“需求讨论”切换到“上线排期”。
3. 明确出现新的独立任务、决策线程或问题排查线程。
4. 多个工作议题在同一批消息中连续出现，应拆分为多个情境。

【命名规则】
- 情境名称必须围绕工作对象命名。
- 推荐格式：“团队在围绕[项目/模块/议题]推进[目标活动]”。
- 长度约 30-50 个字符或等价长度，单句，全局唯一。

---

### 任务二：团队共享工作记忆提取（Work Memory Extraction）

结合背景、当前情境和 SUMMARY_TIP，仅从【待提取的新消息】中提取可共享的核心工作信息。

【通用提取原则】

1. 面向工作协作：
   - 提取出的记忆应能帮助团队成员或 Agent 在后续任务中理解项目背景、接续任务、复用经验或避免重复错误。
   - 不提取普通寒暄、闲聊、临时情绪表达、一次性工具请求。

2. 面向团队共享：
   - 提取内容默认会在项目团队内共享。
   - 只提取适合团队共享的工作内容。
   - 不提取与工作无关的个人偏好、私人生活或敏感信息。

3. 独立完整：
   - 每条记忆必须跳出当前对话仍能理解。
   - content 必须包含清晰主体、工作对象、结论、状态或方法。
   - 不要使用“这个”“那个”“上面说的”等依赖上下文的表达。

4. 准确归因：
   - 某人提出的建议、担忧、判断，不等于团队决策。
   - 只有出现明确确认、拍板、采纳、执行安排时，才能写成确定结论。
   - 未确认内容应表达为“团队正在讨论...”“某方案仍待确认...”“存在某风险...”。

5. 归纳合并：
   - 强关联的多条消息应合并成一条完整记忆。
   - 不要把同一个工作结论拆成多个碎片。
   - 但不同工作对象、不同任务、不同方法论应分开提取。

6. 只从新消息提取：
   - 【背景消息】只用于理解上下文、指代关系和时间。
   - 严禁从背景消息中新增提取记忆。
   - source_message_ids 必须只包含【待提取的新消息】中的 message id。

7. AI / Agent 输出处理：
   - 不要把 AI 的建议自动当成团队事实或团队决策。
   - 只有当人类成员采纳、确认，或 Agent 输出本身是明确的工具执行结果、交付物、实验结果时，才可以提取。
   - SUMMARY_TIP 是 Agent 对已完成流程的总结；在 L0 不完整时可作为提取依据，但仍需区分“已确认结论”和“Agent 建议”。

---

### 支持提取的四类工作记忆

memory type 必须从以下枚举中选择：

1. 工作事实（type: "work_fact"）
   - 项目事实、需求、决策、状态、风险、约束、实验结果、客户反馈。
2. 工作任务（type: "work_task"）
   - 待办、owner、deadline、下一步计划、任务状态变化。
3. 工作方法（type: "work_method"）
   - SOP、禁忌、原则、经验、设计思路、判断标准、Agent 行为规则。
4. 工作资产（type: "work_artifact"）
   - 文档、PR、Issue、Prompt、报告、代码分支、设计稿、链接等。

priority 参考标准与 v1 一致：
- 90-100：关键决策、核心需求、长期约束、重要风险、核心方法、重要资产、阻塞交付且有 deadline 的任务。
- 70-89：对当前项目有持续价值的一般事实、任务、方法或资产。
- <70：细碎、临时、低影响内容，直接丢弃。

metadata 建议与 v1 一致：
- work_task：owner、deadline、status
- work_method：scope、method_type
- work_artifact：artifact_type、artifact_ref
- work_fact：work_object、status、activity_start_time、activity_end_time

---

### 不应提取的内容

- 问候、寒暄、玩笑、无工作价值的闲聊。
- 临时性的一次性请求。
- 未被采纳的 AI 建议或临时草稿。
- 无明确后续价值的细节。
- 与团队工作无关的个人偏好、私人生活或敏感信息。
- SUMMARY_TIP 中与原文直接冲突、且原文更可信的结论。

---

### 任务三：输出格式规范（JSON）

返回且仅返回一个合法的 JSON 数组。数组的每一项是一个工作情境：

[
  {
    "scene_name": "工作情境名称",
    "message_ids": ["属于该情境的消息ID列表"],
    "memories": [
      {
        "content": "完整、独立、适合团队共享的工作记忆陈述",
        "type": "work_fact|work_task|work_method|work_artifact",
        "priority": 80,
        "source_message_ids": ["消息ID_1", "消息ID_2"],
        "source_refs": ["消息ID_1", "tip-xxx"],
        "confidence": 0.85,
        "metadata": {}
      }
    ]
  }
]

新增字段说明：
- source_refs：证据来源数组。优先使用消息 record_id；当 L0 原文完整时，tip_id 只作为辅助线索追加；当 L0 不完整、已截断或已消费过时，可以只写 tip_id。
- confidence：0-1 之间，表示该条记忆的置信度。SUMMARY_TIP 覆盖且原文能支撑的段落可给更高先验（建议 0.8-0.95）；普通原文提取建议 0.5-0.8；推测性内容必须低于 0.5 或直接不提取。

如果整段新消息无有意义的团队共享工作记忆，也要输出情境分割结果，memories 为空数组。

请严格按上述 JSON 数组格式输出，不要输出任何额外的 Markdown 代码块修饰符或解释文本。`;

export interface L1V2ShortTexts {
  /** Template for one <SUMMARY_TIP> block. */
  summaryTipBlockTemplate: string;
  /** Text rendered in the summary section when this batch has no pending tips. */
  noSummaryTipsText: string;
  /** Rule text rendered in the summary section when this batch has tips. */
  summaryTipRuleText: string;
}

export const DEFAULT_L1_V2_SHORT_TEXTS: L1V2ShortTexts = {
  summaryTipBlockTemplate: `<SUMMARY_TIP id="{{tip_id}}" covers="{{l0_start_ref}}..{{l0_end_ref}}" tags="{{tags_csv}}">\n{{summary}}\n</SUMMARY_TIP>`,
  noSummaryTipsText: "（本批没有 Agent 提交的 SUMMARY_TIP）",
  summaryTipRuleText:
    "SUMMARY_TIP 是 Agent 对一段 L0 的高质量压缩总结，默认可信：L0 完整时用于确认重点和补全归纳；L0 不完整或已消费过时，可直接以 SUMMARY_TIP 为主提取。",
};

export interface L1V2SummaryTipPromptItem {
  tip_id: string;
  l0_start_ref: string;
  l0_end_ref: string;
  l0_start_at?: number | null;
  l0_end_at?: number | null;
  tags: string[];
  summary: string;
  created_at?: string;
}

export const DEFAULT_L1_V2_MAX_TIP_CHARS = 4000;

/**
 * Render one message line. This format is generated by engineering code and
 * intentionally does not live in config.
 */
export function formatL1V2MessageLine(message: ConversationMessage, seq: number): string {
  const iso = new Date(message.timestamp).toISOString();
  return `[seq=${seq} record_id=${message.id} ${iso} ${message.role}] ${message.content}`;
}

/** Render all message lines, with seq starting from 1. */
export function formatL1V2MessagesText(messages: ConversationMessage[]): string {
  return messages.map((m, i) => formatL1V2MessageLine(m, i + 1)).join("\n\n");
}

/** Replace the configurable placeholders in the SUMMARY_TIP block template. */
export function renderSummaryTipBlock(
  tip: L1V2SummaryTipPromptItem,
  template: string = DEFAULT_L1_V2_SHORT_TEXTS.summaryTipBlockTemplate,
  maxSummaryChars: number = DEFAULT_L1_V2_MAX_TIP_CHARS,
): string {
  const summary = tip.summary.length > maxSummaryChars
    ? `${tip.summary.slice(0, maxSummaryChars)}\n…(truncated)`
    : tip.summary;
  return template
    .replaceAll("{{tip_id}}", tip.tip_id)
    .replaceAll("{{l0_start_ref}}", tip.l0_start_ref ?? "")
    .replaceAll("{{l0_end_ref}}", tip.l0_end_ref ?? "")
    .replaceAll("{{tags_csv}}", tip.tags.join(","))
    .replaceAll("{{summary}}", summary);
}

function anchorIndex(tip: L1V2SummaryTipPromptItem, ids: string[]): number {
  const end = ids.indexOf(tip.l0_end_ref);
  if (end >= 0) return end;
  const start = ids.indexOf(tip.l0_start_ref);
  if (start >= 0) return start;
  return ids.length;
}

/** Order tips by their anchor position in the message stream, then created_at. */
export function sortSummaryTipsByAnchor(
  tips: L1V2SummaryTipPromptItem[],
  messageIds: string[],
): L1V2SummaryTipPromptItem[] {
  return [...tips].sort((a, b) => {
    const delta = anchorIndex(a, messageIds) - anchorIndex(b, messageIds);
    if (delta !== 0) return delta;
    return String(a.created_at ?? "").localeCompare(String(b.created_at ?? ""));
  });
}

/**
 * Partition pending tips against the current batch time range.
 * - selected: tips whose L0 range is before or inside this batch (inject now)
 * - deferred: tips whose L0 range starts after this batch (keep pending)
 *
 * Tips without timestamp anchors are treated as late tips so legacy pending
 * rows are consumed rather than being silently re-appended forever.
 */
export function partitionSummaryTipsByBatchTime(
  newMessages: ConversationMessage[],
  tips: L1V2SummaryTipPromptItem[],
): { selected: L1V2SummaryTipPromptItem[]; deferred: L1V2SummaryTipPromptItem[] } {
  if (newMessages.length === 0) return { selected: [], deferred: tips };
  const minTs = Math.min(...newMessages.map((m) => m.timestamp));
  const maxTs = Math.max(...newMessages.map((m) => m.timestamp));
  const selected: L1V2SummaryTipPromptItem[] = [];
  const deferred: L1V2SummaryTipPromptItem[] = [];
  for (const tip of tips) {
    const anchorAt = typeof tip.l0_end_at === "number" ? tip.l0_end_at : tip.l0_start_at;
    if (typeof anchorAt === "number" && anchorAt > maxTs) {
      deferred.push(tip);
    } else {
      selected.push(tip);
    }
  }
  return { selected, deferred };
}

interface PlacedTips {
  late: L1V2SummaryTipPromptItem[];
  /** Map from new-message index to tips rendered immediately after it. */
  inline: Map<number, L1V2SummaryTipPromptItem[]>;
}

function placeTipsInMessageStream(
  newMessages: ConversationMessage[],
  tips: L1V2SummaryTipPromptItem[],
): PlacedTips {
  const ids = newMessages.map((m) => m.id);
  const late: L1V2SummaryTipPromptItem[] = [];
  const inline = new Map<number, L1V2SummaryTipPromptItem[]>();
  const minTs = newMessages.length > 0 ? Math.min(...newMessages.map((m) => m.timestamp)) : 0;
  const sorted = [...tips].sort((a, b) =>
    ((a.l0_end_at ?? a.l0_start_at ?? 0) - (b.l0_end_at ?? b.l0_start_at ?? 0))
    || String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")),
  );

  for (const tip of sorted) {
    let index = -1;
    if (typeof tip.l0_end_at === "number" && tip.l0_end_at >= minTs) {
      for (let i = newMessages.length - 1; i >= 0; i--) {
        if (newMessages[i].timestamp <= tip.l0_end_at!) {
          index = i;
          break;
        }
      }
    } else if (typeof tip.l0_end_at !== "number") {
      // Legacy tips without timestamps: keep the old ref-based positioning.
      const end = ids.indexOf(tip.l0_end_ref);
      if (end >= 0) index = end;
      else {
        const start = ids.indexOf(tip.l0_start_ref);
        if (start >= 0) index = start;
      }
    }
    if (index < 0) {
      late.push(tip);
      continue;
    }
    const bucket = inline.get(index) ?? [];
    bucket.push(tip);
    inline.set(index, bucket);
  }
  return { late, inline };
}

/**
 * Insert rendered SUMMARY_TIP blocks into the message stream.
 *
 * - late tips are rendered before the first message (their L0 has already been
 *   consumed by earlier batches);
 * - in-range tips are rendered after the last message whose timestamp is
 *   <= tip.l0_end_at (record_id refs remain the legacy fallback);
 * - future tips are not accepted here — the caller must defer them.
 */
export function formatL1V2MessagesWithTips(
  newMessages: ConversationMessage[],
  tips: L1V2SummaryTipPromptItem[],
  shortTexts: L1V2ShortTexts = DEFAULT_L1_V2_SHORT_TEXTS,
  maxTipChars: number = DEFAULT_L1_V2_MAX_TIP_CHARS,
): string {
  const { late, inline } = placeTipsInMessageStream(newMessages, tips);
  const lines: string[] = [];

  for (const tip of late) {
    lines.push(renderSummaryTipBlock(tip, shortTexts.summaryTipBlockTemplate, maxTipChars));
  }

  for (let i = 0; i < newMessages.length; i++) {
    lines.push(formatL1V2MessageLine(newMessages[i], i + 1));
    for (const tip of inline.get(i) ?? []) {
      lines.push(renderSummaryTipBlock(tip, shortTexts.summaryTipBlockTemplate, maxTipChars));
    }
  }

  return lines.join("\n\n");
}

export interface FormatL1V2ExtractionPromptParams {
  newMessages: ConversationMessage[];
  backgroundMessages?: ConversationMessage[];
  previousSceneName?: string;
  summaryTips?: L1V2SummaryTipPromptItem[];
  shortTexts?: L1V2ShortTexts;
  maxTipChars?: number;
}

/**
 * User prompt for L1 v2. Structure follows the approved §3 template:
 * previous scene / background / new messages (tips interleaved at their
 * l0_end_ref positions) / summary-tip rule or no-tips placeholder.
 */
export function formatL1V2ExtractionPrompt(params: FormatL1V2ExtractionPromptParams): string {
  const {
    newMessages,
    backgroundMessages = [],
    previousSceneName = "无",
    summaryTips = [],
    shortTexts = DEFAULT_L1_V2_SHORT_TEXTS,
    maxTipChars = DEFAULT_L1_V2_MAX_TIP_CHARS,
  } = params;

  const bgText = backgroundMessages.length > 0
    ? formatL1V2MessagesText(backgroundMessages)
    : "无";

  const newText = summaryTips.length > 0
    ? formatL1V2MessagesWithTips(newMessages, summaryTips, shortTexts, maxTipChars)
    : formatL1V2MessagesText(newMessages);

  const summaryTipsText = summaryTips.length > 0
    ? shortTexts.summaryTipRuleText
    : shortTexts.noSummaryTipsText;

  return `**输出语言**：根据下方"待提取的新消息"中 user 发言的主导语言书写 scene_name 和 memory content。

【上一个情境】：${previousSceneName}

【背景对话】（仅供理解上下文推断关系/时间，严禁从中提取记忆）：
${bgText}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

【待提取的新消息】（务必结合 timestamp 推算时间，只从这里提取记忆！）：
${newText}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

【Agent 任务总结】：
${summaryTipsText}`;
}
