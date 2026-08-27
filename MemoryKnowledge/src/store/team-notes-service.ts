/**
 * TeamNotesService — team-scoped lightweight markdown notes.
 *
 * Design decision: SQLite is the system of record. We do NOT dual-write files;
 * /v3/notes/export materializes a markdown file on demand from content_md.
 *
 * All access is scoped by (service_id, team_id). Team membership is enforced
 * by the panel / proxy bridge in front of this data plane.
 */

import { and, asc, desc, eq, inArray, like, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  teamNoteRevisions,
  teamNotes,
  teamNoteTags,
  type TeamNote,
} from "../db/schema.js";
import { genNoteId, genRevisionId } from "./ids.js";

const ID_RETRY = 5;
const MAX_TAGS_PER_NOTE = 10;
const MAX_TAG_LEN = 40;
const MAX_TITLE_LEN = 120;
const MAX_FILENAME_LEN = 180;
const MAX_NOTE_BYTES = 512 * 1024;
const MAX_PAGE_SIZE = 100;

function nowIso(): string {
  return new Date().toISOString();
}

function isUniqueViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(msg);
}

function safeSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}_-]/gu, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 64);
}

function titleSlug(title: string): string {
  const slug = safeSlug(title);
  return slug || "note";
}

export interface TeamNoteTagInput {
  label: string;
  slug: string;
}

export function normalizeTags(raw: unknown): TeamNoteTagInput[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Map<string, string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const label = item.trim().slice(0, MAX_TAG_LEN);
    if (!label) continue;
    const slug = safeSlug(label) || label.slice(0, MAX_TAG_LEN);
    if (!seen.has(slug)) seen.set(slug, label);
    if (seen.size >= MAX_TAGS_PER_NOTE) break;
  }
  return [...seen.entries()].map(([slug, label]) => ({ slug, label }));
}

export interface NoteTagView {
  tag_slug: string;
  tag_label: string;
}

export interface NoteDetail {
  note_id: string;
  service_id: string;
  team_id: string;
  seq_no: number;
  title: string;
  filename: string;
  content: string;
  content_hash: string;
  author_user_id: string;
  version: number;
  status: string;
  tags: NoteTagView[];
  created_at: string;
  updated_at: string;
}

export interface NoteSummary {
  note_id: string;
  team_id: string;
  seq_no: number;
  title: string;
  filename: string;
  author_user_id: string;
  version: number;
  status: string;
  tags: NoteTagView[];
  snippet: string;
  created_at: string;
  updated_at: string;
}

export interface NoteListResult {
  items: NoteSummary[];
  total: number;
}

export interface TagSummary {
  tag_slug: string;
  tag_label: string;
  note_count: number;
}

export interface NotesGraphNode {
  id: string;
  label: string;
  type: "note" | "tag";
  path: string | null;
  linkCount: number;
}

export interface NotesGraphEdge {
  source: string;
  target: string;
  type: "has_tag";
  weight: number;
}

export interface NotesGraph {
  nodes: NotesGraphNode[];
  edges: NotesGraphEdge[];
}

export interface CreateNoteInput {
  service_id: string;
  team_id: string;
  title: string;
  filename?: string;
  content: string;
  tags: string[];
  author_user_id: string;
  user_id?: string;
  agent_id?: string;
}

export interface UpdateNoteInput {
  title?: string;
  filename?: string;
  content?: string;
  tags?: string[];
  edited_by: string;
}

export class TeamNotesError extends Error {
  constructor(
    public readonly code: "note_not_found" | "version_stale" | "invalid_input",
    message: string,
    public readonly httpStatus: 400 | 404 | 409,
  ) {
    super(message);
    this.name = "TeamNotesError";
  }
}

function assertInput(ok: boolean, message: string): void {
  if (!ok) throw new TeamNotesError("invalid_input", message, 400);
}

export class TeamNotesService {
  constructor(private readonly db: Db) {}

