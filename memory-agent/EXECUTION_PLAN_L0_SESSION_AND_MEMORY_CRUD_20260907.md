# 执行计划（评审修订版）：L0 按 Session 展示 + 记忆/Skill 编辑删除端点

> 创建：2026-09-07  
> 评审修订：2026-09-07  
> 原则：分阶段修改，阶段内可独立验证；全部无误后只构建新镜像，**不部署到服务器**，等待指令。  
> 修订说明：保留原阶段 A-E，并补齐“Session 列表需要内核数据面聚合”“Code L0 当前没有 cursor 加载更多”“MemoryProxy 写操作必须 self-only”“Code project 写/删需要完整路由与并发处理”等前置缺口。

---

## 背景确认

已核对源码现状：

- `MemoryPanel /chat-memory/layer` 的 L0 分支刻意不传 `session_id`，返回 `(team, user, agent)` 下所有 session 的 L0，前端平铺展示。
- Chat L2/L3 底层有写接口（`scenario/write`、`scenario/rm`、`core/write`），但 Panel/前端没暴露。
- Code L2/L3 的 project 系列只有 `list/read/search`，缺写/删接口。
- Skill 内核和 proxy 已有完整 CRUD/文件接口；主要缺口在 UI 和“是否让 Agent 通过注入看到编辑能力”。
- MemoryProxy 的 `memory-bridge` 目前只放行只读 TDAI 子路径，Agent 注入文本也明确写着“只读工具”。
- Code Memory 当前 L0 是普通 offset 分页，不是 Chat Memory 的 `before_ts` 游标加载更多；阶段 A 需把 Code L0 一起改成 session 化 + 游标加载。

---

## 范围与默认决策（评审后统一口径）

以下默认值直接写入计划；若执行前用户有不同意见，应先调整计划再动代码：

1. 阶段 A UI：按“session 列表 + 当前 session 消息详情”的拆分交互实现，不做“同一列表内分段”的折中。
2. Chat L1：**不在本计划内按 session 拆分**。L1 维持 agent 级跨 session 聚合；后续如需 session 级 L1，应单独改 `atomic/query`/内核模型。
3. Skill 暴露：按 **C：两者都要** 推进 —— Panel UI 提供编辑/删除/文件管理，Agent 写能力复用 `skill-bridge + skill-tools-injector`，并显式确认/开启 `allowLlmWrite=true`。
4. Code L2 并发：默认增加 **per-(team_id, agent_id) 进程内 mutation lock**，每次 `project/write` / `project/rm` 后立即重建 `MEMORY.md`；不在本计划引入跨实例分布式锁/全量版本控制。若服务为多副本，后续再基于现有 Redis/state backend 补锁。

---

## 阶段 A：L0 按 Session 展示

### 目标
- L0 tab 不再把多个 session 的消息混成一个连续聊天流。
- 采用“session 列表 + 当前 session 消息”的交互：选中 block/agent 后先加载 session 列表，默认选中最近有消息的 session；切换 session 只显示该 session 的 L0。
- 保留并统一 Chat/Code 的“加载更多更早消息”能力，使用 `before_ts` 游标而不是大 offset 分页。

### 改动点

#### A1. MemoryCore 提供 session 汇总数据面（前置，原计划遗漏）
- 新增 `/v3/conversation/sessions`：
  - 请求：`team_id + agent_id + user_id`（沿用 v3 strict isolation），可选 `limit/offset`。
  - 响应：`{ items: [{ session_id, message_count, last_message_at_ms, last_recorded_at_ms, last_content?, first_message_at_ms? }], total }`
  - 返回顺序：按 `last_recorded_at_ms` 倒序，最近更新的 session 在最前。
