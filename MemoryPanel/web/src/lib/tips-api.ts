/**
 * L0.5 summary_tips panel API client.
 *
 * Endpoints live under `/api/v1/tips`; the panel backend enforces team
 * membership and forwards read-only requests to MemoryCore `/v3/tips/*`.
 */

import { getPanelSession } from './panelSession';
import { formatApiErrorMessage } from './error-message';

const BASE = '/api/v1/tips';

interface Envelope<T = unknown> {
  code: number;
  message: string;
  request_id: string;
  data: T;
}

export class TipsApiError extends Error {
  code: number;
  requestId: string;
  rawMessage: string;

  constructor(code: number, message: string, requestId: string) {
    super(formatApiErrorMessage({ code, message, requestId }));
    this.name = 'TipsApiError';
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
    throw new TipsApiError(res.status || 500, text || res.statusText || 'Tips request failed', '');
  }
  if (!res.ok || env.code !== 0) {
    throw new TipsApiError(env.code ?? res.status, env.message || res.statusText, env.request_id);
  }
  return env.data;
}

export type TipStatus = 'pending' | 'consuming' | 'consumed' | 'duplicate' | 'expired';

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

export interface TipsListResult {
  items: SummaryTipItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface TipsListOptions {
  status?: TipStatus;
  agent_id?: string;
  tags?: string[];
  session_id?: string;
  task_id?: string;
  limit?: number;
  offset?: number;
}

export const tipsApi = {
  list: (teamId: string, opts: TipsListOptions = {}) =>
    panelPost<TipsListResult>('/list', { team_id: teamId, ...opts }),
  get: (teamId: string, tipId: string) =>
    panelPost<SummaryTipItem>('/get', { team_id: teamId, tip_id: tipId }),
};

export function formatTipsError(err: unknown): string {
  return err instanceof TipsApiError ? err.message : err instanceof Error ? err.message : 'Tips request failed';
}

export const TIP_STATUS_LABELS: Record<TipStatus, string> = {
  pending: '待消费',
  consuming: '消费中',
  consumed: '已消费',
  duplicate: '重复',
  expired: '已过期',
};
