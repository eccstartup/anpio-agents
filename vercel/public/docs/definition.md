# 定义文件参考

一份定义文件描述三件事：**用哪个模型**、**能用哪些工具**、**一次运行有什么边界**。自运行从文件加载；Collab 路径由平台下发同一套结构。

## 最小定义

```json
{
  "id": "local-chat",
  "name": "本地对话",
  "provider": {
    "protocol": "anthropic-messages",
    "model": "claude-sonnet-5-5"
  },
  "systemPrompt": "你是一个可以直接动手的终端智能体。",
  "tools": ["shell", "read_file", "write_file", "list_files", "finish"],
  "sandbox": { "shell": true }
}
```

## 顶层字段

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `id` | string | 文件名 | 只允许字母、数字、`.` `_` `:` `-`，最长 128 |
| `name` | string | `id` | 展示名 |
| `description` | string | 空 | 用途说明 |
| `capabilities` | string[] | `[]` | 能力标签，供平台匹配任务 |
| `provider` | object | 必填 | 模型协议与鉴权，见下 |
| `systemPrompt` | string | 空 | 系统提示，支持环境变量占位 |
| `tools` | string[] | 读文件、写文件、列目录、finish | 工具白名单 |
| `scopes` | string[] | `[]` | 平台授权范围 |
| `limits` | object | 见下 | 轮次、超时与 token 上限 |
| `sandbox` | object | 见下 | shell 开关与输出限制 |
| `enabled` | boolean | `true` | 平台是否叫醒这个定义 |
| `concurrency` | number | `1` | 同时进行的 thread / Session 数 |
| `sessionIsolation` | `inline` / `process` | `inline` | 是否每个 Session 一个子进程 |
| `completion` | `finish` / `text` | `finish` | 什么算完成（聊天 CLI 缺省为 `text`） |
| `sources` | object | stdin | 消息来源，只存在本地文件 |
| `anp` | object | 无 | ANP router 专用策略 |

`limits` 默认 `{ "maxTurns": 12, "timeoutMs": 180000, "maxTokens": 8192 }`。

`sandbox` 默认 `{ "shell": tools 是否含 shell, "shellTimeoutMs": 30000, "maxOutputBytes": 65536 }`。`tools` 含 `shell` 却把 `sandbox.shell` 设为 `false` 会直接报错。

## provider

```json
{
  "provider": {
    "id": "anthropic",
    "protocol": "anthropic-messages",
    "baseUrl": "https://api.anthropic.com",
    "model": "claude-sonnet-5-5",
    "apiKeyEnv": "ANTHROPIC_API_KEY"
  }
}
```

| 字段 | 说明 |
| --- | --- |
| `protocol` | 协议，见下表 |
| `baseUrl` | 接口根地址；多数协议有默认值 |
| `model` | 模型名；`script` 协议可省略 |
| `apiKeyEnv` | 密钥的环境变量名；设为 `null` 表示不需要 |
| `apiKey` | 明文密钥，仅本地定义文件 |
| `apiKeyFile` | 密钥文件路径，支持 `~/`，仅本地定义文件 |
| `script` | 仅 `script` 协议：每一步说一句话或调一个工具 |

密钥优先级：`apiKey` → `apiKeyFile` → `apiKeyEnv`。平台路径只接受 `apiKeyEnv`。

### 协议

| 协议 | 默认 baseUrl | 默认密钥变量 |
| --- | --- | --- |
| `openai-chat` | `https://api.openai.com/v1` | `OPENAI_API_KEY` |
| `openai-responses` | `https://api.openai.com/v1` | `OPENAI_API_KEY` |
| `anthropic-messages` | `https://api.anthropic.com` | `ANTHROPIC_API_KEY` |
| `gemini-generate` | `https://generativelanguage.googleapis.com/v1beta` | `GEMINI_API_KEY` |
| `workers-ai` | 无，必须提供 | `CLOUDFLARE_API_TOKEN` |
| `script` | 空 | 不需要 |
| `decision-jev` | 决策协议，不支持多轮对话 | — |
| `gemini-interactions` | 预留，未实现 | — |
| `subscription-cli` | 预留，未实现 | — |

自运行可用的协议：`openai-chat`、`openai-responses`、`anthropic-messages`、`gemini-generate`、`workers-ai`、`script`。其他协议在加载定义时明确报错。

### script 协议

不调用模型，按顺序执行固定步骤，适合演示与验收：

