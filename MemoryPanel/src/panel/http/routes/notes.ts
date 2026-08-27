/**
 * /api/v1/notes/* — Team Notes panel routes.
 *
 * Notes are team-scoped resources without AssetType lifecycle; every endpoint
 * requires an active team member. Panel just forwards to Knowledge /v3/notes/*.
 */
import type { Hono } from 'hono';
import { validatePanelMetaHeaders } from '../middleware/validate-panel-headers.js';
import { respondControlError } from '../envelope.js';
import type { PanelDeps } from '../../panel-deps.js';
import { respondEnvelope } from '../envelope.js';
import {
  buildCtx,
  readJson,
  str,
  strArray,
  okEnvelope,
  requireTeamMember,
  runKs,
} from './knowledge/common.js';

function intOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) ? value : null;
}

export function registerNotesRoutes(api: Hono, deps: PanelDeps): void {
  const mw = validatePanelMetaHeaders(deps);

  api.post('/notes/list', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const teamId = str(body, 'team_id');
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');
    const gate = await requireTeamMember(deps, c, ctx, teamId);
    if ('error' in gate) return gate.error;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    const opts = {
      tags: strArray(body, 'tags'),
      limit: intOrNull(body.limit) ?? undefined,
      offset: intOrNull(body.offset) ?? undefined,
      includeArchived: body.include_archived === true,
    };
    return runKs(c, () => kc.noteList(teamId, opts));
  });

  api.post('/notes/get', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const teamId = str(body, 'team_id');
    const noteId = str(body, 'note_id');
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');
    if (!noteId) return respondControlError(c, 400, 'MISSING_NOTE_ID');
    const gate = await requireTeamMember(deps, c, ctx, teamId);
    if ('error' in gate) return gate.error;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    return runKs(c, () => kc.noteGet(teamId, noteId));
  });

  api.post('/notes/create', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const teamId = str(body, 'team_id');
    const title = str(body, 'title');
    const content = str(body, 'content');
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');
    if (!title) return respondControlError(c, 400, 'MISSING_TITLE');
    if (!content) return respondControlError(c, 400, 'MISSING_CONTENT');
    const gate = await requireTeamMember(deps, c, ctx, teamId);
    if ('error' in gate) return gate.error;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    const filename = str(body, 'filename') ?? undefined;
    const tags = strArray(body, 'tags');
    return runKs(c, () => kc.noteCreate(teamId, { title, filename, content, tags }, gate.userId));
  });

  api.post('/notes/update', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const teamId = str(body, 'team_id');
    const noteId = str(body, 'note_id');
    const expectedVersion = intOrNull(body.expected_version);
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');
    if (!noteId) return respondControlError(c, 400, 'MISSING_NOTE_ID');
    if (!expectedVersion) return respondControlError(c, 400, 'MISSING_EXPECTED_VERSION');
    const gate = await requireTeamMember(deps, c, ctx, teamId);
    if ('error' in gate) return gate.error;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    const patch: { title?: string; filename?: string; content?: string; tags?: string[] } = {};
    if (typeof body.title === 'string') patch.title = body.title;
    if (typeof body.filename === 'string') patch.filename = body.filename;
    if (typeof body.content === 'string') patch.content = body.content;
    if (Array.isArray(body.tags)) patch.tags = body.tags as string[];
    return runKs(c, () => kc.noteUpdate(teamId, noteId, expectedVersion, patch, gate.userId));
  });

  api.post('/notes/delete', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const teamId = str(body, 'team_id');
    const noteId = str(body, 'note_id');
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');
    if (!noteId) return respondControlError(c, 400, 'MISSING_NOTE_ID');
    const gate = await requireTeamMember(deps, c, ctx, teamId);
    if ('error' in gate) return gate.error;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    const expectedVersion = intOrNull(body.expected_version) ?? undefined;
    return runKs(c, () => kc.noteArchive(teamId, noteId, expectedVersion));
  });

  api.post('/notes/search', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const teamId = str(body, 'team_id');
    const query = str(body, 'query');
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');
    if (!query) return respondControlError(c, 400, 'MISSING_QUERY');
    const gate = await requireTeamMember(deps, c, ctx, teamId);
    if ('error' in gate) return gate.error;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    const opts = {
      tags: strArray(body, 'tags'),
      limit: intOrNull(body.limit) ?? undefined,
      offset: intOrNull(body.offset) ?? undefined,
    };
    return runKs(c, () => kc.noteSearch(teamId, query, opts));
  });

  api.post('/notes/tags/list', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const teamId = str(body, 'team_id');
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');
    const gate = await requireTeamMember(deps, c, ctx, teamId);
    if ('error' in gate) return gate.error;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    return runKs(c, () => kc.noteTagsList(teamId));
  });

  api.post('/notes/tags/pages', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const teamId = str(body, 'team_id');
    const tag = str(body, 'tag_slug') ?? str(body, 'tag');
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');
    if (!tag) return respondControlError(c, 400, 'MISSING_TAG');
    const gate = await requireTeamMember(deps, c, ctx, teamId);
    if ('error' in gate) return gate.error;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    return runKs(c, () => kc.noteTagPages(teamId, tag));
  });

  api.post('/notes/graph', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const teamId = str(body, 'team_id');
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');
    const gate = await requireTeamMember(deps, c, ctx, teamId);
    if ('error' in gate) return gate.error;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    return runKs(c, () => kc.noteGraph(teamId));
  });

  api.post('/notes/graph/mermaid', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const teamId = str(body, 'team_id');
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');
    const gate = await requireTeamMember(deps, c, ctx, teamId);
    if ('error' in gate) return gate.error;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    const direction = body.direction === 'TB' ? 'TB' : 'LR';
    return runKs(c, () => kc.noteMermaid(teamId, direction));
  });

  api.post('/notes/revisions', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const teamId = str(body, 'team_id');
    const noteId = str(body, 'note_id');
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');
    if (!noteId) return respondControlError(c, 400, 'MISSING_NOTE_ID');
    const gate = await requireTeamMember(deps, c, ctx, teamId);
    if ('error' in gate) return gate.error;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    return runKs(c, () => kc.noteRevisions(teamId, noteId));
  });
}
