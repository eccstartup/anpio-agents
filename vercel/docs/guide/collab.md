---
title: Collab 调用
description: 把控制面交给 anpio-collab：supervisor、平台消息来源与 ANP router。
---

# Collab 调用：接入 anpio-collab

Collab 调用把控制面交给 `anpio-collab`：平台保存定义、创建运行、投递消息、记录日志与结果。执行引擎仍然在运行它的机器上，模型密钥也只在那边。

适合多 agent 协作、任务分发、统一审计，以及从控制台手动触发运行。

## 三种接入方式

| 方式 | 谁发起消息 | 适合 |
| --- | --- | --- |
| supervisor（`npm run runtime`） | 平台队列 / 控制台 / 外部 Agent | 平台托管的批量任务，一个定义一个 worker |
| 平台消息来源（`anpio-agents` + `sources.platform`） | 平台信箱 | 常驻对话智能体，同时接收平台任务 |
| ANP router（`npm run router`） | ANP 消息 / 管理接口 / 定时任务 | 多个 agent 在同一进程内互相派活、长期 thread |

::: warning 不要重复订阅
同一个平台 agent 不要同时用 supervisor 和 `anpio-agents` 订阅消息，否则两边会抢消息、重复执行。
:::

## 1. supervisor

supervisor 常驻但不加载模型。每个定义对应一个 `node src/agent-worker.ts` 子进程，由它按需拉起并复用。worker 内部按定义的 `concurrency` 并发跑 Session。

```bash
COLLAB_BASE_URL=http://127.0.0.1:8787 \
COLLAB_RUNTIME_TOKEN=$COLLAB_BOOTSTRAP_TOKEN \
COLLAB_EMBEDDED_SECRET=... \
npm run runtime
```

| 参数 | 说明 |
| --- | --- |
| `--once` | 扫描一轮、等本轮运行结束、退出；适合 cron 与调试 |
| `--agent <agentId>` | 只处理一个定义 |

```bash
npm run runtime -- --once
npm run runtime -- --once --agent worker-1
```

supervisor 做的事：

- 每 `COLLAB_RUNTIME_TICK_MS` 扫一次定义列表，`enabled=false` 的不叫醒。
- 有未读就建运行并下发；同一 agent 受 `concurrency` 限制，全局受 `COLLAB_RUNTIME_CONCURRENCY` 限制。
- 定期上报心跳，并调用平台的 `recover` 把心跳停滞的运行标成 `outcome_unknown`。
- 接管控制台“立即运行”建出、还没有心跳的运行。
- worker 退出或被杀时，为它名下未结束的运行补结论：已开始记为 `outcome_unknown`，未开始记为 `failed`。
- 设了 `COLLAB_AGENTS_FILE` 时，启动时按名称 upsert 定义。
- `SIGTERM` / `SIGINT` 后停止接活、等待收尾，未完成的消息退回队列。

常用环境变量：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `COLLAB_BASE_URL` | `http://127.0.0.1:8787` | 平台地址 |
| `COLLAB_RUNTIME_TOKEN` | 无 | 管理员令牌，需要 `admin`；不会传给 worker |
| `COLLAB_EMBEDDED_SECRET` | 无 | 派生内置智能体令牌，必须与平台一致 |
| `COLLAB_RUNTIME_TICK_MS` | `3000` | 扫描间隔，最小 200 |
| `COLLAB_RUNTIME_CONCURRENCY` | `2` | 全局同时进行的 Session 数 |
| `COLLAB_AGENT_IDLE_MS` | `60000` | worker 空闲多久退出；`0` 表示不退出 |
| `COLLAB_WORKER_GRACE_MS` | `20000` | 退出信号后等待收尾的时间 |
| `COLLAB_ORPHAN_TTL_MS` | `86400000` | 回收残留 Session 目录的阈值 |
| `COLLAB_HEALTH_FILE` | 无 | 写 JSON 健康快照，供探针读取 |
| `COLLAB_AGENTS_FILE` | 无 | 启动时同步的定义文件 |
| `COLLAB_RUN_ROOT` | `./collab-runs` | 运行目录根 |
| `COLLAB_KEEP_RUN` | `0` | `1` 保留运行目录 |
| `COLLAB_SANDBOX_EXEC` | `0` | `1` 在 macOS 再用 `sandbox-exec` 包一层 |

