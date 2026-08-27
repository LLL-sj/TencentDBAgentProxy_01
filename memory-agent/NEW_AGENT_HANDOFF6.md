# 新 Agent 工作交接（TencentDB-Agent-Memory · 第六轮 · 总交接）

> 本文件是**总交接**，已经吸收 `NEW_AGENT_HANDOFF.md` 至 `NEW_AGENT_HANDOFF5.md` 的全部内容。
> 新 Agent **只需要读本文件**，不需要再回头读其他 handoff。
> 当前状态：Phase 1–6 已完成；下一阶段“面板 chat/code 记忆视图改造”已确认方案但**尚未开始**。

---

## 0. 当前现场快照

- 仓库：`/home/luuu/Desktop/TencentDB-Agent-Memory`
  - Windows 侧路径：`\\wsl.localhost\Ubuntu-24.04\home\luuu\Desktop\TencentDB-Agent-Memory`
- Git：分支 `feat/server_team`，HEAD `fe3230f`
- **全部改动仍未 git commit**，`git status --short` 当前约 89 项；提交前必须核对，未得到用户指示前不得提交。
- 三容器状态：`tdai-memory-core` / `tdai-memory-hub` / `tdai-proxy` 全部 healthy。
- 当前 `.env` 默认：
  ```bash
  MEMORY_PROMPT_MODE=code
  MEMORY_CODE_MEMORY_VERSION=v1
  MEMORY_PROJECT_MEMORY_ENABLED=false
  ```
- 测试数据已清理：`summary_tips` 计数为 0；`project/` 测试 topic 和 MEMORY.md 已删除。
- 三镜像已重建，旧镜像均保留备份 tag（见 §6）。

---

## 1. 环境与账号速查

- 端口：
  - Memory Core：`8420`
  - Panel：`8125`
  - Knowledge：`8424`
  - Proxy：`8096`
- 数据卷：
  - `tdai-memory-core-data`
  - `tdai-panel-data`
- Docker 写操作必须：
  ```bash
  export DOCKER_CONFIG=/tmp/docker-cfg
  ```
- admin key：`deploy/global-images/.admin-key`
- **林婷账号已注销，不要再用。** 测试可用 admin。
- 测试常用身份：
  ```text
  team_id: team-w513ek28vu
  agent_id: agt-xb1fvpz2la
  task_id: task-w56hiyww0x
  user_id: usr-w3yr3upi6l
  ```
- LLM：走中转 `https://api.zhongjx.xyz/v1`，模型 `deepseek-v4-pro`，协议 `openai`。
- 启动/停止：
  ```bash
  cd deploy/global-images
  ./stop-all.sh
  ./start-all.sh
  ```

---

## 2. 历史改动总览

### 2.1 项目原有能力（HANDOFF1 之前）

1. MemoryCore L0–L3 记忆内核：
   - L0 原始对话、L1 原子记忆、L2 scene 场景块、L3 persona/Doctrine；
   - L1 触发调度（每 N 轮 / idle / warmup）、L1 去重、JSONL + SQLite/TCVDB 存储；
   - `/v2`、`/v3` 数据面 API。
2. chat / code 两套内置提示词：
   - chat：persona / episodic / instruction；
   - code：work_fact / work_task / work_method / work_artifact。
3. MemoryProxy：
   - 对话捕获写 L0；
   - session 身份恢复；
   - memory-bridge 只读工具；
   - skill / knowledge 注入与 bridge。
4. MemoryKnowledge：Wiki / CodeGraph 知识资产能力。
5. MemoryPanel：
   - 登录、实例选择；
   - 团队 / 成员 / Agent / Task / API Key 管理；
   - Wiki、Code_Graph、Skill、Chat_Memory 页面；
   - 资产分配 / Agent 挂载链路。
6. 部署：core / hub(panel+knowledge) / proxy 三容器。

### 2.2 前五轮及 Phase 1–6 新增

1. **HANDOFF1：code 模式改造**
   - 新增统一开关 `MEMORY_PROMPT_MODE=chat|code`；
   - core/proxy 两端由同一 `.env` 生成配置；
   - 8 份 chat/code 提示词拆分为独立 TS 文件，facade 按 `promptMode` 选择；
   - Proxy 的 `<memory-tools-guide>` / `<tdai_memory_tools>` 拆成 chat/code 两套。

