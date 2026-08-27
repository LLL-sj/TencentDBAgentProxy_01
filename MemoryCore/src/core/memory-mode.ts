/**
 * Per-session memory capture mode.
 *
 * This is intentionally broader than `MemoryPromptMode` (chat | code):
 *   - chat: L0 写入 + chat 提示词抽取/注入
 *   - code: L0 写入 + code 提示词抽取/注入（v2 时含 L0.5/L2.5 project）
 *   - all:  L0 只写一份，L1 同时跑 chat + code 两条链路（仅 codeMemoryVersion=v2）
 *   - none: 不写 L0，不注入 tdai memory 上下文
 *
 * Config `memory.promptMode` remains the chat/code global fallback; this type
 * is carried per-session in pipeline state and per-request from the proxy.
 */
export type MemoryCaptureMode = "chat" | "code" | "all" | "none";

export const MEMORY_CAPTURE_MODES: readonly MemoryCaptureMode[] = ["chat", "code", "all", "none"];

export function normalizeMemoryCaptureMode(value: unknown, fallback: MemoryCaptureMode = "chat"): MemoryCaptureMode {
  if (value === "chat" || value === "code" || value === "all" || value === "none") return value;
  return fallback;
}

/** Expand a capture mode into the prompt modes that should run against one L0 batch. */
export function expandMemoryCaptureModes(
  mode: MemoryCaptureMode,
  codeMemoryVersion: "v1" | "v2",
): Array<"chat" | "code"> {
  if (mode === "none") return [];
  if (mode === "chat") return ["chat"];
  if (mode === "code") return ["code"];
  // v1 has a single scene/persona file set for chat and code; dual-write would
  // conflict. Callers should reject `all` in v1 before reaching this helper.
  return codeMemoryVersion === "v2" ? ["chat", "code"] : ["code"];
}
