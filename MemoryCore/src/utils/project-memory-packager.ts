/**
 * Code Memory v2 — project memory packager (L2.5) and L3 index generator.
 *
 * Storage layout (relative to a team+agent scoped data directory):
 *   project/MEMORY.md          L3 index, generated deterministically by code
 *   project/topics/*.md        L2 experience files, written by LLM via file tools
 *   project/.packager-state.json
 *
 * The LLM is sandboxed to project/topics/ and can never write MEMORY.md.
 * MEMORY.md is always rebuilt by `writeProjectMemoryIndex()`.
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ProjectMemoryConfig } from "../config.js";
import type { LLMRunner, Logger } from "../core/types.js";
import type { IMemoryStore, L1RecordRow } from "../core/store/types.js";
import type { StorageAdapter } from "../core/storage/adapter.js";
import {
  formatProjectPackagerPrompt,
  getProjectPackagerSystemPrompt,
} from "../core/prompts/code-v2/l2-project-packager.js";

const TAG = "[memory-tdai][project-memory]";

export const PROJECT_INDEX_KEY = "project/MEMORY.md";
export const PROJECT_TOPICS_PREFIX = "project/topics/";
export const PROJECT_STATE_KEY = "project/.packager-state.json";

export type ProjectTopicType = "work_method" | "work_fact" | "decision" | "pitfall";
const VALID_TOPIC_TYPES = new Set<ProjectTopicType>(["work_method", "work_fact", "decision", "pitfall"]);

export interface ProjectTopicFrontmatter {
  type: ProjectTopicType;
  title: string;
  tags: string[];
  sources: string[];
  updated?: string;
}

export interface ProjectTopicMeta {
  /** Index-relative path, e.g. topics/mysql-timeout.md */
  path: string;
  name: string;
  type: ProjectTopicType;
  title: string;
  tags: string[];
  sources: string[];
  updated?: string;
  summary?: string;
  size: number;
}

export interface ProjectTopicFile extends ProjectTopicMeta {
  content: string;
}

export interface ProjectMemorySearchHit {
  path: string;
  title: string;
  type: string;
  tags: string[];
  summary?: string;
  snippet?: string;
  score: number;
}

export interface ProjectPackagerState {
  lastRunAt: number;
  /** ISO updated_time of the newest L1 record included in the last successful run. */
  lastL1UpdatedAt?: string;
  lastIndexHash?: string;
}

export interface RunProjectMemoryPackagerParams {
  /** Team+agent scoped data directory (already scoped by the caller). */
  dataDir: string;
  /** Team+agent scoped storage adapter (already scoped by the caller). */
  storage?: StorageAdapter;
  cfg: ProjectMemoryConfig;
  /** Vector store used to read new L1 atoms since the last run. */
  store?: IMemoryStore;
  /** Tool-enabled LLM runner (read/write/edit sandbox). */
  llmRunner?: LLMRunner;
  teamId: string;
  agentId: string;
  logger?: Logger;
  now?: () => number;
}

export interface RunProjectMemoryPackagerResult {
  ran: boolean;
  reason: string;
  l1RecordCount: number;
  topicCount: number;
  indexHash?: string;
}

// ============================
// Basic storage helpers
// ============================

async function readText(dataDir: string, storage: StorageAdapter | undefined, key: string): Promise<string | null> {
  if (storage) return storage.readFile(key);
  try {
    return await fs.readFile(path.join(dataDir, key), "utf-8");
  } catch {
    return null;
  }
}

async function writeText(dataDir: string, storage: StorageAdapter | undefined, key: string, content: string): Promise<void> {
  if (storage) {
    await storage.writeFile(key, content);
    return;
  }
  const target = path.join(dataDir, key);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf-8");
}

async function ensureTopicsDir(dataDir: string, storage?: StorageAdapter): Promise<void> {
  if (storage) return; // object storage has implicit directories
  await fs.mkdir(path.join(dataDir, "project", "topics"), { recursive: true });
}

