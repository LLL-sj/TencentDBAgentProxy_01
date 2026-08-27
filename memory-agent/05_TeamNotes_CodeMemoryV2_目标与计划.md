# 05 Team Notes + Code Memory v2 目标与实施计划

> 状态：已批准执行（2026-08-17）
> 关联文档：
> - `memory-agent/TeamNotes-TagGraph-Design.md`（Team Notes 表/接口/前端图方案）
> - `memory-agent/CodeMemoryV2-Prompt-Migration.md`（Code Memory v2 提示词/配置/回滚方案）
> 前置动作：已在 `/tmp` 生成全项目备份，见文末。

---

## 1. 背景

在现有 L0–L3 记忆、Skill、Wiki、CodeGraph 四类资产之外，团队需要两类新能力：

1. **团队交流笔记（Team Notes）**：轻量 `.md` 文本，上传时携带标签；不做 LLM ingest；全团队共享、team 严格隔离；标签是唯一关系来源；仪表盘可以像 Wiki 一样查看文档和关系图。
2. **Code Memory v2**：code 模式下的记忆不再走“画像式蒸馏”，改为
   - L0.5：Agent 通过 HTTP 工具主动提交的任务总结 tips；
   - L1：结合 L0 原文 + L0.5 锚点抽取的结构化原子记忆；
   - L2：项目经验文件 `project/topics/*.md`；
   - L3：代码确定性生成的 `project/MEMORY.md` 索引文件。

本文件只写目标、阶段、验收和回滚口径；两份详细设计见关联文档。

---

## 2. 目标

### G1 Team Notes（Phase 1）
- 新增 team 级轻量文档资源，**不新增 AssetType、不与 Task 绑定、不跨 team**。
- 上传/获取均以文本内容为准；DB 存正文，导出接口按需生成 `.md` 文件。
- 标签建图：note 节点 + tag 节点，`note-has_tag->tag` 边。
- 仪表盘可查看列表、Markdown 内容、标签关系图。
- Agent 通过 bridge 只读/按需写入，system prompt 保持稳定。

### G2 L0.5 Task Summary Tips（Phase 2）
- Agent 在“任务/流程完整结束且收到用户反馈”时，通过 HTTP 工具提交总结。
- tips 存储为独立表 `summary_tips`，带 L0 锚点，消费时按时间顺序插回原文。
- 所有触发、提醒、冷却、聚合阈值全部进配置文件。

### G3 Code Memory v2（Phase 3/4）
- 保留 v1 全部旧代码、旧提示词、旧数据，通过 `codeMemoryVersion` 开关切换。
- v2 产出 `project/topics/*.md` 经验文件 + `project/MEMORY.md` 索引。
- code 模式 session_init 最终只注入 `MEMORY.md`，topic 正文按需读取。
- 旧 L3 Doctrine 保留但不再作为 v2 主入口。

### G4 前端可见效果（贯穿）
- MemoryPanel 新增 Team Notes 页面：列表、编辑、标签筛选、知识图谱、Mermaid 导出。
- 记忆面板新增 L0.5 tips 列表/详情，显示 L0 锚点范围、状态、tags。

---

## 3. 非目标（本阶段明确不做）

- Tag/Notes 跨 team 分享。
- Task 父子层级、Task 资源聚合命名空间。
- Git 私钥支持。
- Wiki 层级 `parent` 补强。
- 删除或重写旧 L1/L2/L3 管线。

---

## 4. 总体实现思路

```text
Team Notes（Knowledge 服务）
  SQLite team_notes + team_note_tags
  → /v3/notes/* 数据接口
  → Panel /api/v1/notes/* 业务路由
  → 前端 NotesPage（复用 Sigma/ForceAtlas2 图组件）
  → Proxy /notes-bridge/v3/notes/* + <note_tools>

Code Memory v2（MemoryCore + Proxy）
  summary_tips 表
  → POST /memory-bridge/v3/tips/submit（Proxy 注入身份）
  → L1 抽取 prompt 增加 v2 模板（L0 + 锚点 tips）
  → L2.5 Project Packager 生成 topics/*.md
  → 工程扫描 frontmatter 重建 MEMORY.md
  → session_init 注入 MEMORY.md 索引
  → project/list/read/search 只读工具按需取正文
```

关键原则：

1. **Team 隔离是所有新表、新接口的第一约束**：`service_id + team_id` 必填、必校验、必落索引。
2. **DB 为真相，文件只在导出/需要时生成**：Team Notes 不做 DB/文件双写。
3. **旧链路保留，新链路开关隔离**：v1/v2 并跑，可配置回滚。
4. **Prompt cache 稳定**：静态契约只进 system；动态提醒只进 user，且只在 eligible 时注入。
5. **LLM 只写“内容”，不写“结构”**：L2 文件由 LLM 写，L3 索引由代码生成；Notes 关系由 tags 确定性生成。

---

## 5. 实施阶段与分工

