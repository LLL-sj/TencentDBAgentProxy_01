# 新 Agent 工作交接（TencentDB-Agent-Memory · 第三轮）

> 接续 `NEW_AGENT_HANDOFF.md`（第一轮）与 `NEW_AGENT_HANDOFF2.md`（第二轮）。
> 本轮任务：**Phase 1 Team Notes（团队 Markdown 笔记 + 标签知识图谱）**。
> 本文件是提前交接文本：后端代码已完成并通过本地编译/单测；前端与 Proxy 编译、容器联调**尚未完成**，需要新 Agent 从 §4 开始做全量验证。

---

## 0. 先读这些文件（按顺序）

| 优先级 | 文件 | 作用 |
|---|---|---|
| 必读 | `NEW_AGENT_HANDOFF2.md` | 环境权限、镜像/端口、账号、避坑清单 |
| 必读 | `memory-agent/05_TeamNotes_CodeMemoryV2_目标与计划.md` | 总目标、7 个阶段、验收标准、回滚口径 |
| 必读 | `memory-agent/TeamNotes-TagGraph-Design.md` | Phase 1 详细设计：表/接口/前端/桥接 |
| 参考 | `memory-agent/CodeMemoryV2-Prompt-Migration.md` | 后续 Phase 2–4 设计（本轮未做） |
| 参考 | `NEW_AGENT_HANDOFF.md` | 第一轮 code 模式改造背景 |

---

## 1. 本轮完成了什么

### 1.1 目标

实现 **Team Notes**：

- 团队内共享的轻量 Markdown 笔记；
- 上传/编辑时携带 tags；
- 关系只由 tags 表示，不跨 team，不做 Task 父子，不走 LLM ingest；
- SQLite 存正文，不做 DB/文件双写，导出时按需生成 `.md`；
- 仪表盘展示列表、Markdown 正文、标签知识图谱（Sigma + ForceAtlas2）与 Mermaid 文本；
- Agent 通过 Proxy bridge 按需读取/搜索。

### 1.2 已完成代码

#### Knowledge 服务（端口 8424，代码在 `MemoryKnowledge/`）

| 文件 | 状态 | 说明 |
|---|---|---|
| `MemoryKnowledge/src/db/schema.ts` | 新改 | Drizzle 定义 `team_notes` / `team_note_tags` / `team_note_revisions` |
| `MemoryKnowledge/src/db/client.ts` | 新改 | 运行时 `CREATE TABLE IF NOT EXISTS` + 索引 |
| `MemoryKnowledge/src/store/ids.ts` | 新改 | `note-` / `nrev-` ID 生成与校验 |
| `MemoryKnowledge/src/store/team-notes-service.ts` | 新增 | Notes 服务：CRUD、版本乐观锁、tag 归一化、图谱、Mermaid、导出、revisions |
| `MemoryKnowledge/src/store/team-notes-service.test.ts` | 新增 | 6 个 Vitest 测试 |
| `MemoryKnowledge/src/store/index.ts` | 新改 | barrel 导出 |
| `MemoryKnowledge/src/module.ts` | 新改 | 装配 `notesService` |
| `MemoryKnowledge/src/routes/notes.ts` | 新增 | `/v3/notes/*` Hono 路由 |
| `MemoryKnowledge/src/server.ts` | 新改 | 挂载 `/notes` |
| `MemoryKnowledge/src/middleware/response-envelope.ts` | 修改 | 修复 TS6 下 `bodyCache` 类型错误（与本功能间接相关） |

#### Panel 后端（`MemoryPanel/`，面板 API 8125）

| 文件 | 状态 | 说明 |
|---|---|---|
| `MemoryPanel/src/panel/http/routes/notes.ts` | 新增 | `/api/v1/notes/*`，所有端点 team member 门控 |
| `MemoryPanel/src/panel/kernel/ports/knowledge-client-port.ts` | 新改 | Notes 类型与 `KnowledgeClientPort` 方法 |
| `MemoryPanel/src/panel/kernel/adapters/http-knowledge-client.ts` | 新改 | `HttpKnowledgeClient` 调 KS `/v3/notes/*` |
| `MemoryPanel/src/panel/http/app.ts` | 新改 | 注册 `registerNotesRoutes` |

#### Panel 前端（`MemoryPanel/web/`）

