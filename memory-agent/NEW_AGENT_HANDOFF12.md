You are a helpful software engineer assistant. When you think, think in English, start with "We need..."

请先阅读以下文件并理解背景，再开始执行：

- `memory-agent/AGENT_INDEX.md`
- `memory-agent/EXECUTION_PLAN_L0_SESSION_AND_MEMORY_CRUD_20260907.md`
- `memory-agent/HANDOFF_L0_SESSION_AND_MEMORY_CRUD_AB_20260907.md`
- `memory-agent/REPORT_L0_SESSION_AND_MEMORY_CRUD_CDE_20260907.md`
- `memory-agent/HANDOFF_SKILL_PERMISSION_MODEL_20260907.md`
- `memory-agent/CURRENT_STATUS_功能实现与当前阶段.md`

工作目录为 `/home/luuu/Desktop/TencentDB-Agent-Memory`。

---

## 当前仓库状态

- 阶段 A、B、C、D、E 均已完成并提交。
- 当前分支：`feat/server_team`
- 远端已同步至 `origin/feat/server_team`
- 最近相关提交：
  - `b8f36f7 docs: add skill permission model handoff`
  - `c3db84e docs: add C/D/E execution report with permission and injection freshness notes`
  - `e98050b fix: show Code L2 topic edit/delete actions to memory owners`
- 本地三容器已重启到新镜像并 healthy：
  - `tdai-memory-hub`
  - `tdai-memory-core`
  - `tdai-proxy`
- **服务器尚未部署/同步**，远程容器仍可能运行旧镜像。

---

## 已完成的要点

### L0 Session 化（A）
- Chat/Code L0 都改为 Session 列表 + 当前 Session 消息。
- 支持按当前 Session 的 `before_ts` 加载更早消息。
- 旧无 Session 数据归到默认 Session。

### Chat L2/L3 + Skill UI（B）
- Chat L2 可编辑/删除；Chat L3 可编辑但不删除。
- Skill 面板支持编辑 SKILL.md、删除 Skill、文件编辑/删除。

### Code L2/L3 CRUD（C）
- MemoryCore 新增 `/v3/project/write|rm`。
- 路径沙箱只允许扁平 `project/topics/*.md`。
- 写/删后自动重建 `project/MEMORY.md`。
- Panel 新增 `/api/v1/project/write|delete`。
- Code Memory L2 UI 已暴露编辑/删除，owner 才能操作。

### Agent 端到端写（D）
- memory-bridge 拆分为读/写 allowlist。
- 允许 self-only 写：`scenario/write|rm`、`core/write`、`project/write|rm`。
- 不允许通过 `agent_id` 写 imported/借入记忆。
- `<tdai_memory_tools>` 已更新为“读工具 + 受控写工具”。
- `skillRuntime.allowLlmWrite` 默认已开启。

### 镜像构建（E）
- `agentmemory/memory-core:local`
- `agentmemory/memory-hub:local`
- `agentmemory/memory-proxy:local`

---

## 当前权限口径（简要）

- Chat/Code L2、Chat L3：面板写操作仅限对应记忆资产 owner/创建者。
- Skill：归属 `(team_id, owner_agent_id)`；共享 = 团队只读可见/可使用；修改/删除仍限 owner Agent；其他人可通过 Fork 得到独立可写副本。
- `skillRuntime.allowLlmWrite=true` 只是允许 Agent 调写接口，不代表所有人可改；非 owner 仍被后端拒绝。
- 注入上下文中 `session_init` 类 hook 的结果在会话内基本冻结；需要新会话才会重新拉取最新记忆/Skill。

---

## 尚未完成 / 需要人工确认的事项

1. 服务器部署与远程同步未执行；如果用户要求部署，应先由用户明确同意。
2. Code L3（`project/MEMORY.md`）当前保持只读并随 L2 自动重建；没有“手动编辑 L3”入口。
3. Skill 权限/共享模型目前只整理了文档，**未做产品改动**；用户可能后续会提出新的 Skill 模型设计。
4. 前端 Skill 详情页目前对所有能查看的人都会显示“编辑/删除”按钮，非 owner 点击会触发后端 `SKILL_NOT_OWNER`；是否要按 owner 隐藏按钮属于待确认 UI 问题。
5. 个人 Skill 的“启用/停用/是否使用”开关尚未实现；如用户要求再做。
6. 团队共享 Skill 与 Fork 副本之间暂无“源更新后同步/提示”机制。
7. Code L2 并发锁为进程内锁；多副本部署时需要补分布式锁。

---

## 执行要求

- 只修改本地源码。
- 不要部署到服务器。
- 不要执行远程部署命令。
- 如果用户要求，验证通过后可以 `git push` 提交。
- 完成后输出执行报告，列出：
  - 做了哪些改动；
  - 涉及哪些文件；
  - 本地验证结果；
  - 尚未完成/需要人工确认的事项。
- 如果遇到与已实现代码不一致的旧计划描述，以当前源码实际状态为准。
