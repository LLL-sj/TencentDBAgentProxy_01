# 新 Agent 工作交接（TencentDB-Agent-Memory · 第五轮）

> 接续：
> - `NEW_AGENT_HANDOFF4.md`（第四轮：Phase 1/2 已完成，Phase 3 待实现）
> - `memory-agent/08_Phase3_L1v2_提示词评审稿.md`
> - `memory-agent/CodeMemoryV2-Prompt-Migration.md`
>
> 本轮（第五轮）已完成：
> - **Phase 3 L1 v2 提示词 + `codeMemoryVersion` 开关**
> - **Phase 4 Project Memory 打包器 + `project/*` 只读端点 + Proxy v2 注入切换**
>
> **Phase 5 / Phase 6 尚未开始**。新 Agent 必须先读完本文件，再核对现场，然后继续 Phase 5。

---

## 0. 先读这些文件（按顺序）

| 优先级 | 文件 | 作用 |
|---|---|---|
| 必读 | `NEW_AGENT_HANDOFF4.md` | 环境/账号/镜像/端口/避坑清单；Phase 1/2 交付结论 |
| 必读 | `memory-agent/05_TeamNotes_CodeMemoryV2_目标与计划.md` | 总计划、验收标准、回滚口径 |
| 必读 | `memory-agent/08_Phase3_L1v2_提示词评审稿.md` | 已审批 L1 v2 System/User Prompt 与短文本 |
| 必读 | `MemoryCore/src/core/prompts/code-v2/README.md` | Phase 3/4 新提示词目录说明 |
| 必读 | `MemoryCore/src/core/prompts/code-v2/l1-extraction-with-tips.ts` | Phase 3 实现 |
| 必读 | `MemoryCore/src/core/prompts/code-v2/l2-project-packager.ts` | Phase 4 L2.5 System Prompt |
| 必读 | `MemoryCore/src/utils/project-memory-packager.ts` | Phase 4 打包器/索引/读写搜索 |
| 参考 | `MemoryCore/src/core/record/l1-extractor.ts` | L1 抽取器 v2 分支 |
| 参考 | `MemoryProxy/src/injection/injectors/tdai-profile-memory-injector.ts` | v1/v2 注入切换 |
| 参考 | `MemoryCore/src/gateway/v2-router.ts` | `/v3/project/*` 核心端点 |
| 参考 | `MemoryProxy/src/memory/memory-bridge.ts` | Proxy 只读 allowlist |

---

## 1. 当前现场快照（交接时）

- 仓库：`/home/luuu/Desktop/TencentDB-Agent-Memory`
- 分支：`feat/server_team`，HEAD `fe3230f`
- **全部改动仍未 git commit**，`git status` 约 85 项未提交改动，提交前必须核对。
- 三容器状态：
  ```text
  tdai-memory-core   healthy
  tdai-memory-hub    healthy
  tdai-proxy         healthy
  ```
- `.env` 已恢复为安全默认：
  ```bash
  MEMORY_CODE_MEMORY_VERSION=v1
  MEMORY_PROJECT_MEMORY_ENABLED=false
  MEMORY_PROMPT_MODE=code
  ```
- 测试数据已清理：`summary_tips` 为 0；`project/` 冒烟 topic 和 MEMORY.md 已删除。
- 镜像 ID 与第四轮一致：
  ```text
  agentmemory/memory-hub:local                             71b8ccbd596d
  agentmemory/memory-hub:local-backup-20260817-phase1-pre  7de641575251
  agentmemory/memory-core:local                            2014b92833ab
  agentmemory/memory-proxy:local                           4870464ae321
  ```

---

## 2. 第五轮完成了什么

### 2.1 Phase 3：L1 v2 提示词与开关

**新增：**

| 文件 | 内容 |
|---|---|
| `MemoryCore/src/core/prompts/code-v2/l1-extraction-with-tips.ts` | `EXTRACT_WORK_MEMORIES_WITH_TIPS_SYSTEM_PROMPT`（原样来自 08 §2）；`formatL1V2ExtractionPrompt`；SUMMARY_TIP 块渲染、锚点排序、消息流插入 |
| `MemoryCore/src/core/prompts/code-v2/l1-extraction-with-tips.test.ts` | 9 个单测 |
| `MemoryCore/src/core/prompts/code-v2/README.md` | v2 提示词目录说明 |
| `memory-agent/prompts/code-v2/01_L1_extraction_with_tips.md` | 人工可读副本 |

**修改：**

