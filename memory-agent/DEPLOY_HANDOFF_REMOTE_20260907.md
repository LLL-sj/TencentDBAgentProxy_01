You are a helpful software engineer assistant. When you think, think in English, start with "We need..."

请先阅读以下文件并理解背景，再开始执行：

- `memory-agent/AGENT_INDEX.md`
- `memory-agent/NEW_AGENT_HANDOFF12.md`
- `memory-agent/REPORT_L0_SESSION_AND_MEMORY_CRUD_CDE_20260907.md`
- `memory-agent/HANDOFF_SKILL_PERMISSION_MODEL_20260907.md`
- `memory-agent/HANDOFF_TIMING_STATISTICS_20260907.md`

工作目录为 `/home/luuu/Desktop/TencentDB-Agent-Memory`。

---

## 任务

检查本地当前源码/镜像状态，并将 A–E 阶段的最新镜像部署到远程服务器。

当前已知状态：
- 本地代码已提交并推送：`origin/feat/server_team`
- 本地三个镜像已构建并运行 healthy：
  - `agentmemory/memory-core:local`
  - `agentmemory/memory-hub:local`
  - `agentmemory/memory-proxy:local`
- 远程服务器仍可能运行旧镜像，本次目标是把远程同步到最新本地镜像。
- 远程部署前先检查远程当前状态，避免直接覆盖重要配置。

---

## 远程服务器信息

```text
Host:     8.133.220.36
User:     root
Port:     22
SSH Key:  ~/.ssh/id_ed25519
```

远程常用路径：

```text
/root/tdai-memory/deploy/global-images/   # 部署脚本与 .env
/root/tdai-memory/images/                 # 镜像 tar.gz 目录
```

常用登录：

```bash
ssh -i ~/.ssh/id_ed25519 root@8.133.220.36
```

---

## 执行前检查

1. 查看本地 Git 状态与远端是否一致：
   ```bash
   cd /home/luuu/Desktop/TencentDB-Agent-Memory
   git status --short
   git fetch origin
   git log --oneline origin/feat/server_team -5
   ```
2. 查看本地三镜像是否是最新构建：
   ```bash
   docker images --format '{{.Repository}}:{{.Tag}} {{.ID}} {{.CreatedSince}}' | grep 'agentmemory/'
   ```
3. 如果本地镜像不是最新，先重新构建：
   ```bash
   docker build -t agentmemory/memory-core:local MemoryCore
   docker build -t agentmemory/memory-proxy:local MemoryProxy
   # hub 镜像使用 deploy/panel-knowledge-combined/build.sh
   cd deploy/panel-knowledge-combined
   IMAGE_NAME=agentmemory/memory-hub IMAGE_TAG=local ./build.sh
   ```

---

## 本地验证

部署前至少跑一遍：

```bash
cd /home/luuu/Desktop/TencentDB-Agent-Memory/MemoryCore
npm run build:plugin
npx vitest run

cd ../MemoryPanel
npm run typecheck

cd web
npx tsc --noEmit

cd ../../MemoryProxy
npx tsc --noEmit
```

如有失败先修复/报告，不要带病部署。

---

## 导出镜像包

```bash
cd /home/luuu/Desktop/TencentDB-Agent-Memory
mkdir -p backups
docker save \
  agentmemory/memory-core:local \
  agentmemory/memory-hub:local \
  agentmemory/memory-proxy:local \
  | gzip > backups/tdai-images-local-20260907-cde.tar.gz
```

---

## 上传到服务器

```bash
scp -i ~/.ssh/id_ed25519 \
  backups/tdai-images-local-20260907-cde.tar.gz \
  root@8.133.220.36:/root/tdai-memory/images/
```

---

## 远程加载与启动

登录服务器后执行：

```bash
ssh -i ~/.ssh/id_ed25519 root@8.133.220.36

cd /root/tdai-memory/images
docker load -i tdai-images-local-20260907-cde.tar.gz

cd /root/tdai-memory/deploy/global-images
./start-all.sh
```

如果只需要单个服务，也可以单独：

```bash
./start-memory-core.sh
./start-memory-hub.sh
./start-proxy.sh
```

注意：
- `start-all.sh` 或单个 start 脚本会移除旧容器并用当前 `.env` 重建；
- 数据卷保持不变；
- 远程 `.env` 不要随意修改；
- 不要泄漏 `.admin-key`、API Key、SSH Key。

---

## 远程验证

启动后至少验证：

```bash
docker ps | grep -E 'tdai-memory-core|tdai-memory-hub|tdai-proxy'

curl -fsS http://localhost:28420/health   # core
curl -fsS http://localhost:28125/health   # hub/panel
curl -fsS http://localhost:28424/health   # knowledge
curl -fsS http://localhost:28096/health   # proxy
```

再抽查核心接口是否是新版本：
- Panel 的 Code Memory L2 能看到 topic 编辑/删除；
- `/v3/project/write|rm` 不再 404；
- 如果面板调用仍报“内核服务不可用”，优先检查 `tdai-memory-core` 是否加载了新镜像。

---

## 已知问题与约束

1. 本次只负责检查/部署，不要顺手实现未确认的产品改动。
2. Skill 权限模型只做现状整理，未做产品变更；如发现 Skill UI 对非 owner 显示编辑按钮，只记录，不擅自修改。
3. 服务器部署后如业务侧需要验证 Agent 写能力，再单独测试 memory-bridge。
4. 部署完成后输出报告，列出：
   - 远程部署前状态；
   - 执行的构建/上传/启动命令；
   - 远程容器镜像 ID；
   - 健康检查与接口抽查结果；
   - 尚未完成/异常事项。
