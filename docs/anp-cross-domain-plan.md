# ANP 跨域投递与剩余项实施计划

2026-11-02。主方案见 [anp-runtime-plan.md](anp-runtime-plan.md) §3.5–§3.7。

前置：anpio-cli 仓库的 `docs/service-relay-exports-plan.md` 必须先落地
（`createRelay` / `createEgress` / `loadHttpSigner` 从包入口导出，dist 重建）。
在那之前，P0 只能写代码和测试替身，不能做端到端验收；P1、P2 不受影响。

## 0. 范围

本计划只做 router 侧的接入与消息生命周期，不实现 ANP 转发协议。

做：

- 跨域 `direct.send` 双向：本机 agent ↔ 外部 DID。
- 本机投递不因启用 relay 而依赖 DID 文档解析或端口匹配。
- 外部 DID 的准入策略（允许哪些域名）、入站处理、自动回复。
- 无 `conversation_id` 的一次性 thread 归档。
- `sync.delta` 的 `aged_out` 进 `/health`。

不做：

- 跨域群组、附件、订阅流（router 不使用）。
- 管理接口 `send` 到外部 DID（`routeMessage` 表达不了外部目标；仍只支持本机）。
- 在 router 里实现 `createRelay` / egress / DID 发现；这些只调用 anpio-cli。
- 服务侧异步 outbox。跨域 `direct.send` 在 service 内是同步的，失败由本仓库 outbox 重试。

## 1. 现状

- `createAnpService` 调 `createDispatch` 时没有传 `relay`，所以 `direct.send` 无论目标
  DID 在哪都被本地收下。为此 [src/anp/errors.ts](../src/anp/errors.ts) 的
  `UnroutableTargetError` 在 router、mailbox、session 三处先挡外部目标。
- `Delivery.wake` 只处理本机目标；`thread_members` 只存本机 agent id。
- `AnpTurnSession.replyIfNeeded` 对来自外部 DID 的触发消息直接跳过。
- 无 `conversation_id` 时按 `message_id` 建 thread，但没有归档扫描，也会在
  `agents/<id>/workspace/threads/<threadId>/` 留下长期目录。
- `AnpMailbox.sync` 只把 `aged_out` 写日志。

## 2. P0：跨域投递

### 2.1 本地优先的 relay 包装

不要直接把 `createRelay` 塞进 `createDispatch`。`relayFor` 对每条 `direct.send`
都先解析目标的 DID 文档，确认入口是不是自己，然后才返回 `local`。这会让本机消息

- 依赖 DID 服务可达；
- 依赖 `config.publicUrl` 与真实监听端口一致（测试里的 `port: 0` 会直接坏掉）；
- 每次多一次无意义的解析。

在 [src/anp/service.ts](../src/anp/service.ts) 里构造 relay 时先查本机 DID：

```ts
const base = createRelay({ config, egress });
const relay: Relay = {
  forward: async (request, targetDid) =>
    localTargets().has(targetDid)
      ? { kind: 'local' }
      : base.forward(request, targetDid),
};
```

`localTargets` 由 `AnpServiceOptions` 注入，router 传
`() => new Set([...hosts.values()].map(host => host.did))`。

`AnpServiceOptions` 增加（都从 anpio-cli 的公开入口导入）：

```ts
type AnpServiceOptions = {
  // ...
  crossDomain?: {
    /** 本机 DID；命中时不发任何 HTTP。 */
    localTargets: () => Set<string>;
  };
};
```

`createAnpService` 在 `crossDomain` 存在时：

1. `const egress = createEgress({ config, ...(await loadHttpSigner(config) ? { signer } : {}) })`；
   `loadHttpSigner` 的密钥仍从 `ANPIOCLI_KEY_FILE` / `ANPIOCLI_KEY_ID` 读；没有配钥就不签，
   业务层 `origin_proof` 仍是授权依据。
2. `createRelay({ config, egress })`；
3. 包一层 `localTargets` 短路；
4. `createDispatch({ config, storage, objects, resolver, relay, ... })`。

`envFor` 把外部域名加到 `ANPIOCLI_ALLOWED_DID_HOSTS`（见 2.2）；这个清单同时是出站发现
与入站验签的闸门。

### 2.2 配置

[src/router/config.ts](../src/router/config.ts) 增加：

```ts
type RouterConfig = {
  // ...
  crossDomain: {
    enabled: boolean;          // 默认 false
    allowedDidHosts: string[]; // 默认 []；enabled 时必须非空
  };
};
```

- 配置字段：`crossDomain.enabled`、`crossDomain.allowedDidHosts`。
- 环境变量：`ANP_CROSS_DOMAIN=1`、`ANP_ALLOWED_DID_HOSTS=agent.example.com,*.partner.example`。
- 校验：`enabled=true` 且清单为空 → 启动报错；清单里的 host 不接受协议、路径、端口。
- `envFor` 写入 `ANPIOCLI_ALLOWED_DID_HOSTS = [本机 did/publicUrl 的 host, ...allowedDidHosts]`。
- `crossDomain.enabled=false` 时行为与今天完全一致，`UnroutableTargetError` 保留。

