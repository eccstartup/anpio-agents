# anpio-agents：统一线程智能体 + 多消息来源

- 状态：已实施（平台路径用 fake client 单测覆盖，尚待真实平台验收）
- 日期：2026-11-03
- 范围：新增 `anpio-agents` 交互式命令；现有接口全部保留
- 前置：`docs/standalone-plan.md`、`docs/anp-runtime-plan.md`

## 0. 目标

提供一个像 Claude Code / codex CLI 一样的命令：

```bash
anpio-agents --agent examples/local-chat.json
```

启动一个常驻智能体，逐字流式输出、能调用工具；同时能处理平台推送的任务。平台只是**一种消息订阅方式**，不是另一类 Session。

## 1. 核心模型

```text
MessageSource[] ──poll──▶ ThreadHost ──按 threadId 路由──▶ ThreadStore
  stdin                     │                                ├─ threads
  platform                  │                                ├─ messages（历史）
  http / im / poll（以后）   │                                ├─ inbox（pending / 租约）
                            ├─ ThreadTurn（每个 thread 同时一个）
                            │    ├─ 上下文 = thread 历史 + 新消息
                            │    ├─ brain loop（带流式事件）
                            │    ├─ 工具（本地原语 + 来源工具包）
                            │    └─ 经消息来源 ack / nack / reply
                            └─ 事件 ──▶ REPL / 日志
```

- **一个 agent 只有一种 Session**：按 thread 标识，不按来源标识。
- **一个 thread 同时只跑一个 turn**；不同 thread 可并行，受 `concurrency` 限制。
- **平台是 source**：平台消息进入同一个 store、同一个 thread、同一个模型循环。
- **本地输入也是 source**：REPL 只是 stdin source 的渲染层。

判断“继续之前的任务”还是“新任务”，依据是消息所属的 thread / conversation，而不是消息来自哪里。

## 2. 线程身份

`normalizeThreadKey(sourceId, message)`：

1. `message.threadId`（平台 `ref.threadId`、ANP `conversation_id`）优先。
2. 否则 `message.taskId`，再否则来源给出的 `conversationId`。
3. 都没有时：`sourceId:message.id`，即每条消息一个新任务。
4. 来源显式 `newThread: true` 时，生成 `sourceId:<timestamp>`（REPL `/new` 用）。

store 里已有这个 key → 继续，带历史；没有 → 新建 thread。本地 stdin 默认 thread 是 `local:main`。

## 3. 消息来源端口

`src/threads/types.ts`：

```ts
export type MessageSource = {
  id: string;
  kind: 'interactive' | 'background';
  open?(emit: () => void): Promise<void>;
  poll(): Promise<InboundMessage[]>;
  ack?(message: InboundMessage): Promise<void>;
  nack?(message: InboundMessage, input: { retryAfterSeconds?: number; reason?: string }): Promise<void>;
  reply?(message: InboundMessage, text: string): Promise<void>;
  tools?(): ToolBackend | undefined;
  environment?: EnvironmentDescription;
  beginTurn?(message: InboundMessage): Promise<{ finish(result: SessionResult): Promise<void> } | null>;
  close?(): Promise<void>;
};
```

关键约束：`poll()` 只排空缓冲，**不做长轮询**。平台来源在 `open()` 里起自己的 `pullMail({ waitMs })` 循环，收到消息后 `emit()` 叫醒 host；否则一次长轮询会把本地输入的扫描延迟到同样的时长。

来源不需要知道 thread、模型循环或工具执行；它只负责“拉消息、确认消息、送回复、提供工具”。

## 4. 持久化与工作目录

- `ThreadStore` 直接复用 `src/store/agent-store.ts` 的 `AgentStore`（SQLite）。
- 迁移 v2：`inbox.source`、`inbox.source_delivery`、`messages.source`，默认 `'anp'`，现有 ANP 路径行为不变。`source_delivery` 存 JSON（平台是 `{ deliveryId }`，stdin 为 null）。
- `recordIncoming` 增加可选 `source` / `sourceDelivery`；`pullInbox` 返回它们；`NewInboxMessage` 同步扩展。
- 新增 `pendingThreads(now, limit): Array<{ threadId: string; sources: string[] }>`，host 用它决定先跑交互 thread；`pendingThreadIds` 保留给 router。
- 工作目录：`runtime.root` 是 `<rootBase>/<agentId>`，DB 在 `join(runtime.root, 'agent.db')`，workspace 用 `threadWorkspace(runtime.root, threadId)`，跨 turn 保留。外部 thread id 不合法时用稳定哈希做目录名。
- 启动时释放过期租约；把上次遗留的 `running` turn 标为 `failed`。

