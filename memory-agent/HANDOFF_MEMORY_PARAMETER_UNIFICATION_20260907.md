# Handoff：记忆层参数与统一模型改造（下一步实施手册）

> 日期：2026-09-07
> 分支：`feat/server_team`
> 状态：**下一步实施任务**，不是已完成说明。
> 背景：已完成一轮“成本低、见效快”的全局参数微调；接下来要解决 chat/code 共用参数、L3 触发依据、L2/Skill 结构、L3 索引/总结拆分等重活。
> 目标设计参考：`memory-agent/INVESTIGATION_MEMORY_AND_SKILL_FLOW_20260907.md`
> 历史记录：`memory-agent/MAINTENANCE_AND_CHANGELOG.md` 3.14 / 5.1

---

## 1. 要解决的问题

当前状态是“一套全局触发参数同时服务 chat 与 code”：

- chat 的 L1/L2/L3 偏少；
- code 的 L1/L2 偏多；
- Skill 自动总结偏频繁；
- L3 触发依据仍是“新增 L1 条数”，但它真正消费的是 L2 文件变化；
- L2 与 Skill 都是“维护多文件”，但结构、限制、合并规则没有统一；
- L3 在 chat/code 两侧各缺一半：chat 缺自动索引，code 缺 LLM 总结。

所以不能只继续调数值，需要做结构性改造。

---

## 2. 当前已完成（全局参数阶段）

### 2.1 代码常量/阈值

| 项 | 当前值 | 所在位置 |
|---|---|---|
| L1 单批处理 L0 数 | `L1_BATCH_PROCESS = 25` | `MemoryCore/src/utils/pipeline-factory.ts` |
| L1 单次最多保留记忆 | `10` 条 | 由 `.env` → YAML `memory.extraction.maxMemoriesPerSession` |
| Skill 工具调用阈值 | `15` | YAML `skill.extraction.toolCallThreshold` |
| Skill 归档字节 | `61440`（60KB） | YAML `skill.extraction.archiveBytes` |

### 2.2 环境变量与当前建议值（远程/示例）

| 变量 | 当前值 | 语义 |
|---|---|---|
| `MEMORY_L1_EVERY_N` | `5` | 每 N 个用户轮次触发 L1 |
| `MEMORY_L1_IDLE_TIMEOUT_SECONDS` | `300` | L1 空闲兜底 |
| `MEMORY_L2_DELAY_AFTER_L1_SECONDS` | `120` | L1 后延迟触发 L2 |
| `MEMORY_L2_MIN_INTERVAL_SECONDS` | `180` | 同 session L2 最小间隔 |
| `MEMORY_L2_MAX_INTERVAL_SECONDS` | `600` | 同 session L2 最大兜底 |
| `MEMORY_SESSION_ACTIVE_WINDOW_HOURS` | `2` | 会话超过该小时数停止 L2 周期 |
| `MEMORY_L3_TRIGGER_EVERY_N` | `7` | 新增 L1 达到 N 条评估 L3 |
| `MEMORY_L1_MAX_MEMORIES_PER_SESSION` | `10` | L1 输出条数上限 |
| `MEMORY_SKILL_TOOL_CALL_THRESHOLD` | `15` | Skill 触发阈值 |
| `MEMORY_SKILL_ARCHIVE_BYTES` | `61440` | Skill 归档体积阈值 |

> 这些仍是全局共用；远程 `.env` 已按上表设置，生成配置在 `.memory-core-config/tdai-gateway.yaml`。

---

## 3. 未完成的重任务（按优先级）

### 3.1 让 L1/L2/L3/Skill 触发参数支持 `memory_mode = chat | code`

- 目标：同一字段结构，不同 value；不能让 chat/code 继续抢同一组全局参数。
- 建议配置形态：

```yaml
memory:
  extraction:
    chat:
      maxMemoriesPerSession: ...
    code:
      maxMemoriesPerSession: ...
  persona:
    chat:
      triggerEveryN: ...
    code:
      triggerEveryN: ...
  pipeline:
    chat:
      everyNConversations: ...
      l1IdleTimeoutSeconds: ...
      l2DelayAfterL1Seconds: ...
      sessionActiveWindowHours: ...
    code:
      everyNConversations: ...
      l1IdleTimeoutSeconds: ...
      l2DelayAfterL1Seconds: ...
      sessionActiveWindowHours: ...
```

