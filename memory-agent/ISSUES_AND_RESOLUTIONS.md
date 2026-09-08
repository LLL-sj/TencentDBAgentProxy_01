# ISSUES_AND_RESOLUTIONS.md — 问题汇总与排障记录（原 问题汇总.md）

> 说明：本文位于 `memory-agent/`；原文件名为 `问题汇总.md`。本文记录第一阶段开发过程中遇到的问题、根因与解决方法。

---

## 一、容器部署与镜像管理

**状态**：✅ 已建立正确的修改→部署工作流（2026-08-13）

### 1.0 SSH 连接方式

VM 地址 `192.168.88.128`，用户 `luuu`。本机 `~/.ssh/config` 已配置别名：

```text
Host ubuntu-vm
    HostName 192.168.88.128
    User luuu
```

日常登录：`ssh ubuntu-vm`。共享本机 `~/.ssh/` 目录，无需额外密钥配置。

免密机制：本机 `id_rsa`（lujia@lujiashuo）与 `codex-memoryproxy-vm` 两把公钥已写入 VM 的 `~/.ssh/authorized_keys`，SSH 自动密钥认证。网络排障要点：VM 已配静态 IP（netplan，renderer NetworkManager）；断联先查 Windows 侧 VMware NAT Service 是否运行、VM 内是否有残留 `dhclient` 进程（续租失败会冲刷静态地址）；**禁用手动 `dhclient`**，恢复用 `sudo netplan apply`。

### 1.1 镜像与源码关系

源码仓库位于：

```text
/home/luuu/Desktop/TencentDB-Agent-Memory
```

分支 `feat/server_team`，HEAD `fe3230f`。容器用 `node --import tsx/esm src/index.ts` 直接跑 TypeScript 源码，无需编译。

**2026-08-13 已用 VM 工作区源码重建三个镜像**，`.env` 中 `MEMORY_CORE_IMAGE` / `MEMORY_HUB_IMAGE` / `PROXY_IMAGE` 均已切到 `:local`：

| 镜像 | 大小 | 构建方式 |
|------|------|---------|
| `agentmemory/memory-proxy:local` | 776MB | `docker build -f MemoryProxy/Dockerfile MemoryProxy/` |
| `agentmemory/memory-core:local` | 951MB | `docker build -f MemoryCore/Dockerfile MemoryCore/` |
| `agentmemory/memory-hub:local` | 1.39GB | `deploy/panel-knowledge-combined/build.sh`（rsync 组装 context，见 1.3 #12） |

镜像内 `/app/src/` 与工作区源码逐文件 md5 一致（13 个修改文件已验证），镜像与源码已同源。旧预构建镜像 `agentmemory/memory-proxy:latest` 仍保留在 VM 上，可作回退。构建前提：VM 联网；Docker 镜像源用 DaoCloud（1.3 #8）；apt 用清华源（1.3 #9）。

### 1.2 标准部署流程

Volume mount（`-v 主机:容器:ro`）与镜像重建是两条修改→部署路径：改完源码后 `bash start-proxy.sh` 重启（mount 生效），或重新构建 `:local` 镜像（镜像内代码更新）。当前 12 个源码文件已挂载且与镜像内容一致，两条路径等效。`docker cp` 只在紧急临时场景使用，容器删除即丢失。

**步骤 1：修改 VM 上的源码文件**

修改一律在 VM 本机执行，不跨平台。代码文件位于 `/home/luuu/Desktop/TencentDB-Agent-Memory/` 下。修改方法优先级（高→低）：

