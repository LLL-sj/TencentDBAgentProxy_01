# code-v2 prompts

Code Memory v2 提示词目录。v1 文件 `code/` 保持不动；v2 只新增，通过
`memory.codeMemoryVersion: v2` 启用。

## 文件

- `l1-extraction-with-tips.ts`
  - System Prompt：`EXTRACT_WORK_MEMORIES_WITH_TIPS_SYSTEM_PROMPT`
    （原文来自 `memory-agent/08_Phase3_L1v2_提示词评审稿.md` §2）
  - User Prompt builder：`formatL1V2ExtractionPrompt(...)`
    （结构来自评审稿 §3）
  - SUMMARY_TIP 块模板与两个短文本来自 `MemoryTdaiConfig.l1V2`，
    默认值见 `DEFAULT_L1_V2_SHORT_TEXTS`。
  - Tips 会按 `l0_end_ref` 插入到待提取新消息流中；没有 tips 时使用
    `l1V2.noSummaryTipsText`。

## 配置

```yaml
memory:
  promptMode: code
  codeMemoryVersion: v2   # 默认 v1
  l1V2:
    summaryTipBlockTemplate: |
      <SUMMARY_TIP id="{{tip_id}}" covers="{{l0_start_ref}}..{{l0_end_ref}}" tags="{{tags_csv}}">
      {{summary}}
      </SUMMARY_TIP>
    noSummaryTipsText: （本批没有 Agent 提交的 SUMMARY_TIP）
    summaryTipRuleText: SUMMARY_TIP 是 Agent 对一段 L0 的高质量压缩总结，默认可信：L0 完整时用于确认重点和补全归纳；L0 不完整或已消费过时，可直接以 SUMMARY_TIP 为主提取。
```

环境变量侧由 `deploy/global-images/start-memory-core.sh` 生成。
