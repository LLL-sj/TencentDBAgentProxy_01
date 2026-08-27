/**
 * /api/v1/tips/* — L0.5 summary_tips panel routes.
 *
 * Panel is read-only for tips. Every endpoint requires an active team member,
 * then forwards to MemoryCore /v3/tips/list|get.
 *
 * MemoryCore /v3 strict isolation requires team_id + agent_id + user_id even
 * though /v3/tips/list is a team-wide view (the core handler ignores
 * agent_id). The panel resolves a concrete team agent as the tenancy marker;
 * agent_id/tags filtering is performed panel-side after fetching core pages.
 */
import type { Context, Hono } from "hono";
import { validatePanelMetaHeaders } from "../middleware/validate-panel-headers.js";
import { respondControlError, respondEnvelope } from "../envelope.js";
import type { PanelDeps } from "../../panel-deps.js";
import { toKernelCredentials, type MetaCallContext } from "../../kernel/types.js";
import type { MetaEnvelope } from "../../kernel/envelope.js";
import {
  buildCtx,
  okEnvelope,
  readJson,
  requireTeamMember,
  str,
  strArray,
} from "./knowledge/common.js";

const TIP_STATUSES = ["pending", "consuming", "consumed", "duplicate", "expired"] as const;
type TipStatus = (typeof TIP_STATUSES)[number];

const CORE_PAGE_SIZE = 200;
const MAX_SCAN_ITEMS = 2000;

export interface SummaryTipItem {
  tip_id: string;
  team_id: string;
  agent_id: string;
  user_id: string;
  session_id: string;
  task_id: string;
  l0_start_ref: string;
  l0_end_ref: string;
  l0_refs: string[];
  summary: string;
  steps: string[];
  artifacts: string[];
  tags: string[];
  user_feedback_received: boolean;
  status: TipStatus;
  version: number;
  created_at: string;
  updated_at: string;
}

interface CoreTipsListData {
  items?: SummaryTipItem[];
  total?: number;
}

function intOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) ? value : null;
}

function normalizeStatus(value: string | null): TipStatus | null {
  if (!value) return null;
  return TIP_STATUSES.includes(value as TipStatus) ? (value as TipStatus) : null;
}

/**
 * Resolve the agent_id used to satisfy MemoryCore /v3 strict isolation.
 * Explicit body.agent_id is validated against meta agent/get + team scope.
 * When absent, the first active agent of the team is used.
 *
 * Returns:
 *   - agent_id string on success
 *   - null when the team has no active agent
 *   - Response for call/validation errors
 */
async function resolveTipContextAgent(
  deps: PanelDeps,
  ctx: MetaCallContext,
  c: Context,
  teamId: string,
  body: Record<string, unknown>,
): Promise<string | null | Response> {
  const requested = str(body, "agent_id");
  if (requested) {
    try {
      const env = await deps.metaKernel.invoke("agent/get", { agent_id: requested }, ctx);
      const agent = (env.data ?? {}) as { team_id?: string };
      if (env.code !== 0 || !agent || agent.team_id !== teamId) {
        return respondControlError(c, 400, "AGENT_NOT_IN_TEAM");
      }
      return requested;
    } catch {
      return respondControlError(c, 502, "META_KERNEL_UNAVAILABLE");
    }
  }

  try {
    const env = await deps.metaKernel.invoke(
      "agent/list",
      { team_id: teamId, status: "active", limit: 1, offset: 0 },
      ctx,
    );
    if (env.code !== 0) return respondControlError(c, 502, "META_KERNEL_UNAVAILABLE");
    const items = ((env.data ?? {}) as { items?: Array<{ agent_id?: string }> }).items ?? [];
    const firstAgentId = items
      .map((item) => item.agent_id)
      .find((id): id is string => typeof id === "string" && id.trim().length > 0);
    return firstAgentId ?? null;
  } catch {
    return respondControlError(c, 502, "META_KERNEL_UNAVAILABLE");
  }
}

