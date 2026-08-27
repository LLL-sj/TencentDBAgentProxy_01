# 新 Agent 工作交接（TencentDB-Agent-Memory · 第四轮）

> 接续：
> - `NEW_AGENT_HANDOFF.md`（第一轮：code 模式改造）
> - `NEW_AGENT_HANDOFF2.md`（第二轮：环境/账号/镜像与 agent 挂载）
> - `NEW_AGENT_HANDOFF3.md`（第三轮：Phase 1 Team Notes 交接）
>
> 本文件是第四轮交接。前两个阶段已完成并验证：
> - **Phase 1 Team Notes 已完成交付**
> - **Phase 2 L0.5 summary_tips 已完成交付**
> - **Phase 3 L1 v2 提示词已由用户审批，但代码尚未实现**
>
> 新 Agent 必须先把本文件读完，再检查现场，然后继续执行 Phase 3 代码实现。

---

## 0. 先读这些文件（按顺序）

| 优先级 | 文件 | 作用 |
|---|---|---|
| 必读 | `NEW_AGENT_HANDOFF2.md` | 环境权限、镜像/端口、账号、避坑清单 |
| 必读 | `memory-agent/06_Phase1_TeamNotes_交付报告.md` | Phase 1 交付内容与验证记录 |
| 必读 | `memory-agent/07_Phase2_Tips_交付报告.md` | Phase 2 交付内容与验证记录 |
| 必读 | `memory-agent/08_Phase3_L1v2_提示词评审稿.md` | Phase 3 已审批提示词、短文本配置、占位符 |
| 必读 | `memory-agent/05_TeamNotes_CodeMemoryV2_目标与计划.md` | 7 阶段总计划、验收标准、回滚口径 |
| 参考 | `memory-agent/CodeMemoryV2-Prompt-Migration.md` | Phase 2–4 详细设计 |
| 参考 | `memory-agent/TeamNotes-TagGraph-Design.md` | Phase 1 设计 |

---

## 1. 当前现场快照

- 仓库：`/home/luuu/Desktop/TencentDB-Agent-Memory`
- 分支：`feat/server_team`，HEAD `fe3230f`
- **全部改动均未 git commit**，`git status` 有大量未提交改动，提交前必须核对。
- 容器状态（交接时）：
  ```text
  tdai-memory-core   Exited
  tdai-memory-hub    Exited
  tdai-proxy         Exited
  ```
  启动方式：
  ```bash
  cd /home/luuu/Desktop/TencentDB-Agent-Memory/deploy/global-images
  export DOCKER_CONFIG=/tmp/docker-cfg
  ./stop-all.sh
  ./start-all.sh
  ```
- 镜像：
  ```text
  agentmemory/memory-hub:local                             71b8ccbd596d  ← Phase 1 新镜像
  agentmemory/memory-hub:local-backup-20260817-phase1-pre  7de641575251  ← 旧镜像备份
  agentmemory/memory-core:local                            2014b92833ab  ← 源码挂载热更新
  agentmemory/memory-proxy:local                           4870464ae321  ← 源码挂载热更新
  ```
- 端口：面板 8125 / 内核 8420 / proxy 8096 / knowledge 8424
- `.env` 已配置：`MEMORY_PROMPT_MODE=code`、LLM 走中转 `api.zhongjx.xyz`。
- 数据卷：`tdai-memory-core-data`、`tdai-panel-data` 保留；测试数据已清理。

---

## 2. 第四轮之前完成了什么（新 Agent 检查范围）

### 2.1 Phase 1 Team Notes（已完成，详见 `06_Phase1_TeamNotes_交付报告.md`）

主要改动：

