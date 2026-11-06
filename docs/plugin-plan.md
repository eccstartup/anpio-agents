# anpio-agents：外部插件能力（流水线接入）

- 状态：阶段 1/2 已实施（2026-11-06），阶段 3/4 未开始
- 实现方式：协议层使用官方 `@modelcontextprotocol/sdk`，不自造 JSON-RPC
- 日期：2026-11-06
- 范围：定义扩展、工具装配、运行时事件、自运行与 Collab 两条路径
- 非目标：插件市场、插件沙箱虚拟机、把插件当作消息来源、跨机器插件调度

## 实施现状

阶段 1/2 已落地，与本文的设计差异只有一处：MCP 协议不再手写，改用官方 SDK。

- 模块：`src/plugins/{types,naming,config,mcp-client,registry,context,render,tools,check-cli}.ts`。
- 装配：`src/threads/turn.ts`、`src/runtime/session.ts`、`src/runtime/anp/session.ts`；工具在 `AgentRuntime.preparePlugins()` 之后同步合并。
- 生命周期：`AgentRuntime.close()` 已接到 router 热更新、worker 空闲/退出、聊天 CLI、一次性运行与 `--serve` 关闭。
- 接入体验：`examples/plugins/ci-logs/server.ts` 模板、`examples/local-plugin.json`、`npm run plugin:check`、文档站“5 分钟接入”。
- 临时接入：`--mcp "id=命令 参数"`（可重复，默认信任全部工具）、`--mcp-allow`、`--mcp-env`；REPL 里 `/mcp` / `/mcp add` / `/mcp remove`，运行时增删不影响其它插件。
- 测试：`tests/fixtures/mcp-plugin.ts` + `tests/plugins.test.ts`（23 例），覆盖发现/白名单、翻页、启动失败、stdout 污染、超时、进程死亡、进度、空闲回收、并发、中止、审计、线程集成，以及命令行规格、通配符与运行时增删。

阶段 3/4 仍未开始：平台定义 schema 与插件审批、HTTP 传输、真实 CI/监控适配器。

## 0. 背景

现在智能体能调用的工具是封闭集合：

- 本地原语：`shell`、`read_file`、`write_file`、`list_files`、`finish`。
- 平台工具：任务、文件、知识，由 `ToolBackend` 提供。
- ANP 工具：发消息、子 agent、调度、`http_fetch`，由 router 提供。

把智能体接到流水线上时，需要的是流水线自己的日志、监控和环节执行能力。把这些都写成平台工具不现实：外部系统会变，权限模型也不同。需要一层**插件**：定义里声明，运行时按统一协议发现工具、并入模型循环，权限、超时、审计由引擎统一管。

目标场景：

1. 读当前执行的日志，按游标继续拉，不重复全量。
2. 查监控：指标、告警、最近一次发布状态。
3. 执行某个环节：触发构建、重跑阶段、回滚版本。
4. 把环节串起来：拿到结果后判断下一步，把结论写回任务评论或进度。

## 1. 结论：MCP 服务 + 本地清单

插件按 **MCP（Model Context Protocol）** 接入：

- 传输：`stdio`（本地子进程）与 `http`（远程服务，后续阶段）。
- 方法：`initialize`、`tools/list`、`tools/call`；进度用 `notifications/progress`。
- 不自造协议。日志、监控、CI 系统已经有 MCP 适配器，接入成本最低；模型工具定义也能直接从 `inputSchema` 映射。

插件只提供工具，不提供消息来源，也不绕过定义里的工具白名单。

## 2. 定义格式

在定义文件里新增 `plugins` 段：

```json
{
  "plugins": [
    {
      "id": "ci",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@acme/ci-mcp"],
      "env": ["CI_URL", "CI_TOKEN"],
      "allow": ["logs_tail", "metrics_query", "stage_run", "stage_status"],
      "timeoutMs": 30000,
      "maxOutputBytes": 65536,
      "concurrency": 1,
      "idleMs": 300000,
      "optional": false
    }
  ]
}
```

