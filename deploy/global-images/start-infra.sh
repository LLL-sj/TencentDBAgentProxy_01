#!/usr/bin/env bash
# 启动可观测/基础设施组件：Redis、ClickHouse、Postgres、Langfuse。
# 使用前在 .env 配置对应 *_ENABLED 和密码/密钥。
# 启动顺序：postgres -> clickhouse/redis -> langfuse。

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_lib.sh
source "$SCRIPT_DIR/_lib.sh"

load_env

NETWORK=tdai-memory-stack
RESTART_POLICY="${TDAI_RESTART_POLICY:-no}"
TZ_ARGS=()
if [[ -n "${TDAI_TZ:-}" ]]; then TZ_ARGS=(-e "TZ=$TDAI_TZ"); fi

if ! $DOCKER network inspect "$NETWORK" >/dev/null 2>&1; then
  info "创建 docker 网络 $NETWORK"
  $DOCKER network create "$NETWORK" >/dev/null
fi

# ── Redis ───────────────────────────────────────────────────────────
if [[ "${REDIS_ENABLED:-0}" == "1" ]]; then
  require_vars REDIS_HOST_PORT REDIS_PASSWORD
  info "启动 redis (port=$REDIS_HOST_PORT)"
  rm_container_if_exists tdai-redis
  $DOCKER run -d --name tdai-redis \
    --network "$NETWORK" \
    --network-alias tdai-redis \
    --restart "$RESTART_POLICY" \
    "${TZ_ARGS[@]}" \
    -p "${REDIS_HOST_PORT}:6379" \
    redis:7 redis-server --requirepass "$REDIS_PASSWORD" --appendonly no >/dev/null
  wait_healthy tdai-redis 60
  ok "redis 已启动 → localhost:${REDIS_HOST_PORT}"
else
  info "REDIS_ENABLED=0，跳过 redis"
fi

# ── ClickHouse ──────────────────────────────────────────────────────
if [[ "${CLICKHOUSE_ENABLED:-0}" == "1" ]]; then
  require_vars CLICKHOUSE_HTTP_PORT CLICKHOUSE_TCP_PORT CLICKHOUSE_USER CLICKHOUSE_PASSWORD CLICKHOUSE_DB
  info "启动 clickhouse (http=$CLICKHOUSE_HTTP_PORT, tcp=$CLICKHOUSE_TCP_PORT)"
  rm_container_if_exists tdai-clickhouse
  $DOCKER run -d --name tdai-clickhouse \
    --network "$NETWORK" \
    --network-alias tdai-clickhouse \
    --restart "$RESTART_POLICY" \
    "${TZ_ARGS[@]}" \
    -p "${CLICKHOUSE_HTTP_PORT}:8123" \
    -p "${CLICKHOUSE_TCP_PORT}:9000" \
    -v tdai-clickhouse-data:/var/lib/clickhouse \
    -e CLICKHOUSE_USER="$CLICKHOUSE_USER" \
    -e CLICKHOUSE_PASSWORD="$CLICKHOUSE_PASSWORD" \
    -e CLICKHOUSE_DB="$CLICKHOUSE_DB" \
    -e CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1 \
    clickhouse/clickhouse-server:24.8 >/dev/null
  wait_healthy tdai-clickhouse 90
  ok "clickhouse 已启动 → http://localhost:${CLICKHOUSE_HTTP_PORT}"
else
  info "CLICKHOUSE_ENABLED=0，跳过 clickhouse"
fi

# ── Postgres + Langfuse ─────────────────────────────────────────────
if [[ "${LANGFUSE_ENABLED:-0}" == "1" ]]; then
  require_vars LANGFUSE_PORT LANGFUSE_PUBLIC_URL LANGFUSE_NEXTAUTH_SECRET LANGFUSE_SALT LANGFUSE_ENCRYPTION_KEY
  require_vars POSTGRES_DB POSTGRES_USER POSTGRES_PASSWORD

  info "启动 postgres (供 langfuse 使用，不映射宿主端口)"
  rm_container_if_exists tdai-postgres
  $DOCKER run -d --name tdai-postgres \
    --network "$NETWORK" \
    --network-alias tdai-postgres \
    --restart "$RESTART_POLICY" \
    "${TZ_ARGS[@]}" \
    -v tdai-postgres-data:/var/lib/postgresql/data \
    -e POSTGRES_DB="$POSTGRES_DB" \
    -e POSTGRES_USER="$POSTGRES_USER" \
    -e POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
    postgres:16 >/dev/null
  wait_healthy tdai-postgres 120

  info "启动 langfuse (port=$LANGFUSE_PORT, public=$LANGFUSE_PUBLIC_URL)"
  rm_container_if_exists tdai-langfuse
  $DOCKER run -d --name tdai-langfuse \
    --network "$NETWORK" \
    --network-alias tdai-langfuse \
    --restart "$RESTART_POLICY" \
    "${TZ_ARGS[@]}" \
    -p "${LANGFUSE_PORT}:3000" \
    -e DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@tdai-postgres:5432/${POSTGRES_DB}" \
    -e NEXTAUTH_URL="$LANGFUSE_PUBLIC_URL" \
    -e NEXTAUTH_SECRET="$LANGFUSE_NEXTAUTH_SECRET" \
    -e SALT="$LANGFUSE_SALT" \
    -e ENCRYPTION_KEY="$LANGFUSE_ENCRYPTION_KEY" \
    -e TELEMETRY_ENABLED=false \
    langfuse/langfuse:2 >/dev/null
  wait_healthy tdai-langfuse 120
  ok "langfuse 已启动 → ${LANGFUSE_PUBLIC_URL}"
else
  info "LANGFUSE_ENABLED=0，跳过 postgres/langfuse"
fi

ok "基础设施组件启动完成。"