模型密钥只写变量名，值由运行 supervisor 的机器提供；平台数据库只存名字。

## 2. 平台消息来源

想让一个常驻对话智能体同时接收平台消息，在定义的 `sources.platform` 里启用即可：

```json
{
  "sources": {
    "stdin": { "enabled": true },
    "platform": {
      "enabled": true,
      "baseUrl": "http://127.0.0.1:8787",
      "agentId": "worker-1",
      "adminTokenEnv": "COLLAB_RUNTIME_TOKEN",
      "secretEnv": "COLLAB_EMBEDDED_SECRET",
      "pollMs": 3000
    }
  }
}
```

```bash
COLLAB_RUNTIME_TOKEN=... COLLAB_EMBEDDED_SECRET=... \
  ANTHROPIC_API_KEY=... anpio-agents --agent examples/local-chat.json
```

- 只接受环境变量名；`adminToken` / `secret` 这类明文字段会直接报错。
- 平台来源先用管理员令牌 `ensure` agent，再用 `deriveEmbeddedToken` 得到的派生令牌打开长期信箱会话。
- 会话过期会自动重建；本地 `message_id` 去重保证不丢不重。
- 平台来源不调用 `embedded/agents/import`，也不创建 platform run；任务动作仍由平台工具完成。
- `--no-platform` 可以临时不连平台。

## 3. ANP router

`npm run router` 启动一个常驻进程，进程内托管多个 ANP agent。每个 agent 有自己的 DID、数据库、workspace 与长期 thread session；router 内嵌 ANP 消息服务、DID 文档、ADP 与发现索引，另外开放管理接口。

```text
router 进程
├─ ANP 服务 127.0.0.1:8787   /anp-im/rpc、/.well-known/anp-message-service.json
├─ DID 服务 127.0.0.1:8788   /agents/<id>/<fp>/did.json、.well-known/agent-descriptions
│                            /admin/*、/health
└─ AgentHost × N
   ├─ agents/<id>/agent.db
   ├─ agents/<id>/workspace/threads/<threadId>/
   └─ AgentRuntime → 模型循环
```

示例配置里有两个脚本 agent：`planner` 收到消息后把任务派给 `worker`，`worker` 清点 workspace、写结果并回复。整个过程不发网络请求、不需要密钥。

```bash
npm run router -- --config examples/anp/router.local.json

curl -s http://127.0.0.1:8788/health
npm run anp:send -- --from planner --to worker --thread t1 --text "把这份目录整理成清单"
```

常用能力：

- 协作工具：`anp_send`、`anp_reply`、`anp_list_messages`、`anp_get_message`、`list_agents`、`agent_status`、`finish_turn`。
- 记忆与经验：`memory_*`、`session_*`、`knowledge_*` 在三种运行方式下都由引擎提供，见[记忆与会话](/guide/memory)。
- 定时任务：`anp.allowSchedules` 打开后可用 `schedule_create` / `schedule_cancel` / `list_schedules`，支持 `at`、`interval`、`cron`。
- 子 agent：父定义 `anp.allowSpawn=true` 时可创建子 agent，工具只能从父收缩，默认深度 2、每个父最多 3 个。
- 联网：`anp.network` 为 `none` / `egress` / `open`；默认 `egress` 且 allowlist 为空，即不能用 `http_fetch`。
- 工具可用性等于定义 `tools` 与 router 提供工具的交集；缺失的工具在启动时直接报错。

### 隔离级别

| `anp.isolation` | 模型循环 / 数据库 | `shell` 与文件工具 |
| --- | --- | --- |
| `inline` | router 进程 | router 进程，仅路径与环境清洗 |
| `process` | router 进程 | 目前同样在 router 进程内（保留值） |
| `container` | router 进程 | 每轮一个 Docker 容器，经 `docker exec` 执行 |

