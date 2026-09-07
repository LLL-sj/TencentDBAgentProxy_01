# README.md — memory-agent 文件索引与阅读顺序

> 本目录集中存放 TencentDB-Agent-Memory 的记忆机制说明、修改记录、问题排障、运维手册与提示词。
> 命令中的仓库根目录指 `TencentDB-Agent-Memory/`；本目录为 `memory-agent/`。

---

## 1. 文件索引（按主题）

| 文件 | 内容 | 什么时候读 |
|---|---|---|
| `CURRENT_STATUS_功能实现与当前阶段.md` | **当前阶段总览**：功能实现 / 目前阶段 | 新 Agent 先读这一篇 |
| `AGENT_INDEX.md` | **部署与运维唯一入口**：服务器部署、.env、启停、日志、数据卷、镜像、排障 | 需要部署/运维/排障时读 |
| `MEMORY_MECHANISM.md` | 记忆机制最终口径：L0/L0.5/L1/L2/L3、chat/code/all/none、触发节奏、注入块 | 需要理解记忆系统怎么工作时读 |
| `L0_ROUTING_AND_EXTRACTION.md` | Codex/Claude Code 的 L0 路由与 User/Assistant 抽取规则 | 排查 L0 污染/抽取问题时读 |
| `TEAM_NOTES.md` | Team Notes 机制：定位、功能、数据模型、接口、编码校验、写权限 | 排查 Team Notes 问题时读 |
| `MAINTENANCE_AND_CHANGELOG.md` | **历史修改与交接的唯一档案**：全部轮次、经验与坑、剩余问题 | 查历史背景/剩余待办时读 |
| `ISSUES_AND_RESOLUTIONS.md` | 问题汇总与排障记录（原 `问题汇总.md`）：第一阶段部署/Codex 接入/L0 guard 等问题与解决 | 排查同类问题时读 |
| `prompts/` | chat / code / code-v2 / shared 提示词与说明 | 修改提示词时读 |

> 此前散落在本目录的 `NEW_AGENT_HANDOFF*`、`HANDOFF_*`、执行计划、报告、评审请求等临时交接文档已整理并入 `MAINTENANCE_AND_CHANGELOG.md`。更细粒度的过程文件可在 Git history 中找回。

## 2. 推荐阅读顺序

```text
新 Agent 快速上手：
  1. 本文件（README.md）
  2. CURRENT_STATUS_功能实现与当前阶段.md   ← 当前阶段、功能
  3. AGENT_INDEX.md                        ← 部署运维入口
  4. MEMORY_MECHANISM.md                   ← 记忆机制口径
  5. L0_ROUTING_AND_EXTRACTION.md          ← L0 抽取口径
  6. TEAM_NOTES.md                         ← Team Notes 口径
  7. MAINTENANCE_AND_CHANGELOG.md          ← 历史修改与剩余问题

查问题/排障：
  AGENT_INDEX.md 第 7 节
  ISSUES_AND_RESOLUTIONS.md
  MEMORY_MECHANISM.md 第 8 节

改提示词：
  prompts/README.md 或对应 mode 下的提示词文件
```

## 3. 文件更名对照

| 旧文件名 | 新文件名 | 原因 |
|---|---|---|
| `memory-agent/FINAL.md` | `memory-agent/MAINTENANCE_AND_CHANGELOG.md` | 旧名 `FINAL` 不体现内容，新名体现“长期维护与修改记录” |
| `memory-agent/问题汇总.md` | `memory-agent/ISSUES_AND_RESOLUTIONS.md` | 旧名只表示“问题”，新名体现“问题汇总与排障记录” |
| 仓库根目录 `AGENT_INDEX.md` | `memory-agent/AGENT_INDEX.md` | 集中到本目录，作为运维唯一入口 |

## 4. 目录结构

```text
memory-agent/
├── README.md                                 # 本文件：索引与阅读顺序
├── CURRENT_STATUS_功能实现与当前阶段.md        # 当前阶段总览
├── AGENT_INDEX.md                            # 部署与运维手册
├── MEMORY_MECHANISM.md                       # 记忆机制最终口径
├── L0_ROUTING_AND_EXTRACTION.md              # L0 路由与抽取
├── TEAM_NOTES.md                             # Team Notes 机制
├── MAINTENANCE_AND_CHANGELOG.md              # 历史修改与交接档案（原 FINAL.md）
├── ISSUES_AND_RESOLUTIONS.md                 # 问题汇总与排障（原 问题汇总.md）
└── prompts/                                  # chat/code/code-v2/shared 提示词
    ├── README.md
    ├── chat/
    ├── code/
    ├── code-v2/
    └── shared/
```
