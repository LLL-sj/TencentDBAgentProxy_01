/**
 * tips-bridge — reverse proxy for <proxy>/memory-bridge/v3/tips/submit.
 *
 * The Agent submits a task summary after a completed flow. The proxy always
 * overwrites identity fields (team/user/agent/session/task) from the
 * initialized session; the model cannot forge tenancy or attribution.
 */

import type { Context } from "hono";
import { extractBearerToken, apiKeyToKeyId } from "./opik.js";
import { getSessionStore } from "./session/store.js";
import { verifyUserKey, isAuthEnabled } from "./auth.js";
import type { ProxyConfig } from "./types.js";
import { resetTipsReminderStage, tipsReminderStateKey } from "./db/tips-reminder-repo.js";
import { readStrictUtf8RequestBody } from "./common/request-body-encoding.js";

const TAG = "[tips-bridge]";

interface SessionIds {
  user_id: string;
  team_id: string;
  agent_id: string;
  session_id: string;
  task_id?: string;
  space_id?: string;
  user_key?: string;
}

function deriveSessionKey(c: Context): string {
  const auth = c.req.header("authorization") ?? c.req.header("Authorization") ?? "";
  const apiKey = extractBearerToken(auth);
  const keyId = apiKey ? apiKeyToKeyId(apiKey) : "unknown";
  const conversationId =
    c.req.header("x-conversation-id") ??
    c.req.header("x-session-id") ??
    c.req.header("x-chat-id") ??
    c.req.header("x-thread-id") ??
    c.req.header("x-claude-code-session-id") ??
    null;
  return conversationId ?? keyId;
}

function toIds(state: import("./session/types.js").SessionInitState | undefined): SessionIds | null {
  if (!state || state.status !== "initialized" || !state.sessionInfo) return null;
  const s = state.sessionInfo;
  if (!s.user_id || !s.team_id || !s.agent_id || !s.session_id) return null;
  return {
    user_id: s.user_id,
    team_id: s.team_id,
    agent_id: s.agent_id,
    session_id: s.session_id,
    task_id: s.task_id,
    space_id: s.space_id,
    user_key: s.user_key,
  };
}

function loadIdsL1(sessionKey: string): SessionIds | null {
  const store = getSessionStore();
  let state = store.get(sessionKey);
  if (!state && !sessionKey.includes(":")) {
    state = store.get(`codebuddy:${sessionKey}`) ?? store.get(`claude-code:${sessionKey}`);
  }
  return toIds(state);
}

async function loadIdsL2(apiKey: string, spaceId: string, sessionKey: string): Promise<SessionIds | null> {
  if (!isAuthEnabled() || !apiKey) return null;
  const verified = await verifyUserKey(apiKey, spaceId);
  if (verified.rejected || !verified.userId) return null;
  const candidates = sessionKey.includes(":")
    ? [sessionKey]
    : [sessionKey, `codebuddy:${sessionKey}`, `claude-code:${sessionKey}`];
  for (const composite of candidates) {
    const idx = composite.indexOf(":");
    const agentSource = idx > 0 ? composite.slice(0, idx) : "claude-code";
    const sessionId = idx > 0 ? composite.slice(idx + 1) : composite;
    try {
      const recovered = await getSessionStore().getOrRecover(
        composite,
        { userId: verified.userId, agentSource, sessionId, spaceId },
        {},
      );
      const ids = toIds(recovered);
      if (ids) return ids;
    } catch {
      // try next candidate
    }
  }
  return null;
}

function containsUtf8Replacement(value: unknown): boolean {
  if (typeof value === "string") return value.includes("\uFFFD");
  if (Array.isArray(value)) return value.some((item) => containsUtf8Replacement(item));
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((item) => containsUtf8Replacement(item));
  }
  return false;
}

function envelope(code: number, message: string, httpStatus = 200): Response {
  return new Response(JSON.stringify({
    code,
    message,
    request_id: `tips-bridge-${Date.now()}`,
    data: null,
  }), {
    status: httpStatus,
    headers: { "content-type": "application/json" },
  });
}

