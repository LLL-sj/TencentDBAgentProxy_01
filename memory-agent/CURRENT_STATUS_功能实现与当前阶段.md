# CURRENT_STATUS_功能实现与当前阶段.md — 当前执行阶段：功能实现 / 目前阶段

> 更新日期：2026-09-01
> 一句话结论：功能开发与本地验证已完成，三容器 healthy，三个镜像已从当前源码重建并导出；**当前只差按 `AGENT_INDEX.md` 执行服务器首次部署**。
> 详细机制看 `MEMORY_MECHANISM.md`；运维部署看 `AGENT_INDEX.md`；历史修改轮次、经验与剩余问题看 `MAINTENANCE_AND_CHANGELOG.md`（原 `FINAL.md`）；第一阶段问题与排障看 `ISSUES_AND_RESOLUTIONS.md`（原 `问题汇总.md`）。
>
> 阅读说明：第 1 节给使用系统的用户看；第 2 节给部署/决策的人看。修改内容轮次不在这里重复，统一看 `MAINTENANCE_AND_CHANGELOG.md`。

---

## 1. 现在实现的功能（用户视角）

### 1.1 多轮对话留痕：只记纯净的问答轮次

- 系统会记住一个 Agent 在不同会话中真实、纯净的 user/assistant 信息，过滤掉内部审批、工具调用等噪声。
- 团队成员可以查看这些问答轮次，了解某个 Agent 完整的工作过程。
- 目前已支持 Claude Code 和 Codex。
- 后续还可以基于这些纯净记录，把中转站存储的内容整理得更干净。

### 1.2 Agent 主动提交任务总结，沉淀 Skill

- Agent 会在较为恰当的时机，主动提交关于某个任务的总结。
- 这些总结用于后续 L1-L3 层记忆的沉淀和 Skill 的自动提取。
- 后台自动提取的 Skill 如果表述不理想，大家可以主动修改；修改时可以决定该 Skill 是私有还是团队共享。

### 1.3 长期记忆：chat 画像 + code 项目经验

- 长期记忆不只是 chat 模式的用户画像，还包括 code 模式的项目经验。
- Claude Code 在项目使用中积累的经验也会融合进 code 项目经验体系。
- 大家可以实时查看自己 Agent 的用户画像、项目经验等长期记忆内容。

### 1.4 跨 Agent 记忆挂载，团队内上下文复用

- 团队内的不同 Agent 可以挂载其他 Agent 的记忆；挂载需要手动分配，也可以解绑。
- 这样不同 Agent 可以复用团队内其他 Agent 的记忆，实现上下文共享。

### 1.5 团队成员互相查看上下文与长期记忆

- 团队成员可以查看自己挂载的其他 Agent 的完整对话轮次和长期记忆。
- 无论是人还是 Agent，都能了解彼此的上下文、消息轮次和长期记忆。

### 1.6 团队共享 MD 文档：按标签完成“一类文档”的交接

- 团队内可以维护共享的 MD 文档，配合标签使用；编码问题已经解决，中文内容不会再乱码。
- 团队成员之间可以用 MD 文档交流；通过一个标签，就能查看该标签下的所有 MD 文件。
- 交接的不只是一个 MD 文件，而是整个标签对应的 MD 文档集合，上下文信息更完整。

### 1.7 前端实时查看标签与文档关联

- 大家可以在前端页面实时查看文档。
- 可以通过标签查看相关 MD 文件，以及文件之间的标签连接。
- 一方面帮助梳理文件之间的联系，另一方面防止忽略已经交接的 MD 文档，让更多人了解完整上下文。

### 1.8 团队级资产注入 Agent，按需获取 + 知识图谱

- 团队级别的 MD 文档、Wiki 文档、Skill、长期记忆等，都可以注入给 Agent 使用，并且支持按需获取。
- 同时支持用知识图谱形式展示文档内容以及不同文档之间的关联，整体更清晰明了。

### 1.9 权限与隔离：团队共享、Agent 私有、手动挂载

