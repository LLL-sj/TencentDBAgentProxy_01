#!/usr/bin/env bash
# 单独拉起 proxy（context-proxy，端口 8096）。
#
# proxy 的转发上游走 PROXY_UPSTREAM_URL（与 memory 组的 MEMORY_LLM_* 独立）。
# proxy 会调 memory:8420 做鉴权 / skill / tdai memory 注入；调 memory-hub:8125
# 做 sessionInit control plane。可以单跑 proxy 但相关能力会降级 / 关闭。
#
# 用法：
#   ./start-proxy.sh
#
# 需要以下 proxy 组参数（写在 .env）：
#   PROXY_UPSTREAM_URL / PROXY_UPSTREAM_API_KEY / PROXY_UPSTREAM_MODEL

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_lib.sh
source "$SCRIPT_DIR/_lib.sh"

load_env
require_vars \
  PROXY_IMAGE PROXY_PORT \
  PROXY_UPSTREAM_URL PROXY_UPSTREAM_API_KEY PROXY_UPSTREAM_MODEL

# 与 memory-core 保持一致的 gateway 内部凭据（默认 local，仅本地体验）
MEMORY_CORE_GATEWAY_API_KEY="${MEMORY_CORE_GATEWAY_API_KEY:-local}"

# Agent 通过 curl 调用 proxy bridge 时使用的对外地址。
# 不设置时默认本机回环地址；跨机 / 公网部署请在 .env 显式配置。
PROXY_PUBLIC_BASE_URL="${MEMORY_PROXY_PUBLIC_BASE_URL:-http://127.0.0.1:${PROXY_PORT:-8096}}"
PROXY_PUBLIC_BASE_URL="${PROXY_PUBLIC_BASE_URL%/}"

REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# proxy SQLite（sessions / tips_reminder_state / hook_cache）必须持久化。
# 默认 named volume；可在 .env 用 PROXY_VOLUME 覆盖。
PROXY_VOLUME="${PROXY_VOLUME:-tdai-proxy-data}"

# 服务器模式：镜像已包含全部源码，默认不挂载仓库源码；本地开发热更新才设为 1。
DEV_SOURCE_MOUNTS="${TDAI_DEV_SOURCE_MOUNTS:-0}"
RESTART_POLICY="${TDAI_RESTART_POLICY:-no}"
TZ_ARGS=()
if [[ -n "${TDAI_TZ:-}" ]]; then
  TZ_ARGS=(-e "TZ=$TDAI_TZ")
fi
CONTAINER=tdai-proxy
NETWORK=tdai-memory-stack

if ! $DOCKER network inspect "$NETWORK" >/dev/null 2>&1; then
  info "创建 docker 网络 $NETWORK"
  $DOCKER network create "$NETWORK" >/dev/null
fi

# 依赖检查（不阻塞，仅提醒）
if ! $DOCKER ps --format '{{.Names}}' 2>/dev/null | grep -qx "tdai-memory-core"; then
  warn "memory-core 容器未运行，proxy 的 auth / tdai memory / skill 注入将全部降级。"
fi
if ! $DOCKER ps --format '{{.Names}}' 2>/dev/null | grep -qx "tdai-memory-hub"; then
  warn "memory-hub 容器未运行，proxy 的 sessionInit control plane 不可达。"
fi

pull_image "$PROXY_IMAGE"
rm_container_if_exists "$CONTAINER"

# proxy 只从 YAML 读上游 URL / API key（不认 PROXY_UPSTREAM_URL 环境变量），
# 所以我们从 .env 生成一个最小 config.yaml 挂到容器 /data/config.yaml。
# 容器 CMD 已经是 [--config /data/config.yaml]。
CONFIG_DIR="${PROXY_CONFIG_DIR:-$SCRIPT_DIR/.proxy-config}"
mkdir -p "$CONFIG_DIR"
CONFIG_FILE="$CONFIG_DIR/config.yaml"

# ── 三大能力开关（默认最小可用；打开时自动串联依赖）──
# PROXY_ENABLE_AUTH        : 客户端凭 x-tdai-user-key 走内核 auth/verify → user_id
# PROXY_ENABLE_SESSION_INIT: 首轮弹表单选 team/agent/task；依赖 auth+tdai
# PROXY_ENABLE_TDAI        : L2/L3 记忆注入 + L1 召回；依赖 memory-core
#
# 便捷开关 PROXY_FULL_STACK=1 一键把三个都开。
if [[ "${PROXY_FULL_STACK:-0}" == "1" ]]; then
  PROXY_ENABLE_AUTH=1
  PROXY_ENABLE_TDAI=1
  PROXY_ENABLE_SESSION_INIT=1
