# Team Notes 说明（当前最终口径）

> 注意：文档名中“Team Nodes”即“Team Notes”。

---

## 1. 定位

Team Notes 是团队内共享的轻量 Markdown 笔记库，用于保存团队级知识、纪要、方案。

它与记忆系统分离：

- Team Notes = 团队手动共享文档。
- summary_tips = 任务完成后的记忆总结。
- project/topics = 从对话自动沉淀的项目经验。

---

## 2. 功能清单

面板能力：

- 新建 / 编辑 / 归档笔记
- Markdown 正文
- 标签筛选
- 标签知识图谱
- Mermaid 视图
- Markdown 导出
- 版本记录

Agent 能力：

- 搜索、列表、读取
- 查看当前团队全部标签
- 按标签查笔记
- 新建 / 更新笔记（当前已开放写权限）

---

## 3. 数据模型

```text
team_notes
  note_id / team_id / seq_no / title / content_md / version / status

team_note_tags
  note_id / tag_slug / tag_label

team_note_revisions
  revision_id / note_id / version / content_md / edited_by
```

要点：

- SQLite 为唯一真相，不做 DB/文件双写。
- 更新必须传 `expected_version`，否则 409。
- 删除是软归档。
- 标签按 slug 归一化。
- 图谱节点：note 与 tag；边：note-has_tag。

---

## 4. 接口

### 4.1 Knowledge 直连

```text
POST http://localhost:8424/v3/notes/*
```

子路径：

```text
create / get / list / update / delete / search
tags/list / tags/pages
graph / graph/mermaid
revisions / export
```

### 4.2 Panel 管理 API

```text
POST http://localhost:8125/api/v1/notes/*
```

所有端点要求 team member。

### 4.3 Agent bridge

```text
POST http://localhost:8096/notes-bridge/v3/notes/*
```

Proxy 自动注入 team/user/agent 身份。

写路径编码校验（只对 `create|update|delete` 生效）：

- 先读原始字节，严格 UTF-8 解码；
- UTF-8 通过但 JSON 含 `U+FFFD` → `42201`；
- UTF-8 失败但 GB18030 可解码 → `42202`（返回 GB18030 解码预览，不落库）；
- 两种都失败 → `42203`；
- 系统不会服务端转码后落库，Agent 必须用 UTF-8 JSON 文件 + `curl --data-binary @file` 重发。

当前注入给 Agent 的工具：

```text
note_search
note_list
note_get
note_tags_list      ← 查看当前团队全部标签
note_tags_pages
note_create          ← 已开放
note_update          ← 已开放
```

### 4.4 写路径编码错误码速查

| 错误码 | 含义 | 处理 |
|---|---|---|
| `42201` | 严格 UTF-8 解码成功，但 JSON 文本里已有 `U+FFFD` | 拒绝入库 |
| `42202` | UTF-8 严格解码失败，但 GB18030 可解码 | 拒绝入库；响应和日志带 GB18030 预览；**不服务端转码** |
| `42203` | UTF-8 和 GB18030 都失败 | 拒绝入库 |

统一要求：Agent 必须把 JSON 写成 UTF-8 文件，再用：

```bash
curl --data-binary @payload.json
```

发送；不要用 Windows Git Bash 的 `curl -d` 直接内联中文。

---

## 5. 写权限开关

配置：

```env
MEMORY_NOTES_ALLOW_LLM_WRITE=true
```

生成到 proxy config：

```yaml
knowledge:
  allowLlmWrite: true
```

关闭后 Agent 只能读取，不能创建/更新。

---

## 6. 当前已修复 / 已知经验

- Sigma 图谱 `note` 节点类型报错已修复。
- Agent 注入了明确的 Team Notes 工具说明。
- `note_tags_list` 说明已强化：“查看当前团队全部标签”。
- 明确了 Team Notes 与 summary_tips 的区别。
- Agent 写入增加 UTF-8/回读校验提醒和 `note_delete` 说明。
- 中文乱码问题已上原始字节编码校验（42201/42202/42203），不再只依赖解析后的 `U+FFFD`。
- 历史乱码笔记 `note-79ut1azx`：version 1 乱码、version 2 已正常；旧 revision 是否保留仍待用户决定。

---

## 7. 核心文件

- `MemoryKnowledge/src/store/team-notes-service.ts`
- `MemoryKnowledge/src/routes/notes.ts`
- `MemoryPanel/src/panel/http/routes/notes.ts`
- `MemoryPanel/web/src/pages/notes/NotesPage/`
- `MemoryProxy/src/notes-bridge.ts`
- `MemoryProxy/src/common/request-body-encoding.ts`（原始字节编码识别）
- `MemoryProxy/src/injection/injectors/note-tools-injector.ts`
- `deploy/global-images/start-proxy.sh`（allowLlmWrite 生成）
- `deploy/global-images/.env`（MEMORY_NOTES_ALLOW_LLM_WRITE）

---

## 8. 验证方法

1. 面板：
   - Team Notes 菜单可见
   - 新建笔记、打标签
   - 切换图谱和 Mermaid
2. Agent：
   - system prompt 应出现 `<note_tools>`
   - 让 Agent 调用 `note_tags_list`，应返回当前团队全部标签
   - 让 Agent 用 `note_create` 新建笔记
   - 面板能立即看到新笔记