## 5. 线程 turn

`src/threads/turn.ts`，结构取自 `src/runtime/anp/session.ts` 的 `AnpTurnSession`：

1. `runtime.acquire()`；`runtime.sessionBegin()`。
2. `store.pullInbox({ threadId, limit, leaseSeconds })`；没有消息就结束。
3. `buildThreadContext(store, threadId)`：复用 `src/runtime/anp/context.ts`，只把渲染前缀改成来源无关（`【消息 <id> · 来源 <source>】`）。
4. `ensureThreadWorkspace` + `writeAgentsFile`，环境说明用 `THREAD_ENVIRONMENT`。
5. `createTools({ backend, runDir, runId, definition, tools, log })`。
   - `backend`：取提供 `tools()` 的来源（当前是 platform）。
   - `availableTools`：`isLocalTool(t) || backend`；缺后端且定义含平台工具时按 `allowMissingTools` 降级或报错。
6. `runBrainLoop({ ..., stream, onEvent })`，事件带 `threadId` / `turnId` / `sourceId`。
7. 成功且有 `finished`：
   - 插入一条 assistant 历史消息，让下一轮上下文包含最终回答；
   - 对每个 inbox 行先 `store.ackInbox(...)`，再按行分组调用 `source.ack(inbound)`；
   - `source.reply?.(trigger, summary)`；stdin 来源不实现 reply，避免重复输出。
8. 失败：按行分组 `store.nackInbox(...)` + `source.nack(...)`，保留消息。
9. `runtime.sessionEnd()`；`store.finishTurn()`。

Ack/nack 同时做两件事：本地租约与来源凭据。两件事都幂等；来源确认失败时本地租约到期会重投。

## 6. 线程 host

`src/threads/host.ts`，结构取自 `src/router/agent-host.ts` 的 `AgentHost`：

- 持有 `AgentRuntime`、`AgentStore`、`MessageSource[]`、`running: Map<threadId, Promise>`。
- `start()`：打开各来源（`open(() => this.wake())`）、释放过期租约、立即 `wake()`；每 `tickMs`（默认 500ms）扫一次。
- `sweep()`：
  1. 并行 `poll()` 所有来源（只排空缓冲，不阻塞）；归一化 thread key；`store.recordIncoming` 去重。
  2. `recordIncoming` 返回 false 且该 inbox 行已 `acked` 时，立刻 `source.ack(message)`。
  3. `store.pendingThreads()`；先启动交互来源的 thread，再启动后台来源；后台最多用 `concurrency - 1` 个槽位，给交互留一个。
  4. 每个 thread 一个 `ThreadTurn`；同 thread 不并发。
- `submit({ text, threadId?, newThread? })`：给 stdin 这类推入式来源使用；`done` 在该 thread 下一次 turn 结束时 resolve。
- `stop()`：中止所有 turn，关闭来源与 store。
- 事件通过 `onEvent` 发出；REPL 只把 `sourceId === 'stdin'` 的文本写 stdout，后台来源事件写 stderr 前缀日志。

`runtime.concurrency` 是硬上限。`concurrency=1` 时退化为串行；聊天 CLI 要求至少 2，保证平台 thread 不会占满唯一槽位。

## 7. 消息来源

### stdin（交互）

`src/sources/stdin.ts`

- readline 读行；`open(emit)` 读到一行就入队并 `emit()`；`poll()` 排空队列。
- `kind: 'interactive'`；默认 thread `local:main`。
- 不实现 `reply`：文本已经通过 `text-delta` / `assistant-text` 事件写到 stdout。
- `/help`、`/exit`、`/new`、`/status` 由 REPL 处理，不进入模型。
- `--message` 走 `submit` 一次并等待 `done`。

### platform（平台订阅）

`src/sources/platform.ts`