| 文件 | 状态 | 说明 |
|---|---|---|
| `MemoryPanel/web/src/lib/notes-api.ts` | 新增 | 前端 API client、Markdown 导出/下载 |
| `MemoryPanel/web/src/pages/notes/NotesPage/index.tsx` | 新增 | 列表、标签筛选、正文、新建/编辑/归档、Mermaid |
| `MemoryPanel/web/src/pages/notes/NotesPage/NotesGraph.tsx` | 新增 | Sigma + ForceAtlas2 标签力导向图 |
| `MemoryPanel/web/src/routes/index.tsx` | 新改 | 新增 `/notes` 路由 |
| `MemoryPanel/web/src/constants/menu.tsx` | 新改 | 菜单项 `team_notes` |
| `MemoryPanel/web/src/layouts/ConsoleLayout.tsx` | 新改 | path ↔ page 映射 + legacy hash |
| `MemoryPanel/web/src/i18n/zh-CN.ts` / `en-US.ts` | 新改 | 菜单翻译 |

#### Proxy（`MemoryProxy/`，端口 8096）

| 文件 | 状态 | 说明 |
|---|---|---|
| `MemoryProxy/src/notes-bridge.ts` | 新增 | `/notes-bridge/v3/notes/*` 反代，注入 team/user/agent 身份 |
| `MemoryProxy/src/injection/injectors/note-tools-injector.ts` | 新增 | `<note_tools>` 静态 curl 配方 |
| `MemoryProxy/src/injection/index.ts` | 新改 | 注册 notes injector；proxyBaseUrl 条件加入 notes |
| `MemoryProxy/src/server.ts` | 新改 | 注册 `/notes-bridge/*` |
| `MemoryProxy/src/config.ts` | 新改 | 默认 `injectors` 增加 `"notes"` |

### 1.3 已经通过的验证

以下命令本轮已实际执行并通过：

```bash
cd /home/luuu/Desktop/TencentDB-Agent-Memory/MemoryKnowledge
npm run typecheck        # ✅ 通过
npm run build            # ✅ 通过，dist/ 已生成
npx vitest run src/store/team-notes-service.test.ts
                         # ✅ 6 tests passed

cd /home/luuu/Desktop/TencentDB-Agent-Memory/MemoryPanel
npm run typecheck        # ✅ 通过
npm run build            # ✅ 通过，dist/ 已生成
```

测试覆盖：

- 创建/读取笔记；
- tag 归一化；
- team 隔离（A team 的笔记 B team 查不到）；
- `expected_version` 乐观锁；
- 标签图 nodes/edges 数量；
- Mermaid 输出；
- 归档后 active list 排除；
- Markdown 导出。

---

## 2. 尚未完成 / 尚未验证（新 Agent 必做）

> 注意：本轮因前端依赖安装和 Proxy 依赖安装未完成，以下项目**没有验证过**。请勿直接认为 Phase 1 已交付。

1. **MemoryPanel/web 依赖安装 + 前端 build**。
   - `MemoryPanel/web/node_modules` 当前缺失。
   - 前两次 `pnpm install` 遇到 workspace 识别问题 / 网络超时。
   - 建议从零安装见 §4.1。

2. **MemoryProxy 依赖安装 + TypeScript 编译**。
   - `MemoryProxy/node_modules/.bin/tsc` 当前不存在。
   - `notes-bridge.ts`、`note-tools-injector.ts`、`server.ts`、`injection/index.ts`、`config.ts` 只做了代码评审，**未编译**。

3. **三服务运行时联调**。
   - 尚未重启容器，`/v3/notes/*`、`/api/v1/notes/*`、`/notes-bridge/*` 没有真实 HTTP 冒烟验证。

4. **面板镜像重建**。
   - 面板/前端改动必须重建 `memory-hub` 镜像才生效，**不能只重启容器**。
   - 见 HANDOFF2 任务 B 的构建命令。

5. **前端页面实际点测**：
   - 登录 → Team Notes 菜单；
   - 新建笔记、打标签；
   - 打开图谱看 note/tag 节点和连线；
   - Mermaid 视图；
   - 编辑冲突、归档、导出。

6. **Agent bridge 端到端**：
   - 需要一个已初始化 session 的 Claude Code / CodeBuddy 会话；
   - 在 system prompt 中确认出现 `<note_tools>`；
   - 让 Agent 用 Bash curl `note_tags_pages` / `note_get` 拉笔记。

