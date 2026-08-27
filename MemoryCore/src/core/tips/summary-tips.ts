/**
 * summary_tips — L0.5 task-summary tips store.
 *
 * Tips are written by the Agent through the Proxy memory-bridge and consumed
 * by the Code Memory v2 L1/L2 pipeline. The table is intentionally add-only;
 * consumption statuses are pending → consuming → consumed/duplicate/expired.
 *
 * This module is synchronous on top of node:sqlite (same connection as the
 * VectorStore SQLite database) so writes never race with L0/L1 transactions.
 */

import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

const TIP_ID_RETRY = 5;
const MAX_SUMMARY_CHARS = 8000;
const MAX_LIST_ITEMS = 200;
const MAX_ARRAY_ITEMS = 50;
const MAX_ARRAY_ITEM_CHARS = 400;

export type TipStatus = "pending" | "consuming" | "consumed" | "duplicate" | "expired";

export interface AnchorInput {
  mode: "last_turn" | "message_text";
  start_text?: string;
  end_text?: string;
}

export interface SubmitSummaryTipInput {
  teamId: string;
  userId: string;
  agentId: string;
  sessionId: string;
  taskId?: string;
  summary: string;
  steps?: string[];
  artifacts?: string[];
  tags?: string[];
  userFeedbackReceived?: boolean;
  anchor?: AnchorInput;
  l0StartRef?: string;
  l0EndRef?: string;
  l0Refs?: string[];
}

