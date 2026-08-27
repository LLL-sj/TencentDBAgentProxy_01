#!/usr/bin/env bash
# 单独拉起 memory-core（内核 gateway，端口 8420），首次启动自动 init-admin +
# 把生成的 user_key 持久化到 .admin-key 供 proxy / claude-code 使用。
#
# 用法：
#   ./start-memory-core.sh
#
# 数据持久化到 named volume（默认 tdai-memory-core-data，可在 .env 改 MEMORY_CORE_VOLUME）。
# 重复执行会先移除旧容器再启新的，volume 数据保留 —— admin user_key 也随之保留。

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# shellcheck source=./_lib.sh
source "$SCRIPT_DIR/_lib.sh"

load_env
require_vars MEMORY_CORE_IMAGE MEMORY_CORE_PORT MEMORY_CORE_VOLUME

# ── Gateway 内部管理凭据 ─────────────────────────────────────────
# 用 ${VAR-default}（不是 :-default）：允许 .env 里显式设为空字符串来关闭 Bearer gate。
#
# 当前 memory-core 的 Bearer gate 与 proxy auth 存在**已知不兼容**：proxy 调
# /v3/meta/auth/verify 时不带 Bearer（源码遗漏，见 MemoryProxy/src/auth.ts），
# 所以 proxy 启用 auth 时必须把 MEMORY_CORE_GATEWAY_API_KEY 留空。默认已置空。
MEMORY_CORE_GATEWAY_API_KEY="${MEMORY_CORE_GATEWAY_API_KEY-}"
MEMORY_CORE_ADMIN_USERNAME="${MEMORY_CORE_ADMIN_USERNAME:-admin}"

# admin user_key 持久化位置（宿主机侧；volume 数据被清后需一并删掉此文件）
ADMIN_KEY_FILE="${MEMORY_CORE_ADMIN_KEY_FILE:-$SCRIPT_DIR/.admin-key}"

if [[ -n "$MEMORY_CORE_GATEWAY_API_KEY" ]]; then
  warn "MEMORY_CORE_GATEWAY_API_KEY 非空 —— proxy 的 sessionInit/auth 目前会因缺 Bearer 而失败。"
  warn "本地体验请把 .env 里的 MEMORY_CORE_GATEWAY_API_KEY 留空。"
fi

# 服务器模式：镜像已包含全部源码，默认不挂载仓库源码；本地开发热更新才设为 1。
DEV_SOURCE_MOUNTS="${TDAI_DEV_SOURCE_MOUNTS:-0}"
RESTART_POLICY="${TDAI_RESTART_POLICY:-no}"
TZ_ARGS=()
if [[ -n "${TDAI_TZ:-}" ]]; then
  TZ_ARGS=(-e "TZ=$TDAI_TZ")
fi

CONTAINER=tdai-memory-core
NETWORK=tdai-memory-stack

# 创建共享网络（幂等）
if ! $DOCKER network inspect "$NETWORK" >/dev/null 2>&1; then
  info "创建 docker 网络 $NETWORK"
  $DOCKER network create "$NETWORK" >/dev/null
fi

pull_image "$MEMORY_CORE_IMAGE"
rm_container_if_exists "$CONTAINER"

# ── 生成 gateway config.yaml，挂到容器 /data/config/tdai-gateway.yaml ──
# 默认镜像里没 config，memory-core 走编译时的默认（skill / knowledge 模块关闭）。
# 从 .env 里的 MEMORY_LLM_* 生成一份 standalone+skill 的最小配置。
CORE_CONFIG_DIR="${MEMORY_CORE_CONFIG_DIR:-$SCRIPT_DIR/.memory-core-config}"
mkdir -p "$CORE_CONFIG_DIR"
CORE_CONFIG_FILE="$CORE_CONFIG_DIR/tdai-gateway.yaml"
info "生成 gateway config → $CORE_CONFIG_FILE"
cat > "$CORE_CONFIG_FILE" <<YAML
# 由 start-memory-core.sh 自动生成 —— 每次启动覆盖，请不要手动改。
deployMode: standalone
stateBackend: local

server:
  port: 8420
  host: 0.0.0.0

data:
  baseDir: /data/tdai-memory

llm:
  baseUrl: "${MEMORY_LLM_BASE_URL:-}"
  apiKey: "${MEMORY_LLM_API_KEY:-}"
  model: "${MEMORY_LLM_MODEL:-}"
  maxTokens: 32000
  timeoutMs: 300000

