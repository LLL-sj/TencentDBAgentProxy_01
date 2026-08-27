import type { TdaiClient } from "./client.js";
import type { TdaiIdentity, TdaiMessage } from "./types.js";
import { extractUserQueryText } from "../common/user-query-extractor.js";
import { resolveAgentAdapter } from "../agent-adapters/index.js";

// 保留 re-export，避免下游 import 路径变化引发一次性大改。
export { extractUserQueryText };

// ── Codex guard session 识别 ─────────────────────────────────────────────────
//
// 背景：Codex 每次执行工具前会向内部 guard 模型发送安全审批请求。guard 请求
// 走同一个 /codebuddy/.../chat/completions 端点，messages 内含完整对话
// transcript（单条可达数十 KB），但其 assistant 回复恒为机器可读的 JSON 判决
// 而非自然语言。这类内部审批不应写入 L0 记忆。
//
// 判断策略：从后向前找到第一条 role=assistant 的消息，检查其 content 是否
// 精确等于 guard 输出的两种可能值。使用字符串 === 比较而非 JSON.parse：
//   1. 无需解析大段 transcript，零内存额外开销
//   2. guard 模型输出格式是 Codex 协议的固定契约（OpenAI 定义），
//      不随 system prompt 变更而改变，比匹配 system prompt 文本更稳定
//   3. 用户不可能恰好键入 {outcome:allow} 作为对话内容（单行 JSON 对象
//      含键名 outcome，真实用户输入不含此模式）

/**
 * 判断 messages[] 是否为 Codex 内部 guard 审批 session。
 * 返回 true → 整条请求跳过 L0 记录，不占缓存和磁盘。
 */
function isCodexGuardSession(messages: unknown[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as Record<string, unknown>;
    if (msg?.role !== "assistant") continue;
    const c = msg.content;
    if (typeof c !== "string") return false;
    return c === '{"outcome":"allow"}' || c === '{"outcome":"deny"}';
  }
  return false;
}

/**
 * 判断 messages[] 是否为新版 Codex 内部 guard 审批 session。
 *
 * 新版审批 assistant 输出不再只是精确的 {"outcome":"allow"}，而是带更多字段：
 *   {"risk_level":"low","user_authorization":"high","outcome":"allow","rationale":"..."}
 *
 * 判断条件：最后一条 assistant 的 content 能解析为 JSON 对象，且：
 *   - outcome ∈ allow | deny
 *   - 同时存在 risk_level / user_authorization / rationale 中至少一个字段
 *
 * 与旧 isCodexGuardSession() 平行保留，两个一起使用，避免旧版/新版任一漏判。
 */
function isNewCodexGuardSession(messages: unknown[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as Record<string, unknown>;
    if (msg?.role !== "assistant") continue;
    const c = msg.content;
    if (typeof c !== "string") return false;
    try {
      const parsed = JSON.parse(c) as Record<string, unknown>;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
      const outcome = parsed.outcome;
      if (outcome !== "allow" && outcome !== "deny") return false;
      return (
        typeof parsed.risk_level === "string" ||
        typeof parsed.user_authorization === "string" ||
        typeof parsed.rationale === "string"
      );
    } catch {
      return false;
    }
  }
  return false;
}

/** 检查文本是否命中 Codex 内部 prompt 前缀（标题生成 / 审批 transcript）。 */
function isCodexInternalPrompt(text: string, promptPrefixes: readonly string[]): boolean {
  if (!text || promptPrefixes.length === 0) return false;
  const trimmed = text.trimStart();
  return promptPrefixes.some((prefix) => prefix.length > 0 && trimmed.startsWith(prefix));
}

// ── Session 级 L0 去重 ─────────────────────────────────────────────────────
//
// 背景：tool-call 循环中，CC 每次 HTTP 请求都携带完整对话历史。
// 同一条 user message 会被重复发送多次，导致 L0 写入完全相同的记录。
// 这里按 sessionId 维度的内容 hash 去重，避免 L0 被污染。
//
// user 和 assistant 各自独立 hash set。拼成一个 hash 的教训：
// tool-call 循环中 assistant 从 null 逐渐变成流式文本 → 每次 hash 都不同 → 去重失效。
// 分开追踪：user 命中只跳过 user，不阻塞 assistant 首次写入；反之亦然。
// 每个 session 上限防止长连接内存膨胀；超出时淘汰前半（LRU-like）。

const l0UserDedup = new Map<string, Set<string>>();
const l0AssistantDedup = new Map<string, Set<string>>();
const DEDUP_MAX_PER_SESSION = 100;

