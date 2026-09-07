# Handoff：记忆触发参数微调 + 后续统一方案交接

> 日期：2026-09-07
> 分支：`feat/server_team`
> 状态：本交接记录“已完成/正在执行/下一步建议”。其中第 3 节参数已实际修改并部署到远程。
> 关联文档：
> - `memory-agent/INVESTIGATION_MEMORY_AND_SKILL_FLOW_20260907.md`
> - `memory-agent/AGENT_INDEX.md`
> - `memory-agent/L0_ROUTING_AND_EXTRACTION.md`

---

## 1. 结论摘要

当前项目最需要先解决的是“触发节奏不一致”问题：

- chat 的 L1/L2/L3 偏少；
- code 的 L1/L2 偏多；
- Skill 自动总结偏频繁；
- 目前 chat/code 使用同一套全局触发参数，不是独立方案。

因此本次先做“成本低、见效快”的全局参数调整；真正按 chat/code 分别调参、统一 L2/Skill 结构、拆分 L3 索引/总结属于下一阶段大改。

---

## 2. 已完成/已部署的改动

### 2.1 L1 单批 L0 数量 10 → 25

- 文件：`MemoryCore/src/utils/pipeline-factory.ts`
- 常量：`L1_BATCH_PROCESS = 25`
- 效果：每次 L1 可处理更多 L0，避免 5 轮对话被拆成很多批。

### 2.2 L1 单次输出最多 10 条

- 文件：`MemoryCore/src/config.ts`
- 生成脚本：`deploy/global-images/start-memory-core.sh`
- 效果：chat/code 每次 L1 最多保留 10 条原子记忆。
- 注意：这对 code 降噪更明显，但也会让 chat 输出更克制。

### 2.3 Skill 归档触发阈值调严

- `toolCallThreshold = 15`
- `archiveBytes = 61440`（60KB）
- 文件：`deploy/global-images/start-memory-core.sh`
- 效果：减少 Skill Review LLM 被频繁拉去总结的次数。

---

## 3. 本交接已执行的参数改动

以下为已修改并重新部署到远程的全局参数：

| 参数 | 当前 | 改为 | 语义 |
|---|---|---|---|
| `MEMORY_L1_IDLE_TIMEOUT_SECONDS` | 240 | 300 ✅ | L1 空闲兜底从 4 分钟改为 5 分钟 |
| `MEMORY_L2_DELAY_AFTER_L1_SECONDS` | 30 | 120 ✅ | L1 完成后等待 2 分钟再触发 L2 |
| `MEMORY_SESSION_ACTIVE_WINDOW_HOURS` | 3 | 2 ✅ | session 2 小时后不再周期触发 L2 |
| `MEMORY_L3_TRIGGER_EVERY_N` | 10 | 7 ✅ | 新增 L1 记忆达到 7 条后评估 L3 |

说明：

- 这些仍然是 chat/code 共用参数；
- 它们不等同于“给 chat 单独加频率、给 code 单独降频率”；
- 若要让 chat/code 真正独立，需要后续做 per-mode 触发配置，不属于本次小改动。

远程已验证生成配置：`l1IdleTimeoutSeconds=300`、`l2DelayAfterL1Seconds=120`、`sessionActiveWindowHours=2`、`triggerEveryN=7`。

---

## 4. 仍未解决 / 需要下一阶段处理的问题

### 4.1 chat 的 L2/L3 更新偏少

当前没有为 chat 单独提高 L2/L3 触发频率。仅靠全局参数很难同时满足：

- chat 希望更积极产生 L2/L3；
- code 希望更克制。

建议下一阶段把 L1/L2/L3 触发做成按 `memory_mode = chat | code` 独立配置，例如：

```text
chat:
  l1EveryNConversations: ...
  l1IdleTimeoutSeconds: ...
  l2DelayAfterL1Seconds: ...
  l3EveryNNewL1: ...

code:
  l1EveryNConversations: ...
  l1IdleTimeoutSeconds: ...
  l2DelayAfterL1Seconds: ...
  l3EveryNNewL1: ...
```