| 位置 | 文件 | 状态 |
|---|---|---|
| Knowledge | `MemoryKnowledge/src/store/team-notes-service.ts` / `.test.ts` | 新增 |
| Knowledge | `MemoryKnowledge/src/routes/notes.ts` | 新增 |
| Knowledge | `MemoryKnowledge/src/db/schema.ts` / `db/client.ts` / `store/ids.ts` / `module.ts` / `server.ts` | 修改 |
| Panel 后端 | `MemoryPanel/src/panel/http/routes/notes.ts` | 新增 |
| Panel 后端 | `knowledge-client-port.ts` / `http-knowledge-client.ts` / `http/app.ts` | 修改 |
| 前端 | `MemoryPanel/web/src/lib/notes-api.ts` | 新增 |
| 前端 | `MemoryPanel/web/src/pages/notes/NotesPage/index.tsx` / `NotesGraph.tsx` | 新增 |
| 前端 | `routes/index.tsx` / `constants/menu.tsx` / `ConsoleLayout.tsx` / i18n | 修改 |
| Proxy | `MemoryProxy/src/notes-bridge.ts` | 新增 |
| Proxy | `injection/injectors/note-tools-injector.ts` | 新增 |
| Proxy | `injection/index.ts` / `server.ts` / `config.ts` / `types.ts` | 修改 |
| 部署 | `deploy/global-images/start-proxy.sh` | 修改：knowledge 配置、notes injector、源码挂载 |
| 部署 | `deploy/panel-knowledge-combined/build.sh` | 修改：`APT_MIRROR=mirrors.aliyun.com` |

第四轮修复过的问题：

1. 前端 `ReactMarkdown` 不支持 `className` → 外层 div。
2. `notes-api.ts` 路径重复 `/notes/notes/...` → 改为 `/list` 等。
3. Mermaid 中文 tag slug 节点 ID 冲突 → 改为顺序 `n1/n2/...`。
4. Proxy 存量 TypeScript 编译错误 9 处 → 已修复，`tsc --noEmit` 通过。
5. `start-proxy.sh` 漏配 notes bridge/knowledge/源码挂载 → 已补齐。
6. 新增 Proxy 文件权限 600 导致容器 EACCES → 已改 644。
7. `build.sh` 未透传 apt 镜像 → 已支持。

### 2.2 Phase 2 L0.5 summary_tips（已完成，详见 `07_Phase2_Tips_交付报告.md`）

主要改动：

| 位置 | 文件 | 状态 |
|---|---|---|
| MemoryCore | `src/core/tips/summary-tips.ts` | 新增：DDL、`SummaryTipsStore`、anchor 解析、去重 |
| MemoryCore | `src/core/tips/summary-tips.test.ts` | 新增：5 个单测 |
| MemoryCore | `src/core/store/sqlite.ts` | 修改：initSchema 创建 `summary_tips` |
| MemoryCore | `src/gateway/v2-router.ts` | 修改：`/v3/tips/submit|list|get` |
| MemoryCore | `src/config.ts` | 修改：`TipsConfig`、`ProjectMemoryConfig` 解析 |
| Proxy | `src/tips-bridge.ts` | 新增：`/memory-bridge/v3/tips/submit` |
| Proxy | `src/injection/injectors/summary-tips-contract-injector.ts` | 新增：静态契约 + 动态提醒 |
| Proxy | `src/injection/index.ts` | 修改：注册 summary-tips injectors |
| Proxy | `src/server.ts` | 修改：tips bridge 注册在 memory-bridge 通配之前 |
| Proxy | `src/config.ts` / `src/types.ts` / `config.example.yaml` | 修改：`tips` 配置 |
| 部署 | `start-memory-core.sh` | 修改：生成 `memory.tips`，挂载 tips/v2-router/config 源码 |
| 部署 | `start-proxy.sh` | 修改：生成 proxy `tips`，injectors 增加 summary-tips，挂载新源码 |
| 部署 | `.env.example` | 修改：`MEMORY_TIPS_*` |

已验证：

- Core tips submit/list/get、去重、team 隔离。
- Proxy bridge 强制覆盖身份。
- `anchor_mode=message_text` 解析为 L0 `record_id`。
- `<summary_tips_contract>` 首轮注入成功。
- 动态提醒 final answer 下一轮注入 1 次。

### 2.3 Phase 3 提示词（只完成审批，未写代码）

