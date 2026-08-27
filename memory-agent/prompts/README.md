# 提示词目录说明

## 1. 文件布局

每个模式 6 个文件，共 12 份模式化提示词：

| 文件 | chat | code |
|---|---|---|
| L1 抽取 System Prompt | `chat/01_L1_extraction.md` | `code/01_L1_extraction.md` |
| L1 去重 System Prompt | `chat/02_L1_dedup.md` | `code/02_L1_dedup.md` |
| L2 场景 System Prompt | `chat/03_L2_scene.md` | `code/03_L2_scene.md` |
| L3 画像/纲领 System Prompt | `chat/04_L3_persona.md` | `code/04_L3_persona.md` |
| Proxy 工具使用指南 | `chat/05_proxy_memory_tools_guide.md` | `code/05_proxy_memory_tools_guide.md` |
| Proxy curl 工具说明 | `chat/06_proxy_tdai_memory_tools.md` | `code/06_proxy_tdai_memory_tools.md` |

共用动态模板：`shared/01_user_prompt_templates.md`

## 2. 当前状态：8 份提示词已物理拆分为 8 个 TS 文件

运行时文件（TypeScript 模块，非 md 运行时读取）：
- `MemoryCore/src/core/prompts/chat/{l1-extraction,l1-dedup,l2-scene,l3-persona}.ts`
- `MemoryCore/src/core/prompts/code/{l1-extraction,l1-dedup,l2-scene,l3-persona}.ts`
- 原 4 个 facade 文件保留 API 兼容，继续通过 `promptMode === "code" ? ... : ...` 选择。
- MemoryProxy 已新增 `promptMode` 字段，两套工具说明同样通过一个标志位选择。
- 本目录 `chat/`、`code/` 下的 md 是给人看的分析稿，内容与 TS 模块一一对应。

## 3. 占位符总表

### 3.1 核心 System Prompt

| 提示词 | chat 占位符 | code 占位符 |
|---|---|---|
| L1 抽取 | 无 | 无 |
| L1 去重 | 无 | 无 |
| L2 场景 | `{{maxScenes}}`、`{{maxScenes - 1}}` | 同左 |
| L3 | 无 | 无 |

### 3.2 核心 User Prompt（动态）

| 模板 | 占位符 | chat/code 差异 |
|---|---|---|
| L1 抽取 | `previousSceneName`、`backgroundMessagesText`、`newMessagesText` | 无差异 |
| L1 去重 | `candidateCount`、`candidatePoolJson`、`newMemoryCount`、`newMemoriesJson` | 无差异 |
| L2 场景 | `memoriesJson`、`sceneSummaries`、`currentTimestamp`、`sceneCountWarning`、`existingSceneFilesText` | 无差异 |
| L3 | `currentTime`、`modeLabel`、`triggerInfoSection`、`totalProcessed`、`sceneCount`、`changedSceneCount`、`changedScenesContent`、`existingPersonaSection`、`iterationGuide` | **有差异**：chat 是“当前 Persona/2000 字”，code 是“当前 Team Operating Doctrine/1200 字”；iterationGuide 措辞不同 |

### 3.3 Proxy 注入模板

| 模板 | 占位符 | chat/code 差异 |
|---|---|---|
| `<tdai_profile_memory>` 包装 | `agentName`、`role`、`agentId`、`l3Content`、`scenePath`、`sceneSummary` | 无（标签本身可进一步模式化） |
| `<memory-tools-guide>` | 无固定外部占位符，正文里的 `<bridge>`、`<sid>` 是示例占位 | **有差异**：触发场景和 type 名称 |
| `<tdai_memory_tools>` | `proxyBaseUrl`、`sessionId`、`spaceId`，派生 `bridgeBase` | **有差异**：atomic/query 的 type 枚举、search 用途说明 |
| 旧 `<tdai_recalled_l1_memories>` | `index`、`type`、`source`、`score`、`content` | 建议模式化说明文字，但该注入器当前未注册 |

## 4. 运行时实现状态

1. ✅ 核心 8 份提示词：已拆成 `MemoryCore/src/core/prompts/{chat,code}/` 下 8 个独立 TS 文件；facade 保持一个 `promptMode` 选择。
2. 增加一个 `PromptCatalog(mode)` 入口：
   - L1/L1-dedup/L2/L3 都从 catalog 取；
   - 只有一个 `promptMode` 来源。
3. ✅ MemoryProxy 的 `TdaiMemoryConfig` 已增加 `promptMode`，`start-proxy.sh` 已用同一个 `MEMORY_PROMPT_MODE` 生成。
4. ✅ `renderTdaiMemoryToolsBlock(..., promptMode)` 和 `MEMORY_TOOLS_GUIDE` 已拆成 chat/code 两套。