匹配规则：从 DID 取 host（`did:wba:<host>:...` / `did:web:<host>:...`），支持精确匹配与
`*.` 前缀匹配。不要按整条 DID 匹配，DID 的路径段会变，域名才是部署边界。

### 2.3 出站目标策略

[src/router/router.ts](../src/router/router.ts)：

- `resolveTarget` 返回 `{ did: string; host?: AgentHost }`：
  - 裸 id / `agent:<id>`：仍只查本机，找不到即 `Error('目标 agent 不存在')`。
  - `did:` 命中本机：返回 host。
  - `did:` 未命中 + `crossDomain.enabled` + host 在清单内：返回 `{ did }`，`host` 为空。
  - 其余：`UnroutableTargetError`。
- `sendFrom`：只有 `target.host` 存在时才 `delivery.wakeHost(...)`；外部目标直接
  `from.send(target.did, ...)`。
- `send`（管理接口）：显式外部 DID 仍拒绝，并在错误里说明“管理接口只投本机”。能力/
  默认路由不变。
- `canDeliver` 注入给 mailbox / session 的谓词改为：

```ts
(did) => hostByDid(did) !== undefined
      || (config.crossDomain.enabled && didHostAllowed(did))
```

- `AnpMailbox.flushOutbox` 里已有的“外部目标退休”逻辑改成同一个谓词：未启用跨域时退休，
  启用且域名允许时正常重试；域名后来被移出清单的旧行同样退休。
- `anp_send` / `anp_reply` 的工具描述同步改成“本机或允许的跨域 DID”。

### 2.4 入站与自动回复

- 入站跨域消息由远端 relay 直接 POST 到本机 ANP 服务，`direct.send` 被本地接受后
  `onDelivered` 照常触发；`Delivery.wake` 只按目标 DID 找本机 host，外部 `senderDid`
  查不到就不进 `thread_members`。`thread_members` 保持只存本机 agent，外部发送方由
  `origin_proof` 授权，不往成员表塞外部 DID。
- `Delivery.wake` 增加 `ephemeral` 参数（见 P1），从 `DeliveredEvent` 透传。
- [src/runtime/anp/session.ts](../src/runtime/anp/session.ts) 的 `replyIfNeeded`：
  - `canDeliver` 为真时不再跳过外部 DID；
  - 保留现有的“`anp.chat.message` / `anp.schedule.fire` 无 task_id 不兜底回复”；
  - 新增 `trigger.kind.startsWith('anp.control.')` 不自动回复，避免控制消息回声。
- 跨域回复与普通回复走同一条 `mailbox.send` → outbox → relay，不需要单独路径。

### 2.5 P0 验收

- 未启用跨域：外部 DID 在 `send` / `sendFrom` / `mailbox.send` 三处仍是 `unroutable`，
  outbox 为空。
- 启用跨域且域名允许：外部 DID 能发出；远端不可达时 service 返回 1012，本仓库 outbox
  用同一 `message_id` / `operation_id` 退避重试。
- 启用跨域后，本机 A → B 的投递不产生任何 HTTP 发现请求（用 fake relay 断言
  `forward` 未被调用），DID 服务停掉也不影响本机投递。
- 外部 A → 本机 B：B 收到消息、跑 turn、ack；`anp.task.request` 自动回复能回到 A。
- 外部域名不在清单：入站验签与出站目标都在启动/发送时被拒。

## 3. P1：一次性 thread 归档

### 3.1 标记

- [src/anp/service.ts](../src/anp/service.ts) 的 `DeliveredEvent` 增加
  `ephemeral: boolean`：请求 `params.body.conversation_id` 缺失或为空时为 true，
  `threadId` 仍回落到 `message_id`。
- [src/router/delivery.ts](../src/router/delivery.ts) 的 `wake` / `wakeHost` 接收
  `ephemeral`，传给 `ensureThread`。
- [src/store/router-store.ts](../src/store/router-store.ts)：
  - 新增迁移 version 2：
    `ALTER TABLE threads ADD COLUMN ephemeral INTEGER NOT NULL DEFAULT 0`；
    `ALTER TABLE threads ADD COLUMN archived_at TEXT`。
  - `ensureThread` 只在 INSERT 时写 `ephemeral`；已有 thread 不被后续消息改写。
  - 新增 `archiveEphemeralThreads(cutoffIso: string): ThreadRow[]`：
    `state != 'archived' AND ephemeral = 1 AND updated_at <= cutoff` 的 thread 置为
    `archived` 并写 `archived_at`；返回被归档的行。
  - 显式 `conversation_id` 的新消息命中已归档 thread 时，把 state 改回 `open`
    （只有显式 conversation 才允许复活）。