export function createTipsBridgeHandler(config: ProxyConfig): (c: Context) => Promise<Response> {
  const endpoint = (config.coreSkill.endpoint || "").replace(/\/$/, "");
  const upstreamToken = config.tdai?.apiKey || config.coreSkill.serviceToken || "";
  if (!endpoint) {
    return async () => envelope(50301, `${TAG} core endpoint not configured`, 503);
  }

  return async (c: Context): Promise<Response> => {
    if (!config.tips.enabled) {
      return envelope(40301, `${TAG} summary tips are disabled`, 403);
    }
    if (c.req.method !== "POST") {
      return envelope(40501, `${TAG} POST only`, 405);
    }

    const sessionKey = deriveSessionKey(c);
    let ids = loadIdsL1(sessionKey);
    if (!ids) {
      const auth = c.req.header("authorization") ?? c.req.header("Authorization") ?? "";
      const apiKey = extractBearerToken(auth);
      const spaceId = c.req.header("x-tdai-service-id") ?? config.tdai?.serviceId ?? config.coreSkill?.serviceId ?? "";
      if (apiKey && spaceId) ids = await loadIdsL2(apiKey, spaceId, sessionKey);
    }
    if (!ids) {
      const authHeader = c.req.header("authorization") ?? c.req.header("Authorization") ?? "";
      const conversationHeaders = [
        "x-conversation-id",
        "x-claude-code-session-id",
        "x-session-id",
        "x-chat-id",
        "x-thread-id",
      ];
      console.warn(
        `${TAG} 40101 session=${sessionKey} ` +
        `hasAuth=${authHeader.trim().length > 0} ` +
        `hasConversationHeader=${conversationHeaders.some((name) => (c.req.header(name) ?? "").trim().length > 0)} ` +
        `hasSpaceHeader=${(c.req.header("x-tdai-service-id") ?? "").trim().length > 0}`,
      );
      return envelope(40101, `${TAG} session not initialized`, 401);
    }

    const decoded = await readStrictUtf8RequestBody(c, TAG);
    if (!decoded.ok) {
      return envelope(decoded.code, decoded.message, decoded.httpStatus);
    }

    let body: Record<string, unknown> = {};
    try {
      const raw = decoded.text;
      if (raw.trim()) {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          return envelope(40001, `${TAG} body must be a JSON object`, 400);
        }
        body = parsed as Record<string, unknown>;
        if (containsUtf8Replacement(body)) {
          console.warn(`${TAG} rejected non-UTF8 body session=${sessionKey}`);
          return envelope(42201, `${TAG} body contains invalid UTF-8 replacement characters. Do not inline Chinese in Git Bash curl. Write a UTF-8 JSON file and send it with --data-binary @file.`, 422);
        }
      }
    } catch {
      return envelope(40001, `${TAG} invalid JSON body`, 400);
    }

    // Identity is always server-derived. Caller body values are ignored.
    const outbound: Record<string, unknown> = {
      ...body,
      team_id: ids.team_id,
      user_id: ids.user_id,
      agent_id: ids.agent_id,
      session_id: ids.session_id,
      ...(ids.task_id ? { task_id: ids.task_id } : {}),
    };

    const upstreamUrl = `${endpoint}/v3/tips/submit`;
    try {
      const resp = await fetch(upstreamUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${upstreamToken}`,
          "x-tdai-service-id": ids.space_id || config.tdai?.serviceId || config.coreSkill?.serviceId || "default",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(outbound),
        signal: AbortSignal.timeout(Math.max(5000, config.coreSkill.timeoutMs * 4)),
      });
      const text = await resp.text();
      if (resp.ok) {
        // A successful tip submission ends the current reminder stage.
        const idx = sessionKey.indexOf(":");
        const agentSource = idx > 0 ? sessionKey.slice(0, idx) : "claude-code";
        await resetTipsReminderStage(tipsReminderStateKey({
          spaceId: ids.space_id,
          userId: ids.user_id,
          agentSource,
          sessionId: ids.session_id,
          taskId: ids.task_id,
        }));
      }
      // Privacy: log metadata only, never the submitted summary text.
      console.log(
        `${TAG} session=${sessionKey} tip_bytes=${typeof body.summary === "string" ? Buffer.byteLength(body.summary, "utf8") : 0} ` +
        `tags=${Array.isArray(body.tags) ? body.tags.length : 0} status=${resp.status}`,
      );
      return new Response(text, {
        status: resp.status,
        headers: { "content-type": resp.headers.get("content-type") ?? "application/json" },
      });
    } catch (err) {
      return envelope(50301, `${TAG} upstream unavailable: ${err instanceof Error ? err.message : String(err)}`, 502);
    }
  };
}
