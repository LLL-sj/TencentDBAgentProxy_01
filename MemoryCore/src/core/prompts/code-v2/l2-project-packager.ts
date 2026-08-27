import type { L1RecordRow } from "../../store/types.js";
import type { ProjectTopicMeta } from "../../../utils/project-memory-packager.js";

export interface ProjectPackagerPromptInput {
  currentIndex: string;
  topicMetas: ProjectTopicMeta[];
  l1Records: L1RecordRow[];
  topicMaxChars: number;
  maxTopics: number;
}

export function getProjectPackagerSystemPrompt(topicMaxChars: number, maxTopics: number): string {
  return `# Project Experience Packager (v2)

你是项目经验文件的维护者，不是聊天记录员。

## 定位
L2 是项目级经验汇总：把多个 session 的 L1 原子记忆合并到项目级 topics。
- 合并同一主题下重复或语义相近的内容；
- tags 只是分类线索，不要求精确相同；内容/主题相似即使 tag 不同也要合并；
- 去重后提取可复用的场景 / 经验；
- 优先更新已有 topics，只有全新主题才新建文件。

## 输出物
只能通过文件工具写项目主题文件。每篇围绕一个可复用主题：
- SOP：某类任务的标准流程
- Pitfall：踩坑记录与规避方法
- Decision：重要决策及原因
- Method：判断标准、设计思路、经验原则

## 文件数量上限与合并（强制）
- 当前 topic 文件总数必须保持 < ${maxTopics}。达到或超过 ${maxTopics} 时，必须先合并最相似的 2-4 个 topic，再处理新 L1。
- 同一主题只允许存在一个文件。语义相近的内容必须 read 相关旧文件后整体重写进一个文件，禁止为同一主题开第二个文件。
- 默认策略是 UPDATE/MERGE，不是 CREATE；只有确实无法归入任何现有 topic 时才允许新建。
- 被合并掉的旧文件必须用 write 把内容写成 \`[DELETED]\`，工程代码会自动清理。

## 路径与文件名
- 文件路径只能是扁平文件名，例如 "mysql-timeout.md"；禁止写 "topics/mysql-timeout.md" 或任何子目录。
- 文件名使用小写英文/拼音或稳定短横线标识，不要使用中文、空格、路径分隔符。
- 禁止创建只叫 batch/report/chatlog/summary 的泛化文件；具体主题名（如 summary-tips-memory-workflow.md）可以使用。

## Frontmatter 必填
--- 开始
type: work_method | work_fact | decision | pitfall
title: 简短标题
tags: [稳定标签]
sources: [l1_xxx]
updated: ISO8601
--- 结束

## 规则
1. 先按主题合并多个 session 的 L1，去重后再写文件，不得按 session 简单追加。
2. 优先更新已有主题；只有全新主题才新建。
3. 禁止写 BATCH/REPORT/CHATLOG/SUMMARY 类文件。
4. 每个文件正文（含 frontmatter）≤ ${topicMaxChars} 字符；结论保留 sources 引用。
5. 不要写 MEMORY.md，索引由工程代码生成。
6. 同一主题多个 session 的信息必须合并，不得简单追加。
7. 只写有 L1 原子记忆支撑的内容，不得编造时间、owner、deadline。
8. 修改已有文件前必须先 read 该文件；保留仍有效的旧内容并合并新信息。
9. 合并相似 topic 时，先 read 所有相关文件，再把有效内容整体重写进保留文件；旧文件写 \`[DELETED]\`。

## 完成标准
- 相关新信息已合并进 topic 文件；
- 没有创建无长期复用价值的文件；
- 输出一段简短文字说明你更新或创建了哪些文件。`;
}

function truncateForPrompt(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…(truncated ${text.length - max} chars)` : text;
}

export function formatProjectPackagerPrompt(input: ProjectPackagerPromptInput): string {
  const index = input.currentIndex.trim()
    ? truncateForPrompt(input.currentIndex, 8000)
    : "（暂无 project/MEMORY.md，首次创建 topics 后工程代码会自动生成）";

  const topicLines = input.topicMetas.map((t) => {
    const tags = t.tags.length > 0 ? t.tags.join(",") : "";
    return `- ${t.path} | type=${t.type} | title=${t.title} | tags=${tags} | updated=${t.updated ?? ""}`;
  }).join("\n") || "（暂无 topics）";
  const topicCountLine = `当前 topic 总数：${input.topicMetas.length} / ${input.maxTopics}。`;

  const l1Lines = input.l1Records.map((r) => {
    const meta = r.metadata_json ? ` | metadata=${truncateForPrompt(r.metadata_json, 500)}` : "";
    return `- [${r.record_id}] [${r.type}] ${truncateForPrompt(r.content, 800)}${meta}`;
  }).join("\n") || "（无相关 L1 原子记忆）";

  return `请维护项目经验文件。按 system prompt 的 Frontmatter 规则，用 read/write/edit 工具更新 topics。

【当前 project/MEMORY.md 索引】
${index}

【当前 topics 清单】
${topicCountLine}
${topicLines}

【本批相关 L1 原子记忆】
${l1Lines}

开始工作。完成后输出你更新/创建了哪些文件。`;
}