| 优先级 | 方式 | 适用场景 |
|--------|------|----------|
| **1** | 本机写脚本 → `scp` 到 VM → `python3` 执行 | 多行插入、多文件批量改（零转义问题，可审计可重跑） |
| **2** | SSH 直接 `sed` | 单行替换，pattern 不含 `$`/`"`/`\` |
| **3** | SSH inline `python3 -c` | 只在绝对必要时 |

禁止 SSH heredoc 传 Python、内联多层转义 sed、Windows 本地改完 scp 覆盖（详见 1.3 #3/#4/#7）。

**步骤 2：volume mount 注册**

当前 12 个源码文件已注册在 `start-proxy.sh` 的 `docker run` 中（格式 `-v "$REPO_ROOT/MemoryProxy/src/某文件.ts:/app/src/某文件.ts:ro"`），与 `:local` 镜像内容一致。新改文件按同样格式追加 mount 行即可；`REPO_ROOT` 定义见脚本头部（踩坑见 1.3 #2）。**mount 列表以 `start-proxy.sh` 脚本本身为准，本文档不复制。**

**步骤 3：重启容器**

```bash
cd ~/Desktop/TencentDB-Agent-Memory/deploy/global-images && bash start-proxy.sh
```

该脚本会自动删旧容器 → 生成 config.yaml → 创建新容器 → 等待 healthy。

**步骤 4：验证**

```bash
docker logs tdai-proxy --tail 5                                    # 确认容器跑起来了
docker exec tdai-proxy grep -n "标志性代码" /app/src/某文件.ts        # 确认文件已挂载
docker logs tdai-proxy -f | grep -i "关键词"                        # 确认改动生效
```

### 1.3 常见的踩坑记录

| #   | 现象                                                    | 根因                                                 | 解决                                          |
| --- | ----------------------------------------------------- | -------------------------------------------------- | ------------------------------------------- |
| 1   | 改了源码但日志没变化                                            | 1) 没加 volume mount，容器跑旧镜像代码；2) 改了文件但启动命令没读这个文件     | 确认 mount 存在 → 重启容器                          |
| 2   | `start-proxy.sh: line N: REPO_ROOT: unbound variable` | `set -euo pipefail` 下未定义变量直接退出                     | 脚本头部定义 `REPO_ROOT="$SCRIPT_DIR/../.."`      |
| 3   | `docker run` 报错或挂载路径不存在                               | sed 编辑把换行续接符 `\` 弄丢或加空格                            | 用 Python 脚本而非 sed 改 start-proxy.sh          |
| 4   | Python inline 命令报 `SyntaxError`                       | SSH 传递时 bash 解析了 Python 的 `$` / 反斜杠                | 写成 `.py` 文件 scp 过去再执行；Python 字符串用 raw 或双反斜杠 |
| 5   | Volume mount 加好了但容器不是最新代码                             | 启动容器后改了 VM 源文件没重启                                  | 改完 → `bash start-proxy.sh` 重建容器             |
| 6   | `.env` 改了但容器不认                                        | `.env` 只在 YAML 生成阶段被 `start-proxy.sh` 读取，不是容器运行时读取 | 改 `.env` 后必须重启容器（`bash start-proxy.sh`）     |
| 7   | SSH 传 Python 命令报 `SyntaxError` 或静默出错                  | bash → SSH → Python 三层引号 `$`/`\`/`"` 相互吃掉                   | 写 `.py` 文件 scp 过去再 `python3` 执行；禁止 heredoc / inline `-c` |
| 8   | 构建拉 `docker/dockerfile:1` 报 no such host             | `daemon.json` 的 registry-mirrors 已停服（中科大、网易）            | 换 `docker.m.daocloud.io` → `systemctl restart docker` |
| 9   | 构建 apt 拉包失败（exit 100 / 证书不信任）                       | 腾讯源证书不被 node:22-slim 信任；deb.debian.org 直连不稳            | apt 统一换清华源 `mirrors.tuna.tsinghua.edu.cn` |
| 10  | 重建容器后 `TransformError: Expected identifier but found ","` | 源码有语法错误（如 `},,`）；旧容器没重启，内存里跑旧代码，错误被掩盖     | 改完源码及时重启或先做语法校验；修复后重建镜像 |
| 11  | 构建报 `COPY packages/cost-guard/src: not found`         | `packages/cost-guard` 是 gitlink 但仓库缺 `.gitmodules`，目录为空    | `docker cp tdai-proxy:/app/packages/cost-guard/. MemoryProxy/packages/cost-guard/` 补齐 |
| 12  | hub 构建报 `COPY start-combined.sh: not found`           | 该 Dockerfile 要求专用 context（panel/ + knowledge/ + 脚本），不能用仓库根 | 用官方 `build.sh`：`PREPARE_ONLY=1` 生成 context → `docker build --build-arg APT_MIRROR=<清华源>` |

---

## 二、Claude Code 配置与 cc-switch 要求

1. `C:\Users\lujia\.claude\settings.json` **只允许查看，不允许手动修改**。该文件是 cc-switch 的运行时输出，排查问题时可以读取，但不作为手工配置入口。

2. **cc-switch 是唯一配置入口**。通过 cc-switch 供应商配置生成 Claude Code 所需 env、model、permissions 等所有 settings 内容；切换供应商即切换上游、请求头和记忆身份。

3. **`permissions` 字段不得为 `null`**。若某供应商无需权限配置，写 `"permissions": {}`（空对象），不能写 `"permissions": null`。写 `null` 会导致 Claude Code 报错 `Expected object, but received null`，整个 settings 文件被跳过。

4. **身份头/自定义配置只写在对应 provider 的配置里，禁止写入 common 配置**。切换供应商时自动带上、切走自动不带。写入 common 会导致所有供应商都被注入不该带的头。Claude Code provider 通过 `ANTHROPIC_CUSTOM_HEADERS` 携带，Codex provider 通过 TOML 的 `http_headers` 携带，各自独立。

