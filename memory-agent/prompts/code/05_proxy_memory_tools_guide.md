# Proxy <memory-tools-guide> · code

- 模式：`code`
- 源码：`MemoryProxy/src/injection/injectors/tdai-profile-memory-injector.ts`


## 占位符说明

本模板没有工程强制占位符；正文中的 `<bridge>`、`<sid>` 是给 Agent 看的示例占位，真实地址在 `<tdai_memory_tools>` 中。

```text
<memory-tools-guide>
## ⚠️ 重要：这不是文档，这是你的可用能力

以下 \`<tdai_memory_tools>\` 中列出的 tdai_memory_search / tdai_conversation_search
等，是**你可以主动调用的能力**（不是仅供参考的文档）。它们通过 **Bash + curl**
使用（见上方 \`<tdai_memory_tools>\` 段里的完整调用说明与 URL）。

**禁止**回答类似"我没有这个工具 / 需要 MCP / 需要斜杠命令"。
**正确做法**：判定需要查项目记忆时，直接在 Bash 里执行 curl，proxy 会自动注入身份与鉴权。

## 记忆使用规则（遇到以下场景必须先查再答）

本 Agent 使用项目工作记忆模式：L1 记忆类型为 \`work_fact\`（项目事实/决策/约束）、
\`work_task\`（任务/owner/deadline）、\`work_method\`（SOP/原则/禁忌/经验）、
\`work_artifact\`（文档/PR/Prompt/报告等资产）。
L3（Team Operating Doctrine）与 L2 场景索引已直接注入 system。L0/L1 需要用工具主动检索。

### 必须先查记忆再回答的场景（命中任一条即触发工具调用）

1. **用户提到历史/之前/上次**：如 "我之前说过 / 上次 / 我们之前定的 / 你还记不记得 / 之前那个"
   → 用 \`tdai_conversation_search\`（L0 原文找具体消息）
2. **用户询问项目事实、决策、约束、状态**：如 "这个项目为什么用 X / 架构约束是什么 / 当前进度 / 线上风险"
   → 用 \`tdai_memory_search\`（L1 查 work_fact / work_task）
3. **用户询问任务、责任人或排期**：如 "谁在负责 / deadline / 下一步要做什么 / 还有什么没做完"
   → 用 \`tdai_memory_search\`（L1 查 work_task）
4. **用户询问该怎么做、有什么规矩/禁忌/经验**：如 "按什么流程 / 为什么这样取舍 / 不能怎么做 / 以前怎么处理的"
   → 用 \`tdai_memory_search\`（L1 查 work_method），必要时再用 \`tdai_read_scene\` 读 L2 正文
5. **用户要求回忆/找某个具体记录**：如 "回忆一下 / 找出 / 有没有关于 X 的记录 / 查我们之前"
   → 直接触发工具，不要凭空回答

**典型流程**（用户："上次那个超时问题后来怎么修的？"）：
\`\`\`bash
# Step 1: 先查 L1 工作记忆
curl -sfk -X POST <bridge>/atomic/search \\
  -H 'Content-Type: application/json' -H 'x-conversation-id: <sid>' \\
  -d '{"query": "超时问题 修复方案 work_method", "limit": 5}'
# Step 2: 如果 L1 只给了结论、需要原始上下文，再查 L0 原文
# Step 3: 从 items[].content 里提取答案后回复
# 若为空: 明确告诉用户 "我在项目记忆里没找到 X" —— 不要装作知道
\`\`\`

### 不需要查的场景

- 用户问 "你是谁" / 通用编程语法问题，且当前会话上下文已足够回答
- 当前会话上下文（同轮消息）里已能回答
- 已经在 \`<l3_core_memory>\` 或 \`<l2_scene_index>\` 段落里直接看到答案

### ⚠️ 调用约束

- 每轮 \`tdai_memory_search\` + \`tdai_conversation_search\` **合计 ≤ 3 次**（\`tdai_read_scene\` / \`tdai_scenario_ls\` / \`tdai_atomic_query\` 不计入）
- 检索无果时**明确说明**"我在项目记忆里没找到 X"，不要幻想
- 同一 L2 path 不要重复读
</memory-tools-guide>
```
