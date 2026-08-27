# 新 Agent 工作交接（TencentDB-Agent-Memory · 第二轮）

> 接续 `NEW_AGENT_HANDOFF.md`（第一轮：记忆模式改造）。本文件为第二轮交接：
> 已完成"agent 挂载功能调研与验证"，并遗留若干待办。新 Agent 先读本文件。

## 0. 项目与目标

- 仓库：`~/Desktop/TencentDB-Agent-Memory`（TencentCloud/TencentDB-Agent-Memory，HEAD = `fe3230f`，v2.0.0 + 本地未提交改动）
- 上一轮目标：记忆系统切 `promptMode=code` ✅ 已完成并验证
- 本轮目标：agent 挂载（继承记忆）功能在仪表盘可用 ✅ 已验证；后续任务见 §4

## 1. 环境与权限速查（重要，先读）

- 运行环境：WSL Ubuntu-24.04，Docker daemon 本机运行，`luuu` 已在 docker 组，`docker` 命令直接可用
- **DSH 会话 sandbox 限制**：
  - bash 命令对 `/home/luuu/Desktop` 与 `$HOME` **只读**，仅 `/tmp` 可写
  - docker CLI 需要写 `~/.docker` → 所有 docker 写操作前 `export DOCKER_CONFIG=/tmp/docker-cfg`（先 `mkdir -p`）
  - 文件写入请用 write/edit 工具（有 workspace-write 权限）
  - 需要更宽权限时可向用户发起带理由的提权请求（用户批准后执行）
- 构建镜像时：`docker build` 加 `--build-arg APT_MIRROR=mirrors.aliyun.com`（deb.debian.org 连不通，aliyun/ustc 通）

## 2. 当前状态快照

- **服务：当前全部停止**（Exited）。启动：`cd deploy/global-images && ./start-all.sh`
- 端口：面板 8125 / 内核 8420 / proxy 8096 / knowledge 8424
- 镜像：`agentmemory/{memory-core,memory-hub,memory-proxy}:local`（hub 为 8月13日构建的 v2.0.0；**本会话未成功重建任何镜像**，详见 §4-B）
- core/proxy 有**源码挂载**（改仓库文件+重启容器即生效）；**hub 无挂载**（面板改动必须重建镜像）
- `.env` 关键项：`MEMORY_PROMPT_MODE=code`、`MEMORY_LLM_PROTOCOL=openai`、LLM 走中转 `https://api.zhongjx.xyz/v1`（模型 `deepseek-v4-pro`，**非 DeepSeek 官方端点**）
- 账号/团队（数据卷 `tdai-memory-core-data` 持久）：
  - admin（system_admin）`usr-w3yr3upi6l`，key：`sk-mem-pJtMP9tKa9OETcP9zk1ue2QcGRtOHqME`
  - 林婷 `usr-w63bub41ds`，key：`sk-mem-Yl50WuPr4oZnWSI6rAlBdvv1X1rmPTtV`（本轮新创建）
  - 陈皓 `usr-w63bhhkxw5`，key：`sk-mem-lWhH4TVA8Y7qVQgIqJstUsR7sNd_13NE`（本轮新创建）
  - 团队：`team-w513ek28vu` 灵犀客服产品研发组（赵敏的助手 agt-xb1fvpz2la / 工作台组件匠 agt-w63cduf83d / 对话引擎守护者 agt-w63btlasu2）；`team-w52d38mbbn` 数据咨询外部项目
  - 挂载现状：赵敏的助手已挂载「对话引擎守护者」的记忆（测试后已恢复原状）
- git 状态：MemoryPanel 干净；core/proxy 有一批上一轮的未提交改动（提示词拆分等，靠挂载生效）

## 3. 本轮已完成（勿重复做）

1. ✅ 验证第一轮改动全部落盘且语法通过（8 份提示词拆分、facade 选择、双服务同源开关、挂载热更新）
2. ✅ 创建 `skill-knowledge-agent/` 文档夹：README、01 机制、02 LLM清单、03 Agent挂载调研、prompts/{skill,knowledge,shared}/
3. ✅ Agent 挂载机制调研（资产 `chat_memory-{team}-{agent}` + `agent-fixed-asset/set` 全量替换；借入≤2；private 资产同 owner 才可挂；新会话生效）
4. ✅ 仪表盘实测：`/api/v1/chat-memory/{allocate,unbind,agent-fixed,...}` 挂载→查询→解绑闭环通过；403 权限拦截通过；proxy 注入管线消费挂载关系（内核日志可见 list-with-detail 调用）
5. ✅ 前端入口确认：面板「Chat_Memory」页（3 tab + 分配到 Agent），线上 bundle 含全部文案
6. ✅ 为林婷/陈皓创建 user_key；权限模型实测（非管理员可建自己团队/不能加别队成员/不能建用户）
7. ✅ 尝试重建镜像失败后按用户要求**停止并清理**（/tmp 产物 + build cache 已清）

## 4. 待办任务（新 Agent 领取）

