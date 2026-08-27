/**
 * notes-bridge — reverse proxy for <proxy>/notes-bridge/v3/notes/* → Knowledge service.
 *
 * The model can discover/read team notes via Bash + curl without ever seeing
 * service credentials. The proxy stamps team/user/agent identity from the
 * initialized session, overwriting any body-supplied IDs.
 */

import type { Context } from "hono";
import { extractBearerToken } from "./opik.js";
import { apiKeyToKeyId } from "./opik.js";
import { getSessionStore } from "./session/store.js";
import { verifyUserKey, isAuthEnabled } from "./auth.js";
import type { ProxyConfig } from "./types.js";
import { readStrictUtf8RequestBody } from "./common/request-body-encoding.js";

const TAG = "[notes-bridge]";

const READ_SUBPATHS = new Set(["list", "get", "search", "tags/list", "tags/pages", "graph", "graph/mermaid", "revisions"]);
const WRITE_SUBPATHS = new Set(["create", "update", "delete"]);

interface SessionIds {
  user_id: string;
  team_id: string;
  agent_id: string;
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
  if (!s.user_id || !s.team_id || !s.agent_id) return null;
  return { user_id: s.user_id, team_id: s.team_id, agent_id: s.agent_id, space_id: s.space_id, user_key: s.user_key };
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
      // keep trying candidates
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

function envelope(code: number, message: string, httpStatus = 200) {
  return new Response(JSON.stringify({ code, message, request_id: `notes-bridge-${Date.now()}` }), {
    status: httpStatus,
    headers: { "content-type": "application/json" },
  });
}

export function createNotesBridgeHandler(config: ProxyConfig): (c: Context) => Promise<Response> {
  const endpoint = (config.knowledge?.endpoint || "").replace(/\/$/, "");
  if (!endpoint || !config.knowledge?.serviceToken) {
    return async () => envelope(50301, `${TAG} knowledge endpoint not configured`, 503);
  }

  return async (c: Context): Promise<Response> => {
    const path = new URL(c.req.url).pathname;
    const m = path.match(/^\/notes-bridge\/v3\/notes\/(.+)$/);
    const sub = m ? m[1].replace(/\/+$/, "") : "";
    if (!sub || (!READ_SUBPATHS.has(sub) && !WRITE_SUBPATHS.has(sub))) {
      return envelope(40401, `${TAG} unknown subpath ${sub || path}`, 404);
    }
    if (c.req.method !== "POST") return envelope(40501, `${TAG} POST only`, 405);

    const sessionKey = deriveSessionKey(c);
    let ids = loadIdsL1(sessionKey);
    if (!ids) {
      const auth = c.req.header("authorization") ?? c.req.header("Authorization") ?? "";
      const apiKey = extractBearerToken(auth);
      const spaceId = c.req.header("x-tdai-service-id") || config.knowledge.serviceId;
      if (apiKey && spaceId) ids = await loadIdsL2(apiKey, spaceId, sessionKey);
    }
    if (!ids) return envelope(40101, `${TAG} session not initialized`, 401);

    if (WRITE_SUBPATHS.has(sub) && !(config.knowledge?.allowLlmWrite ?? false)) {
      return envelope(40301, `${TAG} LLM note write access is disabled`, 403);
    }

    let body: Record<string, unknown> = {};
    try {
      let raw: string;
      if (WRITE_SUBPATHS.has(sub)) {
        const decoded = await readStrictUtf8RequestBody(c, TAG);
        if (!decoded.ok) {
          return envelope(decoded.code, decoded.message, decoded.httpStatus);
        }
        raw = decoded.text;
      } else {
        raw = await c.req.text();
      }
      if (raw.trim()) {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          return envelope(40001, `${TAG} body must be a JSON object`, 400);
        }
        body = parsed as Record<string, unknown>;
        if (WRITE_SUBPATHS.has(sub) && containsUtf8Replacement(body)) {
          console.warn(`${TAG} rejected non-UTF8 write body session=${sessionKey} sub=${sub}`);
          return envelope(42201, `${TAG} body contains invalid UTF-8 replacement characters. Do not inline Chinese in Git Bash curl. Write a UTF-8 JSON file and send it with --data-binary @file.`, 422);
        }
      }
    } catch {
      return envelope(40001, `${TAG} invalid JSON body`, 400);
    }

    const outbound = {
      ...body,
      team_id: ids.team_id,
      user_id: ids.user_id,
      agent_id: ids.agent_id,
    };
    const upstreamUrl = `${endpoint}/v3/notes/${sub}`;
    try {
      const resp = await fetch(upstreamUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.knowledge.serviceToken}`,
          "x-tdai-service-id": ids.space_id || config.knowledge.serviceId,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(outbound),
        signal: AbortSignal.timeout(Math.max(5000, config.knowledge.timeoutMs)),
      });
      const text = await resp.text();
      return new Response(text, {
        status: resp.status,
        headers: { "content-type": resp.headers.get("content-type") ?? "application/json" },
      });
    } catch (err) {
      return envelope(50301, `${TAG} upstream unavailable: ${err instanceof Error ? err.message : String(err)}`, 502);
    }
  };
}