### 3.2 清理

- [src/router/router.ts](../src/router/router.ts) 增加 `ephemeralThreadTtlMs`（默认
  `3_600_000`）与 `ephemeralSweepIntervalMs`（默认 `60_000`，0 关闭），可用
  `ANP_EPHEMERAL_THREAD_TTL_MS` / `ANP_EPHEMERAL_SWEEP_INTERVAL_MS` 覆盖。
- tick 里调用 `archiveEphemeralThreads(now - ttl)`，对每条：
  1. 找 owner host；该 host 的 thread 正在跑就跳过，下一轮再试；
  2. `host.archiveThread(threadId)` 删除
     `agents/<id>/workspace/threads/<threadId>/`（只删 workspace，不删消息与 notes）；
  3. `store.archiveSessionsForThread(threadId)` 把 session 置 `archived`，未 ack 的
     inbox 行保留，便于排查。
- 一次性 thread 的 turn 结束后不保留 workspace；如果实现成本高，先只做归档删除目录，
  不留后台常驻目录即可。

### 3.3 验收

- 无 `conversation_id` 的入站消息：thread `ephemeral=1`；跑一轮后 workspace 存在；
  用可控时钟推进超过 TTL 并触发 tick：thread 变 `archived`、workspace 目录消失。
- 带 `conversation_id` 的 thread 不被归档，workspace 保留。
- 归档后同 `conversation_id` 再来消息：thread 恢复 `open`，turn 正常执行。

## 4. P2：`aged_out` 观测

- [src/runtime/anp/mailbox.ts](../src/runtime/anp/mailbox.ts)：
  - 字段 `lastAgedOut: number`；`sync()` 每轮把 `result.agedOut` 累加，结束后保存；
  - 公开 `agedOut(): number` 返回最近一次 `sync()` 的累计值。
- [src/router/agent-host.ts](../src/router/agent-host.ts)：公开 `agedOut()` 转发 mailbox；
  注意 `baseMailbox()` 按 thread 缓存，需要让所有 mailbox 共享一个计数器或由 host 自己
  汇总每个 mailbox 的值。
- [src/router/router.ts](../src/router/router.ts) 的 `status()` 增加
  `agedOutMessages: number`；`/health` 与 `/admin/health` 直接可见。
- 验收：制造 `aged_out > 0` 的 `sync.delta`（fake client）后，`mailbox.agedOut()` 与
  `router.status().agedOutMessages` 都大于 0。

## 5. 测试矩阵

| 层 | 用例 |
| --- | --- |
| 配置 | `crossDomain.enabled` 缺清单报错；环境变量解析；默认关闭 |
| 目标策略 | 本机 DID / 本机 id / 外部 DID（关、开但域名不允许、开且允许） |
| relay 包装 | 本机目标不调 `base.forward`；外部目标原样转发 |
| 跨域端到端 | 两个 `createAnpService` + fake relay → 双向投递、自动回复、幂等重试 |
| 入站 | 外部发送方不进 `thread_members`；`conversation_id` 映射；无 `conversation_id` 标记 ephemeral |
| 归档 | TTL、tick、workspace 删除、显式 conversation 复活 |
| 观测 | `aged_out` 计数进 health |
| 回归 | 现有 router / mailbox / thread-session 用例全绿；`npm run check` |

跨域端到端不要依赖真实公网：用 fake `Relay` 把 A 的 `direct.send` 直接交给 B 的
`handleRpc`，签名仍由真实 `AnpClient` / 身份生成，B 的 `localKeys` 里带上 A 的公钥。
anpio-cli 自己的 `crossDomain.test.ts` 负责 egress 与发现。

## 6. 实施顺序

1. anpio-cli 导出落地（前置）。
2. P2 `aged_out`（独立，小）。
3. P1 一次性 thread（独立）。
4. P0 relay：配置 → service 包装 → 目标策略 → 入站/回复 → 测试。
5. 最后更新 README 与主方案 §3.5 / §3.7 的状态。

## 7. 风险

- **本地短路必须做**：漏掉就会把本机消息变成网络调用，DID 服务一挂全挂。
- **`publicUrl` 要真实**：跨域时它决定对方回连地址，也参与“是不是自己”的判断；本机
  短路只保护本机目标。
- **允许清单同时放宽入站**：`ANPIOCLI_ALLOWED_DID_HOSTS` 变大后，外部 DID 文档会被
  解析；只写确切的域名，不写通配整个 TLD。
- **relay 是同步的**：远端慢会拖慢本轮工具调用；不要因此把 `direct.send` 改成异步，
  否则失去 `anp.did_superseded` 回传能力。超时与重试仍由 outbox 承担。
