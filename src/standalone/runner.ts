/**
 * 独立运行的单次提交：把输入放进本地信箱，再用同一个 AgentRuntime 跑一轮。
 *
 * 这里不引入新的执行语义——Session、工具、收尾判定都复用平台路径的实现；
 * 区别只在于控制面换成了 localTransport，运行状态落在 `<root>/.local/`。
 */

import { randomUUID } from 'node:crypto';
import type { Brain, ChatMessage } from '../brains/types.ts';
import type { CompletionPolicy, EmbeddedAgentDefinition } from '../definition.ts';
import { AgentRuntime } from '../runtime/agent.ts';
import { defaultLocalRoot, localTransport, type LocalTransport } from '../runtime/local/transport.ts';
import type { ToolBackend } from '../runtime/transport.ts';
import type { LogLevel, SessionResult } from '../runtime/types.ts';
import { StandaloneConfigError } from './config.ts';

export function newRunId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '');
  return `run-${stamp}-${randomUUID().slice(0, 8)}`;
}

export type StandaloneRuntimeOptions = {
  root?: string;
  /** 定义里声明了本地传输层没有的工具时，是否降级为「只用能用的工具」。 */
  allowMissingTools?: boolean;
  /** 以后接本地任务库、Slack、GitHub 等系统时注入。 */
  tools?: ToolBackend;
  brain?: Brain;
  /** 缺省把运行日志同步写到 stderr。 */
  log?: (level: LogLevel, text: string) => void;
};

function stderrLog(level: LogLevel, text: string): void {
  process.stderr.write(`[${level}] ${text}\n`);
}

export async function createStandaloneRuntime(
  definition: EmbeddedAgentDefinition,
  options: StandaloneRuntimeOptions = {},
): Promise<{ runtime: AgentRuntime; transport: LocalTransport }> {
  const transport = localTransport({
    root: options.root ?? defaultLocalRoot(),
    ...(options.tools ? { tools: options.tools } : {}),
    logMirror: options.log ?? stderrLog,
  });

  const missing = definition.tools.filter(tool => !transport.supportsTool(tool));
  if (missing.length > 0 && !options.allowMissingTools) {
    throw new StandaloneConfigError(
      `当前运行环境不支持这些工具：${missing.join(', ')}（需要对应的 ToolBackend；可用 --allow-missing-tools 降级）`,
    );
  }

  const runtime = await AgentRuntime.create({
    agentId: definition.id,
    definition,
    transport,
    rootBase: transport.root,
    ...(options.brain ? { brain: options.brain } : {}),
  });
  return { runtime, transport };
}

export type RunInput = {
  text: string;
  threadId?: string;
  /** 多轮会话历史；P4 接入 ConversationStore 后由调用方提供。 */
  history?: ChatMessage[];
};

export type StandaloneRun = {
  runId: string;
  result: SessionResult;
};

export type StandaloneAgentOptions = {
  /** 覆盖定义里的 completion；命令行可用。 */
  completion?: CompletionPolicy;
  maxMessages?: number;
};

/** 常驻在进程里的单 agent 执行器；每次 run() 建一个独立 Session。 */
export class StandaloneAgent {
  private readonly runtime: AgentRuntime;
  private readonly transport: LocalTransport;
  private readonly options: StandaloneAgentOptions;

  constructor(runtime: AgentRuntime, transport: LocalTransport, options: StandaloneAgentOptions = {}) {
    this.runtime = runtime;
    this.transport = transport;
    this.options = options;
  }

  async run(input: RunInput): Promise<StandaloneRun> {
    const text = input.text.trim();
    if (!text) throw new StandaloneConfigError('输入不能为空');
    const threadId = input.threadId?.trim() || undefined;
    const runId = newRunId();

    await this.transport.runs.create(runId, {
      input: text,
      ...(threadId ? { threadId } : {}),
    });
    await this.transport.enqueue({
      text,
      ...(threadId ? { threadId } : {}),
    });

    const definition: EmbeddedAgentDefinition | undefined = this.options.completion
      ? { ...this.runtime.definition, completion: this.options.completion }
      : undefined;
    const result = await this.runtime.runSession({
      runId,
      ...(definition ? { definition } : {}),
      ...(this.options.maxMessages === undefined ? {} : { maxMessages: this.options.maxMessages }),
      ...(input.history && input.history.length > 0 ? { history: input.history } : {}),
    });
    return { runId, result };
  }
}
