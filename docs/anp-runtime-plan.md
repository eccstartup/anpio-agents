# anpio-agents：常驻多 Agent、ANP 协作与隔离方案


## Context

现在的执行引擎是「一次运行 = 一个 Session」：

```text
supervisor → AgentRuntime → AgentSession（runId）→ 信箱 → 模型循环 → 工具 → finish
```

`runId` 同时是账本文件、信箱 `run:<runId>`、工作目录、工具 operationId、子进程配置和事件流的身份；Session 结束就删目录。因此它天然是「被平台叫醒跑一轮」，不是持续存在、可被反复唤醒的智能体；一个 agent 无法同时拥有多个互不打扰的长期会话；多 agent 只能靠每个进程一个 `--serve`，没有路由层。

目标是把执行引擎改造成一个**常驻的 ANP 智能体运行时**：

- 一个 router 进程托管多个 agent，agent 之间只通过**签名过的 ANP 消息**交互；
- 每个 **thread** 对应一个长期存活的 Session，Session 由多个 Turn 组成，工作目录和上下文跨 Turn 保留；
- 每个 agent 有独立存储、工作目录、DID 身份和进程/容器边界；
- 定时器只负责把任务投递进 thread，agent 不会「无缘无故自己醒来」；
- agent 可以创建子 agent、调用工具、按策略访问网络。

平台路径（anpio-collab）和现有 standalone 路径保持行为不变，新能力走独立入口 `npm run router`。router 默认不依赖 collab；四种运行形态（内嵌执行器 / 单 agent 独立 / 多 agent 常驻 / router 接入 collab）的边界与对接方式见第 14 节。

**ANP 层不再手写密码学**：直接使用 `@anpio-cli/core`（DID:WBA、RFC 9421、ADP、发现、消息信封）和 `@anpio-cli/service`（完整的 ANP-09 消息服务），不引入 `@connectx-sdk/core`。

## 1. 目标形态

```text
外部 ANP 请求 / 定时任务 / 管理 API
                │
                ▼
┌──────────────────────────── router 进程 ────────────────────────────┐
│ DID/ADP/发现/管理 HTTP   /agents/<id>/did.json、/ad.json、well-known │
│ ANP 消息服务（嵌入）      @anpio-cli/service：/anp-im/rpc、stream    │
│ RouterStore              router.db：agent 注册表、thread、session、   │
│                          turn、schedule、子 agent                     │
│ Dispatcher               目标解析、本地投递、唤醒 AgentHost            │
│ Scheduler                持久化定时器，到点把任务投进 thread           │
│ KeyVault                 agent 的 DID 私钥只在这里                     │
└──────────────────────────────┬───────────────────────────────────────┘
                               │ 内部调用（进程内，不经过 HTTP）
                               ▼
┌────────────────────── AgentHost <agentId> ───────────────────────────┐
│ AgentStore      agents/<id>/agent.db：thread 镜像、inbox、outbox、    │
│                 turn、审计、笔记                                       │
│ Workspace       agents/<id>/workspace：长期文件与 thread 子目录        │
│ AgentRuntime    定义、Brain、工具、并发控制（复用现有实现）            │
│ AnpTurnSession  thread 级长期上下文；同一 thread 同时只跑一个 Turn     │
│   └─ Turn       现有模型循环：inbox → 模型/工具 → outbox → ack         │
└──────────────────────────────────────────────────────────────────────┘
```

### 概念边界

| 概念 | 含义 | 生命周期 |
| --- | --- | --- |
| Agent | 一个有 DID、定义、存储、工作目录和策略的执行身份 | 常驻，直到被停用/删除 |
| Thread | 一次协作/任务上下文，由 `threadId` 标识 | 长期，可归档 |
| Session | 某个 agent 在某个 thread 上的执行上下文 | 随 thread 长期存活；进程可回收后从 DB 重建 |
| Turn | 一次模型循环，由一条或多条消息触发 | 一次 `runId`，保留 `runId` 兼容字段 |
| Message | ANP 业务消息，是 agent 之间唯一的共享记录 | 持久化，按 thread 归档 |

**Agent 的个人行为（思考、工具调用、中间输出）不进入 thread 历史**；它们只进 `tool_audit` 和运行日志。模型看到的 thread 历史完全由 ANP 消息构成。

## 2. 存储与数据空间

### 2.1 存储选型

使用 Node 内置 `node:sqlite`（`DatabaseSync`；本机 Node 26.7 已验证）：

- 零外部运行时依赖；
- WAL + `busy_timeout=5000` + `BEGIN IMMEDIATE` 支持 router 与多个 Turn 子进程并发读写；
- 单文件备份，单 agent 数据可整体搬走；
- 以后上多机只需替换 `RouterStore` 实现，端口不变。

封装在 `src/store/sqlite.ts`：`journal_mode=WAL`、`busy_timeout=5000`、`foreign_keys=ON`，提供 `tx(fn)` 与 `migrate()`。`@anpio-cli/service` 内部也用 `node:sqlite`，两边各自管理自己的库，不共享连接。

### 2.2 三个数据库

| 库 | 位置 | 内容 | 归属 |
| --- | --- | --- | --- |
| RouterStore | `<root>/router.db` | agent 注册表、thread/成员、session 索引、turn 索引、schedule、子 agent 关系 | 本仓库 |
| ANP 服务库 | `<root>/anp/service.db` | `messages`、`deliveries`、幂等台账、HTTP nonce、groups/attachments（未用） | `@anpio-cli/service` |
| AgentStore | `<root>/agents/<id>/agent.db` | thread 镜像、inbox、outbox、turn、tool_audit、notes、context 游标 | 本仓库 |

消息总线由 ANP 服务库持有，因为它是投递权威；agent 侧只保留自己的收件镜像。发送/接收都按 `message_id` 幂等写入两边，**不做跨库事务**。ANP 服务的 `deliveries` 永不裁剪，但 `sync.delta` 只有 30 天可读窗口——所以 agent 的本地 inbox 是长期权威，服务游标只是扫描位置。

### 2.3 数据空间长什么样

```text
<root>/
├── router.db                       # 控制面：注册表、thread、session、调度
├── router.log
├── anp/
│   ├── service.db                  # ANP 消息服务（投递权威）
│   └── objects/                    # 附件对象目录（v1 不使用）
└── agents/
    └── <agentId>/
        ├── agent.json              # 规范化定义 + ANP 元数据
        ├── key.json                # Ed25519 私钥 + DID + keyid（0600）
        ├── agent.db                # 数据面：inbox/outbox/turn/审计/笔记
        ├── workspace/              # agent 可见的文件根
        │   ├── AGENTS.md           # 角色、工具、环境说明
        │   ├── NOTES.md            # 跨 thread 的长期笔记
        │   └── threads/<threadId>/ # 该 thread 的工作文件
        └── logs/<date>.jsonl       # 运行与工具审计日志
```

