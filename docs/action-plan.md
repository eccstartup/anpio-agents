# 行动计划：从「一次运行一个进程」到「常驻 Agent 承载多 Session」

- 状态：待评审
- 日期：2026-11-01
- 范围：`anpio-agents` 执行引擎（不含 anpio-collab 控制面）
- 参考实现：`/Users/eccstartup/code/claude/dsh-superagent-prototype`（见第 8 节）
- 新 session 开工清单：见第 9 节

## 0. 判断

当前代码不需要推倒重来。`client.ts`、`brains/*`、`tools.ts`、`sandbox.ts`、`token.ts`、`definition.ts`
约 1.6k 行是无状态、边界清楚的适配层，保留。

真正卡住目标的是进程模型：现在 agent ↔ 子进程 ↔ 一次 run ↔ 一个 mail session 是 **1:1:1:1**。

- `supervisor.ts:92` 的 `children` 以 `agent.id` 为 key，同一 agent 同时只能有一个子进程；
  `supervisor.ts:148` 直接 `continue`。
- 定义里的 `concurrency` 字段没有被读取，只存在于 `definition.ts` 和示例配置里。
- 每个 run 新建一个 mail session（`session.ts:167`，`run:<runId>`），运行结束即关闭。
- 工作目录按 run 创建并在结束时删除（`supervisor.ts:203`、`sandbox.ts:32`），没有 agent 级持久化。

结论：需要重构的是 `supervisor` 与 `session` 的进程/生命周期模型，不是协议适配层。

## 1. 目标分解：三层，各自持有不同的东西

| 层 | 进程/对象 | 生命周期 | 持有 | 不持有 |
|---|---|---|---|---|
| **Supervisor** 调度面 | 每台机器 1 个 | 常驻 | 定义发现、放置、全局并发、心跳、recover、日志转发 | 模型密钥、对话上下文、工作目录 |
| **AgentRuntime** 智能体面 | 每个定义 1 个，按需拉起 | 常驻，空闲 TTL 回收 | 派生身份、Brain、工具策略、并发配额、agent 级工作根 | 单次对话状态 |
| **Session** 会话面 | 每个 run 1 个，进程内并发 | 一次运行 | mail session、消息历史、独立目录、deadline、预算、abort | 别的 Session 的任何状态 |

目标形态：AgentRuntime 是**有身份、有资源、有配额**的常驻体，Session 是它身上可并发的**轻量上下文**。
“同一个 agent 承载不同 Session”由此成立。

## 2. 资源归属矩阵

| 资源 | 归属层 | 生命周期 | 隔离方式 |
|---|---|---|---|
| 模型 API Key | 宿主机环境变量 → AgentRuntime 解析 | agent 级 | 只存在 AgentRuntime 进程内；shell 孙进程环境已清洗 |
| 平台令牌 | AgentRuntime（HMAC 派生） | agent 级 | 进程内引用，进程隔离模式下仍可走 stdin |
| CollabClient / Brain | AgentRuntime | agent 级，可复用 | 会话间共享（无状态） |
| 工具定义（specs） | AgentRuntime | agent 级 | 执行时绑定 Session |
| 工作根 `runRoot/<agentId>/` | AgentRuntime | agent 级 | 目录权限 0700 |
| Session 工作目录 | Session | 一次运行 | 每 Session 独立子目录 |
| mail session | Session | 一次运行 | 独立 |
| 对话历史 / token 预算 | Session | 一次运行 | 独立 |
| 并发配额 | Supervisor（全局）+ AgentRuntime（`definition.concurrency`） | — | 信号量 |
| 心跳 | Supervisor + 每个 run | — | — |

原则：**能复用且无状态的下沉到 agent 级；有状态、有预算、会失败的上浮到 session 级。**

## 3. 进程与部署形态

```text
                 ┌────────── Supervisor（每主机 1 个）──────────┐
  平台 HTTP ◄────┤ 发现 / 放置 / 全局并发 / recover / 日志转发  │
                 └──────┬──────────────────────────┬────────────┘
                        │ 按需 spawn                │
                ┌───────▼────────┐         ┌───────▼────────┐
                │ AgentRuntime A │         │ AgentRuntime B │   常驻，1/定义
                │ 身份/Brain/策略 │         │                │
                │ ┌────────────┐ │         └────────────────┘
                │ │ Session 1  │ │  run + mail session + 目录 + 预算
                │ │ Session 2  │ │
                │ └────────────┘ │
                └────────────────┘
```

