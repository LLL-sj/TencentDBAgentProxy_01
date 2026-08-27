import { describe, expect, it } from "vitest";
import { parseConfig } from "../../../config.js";
import type { ConversationMessage } from "../../conversation/l0-recorder.js";
import {
  DEFAULT_L1_V2_MAX_TIP_CHARS,
  DEFAULT_L1_V2_SHORT_TEXTS,
  EXTRACT_WORK_MEMORIES_WITH_TIPS_SYSTEM_PROMPT,
  formatL1V2ExtractionPrompt,
  formatL1V2MessagesWithTips,
  partitionSummaryTipsByBatchTime,
  renderSummaryTipBlock,
  sortSummaryTipsByAnchor,
} from "./l1-extraction-with-tips.js";

function msg(id: string, content: string, timestamp = 1_700_000_000_000): ConversationMessage {
  return { id, role: "user" as const, content, timestamp };
}

const tip = {
  tip_id: "tip-1",
  l0_start_ref: "r-1",
  l0_end_ref: "r-2",
  tags: ["数据库", "SOP"],
  summary: "完成 MySQL 超时排查",
  created_at: "2026-08-18T10:00:00.000Z",
};

describe("L1 v2 system prompt", () => {
  it("contains the approved SUMMARY_TIP ground-truth rules", () => {
    expect(EXTRACT_WORK_MEMORIES_WITH_TIPS_SYSTEM_PROMPT).toContain("SUMMARY_TIP 是 Agent 对一段 L0 的高质量压缩总结");
    expect(EXTRACT_WORK_MEMORIES_WITH_TIPS_SYSTEM_PROMPT).toContain("可以直接以 SUMMARY_TIP 为主提取");
    expect(EXTRACT_WORK_MEMORIES_WITH_TIPS_SYSTEM_PROMPT).toContain("source_refs");
    expect(EXTRACT_WORK_MEMORIES_WITH_TIPS_SYSTEM_PROMPT).toContain("confidence");
    expect(EXTRACT_WORK_MEMORIES_WITH_TIPS_SYSTEM_PROMPT).toContain("请严格按上述 JSON 数组格式输出");
  });
});

describe("SUMMARY_TIP block rendering", () => {
  it("renders all placeholders and preserves summary newlines", () => {
    const rendered = renderSummaryTipBlock({ ...tip, summary: "第一行\n第二行" });
    expect(rendered).toContain('id="tip-1"');
    expect(rendered).toContain('covers="r-1..r-2"');
    expect(rendered).toContain('tags="数据库,SOP"');
    expect(rendered).toContain("第一行\n第二行");
  });

  it("truncates summaries at maxTipChars", () => {
    const rendered = renderSummaryTipBlock({ ...tip, summary: "a".repeat(5000) }, undefined, DEFAULT_L1_V2_MAX_TIP_CHARS);
    expect(rendered.length).toBeLessThan(5000 + 200);
    expect(rendered).toContain("(truncated)");
  });
});

describe("tip anchor ordering / interleaving", () => {
  const messages = [msg("r-1", "first"), msg("r-2", "second"), msg("r-3", "third")];

  it("inserts a tip immediately after l0_end_ref", () => {
    const text = formatL1V2MessagesWithTips(messages, [tip]);
    const iEnd = text.indexOf("record_id=r-2");
    const iNext = text.indexOf("record_id=r-3");
    const iTip = text.indexOf('<SUMMARY_TIP id="tip-1"');
    expect(iEnd).toBeGreaterThan(-1);
    expect(iNext).toBeGreaterThan(-1);
    expect(iTip).toBeGreaterThan(iEnd);
    expect(iTip).toBeLessThan(iNext);
  });

  it("sorts tips by l0_end_ref position", () => {
    const tips = [
      { ...tip, tip_id: "tip-later", l0_end_ref: "r-3", l0_start_ref: "r-2" },
      { ...tip, tip_id: "tip-earlier", l0_end_ref: "r-1", l0_start_ref: "r-1" },
    ];
    expect(sortSummaryTipsByAnchor(tips, ["r-1", "r-2", "r-3"]).map((t) => t.tip_id)).toEqual([
      "tip-earlier",
      "tip-later",
    ]);
  });
});