- 已经实现权限管理：Agent 生成的内容可以共享，但只有创建者可以修改。
- 团队级别相互隔离；Agent 之间默认隔离，但可以通过手动挂载/解绑，按需实现记忆的耦合或隔离。
- 文档资源、Skill 在“团队共享 / Agent 私有”上分别做了设计实现：哪些属于团队共享、哪些属于 Agent 私有，边界和实现方式不同。

### 1.10 四种记忆模式，按需选择

- `chat`：记个人偏好、习惯、指示等用户画像。
- `code`：记工作事实、任务、方法、产出等项目经验（项目场景默认）。
- `all`：两种都记，用户画像和项目经验各沉淀一份。
- `none`：不记录、不注入，适合临时或敏感会话。

### 1.11 不同角色怎么用

| 角色 | 能做什么 |
|---|---|
| 普通成员 | 配置好代理地址和身份标识后正常使用 Agent；系统自动记录、沉淀、召回记忆；按权限读写团队笔记 |
| 管理员 | 在 Panel 维护 Team / Agent / Task、记忆资产、Team Notes，查看各层记忆沉淀 |
| 部署运维 | 按 `AGENT_INDEX.md` 在服务器独立部署三件套；数据保存在数据卷里，重启、升级、重建容器都不丢 |

### 1.12 怎么确认效果

- 打开 Panel（`http://<服务器>:8125`），可以看到当前团队/Agent 的对话记录、任务总结、长期记忆和团队笔记。
- 让 Agent 在新会话里追问“我们之前聊过什么 / 项目背景是什么”，能答上来就说明记忆注入生效。
- 团队笔记：Agent 调用 `note_create` 后，Panel 的 Team Notes 页面应立即看到新笔记。

---

## 2. 目前阶段（部署/决策者看）

### 2.1 总结论

**开发与本地验证已基本完成，当前只差部署到服务器。**

- 本机三容器 healthy，运行在从当前源码重建的三个 `:local` 镜像上。
- 本地验证通过：`MemoryProxy npx tsc --noEmit`、`MemoryCore vitest` 25/25、`MemoryKnowledge vitest` 6/6、`MemoryPanel typecheck/build` 与 `web build`。
- 镜像包 `../backups/tdai-images-local-20260827.tar.gz` 已导出；`docker save` 只含镜像层，不含本机 `.env`、`.admin-key`、volumes、SQLite 数据。

### 2.2 服务器部署

服务器首次部署尚未执行，执行时只需按 `AGENT_INDEX.md` 第 2 章操作：

1. 准备镜像包 + `../deploy/global-images/` 目录（相对仓库根目录为 `deploy/global-images/`），不拷贝本机数据。
2. 服务器 `docker load -i tdai-images-local-20260827.tar.gz`。
3. 生成服务器自己的 `.env`，确认镜像 tag、两组 LLM、`MEMORY_PROXY_PUBLIC_BASE_URL`。
4. 保持服务器模式默认值：`TDAI_DEV_SOURCE_MOUNTS=0`、`unless-stopped`、`Asia/Shanghai`。
5. `./verify.sh` 预检，`./start-all.sh` 启动，放行 8420/8125/8424/8096。

### 2.3 部署前/后的收尾事项

1. Git：功能改动仍未 commit，原仓库无 push 权限，计划推到用户自建 private 仓库。
2. 服务器部署后必须把 `MEMORY_PROXY_PUBLIC_BASE_URL` 改为服务器实际可达地址。
3. 已知但非阻断：`CREDIT_REPORT fetch failed`、`agent-fixed-asset/list-with-detail 404`、`joinUrl.fallback` warning 三类日志噪音。
4. 剩余功能待办：Claude Code WebSearch 内部请求可能污染 L0（需抓包后做通用过滤）、历史 L0 污染记录待清理、`summary_tips` 暂无删除接口等；完整列表见 `MAINTENANCE_AND_CHANGELOG.md` 第 5 节。
