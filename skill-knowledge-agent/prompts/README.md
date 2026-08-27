# 提示词文件索引（Skill / Knowledge）

```
prompts/
├── skill/
│   ├── 01_skill_review_agent.md          # Skill Review Agent System Prompt（唯一 skill LLM 调用）
│   └── 02_skill_listing_header_footer.md # <available_skills> header/footer + guidance（非 LLM）
├── knowledge/
│   ├── 01_wiki_ingest_prompts.md         # wiki 摄取：分析/系统/生成 提示词 + 占位符
│   └── 02_wiki_summary_prompt.md         # wiki ≤100 字摘要 prompt（callback 内联）
└── shared/
    └── 01_llm_config_chain.md            # 两侧 LLM 配置链路对照（skill 内核 llm / knowledge binding）
```

## 占位符分类（同 memory-agent 惯例）

| 类型 | 谁填 | 例子 |
|---|---|---|
| A. 工程填充型 | 我们的 TS 代码 | `sourceName`、`sourceText`、`existingPages`、`pagesToUpdate`、`analysis`、`hint`、会话切片 |
| B. 模板注入型 | wiki 模板（运行时配置） | `template.purpose`、`template.schema` |
| C. 提示词内置标记型 | LLM 输出时自己遵守 | `<<<FILE path="...">>>`、`<<<END>>>`、`[[wikilink]]`、`Nothing to save.` |

结论：Skill/Knowledge 的提示词**没有 chat/code 双模式**（那是 memory 特有的）；差异点在 LLM 配置链路（内核 `llm:` 块 vs Knowledge 每 instance llm_binding）与调用协议（openai 固定 vs openai/anthropic 双协议）。