---

## 3. 数据模型

```sql
team_notes(
  note_id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  seq_no INTEGER NOT NULL,           -- team 内递增，先创建优先
  title TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_md TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  author_user_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(service_id, team_id, seq_no)
);

team_note_tags(
  note_id TEXT NOT NULL,
  tag_slug TEXT NOT NULL,
  tag_label TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(note_id, tag_slug)
);

team_note_revisions(
  revision_id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  content_md TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  edited_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

设计决策：

- **DB 为真相，文件不双写**；`exportMarkdown()` 在内存拼 frontmatter + 正文。
- `seq_no` 由事务内 `coalesce(max(seq_no),0)+1` 生成；编号不回收。
- 更新必须传 `expected_version`，不匹配返回 `40901`。
- 删除是软归档 `status='archived'`。
- 图谱节点：`note:<id>` 和 `tag:<slug>`；边：`note-has_tag->tag`。

---

## 4. 新 Agent 验证步骤（从零开始）

### 4.1 依赖安装

仓库源码本身没有提交 `node_modules`。当前 Knowledge / Panel 后端依赖已装，但建议全部重验：

```bash
cd /home/luuu/Desktop/TencentDB-Agent-Memory

# 1) Knowledge
cd MemoryKnowledge
pnpm install --store-dir /tmp/.pnpm-store --ignore-scripts --no-frozen-lockfile

# better-sqlite3 需要补原生二进制（当前已处理过一次）
cd node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3
HOME=/tmp NPM_CONFIG_CACHE=/tmp/npm-cache ./node_modules/.bin/prebuild-install

# 2) Panel 后端
cd ../../../MemoryPanel
pnpm install --store-dir /tmp/.pnpm-store --ignore-scripts --no-frozen-lockfile

# 3) 前端
cd web
pnpm install --ignore-workspace --store-dir /tmp/.pnpm-store --no-frozen-lockfile
# 若 --ignore-workspace 仍异常，先检查 pnpm-workspace.yaml 与 .npmrc，
# 目标：确保 web/node_modules/.bin/vite 存在。

# 4) Proxy
cd ../../MemoryProxy
pnpm install --store-dir /tmp/.pnpm-store --ignore-scripts --no-frozen-lockfile
```

网络慢时：设置较长 `fetch-timeout`：

```bash
pnpm config set fetch-timeout 600000 --location project
```

### 4.2 编译 + 测试

```bash
cd MemoryKnowledge
npm run typecheck
npm run build
npx vitest run src/store/team-notes-service.test.ts

cd ../MemoryPanel
npm run typecheck
npm run build

cd web
npm run build        # 前端生产构建，必须通过

cd ../../MemoryProxy
npx tsc --noEmit     # 或按项目脚本补齐 typecheck
```

### 4.3 HTTP 冒烟测试（Knowledge 直连）

服务启动后：

```bash
# 假设 knowledge 服务在 8424，x-tdai-service-id=default
BASE=http://127.0.0.1:8424/v3/notes
H='-H content-type:application/json -H x-tdai-service-id:default'

# 创建
curl -sS -X POST $BASE/create $H -d '{
  "team_id":"team-w513ek28vu",
  "user_id":"usr-w63bub41ds",
  "title":"K8s 回滚 SOP",
  "content":"# 步骤\n1. 检查\n2. 回滚",
  "tags":["部署","故障"]
}'

# 列表 / 标签
curl -sS -X POST $BASE/list $H -d '{"team_id":"team-w513ek28vu"}'
curl -sS -X POST $BASE/tags/list $H -d '{"team_id":"team-w513ek28vu"}'
curl -sS -X POST $BASE/tags/pages $H -d '{"team_id":"team-w513ek28vu","tag_slug":"部署"}'
curl -sS -X POST $BASE/graph $H -d '{"team_id":"team-w513ek28vu"}'
curl -sS -X POST $BASE/graph/mermaid $H -d '{"team_id":"team-w513ek28vu"}'
```

预期：

- create 返回 `note-xxxxxxxx`；
- graph 至少 1 个 note 节点、对应 tag 节点、`has_tag` 边；
- Mermaid 以 `flowchart LR` 开头。

### 4.4 Panel API 冒烟

```bash
curl -sS -X POST http://127.0.0.1:8125/api/v1/notes/list \
  -H 'content-type: application/json' \
  -H 'x-tdai-service-id: default' \
  -H 'x-tdai-user-key: <林婷或admin的key>' \
  -d '{"team_id":"team-w513ek28vu"}'
