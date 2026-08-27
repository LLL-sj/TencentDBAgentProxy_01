import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { SummaryTipsStore, ensureSummaryTipsSchema, type SummaryTipsStore as _StoreType } from "./summary-tips.js";

function createDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE l0_conversations (
      record_id TEXT PRIMARY KEY,
      session_key TEXT DEFAULT '',
      session_id TEXT DEFAULT 'default',
      team_id TEXT DEFAULT 'default',
      task_id TEXT DEFAULT '',
      user_id TEXT NOT NULL DEFAULT 'default',
      agent_id TEXT NOT NULL DEFAULT 'default',
      role TEXT DEFAULT 'user',
      message_text TEXT NOT NULL,
      recorded_at TEXT DEFAULT '',
      timestamp INTEGER DEFAULT 0
    )
  `);
  ensureSummaryTipsSchema(db);
  return db;
}

describe("SummaryTipsStore", () => {
  let db: DatabaseSync;
  let store: SummaryTipsStore;

  beforeEach(() => {
    db = createDb();
    store = new SummaryTipsStore(db);
  });

  function seedL0(rows: Array<[string, string, number]>): void {
    const stmt = db.prepare(`
      INSERT INTO l0_conversations (record_id, session_id, team_id, user_id, agent_id, role, message_text, timestamp)
      VALUES (?, 'sess-1', 'team-a', 'usr-1', 'agt-1', 'user', ?, ?)
    `);
    for (const [id, text, ts] of rows) stmt.run(id, text, ts);
  }

  it("submits a tip with message_text anchors and resolves l0 refs", () => {
    seedL0([
      ["r-001", "请排查 MySQL 超时", 1],
      ["r-002", "连接池被打满", 2],
      ["r-003", "已恢复", 3],
    ]);
    const res = store.submit({
      teamId: "team-a",
      userId: "usr-1",
      agentId: "agt-1",
      sessionId: "sess-1",
      summary: "完成 MySQL 超时排查，先看连接池",
      steps: ["查 pool 水位"],
      tags: ["数据库", "SOP"],
      anchor: { mode: "message_text", start_text: "请排查", end_text: "已恢复" },
    });
    expect(res.tip_id).toMatch(/^tip-/);
    expect(res.duplicate).toBe(false);
    const detail = store.get("team-a", res.tip_id)!;
    expect(detail.l0_start_ref).toBe("r-001");
    expect(detail.l0_end_ref).toBe("r-003");
    expect(detail.l0_start_at).toBe(1);
    expect(detail.l0_end_at).toBe(3);
    expect(detail.l0_refs).toEqual(["r-001", "r-002", "r-003"]);
    expect(detail.tags).toEqual(["数据库", "SOP"]);
  });

  it("deduplicates identical submissions and marks the original duplicate", () => {
    seedL0([["r-001", "任务A", 1]]);
    const first = store.submit({
      teamId: "team-a",
      userId: "usr-1",
      agentId: "agt-1",
      sessionId: "sess-1",
      summary: "相同总结",
    });
    const second = store.submit({
      teamId: "team-a",
      userId: "usr-1",
      agentId: "agt-1",
      sessionId: "sess-1",
      summary: "相同总结",
    });
    expect(second.tip_id).toBe(first.tip_id);
    expect(second.duplicate).toBe(true);
    expect(store.get("team-a", first.tip_id)?.status).toBe("duplicate");
  });

  it("isolates tips by team", () => {
    seedL0([["r-001", "team a only", 1]]);
    store.submit({
      teamId: "team-a",
      userId: "usr-1",
      agentId: "agt-1",
      sessionId: "sess-1",
      summary: "team a tip",
    });
    expect(store.list({ teamId: "team-b" }).total).toBe(0);
    expect(store.list({ teamId: "team-a" }).total).toBe(1);
  });

  it("uses last_turn anchors when no explicit anchor is provided", () => {
    seedL0([
      ["r-001", "first", 1],
      ["r-002", "last", 2],
    ]);
    const res = store.submit({
      teamId: "team-a",
      userId: "usr-1",
      agentId: "agt-1",
      sessionId: "sess-1",
      summary: "last turn tip",
    });
    const detail = store.get("team-a", res.tip_id)!;
    expect(detail.l0_start_ref).toBe("r-001");
    expect(detail.l0_end_ref).toBe("r-002");
    expect(detail.l0_start_at).toBe(1);
    expect(detail.l0_end_at).toBe(2);
  });

  it("filters tips by agent when requested", () => {
    seedL0([
      ["r-001", "agent 1 message", 1],
      ["r-002", "agent 2 message", 2],
    ]);
    store.submit({
      teamId: "team-a",
      userId: "usr-1",
      agentId: "agt-1",
      sessionId: "sess-1",
      summary: "agent 1 tip",
    });
    store.submit({
      teamId: "team-a",
      userId: "usr-1",
      agentId: "agt-2",
      sessionId: "sess-1",
      summary: "agent 2 tip",
    });
    expect(store.list({ teamId: "team-a", agentId: "agt-1" }).total).toBe(1);
    expect(store.list({ teamId: "team-a", agentId: "agt-2" }).total).toBe(1);
  });

  it("updates tip status for pipeline consumption", () => {
    seedL0([["r-001", "x", 1]]);
    const res = store.submit({
      teamId: "team-a",
      userId: "usr-1",
      agentId: "agt-1",
      sessionId: "sess-1",
      summary: "status test",
    });
    expect(store.markStatus("team-a", res.tip_id, "consuming")).toBe(true);
    expect(store.get("team-a", res.tip_id)?.status).toBe("consuming");
    expect(store.markStatus("team-a", res.tip_id, "consumed")).toBe(true);
    expect(store.get("team-a", res.tip_id)?.status).toBe("consumed");
  });
});
