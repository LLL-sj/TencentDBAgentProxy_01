/**
 * Strict request-body decoding for Agent-facing write bridges.
 *
 * Agent tools often run inside Windows Git Bash / shell wrappers where inline
 * Chinese text is encoded as GBK or GB18030. Hono's `c.req.text()` would
 * already have replaced invalid bytes with U+FFFD by the time we inspect it,
 * so these helpers read the raw bytes first and decode strictly.
 */

import type { Context } from "hono";

export type StrictRequestBodyResult =
  | { ok: true; text: string }
  | { ok: false; code: 42202 | 42203; httpStatus: 422; message: string };

function decodeWith(encoding: string, bytes: Uint8Array): string | null {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** First 120 Unicode code points, control chars collapsed. */
function previewText(text: string): string {
  const safe = text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(safe).slice(0, 120).join("");
}

/**
 * Decode a request body as strict UTF-8.
 *
 * - Strict UTF-8 success → return the decoded text.
 * - UTF-8 failure but GB18030 success → 42202 (detected GBK/GB18030).
 * - Both fail → 42203 (unrecognized encoding).
 *
 * The server intentionally does NOT transcode-and-store; the Agent must
 * re-send the payload as UTF-8.
 */
export async function readStrictUtf8RequestBody(c: Context, tag: string): Promise<StrictRequestBodyResult> {
  const bytes = Buffer.from(await c.req.arrayBuffer());

  const utf8 = decodeWith("utf-8", bytes);
  if (utf8 !== null) return { ok: true, text: utf8 };

  const gb18030 = decodeWith("gb18030", bytes);
  if (gb18030 !== null) {
    const preview = previewText(gb18030);
    const message = [
      `${tag} 检测到 GBK/GB18030 编码（不是 UTF-8），系统只接受 UTF-8 JSON。`,
      "请先用 Write 工具把 JSON 写成 UTF-8 文件，再用 curl --data-binary @文件 重新提交；",
      "必须重新执行一次并确认返回成功，不得静默放弃。",
      `GB18030 解码预览（前 120 字符）：${preview}`,
    ].join(" ");
    console.warn(`${tag} rejected non-UTF8 request body (GB18030 decode succeeded) preview=${preview}`);
    return { ok: false, code: 42202, httpStatus: 422, message };
  }

  const message = [
    `${tag} 无法识别请求体编码（既不是 UTF-8，也不是 GBK/GB18030），系统只接受 UTF-8 JSON。`,
    "请改为 UTF-8 编码后必须重新执行一次并确认成功，不得静默放弃。",
  ].join(" ");
  console.warn(`${tag} rejected request body with unrecognized encoding`);
  return { ok: false, code: 42203, httpStatus: 422, message };
}
