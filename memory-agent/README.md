# Memory Agent 记忆提示词与模式规则

> 快速定位文件请先读仓库根目录 [`AGENT_INDEX.md`](../AGENT_INDEX.md)。

> 新 Agent 快速入口：先读 [`AGENT_INDEX.md`](../AGENT_INDEX.md)，再读 [`NEW_AGENT_HANDOFF7.md`](NEW_AGENT_HANDOFF7.md)（当前最新交接）和 [`NEW_AGENT_HANDOFF6.md`](NEW_AGENT_HANDOFF6.md)（上一轮总交接）。

## 目录

```
memory-agent/
├── 01_记忆机制与流程图.md          # L0-L3 机制
├── 02_修改说明与实施记录.md        # 已实施改动
├── 03_LLM调用与占位符清单.md      # LLM 调用点 + 占位符
├── 05_TeamNotes_CodeMemoryV2_目标与计划.md   # 新一轮 7 阶段计划
├── TeamNotes-TagGraph-Design.md              # Phase 1 Team Notes 设计
├── CodeMemoryV2-Prompt-Migration.md          # Phase 2-4 Code Memory v2 设计
├── 08_Phase3_L1v2_提示词评审稿.md             # Phase 3 已审批提示词
└── prompts/
    ├── chat/                      # chat 模式：每份提示词一个文件
    ├── code/                      # code 模式：每份提示词一个文件
    ├── code-v2/                   # code v2：L1 v2 提示词（人工可读副本）
    ├── shared/                    # chat/code 共用的动态 User Prompt 模板
    └── README.md                  # 模式选择与占位符说明
```

## 核心规则

### 1. 只有一个用户可见开关：`MEMORY_PROMPT_MODE`

```
MEMORY_PROMPT_MODE=chat | code
```

- `chat`：用户画像 / 生活记忆。
- `code`：项目 / 团队工作记忆，Agent 记录 `work_fact / work_task / work_method / work_artifact`。
- 项目 Agent 默认使用 `code`。

### 2. 一个开关同时喂给两个进程

MemoryCore 和 MemoryProxy 是两个独立进程，各自必须读自己的配置文件，所以运行时仍有：

```yaml
# memory-core/tdai-gateway.yaml
memory.promptMode: code

# memory-proxy/config.yaml
tdai.memory.promptMode: code
```

但这两个值**不需要手工同步**：`start-memory-core.sh` 和 `start-proxy.sh` 都从同一个 `.env` 变量生成配置：

```
MEMORY_PROMPT_MODE
      ├── 生成 memory.promptMode
      └── 生成 tdai.memory.promptMode
```

结论：进程内是两个配置字段，用户侧是一个标志位。这是两个独立服务架构下的正确做法，不是遗漏。

### 3. 一个 mode 决定整套提示词

```
promptMode = code|chat
      ├── L1 抽取     → chat/01 或 code/01
      ├── L1 去重     → chat/02 或 code/02
      ├── L2 场景     → chat/03 或 code/03
      ├── L3 画像/纲领 → chat/04 或 code/04
      └── Proxy 工具说明 → chat/05-06 或 code/05-06
```

## 实现方式

已实现：

1. 核心 8 份提示词物理拆分为 `MemoryCore/src/core/prompts/{chat,code}/` 下 8 个 TS 文件。
2. 原 facade 文件保留，按 `promptMode` 用三元判断选择对应文件。
3. MemoryProxy 同样新增 `promptMode`，`<memory-tools-guide>` 和 `<tdai_memory_tools>` 拆成 chat/code 两套。
4. 所有工程占位符由 builder/renderer 统一填充；切换 mode 时不需要手工改占位符。

## 切换方法

```bash
# .env 中改一个值
MEMORY_PROMPT_MODE=code

# 重启
./stop-all.sh
./start-all.sh
```

## 注意

- 切 mode 只影响之后新抽取的记忆，旧 chat 记忆不会自动清除。
- 需要纯净项目记忆时：清空数据卷重来，或查询时只筛 `work_*`。