2. **HANDOFF2：Agent 挂载调研与验证**
   - `chat_memory-{team}-{agent}` 资产；
   - `agent-fixed-asset/set` 全量替换绑定；
   - 借入 ≤ 2、同 team、不能借自己；
   - private 资产同 owner 才可挂载；
   - 对新会话生效。

3. **Phase 1：Team Notes**
   - Knowledge `/v3/notes/*`；
   - Panel `/api/v1/notes/*`；
   - Proxy `/notes-bridge/v3/notes/*`；
   - `<note_tools>` 注入；
   - 前端 Team Notes 列表 / Markdown / 标签图 / Mermaid / 导出。

4. **Phase 2：L0.5 summary_tips**
   - `summary_tips` 表；
   - Core `/v3/tips/submit|list|get`；
   - Proxy `/memory-bridge/v3/tips/submit`；
   - `<summary_tips_contract>` 静态契约 + final-answer 后动态提醒；
   - 去重、锚点解析、team 隔离。

5. **Phase 3：L1 v2 提示词与开关**
   - `codeMemoryVersion: v1 | v2`，默认 v1；
   - `code-v2/l1-extraction-with-tips.ts`；
   - pending tips 按 `l0_end_ref` 插入待提取消息流；
   - `source_refs` / `confidence` 合并进 L1 `metadata_json`，L1 主表不变；
   - v1 路径完全保留。

6. **Phase 4：Project Memory**
   - `project-memory-packager.ts`；
   - LLM 维护 `project/topics/*.md`；
   - 代码确定性生成 `project/MEMORY.md`；
   - Core `/v3/project/list|read|search`；
   - Proxy v2 只注入 `<tdai_project_memory>`（MEMORY.md 索引），不注入旧 L3/L2 索引；
   - `projectMemory.enabled=false` 默认关闭。

7. **Phase 5：面板展示 L0.5 tips**
   - Panel `/api/v1/tips/list|get`；
   - 前端 `Summary Tips` 页面；
   - 列表 / 详情 / L0 锚点 / 状态 / tags 展示。

8. **Phase 6：整体测试与镜像重建**
   - 三服务集成测试通过；
   - v1 / v2 切换与回滚验证通过；
   - 更新 `memory-agent/02_修改说明与实施记录.md`；
   - 新增 `memory-agent/04_code_memory_v2_改造记录.md`；
   - 重建三镜像并保留备份 tag。

---

## 3. 当前功能清单

### 3.1 Core（8420）

- L0/L1/L2/L3 v1 数据面；
- `/v3/tips/submit|list|get`；
- `/v3/project/list|read|search`；
- team/user/agent/task 元数据管理；
- skill / knowledge 相关上游能力。

### 3.2 Knowledge（8424）

- Wiki、CodeGraph；
- Team Notes `/v3/notes/*`。

### 3.3 Panel（8125）

- 团队 / 成员 / Agent / Task / API Key；
- Wiki、Code_Graph、Skill、Chat_Memory；
- Team Notes 页面；
- Summary Tips 页面（下一阶段将并入 code 记忆页，见 §8）；
- 顶栏设置中的资源权限开关仍是 4 项：
  `WIKI / SKILL / CODE_GRAPH / CHAT_MEMORY`。

### 3.4 当前左侧资产管理菜单

当前实际有 6 项：

```text
WIKI / TEAM_NOTES / CODE_GRAPH / SKILL / CHAT_MEMORY / SUMMARY_TIPS
```

已确认的最终口径：

- `TEAM_NOTES` **保留**在资产管理菜单；
- `SUMMARY_TIPS` **不再单独占菜单**，并入 code 记忆页的 L0.5 层。

### 3.5 Proxy（8096）

- session init / 身份恢复；
- skill bridge；
- knowledge bridge；
- memory bridge（L0/L1/L2/L3/project 只读）；
- notes bridge；
- tips submit bridge；
- 注入器：
  `skill / knowledge / tdai-memory / notes / summary-tips`。

---

## 4. 当前记忆机制（以本节为准）

### 4.1 面板视角（已确认的最终目标）