- **默认单机**：supervisor + 每个 agent 一个 `agent-worker.ts` 子进程；worker 内部用异步任务并发跑多个 Session。
  模型循环几乎全是 I/O，进程内存主要是对话历史，受 `maxTurns` 与内容上限约束。
- **多机**：现有 `--agent <id>` 过滤可作为最简放置策略；后续再引入按 capability / 负载的 placement。
- **容器**：挂载 `COLLAB_RUN_ROOT` 卷，注入密钥环境变量，不连数据库——控制面/执行面边界保持不变。
- **故障域**：Session 级 try/catch，一坏不影响同 agent 其它 Session；worker 崩溃时 supervisor 必须把它的
  **所有** running run 标成 `outcome_unknown`（现在只标一个）。
- **目录布局**：

  ```text
  <runRoot>/<agentId>/
    sessions/<runId>/        # 每个 Session 一个 0700 目录，结束清理
    cache/                   # 可选，跨 Session 复用
  ```

- **启动清理**：启动时回收孤儿目录，避免崩溃残留。

## 4. 分阶段实施

| 阶段 | 做什么 | 验收标准 |
|---|---|---|
| **P0 契约** | 定义 `AgentRuntime` / `Session` 接口；扩展测试桩，支持同一 agent 多个 run | 接口和现有测试都能跑 |
| **P1 抽层** | 把 ensure/token/brain/client/工具注册从 `session.ts` 上移到 `AgentRuntime`；`session.ts` 变成 `SessionRunner`，只做一次会话 | 现有 supervisor 测试全绿，外部行为不变 |
| **P2 多 Session** | 新增 `agent-worker.ts`：拉未读 → 在 `definition.concurrency` 内并发开 Session；supervisor 改成 spawn worker、转发日志、按 agent 追踪所有 run；`--once` 等全部 drain | 同一 agent 可并发处理 ≥2 个 run，互不串目录 |
| **P3 资源配额** | 每 Session 独立目录/预算/abort；agent 空闲 TTL；孤儿目录回收；每 agent 指标 | 杀掉一个 Session 不影响其它；空闲 worker 自动退出 |
| **P4 部署加固** | SIGTERM 优雅退出（停止接活 → drain → 未完成 nack）；定义变更按 hash 重建 worker；日志前缀；健康检查 | 重启过程中消息不丢、不重复执行 |
| **P5 强隔离（可选）** | `sessionIsolation: 'inline' \| 'process'`，每 Session 一个子进程或容器 | 同一套接口切换隔离级别 |

### P1 详细步骤（建议先做）

1. 新建 `src/runtime/agent.ts`：`AgentRuntime` 持有 definition、token、client、brain、tool specs、work root、信号量。
2. 新建 `src/runtime/session.ts`：`Session` 持有 runId、mail session、messages、workdir、deadline、abort、预算。
3. `session.ts` 入口改为：读 stdin → 构造 AgentRuntime → `runtime.runSession(config)`。
4. `supervisor.ts` 暂时保持“一个 agent 一个子进程”，但 launch 时传定义快照。
5. 用现有测试做回归；补一个同一 agent 两次运行的顺序用例。

## 5. 保留 / 重写边界

保留：

- `src/client.ts`：平台 HTTP 协议，无状态。
- `src/brains/*`：模型协议适配，无状态。
- `src/tools.ts`：工具定义与执行，执行时注入上下文。
- `src/sandbox.ts`：路径、环境、超时、输出截断。
- `src/token.ts`：派生令牌。
- `src/definition.ts`：平台下发的类型。

重写：

- `src/supervisor.ts` → 调度器（发现、放置、全局并发、worker 生命周期、recover、日志）。
- `src/session.ts` → 拆成 `agent-worker.ts`（常驻、多 Session）与 `session-runner.ts`（单次会话）。

顺带修掉的现有缺陷：

- `agent.concurrency` 未生效。
- `--once` 只等子进程，不等内部会话。
- worker 崩溃只收尾一个 run。
- run 目录随运行删除，没有 agent 级持久化。

## 6. 待确认的语义