memory:
  # promptMode: chat（通用聊天/教学场景）| code（项目/代码工程 Agent 记忆，
  # LLM 抽 work_fact/work_task/work_method/work_artifact，项目对话不抽个人画像）
  # 本项目默认 code；通过 .env 里 MEMORY_PROMPT_MODE 覆盖。
  promptMode: ${MEMORY_PROMPT_MODE:-code}
  codeMemoryVersion: ${MEMORY_CODE_MEMORY_VERSION:-v1}
  capture: { enabled: true }
  extraction:
    enabled: true
    enableDedup: true
    maxMemoriesPerSession: 20
  persona:
    triggerEveryN: ${MEMORY_L3_TRIGGER_EVERY_N:-10}
    maxScenes: 15
  pipeline:
    everyNConversations: ${MEMORY_L1_EVERY_N:-5}
    enableWarmup: ${MEMORY_PIPELINE_WARMUP:-true}
    l1IdleTimeoutSeconds: ${MEMORY_L1_IDLE_TIMEOUT_SECONDS:-240}
    l2DelayAfterL1Seconds: ${MEMORY_L2_DELAY_AFTER_L1_SECONDS:-30}
    l2MinIntervalSeconds: ${MEMORY_L2_MIN_INTERVAL_SECONDS:-180}
    l2MaxIntervalSeconds: ${MEMORY_L2_MAX_INTERVAL_SECONDS:-600}
    sessionActiveWindowHours: ${MEMORY_SESSION_ACTIVE_WINDOW_HOURS:-3}
  recall:
    enabled: true
    maxResults: 5
    scoreThreshold: 0.3
    strategy: hybrid
    timeoutMs: 5000
  storeBackend: sqlite
  embedding:
    provider: none
  # Code Memory v2 L1 短文本（默认值与 config.ts 保持一致）
  l1V2:
    summaryTipBlockTemplate: |-
      <SUMMARY_TIP id="{{tip_id}}" covers="{{l0_start_ref}}..{{l0_end_ref}}" tags="{{tags_csv}}">
      {{summary}}
      </SUMMARY_TIP>
    noSummaryTipsText: ${MEMORY_L1_V2_NO_SUMMARY_TIPS_TEXT:-（本批没有 Agent 提交的 SUMMARY_TIP）}
    summaryTipRuleText: ${MEMORY_L1_V2_SUMMARY_TIP_RULE_TEXT:-SUMMARY_TIP 是 Agent 对一段 L0 的高质量压缩总结，默认可信：L0 完整时用于确认重点和补全归纳；L0 不完整或已消费过时，可直接以 SUMMARY_TIP 为主提取。}

  # Code Memory v2 project experience packager（默认关，v1 行为不变）
  projectMemory:
    enabled: ${MEMORY_PROJECT_MEMORY_ENABLED:-false}
    minPendingTips: ${MEMORY_PROJECT_MEMORY_MIN_PENDING_TIPS:-3}
    minDistinctSessions: ${MEMORY_PROJECT_MEMORY_MIN_DISTINCT_SESSIONS:-2}
    packagerMinIntervalSeconds: ${MEMORY_PROJECT_MEMORY_MIN_INTERVAL_SECONDS:-300}
    packagerMaxIntervalSeconds: ${MEMORY_PROJECT_MEMORY_MAX_INTERVAL_SECONDS:-14400}
    maxTopics: ${MEMORY_PROJECT_MEMORY_MAX_TOPICS:-15}
    indexMaxChars: ${MEMORY_PROJECT_MEMORY_INDEX_MAX_CHARS:-6000}
    topicMaxChars: ${MEMORY_PROJECT_MEMORY_TOPIC_MAX_CHARS:-4000}

  # L0.5 task-summary tips（Code Memory v2）
  tips:
    enabled: ${MEMORY_TIPS_ENABLED:-true}
    reminderEnabled: ${MEMORY_TIPS_REMINDER_ENABLED:-true}
    maxReminderPerTask: ${MEMORY_TIPS_MAX_REMINDER_PER_TASK:-50}
    reminderCooldownSeconds: ${MEMORY_TIPS_REMINDER_COOLDOWN_SECONDS:-600}
    submitPath: /memory-bridge/v3/tips/submit

# ── Skill 模块 ──
skill:
  enabled: true
  routing:
    mode: bm25
    searchTopK: 20
  extraction:
    enabled: true
    maxIterations: 16
    queue:
      backend: local
      keyPrefix: tdai
      resultTtlSeconds: 86400
      lockTtlMs: 600000
      maxRetries: 2
      retryBackoffsMs: [5000, 15000]
  resources:
    maxResourceSizeBytes: 5000000
YAML