| 字段 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `id` | 是 | — | `[a-z0-9-]{1,32}`，用于工具命名与审计 |
| `transport` | 否 | `stdio` | 目前只能是 stdio；`http` 在阶段 4 之前明确报错 |
| `command` | 是 | — | 可执行文件 |
| `args` | 否 | `[]` | 启动参数 |
| `env` | 否 | `[]` | 允许从运行进程继承的环境变量名，不接受明文值 |
| `allow` | 是 | — | 允许模型调用的工具名；必须非空 |
| `timeoutMs` | 否 | `30000` | 单次工具调用超时 |
| `maxOutputBytes` | 否 | `65536` | 单次结果上限，超出截断 |
| `concurrency` | 否 | `1` | 同一插件同时进行的调用数 |
| `idleMs` | 否 | `300000` | 常驻进程空闲多久关闭；`0` 表示不关 |
| `optional` | 否 | `false` | 启动失败时是否降级；默认启动即报错 |

校验规则：

- `id` 唯一，且不能与内置工具命名冲突。
- `allow` 必须非空，允许重复但去重。
- `env` 只接受变量名；出现 `API_KEY=...` 这种赋值形式直接报错。
- `transport: "http"` 在阶段 4 之前明确报错，不静默降级。
- `optional: false` 时，插件启动失败、`tools/list` 至少一个 `allow` 工具不存在，都让本轮启动失败。

### 工具命名

模型看到的工具名：

```text
plugin__<id>__<toolName>
```

- 只保留 `[A-Za-z0-9_-]`，其他字符替换为 `-`。
- 总长度超过 64 时，截断并追加 6 位哈希后缀，保证唯一。
- 执行时还原为插件原名，审计日志同时记录插件 id 与原始工具名。

### 类型改动

`EmbeddedTool` 保持内置工具的固定并集，不把动态插件工具塞进去。新增：

```ts
// src/plugins/types.ts
export type PluginDefinition = { /* 上表字段 */ };
export type PluginTool = {
  pluginId: string;
  name: string;        // 插件内原名
  exposedName: string; // plugin__id__name
  spec: ToolSpec;
  effects: 'read' | 'write';
};
```

模型工具清单 = 内置工具（`definition.tools`）+ 每个插件 `allow` 命中的工具。插件条目本身就是白名单，平台定义与本地定义都遵循同一规则。

## 3. 运行时装配

新增模块：

| 文件 | 职责 |
| --- | --- |
| `src/plugins/types.ts` | `PluginDefinition`、`PluginTool`、`PluginCallContext` |
| `src/plugins/naming.ts` | 唯一的工具命名规则，配置、注册表、AGENTS.md、script 校验共用 |
| `src/plugins/config.ts` | `plugins` 校验与默认值、相对路径解析 |
| `src/plugins/mcp-client.ts` | 官方 SDK 的 `Client` + `StdioClientTransport`；stderr 环、失败分类、退出收尾 |
| `src/plugins/registry.ts` | 插件进程生命周期、白名单、并发闸门、空闲回收、审计 |
| `src/plugins/context.ts` | 组装每次调用的 `_meta` 上下文与幂等键 |
| `src/plugins/render.ts` | MCP `content` 转文本与两层截断 |
| `src/plugins/tools.ts` | `withPlugins`：合并工具清单、路由插件调用、`endTurn` |
| `src/plugins/check-cli.ts` | `plugin:check` 自检入口 |

合并方式不侵入现有工具实现：

```ts
// src/plugins/tools.ts
export function withPlugins(
  base: BrainLoopTools,
  registry: PluginRegistry | null,
  context: PluginCallContext,
): BrainLoopTools {
  if (!registry) return base;
  const specs = registry.specs();
  if (specs.length === 0) return base;

  return {
    specs: [...base.specs, ...specs],
    execute: async call => {
      if (isPluginToolName(call.name) && registry.has(call.name)) {
        return registry.call(call, context);
      }
      return base.execute(call);
    },
    dispose: async () => {
      try {
        await base.dispose?.();
      } finally {
        registry.endTurn();
      }
    },
  };
}
```

装配点：

