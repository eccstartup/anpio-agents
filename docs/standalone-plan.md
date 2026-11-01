# 行动计划：把执行引擎从 anpio-collab 解耦，支持独立运行

- 状态：实施中（P0 端口提取、P1 本地传输层、P2 独立入口、P3 本地服务、P4 会话连续性已完成）
- 日期：2026-11-01
- 范围：`anpio-agents` 执行引擎
- 前置：`docs/action-plan.md`（常驻 worker 承载多 Session）已完成并合入

## 0. 判断

内核已经自包含：模型循环、Brain 适配器、工具执行、沙箱、目录与 ack/nack 语义都在本仓库，
不依赖平台的数据库，也不需要 supervisor 常驻。真正耦合的只有 `CollabClient` 这一层，
以及 `supervisor.ts` 里“发现定义、建 run、ensure 令牌、recover”的平台调度语义。

因此目标不是再写一个 agent loop，而是把**控制面抽成端口**：

- `CollabClient` 变成端口的一个实现，平台路径行为不变；
- 新增本地实现，让同一个 `AgentRuntime` / `AgentSession` 不接 anpio-collab 也能跑；
- 以后接 Slack、Webhook、邮件、定时任务或另一套控制面，只需实现触发适配器或传输层，不改内核。

一句话：**Session 面向 `AgentTransport` 编程，supervisor 继续做 anpio-collab 的调度适配器。**

## 1. 目标形态

```text
触发适配器                        独立运行时（standalone.ts）
CLI / stdin / HTTP / 未来 Slack…  ──▶  队列 + 并发 + 生命周期
                                          │
                                          ▼
                                    AgentRuntime（身份、Brain、工具、工作根）
                                          │ AgentTransport
                        ┌─────────────────┴─────────────────┐
                        ▼                                   ▼
                 CollabTransport                     LocalTransport
                 （anpio-collab HTTP）                （内存 / 文件）
                        │                                   │
                        └──────────────┬────────────────────┘
                                       ▼
                                  AgentSession（一次运行）
```

- supervisor / agent-worker 保持现状，只把 `CollabClient` 包成 `CollabTransport`。
- standalone 不经过 supervisor，单定义直接从文件加载。
- 两种运行方式共用同一个 `AgentSession`，所以目录、超时、ack/nack、finish、`outcome_unknown` 的语义一致。

## 2. 端口设计

只抽 Session 真正需要的能力，不复制平台的 HTTP 形状。`operationId`、mail session、`embedded/runs`
这些是平台概念，不应该出现在本地实现里。

```ts
// src/runtime/transport.ts

export type MailboxPort = {
  open(input: { label?: string; kind?: 'embedded' | 'external'; ttlSeconds?: number }, signal?: AbortSignal): Promise<MailSession>;
  pull(sessionId: string, options: { limit?: number; leaseSeconds?: number; since?: number; waitMs?: number }, signal?: AbortSignal): Promise<{ items: MailEnvelope[]; cursor: number }>;
  message(messageId: string, signal?: AbortSignal): Promise<MailMessage>;
  ack(messageId: string, deliveryId: string): Promise<void>;
  nack(messageId: string, input: { deliveryId: string; retryAfterSeconds?: number; reason?: string }): Promise<void>;
  close(sessionId: string): Promise<void>;
};

export type RunLedgerPort = {
  heartbeat(runId: string, input?: { sessionId?: string }): Promise<void>;
  log(runId: string, level: 'debug' | 'info' | 'warn' | 'error', text: string): Promise<void>;
  finish(runId: string, result: SessionResult): Promise<void>;
  status(runId: string): Promise<{ status: SessionOutcome | 'running' }>;
};

export type PresencePort = {
  heartbeat(input?: { state?: 'online' | 'busy' | 'offline'; note?: string }): Promise<void>;
};

/** 平台任务/文件/知识工具的后端；本地模式可以为空。 */
export type ToolBackend = {
  task(id: string): Promise<TaskDetail>;
  inbox(): Promise<InboxItem[]>;
  accept(subtaskId: string, operationId: string, expectedVersion?: number): Promise<unknown>;
  // …与 client.ts 中 tools.ts 实际用到的方法一一对应
};

export type AgentTransport = {
  mailbox: MailboxPort;
  runs: RunLedgerPort;
  presence: PresencePort;
  tools?: ToolBackend;
  /** 这个传输层是否支持某个工具；本地原语（shell / 文件 / finish）总是支持。 */
  supportsTool(name: EmbeddedTool): boolean;
  /** 渲染系统提示与 AGENTS.md 的环境规则，替代写死的“平台规则”。 */
  environment: { rules: string[]; persistenceNote: string };
  /** 进程隔离时子进程的启动配置；返回 null 表示该传输层暂不支持 process 隔离。 */
  spawnConfig?(runId: string): Record<string, unknown> | null;
};
```

