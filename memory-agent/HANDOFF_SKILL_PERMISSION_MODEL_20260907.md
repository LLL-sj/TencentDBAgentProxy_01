# Handoff：Skill 权限与使用模型（当前现状）

> 日期：2026-09-07
> 目的：记录当前 Skill 权限/共享/使用机制，不包含修改建议。
> 关联报告：`REPORT_L0_SESSION_AND_MEMORY_CRUD_CDE_20260907.md`

---

## 1. 一句话现状

Skill 属于 `(team_id, owner_agent_id)`；创建者/拥有 Agent 可维护，共享后团队只读可见/可使用；其他成员需要复制到自己的 Agent 名下才能得到可写副本。

---

## 2. 核心归属模型

- 每个 Skill 有唯一 `owner_agent_id`（拥有它的 Agent）。
- 一个 Agent 创建 Skill 后，该 Skill 属于该 Agent。
- Skill 与 meta asset 关联，`asset_id === skill_id`。
- asset 可见性字段控制共享范围：
  - `visibility = 'private'`：仅 owner/创建者可见；
  - `visibility = 'team'`：团队可见/团队共享。

---

## 3. 当前页面/入口

### 3.1 页面 Tabs

| Tab | 含义 |
|---|---|
| Team 团队资产 | 当前团队内所有 `visibility = 'team'` 的 Skill；不显示 private |
| Fixed Agent 资产 | 某个 Agent 名下绑定/可见的 Skill |
| Personal 我的资产分配 | 当前用户 owner 的真实资产；private 和 team 都列出 |

### 3.2 个人维护入口

- Personal 中可切换：
  - `team` = 共享；
  - `private` = 私密。
- 共享后可随时切回私有：
  - 切回私有后从团队资产消失；
  - 其他人不能再作为团队共享内容访问；
  - 别人已 Fork 的独立副本不受影响。

---

## 4. 当前权限关系

| 角色 | 能否查看 | 能否修改/删除 |
|---|---|---|
| Skill 的 owner Agent / 创建者 | ✅ | ✅ |
| 团队内其他成员/其他 Agent | 只能看到共享（team）的 Skill | ❌ 不能改原版 |
| 非 owner 通过 skill-bridge 调用写接口 | 读可见时才可访问 | ❌ 后端返回 SKILL_NOT_OWNER |
| Admin | 可管理/删除（现有 UI 注释中的口径） | ✅ 管理侧可操作 |

### 4.1 面板按钮现状

- 后端严格 owner-only 校验。
- 前端详情页目前对所有能查看的人仍会显示“编辑/删除”按钮；非 owner 点击会触发后端权限错误。
- 尚未做前端按 owner 隐藏按钮。

---

## 5. “团队共享”到底是什么

当前**不是“共享后所有人改同一份”**，而是：

```text
团队共享 = 团队范围内只读可见、可搜索、可读取、可复制/使用
原版维护 = 只有 owner Agent / 创建者可改可删
个人可写版本 = 通过 Fork 复制到自己的 Agent 名下
```

### 5.1 Fork 副本

- Fork 会把源 Skill 的 SKILL.md 和资源复制成一个新 Skill；
- 新 Skill 的 owner 变成目标 Agent；
- 目标 Agent 可以修改自己的副本；
- 副本不影响团队原版；
- 原版后续更新也不会自动同步到已 Fork 的副本（当前无同步机制）。

### 5.2 与其他操作的区别

- “分配/挂载”是引用/只读使用形态；
- “Fork”是复制成个人可写副本。

---

## 6. Agent 注入与使用

- `<available_skills>` 主要列出**当前 Agent 自己拥有**的 Skill。
- 团队共享 Skill 不会自动全部注入给每个 Agent。
- Agent 可以通过 skill 搜索类工具发现团队共享 Skill。
- 想获得一个自己可改的版本，需要 Fork 到当前 Agent 名下。

---

## 7. skillRuntime.allowLlmWrite

- `allowLlmWrite = true` 只表示允许 Agent 通过 skill-bridge 调用 Skill 写接口；
- 是否允许修改某个 Skill 仍由后端 owner 校验决定；
- `false` 时所有 Skill 写接口都会被 bridge 拒绝；
- `true` 不等于“所有人可改”，非 owner 仍会收到 `SKILL_NOT_OWNER`。

---

## 8. 注入上下文时效性（Skill 部分）

- `skill-injector`、`skill-tools-injector` 均使用 `cacheStrategy = "session_init"`；
- Skill 列表与工具说明在 session 初始化时生成/缓存；
- 已有会话中修改 Skill 后，不会实时更新已注入内容；
- 新开会话 / 重新 session init 才会重新拉取。