- 扩展 store 能力：
  - `IMemoryStore` 新增可选方法 `listL0Sessions(filter, page)`。
  - SQLite 实现：`GROUP BY session_id` + `COUNT(*)` + `MAX(recorded_at_ms)`，过滤条件沿用 team/user/agent。
  - TCVDB 实现：先用现有 `_queryAllDocs` 按 team/user/agent 分页扫描所需 `session_id/recorded_at_ms` 字段，在内存按 session 聚合；如数据量大需限制扫描上限并在接口上分页/加阈值，后续再评估后端原生 group-by。
- 同步将 `/v3/conversation/sessions` 加入：
  - `V3_ALLOWED_SUBPATHS`
  - `routeTable`
  - gateway schema（zod request/response types）
- 如不新增 store 方法，Panel `l0-sessions` 不应仅靠“第一页 20 条”或反复翻页推断 session。

#### A2. Panel `chat-memory/layer`
- L0 返回 item 时补 `session_id`（当前内核已返回，Panel 映射时透传即可）。
- 支持 `body.session_id`：
  - 传了：转成 `/v3/conversation/query` 的 `session_id`，只查该 session；
  - 未传：保留现有跨 session 聚合语义，供旧调用方/其他层继续使用。
- 游标分页继续保留 `before_ts`，且游标应只作用于当前选中 session。

#### A3. Panel 新增 `chat-memory/l0-sessions`
- 复用 `/chat-memory/layer` 同套 ACL：先校验 asset 可读，再用 `asset.owner_user_id` 调 `/v3/conversation/sessions`。
- 返回：
  ```json
  { "items": [{ "session_id": "...", "message_count": 10, "last_message_at": "ISO", "last_content": "..." }], "total": 1 }
  ```
- 前端不在列表页自行聚合消息推断 session。

#### A4. 前端
- `ChatMemoryLayerItem` 增加 `session_id`。
- 新增 `L0SessionSummary` 类型与 `chatMemoryApi.l0Sessions(...)`。
- Chat Memory：
  - 选择 block 且进入 L0 时先请求 `l0-sessions`；
  - 状态中保存 `selectedSessionId`、`sessions`、按 session 隔离的 L0 items/cursor；
  - `BlockDetail` 增加 session 列表或分组入口；默认选中最近 session；
  - “加载更多更早消息”传入当前 session 的 `session_id + before_ts`。
- Code Memory：
  - `CodeMemoryDetail` 同样改为 session 列表 + 当前 session 消息；
  - L0 不再使用 `chatPage * CHAT_LAYER_PAGE_SIZE` 的 offset 分页；
  - 使用当前 session 的 `session_id + before_ts` 游标追加更早消息。
- 原无 session 的旧数据：
  - 由后端归一为 `default` 或空 `session_id` 分组展示；具体显示名可用“无 Session/默认”；
  - 不应让旧数据因缺 session 而从 L0 列表中消失。

### 验证点
- 多 session 数据在 L0 tab 中按 session 分开，不再混合成一条连续流。
- 切换 session 只请求/显示该 session 的消息。
- Chat 与 Code 两个 Memory 页的 L0 都生效。
- 旧无 session_id 的 L0 仍能显示（默认分组）。
- L0 加载更早消息在 session 内部正确追加，不跨 session 串数据。

---

## 阶段 B：暴露 Chat L2/L3 的编辑/删除 + Skill 暴露

### Chat L2
- 底层已存在：
  - `/v3/scenario/write`（编辑/新建 L2 文件）
  - `/v3/scenario/rm`（删除 L2 文件）
- Panel 暴露：
  - `/api/v1/chat-memory/l2-write`
  - `/api/v1/chat-memory/l2-delete`
- 权限沿用 `/chat-memory/layer` 的 asset ACL，并额外要求：
  - 写入目标是 asset owner 自己的 agent（或当前用户有明确管理权）；
  - 不能借“借入/imported memory”语义编辑别人 agent 的 L2。
- 前端 L2 详情加编辑、删除按钮：
  - 编辑在弹层/编辑区保存后调用 `l2-write`，刷新当前条目；
  - 删除需二次确认，成功后从列表移除并刷新计数/索引。

