/**
 * Proxy-side per-request/per-session memory capture mode.
 *
 * Header: `x-tdai-memory-mode: chat | code | all | none`
 * Priority: request header > frozen session mode > config.tdai.memory.promptMode.
 */
export type MemoryCaptureMode = "chat" | "code" | "all" | "none";

export const MEMORY_MODE_HEADER = "x-tdai-memory-mode";

export function normalizeMemoryCaptureMode(value: unknown): MemoryCaptureMode | null {
  if (value === "chat" || value === "code" || value === "all" || value === "none") return value;
  return null;
}

export function readRequestMemoryMode(c: { req: { header(name: string): string | undefined } }): MemoryCaptureMode | null {
  return normalizeMemoryCaptureMode(c.req.header(MEMORY_MODE_HEADER)?.trim().toLowerCase());
}

export function resolveEffectiveMemoryMode(
  requestMode: MemoryCaptureMode | null,
  sessionMode: unknown,
  fallback: "chat" | "code" | "all" | "none",
): MemoryCaptureMode {
  // Session freeze semantics: once a session carries a mode, later request
  // headers are ignored. Otherwise the first request header wins, then config.
  const frozen = normalizeMemoryCaptureMode(sessionMode);
  if (frozen) return frozen;
  if (requestMode) return requestMode;
  return fallback;
}

/** Whether this mode should write L0 or inject tdai memory at all. */
export function isMemoryModeActive(mode: MemoryCaptureMode): boolean {
  return mode !== "none";
}
