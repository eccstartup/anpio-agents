/**
 * 一个 thread 的一轮：拉取待处理消息、跑模型循环、把结果 ack/nack 回来源。
 *
 * 结构取自 ANP 的 AnpTurnSession，但消息来自 MessageSource，而不是一个
 * 固定的 ANP 信箱；thread 的历史与工作目录照旧落在 agent.db / workspace 下。
 */

import { randomUUID } from 'node:crypto';
import type { BrainLoopTools } from '../runtime/brain-loop.ts';
import { runBrainLoop } from '../runtime/brain-loop.ts';
import { systemPromptFor, writeAgentsFile, type EnvironmentDescription } from '../runtime/prompt.ts';
import type { AgentRuntime } from '../runtime/agent.ts';
import type { SessionResult } from '../runtime/types.ts';
import type { ToolBackend } from '../runtime/transport.ts';
import type { EmbeddedAgentDefinition, EmbeddedTool } from '../definition.ts';
import { isLocalTool } from '../definition.ts';
import { createTools } from '../tools.ts';
import { withPlugins } from '../plugins/tools.ts';
import type { AgentStore, InboxRow } from '../store/agent-store.ts';
import { buildThreadContext, ensureThreadWorkspace, THREAD_ENVIRONMENT } from './context.ts';
import type { InboundMessage, MessageSource, ThreadEvent, TurnHandle } from './types.ts';

type LeasedRow = InboxRow & { delivery_id: string };

const MAX_MESSAGES = 20;
const FAILURE_RETRY_SECONDS = 300;
const UNCERTAIN_RETRY_SECONDS = 3_600;

export type ThreadTurnOptions = {
  runtime: AgentRuntime;
  definition: EmbeddedAgentDefinition;
  store: AgentStore;
  sources: Map<string, MessageSource>;
  threadId: string;
  turnId?: string;
  runId?: string;
  /** 逐字流式输出；false 时只发完整的 assistant-text。 */
  stream?: boolean;
  /** 没有平台工具后端时，是否允许降级为本地原语。 */
  allowMissingTools?: boolean;
  emit?: (event: ThreadEvent) => void;
  log?: (level: 'info' | 'warn', text: string) => void;
};

export class ThreadTurn {
  readonly threadId: string;
  readonly turnId: string;
  readonly runId: string;

  private readonly runtime: AgentRuntime;
  private readonly definition: EmbeddedAgentDefinition;
  private readonly store: AgentStore;
  private readonly sources: Map<string, MessageSource>;
  private readonly stream: boolean;
  private readonly allowMissingTools: boolean;
  private readonly emit: (event: ThreadEvent) => void;
  private readonly log: (level: 'info' | 'warn', text: string) => void;
  private readonly controller = new AbortController();

  private timer: NodeJS.Timeout | null = null;
  private abortedReason: string | null = null;
  private timedOut = false;
  private workdir: string | null = null;
  private sourceId = 'local';

  constructor(options: ThreadTurnOptions) {
    this.runtime = options.runtime;
    this.definition = options.definition;
    this.store = options.store;
    this.sources = options.sources;
    this.threadId = options.threadId;
    this.turnId = options.turnId ?? `turn-${randomUUID()}`;
    this.runId = options.runId ?? `run-${randomUUID()}`;
    this.stream = options.stream ?? true;
    this.allowMissingTools = options.allowMissingTools ?? false;
    this.emit = options.emit ?? (() => undefined);
    this.log = options.log ?? (() => undefined);
  }

  abort(reason: string): void {
    this.abortedReason = reason;
    this.controller.abort(new Error(reason));
  }

