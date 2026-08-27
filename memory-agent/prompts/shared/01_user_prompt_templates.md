# 动态 User Prompt 模板与占位符（chat / code 共用骨架）

> 这里只放“每次调用都会动态填充”的模板。System Prompt 在 `chat/` 和 `code/` 中分别存放。

## 1. L1 抽取 User Prompt（chat / code 共用）

```text
**输出语言**：根据下方"待提取的新消息"中 user 发言的主导语言书写 `scene_name` 和 memory `content`。

【上一个情境】：{{previousSceneName}}

【背景对话】（仅供理解上下文推断关系/时间，严禁从中提取记忆）：
{{backgroundMessagesText}}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

【待提取的新消息】（务必结合 timestamp 推算时间，只从这里提取记忆！）：
{{newMessagesText}}
```

| 占位符 | 来源 / 格式 |
|---|---|
| `{{previousSceneName}}` | 上轮最后场景名；无则 `无` |
| `{{backgroundMessagesText}}` | 最多 5 条历史消息，每条 `[id] [role] [ISO时间]: content` |
| `{{newMessagesText}}` | 本批最多 10 条新消息，格式同上 |

## 2. L1 去重 User Prompt（chat / code 共用骨架，type 枚举随模式变化）

```text
## 统一候选记忆池（共 {{candidateCount}} 条已有记忆）
{{candidatePoolJson}}

════════════════════════════════════════════

## 待判断的新记忆（共 {{newMemoryCount}} 条）
{{newMemoriesJson}}

请逐条判断并输出决策 JSON 数组。
```

| 占位符 | 说明 |
|---|---|
| `{{candidateCount}}` | 候选池数量 |
| `{{candidatePoolJson}}` | 已有记忆的 `record_id/content/type/priority/scene_name/timestamps` |
| `{{newMemoryCount}}` | 本批新记忆数 |
| `{{newMemoriesJson}}` | 新记忆及每条关联候选 ID |

## 3. L2 场景 User Prompt（chat / code 共用）

```text
**输出语言**：场景文件内容使用下方 New Memories List 中记忆的主导语言。
{{sceneCountWarning}}

### 1️⃣ New Memories List
{{memoriesJson}}

### 2️⃣ Existing Scene Blocks Summary
{{sceneSummaries}}

### 3️⃣ Current Timestamp
{{currentTimestamp}}

### 📁 已有场景文件清单（仅以下文件可 read）
{{existingSceneFilesText}}
```

| 占位符 | 说明 |
|---|---|
| `{{sceneCountWarning}}` | 可选；场景数接近上限时填预警 |
| `{{memoriesJson}}` | 本批 L1 记忆 JSON |
| `{{sceneSummaries}}` | 现有 scene index（文件名 + summary） |
| `{{currentTimestamp}}` | 当前时间 |
| `{{existingSceneFilesText}}` | 可读文件清单 |

## 4. L3 User Prompt（chat / code 共用骨架，局部措辞不同）

```text
**输出语言**：`persona.md` 使用下方变化场景内容的主导语言。

**⏰ 更新时间**: {{currentTime}}
**模式**: {{modeLabel}}
{{triggerInfoSection}}

## 📊 统计
- **总记忆数**: {{totalProcessed}} 条
- **场景总数**: {{sceneCount}} 个
- **变化场景**: {{changedSceneCount}} 个（自上次更新后）

---
{{changedScenesContent}}

{{existingPersonaSection}}

{{iterationGuide}}
```

| 占位符 | chat | code |
|---|---|---|
| `{{modeLabel}}` | 🆕 首次生成 / 🔄 迭代更新 | 同左 |
| `{{currentTime}}` | 当前时间 | 同左 |
| `{{triggerInfoSection}}` | 可选触发说明 | 同左 |
| `{{totalProcessed}}` | 总记忆数 | 同左 |
| `{{sceneCount}}` | 场景数 | 同左 |
| `{{changedSceneCount}}` | 变化场景数 | 同左 |
| `{{changedScenesContent}}` | 变化场景正文 | 同左 |
| `{{existingPersonaSection}}` | 标题为“当前 Persona”，正文限制 2000 字 | 标题为“当前 Team Operating Doctrine”，正文限制 1200 字 |
| `{{iterationGuide}}` | 强化/补充/修正/重构/不改（用户洞察版） | 强化/补充/修正/重构/不改（工作原则版） |

## 5. 关键结论

1. **System Prompt 侧**：8 份里只有 L2 有动态参数 `{{maxScenes}}`（chat/code 都用到）；其余 L1、L1 去重、L3 的 System Prompt 都是纯静态文本。
2. **User Prompt 侧**：L1、L1 去重、L2 的模板 chat/code 相同；L3 的模板相同，但 `existingPersonaSection` 与 `iterationGuide` 的措辞/字符上限随模式不同。
3. **Proxy 侧**：`<memory-tools-guide>` 和 `<tdai_memory_tools>` 需要注入 `{{proxyBaseUrl}}`、`{{sessionId}}`、`{{spaceId}}`；触发场景和 type 枚举应随模式切换。