async function deleteTopicFile(dataDir: string, storage: StorageAdapter | undefined, key: string): Promise<void> {
  if (storage) {
    await storage.unlink(key);
    return;
  }
  await fs.unlink(path.join(dataDir, key));
}

async function listTopicNames(dataDir: string, storage?: StorageAdapter): Promise<string[]> {
  if (storage) {
    try {
      const names = await storage.readdirNames(PROJECT_TOPICS_PREFIX, ".md");
      return names.filter((n) => n && !n.startsWith(".")).sort();
    } catch (err) {
      return [];
    }
  }
  const dir = path.join(dataDir, "project", "topics");
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".md") && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

function safeTopicName(name: string): string {
  const trimmed = name.trim().replace(/\\/g, "/");
  if (!trimmed || trimmed.includes("/") || trimmed.includes("..") || trimmed.includes("\0")) return "";
  const base = trimmed.endsWith(".md") ? trimmed : `${trimmed}.md`;
  if (base === ".md" || base.length > 120) return "";
  // Only block generic dump-file names. A concrete topic such as
  // `summary-tips-memory-workflow.md` is a valid project topic.
  if (/^(batch|report|chatlog|summary)\.md$/i.test(base)) return "";
  return base;
}

/**
 * Recursively collect .md files below project/topics (local filesystem only).
 * Returns absolute file paths.
 */