info "启动 memory-core (image=$MEMORY_CORE_IMAGE, port=$MEMORY_CORE_PORT, sourceMounts=$DEV_SOURCE_MOUNTS)"
if [[ "$DEV_SOURCE_MOUNTS" == "1" ]]; then
$DOCKER run -d --name "$CONTAINER" \
  --network "$NETWORK" \
  --network-alias memory-core \
  --restart "$RESTART_POLICY" \
  -p "${MEMORY_CORE_PORT}:8420" \
  "${TZ_ARGS[@]}" \
  -v "${MEMORY_CORE_VOLUME}:/data/tdai-memory" \
  -v "$CORE_CONFIG_FILE:/data/config/tdai-gateway.yaml:ro" \
  -v "$REPO_ROOT/MemoryCore/src/config.ts:/app/src/config.ts:ro" \
  -v "$REPO_ROOT/MemoryCore/src/core/store/sqlite.ts:/app/src/core/store/sqlite.ts:ro" \
  -v "$REPO_ROOT/MemoryCore/src/core/record/l1-extractor.ts:/app/src/core/record/l1-extractor.ts:ro" \
  -v "$REPO_ROOT/MemoryCore/src/utils/pipeline-factory.ts:/app/src/utils/pipeline-factory.ts:ro" \
  -v "$REPO_ROOT/MemoryCore/src/utils/project-memory-packager.ts:/app/src/utils/project-memory-packager.ts:ro" \
  -v "$REPO_ROOT/MemoryCore/src/core/tdai-core.ts:/app/src/core/tdai-core.ts:ro" \
  -v "$REPO_ROOT/MemoryCore/src/core/prompts:/app/src/core/prompts:ro" \
  -v "$REPO_ROOT/MemoryCore/src/core/tips:/app/src/core/tips:ro" \
  -v "$REPO_ROOT/MemoryCore/src/gateway/v2-router.ts:/app/src/gateway/v2-router.ts:ro" \
  -v "$REPO_ROOT/MemoryCore/src/gateway/v2-schemas.ts:/app/src/gateway/v2-schemas.ts:ro" \
  -v "$REPO_ROOT/MemoryCore/src/gateway/server.ts:/app/src/gateway/server.ts:ro" \
  -v "$REPO_ROOT/MemoryCore/src/core/memory-mode.ts:/app/src/core/memory-mode.ts:ro" \
  -v "$REPO_ROOT/MemoryCore/src/core/state/types.ts:/app/src/core/state/types.ts:ro" \
  -v "$REPO_ROOT/MemoryCore/src/core/state/local-backend.ts:/app/src/core/state/local-backend.ts:ro" \
  -v "$REPO_ROOT/MemoryCore/src/utils/checkpoint.ts:/app/src/utils/checkpoint.ts:ro" \
  -v "$REPO_ROOT/MemoryCore/src/utils/stateful-pipeline-manager.ts:/app/src/utils/stateful-pipeline-manager.ts:ro" \
  -e TDAI_GATEWAY_PORT=8420 \
  -e TDAI_GATEWAY_HOST=0.0.0.0 \
  -e TDAI_GATEWAY_API_KEY="$MEMORY_CORE_GATEWAY_API_KEY" \
  -e TDAI_DATA_DIR=/data/tdai-memory \
  "$MEMORY_CORE_IMAGE" >/dev/null
else
$DOCKER run -d --name "$CONTAINER" \
  --network "$NETWORK" \
  --network-alias memory-core \
  --restart "$RESTART_POLICY" \
  -p "${MEMORY_CORE_PORT}:8420" \
  "${TZ_ARGS[@]}" \
  -v "${MEMORY_CORE_VOLUME}:/data/tdai-memory" \
  -v "$CORE_CONFIG_FILE:/data/config/tdai-gateway.yaml:ro" \
  -e TDAI_GATEWAY_PORT=8420 \
  -e TDAI_GATEWAY_HOST=0.0.0.0 \
  -e TDAI_GATEWAY_API_KEY="$MEMORY_CORE_GATEWAY_API_KEY" \
  -e TDAI_DATA_DIR=/data/tdai-memory \
  "$MEMORY_CORE_IMAGE" >/dev/null
fi

wait_healthy "$CONTAINER" 90
ok "memory-core 已启动 → http://localhost:${MEMORY_CORE_PORT}/"

# ── Admin user 生命周期 ─────────────────────────────────────────
# 首次启动：init-admin 时**传入我们生成的随机 user_key**，返回体里读回来存文件。
# 重启且已初始化（409）：优先读 .admin-key；若 volume 是新造的但 .admin-key 是
#   旧的，无法恢复（volume/key 必须同步；提示用户清理）。
#
# init-admin 接口尊重传入的 user_key（见 MemoryCore/src/metadata/store/sqlite-adapter.ts
# defaultKeyValue = input.default_key_value ?? generateUserKey()）；只要 volume 空、
# 我们传固定 key，就能拿到自己指定的 key。首次启动时脚本生成一把 32 字节随机
# base32url —— 每台机器/每次 purge 都是独立 key，不会撞车。

