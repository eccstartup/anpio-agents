/**
 * 常驻智能体的线程调度：把多个 MessageSource 的消息并进同一个 store，
 * 每个 thread 同时只跑一个 ThreadTurn，不同 thread 并行。
 */

import { randomUUID } from 'node:crypto';
import type { AgentRuntime } from '../runtime/agent.ts';
import type { EmbeddedAgentDefinition } from '../definition.ts';
import type { SessionResult } from '../runtime/types.ts';
import type { AgentStore } from '../store/agent-store.ts';
import { nowIso } from '../store/sqlite.ts';
import { ThreadTurn } from './turn.ts';
import type { InboundMessage, MessageSource, ThreadEvent } from './types.ts';
import { normalizeThreadKey } from './types.ts';

export type ThreadHostOptions = {
  runtime: AgentRuntime;
  definition: EmbeddedAgentDefinition;
  store: AgentStore;
  sources: MessageSource[];
  /** 扫描间隔；<=0 时只在 emit 与 submit 时扫。 */
  tickMs?: number;
  stream?: boolean;
  allowMissingTools?: boolean;
  now?: () => number;
  log?: (line: string) => void;
  onEvent?: (event: ThreadEvent) => void;
};

export type SubmitInput = {
  text: string;
  threadId?: string | null;
  newThread?: boolean;
  /** 记录来源；缺省 stdin。 */
  sourceId?: string;
};

export type SubmitResult = {
  threadId: string;
  messageId: string;
  /** 该 thread 处理完这条消息后的结果；host 停止时 resolve null。 */
  done: Promise<SessionResult | null>;
};

export class ThreadHost {
  readonly agentId: string;

  private readonly runtime: AgentRuntime;
  private readonly definition: EmbeddedAgentDefinition;
  private readonly store: AgentStore;
  private readonly sources: MessageSource[];
  private readonly sourcesById = new Map<string, MessageSource>();
  private readonly running = new Map<string, Promise<SessionResult | null>>();
  private readonly kinds = new Map<string, 'interactive' | 'background'>();
  private readonly tasks = new Map<string, ThreadTurn>();
  private readonly waiters = new Map<string, Array<(result: SessionResult | null) => void>>();
  private readonly lastResults = new Map<string, SessionResult>();
  private readonly tickMs: number;
  private readonly stream: boolean;
  private readonly allowMissingTools: boolean;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly onEvent: (event: ThreadEvent) => void;

  private timer: NodeJS.Timeout | null = null;
  private sweepPromise: Promise<void> | null = null;
  private wakeAgain = false;
  private started = false;
  private stopped = false;