```text
面板选择 chat | code

chat：
  L0 原始对话
  L1 原子记忆（persona/episodic/instruction）
  L2 scene_blocks/*.md
  L3 persona.md

code：
  L0    原始对话
  L0.5  summary_tips
  L1    结构化原子记忆（work_fact/work_task/work_method/work_artifact）
  L2    project/topics/*.md（即 code v2 的 L2.5）
  L3    project/MEMORY.md
```

### 4.2 v1 链路（chat 与 code v1 通用骨架）

```text
L0 原始对话
  → L1 LLM 抽取结构化原子记忆
  → L1 内部去重
  → L2 scene_blocks/*.md
  → L3 persona.md / Team Operating Doctrine
```

- chat L1：persona / episodic / instruction；
- code v1 L1：work_fact / work_task / work_method / work_artifact。

### 4.3 code v2 链路

```text
L0   原始对话（唯一事实基准）
  ↘
L0.5 Agent 在任务/流程结束后主动提交 summary_tips（带 L0 锚点）
  ↘
L1   结合 L0 与 L0.5 抽取结构化原子记忆；去重发生在 L1 内部
  ↘
L2   项目级经验文件 project/topics/*.md（即 L2.5）
  ↘
L3   代码扫描 topics frontmatter 生成 project/MEMORY.md（不调 LLM）
```

### 4.4 L0.5 规则

1. Agent 在“任务/流程完整结束且收到用户反馈”时，通过 HTTP 工具提交。
2. 提交带 L0 锚点：`l0_start_ref` / `l0_end_ref` / `l0_refs`。
3. 状态机：`pending → consuming → consumed | duplicate | expired`。
4. 相同锚点 + summary 去重，重复提交返回同一个 tip。
5. tips 不是每轮写。

### 4.5 L1 v2 规则

1. 当前实现：
   - System Prompt 以 L0 为事实来源；
   - SUMMARY_TIP 用于提升对应段落的提取优先级；
   - tips 按 `l0_end_ref` 插入待提取消息流；
   - 无 tips 时行为与 v1 一致；
   - `source_refs` / `confidence` 合并进 `metadata_json`。
2. 用户最新口径：
   - 一条 L1 **可以包含/聚合多条 L0.5**；
   - 当前数据协议已允许 `source_refs` 携带多个 `tip_id`；
   - 当前提示词未显式写出这条规则，但不禁止；
   - 用户确认 L1 v2 提示词先保留，不急于改。
3. 以后如要显式锁定“一条 L1 聚合多条 L0.5”，只需：
   - 在 v2 System/User Prompt 中补一句规则；
   - 加一个单测，断言输出 `source_refs` 可出现多个 `tip_id`。

### 4.6 L1 触发与去重

1. 触发：
   - 每 N 轮触发（当前 `everyNConversations=2`）；
   - warmup：新会话 `1 → 2 → 4 → ... → N`；
   - idle 兜底（当前 `60s`）；
   - 失败留待下轮，不阻断主对话。
2. 去重：
   - 复用 `code/l1-dedup.ts`；
   - 在 L1 内部完成，不在 L2 做 L1 记录级去重；
   - 失败时跳过仍可写 L1。

### 4.7 L2 / L2.5（项目经验打包器）

1. 用户确认的语义：
   - L1 是会话级原子记忆；
   - L2 是把多个 session 的 L1 汇总到**项目级**；
   - 合并重复内容；
   - 提取可复用的场景 / 经验；
   - 产出或更新 `project/topics/*.md`。
2. 当前实现：
   - 输入：当前 MEMORY.md 索引 + 已有 topics 清单 + 本批 pending tips + **最近 60 条已去重 L1**；
   - LLM 用文件工具读旧 topic，再更新旧文件或新建文件；
   - 写完后工程代码重建 `project/MEMORY.md`；
   - 成功后 pending tips 标记 `consumed`，失败保留 `pending`。
3. 用户确认：
   - **不要**全量 L1 历史；
   - **不要**显式计算“重复越多越重要”的频次权重；
   - 逻辑保持不变；
   - 下一步只把 L2.5 System Prompt 文案改得更直白：明确“把多个 session 的 L1 汇总到项目级、去重合并、提取场景/经验”。

### 4.8 L3（code v2）

1. 不调 LLM；
2. 代码扫描 `project/topics/*.md` frontmatter；
3. 按首个 tag 分组、标题排序；
4. 生成 `project/MEMORY.md` 并写入 hash；
5. `indexMaxChars` 超限时降级为 title+tags，再超则截断。

