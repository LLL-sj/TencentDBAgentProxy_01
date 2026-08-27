/**
 * Team Notes Routes — lightweight team-shared markdown notes.
 *
 * Routes are mounted under /v3/notes. Every endpoint requires
 * x-tdai-service-id and a team_id in the body; team membership / auth is
 * enforced by the panel or proxy bridge in front of this data plane.
 */

import { Hono, type Context } from "hono";
import { isValidIdSegment, wrapError, wrapOk } from "../api-helpers.js";
import {
  TeamNotesError,
  TeamNotesService,
} from "../store/team-notes-service.js";

export interface NotesRouteDeps {
  notesService: TeamNotesService;
}

function bodyString(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function bodyStringArray(body: Record<string, unknown>, key: string): string[] {
  const value = body[key];
  if (!Array.isArray(value)) return [];
  return value.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
}

function bodyInt(body: Record<string, unknown>, key: string): number | null {
  const value = body[key];
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) ? value : null;
}

function mapError(err: unknown): Response {
  if (err instanceof TeamNotesError) {
    const code = err.code === "version_stale" ? 40901 : err.code === "note_not_found" ? 40401 : 40001;
    return Response.json(wrapError(code, err.message), { status: err.httpStatus });
  }
  const message = err instanceof Error ? err.message : String(err);
  return Response.json(wrapError(50001, `notes internal error: ${message}`), { status: 500 });
}

