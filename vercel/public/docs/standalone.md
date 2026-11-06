# 自运行：不连平台

自运行只依赖一份定义文件。控制面被换成本地实现：信箱、运行记录与在线状态落在 `<root>/.local/`，不访问 `anpio-collab`。

适合本地试用、把智能体嵌入脚本、或在流水线节点上执行一次任务。

## 前提

- Node.js ≥ 22.18。仓库直接用 TypeScript 源码运行，不需要构建产物。
- 安装依赖：`npm install`。
- 想用 `anpio-agents` 这个命令，先执行 `npm link`；或者用 `npm run agents -- ...`。
- 模型密钥通过 `provider.apiKeyEnv`、`provider.apiKeyFile` 或 `provider.apiKey` 提供。

```bash
npm install
npm link
anpio-agents --help
```

## 交互式对话

```bash
# 不需要密钥的确定性示例：看一眼目录、写结果、收尾
npm run agents -- --agent examples/local-demo.json

# 真实模型；密钥名字写在定义里
ANTHROPIC_API_KEY=... npm run agents -- --agent examples/local-chat.json
```

启动后会进入 REPL，逐字输出模型回答，并显示工具调用与结果。

| 命令 | 作用 |
| --- | --- |
| `/new` | 下一条消息开一个新 thread |
| `/status` | 查看运行中的 thread 与消息来源 |
| `/help` | 显示命令帮助 |
| `/exit`、`/quit`、Ctrl-D | 退出 |
| Ctrl-C | 中止当前 thread 的这一轮；空闲时连按两次退出 |

带上 `--message` 时只处理一条消息，打印结果后退出，适合脚本：

```bash
anpio-agents --agent examples/local-chat.json --message "你好"
```

常用参数：

| 参数 | 说明 |
| --- | --- |
| `--agent <file>` | 定义文件，必填 |
| `--message <text>` | 只处理这条消息，然后退出 |
| `--thread <id>` | 默认 thread，缺省 `local:main` |
| `--root <dir>` | 运行根，缺省 `$COLLAB_RUN_ROOT` 或 `./collab-runs` |
| `--no-stream` | 等模型整段返回，不逐字输出 |
| `--no-platform` | 定义里配置了平台来源也不连接 |
| `--allow-missing-tools` | 平台工具不可用时降级为本地工具 |

### 线程与历史

- 本地输入和平台消息进入同一个 SQLite 存储，按 thread 路由。
- 同一 thread 的后续消息带历史继续；`/new` 或显式 `--thread` 可以开新线程。
- 同一 thread 同时只跑一轮；不同 thread 并行，受定义里的 `concurrency` 限制。交互输入优先占槽位。
- 工作目录在 `<root>/<agentId>/workspace/threads/<threadId>`，跨轮保留。

## 跑一次（脚本友好）

`src/standalone.ts` 是不带 REPL 的一次性入口。结果 JSON 写 stdout，日志写 stderr。

```bash
# 确定性示例
npm run standalone -- --agent examples/local-demo.json --message "跑一下"

# 真实模型
ANTHROPIC_API_KEY=... npm run standalone -- --agent examples/local-assistant.json --message "帮我看看这个目录"
```

stdin 也可以传 JSON，带上 `threadId` 便于上层把多轮串起来：

```bash
echo '{"text":"继续处理","threadId":"thread-1"}' \
  | npm run standalone -- --agent examples/local-assistant.json
```

| 参数 | 说明 |
| --- | --- |
| `--message <text>` | 要处理的输入；省略时从 stdin 读取 |
| `--thread <id>` | 同一 id 自动带上前几轮历史 |
| `--root <dir>` | 运行根，缺省 `$AGENT_RUN_ROOT` 或 `./agent-runs` |
| `--completion <策略>` | `finish`（默认）或 `text` |
| `--max-messages <n>` | 一轮最多处理几条消息，默认 5 |
| `--keep-run` | 保留本次 Session 目录，便于排查 |
| `--serve` | 启动本地 HTTP 服务，而不是跑一次就退出 |

退出码与平台路径一致：`0` 成功，`2` 结果未知（`outcome_unknown`），其他失败。

### 完成策略

- `finish`：模型必须调用 `finish` 才算完成；没有结束信号的一轮会失败并退回消息。
- `text`：模型给出纯文本回答即视为完成，适合聊天式定义。

`anpio-agents` 在定义没写 `completion` 时默认用 `text`；`npm run standalone` 默认 `finish`，可用 `--completion text` 覆盖。