### 4.9 注入与读取

1. `codeMemoryVersion=v1`：
   - 注入旧 `<tdai_profile_memory>`：
     - 自有/借入 Agent 分段；
     - L3 全文；
     - L2 只注入 path + summary 索引；
   - L0/L1 通过 `<tdai_memory_tools>` 按需查。
2. `codeMemoryVersion=v2`：
   - 注入 `<tdai_project_memory>`：
     - 只注入 `project/MEMORY.md` 索引；
   - 注入 `<project-memory-tools-guide>`；
   - 不注入旧 L3 Doctrine 全文和旧 L2 scene index；
   - topic 正文按需 `project/read`；
   - L0/L1 检索工具仍保留。
3. 其他注入：
   - `<note_tools>`；
   - `<summary_tips_contract>` + user.before 动态提醒。

### 4.10 存储与隔离

- L0：`l0_conversations`；
- L0.5：`summary_tips`；
- L1：`l1_records` + `records/YYYY-MM-DD.jsonl`；
- v1 L2：`scene_blocks/*.md`；
- v1 L3：`persona.md`；
- v2 L2：`project/topics/*.md`；
- v2 L3：`project/MEMORY.md`；
- v2 packager state：`project/.packager-state.json`；
- profile scope：`profiles/team:<team>|agent:<agent>/...`。

---

## 5. 配置与默认值

### 5.1 `.env` 当前值

```bash
MEMORY_PROMPT_MODE=code
MEMORY_CODE_MEMORY_VERSION=v1
MEMORY_PROJECT_MEMORY_ENABLED=false
```

### 5.2 core 生成配置关键段

```yaml
memory:
  promptMode: code
  codeMemoryVersion: v1
  l1V2:
    summaryTipBlockTemplate: |-
      <SUMMARY_TIP id="{{tip_id}}" covers="{{l0_start_ref}}..{{l0_end_ref}}" tags="{{tags_csv}}">
      {{summary}}
      </SUMMARY_TIP>
    noSummaryTipsText: （本批没有 Agent 提交的 SUMMARY_TIP）
    summaryTipRuleText: SUMMARY_TIP 是 Agent 主动提交的高价值总结，仅用于提升对应段落的提取优先级；不是独立事实来源，不得作为事实写入记忆。
  projectMemory:
    enabled: false
    minPendingTips: 3
    minDistinctSessions: 2
    packagerMinIntervalSeconds: 1800
    packagerMaxIntervalSeconds: 14400
    indexMaxChars: 6000
    topicMaxChars: 4000
```

### 5.3 proxy 生成配置关键段

```yaml
tdai:
  memory:
    promptMode: code
    codeMemoryVersion: v1

injection:
  injectors:
    - skill
    - knowledge
    - tdai-memory
    - notes
    - summary-tips
```

---

## 6. 镜像 / 容器 / 备份

### 6.1 当前镜像

| 镜像 | 当前 ID | 说明 |
|---|---|---|
| `agentmemory/memory-core:local` | `2de0c5f5545b` | Phase 6 重建 |
| `agentmemory/memory-hub:local` | `b3172dbc1a00` | Phase 5/6 重建 |
| `agentmemory/memory-proxy:local` | `db8035750dde` | Phase 6 重建 |

### 6.2 备份 tag

```text
agentmemory/memory-hub:local-backup-20260817-phase1-pre
agentmemory/memory-hub:local-backup-20260819-phase5-pre
agentmemory/memory-core:local-backup-20260819-phase5-pre
agentmemory/memory-proxy:local-backup-20260819-phase5-pre
```

### 6.3 源码挂载

- core/proxy：`start-*.sh` 当前仍保留源码挂载；
- hub：无源码挂载，面板改动必须重建 hub 镜像；
- 最终发布前建议移除宿主机源码挂载并做无挂载复验。

---

## 7. 已验证结果

### 7.1 编译与单测

| 命令 | 结果 |
|---|---|
| `cd MemoryCore && npx vitest run src/core/prompts/code-v2/l1-extraction-with-tips.test.ts src/core/record/l1-extractor.v2.test.ts src/core/tips/summary-tips.test.ts src/utils/project-memory-packager.test.ts` | ✅ 20/20 |
| `cd MemoryCore && npx tsdown` | ✅ |
| `cd MemoryProxy && npx tsc --noEmit` | ✅ |
| `cd MemoryKnowledge && npm run typecheck && npm run build` | ✅ |
| `cd MemoryPanel && npm run typecheck && npm run build` | ✅ |
| `cd MemoryPanel/web && npm run build` | ✅ |

