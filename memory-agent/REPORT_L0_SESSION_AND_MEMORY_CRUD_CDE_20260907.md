# 执行报告：L0 Session / Memory CRUD 阶段 C-D-E + 本地联调修复

> 日期：2026-09-07
> 分支：`feat/server_team`
> 范围：`EXECUTION_PLAN_L0_SESSION_AND_MEMORY_CRUD_20260907.md` 的阶段 C、D、E
> 说明：A/B 已完成；本报告覆盖 C/D/E 源码改动、本地验证、镜像构建、运行权限口径、注入上下文实时性说明、已知未决项。

---

## 1. 本次改动汇总

### 阶段 C：Code L2/L3 编辑/删除端点

| 文件 | 改动 |
|---|---|
| `MemoryCore/src/utils/project-memory-packager.ts` | 新增 `normalizeProjectTopicName`、`writeProjectTopicFile`、`deleteProjectTopicFile`；`readProjectTopic` 统一安全归一化 |
| `MemoryCore/src/gateway/v2-schemas.ts` | 新增 `projectWriteRequestSchema`、`projectRmRequestSchema` |
| `MemoryCore/src/gateway/v2-router.ts` | 新增 `/v3/project/write`、`/v3/project/rm`；路径沙箱；写/删后自动重建 `project/MEMORY.md`；进程内 per-(team,agent) mutation 锁 |
| `MemoryPanel/src/panel/http/routes/project.ts` | 新增 `/api/v1/project/write`、`/api/v1/project/delete`；有 `block_id` 时仅 asset owner 可写 |
| `MemoryPanel/web/src/lib/project-api.ts` | 新增 `projectApi.write/delete` |
| `MemoryPanel/web/src/pages/memory/MemoryPage/components/CodeMemoryDetail.tsx` | Code L2 topic 列表与详情均暴露编辑/删除；`canEdit` 控制展示 |
| `MemoryPanel/web/src/pages/memory/MemoryPage/components/CodeMemoryPanel.tsx` | 向 `CodeMemoryDetail` 传递 `canEdit` |
| `MemoryPanel/web/src/pages/memory/MemoryPage/components/code-memory-detail.css` | L2 列表行级操作按钮样式 |
| `MemoryPanel/web/src/i18n/*.ts` | 编辑/删除相关文案 |

### 阶段 D：Agent 注入端到端

| 文件 | 改动 |
|---|---|
| `MemoryProxy/src/memory/memory-bridge.ts` | 拆分 `READ_SUBPATHS` / `WRITE_SUBPATHS`；新增 `scenario/write|rm`、`core/write`、`project/write|rm`；写操作强制 self-only；写日志带 `write=true self=...` |
| `MemoryProxy/src/injection/injectors/tdai-tools-injector.ts` | `<tdai_memory_tools>` 从只读说明扩展为“读 + 受控写”说明 |
| `MemoryProxy/src/config.ts` | `skillRuntime.allowLlmWrite` 默认开启 |
| `MemoryProxy/config.example.yaml` | 同步示例默认值 |

### 阶段 E：本地镜像构建

- `agentmemory/memory-core:local`
- `agentmemory/memory-hub:local`
- `agentmemory/memory-proxy:local`

未部署到服务器；本地容器已重启到新镜像。

---

## 2. 权限口径：谁可以修改/删除？

### 2.1 面板 UI / Panel API（仪表盘）

| 功能 | 可编辑/删除者 | 说明 |
|---|---|---|
| Chat L2 场景记忆 | 该 chat_memory asset owner | `ChatMemory` 写接口通过 `authorizeChatMemoryWriteScope()` 校验 `asset.owner_user_id === me` |
| Chat L3 Core Memory | 该 chat_memory asset owner | 只允许编辑，不提供删除 |
| Code L2 project topic | 该 chat_memory asset owner | `/project/write`、`/project/delete` 在带 `block_id` 时要求 `asset.owner_user_id === me` |
| Code L3 `project/MEMORY.md` | 当前不直接编辑 | 由 Code L2 topic 写/删后自动重建 |

