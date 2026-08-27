import { describe, it, expect, beforeEach } from "vitest";
import { createDb } from "../db/client.js";
import { TeamNotesService, TeamNotesError } from "./team-notes-service.js";

describe("TeamNotesService", () => {
  const serviceId = "default";
  let service: TeamNotesService;

  beforeEach(() => {
    const { db } = createDb({ path: ":memory:" });
    service = new TeamNotesService(db);
  });

  it("creates and reads a note with normalized tags", () => {
    const created = service.create({
      service_id: serviceId,
      team_id: "team-a",
      title: "K8s 回滚 SOP",
      content: "# 步骤\n1. 观察\n2. 回滚",
      tags: ["部署", "部署", " 故障 "],
      author_user_id: "usr-1",
    });
    expect(created.note_id).toMatch(/^note-[0-9a-z]{8}$/);
    expect(created.seq_no).toBe(1);
    expect(created.tags).toHaveLength(2);

    const read = service.get(serviceId, "team-a", created.note_id);
    expect(read?.content).toContain("回滚");
    expect(read?.version).toBe(1);
  });

  it("enforces team isolation", () => {
    const created = service.create({
      service_id: serviceId,
      team_id: "team-a",
      title: "私密笔记",
      content: "team-a only",
      tags: [],
      author_user_id: "usr-1",
    });
    expect(service.get(serviceId, "team-b", created.note_id)).toBeNull();
    expect(service.list(serviceId, "team-b").total).toBe(0);
  });

  it("uses optimistic locking on update", () => {
    const created = service.create({
      service_id: serviceId,
      team_id: "team-a",
      title: "v1",
      content: "one",
      tags: [],
      author_user_id: "usr-1",
    });
    expect(() => service.update(serviceId, "team-a", created.note_id, 99, { title: "bad" })).toThrowError(TeamNotesError);

    const updated = service.update(serviceId, "team-a", created.note_id, 1, {
      title: "v2",
      content: "two",
      tags: ["部署"],
    });
    expect(updated.version).toBe(2);
    expect(updated.title).toBe("v2");
    expect(updated.tags).toEqual([{ tag_slug: "部署", tag_label: "部署" }]);
  });

  it("builds tag graph and mermaid view", () => {
    const a = service.create({
      service_id: serviceId,
      team_id: "team-a",
      title: "A",
      content: "a",
      tags: ["部署"],
      author_user_id: "usr-1",
    });
    service.create({
      service_id: serviceId,
      team_id: "team-a",
      title: "B",
      content: "b",
      tags: ["部署", "数据库"],
      author_user_id: "usr-1",
    });

    const graph = service.graph(serviceId, "team-a");
    expect(graph.nodes.filter((n) => n.type === "note")).toHaveLength(2);
    expect(graph.nodes.filter((n) => n.type === "tag")).toHaveLength(2);
    expect(graph.edges).toHaveLength(3);

    const tags = service.listTags(serviceId, "team-a");
    expect(tags.find((t) => t.tag_slug === "部署")?.note_count).toBe(2);

    const mermaid = service.renderMermaid(serviceId, "team-a");
    expect(mermaid).toContain("flowchart LR");
    expect(mermaid).toContain(`"部署"`);

    const byTag = service.listTagNotes(serviceId, "team-a", "部署");
    expect(byTag.items).toHaveLength(2);
    expect(byTag.items.map((n) => n.note_id)).toContain(a.note_id);
  });

  it("archives a note and excludes it from active lists", () => {
    const created = service.create({
      service_id: serviceId,
      team_id: "team-a",
      title: "to archive",
      content: "x",
      tags: [],
      author_user_id: "usr-1",
    });
    const archived = service.archive(serviceId, "team-a", created.note_id, created.version);
    expect(archived.status).toBe("archived");
    expect(service.list(serviceId, "team-a").total).toBe(0);
    expect(service.exportMarkdown(serviceId, "team-a", created.note_id)).toBeNull();
  });

  it("exports markdown with frontmatter", () => {
    const created = service.create({
      service_id: serviceId,
      team_id: "team-a",
      title: "导出测试",
      content: "正文",
      tags: ["测试"],
      author_user_id: "usr-1",
    });
    const file = service.exportMarkdown(serviceId, "team-a", created.note_id)!;
    expect(file.filename).toBe("导出测试.md");
    expect(file.content).toContain("---");
    expect(file.content).toContain("正文");
  });
});