5. **记忆代理 provider 必须关闭 common 配置合并**。cc-switch 的合并机制：当 `meta.commonConfigEnabled=true`（默认）时，`settings.common_config_claude` 覆盖 provider 的 `settings_config`（同名 key 以 common 为准）。记忆代理等需要独立配置的 provider 必须设置：

    ```json
    {"commonConfigEnabled": false, "endpointAutoSelect": true, "apiFormat": "anthropic"}
    ```

    `CLAUDE_CODE_EFFORT_LEVEL` 同样遵循此隔离规则：记忆代理 provider 使用 `max`（Thinking 块兼容已在 proxy 层解决），不与 common 合并

---

## 三、Web 工具兼容

### 3.1 WebSearch `type:null` schema 错误

**状态**：✅ 已解决（2026-08-11）

1. **问题描述**：Claude Code 配置 TDAI Memory Proxy 后，执行内置 `WebSearch` 时报错 `API Error: 400 Invalid schema for function 'web_search': schema must be a JSON Schema of 'type: "object"', got 'type: null'`。直连上游 `deepseek-v4-pro` 时正常，问题仅在经过 proxy 时出现。根因在 `MemoryProxy/src/injection/pipeline.ts` 的 `process()` 方法：injection pipeline 对请求 body 做了 `parse → AgentContext → serialize` 往返处理，`adapter.parse()` 调用 `parseTool()` 时把合法的 `input_schema: null` 强制转为空对象 `{}`，破坏了原始 tool 定义。

2. **解决方法**：修改 `process()` 方法——原始 `body.tools` 在 parse 之前拆走保存，parse/serialize 流程完全不知 tools 存在，最后再原样拼回。核心代码：

    ```typescript
    const originalTools = body.tools;
    if (originalTools !== undefined) { delete body.tools; }
    // parse → executeHooks → serialize
    if (originalTools !== undefined || result.tools) {
      result.tools = [...(originalTools ?? []), ...(result.tools ?? [])];
    }
    ```

    curl 模拟请求验证通过，Claude Code WebSearch 恢复正常。

### 3.2 WebFetch 域名安全校验失败

**状态**：⚠️ 待解决

1. **问题描述**：Claude Code 使用 `WebFetch` 抓取 GitHub 内容时出现 `Unable to verify if domain github.com is safe to fetch`。这与 WebSearch 的 schema 错误不同，属于 WebFetch 安全校验或网络策略链路问题。

2. **解决方法**：待解决。需通过真正指向 Memory Proxy 的 Claude provider 进行黑盒验收，区分排查 Proxy 工具透传、Claude Code 外部安全校验以及上游网络/企业策略。

### 3.3 Codex 是否受 Web 工具问题影响

**状态**：✅ 已验证

1. **问题描述**：Codex 不走 Claude Code CLI 的内置 WebSearch/WebFetch 执行链路，需验证是否会遇到同类问题，以及 MemoryProxy 对 Codex/OpenAI 请求的识别、注入和沉淀是否完整。

2. **解决方法**：Codex + GPT 上游的 Memory Proxy 记忆链路已完成验证——身份头、session、记忆注入、L0 记录及 L1/L2/L3 后台处理均运行正常，Codex 不会复现 Claude Code 的 WebSearch 问题。但原生 OpenAI Responses API（`/v1/responses`）尚未专项验收，后续如需发布级兼容承诺应补做。

---

## 四、Thinking 块兼容

**状态**：✅ 已解决（2026-08-11）

1. **问题描述**：Claude Code 配置 `CLAUDE_CODE_EFFORT_LEVEL=max` 后，请求返回 400 错误 `content[].thinking must be passed back`。`max` 级别下 CC 在 assistant message 中附带 thinking blocks，proxy 的 `sanitizeThinkingBlocks()` 通过签名有效性判断是否保留——CC 的 thinking block 签名是 base64、≥40 字符，被误判为有效 Anthropic 签名，原样转发给 DeepSeek。DeepSeek 的 Anthropic 兼容层不认识 thinking block，直接 400。

2. **解决方法**：修改 `MemoryProxy/src/anthropicHandler.ts` 的 `sanitizeThinkingBlocks()` 函数——改为根据**模型名**自动判断（`/^claude/i.test(modelId)`），非 Anthropic 模型的 thinking block 全部洗掉。同时提供 `PROXY_PRESERVE_THINKING_SIGNATURES` 环境变量可强制覆盖。CC 侧保持 `CLAUDE_CODE_EFFORT_LEVEL=max`，对话框正常显示 "thinking Xs"，proxy 后台静默洗掉，上游无感知。