- 审批文件：`memory-agent/08_Phase3_L1v2_提示词评审稿.md`
- 状态：**提示词已审批，L0–L3 分层口径按该文件 §1.1 执行**。
- 下一步：把 §2/§3/§4 落到 `MemoryCore/src/core/prompts/code-v2/` 和配置中。

---

## 3. 已确认的记忆机制（以本节为准，其他文档冲突时修改其他文档）

### 3.1 通用骨架

```text
L0 原始对话
  → L1 从 L0 抽取结构化原子记忆
  → L1 去重/合并
  → L2 把 L1 碎片聚合成可复用文档
  → L3 从 L2 生成长期索引/纲领
```

### 3.2 chat 模式（v1，保持不动）

| 层 | 产出 |
|---|---|
| L0 | `l0_conversations` 原始对话 |
| L1 | `persona / episodic / instruction` |
| L2 | `scene_blocks/*.md` 用户场景叙事 |
| L3 | `persona.md` 用户画像（≤2000 字） |

### 3.3 code 模式 v1（当前线上）

| 层 | 产出 |
|---|---|
| L0 | `l0_conversations` 原始对话 |
| L1 | `work_fact / work_task / work_method / work_artifact` |
| L2 | `scene_blocks/*.md` 工作方法场景块 |
| L3 | `persona.md` Team Operating Doctrine（≤1200 字） |

### 3.4 code 模式 v2（目标态）

| 层 | 规则 | 关键点 |
|---|---|---|
| L0 | 原始对话流水 | 唯一事实来源 |
| L0.5 | Agent 在任务/流程完整结束后主动提交 `summary_tips` | 不是每轮写；带 L0 锚点 |
| L1 | 从 L0 抽取结构化原子记忆 | L0.5 只作为高价值提示/锚点，不是“进一步总结的输入正文” |
| L1 去重 | 在 L1 内部，不在 L2 | 复用 `code/l1-dedup.ts` |
| L2 | 工程代码 + LLM 维护 `project/topics/*.md` | 不是 L1 去重，不是聊天记录；产出 SOP / Pitfall / Decision / Method |
| L3 | 代码扫描 topics frontmatter 生成 `project/MEMORY.md` | 不调 LLM；session_init 只注入 MEMORY.md，topic 正文按需读 |

**两个已经纠正的口径：**

1. **L1 不是“多个 L0 + L0.5 的进一步总结”**：L1 输入主体仍是 L0 原文；L0.5 只是提升对应段落优先级。
2. **L2 不是“L1 的去重、场景/任务提取”**：L1 去重发生在 L1 内部；code v2 的 L2 是项目经验打包器。

---

## 4. 触发与兜底机制（之前已做好，不要重复开发）

### 4.1 L1 / L2 / L3 主链路（已存在）

| 机制 | 配置 | 兜底 |
|---|---|---|
| L1 每 N 轮触发 | `memory.pipeline.everyNConversations` / `MEMORY_L1_EVERY_N` | warmup：新会话从 1→2→4 逼近 N |
| L1 空闲触发 | `pipeline.l1IdleTimeoutSeconds` / `MEMORY_L1_IDLE_TIMEOUT_SECONDS` | 用户停止后计时触发 |
| L1 质量门 | `shouldExtractL1` | 空/低质量消息不送 LLM |
| L1 去重 | `extraction.enableDedup` | 失败时跳过去重但仍可写 L1 |
| L2 触发 | `pipeline.l2DelayAfterL1Seconds` + min/max interval | 到点重试，最迟按 max interval 兜底 |
| L2 会话活性 | `pipeline.sessionActiveWindowHours` | 超时停止轮询，避免僵尸会话 |
| L3 触发 | `persona.triggerEveryN` / `MEMORY_L3_TRIGGER_EVERY_N` | 新 L1 累积到阈值触发 |
| LLM 失败 | 见 `l1-extractor` / scene / persona | 返回失败、留待下轮，不阻断主对话 |

### 4.2 L0.5 summary_tips（Phase 2 已完成）