fi
PROXY_ENABLE_AUTH="${PROXY_ENABLE_AUTH:-0}"
PROXY_ENABLE_TDAI="${PROXY_ENABLE_TDAI:-0}"
PROXY_ENABLE_SESSION_INIT="${PROXY_ENABLE_SESSION_INIT:-0}"

# sessionInit 依赖 auth 拿 user_id；开 sessionInit 时自动补 auth
if [[ "$PROXY_ENABLE_SESSION_INIT" == "1" && "$PROXY_ENABLE_AUTH" != "1" ]]; then
  warn "PROXY_ENABLE_SESSION_INIT=1 需要 auth；自动打开 PROXY_ENABLE_AUTH"
  PROXY_ENABLE_AUTH=1
fi

bool() { [[ "$1" == "1" ]] && echo "true" || echo "false"; }

# Codex 内部请求 prompt 前缀（标题生成 / 安全审批）。真实用户对话不要使用这些前缀。
# 如需覆盖，在 .env 设置 MEMORY_CODEX_INTERNAL_PROMPT_PREFIXES，用 | 分隔多个前缀。
CODEX_INTERNAL_PROMPT_PREFIXES="${MEMORY_CODEX_INTERNAL_PROMPT_PREFIXES:-}"
if [[ -z "$CODEX_INTERNAL_PROMPT_PREFIXES" ]]; then
  CODEX_INTERNAL_PROMPT_PREFIXES_YAML='    - "You are a helpful assistant. You will be presented with a user prompt, and your job is to provide a short title"
    - "The following is the Codex agent history whose request action you are assessing"
    - "The following is the Codex agent history added since your last approval assessment"'
else
  CODEX_INTERNAL_PROMPT_PREFIXES_YAML="$(
    printf '%s' "$CODEX_INTERNAL_PROMPT_PREFIXES" | tr '|' '\n' | sed '/^[[:space:]]*$/d' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' | while IFS= read -r prefix; do
      printf '    - "%s"\n' "$prefix"
    done
  )"
fi

# 本地 e2e / 调试：强制 session init 身份（跳过交互表单）。生产请勿开启。
DEBUG_FORCE_IDENTITY_YAML=""
if [[ "${PROXY_DEBUG_FORCE_IDENTITY:-0}" == "1" ]]; then
  DEBUG_FORCE_IDENTITY_YAML="  debugForceIdentity:
    team_id: \"${PROXY_DEBUG_TEAM_ID:?PROXY_DEBUG_TEAM_ID required}\"
    agent_id: \"${PROXY_DEBUG_AGENT_ID:?PROXY_DEBUG_AGENT_ID required}\"
    task_id: \"${PROXY_DEBUG_TASK_ID:-}\"
"
fi

info "生成 proxy config → $CONFIG_FILE  (auth=$(bool $PROXY_ENABLE_AUTH) session-init=$(bool $PROXY_ENABLE_SESSION_INIT) tdai=$(bool $PROXY_ENABLE_TDAI))"
cat > "$CONFIG_FILE" <<YAML
# 由 start-proxy.sh 自动生成 —— 每次启动覆盖，请不要手动改。
server:
  host: 0.0.0.0
  port: 8096
  forwardTimeoutMs: 600000

upstream:
  url: "${PROXY_UPSTREAM_URL}"
  apiKey: "${PROXY_UPSTREAM_API_KEY}"
  defaultModel: "${PROXY_UPSTREAM_MODEL}"

log:
  file: ""
  level: info
  backend: console

# tdai 内核对接（用于 injection / skill / auth 拉取）
tdai:
  enabled: $(bool $PROXY_ENABLE_TDAI)
  endpoint: "http://memory-core:8420"
  apiKey: "${MEMORY_CORE_GATEWAY_API_KEY}"
  serviceId: default
  memory:
    enabled: true
    inject: true
    # 与 memory-core 共用同一个 MEMORY_PROMPT_MODE 标志位。
    # code: 项目/团队工作记忆；chat: 用户画像/生活记忆。
    promptMode: ${MEMORY_PROMPT_MODE:-code}
    # v1=现有 L2/L3 注入；v2=只注入 project/MEMORY.md 索引
    codeMemoryVersion: ${MEMORY_CODE_MEMORY_VERSION:-v1}
    writeL0: true
    recallL1: true
    injectL2L3: true

