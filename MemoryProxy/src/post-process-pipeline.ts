/** Shared response post-processing for OpenAI and Anthropic handlers. */

import {
  opikCreateLlmSpan,
  opikUpdateTrace,
} from "./opik.js";
import {
  langfuseReportGeneration,
  type LangfuseTurnContext,
} from "./langfuse.js";
import {
  writeLog,
  type Pipeline,
} from "./logger.js";
import type { ProxyConfig } from "./types.js";
import {
  tryReportCreditFromPath,
} from "./credit-reporter.js";
import { writeFailedReportRaw } from "./clickhouse.js";
import { recordInputTokenUsage } from "./rate-limit/guard.js";
import { recordTdaiTurn } from "./tdai/recorder.js";
import { trackWrite, withL0Retry } from "./tdai/pending-writes.js";
import type { TdaiClient } from "./tdai/client.js";
import type { TdaiIdentity, TdaiMessage } from "./tdai/types.js";
import { triggerSkillExtractIfReady } from "./skill/handler-glue.js";
import { isExtractionAllowed, logExtractionSkipped } from "./extraction-gate.js";

export type PostProcessProtocol = "openai" | "anthropic";

export type L0WriteMode = "await" | "fire-and-forget" | "tracked";

export interface PostProcessContext {
  config: ProxyConfig;
  modelId: string;
  keyId: string;
  sessionKey: string;
  upstreamUrl: string;
  requestPath: string;
  traceId: string;
  forkTraceId: string;
  startTime: string;
  inputMessages: unknown[];
  retried: boolean;
  logMeta: Record<string, unknown>;
  pipe: Pipeline;
  lf: LangfuseTurnContext;
  spaceId?: string;
  upstreamRequestId?: string;
  langfuseDebug: boolean;
  debugMetadata: Record<string, unknown>;

  tdaiClient: TdaiClient | null;
  tdaiIdentity: TdaiIdentity | null;
  tdaiUserMessage: TdaiMessage | null;
  sessionKeyForSkill: string;
  agentSource: string;
  sessionInfo: Record<string, unknown> | null | undefined;
  assetCapabilities?: import("./injection/types.js").AssetCapabilityFlags;
}

export interface PostProcessResult {
  protocol: PostProcessProtocol;
  stream: boolean;
  usage: Record<string, unknown> | null;
  outputMessage: Record<string, unknown> | null;
  outputContent: string | null;
  opikInputMessages: unknown[];
  langfuseInput: unknown;
  langfuseOutput: unknown;
  toolCallCount?: number;

  /** OpenAI updates its parent trace; Anthropic currently creates a span only. */
  updateOpikTrace: boolean;
  /** Anthropic stream/non-stream keeps its own debug output metadata. */
  langfuseExtraMetadata?: Record<string, unknown>;
  /** Protocol-specific Opik tags; omitted means no extra tags. */
  opikTags?: string[];

  /** Explicitly preserves the existing protocol-specific L0 timing. */
  l0Mode: L0WriteMode;
  /** Some legacy paths only attempted L0 when usage was present. */
  writeL0: boolean;
  /** Streaming credit reporting is intentionally detached from response close. */
  creditMode: "await" | "fire-and-forget";
  /** FORK/SIDEQUERY requests skip skill and L0 but still report credit. */
  mainDialog: boolean;
  /** Some handlers mark the response complete before their L0 write. */
  doneBeforeL0?: boolean;
  /** Anthropic non-streaming historically triggers skill before its fire-and-forget L0 write. */
  skillBeforeL0?: boolean;
  /** Called after usage/L0 and before skill/credit, matching existing ordering. */
  onDone: () => void;
  /** Non-streaming responses may expose credit reporting errors to the client. */
  responseHeaders?: Headers;
}

