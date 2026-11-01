# anpio-agents

[anpio-collab](https://github.com/eccstartup/anpio-collab) 的**执行引擎**：平台的 supervisor、常驻 agent worker、工具层、沙箱与模型协议适配器。

平台负责“定义、身份、运行记录”，这里负责“真的跑一轮”。两边只通过 HTTP 接口相连，不共享数据库。

```text
anpio-collab（控制面）                 anpio-agents（执行引擎）
定义校验 / 派生令牌 / 运行记录  ←HTTP→  supervisor 常驻，按定义拉起 worker
控制台 / 保留期回收                       └─ agent-worker：一个定义一个进程
                                             └─ Session × N：信箱 → 模型循环 → 工具 → ack → finish
```

不启动 supervisor 时，平台照常工作，只是内嵌 Agent 不会被执行。

## 三层结构

- **supervisor**（`src/supervisor.ts`）：发现定义、创建运行、全局并发、心跳、`recover`、运行生命周期与日志前缀；不加载模型，也不持有运行上下文。
- **AgentRuntime**（`src/runtime/agent.ts`）：一个定义的执行身份——派生令牌、模型适配器、工具清单、agent 工作根与并发信号量；跨 Session 常驻。
- **Session**（`src/runtime/session.ts`）：一次运行的可并发上下文——自己的信箱会话、消息、目录、deadline、中断信号与 token 统计。Session 之间不共享可变状态，一个失败不影响同 agent 的另一个。

空闲超过 `COLLAB_AGENT_IDLE_MS` 后 worker 自行退出，supervisor 下次有活再拉起；定义变更时 supervisor 会在 worker 空闲后重建它。

## Session 隔离级别

定义里可以用 `sessionIsolation` 选择 Session 的执行方式：

```json
{ "sessionIsolation": "process" }
```

- `inline`（缺省）：Session 在 `agent-worker` 进程内并发，最省资源，保持既有行为。
- `process`：worker 为每个 Session 拉起一个 `src/session.ts` 子进程，连接信息与派生令牌仍走 stdin，不进入环境变量。子进程跑的是同一套 `AgentSession`，所以独立目录、ack/nack、`finish`、中断后退回消息的语义与 inline 完全一致；worker 负责转发子进程的 stderr、汇总 `session-end`，并在超时或中断时杀掉整个进程组。子进程在没有交出结果的情况下退出时，该运行按 `outcome_unknown` 收尾，已拉取的消息带长退避退回队列。

两种模式只改这一个字段，`concurrency` 的含义不变。进程隔离能挡住单个 Session 崩溃或挂死对同 agent 其它 Session 的影响，但模型密钥与派生令牌仍在子进程内存里；需要更强隔离时仍应把整套服务放进容器或独立用户下运行。进程模式每次运行多一次 Node 启动开销，适合工具副作用较重、值得隔离的定义。

## 要求

- Node.js ≥ 22.18（直接运行 TypeScript，无需构建）
- 能访问平台的 HTTP 接口
- 平台侧设置了 `COLLAB_EMBEDDED_SECRET`，且与本仓库运行环境一致

## 安装

```bash
git clone https://github.com/eccstartup/anpio-agents
cd anpio-agents
npm install
```

## 运行 supervisor

```bash
COLLAB_BASE_URL=http://127.0.0.1:8787 \
COLLAB_RUNTIME_TOKEN=$COLLAB_BOOTSTRAP_TOKEN \
COLLAB_EMBEDDED_SECRET=... \
npm run runtime
```

- `--once`：扫描一轮、等本轮运行结束、退出；适合 cron 与调试。
- `--agent <agentId>`：只处理一个定义。

```bash
npm run runtime -- --once
npm run runtime -- --once --agent <agentId>
```

也可以单独跑一次 session（调试用），supervisor 会通过 stdin 传入 `baseUrl`、派生令牌、`runId`、`agentId` 与 `definition`：

```bash
echo '{"baseUrl":"http://127.0.0.1:8787","token":"...","runId":"...","agentId":"...","definition":{...}}' \
  | npm run session
```

`npm run worker` 对应的 `src/agent-worker.ts` 由 supervisor 用 stdin 配置拉起，通常不需要单独运行。

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `COLLAB_BASE_URL` | `http://127.0.0.1:8787` | 平台地址 |
| `COLLAB_RUNTIME_TOKEN` | 无 | 管理员令牌，用于拉定义、起运行；需要 `admin`，不会传给 worker |
| `COLLAB_EMBEDDED_SECRET` | 无 | 派生内置智能体令牌，必须与平台一致 |
| `COLLAB_RUNTIME_TICK_MS` | `3000` | 扫描间隔，最小 200 |
| `COLLAB_RUNTIME_CONCURRENCY` | `2` | 全局同时进行的 Session 数 |
| `COLLAB_AGENT_IDLE_MS` | `60000` | worker 空闲多久自行退出；`0` 表示不退出 |
| `COLLAB_WORKER_GRACE_MS` | `20000` | 退出信号后等待运行收尾的时间，之后中断剩余 Session |
| `COLLAB_ORPHAN_TTL_MS` | `86400000` | 启动时回收超过此时长的残留 Session 目录 |
| `COLLAB_HEALTH_FILE` | 无 | 写一个 JSON 健康快照，供外部探针读取 |
| `COLLAB_AGENTS_FILE` | 无 | 启动时同步的定义文件，见 `examples/agents.json` |
| `COLLAB_RUN_ROOT` | `./collab-runs` | 运行目录根 |
| `COLLAB_KEEP_RUN` | `0` | `1` 保留运行目录，便于排查 |
| `COLLAB_SANDBOX_EXEC` | `0` | `1` 在 macOS 用 `sandbox-exec` 再包一层 |

模型密钥只写**环境变量名**（如 `ANTHROPIC_API_KEY`），值由运行 supervisor 的机器提供；平台数据库只存名字。

### supervisor 做什么

- 每 `COLLAB_RUNTIME_TICK_MS` 扫一次定义列表，`enabled=false` 的不叫醒；
- 每个定义最多一个 `node src/agent-worker.ts` 子进程，跑完后常驻复用；
- 有未读就建运行并下发；同一 agent 的并发受 `concurrency` 限制，全局受 `COLLAB_RUNTIME_CONCURRENCY` 限制（按 Session 计）；
- 定期上报 supervisor 心跳，并调用平台的 `recover` 把心跳停滞的运行标成 `outcome_unknown`；
- 接管控制台“立即运行”建出的、还没有心跳的运行；
- worker 退出或被杀时，为它名下所有未结束的运行补一条结论（已开始 → `outcome_unknown`，未开始 → `failed`）；
- 启动时若设了 `COLLAB_AGENTS_FILE`，按名称 upsert 定义；
- 启动时清理超过 `COLLAB_ORPHAN_TTL_MS` 的 Session 目录；`SIGTERM` / `SIGINT` 后停止接活、等待收尾，未完成的运行会把消息退回队列。

## 一次运行

```text
建运行记录 → Session 目录 <runRoot>/<agentId>/sessions/<runId>（0700）
  → 开信箱会话，拉信封 → 取正文
  → 写 AGENTS.md（任务、验收条件、消息）
  → 模型循环（最多 maxTurns）→ 调用工具
  → ack / nack 消息 → 提交结果 → finish
  → 删除 Session 目录（COLLAB_KEEP_RUN=1 时保留），agent 工作根保留
```

退出码：`0` 成功；`2` 结果未知（`outcome_unknown`）；其他失败。超时由 `limits.timeoutMs` 控制，到点中止本轮并标记超时；被中断的运行记为 `failed`，未确认的消息退回队列。

## 工具：与外部 Agent 同一套能力

外部 Agent 用 SDK / HTTP 能做的事，内嵌 Agent 用同名工具做；两条路径打到同一组平台接口、同一套授权范围。

| 工具 | 作用 | 对应接口 |
| --- | --- | --- |
| `task_get` | 读任务详情 | `GET /v1/tasks/:id` |
| `subtask_inbox` | 我的待办子任务 | `GET /v1/inbox` |
| `task_accept` | 接受子任务 | `POST /v1/subtasks/:id/accept` |
| `task_progress` | 上报进展 | `POST /v1/subtasks/:id/progress` |
| `task_submit` | 提交结构化结果 | `POST /v1/subtasks/:id/submit` |
| `subtask_reject` | 拒绝子任务并说明原因 | `POST /v1/subtasks/:id/reject` |
| `task_comment` | 写评论 | `POST /v1/tasks/:id/comments` |
| `task_comments` | 读评论流 | `GET /v1/tasks/:id/comments` |
| `offer_list` | 与我能力匹配的开放池子任务 | `GET /v1/offers` |
| `offer_claim` | 认领开放池子任务 | `POST /v1/offers/:id/claim` |
| `task_files` | 任务空间文件列表 | `GET /v1/tasks/:id/files` |
| `file_download` | 下载文件到运行目录 | `GET /v1/tasks/:id/files/:fileId` |
| `file_upload` | 上传运行目录文件（≤256 KiB） | `POST /v1/tasks/:id/files` |
| `knowledge_search` | 检索可读经验 | `GET /v1/knowledge/search` |
| `shell` | 执行 shell | 仅执行引擎提供 |
| `read_file` / `write_file` / `list_files` | 运行目录读写 | 仅执行引擎提供 |
| `finish` | 结束本轮并给出摘要 | 仅执行引擎提供 |

工具白名单来自定义里的 `tools`；不含 `finish` 时平台会自动补上。启用工具所需的范围由平台自动补齐（如 `offer_claim` → `offers:claim`、`file_upload` → `tasks:submit`）。工具失败以文本回到模型，只有“写请求结果未知”会中止本轮并以 `outcome_unknown` 收尾。

## 模型协议

| 协议 | 用途 |
| --- | --- |
| `openai-chat` | OpenAI Chat Completions 兼容接口 |
| `openai-responses` | OpenAI Responses |
| `anthropic-messages` | Anthropic Messages |
| `gemini-generate` | Gemini generateContent |
| `workers-ai` | Cloudflare Workers AI |
| `decision-jev` | Decision JEV |
| `gemini-interactions` / `subscription-cli` | 预留协议位，未安装或未实现时明确报错 |
| `script` | 确定性脚本，不调用模型，适合演示与验证 |

适配器只依赖注入的 `fetch`，测试里用本地 mock 断言 URL、鉴权头与工具调用解析，不发真实请求。

## 沙箱

- 每个 Session 一个 `0700` 目录，路径不能跳出、拒绝符号链接；
- shell 的 `HOME` / `TMPDIR` 指向 Session 目录，环境里没有平台令牌与模型密钥；
- 超时杀整个进程组，stdout/stderr 按上限截断；
- 启动时回收超过 `COLLAB_ORPHAN_TTL_MS` 的残留 Session 目录，刚创建的不动；
- `COLLAB_SANDBOX_EXEC=1` 时在 macOS 上额外用 `sandbox-exec`（默认拒绝网络，只允许写 Session 目录）。

这是“防误伤”，不是容器级隔离。需要强隔离时，把 supervisor 放进容器或独立用户下运行，并限制网络出口。

## 测试

```bash
npm test
npm run check
```

- `tests/runtime.test.ts`：同一 AgentRuntime 顺序 / 并发跑多个 Session，目录、信箱与并发上限；
- `tests/worker.test.ts`：跨进程验证一个 worker 并发跑两个 Session、一个失败不影响另一个，以及 SIGTERM 后的收尾与消息退回；`sessionIsolation: 'process'` 下同样的并发用例换到两个 Session 子进程里跑，另含子进程 SIGTERM 中断与崩溃（`outcome_unknown`）的用例；
- `tests/supervisor.test.ts`：跨进程跑一个 script 智能体，验证接活、提交、ack、收尾与目录回收；
- `tests/tools.test.ts`：工具层与外部 Agent 的接口对齐（待办、拒绝、评论、开放池、文件）；
- `tests/brains.test.ts`：各模型协议的请求形状与工具调用解析；
- `tests/sandbox.test.ts`：路径边界、环境清洗、超时、截断与过期目录回收。

## 故障排查

**提示需要 `COLLAB_RUNTIME_TOKEN`**：supervisor 用管理员令牌调平台接口，不能用派生令牌代替。

**worker 401**：两端的 `COLLAB_EMBEDDED_SECRET` 不一致，或平台没设。

**运行记录一直 `running`**：看 supervisor 是否在跑、日志里有没有 `▶` / `■`；心跳停滞的运行会被 `recover` 标成 `outcome_unknown`，消息退回队列。设了 `COLLAB_HEALTH_FILE` 时可以直接读快照看各 worker 的 `ready` / `sessions` / `pending`。

**worker 反复重启**：看 stderr 里带 `[名称]` 前缀的诊断；定义变更会触发重建，异常退出会先补完运行结论再重新拉起。

**控制台“立即运行”没动静**：控制台只建运行记录，需要有一个启用的 supervisor 连着同一平台。

## 相关文档

- [行动计划](docs/action-plan.md)：从「一次运行一个进程」到「常驻 Agent 承载多 Session」，已完成
- [独立运行方案](docs/standalone-plan.md)：把控制面抽成端口，让同一个执行引擎可以脱离 anpio-collab 单独运行，并为任意触发/工具接口预留扩展点
- [平台内嵌 Agent](https://github.com/eccstartup/anpio-collab/blob/master/vercel/docs/guide/embedded-agent.md)：定义字段、管理接口、身份与授权
- [anpio-collab](https://github.com/eccstartup/anpio-collab)：控制面与协作协议