- 配置：`baseUrl`、`agentId`、`adminTokenEnv`、`secretEnv`、`pollMs`。
- `open(emit)`：管理员令牌 `POST embedded/agents/:id/ensure`；`deriveEmbeddedToken(secret, agentId)` 得到派生令牌；派生令牌的 `CollabClient` 打开长期 embedded mail session。
- 后台循环直接用 `collabTransport(derivedClient).mailbox` 的 `open/pull/message/ack/nack/close`。
- `pullMail(sessionId, { limit, waitMs: pollMs })`；`CollabClient` 用 `timeoutMs: pollMs + 10_000` 构造。
- 每条用 `mailMessage(id)` 取正文，转成 `InboundMessage` 入队并 `emit()`。
- 平台不可用 / agent 不存在时退避重试，只告警，不影响本地对话。
- 信箱 session 设 `ttlSeconds`（默认 24h）；会话过期 / 不存在时重新 `createMailSession`。
- thread key：`ref.threadId ?? ref.taskId ?? id`。
- 正文：`content.body.payload.text`，没有就退回 `envelope.summary`；完整 `content` 放进 `data`。
- `delivery`：`{ deliveryId }`。
- `tools()`：返回派生令牌的 `CollabClient`。
- `environment`：`COLLAB_ENVIRONMENT`。
- `ack/nack`：直接调 `ackMail` / `nackMail`，nack 用显式幂等键 `mail:nack:<messageId>:<deliveryId>`。
- **不调用 `embedded/agents/import`**；不修改平台定义。

## 8. 流式

- `BrainRequest.onTextDelta?: (delta: string) => void`。设置时适配器走 SSE；不设置时保持整段 JSON。
- 不改 `BrainConfig` 或 `AgentRuntime`：`runBrainLoop` 把 `stream` + `onEvent` 映射成 `onTextDelta`。
- `src/brains/stream.ts`：SSE 解析（增量 UTF-8、CRLF、多行 `data:`、注释行、分块边界）。
- `anthropic-messages` / `openai-chat` 支持流式；响应不是 `text/event-stream` 时回退 JSON；`openai-responses` / `gemini-generate` 保持整段返回。
- `src/runtime/brain-loop.ts` 发 `text-delta`、`assistant-text`、`tool-call`、`tool-result`；现有日志行不变。
- REPL：`text-delta` → stdout；`assistant-text` 只在未流式时输出；工具调用/结果 → stderr；非 TTY 不输出 ANSI / banner / 提示符。
- 平台 thread 的事件只写 stderr 前缀日志。

## 9. CLI 与 REPL

`src/chat/cli.ts` + `src/chat/repl.ts` + `bin/anpio-agents.mjs`；`package.json` 加 `bin` 与 `agents` 脚本。

参数：`--agent`（必填）、`--message`、`--thread`、`--root`、`--no-stream`、`--no-platform`、`--keep-run`、`--allow-missing-tools`、`--help`。

流程：

1. `loadAgentFile`（`src/standalone/config.ts` 新增，返回 `{ definition, sources }`）：`sources` 单独解析校验；原始对象直接交给 `normalizeDefinition`。
2. 聊天 CLI 的 `completion` 默认 `text`（文件显式写了就用文件的）。
3. 强制 `sessionIsolation: 'inline'`。
4. `AgentRuntime.create`，transport 用 `src/threads/transport.ts` 的最小实现。
5. 启动前检查工具：有平台来源就允许平台工具，否则按 `--allow-missing-tools` 报错或降级。
6. 创建 `AgentStore`、`ThreadHost`、stdin source，按配置加 platform source。
7. 启动 host；进入 REPL 或 `--message`。

退出：`/exit`、Ctrl-D、非 TTY EOF → `host.stop()`；Ctrl-C 有活动 turn 时中止当前交互 thread，空闲时两次退出。

## 10. 配置

