# Wiki 摘要 Prompt（callback 内联）

- 模式：唯一（无 chat/code 之分）
- 源码：`MemoryKnowledge/src/callback.ts` → `generateWikiSummary()`（内联，非独立常量文件）
- LLM 调用点：清单 #4
- 触发时机：wiki 就绪（ready）回调；code-graph 走模板摘要，**无 LLM**

## 占位符说明

| 占位符 | 含义 | 谁填 |
|---|---|---|
| `${pages}` | 页面标题 + 描述列表（`pages.map(...)` 拼装） | TS 代码 |

## Prompt 全文

```text
请为以下知识库生成一个不超过100字的中文摘要，描述它的主要内容和用途。只输出摘要文本，不要输出其他内容。

页面列表：
${pages}
```

## 实现说明

- 复用 `createLlmClient`（`engines/wiki/ingest-v2/llm.ts`）：自动按 `protocol` 切 openai/anthropic、带 Langfuse 追踪与超时处理。
- 配置与 wiki ingest 同一条链：`resolveLlmConfig(serviceId, llm_binding, 环境变量兜底)`，见 `../shared/01_llm_config_chain.md`。
