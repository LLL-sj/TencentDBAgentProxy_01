/**
 * Per-request coarse-grained stage timing utilities.
 *
 * This intentionally records whole phases only — never per token/chunk.
 * It exists to answer:
 *   - how long is upstream/model time?
 *   - how long is proxy local time?
 *   - how long is the server-to-client send tail?
 */

import type { Context } from "hono";
import type { ProxyConfig } from "./types.js";
import type { RequestStageTimingRow } from "./clickhouse.js";
import { toChTimestamp, writeRequestTiming } from "./clickhouse.js";
import { log } from "./report/log.js";

export type Timeline = Record<string, number>;

export const TIMING_KEYS = {
  received: "t0",
  localPrepareDone: "t1",
  buildDone: "t2",
  upstreamFirstResponse: "t3",
  upstreamEnd: "t4",
  proxyResponseEnd: "t5",
  clientFinish: "t6",
  postprocessDone: "t7",
} as const;

export function markTime(timeline: Timeline, name: string, at: number = Date.now()): number {
  timeline[name] = at;
  return at;
}

export function durationMs(timeline: Timeline, from: string, to: string): number {
  const a = timeline[from];
  const b = timeline[to];
  if (typeof a !== "number" || typeof b !== "number") return 0;
  return Math.max(0, Math.round(b - a));
}

export interface TimingMeta {
  requestId: string;
  model: string;
  protocol: string;
  sessionKey: string;
  stream: boolean;
  timestamp: string;
}

/**
 * Build one ClickHouse row from the timeline.
 * Missing marks are treated as 0 (only emit when enough marks exist).
 */
export function buildRequestTimingRow(
  timeline: Timeline,
  meta: TimingMeta,
): RequestStageTimingRow | null {
  const total = durationMs(timeline, "t0", "t6");
  if (timeline.t0 === undefined || timeline.t6 === undefined) return null;

  return {
    timestamp: toChTimestamp(meta.timestamp),
    request_id: meta.requestId,
    model: meta.model,
    protocol: meta.protocol,
    session_key: meta.sessionKey,
    stream: meta.stream ? 1 : 0,
    total_ms: total,
    local_prepare_ms: durationMs(timeline, "t0", "t1"),
    build_request_ms: durationMs(timeline, "t1", "t2"),
    upstream_ttfb_ms: durationMs(timeline, "t2", "t3"),
    upstream_stream_ms: durationMs(timeline, "t3", "t4"),
    proxy_tail_ms: durationMs(timeline, "t4", "t5"),
    client_network_tail_ms: durationMs(timeline, "t5", "t6"),
    postprocess_ms: durationMs(timeline, "t6", "t7"),
  };
}

/** Log a single request timing to structured logs, then enqueue to ClickHouse. */
export function emitRequestTiming(
  config: ProxyConfig,
  timeline: Timeline,
  meta: TimingMeta,
): void {
  const row = buildRequestTimingRow(timeline, meta);
  if (!row) return;

  log.info("request.timing", {
    requestId: row.request_id,
    model: row.model,
    protocol: row.protocol,
    stream: row.stream,
    totalMs: row.total_ms,
    localPrepareMs: row.local_prepare_ms,
    buildRequestMs: row.build_request_ms,
    upstreamTtfbMs: row.upstream_ttfb_ms,
    upstreamStreamMs: row.upstream_stream_ms,
    proxyTailMs: row.proxy_tail_ms,
    clientNetworkTailMs: row.client_network_tail_ms,
    postprocessMs: row.postprocess_ms,
  });

  writeRequestTiming(row);
}

/**
 * Attach a Node ServerResponse "finish" listener.
 *
 * This is the closest server-side measurement for "server → user network send".
 * `finish` fires after data has been handed to the kernel/system TCP buffer.
 */
export function attachClientFinishTiming(
  c: Context,
  timeline: Timeline,
  config: ProxyConfig,
  meta: TimingMeta,
): void {
  try {
    const env = c.env as { outgoing?: { once?: (event: string, cb: () => void) => unknown } };
    const outgoing = env?.outgoing;
    if (!outgoing || typeof outgoing.once !== "function") return;

    outgoing.once("finish", () => {
      markTime(timeline, "t6");
      emitRequestTiming(config, timeline, meta);
    });
  } catch {
    // Never let observability wiring break request handling.
  }
}
