/**
 * TipsReminderRepo — persistent state for the L0.5 dynamic reminder injector.
 *
 * The injector needs its counters to survive proxy process restarts. This repo
 * uses the proxy's existing SQLite singleton; if SQLite is unavailable it
 * degrades to an in-memory map so reminder injection never throws.
 */

import { getDb } from "./index.js";

export interface TipsReminderState {
  reminderCount: number;
  count1: number;
  count2: number;
  lastReminderAt: number;
  lastActiveAt: number;
  stageStartedAt: number;
  updatedAt: number;
}

export function tipsReminderStateKey(identity: {
  spaceId?: string;
  userId: string;
  agentSource: string;
  sessionId: string;
  taskId?: string;
}): string {
  return [
    identity.spaceId || "default",
    identity.userId || "anonymous",
    identity.agentSource || "claude-code",
    identity.sessionId,
    identity.taskId || "",
  ].join("\u0000");
}

const memoryFallback = new Map<string, TipsReminderState>();

function normalizeRow(row: Record<string, unknown> | undefined): TipsReminderState | null {
  if (!row) return null;
  return {
    reminderCount: Number(row.reminder_count) || 0,
    count1: Number(row.count1) || 0,
    count2: Number(row.count2) || 0,
    lastReminderAt: Number(row.last_reminder_at) || 0,
    lastActiveAt: Number(row.last_active_at) || 0,
    stageStartedAt: Number(row.stage_started_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
  };
}

export async function loadTipsReminderState(key: string): Promise<TipsReminderState | null> {
  const db = getDb();
  if (!db) return memoryFallback.get(key) ?? null;
  try {
    const row = db.prepare("SELECT * FROM tips_reminder_state WHERE state_key = ?").get(key) as
      | Record<string, unknown>
      | undefined;
    return normalizeRow(row);
  } catch {
    return null;
  }
}

export async function saveTipsReminderState(key: string, state: TipsReminderState): Promise<void> {
  const now = Date.now();
  const next: TipsReminderState = { ...state, updatedAt: now };
  const db = getDb();
  if (!db) {
    memoryFallback.set(key, next);
    return;
  }
  try {
    db.prepare(`
      INSERT INTO tips_reminder_state (
        state_key, reminder_count, count1, count2, last_reminder_at, last_active_at, stage_started_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(state_key) DO UPDATE SET
        reminder_count = excluded.reminder_count,
        count1 = excluded.count1,
        count2 = excluded.count2,
        last_reminder_at = excluded.last_reminder_at,
        last_active_at = excluded.last_active_at,
        stage_started_at = excluded.stage_started_at,
        updated_at = excluded.updated_at
    `).run(
      key,
      next.reminderCount,
      next.count1,
      next.count2,
      next.lastReminderAt,
      next.lastActiveAt,
      next.stageStartedAt,
      next.updatedAt,
    );
  } catch {
    // Persistence failure must not break prompt injection.
    memoryFallback.set(key, next);
  }
}

/**
 * Reset the current reminder stage.
 *
 * `lastReminderAt` defaults to 0 for successful tip submissions (a brand-new
 * stage starts without recent-reminder back-pressure). The summary-handoff
 * trigger passes `lastReminderAt: now` because that trigger itself just
 * injected a reminder and the following stage must respect the cooldown.
 */
export async function resetTipsReminderStage(
  key: string,
  options: { lastReminderAt?: number } = {},
): Promise<void> {
  const now = Date.now();
  await saveTipsReminderState(key, {
    reminderCount: 0,
    count1: 0,
    count2: 0,
    lastReminderAt: options.lastReminderAt ?? 0,
    lastActiveAt: now,
    stageStartedAt: now,
    updatedAt: now,
  });
}
