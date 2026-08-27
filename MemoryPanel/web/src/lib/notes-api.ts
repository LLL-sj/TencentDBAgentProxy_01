/**
 * Team Notes panel API client.
 *
 * Endpoints live under `/api/v1/notes`; the panel backend enforces team
 * membership and forwards to the Knowledge service `/v3/notes/*`.
 */

import { getPanelSession } from './panelSession';
import { formatApiErrorMessage } from './error-message';

const BASE = '/api/v1/notes';

interface Envelope<T = unknown> {
  code: number;
  message: string;
  request_id: string;
  data: T;
}

export class NotesApiError extends Error {
  code: number;
  requestId: string;
  rawMessage: string;

  constructor(code: number, message: string, requestId: string) {
    super(formatApiErrorMessage({ code, message, requestId }));
    this.name = 'NotesApiError';
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
    throw new NotesApiError(res.status || 500, text || res.statusText || 'Notes request failed', '');
  }
  if (!res.ok || env.code !== 0) {
    throw new NotesApiError(env.code ?? res.status, env.message || res.statusText, env.request_id);
  }
  return env.data;
}

export interface NoteTag {
  tag_slug: string;
  tag_label: string;
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
  tags: NoteTag[];
  snippet: string;
  created_at: string;
  updated_at: string;
}

export interface NoteDetail extends NoteSummary {
  service_id: string;
  content: string;
  content_hash: string;
}

export interface NoteListResult {
  items: NoteSummary[];
  total: number;
}

export interface NoteTagSummary {
  tag_slug: string;
  tag_label: string;
  note_count: number;
}

export interface NotesGraphNode {
  id: string;
  label: string;
  type: 'note' | 'tag';
  path: string | null;
  linkCount: number;
}

export interface NotesGraphEdge {
  source: string;
  target: string;
  type: 'has_tag';
  weight: number;
}

export interface NotesGraphData {
  nodes: NotesGraphNode[];
  edges: NotesGraphEdge[];
}

export const notesApi = {
  list: (teamId: string, opts?: { tags?: string[]; limit?: number; offset?: number }) =>
    panelPost<NoteListResult>('/list', { team_id: teamId, ...opts }),
  get: (teamId: string, noteId: string) =>
    panelPost<NoteDetail>('/get', { team_id: teamId, note_id: noteId }),
  create: (teamId: string, input: { title: string; filename?: string; content: string; tags: string[] }) =>
    panelPost<NoteDetail>('/create', { team_id: teamId, ...input }),
  update: (teamId: string, noteId: string, expectedVersion: number, patch: { title?: string; filename?: string; content?: string; tags?: string[] }) =>
    panelPost<NoteDetail>('/update', { team_id: teamId, note_id: noteId, expected_version: expectedVersion, ...patch }),
  archive: (teamId: string, noteId: string, expectedVersion?: number) =>
    panelPost<NoteDetail>('/delete', { team_id: teamId, note_id: noteId, expected_version: expectedVersion }),
  search: (teamId: string, query: string, opts?: { tags?: string[]; limit?: number; offset?: number }) =>
    panelPost<NoteListResult>('/search', { team_id: teamId, query, ...opts }),
  tagsList: (teamId: string) =>
    panelPost<{ items: NoteTagSummary[] }>('/tags/list', { team_id: teamId }),
  tagPages: (teamId: string, tagSlug: string) =>
    panelPost<{ tag: NoteTagSummary; items: NoteSummary[] }>('/tags/pages', { team_id: teamId, tag_slug: tagSlug }),
  graph: (teamId: string) =>
    panelPost<NotesGraphData>('/graph', { team_id: teamId }),
  mermaid: (teamId: string, direction: 'LR' | 'TB' = 'LR') =>
    panelPost<{ mermaid: string }>('/graph/mermaid', { team_id: teamId, direction }),
  revisions: (teamId: string, noteId: string) =>
    panelPost<{ items: Array<{ revision_id: string; version: number; edited_by: string; created_at: string }> }>('/revisions', { team_id: teamId, note_id: noteId }),
};

export function noteToMarkdown(note: NoteDetail): string {
  const fm = [
    '---',
    `title: ${JSON.stringify(note.title)}`,
    `tags: [${note.tags.map((t) => JSON.stringify(t.tag_label)).join(', ')}]`,
    `version: ${note.version}`,
    `created_at: ${note.created_at}`,
    `updated_at: ${note.updated_at}`,
    '---',
  ].join('\n');
  return `${fm}\n\n${note.content}\n`;
}

export function downloadNote(note: NoteDetail): void {
  const content = noteToMarkdown(note);
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = note.filename || `${note.title || 'note'}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function formatNotesError(err: unknown): string {
  return err instanceof NotesApiError ? err.message : err instanceof Error ? err.message : 'Notes request failed';
}
