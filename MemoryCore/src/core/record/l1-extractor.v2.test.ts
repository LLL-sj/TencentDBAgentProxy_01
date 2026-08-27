import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { SummaryTipsStore, ensureSummaryTipsSchema } from "../tips/summary-tips.js";
import type { ConversationMessage } from "../conversation/l0-recorder.js";
import type { LLMRunner } from "../types.js";
import { extractL1Memories } from "./l1-extractor.js";

function createTipsDb(): DatabaseSync {
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
  db.prepare(`
    INSERT INTO l0_conversations (record_id, session_id, team_id, user_id, agent_id, role, message_text, timestamp)
    VALUES (?, ?, ?, ?, ?, 'user', ?, ?)
  `).run("r-1", "sess-1", "team-a", "usr-1", "agt-1", "请排查 MySQL 超时", 1);
  db.prepare(`
    INSERT INTO l0_conversations (record_id, session_id, team_id, user_id, agent_id, role, message_text, timestamp)
    VALUES (?, ?, ?, ?, ?, 'assistant', ?, ?)
  `).run("r-2", "sess-1", "team-a", "usr-1", "agt-1", "连接池被打满，已恢复", 2);
  ensureSummaryTipsSchema(db);
  return db;
}

const messages: ConversationMessage[] = [
  { id: "r-1", role: "user", content: "请排查 MySQL 超时", timestamp: 1_700_000_000_000 },
  { id: "r-2", role: "assistant", content: "连接池被打满，已恢复", timestamp: 1_700_000_060_000 },
];

const jsonResponse = JSON.stringify([
  {
    scene_name: "团队在围绕 MySQL 超时问题推进排查",
    message_ids: ["r-1", "r-2"],
    memories: [
      {
        content: "团队确认 MySQL 超时由连接池打满导致。",
        type: "work_fact",
        priority: 85,
        source_message_ids: ["r-1", "r-2"],
        source_refs: ["r-1", "r-2", "tip-t1"],
        confidence: 0.9,
        metadata: { work_object: "MySQL 超时" },
      },
    ],
  },
]);

function makeRunner(captured: { prompt?: string; systemPrompt?: string }): LLMRunner {
  return {
    run: async (params) => {
      captured.prompt = params.prompt;
      captured.systemPrompt = params.systemPrompt;
      return jsonResponse;
    },
  };
}

describe("extractL1Memories L1 v2", () => {
  it("loads pending tips, injects late tips before the batch, consumes them, and preserves source_refs/confidence", async () => {
    const db = createTipsDb();
    const tips = new SummaryTipsStore(db);
    tips.submit({
      teamId: "team-a",
      userId: "usr-1",
      agentId: "agt-1",
      sessionId: "sess-1",
      taskId: "task-1",
      summary: "完成 MySQL 超时排查，结论是连接池被打满",
      tags: ["数据库", "SOP"],
      l0StartRef: "r-1",
      l0EndRef: "r-2",
      l0Refs: ["r-1", "r-2"],
    });

    const dir = mkdtempSync(path.join(tmpdir(), "l1v2-test-"));
    const captured: { prompt?: string; systemPrompt?: string } = {};
    try {
      const result = await extractL1Memories({
        messages,
        sessionKey: "sess-1",
        sessionId: "sess-1",
        taskId: "task-1",
        teamId: "team-a",
        userId: "usr-1",
        agentId: "agt-1",
        baseDir: dir,
        config: {},
        options: {
          enableDedup: false,
          promptMode: "code",
          codeMemoryVersion: "v2",
          summaryTipsStore: tips,
          llmRunner: makeRunner(captured),
        },
      });

      expect(result.success).toBe(true);
      expect(result.records).toHaveLength(1);
      const metadata = result.records[0].metadata as Record<string, unknown>;
      expect(metadata.source_refs).toEqual(["r-1", "r-2", "tip-t1"]);
      expect(metadata.confidence).toBe(0.9);
      expect(metadata.work_object).toBe("MySQL 超时");

      expect(captured.prompt).toContain("<SUMMARY_TIP");
      expect(captured.prompt).toContain("完成 MySQL 超时排查");
      const firstPos = captured.prompt!.indexOf("record_id=r-1");
      const tipPos = captured.prompt!.indexOf("<SUMMARY_TIP");
      expect(firstPos).toBeGreaterThan(-1);
      expect(tipPos).toBeGreaterThan(-1);
      expect(tipPos).toBeLessThan(firstPos);
      expect(tips.list({ teamId: "team-a", agentId: "agt-1", sessionId: "sess-1", taskId: "task-1", status: "pending" }).total).toBe(0);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps injected tips pending when the LLM call fails", async () => {
    const db = createTipsDb();
    const tips = new SummaryTipsStore(db);
    tips.submit({
      teamId: "team-a",
      userId: "usr-1",
      agentId: "agt-1",
      sessionId: "sess-1",
      taskId: "task-1",
      summary: "失败场景下不能消费",
      l0StartRef: "r-1",
      l0EndRef: "r-2",
    });

    const dir = mkdtempSync(path.join(tmpdir(), "l1v2-fail-"));
    try {
      const result = await extractL1Memories({
        messages,
        sessionKey: "sess-1",
        sessionId: "sess-1",
        taskId: "task-1",
        teamId: "team-a",
        userId: "usr-1",
        agentId: "agt-1",
        baseDir: dir,
        config: {},
        options: {
          enableDedup: false,
          promptMode: "code",
          codeMemoryVersion: "v2",
          summaryTipsStore: tips,
          llmRunner: {
            run: async () => {
              throw new Error("upstream LLM failed");
            },
          },
        },
      });
      expect(result.success).toBe(false);
      expect(tips.list({ teamId: "team-a", agentId: "agt-1", sessionId: "sess-1", taskId: "task-1", status: "pending" }).total).toBe(1);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps v1 prompt untouched when codeMemoryVersion=v1", async () => {
    const db = createTipsDb();
    const tips = new SummaryTipsStore(db);
    const dir = mkdtempSync(path.join(tmpdir(), "l1v1-test-"));
    const captured: { prompt?: string; systemPrompt?: string } = {};
    try {
      const result = await extractL1Memories({
        messages,
        sessionKey: "sess-1",
        sessionId: "sess-1",
        taskId: "task-1",
        teamId: "team-a",
        userId: "usr-1",
        agentId: "agt-1",
        baseDir: dir,
        config: {},
        options: {
          enableDedup: false,
          promptMode: "code",
          codeMemoryVersion: "v1",
          summaryTipsStore: tips,
          llmRunner: makeRunner(captured),
        },
      });
      expect(result.success).toBe(true);
      expect(captured.prompt).not.toContain("SUMMARY_TIP");
      expect(captured.prompt).toContain("【待提取的新消息】");
      const metadata = result.records[0].metadata as Record<string, unknown>;
      expect(metadata.source_refs).toBeUndefined();
      expect(metadata.confidence).toBeUndefined();
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