- `key.json` 与 `agent.db` 不挂进容器；容器只看到 `workspace/`（或其中的 thread 子目录）。
- 一个 agent 的整个数据空间就是 `agents/<agentId>/`；删除/备份/迁移都以这个目录为单位。
- 不同 agent 之间没有共享文件夹；共享只通过 ANP 消息（文件用附件，v1 不做）。

### 2.4 关键表

`router.db`：

```text
agents(agent_id PK, name, definition_json, did, enabled, created_at, updated_at)
threads(thread_id PK, owner_agent_id, title, state, created_at, updated_at)
thread_members(thread_id, agent_id, role, joined_at, PK(thread_id, agent_id))
sessions(session_id PK, agent_id, thread_id, state, active_turn_id,
         heartbeat_at, next_seq, created_at, updated_at,
         UNIQUE(agent_id, thread_id))
turns(turn_id PK, session_id, agent_id, thread_id, run_id, status,
      started_at, finished_at, summary, error, trigger_message_id)
schedules(id PK, owner_agent_id, kind, expr, payload_json, target_thread,
          state, next_run_at, runs, max_runs, catch_up, created_at)
schedule_fires(schedule_id, scheduled_at, PK(schedule_id, scheduled_at))
agent_links(parent_id, child_id, depth, created_at, ttl_at, state)
```

`agent.db`：

```text
threads(thread_id PK, title, state, last_seq, updated_at)
messages(message_id PK, thread_id, direction, sender_did, target_did,
         content_type, body_json, reply_to, created_at)
inbox(message_id PK, thread_id, sender_did, target_did, content_type,
      body_json, reply_to, received_at, status, attempts, retry_at, lease_until)
outbox(message_id PK, thread_id, target_did, content_type, body_json,
       reply_to, created_at, attempts, next_attempt_at, sent_at, service_json)
turns(turn_id PK, thread_id, run_id, status, started_at, finished_at,
      summary, error, prompt_tokens, completion_tokens, trigger_message_id)
tool_audit(id PK, turn_id, tool, args_hash, status, duration_ms, effect_id, created_at)
effects(scope, operation_id, result_json, created_at, PK(scope, operation_id))
notes(key PK, value, updated_at)
context_state(session_id PK, last_seq, updated_at)
```

## 3. ANP 层（基于 anpio-cli）

### 3.1 依赖与范围

```json
{
  "dependencies": {
    "@anpio-cli/core": "file:../anpio-cli/packages/core",
    "@anpio-cli/service": "file:../anpio-cli/packages/service"
  },
  "overrides": {
    "@anpio-cli/core": "file:../anpio-cli/packages/core"
  }
}
```

- 两个包都是 `0.0.0` 且未发布；`service` 依赖 `@anpio-cli/core: "*"`，所以必须用根 `overrides` 把它指回本地路径。P0 先验证 `npm install`；若 lockfile 解析失败，退回 `npm pack` 生成 `vendor/anpio-cli-{core,service}-0.0.0.tgz` 并用 `file:vendor/...`。
- 两个包都需要先 `npm --prefix ../anpio-cli run build`（仓库里已带 `dist`）；`file:` 依赖不会替你构建。
- `@anpio-cli/service` 声明 `engines.node >= 24.16.0`。仓库现有的 `engines.node >= 22.18` 不改；`src/router/main.ts` 启动时检查版本，不满足直接报错并说明只有 router 入口需要。
- **不使用** `@connectx-sdk/core`，也不自己实现 JCS/Ed25519/Multibase/RFC 9421。

实际用到的 API：

| 来源 | 用途 |
| --- | --- |
| `@anpio-cli/core` | `createAnpIdentity`、`identityDid`、`didToUrl`、`buildAgentDescription`、`agentDescriptionService`、`buildAgentDescriptionIndex`、`buildMessageRequest`、`buildOriginProofAuth` / `signOriginProof`、`ed25519OriginProofSigner`、`parseCapabilities`、`ANP_MESSAGE_SERVICE_TYPE`、`AGENT_DESCRIPTIONS_PATH` |
| `@anpio-cli/core/advanced` | `buildBaseDidDocument`、`signDidDocumentProofSync`（重建带 service 的 DID 文档） |
| `@anpio-cli/service` | `loadConfig`、`openStorage`、`createDispatch`、`createServer`、`buildServiceEntry`、`serviceCapabilities`、`RPC_PATH`、`WELL_KNOWN_PATH` |

范围：ANP-03 DID:WBA、ANP-07 ADP、ANP-08 发现、ANP-09 `direct.send` / `direct.incoming` / `sync.delta` / `anp.get_capabilities`。不做 groups、E2EE、附件、跨域联邦、AP2/支付、治理。`anp.negotiate` 在规范里有、但 `@anpio-cli/service` 没实现，v1 不调用。

### 3.2 身份与端点

每个 agent 一个 path-type DID：

```text
did:wba:<host[:port]>:agents:<agentId>:e1_<fingerprint>
```

`didToUrl` 会把它解析到 `https://<host>/agents/<agentId>/e1_<fingerprint>/did.json`（host 里的 `:` 在 DID 中写成 `%3A`）。

生成方式（`createAnpIdentity` 在 DID 生成前就要求传入 service，无法引用刚生成的 DID，所以分两步）：