### 4.2 L3 当前依赖 L1 数量，而不是 L2 变化

chat L3 的触发计数是“新增 L1 条数”，但 L3 真正消费的是 L2 scene 文件。更合理的触发应改为“L2 文件变化”驱动。

### 4.3 L2/Skill 缺少统一限制

当前：

- L2 有文件数量/字符限制；
- Skill 没有数量上限、没有强制合并、没有单文件 token 限制；
- L2 与 Skill 虽然都应维护多文件，但参数各自独立。

下一阶段建议把 L2/Skill 做成同构“多文件维护模型”。

### 4.4 L3 索引/总结未拆分

- chat L3 更像“总结部分”，缺少自动索引；
- code L3 更像“索引部分”，缺少 LLM 总结；
- 下一阶段希望统一成“工程自动重建索引 + LLM/用户维护总结”。

---

## 5. 统一方案参考

详见 `memory-agent/INVESTIGATION_MEMORY_AND_SKILL_FLOW_20260907.md`。

统一模型核心：

| 层 | 触发条件 | 输入 | 输出 | 输出限制 |
|---|---|---|---|---|
| L0 | 真实主问答每轮插入 | User/Assistant 文本 | 原始消息 | 不写内部请求/tool |
| L0.5 | 完成任务且有复用价值 | Agent 主动提交 | summary_tips | 提醒次数/冷却/去重 |
| L1 | 轮次/空闲/warmup 触发 | 一批 L0 + tips + 背景 | 多条原子记忆 | 批大小/记忆条数/JSON 格式 |
| L2 | 新 L1 + 延迟/间隔/周期 | L3 相关 + L2 清单 + 新 L1 | 多个 L2 文件 | 文件数量/单文件大小/token |
| L3 | L2 变化触发 | L2 变化 + 当前 L3 | 索引 + 总结 | 文件数量/长度 |
| Skill | buffer 达到阈值 | 相关 Skill + 对话 | SKILL.md 多文件 | Skill 数量/单文件 token/合并 |

chat/code 对应层字段结构相同，value 可以不同。

---

## 6. 执行清单

### 6.1 本地修改

```text
1. .env.example / 远程 .env 调整：
   MEMORY_L1_IDLE_TIMEOUT_SECONDS=300
   MEMORY_L2_DELAY_AFTER_L1_SECONDS=120
   MEMORY_SESSION_ACTIVE_WINDOW_HOURS=2
   MEMORY_L3_TRIGGER_EVERY_N=7

2. 已存在代码改动：
   MemoryCore/src/utils/pipeline-factory.ts
   MemoryCore/src/config.ts
   deploy/global-images/start-memory-core.sh
```

### 6.2 构建/导出/上传

```bash
cd MemoryCore
docker build -t agentmemory/memory-core:local .

cd ..
docker save agentmemory/memory-core:local | gzip > backups/<core-tag>.tar.gz

scp backups/<core-tag>.tar.gz root@8.133.220.36:/root/tdai-memory/images/
scp deploy/global-images/start-memory-core.sh root@8.133.220.36:/root/tdai-memory/deploy/global-images/
```

### 6.3 远程部署

```bash
ssh root@8.133.220.36

cd /root/tdai-memory/images
docker load -i <core-tag>.tar.gz

cd /root/tdai-memory/deploy/global-images
# 修改 .env 对应四项后执行
./start-memory-core.sh
```

### 6.4 验证

```bash
docker ps | grep tdai-memory-core
curl -fsS http://localhost:28420/health

# 检查生成配置
grep -nE "l1IdleTimeoutSeconds|l2DelayAfterL1Seconds|sessionActiveWindowHours|triggerEveryN|maxMemoriesPerSession|toolCallThreshold|archiveBytes" \
  /root/tdai-memory/deploy/global-images/.memory-core-config/tdai-gateway.yaml
```

---

## 7. 回滚

远程已保留：

```text
agentmemory/memory-core:local-before-triggers-20260907
agentmemory/memory-core:local-before-cde-20260907
```

如需要回滚，可把 `.env` 参数还原后，用旧镜像 tag 重新 `start-memory-core.sh`。
