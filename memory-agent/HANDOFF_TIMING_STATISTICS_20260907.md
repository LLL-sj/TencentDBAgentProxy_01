# Handoff: Proxy 分阶段耗时统计（已完成首轮部署）

> 日期：2026-09-07  
> 范围：MemoryProxy 分阶段耗时统计 + OpenAI 流式 EOF 优化 + OpenAI 非流式 L0 异步  
> 状态：已部署到服务器并验证写入成功

---

## 1. 完成内容

### 1.1 代码变更

| 文件 | 变更 |
|---|---|
| `MemoryProxy/src/timing.ts` | 新增：粗粒度耗时统计工具、ClickHouse 行组装、Node ServerResponse finish 监听 |
| `MemoryProxy/src/handler.ts` | OpenAI 请求阶段计时；OpenAI 流式 EOF 先 close 再异步 finalize；OpenAI 非流式 L0 改为 `trackWrite()` 异步 |
| `MemoryProxy/src/anthropicHandler.ts` | Anthropic 请求阶段计时；流式 t4/t5 记录；非流式/流式都接入耗时统计 |
| `MemoryProxy/src/clickhouse.ts` | 新增 `request_stage_timings` 建表与异步写入、flush、shutdown；导出 `toChTimestamp()` |

### 1.2 耗时阶段

记录到 ClickHouse `request_stage_timings`，一行一条请求：

完整字段速查：

| 字段 | 含义 |
|---|---|
| `timestamp` | 这次请求在 ClickHouse 中记录的本地时间（北京时间） |
| `request_id` | Proxy 为这次请求生成的唯一标识 |
| `model` | 实际使用的上游模型名称 |
| `protocol` | 请求走的是 OpenAI 还是 Anthropic 协议 |
| `stream` | 是否流式请求，0=否，1=是 |
| `total_ms` | 用户从请求到收到响应的总耗时（Proxy 侧 `t0 → t6`，不含客户端真实公网往返） |
| `local_prepare_ms` | Proxy 收到请求后做本地解析/注入处理的耗时（`t0 → t1`；包含鉴权、session、注入等内部调用，可能含内部网络时间，不是纯 CPU） |
| `build_request_ms` | Proxy 构造上游请求的耗时（`t1 → t2`） |
| `upstream_ttfb_ms` | 等待上游返回首个响应/首字节的耗时（`t2 → t3`） |
| `upstream_stream_ms` | 上游从开始输出到输出完整的耗时（`t3 → t4`；非流式通常很小） |
| `proxy_tail_ms` | 上游完成后 Proxy 自己收尾处理的耗时（`t4 → t5`） |
| `client_network_tail_ms` | Proxy 把响应交给系统发送到用户的网络尾部耗时（`t5 → t6`；只到 Node `finish`，不是真实公网回包延迟） |
| `postprocess_ms` | 响应发出后异步后处理的耗时（`t6 → t7`；目前基本为 0） |

### 1.3 OpenAI/Responses SSE 修复

原逻辑：

```ts
await finalizeStreamTap(...);
controller.close();
```

改为：

```ts
markTime(timeline, "t5");
controller.close();
void finalizeStreamTap(...);
```

效果：客户端先收到流式结束标志，L0/ClickHouse/Langfuse/skill/credit 后异步执行，不阻塞用户 EOF。

### 1.4 OpenAI 非流式 L0 统一异步

原逻辑：

```ts
await recordTdaiTurn(...);
```

改为：

```ts
trackWrite(
  withL0Retry(() => recordTdaiTurn(...)).catch(...)
);
```

效果：非流式响应不再等待 L0 写库，与流式路径行为一致。

---

## 2. 构建与部署

### 2.1 镜像

- 仓库：`agentmemory/memory-proxy:local`
- 当前部署镜像 ID：
  ```text
  5e9f77f06459495d5f89b93bd0f355b58c14363d63c2de704f7b84ab24c72228
  ```

### 2.2 远程部署位置

- 脚本目录：`/root/tdai-memory/deploy/global-images/`
- 镜像包：`/root/tdai-memory/images/proxy-image.tar.gz`
- 服务：`tdai-proxy` healthy

### 2.3 部署命令（已执行）

```bash
cd /root/tdai-memory/images
docker load -i proxy-image.tar.gz
cd /root/tdai-memory/deploy/global-images
./start-proxy.sh
```

### 2.4 远程 SSH（重要，补录）

当前远程服务器可直连：

```text
Host:     8.133.220.36
User:     root
Port:     22（默认）
SSH:      ssh root@8.133.220.36
密钥:     开发机（luuu）已有 ~/.ssh/id_ed25519
```