  async run(): Promise<SessionResult> {
    const result: SessionResult = {
      status: 'succeeded',
      turns: 0,
      promptTokens: 0,
      completionTokens: 0,
      error: null,
      summary: null,
      toolExecuted: false,
      mailSessionId: null,
    };

    this.runtime.sessionBegin();
    let release: (() => void) | null = null;
    let tools: BrainLoopTools | null = null;
    let rows: LeasedRow[] = [];
    let settled = false;
    let handle: TurnHandle | null = null;

    try {
      release = await this.runtime.acquire();
      const leaseSeconds = Math.max(60, Math.ceil(this.definition.limits.timeoutMs / 1_000) + 60);
      this.workdir = await ensureThreadWorkspace(this.runtime.root, this.threadId);
      rows = this.store.pullInbox({ threadId: this.threadId, limit: MAX_MESSAGES, leaseSeconds });
      if (rows.length === 0) {
        settled = true;
        return result;
      }

      const primary = rows[0]!;
      this.sourceId = primary.source;
      this.store.startTurn({
        turnId: this.turnId,
        threadId: this.threadId,
        runId: this.runId,
        triggerMessageId: primary.message_id,
      });
      this.emit({ type: 'turn-start', threadId: this.threadId, turnId: this.turnId, sourceId: this.sourceId });

      const primarySource = this.sources.get(primary.source);
      handle = primarySource?.beginTurn ? await primarySource.beginTurn(this.inboundFrom(primary)) : null;

      const backend = this.backendFor(rows);
      const available = this.availableTools(backend);
      const environment = this.environmentFor(rows);

      const toolLog = (level: 'debug' | 'info' | 'warn' | 'error', text: string): void => {
        this.log(level === 'error' || level === 'warn' ? 'warn' : 'info', text);
      };
      const preparation = await this.runtime.preparePlugins(toolLog);
      for (const item of preparation.degraded) {
        this.log('warn', `插件 ${item.id} 不可用，按 optional 降级：${item.reason}`);
      }
      const authored = [...available, ...preparation.tools.map((tool) => tool.exposedName)];
      await writeAgentsFile(this.workdir, this.definition, authored, environment);

      const context = buildThreadContext(this.store, this.threadId);
      const system = [
        systemPromptFor(this.definition, environment),
        [
          '# 当前会话',
          '',
          `- thread：${this.threadId}`,
          `- 工作目录：${this.workdir}`,
          `- 本轮消息：${rows.map(row => row.message_id).join(', ')}`,
          `- 来源：${[...new Set(rows.map(row => row.source))].join(', ')}`,
          context.total === 1 ? '- 这是这个 thread 的第一条消息。' : `- 历史消息：${context.total} 条。`,
          context.omitted > 0 ? `- 历史：省略了 ${context.omitted} 条较早消息` : '',
        ].filter(Boolean).join('\n'),
      ].join('\n\n');

      tools = withPlugins(
        createTools({
          ...(backend ? { backend } : {}),
          runDir: this.workdir,
          runId: this.turnId,
          definition: this.definition,
          tools: available,
          log: toolLog,
        }),
        this.runtime.plugins,
        {
          runId: this.runId,
          agentId: this.runtime.agentId,
          threadId: this.threadId,
          turnId: this.turnId,
          signal: this.controller.signal,
          log: toolLog,
          onProgress: (progress) => {
            this.emit({
              type: 'plugin-progress',
              threadId: this.threadId,
              turnId: this.turnId,
              sourceId: this.sourceId,
              ...progress,
            });
          },
        },
      );

      this.timer = setTimeout(() => {
        this.timedOut = true;
        this.controller.abort(new Error('timeout'));
      }, this.definition.limits.timeoutMs);
      this.timer.unref?.();

      const loop = await runBrainLoop({
        brain: this.runtime.brainForSession(),
        tools,
        messages: context.messages,
        system,
        maxTurns: this.definition.limits.maxTurns,
        maxTokens: this.definition.limits.maxTokens,
        completion: this.definition.completion === 'text' ? 'text' : 'finish',
        vars: this.vars(rows),
        signal: this.controller.signal,
        log: (level, text) => {
          const mapped = level === 'warn' || level === 'error' ? 'warn' : 'info';
          if (mapped === 'warn') this.log(mapped, text);
          this.emit({ type: 'log', level: mapped, text, threadId: this.threadId, turnId: this.turnId, sourceId: this.sourceId });
        },
        heartbeat: async () => this.renewLeases(rows, leaseSeconds),
        stream: this.stream,
        onEvent: event => {
          this.emit({ ...event, threadId: this.threadId, turnId: this.turnId, sourceId: this.sourceId });
        },
        onToolExecuted: () => {
          result.toolExecuted = true;
        },
      });

      result.turns = loop.turns;
      result.promptTokens = loop.promptTokens;
      result.completionTokens = loop.completionTokens;
      result.toolExecuted = loop.toolExecuted;
      if (loop.aborted) {
        if (this.abortedReason) {
          result.status = 'failed';
          result.error = this.abortedReason;
        } else {
          result.status = 'timeout';
          result.error = `超过时限 ${this.definition.limits.timeoutMs}ms`;
        }
      } else {
        result.status = loop.status;
        result.error = loop.error;
      }

      if (loop.finished) {
        result.summary = loop.finished.summary;
        this.recordReply(result.summary);
        await this.ackRows(rows);
        await this.replyTrigger(primary, result.summary);
        settled = true;
      } else {
        if (result.status === 'succeeded') {
          result.status = 'failed';
          result.error = '本轮没有结束信号';
        }
        const retryAfterSeconds = result.status === 'outcome_unknown'
          ? UNCERTAIN_RETRY_SECONDS
          : FAILURE_RETRY_SECONDS;
        await this.nackRows(rows, retryAfterSeconds, result.error ?? '运行未完成，消息退回队列');
        settled = true;
      }
    } catch (error) {
      if (this.abortedReason) {
        result.status = 'failed';
        result.error = this.abortedReason;
      } else if (this.timedOut || this.controller.signal.aborted) {
        result.status = 'timeout';
        result.error = `超过时限 ${this.definition.limits.timeoutMs}ms`;
      } else {
        result.status = 'failed';
        result.error = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (this.timer) clearTimeout(this.timer);
      if (!settled && rows.length > 0) {
        const retryAfterSeconds = this.abortedReason || this.timedOut
          ? (result.toolExecuted ? UNCERTAIN_RETRY_SECONDS : FAILURE_RETRY_SECONDS)
          : FAILURE_RETRY_SECONDS;
        await this.nackRows(rows, retryAfterSeconds, '运行未完成，消息退回队列');
      }
      if (handle) {
        try {
          await handle.finish(result);
        } catch {
          // 来源自己的运行记录失败不影响本地结果。
        }
      }
      if (tools?.dispose) {
        try {
          await tools.dispose();
        } catch {
          // 容器清理失败由 labels 与超时兜底。
        }
      }
      this.store.finishTurn(this.turnId, {
        status: result.status,
        summary: result.summary,
        error: result.error,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
      });
      this.emit({
        type: 'turn-end',
        status: result.status,
        summary: result.summary,
        error: result.error,
        threadId: this.threadId,
        turnId: this.turnId,
        sourceId: this.sourceId,
      });
      release?.();
      await this.runtime.sessionEnd();
    }

    return result;
  }

  private backendFor(rows: LeasedRow[]): ToolBackend | undefined {
    const ordered = [
      ...new Set([rows[0]!.source, ...rows.map(row => row.source)]),
    ];
    for (const sourceId of ordered) {
      const backend = this.sources.get(sourceId)?.tools?.();
      if (backend) return backend;
    }
    return undefined;
  }

  private availableTools(backend: ToolBackend | undefined): EmbeddedTool[] {
    const missing = this.definition.tools.filter(tool => !isLocalTool(tool));
    if (!backend && missing.length > 0 && !this.allowMissingTools) {
      throw new Error(`当前没有平台工具后端，无法提供：${missing.join(', ')}`);
    }
    const legacyLocal = this.definition.tools.filter(isLocalTool);
    return backend ? this.definition.tools : legacyLocal;
  }

  private environmentFor(rows: LeasedRow[]): EnvironmentDescription {
    const sourceEnvironment = rows
      .map(row => this.sources.get(row.source)?.environment)
      .find((value): value is EnvironmentDescription => Boolean(value));
    if (!sourceEnvironment) return THREAD_ENVIRONMENT;
    return {
      rules: [...THREAD_ENVIRONMENT.rules, ...sourceEnvironment.rules],
      persistenceNote: THREAD_ENVIRONMENT.persistenceNote,
      workspaceNote: THREAD_ENVIRONMENT.workspaceNote,
    };
  }

  private vars(rows: LeasedRow[]): Record<string, string> {
    return {
      taskId: rows.length > 0 ? firstString(rows, 'task_id') : '',
      refId: rows[0]!.message_id,
      messageId: rows[0]!.message_id,
      threadId: this.threadId,
      runId: this.runId,
      turnId: this.turnId,
      agentId: this.runtime.agentId,
      workdir: this.workdir ?? '',
      now: new Date().toISOString(),
    };
  }

  private recordReply(summary: string): void {
    this.store.insertMessage({
      message_id: `reply-${randomUUID()}`,
      thread_id: this.threadId,
      direction: 'out',
      sender_did: null,
      target_did: null,
      content_type: 'application/json',
      body_json: JSON.stringify({ payload: { type: 'chat.message', text: summary } }),
      reply_to: null,
      created_at: new Date().toISOString(),
      source: 'agent',
    });
  }

  private async ackRows(rows: LeasedRow[]): Promise<void> {
    for (const row of rows) this.store.ackInbox(row.message_id, row.delivery_id);
    for (const [sourceId, list] of groupBySource(rows)) {
      const source = this.sources.get(sourceId);
      if (!source?.ack) continue;
      for (const row of list) {
        try {
          await source.ack(this.inboundFrom(row));
        } catch {
          // 本地已 ack；来源重投时 host 会看到 acked 并再次确认。
        }
      }
    }
  }

  private async nackRows(rows: LeasedRow[], retryAfterSeconds: number, reason: string): Promise<void> {
    for (const [sourceId, list] of groupBySource(rows)) {
      const source = this.sources.get(sourceId);
      for (const row of list) {
        const retryAt = Date.now() + retryAfterSeconds * 1_000;
        this.store.nackInbox(row.message_id, { deliveryId: row.delivery_id, retryAt });
        if (!source?.nack) continue;
        try {
          await source.nack(this.inboundFrom(row), { retryAfterSeconds, reason });
        } catch {
          // 本地租约到期后会重新进入队列。
        }
      }
    }
  }

  private async replyTrigger(primary: LeasedRow, summary: string): Promise<void> {
    const source = this.sources.get(primary.source);
    if (!source?.reply || !summary.trim()) return;
    try {
      await source.reply(this.inboundFrom(primary), summary.trim());
    } catch {
      // 回复失败不回滚本轮；来源自己的发送队列会重试。
    }
  }

  private async renewLeases(rows: LeasedRow[], seconds: number): Promise<void> {
    for (const row of rows) this.store.renewInboxLease(row.delivery_id, seconds);
  }

  private inboundFrom(row: InboxRow): InboundMessage {
    let body: Record<string, unknown> = {};
    try {
      body = asRecord(JSON.parse(row.body_json));
    } catch {
      // 非 JSON 正文按纯文本处理。
    }
    const payload = asRecord(body.payload);
    return {
      id: row.message_id,
      threadId: row.thread_id,
      text: typeof payload.text === 'string' ? payload.text : '',
      ...(typeof payload.title === 'string' ? { title: payload.title } : {}),
      ...(typeof payload.type === 'string' ? { kind: payload.type } : {}),
      ...('data' in payload ? { data: payload.data } : {}),
      sender: row.sender_did,
      ...(row.source_delivery ? { delivery: safeParse(row.source_delivery) } : {}),
    };
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function firstString(rows: LeasedRow[], key: string): string {
  for (const row of rows) {
    const payload = asRecord(asRecord(safeParse(row.body_json)).payload);
    if (typeof payload[key] === 'string') return payload[key] as string;
  }
  return '';
}

function groupBySource(rows: LeasedRow[]): Array<[string, LeasedRow[]]> {
  const groups = new Map<string, LeasedRow[]>();
  for (const row of rows) {
    const list = groups.get(row.source) ?? [];
    list.push(row);
    groups.set(row.source, list);
  }
  return [...groups.entries()];
}