> 注意：**不要对 MemoryCore 跑全量 `tsc --noEmit`**。MemoryCore 没有根 tsconfig，且存量文件有与本次无关的历史类型错误；只跑 targeted vitest + tsdown。

### 7.2 容器验证

- v1 默认状态：
  - 三容器 healthy；
  - core project/list 返回空；
  - panel tips/list 返回空；
  - proxy project bridge 未初始化会话返回 `40101`。
- v2 状态：
  - `codeMemoryVersion=v2`、`projectMemory.enabled=true`；
  - proxy 注入 `<project-memory-tools-guide>`，无旧 `<tdai_profile_memory>`；
  - project/list|read|search 正常。
- v1 回滚状态：
  - 恢复旧 `<tdai_profile_memory>`；
  - 最终恢复默认 `.env` 并重启，三容器 healthy。
- 测试数据已清理：`summary_tips=0`；project 测试 topic / MEMORY.md 已删除。

---

## 8. 下一阶段计划（已和用户确认，尚未实施）

### 8.1 目标

把当前记忆面板整理为 **chat/code 双模式**：

```text
chat：L0 / L1 / L2 / L3
code：L0 / L0.5 / L1 / L2 / L3
```

其中 code 的 `L2 = project/topics/*.md`，`L3 = project/MEMORY.md`。

### 8.2 明确不做的

1. **不新增 Agent 选择器**；
   - 继续沿用现有记忆块选择逻辑；
   - Agent 由当前选中的 `chat_memory-{team}-{agent}` block 反解得出。
2. **不改 L2.5 打包器输入逻辑**；
   - 不引入全量 L1；
   - 不引入频次权重。
3. **不改 L1 v2 提示词语义**；
   - 仅保留“一条 L1 可聚合多条 L0.5”作为以后可选补强项。

### 8.3 具体改动

1. 前端：
   - 把现有 `Chat_Memory` 页升级为统一 `Memory` 页；
   - 页面顶部增加 `chat | code` 模式切换；
   - chat 模式继续使用现有 ChatMemoryPanel；
   - code 模式新增 CodeMemoryPanel：
     - 层 tab：`L0 / L0.5 / L1 / L2 / L3`；
     - `L0/L1` 复用 `/api/v1/chat-memory/layer`；
     - `L0.5` 复用 `/api/v1/tips/list|get`；
     - `L2` 调新增面板 project 接口，展示 topics 列表 + Markdown 详情；
     - `L3` 展示 `project/MEMORY.md`。
2. 后端：
   - 新增 `MemoryPanel/src/panel/http/routes/project.ts`：
     - `POST /api/v1/project/list`
     - `POST /api/v1/project/read`
     - team member 门控；
     - 从 `block_id` 或 `team_id+agent_id` 反解 scope；
     - 转发 Core `/v3/project/list|read`。
   - 注册到 `MemoryPanel/src/panel/http/app.ts`。
3. 菜单：
   - 删除 `SUMMARY_TIPS` 独立菜单项；
   - `TEAM_NOTES` 保留在资产管理菜单；
   - 资产管理菜单最终为 5 项：
     `WIKI / TEAM_NOTES / CODE_GRAPH / SKILL / CHAT_MEMORY`。
4. 提示词：
   - 只改 `MemoryCore/src/core/prompts/code-v2/l2-project-packager.ts` 的 System Prompt 文案；
   - 明确“L2 是项目级汇总：合并多个 session 的 L1，去重并提取场景/经验，更新 topics”；
   - 不改打包器输入/流程。

### 8.4 完成后验证

1. `MemoryPanel` typecheck + build；
2. `MemoryPanel/web` build；
3. 重建 hub 镜像：
   ```bash
   cd deploy/panel-knowledge-combined
   DOCKER_CONFIG=/tmp/docker-cfg CTX_DIR=/tmp/panel-knowledge-builder \
     APT_MIRROR=mirrors.aliyun.com \
     IMAGE_NAME=agentmemory/memory-hub IMAGE_TAG=local ./build.sh
   ```