- 涉及改动点（初步定位）：
  - `.env.example` / `start-memory-core.sh`：从“一组全局变量”扩展为“chat/code 两组变量或一个值 + per-mode 覆盖”。
  - `MemoryCore/src/config.ts`：`ExtractionConfig`、`PersonaConfig`、`PipelineTriggerConfig` 需要支持按 mode 取配置。
  - `MemoryCore/src/utils/pipeline-factory.ts` / `stateful-pipeline-manager.ts`：L1/L2/L3 runner 创建和通知时已带 `memoryMode`，需要据此选择对应参数。
  - `MemoryCore/src/gateway/server.ts`：任务分发已经区分 `memoryMode`，确认 L1/L2/L3 参数传递链路完整。
  - 注意 `all` 模式的分流：可能 chat 链路与 code 链路分别跑，建议落在调用点再决定用哪套参数。

### 3.2 L3 触发依据从“L1 条数”改为“L2 文件变化”

- 现状：
  - chat L3 用 `persona.triggerEveryN` 看新增 L1 条数；
  - code L2 写完 topics 后自动重建 `project/MEMORY.md`，但 LLM 总结触发仍不足。
- 目标：
  - L2 文件发生变化（新增/修改/删除/合并）后，按变化次数或重要性评估是否更新 L3；
  - 不再单纯看 L1 条数。
- 建议落点：
  - 追踪 L2 变更的 checkpoint/state：chat 的 `scene_blocks` 文件、code 的 `project/topics/*.md`。
  - 把 `PersonaTrigger` / L3 调度改成基于 L2 文件的变更计数或哈希/时间戳变化。
  - code v2 的 `project-memory-packager` 已有 L2 后重建索引的入口，可在此处追加“总结是否更新”的判断。

### 3.3 L2 与 Skill 统一为“多文件维护模型”

- 现状：
  - L2 有文件数量/单文件大小/合并规则；
  - Skill 有 SKILL.md 模板、工具调用流程，但缺少数量上限、单文件 token、总预算、强制合并；
  - L2 与 Skill 的参数和结构各自独立。
- 目标：
  - L2 和 Skill 使用同一套“多文件维护”抽象，只允许文件路径、触发阈值、大小/预算 value 不同。
- 建议落点：
  - 统一一个“多文件资产”模型：总数上限、单文件 token/字符上限、总 token 预算、合并/删除规则。
  - 当前 Skill 相关代码：`MemoryCore/src/core/skill/`，特别是 `skill-config.ts`、`conversation-add/add-handler.ts`、`skill-handlers.ts`。
  - 当前 L2 相关代码：`MemoryCore/src/core/persona/`（chat scene）、`MemoryCore/src/utils/project-memory-packager.ts`（code topic）。
- 注意：不一定要让 chat L2 和 code L2 共用同一套物理文件，而是复用同一套“配置字段 + 维护逻辑”。

### 3.4 L3 统一拆成“自动索引 + 总结”两部分

- 现状：
  - chat L3（`persona.md`）更接近“总结”，缺自动索引；
  - code L3（`project/MEMORY.md`）更接近“自动索引”，缺 LLM/用户维护的总结。
- 目标：
  - 索引部分：工程代码扫描 L2 自动重建；
  - 总结部分：LLM 维护，用户可手工编辑；
  - 两者都可以同时存在，且触发时机不同。
- 建议落点：
  - chat 侧：在 persona 旁增加 scene 导航/索引文件，或改造 persona 文件为“索引段 + 总结段”。
  - code 侧：`project/MEMORY.md` 继续作为自动索引；新增/扩展一个 LLM 维护的团队/项目总结文件。
  - UI 编辑权限沿用当前 owner 规则；Code L3 是否新增手工编辑入口需用户确认。

### 3.5 L1 warmup 调整（小但应一并纳入）

- 现状：warmup 从 `1 → 2 → 4 → ... → everyN`。
- 建议：直接 `2 → 5`（即首轮不因 1 轮就触发，稳定后 5 轮触发）。
- 涉及：`stateful-pipeline-manager.ts` / `pipeline-manager.ts` 的初始 warmup threshold 与推进逻辑。

---

## 4. 实施顺序建议

1. **先做 3.1 per-mode 配置拆分**
   - 这是后续所有触发行为差异化的地基。
   - 改动集中在配置解析、YAML 生成、runner 参数注入，风险相对可控。
2. **再做 3.2 L3 触发改为 L2 变化驱动**
   - 依赖 per-mode 参数按 mode 选择后，再让每个 mode 的 L3 依据统一。
3. **再做 3.4 L3 索引/总结拆分**
   - 在触发准确后，才适合引入新的 L3 输出结构。
4. **最后做 3.3 L2/Skill 统一模型**
   - 结构性最强，可能影响已有数据与工具接口，应单独排期。
5. **3.5 warmup 可以随 3.1 一起做**，也可以作为独立小改动先落地。

---

## 5. 验收建议