本计划把 **Session 定义为“一次运行上下文”**：一个平台 run + 一个 mail session + 一段对话历史。

如果目标是“同一个 agent 上跨运行长期存活的会话”，则：

- P2 之前需要把 mail session 的 key 从 `run:<runId>` 改为可复用的会话标识；
- 需要确认平台侧支持按会话续拉（`since` / cursor 语义）；
- Session 的目录与预算生命周期也会从“一次运行”变成“会话存活期”。

两种语义只在 P2 分叉，P0/P1 的工作不受影响。

## 7. 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| worker 内并发导致故障扩散 | 一个异常杀掉多个 Session | Session 级 try/catch；可选进程隔离 |
| 平台 `recover` 只按心跳判断 | 多 Session 时可能误回收 | worker 为每个 run 持续心跳；优雅退出时主动 nack |
| 模型密钥进入子进程 | 泄漏面扩大 | 密钥只在 AgentRuntime 内解析；shell 环境清洗保持不变 |
| 目录残留 | 磁盘增长 | 启动清理 + 空闲 TTL |
| 定义热更新 | 运行中行为不一致 | 按定义 hash 重建 worker；运行中的 Session 用快照 |

## 8. 参考实现：dsh-superagent-prototype

路径：`/Users/eccstartup/code/claude/dsh-superagent-prototype`

性质：MIT 研究原型，约 15k 行 `src` + 13k 行测试，只有一次提交。它是 DeepSeek Harness（DSH）的 Cordis bundle，
不能直接当库依赖；有价值的是它的**领域规则和控制面设计**，不是它的打包方式。
`src/core/` 基本是纯 TypeScript（`core` + `infra` 里只有一处 DSH 导入），概念可以搬，代码要改写。

### 8.1 按这个顺序读

| 顺序 | 文档 | 读它解决什么 |
|---|---|---|
| 1 | `docs/000-philosophy.md` | 注意力经济：为什么要区分“人能看多少”和“系统能做多少” |
| 2 | `docs/001-domain.md` | Source / Trigger / Thread / Eval / Mandate / Ticket / Assignment / Subscription 的定义与不变式 |
| 3 | `docs/002-authorization.md` | 门禁、授权强度、准入、`observe`/`auto`、恢复时复验 |
| 4 | `docs/003-execution.md` | 阶段怎么从事实推导、Executor 与槽位、恢复语义 |
| 5 | `docs/007-architecture.md` | 核心类、模块划分、持久化、面向模型的接口 |
| 6 | `docs/004-prompts.md` | 分层提示词与版本化 |

`005-panel.md`（React 面板）、`006-deployment.md`（DSH 部署）、`008-cookbook.md` 与本次迁移无关，可跳过。

### 8.2 概念映射

| dsh-superagent | anpio-agents 对应物 | 差别 / 可借鉴点 |
|---|---|---|
| Source → Trigger | 平台 mail envelope、`run` 的创建 | 平台已经做了触发，缺的是**去重与已读游标** |
| Thread | mail session / 任务讨论串 | dsh 保证同一 thread 串行；anpio 现在靠 lease 自然串行 |
| Eval（确定性 gate + LLM assessment） | 平台 scope 校验 + `definition.tools` 白名单 | 确定性准入与模型判断分离，anpio 只有前者 |
| Mandate（不可变，恢复时复验） | `scopes` + `operationId` 幂等 | **恢复/重试时重新校验授权**，anpio 没有 |
| Ticket / Assignment | task / subtask / run | 一个 assignment 一次执行、可重试；anpio 是 run |
| Executor Session | Session（本计划第 1 节） | dsh 的 worker 一个 ticket 一个，anpio 要走多 Session 复用 |
| Subscription fan-out | 未实现 | 已订阅线程的后续消息直达 owner，orchestrator 只路由 |
| Effect queue（`src/app/effects.ts`） | 未实现 | **事务内落库 + 退避重试 + 按 kind 限并发**，是 dsh 最值得抄的一块 |
| Outbox（`src/app/outbox.ts`） | 平台自身 | 对外投递保序、可重放 |
| Store / Passes（`src/app/store.ts`、`passes.ts`） | 平台数据库 | 执行面不持有事实，只持有本地缓存 |
| 分层提示词 + 版本（`src/app/prompts.ts`） | `systemPromptFor()` + `AGENTS.md` | 默认文本与团队覆盖分离 |
| Stage 由事实推导（`src/core/stage.ts`） | run 状态 | 不存冗余状态，避免状态机漂移 |

