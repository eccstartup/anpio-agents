# anpio-agents 文档

`anpio-agents` 是 ANPIO 的智能体执行引擎。给定一份定义文件和一个模型，它就能在受控目录里读写文件、执行 shell、调用平台工具，并把多轮对话按 thread 串起来。

**同一个引擎，两种接入方式**：不连平台时自己跑；连上 `anpio-collab` 后，由平台下发定义、投递消息、记录运行。

## 三层结构

| 层 | 做什么 | 主要位置 |
| --- | --- | --- |
| 定义层 | provider、工具白名单、限额、沙箱、消息来源 | `src/definition.ts`、`src/standalone/config.ts` |
| 执行层 | 模型循环、工具分发、文件与 shell 沙箱 | `src/runtime/`、`src/tools.ts`、`src/sandbox.ts` |
| 接入层 | 消息来源、thread 调度、控制面端口 | `src/sources/`、`src/threads/`、`src/runtime/transport.ts` |

执行层不知道消息来自终端还是平台。它只消费 `AgentTransport` 这组端口，因此自运行与 Collab 调用复用同一套模型循环和工具。

```text
消息来源              线程调度                 一轮执行
stdin        ─┐
platform     ─┼─▶ ThreadHost ─▶ ThreadTurn ─▶ 模型循环 ─▶ 工具
http / 定时  ─┘      │             │                        ├─ 本地原语（shell / 文件 / finish）
                     │             │                        ├─ 平台工具（任务 / 文件 / 知识）
                     └─ SQLite     └─ 每线程同时一轮         └─ ANP 工具（发消息 / 子 agent / 调度）
```

## 两种运行方式

| | 自运行 | Collab 调用 |
| --- | --- | --- |
| 控制面 | 定义文件 + 本地 SQLite | `anpio-collab` 平台 |
| 启动方式 | `anpio-agents`、`npm run standalone` | `npm run runtime`、平台来源、`npm run router` |
| 消息从哪来 | 终端 stdin、一次性参数、HTTP `POST /runs` | 平台信箱、ANP 消息 |
| 需要平台吗 | 不需要 | 需要 |
| 运行记录 | `<root>/<agentId>/...` 本地目录 | 平台运行记录 + Session 目录 |
| 典型场景 | 本地试用、脚本化调用、单机流水线节点 | 多 agent 协作、任务分发、统一审计与看板 |

## 怎么选

- **只在本机试用、写脚本、或者把智能体挂到一条单机流水线上**：从 [自运行](standalone.md) 开始。
- **需要平台建运行、分配任务、保留审计、和外部 Agent 协作**：读 [Collab 调用](collab.md)。
- **既想在终端聊天，又想接收平台任务**：用 `anpio-agents`，并在定义里启用 `sources.platform`。平台只是消息来源之一，不需要为它单独写一套 Session。
- **多个 agent 互相发消息、派活、定时触发**：用 ANP router 常驻进程，见 [Collab 调用](collab.md)。

## 接下来

| 文档 | 内容 |
| --- | --- |
| [自运行](standalone.md) | 交互式对话、一次性运行、HTTP 常驻服务、密钥与数据目录 |
| [Collab 调用](collab.md) | supervisor、平台来源、ANP router、消息确认与上线清单 |
| [定义文件](definition.md) | 字段参考、协议、工具、来源与校验规则 |
| [外部插件（规划）](plugins.md) | 把日志、监控和流水线环节作为工具接入 |

> 计划把外部系统作为插件接入智能体（读执行日志、查监控、触发某个流水线环节）。当前设计还在评审，方案摘要见 [外部插件](plugins.md)，完整计划在仓库的 `docs/plugin-plan.md`。
