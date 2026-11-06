---
layout: home

hero:
  name: Anpio Agents
  text: 智能体执行引擎
  tagline: 一份定义文件，一个模型。它在受控目录里读写文件、执行 shell、调用工具；不连平台时自己跑，连上 anpio-collab 后由平台下发定义、投递消息、记录运行。
  image:
    src: /logo.svg
    alt: Anpio Agents
  actions:
    - theme: brand
      text: 快速开始
      link: /guide/standalone
    - theme: alt
      text: 接入 Collab
      link: /guide/collab
    - theme: alt
      text: 看定义文件
      link: /guide/definition

features:
  - title: 一份定义描述一次运行
    details: provider、工具白名单、限额、沙箱与消息来源都写在 JSON 里；加载时校验，坏定义在启动前就失败。
  - title: 两种接入方式
    details: 本地终端、一次性调用与 HTTP 服务；或接 anpio-collab，由平台建运行、投递消息、保留审计。
  - title: 同一套执行层
    details: 消息来源只负责拉取与确认，模型循环、工具与沙箱在自运行和 Collab 之间完全复用。
  - title: 工具分层清楚
    details: 本地原语、平台工具、ANP 协作工具按白名单取交集；能力缺失显式报错，不静默降级。
  - title: 隔离与限额
    details: 每轮独立 Session 目录，shell 超时杀整个进程组，输出按上限截断；可选进程隔离与容器模式。
  - title: 外部插件
    details: 用 MCP server 接入流水线日志、监控与环节执行，3 个字段就接好；权限、超时和审计仍由引擎统一管。
---

## 这个引擎解决什么问题

多数智能体框架把“能调用模型”和“能安全地做一件事”分开处理：模型循环写一套，工具、沙箱、限额再各写一套。换一个消息来源，整条链路就要重写一遍。

Anpio Agents 把一次运行拆成三层：

1. **定义层**写清楚用哪个模型、能用哪些工具、一次运行有什么边界；
2. **执行层**只做模型循环、工具分发与沙箱，不关心消息从哪里来；
3. **接入层**负责把终端、平台、ANP 消息并进同一个 thread 调度。

这样，同一个引擎既能作为本地 CLI 使用，也能作为 anpio-collab 的执行后端，不需要维护两份代码。

## 三层结构

| 层 | 做什么 | 主要位置 |
| --- | --- | --- |
| 定义层 | provider、工具白名单、限额、沙箱、消息来源 | `src/definition.ts`、`src/standalone/config.ts` |
| 执行层 | 模型循环、工具分发、文件与 shell 沙箱 | `src/runtime/`、`src/tools.ts`、`src/sandbox.ts` |
| 接入层 | 消息来源、thread 调度、控制面端口 | `src/sources/`、`src/threads/`、`src/runtime/transport.ts` |

## 文档地图

| 你想了解 | 从这里开始 |
| --- | --- |
| 引擎的层次与两种运行方式 | [总览](/guide/overview) |
| 在本机对话、跑一次任务或提供 HTTP 服务 | [自运行](/guide/standalone) |
| 接 supervisor、平台来源或 ANP router | [Collab 调用](/guide/collab) |
| 定义文件有哪些字段、怎么校验 | [定义文件](/guide/definition) |
| 把流水线日志、监控与环节执行接进来 | [外部插件](/guide/plugins) |

## 五分钟看到效果

```bash
git clone https://github.com/eccstartup/anpio-agents.git
cd anpio-agents
npm install
npm run agents -- --agent examples/local-demo.json
```

`examples/local-demo.json` 用的是 `script` 协议，不调用模型、不需要密钥：先看一眼目录，再写一个结果文件。换成真实模型只需要提供密钥：

```bash
ANTHROPIC_API_KEY=... npm run agents -- --agent examples/local-chat.json
```

::: tip 这份文档和仓库 README 的关系
这份站点面向使用者和集成方，按“自运行 / Collab 调用”两条路径组织；仓库根目录的 `README.md` 是代码仓库说明。两边内容相互对照，但不需要一起读。
:::

## 设计上的一句话

> 消息从哪里来可以变，执行怎么发生必须一致。