---

## 五、模型与上游配置

### 5.1 上游模型兜底机制

**状态**：✅ 已实现（2026-08-11）

1. **问题描述**：客户端没带 `model` 字段时，proxy 会以空值转发上游，可能导致路由失败。

2. **解决方法**：客户端带了 model → 透传；客户端没带 → 兜底用 `PROXY_UPSTREAM_MODEL`。换模型只改 `.env` 一处，代码零硬编码。涉及 4 个文件：

    | 文件 | 改动 |
    |------|------|
    | `types.ts` | `upstream` 新增 `defaultModel: string` 字段 |
    | `config.ts` | 解析链：`yaml.upstream.defaultModel` → `env.PROXY_UPSTREAM_MODEL` → 空字符串 |
    | `handler.ts` | OpenAI 请求没带 model → 自动写入 `body.model = defaultModel` |
    | `anthropicHandler.ts` | Anthropic 请求没带 model → 自动写入 `body.model = defaultModel` |
    | `start-proxy.sh` | YAML 模板写入 `defaultModel: "${PROXY_UPSTREAM_MODEL}"` |

    配置优先级：客户端 `body.model`（透传）> `.env` `PROXY_UPSTREAM_MODEL`（兜底）> 空字符串。

### 5.2 OpenAI 协议请求路由

**状态**：✅ 已解决（2026-08-12）

1. **问题描述**：CodeBuddy/Codex 的 OpenAI 协议请求（`/v1/chat/completions`）被错误转发到 Anthropic 端点（`api.deepseek.com/anthropic`），上游返回 404。根因是 `.env` 只有一套上游地址，两类客户端走了同一套上游。

    | 客户端 | 协议 | 路径 | 上游兼容 |
    |--------|------|------|----------|
    | Claude Code | Anthropic Messages | `/v1/messages` | ✅ |
    | CodeBuddy / Codex | OpenAI Chat Completions | `/v1/chat/completions` | ❌ 404 |

2. **解决方法**：为 OpenAI 协议单独配置中转站 URL 和 API key（如 `api.zhongjx.xyz`），使两类协议各有正确路由。不需要改 proxy 的模型透传逻辑。模型继续透传客户端请求中的 model（不带 model 时用 5.2 的兜底机制）。

---

## 六、Codex 接入 Memory Proxy 实现方式

**状态**：✅ 端到端可用（2026-08-11 首通；2026-08-12 补充完整实现文档）

### 6.1 协议与路由

Codex 使用 OpenAI Chat Completions 协议（`/v1/chat/completions`），**始终流式**（`stream: true`）。与 Claude Code 的 Anthropic Messages 协议完全不同。

Proxy URL 路由设计：

```
http://192.168.88.129:8096/codebuddy/{spaceId}/v1/chat/completions
                         ↑          ↑
                     agentSource   认证/路由空间
```

| 组件 | 值 | 来源 |
|------|-----|------|
| `agentSource` | `"codebuddy"` | URL 第一段，硬编码在 Codex TOML `base_url` 中 |
| `spaceId` | `"default"` | 认证层的团队空间标识 |
| 上游模型 | `gpt-5`（或其他） | Codex 客户端 `body.model` 透传 |

**与 Claude Code 的差异**：

| 维度         | Claude Code                 | Codex                   |
| ---------- | --------------------------- | ----------------------- |
| 协议         | Anthropic Messages          | OpenAI Chat Completions |
| URL 前缀     | `/claude-code/`             | `/codebuddy/`           |
| 流式         | 部分场景非流式                     | 始终流式                    |
| 处理文件       | `anthropicHandler.ts`       | `handler.ts`            |
| content 格式 | 数组（content blocks）          | 字符串                     |
| tool 调用    | `tool_use` block type（结构分离） | `tool_calls` 顶层字段（理论分离） |
| 工具审批       | **用户手动**（CLI 弹窗 Allow/Deny） | **远程 guard 模型自动审批**     |

**Codex 的 guard 审批机制**：Codex 每次执行工具前，会向内部 guard 模型发送独立的 HTTP 请求（走同一 `/codebuddy/.../chat/completions` 端点），由 guard 模型自动判断操作安全性。guard 回复 `{"outcome":"allow"}` 后 Codex 才真正执行工具；回复 `{"outcome":"deny"}` 则拒绝。这些 guard 请求对用户透明，不进入主对话上下文。proxy 层通过 `isCodexGuardSession()` 识别并跳过 L0 记录（详见七）。

### 6.2 身份识别与会话管理

**身份头（Codex TOML `http_headers` 注入）**：