function seen(sessionId: string, text: string, pool: Map<string, Set<string>>): boolean {
  let set = pool.get(sessionId);
  if (!set) {
    set = new Set<string>();
    pool.set(sessionId, set);
  }
  if (set.has(text)) return true;
  if (set.size >= DEDUP_MAX_PER_SESSION) {
    const entries = Array.from(set);
    set.clear();
    for (const h of entries.slice(-Math.floor(DEDUP_MAX_PER_SESSION / 2))) {
      set.add(h);
    }
  }
  set.add(text);
  return false;
}

/**
 * 从原始请求 messages[] 中提取「真正用户键入的文本」。
 *
 * 提取策略分两层：
 *   1. 结构层（agent adapter）：按客户端/协议规则从 content blocks 中取文本
 *      - claude-code (Anthropic)：只取最后一个 type:"text" block，
 *        跳过 <system-reminder> / tool_result / image / thinking 等
 *      - codebuddy (OpenAI)：优先取 <user_query> 块，否则剥离 CB wrapper
 *      - unknown：保守拼接所有 text block（等价老逻辑）
 *   2. 文本层（extractUserQueryText）：剥离 text block 内部嵌入的系统上下文
 *      （Multica workspace 提示、CC 内部标记等第一层没过滤干净的残留）。
 *
 * @param messages 原始请求 body.messages
 * @param agentSource 客户端类型，从 URL 前缀解析（"claude-code" / "codebuddy" 等）
 */
export function extractLatestUserMessage(
  messages: unknown[],
  agentSource: string = "claude-code",
  codexInternalPromptPrefixes: readonly string[] = [],
): TdaiMessage | null {
  // 跳过 Codex guard 审批 session —— 内部安全闸门请求不含用户对话，不应进 L0。
  // 旧版精确 JSON 和新版扩展 JSON 两种 guard 判断平行保留，一起使用。
  if (isCodexGuardSession(messages) || isNewCodexGuardSession(messages)) return null;

  const adapter = resolveAgentAdapter(agentSource);

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as Record<string, unknown>;
    if (msg?.role !== "user") continue;

    // 第一层：agent adapter 做结构化过滤 ——
    // 只取用户键入文本，丢弃 tool_result / tool_use / image / thinking block
    const userText = adapter.extractUserText(msg.content);
    if (!userText || !userText.trim()) continue;

    // 第二层：extractUserQueryText 做文本级清理 ——
    // 剥离 text block 内嵌的系统上下文（Multica、CC 标记等）
    const cleaned = extractUserQueryText(userText);
    if (cleaned.trim()) {
      // Codex 内部 prompt 前缀过滤（标题生成 / 安全审批 transcript）。
      // 命中任意前缀 → 整条请求视为内部请求，不写 L0。
      if (agentSource === "codebuddy" && isCodexInternalPrompt(cleaned, codexInternalPromptPrefixes)) {
        return null;
      }
      return { role: "user", content: cleaned };
    }
  }
  return null;
}

/**
 * 写入一轮 user + assistant 对话到 L0 记忆。
 *
 * 内置保护：
 *   - Session 级去重：同一 session 内相同 content hash 不重复写入，
 *     避免 tool-call 循环中 CC 重复携带同一 user message 导致的 L0 膨胀。
 *   - 空内容跳过：user 为空或 identity 缺失时直接返回。
 *   - Assistant 内容只保留纯文本：调用方传入前已过滤 tool_use/tool_result。
 */
export async function recordTdaiTurn(
  client: TdaiClient,
  identity: TdaiIdentity | null,
  userMessage: TdaiMessage | null,
  assistantContent: string | null | undefined,
): Promise<void> {
  if (!identity || !userMessage) return;

  const sessionId = identity.sessionId;
  const userText = userMessage.content.trim();
  const assistantText = assistantContent?.trim() || null;

  if (!userText) return;

  // Session 级去重：user / assistant 各自独立追踪。
  // 同一轮请求中 user 可能已见过但 assistant 是新的（或反过来），
  // 只跳过已见过的消息，不因为一个重复就丢掉另一个。
  const userDup = sessionId ? seen(sessionId, userText, l0UserDedup) : false;
  const assistantDup = sessionId && assistantText ? seen(sessionId, assistantText, l0AssistantDedup) : false;

  if (userDup && (assistantDup || !assistantText)) {
    console.log('[tdai-recorder] dedup-skip session=%s userLen=%d assistantLen=%d',
      sessionId, userText.length, assistantText?.length ?? 0);
    return;
  }

  // 只写入本轮新出现的消息
  const messages: TdaiMessage[] = [];
  if (!userDup) {
    messages.push(userMessage);
  }
  if (assistantText && !assistantDup) {
    messages.push({ role: "assistant", content: assistantText });
  }
  if (messages.length > 0) {
    await client.addConversation(identity, messages);
  }
}