/** Run usage, observability, memory, skill and credit side effects once. */
export async function runPostProcessPipeline(
  context: PostProcessContext,
  result: PostProcessResult,
): Promise<void> {
  const { config, pipe } = context;
  const {
    protocol,
    stream,
    usage,
    outputMessage,
    outputContent,
    opikInputMessages,
    langfuseInput,
    langfuseOutput,
    updateOpikTrace,
    langfuseExtraMetadata,
    l0Mode,
    mainDialog,
  } = result;
  const endTime = new Date().toISOString();

  if (usage) {
    try {
      await recordInputTokenUsage({
        config,
        instanceId: context.spaceId || undefined,
        modelId: context.modelId,
        usage,
        protocol,
      });
    } catch (err: unknown) {
      pipe.error("RATE_LIMIT_USAGE", err);
    }

    try {
      writeLog(config, {
        timestamp: endTime,
        event: "usage",
        modelId: context.modelId,
        keyId: context.keyId,
        sessionKey: context.sessionKey,
        turnSeq: context.lf.turnSeq,
        userInput: context.lf.userQuery || undefined,
        upstreamUrl: context.upstreamUrl,
        stream,
        usage,
        spaceId: context.spaceId,
        upstreamRequestId: context.upstreamRequestId,
        ...context.logMeta,
      });
    } catch (err: unknown) {
      pipe.error("LOG_WRITE", err);
    }

    try {
      const outputMessages = outputMessage ? [outputMessage] : [];
      if (updateOpikTrace) {
        opikUpdateTrace(config, {
          traceId: context.traceId,
          projectName: context.keyId,
          endTime,
          output: outputMessages,
          usage,
        });
        if (context.forkTraceId && !config.opik.stripRequestLogContent) {
          opikUpdateTrace(config, {
            traceId: context.forkTraceId,
            projectName: "request_log",
            endTime,
            output: outputMessages,
            usage,
          });
        }
      }

      opikCreateLlmSpan(config, {
        traceId: context.traceId,
        projectName: context.keyId,
        name: context.modelId,
        startTime: context.startTime,
        endTime,
        inputMessages: opikInputMessages,
        outputMessage,
        model: context.modelId,
        usage,
        tags: result.opikTags,
        forkProjectName: "request_log",
        forkTraceId: context.forkTraceId,
        forkMetadata: {
          keyId: context.keyId,
          modelId: context.modelId,
          stream,
          upstreamUrl: context.upstreamUrl,
        },
      });
    } catch (err: unknown) {
      pipe.error("OPIK_SPAN", err);
    }

    try {
      const metadata = {
        stream,
        retried: context.retried,
        upstreamUrl: context.upstreamUrl,
        ...context.logMeta,
        ...context.debugMetadata,
        ...langfuseExtraMetadata,
      };
      langfuseReportGeneration({
        traceId: context.lf.traceId,
        name: context.modelId,
        model: context.modelId,
        startTime: context.startTime,
        endTime,
        input: langfuseInput,
        output: langfuseOutput,
        usage,
        traceName: context.lf.traceName,
        userId: context.lf.userId,
        sessionId: context.lf.sessionId,
        tags: context.lf.tags,
        traceInput: context.lf.userQuery || undefined,
        traceOutput: langfuseOutput ?? undefined,
        traceMetadata: metadata,
        observationMetadata: {
          retried: context.retried,
          ...context.logMeta,
          ...context.debugMetadata,
          ...langfuseExtraMetadata,
        },
      });
    } catch (err: unknown) {
      pipe.error("LANGFUSE_SPAN", err);
    }
  }

  if (result.doneBeforeL0) {
    result.onDone();
  }

  const runSkill = async (): Promise<void> => {
    if (mainDialog && isExtractionAllowed(config, "skill")) {
      try {
        await triggerSkillExtractIfReady({
          config,
          sessionKey: context.sessionKeyForSkill,
          agentSource: context.agentSource,
          sessionInfo: context.sessionInfo,
          inputMessages: context.inputMessages,
          assistantMessage: outputMessage,
          protocol,
          assetCapabilities: context.assetCapabilities,
          ...(typeof result.toolCallCount === "number"
            ? { toolCallCountOverride: result.toolCallCount }
            : {}),
        });
      } catch (err: unknown) {
        pipe.error("SKILL_EXTRACT", err);
      }
    } else if (mainDialog) {
      logExtractionSkipped(config, "skill", context.sessionKeyForSkill);
    } else {
      pipe.info("ROUTING_SKIP", `skip skill for kind=${result.protocol} session=${context.sessionKeyForSkill}`);
    }
  };

  if (result.skillBeforeL0) {
    await runSkill();
  }

  if (result.writeL0 && mainDialog && context.tdaiClient && isExtractionAllowed(config, "tdai-memory")) {
    const write = withL0Retry(() => recordTdaiTurn(
      context.tdaiClient!,
      context.tdaiIdentity,
      context.tdaiUserMessage,
      outputContent,
    ));
    if (l0Mode === "await") {
      await write.catch((err: unknown) => pipe.error("TDAI_L0", err));
    } else if (l0Mode === "tracked") {
      trackWrite(write.catch((err: unknown) => pipe.error("TDAI_L0", err)));
    } else {
      write.catch((err: unknown) => pipe.error("TDAI_L0", err));
    }
  } else if (result.writeL0 && mainDialog && context.tdaiClient) {
    logExtractionSkipped(config, "tdai-memory", context.sessionKeyForSkill);
  } else if (result.writeL0 && !mainDialog) {
    pipe.info("ROUTING_SKIP", `skip L0 for kind=${result.protocol} session=${context.sessionKeyForSkill}`);
  }

  if (!result.doneBeforeL0) {
    result.onDone();
  }

  if (!result.skillBeforeL0) {
    await runSkill();
  }

  const reportCredit = async (): Promise<void> => {
    let creditOutcome;
    try {
      creditOutcome = await tryReportCreditFromPath(
        config.creditReport,
        context.requestPath,
        usage,
        config.creditPricing,
        context.modelId,
        context.upstreamUrl,
        "usage",
      );
    } catch (err: unknown) {
      pipe.error("CREDIT_REPORT", `${stream ? "[stream] " : ""}${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (creditOutcome.attempted && !creditOutcome.ok) {
      pipe.error("CREDIT_REPORT", `${stream ? "[stream] " : ""}${creditOutcome.errorMessage ?? "unknown"}`);
      if (!stream && creditOutcome.errorHeader && result.responseHeaders) {
        result.responseHeaders.set("x-credit-report-error", creditOutcome.errorHeader);
      }
      try {
        writeFailedReportRaw(
          {
            timestamp: new Date().toISOString(),
            event: "usage",
            modelId: context.modelId,
            keyId: context.keyId,
            sessionKey: context.sessionKey,
            upstreamUrl: context.upstreamUrl,
            stream,
            usage: usage ?? undefined,
            upstreamRequestId: context.upstreamRequestId,
            pricingConfig: config.creditPricing,
          },
          creditOutcome.errorMessage ?? "unknown",
        );
      } catch (err: unknown) {
        pipe.error("CREDIT_REPORT_RAW", err);
      }
    }
  };

  if (result.creditMode === "await") {
    await reportCredit();
  } else {
    void reportCredit();
  }
}