### Chat L3
- 只暴露编辑：
  - `/v3/core/write` 已有
  - Panel：`/api/v1/chat-memory/l3-update`
- **不暴露删除**：L3 是 persona/core memory，只能覆盖写，不允许删除整个 L3。
- 保存前从 `/chat-memory/layer` L3 读取现有正文作为默认值，避免前端只传片段导致覆盖丢失。

### Skill（按默认决策 C 执行）
- 后端已具备：`update/patch/delete/files/write/files/remove`
- Panel UI：
  - Skill 详情页从只读改为可编辑 SKILL.md；
  - 增加删除 Skill 入口；
  - 文件树支持上传/覆盖/删除/查看文件（复用现有 skill-api）。
- Agent 写能力：
  - 检查并确认 `skillRuntime.allowLlmWrite=true`；
  - 若为 `false`，阶段 C/D 需要同步把配置打开，否则 Agent 写 Skill 的工具只会返回 403；
  - 配置开关保持独立，不与 `memory-bridge` 写开关耦合。

---

## 阶段 C：补充 Code L2/L3 编辑/删除端点

### C1. MemoryCore Code L2（project/topics/*.md）
- 新增 `/v3/project/write`：
  - 请求：`team_id + agent_id + user_id + name/path + content/frontmatter + 可选 expected_version?`
  - 校验 path：只允许扁平 `project/topics/<name>.md`，拒绝 `/`、`..`、` `、隐藏文件；
  - 已有文件：覆盖写入；不存在：创建新 topic；
  - 写后调用 `writeProjectMemoryIndex()` 立即重建 `project/MEMORY.md`。
- 新增 `/v3/project/rm`：
  - 请求：`team_id + agent_id + user_id + path`
  - 只允许删除 `project/topics/*.md`，禁止删除 `MEMORY.md` 或目录；
  - 删除后立即重建 `project/MEMORY.md`。
- 需要在 `project-memory-packager.ts` 暴露/补充安全文件名与写入 helper（当前 `safeTopicName`/`writeText` 为模块内私有，按需导出）。
- 路由与 schema：
  - 加入 `V3_ALLOWED_SUBPATHS` 和 `routeTable`；
  - 补 zod request schema 与类型；
  - 如 V3 strict isolation 生效，必须校验 `user_id`；该 `user_id` 用于判断团队/归属，而不是信任 path 防逃逸。
- 并发：
  - MemoryCore 路由层维护 `Map<string, Promise>` 或简单 `Map<string, boolean>` 作为 per-(team,agent) 串行锁；
  - write/rm 期间不并发重建 MEMORY.md；
  - 锁只防“同进程内两个请求同时改同一 project topics + index”的丢失更新；跨副本/跨实例锁后续按部署形态补充。

### C2. Panel Code L2/L3
- Panel 暴露：
  - `/api/v1/project/write`
  - `/api/v1/project/delete`
  - 可选 `/api/v1/project/rebuild-index`（如果后续需要手动重建 L3）
- `projectApi` 增加 `write` / `delete` 方法。
- 前端 Code Memory 的 L2 详情加编辑、删除：
  - 编辑 topic 后调用 `/project/write`；
  - 删除 topic 前二次确认，成功后刷新项目列表与 L2/L3 计数。
- Code L3（`project/MEMORY.md`）：
  - 保持只读；只展示“编辑/重建”入口时可调用 `/v3/project/write` 写入一个 topic 后由服务端重建，或另加手动 rebuild 端点。
  - 不暴露直接删除 `MEMORY.md`。

---

## 阶段 D：Agent 注入端到端

### D1. MemoryProxy `memory-bridge` 只读 → 受控读写
- 把 `ALLOWED_SUBPATHS` 拆成：
  - `READ_SUBPATHS`
  - `WRITE_SUBPATHS`
  - `ALLOWED_SUBPATHS = READ ∪ WRITE`