| 机制 | 位置 | 行为 |
|---|---|---|
| 静态契约 | `summary-tips-contract-injector.ts` | `session_init` 注入，不破坏 prompt cache |
| 动态提醒 | 同文件 `SummaryTipsReminderInjector` | 仅上一轮为 final answer 的下一轮 user.before 注入 |
| 提醒冷却 | `tips.reminderCooldownSeconds` | 同 key 冷却内不重复 |
| 每任务上限 | `tips.maxReminderPerTask` | 同 (session, task) 最多提醒 N 次 |
| 总开关 | `tips.enabled=false` | bridge 返回 403，injector 不注入 |
| 身份兜底 | `tips-bridge.ts` | session 内存未命中 → `getOrRecover` 恢复 |
| 上游兜底 | `tips-bridge.ts` | 5s min timeout，失败 502，不阻断主链路 |

### 4.3 Phase 1 Team Notes（已存在）

| 机制 | 位置 | 行为 |
|---|---|---|
| 乐观锁 | `team-notes-service.ts` | `expected_version` 不匹配返回 40901 |
| 归档 | `team-notes-service.ts` | 软删除 `archived` |
| team 隔离 | service / panel / bridge | 三层都按 team 过滤 |
| 写开关 | `skillRuntime.allowLlmWrite` | 关闭时 bridge create/update/delete 返回 403 |
| 身份兜底 | `notes-bridge.ts` | session L1→L2 恢复 |
| 前端构建 | Dockerfile panel-ui-builder | 生产 build 通过 |

### 4.4 构建 / 启动

- `build.sh` 默认 `APT_MIRROR=mirrors.aliyun.com`。
- hub 无源码挂载，**必须重建镜像**；core/proxy 靠 `start-*.sh` 里的源码挂载 + 重启。
- core/proxy 镜像目前是旧镜像 + 挂载新源码，最终提交前建议重建 core/proxy 镜像验证。

---

## 5. 新 Agent 必做检查清单（先检查，再开发）

1. `git status --short`，确认第 2 节列出的文件都在。
2. 检查新增文件权限；Proxy 新增源码必须宿主可读（`644`），否则容器 EACCES：
   ```bash
   ls -l MemoryProxy/src/notes-bridge.ts \
          MemoryProxy/src/tips-bridge.ts \
          MemoryProxy/src/injection/injectors/note-tools-injector.ts \
          MemoryProxy/src/injection/injectors/summary-tips-contract-injector.ts
   ```
3. 复跑已验证命令：
   ```bash
   cd MemoryKnowledge && npm run typecheck && npm run build && npx vitest run src/store/team-notes-service.test.ts
   cd ../MemoryPanel && npm run typecheck && npm run build
   cd web && npm run build
   cd ../../MemoryProxy && npx tsc --noEmit
   cd ../MemoryCore && npx vitest run src/core/tips/summary-tips.test.ts && npx tsdown
   ```
4. **不要对 MemoryCore 跑全量 `tsc --noEmit`**：MemoryCore 没有根 tsconfig，且存量文件有大量与本次无关的历史类型错误。只跑上面的 targeted vitest + tsdown。
5. 检查两个生成的配置：
   ```bash
   cat deploy/global-images/.memory-core-config/tdai-gateway.yaml | grep -A8 'tips:'
   cat deploy/global-images/.proxy-config/config.yaml | grep -A8 -E 'tips:|injectors:'
   ```
6. 启动三容器后做最小冒烟：
   - `http://localhost:8420/health`
   - `POST /v3/tips/list`（`Authorization: Bearer local`，team 三字段）
   - `http://localhost:8424/v3/notes/list`
   - `POST http://localhost:8096/notes-bridge/v3/notes/tags/list`（未初始化会话应 `40101`）
7. 检查 hub 镜像 ID 是否仍为 `71b8ccbd596d`；如果重启后 hub 不是新镜像，说明镜像被覆盖过。
8. 确认 Phase 2 测试数据已清理：
   ```bash
   docker exec tdai-memory-core node -e "const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync('/data/tdai-memory/vectors.db'); console.log(db.prepare('select count(*) as n from summary_tips').get()); db.close();"
   ```

---

## 6. 新 Agent 要完成的工作

### 6.1 Phase 3（下一阶段，提示词已审批）