4. 重启 hub 并验证：
   - chat 模式 L0/L1/L2/L3 正常；
   - code 模式 L0/L0.5/L1/L2/L3 正常；
   - Summary Tips 菜单消失；
   - Team Notes 菜单保留。
5. core/proxy 无需重建（本轮只改面板和提示词文案；若改 L2 提示词可通过 core 源码挂载生效，最终发布时再决定是否重建）。

---

## 9. 新 Agent 必做检查清单

1. 只读本文件，不要继续依赖 HANDOFF1–5。
2. 检查现场：
   ```bash
   cd /home/luuu/Desktop/TencentDB-Agent-Memory
   git status --short
   git rev-parse --short HEAD
   ```
3. 复跑验证：
   ```bash
   cd MemoryCore && npx vitest run \
     src/core/prompts/code-v2/l1-extraction-with-tips.test.ts \
     src/core/record/l1-extractor.v2.test.ts \
     src/core/tips/summary-tips.test.ts \
     src/utils/project-memory-packager.test.ts && npx tsdown
   cd ../MemoryProxy && npx tsc --noEmit
   ```
4. 检查容器和默认配置：
   ```bash
   export DOCKER_CONFIG=/tmp/docker-cfg
   docker ps --format '{{.Names}}\t{{.Status}}' | grep tdai
   grep -n 'codeMemoryVersion' deploy/global-images/.memory-core-config/tdai-gateway.yaml
   grep -n 'codeMemoryVersion' deploy/global-images/.proxy-config/config.yaml
   grep -n 'MEMORY_CODE_MEMORY_VERSION\|MEMORY_PROJECT_MEMORY_ENABLED\|MEMORY_PROMPT_MODE' deploy/global-images/.env
   ```
   默认应为 `v1` / `false` / `code`。
5. 最小冒烟：
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
6. 测试数据用后即清；写 Docker 一律带 `DOCKER_CONFIG=/tmp/docker-cfg`。
7. 未得到用户指示前，**不得 git commit**。

---

## 10. 已知风险 / 限制 / 待确认

1. 全部改动未 commit；Phase 1–6 均未提交 Git。
2. `summary_tips` / project packager 只在 SQLite-backed store 可用；TCVDB service 模式不工作。
3. Team Notes 面板 update/delete 当前只校验 team member，未完全细化为“作者或 team admin”。
4. Proxy reminder 状态是进程内 Map，容器重启后计数重置。
5. tips 表没有物理删除接口；测试数据需通过 SQLite 清理。
6. `PROXY_DEBUG_FORCE_IDENTITY` 仅供本地调试，生产禁止开启。
7. core/proxy 容器仍依赖源码挂载；最终发布前需移除宿主机路径依赖并复验。
8. 仓库内 `.bak` / `.bak-*` 临时文件尚未清理，需用户确认后处理。
9. 全仓库 `git diff --check` 仍会报告 `MemoryProxy/src/session/session-key.ts` 的旧 trailing whitespace（非本轮引入）。
10. 资产管理菜单当前有 6 项，按 §8 改造后应回到 5 项。

---

## 11. 回滚口径

```bash
# Code Memory v2 功能回滚
# .env 改回：
MEMORY_CODE_MEMORY_VERSION=v1
MEMORY_PROJECT_MEMORY_ENABLED=false
cd deploy/global-images && ./stop-all.sh && ./start-all.sh

# hub 镜像回滚到 Phase 5 之前
docker tag agentmemory/memory-hub:local-backup-20260819-phase5-pre agentmemory/memory-hub:local
cd deploy/global-images && ./stop-all.sh && ./start-all.sh

# hub 镜像回滚到 Phase 1 之前
docker tag agentmemory/memory-hub:local-backup-20260817-phase1-pre agentmemory/memory-hub:local
cd deploy/global-images && ./stop-all.sh && ./start-all.sh

# core 镜像回滚
docker tag agentmemory/memory-core:local-backup-20260819-phase5-pre agentmemory/memory-core:local
cd deploy/global-images && ./stop-all.sh && ./start-all.sh

# proxy 镜像回滚
docker tag agentmemory/memory-proxy:local-backup-20260819-phase5-pre agentmemory/memory-proxy:local
cd deploy/global-images && ./stop-all.sh && ./start-all.sh
```