## 常驻 HTTP 服务

加 `--serve` 后同一个 agent 常驻，外部系统通过 HTTP 提交运行：

```bash
npm run standalone -- --agent examples/local-assistant.json --serve --port 8788
```

| 接口 | 作用 |
| --- | --- |
| `POST /runs` | 提交一次运行，立即返回 `202 {"runId":"..."}` |
| `GET /runs/:id` | 状态、摘要、错误与 token 统计 |
| `GET /runs/:id/events` | NDJSON 流式事件，运行结束即关闭 |
| `GET /health` | `{ok, active, queued}` |

```bash
curl -sS -X POST http://127.0.0.1:8788/runs \
  -H 'content-type: application/json' \
  -d '{"text":"检查一下工作目录","threadId":"thread-1"}'
```

默认只监听 `127.0.0.1`。监听非回环地址必须设置 `AGENT_HTTP_TOKEN`，之后所有接口都要带 `Authorization: Bearer <token>`。

服务相关环境变量：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `AGENT_HTTP_TOKEN` | 无 | HTTP 服务的 Bearer 令牌 |
| `AGENT_IDLE_MS` | `0` | 空闲多久自动退出；`0` 表示常驻 |
| `AGENT_SHUTDOWN_GRACE_MS` | `15000` | 退出信号后等待收尾的时间 |
| `AGENT_HISTORY_MAX_MESSAGES` | `40` | 每个 `threadId` 保留的消息条数 |
| `AGENT_HISTORY_MAX_BYTES` | `262144` | 每个 `threadId` 保留的历史字节数 |

## 密钥怎么给

优先级从高到低：

| 字段 | 说明 | 适用 |
| --- | --- | --- |
| `provider.apiKey` | 直接写明文密钥 | 仅本地定义文件 |
| `provider.apiKeyFile` | 指向密钥文件，读取时去掉首尾空白；支持 `~/` | 仅本地定义文件，推荐 |
| `provider.apiKeyEnv` | 环境变量名，运行时取值 | 本地与平台 |

平台只存变量名，不会下发明文密钥。三层都为空时，不注入 `Authorization` 或 `x-api-key`。

### 接本机模型代理

如果模型来自本机代理（例如 `cc-router`），把 token 写进一个只有自己能读的文件，再让定义指向它：

```json
{
  "provider": {
    "protocol": "anthropic-messages",
    "baseUrl": "https://127.0.0.1:23457",
    "model": "claude-sonnet-5-5",
    "apiKeyFile": "~/.anpio-cc-router-token"
  }
}
```

```bash
chmod 600 ~/.anpio-cc-router-token
anpio-agents --agent agent-runs/local-router.json
```

本机代理使用自签 CA 时，Node 需要信任系统证书：仓库里的 `bin/anpio-agents.mjs` 和 `npm run agents` 已经带上 `--use-system-ca`。直接运行 `node src/chat/cli.ts` 时需要自己加。

## 数据目录

| 路径 | 内容 |
| --- | --- |
| `<root>/<agentId>/workspace/threads/<threadId>/` | 每个 thread 的工作目录，跨轮保留 |
| `<root>/<agentId>/sessions/<runId>/` | 一次运行的临时目录，结束后删除 |
| `<root>/<agentId>/agent.db` | thread、消息、待办与运行记录 |
| `<root>/.local/conversations/` | 一次性运行的多轮历史 |
| `<root>/.local/` | 本地信箱、运行记录与在线状态 |

`--keep-run`（或 `AGENT_KEEP_RUN=1`）保留 Session 目录，便于排查。

## 常见问题

**启动时报缺少环境变量**：`provider.apiKeyEnv` 指向的变量没有值。改用 `apiKeyFile`，或先在当前 shell 里导出。

**连接本机代理时报 `unable to get local issuer certificate`**：Node 没有信任本机 CA。用 `anpio-agents` 启动器，或给 Node 加 `--use-system-ca`。

**HTTP 401**：平台或代理需要令牌。检查 `apiKeyFile` 内容、`apiKeyEnv` 对应的变量，以及服务模式的 `AGENT_HTTP_TOKEN`。

**定义里的工具启动即报错**：自运行没有平台工具后端。去掉平台工具，或加 `--allow-missing-tools` 降级；插件与外部能力会在后续版本提供。

**修改没有被平台看到**：自运行的定义文件只在本机生效，不会同步到 `anpio-collab`。