export interface SummaryTipRow {
  tip_id: string;
  team_id: string;
  agent_id: string;
  user_id: string;
  session_id: string;
  task_id: string;
  l0_start_ref: string;
  l0_end_ref: string;
  l0_start_at: number | null;
  l0_end_at: number | null;
  l0_refs_json: string;
  summary: string;
  steps_json: string;
  artifacts_json: string;
  tags_json: string;
  user_feedback_received: number;
  status: TipStatus;
  dedupe_key: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface SummaryTipDetail {
  tip_id: string;
  team_id: string;
  agent_id: string;
  user_id: string;
  session_id: string;
  task_id: string;
  l0_start_ref: string;
  l0_end_ref: string;
  /** Millisecond timestamps of the anchored L0 range (may be null for legacy tips). */
  l0_start_at: number | null;
  l0_end_at: number | null;
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

export interface SubmitResult {
  tip_id: string;
  status: TipStatus;
  duplicate: boolean;
}

export interface ListTipsInput {
  teamId: string;
  agentId?: string;
  sessionId?: string;
  taskId?: string;
  status?: TipStatus;
  limit?: number;
  offset?: number;
}

export interface ListTipsResult {
  items: SummaryTipDetail[];
  total: number;
}

export const SUMMARY_TIPS_DDL = `
CREATE TABLE IF NOT EXISTS summary_tips (
  tip_id                 TEXT PRIMARY KEY,
  team_id                TEXT NOT NULL DEFAULT 'default',
  agent_id               TEXT NOT NULL DEFAULT 'default',
  user_id                TEXT NOT NULL DEFAULT 'default',
  session_id             TEXT NOT NULL,
  task_id                TEXT DEFAULT '',
  l0_start_ref           TEXT DEFAULT '',
  l0_end_ref             TEXT DEFAULT '',
  l0_start_at            INTEGER,
  l0_end_at              INTEGER,
  l0_refs_json           TEXT DEFAULT '[]',
  summary                TEXT NOT NULL,
  steps_json             TEXT DEFAULT '[]',
  artifacts_json         TEXT DEFAULT '[]',
  tags_json              TEXT DEFAULT '[]',
  user_feedback_received INTEGER NOT NULL DEFAULT 0,
  status                 TEXT NOT NULL DEFAULT 'pending',
  dedupe_key             TEXT NOT NULL,
  version                INTEGER NOT NULL DEFAULT 1,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_summary_tips_dedupe ON summary_tips(dedupe_key);
CREATE INDEX IF NOT EXISTS idx_summary_tips_team_status ON summary_tips(team_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_summary_tips_session_created ON summary_tips(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_summary_tips_task_status ON summary_tips(task_id, status, created_at DESC);
`;

function nowIso(): string {
  return new Date().toISOString();
}

function cleanString(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, max);
}

function cleanStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (out.length >= MAX_ARRAY_ITEMS) break;
    const text = cleanString(item, MAX_ARRAY_ITEM_CHARS);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function dedupeKey(input: {
  teamId: string;
  sessionId: string;
  taskId?: string;
  l0StartRef?: string;
  l0EndRef?: string;
  summary: string;
}): string {
  const summaryHash = createHash("sha256").update(input.summary, "utf8").digest("hex");
  const raw = [
    input.teamId,
    input.sessionId,
    input.taskId ?? "",
    input.l0StartRef ?? "",
    input.l0EndRef ?? "",
    summaryHash,
  ].join("\n");
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

function genTipId(): string {
  return `tip-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function isUniqueViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(msg);
}

interface L0RefRow {
  record_id: string;
  timestamp: number;
  role: string;
  messageText?: string;
}

export class SummaryTipsError extends Error {
  constructor(
    message: string,
    readonly code: number = 400,
  ) {
    super(message);
    this.name = "SummaryTipsError";
  }
}

export function ensureSummaryTipsSchema(db: DatabaseSync): void {
  db.exec(SUMMARY_TIPS_DDL);

  // Idempotent migration for databases created before l0_start_at/l0_end_at.
  const columns = new Set(
    (db.prepare("PRAGMA table_info(summary_tips)").all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!columns.has("l0_start_at")) {
    db.exec("ALTER TABLE summary_tips ADD COLUMN l0_start_at INTEGER");
  }
  if (!columns.has("l0_end_at")) {
    db.exec("ALTER TABLE summary_tips ADD COLUMN l0_end_at INTEGER");
  }
}

export class SummaryTipsStore {
  constructor(private readonly db: DatabaseSync) {
    ensureSummaryTipsSchema(db);
  }

  submit(input: SubmitSummaryTipInput): SubmitResult {
    const teamId = cleanString(input.teamId, 128);
    const userId = cleanString(input.userId, 128);
    const agentId = cleanString(input.agentId, 128);
    const sessionId = cleanString(input.sessionId, 256);
    const taskId = cleanString(input.taskId, 128);
    const summary = input.summary.trim();

    if (!teamId || !userId || !agentId || !sessionId) {
      throw new SummaryTipsError("team_id, user_id, agent_id and session_id are required");
    }
    if (!summary) throw new SummaryTipsError("summary is required");
    if (summary.length > MAX_SUMMARY_CHARS) {
      throw new SummaryTipsError(`summary exceeds ${MAX_SUMMARY_CHARS} chars`);
    }

    const steps = cleanStringArray(input.steps);
    const artifacts = cleanStringArray(input.artifacts);
    const tags = cleanStringArray(input.tags).slice(0, 20);
    const userFeedbackReceived = input.userFeedbackReceived === true;
    const refs = this.resolveL0Refs(input, teamId, userId, agentId, sessionId);
    const key = dedupeKey({
      teamId,
      sessionId,
      taskId,
      l0StartRef: refs.start,
      l0EndRef: refs.end,
      summary,
    });

    const ts = nowIso();
    for (let attempt = 0; attempt < TIP_ID_RETRY; attempt++) {
      const tipId = genTipId();
      try {
        this.db.prepare(`
          INSERT INTO summary_tips (
            tip_id, team_id, agent_id, user_id, session_id, task_id,
            l0_start_ref, l0_end_ref, l0_start_at, l0_end_at, l0_refs_json,
            summary, steps_json, artifacts_json, tags_json,
            user_feedback_received, status, dedupe_key, version, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 1, ?, ?)
        `).run(
          tipId, teamId, agentId, userId, sessionId, taskId,
          refs.start, refs.end, refs.startAt, refs.endAt, JSON.stringify(refs.refs),
          summary, JSON.stringify(steps), JSON.stringify(artifacts), JSON.stringify(tags),
          userFeedbackReceived ? 1 : 0, key, ts, ts,
        );
        return { tip_id: tipId, status: "pending", duplicate: false };
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        const existing = this.findByDedupeKey(key);
        if (existing) {
          if (existing.status === "pending") {
            this.db.prepare(
              "UPDATE summary_tips SET status = 'duplicate', updated_at = ? WHERE dedupe_key = ? AND status = 'pending'",
            ).run(nowIso(), key);
            existing.status = "duplicate";
          }
          return { tip_id: existing.tip_id, status: existing.status, duplicate: true };
        }
        if (attempt < TIP_ID_RETRY - 1) continue;
        throw err;
      }
    }
    throw new SummaryTipsError("failed to allocate tip id", 500);
  }

  get(teamId: string, tipId: string): SummaryTipDetail | null {
    const row = this.db.prepare(
      "SELECT * FROM summary_tips WHERE team_id = ? AND tip_id = ?",
    ).get(teamId, tipId) as SummaryTipRow | undefined;
    return row ? this.toDetail(row) : null;
  }

  list(input: ListTipsInput): ListTipsResult {
    const where: string[] = ["team_id = ?"];
    const params: Array<string | number> = [input.teamId];
    if (input.agentId) {
      where.push("agent_id = ?");
      params.push(input.agentId);
    }
    if (input.sessionId) {
      where.push("session_id = ?");
      params.push(input.sessionId);
    }
    if (input.taskId) {
      where.push("task_id = ?");
      params.push(input.taskId);
    }
    if (input.status) {
      where.push("status = ?");
      params.push(input.status);
    }
    const limit = Math.min(Math.max(Math.floor(input.limit ?? 20), 1), MAX_LIST_ITEMS);
    const offset = Math.max(Math.floor(input.offset ?? 0), 0);
    const whereSql = where.join(" AND ");
    const totalRow = this.db.prepare(
      `SELECT COUNT(*) AS total FROM summary_tips WHERE ${whereSql}`,
    ).get(...params) as { total: number } | undefined;
    const rows = this.db.prepare(
      `SELECT * FROM summary_tips WHERE ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    ).all(...params, limit, offset) as unknown as SummaryTipRow[];
    return { items: rows.map((r) => this.toDetail(r)), total: totalRow?.total ?? 0 };
  }