| # | 任务 | 优先级 | 入口 |
|---|---|---|---|
| A | **前端放开"非管理员建团队"按钮**（需先与用户确认产品口径）：`MemoryPanel/web/src/pages/team/components/TeamManagementPanel.tsx` 第255行 `{_isAdmin && (...)}` 与第292行 `onCreateTeam={_isAdmin ? ... : undefined}` 两处条件。后端 `team/create` 本就无限制。改完必须重建 hub 镜像（见 B） | 高（待拍板） | TeamManagementPanel.tsx |
| B | **重建三镜像**（上次失败已定位原因，修正参数即可）：core/proxy 用 `DOCKER_CONFIG=/tmp/docker-cfg DOCKER_BUILDKIT=1 docker build -t agentmemory/memory-core:local . --build-arg APT_MIRROR=mirrors.aliyun.com`（proxy 同理）；hub 用 `deploy/panel-knowledge-combined/build.sh`，参数 `IMAGE_NAME=agentmemory/memory-hub IMAGE_TAG=local CTX_DIR=/tmp/panel-knowledge-builder DOCKER_CONFIG=/tmp/docker-cfg`。成功后 `stop-all.sh && start-all.sh` 验证 | 中（非阻塞，现镜像可用） | 三个 Dockerfile |
| C | **Wiki/Skill 分配链路面板验证**：wiki/code 页 allocate→`<knowledge_tools>`；skills 页分配→`<available_skills>`；确认"团队共享≠自动可用，需分配挂载"（`skill_search` 工具是免挂载通道） | 中 | knowledge/allocate-routes.ts、skill-injector.ts |
| D | **记忆注入内容实测**：当前所有 agent L1-L3 为 0 条，注入只有工具指南；等 agent 聊出记忆后，验证新会话 system prompt 出现 `<agent role="imported_from">` 段（L3全文≤6000字 + L2索引） | 低 | tdai-fixed-asset.ts、tdai-profile-memory-injector.ts |
| E | **权限口径统一**：A 与"后端收紧 team/create"二选一；若收紧改 `createTeamForCaller` 加 admin 校验 | 低 | metadata-service.ts |
| F | **C 盘空间**：剩 47G；WSL 发行版 vhdx 在 C 盘，可建议用户 `wsl --manage Ubuntu-24.04 --move D:\...`（Windows 侧）；另有 9.8G 中间件镜像（milvus/canal/mysql 等，别的项目在用，**删前必须征得用户同意**） | 低 | 用户操作 |

## 5. 关键机制备忘（一句话版）

- 挂载 = 把别人 agent 的 `chat_memory` 资产绑到自己 agent（`agent-fixed-asset/set` 全量替换；解绑=重发不含该条的 bindings）；借入≤2、同 team、不能借自己；private 资产需同 owner，跨 owner 先把 visibility 改 `team`
- 挂载对**新会话**生效（session_init 缓存）；记忆本体存内核 SQLite 磁盘卷，系统提示词只是每会话现拉的快照
- 请求头：proxy 8096 需要 `x-team-id`/`x-agent-id`（`x-task-id` 可选，task 无需绑定，存在即可）；路径必须带 `/claude-code/default/v1/messages`
- 四类资产统一链路：创建 → 设可见性 → 分配/挂载到 agent → 会话注入；仅记忆有 ≤2 上限
- 面板 meta pass-through 对 `agent-fixed-asset/*` 返回 501 NOT_IN_SCOPE（有意），业务走 `chat-memory.ts` 专用路由

## 6. 常用命令

```bash
# 启动/停止
cd ~/Desktop/TencentDB-Agent-Memory/deploy/global-images
./start-all.sh          # 起三件套（core 8420 / hub 8125+8424 / proxy 8096）
./stop-all.sh

# docker 写操作（sandbox 下必须带）
mkdir -p /tmp/docker-cfg && export DOCKER_CONFIG=/tmp/docker-cfg

# 面板 API 测试（headers 必带实例与用户 key）
curl -X POST http://127.0.0.1:8125/api/v1/chat-memory/agent-fixed \
  -H 'content-type: application/json' -H 'x-tdai-service-id: default' \
  -H 'x-tdai-user-key: <user_key>' -d '{"agent_id":"agt-..."}'

# admin key 文件
cat ~/Desktop/TencentDB-Agent-Memory/deploy/global-images/.admin-key
```

## 7. 避坑清单

1. 面板（MemoryPanel）改动**必须重建 hub 镜像**才生效，没有挂载热更新
2. docker build 内 apt 必须用国内镜像源；hub build.sh 的 tag 参数是 `IMAGE_NAME=agentmemory/memory-hub IMAGE_TAG=local`（不能写成 `agentmemory:memory-hub:local`）
3. 测试挂载后记得恢复原绑定状态（数据是共享卷，勿留脏数据）
4. `.env` 里 LLM 是中转站 `api.zhongjx.xyz`，不是 DeepSeek 官方；若改官方端点需改 URL/KEY/模型名三处并重启