目标文件：
- `MemoryCore/src/core/prompts/code-v2/l1-extraction-with-tips.ts`
- `MemoryCore/src/core/prompts/code-v2/README.md`
- `MemoryCore/src/config.ts`（三个短文本配置）
- `MemoryCore/src/core/record/l1-extractor.ts`（v2 分支）
- 开关：`memory.codeMemoryVersion: v1 | v2`（默认 `v1`）

实现要求：

1. 把 `memory-agent/08_Phase3_L1v2_提示词评审稿.md` 的 §2 System Prompt 原样放入 TS。
2. 把 §3 User Prompt 模板实现为 builder。
3. 把 §4 三个短文本放入配置：
   - `L1_V2_SUMMARY_TIP_BLOCK_TEMPLATE`
   - `L1_V2_NO_SUMMARY_TIPS_TEXT`
   - `L1_V2_SUMMARY_TIP_RULE_TEXT`
4. tips 从 `summary_tips` 读取：`status='pending'`，按 session/task 过滤，按 `l0_end_ref` 对应位置插入。
5. 无 tips 时行为必须与 v1 完全一致。
6. 输出新增字段 `source_refs` / `confidence` 由解析器保留进 `metadata_json`，不改变 L1 主表结构。
7. `codeMemoryVersion=v1` 时仍走 `code/l1-extraction.ts`，不要动 v1 文件。

### 6.2 Phase 4

- `MemoryCore/src/utils/project-memory-packager.ts`
- `MemoryCore/src/core/prompts/code-v2/l2-project-packager.ts`
- `project/topics/*.md` + `project/MEMORY.md`
- `projectMemory.*` 配置已提前放进 `config.ts`，直接使用。
- Proxy 只读端点 `project/list|read|search` + v2 注入切换。

### 6.3 Phase 5

- 面板展示 L0.5 tips：列表/详情/L0 锚点/状态/tags。

### 6.4 Phase 6

- 三服务整体测试。
- v1/v2 切换回滚验证。
- 更新 `memory-agent/02_修改说明与实施记录.md` 和新增 `04_code_memory_v2_改造记录.md`。

---

## 7. 关键环境与账号提醒

- admin key：`deploy/global-images/.admin-key`。
- **林婷账号已注销，不要再用**；测试可继续用 admin 或自行创建新用户。
- admin 是 `team-w513ek28vu` 成员；陈皓也是该团队成员。
- 当前测试可直接用 header 预选：
  ```text
  x-team-id: team-w513ek28vu
  x-agent-id: agt-xb1fvpz2la
  x-task-id: task-w56hiyww0x
  ```
- Docker 写操作带 `DOCKER_CONFIG=/tmp/docker-cfg`。

---

## 8. 已知风险 / 限制

1. **全部改动未 commit**。Phase 1/2 均未提交 Git。
2. MemoryCore 无根 tsconfig，全量 tsc 有历史错误；不要按全量 tsc 验收。
3. `summary_tips` 只在 SQLite-backed store 可用；TCVDB service 模式返回 503。
4. Proxy reminder 状态是进程内 Map，容器重启后计数重置。
5. tips 表无删除接口；测试数据需 SQLite 清理。
6. core/proxy 目前是旧镜像 + 源码挂载，最终发布前需重建镜像。
7. Phase 3 尚未写代码；Phase 4/5/6 未开始。
8. 旧 hub 镜像备份 tag 保留：`agentmemory/memory-hub:local-backup-20260817-phase1-pre`。

---

## 9. 回滚口径

```bash
# hub 回滚
docker tag agentmemory/memory-hub:local-backup-20260817-phase1-pre agentmemory/memory-hub:local
cd deploy/global-images && ./stop-all.sh && ./start-all.sh

# 功能回滚
# Team Notes：前端移除 notes 路由；Proxy injectors 去掉 notes，注释 notes bridge
# tips：MEMORY_TIPS_ENABLED=false + proxy tips.enabled=false
# Code Memory v2：codeMemoryVersion=v1，projectMemory.enabled=false

# 全项目备份
ls -l backups/
```