```toml
http_headers = {
  "x-team-id" = "team-vb2ty2kp2t",
  "x-agent-id" = "agt-vb2tfufjj7",
  "x-task-id" = "task-vb2t47wer5"
}
```

这三个头在 proxy 层合成为 `PresetIdentity`，驱动 header-driven session initiation（跳过交互式表单）。

**会话 ID 识别链**（`session-key.ts`）：

Codex 的 session 标识来源比 CC 更多样，按优先级尝试：

1. `session-id` header（Codex CLI 标准头）
2. `thread-id` header（OpenAI Threads 兼容）
3. `x-codex-turn-metadata` header（Codex 特定扩展）
4. 回退到 `x-agent-id + x-task-id` 组合

### 6.3 Session Init 状态机（CodeBuddy 路径）

**入口**：`session/codebuddy/init.ts` 的 `handleSessionInit()`

**状态流转**：

```
uninitialized
  ├─ presetIdentity + headerAutoSelect → 跳过表单，直接注册
  └─ 无 preset → pending_asset_confirm（"是否关联团队资产？"）
       ├─ 用户选"是" → pending_team_select（单选 Team）
       │    └─ pending_agent_task（选 Agent + Task）
       │         └─ initialized（注册，注入记忆上下文）
       └─ 用户选"否" → initialized（bypassed=true，后续不进 injection）
```

**关键差异 vs CC**：
- CC 使用 Anthropic `tool_use` 原生交互（`ask_followup_question`）；Codex 使用 OpenAI 协议的 form 对话
- CC 的 team/agent/task 分三步（三次请求）；Codex 的 asset_confirm 合并了前两步
- Codex 路径的 `systemAppend` 始终为 `null`（不需要 Anthropic 的 `<session_context>` 注入）

**headerAutoSelect 安全网**（`codebuddy/init.ts`）：
- 当 `state` 丢失但 `presetIdentity` 存在时，自动回退到 header-driven 注册
- 当 `presetIdentity` 解析失败（mismatch）时，按 `onMismatch` 配置决定 bypass 或回退表单

### 6.4 Agent Adapter 架构

**工厂模式**：`agent-adapters/index.ts` 的 `resolveAgentAdapter(agentSource)` 按 URL 前缀路由。

```
resolveAgentAdapter("codebuddy") → codebuddyAdapter
resolveAgentAdapter("claude-code") → claudeCodeAdapter
resolveAgentAdapter(其他)          → defaultAdapter
```

**CodeBuddy Adapter**（`agent-adapters/codebuddy.ts`）：

| 方法 | 行为 | 原因 |
|------|------|------|
| `classifyRequest()` | 恒返回 `"main"` | Codex 无 fork/sidequery 概念，所有请求走完整链路 |
| `extractUserText(content)` | `typeof content === "string"` → 调 `extractUserQueryText(content)`；否则走 default 兜底 | Codex 的 user content 永远是字符串，用共用文本清洗 |

**共用文本清洗**：`common/user-query-extractor.ts` 的 `extractUserQueryText(raw: string): string`

- 优先提取 `<user_query>...</user_query>` 块
- 无则剥离 XML wrapper（`<additional_data>`、`<user_info>` 等 11 种标签）
- 再剥离非 XML 系统段落、行级 tool 回显、MEMORY.md frontmatter
- 返回空字符串表示"整条都是噪声" → 不写 L0

### 6.5 流式处理与 TransformStream Bug

**问题**：Node.js 22–24 Web Streams 的 bug —— `TransformStream.flush()` 在 Codex 上游（中转站）的特定响应流上不被调用。

**影响**：proxy 的流式管线依赖 `flush()` 执行 L0 写入、skill 提取等关键操作。Claude Code 不受影响（其上游响应流正常触发 `flush()`）。

**修复**（`handler.ts`，仅 OpenAI 路径）：完全绕过 `TransformStream`，手动实现 `ReadableStream`：

```
upstreamResp.body.getReader() → while (reader.read()) → 手动 SSE 解析
  → reader.read() 返回 done:true → 显式调用 finalizeStreamTap()
```

**双输出架构**（stream 路径内 `finalizeStreamTap`）：

```
SSE 解析
  ├─→ usAssistantContent（纯文本累加：choices[0].delta.content）
  │     → L0 写入：stripTranscriptArtifacts(assistantContent) || null
  │
  └─→ usToolAcc（tool_calls 合并：mergeToolCallDeltas）
        → outputMessage.content = usAssistantContent + JSON(tool_call)
          → Opik / Langfuse 观测用（需完整快照）
```

**关键原则**：L0 用 `usAssistantContent`（纯文本），Opik/Langfuse 用 `outputMessage`（含 tool JSON）。两者不能共用同一个对象 —— 这是 2026-08-12 修复前的 bug 根因。

