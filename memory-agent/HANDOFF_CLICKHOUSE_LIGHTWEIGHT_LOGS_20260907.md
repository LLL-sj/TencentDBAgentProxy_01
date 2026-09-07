# Handoff：ClickHouse 高频写入优化 + Proxy 轻量 JSONL 日志

> 日期：2026-09-07
> 分支：`feat/server_team`
> 状态：已完成本地代码修改、镜像构建、远程部署与验证；后经用户确认清理了 ClickHouse 容器/镜像，并清理旧回滚镜像与离线 tar 包，保留数据卷。
> 关联文档：
> - `AGENT_INDEX.md`（运维入口，新增 4.5 Token/耗时查询）
> - `HANDOFF_TIMING_STATISTICS_20260907.md`（耗时统计来源背景）
> - `PERFORMANCE_TIMING_EXECUTION_PLAN.md`（request_stage_timings 设计）

---

## 1. 一句话结论

ClickHouse 在当前规模下被高频小批量 INSERT 打高 CPU。已不再作为 Proxy 的主动统计写入目标，改为 Proxy 本地轻量 JSONL 日志 + Node 查询脚本；原 ClickHouse 数据卷保留，远程容器/镜像及旧离线 tar 包已按用户确认清理。

---

## 2. 背景与根因

### 2.1 现象

- ClickHouse 进程 CPU 曾高达 90%+，系统接近满载。
- ClickHouse 日志中大量 `INSERT INTO usage_logs`、`INSERT INTO usage_raw`、`INSERT INTO request_stage_timings`。
- 单条 INSERT 耗时不高，但频率高、批次小。

### 2.2 根因

- Proxy 每个请求结束后都会异步写 ClickHouse：
  - `usage_logs`：1 条主用量；
  - `usage_raw`：1 条 `non_tokenhub`；
  - `usage_raw`：额外 1 条 `report_failed`（credit report URL 未配置/不可达时）；
  - `request_stage_timings`：1 条请求耗时。
- ClickHouse 对每次 INSERT 都要做压缩/编码/排序/生成 part/后台 merge，频繁小批次写入会显著消耗 CPU。
- 当前数据量小，ClickHouse 的“海量日志分析”优势没发挥，反而带来额外维护开销。

---

## 3. 已完成改动（本地）

| 文件 | 改动 |
|---|---|
| `MemoryProxy/src/report/file-logger.ts` | `proxy.log` 从 `[timestamp][LEVEL] event {...}` 改为纯 JSONL：每行 `{"timestamp":...,"level":...,"event":...,"data":{...}}` |
| `MemoryProxy/scripts/query_usage_stats.mjs` | 新增 Node 脚本：解析 JSONL 与旧日志格式，统计 Token / 耗时 / P50 / P90 |
| `deploy/global-images/start-proxy.sh` | `PROXY_LOG_FILE` 默认值改为 `/data/tdai-memory-proxy/logs`，未显式设置也会启用轻量日志 |
| `deploy/global-images/.env.example` | 增加 `PROXY_LOG_FILE` 示例与说明 |
| `memory-agent/AGENT_INDEX.md` | 新增 4.5 Token/耗时查询；说明 ClickHouse 当前状态 |

### 3.1 日志落盘位置

```text
/data/tdai-memory-proxy/logs/proxy.log          # 结构化 JSONL：request.timing 等
/data/tdai-memory-proxy/logs/YYYY-MM-DD.jsonl   # Token 用量日志
```

### 3.2 查询脚本用法

```bash
# 在 proxy 容器内
docker exec tdai-proxy node /app/scripts/query_usage_stats.mjs /data/tdai-memory-proxy/logs

# 在本仓库
node MemoryProxy/scripts/query_usage_stats.mjs /path/to/logs
```

---

## 4. 远程已执行操作

远程服务器：`8.133.220.36`（root SSH 已在历史交接中记录，不再重复密钥内容）。

1. 本地导出并上传：
   - `backups/tdai-memory-proxy-local-jsonl-20260907.tar.gz`
   - 远程目标：`/root/tdai-memory/images/tdai-memory-proxy-local-jsonl-20260907.tar.gz`
2. 远程 `docker load` 新 proxy 镜像。
3. 修改远程 `.env`（未改动其它密钥/配置）：
   - `CLICKHOUSE_ENABLED=0`
   - 新增 `PROXY_LOG_FILE=/data/tdai-memory-proxy/logs`
4. 重启 `tdai-proxy`。
5. `docker stop tdai-clickhouse`：停止 ClickHouse 容器，保留 `tdai-clickhouse-data` 数据卷。
6. 经用户确认后清理：`docker rm tdai-clickhouse && docker rmi clickhouse/clickhouse-server:24.8`，释放约 807MB。
7. 经用户确认后再次清理：删除 `local-before-*` 回滚镜像与 `/root/tdai-memory/images/` 下全部 tar.gz，远程磁盘使用从约 16G 降到约 9.5G。