- 能用同一个 `.env`/YAML 分别为 chat/code 配置不同触发参数，重启后生效。
- 发一组 chat 对话和一组 code 对话，能观察到各自独立触发节奏。
- L3 不是在新增 L1 达到阈值时盲目触发，而是在 L2 文件确实变化后才进入评估。
- Skill 与 L2 的“文件数量/大小/总预算/合并规则”可以在配置中分别表达。
- 生成配置 `.memory-core-config/tdai-gateway.yaml` 中能看到 chat/code 分块，且未破坏当前线上全局参数兼容性。

---

## 6. 参考文件与代码位置

| 用途 | 路径 |
|---|---|
| 统一目标设计（权威方案） | `memory-agent/INVESTIGATION_MEMORY_AND_SKILL_FLOW_20260907.md` |
| 历史/待办摘要 | `memory-agent/MAINTENANCE_AND_CHANGELOG.md` 3.14、5.1 |
| 配置模板 | `deploy/global-images/.env.example` |
| YAML 生成脚本 | `deploy/global-images/start-memory-core.sh` |
| 配置类型/解析 | `MemoryCore/src/config.ts` |
| L1/L2/L3 runner 工厂 | `MemoryCore/src/utils/pipeline-factory.ts` |
| 会话状态与 warmup | `MemoryCore/src/utils/pipeline-manager.ts`、`stateful-pipeline-manager.ts` |
| 任务分发/ mode 路由 | `MemoryCore/src/gateway/server.ts`、`gateway/v2-router.ts` |
| Code v2 L2/L3 | `MemoryCore/src/utils/project-memory-packager.ts` |
| Skill 配置/处理 | `MemoryCore/src/core/skill/`（`skill-config.ts`、`conversation-add/`、`skill-handlers.ts`） |

---

## 7. 注意与边界

- 不要只在文档里改；必须同步改 `config.ts`、YAML 生成、runner 读取点，否则配置不会生效。
- 当前有旧版 pipeline 与新 stateful pipeline 两套调度路径，改动时都要覆盖，避免 chat/code 只在某一路径生效。
- `memory_mode = all` 会同时跑 chat/code 两条链，参数选择要明确：建议在 L1/L2/L3 调度入口按实际执行分支选择 chat 或 code 参数，而不是把 `all` 当成第三种参数集。
- 涉及 L3/Skill 文件结构变更前先确认历史数据迁移与 UI 权限口径。
- 完成后按 `MAINTENANCE_AND_CHANGELOG.md` 记录规范追加简洁结论。

---

## 8. 2026-09-08 追加：L0 数据质量侧已完成事项（非 3.x 参数主线）

> 本文 3.x 主线（per-mode 配置 / L3 依据 / L2/Skill 统一）**仍未完成**；以下是与主线平行的近期已完成事项，供后续继续接手时参考。

### 8.1 Codex Ambient Suggestions 污染 L0 已过滤并部署

- **问题**：Codex Desktop 的 ambient suggestions 功能会携带与真实会话相同的 `team/agent/user/task` 身份头，向 Memory Proxy 发一条“生成个性化建议”的后台请求；因内容包含大量旧任务历史，L0/L1 里会多出看似旧会话复活的污染 session。
- **已实现**：
  - `MemoryProxy/src/tdai/recorder.ts`：`isCodexInternalPrompt()` 在匹配前缀前会剥离首个 Markdown 标题，从而同时支持 `# Overview\n\nGenerate 0 to 3...` 完整前缀和 `Generate 0 to 3...` 特征句前缀。
  - `MemoryProxy/src/config.ts`、`MemoryProxy/config.example.yaml`、`deploy/global-images/start-proxy.sh`、`deploy/global-images/.env.example`：默认 `codexInternal.promptPrefixes` 已加入两条 Ambient 前缀。
- **验证/部署**：
  - TypeScript 编译通过；Ambient 样本验证为 `null`（不写 L0）；普通用户消息正常保留。
  - 新 `agentmemory/memory-proxy:local` 镜像已构建并部署到远程，`tdai-proxy` healthy。
  - Git commit：`1f8f7b7`，已推送 `origin/feat/server_team`。
- **污染数据已清理**：
  - 删除 session `01a07bd8-4de7-7e63-9089-fe9019acc249` 对应的 L0 3 条、L1 3 条、JSONL 与 checkpoint runner state。
  - 真实会话 `01a07bd8-988f-7dd0-aab4-ab9be9301f97` 保留。
  - 清理前备份：`/root/tdai-memory/backups/l0-cleanup-20260908-024410/`。
- **后续可丰富**：按 `L0_ROUTING_AND_EXTRACTION_NEW.md` §6 继续抓真实 Ambient 请求 body，若找到结构信号可将文本前缀升级为结构判定。