### 6.6 Volume Mount 部署

Codex 相关文件的 volume mount（`start-proxy.sh`）：

```bash
-v "$REPO_ROOT/MemoryProxy/src/handler.ts:/app/src/handler.ts:ro" \
-v "$REPO_ROOT/MemoryProxy/src/tdai/recorder.ts:/app/src/tdai/recorder.ts:ro" \
-v "$REPO_ROOT/MemoryProxy/src/common/user-query-extractor.ts:/app/src/common/user-query-extractor.ts:ro" \
-v "$REPO_ROOT/MemoryProxy/src/agent-adapters/codebuddy.ts:/app/src/agent-adapters/codebuddy.ts:ro" \
-v "$REPO_ROOT/MemoryProxy/src/agent-adapters/index.ts:/app/src/agent-adapters/index.ts:ro" \
-v "$REPO_ROOT/MemoryProxy/src/session/codebuddy/init.ts:/app/src/session/codebuddy/init.ts:ro" \
```

容器使用 `tsx` 直接运行 TypeScript（无需编译），修改后重启容器即可生效。

### 6.7 涉及文件总览（Codex 接入链路）

| 文件 | 职责 |
|------|------|
| `handler.ts` | OpenAI 协议主 handler：路由、injection、L0 写入、流式处理 |
| `session/session-key.ts` | Session ID 提取（`session-id` / `thread-id` / `x-codex-turn-metadata`） |
| `session/codebuddy/init.ts` | CodeBuddy 专属 session-init 状态机 |
| `session/codebuddy/form.ts` | Form 对话构建（OpenAI 协议格式） |
| `session/codebuddy/extractor.ts` | 用户回复解析（Team/Agent/Task 选择提取） |
| `agent-adapters/codebuddy.ts` | Codex 适配器：`classifyRequest`、`extractUserText` |
| `agent-adapters/index.ts` | 适配器工厂：`resolveAgentAdapter()` |
| `common/user-query-extractor.ts` | 共用文本清洗（CC + Codex Layer 2） |
| `tdai/recorder.ts` | L0 提取 + guard 过滤 + 去重写入 |
| `injection/pipeline.ts` | 记忆注入管线（tools 保全修复） |

---

## 七、L0 记忆录音质量修复

**状态**：✅ 已修复（2026-08-12）

### 7.0 核心问题：Codex guard 审批 session 污染 L0

L0 录音的目标是"从 raw messages 中提取人类对话文本，丢弃工具/系统/上下文噪声"。Codex 的特殊之处在于：它有一个**内部 guard 审批机制**，每次执行工具前向 guard 模型发送安全审批请求。这些内部请求经过 proxy 时被当成正常对话，transcript dump（每条约 30–50 KB）写入 L0，产生噪声。

**数据来源**：通过 `fs.appendFileSync("/tmp/codex_trace.jsonl", JSON.stringify(messages))` 在 `handler.ts` 的请求入口 dump 了 21 条 Codex 请求的完整 messages，逐条分析确认了问题。

### 7.1 两类 session 的结构差异

从 trace 数据中识别出 Codex 实际发出两类性质完全不同的请求：

**类型 A — 正常对话**（trace 行 1–8, 12–15, 18–21）：

```
system("You are Codex, a coding agent...")  ← Codex 主模型 system prompt
user("# AGENTS.md instructions
...")       ← 注入的全局指令（非用户输入）
user("你好")                                 ← 真实用户输入
assistant("你好。今天需要...")               ← 主模型文本回复
user("你是Codex吗？...")                     ← 真实用户输入
assistant: content="是，我是 Codex..."        ← 文本 + tool_calls 并存
assistant: content=null, tool_calls=[...]   ← 纯工具调用
tool: content="Chunk ID: ... Wall time..."  ← 工具执行结果
...
```

messages 从 3 条逐步增长到 33 条（OpenAI 协议每次请求携带完整历史）。

**类型 B — Guard 审批**（trace 行 9–11, 16–17）：

```
system("You are judging one planned coding-agent action.
Assess the exact action's intrinsic risk...")
user("# AGENTS.md instructions
...")       ← 注入的全局指令
user("The following is the Codex agent history whose request action you are assessing...")  ← 完整 transcript dump（~15 KB）
assistant('{"outcome":"allow"}')            ← guard 判决
user("The following is the Codex agent history added since...")  ← 增量 transcript
assistant('{"outcome":"allow"}')
...
```

messages 只有 3–9 条（不累积历史）。Guard 请求是 Codex 内部安全闸门，和用户对话完全无关。

### 7.2 修复方案：`isCodexGuardSession` 结构判断