| 阶段 | 内容 | 落点 | 产出 |
|---|---|---|---|
| 0 | 备份 + 设计文档 | 本文件、两份设计 | 可回滚基线 |
| 1 | Team Notes 后端 | `MemoryKnowledge/src/db/schema.ts`、`db/client.ts`、`store/notes-service.ts`、`routes/notes.ts`、`server.ts` | `/v3/notes/*` |
| 1 | Team Notes 面板后端 | `MemoryPanel/src/panel/http/routes/notes.ts`、`http-knowledge-client.ts` | `/api/v1/notes/*` |
| 1 | Team Notes 前端 | `MemoryPanel/web/src/pages/notes/` | 列表/详情/图 |
| 1 | Agent 访问通道 | `MemoryProxy/src/notes-bridge.ts`、`injection/injectors/note-tools-injector.ts` | `/notes-bridge/*` + `<note_tools>` |
| 2 | tips 存储 | `MemoryCore` SQLite（新表 `summary_tips`） | L0.5 持久化 |
| 2 | tips 提交通道 | `MemoryProxy/src/memory/memory-bridge.ts` 或独立 `tips-bridge.ts` | `POST /memory-bridge/v3/tips/submit` |
| 2 | tips 契约与提醒 | `MemoryProxy/src/injection/injectors/summary-tips-contract-injector.ts` | system 静态契约 + user 动态提醒 |
| 2 | 触发配置 | `MemoryCore/src/config.ts`、`deploy/global-images/.env.example`、`MemoryProxy/src/config.ts` | `tips.*` 配置 |
| 3 | L1 v2 提示词 | `MemoryCore/src/core/prompts/code-v2/l1-extraction-with-tips.ts` | L1 输入含锚点 tips |
| 4 | L2.5 打包器 | `MemoryCore/src/utils/project-memory-packager.ts` | `project/topics/*.md` |
| 4 | MEMORY.md 生成 | 同打包器模块 | `project/MEMORY.md` |
| 4 | 注入/读取工具 | `MemoryProxy/src/injection/injectors/tdai-project-memory-injector.ts`、`tdai-project-memory-tools-injector.ts` | v2 注入 |
| 5 | 面板 L0.5 展示 | `MemoryPanel/web/src/pages/memory/` 或现有 chat memory 页 | tips 列表/详情 |
| 6 | 测试 + 回滚验证 | 三服务单测/集成测试 | 验收清单 |

建议执行顺序：1 → 2 → 3 → 4 → 5。每阶段结束都做一次构建/重启验证。

---

## 6. 验收标准

### Team Notes
- [ ] 同一 team 内上传、更新、删除、查询正常；跨 team 一律 404/403。
- [ ] `expected_version` 冲突返回 409/422，不会发生最后写入覆盖。
- [ ] `/v3/notes/graph` 返回 note/tag 两类节点和 `has_tag` 边。
- [ ] 前端列表、Markdown 详情、标签筛选、力导向图、Mermaid 导出可见。
- [ ] Agent 用 `<note_tools>` 按 tag 拉取列表和正文，不注入全量正文。

### L0.5 Tips
- [ ] 任务结束后 Agent 能通过 bridge 提交，`tip_id` 返回稳定。
- [ ] 相同锚点重复提交被去重。
- [ ] 只注入一次静态契约；动态提醒有次数上限和冷却。
- [ ] 关闭 `tips.enabled=false` 后行为回到 v1。

### Code Memory v2
- [ ] `codeMemoryVersion=v1` 时所有旧行为不变，旧文件可读写。
- [ ] `codeMemoryVersion=v2` 时 session_init 只注入 `MEMORY.md`，不注入旧 L3 全文。
- [ ] `project/list/read/search` 可读取 topics。
- [ ] 配置 `projectMemory.enabled=false` 时不运行 L2.5 打包器。

---

## 7. 配置原则

所有新触发/兜底参数必须进入配置文件，且与旧配置风格一致：

```yaml
tips:
  enabled: true
  reminderEnabled: true
  maxReminderPerTask: 2
  reminderCooldownSeconds: 1800
  submitPath: /memory-bridge/v3/tips/submit

projectMemory:
  enabled: false          # 默认关，v1 不受影响
  minPendingTips: 3
  minDistinctSessions: 2
  packagerMinIntervalSeconds: 1800
  packagerMaxIntervalSeconds: 14400
  indexMaxChars: 6000
  topicMaxChars: 4000
```

环境变量侧（`deploy/global-images/.env.example`）新增同义 `MEMORY_TIPS_*`、`MEMORY_PROJECT_MEMORY_*`，由启动脚本生成 YAML，保持现有 `MEMORY_*` 模式。

---

## 8. 回滚口径

1. **代码回滚**：使用文末全项目备份覆盖恢复。
2. **功能回滚**：
   - Team Notes：关闭前端路由 + Proxy 注入开关即可隐藏；数据表保留不删。
   - tips：`tips.enabled=false`；表保留。
   - Code Memory v2：`codeMemoryVersion=v1`，v2 文件保留但不注入、不生成。
3. **数据回滚**：
   - 新表均为 add-only；不修改旧表结构。
   - 若必须清理，先导出再删除，并记录到 `memory-agent/02_修改说明与实施记录.md`。

---

## 9. 备份记录

- 备份文件：`/tmp/TencentDB-Agent-Memory-backup-20260817-220610.tar.gz`
- 大小：67M
- SHA-256：`30adb859f4e0e0d1bfc21ece7cced8592f80a1858639e6ec1e7252744da3c904`
- 内容：`TencentDB-Agent-Memory/` 全目录（含 `.git`、未提交改动、memory-agent 文档；排除 node_modules，当前仓库无 node_modules）

> 注意：`/tmp` 备份可能随系统重启丢失；开始大改或提交前，建议由用户把该文件复制到 Windows 侧长期目录。