```json
{
  "provider": {
    "protocol": "script",
    "script": [
      { "tool": "shell", "input": { "command": "pwd" } },
      { "tool": "write_file", "input": { "path": "result.txt", "content": "完成\n" } },
      { "tool": "finish", "input": { "summary": "已写入 result.txt", "outcome": "done" } }
    ]
  }
}
```

## tools

工具分三组，可用性等于定义白名单与当前接入层提供能力的交集。

**本地原语**（执行引擎提供）：

| 工具 | 作用 |
| --- | --- |
| `shell` | 在工作目录执行命令，受超时与输出上限约束 |
| `read_file` | 读工作目录内的文件 |
| `write_file` | 写工作目录内的文件 |
| `list_files` | 列工作目录 |
| `finish` | 结束本轮并给出摘要 |

**平台工具**（需要 Collab 的工具后端）：`task_get`、`subtask_inbox`、`task_accept`、`task_progress`、`task_submit`、`subtask_reject`、`task_comment`、`task_comments`、`offer_list`、`offer_claim`、`task_files`、`file_download`、`file_upload`、`knowledge_search`。

**router 工具**（ANP router 提供）：`anp_send`、`anp_reply`、`anp_list_messages`、`anp_get_message`、`list_agents`、`agent_status`、`spawn_agent`、`schedule_create`、`schedule_cancel`、`list_schedules`、`http_fetch`、`memory_get`、`memory_set`、`finish_turn`。

自运行时声明了平台工具会启动报错；`--allow-missing-tools` 可以降级为只用本地原语。

## sources

只在本地的定义文件里生效，平台不会保存这一段。

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

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `stdin.enabled` | `true` | 从终端读消息 |
| `platform.baseUrl` | 必填 | 平台地址 |
| `platform.agentId` | 定义 `id` | 平台侧的 agent 标识 |
| `platform.adminTokenEnv` | `COLLAB_RUNTIME_TOKEN` | 管理员令牌变量名 |
| `platform.secretEnv` | `COLLAB_EMBEDDED_SECRET` | 派生令牌的密钥变量名 |
| `platform.pollMs` | `3000` | 信箱轮询间隔 |

明文凭据字段（`adminToken`、`secret`、`token`）会被拒绝，只能写环境变量名。

## scopes

平台授权范围：`tasks:read`、`tasks:submit`、`offers:claim`、`knowledge:read`、`comments:write`、`presence:write`、`mailbox:read`、`mailbox:write`。

平台会按启用的工具自动补齐所需范围，例如 `offer_claim` 补 `offers:claim`，`file_upload` 补 `tasks:submit`。

## anp

只在 ANP router 里生效，与上面的字段共用同一份定义：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `isolation` | `inline` | `inline` / `process` / `container` |
| `allowSchedules` | `false` | 是否允许创建定时任务 |
| `allowSpawn` | `false` | 是否允许创建子 agent |
| `network` | `egress` | `none` / `egress` / `open` |
| `networkAllowlist` | `[]` | `http_fetch` 允许的主机；支持 `*.example.com` 与 `host:port` |
| `maxSchedules` | `20` | 每个 agent 的定时任务上限 |
| `maxChildren` | `3` | 每个父 agent 的子 agent 上限 |
| `maxDepth` | `2` | 子 agent 最大深度 |

## 示例

| 文件 | 说明 |
| --- | --- |
| `examples/local-demo.json` | 脚本协议，无模型无密钥 |
| `examples/local-chat.json` | 聊天式定义，`completion` 由聊天 CLI 补成 `text` |
| `examples/local-assistant.json` | 一次性运行助手，`completion: text` |
| `examples/local-deepseek.json` | OpenAI 兼容供应商，覆盖 `baseUrl` |
| `examples/agents.json` | 平台同步用的多定义文件 |
| `examples/anp/router.local.json` | ANP router 配置与两个脚本 agent |

## 校验规则

加载定义时会被拒绝的情况：

- `id` 含非法字符或超长。
- 协议未知，或协议不能独立多轮运行。
- 非 `script` 协议缺 `model`，或需要 `baseUrl` 却没有。
- 工具名不在已知集合里。
- `tools` 含 `shell` 但 `sandbox.shell` 为 `false`。
- 声明了 `apiKeyEnv`，但既没有 `apiKey` / `apiKeyFile`，环境里也没有这个变量。
- `sources.platform` 写了明文凭据。
- 自运行时声明了平台工具，且没有传 `--allow-missing-tools`。

定义文件不存在、JSON 不合法、字段类型不对，都会在启动前报错，不会跑到一半才失败。