  constructor(options: ThreadHostOptions) {
    this.runtime = options.runtime;
    this.definition = options.definition;
    this.store = options.store;
    this.sources = options.sources;
    for (const source of options.sources) this.sourcesById.set(source.id, source);
    this.agentId = options.runtime.agentId;
    this.tickMs = options.tickMs ?? 500;
    this.stream = options.stream ?? true;
    this.allowMissingTools = options.allowMissingTools ?? false;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => undefined);
    this.onEvent = options.onEvent ?? (() => undefined);
  }

  get activeTurns(): number {
    return this.running.size;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.store.releaseExpiredLeases(this.now());
    const stale = this.store.failRunningTurns('进程重启，上一轮未完成');
    if (stale > 0) this.log(`[${this.agentId}] 收回 ${stale} 个上次未结束的 turn`);
    for (const source of this.sources) {
      if (!source.open) continue;
      try {
        await source.open(() => this.wake());
      } catch (error) {
        this.log(`[${this.agentId}] 来源 ${source.id} 启动失败：${messageOf(error)}`);
      }
    }
    if (this.tickMs > 0) {
      this.timer = setInterval(() => this.wake(), this.tickMs);
      this.timer.unref?.();
    }
    this.wake();
  }

  wake(): void {
    if (this.stopped) return;
    if (this.sweepPromise) {
      this.wakeAgain = true;
      return;
    }
    const sweep = this.sweepOnce()
      .catch(error => {
        this.log(`[${this.agentId}] 扫描失败：${messageOf(error)}`);
      })
      .finally(() => {
        this.sweepPromise = null;
        if (this.wakeAgain) {
          this.wakeAgain = false;
          this.wake();
        }
      });
    this.sweepPromise = sweep;
  }

  async sweepNow(): Promise<void> {
    this.wake();
    await this.sweepPromise;
  }

  /** 一直扫到没有可开始的待处理消息且所有 turn 结束；测试与 drain 使用。 */
  async settle(rounds = 8): Promise<void> {
    for (let round = 0; round < rounds; round += 1) {
      await this.sweepNow();
      await this.idle();
      if (this.stopped) return;
      if (this.store.pendingThreads(this.now()).length === 0) return;
    }
  }

  async idle(): Promise<void> {
    while (this.running.size > 0) {
      await Promise.all([...this.running.values()]);
    }
  }

  /** 推入一条消息并等待它所在的 thread 处理完。 */
  submit(input: SubmitInput): SubmitResult {
    const sourceId = input.sourceId ?? 'stdin';
    const messageId = `submit-${randomUUID()}`;
    const message: InboundMessage = {
      id: messageId,
      text: input.text,
      kind: 'chat.message',
      receivedAt: nowIso(this.now),
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(input.newThread ? { newThread: true } : {}),
    };
    const threadId = normalizeThreadKey(sourceId, message, this.now());
    this.record(sourceId, message, threadId);

    const done = new Promise<SessionResult | null>(resolve => {
      const list = this.waiters.get(threadId) ?? [];
      list.push(resolve);
      this.waiters.set(threadId, list);
    });
    this.wake();
    return { threadId, messageId, done };
  }

  /** 中止某个 thread 的当前 turn；消息会在收尾时退回队列。 */
  abortThread(threadId: string): boolean {
    const task = this.tasks.get(threadId);
    if (!task) return false;
    task.abort('用户中断了本轮');
    return true;
  }

  snapshot(): { threads: number; pending: number; sources: Array<{ id: string; kind: string }> } {
    return {
      threads: this.running.size,
      pending: this.store.pendingThreads(this.now()).length,
      sources: this.sources.map(source => ({ id: source.id, kind: source.kind })),
    };
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // 先把来源里已经缓冲的消息收进来，再停订阅；正在跑的 turn 不打断。
    await this.collect();
    for (const source of this.sources) {
      try {
        await source.close?.();
      } catch {
        // 来源关闭失败不阻塞退出。
      }
    }
    for (;;) {
      const pending = this.store.pendingThreads(this.now());
      if (pending.length === 0) break;
      this.schedule(pending);
      await this.idle();
      if (this.store.pendingThreads(this.now()).length === 0) break;
      if (this.running.size === 0) break;
    }
    for (const list of this.waiters.values()) {
      for (const resolve of list) resolve(null);
    }
    this.waiters.clear();
  }

  private async sweepOnce(): Promise<void> {
    if (this.stopped) return;
    await this.collect();
    if (this.stopped) return;
    this.schedule(this.store.pendingThreads(this.now()));
  }

  /** 拉取所有来源并写入本地 inbox；stop 前的最后一次收口也用它。 */
  private async collect(): Promise<void> {
    const pages = await Promise.all(this.sources.map(async source => {
      try {
        return await source.poll();
      } catch (error) {
        this.log(`[${this.agentId}] 来源 ${source.id} 拉取失败：${messageOf(error)}`);
        return [];
      }
    }));

    for (let index = 0; index < this.sources.length; index += 1) {
      const source = this.sources[index]!;
      for (const message of pages[index] ?? []) {
        const threadId = normalizeThreadKey(source.id, message, this.now());
        const inserted = this.record(source.id, message, threadId);
        if (!inserted) await this.reack(source, message);
      }
    }
  }

  private schedule(pending: Array<{ threadId: string; sources: string[] }>): void {
    const limit = this.runtime.concurrency;
    const isInteractive = (sources: string[]): boolean =>
      sources.some(sourceId => this.sourcesById.get(sourceId)?.kind === 'interactive');

    for (const item of pending) {
      if (this.running.size >= limit) break;
      if (!isInteractive(item.sources)) continue;
      if (!this.running.has(item.threadId)) this.startThread(item.threadId, 'interactive');
    }

    let backgroundRunning = [...this.kinds.values()].filter(kind => kind === 'background').length;
    const backgroundCap = Math.max(1, limit - 1);
    for (const item of pending) {
      if (this.running.size >= limit || backgroundRunning >= backgroundCap) break;
      if (isInteractive(item.sources)) continue;
      if (this.running.has(item.threadId)) continue;
      this.startThread(item.threadId, 'background');
      backgroundRunning += 1;
    }
  }

  private record(sourceId: string, message: InboundMessage, threadId: string): boolean {
    const payload: Record<string, unknown> = { type: message.kind ?? 'chat.message' };
    if (message.text) payload.text = message.text;
    if (message.title) payload.title = message.title;
    if (message.taskId) payload.task_id = message.taskId;
    if (message.data !== undefined) payload.data = message.data;
    return this.store.recordIncoming({
      messageId: message.id,
      threadId,
      senderDid: message.sender ?? null,
      targetDid: this.runtime.agentId,
      contentType: 'application/json',
      body: { payload },
      replyTo: message.replyTo ?? null,
      receivedAt: message.receivedAt ?? nowIso(this.now),
      source: sourceId,
      sourceDelivery: message.delivery,
    });
  }

  private async reack(source: MessageSource, message: InboundMessage): Promise<void> {
    if (!source.ack) return;
    const row = this.store.inboxByMessage(message.id);
    if (row?.status !== 'acked') return;
    try {
      await source.ack(message);
    } catch {
      // 下次 poll 还会收到同一条；本地已 ack，不会重复执行。
    }
  }

  private startThread(threadId: string, kind: 'interactive' | 'background'): void {
    if (this.running.has(threadId)) return;
    const turn = new ThreadTurn({
      runtime: this.runtime,
      definition: this.definition,
      store: this.store,
      sources: this.sourcesById,
      threadId,
      stream: this.stream,
      allowMissingTools: this.allowMissingTools,
      emit: event => this.onEvent(event),
      log: (level, text) => this.log(`[${this.agentId}] ${level}: ${text}`),
    });
    this.tasks.set(threadId, turn);
    const promise = turn
      .run()
      .catch(error => {
        this.log(`[${this.agentId}] thread ${threadId} 运行失败：${messageOf(error)}`);
        const failed: SessionResult = {
          status: 'failed',
          turns: 0,
          promptTokens: 0,
          completionTokens: 0,
          error: messageOf(error),
          summary: null,
          toolExecuted: false,
          mailSessionId: null,
        };
        return failed;
      })
      .then(result => {
        this.lastResults.set(threadId, result);
        return result;
      })
      .finally(() => {
        this.running.delete(threadId);
        this.kinds.delete(threadId);
        this.tasks.delete(threadId);
        this.resolveIfIdle(threadId);
        if (!this.stopped) this.wake();
      });
    this.running.set(threadId, promise);
    this.kinds.set(threadId, kind);
  }

  private resolveIfIdle(threadId: string): void {
    if (this.store.pendingThreads(this.now()).some(item => item.threadId === threadId)) return;
    const list = this.waiters.get(threadId);
    if (!list) return;
    this.waiters.delete(threadId);
    const result = this.lastResults.get(threadId) ?? null;
    this.lastResults.delete(threadId);
    for (const resolve of list) resolve(result);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