**核心洞察**：Guard session 的 assistant 回复恒为 `{"outcome":"allow"}` 或 `{"outcome":"deny"}`，这是 Codex guard 协议的输出契约 —— 单行 JSON 对象，仅一个 key。正常对话中用户和 assistant 都不会输出这种格式。

**实现**（`tdai/recorder.ts`）：

```typescript
/**
 * 判断 messages[] 是否为 Codex 内部 guard 审批 session。
 * 从后向前找到第一条 role="assistant" 的消息，检查其 content
 * 是否精确等于 guard 输出的两种可能值。
 *
 * 使用字符串 === 比较而非 JSON.parse：
 *   1. 无需解析大段 transcript，零内存额外开销
 *   2. guard 输出格式是 Codex 协议的固定契约，不随 system prompt 变更
 *   3. 用户不可能恰好键入 {"outcome":"allow"} 作为对话内容
 */
function isCodexGuardSession(messages: unknown[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as Record<string, unknown>;
    if (msg?.role !== "assistant") continue;
    const c = msg.content;
    if (typeof c !== "string") return false;
    return c === '{"outcome":"allow"}' || c === '{"outcome":"deny"}';
  }
  return false;
}
```

在 `extractLatestUserMessage` 开头调用：

```typescript
export function extractLatestUserMessage(...): TdaiMessage | null {
  if (isCodexGuardSession(messages)) {
    console.log("[L0-GUARD] detected Codex guard session, skipping L0 record (msgs=" + messages.length + ")");
    return null;  // 整条请求跳过 L0
  }
  // ... 正常提取逻辑
}
```

**设计原则**：
1. **不依赖 system prompt 文本** —— 不匹配 `"You are judging"`，换 prompt 不受影响
2. **不依赖正则表达式** —— 字符串精确比较，零误伤
3. **不依赖消息数量或长度** —— 只看 assistant 输出格式
4. **及时丢弃** —— 找到第一条 assistant 就判断完毕，不遍历全部消息；return null 后 `recordTdaiTurn` 直接 `if (!userMessage) return`，L0 零写入

**验证结果**（2026-08-12 实际日志）：

```
[L0-GUARD] detected Codex guard session, skipping L0 record (msgs=11)
[L0-GUARD] detected Codex guard session, skipping L0 record (msgs=13)
[L0-GUARD] detected Codex guard session, skipping L0 record (msgs=15)
[L0-GUARD] detected Codex guard session, skipping L0 record (msgs=17)
[L0-GUARD] detected Codex guard session, skipping L0 record (msgs=19)
```

5 次 guard 审批全部拦截，正常对话不受影响。

### 7.3 User 消息提取（现有逻辑，确认正确）

`extractLatestUserMessage` 对正常 Codex 请求的提取逻辑：

```
messages[last] 向前扫描
  → 找到第一条 role="user"
    → codebuddyAdapter.extractUserText(content)
      → extractUserQueryText(content)  ← 共用文本清洗
        → 优先 <user_query> 块 → XML wrapper 剥离 → 段落/行级过滤
        → 返回纯用户输入 / ""（全是噪声）
```

对于 trace 行 4 的正常请求（`user("你是Codex吗？你知道Codex最近的热点信息吗？给我整理一下吧")`），最后一条 user 就是用户真实输入，经过 `extractUserQueryText` 无匹配的噪声规则 → 原样返回。✅

### 7.4 去重机制

同 7.3 已存在且正确运行。不再赘述。核心规则：
- `l0UserDedup`: `Map<sessionId, Set<contentHash>>`
- `l0AssistantDedup`: `Map<sessionId, Set<contentHash>>`
- user 和 assistant **分开追踪**（否则 tool-call 循环中 assistant 从 null 逐步累积 → hash 每次不同 → 去重失效）
- 每 session 上限 100 条，超出淘汰前半

### 7.5 涉及文件

| 文件 | 本次改动 |
|------|---------|
| `tdai/recorder.ts` | **新增** `isCodexGuardSession()` + 在 `extractLatestUserMessage` 首行调用 |
| `handler.ts` | trace dump 代码（已保留，后续可复用）；stream 路径 L0 使用 `stripTranscriptArtifacts(assistantContent)` |
| `common/user-query-extractor.ts` | **清理**：移除了 7 条 `CODEX_SYSTEM_MESSAGE_PATTERNS` 和 `isCodexSystemMessage()` 方法（基于正则的特定内容匹配方案被废弃） |

### 7.6 教训

1. **先取证再写代码**：2.3 MB 的 trace dump 文件让我们看到 Codex 实际发出的两类请求。没有这个数据，"guard 请求经过 proxy"这个事实无法从文档推断——Codex 的内部架构在公开文档中没有描述。trace → 分析 → 设计 → 实现的顺序避免了之前"换 4 种策略都没用"的循环。

