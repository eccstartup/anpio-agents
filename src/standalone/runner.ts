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
import type { ConversationStore } from './conversation.ts';

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
  /** 显式提供的历史；省略时从 ConversationStore 按 threadId 读取。 */
  history?: ChatMessage[];
};

export type StandaloneRun = {
  runId: string;
  result: SessionResult;
};

export type RunHandle = {
  runId: string;
  /** 结果不会 reject：Session 内部已经把异常收敛成 SessionResult。 */
  done: Promise<SessionResult>;
  /** 本轮还没拿到并发槽位时也能中止，拿到后立即生效。 */
  abort(reason: string): void;
};

export type StandaloneAgentOptions = {
  /** 覆盖定义里的 completion；命令行可用。 */
  completion?: CompletionPolicy;
  maxMessages?: number;
  /** 按 threadId 持久化多轮历史；不传时每次运行互不相干。 */
  conversations?: ConversationStore;
};

/** 常驻在进程里的单 agent 执行器；每次 start() 建一个独立 Session。 */
export class StandaloneAgent {
  private readonly runtime: AgentRuntime;
  private readonly transport: LocalTransport;
  private readonly options: StandaloneAgentOptions;
  private readonly handles = new Set<RunHandle>();
  private queuedCount = 0;

  constructor(runtime: AgentRuntime, transport: LocalTransport, options: StandaloneAgentOptions = {}) {
    this.runtime = runtime;
    this.transport = transport;
    this.options = options;
  }

  /** 已提交、但还在等并发槽位的运行数。 */
  get queued(): number {
    return this.queuedCount;
  }

  async start(input: RunInput): Promise<RunHandle> {
    const text = input.text.trim();
    if (!text) throw new StandaloneConfigError('输入不能为空');
    const threadId = input.threadId?.trim() || undefined;
    const runId = newRunId();

    const history =
      input.history !== undefined
        ? input.history
        : this.options.conversations && threadId
          ? await this.options.conversations.load(threadId)
          : undefined;

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
    const request = {
      runId,
      ...(definition ? { definition } : {}),
      ...(this.options.maxMessages === undefined ? {} : { maxMessages: this.options.maxMessages }),
      ...(history && history.length > 0 ? { history } : {}),
    };
    const runtime = this.runtime;
    const conversations = this.options.conversations;

    let session: ReturnType<AgentRuntime['createSession']> | null = null;
    let abortReason: string | null = null;

    this.queuedCount += 1;
    const done = (async (): Promise<SessionResult> => {
      const release = await runtime.acquire();
      this.queuedCount -= 1;
      try {
        session = runtime.createSession(request);
        if (abortReason) session.abort(abortReason);
        const result = await session.run();
        if (conversations && threadId && result.status === 'succeeded' && result.summary?.trim()) {
          try {
            await conversations.append(threadId, [
              { role: 'user', content: text },
              { role: 'assistant', content: result.summary.trim() },
            ]);
          } catch (error) {
            await this.transport.runs
              .log(runId, 'warn', `会话历史写入失败：${error instanceof Error ? error.message : String(error)}`)
              .catch(() => undefined);
          }
        }
        return result;
      } finally {
        release();
      }
    })();

    const handle: RunHandle = {
      runId,
      done,
      abort: (reason: string) => {
        abortReason ??= reason;
        session?.abort(reason);
      },
    };
    this.handles.add(handle);
    void done.finally(() => this.handles.delete(handle)).catch(() => undefined);
    return handle;
  }

  async run(input: RunInput): Promise<StandaloneRun> {
    const handle = await this.start(input);
    return { runId: handle.runId, result: await handle.done };
  }

  /** 服务退出时中止所有排队与进行中的运行。 */
  abortAll(reason: string): void {
    for (const handle of this.handles) handle.abort(reason);
  }
}