- 新增写路径：
  - `scenario/write`
  - `scenario/rm`
  - `core/write`
  - `project/write`
  - `project/rm`
  - `atomic/update`（若允许 Agent 改 L1；默认先不放开，单独确认后加）
- 安全限制：
  - 写操作 **只允许 target 为当前 session 的 self agent**；
  - 如果 body 带 `agent_id` 且该 agent 属于 imported/借入，写请求应直接拒绝，不能复用当前 `selectTargetCtx` 的 imported 选择逻辑；
  - 写操作 body 中 `team_id/user_id/agent_id` 仍由 proxy 强制覆盖；`task_id` 可保留 session 注入；
  - `project/write|rm` 的 `path/name` 仍需由 MemoryCore 做二次路径沙箱。
- 在 bridge 日志中区分 `sub=xxx write=true self=xxx imported=...`，便于审计。

### D2. `tdai-tools-injector` 注入文本
- 更新“这些是只读工具”描述为“读工具 + 受控写工具”。
- 增加工具说明：
  - `tdai_update_scene` → `/memory-bridge/v3/scenario/write`
  - `tdai_delete_scene` → `/memory-bridge/v3/scenario/rm`
  - `tdai_update_core` → `/memory-bridge/v3/core/write`
  - `tdai_write_project_topic` → `/memory-bridge/v3/project/write`
  - `tdai_delete_project_topic` → `/memory-bridge/v3/project/rm`
- 每类写工具注明：
  - 只能作用于当前 session 归属的 agent；
  - 修改前应先用只读工具查询当前内容；
  - 不要自行构造 `team_id/user_id/agent_id/session_id`，proxy 会注入；
  - `scenario/write` 只能改已存在 path；新建 L2 如需支持需再确认底层语义；
  - Code project topic 写完后 MEMORY.md 自动重建，无需再调用其他写接口。

### D3. 权限与校验
- L2 scenario write/rm、L3 core write：继续由 MemoryCore handler 内的权限/隔离层校验；MemoryProxy 只保证 self-only。
- Code project write/rm：
  - MemoryCore 校验调用者是 team 成员（或按当前 gateway 的隔离规则）；
  - 写入路径只能落在 `project/topics/`；
  - 不允许覆盖 `MEMORY.md`、目录、嵌套路径。
- Skill 写已有 `allowLlmWrite` 门禁，不在本次 memory-bridge 写集合中重复放开。

---

## 阶段 E：构建镜像

- 所有修改完成后：
  1. MemoryCore 构建新镜像
  2. MemoryPanel（实际产物随 memory-hub / panel-knowledge-combined 镜像）构建新镜像
  3. MemoryProxy 构建新镜像
  4. 如相关镜像打进同一个 `proxy-image.tar.gz` / 部署包，则重新打镜像包
- **只构建，不部署到服务器。**
- 等待用户明确指令后再更新远程 `/root/tdai-memory` 与容器。
- 构建前先跑：
  - `MemoryCore` 单元测试与 TS 构建
  - `MemoryPanel` `tsc --noEmit`
  - `MemoryPanel/web` `npm run build`（或整体 memory-hub docker build 内的前端构建）
  - `MemoryProxy` TS 构建/测试
  - 若涉及 SQL/API schema 生成，重新生成后检查 diff

---

## 执行前仍需用户拍板的项

1. `atomic/update` 是否开放给 Agent？默认 **先不放开**，如需 L1 修改能力再单独加阶段。
2. `project/write` 是否允许“新建 topic”？当前按允许新建/覆盖推进；若只允许编辑现有 topic 需再调整校验。
3. 是否接受 Code L2 并发“进程内锁即可、不做跨副本分布式锁”？默认接受，多副本部署前另行补充。
4. Skill UI 和 Agent 写能力是否都做？默认按 C 执行，若只要 Agent 写能力则取消 UI 部分。
5. 阶段 A 是否必须做“左右两栏”而不是内部列表分组？默认按左右/上下明确分区执行。
