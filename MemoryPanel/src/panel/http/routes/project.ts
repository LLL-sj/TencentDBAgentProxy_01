/**
 * /api/v1/project/* — Code Memory v2 project memory panel routes.
 *
 * Code memory project files are team+agent scoped:
 *   L2: project/topics/*.md
 *   L3: project/MEMORY.md
 *
 * Read endpoints require an active team member. Write endpoints require the
 * block owner when a block_id is supplied (or team membership for legacy
 * agent_id-only callers), then forwards to MemoryCore /v3/project/*.
 *
 * block_id precedence follows the memory panel's existing block model:
 *   - `chat_memory-{team_id}-{agent_id}` is parsed to { team_id, agent_id }.
 *   - Any other id is rejected for project access because project storage is
 *     always team+agent scoped.
 */
import type { Context, Hono } from "hono";
import { validatePanelMetaHeaders } from "../middleware/validate-panel-headers.js";
import { respondControlError, respondEnvelope } from "../envelope.js";
import type { PanelDeps } from "../../panel-deps.js";
import { toKernelCredentials, type MetaCallContext } from "../../kernel/types.js";
import type { MetaEnvelope } from "../../kernel/envelope.js";
import {
  buildCtx,
  readJson,
  requireTeamMember,
  resolveCallerUserId,
  str,
} from "./knowledge/common.js";

interface ParsedChatMemoryBlock {
  teamId: string;
  agentId: string;
}

/** 从 chat_memory-{team_id}-{agent_id} 解出 team_id / agent_id。 */
function parseChatMemoryBlockId(blockId: string): ParsedChatMemoryBlock | null {
  if (!blockId.startsWith("chat_memory-")) return null;
  const inner = blockId.slice("chat_memory-".length);
  const dashAgt = inner.lastIndexOf("-agt");
  if (dashAgt <= 0) return null;
  return {
    teamId: inner.slice(0, dashAgt),
    agentId: inner.slice(dashAgt + 1),
  };
}

async function validateAgentInTeam(
  deps: PanelDeps,
  ctx: MetaCallContext,
  teamId: string,
  agentId: string,
): Promise<boolean> {
  try {
    const env = await deps.metaKernel.invoke("agent/get", { agent_id: agentId }, ctx);
    if (env.code !== 0) return false;
    const agent = (env.data ?? {}) as { team_id?: string };
    return agent.team_id === teamId;
  } catch {
    return false;
  }
}

/**
 * Project write permission gate.
 *
 * When the request has a chat_memory block_id, only the asset owner may edit
 * that agent's Code Memory project topics. For agent_id-only callers we keep
 * the previous team-member gate (used by internal/admin callers).
 */
async function authorizeProjectWrite(
  deps: PanelDeps,
  c: Context,
  ctx: MetaCallContext,
  body: Record<string, unknown>,
  teamId: string,
  agentId: string,
): Promise<{ userId: string } | { error: Response }> {
  const meUserId = await resolveCallerUserId(deps, ctx);
  if (!meUserId) return { error: respondControlError(c, 401, 'INVALID_USER_KEY') };
  const blockId = str(body, 'block_id');
  if (blockId) {
    const parsed = parseChatMemoryBlockId(blockId);
    if (!parsed || parsed.teamId !== teamId || parsed.agentId !== agentId) {
      return { error: respondControlError(c, 400, 'TEAM_AGENT_MISMATCH') };
    }
    const env = await deps.metaKernel.invoke('asset/get', { asset_id: blockId }, ctx);
    if (env.code !== 0 || !env.data) {
      return { error: respondControlError(c, 404, 'BLOCK_NOT_FOUND') };
    }
    const asset = env.data as { asset_type?: string; owner_user_id?: string };
    if (asset.asset_type !== 'chat_memory' || asset.owner_user_id !== meUserId) {
      return { error: respondControlError(c, 403, 'ASSET_NOT_EDITABLE') };
    }
    return { userId: meUserId };
  }

  const member = await requireTeamMember(deps, c, ctx, teamId);
  if ('error' in member) return member;
  return { userId: member.userId };
}

/**
 * Resolve the target MemoryCore scope.
 *
 * Returns:
 *   - { teamId, agentId } on success
 *   - Response for request errors
 */
async function resolveProjectScope(
  deps: PanelDeps,
  c: Context,
  ctx: MetaCallContext,
  body: Record<string, unknown>,
): Promise<{ teamId: string; agentId: string } | { error: Response }> {
  const teamId = str(body, "team_id");
  if (!teamId) return { error: respondControlError(c, 400, "MISSING_TEAM_ID") };

  const blockId = str(body, "block_id");
  const agentId = str(body, "agent_id");

  if (blockId) {
    const parsed = parseChatMemoryBlockId(blockId);
    if (!parsed) {
      return { error: respondControlError(c, 400, "PROJECT_BLOCK_SCOPE_UNRESOLVABLE") };
    }
    if (parsed.teamId !== teamId) {
      return { error: respondControlError(c, 400, "TEAM_MISMATCH") };
    }
    return { teamId, agentId: parsed.agentId };
  }

  if (agentId) {
    const ok = await validateAgentInTeam(deps, ctx, teamId, agentId);
    if (!ok) return { error: respondControlError(c, 400, "AGENT_NOT_IN_TEAM") };
    return { teamId, agentId };
  }

  return { error: respondControlError(c, 400, "MISSING_BLOCK_OR_AGENT") };
}

