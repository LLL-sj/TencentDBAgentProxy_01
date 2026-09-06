# Handoff：L0 Session 化 + Chat L2/L3 编辑/删除 + Skill UI（阶段 A/B）

> 日期：2026-09-07  
> 范围：执行计划 `EXECUTION_PLAN_L0_SESSION_AND_MEMORY_CRUD_20260907.md` 的 **阶段 A、B**  
> 状态：本地源码已修改并通过基础类型检查/构建，**未部署到服务器**  
> 说明：阶段 C/D/E 未执行；如需继续请基于本交接继续。

---

## 1. 本次完成内容

### 1.1 阶段 A：L0 按 Session 展示

#### MemoryCore
- 新增 L0 session 汇总能力：
  - `IMemoryStore.listL0Sessions(filter)`
  - SQLite 实现：`GROUP BY session_id`，返回消息数、首末时间
  - TCVDB 实现：按 `(team, agent, user)` 分页扫描后内存聚合
- 新增数据面接口：
  - `POST /v3/conversation/sessions`
  - 入参沿用 v3 strict isolation：`team_id/agent_id/user_id`
  - 返回 `{ items: [{ session_id, message_count, first_recorded_at_ms, last_recorded_at_ms }], total }`
- 已将路径加入 `V3_ALLOWED_SUBPATHS` 与路由表

#### MemoryPanel
- `POST /chat-memory/l0-sessions`
  - 沿用 `/chat-memory/layer` 的读权限（owner / team 可见 / 借入可读）
  - 转发 MemoryCore `/v3/conversation/sessions`，时间字段转为 ISO
- `POST /chat-memory/layer` L0 分支：
  - 响应 item 增加 `session_id`
  - 支持 `body.session_id`：传了只查该 session，未传保留跨 session 聚合语义
  - 游标分页仍用 `before_ts`

#### 前端
- `ChatMemoryLayerItem` 增加 `session_id`
- 新增 `L0SessionSummary` 与 `chatMemoryApi.l0Sessions`
- Chat Memory：
  - 进入 L0 后先拉 session 列表
  - 默认选中最近 session
  - 切换 session 按 session_id 请求消息
  - L0 “加载更多更早消息”按当前 session 的 `before_ts` 执行
  - 详情面板顶部显示 session 选择胶囊
- Code Memory：
  - L0 同样改为 session 列表 + 当前 session 消息
  - L1 仍保留原有分页
  - L0 不再用 offset 分页，改为 `session_id + before_ts` 加载更多
- 未展示 `session_id` 的旧数据会归到默认 session 分组显示

### 1.2 阶段 B：Chat L2/L3 编辑/删除 + Skill UI

#### Chat L2/L3 后端暴露
- 新增 Panel 端点：
  - `POST /chat-memory/l2-write` → MemoryCore `/v3/scenario/write`
  - `POST /chat-memory/l2-delete` → MemoryCore `/v3/scenario/rm`
  - `POST /chat-memory/l3-update` → MemoryCore `/v3/core/write`
- 权限：仅 **chat_memory asset owner** 可写；借入/只读用户不可写

#### Chat L2/L3 前端
- `BlockDetail`：
  - L2 / L3 条目提供“编辑”按钮
  - L2 额外提供“删除”按钮（L3 不删除）
  - 编辑弹层使用全文 textarea，保存后刷新当前层
- 新增 `chatMemoryApi.l2Write/l2Delete/l3Update`

#### Skill UI
- `SkillDetailPane` 由只读改为可编辑：
  - 顶部增加“编辑 / 删除”
  - 编辑 SKILL.md：弹层保存调用 `skillApi.update`
  - 删除 Skill：二次确认后调用 `skillApi.delete`
  - 文件预览：文本文件可在线编辑并保存，可删除当前文件
  - 文件操作调用 `writeSkillFiles / removeSkillFiles`
- `SkillsPanel` 向详情页传入 `onChanged`，保存/删除后刷新当前列表视图

---

## 2. 涉及文件

| 区域 | 文件 |
|---|---|
| MemoryCore | `src/core/store/types.ts`、`src/core/store/sqlite.ts`、`src/core/store/tcvdb.ts`、`src/gateway/v2-router.ts` |
| MemoryPanel 后端 | `src/panel/http/routes/chat-memory.ts` |
| MemoryPanel 前端 | `web/src/lib/api/chat-memory.ts`、`web/src/lib/teamApi.ts` |
| Chat UI | `web/src/pages/memory/ChatMemoryPage/components/ChatMemoryPanel.tsx`、`BlockDetail.tsx`、`chat-memory-panel.css` |
| Code UI | `web/src/pages/memory/MemoryPage/components/CodeMemoryDetail.tsx`、`code-memory-detail.css` |
| Skill UI | `web/src/pages/skills/SkillsPage/components/SkillDetailPane.tsx`、`SkillsPanel.tsx`、`skill-detail.css` |

---

## 3. 本地验证

- `MemoryPanel npm run typecheck`：通过
- `MemoryPanel/web npx tsc --noEmit`：通过
- `MemoryCore npm run build:plugin`：通过
- 未执行：
  - 未启动完整前后端联调
  - 未执行真实接口 curl 测试
  - 未构建 Docker 镜像
  - 未部署远程

---

## 4. 尚未完成/注意点

1. 阶段 C（Code L2/L3 编辑删除）未做。
2. 阶段 D（MemoryProxy memory-bridge / tools-injector 写能力）未做。
3. 阶段 E（镜像构建/打包）未做。
4. Skill “新增文件/上传文件”尚未做；当前 UI 支持已有文本文件编辑/删除、SKILL.md 编辑、Skill 删除。
5. 前端 session 化与 L2/L3 编辑按钮依赖新 Panel/后端接口，建议联调时覆盖：
   - 多 session 分组与切换
   - 无 session 旧数据展示
   - L2 编辑后刷新、删除后刷新
   - L3 只编辑不删除
   - Skill owner 才可编辑，非 owner 操作应被后端拒绝
6. 当前改动尚未提交 Git。