- `src/threads/turn.ts`：聊天 CLI（含平台来源）的每一轮。
- `src/runtime/session.ts`：自运行一次性 / 子进程 Session。
- `src/runtime/anp/session.ts`：ANP router 的每轮。
- `src/router/turn-tools.ts`：router 工具集的合并入口；与 `withPlugins` 组合。

插件进程按 agent 进程维度复用，不随每一轮重启：

- 第一次需要时启动并握手；`tools/list` 结果缓存。
- `--serve`、router、常驻聊天：空闲 `idleMs` 后关闭。
- 一次性运行：本轮结束统一关闭。
- 调用失败不自动重试；同一次运行内下一次调用可以重新拉起一次。

### MCP 细节

- 握手、版本协商、分帧、请求路由、取消与超时都由官方 SDK 负责；引擎只在握手前挂上自己的 `onerror` / `onclose` 钩子。
- 协议版本按客户端支持范围协商，服务端返回不兼容版本时启动失败。
- `stdio` 子进程只把 stdout 当 JSON-RPC 帧；插件的日志必须走 stderr。引擎保留最近 50 行 stderr 用于诊断，不发送给模型。
- `tools/call` 返回的 `content` 转成文本；`isError: true` 以“工具失败”文本回到模型，不致命。
- `notifications/progress` 转成 `plugin-progress` 事件（见第 5 节）。
- 结果最终仍经过现有 `MAX_RESULT_CHARS` 截断，`maxOutputBytes` 是更早的一层保护。

## 4. 调用上下文与幂等

每次 `tools/call` 在 `params._meta` 里带上下文：

```json
{
  "runId": "run-...",
  "agentId": "worker-1",
  "threadId": "task-42",
  "turnId": "turn-...",
  "taskId": "task-42",
  "pluginId": "ci",
  "tool": "stage_run",
  "idempotencyKey": "turn:...:call_1",
  "deadline": "2026-11-06T10:45:00.000Z"
}
```

规则：

- 上下文不含模型密钥、平台令牌、完整环境变量或 workspace 之外的路径。
- 需要 workspace 的插件在定义里自己配置路径；引擎不主动下发主机路径。
- `idempotencyKey` 由 `turnId + call.id` 生成；同一次运行内模型重放同一个工具调用时 key 相同。
- `effects: "read"` 的工具失败只把错误文本回给模型；`effects: "write"` 的工具在传输中断、超时但无法确认是否执行时返回 `uncertain`，本轮以 `outcome_unknown` 收尾，不重试。
- `effects` 优先读 MCP 工具注解：`readOnlyHint: true` 视为读，其余一律视为写。默认按写处理，避免漏判副作用。

## 5. 进度与长任务

- 工具调用期间的进度通知 → `ThreadEvent { type: 'plugin-progress' }` → REPL 实时显示，Collab 路径写运行日志。
- 跨轮长任务用“启动 + 轮询”：`stage_run` 立即返回 run id，后续用 `stage_status` 查。不要用一次调用等完整条流水线。
- 日志用游标：`logs_tail({ cursor, limit })` 返回 `{ lines, cursor, eof }`；下一轮从新游标继续。
- 引擎不保存插件会话状态；需要状态的插件把状态放在外部系统或自己的存储里。

## 6. 安全

- **显式授权**：插件、工具、环境变量都必须在定义里出现；插件新增工具不会自动进入工具清单。
- **环境隔离**：子进程环境只包含 `PATH`、`HOME`、`TMPDIR`、`LANG` 与 `env` 白名单；模型密钥、平台令牌默认不传。
- **超时与上限**：启动、握手、单次调用分别有超时；输出有两层上限。
- **审计**：记录 `pluginId`、原始工具名、耗时、状态、是否 uncertain；不记录参数与正文。
- **信任边界**：插件是运行机器上的独立进程，拥有启动它的用户权限。安装插件等于信任它；Collab 路径只允许平台管理员批准的插件。
- **写操作**：幂等键 + `outcome_unknown` 语义，避免自动重试造成重复发布或重复构建。
- **失败姿态**：默认 fail fast；`optional: true` 才允许缺失，且日志必须明说降级。

## 7. 两种接入方式

### 自运行

定义文件里写 `plugins`，插件在本机启动：

