/**
 * Note Tools Injector — injects static <note_tools> curl recipes for the
 * Team Notes bridge. Session-static, so it does not disturb prompt cache.
 */

import type {
  AgentContext,
  AnchorTarget,
  CacheStrategy,
  ContextBlock,
  HookPriority,
  InjectionHook,
  PrewarmInput,
} from "../types.js";
import { HOOK_PRIORITY } from "../types.js";

export interface NoteToolsInjectorConfig {
  proxyBaseUrl: string;
  allowLlmWrite?: boolean;
}

export function renderNoteToolsBlock(proxyBaseUrl: string, allowLlmWrite = false, sessionId?: string, spaceId?: string): string {
  const base = proxyBaseUrl.replace(/\/$/, "");
  const bridge = `${base}/notes-bridge/v3/notes`;
  const sessionHeader = sessionId ? ` -H 'x-conversation-id: ${sessionId}'` : "";
  const tenantHeader = spaceId ? ` -H 'x-tdai-service-id: ${spaceId}'` : "";
  const authHeader = `${tenantHeader}${sessionHeader}`;

  const lines = [
    "<note_tools>",
    "## 功能定位",
    "Team Notes 是团队共享的 Markdown 文档库，用来保存团队级知识、纪要、方案。",
    "它和“任务总结 memory”不是一回事：刚完成任务要沉淀成记忆时，按 <summary_tips_contract> 提交 summary_tips；",
    "用户要写团队共享文档/纪要时，才用这里的 note_* 工具。",
    "",
    "## 调用方式",
    "以下是 Team Notes 操作工具。这些不是本地工具，必须用 Bash + curl 调用。",
    "proxy 会自动注入 team_id/user_id/agent_id，body 中不需要传这些字段。",
    "创建/更新笔记时，中文内容不要用 Windows Git Bash 的 `curl -d` 直接内联；先用 Write 工具把 JSON 写到 UTF-8 文件，再用 `--data-binary @文件路径` 发送。",
    "完成后用 note_get 回读校验，发现乱码先用 note_delete 删除后重新创建。",
    "",
    "调用模板：",
    `  curl -sSk -X POST <bridge>/<action> -H 'content-type: application/json'${authHeader} --data-binary @note_payload.json`,
    `  其中 <bridge> = ${bridge}`,
    "",
    "可用工具：",
    `  <tool name="note_search">`,
    `    path: ${bridge}/search`,
    `    body: {"query": "关键词", "tags": ["可选标签"]}`,
    `    use:  搜索团队笔记标题和正文。用户给标签时优先用 note_list 或 note_tags_pages。`,
    `  </tool>`,
    "",
    `  <tool name="note_list">`,
    `    path: ${bridge}/list`,
    `    body: {"tags": ["可选标签"]}`,
    `    use:  列出团队共享笔记摘要（不含正文）。`,
    `  </tool>`,
    "",
    `  <tool name="note_get">`,
    `    path: ${bridge}/get`,
    `    body: {"note_id": "note-xxx"}`,
    `    use:  按 note_id 读取单篇笔记完整 Markdown 正文。`,
    `  </tool>`,
    "",
    `  <tool name="note_tags_list">`,
    `    path: ${bridge}/tags/list`,
    `    body: {}`,
    `    use:  查看当前团队现在有哪些标签。用户问“有哪些标签/分类”时，先调用这个接口获取全部标签，再按标签查笔记。`,
    `  </tool>`,
    "",
    `  <tool name="note_tags_pages">`,
    `    path: ${bridge}/tags/pages`,
    `    body: {"tag_slug": "部署"}`,
    `    use:  按标签拉取所有相关笔记摘要；随后按需 note_get 读正文。`,
    `  </tool>`,
    "",
  ];

  if (allowLlmWrite) {
    lines.push(
      `  <tool name="note_create">`,
      `    path: ${bridge}/create`,
      `    body: {"title": "标题", "content": "Markdown 正文", "tags": ["标签"]}`,
      `    use:  在团队共享笔记中新建一篇 Markdown 文档。`,
      `  </tool>`,
      "",
      `  <tool name="note_update">`,
      `    path: ${bridge}/update`,
      `    body: {"note_id": "note-xxx", "expected_version": 1, "title": "新标题", "content": "新正文", "tags": ["新标签"]}`,
      `    use:  更新已有笔记，需要当前 version。`,
      `  </tool>`,
      "",
      `  <tool name="note_delete">`,
      `    path: ${bridge}/delete`,
      `    body: {"note_id": "note-xxx", "expected_version": 1}`,
      `    use:  删除（归档）一篇笔记。发现乱码或误创建时，用 note_get 确认 note_id 后删除重建。`,
      `  </tool>`,
      "",
    );
  }

  lines.push(
    "",
    "错误处理：响应统一为 `{code, message, request_id, data?}`；`code != 0` 表示业务错误。",
    allowLlmWrite ? "" : "当前仅开放只读操作；如需新建/编辑笔记请联系管理员。",
    "</note_tools>",
  );
  return lines.join("\n");
}

export class NoteToolsInjector implements InjectionHook {
  id = "note-tools-injector";
  point = "system.before_tools" as const;
  anchor: AnchorTarget = { slot: "knowledge", relation: "before" };
  priority: HookPriority = HOOK_PRIORITY.WIKI - 1;
  description = "Inject the static <note_tools> curl-recipe block.";
  cacheStrategy: CacheStrategy = "session_init";

  constructor(private config: NoteToolsInjectorConfig) {}

  async execute(ctx: AgentContext): Promise<ContextBlock[]> {
    return this.renderBlocks(ctx);
  }

  async prewarm(input: PrewarmInput): Promise<ContextBlock[]> {
    return this.renderBlocks(undefined, input.sessionInfo.session_id, input.sessionInfo.space_id);
  }

  private renderBlocks(ctx?: AgentContext, prewarmSessionId?: string, prewarmSpaceId?: string): ContextBlock[] {
    let sessionId = prewarmSessionId;
    let spaceId = prewarmSpaceId;
    if (ctx) {
      const custom = ctx.metadata.custom as Record<string, unknown> | undefined;
      const session = custom?.session as Record<string, unknown> | undefined;
      if (typeof session?.session_id === "string") sessionId = session.session_id;
      if (typeof session?.space_id === "string") spaceId = session.space_id;
    }
    const content = renderNoteToolsBlock(
      this.config.proxyBaseUrl,
      this.config.allowLlmWrite ?? false,
      sessionId,
      spaceId,
    );
    return [{
      type: "text",
      content,
      metadata: {
        source: this.id,
        cacheKey: `note-tools-injector:catalog:${this.config.allowLlmWrite ? "rw" : "ro"}`,
      },
    }];
  }
}
