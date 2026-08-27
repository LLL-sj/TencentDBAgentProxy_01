/**
 * /api/v1/project/* — Code Memory v2 project memory panel routes.
 *
 * Code memory project files are team+agent scoped:
 *   L2: project/topics/*.md
 *   L3: project/MEMORY.md
 *
 * Panel is read-only here. Every endpoint requires an active team member,
 * resolves the MemoryCore isolation scope from block_id or team_id+agent_id,
 * then forwards to MemoryCore /v3/project/list|read.
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
}