实现：

- `collabTransport(client: CollabClient): AgentTransport`：把现有方法逐个转接，`supportsTool` 对全部工具返回 true，`environment` 返回当前“平台规则”。
- `localTransport({ root }): AgentTransport`：绑定本地信箱与运行账本，默认没有 `ToolBackend`。
- `AgentRuntime` 不再自己构造 `CollabClient`；新增 `collabRuntime({ baseUrl, token, agentId, definition })` 工厂，supervisor / worker / `session.ts` 改用它。

不直接把 `CollabClient` 当接口，是因为它带着 `operationId`、mail session、`embedded/runs` 等平台语义；
端口更窄，本地实现也更诚实——本地没有的东西就应该显式缺席，而不是伪装成空响应。

## 3. 三条不变式

1. **Session 语义不变**：一次运行 = 一个独立目录 + 一批消息 + 最多 `maxTurns` + `finish`/`ack` 或 `nack`。
2. **收尾语义不变**：没有成功收尾不能 ack；写请求结果未知 → `outcome_unknown`，消息长退避退回。
3. **平台路径行为不变**：P0 是纯重构，`supervisor`、`agent-worker`、现有测试的行为不允许变化。

## 4. 独立运行要补的语义

### 4.1 消息从哪里来

本地触发把一条输入包装成与平台同形的 `MailEnvelope` + `MailMessage`，
`kind` 用 `user.message` / `api.request` 之类的普通值，`ref.type = 'message'`。

```ts
const envelope: MailEnvelope = {
  id: 'msg-…',
  seq: 1,
  deliveryId: 'delivery-…',
  topic: 'standalone',
  kind: 'user.message',
  priority: 'normal',
  summary: text.slice(0, 80),
  ref: { type: 'message', id: threadId ?? runId, taskId: null, threadId: threadId ?? null },
  publisherId: 'local',
  createdAt: new Date().toISOString(),
  expiresAt: null,
};
```

这样 `envelopeText()`、`{{messageId}}` / `{{refId}}` 替换、`onMailPulled` 都能原样复用。
本地信箱一次可以排多条，`maxMessages` 的批处理语义也与平台一致。

### 4.2 完成判定：`finish` 还是直接文本

现在模型如果只回文本、不调 `finish`，运行会被判失败并把消息退回——这对协作平台是对的，
对聊天式接口不自然。定义里增加一个字段：

```json
{ "completion": "text" }
```

- `finish`（缺省）：保持现有行为，必须调用 `finish` 才算完成；anpio-collab 的定义不受影响。
- `text`：模型给出没有工具调用的文本回答时，视为正常完成，`summary` 取该文本并 ack；
  调用了 `finish` 仍然立即结束。

只改 `src/runtime/session.ts` 模型循环里“没有 tool calls”的那一个分支，其余收尾逻辑不变。

### 4.3 提示词与环境说明

`systemPromptFor()` 现在硬编码“你是平台里的协作智能体”，`writeAgentsFile()` 也写死“提交到平台”。
改为由传输层提供环境说明：

- Collab：保留现有规则文本；
- Local：说明这是独立进程、工作目录随运行创建、长期产出写到宿主机指定目录、收尾方式取决于 `completion`。

`AGENTS.md` 的“可用工具”一栏改用**生效后的工具清单**，而不是定义里原始的 `tools`。

### 4.4 工具可用性

- `shell` / `read_file` / `write_file` / `list_files` / `finish` 是本地原语，任何传输层都可用。
- `task_*` / `offer_*` / `file_*` / `knowledge_search` 需要 `ToolBackend`。
- 启动时计算 `effectiveTools` 与 `missingTools`：有缺失默认**直接报错并列出名字**，避免模型拿到不存在的工具；
  需要降级时显式传 `--allow-missing-tools`。

以后接别的系统时，实现一个 `ToolBackend` 就能把同一批工具名映射到 Slack / GitHub / 本地任务库，
模型侧的工具协议不用改。

### 4.5 会话连续性（单独阶段）

当前一次 Session 只处理一批消息，运行结束即丢对话历史。独立智能体通常需要多轮：

- 新增 `ConversationStore` 端口，本地用 JSONL 按 `threadId` 落盘；
- `SessionRequest` 增加可选的 `history: ChatMessage[]`，模型循环前拼进去；
- 运行成功后追加“用户输入 + 最终文本回答”；
- 设保留上限（条数 / 字节 / token），超出时从最旧的成对消息开始丢；
- Collab 路径不传 `history`，行为不变。

这一阶段可以后做；MVP 先接受“每次运行独立”的语义，用工作根里的文件保留长期产出。

## 5. 入口与形态

### 5.1 一次性运行