skill:
  endpoint: "http://memory-core:8420"
  serviceToken: "${MEMORY_CORE_GATEWAY_API_KEY}"

# L0.5 task-summary tips（Code Memory v2）
tips:
  enabled: ${MEMORY_TIPS_ENABLED:-true}
  reminderEnabled: ${MEMORY_TIPS_REMINDER_ENABLED:-true}
  maxReminderPerTask: ${MEMORY_TIPS_MAX_REMINDER_PER_TASK:-50}
  reminderCooldownSeconds: ${MEMORY_TIPS_REMINDER_COOLDOWN_SECONDS:-600}
  firstUserReminder: ${MEMORY_TIPS_FIRST_USER_REMINDER:-true}
  count1Threshold: ${MEMORY_TIPS_COUNT1_THRESHOLD:-2}
  count2Threshold: ${MEMORY_TIPS_COUNT2_THRESHOLD:-2}
  timeReminderSeconds: ${MEMORY_TIPS_TIME_REMINDER_SECONDS:-480}
  sessionTtlSeconds: ${MEMORY_TIPS_SESSION_TTL_SECONDS:-7200}

# Codex 内部请求 prompt 前缀（标题生成 / 安全审批），命中后跳过 L0 写入。
codexInternal:
  promptPrefixes:
${CODEX_INTERNAL_PROMPT_PREFIXES_YAML}

# Team Notes 走 knowledge 服务（memory-hub :8424）；数据面自身不校验成员关系，
# 由 proxy bridge 注入 session 身份后再转发。
knowledge:
  enabled: true
  endpoint: "http://memory-hub:8424"
  serviceToken: "${MEMORY_CORE_GATEWAY_API_KEY}"
  serviceId: default
  timeoutMs: 5000
  # Team Notes write access for the Agent (read is always enabled).
  allowLlmWrite: ${MEMORY_NOTES_ALLOW_LLM_WRITE:-true}

auth:
  enabled: $(bool $PROXY_ENABLE_AUTH)
  url: "http://memory-core:8420"
  timeoutMs: 5000

sessionInit:
  enabled: $(bool $PROXY_ENABLE_SESSION_INIT)
  maxRetries: 3
  injectAgentContext: true
  injectTaskContext: true
  headerAutoSelect:
    enabled: true
    teamHeader: "x-team-id"
    agentHeader: "x-agent-id"
    taskHeader: "x-task-id"
    onMismatch: "bypass"
${DEBUG_FORCE_IDENTITY_YAML}

costGuard:
  enabled: false

# 打开 skill + knowledge + tdai-memory + notes + summary-tips 注入器；
# knowledge 依赖 memory-hub 起来，否则 hook 内部会降级为空块。
injection:
  enabled: true
  externalGatewayUrl: "${PROXY_PUBLIC_BASE_URL}"
  injectors:
    - skill
    - knowledge
    - tdai-memory
    - notes
    - summary-tips

redis:
  enabled: false
YAML

