# Skill Listing 注入模板（header / footer / guidance）

- 模式：唯一（无 chat/code 之分）
- 源码：`MemoryCore/src/core/skill/prompts/skill-listing-prompt.ts`
- 性质：**非 LLM 调用**，纯静态注入文本。由内核 M5 路由层（`core/skill/index.ts` 导出）把命中的 skill 条目包在 header / footer 之间渲染成 `<available_skills>` 块；proxy 的 `SkillInjector` 在 session_init 时**原样注入**该预渲染块。

## 占位符说明

三个常量均无占位符。实际条目由路由层（M5，`routing.mode: bm25` + `searchTopK: 20`）把命中的 skill 列表包在 header / footer 之间。

```text
## Skills (mandatory)
Before replying, scan the skills below. If a skill matches or is even partially relevant to your task, you MUST load it with skill_view(name) and follow its instructions. Err on the side of loading — it is always better to have context you don't need than to miss critical steps, pitfalls, or established workflows. Skills contain specialized knowledge — API endpoints, tool-specific commands, and proven workflows that outperform general-purpose approaches. Load the skill even if you think you could handle the task with basic tools like web_search or terminal. Skills also encode the user's preferred approach, conventions, and quality standards for tasks like code review, planning, and testing — load them even for tasks you already know how to do, because the skill defines how it should be done here.
If a skill has issues, fix it with skill_manage(action='patch').
After difficult/iterative tasks, offer to save as a skill. If a skill you loaded was missing steps, had wrong commands, or needed pitfalls you discovered, update it before finishing.
```

```text
Only proceed without loading a skill if genuinely none are relevant to the task.
```

```text
After completing a complex task (5+ tool calls), fixing a tricky error, or discovering a non-trivial workflow, save the approach as a skill with skill_manage so you can reuse it next time.
When using a skill and finding it outdated, incomplete, or wrong, patch it immediately with skill_manage(action='patch') — don't wait to be asked. Skills that aren't maintained become liabilities.
```

> 注：header 里出现的 `skill_view(name)` / `skill_manage(...)` 是**面向 Agent 的注入文案措辞**；内核侧实际工具名是 `skill_list/skill_view/skill_create/skill_update/skill_patch/skill_files_write`（见 `01_skill_review_agent.md`）。两者面向的调用方不同：前者是业务 Agent 读技能，后者是 Skill Review Agent 改库。