```bash
npm run standalone -- --agent ./agent.json --message "帮我看看这个目录"
echo '{"text":"继续处理上一条"}' | npm run standalone -- --agent ./agent.json
```

- 定义从文件加载，缺省值由 loader 补齐（id、时间戳、`concurrency: 1`、`sessionIsolation: 'inline'`）。
- 模型密钥仍只写环境变量名，值从当前进程环境读取；缺密钥时启动即报错。
- 结果以 JSON 写到 stdout，日志写 stderr；退出码沿用 `0` 成功 / `2` 结果未知 / 其他失败。

### 5.2 常驻本地服务

```bash
npm run standalone -- --agent ./agent.json --serve --port 8788
```

```text
POST /runs          { "text": "...", "threadId": "可选" }  -> 202 { "runId": "..." }
GET  /runs/:id      -> { status, summary, error, turns, tokens, createdAt, finishedAt }
GET  /health        -> { ok, active, queued }
```

- 默认只监听 `127.0.0.1`；需要对外时显式 `--host`，并加 `AGENT_HTTP_TOKEN` 做 Bearer 校验。
- 队列与并发复用 `AgentRuntime` 的信号量，`concurrency` 的含义不变。
- `SIGTERM`：停止接新请求 → 等待收尾 → 超时后中断剩余 Session。
- `Idempotency-Key` 可选：同一个 key 返回同一个 `runId`。

### 5.3 配置命名

standalone 使用中性的 `AGENT_*` 变量，平台路径继续用 `COLLAB_*`：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `AGENT_RUN_ROOT` | `./agent-runs` | 本地运行目录根 |
| `AGENT_IDLE_MS` | `0` | 服务空闲多久退出；`0` 表示常驻 |
| `AGENT_HTTP_TOKEN` | 无 | 本地 HTTP 的 Bearer 令牌 |
| `AGENT_KEEP_RUN` | `0` | `1` 保留运行目录 |

不在这轮做全局改名；`COLLAB_*` 只服务 anpio-collab 路径。

### 5.4 定义示例

```json
{
  "id": "local-assistant",
  "name": "本地助手",
  "description": "不接协作平台的独立智能体",
  "provider": {
    "id": "anthropic",
    "protocol": "anthropic-messages",
    "model": "claude-sonnet-4-5",
    "apiKeyEnv": "ANTHROPIC_API_KEY"
  },
  "systemPrompt": "你是一个独立运行的助手。先确认目标，再动手；结论要能直接使用。",
  "tools": ["shell", "read_file", "write_file", "list_files", "finish"],
  "completion": "text",
  "limits": { "maxTurns": 12, "timeoutMs": 180000, "maxTokens": 8192 },
  "sandbox": { "shell": true, "shellTimeoutMs": 30000, "maxOutputBytes": 65536 },
  "concurrency": 1
}
```

## 6. 分阶段实施

| 阶段 | 做什么 | 验收标准 |
| --- | --- | --- |
| **P0 端口提取** | 新增 `transport.ts` 与 `collabTransport`；`AgentRuntime` 接收 `transport`；Session / ProcessSession / log / tools 改依赖端口；supervisor / worker / session 入口改用 `collabRuntime()` | `npm test`、`npm run check` 全绿；平台路径行为与日志不变 |
| **P1 本地传输层** | `LocalMailbox`（内存 + JSONL）、`LocalRunLedger`、`LocalPresence`、`localTransport`；租约、ack/nack、重启恢复 | 不接 HTTP，用本地传输层跑通一个 script 定义；并发拉取不重复投递 |
| **P2 独立入口（MVP）** | `src/standalone.ts`、定义文件 loader、`completion` 字段、传输层环境提示、工具可用性校验、一次性运行 | 不连 anpio-collab 能跑脚本定义；有密钥时能跑真实模型；缺工具/缺密钥启动即报错 |
| **P3 本地服务** | `--serve`、队列、HTTP 接口、健康检查、优雅退出、可选幂等键 | 两个并发请求受 `concurrency` 限制；一个失败不影响另一个；SIGTERM 能收尾 |
| **P4 会话连续性** | `ConversationStore`、`threadId`、历史注入与保留上限 | 第二轮能看到第一轮；历史超过上限后从最旧处淘汰 |
| **P5 可选扩展** | 本地传输层下的 process 隔离、流式事件、Slack/Webhook/cron 触发适配器、本地任务 `ToolBackend` | 按需做，不阻塞 MVP |

建议先做 **P0 → P1 → P2**，这就是“能独立跑”的最小闭环；P3 以后逐步补齐。

## 7. 文件边界