async function callProjectCore<T>(
  deps: PanelDeps,
  c: Context,
  ctx: MetaCallContext,
  path: string,
  body: Record<string, unknown>,
): Promise<{ data: T } | { error: Response }> {
  try {
    const cred = toKernelCredentials(ctx, { timeoutMs: deps.config.metadataRemoteTimeoutMs });
    const env = await deps.kernelHttp.postEnvelope<T>(path, body, cred);
    if (env.code !== 0) {
      const envelope: MetaEnvelope<unknown> = {
        code: env.code,
        message: env.message || "MEMORY_CORE_ERROR",
        request_id: env.request_id,
        data: env.data,
      };
      return { error: respondEnvelope(c, envelope) };
    }
    return { data: env.data };
  } catch {
    return { error: respondControlError(c, 502, "MEMORY_CORE_UNAVAILABLE") };
  }
}

export function registerProjectRoutes(api: Hono, deps: PanelDeps): void {
  const mw = validatePanelMetaHeaders(deps);

  api.post("/project/list", mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);

    const scope = await resolveProjectScope(deps, c, ctx, body);
    if ("error" in scope) return scope.error;

    const gate = await requireTeamMember(deps, c, ctx, scope.teamId);
    if ("error" in gate) return gate.error;

    const result = await callProjectCore(deps, c, ctx, "/v3/project/list", {
      team_id: scope.teamId,
      agent_id: scope.agentId,
      user_id: gate.userId,
    });
    if ("error" in result) return result.error;
    return respondEnvelope(c, {
      code: 0,
      message: "ok",
      request_id: c.get("reqId") ?? "",
      data: result.data,
    });
  });

  api.post("/project/read", mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);

    const topicPath = str(body, "path");
    if (!topicPath) return respondControlError(c, 400, "MISSING_PATH");

    const scope = await resolveProjectScope(deps, c, ctx, body);
    if ("error" in scope) return scope.error;

    const gate = await requireTeamMember(deps, c, ctx, scope.teamId);
    if ("error" in gate) return gate.error;

    const result = await callProjectCore(deps, c, ctx, "/v3/project/read", {
      team_id: scope.teamId,
      agent_id: scope.agentId,
      user_id: gate.userId,
      path: topicPath,
    });
    if ("error" in result) return result.error;
    return respondEnvelope(c, {
      code: 0,
      message: "ok",
      request_id: c.get("reqId") ?? "",
      data: result.data,
    });
  });

  api.post("/project/write", mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);

    const content = typeof body?.content === "string" ? body.content : "";
    const pathValue = str(body, "path");
    const nameValue = str(body, "name");
    if (!content || (!pathValue && !nameValue)) {
      return respondControlError(c, 400, "MISSING_PATH_OR_CONTENT");
    }

    const scope = await resolveProjectScope(deps, c, ctx, body);
    if ("error" in scope) return scope.error;

    const writeGate = await authorizeProjectWrite(deps, c, ctx, body, scope.teamId, scope.agentId);
    if ("error" in writeGate) return writeGate.error;

    const result = await callProjectCore(deps, c, ctx, "/v3/project/write", {
      team_id: scope.teamId,
      agent_id: scope.agentId,
      user_id: writeGate.userId,
      ...(pathValue ? { path: pathValue } : {}),
      ...(nameValue ? { name: nameValue } : {}),
      content,
    });
    if ("error" in result) return result.error;
    return respondEnvelope(c, {
      code: 0,
      message: "ok",
      request_id: c.get("reqId") ?? "",
      data: result.data,
    });
  });

  api.post("/project/delete", mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);

    const pathValue = str(body, "path");
    if (!pathValue) return respondControlError(c, 400, "MISSING_PATH");

    const scope = await resolveProjectScope(deps, c, ctx, body);
    if ("error" in scope) return scope.error;

    const writeGate = await authorizeProjectWrite(deps, c, ctx, body, scope.teamId, scope.agentId);
    if ("error" in writeGate) return writeGate.error;

    const result = await callProjectCore(deps, c, ctx, "/v3/project/rm", {
      team_id: scope.teamId,
      agent_id: scope.agentId,
      user_id: writeGate.userId,
      path: pathValue,
    });
    if ("error" in result) return result.error;
    return respondEnvelope(c, {
      code: 0,
      message: "ok",
      request_id: c.get("reqId") ?? "",
      data: result.data,
    });
  });
}