- `MemoryCore/src/config.ts`
  - 新增 `CodeMemoryVersion = "v1" | "v2"`；
  - `MemoryTdaiConfig` 新增 `codeMemoryVersion`（默认 `v1`）和 `l1V2` 短文本组；
  - 三个短文本默认值：`summaryTipBlockTemplate` / `noSummaryTipsText` / `summaryTipRuleText`。
- `MemoryCore/src/core/record/l1-extractor.ts`
  - options 新增 `codeMemoryVersion` / `l1V2ShortTexts` / `summaryTipsStore`；
  - 仅 `promptMode=code && codeMemoryVersion=v2` 时走 v2 提示词；
  - tips 从 SQLite `summary_tips` 读 `status='pending'`，按 session/task 过滤；
  - **tip 插入策略**：按 `l0_end_ref` 插入到待提取新消息流中（找不到锚点时先试 `l0_start_ref`，再追加到新消息末尾）；下方 Agent 任务总结区放规则提示行，无 tips 时放占位文本；
  - LLM 输出新增字段 `source_refs` / `confidence` 由解析器合并写入 `metadata_json`，L1 主表结构不变；
  - `codeMemoryVersion=v1` 完全走旧 `code/l1-extraction.ts` 路径，旧文件未改。
- `MemoryCore/src/utils/pipeline-factory.ts`
  - L1 runner 透传 `cfg.codeMemoryVersion` 和 `cfg.l1V2`。
- `deploy/global-images/start-memory-core.sh`
  - 生成 `memory.codeMemoryVersion` / `memory.l1V2` / `memory.projectMemory`；
  - 新增挂载 `l1-extractor.ts`、`pipeline-factory.ts`、`project-memory-packager.ts`、`tdai-core.ts`。
- `deploy/global-images/.env.example`
  - 新增 `MEMORY_CODE_MEMORY_VERSION`、`MEMORY_L1_V2_*`、`MEMORY_PROJECT_MEMORY_*`。

### 2.2 Phase 4：Project Memory 打包器与 v2 注入切换

**新增：**

| 文件 | 内容 |
|---|---|
| `MemoryCore/src/core/prompts/code-v2/l2-project-packager.ts` | L2.5 System Prompt（工程经验文件维护者）+ User Prompt builder |
| `MemoryCore/src/utils/project-memory-packager.ts` | frontmatter 校验、`project/topics/*.md` 读写/搜索、`project/MEMORY.md` 确定性索引、触发就绪判断、LLM 文件工具沙箱、tips 消费状态推进、packager state |
| `MemoryCore/src/utils/project-memory-packager.test.ts` | 4 个单测 |
| `MemoryCore/src/core/record/l1-extractor.v2.test.ts` | L1 v2 端到端单测（fake LLM + SQLite tips）2 个 |

**修改：**

- `MemoryCore/src/utils/pipeline-factory.ts`
  - L1 runner 完成一批后，按 team+agent profile scope 触发 `runProjectMemoryPackager`；
  - `projectMemory.enabled=false` 时不触发；
  - 打包器使用 `projectMemoryLLMRunner`（需 `enableTools=true`）。
- `MemoryCore/src/core/tdai-core.ts`
  - 为 `createL1Runner` 传入 tool-enabled runner。
- `MemoryCore/src/gateway/v2-router.ts`
  - 新增核心只读端点：`POST /v3/project/list|read|search`；
  - 按 `team+agent` profile scope 读写 `profiles/<scope>/project/*`；
  - `/v3/project/list` 同时返回 `items` 和 `index`（`project/MEMORY.md` 正文）。
- `MemoryProxy/src/config.ts` / `types.ts` / `tdai/types.ts`
  - `tdai.memory.codeMemoryVersion: v1 | v2`（默认 v1）。
- `MemoryProxy/src/tdai/client.ts`
  - 新增 `readProjectIndexForCtx` / `listProjectForCtx` / `readProjectForCtx` / `searchProjectForCtx`。
- `MemoryProxy/src/memory/memory-bridge.ts`
  - allowlist 放行 `project/list` / `project/read` / `project/search`。
- `MemoryProxy/src/injection/injectors/tdai-profile-memory-injector.ts`
  - `codeMemoryVersion=v2`：只注入 `project/MEMORY.md` 索引 + project 工具说明；不注入旧 L3 Doctrine / L2 scene index；
  - `v1`：完全保留旧 `<tdai_profile_memory>` 行为。
