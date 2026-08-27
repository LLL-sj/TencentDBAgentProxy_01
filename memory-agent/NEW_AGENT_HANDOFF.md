# 新 Agent 执行交接文档（Memory Agent 项目）

## 0. 项目与目标

- 仓库：`~/Desktop/TencentDB-Agent-Memory`
- 目标：把记忆系统从“用户画像模式”改为“项目 Agent 工作记忆模式”
- 原始问题：聊了很多轮 L1 像没触发。根因是配置用了 `promptMode: chat`，chat 只抽用户画像，项目讨论常抽出 0 条
- 解决方案：切到已内置的 `promptMode: code`，并让 core/proxy 共用一个开关；相关代码改动已完成

## 1. 新 Agent 先读这个索引

| 文件 | 读它干什么 |
|---|---|
| `memory-agent/README.md` | 目录结构 + 一个开关的总规则 |
| `memory-agent/01_记忆机制与流程图.md` | L0-L3 写入/触发/注入机制 |
| `memory-agent/02_修改说明与实施记录.md` | 已实施改动清单和生效方法 |
| `memory-agent/03_LLM调用与占位符清单.md` | LLM 调用点、占位符、chat/code 差异 |
| `memory-agent/prompts/chat/` | chat 模式每份提示词一个文件 |
| `memory-agent/prompts/code/` | code 模式每份提示词一个文件 |
| `memory-agent/prompts/shared/` | 共用 User Prompt 模板和占位符 |

## 2. 核心规则（只需记住一条）

```text
MEMORY_PROMPT_MODE=code|chat
   ├── 生成 memory-core 的 memory.promptMode
   └── 生成 memory-proxy 的 tdai.memory.promptMode
```

- 项目 Agent 用 `code`，L1 会抽 `work_fact/work_task/work_method/work_artifact`
- 两个服务是独立进程，所以配置字段是两个，但由同一个 `.env` 变量生成，不需要手工同步

## 3. 已经完成的改动

- 核心 8 份提示词已拆成 8 个 TS 文件：
  `MemoryCore/src/core/prompts/{chat,code}/{l1-extraction,l1-dedup,l2-scene,l3-persona}.ts`
- 原 facade 文件保留，按 `promptMode` 选择对应文件
- MemoryProxy 已新增 `tdai.memory.promptMode`
- Proxy 的 `<memory-tools-guide>`、`<tdai_memory_tools>` 已拆成 chat/code 两套
- `start-memory-core.sh` / `start-proxy.sh` 都从 `MEMORY_PROMPT_MODE` 生成配置
- 部署脚本已挂载提示词源码，改文件后重启容器即可生效，不必重新打镜像

## 4. 新 Agent 要执行的操作

```bash
cd ~/Desktop/TencentDB-Agent-Memory/deploy/global-images

# 1. 确认 .env 关键项
grep -E 'MEMORY_PROMPT_MODE|MEMORY_LLM_BASE_URL|MEMORY_LLM_API_KEY|MEMORY_LLM_MODEL|MEMORY_LLM_PROTOCOL' .env

# 2. 停止旧服务
./stop-all.sh

# 3. 启动
./start-memory-core.sh
./start-proxy.sh
```

`.env` 应保持：

```bash
MEMORY_PROMPT_MODE=code
MEMORY_LLM_PROTOCOL=openai   # 内核 L1/L2/L3 目前只支持 OpenAI 兼容协议
```

## 5. 验证是否成功

```bash
# core 配置生效
docker exec tdai-memory-core grep -n 'promptMode' /data/config/tdai-gateway.yaml

# L1 是否触发
docker logs -f tdai-memory-core | grep -E '\[l1\]|pipeline_l1_trigger|L1 complete'

# 聊 2-3 轮项目内容后，检查 L1 记录文件
docker exec tdai-memory-core ls -l /data/tdai-memory/records/
```

成功标准：日志出现 `[l1] Processing ... L0 messages`，且 `stored>0`，`records/` 出现当天 JSONL。

## 6. 注意事项

- 本次环境无 Docker socket 权限，**没有真正重启过服务**；新 Agent 必须在目标机器执行第 4 步
- 切换 mode 只影响之后新抽取的记忆，旧的 chat 记忆不会自动删除
- 若旧记忆污染项目召回：清空 `tdai-memory-core-data` 数据卷重来，或查询时只筛 `work_*`
- 若 L1 仍为空：先查日志是“没触发”还是 `LLM extraction failed`；后者检查 LLM 端点和协议