> 简单说：**默认只有创建者/owner（该记忆资产的 owner_user_id）能改/删。**
> 非 owner 在团队池或借入资产中只能读。

### 2.2 内核 / Agent 写路径

- MemoryCore `/v3/*` 本身依赖调用方传入的 `team_id/user_id/agent_id` 和团队校验，不在每个 handler 重复做“asset owner”判断。
- MemoryProxy `memory-bridge` 只对 Agent 工具开放 **self-only 写**：
  - 写操作只能作用于当前 session 归属的 self agent；
  - 不能通过 `agent_id` 指向 imported/借入 agent；
  - body 中的 `team_id/user_id/agent_id` 会被 proxy 强制覆盖。
- Skill 写能力由 `skillRuntime.allowLlmWrite` 独立控制；本次已默认开启，但部署方可显式设回 `false`。

---

## 3. 注入上下文的实时性说明

### 3.1 结论

**不是所有 hook 都是实时的。**
大部分你关心的“hook 注入结果”使用 `cacheStrategy = "session_init"`，属于 **会话初始化时抓取/生成一次，后续请求命中缓存**，在会话内基本是“冻结快照”。

### 3.2 各 hook 当前策略

| Injector | cacheStrategy | 注入内容是否实时 |
|---|---|---|
| `skill-injector` | `session_init` | 会话开始时拉取 skill 列表，会话内不是实时刷新 |
| `skill-tools-injector` | `session_init` | 静态 curl 工具说明，不依赖数据变化 |
| `note-tools-injector` | `session_init` | 静态工具说明 |
| `summary-tips-contract-injector` | `session_init` | 静态契约说明 |
| `tdai-memory-tools-injector` | `session_init` | 静态 curl 工具说明 |
| `tdai-profile-memory-injector` | `session_init` | L3/长期画像与 L2 索引在 session 初始化时抓取，会话内不自动更新 |
| `summary-tips-reminder-injector` | 默认 `none` | 每轮根据当前消息实时分析并决定是否提醒 |

### 3.3 对“我改了 L2/L3 后为什么 Agent 还看到旧内容”的影响

- 已注入的 L2/L3 快照是 **当前 session 启动时**的版本；
- 修改记忆后，正在进行的旧会话仍可能携带旧快照；
- 需要 **新开一个会话 / 触发 session re-init / 清理 hook cache**，才会重新抓取并注入最新内容；
- Agent 按需读工具（`memory-bridge/v3/*`）是实时读取后端数据的，不受上述冻结影响。

---

## 4. 本地验证

- `MemoryCore npm run build:plugin`：通过
- `MemoryCore npx vitest run`：25/25 通过
- `MemoryPanel npm run typecheck`：通过
- `MemoryPanel/web npx tsc --noEmit`：通过
- `MemoryPanel/web npm run build`：通过（Docker 内执行）
- `MemoryProxy npx tsc --noEmit`：通过
- Docker 三个镜像构建：通过
- 本地容器已重启到新镜像：
  - `tdai-memory-core`：新镜像，healthy
  - `tdai-memory-hub`：新镜像，healthy
  - `tdai-proxy`：新镜像，healthy
- 本地 Panel 写接口已验证不再 404/502：
  - `/api/v1/project/delete` 到 `/v3/project/rm` 可正常返回路径校验 400
  - `/v3/project/write`、`/v3/project/rm` 已在 core 新镜像中注册

---

## 5. 尚未完成 / 需人工确认

1. 服务器仍运行旧镜像，**未同步/未部署**。
2. Code L3 当前保持只读并随 L2 自动重建；若需要手动编辑/重建 L3 按钮，需另行确认。
3. `atomic/update`（L1 修改）默认未开放给 Agent。
4. Code L2 并发锁为进程内锁，多副本部署需补分布式锁。
5. 生产若要求 Skill 默认只读，应将 `skillRuntime.allowLlmWrite` 显式设回 `false`。