- `deploy/global-images/start-proxy.sh`
  - 生成 `tdai.memory.codeMemoryVersion`；
  - 新增挂载 `memory-bridge.ts`、`tdai/client.ts`、`tdai/types.ts`；
  - 新增可选的 `PROXY_DEBUG_FORCE_IDENTITY=1` 本地调试会话注册（需同时给 `PROXY_DEBUG_TEAM_ID` / `PROXY_DEBUG_AGENT_ID` / 可选 `PROXY_DEBUG_TASK_ID`）。
- `MemoryProxy/config.example.yaml`
  - 新增 `tdai.memory.codeMemoryVersion`。

---

## 3. 本轮已执行并通过的验证

### 3.1 编译与单测

| 命令 | 结果 |
|---|---|
| `cd MemoryCore && npx vitest run src/core/prompts/code-v2/l1-extraction-with-tips.test.ts src/core/record/l1-extractor.v2.test.ts src/core/tips/summary-tips.test.ts src/utils/project-memory-packager.test.ts` | ✅ 20/20 |
| `cd MemoryCore && npx tsdown` | ✅ |
| `cd MemoryProxy && npx tsc --noEmit` | ✅ |

### 3.2 Phase 3 单测覆盖

- v2 System Prompt 关键规则存在；
- SUMMARY_TIP 块占位符渲染、summary 截断；
- tips 按 `l0_end_ref` 插入到正确位置；
- 无 tips 时占位文本；
- `parseConfig` 默认 v1 + 短文本默认值；v2 覆盖生效；
- fake LLM + 内存 SQLite：v2 注入 pending tip、`source_refs`/`confidence` 写入 metadata；
- v1 时 prompt 不含 SUMMARY_TIP、metadata 不新增字段。

### 3.3 Phase 4 单测覆盖

- topic frontmatter 解析、列表/读取/搜索；
- MEMORY.md 索引生成、tag 分组、hash；
- `topicMaxChars` 强制截断；
- fake tool-call LLM 写 topic → 校验 → 重建 MEMORY.md → pending tips 标记 consumed。

### 3.4 容器端到端验证（已执行）

- 三容器分别以 `v1` 和 `v2` 启动，均 healthy。
- v2 状态下：
  - Core `/v3/project/list|read|search` 返回正常，team+agent 隔离生效；
  - 手工写入 topic 后，list/read/search 均正确；
  - 运行 `writeProjectMemoryIndex` 后，`project/list` 返回 `index` 正文；
  - Proxy 未初始化会话访问 `/memory-bridge/v3/project/*` 返回 `40101`；
  - 用 `PROXY_DEBUG_FORCE_IDENTITY` 初始化会话后，Proxy project bridge 转发成功；
  - Proxy 日志确认 v2 注入 `<tdai_project_memory>`，未出现旧 `<tdai_profile_memory>`。
- v1 状态下：
  - Proxy 日志确认仍注入旧 `<tdai_profile_memory>`；
  - `project` 块出现次数为 0。
- 最终恢复默认：`.env` 为 `v1` / `projectMemory.enabled=false`，三容器 healthy，测试数据清理。

---

## 4. 新 Agent 必做检查清单（先检查，再开发）

1. `git status --short`，确认第 2 节新增/修改文件都在。
2. 复跑：
   ```bash
   cd MemoryCore && npx vitest run src/core/prompts/code-v2/l1-extraction-with-tips.test.ts src/core/record/l1-extractor.v2.test.ts src/core/tips/summary-tips.test.ts src/utils/project-memory-packager.test.ts && npx tsdown
   cd ../MemoryProxy && npx tsc --noEmit
   ```
3. 检查容器和配置：
   ```bash
   export DOCKER_CONFIG=/tmp/docker-cfg
   docker ps --format '{{.Names}}\t{{.Status}}' | grep tdai
   grep -n 'codeMemoryVersion' deploy/global-images/.memory-core-config/tdai-gateway.yaml
   grep -n 'codeMemoryVersion' deploy/global-images/.proxy-config/config.yaml
   ```
   默认应为 `v1`。
4. 最小冒烟：
   ```bash
   curl -sS http://localhost:8420/health
   curl -sS -X POST http://localhost:8420/v3/tips/list \
     -H 'content-type: application/json' -H 'authorization: Bearer local' \
     -H 'x-tdai-service-id: default' \
     -d '{"team_id":"team-w513ek28vu","agent_id":"agt-xb1fvpz2la","user_id":"usr-w3yr3upi6l"}'
   curl -sS -X POST http://localhost:8420/v3/project/list \
     -H 'content-type: application/json' -H 'authorization: Bearer local' \
     -H 'x-tdai-service-id: default' \
     -d '{"team_id":"team-w513ek28vu","agent_id":"agt-xb1fvpz2la","user_id":"usr-w3yr3upi6l"}'
   ```
   > 注意：HANDOFF4 第 5 节的 tips 冒烟命令漏了 `x-tdai-service-id`；补上后正常。