容器模式只隔离工具执行，不隔离模型推理：DID 私钥、模型密钥、平台令牌都在主机侧。容器默认 `--network none`、`--read-only`、`no-new-privileges`、`cap-drop ALL`，只挂载当前 thread 的 workspace。

```bash
container/build.sh
# 输出 anp-toolbox:latest
```

## 消息与确认

```text
建运行记录 → Session 目录 <runRoot>/<agentId>/sessions/<runId>（0700）
  → 开信箱会话，拉信封 → 取正文
  → 写 AGENTS.md（任务、验收条件、消息）
  → 模型循环（最多 maxTurns）→ 调用工具
  → ack / nack 消息 → 提交结果 → finish
  → 删除 Session 目录（COLLAB_KEEP_RUN=1 时保留），agent 工作根保留
```

- 一轮只有拿到结束信号才 ack；失败或中断会 nack，消息退回来源与本地队列。
- 同一 thread 同时只跑一轮；不同 thread 并行，受 `concurrency` 限制。
- 写请求“结果未知”时本轮停止，并以 `outcome_unknown` 收尾，不会假装成功。
- 平台只存定义，不同步本地文件；平台任务的产品通过平台工具发送。

## 平台工具

| 工具 | 作用 |
| --- | --- |
| `task_get` / `subtask_inbox` | 读任务与待办子任务 |
| `task_accept` / `task_progress` / `task_submit` / `subtask_reject` | 推进子任务 |
| `task_comment` / `task_comments` | 任务评论 |
| `offer_list` / `offer_claim` | 开放池子任务 |
| `task_files` / `file_download` / `file_upload` | 任务空间文件 |
| `knowledge_search` | 检索可读经验 |

工具白名单来自定义里的 `tools`。启用工具所需的范围由平台自动补齐，例如 `offer_claim` 对应 `offers:claim`，`file_upload` 对应 `tasks:submit`。

## 权限与密钥

- `COLLAB_RUNTIME_TOKEN` 是管理员令牌，只给 supervisor / 平台来源的管理调用，不会传给 worker。
- `COLLAB_EMBEDDED_SECRET` 用于派生每个 agent 的令牌；两端必须一致，否则 worker 401。
- 平台路径只接受 `provider.apiKeyEnv` 的变量名。`apiKey` / `apiKeyFile` 是本地定义文件专用，不会进入平台。
- 平台来源和 supervisor 都用派生令牌打开信箱，不把管理员令牌暴露给模型循环。

## 与自运行的区别

| | 自运行 | Collab |
| --- | --- | --- |
| 线程存储 | 本地 SQLite | 本地 SQLite + 平台运行记录 |
| 消息确认 | 本地队列 | 平台信箱 ack / nack |
| 工具后端 | 仅本地原语 | 本地原语 + 平台工具 |
| 运行触发 | 命令行、stdin、HTTP | 平台队列、控制台、外部 Agent |
| 失败可见性 | 退出码、本地日志 | 运行状态、心跳、`recover`、健康快照 |

## 上线检查清单

- 平台版本包含内嵌智能体接口（`embedded/agents`、`embedded/runs`、信箱）。
- supervisor 机器已导出 `COLLAB_BASE_URL`、`COLLAB_RUNTIME_TOKEN`、`COLLAB_EMBEDDED_SECRET`。
- 模型密钥变量名与定义一致，且只在运行机器上存在。
- 同一个 agent 只由一个 supervisor 或一个 `anpio-agents` 订阅。
- 需要断网时使用容器隔离，并确认 `container/build.sh` 已构建镜像。
- 用 `COLLAB_HEALTH_FILE` 或 `GET /health` 接探针；心跳停滞的运行会被标成 `outcome_unknown`。
- 定义里的工具没有超出平台能力；缺失工具会让 worker 启动失败，而不是静默降级。
