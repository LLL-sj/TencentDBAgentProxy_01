/**
 * Session key resolution & conversation freshness check.
 *
 * Shared between handler.ts and anthropicHandler.ts.
 */
import type { Context } from "hono";

/** Extract conversation ID from request headers. Returns null if no valid ID found. */
export function resolveConversationId(c: Context): string | null {
  const id =
    c.req.header("x-conversation-id") ??
    c.req.header("x-session-id") ??
    c.req.header("x-claude-code-session-id") ?? // Claude Code CLI
    c.req.header("session-id") ??               // Codex Desktop (UUIDv7)
    c.req.header("x-chat-id") ??
    c.req.header("x-thread-id") ??
    c.req.header("thread-id") ??                // Codex Desktop (UUIDv7)
    null;

  if (id && id.length > 0) return id;

  // Fallback: Codex embeds session_id in X-Codex-Turn-Metadata JSON
  const turnMeta = c.req.header("x-codex-turn-metadata");
  if (turnMeta) {
    try {
      const meta = JSON.parse(turnMeta) as Record<string, unknown>;
      const sid = meta.session_id;
      if (typeof sid === "string" && sid.length > 0) return sid;
    } catch {
      // ignore parse errors
    }
  }

  return null;
}

/** Check whether the messages look like a fresh conversation (at most 1 user message, no assistant/tool). */
export function isFreshConversation(
  messages: Array<{ role?: string }>,
): boolean {
  let userCount = 0;
  for (const m of messages) {
    const role = m.role ?? "";
    if (role === "assistant" || role === "tool") return false;
    if (role === "user") userCount++;
    if (userCount > 1) return false;
  }
  return userCount <= 1;
}