5. v2 快速复验方法（可选）：
   - 改 `.env`：`MEMORY_CODE_MEMORY_VERSION=v2`、`MEMORY_PROJECT_MEMORY_ENABLED=true`；
   - `./stop-all.sh && ./start-all.sh`；
   - 用 `PROXY_DEBUG_FORCE_IDENTITY=1` 起 proxy（见 `start-proxy.sh` 注释）；
   - 检查 proxy 日志出现 `<tdai_project_memory>`。
   - 测完改回 v1/false 再重启。
6. **不要对 MemoryCore 跑全量 `tsc --noEmit`**；仍只跑 targeted vitest + tsdown。
7. 最终提交前，建议重建 core/proxy 镜像验证（当前仍是旧镜像 + 源码挂载）。

---

## 5. 下一阶段（Phase 5，供新 Agent 继续）

Phase 5：面板展示 L0.5 tips。
- 列表/详情/L0 锚点/状态/tags；
- 建议先读 `MemoryPanel/web/src/pages/` 现有 memory/chat 页面风格，再仿照 `NotesPage` 增加 tips 页面或复用现有 memory 页面；
- 面板 API 可复用 MemoryCore `/v3/tips/list|get`（注意面板后端要补 team member 门控与知识客户端透传，参考 `MemoryPanel/src/panel/http/routes/notes.ts`）。

Phase 6（之后）：
- 三服务整体测试；
- v1/v2 切换回滚验证；
- 更新 `memory-agent/02_修改说明与实施记录.md`，新增 `memory-agent/04_code_memory_v2_改造记录.md`；
- 建议重建三镜像、清理备份文件、再统一 git commit。

---

## 6. 关键环境与账号提醒

- admin key：`deploy/global-images/.admin-key`。
- 林婷账号已注销，不要再用；测试可用 admin。
- header 预选：
  ```text
  x-team-id: team-w513ek28vu
  x-agent-id: agt-xb1fvpz2la
  x-task-id: task-w56hiyww0x
  ```
- Docker 写操作带 `DOCKER_CONFIG=/tmp/docker-cfg`。
- core/proxy 源码挂载清单已更新，新增文件必须保持宿主可读（644）。

---

## 7. 已知风险 / 限制

1. **全部改动未 commit**；Phase 1–4 均未提交 Git。
2. `summary_tips` / project packager 只在 SQLite-backed store 可用；TCVDB service 模式不工作。
3. `project/MEMORY.md` 的 scope 与旧 L2/L3 一致：`profiles/team:<team>|agent:<agent>/project/*`。
4. 打包器只有在 LLM 成功写完并完成索引重建后才把 tips 标记为 `consumed`；失败保留 `pending`。
5. `PROXY_DEBUG_FORCE_IDENTITY` 仅供本地调试，生产禁止开启。
6. `codeMemoryVersion=v2` 时，`TdaiToolsInjector` 仍会注入 L0/L1 memory tools（这是预期的，L1 检索仍可用）。
7. 本阶段未改 MemoryPanel；Phase 5 前端尚未开始。
8. 当前 core/proxy 容器依赖源码挂载，最终发布前需要重建镜像并移除对宿主机路径的依赖。
9. HANDOFF4 中“tips 按 l0_end_ref 对应位置插入”与 08 评审稿 §3 的“单独总结区”存在轻微表述差异；本轮实现以 HANDOFF4 为准：tip 块插入消息流，单独总结区放规则/占位文本。

---

## 8. 回滚口径

```bash
# Code Memory v2 功能回滚
# .env 改回：
MEMORY_CODE_MEMORY_VERSION=v1
MEMORY_PROJECT_MEMORY_ENABLED=false
cd deploy/global-images && ./stop-all.sh && ./start-all.sh

# hub 镜像回滚（Phase 1 之前）
docker tag agentmemory/memory-hub:local-backup-20260817-phase1-pre agentmemory/memory-hub:local
cd deploy/global-images && ./stop-all.sh && ./start-all.sh

# 全项目备份
ls -l backups/
```