远程验证结果：

- `tdai-proxy` healthy，镜像 ID：`84cdc6177fa4`
- `.proxy-config/config.yaml`：`clickhouse.enabled: false`、`log.file: /data/tdai-memory-proxy/logs`
- 发送测试请求后生成了 `proxy.log` 与当日 `.jsonl`
- 执行查询脚本成功输出 Token/耗时统计
- ClickHouse 日志中无新 INSERT
- 清理后 `tdai-clickhouse` 容器/镜像不存在，`local-before-*` 回滚镜像和 `/root/tdai-memory/images/*.tar.gz` 也已删除；`tdai-clickhouse-data` 数据卷保留

---

## 5. 当前远程状态

| 项 | 状态 |
|---|---|
| `tdai-memory-core` | healthy，当前镜像 |
| `tdai-memory-hub` | healthy，当前镜像 |
| `tdai-proxy` | healthy，新 JSONL 日志镜像 |
| `tdai-clickhouse` | **已移除容器和镜像**（数据卷保留） |
| 旧回滚镜像 / tar 包 | **已清理**（`local-before-*` 与 `/root/tdai-memory/images/*.tar.gz` 已删除） |
| Proxy 新统计 | 写入 `/data/tdai-memory-proxy/logs` |
| ClickHouse 新统计 | 不再写入 |

---

## 6. 遗留事项 / 后续可做

1. **旧镜像与 tar 包清理（已完成）**
   - 已执行 `docker image prune -f`，清掉无 tag 旧 proxy 镜像，释放约 374.6MB。
   - 后经用户确认删除 `local-before-*` 回滚镜像与 `/root/tdai-memory/images/` 下全部 tar.gz；当前 `/root/tdai-memory/images/` 为空。
2. **CREDIT_REPORT 日志噪音**
   - `CREDIT_REPORT ... fetch failed` 仍会写进 `proxy.log`，但现在不会写 ClickHouse。
   - 若想消除日志噪音，后续可在配置中显式关闭 credit report。
3. **ClickHouse 容器/镜像已移除，数据卷保留**
   - 当前不再运行 ClickHouse，也不需要镜像；`tdai-clickhouse-data` 数据卷仍保留。
   - `/root/tdai-memory/images/` 下 ClickHouse/Redis/Postgres/Langfuse/TDAI 的 tar.gz 已按用户确认全部清理。
   - 如需彻底删除历史数据/卷，需要人工确认，不能直接 `--purge`。
   - 若确需恢复 ClickHouse，需要从外部源/备份重新获得离线镜像，当前服务器本地无该 tar 包。
4. **已知 UI/权限问题仅记录不擅自改**
   - Skill UI 对非 owner 显示编辑/删除按钮仍是已知问题，本次未改。

---

## 7. 给下一位检查/执行者的检查命令

```bash
# 登录远程
ssh root@8.133.220.36

# 关键配置确认（不要输出密钥值）
cd /root/tdai-memory/deploy/global-images
grep -nE '^(CLICKHOUSE_ENABLED|PROXY_LOG_FILE)' .env

# 容器状态
docker ps --filter name=tdai-memory
docker ps --filter name=tdai-clickhouse   # 预期为空
# 镜像状态
docker images | grep clickhouse   # 预期为空
# 离线包目录
ls -lh /root/tdai-memory/images/ 2>/dev/null   # 当前预期为空/不存在

# proxy 日志统计验证
docker exec tdai-proxy node /app/scripts/query_usage_stats.mjs /data/tdai-memory-proxy/logs

# 查看轻量日志
docker exec tdai-proxy ls -l /data/tdai-memory-proxy/logs
docker exec tdai-proxy tail -n 20 /data/tdai-memory-proxy/logs/proxy.log
```

---

## 8. 回滚方法

- 需要恢复 ClickHouse 统计：
  - 先获取 ClickHouse 离线镜像（当前服务器 `/root/tdai-memory/images/` 已清理，需从外部源/备份重新获得），再执行 `docker load -i <离线镜像>`
  - 远程 `.env`：`CLICKHOUSE_ENABLED=1`
  - `cd /root/tdai-memory/deploy/global-images && ./start-infra.sh`（会重建 `tdai-clickhouse`，复用 `tdai-clickhouse-data` 数据卷）
  - `./start-proxy.sh`
- 需要回退 proxy 镜像：
  - 旧回滚 tag `agentmemory/memory-proxy:local-before-cde-20260907` 已删除；如需回退，需从外部备份重新导入对应旧镜像。