async function callMemoryCore<T>(
  deps: PanelDeps,
  ctx: MetaCallContext,
  c: Context,
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

function tipMatchesFilters(tip: SummaryTipItem, agentId: string | null, tags: string[]): boolean {
  if (agentId && tip.agent_id !== agentId) return false;
  if (tags.length > 0 && !tip.tags.some((tag) => tags.includes(tag))) return false;
  return true;
}

export function registerTipsRoutes(api: Hono, deps: PanelDeps): void {
  const mw = validatePanelMetaHeaders(deps);

  api.post("/tips/list", mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const teamId = str(body, "team_id");
    if (!teamId) return respondControlError(c, 400, "MISSING_TEAM_ID");

    const gate = await requireTeamMember(deps, c, ctx, teamId);
    if ("error" in gate) return gate.error;

    const requestedStatusRaw = str(body, "status");
    const status = normalizeStatus(requestedStatusRaw);
    if (requestedStatusRaw && !status) {
      return respondControlError(c, 400, "INVALID_STATUS");
    }

    const agentId = str(body, "agent_id");
    const tags = strArray(body, "tags");
    const requestedLimit = intOrNull(body.limit) ?? 50;
    const requestedOffset = intOrNull(body.offset) ?? 0;
    const limit = Math.min(Math.max(requestedLimit, 1), CORE_PAGE_SIZE);
    const offset = Math.max(requestedOffset, 0);

    const resolved = await resolveTipContextAgent(deps, ctx, c, teamId, body);
    if (resolved instanceof Response) return resolved;
    if (!resolved) {
      // No active agent means no /v3 strict-isolation handle exists yet.
      // Return an empty team view instead of an opaque core error.
      return respondEnvelope(c, okEnvelope(c, { items: [], total: 0, limit, offset }));
    }

    const coreBody: Record<string, unknown> = {
      team_id: teamId,
      user_id: gate.userId,
      agent_id: resolved,
    };
    if (status) coreBody.status = status;
    const sessionId = str(body, "session_id");
    if (sessionId) coreBody.session_id = sessionId;
    const taskId = str(body, "task_id");
    if (taskId) coreBody.task_id = taskId;

    const all: SummaryTipItem[] = [];
    let coreTotal = 0;
    for (let coreOffset = 0; coreOffset < MAX_SCAN_ITEMS; coreOffset += CORE_PAGE_SIZE) {
      const result = await callMemoryCore<CoreTipsListData>(deps, ctx, c, "/v3/tips/list", {
        ...coreBody,
        limit: CORE_PAGE_SIZE,
        offset: coreOffset,
      });
      if ("error" in result) return result.error;
      const pageItems = result.data.items ?? [];
      coreTotal = result.data.total ?? pageItems.length;
      all.push(...pageItems);
      if (all.length >= coreTotal || pageItems.length < CORE_PAGE_SIZE) break;
    }

    const filtered = all.filter((tip) => tipMatchesFilters(tip, agentId, tags));
    const items = filtered.slice(offset, offset + limit);
    return respondEnvelope(
      c,
      okEnvelope(c, {
        items,
        total: filtered.length,
        limit,
        offset,
      }),
    );
  });

  api.post("/tips/get", mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const teamId = str(body, "team_id");
    const tipId = str(body, "tip_id");
    if (!teamId) return respondControlError(c, 400, "MISSING_TEAM_ID");
    if (!tipId) return respondControlError(c, 400, "MISSING_TIP_ID");

    const gate = await requireTeamMember(deps, c, ctx, teamId);
    if ("error" in gate) return gate.error;

    const resolved = await resolveTipContextAgent(deps, ctx, c, teamId, body);
    if (resolved instanceof Response) return resolved;
    if (!resolved) return respondControlError(c, 404, "TIP_UNAVAILABLE_NO_TEAM_AGENT");

    const result = await callMemoryCore<SummaryTipItem | null>(deps, ctx, c, "/v3/tips/get", {
      team_id: teamId,
      user_id: gate.userId,
      agent_id: resolved,
      tip_id: tipId,
    });
    if ("error" in result) return result.error;
    if (!result.data) return respondControlError(c, 404, "TIP_NOT_FOUND");
    return respondEnvelope(c, okEnvelope(c, result.data));
  });
}
