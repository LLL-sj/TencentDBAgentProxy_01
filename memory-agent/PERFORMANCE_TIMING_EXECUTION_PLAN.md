# Proxy 请求分阶段耗时统计 — 执行方案

> 目标：准确区分“模型厂商耗时 / Proxy 自身耗时 / 服务端到客户端网络发送耗时”，
> 并将粗粒度阶段耗时异步写入 ClickHouse，供长期聚合统计使用。

---

## 1. 核心原则

1. **不按 token/chunk 记录**，不记录 10000 条。
2. 流式响应只记录几个整段时间点，不把上游生成时间误算成 Proxy 本地时间。
3. 用户响应的结束标志不能被统计写入阻塞。
4. 统计结果异步写入 ClickHouse，使用类似现有 `trackWrite()` 的模式。
5. 非流式 L0 也统一改为异步 `trackWrite()`，与流式保持一致。
6. OpenAI/Responses SSE 在 EOF 时先关闭用户流，再异步 finalize。

---

## 2. 要统计的阶段

### 2.1 统一定义时间点

| 记号 | 含义 | 是否可观测 |
|---|---|---|
| `t0` | 请求进入 handler | 代码开始处 |
| `t1` | 解析/auth/session/hook 注入完成 | 当前 `pipe` 创建处附近 |
| `t2` | 构建完上游 headers/body，开始请求上游 | `pipe.forwardStart()` 前 |
| `t3` | 收到上游首响应/首 chunk | `pipe.forwardDone()` / 进入 stream 分支 |
| `t4` | 收到上游流式结束标志 / 上游 body EOF | 流 readDone |
| `t5` | Proxy 已把结束标志/EOF 交给用户侧框架 | `controller.close()` 前 |
| `t6` | Node `ServerResponse` `finish` 触发 | 底层事件 |
| `t7` | 异步后处理完成（L0/统计写入） | 后台，不阻塞用户 |

### 2.2 记录字段（ClickHouse 一行一条请求）

```text
request_id
timestamp
model
protocol
session_key
stream

total_ms
local_prepare_ms
build_request_ms
upstream_ttfb_ms
upstream_stream_ms
proxy_tail_ms
client_network_tail_ms
postprocess_ms
```

各字段口径：

| 字段 | 计算 | 说明 |
|---|---|---|
| `local_prepare_ms` | `t1 - t0` | 解析请求、鉴权、session、hook 注入 |
| `build_request_ms` | `t2 - t1` | 构造上游 headers/body |
| `upstream_ttfb_ms` | `t3 - t2` | 从发出到收到上游首响应 |
| `upstream_stream_ms` | `t4 - t3` | 模型厂商流式输出完整时长 |
| `proxy_tail_ms` | `t5 - t4` | 上游结束后 Proxy 到返回用户结束标志的处理/发送尾部 |
| `client_network_tail_ms` | `t6 - t5` | 服务端把响应交给系统 socket 到 finish 的网络发送尾部 |
| `postprocess_ms` | `t7 - t6` | 统计/L0/上报等异步后处理耗时（不阻塞用户） |
| `total_ms` | `t6 - t0` | 用户可感知总耗时（到 Node finish） |

> `client_network_tail_ms` 是服务端能拿到的最接近“服务器→用户网络开销”的指标。
> `finish` 表示已交给系统 TCP 发送缓冲，不是客户端业务层已收到。

---

## 3. 流式响应重点

流式时，时间线存在重叠：

```text
t0 ─────── t1 ── t2 ── t3 ────────────────── t4 ── t5 ── t6
                本地准备       ↑ 上游流式输出 ↑
                               t3 → t4 属于模型厂商
                               t4 → t5 才是 Proxy 尾部处理/发送
                               t5 → t6 网络发送尾部
```

统计时不允许把 `t3 → t6` 整段都算成 Proxy 本地耗时。

### 流式要保留的关键指标

- `upstream_ttfb_ms`：模型厂商首响应延迟
- `upstream_stream_ms`：模型厂商输出时长
- `proxy_tail_ms`：上游结束后，Proxy 处理并送结束标志给用户的耗时
- `client_network_tail_ms`：服务端到用户网络/发送尾部

### OpenAI / Responses SSE 修复

当前 `handler.ts` 在 readDone 时：

```ts
await finalizeStreamTap(...);
controller.close();
```

需要改为：

```ts
// 处理残留 SSE
...
// 先让用户流结束
controller.close();

// 再异步执行统计/L0/skill/credit 等后处理
void finalizeStreamTap(tapCtx, usLastUsage, usAssistantContent, usToolAcc)
  .catch((err) => pipe.error("STREAM_FINALIZE", err));
```

这样客户端 EOF 不会被本地后处理阻塞。

---

## 4. 非流式阶段

非流式可视为顺序相加：

```text
local_prepare_ms + build_request_ms + upstream_ttfb_ms
+ upstream_stream_ms(≈响应体读取) + proxy_tail_ms + client_network_tail_ms
≈ total_ms
```

### 非流式 L0 统一异步

当前 OpenAI 非流式路径存在 `await recordTdaiTurn(...)`，需要统一改为：

```ts
trackWrite(
  withL0Retry(() => recordTdaiTurn(...)).catch((err) => pipe.error("TDAI_L0", err))
);
```

保证：

- 用户响应不被 L0 拖慢
- 进程退出前仍可由 `flushPendingWrites()` 兜底

---

## 5. ClickHouse 落地

### 5.1 新表