### 8.3 值得借的四个模式

1. **效果队列**（`src/app/effects.ts`）：所有副作用（launch / delivery / relay / notice / reply / assessment）
   先写进 DB 事务，再由 worker 消费。anpio 现在“spawn 后即忘”，worker 崩溃就丢上下文；
   对应改造是 P4 的“未完成 nack + 重启可恢复”。
2. **恢复时复验授权**（`docs/002-authorization.md`）：Mandate 不可变，恢复时必须重新检查门禁。
   anpio 的恢复只按心跳判活，应补“恢复前重新拉一次定义与 scope”。
3. **阶段推导**（`src/core/stage.ts` + `docs/003-execution.md`）：状态由事实算出，不单独存。
   anpio 的 run 状态由平台持有，但 Session 内部进度（拉到几条、ack 到哪）应同样可推导。
4. **订阅扇出**（`docs/001-domain.md`）：消息只送给真正相关的一方。anpio 的 supervisor 每次都全量
   扫描所有定义，Session 多了以后应改成“按 agent 的未读游标”增量拉取。

### 8.4 不要照抄

- Cordis / DSH 的插件与部署包装（`src/deployment.ts`、`src/setup.ts`）。
- GitHub 单仓库语义（Source 是 PR/issue），anpio 的 Source 是平台任务。
- dsh 的 Ticket/Thread 领域模型本身——anpio 已经有 task/subtask/offer，强行对齐会引入两套状态机。
- React 面板（`src/app/views`、`005-panel.md`）。
- 14 + 6 个工具的数量与命名；anpio 的工具集由平台协议决定。
- 策略版本化的完整机制（`policy.ts`、`settings-history.ts`）——P0–P2 用定义快照就够，别提前做。

## 9. 新 session 开工清单

给接手的新 session 的最小上下文，按顺序执行。

### 9.1 先读

1. `README.md`——现状：一次运行一个 `session.ts` 子进程。
2. 本文档第 0、1、2、4、5 节——问题、目标分层、资源归属、阶段、保留/重写边界。
3. 参考实现只读第 8.1 节的六份文档；代码看 `src/app/effects.ts`、`src/core/stage.ts`、`src/core/intake.ts`。

不必通读 dsh 的 `src/executor`、`src/client`、`src/sources`——它们是 DSH 生态的适配，和本仓库无关。

### 9.2 先跑基线

```bash
npm install
npm test
npm run check
```

现有测试是唯一的回归护栏，改动前必须全绿。

### 9.3 从哪开始

- **只做 P0 + P1**：抽 `AgentRuntime` / `Session` 两个接口，把身份、Brain、client、工具注册上移，
  `session.ts` 变成单次会话执行器。外部行为不变，现有测试不改。
- P2（`agent-worker.ts` 多 Session）等 P1 合入并稳定后再开，不要一次做完。
- **不要改 anpio-collab**：控制面/执行面只通过 HTTP 相连，本仓库不读平台数据库、不改平台接口。
- 不要新增依赖；Node ≥ 22.18，直接跑 TypeScript，保持 `fetch` + 标准库。

### 9.4 完成标准

| 阶段 | 判定 |
|---|---|
| P0 | 两个接口有类型定义与至少一个测试桩；`npm test` 全绿 |
| P1 | `supervisor.ts` 行为不变；新增“同一 agent 顺序两次运行”用例通过；`session.ts` 里不再出现 token/brain 的构造 |
| P2 | 同一 agent 并发 2 个 run，各自独立目录与 mail session；单个 Session 抛错不影响另一个 |

### 9.5 尚未决定

第 6 节的 Session 语义（一次运行 vs 跨运行长会话）只需在 P2 前回答。P0/P1 不受影响，
可以先把接口设计成“Session 持有 mail session id”而不是“Session 等于 mail session”，两种语义都能接。

### 9.6 提交建议

按阶段各一个提交，信息写清“为什么”：

```text
refactor: extract AgentRuntime from session entry
refactor: make session.ts a single-session runner
feat: run multiple sessions per agent worker
```