```

预期 `code:0`。

### 4.5 镜像与启动

1. 先停服务：
   ```bash
   cd deploy/global-images && ./stop-all.sh
   ```
2. 重建 hub（**必须**，面板/前端改动才生效）：
   ```bash
   cd ../panel-knowledge-combined
   DOCKER_CONFIG=/tmp/docker-cfg DOCKER_BUILDKIT=1 IMAGE_NAME=agentmemory/memory-hub IMAGE_TAG=local CTX_DIR=/tmp/panel-knowledge-builder ./build.sh
   ```
3. core/proxy 有源码挂载，重启即可；必要时按 HANDOFF2 任务 B 重建三镜像。
4. 启动：
   ```bash
   cd ../global-images && ./start-all.sh
   ```
5. 登录面板验证 Team Notes 菜单。

### 4.6 Agent bridge 冒烟

需要一个已初始化 session。用该 session 的 `x-conversation-id`：

```bash
curl -sS -X POST http://127.0.0.1:8096/notes-bridge/v3/notes/tags/list \
  -H 'content-type: application/json' \
  -H 'x-conversation-id: <session_id>' \
  -d '{}'
```

预期：

- 未初始化 session → 40101；
- 已初始化 → 转成 team 内 tags；
- 模型侧 system prompt 出现 `<note_tools>`。

---

## 5. 回滚

### 5.1 代码回滚

全项目备份：

```text
/home/luuu/Desktop/TencentDB-Agent-Memory/backups/TencentDB-Agent-Memory-backup-20260817-224223.tar.gz
SHA-256: 4d9b00ab804fb642730fe0047f36a90929f4a62c7ad78d3f9b96a70102c0fb1c
```

该备份在 Phase 1 代码开始前创建，包含 `.git` 与全部未提交改动。恢复方式：

```bash
cd /home/luuu/Desktop
tar -xzf /path/to/backup.tar.gz
```

### 5.2 功能回滚

- 前端：移除/关闭 `notes` 路由注册即可，表数据保留；
- Proxy：`injection.injectors` 去掉 `notes`，并注释 `/notes-bridge/*` 注册；
- Knowledge：`/v3/notes/*` 可继续保留，不影响旧功能。

---

## 6. 已知问题 / 风险

1. **前端 build 未验证**。`NotesGraph.tsx` 与 `NotesPage/index.tsx` 中的 Sigma/Tea 组件 props 可能还有编译期细节。
2. **Proxy 编译未验证**。`notes-bridge.ts` 和 `note-tools-injector.ts` 只做了源码评审。
3. **服务运行时未联调**。当前容器是停止状态。
4. **Knowledge 服务依赖需要 native binary**。重装依赖后务必执行 `prebuild-install`，否则 `better-sqlite3` 会报 `.node` 找不到。
5. **Team Notes 不注册 AssetType**。面板侧不参与 `agent-fixed-asset` 分配；所有 notes 对 team 成员可见。
6. **写权限**：当前 Knowledge 数据面本身不校验 membership，只校验 service/team 参数；membership 由 Panel 路由与 Proxy bridge 前置保证。**不要绕过 Panel/Proxy 直连 KS 并误以为天然鉴权。**
7. **未提交 Git**。本轮没有 commit；现场还有前两轮的未提交改动，提交前建议先核对 `git status`。

---

## 7. 下一步（Phase 2+，不在本轮交付范围）

按 `memory-agent/05_TeamNotes_CodeMemoryV2_目标与计划.md`：

- Phase 2：`summary_tips` 表 + `/memory-bridge/v3/tips/submit` + `<summary_tips_contract>` + 触发配置。
- Phase 3：`code-v2/l1-extraction-with-tips.ts`。
- Phase 4：Project Packager + `project/topics/*.md` + `project/MEMORY.md`。
- Phase 5：面板展示 L0.5 tips。
- Phase 6：整体测试与回滚验证。

提示词/配置/回滚细节参考 `memory-agent/CodeMemoryV2-Prompt-Migration.md`。