export function createNotesRoutes(deps: NotesRouteDeps): Hono {
  const app = new Hono();
  const { notesService } = deps;

  function ids(c: Context, body: Record<string, unknown>): { service_id: string; team_id: string } | Response {
    const serviceId = c.req.header("x-tdai-service-id");
    if (!isValidIdSegment(serviceId)) return Response.json(wrapError(400, "x-tdai-service-id header is required"), { status: 400 });
    const teamId = bodyString(body, "team_id");
    if (!teamId || !isValidIdSegment(teamId)) return Response.json(wrapError(400, "valid team_id is required"), { status: 400 });
    return { service_id: serviceId, team_id: teamId };
  }

  // ── Write endpoints ─────────────────────────────────────────

  app.post("/create", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const base = ids(c, body);
    if (base instanceof Response) return base;
    const title = bodyString(body, "title");
    const content = bodyString(body, "content");
    if (!title) return Response.json(wrapError(40001, "title is required"), { status: 400 });
    if (!content) return Response.json(wrapError(40001, "content is required"), { status: 400 });
    const filename = bodyString(body, "filename") ?? undefined;
    const tags = bodyStringArray(body, "tags");
    const userId = bodyString(body, "user_id") ?? bodyString(body, "author_user_id") ?? "unknown";
    try {
      const detail = notesService.create({
        service_id: base.service_id,
        team_id: base.team_id,
        title,
        filename,
        content,
        tags,
        author_user_id: userId,
        user_id: userId,
        agent_id: bodyString(body, "agent_id") ?? undefined,
      });
      return Response.json(wrapOk(detail), { status: 201 });
    } catch (err) {
      return mapError(err);
    }
  });

  app.post("/update", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const base = ids(c, body);
    if (base instanceof Response) return base;
    const noteId = bodyString(body, "note_id");
    const expectedVersion = bodyInt(body, "expected_version");
    if (!noteId) return Response.json(wrapError(40001, "note_id is required"), { status: 400 });
    if (!expectedVersion) return Response.json(wrapError(40001, "expected_version is required"), { status: 400 });
    try {
      const detail = notesService.update(base.service_id, base.team_id, noteId, expectedVersion, {
        title: body.title !== undefined ? (typeof body.title === "string" ? body.title : "") : undefined,
        filename: body.filename !== undefined ? (typeof body.filename === "string" ? body.filename : "") : undefined,
        content: body.content !== undefined ? (typeof body.content === "string" ? body.content : "") : undefined,
        tags: Array.isArray(body.tags) ? (body.tags as string[]) : undefined,
        edited_by: bodyString(body, "user_id") ?? "unknown",
      });
      return Response.json(wrapOk(detail));
    } catch (err) {
      return mapError(err);
    }
  });

  app.post("/delete", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const base = ids(c, body);
    if (base instanceof Response) return base;
    const noteId = bodyString(body, "note_id");
    if (!noteId) return Response.json(wrapError(40001, "note_id is required"), { status: 400 });
    const expectedVersion = bodyInt(body, "expected_version") ?? undefined;
    try {
      const detail = notesService.archive(base.service_id, base.team_id, noteId, expectedVersion);
      return Response.json(wrapOk(detail));
    } catch (err) {
      return mapError(err);
    }
  });

  // ── Read endpoints ──────────────────────────────────────────

  app.post("/get", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const base = ids(c, body);
    if (base instanceof Response) return base;
    const noteId = bodyString(body, "note_id");
    if (!noteId) return Response.json(wrapError(40001, "note_id is required"), { status: 400 });
    const detail = notesService.get(base.service_id, base.team_id, noteId);
    if (!detail) return Response.json(wrapError(40401, "note not found"), { status: 404 });
    return Response.json(wrapOk(detail));
  });

  app.post("/list", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const base = ids(c, body);
    if (base instanceof Response) return base;
    const tags = bodyStringArray(body, "tags");
    const limit = bodyInt(body, "limit") ?? 20;
    const offset = bodyInt(body, "offset") ?? 0;
    const includeArchived = body.include_archived === true;
    return Response.json(wrapOk(notesService.list(base.service_id, base.team_id, { tags, limit, offset, includeArchived })));
  });

  app.post("/search", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const base = ids(c, body);
    if (base instanceof Response) return base;
    const query = bodyString(body, "query");
    if (!query) return Response.json(wrapError(40001, "query is required"), { status: 400 });
    const tags = bodyStringArray(body, "tags");
    const limit = bodyInt(body, "limit") ?? 20;
    const offset = bodyInt(body, "offset") ?? 0;
    try {
      return Response.json(wrapOk(notesService.search(base.service_id, base.team_id, query, { tags, limit, offset })));
    } catch (err) {
      return mapError(err);
    }
  });

  app.post("/tags/list", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const base = ids(c, body);
    if (base instanceof Response) return base;
    return Response.json(wrapOk({ items: notesService.listTags(base.service_id, base.team_id) }));
  });

  app.post("/tags/pages", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const base = ids(c, body);
    if (base instanceof Response) return base;
    const tag = bodyString(body, "tag_slug") ?? bodyString(body, "tag");
    if (!tag) return Response.json(wrapError(40001, "tag_slug is required"), { status: 400 });
    return Response.json(wrapOk(notesService.listTagNotes(base.service_id, base.team_id, tag)));
  });

  app.post("/graph", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const base = ids(c, body);
    if (base instanceof Response) return base;
    return Response.json(wrapOk(notesService.graph(base.service_id, base.team_id)));
  });

  app.post("/graph/mermaid", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const base = ids(c, body);
    if (base instanceof Response) return base;
    const direction = body.direction === "TB" ? "TB" : "LR";
    return Response.json(wrapOk({ mermaid: notesService.renderMermaid(base.service_id, base.team_id, direction) }));
  });

  app.post("/revisions", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const base = ids(c, body);
    if (base instanceof Response) return base;
    const noteId = bodyString(body, "note_id");
    if (!noteId) return Response.json(wrapError(40001, "note_id is required"), { status: 400 });
    const detail = notesService.get(base.service_id, base.team_id, noteId);
    if (!detail) return Response.json(wrapError(40401, "note not found"), { status: 404 });
    return Response.json(wrapOk({ items: notesService.listRevisions(base.service_id, base.team_id, noteId) }));
  });

  app.post("/export", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const base = ids(c, body);
    if (base instanceof Response) return base;
    const noteId = bodyString(body, "note_id");
    if (!noteId) return Response.json(wrapError(40001, "note_id is required"), { status: 400 });
    const file = notesService.exportMarkdown(base.service_id, base.team_id, noteId);
    if (!file) return Response.json(wrapError(40401, "note not found"), { status: 404 });
    const disposition = `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`;
    return new Response(file.content, {
      status: 200,
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": disposition,
      },
    });
  });

  return app;
}
