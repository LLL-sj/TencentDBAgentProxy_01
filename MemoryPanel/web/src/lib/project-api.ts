/**
 * Code Memory project memory panel API client.
 *
 * Endpoints live under `/api/v1/project`; the panel backend enforces team
 * membership and forwards read-only requests to MemoryCore `/v3/project/*`.
 */

import { getPanelSession } from './panelSession';
import { formatApiErrorMessage } from './error-message';

const BASE = '/api/v1/project';

interface Envelope<T = unknown> {
  code: number;
  message: string;
  request_id: string;
  data: T;
}

export class ProjectApiError extends Error {
  code: number;
  requestId: string;
  rawMessage: string;

  constructor(code: number, message: string, requestId: string) {
    super(formatApiErrorMessage({ code, message, requestId }));
    this.name = 'ProjectApiError';
    this.code = code;
    this.requestId = requestId;
    this.rawMessage = message;
  }
}

async function panelPost<T>(path: string, body?: unknown): Promise<T> {
  const session = getPanelSession();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (session) {
    headers['X-Tdai-Service-Id'] = session.instanceId;
    headers['X-Tdai-User-Key'] = session.userKey;
  }
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let env: Envelope<T>;
  try {
    env = JSON.parse(text) as Envelope<T>;
  } catch {
    throw new ProjectApiError(res.status || 500, text || res.statusText || 'Project request failed', '');
  }
  if (!res.ok || env.code !== 0) {
    throw new ProjectApiError(env.code ?? res.status, env.message || res.statusText, env.request_id);
  }
  return env.data;
}

export type ProjectTopicType = 'work_method' | 'work_fact' | 'decision' | 'pitfall';

export interface ProjectTopicMeta {
  path: string;
  name: string;
  type: ProjectTopicType;
  title: string;
  tags: string[];
  sources: string[];
  updated?: string;
  summary?: string;
  size: number;
}

export interface ProjectTopicFile extends ProjectTopicMeta {
  content: string;
}

export interface ProjectListResult {
  items: ProjectTopicMeta[];
  index: string;
}

export interface ProjectScope {
  teamId: string;
  /** Preferred for the panel block model: chat_memory-{team}-{agent}. */
  blockId?: string;
  /** Fallback when the caller only has team_id + agent_id. */
  agentId?: string;
}

export const projectApi = {
  list: (scope: ProjectScope) =>
    panelPost<ProjectListResult>('/list', {
      team_id: scope.teamId,
      ...(scope.blockId ? { block_id: scope.blockId } : {}),
      ...(!scope.blockId && scope.agentId ? { agent_id: scope.agentId } : {}),
    }),
  read: (scope: ProjectScope, path: string) =>
    panelPost<ProjectTopicFile>('/read', {
      team_id: scope.teamId,
      ...(scope.blockId ? { block_id: scope.blockId } : {}),
      ...(!scope.blockId && scope.agentId ? { agent_id: scope.agentId } : {}),
      path,
    }),
};

export function formatProjectError(err: unknown): string {
  return err instanceof ProjectApiError ? err.message : err instanceof Error ? err.message : 'Project request failed';
}