```bash
npm run standalone -- --agent examples/local-pipeline.json --message "查一下 build-123 的日志，失败就重跑"
anpio-agents --agent examples/local-pipeline.json
```

- `--serve` 模式下插件随服务常驻，空闲回收。
- 一次性运行在本轮结束关闭插件。
- 环境变量由启动进程提供，定义只写变量名。

### Collab

- 平台定义新增 `plugins` 段；由平台管理员审批插件 id 与工具白名单。
- 平台只存插件 id、工具白名单、变量名；值在 worker / router 所在机器。
- worker 启动时校验本机插件注册表；未安装的插件按 `optional` 处理，默认让运行失败并在运行记录里给出原因。
- 插件调用写入运行日志与审计；进度通知沿用运行日志通道。
- 后续阶段可增加“插件网关”：插件注册为平台服务，worker 通过带派生令牌的 HTTP 调用，避免每台机器安装。

### ANP router

- 每个 agent 有自己的插件实例与工具清单，互不共享连接。
- 插件继承 router 的联网策略吗？**不继承。** 插件是独立进程，`anp.network` 只约束 `http_fetch`。需要在文档里明确这一点，避免误以为 allowlist 管住了插件。

## 8. 流水线场景

| 需求 | 工具 | 返回 |
| --- | --- | --- |
| 当前执行日志 | `logs_tail` | 新增行 + 游标 |
| 构建 / 阶段状态 | `stage_status` | 状态、耗时、失败原因 |
| 触发环节 | `stage_run` | 运行 id |
| 监控指标 | `metrics_query` | 时间序列 |
| 告警 | `alerts_list` | 告警列表 |
| 发布 / 回滚 | `release_deploy` / `release_rollback` | 操作结果，带幂等键 |

智能体职责不变：读任务、看日志、判断、调用环节、把结论写回 `task_comment` / `task_progress`。插件不替智能体做决策。

## 9. 实施阶段

### 阶段 1：MCP stdio 与工具合并（已完成）

- 定义 `plugins` 字段与校验（`src/definition.ts`、`src/standalone/config.ts`）。
- `mcp-client.ts`：stdio 握手、`tools/list`、`tools/call`、超时、stderr 捕获。
- `registry.ts`：启动、缓存、并发 1、关闭。
- `withPlugins` 接入 `src/threads/turn.ts` 与 `src/runtime/session.ts`。
- `script` 协议的 `parseScriptSteps` 允许插件工具名，便于无模型测试。
- 测试：mock MCP server（`tests/fixtures/mcp-plugin.ts`）覆盖发现、调用、缺工具、启动失败、超时。

### 阶段 2：上下文、幂等与进度（已完成）

- `context.ts` 组装 `_meta`；`idempotencyKey` 与 `effects`。
- `plugin-progress` 事件接入 `ThreadEvent` 与 REPL 渲染。
- 结果截断、审计日志。
- `--serve` 常驻与空闲回收。
- 测试：进度通知、写工具超时 → `outcome_unknown`、审计不含正文。

### 阶段 3：Collab

- 平台侧（anpio-collab）：定义 schema、插件注册表、审批、变量绑定。
- worker / supervisor：插件校验、失败原因写入运行记录。
- 运行日志接收 `plugin-progress`。
- 测试：平台定义经 supervisor 下发后插件可用；未安装插件失败可见。

### 阶段 4：HTTP 传输与适配器

- `http` transport（Streamable HTTP / JSON-RPC）。
- 示例插件：CI 日志、Prometheus 指标、内部阶段执行。
- 端到端验收与文档站更新。

## 10. 文件改动清单

