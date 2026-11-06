---
title: 外部插件（MCP）
description: 用一个 MCP server 把流水线日志、监控与环节执行接入智能体；5 分钟接入、字段参考、失败与幂等语义。
---

# 外部插件（MCP）

插件就是一个 **MCP server**：智能体作为 MCP 客户端启动它，把它的工具并入模型循环。权限、超时、审计仍由引擎统一管。

当前实现：**stdio 传输**（本地子进程），协议层用官方 `@modelcontextprotocol/sdk`。HTTP 传输与平台侧审批属于后续阶段。

## 5 分钟接入

外部接入只碰你自己仓库里的文件，全程不需要读引擎源码。

### 1. 写一个 MCP server

复制 [`examples/plugins/ci-logs/server.ts`](https://github.com/eccstartup/anpio-agents/blob/main/examples/plugins/ci-logs/server.ts)，把里面的假数据换成你的真实查询。用官方 SDK 大约 40 行：

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'ci-logs', version: '0.1.0' });

server.registerTool(
  'logs_tail',
  {
    description: '读取构建日志的最新若干行',
    inputSchema: { cursor: z.number().int().min(0).optional() },
    annotations: { readOnlyHint: true },
  },
  async ({ cursor }) => ({
    content: [{ type: 'text', text: await readLogs(cursor ?? 0) }],
  }),
);

await server.connect(new StdioServerTransport());
```

三条规则：

1. **stdout 只走 MCP 协议**，任何日志都写 stderr。
2. **只读工具加 `readOnlyHint: true`**；不加就按写操作处理（超时会被标记为结果未知）。
3. 从 stdin 读请求，**收到 EOF 就退出**。

任何语言、任何现成的 MCP server 都可以，不限于 TypeScript。

### 2. 在定义里声明，只有 3 个必填字段

```json
{
  "plugins": [
    {
      "id": "ci",
      "command": "node",
      "args": ["./plugins/ci-logs/server.ts"],
      "allow": ["logs_tail", "stage_status"]
    }
  ]
}
```

- `id`：小写字母、数字、连字符，最长 32，决定工具前缀。
- `command`：启动命令；`command` 与 `args` 里的相对路径按**定义文件所在目录**解析。
- `allow`：允许模型看到的工具名；插件暴露的其它工具不会进入模型工具清单。

其余字段全部有默认值，不写就不出现。

### 3. 一条命令自检

```bash
npm run plugin:check -- --command "node examples/plugins/ci-logs/server.ts" --allow logs_tail,stage_status
```

或者直接检查定义文件里的插件：

```bash
npm run plugin:check -- --definition examples/local-plugin.json --plugin ci --call logs_tail --input '{"limit":5}'
```

输出连接结果、每个工具的名称/读写属性/参数 schema、`allow` 是否全部存在，以及一次真实调用的耗时与结果。加 `--json` 便于脚本化。

自检通过后，模型就能调用 `plugin__ci__logs_tail`。也可以用 `script` 协议先离线跑通：

```bash
npm run standalone -- --agent examples/local-plugin.json --message "查 build-123 日志"
```

### 4. 不写定义文件也能接

临时接一个 server，直接放在启动命令上：

```bash
npm run agents -- --agent examples/local-chat.json --mcp "ci=node ./examples/plugins/ci-logs/server.ts"
```

可重复 `--mcp`；不写 `id=` 时从命令或第一个路径参数推导。命令行接入默认信任服务端暴露的**全部**工具，需要收窄时再加：

```bash
npm run agents -- --agent examples/local-chat.json \
  --mcp "ci=node ./examples/plugins/ci-logs/server.ts" \
  --mcp-allow "ci=logs_tail,stage_status" \
  --mcp-env "ci=CI_URL,CI_TOKEN"