  // ─────────────────────────────────────────────────────────────
  // Create
  // ─────────────────────────────────────────────────────────────

  create(input: CreateNoteInput): NoteDetail {
    assertInput(input.title.trim().length > 0, "title is required");
    assertInput(input.title.trim().length <= MAX_TITLE_LEN, `title exceeds ${MAX_TITLE_LEN} chars`);
    assertInput(input.content.trim().length > 0, "content is required");
    assertInput(Buffer.byteLength(input.content, "utf8") <= MAX_NOTE_BYTES, "content exceeds 512KB");
    const tags = normalizeTags(input.tags);
    const ts = nowIso();
    const filename = (input.filename?.trim() || `${titleSlug(input.title)}.md`).slice(0, MAX_FILENAME_LEN);
    const contentHash = this.hashContent(input.content);

    for (let attempt = 0; attempt < ID_RETRY; attempt++) {
      const noteId = genNoteId();
      try {
        this.db.transaction((tx) => {
          const seq = tx
            .select({ next: sql<number>`coalesce(max(${teamNotes.seqNo}), 0) + 1` })
            .from(teamNotes)
            .where(and(eq(teamNotes.serviceId, input.service_id), eq(teamNotes.teamId, input.team_id)))
            .get();
          const seqNo = seq?.next ?? 1;

          tx.insert(teamNotes)
            .values({
              noteId,
              serviceId: input.service_id,
              teamId: input.team_id,
              seqNo,
              title: input.title.trim(),
              filename,
              contentMd: input.content,
              contentHash,
              authorUserId: input.author_user_id,
              version: 1,
              status: "active",
              createdAt: ts,
              updatedAt: ts,
            })
            .run();

          this.replaceTags(tx as any, noteId, tags, ts);
          tx.insert(teamNoteRevisions)
            .values({
              revisionId: genRevisionId(),
              noteId,
              version: 1,
              title: input.title.trim(),
              contentMd: input.content,
              tagsJson: JSON.stringify(tags),
              editedBy: input.author_user_id,
              createdAt: ts,
            })
            .run();
        });
        return this.get(input.service_id, input.team_id, noteId)!;
      } catch (err) {
        if (isUniqueViolation(err) && attempt < ID_RETRY - 1) continue;
        throw err;
      }
    }
    throw new Error("create note: failed to allocate unique id");
  }

  // ─────────────────────────────────────────────────────────────
  // Read
  // ─────────────────────────────────────────────────────────────

  get(serviceId: string, teamId: string, noteId: string): NoteDetail | null {
    return this.readDetail(this.db, serviceId, teamId, noteId);
  }

  list(
    serviceId: string,
    teamId: string,
    opts: { tags?: string[]; limit?: number; offset?: number; includeArchived?: boolean } = {},
  ): NoteListResult {
    const conditions: SQL[] = [
      eq(teamNotes.serviceId, serviceId),
      eq(teamNotes.teamId, teamId),
    ];
    if (!opts.includeArchived) conditions.push(eq(teamNotes.status, "active"));

    let rows: TeamNote[];
    if (opts.tags && opts.tags.length > 0) {
      const slugs = [...new Set(opts.tags.map(safeSlug).filter(Boolean))];
      const tagRows = this.db
        .select()
        .from(teamNoteTags)
        .where(inArray(teamNoteTags.tagSlug, slugs))
        .all();
      const noteIds = [...new Set(tagRows.map((t) => t.noteId))];
      if (noteIds.length === 0) return { items: [], total: 0 };
      conditions.push(inArray(teamNotes.noteId, noteIds));
    }

    const limit = Math.min(Math.max(Math.floor(opts.limit ?? 20), 1), MAX_PAGE_SIZE);
    const offset = Math.max(Math.floor(opts.offset ?? 0), 0);
    rows = this.db
      .select()
      .from(teamNotes)
      .where(and(...conditions))
      .orderBy(asc(teamNotes.seqNo))
      .limit(limit)
      .offset(offset)
      .all();

    const totalRow = this.db
      .select({ total: sql<number>`count(*)` })
      .from(teamNotes)
      .where(and(...conditions))
      .get();

    const tagsByNote = this.loadTagsForNotes(rows.map((r) => r.noteId));
    return {
      items: rows.map((row) => this.toSummary(row, tagsByNote.get(row.noteId) ?? [])),
      total: totalRow?.total ?? 0,
    };
  }