如果本机有多个 key 或需要显式指定：

```bash
ssh -i ~/.ssh/id_ed25519 root@8.133.220.36
```

登录后通常先看：

```bash
docker ps | grep tdai-proxy
cd /root/tdai-memory/deploy/global-images
./start-proxy.sh
```

---

## 3. 验证结果

### 3.1 测试请求

已通过 `/codebuddy/default/v1/chat/completions` 发送一次非流式测试：

```bash
AK=$(cat /root/tdai-memory/deploy/global-images/.admin-key)
curl -sS http://localhost:28096/codebuddy/default/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $AK" \
  -d '{"model":"gpt-5.6-luna","messages":[{"role":"user","content":"ping, reply ok"}],"stream":false}'
```

返回 `HTTP=200`，上游模型回复 `ok`。

### 3.2 ClickHouse 写入成功

`request_stage_timings` 已有数据（首轮部署验证时 `count = 1`，后续补测后已有更多行）：

```text
count = 1（首轮部署时）
```

示例行：

```text
timestamp:                 2026-09-07 01:52:11.418
request_id:                01a077d9-...
model:                     gpt-5.6-luna
protocol:                  openai
stream:                    0
total_ms:                  2197
local_prepare_ms:          60
build_request_ms:          3
upstream_ttfb_ms:          2113
upstream_stream_ms:        1
proxy_tail_ms:             18
client_network_tail_ms:    2
postprocess_ms:            0
```

从该行可以看出：慢主要在上游 TTFB（2113ms），Proxy 本地处理很少。

### 3.3 网络开销补充（本地 → 远程服务器实测）

说明：`request_stage_timings` 只覆盖 Proxy 侧 `t0 → t6`，**不记录客户端到服务器的真实公网传输时间**。要估网络开销，可对比“本机 curl 总耗时”和“服务器 ClickHouse `total_ms`”。

2026-09-07 02:07 从本机到 `8.133.220.36:28096` 连续发了 5 次小模型请求，实测概览：

```text
TCP 连接耗时（1 个 RTT）：约 30ms
HTTP 完整请求相对服务器 total_ms 的额外开销：约 60-80ms（约 2 个 RTT）
```

| # | 本地 curl `time_total` | 服务器 `total_ms` | 差值（网络/客户端侧近似开销） |
|---|---|---|---|
| 1 | 2.242s | 2165ms | 约 77ms |
| 2 | 1.627s | 1563ms | 约 64ms |
| 3 | 2.102s | 2022ms | 约 80ms |
| 4 | 1.535s | 1468ms | 约 67ms |
| 5 | 2.727s | 2653ms | 约 74ms |

结论：这组测试里真实公网延迟不大，RTT 约 30ms，额外网络开销约 60-80ms；主要耗时仍是上游 TTFB（1.4-2.5s）。

---

## 4. 过程中发现并修复的问题

### 4.1 ClickHouse timestamp 格式错误

现象：

```text
ERROR clickhouse.flushTimings.error
Cannot parse input: expected '"' before: 'Z","request_id":"...'
```

原因：写入 ClickHouse 的 timestamp 是 ISO 格式：

```text
2026-09-06T17:38:18.685Z
```

但 ClickHouse 字段是：

```text
DateTime64(3, 'Asia/Shanghai')
```

需要：

```text
2026-09-07 01:38:18.685
```

修复：`timing.ts` 改用 `clickhouse.ts` 的 `toChTimestamp()`。

---

## 5. 当前已知限制/后续可改点

1. `postprocess_ms` 当前基本为 0，因为 `request.timing` 在 Node `finish` 时立即发出，而 t7 异步后处理可能更晚完成。后续如果要统计 L0/ClickHouse 后处理耗时，需要改为在 t7 后再最终发送，或再发一条补写。
2. `client_network_tail_ms` 是 Node `finish` 近似值，表示已交给系统 socket，不是客户端应用层已收到。
3. Langfuse 仍未配置 `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY`，因此暂未通过 Langfuse 查看 Trace/span。
4. 当前只统计了成功转发并走到 handler 返回路径的请求；鉴权失败/上游 4xx/未到 `t6` 的请求不一定写入。
5. Anthropic 流式的 `t5` 在 TransformStream flush 中记录；OpenAI 流式的 `t5` 在 `controller.close()` 前记录。两者含义一致但实现位置不同。
6. 尚未做长期统计看板，查询示例见 `PERFORMANCE_TIMING_EXECUTION_PLAN.md`。