```json
{
  "id": "local-chat",
  "provider": { "protocol": "anthropic-messages", "model": "claude-sonnet-5-5" },
  "tools": ["read_file", "write_file", "list_files", "finish"],
  "completion": "text",
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

- `sources` 只存在本地文件，`normalizeDefinition` 忽略它；不会进入平台。
- 只接受环境变量名；`adminToken` / `secret` 这类明文字段直接报错。
- 未知 source / 未知字段报错。`stdin` 默认 true；`platform` 默认 false。
- `--no-platform` 覆盖平台来源。

## 11. 现有路径

- `standalone.ts` / `standalone/server.ts`：不动。
- `supervisor.ts` / `agent-worker.ts`：不动。
- `router` / `src/runtime/anp/*`：不动；`buildThreadContext` 加可选 `renderRow`，ANP 默认渲染不变。
- `AnpMailbox` / `AnpTurnSession` / `AgentSession`：不改。
- `AgentStore`：只加列与可选参数，默认值保持 ANP 行为。

## 12. 非目标

- 不做 per-session transport 分流；本地与平台不再各有一套 Session。
- 不把本地定义同步到平台；不调用 `import`。
- 不实现 IM / 抓取的具体适配器，只留端口与示例。
- 不支持 `process` 隔离下的交互流式；CLI 强制 inline。
- 不新增平台 run 记录通道；平台消息通过信箱订阅消费。
- 不实现 markdown 渲染、shell 审批、多窗口。
- 同一个平台 agent 不要同时跑 `supervisor` 与 `anpio-agents`，否则两边会抢消息。

## 13. 实施顺序

1. **线程基础**：`AgentStore` v2、`src/threads/types.ts`、`context.ts`、`turn.ts`、`host.ts` + 单测。
2. **本地可用**：流式适配器与 `brain-loop` 事件、stdin source、REPL、`bin/anpio-agents.mjs`、`package.json`。
3. **平台订阅**：`src/sources/platform.ts`，用 fake client 单测，再用真实平台验收。
4. **文档与回归**：README 新章节、`examples/local-chat.json`、跑全量测试与旧路径回归。

## 14. 测试

- `tests/thread-identity.test.ts`：thread key 归一化、继续 / 新建、`newThread`。
- `tests/thread-store.test.ts`：v1 → v2 迁移幂等、`source` / `source_delivery` 往返、`pendingThreads` 聚合、旧 ANP 行默认 `anp`。
- `tests/thread-host.test.ts`：两个 fake source；同 thread 串行、不同 thread 并行；交互优先；ack/nack 调对来源；重启后历史与未 ack 消息。
- `tests/thread-turn.test.ts`：历史注入、workspace 持久化、`finished` 才 ack、失败 nack、事件顺序。
- `tests/brain-stream.test.ts`：SSE 分块 / CRLF / 多行、Anthropic / OpenAI Chat delta、工具增量、回退 JSON、abort。
- `tests/platform-source.test.ts`：fake client；`ensure` 一次、派生令牌、长会话 pull、thread key、ack/nack、无 `import`。
- `tests/chat-cli.test.ts`：piped stdin + `script` agent；stdout 文本、stderr 工具行、`/new`、`/exit`、`--message` 退出码。
- 现有 `tests/standalone*.test.ts`、`tests/worker.test.ts`、`tests/supervisor.test.ts`、`tests/thread-session.test.ts` 全绿。

## 15. 验证

```bash
npm run check
npm test
```

确定性：

```bash
npm run agents -- --agent examples/local-demo.json --message "跑一下"
printf '跑一下\n/exit\n' | npm run agents -- --agent examples/local-demo.json
```

真实流式：

```bash
ANTHROPIC_API_KEY=... npm run agents -- --agent examples/local-chat.json
```

平台并行（先在 anpio-collab 建好 agent）：

```bash
COLLAB_RUNTIME_TOKEN=... COLLAB_EMBEDDED_SECRET=... \
  npm run agents -- --agent examples/local-chat.json
```

验收：本地逐字输出；平台发消息后同一进程起一个平台 thread，本地对话不被阻塞；平台消息的 thread 与本地 thread 各自延续；平台定义未被修改；重启后 thread 历史仍在。

## 16. 风险

- 平台信箱能否在没有 run 的情况下长期订阅（需真实平台验证一次）。
- `AgentStore` 迁移与 ANP 共用：v2 默认值保持 `anp`。
- 来源 ack 与本地租约双写的一致性：两边都幂等，来源失败时租约到期重投。
- 不同供应商 SSE 细节：单测覆盖分块、CRLF、回退。

## 17. 一个假设

平台侧只通过信箱订阅消费消息，不创建 platform run 记录。任务动作（`task_submit`、评论、文件）仍通过工具完成。如果必须保留 run 记录，以后用 `beginTurn` 钩子加，不去抢 supervisor 的 run。