```

`--mcp` 里的相对路径按**当前工作目录**解析，不是定义文件目录；`--mcp-env` 里的变量仍从运行机器继承。

已经在 REPL 里时用斜杠命令，不用重启：

```text
/mcp                                           查看已接入的插件和工具
/mcp add ci=node ./examples/plugins/ci-logs/server.ts   立刻接入
/mcp remove ci                                 断开并移除
```

接入是即时的：新工具从下一轮对话起可用。有 thread 正在运行时先等这一轮结束，避免工具清单在调用中途变化。

命令行和 REPL 接入的插件只存在于这次进程，不写回定义文件；`npm run standalone` 同样支持这三个参数（一次性运行）。

## 字段

| 字段 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `id` | 是 | — | `[a-z0-9-]{1,32}`，在同一份定义里唯一 |
| `command` | 是 | — | 可执行文件；相对路径按定义文件所在目录解析 |
| `args` | 否 | `[]` | 启动参数 |
| `allow` | 是 | — | 非空工具名数组，插件工具的白名单；命令行 `--mcp` 可省略，等价于 `["*"]`（服务端暴露的全部工具） |
| `env` | 否 | `[]` | 从运行进程继承的环境变量**名**；写 `KEY=value` 会报错 |
| `timeoutMs` | 否 | `30000` | 单次请求（含握手、`tools/list`、工具调用）超时 |
| `maxOutputBytes` | 否 | `65536` | 单次结果上限，超出按 UTF-8 安全截断 |
| `concurrency` | 否 | `1` | 同一插件同时进行的调用数 |
| `idleMs` | 否 | `300000` | 常驻进程空闲多久关闭；`0` 表示不自动关闭 |
| `optional` | 否 | `false` | 启动失败或缺少 `allow` 工具时是否降级 |
| `transport` | 否 | `stdio` | 目前只能是 `stdio`；`http` 会明确报错 |

未知字段、非法 id、重复 id、空 `allow`、`*` 与具体工具名混用、清洗后重名的工具，都会在加载定义时拒绝。

## 工具命名

模型看到的名字是 `plugin__<id>__<tool>`，例如 `plugin__ci__logs_tail`。

- 原始工具名里的非 `[A-Za-z0-9_-]` 字符替换为 `-`。
- 超过 64 字符时截断，并追加 6 位哈希，避免不同原名撞车。
- 只有 `allow` 里的工具会被暴露；插件新增工具不会自动获得权限。

## 插件收到的上下文

每次调用带一份 `_meta`：

```json
{
  "runId": "run-...",
  "agentId": "worker-1",
  "threadId": "task-42",
  "turnId": "turn-...",
  "taskId": "task-42",
  "pluginId": "ci",
  "tool": "logs_tail",
  "idempotencyKey": "turn:turn-...:call_1",
  "deadline": "2026-11-06T10:45:00.000Z"
}
```

没有 `turnId` 时幂等键是 `run:<runId>:<callId>`。这里没有模型密钥、平台令牌或完整环境变量。

幂等键只保证**同一个 ToolCall 重放**时不变；模型重新发起一次同名调用会拿到新的 `call.id`，不构成语义去重。真正的幂等需要插件自己配合。

## 超时、失败与幂等

工具声明了 `annotations.readOnlyHint: true` 才是读操作，其余一律按写处理。

| 情况 | 结果 |
| --- | --- |
| 启动失败、`allow` 缺少工具（`optional: false`） | 本轮直接失败，错误包含插件 id 与原因 |
| 启动失败且 `optional: true` | 降级：记一条日志，其余工具照常可用 |
| 工具返回 `isError: true`、JSON-RPC 错误 | `工具失败：…` 回到模型，本轮继续 |
| 读工具超时 / 连接断开 / 进程退出 | `工具失败：…`，本轮继续 |
| 写工具超时 / 连接断开 / 进程退出 | `写请求结果未知：…`，本轮以 `outcome_unknown` 收尾 |

引擎**不会自动重试**写操作。启动失败后同一轮内下一次调用可以重新拉起进程。

## 进度

插件在调用期间可以发 `notifications/progress`，引擎转成 `plugin-progress` 事件：

- 聊天 CLI 实时显示到 stderr，按“到最后一条或每 10 条”节流，避免刷屏。
- 平台 / router 路径写入运行日志。

长任务更稳的做法是：`stage_run` 立即返回 run id，随后用 `stage_status` 轮询，把等待拆到不同轮次。

## 环境与安全

- 插件进程的 `cwd`、`HOME`、`TMPDIR` 指向 `<agentRoot>/plugins/<id>/`，跨轮稳定；不能用会被删除的 Session 目录。
- 默认只继承 `PATH` 等基础变量；模型密钥与平台令牌**不会**自动进去。需要外部凭据时在 `env` 里列变量名，值仍来自运行机器。
- 插件 stderr 只保留最近 50 行用于诊断，不发送给模型。
- stdout 出现非 JSON-RPC 内容会关闭该插件并提示“日志请写 stderr”，污染行不会进入模型上下文。
- 审计只记 `插件 <id> 工具 <name> <耗时>ms <状态>`，不记参数与正文。
- 插件是启动它的用户权限下的独立进程，**安装即信任**，没有额外沙箱；`anp.network` 等网络策略不约束插件自己的出站连接。

## 进程与生命周期

- 同一 agent 的插件进程跨 Session 复用：第一次需要时启动，`tools/list` 结果缓存。
- `endTurn` 只减少活跃轮次；空闲超过 `idleMs` 才关闭，`0` 表示常驻。
- router 热更新、worker 空闲退出、一次性运行结束、`--serve` 关闭时都会收尾插件进程。
- `sessionIsolation: "process"` 时，插件随每次运行的子进程启停，不具备 agent 级复用。
- 依赖插件在 stdin EOF 时退出；引擎无法按进程组杀，只能做 best-effort 关闭。

## 两种接入路径

| | 自运行 | Collab |
| --- | --- | --- |
| 插件来源 | 本地定义文件 | 平台定义（阶段 3） |
| 运行位置 | 启动智能体的机器 | worker 所在机器 |
| 凭据 | `env` 白名单 | 平台绑定变量名，值仍在运行机器 |
| 审批 | 文件即授权 | 插件注册表 + 定义审批（阶段 3） |

阶段 3 之前，Collab 下发的定义里即使有 `plugins` 也按同一套 stdio 规则执行；平台侧的审批与插件注册表尚未实现。

## 流水线场景映射

| 需求 | 工具 | 返回 |
| --- | --- | --- |
| 看当前执行日志 | `logs_tail` | 新增日志行与下一个游标 |
| 查构建状态 | `stage_status` | 阶段、结果、耗时、失败原因 |
| 查监控 | `metrics_query` / `alerts_list` | 时间序列或告警列表 |
| 触发环节 | `stage_run` | 运行 id，后续用状态工具跟进 |
| 发布 / 回滚 | `release_deploy` / `release_rollback` | 操作结果，带幂等键 |

智能体仍负责读任务、看日志、做判断、调用环节、把结论写回任务评论或进度；插件只把外部能力变成可调用工具。

## 排错

`plugin:check` 会把常见失败翻译成可操作的原因：

| 现象 | 原因 |
| --- | --- |
| `ENOENT` | `command` 的第一个词不在 PATH，或路径写错 |
| `protocol version is not supported` | 服务端用了 MCP 客户端不支持的协议版本，升级插件 SDK |
| `没有提供这些工具` | `allow` 里的名字与 `tools/list` 不一致；先跑 `plugin:check` 看实际工具名 |
| 调用一直超时 | 插件没响应 `tools/call`；检查 stderr 报错或加大 `timeoutMs` |
| `向 stdout 输出了非 JSON-RPC 内容` | 插件把日志打印到了 stdout，改到 stderr |