generate_user_key() {
  # sk-mem-<32 chars A-Za-z0-9>，与 metadata/utils/user-key.ts 的格式一致
  # 用 openssl（可移植；tr 过滤 base64 里的 +/= 到 32 位）
  local raw
  if command -v openssl >/dev/null 2>&1; then
    raw=$(openssl rand -base64 48 | LC_ALL=C tr -dc 'A-Za-z0-9' | head -c 32)
  else
    # 兜底：读足够多的 urandom 保证过滤后 >=32
    raw=$(head -c 256 /dev/urandom | LC_ALL=C tr -dc 'A-Za-z0-9' | head -c 32)
  fi
  echo "sk-mem-${raw}"
}

verify_user_key() {
  local key="$1"
  local code
  code=$(/usr/bin/curl -sS -o /dev/null -w "%{http_code}" --max-time 5 \
    -X POST -H "Content-Type: application/json" \
    -H "x-tdai-service-id: default" \
    ${MEMORY_CORE_GATEWAY_API_KEY:+-H "Authorization: Bearer ${MEMORY_CORE_GATEWAY_API_KEY}"} \
    "http://localhost:${MEMORY_CORE_PORT}/v3/meta/auth/verify" \
    -d "$(printf '{"user_key":"%s"}' "$key")" 2>/dev/null || echo "000")
  [[ "$code" == "200" ]]
}

info "初始化 admin user（username=${MEMORY_CORE_ADMIN_USERNAME}, key 持久化 → $ADMIN_KEY_FILE）..."

# 生成随机 key（首次 init-admin 用；若之前有 file 就复用）
if [[ -s "$ADMIN_KEY_FILE" ]]; then
  ADMIN_KEY=$(cat "$ADMIN_KEY_FILE")
  info "  复用已保存的 admin key（.admin-key 已存在）"
else
  ADMIN_KEY=$(generate_user_key)
fi

init_body=$(printf '{"username":"%s","user_key":"%s"}' \
  "$MEMORY_CORE_ADMIN_USERNAME" "$ADMIN_KEY")
init_resp=$(/usr/bin/curl -sS -o /tmp/init-admin.$$ -w "%{http_code}" \
  -X POST -H "Content-Type: application/json" \
  ${MEMORY_CORE_GATEWAY_API_KEY:+-H "Authorization: Bearer ${MEMORY_CORE_GATEWAY_API_KEY}"} \
  -H "x-tdai-service-id: default" \
  "http://localhost:${MEMORY_CORE_PORT}/v3/internal/meta/user/init-admin" \
  -d "$init_body" 2>/dev/null || echo "000")

case "$init_resp" in
  200)
    ok "admin user 已创建"
    # 落盘 key（把宿主机 file 的权限收紧）
    umask 077
    echo -n "$ADMIN_KEY" > "$ADMIN_KEY_FILE"
    ok "  admin user_key 已保存到 $ADMIN_KEY_FILE"
    ;;
  409)
    if [[ -s "$ADMIN_KEY_FILE" ]]; then
      ok "admin user 已存在（跳过 init-admin，用 $ADMIN_KEY_FILE 里的 key）"
    else
      warn "admin user 已存在，但 $ADMIN_KEY_FILE 缺失，无法恢复 user_key。"
      warn "选项 A: 清理 volume 重建 —— ./stop-all.sh --purge && ./start-memory-core.sh"
      warn "选项 B: 手动创建新 admin user_key（需要旧 key 或 gateway apiKey）"
    fi
    ;;
  *)
    warn "init-admin 返回 HTTP=${init_resp}，可能需要手动排查："
    cat /tmp/init-admin.$$ 2>/dev/null; echo
    ;;
esac
rm -f /tmp/init-admin.$$

# ── 校验 admin key 可用 ─────────────────────────────────────────
if [[ -s "$ADMIN_KEY_FILE" ]]; then
  ADMIN_KEY=$(cat "$ADMIN_KEY_FILE")
  if verify_user_key "$ADMIN_KEY"; then
    # 只在末尾做脱敏输出：整串路径 masked，让终端历史里不留全值
    masked="${ADMIN_KEY:0:11}****${ADMIN_KEY: -4}"
    ok "admin user_key 校验通过（auth/verify 200）—— $masked"
    ok "  key file: $ADMIN_KEY_FILE"
  else
    warn "admin user_key 校验失败（auth/verify 非 200）。检查 $ADMIN_KEY_FILE 与 volume 是否匹配。"
  fi
fi