info "启动 proxy (image=$PROXY_IMAGE, port=$PROXY_PORT, sourceMounts=$DEV_SOURCE_MOUNTS)"
if [[ "$DEV_SOURCE_MOUNTS" == "1" ]]; then
$DOCKER run -d --name "$CONTAINER" \
  --network "$NETWORK" \
  --network-alias proxy \
  --add-host=host.docker.internal:host-gateway \
  --restart "$RESTART_POLICY" \
  -p "${PROXY_PORT}:8096" \
  "${TZ_ARGS[@]}" \
  -e PROXY_UPSTREAM_MODEL="$PROXY_UPSTREAM_MODEL" \
  -v "$PROXY_VOLUME:/data/tdai-memory-proxy" \
  -v "$CONFIG_FILE:/data/config.yaml:ro" \
  -v "$REPO_ROOT/MemoryProxy/src/tdai/recorder.ts:/app/src/tdai/recorder.ts:ro" \
  -v "$REPO_ROOT/MemoryProxy/src/common/user-query-extractor.ts:/app/src/common/user-query-extractor.ts:ro" \
  -v "$REPO_ROOT/MemoryProxy/src/common/request-body-encoding.ts:/app/src/common/request-body-encoding.ts:ro" \
  -v "$REPO_ROOT/MemoryProxy/src/types.ts:/app/src/types.ts:ro" \
  -v "$REPO_ROOT/MemoryProxy/src/config.ts:/app/src/config.ts:ro" \
  -v "$REPO_ROOT/MemoryProxy/src/handler.ts:/app/src/handler.ts:ro" \
  -v "$REPO_ROOT/MemoryProxy/src/anthropicHandler.ts:/app/src/anthropicHandler.ts:ro" \
  -v "$REPO_ROOT/MemoryProxy/src/routes/whitelist.ts:/app/src/routes/whitelist.ts:ro" \
  -v "$REPO_ROOT/MemoryProxy/src/guard-adapter.ts:/app/src/guard-adapter.ts:ro" \
  -v "$REPO_ROOT/MemoryProxy/src/server.ts:/app/src/server.ts:ro" \
  -v "$REPO_ROOT/MemoryProxy/src/memory/memory-bridge.ts:/app/src/memory/memory-bridge.ts:ro" \
  -v "$REPO_ROOT/MemoryProxy/src/tdai/client.ts:/app/src/tdai/client.ts:ro" \
  -v "$REPO_ROOT/MemoryProxy/src/tdai/types.ts:/app/src/tdai/types.ts:ro" \
  -v "$REPO_ROOT/MemoryProxy/src/notes-bridge.ts:/app/src/notes-bridge.ts:ro" \
  -v "$REPO_ROOT/MemoryProxy/src/tips-bridge.ts:/app/src/tips-bridge.ts:ro" \
  -v "$REPO_ROOT/MemoryProxy/src/db/tips-reminder-repo.ts:/app/src/db/tips-reminder-repo.ts:ro" \
  -v "$REPO_ROOT/MemoryProxy/src/db/schema.ts:/app/src/db/schema.ts:ro" \
  -v "$REPO_ROOT/MemoryProxy/src/injection/injectors/summary-tips-contract-injector.ts:/app/src/injection/injectors/summary-tips-contract-injector.ts:ro" \
  -v "$REPO_ROOT/MemoryProxy/src/injection/index.ts:/app/src/injection/index.ts:ro" \
  -v "$REPO_ROOT/MemoryProxy/src/injection/injectors/note-tools-injector.ts:/app/src/injection/injectors/note-tools-injector.ts:ro" \
  -v "$REPO_ROOT/MemoryProxy/src/injection/pipeline.ts:/app/src/injection/pipeline.ts:ro" \
  -v "$REPO_ROOT/MemoryProxy/src/injection/injectors/tdai-profile-memory-injector.ts:/app/src/injection/injectors/tdai-profile-memory-injector.ts:ro" \
  -v "$REPO_ROOT/MemoryProxy/src/injection/injectors/tdai-tools-injector.ts:/app/src/injection/injectors/tdai-tools-injector.ts:ro" \
  -v "$REPO_ROOT/MemoryProxy/src/injection/injectors/tdai-l1-recall-injector.ts:/app/src/injection/injectors/tdai-l1-recall-injector.ts:ro" \
  -v "$REPO_ROOT/MemoryProxy/src/session/session-key.ts:/app/src/session/session-key.ts:ro" \
  -v "$REPO_ROOT/MemoryProxy/src/session/codebuddy/init.ts:/app/src/session/codebuddy/init.ts:ro" \
  -v "$REPO_ROOT/MemoryProxy/src/session/claude-code/init.ts:/app/src/session/claude-code/init.ts:ro" \
  -v "$REPO_ROOT/MemoryProxy/src/session/preset.ts:/app/src/session/preset.ts:ro" \
  -v "$REPO_ROOT/MemoryProxy/src/tdai/memory-mode.ts:/app/src/tdai/memory-mode.ts:ro" \
  -v "$REPO_ROOT/MemoryProxy/src/session/types.ts:/app/src/session/types.ts:ro" \
  -v "$REPO_ROOT/MemoryProxy/src/session/store.ts:/app/src/session/store.ts:ro" \
  "$PROXY_IMAGE" >/dev/null
else
$DOCKER run -d --name "$CONTAINER" \
  --network "$NETWORK" \
  --network-alias proxy \
  --add-host=host.docker.internal:host-gateway \
  --restart "$RESTART_POLICY" \
  -p "${PROXY_PORT}:8096" \
  "${TZ_ARGS[@]}" \
  -e PROXY_UPSTREAM_MODEL="$PROXY_UPSTREAM_MODEL" \
  -v "$PROXY_VOLUME:/data/tdai-memory-proxy" \
  -v "$CONFIG_FILE:/data/config.yaml:ro" \
  "$PROXY_IMAGE" >/dev/null
fi

wait_healthy "$CONTAINER" 90
ok "proxy 已启动 → http://localhost:${PROXY_PORT}/"
ok "  用法：把 coding agent 的 API base 指向 http://localhost:${PROXY_PORT}"