  search(
    serviceId: string,
    teamId: string,
    query: string,
    opts: { tags?: string[]; limit?: number; offset?: number } = {},
  ): NoteListResult {
    const q = query.trim();
    assertInput(q.length > 0, "query is required");
    const conditions: SQL[] = [
      eq(teamNotes.serviceId, serviceId),
      eq(teamNotes.teamId, teamId),
      eq(teamNotes.status, "active"),
    ];
    const pattern = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
    conditions.push(or(like(teamNotes.title, pattern), like(teamNotes.contentMd, pattern))!);

    if (opts.tags && opts.tags.length > 0) {
      const slugs = [...new Set(opts.tags.map(safeSlug).filter(Boolean))];
      const tagRows = this.db
        .select()
        .from(teamNoteTags)
        .where(inArray(teamNoteTags.tagSlug, slugs))
        .all();
      const noteIds = [...new Set(tagRows.map((t) => t.noteId))];
      if (noteIds.length === 0) return { items: [], total: 0 };
      conditions.push(inArray(teamNotes.noteId, noteIds));
    }

    const limit = Math.min(Math.max(Math.floor(opts.limit ?? 20), 1), MAX_PAGE_SIZE);
    const offset = Math.max(Math.floor(opts.offset ?? 0), 0);
    const rows = this.db
      .select()
      .from(teamNotes)
      .where(and(...conditions))
      .orderBy(desc(teamNotes.updatedAt))
      .limit(limit)
      .offset(offset)
      .all();
    const totalRow = this.db
      .select({ total: sql<number>`count(*)` })
      .from(teamNotes)
      .where(and(...conditions))
      .get();
    const tagsByNote = this.loadTagsForNotes(rows.map((r) => r.noteId));
    return {
      items: rows.map((row) => this.toSummary(row, tagsByNote.get(row.noteId) ?? [])),
      total: totalRow?.total ?? 0,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // Update / archive
  // ─────────────────────────────────────────────────────────────

  update(serviceId: string, teamId: string, noteId: string, expectedVersion: number, input: UpdateNoteInput): NoteDetail {
    assertInput(Number.isInteger(expectedVersion) && expectedVersion > 0, "expected_version is required");
    const existing = this.findActiveRow(this.db, serviceId, teamId, noteId);
    if (!existing) throw new TeamNotesError("note_not_found", "note not found", 404);
    if (existing.version !== expectedVersion) {
      throw new TeamNotesError("version_stale", `note version ${expectedVersion} is stale; current ${existing.version}`, 409);
    }

    const nextTitle = input.title !== undefined ? input.title.trim() : existing.title;
    const nextContent = input.content !== undefined ? input.content : existing.contentMd;
    assertInput(nextTitle.length > 0 && nextTitle.length <= MAX_TITLE_LEN, "invalid title");
    assertInput(nextContent.trim().length > 0, "content is required");
    assertInput(Buffer.byteLength(nextContent, "utf8") <= MAX_NOTE_BYTES, "content exceeds 512KB");
    const nextFilename = (input.filename !== undefined ? input.filename.trim() : existing.filename).slice(0, MAX_FILENAME_LEN);
    const tags = input.tags !== undefined ? normalizeTags(input.tags) : this.loadTagsForNote(this.db, noteId).map((t) => ({ slug: t.tag_slug, label: t.tag_label }));
    const nextVersion = existing.version + 1;
    const ts = nowIso();

    this.db.transaction((tx) => {
      tx.update(teamNotes)
        .set({
          title: nextTitle,
          filename: nextFilename || `${titleSlug(nextTitle)}.md`,
          contentMd: nextContent,
          contentHash: this.hashContent(nextContent),
          version: nextVersion,
          updatedAt: ts,
        })
        .where(and(eq(teamNotes.serviceId, serviceId), eq(teamNotes.teamId, teamId), eq(teamNotes.noteId, noteId)))
        .run();

      tx.delete(teamNoteTags).where(eq(teamNoteTags.noteId, noteId)).run();
      this.replaceTags(tx as any, noteId, tags, ts);
      tx.insert(teamNoteRevisions)
        .values({
          revisionId: genRevisionId(),
          noteId,
          version: nextVersion,
          title: nextTitle,
          contentMd: nextContent,
          tagsJson: JSON.stringify(tags),
          editedBy: input.edited_by || existing.authorUserId,
          createdAt: ts,
        })
        .run();
    });

    return this.get(serviceId, teamId, noteId)!;
  }

  archive(serviceId: string, teamId: string, noteId: string, expectedVersion?: number): NoteDetail {
    const existing = this.findActiveRow(this.db, serviceId, teamId, noteId);
    if (!existing) throw new TeamNotesError("note_not_found", "note not found", 404);
    if (expectedVersion !== undefined && existing.version !== expectedVersion) {
      throw new TeamNotesError("version_stale", `note version ${expectedVersion} is stale; current ${existing.version}`, 409);
    }
    const nextVersion = existing.version + 1;
    const ts = nowIso();
    this.db
      .update(teamNotes)
      .set({ status: "archived", version: nextVersion, updatedAt: ts })
      .where(and(eq(teamNotes.serviceId, serviceId), eq(teamNotes.teamId, teamId), eq(teamNotes.noteId, noteId)))
      .run();
    const detail = this.get(serviceId, teamId, noteId)!;
    detail.status = "archived";
    return detail;
  }

  // ─────────────────────────────────────────────────────────────
  // Tags / graph / export
  // ─────────────────────────────────────────────────────────────

  listTags(serviceId: string, teamId: string): TagSummary[] {
    const rows = this.listActiveRows(serviceId, teamId);
    if (rows.length === 0) return [];
    const tagRows = this.loadTagsForNotes(rows.map((r) => r.noteId));
    const bySlug = new Map<string, TagSummary>();
    for (const tags of tagRows.values()) {
      for (const tag of tags) {
        const cur = bySlug.get(tag.tag_slug) ?? {
          tag_slug: tag.tag_slug,
          tag_label: tag.tag_label,
          note_count: 0,
        };
        cur.note_count += 1;
        bySlug.set(tag.tag_slug, cur);
      }
    }
    return [...bySlug.values()].sort((a, b) => b.note_count - a.note_count || a.tag_label.localeCompare(b.tag_label));
  }

  listTagNotes(serviceId: string, teamId: string, tagSlug: string): { tag: TagSummary; items: NoteSummary[] } {
    const slug = safeSlug(tagSlug);
    if (!slug) return { tag: { tag_slug: tagSlug, tag_label: tagSlug, note_count: 0 }, items: [] };
    const rows = this.listActiveRows(serviceId, teamId);
    const tagsByNote = this.loadTagsForNotes(rows.map((r) => r.noteId));
    let label = tagSlug;
    for (const tags of tagsByNote.values()) {
      for (const tag of tags) {
        if (tag.tag_slug === slug) {
          label = tag.tag_label;
          break;
        }
      }
    }
    const items: NoteSummary[] = [];
    let count = 0;
    for (const row of rows) {
      const tags = tagsByNote.get(row.noteId) ?? [];
      if (tags.some((t) => t.tag_slug === slug)) {
        count += 1;
        items.push(this.toSummary(row, tags));
      }
    }
    return {
      tag: { tag_slug: slug, tag_label: label, note_count: count },
      items,
    };
  }

  graph(serviceId: string, teamId: string): NotesGraph {
    const rows = this.listActiveRows(serviceId, teamId);
    const tagRowsByNote = this.loadTagsForNotes(rows.map((r) => r.noteId));
    const nodes: NotesGraphNode[] = [];
    const edges: NotesGraphEdge[] = [];
    const tagLink = new Map<string, number>();
    const tagLabel = new Map<string, string>();

    for (const row of rows) {
      nodes.push({
        id: `note:${row.noteId}`,
        label: row.title,
        type: "note",
        path: row.filename,
        linkCount: (tagRowsByNote.get(row.noteId) ?? []).length,
      });
      for (const tag of tagRowsByNote.get(row.noteId) ?? []) {
        tagLink.set(tag.tag_slug, (tagLink.get(tag.tag_slug) ?? 0) + 1);
        tagLabel.set(tag.tag_slug, tag.tag_label);
      }
    }

    for (const [slug, count] of tagLink) {
      nodes.push({ id: `tag:${slug}`, label: tagLabel.get(slug) ?? slug, type: "tag", path: null, linkCount: count });
    }
    for (const row of rows) {
      for (const tag of tagRowsByNote.get(row.noteId) ?? []) {
        edges.push({
          source: `note:${row.noteId}`,
          target: `tag:${tag.tag_slug}`,
          type: "has_tag",
          weight: 1,
        });
      }
    }
    return { nodes, edges };
  }

  renderMermaid(serviceId: string, teamId: string, direction: "LR" | "TB" = "LR"): string {
    const graph = this.graph(serviceId, teamId);
    const lines = [`flowchart ${direction}`];
    // Assign sequential ids from the graph node list so non-ASCII slugs
    // (e.g. CJK tags) cannot collide after sanitization.
    const ids = new Map<string, string>();
    graph.nodes.forEach((node, index) => ids.set(node.id, `n${index + 1}`));
    for (const [index, node] of graph.nodes.entries()) {
      const id = ids.get(node.id) ?? `n${index + 1}`;
      const label = this.escapeMermaid(node.label);
      lines.push(`  ${id}${node.type === "tag" ? `[("${label}")]` : `["${label}"]`}`);
    }
    for (const edge of graph.edges) {
      const source = ids.get(edge.source);
      const target = ids.get(edge.target);
      if (!source || !target) continue;
      lines.push(`  ${source} --> ${target}`);
    }
    return lines.join("\n") + "\n";
  }

  exportMarkdown(serviceId: string, teamId: string, noteId: string): { filename: string; content: string } | null {
    const detail = this.get(serviceId, teamId, noteId);
    if (!detail || detail.status !== "active") return null;
    const fm = [
      "---",
      `title: ${JSON.stringify(detail.title)}`,
      `tags: [${detail.tags.map((t) => JSON.stringify(t.tag_label)).join(", ")}]`,
      `version: ${detail.version}`,
      `created_at: ${detail.created_at}`,
      `updated_at: ${detail.updated_at}`,
      "---",
    ].join("\n");
    return { filename: detail.filename || `${titleSlug(detail.title)}.md`, content: `${fm}\n\n${detail.content}\n` };
  }

  listRevisions(_serviceId: string, _teamId: string, noteId: string): Array<{ revision_id: string; version: number; edited_by: string; created_at: string }> {
    const rows = this.db
      .select({
        revision_id: teamNoteRevisions.revisionId,
        version: teamNoteRevisions.version,
        edited_by: teamNoteRevisions.editedBy,
        created_at: teamNoteRevisions.createdAt,
      })
      .from(teamNoteRevisions)
      .where(eq(teamNoteRevisions.noteId, noteId))
      .orderBy(desc(teamNoteRevisions.version))
      .all();
    return rows.map((r) => ({
      revision_id: r.revision_id,
      version: r.version,
      edited_by: r.edited_by,
      created_at: r.created_at,
    }));
  }

  // ─────────────────────────────────────────────────────────────
  // Internals
  // ─────────────────────────────────────────────────────────────

  private hashContent(content: string): string {
    // FNV-1a is enough for change detection; no cryptographic requirement here.
    let h = 0x811c9dc5;
    for (let i = 0; i < content.length; i++) {
      h ^= content.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  }

  private findActiveRow(db: Db, serviceId: string, teamId: string, noteId: string): TeamNote | null {
    return (
      db
        .select()
        .from(teamNotes)
        .where(
          and(
            eq(teamNotes.serviceId, serviceId),
            eq(teamNotes.teamId, teamId),
            eq(teamNotes.noteId, noteId),
            eq(teamNotes.status, "active"),
          ),
        )
        .get() ?? null
    );
  }

  private listActiveRows(serviceId: string, teamId: string): TeamNote[] {
    return this.db
      .select()
      .from(teamNotes)
      .where(
        and(
          eq(teamNotes.serviceId, serviceId),
          eq(teamNotes.teamId, teamId),
          eq(teamNotes.status, "active"),
        ),
      )
      .orderBy(asc(teamNotes.seqNo))
      .all();
  }

  private readDetail(db: Db, serviceId: string, teamId: string, noteId: string): NoteDetail | null {
    const row =
      db
        .select()
        .from(teamNotes)
        .where(
          and(
            eq(teamNotes.serviceId, serviceId),
            eq(teamNotes.teamId, teamId),
            eq(teamNotes.noteId, noteId),
          ),
        )
        .get() ?? null;
    if (!row) return null;
    const tags = this.loadTagsForNote(db, noteId);
    return {
      note_id: row.noteId,
      service_id: row.serviceId,
      team_id: row.teamId,
      seq_no: row.seqNo,
      title: row.title,
      filename: row.filename,
      content: row.contentMd,
      content_hash: row.contentHash,
      author_user_id: row.authorUserId,
      version: row.version,
      status: row.status,
      tags,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    };
  }

  private replaceTags(db: Db, noteId: string, tags: TeamNoteTagInput[], ts: string): void {
    for (const tag of tags) {
      db.insert(teamNoteTags)
        .values({ noteId, tagSlug: tag.slug, tagLabel: tag.label, createdAt: ts })
        .run();
    }
  }

  private loadTagsForNotes(noteIds: string[]): Map<string, NoteTagView[]> {
    const out = new Map<string, NoteTagView[]>();
    if (noteIds.length === 0) return out;
    const rows = this.db
      .select()
      .from(teamNoteTags)
      .where(inArray(teamNoteTags.noteId, noteIds))
      .orderBy(asc(teamNoteTags.tagSlug))
      .all();
    for (const row of rows) {
      const list = out.get(row.noteId) ?? [];
      list.push({ tag_slug: row.tagSlug, tag_label: row.tagLabel });
      out.set(row.noteId, list);
    }
    return out;
  }

  private loadTagsForNote(db: Db, noteId: string): NoteTagView[] {
    const rows = db
      .select()
      .from(teamNoteTags)
      .where(eq(teamNoteTags.noteId, noteId))
      .orderBy(asc(teamNoteTags.tagSlug))
      .all();
    return rows.map((row) => ({ tag_slug: row.tagSlug, tag_label: row.tagLabel }));
  }

  private toSummary(row: TeamNote, tags: NoteTagView[]): NoteSummary {
    const snippet = row.contentMd.replace(/^---\n[\s\S]*?\n---\n?/, "").replace(/\s+/g, " ").trim().slice(0, 160);
    return {
      note_id: row.noteId,
      team_id: row.teamId,
      seq_no: row.seqNo,
      title: row.title,
      filename: row.filename,
      author_user_id: row.authorUserId,
      version: row.version,
      status: row.status,
      tags,
      snippet,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    };
  }

  private escapeMermaid(label: string): string {
    return label.replace(/"/g, "'").replace(/\n/g, " ");
  }
}