2. **按结构区分，不按内容匹配**：Codex guard 和正常对话的区别不在 system prompt 文本（可能被更新），而在 assistant 输出的格式（单行 JSON `{"outcome":"allow"/"deny"}` vs 自然语言）。这是协议层面的契约，比文本特征稳定。同理，user 消息的区分靠位置（最后一条）而非内容模式（AGENTS.md 的内容随时可能变）。

3. **字符串比较优于正则/JSON.parse**：`c === '{"outcome":"allow"}'` 比 `/^{"outcome":"(allow|deny)"}$/` 更简洁，比 `JSON.parse(c).outcome` 更快（不解析 50 KB transcript）。在判断"是不是 guard"这个场景中，不需要解析 JSON —— 只需要精确匹配两个已知字符串。

4. **废弃方案要及时清理**：`isCodexSystemMessage` 的 7 条正则规则是针对 AGENTS.md 内容写的模式匹配，换一套提示词就失效。从 trace 数据确认了问题不在"user 消息里夹了系统文本"，而在"guard 请求整体混入了 pipeline"后，整个 content-pattern-based 过滤方案被废弃，代码删除，用结构判断替代。
---

## 八、非阻断性运行日志

**状态**：⚠️ 保留观察

1. **问题描述**：以下日志在容器启动或运行中反复出现，但不影响记忆注入或 L0/L1 主链路，属于配置不完整导致的小问题：
    - `[hook-cache] putMany failed ... FOREIGN KEY constraint failed` — hook cache 写入时 `spaceId` 为空，和 `sessions` 的外键不一致
    - `CREDIT_REPORT fetch failed / timeout` — 计费地址为默认示例（`gateway.example.com`）不可达
    - `rate_limit.fail_open reason=redis_unavailable` — Redis 未启用时限流 fail-open

2. **解决方法**：保留观察，按需处理。统一空 `spaceId` 与 `default` 的规范化，确保 session 父记录先于 hook cache 写入；不需要计费时显式关闭 credit report；Redis 按部署要求决定是否启用。

---

## 九、记忆系统设计约定与待验证项

### 9.1 命名规范与身份模型

**状态**：✅ 已确定

1. **问题描述**：早期供应商和文档中混用了描述性名称、team/agent/task id 和中文备注，难以看清对应关系；同时 task 被写得像固定长期身份，但 team 和 agent 才需要固定，task/session 不一定固定。

2. **解决方法**：统一使用 `U(User){N1}-T(Team){N2}-A(Agent){N3}-Tsk(Task){N4}` 代号表达，详细 id 和含义放备注或映射表。cc-switch 供应商名称改为直观项目名（测试项目、隔离项目等）。身份模型以 team + agent 为主要边界，task 用于具体测试链路和会话区分。后续新增供应商沿用此规则。

### 9.2 团队共享记忆与私有记忆边界

**状态**：⚠️

1. **问题描述**：需验证同一 team 内不同 agent/user 是否能在共享开启时继承记忆，以及私有 agent 或不同 team 是否不会互通。

2. **当前方案**：逐个切换 cc-switch 供应商与对应 agent 完成多轮对话，观察 8125 仪表盘 L0-L3 和召回表现。验收标准：同 team 共享 agent 能看到共享记忆；私有或不同 team agent 不能看到不应继承的记忆；多会话能区分清楚。

### 9.3 L1 触发与记忆沉淀

**状态**：⚠️

1. **问题描述**：多次请求后 L1/L2 记忆沉淀不多，L1 生成依赖后台异步 pipeline，不一定实时出现。

2. **当前方案**：每个供应商至少 10 轮真实对话制造足够上下文，在 8125 仪表盘观察 L0-L3 沉淀。若仍不触发，继续检查 pipeline、抽取模型、异步任务日志。

### 9.4 记忆召回与注入时机

**状态**：⚠️

1. **问题描述**：两项待验证——(a) 不配置 embedding 时，仅靠 L2/L3 注入是否能达到长期记忆效果，召回精度、覆盖面和相关性可能下降；(b) 记忆注入是每次请求实时通过 proxy 获取还是会话开始时形成冻结版本，实时注入则新沉淀记忆可在同会话后续轮次可见，冻结版本则需开新会话。

2. **当前方案**：(a) 先不启用 embedding，重点验证 L2/L3 是否形成可感知长期记忆，后续对比有 embedding 的效果；(b) 在一次会话中写入明显事实，等待 pipeline 完成后继续同会话追问，再开新会话追问做对比，同时观察代理日志或仪表盘时间戳判断注入时机。