```ts
const identity = createAnpIdentity(host, { path: ['agents', agentId] });
const did = identity.did;
const services = [
  agentDescriptionService(adpUrl, did),
  { id: `${did}#anp-message-service`, type: ANP_MESSAGE_SERVICE_TYPE,
    serviceEndpoint: `${publicUrl}${RPC_PATH}` /* 生产可加 serviceDid */ },
];
const didDocument = buildBaseDidDocument({
  did, keyid: identity.keyid,
  publicKeyMultibase: identity.publicKey.publicKeyMultibase,
  service: services,
});
didDocument.proof = signDidDocumentProofSync(didDocument, identity.keyid, identity.priv);
```

`key.json` 存 `{ did, keyid, priv: base64url, publicKeyMultibase, createdAt }`，权限 `0600`，目录 `0700`。启动时用 `buildBaseDidDocument` + `signDidDocumentProofSync` 重建文档，保证 service 条目与当前配置一致。

端点：

| 路径 | 监听器 | 作用 |
| --- | --- | --- |
| `GET /agents/<id>/<fingerprint>/did.json` | router | DID 文档（含 proof、Ed25519 Multikey、AgentDescription / ANPMessageService service） |
| `GET /agents/<id>/ad.json` | router | AgentDescription（ADP） |
| `GET /.well-known/agent-descriptions` | router | 该 host 下所有启用 agent 的 `CollectionPage` |
| `POST /anp-im/rpc` | ANP 服务 | ANP-09 JSON-RPC |
| `GET /anp-im/stream` | ANP 服务 | 流式订阅（v1 不接） |
| `GET /.well-known/anp-message-service.json` | ANP 服务 | 服务能力入口 |
| `GET /health` | router | 健康快照 |
| `GET /admin/*` | router | 管理接口（Bearer admin token，默认只绑回环） |

ADP 的 `proof` 在 ANP-07 里是**可选**的；`@anpio-cli/core` 只透传、不验签。v1 先发布不带 proof 的 ADP（字段完整、`did`/`url`/`security`/`interfaces` 准确），需要时再加。发现索引条目用 `{ "@type": "ad:AgentDescription", name, "@id": adpUrl }`。

开发环境用 `http://127.0.0.1:<port>`，并给服务的 DID 解析开 `allowPrivateHosts` / `allowInsecureTransport`；生产必须 HTTPS + 域名。DID 的 host 必须与 `didBaseUrl` 一致，否则 `didToUrl` 解析不到文档。

### 3.3 两个监听器与嵌入方式

`@anpio-cli/service` 的 `createServer` 只认固定路径，未知路径 404，没有扩展钩子。因此 router 进程起**两个 HTTP 监听器**：

- **A：ANP 消息服务**（默认 `127.0.0.1:8787`）：`loadConfig()` + `openStorage({path: <root>/anp/service.db})` + `createDispatch()` + `createServer({config, handleRpc, wellKnown})`。不需要 `relay`、`handleStream`、`handleUpload`、`handleObject`、delivery worker——v1 只做本机投递。
- **B：router 自己的 HTTP**（默认 `127.0.0.1:8788`）：DID/ADP/发现/health/admin。

生产放在同一个 TLS 反向代理后面：`/anp-im/*` 与 `/.well-known/anp-message-service.json` 转 A，其余转 B；`publicUrl` 与 `didBaseUrl` 都是 `https://agents.example.com`。开发时两者端口不同，`publicUrl` 指向 A、`didBaseUrl` 指向 B，DID 文档里的 `serviceEndpoint` 指向 A——`isOurOwnIngress` 只比较 `serviceEndpoint` 与 `config.publicUrl + RPC_PATH`，所以仍然判定为本地。

配置不手写 `Config` 对象，而是把 router 配置映射成 `ANPIOCLI_*` 环境变量后调用 `loadConfig()`（字段见 `packages/service/src/config.ts`），避免跟着它的必填字段漂移。v1 不配 `ANPIOCLI_KEY_FILE`：没有 relay，就不需要服务自己的外层签名钥。

### 3.4 认证与本地投递

- 入站 `direct.send` / `sync.delta` 的业务认证由服务的 `authenticate` 完成：校验 envelope 里的 `origin_proof`（content-digest、签名、keyid 所属身份 == `meta.sender_did`、时间窗），nonce 在 dispatch 里一次性消费。
- **本地投递不走 HTTP**：router 直接调用自己传给 `createServer` 的 `handleRpc`，并且**不传 `method`**——这是进程内调用，不是一次 HTTP 请求，外层 RFC 9421 认证整段跳过，业务层 `origin_proof` 照常校验（和 service 自己的 stream 帧同一语义）。

```ts
const answer = await handleRpc({
  body: JSON.stringify(request),      // buildMessageRequest 的结果
  headers: {},
  url: new URL(`${config.publicUrl}${RPC_PATH}`),
  // 不传 method
});
```

这样没有回环跳转，也没有 `@target-uri` / `@authority` 不匹配的问题。

- **不配置 relay**：`relayFor` 对非 relay 方法直接返回 LOCAL，所以 `direct.send` 无论目标 DID 在哪都会被本地收下。因此 router 的出站工具必须**先校验目标是本机注册表里的 agent**，否则拒绝（`unroutable`）。跨域投递不在 v1 范围内，后续接 `createRelay` + egress 时再放开。
- 外部调用方仍然正常访问 `publicUrl + /anp-im/rpc`；服务从 `meta.sender_did` 解析对方 DID 文档，受 `didResolution.allowedHosts` 与私网限制约束。

### 3.5 消息与 thread 映射

统一用 ANP-09 `direct.send`，`content_type: application/json`，正文必须且只能有 `text` / `payload` / `payload_b64u` 之一：

```ts
const body = {
  payload: {
    type: 'anp.task.request' | 'anp.task.result' | 'anp.chat.message' | 'anp.control.*',
    task_id?: string,
    title?: string,
    text?: string,
    data?: unknown,
  },
  conversation_id: threadId,   // 线程 id
  reply_to?: messageId,
};
```

- `direct.send` 不检查未知字段，`incomingParams` 又原样保留 `body`，所以 `conversation_id` / `reply_to` 能完整到达收件人。
- `direct.send` 的 payload 规则：`application/json` 必须是 `payload` 对象；纯文本用 `text` + `text/plain`。任务消息统一用 JSON。
- thread 由 `body.conversation_id` 决定；缺省用 `message_id` 建一次性 thread（1 小时后归档，不进长期工作区）。
- 收件规则：显式 `meta.target.did` 只投给该 agent；thread 消息需要 `thread_members` 里已有双方，否则 router 先补成员再投。
- 出站：`anp_send` 写 `outbox`，再构造 `buildMessageRequest({ id, method: 'direct.send', meta, body, auth })`；`auth` 由 `buildOriginProofAuth(signOriginProof({ method, meta, body, signer: ed25519OriginProofSigner(priv, keyid) }))` 生成。投递成功后标 `sent_at`；失败按 1s/5s/30s/5m/30m 退避。
- 回复：模型可显式调 `anp_reply`；没有调用但循环自然结束时，把最后一段 assistant 文本作为 `anp.chat.message` 回复到触发 thread（与 `completion: 'text'` 对齐）。

### 3.6 邮箱、游标与历史

`AnpMailbox` 实现现有 `MailboxPort`，并增加可选方法 `resume(sessionKey)`、`renew(sessionId, leaseSeconds)`、`pending(sessionId)`：

- `sync()`：以 agent 身份调用 `sync.delta { since: cursor, limit: 100 }`，把 `direct.incoming` 的 `params` 拆成 `meta` / `body`，按 `message_id` `INSERT OR IGNORE` 进 `agent.db.inbox`，然后推进 `context_state.last_seq = next_since`。`has_more` 时继续拉。
- `pull()`：从本地 `inbox` 取 `pending` 或 `retry_at` 到期的行，按 `seq` 升序，发租约；不直接依赖服务的 `deliveries`。
- `ack` / `nack`：只改本地状态。服务侧没有 ack 概念，30 天窗口过后 `sync.delta` 自然不再返回；本地 inbox 才是权威。
- 游标丢失时从 0 重新拉 30 天内的消息，靠 `message_id` 去重；不会重复处理。
- `open` 用 `session:<sessionId>` 标签幂等打开；`close` 只处理本轮租约，不 ack 该 session 的全部待处理消息。
- 唤醒：router 包装的 `handleRpc` 在返回 `accepted` 后，按目标 DID 找 AgentHost 并 `wake(threadId)`；另有 5 秒兜底轮询（`sync.delta` 是拉模型，没有推送）。

历史来源只有 `agent.db.messages`：

- 入站消息在 `sync` 时写入（`direction='in'`），出站在 `anp_send` 时写入（`direction='out'`）；
- 按 `thread_id, created_at` 读取，渲染成 user/assistant 文本；
- `tool_audit`、中间推理、运行日志都不进历史；
- 超预算时保留第一条任务消息 + 最近 60 条 / 256 KiB，旧消息折叠成一行「省略 N 条较早消息」；不做自动模型摘要。

这正是「agent 的个人行为不记录历史，agent 的交互通过 ANP 消息记录」。

## 4. 长期存活的 Session 与 Turn

### 4.1 键与状态机

- 默认 `thread:<threadId>`；工单模式用 `ticket:<taskId>`；无 thread 的一次性消息用 `msg:<messageId>`。
- `sessionId = 'sess-' + sha256(agentId + '\n' + sessionKey).slice(0, 32)`，重启后同键直接寻回同一 workspace。
- 每次唤醒生成 `turnId`，同时写一个 `runId` 到 `turns.run_id`，复用现有日志、工具 operationId 与 `finish` 约定。
- 状态：`created → idle → running → idle … → archived`。`UPDATE sessions SET state='running', active_turn_id=?, heartbeat_at=? WHERE id=? AND state IN ('created','idle')` 做 CAS；抢不到就保留消息等下一次唤醒。
- 一个 session 同时只有一个 Turn；不同 session 可并发。全局 `maxActiveTurns` 默认 CPU×2，每 agent 再受 `concurrency` 限制。
- router 启动时把 `running` 且心跳超过 90 秒的 session 改回 `idle`，未 ack 的 inbox 行重新变为 `pending`。

### 4.2 一次 Turn

```text
wake(thread)
  → CAS 抢占 session
  → sync.delta 补拉 + 从本地 inbox 取本轮消息（租约 300s，周期续租）
  → 用 thread 历史 + 本轮消息构造上下文
  → 模型循环（最多 limits.maxTurns，调用工具）
  → anp_reply / 自然结束：写 outbox 并投递
  → ack 触发消息；失败 nack（普通 300s，outcome_unknown 3600s）
  → 写 turns 行，session 回 idle，保留 workspace
```

- 不接受「部分 ack」：一轮要么全部 ack，要么全部 nack，避免半成功语义。
- Turn 超时由 `limits.timeoutMs` 控制；中止后 nack，session 回 idle。
- 重启后 `idle` 的 session 不主动跑；有新消息才唤醒。

### 4.3 代码复用

- 新增 `src/runtime/brain-loop.ts`：把 `AgentSession` 里的模型循环抽成纯函数（输入 Brain、工具、消息、限额；输出 summary / token / 工具执行标记）。`src/runtime/session.ts` 改为调用它，日志与行为逐字不变，由现有测试兜底。
- 新增 `src/runtime/anp/session.ts`（`AnpTurnSession implements SessionTask`），只依赖 ports，不复用 `AgentSession` 的目录删除与 `run:<runId>` 信箱语义。
- `src/runtime/agent.ts` 增加可选 `createSessionTaskFactory`；默认分支不变，router 注入 `AnpTurnSession` 工厂。
- `src/runtime/local/mailbox.ts` 不动（它「open 总是新 session、close ack 未决」的行为被 `tests/local-transport.test.ts` 钉死）。
- 平台 supervisor 的 `recover` 不动；ANP 的恢复由 router 自己做。

### 4.4 目录

```text
<root>/agents/<agentId>/
  agent.db
  key.json
  workspace/
    AGENTS.md
    threads/<threadId>/          # 持久，Turn 结束不删
  logs/<turnId>.log              # 仅诊断，默认关
```

Turn 的临时 IPC 目录放 `sessions/<sessionId>/`，不放容器；容器只挂 `workspace/threads/<threadId>`。

## 5. Router 与调度

### 5.1 进程与生命周期

- 入口 `src/router/main.ts`，配置 `router.json` 或 `ANP_*` 环境变量；`src/router/config.ts` 校验。
- `<root>/router.lock` 单实例锁（pid + 启动时间，检测 stale）。
- 加载 `agents.json`（字段同 `EmbeddedAgentDefinition`，新增 `anp` 段）→ 确保身份 → 生成 DID/ADP → 建 `AgentRuntime`（root 指向 `agents/<id>`）→ 启动 AgentHost。
- 热更新：文件 mtime 变化 → 校验 → 空闲时替换 runtime；进行中的 Turn 用旧定义跑完。
- 单个 AgentHost 崩溃不影响其他；router 记录错误并重启该 host。

### 5.2 确定性路由

1. 显式 `to`（DID 或 `agent:<id>`）命中注册表；
2. thread 已有 owner；
3. 能力匹配：ADP 的 `capabilities` / `interfaces` 与消息 `skills` 求交集，精确 tag > 前缀 > 描述关键词，同分按 agentId 字典序；
4. 配置的 `defaultAgent`。

v1 不用模型路由；预留 `routing.strategy: 'model'`，以后只在候选集内做一次低成本选择。

### 5.3 调度

定时器只做「把任务投进 thread」：

- `schedules`：`kind: at | interval | cron`、`next_run_at`、`catch_up: skip | once | all`、`payload_json`、`target_thread`、`max_runs`。
- tick 每秒取到期最多 50 条，`BEGIN IMMEDIATE` 里先推进 `next_run_at` / 置 `firing`，再写消息；`schedule_fires(schedule_id, scheduled_at)` 唯一键防重。
- `message_id = schedule:<scheduleId>:<fireAt>`，`INSERT OR IGNORE` 幂等。
- 重启后按 `catch_up` 补投；默认 `skip`。
- 限制：每 agent `maxSchedules` 默认 20，最小间隔 60 秒。
- agent 侧只有 `schedule_create` / `schedule_cancel` / `list_schedules`，只能操作自己的 schedule，且定义里 `anp.allowSchedules` 必须为 true；agent 不能直接写表，也不能给自己设「提醒」。

## 6. 工具、子 agent 与联网

### 6.1 工具清单

在现有本地原语之外新增（注册在 `src/tools.ts`，实现放 `src/tools/anp.ts` / `subagent.ts` / `net.ts`）：

| 工具 | 作用 |
| --- | --- |
| `anp_send` | 向本机 agent / DID 发一条 ANP 消息（可指定 thread） |
| `anp_reply` | 回复触发消息所在的 thread |
| `anp_list_messages` / `anp_get_message` | 查自己的 thread 消息 |
| `list_agents` / `agent_status` | 查注册表与子 agent 状态 |
| `spawn_agent` | 创建子 agent |
| `schedule_create` / `schedule_cancel` / `list_schedules` | 管理自己的定时任务 |
| `http_fetch` | 受策略限制的 HTTP 请求 |
| `memory_get` / `memory_set` | 读写自己的 `notes` |
| `finish_turn` | 结束本轮并给出摘要 |

工具可用性 = 定义 `tools` ∩ 运行时策略 ∩ 传输层支持；缺工具时启动校验并明确报错，沿用 `missingTools` 语义。平台工具在 ANP 模式默认不可用。

operationId：Turn 内用 `turn:<turnId>:<callId>`；agent 级操作（spawn/schedule）用 `agent:<agentId>:<callId>-<hash>`。`effects(scope, operation_id)` 唯一键保证重放返回首次结果。

### 6.2 子 agent

`spawn_agent({ name, description, capabilities, tools, ttlMs, maxTurns })`：

- 父定义需 `anp.allowSpawn: true`，默认 false；
- 深度默认最大 2，每个父 agent 子 agent 默认最多 3；
- **工具只能收缩**：子 agent 的 `tools` 必须是父 agent 的 `tools` 的子集；网络策略、文件根、并发数同理；
- 生成独立 Ed25519 身份与 DID（`did:wba:<host>:agents:<parentId>:<childId>:e1_...`），存储 `agents/<childId>/`，workspace 在父的 `workspace/subagents/<childId>/`；
- 与父通过同一 thread 的 ANP 消息协作；`ttl_at` 到期或父 `agent_stop` 后归档 session，workspace 保留；
- router 每 60 秒扫描过期的 `agent_links`。

### 6.3 联网

- `anp.network: none | egress | open`；默认 `egress`，allowlist 默认空。
- `http_fetch` 只允许 allowlist host；DNS 解析后校验 IP，拒绝回环、RFC1918、link-local；禁止 `file://` / `data:`；超时 30 秒，响应 ≤1 MiB，重定向最多 3 次。
- 进程模式只能做工具级限制与 env 清洗（shell 仍可能联网，文档写明）；容器模式用 `--network none` 或 allowlist 代理真正兑现。
- 出站记 `tool_audit`（host、status、bytes），不记 body。

## 7. 进程与容器隔离

| 级别 | 边界 | 适用 |
| --- | --- | --- |
| `inline` | 同进程，仅逻辑隔离 | 开发、脚本 agent |
| `process` | 每个 Turn 一个 `src/session.ts` 子进程 | 默认的 ANP 运行方式 |
| `container` | 每个 session 一个容器，只执行工具 | 不可信工具、强隔离 |

容器模式的关键取舍：**主机侧仍跑 `AnpTurnSession`（模型循环、ANP 签名、DB），只有 shell / 文件工具在容器里执行**。DID 私钥、模型密钥、平台令牌都不进容器；模型推理不是不可信代码，工具副作用才是。

```bash
docker run --rm -d \
  --name anp-<sessionId> \
  --label anp.session=<sessionId> --label anp.agent=<agentId> \
  --network none \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --user 10001:10001 \
  --cap-drop ALL --security-opt no-new-privileges \
  --pids-limit 256 --memory 1g --cpus 1 \
  -v <workspace>/threads/<threadId>:/workspace:rw \
  node:24-bookworm-slim
```

- 执行通道：host 启动 `container/exec.ts`（stdio JSON-RPC），经 `docker exec -i` 调用；每 turn 一个 32 字节短期 token，turn 结束失效。
- 工具映射：`shell` → 容器 `/bin/sh -lc`，cwd `/workspace`；`read_file` / `write_file` / `list_files` → 容器内 helper，路径限制 `/workspace`；`http_fetch` 在主机侧执行，便于 SSRF 校验与审计。
- `--network none` 时 `http_fetch` 仍可用（主机侧执行）；shell 不能联网。需要 shell 联网时用自定义 bridge + allowlist 代理。
- 不挂 docker socket，不 `--privileged`，不挂 host 根目录；容器运行时缺失时启动报错，除非 `--allow-missing-container`。
- 文档写明：容器隔离的是「工具执行」，不是「模型推理」。

## 8. 分阶段实施

原则：每阶段独立提交、可回滚；平台路径行为不变，现有测试全绿。

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| **P0 依赖与存储底座** | anpio-cli `file:` 依赖 + overrides、构建检查、`src/store/*`（迁移、WAL、事务） | `npm install` 成功；迁移幂等；并发读写不丢 |
| **P1 身份与公开面** | `src/anp/identity.ts`、`description.ts`、`did-server.ts`；DID/ADP/发现/health | 用 `verifyDidDocument` 自验 DID proof；发现索引分页有界 |
| **P2 嵌入 ANP 服务** | `src/anp/service.ts`：映射 `ANPIOCLI_*`、`createDispatch` + `createServer`；`handleRpc` 包装与唤醒钩子 | 外部签名 `direct.send` 被接受；重复 `message_id` 幂等；nonce 重放被拒 |
| **P3 邮箱与本地投递** | `AnpMailbox`、`sync.delta` 拉取、inbox/outbox、游标、租约 | 两个 agent 在一个进程内互发；重启后不重复处理已 ack 消息 |
| **P4 长期 Session/Turn** | 抽取 `brain-loop`、`AnpTurnSession`、sessions/turns 表、workspace、恢复、history | 同一 thread 多轮复用 workspace；重启继续；历史不含工具调用 |
| **P5 Router 多 agent** | registry、AgentHost、确定性路由、管理/健康、单实例锁 | 一个进程托管 ≥2 个 agent；按 DID/能力路由；单 agent 崩溃不影响其他 |
| **P6 协作工具与子 agent** | `anp_send/reply/list`、`spawn_agent`、工具收缩、`http_fetch` | 子 agent 深度/数量/工具子集受限；父能收到子回复 |
| **P7 调度** | `schedules`、tick、catch-up、幂等 fire、`schedule_*` 工具 | once/cron 只触发一次；重启不重复；默认 skip |
| **P8 容器隔离** | 工具执行容器、网络策略、资源限制、镜像 | 容器内无 key/token；workspace 可写；默认无网络；无 Docker 时明确跳过 |
| **P9 文档与端到端** | README、示例、两 agent + 定时任务 e2e | `npm test`、`npm run check` 全绿；脚本 agent 离线可复现 |

建议顺序：P0 → P1 → P2 → P3 是「单 agent 长期存活 + ANP 交互」的最小闭环；P4 起进入多 agent；P7/P8 可按需要提前。

## 9. 文件边界

| 处理 | 文件 |
| --- | --- |
| 新增 | `src/store/sqlite.ts`、`src/store/migrate.ts`、`src/store/router-store.ts`、`src/store/agent-store.ts`、`src/anp/identity.ts`、`src/anp/service.ts`、`src/anp/client.ts`、`src/anp/description.ts`、`src/anp/did-server.ts`、`src/runtime/brain-loop.ts`、`src/runtime/anp/{session,mailbox,context,ledger}.ts`、`src/tools/{anp,subagent,net}.ts`、`src/router/{main,config,registry,agent-host,delivery,routing,scheduler,admin,container,lock}.ts`、`container/{Containerfile,exec.ts,build.sh}`、`examples/anp/{agents.json,router.local.json}`、`tests/{store,anp-identity,anp-service,anp-mailbox,thread-session,router,scheduler,container}.test.ts` |
| 改动 | `src/runtime/session.ts`（改为调用 `brain-loop`）、`src/runtime/agent.ts`（可选 `createSessionTaskFactory`）、`src/runtime/transport.ts`（可选 `resume` / `renew`）、`src/definition.ts`（`anp` 段、`container` 隔离级别）、`src/tools.ts`（注册新工具，默认不启用）、`src/sandbox.ts`（长期 workspace helper）、`package.json`（依赖、`router` / `anp:send` 脚本）、`README.md` |
| 不动 | `src/client.ts`、`src/supervisor.ts`、`src/agent-worker.ts`、`src/runtime/local/*`、`src/standalone/*`、`src/brains/*`、`src/token.ts`、平台协议与鉴权；平台路径的日志、退出码、消息退回语义不变 |

## 10. 测试与验证

### 自动化

- `tests/store.test.ts`：迁移幂等、WAL 并发、`BEGIN IMMEDIATE` 争用、lease 过期、outbox 去重。
- `tests/anp-identity.test.ts`：DID 文档自验、ADP 必填字段、发现索引、非白名单 host 拒绝。
- `tests/anp-service.test.ts`：嵌入服务接受签名 `direct.send`、幂等、nonce 重放、未知 target、`sync.delta` 分页与 30 天窗口。
- `tests/anp-mailbox.test.ts`：游标推进、`message_id` 去重、租约、ack/nack、游标丢失后重拉。
- `tests/thread-session.test.ts`：同 thread 串行、不同 thread 隔离、重启恢复、history 不含工具调用。
- `tests/router.test.ts`：两个 agent 在一个 router 内互发、按 DID/能力路由、单 agent 崩溃不影响另一个、单实例锁。
- `tests/scheduler.test.ts`：at/interval/cron、catch-up、重复 tick 不重复、取消。
- `tests/container.test.ts`：`ANP_TEST_CONTAINER=1` 时验证无密钥环境变量、workspace 可写、默认无网络；否则跳过并打印原因。

### 回归

现有 `tests/runtime.test.ts`、`local-transport.test.ts`、`standalone*.test.ts`、`worker.test.ts`、`supervisor.test.ts`、`tools.test.ts`、`brains.test.ts`、`sandbox.test.ts` 原样通过；`npm run check` 零错误。

### 手工端到端

```bash
npm --prefix ../anpio-cli run build
npm install
npm run router -- --config examples/anp/router.local.json
```

```bash
curl -s http://127.0.0.1:8788/health
curl -s http://127.0.0.1:8788/.well-known/agent-descriptions
npm run anp:send -- --from planner --to worker --thread t1 --text "把这份目录整理成清单"
```

验收点：

1. worker 在自己的 thread 里回复，planner 能收到回复；
2. 重启 router 后继续发消息，thread 历史仍在，worker 不重复处理已 ack 的消息；
3. 2 秒后的定时任务只触发一次，重复启动 router 不重复触发；
4. `spawn_agent` 出的子 agent 只能使用父 agent 工具的子集；
5. 容器模式 `docker inspect` 看不到密钥环境变量，workspace 外不可写。

## 11. 风险与取舍

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| anpio-cli 是 `0.0.0` 未发布，`service` 依赖 `core: "*"` | 安装失败 / 版本漂移 | 根 `overrides` 指回本地；P0 验证；失败则 `npm pack` + `vendor/*.tgz` |
| `service` 要求 Node ≥24.16 | 与仓库 `>=22.18` 不一致 | 只对 router 入口做启动检查；平台/standalone 路径不变 |
| 服务固定路由、无扩展钩子 | 不能同端口挂 DID/ADP | 两个监听器；生产用反向代理按路径分流 |
| 无 relay 时 `direct.send` 一律本地收下 | 远端消息被误存 | router 先校验目标在本机注册表；跨域投递留到接 `createRelay` 后 |
| 两个 SQLite，无跨库事务 | 消息丢失或重复 | ANP 服务是投递权威，agent 库按 `message_id` 幂等；outbox + 重试 |
| 服务 `deliveries` 不裁剪、只 30 天可读 | 长期历史不可回拉 | 本地 inbox 是权威；游标丢失后靠 `message_id` 去重 |
| DID 私钥集中于 router | 单点信任 | `key.json` 0600、目录 0700；子进程/容器不拿 key；后续可接 KMS |
| 进程模式无网络隔离 | shell 可能连内网 | `http_fetch` 做 SSRF 校验；容器模式兑现；文档写明边界 |
| 容器只隔离工具 | 模型提示注入仍影响主机逻辑 | 容器内无密钥；工具输出截断；文档写明边界 |
| 长期 Session 上下文膨胀 | token 超限 | 60 条 / 256 KiB + 省略提示 + workspace 外置 |
| 调度至少一次 | 重复触发 | `schedule_fires` 唯一键 + `message_id` 幂等 + 默认 skip |
| `node:sqlite` 仍标记实验 | API 变化 | 集中在 `src/store/*`；启动加 `--disable-warning=ExperimentalWarning` |

## 12. 本计划的默认选择

1. **存储**：router 一个 SQLite、ANP 服务一个 SQLite、每个 agent 一个 SQLite；不用外部数据库。
2. **ANP 实现**：`@anpio-cli/core` + `@anpio-cli/service`（本地 `file:` 链接 + overrides）；不用 `@connectx-sdk/core`，不手写密码学。
3. **密钥保管**：DID 私钥只在 router；Turn 子进程和容器都不持有。
4. **路由**：确定性优先；模型路由是可选配置，不作为默认。
5. **历史**：thread 历史只来自 ANP 消息；工具调用只进审计日志。
6. **隔离默认值**：ANP 模式默认 `process`；`container` 按定义显式开启，且只隔离工具执行。
7. **调度**：只用于投递任务，agent 不能给自己设提醒。
8. **兼容**：平台路径和 standalone 路径不改行为；新能力从 `npm run router` 进入。
9. **对接**：router 默认独立运行；接 collab 用第 14 节的形态 D，只走 HTTP（ANP 登录 + `/v1`），不共享数据库。

## 13. 与 anpio-collab 的 ANP 收敛

原则：**规范只有一份实现（`@anpio-cli/core`）；collab 是消费者，不是第二份规范。**

两边角色不同，需要的 API 也不同：

| 仓库 | ANP 角色 | 需要的 API |
| --- | --- | --- |
| anpio-collab | 验签方：登录挑战、DID 抓取、RFC 9421 验证 | `verifyDidDocument`、`resolveVerificationKey`、`verifyHttpSignatureForServer`、`decodeMultibaseKey`、`didFingerprint`、`createNonceStore`、`parseSignatureInput`；`resolveDidDocument` 不用（它要求 `allowedHosts`，与开放联邦冲突） |
| anpio-agents router | 持有方 + 服务方：生成身份、签 DID 文档/ADP/origin proof、提供 ANP-09 服务 | `createAnpIdentity`、`buildBaseDidDocument`、`signDidDocumentProofSync`、`buildMessageRequest`、`signOriginProof`、`@anpio-cli/service` |

所以结论是**改 collab，不改这里的 agent 设计**：router 需要完整的产出/服务能力，collab 只有验证能力；反过来让 agent 依赖 collab 的 `src/anp/*` 会缺掉签名、DID 文档构建、ADP、ANP-09，等于重写 core。core 已经导出 `verifyDidDocument` / `resolveVerificationKey` / `verifyHttpSignatureForServer`，正好覆盖 collab 现在手写的密码学部分；`verifyAnpLoginRequest` 不适合 collab（它要求先有 nonce，且默认信任 inline 文档）。

兼容性已确认：collab 是 `type: module`、Node ≥22.18、直接跑 TS（无打包器）；core 是 ESM+CJS 双产物、Node ≥22.12、纯 JS 依赖（noble/scure）、`sideEffects: false`。没有运行时阻碍。

实施顺序（不阻塞 P0–P9）：

1. **现在**：router 用 core + service；collab 不动。两者只通过 ANP 规范对齐，不共享代码。
2. **一致性测试**：用 core 生成 golden vectors（DID 文档→解析结果、合法/非法登录签名、multibase、nonce 重放），两个仓库各跑同一组向量。成本最低，先做。
3. **core 可发布/可 vendor 后**：collab 把 `src/anp/{base58,did,signature}.ts` 的密码学部分换成 core；`src/anp/resolver.ts` 保留（core 的开放式抓取需要 `allowedHosts`，不适合 collab）；`src/anp/identity.ts` 保留 DID 字符串形状并补文档 proof；`/auth/anp/login` 路由与挑战流程不动。详见 `anpio-collab/docs/anp-convergence-plan.md`。
4. **需要跨域协作时**：collab 再从 core 取 `buildMessageRequest` + `signOriginProof` + `postMessage`，成为 ANP 客户端；到那时它才真正需要“发消息”的 ANP。

取舍：

- v1 不强迫 collab 迁移，因为 core 仍是 `0.0.0` 未发布；先把 router 的产出/服务能力跑通。
- 如果 collab 想减少依赖面，给 core 加一个 `@anpio-cli/core/verify` 子入口（只导出验签面），而不是 fork。
- 绝不把 collab 的 `src/anp/*` 复制进 agent 仓库，也不让 agent 实现去匹配 collab 的实现；契约是 ANP 规范本身。

## 14. 运行形态：独立运行与接入 anpio-collab

这一节回答「到底怎么跑、和 collab 是什么关系」。三种入口并存，共用同一个执行内核；**router 不要求 collab 才能启动**。

### 14.1 四种形态

| 形态 | 入口 | 控制面 | 身份 | 消息/任务来源 | 依赖 collab | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| A 内嵌执行器 | `npm run runtime` | anpio-collab HTTP v1 | collab 派生令牌 | collab 信箱 / 运行记录 | 是 | 已存在，行为不变 |
| B 单 agent 独立 | `npm run standalone` | 本地传输层 | 无 DID | CLI / `POST /runs` | 否 | 已存在，行为不变 |
| C 多 agent 常驻 | `npm run router` | router SQLite + 内嵌 ANP-09 | 每个 agent 自己的 DID:WBA | 外部 ANP 消息 / 定时任务 / 管理 API | 否 | 本计划新增 |
| D router 接入 collab | `npm run router -- --collab` | router + collab `/v1` | 每个 agent 自己的 DID，ANP 登录换 token | collab 任务/信箱 + ANP 消息 | 是（单向 HTTP） | 本计划预留，P10 |

- **A 是「collab 调度 agents」**：定义、派生令牌、运行账本都在 collab，agent 只是执行器；已有能力，不改。
- **B 是「单 agent 脱离平台跑一轮」**：本地传输层，无 DID；已有能力，不改。
- **C 是「agents 自己运行」**：没有 collab 也能启动、互发、定时、落盘；这是「单独作为 agents 运行」的目标形态。
- **D 是「agents 作为外部参与者接入 collab」**：agent 自己持有 DID 和定义，collab 只提供登录与任务协作，不接管运行。
- 四种形态共用 `AgentRuntime`、`brain-loop`、工具层、沙箱；差异只在控制面适配器。

### 14.2 依赖方向

```text
anpio-agents ──HTTP(/auth/anp/*, /v1/*)──▶ anpio-collab
      │
      └── @anpio-cli/core（ANP 规范实现）

anpio-collab ──HTTP(supervisor 协议，可选)──▶ anpio-agents
      │
      └── @anpio-cli/core（验签）
```

- 两个仓库**不共享代码、不共享数据库**；`anpio-agents` 不 import collab 的 `src/anp/*`，collab 也不 import 这里的代码。
- 共同契约只有两个：ANP 规范（core 实现）与 collab 的 HTTP v1。
- 「接入 collab」不改变 router 的 ANP 设计，只是多一个控制面适配器；反之，collab 换成 core 验签也不改变 supervisor 协议。

### 14.3 形态 C：完全独立

- 只需要 `examples/anp/agents.json` + 本地目录；不需要 `COLLAB_*`。
- DID host 由 `router.json` 的 `didBaseUrl` 决定；DID 文档、ADP、发现索引由 router 自己发布。
- agent 之间通过内嵌 ANP-09 服务互发；外部调用方只要能访问 `publicUrl` 就能参与。
- 定时任务、管理 API、子 agent 都在本地闭环。
- 验收：没有 collab、没有外网时，两个 script agent 仍能完成一轮协作。

### 14.4 形态 D：router agent 作为外部参与者接入 collab

目标：让 router 里的 agent 以独立 DID 登录 collab，使用 collab 的任务/协作能力；**不要求 collab 改协议**。

登录（复用 collab 现有能力）：

- 每个 agent 用自己的 `key.json` 的 DID；`GET /auth/anp/challenge` → 用 DID 私钥签 `{nonce, did, didDocument, client: 'agent', bindCode?}` → `POST /auth/anp/login` → Bearer token。
- token 缓存在 `agents/<id>/collab-session.json`（0600），到期前 60 秒重登；不写进 `agent.db`，不写进容器。
- collab 必须能取到 agent 的 DID 文档：`didBaseUrl` 对 collab 可达；开发环境 loopback 自动走 http，生产必须 HTTPS；`COLLAB_ANP_ENROLL=open` 或管理员已批准 / 已发绑定码。
- collab 的 DID 路径形状是通用的：`did:wba:<host>:agents:<agentId>:e1_<fp>` 会解析到 `<host>/agents/<agentId>/<fp>/did.json`，与 router 发布的路径一致；`handleFromDid` 得到 `agents.<agentId>@<host>`，不需要改 collab。

任务桥（P10，最小语义）：

- 新增 `src/router/collab/bridge.ts`：按 agent 轮询 `GET /v1/inbox`，把新的 subtask 写成 `anp.task.request` 进 thread `collab:subtask:<subtaskId>`；turn 结束后用 `POST /v1/subtasks/:id/submit` 写回结果（失败用 `reject`，中途可用 `progress`）。
- 映射表 `router.db.collab_links(agent_id, collab_task_id, collab_subtask_id, thread_id, state, last_seen_at)`；`collab_subtask_id` 唯一，重复拉取幂等。
- 复用 `src/client.ts` 的 `CollabClient`（它只要求 Bearer token，不关心 token 来源）做 `/v1` 调用，不复制任务接口。
- 只做「任务进、结果出」；不在 v1 复刻 collab 的运行账本、心跳、`recover`。

为什么不做成完整 transport：

- collab 的 mailbox/run 语义与 router 的 thread/turn 语义不同；强行一一映射会产生两套状态机。
- 把 D 限定为「任务桥」，边界清楚；bridge 故障时 agent 仍可只跑本地 ANP。
- 以后 collab 若实现 ANP-09 消息服务，D 可以退化成纯 ANP 对等，不再需要 `/v1` 桥。

状态与失败隔离：

- `router.json` 默认 `collab.enabled=false`；显式 `--collab` 才启用。
- 启动时先做一次 DID 文档自检（`didToUrl` → 本机 HTTP），再登录；登录失败只禁用该 agent 的 collab 能力，不影响本地 ANP。
- 日志前缀区分 `[anp]` 与 `[collab]`；任务桥的失败重试与 ANP outbox 分开记录。

### 14.5 四种形态的配置与身份对照

| 形态 | 关键配置 | 身份/凭据 | 密钥位置 |
| --- | --- | --- | --- |
| A | `COLLAB_BASE_URL`、`COLLAB_RUNTIME_TOKEN`、`COLLAB_EMBEDDED_SECRET` | collab 派生令牌 | 只在 worker 进程内存 |
| B | `AGENT_RUN_ROOT`、`provider.apiKeyEnv` | 无 DID | 模型密钥在进程环境 |
| C | `router.json`：`didBaseUrl`、`publicUrl`、`agentsFile` | 每个 agent 的 `key.json` | 只在 router 进程 |
| D | C + `collab.baseUrl`、`collab.enrollMode`、`collab.bindCode?` | C 的 DID + ANP 登录 token | DID 私钥只在 router；collab token 只在 `collab-session.json` |

安全边界不变：DID 私钥、collab token、模型密钥都不进容器；容器只拿 workspace 与短期工具 token。

### 14.6 验收

1. **C 独立**：无 `COLLAB_*` 配置，`npm run router` 启动；两个 script agent 互发并完成一轮；重启后 thread 历史仍在。
2. **D 接入**：collab 在线时，router agent 用 DID 登录成功，能拉到 collab subtask 并写回结果；collab 离线时，本地 ANP 消息不受影响，任务桥重试。
3. **A/B 回归**：现有 supervisor、standalone 测试与行为不变。
4. **互操作**：D 的登录请求能被 collab 现有 `/auth/anp/login` 接受；不需要改 collab 协议（collab 侧的验签收敛见 `anpio-collab/docs/anp-convergence-plan.md`）。


