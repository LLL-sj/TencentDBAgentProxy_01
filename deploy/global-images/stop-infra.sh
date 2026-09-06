#!/usr/bin/env bash
# 停止并移除基础设施容器；默认保留数据卷。
# ./stop-infra.sh --purge 会同时删除 clickhouse/postgres 数据卷。

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_lib.sh
source "$SCRIPT_DIR/_lib.sh"

PURGE=0
if [[ "${1:-}" == "--purge" ]]; then PURGE=1; fi

for c in tdai-langfuse tdai-postgres tdai-clickhouse tdai-redis; do
  if $DOCKER ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$c"; then
    info "停止并移除 $c"
    $DOCKER rm -f "$c" >/dev/null
  else
    info "$c 未运行，跳过"
  fi
done

if (( PURGE == 1 )); then
  for v in tdai-clickhouse-data tdai-postgres-data; do
    if $DOCKER volume inspect "$v" >/dev/null 2>&1; then
      $DOCKER volume rm "$v" >/dev/null && ok "已删除 volume $v" || warn "删除 volume $v 失败"
    fi
  done
fi

ok "基础设施容器已停止。"