async function collectLocalTopicFiles(topicsDir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await fs.readdir(topicsDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(topicsDir, entry.name);
    if (entry.isDirectory()) {
      out.push(...await collectLocalTopicFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".md") && !entry.name.startsWith(".")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Flatten `project/topics/<dir>/<name>.md` back to `project/topics/<name>.md`.
 *
 * The packager prompt tells the LLM to write flat filenames, but some models
 * still write `topics/<name>.md` because the index lists paths with the
 * `topics/` prefix. Such nested files are invisible to the flat listing and
 * therefore never reach MEMORY.md or the panel. This repair is idempotent:
 * when both a flat and a nested file exist, the newer file wins.
 */
async function flattenNestedTopicLayout(dataDir: string, storage?: StorageAdapter, logger?: Logger): Promise<void> {
  if (storage) {
    let entries;
    try {
      const result = await storage.getBackend().listObjects(PROJECT_TOPICS_PREFIX, {
        recursive: true,
        maxKeys: 10000,
      });
      entries = result.entries;
    } catch {
      return;
    }
    const files = entries.filter((e) => !e.isDirectory && e.key.endsWith(".md") && !e.key.includes("/."));
    const byKey = new Map(files.map((e) => [e.key, e]));
    for (const source of files) {
      const name = source.key.startsWith(PROJECT_TOPICS_PREFIX)
        ? source.key.slice(PROJECT_TOPICS_PREFIX.length)
        : source.key;
      const base = name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name;
      if (name === base) continue;
      if (!safeTopicName(base)) {
        logger?.warn?.(`${TAG} Ignoring invalid nested topic path ${PROJECT_TOPICS_PREFIX}${name}`);
        continue;
      }

      const targetKey = `${PROJECT_TOPICS_PREFIX}${base}`;
      const target = byKey.get(targetKey);
      try {
        if (target && target.lastModified.getTime() > source.lastModified.getTime()) {
          await storage.unlink(source.key);
          logger?.warn?.(`${TAG} Removed stale nested topic ${source.key}`);
        } else {
          await storage.rename(source.key, targetKey);
          byKey.delete(source.key);
          byKey.set(targetKey, { ...source, key: targetKey });
          logger?.warn?.(`${TAG} Flattened nested topic ${source.key} → ${targetKey}`);
        }
      } catch (err) {
        logger?.warn?.(
          `${TAG} Failed to flatten nested topic ${source.key}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return;
  }

  const root = path.join(dataDir, "project", "topics");
  const files = await collectLocalTopicFiles(root);
  for (const source of files) {
    const relative = path.relative(root, source);
    const base = path.basename(relative);
    if (relative === base) continue;
    if (!safeTopicName(base)) {
      logger?.warn?.(`${TAG} Ignoring invalid nested topic path project/topics/${relative.split(path.sep).join("/")}`);
      continue;
    }

    const target = path.join(root, base);
    try {
      const [sourceStat, targetStat] = await Promise.all([
        fs.stat(source),
        fs.stat(target).catch(() => null),
      ]);
      if (targetStat && targetStat.mtimeMs > sourceStat.mtimeMs) {
        // The flat file is strictly newer: drop the stale nested copy.
        // Equal-mtime duplicates prefer the nested file, matching the
        // observed LLM pattern of rewriting an existing topic below topics/.
        await fs.unlink(source);
        logger?.warn?.(`${TAG} Removed stale nested topic project/topics/${relative.split(path.sep).join("/")}`);
      } else {
        await fs.rename(source, target);
        logger?.warn?.(
          `${TAG} Flattened nested topic project/topics/${relative.split(path.sep).join("/")} → project/topics/${base}`,
        );
      }
    } catch (err) {
      logger?.warn?.(
        `${TAG} Failed to flatten nested topic project/topics/${relative.split(path.sep).join("/")}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

// ============================
// Frontmatter
// ============================

function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } | null {
  const normalized = content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return null;
  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0) return null;
  const fmText = normalized.slice(4, end);
  const body = normalized.slice(end + 5);
  const frontmatter: Record<string, string> = {};
  for (const rawLine of fmText.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    frontmatter[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { frontmatter, body };
}

function parseStringArray(raw: string | undefined): string[] {
  if (!raw) return [];
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "[]") return [];
  const inner = trimmed.startsWith("[") && trimmed.endsWith("]")
    ? trimmed.slice(1, -1).trim()
    : trimmed;
  if (!inner) return [];
  return inner
    .split(",")
    .map((item) => {
      const text = item.trim().replace(/^["']|["']$/g, "");
      if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
        try {
          const parsed = JSON.parse(text);
          return typeof parsed === "string" ? parsed : text;
        } catch {
          return text;
        }
      }
      return text;
    })
    .filter(Boolean);
}

function toTopicType(raw: string | undefined): ProjectTopicType | null {
  if (!raw) return null;
  const value = raw.trim().toLowerCase();
  return VALID_TOPIC_TYPES.has(value as ProjectTopicType) ? (value as ProjectTopicType) : null;
}

function firstSummary(body: string): string | undefined {
  const line = body
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("#") && !l.startsWith("<!--"));
  if (!line) return undefined;
  const clean = line.replace(/^[-*]\s*/, "");
  return clean.length > 160 ? `${clean.slice(0, 160)}…` : clean;
}

export function parseProjectTopic(name: string, content: string): ProjectTopicFile | null {
  const parsed = parseFrontmatter(content);
  if (!parsed) return null;
  const type = toTopicType(parsed.frontmatter.type);
  const title = (parsed.frontmatter.title ?? "").trim();
  if (!type || !title) return null;
  const tags = parseStringArray(parsed.frontmatter.tags);
  const sources = parseStringArray(parsed.frontmatter.sources);
  const updated = parsed.frontmatter.updated?.trim();
  return {
    path: `topics/${name}`,
    name,
    type,
    title,
    tags,
    sources,
    updated,
    summary: firstSummary(parsed.body),
    size: content.length,
    content,
  };
}

function latestTopicUpdated(topics: ProjectTopicFile[]): string | undefined {
  return topics
    .map((t) => t.updated)
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .sort()
    .at(-1);
}

export function enforceTopicMaxChars(topic: ProjectTopicFile, maxChars: number): ProjectTopicFile {
  if (topic.content.length <= maxChars) return topic;
  const parsed = parseFrontmatter(topic.content);
  if (!parsed) return { ...topic, content: topic.content.slice(0, maxChars), size: maxChars };
  const headerEnd = topic.content.indexOf("\n---\n", 4);
  if (headerEnd < 0) return { ...topic, content: topic.content.slice(0, maxChars), size: maxChars };
  const header = topic.content.slice(0, headerEnd + 5);
  if (header.length >= maxChars) return { ...topic, content: header.slice(0, maxChars), size: maxChars };
  const bodyBudget = maxChars - header.length;
  const body = parsed.body;
  const trimmedBody = bodyBudget >= 160
    ? `${body.slice(0, bodyBudget - 40)}\n\n<!-- truncated by topicMaxChars -->\n`
    : body.slice(0, bodyBudget);
  const content = `${header}${trimmedBody}`;
  return { ...topic, content, size: content.length };
}

// ============================
// List / read / search
// ============================

export async function loadProjectTopics(dataDir: string, storage?: StorageAdapter): Promise<ProjectTopicFile[]> {
  await flattenNestedTopicLayout(dataDir, storage);
  const names = await listTopicNames(dataDir, storage);
  const out: ProjectTopicFile[] = [];
  for (const name of names) {
    const safe = safeTopicName(name);
    if (!safe) continue;
    const key = `${PROJECT_TOPICS_PREFIX}${safe}`;
    const content = await readText(dataDir, storage, key);
    if (content === null) continue;
    if (content.trim() === "[DELETED]") {
      try {
        await deleteTopicFile(dataDir, storage, key);
      } catch {
        // The marker is the source of truth; a stale file will be retried later.
      }
      continue;
    }
    const topic = parseProjectTopic(safe, content);
    if (topic) out.push(topic);
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export async function listProjectTopics(
  dataDir: string,
  storage?: StorageAdapter,
  indexMaxChars = 6000,
): Promise<ProjectTopicMeta[]> {
  const topics = await loadProjectTopics(dataDir, storage);
  const indexHash = computeProjectTopicsHash(topics);
  const currentIndex = await readProjectMemoryIndex(dataDir, storage);
  const currentHash = /hash: ([a-f0-9]{8,})/.exec(currentIndex)?.[1];
  if (currentHash !== indexHash) {
    const latestUpdated = latestTopicUpdated(topics);
    const index = generateProjectMemoryIndex(topics, {
      indexMaxChars,
      now: latestUpdated ? new Date(latestUpdated) : undefined,
    });
    await writeText(dataDir, storage, PROJECT_INDEX_KEY, index);
  }
  return topics.map(({ content: _content, ...meta }) => meta);
}

export async function readProjectTopic(dataDir: string, storage: StorageAdapter | undefined, topicPath: string): Promise<ProjectTopicFile | null> {
  const normalized = topicPath.trim().replace(/\\/g, "/").replace(/^\.?\//, "");
  const relative = normalized.startsWith("topics/") ? normalized.slice("topics/".length) : normalized;
  const name = safeTopicName(relative);
  if (!name) return null;
  const content = await readText(dataDir, storage, `${PROJECT_TOPICS_PREFIX}${name}`);
  if (content === null) return null;
  return parseProjectTopic(name, content);
}

export async function searchProjectTopics(
  dataDir: string,
  storage: StorageAdapter | undefined,
  query: string,
  tags?: string[],
  limit = 20,
): Promise<ProjectMemorySearchHit[]> {
  const q = query.trim().toLowerCase();
  const wanted = new Set((tags ?? []).map((t) => t.toLowerCase()));
  const topics = await loadProjectTopics(dataDir, storage);
  const hits: ProjectMemorySearchHit[] = [];

  for (const topic of topics) {
    if (wanted.size > 0 && !topic.tags.some((t) => wanted.has(t.toLowerCase()))) continue;
    const body = topic.content.toLowerCase();
    let score = 0;
    let snippet: string | undefined;
    if (q) {
      const titleScore = topic.title.toLowerCase().includes(q) ? 3 : 0;
      const tagScore = topic.tags.some((t) => t.toLowerCase().includes(q)) ? 2 : 0;
      const bodyIdx = body.indexOf(q);
      const bodyScore = bodyIdx >= 0 ? 1 : 0;
      score = titleScore + tagScore + bodyScore;
      if (bodyIdx >= 0) {
        const start = Math.max(0, bodyIdx - 80);
        snippet = `${topic.content.slice(start, bodyIdx + q.length + 160).trim()}${bodyIdx > 80 ? "…" : ""}`;
      } else if (titleScore || tagScore) {
        snippet = topic.summary ?? topic.title;
      }
    } else {
      score = 1;
      snippet = topic.summary ?? topic.title;
    }
    if (score > 0) hits.push({ path: topic.path, title: topic.title, type: topic.type, tags: topic.tags, summary: topic.summary, snippet, score });
  }

  return hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, Math.min(Math.max(limit, 1), 50));
}

// ============================
// Index generation
// ============================

export function computeProjectTopicsHash(topics: ProjectTopicFile[]): string {
  const material = topics
    .map((t) => `${t.path}\u0000${t.content}`)
    .sort()
    .join("\u0000");
  return createHash("sha256").update(material, "utf8").digest("hex").slice(0, 16);
}

function renderIndexLine(topic: ProjectTopicFile, includeSummary: boolean): string {
  const tags = topic.tags.length > 0 ? topic.tags.join(", ") : "general";
  return `- ${topic.path} | ${topic.title} | tags: ${tags}${includeSummary && topic.summary ? ` | ${topic.summary}` : ""}`;
}

export function generateProjectMemoryIndex(topics: ProjectTopicFile[], opts: { indexMaxChars: number; now?: Date }): string {
  const now = opts.now ?? new Date();
  const topicsHash = computeProjectTopicsHash(topics);
  const header = `# Project Memory Index\n\n_生成时间（UTC）：${now.toISOString()}_\n\n<!-- generated_at: ${now.toISOString()} hash: ${topicsHash} -->\n`;
  const groups = new Map<string, ProjectTopicFile[]>();
  for (const topic of topics) {
    const tag = topic.tags[0]?.trim() || "general";
    const list = groups.get(tag) ?? [];
    list.push(topic);
    groups.set(tag, list);
  }

  const sectionNames = [...groups.keys()].sort((a, b) => a.localeCompare(b, "zh-CN"));
  let full = header;
  for (const tag of sectionNames) {
    const sectionTopics = [...(groups.get(tag) ?? [])].sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
    full += `\n## ${tag}\n${sectionTopics.map((t) => renderIndexLine(t, true)).join("\n")}\n`;
  }

  if (full.length <= opts.indexMaxChars) return full.trimEnd() + "\n";

  // Degrade: title + tags only, no summaries.
  let compact = header;
  for (const tag of sectionNames) {
    const sectionTopics = [...(groups.get(tag) ?? [])].sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
    compact += `\n## ${tag}\n${sectionTopics.map((t) => renderIndexLine(t, false)).join("\n")}\n`;
  }
  if (compact.length > opts.indexMaxChars) {
    compact = `${header}\n<!-- index truncated to ${opts.indexMaxChars} chars -->\n${compact.slice(header.length, opts.indexMaxChars)}`;
  }
  return compact.trimEnd() + "\n";
}

export async function readProjectMemoryIndex(dataDir: string, storage?: StorageAdapter): Promise<string> {
  return (await readText(dataDir, storage, PROJECT_INDEX_KEY)) ?? "";
}

export async function writeProjectMemoryIndex(dataDir: string, storage: StorageAdapter | undefined, opts: { indexMaxChars: number; now?: Date }): Promise<string> {
  const topics = await loadProjectTopics(dataDir, storage);
  const latestUpdated = latestTopicUpdated(topics);
  const index = generateProjectMemoryIndex(topics, {
    ...opts,
    now: opts.now ?? (latestUpdated ? new Date(latestUpdated) : undefined),
  });
  await writeText(dataDir, storage, PROJECT_INDEX_KEY, index);
  return computeProjectTopicsHash(topics);
}

// ============================
// Packager state
// ============================

async function readState(dataDir: string, storage?: StorageAdapter): Promise<ProjectPackagerState> {
  const raw = await readText(dataDir, storage, PROJECT_STATE_KEY);
  if (!raw) return { lastRunAt: 0 };
  try {
    const parsed = JSON.parse(raw) as Partial<ProjectPackagerState>;
    return {
      lastRunAt: typeof parsed.lastRunAt === "number" && Number.isFinite(parsed.lastRunAt) ? parsed.lastRunAt : 0,
      lastL1UpdatedAt: typeof parsed.lastL1UpdatedAt === "string" ? parsed.lastL1UpdatedAt : undefined,
      lastIndexHash: typeof parsed.lastIndexHash === "string" ? parsed.lastIndexHash : undefined,
    };
  } catch {
    return { lastRunAt: 0 };
  }
}

async function writeState(dataDir: string, storage: StorageAdapter | undefined, state: ProjectPackagerState): Promise<void> {
  await writeText(dataDir, storage, PROJECT_STATE_KEY, JSON.stringify(state, null, 2));
}

// ============================
// New-L1 cursor query
// ============================

/**
 * Query L1 atoms created/updated after the packager cursor.
 *
 * `queryL1Paginated` is inclusive on timeStart, so we query from the cursor
 * then filter strictly by `updated_time > cursor` to avoid re-processing the
 * boundary row on every run. The page size is intentionally generous because
 * the packager aggregates at team+agent level, not per session.
 */
async function queryNewL1Since(
  store: IMemoryStore | undefined,
  teamId: string,
  agentId: string,
  afterUpdatedAtIso?: string,
  limit = 200,
): Promise<L1RecordRow[]> {
  if (!store?.queryL1Paginated) return [];
  try {
    const result = await store.queryL1Paginated({
      teamId,
      agentId,
      limit,
      offset: 0,
      ...(afterUpdatedAtIso ? { timeStart: afterUpdatedAtIso } : {}),
    });
    return result.rows.filter((row) => !afterUpdatedAtIso || row.updated_time > afterUpdatedAtIso);
  } catch {
    return [];
  }
}

function maxUpdatedTime(rows: L1RecordRow[]): string | undefined {
  return rows
    .map((row) => row.updated_time)
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .sort()
    .at(-1);
}

// ============================
// Packager orchestration
// ============================

export async function runProjectMemoryPackager(params: RunProjectMemoryPackagerParams): Promise<RunProjectMemoryPackagerResult> {
  const {
    dataDir,
    storage,
    cfg,
    store,
    llmRunner,
    teamId,
    agentId,
    logger,
    now = () => Date.now(),
  } = params;

  const reason = (ran: boolean, text: string, extra: Partial<RunProjectMemoryPackagerResult> = {}): RunProjectMemoryPackagerResult => ({
    ran,
    reason: text,
    l1RecordCount: 0,
    topicCount: 0,
    ...extra,
  });

  if (!cfg.enabled) return reason(false, "projectMemory.enabled=false");
  if (!llmRunner) return reason(false, "no tool-enabled LLM runner available");

  const state = await readState(dataDir, storage);
  const nowMs = now();
  const elapsedMs = state.lastRunAt > 0 ? nowMs - state.lastRunAt : Number.POSITIVE_INFINITY;

  if (state.lastRunAt > 0 && elapsedMs < cfg.packagerMinIntervalSeconds * 1000) {
    return reason(false, `min interval not reached (${Math.floor(elapsedMs / 1000)}s < ${cfg.packagerMinIntervalSeconds}s)`);
  }

  const l1Records = await queryNewL1Since(store, teamId, agentId, state.lastL1UpdatedAt);
  if (l1Records.length === 0) return reason(false, "no new L1 records");

  logger?.info?.(
    `${TAG} Packager ready team=${teamId} agent=${agentId} newL1=${l1Records.length} trigger=new-l1`,
  );

  let topics: ProjectTopicFile[] = [];
  try {
    topics = await loadProjectTopics(dataDir, storage);
  } catch (err) {
    logger?.warn?.(`${TAG} Failed to load existing topics: ${err instanceof Error ? err.message : String(err)}`);
  }
  const currentIndex = (await readText(dataDir, storage, PROJECT_INDEX_KEY)) ?? "";

  const prompt = formatProjectPackagerPrompt({
    currentIndex,
    topicMetas: topics.map(({ content: _c, ...meta }) => meta),
    l1Records,
    topicMaxChars: cfg.topicMaxChars,
    maxTopics: cfg.maxTopics,
  });

  try {
    await ensureTopicsDir(dataDir, storage);
    if (storage) {
      await llmRunner.run({
        prompt,
        systemPrompt: getProjectPackagerSystemPrompt(cfg.topicMaxChars, cfg.maxTopics),
        taskId: "project-memory-packager",
        timeoutMs: 300_000,
        enableTools: true,
        storage,
        storagePrefix: PROJECT_TOPICS_PREFIX,
        traceName: "memory.project-packager",
        tags: ["memory", `team:${teamId}`, `agent:${agentId}`],
      });
    } else {
      const workspaceDir = path.join(dataDir, "project", "topics");
      await fs.mkdir(workspaceDir, { recursive: true });
      await llmRunner.run({
        prompt,
        systemPrompt: getProjectPackagerSystemPrompt(cfg.topicMaxChars, cfg.maxTopics),
        taskId: "project-memory-packager",
        timeoutMs: 300_000,
        enableTools: true,
        workspaceDir,
        traceName: "memory.project-packager",
        tags: ["memory", `team:${teamId}`, `agent:${agentId}`],
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger?.error?.(`${TAG} LLM packaging failed: ${message}`);
    return reason(false, `LLM packaging failed: ${message}`, { l1RecordCount: l1Records.length });
  }

  // Validate/enforce constraints written by the model.
  const refreshed = await loadProjectTopics(dataDir, storage);
  const valid: ProjectTopicFile[] = [];
  for (const topic of refreshed) {
    const enforced = enforceTopicMaxChars(topic, cfg.topicMaxChars);
    if (enforced.content !== topic.content) {
      await writeText(dataDir, storage, `${PROJECT_TOPICS_PREFIX}${topic.name}`, enforced.content);
      logger?.warn?.(`${TAG} Truncated topic ${topic.path} to ${cfg.topicMaxChars} chars`);
    }
    valid.push(enforced);
  }

  // Deterministic L3 index. LLM cannot write this key because its sandbox is topics/.
  let indexHash: string;
  try {
    const index = generateProjectMemoryIndex(valid, { indexMaxChars: cfg.indexMaxChars, now: new Date(nowMs) });
    await writeText(dataDir, storage, PROJECT_INDEX_KEY, index);
    indexHash = computeProjectTopicsHash(valid);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger?.error?.(`${TAG} Index generation failed: ${message}`);
    return reason(false, `index generation failed: ${message}`, { l1RecordCount: l1Records.length, topicCount: valid.length });
  }

  const nextCursor = maxUpdatedTime(l1Records) ?? state.lastL1UpdatedAt;
  await writeState(dataDir, storage, { lastRunAt: nowMs, lastL1UpdatedAt: nextCursor, lastIndexHash: indexHash });
  logger?.info?.(
    `${TAG} Packaging complete team=${teamId} agent=${agentId} topics=${valid.length} l1Processed=${l1Records.length} indexHash=${indexHash}`,
  );

  return reason(true, "ok", {
    l1RecordCount: l1Records.length,
    topicCount: valid.length,
    indexHash,
  });
}