```sql
CREATE TABLE IF NOT EXISTS context_proxy.request_stage_timings (
  timestamp DateTime64(3, 'Asia/Shanghai'),
  request_id String,
  model String,
  protocol LowCardinality(String),
  session_key String,
  stream UInt8,
  total_ms UInt32,
  local_prepare_ms UInt32,
  build_request_ms UInt32,
  upstream_ttfb_ms UInt32,
  upstream_stream_ms UInt32,
  proxy_tail_ms UInt32,
  client_network_tail_ms UInt32,
  postprocess_ms UInt32
) ENGINE = MergeTree
ORDER BY timestamp;
```

### 5.2 写入时机

- 在 `t6`（`ServerResponse.finish`）后，组装完整记录。
- 通过 `trackWrite()` 异步写入 ClickHouse，不阻塞响应。
- 写入失败只记日志，不影响业务。

### 5.3 统计查询示例

```sql
SELECT
  model,
  count() AS requests,
  quantile(0.5)(upstream_ttfb_ms) AS p50_ttfb,
  quantile(0.9)(upstream_ttfb_ms) AS p90_ttfb,
  quantile(0.5)(upstream_stream_ms) AS p50_upstream_stream,
  quantile(0.9)(upstream_stream_ms) AS p90_upstream_stream,
  quantile(0.5)(proxy_tail_ms) AS p50_proxy_tail,
  quantile(0.9)(proxy_tail_ms) AS p90_proxy_tail,
  quantile(0.5)(client_network_tail_ms) AS p50_client_network,
  quantile(0.9)(client_network_tail_ms) AS p90_client_network
FROM context_proxy.request_stage_timings
WHERE stream = 1
GROUP BY model;
```

---

## 6. 代码改动点

1. 新增/集中一个 timing 工具模块，例如：
   - `MemoryProxy/src/timing.ts`
   - 或直接扩展 `src/logger.ts`

2. 修改 OpenAI handler：
   - `MemoryProxy/src/handler.ts`
   - 在关键节点记录 `t0` ~ `t6`
   - 流式 EOF 先 `controller.close()`，再异步 finalize
   - 非流式 L0 改为 `trackWrite`

3. 修改 Anthropic handler：
   - `MemoryProxy/src/anthropicHandler.ts`
   - 同样记录阶段时间
   - 已有 tee/后台消费模式，不需要再大改流式关闭方式

4. 修改 ClickHouse：
   - `MemoryProxy/src/clickhouse.ts`
   - 增加 `request_stage_timings` 的建表/写入函数

5. 日志：
   - 同时输出一条 `request.timing` JSON 到 docker logs，方便即时排查

---

## 7. 不做的事

- 不记录每个 token/chunk 的细碎耗时
- 不把 Langfuse 作为主要长期统计存储
- 不把统计写入放到用户响应结束标志之前同步执行
- 不改动现有 `usage_logs` / `usage_raw` 的语义

---

## 8. 验收标准

1. OpenAI 流式响应中，用户先收到结束标志，统计/L0 后异步写入。
2. 非流式 OpenAI L0 不再阻塞用户响应返回。
3. ClickHouse 出现 `request_stage_timings` 表。
4. 每个请求一条记录，字段非空。
5. 能按 model / stream 查询 p50 / p90 的：
   - 上游 TTFB
   - 上游流式输出
   - Proxy 尾部处理
   - 服务端到客户端网络尾部

---

## 9. 执行进度记录（2026-09-07）

### 已完成

1. 代码已改：
   - `MemoryProxy/src/timing.ts`（新增）
   - `MemoryProxy/src/handler.ts`
   - `MemoryProxy/src/anthropicHandler.ts`
   - `MemoryProxy/src/clickhouse.ts`

2. 改动内容：
   - 新增 `request_stage_timings` ClickHouse 表。
   - OpenAI 流式 EOF：先 `controller.close()`，再异步 `finalizeStreamTap()`。
   - OpenAI 非流式 L0：由 `await` 改为 `trackWrite()` 异步。
   - 在 Proxy 请求流程记录阶段：
     - `t0` 收到请求
     - `t1` 本地解析/hook 注入完成
     - `t2` 请求上游前
     - `t3` 收到上游首响应
     - `t4` 收到上游结束/EOF
     - `t5` 返回用户结束标志
     - `t6` ServerResponse finish（服务端→用户网络尾部）
   - 通过 `attachClientFinishTiming()` 监听 Node `ServerResponse.finish`。
   - 耗时数据写入 ClickHouse `request_stage_timings`。

3. 本地构建/远程部署：
   - 第一次构建成功：`bfd739fbcc44`
   - 已上传并加载到服务器。
   - 远程 `tdai-proxy` 已重启并 healthy。
   - 远程 ClickHouse 已出现 `request_stage_timings` 表。

### 发现并修复的问题

- 第一次写入 ClickHouse 时发现 timestamp 格式错误：
  - 错误：直接写 ISO 带 `Z`，如 `2026-09-06T17:38:...Z`
  - ClickHouse 报错：`Cannot parse input ... while reading the value of key timestamp`
  - 修复：`timing.ts` 使用 `clickhouse.ts` 的 `toChTimestamp()` 转成 ClickHouse DateTime64 格式。
- 修复后已重新构建镜像 `5e9f77f06459`，准备再次上传/加载/重启远程 Proxy。

### 当前状态（未完成部分）

- 第二次新镜像 `5e9f77f06459` 本地构建中/刚完成，尚未传到远程。
- 待完成后执行：
  1. `docker save agentmemory/memory-proxy:local | gzip > /tmp/proxy-image.tar.gz`
  2. scp 到服务器 `/root/tdai-memory/images/`
  3. `docker load -i proxy-image.tar.gz`
  4. `./start-proxy.sh`
  5. 让 Agent 再发一次请求，确认 `request_stage_timings` 有数据。