describe("batch-time partition", () => {
  const messages = [msg("r-1", "first", 1000), msg("r-2", "second", 2000), msg("r-3", "third", 3000)];

  it("keeps past/in-range tips and defers future tips", () => {
    const result = partitionSummaryTipsByBatchTime(messages, [
      { ...tip, tip_id: "past", l0_start_at: 500, l0_end_at: 900 },
      { ...tip, tip_id: "in", l0_start_at: 1500, l0_end_at: 2500 },
      { ...tip, tip_id: "future", l0_start_at: 3500, l0_end_at: 3900 },
    ]);
    expect(result.selected.map((t) => t.tip_id).sort()).toEqual(["in", "past"]);
    expect(result.deferred.map((t) => t.tip_id)).toEqual(["future"]);
  });
});

describe("formatL1V2MessagesWithTips", () => {
  it("renders late tips before the first message", () => {
    const text = formatL1V2MessagesWithTips(
      [msg("r-1", "first", 1000), msg("r-2", "second", 2000)],
      [{ ...tip, tip_id: "late", l0_start_at: 10, l0_end_at: 20 }],
    );
    expect(text.indexOf('<SUMMARY_TIP id="late"')).toBeGreaterThan(-1);
    expect(text.indexOf('<SUMMARY_TIP id="late"')).toBeLessThan(text.indexOf("record_id=r-1"));
  });

  it("inserts timestamp-anchored tips after the last message <= l0_end_at", () => {
    const text = formatL1V2MessagesWithTips(
      [msg("r-1", "first", 1000), msg("r-2", "second", 2000), msg("r-3", "third", 3000)],
      [{ ...tip, tip_id: "timed", l0_start_at: 1500, l0_end_at: 2500 }],
    );
    expect(text.indexOf('<SUMMARY_TIP id="timed"')).toBeGreaterThan(text.indexOf("record_id=r-2"));
    expect(text.indexOf('<SUMMARY_TIP id="timed"')).toBeLessThan(text.indexOf("record_id=r-3"));
  });
});

describe("formatL1V2ExtractionPrompt", () => {
  it("renders approved section skeleton and no-tips placeholder", () => {
    const text = formatL1V2ExtractionPrompt({
      newMessages: [msg("r-1", "hello")],
      previousSceneName: "场景A",
    });
    expect(text).toContain("【上一个情境】：场景A");
    expect(text).toContain("【背景对话】");
    expect(text).toContain("【待提取的新消息】");
    expect(text).toContain("【Agent 任务总结】");
    expect(text).toContain(DEFAULT_L1_V2_SHORT_TEXTS.noSummaryTipsText);
  });

  it("interleaves tips into new messages and puts rule text in summary section", () => {
    const text = formatL1V2ExtractionPrompt({
      newMessages: [msg("r-1", "start"), msg("r-2", "end")],
      summaryTips: [tip],
    });
    expect(text).toContain('<SUMMARY_TIP id="tip-1"');
    expect(text).toContain(DEFAULT_L1_V2_SHORT_TEXTS.summaryTipRuleText);
    const newMessagesSection = text.slice(
      text.indexOf("【待提取的新消息】"),
      text.indexOf("【Agent 任务总结】"),
    );
    expect(newMessagesSection.indexOf('<SUMMARY_TIP id="tip-1"')).toBeGreaterThan(-1);
  });
});

describe("parseConfig Code Memory v2 fields", () => {
  it("defaults codeMemoryVersion to v1 and short texts to approved defaults", () => {
    const cfg = parseConfig({ promptMode: "code" });
    expect(cfg.codeMemoryVersion).toBe("v1");
    expect(cfg.l1V2.summaryTipBlockTemplate).toContain("{{tip_id}}");
    expect(cfg.l1V2.noSummaryTipsText).toBe(DEFAULT_L1_V2_SHORT_TEXTS.noSummaryTipsText);
  });

  it("accepts memory.codeMemoryVersion=v2 and l1V2 overrides", () => {
    const cfg = parseConfig({
      promptMode: "code",
      codeMemoryVersion: "v2",
      l1V2: {
        summaryTipBlockTemplate: "<TIP>{{tip_id}}</TIP>",
        noSummaryTipsText: "无 tips",
        summaryTipRuleText: "规则",
      },
    });
    expect(cfg.codeMemoryVersion).toBe("v2");
    expect(cfg.l1V2.summaryTipBlockTemplate).toBe("<TIP>{{tip_id}}</TIP>");
    expect(cfg.l1V2.noSummaryTipsText).toBe("无 tips");
  });
});