| 文件 | 改动 |
| --- | --- |
| `package.json` | 依赖 `@modelcontextprotocol/sdk`、`zod`；脚本 `plugin:check` |
| `src/definition.ts` | `plugins?: PluginDefinition[]` 字段 |
| `src/standalone/config.ts` | 解析 `plugins`、脚本步骤放行插件工具、相对路径解析 |
| `src/runtime/agent.ts` | `preparePlugins()`、`plugins`、`close()` |
| `src/plugins/types.ts` | 新文件 |
| `src/plugins/naming.ts` | 新文件 |
| `src/plugins/config.ts` | 新文件 |
| `src/plugins/mcp-client.ts` | 新文件，SDK 适配 |
| `src/plugins/registry.ts` | 新文件 |
| `src/plugins/context.ts` | 新文件 |
| `src/plugins/render.ts` | 新文件 |
| `src/plugins/tools.ts` | 新文件，`withPlugins` |
| `src/plugins/check-cli.ts` | 新文件，`plugin:check` |
| `src/threads/turn.ts` | 合并插件工具、转发进度事件 |
| `src/runtime/session.ts` | 一次性运行装配与关闭 |
| `src/runtime/anp/session.ts` | router 装配 |
| `src/router/agent-host.ts` | 停止与热更新时关闭旧 runtime |
| `src/threads/types.ts` | `plugin-progress` 事件 |
| `src/chat/repl.ts` | 进度渲染与节流 |
| `src/chat/cli.ts`、`src/agent-worker.ts`、`src/session.ts`、`src/standalone.ts` | 退出收尾 |
| `src/runtime/prompt.ts` | AGENTS.md 工具清单包含插件工具名 |
| `tests/fixtures/mcp-plugin.ts` | 新文件，测试用 MCP 服务 |
| `tests/plugins.test.ts` | 新文件，19 例 |
| `examples/plugins/ci-logs/server.ts` | 新文件，可复制的插件模板 |
| `examples/local-plugin.json` | 新文件，script 协议示例 |
| `vercel/docs/guide/plugins.md` | 新文档站页面（5 分钟接入） |
| `vercel/docs/guide/definition.md` | `plugins` 字段 |
| `docs/plugin-plan.md` | 本文件 |

## 11. 验收

阶段 1 完成时必须能离线跑通：

```bash
npm run check
npm test

# 自检：命令模式与定义文件模式
npm run plugin:check -- --command "node examples/plugins/ci-logs/server.ts" --allow logs_tail,stage_status
npm run plugin:check -- --definition examples/local-plugin.json --plugin ci --call logs_tail --input '{"limit":5}'

# 定义里挂一个本地插件，script 协议直接调用
npm run standalone -- --agent examples/local-plugin.json --message "查 build-123 日志"
```

验收点：

1. 插件启动、`tools/list` 过滤后只暴露 `allow` 中的工具。
2. 模型（或 script）调用 `plugin__ci__logs_tail`，结果按游标返回。
3. 调用超时返回“工具失败”文本，本轮继续；写工具超时返回 `outcome_unknown`。
4. 插件缺失且 `optional: false` 时启动失败，错误信息包含插件 id 与原因。
5. stderr 噪声不影响 JSON-RPC；stdout 非协议输出被检测并报错。
6. 审计日志有插件、工具、耗时、状态，没有参数正文。
7. 一次性运行结束后没有残留插件进程。

阶段 3 额外验收：平台下发含 `plugins` 的定义，supervisor 启动 worker 后插件可用；未安装插件时运行记录可读；禁用插件后工具不再出现在工具清单里。

## 12. 风险与未决

- **MCP 版本漂移**：客户端按协商版本工作，服务端返回不兼容版本时明确失败，不做兼容层猜测。
- **stdout 污染**：第三方插件可能打印日志到 stdout。引擎检测非 JSON 行并终止该插件，提示改用 stderr。
- **工具名长度**：部分模型对工具名有 64 字符限制；命名规则已包含截断与哈希。
- **凭据泄露**：默认不继承模型密钥与平台令牌；需要凭据的插件必须显式列 `env`。
- **副作用**：无法确认结果时不重试写操作，这是有意为之；插件需要配合幂等键。
- **平台跨仓库改动**：阶段 3 依赖 anpio-collab 的定义 schema 与审批流程，需要单独排期。
- **插件实例粒度**：阶段 1 按 agent 进程共享；如果插件有每 thread 状态，后续再评估按 thread 隔离。
- **Windows**：stdio 启动与信号处理先按 POSIX 验收，Windows 放到后续。
- **插件沙箱**：v1 不做；插件拥有启动用户权限，这一点必须在文档和审批界面写清楚。