| 处理 | 文件 |
| --- | --- |
| 新增 | `src/runtime/transport.ts`、`src/runtime/local/*.ts`、`src/standalone.ts`、`src/standalone/config.ts`、`examples/local-assistant.json`、`tests/transport.test.ts`、`tests/local-transport.test.ts`、`tests/standalone.test.ts` |
| 改动 | `src/runtime/agent.ts`、`src/runtime/session.ts`、`src/runtime/process-session.ts`、`src/runtime/log.ts`、`src/runtime/prompt.ts`、`src/runtime/types.ts`、`src/tools.ts`、`src/sandbox.ts`（工作根可覆盖）、`src/session.ts`、`src/agent-worker.ts`、`package.json`、`README.md` |
| 不动 | `src/supervisor.ts`（除改用 `collabRuntime()`）、`src/client.ts`、`src/brains/*`、`src/token.ts`、平台协议与鉴权 |

## 8. 测试计划

- `tests/transport.test.ts`：端口契约；`collabTransport` 与现有 `CollabClient` 行为一致。
- `tests/local-transport.test.ts`：租约到期、ack、nack 退避、并发拉取不重复、账本 finish / recover。
- `tests/standalone.test.ts`：定义加载与缺省值、工具校验、`completion: 'finish' | 'text'`、一次性运行的退出码。
- `tests/standalone-serve.test.ts`（P3）：HTTP 并发、失败隔离、SIGTERM。
- 现有 `tests/runtime.test.ts` / `tests/worker.test.ts` 的假客户端改成假 `AgentTransport`；
  这是 P0 的主要测试改动，行为断言不变。

## 9. 风险与取舍

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 端口提取波及所有测试 | 重构期回归噪声 | P0 只做转接，不夹带行为变化；先让现有测试全绿 |
| `finish` 与聊天语义冲突 | 独立运行时总是失败 | 显式 `completion` 字段；缺省保持平台行为 |
| 本地信箱只有单进程保证 | 多进程/多机会重复投递 | MVP 只支持单进程；P5 做进程隔离时改用文件锁或 SQLite |
| 本地进程隔离缺状态 | 子进程重建不了内存信箱 | P5 再做；之前 standalone 只跑 inline，或强制文件后端 |
| 工具能力缺失 | 模型调用不存在的工具 | 启动时校验并报错；`--allow-missing-tools` 才降级 |
| 提示词仍像协作平台 | 独立运行时模型行为别扭 | 环境说明由传输层提供，P2 一并改 |
| 本地 HTTP 暴露 | 宿主机被远程调用 | 默认只绑 `127.0.0.1`；对外必须配 Bearer |
| 定义结构漂移 | 本地与平台解析不一致 | standalone loader 只做缺省值与必填校验，不做平台业务校验 |

安全边界不变：`sandbox.ts` 仍是“防误伤”，不是容器隔离；模型密钥只在 `AgentRuntime` 进程内，
shell 子进程环境继续清洗。独立运行少了平台令牌，暴露面反而更小。

## 10. 待确认

| 问题 | 建议 |
| --- | --- |
| MVP 是否需要 HTTP 服务 | 先做一次性运行；需要长期接接口时再做 P3 |
| `completion` 缺省值 | `finish`（兼容平台）；示例定义显式写 `text` |
| 本地是否实现平台任务工具 | MVP 不支持，启动时报错；需要时再做本地 `ToolBackend` |
| 是否马上做多轮记忆 | 放 P4；MVP 用工作根文件保留产出 |
| standalone 是否支持 process 隔离 | 放 P5；P1 先只做内存/文件传输层与 inline |
| 是否重命名 `EmbeddedAgentDefinition` | 单独一次机械提交，别和本次混在一起 |

## 11. 开工清单

1. 读 `src/runtime/session.ts`、`src/runtime/agent.ts`、`src/tools.ts`、`src/runtime/log.ts`、`src/runtime/process-session.ts`，标出每一处 `CollabClient` 调用。
2. 跑基线：

   ```bash
   npm install
   npm test
   npm run check
   ```

3. P0 先提交纯重构：

   ```text
   refactor: extract AgentTransport from CollabClient
   ```

4. P1 提交本地传输层：

   ```text
   feat: add a local transport for standalone runs
   ```

5. P2 提交独立入口：

   ```text
   feat: run an agent without a control plane
   ```

约束：不新增依赖；不改 anpio-collab 的协议；不让 supervisor 承担 standalone 的职责；
P0 期间平台路径的日志、退出码、消息退回语义必须逐字保持不变。

## 12. MVP 完成定义

- 一个定义文件 + 一条输入，不启动 supervisor、不连 anpio-collab，就能完成一轮并给出结果；
- `script` 定义完全离线可验证；真实模型定义只依赖模型 API 与 `apiKeyEnv`；
- 运行目录、超时、工具调用、`finish` / 文本完成、退出码与现有实现一致；
- `npm test` 与 `npm run check` 全绿。
