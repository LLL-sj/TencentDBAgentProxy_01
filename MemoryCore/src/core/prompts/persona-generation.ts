/**
 * Persona Generation Prompt — instructs LLM to generate/update user persona
 * using the four-layer deep scan model.
 *
 * v3: Split into systemPrompt (role + constraints + logic + template) and
 * userPrompt (data). Tool names aligned to OpenClaw actual API (write/edit).
 */

import type { MemoryPromptMode } from "../../config.js";
import { PERSONA_SYSTEM_PROMPT } from "./chat/l3-persona.js";
import { TEAM_MEMORY_SYSTEM_PROMPT } from "./code/l3-persona.js";

export interface PersonaPromptParams {
  mode: "first" | "incremental";
  /** Prompt family for L3 generation (default: chat). */
  promptMode?: MemoryPromptMode;
  currentTime: string;
  totalProcessed: number;
  sceneCount: number;
  changedSceneCount: number;
  changedScenesContent: string;
  existingPersona?: string;
  triggerInfo?: string;
  /** @deprecated Kept for call-site compatibility; no longer used in prompt. */
  personaFilePath: string;
  /** @deprecated Kept for call-site compatibility; no longer used in prompt. */
  checkpointPath: string;
}

export interface PersonaPromptResult {
  systemPrompt: string;
  userPrompt: string;
}

// System prompts live in ./chat/l3-persona.ts and ./code/l3-persona.ts.
// buildPersonaPrompt below keeps the one-flag behavior.



// ============================
// User Prompt builder (dynamic data)
// ============================

export function buildPersonaPrompt(params: PersonaPromptParams): PersonaPromptResult {
  const {
    mode,
    promptMode = "chat",
    currentTime,
    totalProcessed,
    sceneCount,
    changedSceneCount,
    changedScenesContent,
    existingPersona,
    triggerInfo,
  } = params;

  const isCodeMode = promptMode === "code";
  const targetFile = "persona.md";
  const modeLabel = mode === "first" ? "🆕 首次生成" : "🔄 迭代更新";

  const triggerSection = triggerInfo
    ? `\n### 触发信息\n${triggerInfo}\n`
    : "";

  const existingPersonaSection = existingPersona
    ? isCodeMode
      ? `\n## 📄 当前 Team Operating Doctrine（工程已预加载）\n\n` +
        `*以下是现有 persona.md 中 Team Operating Doctrine 的完整内容（${existingPersona.length} 字符）。更新后必须压缩在 1200 字以内：*\n\n` +
        `\`\`\`markdown\n${existingPersona}\n\`\`\`\n\n---\n`
      : `\n## 📄 当前 Persona（工程已预加载）\n\n` +
        `*以下是现有 persona.md 的完整内容（${existingPersona.length} 字符），基于此更新后请控制在2000字内：*\n\n` +
        `\`\`\`markdown\n${existingPersona}\n\`\`\`\n\n---\n`
    : "";

  const iterationGuide = mode === "incremental"
    ? isCodeMode
      ? `\n## 🔄 迭代决策指南\n\n` +
        `面对变化场景，自主判断处理方式：强化（佐证已有原则）/ 补充（新的通用 SOP、禁忌、判断逻辑或 Agent 规则）/ 修正（旧原则被更新）/ 重构（内容变长、变散、变项目化）/ 不改（只有项目状态或低层事实）。\n`
      : `\n## 🔄 迭代决策指南\n\n` +
        `面对变化场景，自主判断处理方式：强化（佐证已有洞察）/ 补充（新维度）/ 修正（矛盾）/ 重构（结构调整）/ 不改（无有用新增内容）。\n`
    : "";

  const userPrompt = `**输出语言**：\`${targetFile}\` 使用下方变化场景内容的主导语言。

**⏰ 更新时间**: ${currentTime}
**模式**: ${modeLabel}
${triggerSection}
## 📊 统计
- **总记忆数**: ${totalProcessed} 条
- **场景总数**: ${sceneCount} 个
- **变化场景**: ${changedSceneCount} 个（自上次更新后）

---
${changedScenesContent}

${existingPersonaSection}
${iterationGuide}`;

  return {
    systemPrompt: isCodeMode ? TEAM_MEMORY_SYSTEM_PROMPT : PERSONA_SYSTEM_PROMPT,
    userPrompt,
  };
}
