#!/usr/bin/env node
/**
 * Lightweight MemoryProxy JSONL usage/timing statistics parser.
 *
 * Run inside the proxy container or on any machine with Node.js:
 *
 *   node scripts/query_usage_stats.mjs /data/tdai-memory-proxy/logs
 *   node scripts/query_usage_stats.mjs proxy.log 2026-09-07.jsonl
 *
 * The parser understands:
 *   - New FileLogger JSONL lines:
 *       {"timestamp":"...","level":"INFO","event":"request.timing","data":{...}}
 *   - Daily usage JSONL from logger.ts:
 *       {"timestamp":"...","event":"usage","usage":{...},"modelId":"..."}
 *   - Old proxy.log prefix-text lines:
 *       [2026-09-07T...][INFO] request.timing {...}
 */

import fs from "node:fs";
import path from "node:path";

const OLD_LOG_RE = /^\[[^\]]*\]\[[A-Z]+\]\s+(\S+)\s*(\{.*\})\s*$/;

function collectFiles(inputPaths) {
  const files = [];
  for (const p of inputPaths) {
    const st = fs.statSync(p, { throwIfNoEntry: false });
    if (!st) continue;
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(p).sort()) {
        const full = path.join(p, name);
        const child = fs.statSync(full);
        if (child.isFile() && (name.endsWith(".log") || name.endsWith(".jsonl") || name.includes(".log.") || name.includes(".jsonl."))) {
          files.push(full);
        }
      }
    } else if (st.isFile()) {
      files.push(p);
    }
  }
  return files;
}

function parseLine(raw) {
  const line = raw.trim();
  if (!line) return { event: null, data: null };

  try {
    const obj = JSON.parse(line);
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { event: null, data: null };
    if (typeof obj.event === "string") {
      const data = obj.data && typeof obj.data === "object" ? obj.data : {};
      return { event: obj.event, data };
    }
    return { event: null, data: obj };
  } catch {
    const m = OLD_LOG_RE.exec(line);
    if (!m) return { event: null, data: null };
    try {
      return { event: m[1], data: JSON.parse(m[2]) };
    } catch {
      return { event: null, data: null };
    }
  }
}

function extractTokens(usage) {
  if (!usage || typeof usage !== "object") return null;
  const n = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const prompt = usage.prompt_tokens ?? (n(usage.input_tokens) + n(usage.prompt_cache_hit_tokens) + n(usage.prompt_cache_write_tokens));
  const completion = usage.completion_tokens ?? usage.output_tokens;
  const total = usage.total_tokens ?? (n(prompt) + n(completion));
  return {
    prompt_tokens: n(prompt),
    completion_tokens: n(completion),
    total_tokens: n(total),
  };
}

function parseUsageRecords(lines) {
  const rows = [];
  for (const line of lines) {
    if (!line.event) continue;
    if (!["usage", "analyzer_usage"].includes(line.event)) continue;
    if (!line.raw || typeof line.raw !== "object") continue;
    const usage = line.raw.usage;
    const tokens = extractTokens(usage);
    if (!tokens) continue;
    rows.push({
      model: line.raw.modelId || "unknown",
      sessionKey: line.raw.sessionKey || "",
      keyId: line.raw.keyId || "",
      ...tokens,
    });
  }
  return rows;
}

function parseTimingRecords(lines) {
  const rows = [];
  for (const line of lines) {
    if (!line.event) continue;
    if (line.event !== "request.timing") continue;
    const d = line.data;
    const total = d.totalMs ?? d.total_ms;
    if (typeof total !== "number") continue;
    rows.push({
      model: d.model || "unknown",
      protocol: d.protocol || "unknown",
      stream: d.stream ?? null,
      totalMs: Math.round(total || 0),
      ttfbMs: Math.round(d.upstreamTtfbMs ?? d.upstream_ttfb_ms ?? 0),
      streamMs: Math.round(d.upstreamStreamMs ?? d.upstream_stream_ms ?? 0),
    });
  }
  return rows;
}

function pct(sorted, q) {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo));
}

function printUsage(rows) {
  console.log("\n== Token / Usage ==");
  if (rows.length === 0) {
    console.log("(no usage rows found)");
    return;
  }
  const totalTokens = rows.reduce((s, r) => s + r.total_tokens, 0);
  console.log(`rows=${rows.length} total_tokens=${totalTokens}`);

  const byModel = new Map();
  for (const r of rows) {
    const m = byModel.get(r.model) ?? { rows: 0, total_tokens: 0 };
    m.rows += 1;
    m.total_tokens += r.total_tokens;
    byModel.set(r.model, m);
  }
  const sorted = [...byModel.entries()].sort((a, b) => b[1].rows - a[1].rows);
  console.log("model".padEnd(20), "calls".padStart(6), "tokens".padStart(12));
  for (const [model, m] of sorted) {
    console.log(model.padEnd(20), String(m.rows).padStart(6), String(m.total_tokens).padStart(12));
  }
}

function printTiming(rows) {
  console.log("\n== Timing ==");
  if (rows.length === 0) {
    console.log("(no request.timing rows found)");
    return;
  }
  console.log(`rows=${rows.length}`);

  const groups = new Map();
  for (const r of rows) {
    const key = `${r.model}\u0000${r.protocol}\u0000${r.stream}`;
    const g = groups.get(key) ?? [];
    g.push(r);
    groups.set(key, g);
  }
  console.log(
    "model".padEnd(16),
    "protocol".padEnd(10),
    "stream".padStart(3),
    "requests".padStart(7),
    "p50_total_ms".padStart(13),
    "p90_total_ms".padStart(13),
    "p50_ttfb_ms".padStart(12),
    "p90_ttfb_ms".padStart(12),
  );
  const sorted = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [, group] of sorted) {
    const totals = group.map((r) => r.totalMs).sort((a, b) => a - b);
    const ttfb = group.map((r) => r.ttfbMs).sort((a, b) => a - b);
    const first = group[0];
    console.log(
      String(first.model).padEnd(16),
      String(first.protocol).padEnd(10),
      String(first.stream ?? "").padStart(3),
      String(group.length).padStart(7),
      String(pct(totals, 0.5)).padStart(13),
      String(pct(totals, 0.9)).padStart(13),
      String(pct(ttfb, 0.5)).padStart(12),
      String(pct(ttfb, 0.9)).padStart(12),
    );
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("Usage: node query_usage_stats.mjs <proxy.log|jsonl|log-dir> [...]");
    process.exit(1);
  }

  const files = collectFiles(args);
  if (files.length === 0) {
    console.error("No log files found in the given paths.");
    process.exit(1);
  }

  const lines = [];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const raw of text.split("\n")) {
      const { event, data } = parseLine(raw);
      if (!event) continue;
      const rawObj = raw.startsWith("{") ? JSON.parse(raw) : data;
      lines.push({ event, data, raw: event === "request.timing" ? data : rawObj });
    }
  }

  printUsage(parseUsageRecords(lines));
  printTiming(parseTimingRecords(lines));
}

main();
