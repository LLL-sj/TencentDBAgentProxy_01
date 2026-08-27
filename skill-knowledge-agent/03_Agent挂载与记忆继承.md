# Agent 挂载与记忆继承

> 调研结论：如何让一个 Agent「挂载」另一个 Agent、继承其记忆；原理、API、面板现状与限制。
> 代码锚点：`MemoryCore/src/metadata/`（内核）、`MemoryProxy/src/injection/injectors/tdai-fixed-asset.ts`（注入）、`MemoryPanel/src/panel/http/routes/chat-memory.ts`（面板）。

---

## 1. 概念模型：资产 + 固定资产绑定

```text
资产（asset）                        固定资产绑定（agent-fixed-asset）
┌──────────────────────────┐        ┌─────────────────────────────────┐
│ chat_memory-{team}-{agt} │        │ agent_id   ← 挂载到谁             │
│   asset_type=chat_memory │◄───────│ asset_id   ← 挂载谁的记忆资产     │
│   visibility=private/team│ 绑定行  │ injection_mode=summary/direct/... │
│   owner_user_id          │        │ priority / created_by            │
└──────────────────────────┘        └─────────────────────────────────┘
```

- 每个 `(team, agent)` 自动拥有一个 **`chat_memory` 资产**，ID 稳定可推导：`chat_memory-{team_id}-{agent_id}`（agent_id 形如 `agt-…`）。
  生成时机：`agent/create`、会话写入（`handleConversationAdd`）都会幂等 `ensureChatMemoryAsset`，绑定 `injection_mode=summary`、`priority=50`。
- 「挂载别人的 agent」= 把**对方 agent 的 chat_memory 资产**加进**自己 agent 的绑定表**。

## 2. 继承原理（注入管线）

```text
请求到达 MemoryProxy（x-team-id / x-agent-id / x-user-key 头）
  → TdaiProfileMemoryInjector（session_init 缓存）
      → resolveFixedAssetCtxs()（tdai-fixed-asset.ts）
          → 内核 /v3/meta/agent-fixed-asset/list-with-detail（apply_visibility_filter=true）
          → 过滤：只留 asset_type=chat_memory
                  解析 team 必须 == 本 agent team（跨 team 排除）
                  排除自己；反查来源 agent 必须仍同 team（已删/不可见跳过）
          → [self, ...imported]；imported 最多 2 个（items.slice(0,2)）
      → 逐 agent 拉取并注入：
          <agent name=… role="self"|"imported_from" agent_id=…>
            <l3_core_memory> L3 全文（截断 6000 字）
            <l2_scene_index> 仅 path + ≤200 字 summary（正文靠只读工具按需拉）
      → L1 不预注入；LLM 通过 memory-bridge 工具按需召回（同样走这套 ctx，
         可指定查借入的 agent）
```

- 降级：内核不可达 → 只注入 self；`assetCapabilities.chat_memory=false` → 整个注入跳过。
- 挂载关系在 **session_init** 解析并缓存：新挂载对**新会话**生效。
- 结论（与直觉一致的精确版）：不是"扫描同 team 所有 agent"，而是**查本 agent 的绑定表**；「最多两个」指的是**借入的别人 ≤2**（加上自己最多 3 段）。

## 3. API（直接 curl 内核 memory-core:8420）

| 接口 | 用途 |
|---|---|
| `POST /v3/meta/agent-fixed-asset/set` | **全量替换**绑定（挂载/解绑都靠它） |
| `POST /v3/meta/agent-fixed-asset/list` | 列绑定（物理行） |
| `POST /v3/meta/agent-fixed-asset/list-with-detail` | 绑定 + 资产详情（可 `apply_visibility_filter`） |
| `POST /v3/meta/agent-fixed-asset/summary-by-agents` | 按 agent 汇总资产计数 |
| `POST /v3/meta/asset/{create,get,update,delete,list,list-accessible}` | 资产 CRUD（改 visibility 用 update） |
| `POST /v3/meta/acl/{grant,revoke,list,check}` | 资产授权（skill 分配用；绑定校验不走 ACL） |

认证头（内核 `/v3/meta/*`）：
- `Authorization: Bearer <gateway apiKey>`（本部署为空 = 不校验）
- `x-tdai-service-id: <instanceId>`（必填；本部署为 `default`）
- `x-tdai-user-key: <user key>`（必填；本部署可用 `.admin-key` 或 user-key/create 的 key）

### 挂载示例

```bash
curl -s -X POST http://127.0.0.1:8420/v3/meta/agent-fixed-asset/set \
  -H 'content-type: application/json' \
  -H 'x-tdai-service-id: default' \
  -H "x-tdai-user-key: $(cat .admin-key)" \
  -d '{
    "agent_id": "agt-目标agent(挂载到谁)",
    "bindings": [
      { "asset_id": "chat_memory-<team>-agt-来源agent", "asset_type": "chat_memory",
        "injection_mode": "summary", "priority": 50, "created_by": "<你的user_id>" }
    ]
  }'
```

### 解绑示例

没有专用解绑路由：再调一次 `set`，`bindings` 里去掉那条即可（全量替换语义）。

## 4. 权限规则（`canBindAsset`）

| 资产 visibility | 可绑定条件 |
|---|---|
| `team` | 同 team 即可 |
| `agent` | 同 team |
| `private` | **同 owner_user_id 且同 team** |
| `task` / `restricted` | 不允许 |

- `chat_memory` 资产默认 `private`：同一用户名下的 agent 之间可直接互挂；
  跨用户挂载需先把资产 `visibility` 改成 `team`（`asset/update`）。
- 注入/读侧还有第二道过滤：`list-with-detail` 默认 `apply_visibility_filter=true`，
  私有化后被过滤的绑定会自然失效。

## 5. 面板（仪表盘）现状

- `MemoryPanel/src/panel/api/meta-actions.ts`：`agent-fixed-asset/` 前缀在
  `NOT_IN_SCOPE_PREFIXES`，公开 `/meta/*` pass-through 一律 `501 NOT_IN_SCOPE`
  （设计决策 12.3）。
- **例外落点**：`MemoryPanel/src/panel/http/routes/chat-memory.ts` —— 面板专属
  Chat Memory 业务路由（11 个 endpoint：`agent-fixed` / `allocate` / `unbind` /
  `set-agent-fixed` / `team-assets` / `my-agents` / `layer` / `import` …），
  内部通过 `metaKernel.invoke('agent-fixed-asset/set', …)` 直调内核，并对借入做
  `MAX_IMPORTED_AGENTS=2` 校验（`domain/chat-memory-governance.ts`）。
- 前端：`web/src/pages/memory/ChatMemoryPage`（3 tab：团队资产 / 固定资产 /
  我的资产分配），`AllocateMemoryDialog`（agent 下拉选择 + 分配按钮，
  **不需要手输 agent_id**），已注册路由 `/memory` 与导航菜单。
- 结论：**源码（v2.0.0）里挂载功能已经完整实现**；看不到入口的原因大概率是
  部署的 Control 面板容器是旧镜像（面板不在 `deploy/global-images` 的本地构建
  链路里）。升级面板镜像到 v2.0.0 即可获得入口。

## 6. 限制与注意

1. 借入上限 2（内核注入侧 `slice(0,2)` 与面板侧 `MAX_IMPORTED_AGENTS` 双重约束）。
2. 挂载只影响**之后新会话**的注入（session_init 缓存）。
3. 旧 binding 在资产切 private 后不会被自动清除，但读侧 visibility 过滤会让它失效。
4. 跨 team 挂载被注入侧与 `canBindAsset` 双重禁止。