  markStatus(teamId: string, tipId: string, status: TipStatus): boolean {
    if (!["consuming", "consumed", "duplicate", "expired"].includes(status)) return false;
    const res = this.db.prepare(
      "UPDATE summary_tips SET status = ?, updated_at = ? WHERE team_id = ? AND tip_id = ?",
    ).run(status, nowIso(), teamId, tipId);
    return res.changes > 0;
  }

  private resolveL0Refs(
    input: SubmitSummaryTipInput,
    teamId: string,
    userId: string,
    agentId: string,
    sessionId: string,
  ): { start: string; end: string; startAt: number | null; endAt: number | null; refs: string[] } {
    const rows = this.queryL0(sessionId, teamId, userId, agentId);
    const explicitRefs = cleanStringArray(input.l0Refs).filter((id) => rows.some((r) => r.record_id === id));
    const range = (start: string, end: string, refs: string[]) => {
      const startRow = rows.find((r) => r.record_id === start);
      const endRow = rows.find((r) => r.record_id === end);
      return {
        start,
        end,
        startAt: startRow ? startRow.timestamp : null,
        endAt: endRow ? endRow.timestamp : null,
        refs,
      };
    };

    if (input.l0StartRef || input.l0EndRef) {
      const start = input.l0StartRef && rows.some((r) => r.record_id === input.l0StartRef)
        ? input.l0StartRef!
        : "";
      const end = input.l0EndRef && rows.some((r) => r.record_id === input.l0EndRef)
        ? input.l0EndRef!
        : start;
      return range(start, end, explicitRefs.length > 0 ? explicitRefs : (start ? [start, end].filter((x, i, a) => x && a.indexOf(x) === i) : []));
    }

    if (!input.anchor || input.anchor.mode === "last_turn") {
      if (rows.length === 0) return range("", "", explicitRefs);
      const last = rows[rows.length - 1];
      const prev = rows[rows.length - 2];
      const start = prev?.record_id ?? last.record_id;
      const end = last.record_id;
      return range(start, end, [start, end].filter((x, i, a) => a.indexOf(x) === i));
    }

    const startText = cleanString(input.anchor.start_text, MAX_ARRAY_ITEM_CHARS);
    const endText = cleanString(input.anchor.end_text, MAX_ARRAY_ITEM_CHARS) || startText;
    if (!startText) throw new SummaryTipsError("anchor.start_text is required for anchor_mode=message_text");

    let startRow: L0RefRow | null = null;
    let endRow: L0RefRow | null = null;
    for (const row of rows) {
      if (!startRow && this.l0MessageContains(row, startText)) startRow = row;
      if (this.l0MessageContains(row, endText)) endRow = row;
    }
    if (!startRow || !endRow) {
      throw new SummaryTipsError(
        `anchor text not found in session L0 (start=${startRow ? "ok" : "missing"}, end=${endRow ? "ok" : "missing"})`,
      );
    }
    const refs = rows
      .filter((r) => r.timestamp >= startRow!.timestamp && r.timestamp <= endRow!.timestamp)
      .map((r) => r.record_id);
    return range(startRow.record_id, endRow.record_id, refs);
  }

  private queryL0(sessionId: string, teamId: string, userId: string, agentId: string): L0RefRow[] {
    const rows = this.db.prepare(`
      SELECT record_id, timestamp, message_text
      FROM l0_conversations
      WHERE session_id = ? AND team_id = ? AND user_id = ? AND agent_id = ?
      ORDER BY timestamp ASC, rowid ASC
    `).all(sessionId, teamId, userId, agentId) as Array<{ record_id: string; timestamp: number; message_text: string }>;
    return rows.map((r) => ({ record_id: r.record_id, timestamp: Number(r.timestamp) || 0, role: "", messageText: r.message_text }));
  }

  private l0MessageContains(row: L0RefRow, text: string): boolean {
    return Boolean(row.messageText && row.messageText.includes(text));
  }

  private findByDedupeKey(key: string): SummaryTipRow | null {
    return this.db.prepare("SELECT * FROM summary_tips WHERE dedupe_key = ?").get(key) as unknown as SummaryTipRow | null;
  }

  private toDetail(row: SummaryTipRow): SummaryTipDetail {
    return {
      tip_id: row.tip_id,
      team_id: row.team_id,
      agent_id: row.agent_id,
      user_id: row.user_id,
      session_id: row.session_id,
      task_id: row.task_id,
      l0_start_ref: row.l0_start_ref,
      l0_end_ref: row.l0_end_ref,
      l0_start_at: row.l0_start_at ?? null,
      l0_end_at: row.l0_end_at ?? null,
      l0_refs: parseJsonArray(row.l0_refs_json),
      summary: row.summary,
      steps: parseJsonArray(row.steps_json),
      artifacts: parseJsonArray(row.artifacts_json),
      tags: parseJsonArray(row.tags_json),
      user_feedback_received: row.user_feedback_received === 1,
      status: row.status,
      version: row.version,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}
