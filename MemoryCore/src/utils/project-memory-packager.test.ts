import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ProjectMemoryConfig } from "../config.js";
import type { LLMRunner } from "../core/types.js";
import type { IMemoryStore, L1RecordRow } from "../core/store/types.js";
import {
  enforceTopicMaxChars,
  generateProjectMemoryIndex,
  loadProjectTopics,
  parseProjectTopic,
  readProjectMemoryIndex,
  readProjectTopic,
  runProjectMemoryPackager,
  searchProjectTopics,
} from "./project-memory-packager.js";

const topicContent = `---
type: work_method
title: MySQL 超时排查
tags: [数据库, SOP]
sources: [tip-1, l1-1]
updated: 2026-08-19T00:00:00.000Z
---

先查连接池水位，再查慢 SQL。`;
const topicName = "mysql-timeout.md";

function makePackagerRunner(dir: string): LLMRunner {
  return {
    run: async (params) => {
      const workspace = params.workspaceDir ?? dir;
      const file = path.join(workspace, topicName);
      const fs = await import("node:fs/promises");
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, topicContent, "utf-8");
      return "已创建 mysql-timeout.md";
    },
  };
}

describe("project-memory-packager utilities", () => {
  it("parses frontmatter and lists/reads/searches topics", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pm-utils-"));
    const topicsDir = path.join(dir, "project", "topics");
    const fs = await import("node:fs/promises");
    await fs.mkdir(topicsDir, { recursive: true });
    await fs.writeFile(path.join(topicsDir, topicName), topicContent, "utf-8");

    const topics = await loadProjectTopics(dir);
    expect(topics).toHaveLength(1);
    expect(topics[0].type).toBe("work_method");
    expect(topics[0].tags).toEqual(["数据库", "SOP"]);

    const file = await readProjectTopic(dir, undefined, "topics/mysql-timeout.md");
    expect(file?.content).toContain("先查连接池水位");

    const hits = await searchProjectTopics(dir, undefined, "连接池");
    expect(hits).toHaveLength(1);
    expect(hits[0].path).toBe("topics/mysql-timeout.md");
    rmSync(dir, { recursive: true, force: true });
  });

  it("generates deterministic MEMORY.md index with hash and tag grouping", () => {
    const topic = parseProjectTopic(topicName, topicContent)!;
    const index = generateProjectMemoryIndex([topic], { indexMaxChars: 6000 });
    expect(index).toContain("# Project Memory Index");
    expect(index).toContain("hash:");
    expect(index).toContain("## 数据库");
    expect(index).toContain("topics/mysql-timeout.md");
  });

  it("enforces topicMaxChars", () => {
    const long = parseProjectTopic(topicName, topicContent + "长".repeat(5000))!;
    const trimmed = enforceTopicMaxChars(long, 4000);
    expect(trimmed.content.length).toBeLessThanOrEqual(4000);
  });
});

function makeL1Row(overrides: Partial<L1RecordRow> = {}): L1RecordRow {
  return {
    record_id: "l1-1",
    content: "MySQL 超时排查：先看连接池水位，再查慢 SQL",
    type: "work_method",
    priority: 80,
    scene_name: "MySQL 超时排查",
    session_key: "sess-1",
    session_id: "sess-1",
    team_id: "team-a",
    task_id: "",
    user_id: "usr-1",
    agent_id: "agt-a",
    version: 1,
    timestamp_str: "2026-08-21T00:00:00.000Z",
    timestamp_start: "2026-08-21T00:00:00.000Z",
    timestamp_end: "2026-08-21T00:01:00.000Z",
    created_time: "2026-08-21T00:00:00.000Z",
    updated_time: "2026-08-21T00:00:00.000Z",
    metadata_json: "{}",
    ...overrides,
  };
}

function makeStore(rows: L1RecordRow[]): IMemoryStore {
  const calls: Array<{ timeStart?: string }> = [];
  const store = {
    calls,
    queryL1Paginated: async (filter: { timeStart?: string }) => {
      calls.push({ timeStart: filter.timeStart });
      return { rows, total: rows.length };
    },
  };
  return store as unknown as IMemoryStore;
}

describe("runProjectMemoryPackager", () => {
  it("runs without tips when new L1 exists, rebuilds MEMORY.md, and advances the cursor", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pm-run-"));
    const row = makeL1Row();
    const store = makeStore([row]);
    const cfg: ProjectMemoryConfig = {
      enabled: true,
      minPendingTips: 2,
      minDistinctSessions: 2,
      packagerMinIntervalSeconds: 0,
      packagerMaxIntervalSeconds: 3600,
      maxTopics: 15,
      indexMaxChars: 6000,
      topicMaxChars: 4000,
    };

    try {
      const result = await runProjectMemoryPackager({
        dataDir: dir,
        cfg,
        store,
        llmRunner: makePackagerRunner(dir),
        teamId: "team-a",
        agentId: "agt-a",
      });

      expect(result.ran).toBe(true);
      expect(result.l1RecordCount).toBe(1);
      expect(result.topicCount).toBe(1);

      const index = await readProjectMemoryIndex(dir);
      expect(index).toContain("topics/mysql-timeout.md");
      expect(index).toContain(result.indexHash);
      expect((store as unknown as { calls: Array<{ timeStart?: string }> }).calls[0].timeStart).toBeUndefined();

      const second = await runProjectMemoryPackager({
        dataDir: dir,
        cfg,
        store,
        llmRunner: makePackagerRunner(dir),
        teamId: "team-a",
        agentId: "agt-a",
      });
      expect(second.ran).toBe(false);
      expect(second.reason).toBe("no new L1 records");
      expect((store as unknown as { calls: Array<{ timeStart?: string }> }).calls[1].timeStart).toBe(row.updated_time);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});