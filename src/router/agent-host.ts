/**
 * 一个常驻 Agent：身份、数据面、运行时与小循环。
 *
 * host 每秒扫一次自己的 inbox：先 sync + 重试 outbox，再为有到期消息的 thread
 * 抢 session 跑 turn。单个 host 的错误只影响它自己的 thread；router 不共享
 * AgentStore 或 Brain 实例。
 */

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { AnpSigningIdentity } from '@anpio-cli/core';
import type { Brain } from '../brains/types.ts';
import type { EmbeddedAgentDefinition } from '../definition.ts';
import { isLocalTool, isRouterTool } from '../definition.ts';
import { AnpClient, type AnpPayload } from '../anp/client.ts';
import { loadOrCreateIdentity, writeAgentJson, type ServiceEndpoints } from '../anp/identity.ts';
import { AgentRuntime } from '../runtime/agent.ts';
import type { BrainLoopTools } from '../runtime/brain-loop.ts';
import type { AgentTransport } from '../runtime/transport.ts';
import type { SessionResult } from '../runtime/types.ts';
import { ANP_ENVIRONMENT } from '../runtime/anp/context.ts';
import { AnpMailbox } from '../runtime/anp/mailbox.ts';
import { AnpTurnLedger } from '../runtime/anp/ledger.ts';
import { AnpTurnSession } from '../runtime/anp/session.ts';
import { AgentStore } from '../store/agent-store.ts';
import type { RouterStore } from '../store/router-store.ts';
import type { AgentEntry } from './registry.ts';

export type AgentHostOptions = {
  root: string;
  entry: AgentEntry;
  endpoints: ServiceEndpoints;
  call: (request: unknown) => Promise<Record<string, unknown>>;
  router: RouterStore;
  log: (line: string) => void;
  /** 测试替身；缺省按 provider 构造。 */
  brain?: Brain;
  /** 重载定义后重建 Brain；缺省沿用 brain 或 provider。 */
  brainFactory?: (definition: EmbeddedAgentDefinition) => Brain | undefined;
  maxActiveTurns: number;
  sweepIntervalMs?: number;
  now?: () => number;
  /** 子 agent 把 workspace 放在父的 workspace/subagents 下。 */
  workspaceBase?: string;
  toolFactory?: (input: {
    runDir: string;
    turnId: string;
    definition: EmbeddedAgentDefinition;
    threadId: string;
    triggerMessageId: string | null;
    store: AgentStore;
    mailbox: AnpMailbox;
    markReplied: () => void;
    agentId: string;
    entry: AgentEntry;
  }) => BrainLoopTools;
};

function anpTransport(): AgentTransport {
  const unused = async () => {
    throw new Error('ANP 常驻运行不经过平台传输层');
  };
  return {
    mailbox: {
      open: unused as never,
      pull: unused as never,
      message: unused as never,
      ack: unused as never,
      nack: unused as never,
      close: async () => undefined,
    },
    runs: {
      heartbeat: async () => undefined,
      log: async () => undefined,
      finish: async () => undefined,
      status: async () => ({ status: 'running' }),
    },
    presence: { heartbeat: async () => undefined },
    supportsTool: () => true,
    environment: ANP_ENVIRONMENT,
  };
}

export class AgentHost {
  readonly agentId: string;
  readonly directory: string;

  private entry: AgentEntry;
  private runtime: AgentRuntime | null = null;
  private store: AgentStore | null = null;
  private client: AnpClient | null = null;
  private signingIdentity: AnpSigningIdentity | null = null;
  private readonly mailboxes = new Map<string, AnpMailbox>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly tasks = new Map<string, AnpTurnSession>();
  private timer: NodeJS.Timeout | null = null;
  private sweepPromise: Promise<void> | null = null;
  private wakeAgain = false;
  private stopped = false;
  private pendingEntry: AgentEntry | null = null;
  private lastErrorText: string | null = null;

  private readonly options: AgentHostOptions;
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private activeLimit: number;

  constructor(options: AgentHostOptions) {
    this.options = options;
    this.entry = options.entry;
    this.agentId = options.entry.definition.id;
    this.directory = join(options.root, 'agents', this.agentId);
    this.log = options.log;
    this.now = options.now ?? Date.now;
    this.activeLimit = options.maxActiveTurns;
  }

  get definition(): EmbeddedAgentDefinition {
    return this.entry.definition;
  }

  get anpConfig(): AgentEntry['anp'] {
    return this.entry.anp;
  }

  get identity(): AnpSigningIdentity {
    if (!this.signingIdentity) throw new Error(`agent ${this.agentId} 尚未启动`);
    return this.signingIdentity;
  }

  get did(): string {
    return this.identity.did;
  }

  get dataStore(): AgentStore {
    if (!this.store) throw new Error(`agent ${this.agentId} 尚未启动`);
    return this.store;
  }

  get activeTurns(): number {
    return this.running.size;
  }

  get lastError(): string | null {
    return this.lastErrorText;
  }

  get enabled(): boolean {
    return !this.stopped;
  }

  async start(): Promise<void> {
    const endpoints = this.options.endpoints;
    const unsupported = this.entry.definition.tools.filter(tool => !isLocalTool(tool) && !isRouterTool(tool));
    if (unsupported.length > 0) {
      throw new Error(
        `agent ${this.agentId} 定义了 router 不提供的工具：${unsupported.join(', ')}`,
      );
    }
    const identity = await loadOrCreateIdentity(this.directory, endpoints, this.agentId);
    this.signingIdentity = identity;
    this.store = new AgentStore(join(this.directory, 'agent.db'));
    this.client = new AnpClient({ identity, call: this.options.call });
    this.runtime = await this.buildRuntime(this.entry.definition);
    this.options.router.upsertAgent({
      agentId: this.agentId,
      name: this.entry.definition.name,
      definition: this.entry.definition,
      did: identity.did,
      enabled: true,
    });
    await this.writeAgentFile();

    if ((this.options.sweepIntervalMs ?? 1_000) > 0) {
      this.timer = setInterval(() => this.wake(), this.options.sweepIntervalMs ?? 1_000);
      this.timer.unref?.();
    }
    this.wake();
    this.log(`[${this.agentId}] 已启动 ${identity.did}`);
  }

  /** 定义热更新：没有进行中的 turn 时立即替换；否则等当前 turn 结束后替换。 */
  async reconfigure(entry: AgentEntry, maxActiveTurns: number): Promise<void> {
    this.pendingEntry = entry;
    this.activeLimit = maxActiveTurns;
    if (this.running.size === 0) await this.applyPending();
  }

  setEnabled(enabled: boolean): void {
    if (!enabled) {
      this.stopped = true;
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      for (const task of this.tasks.values()) task.abort('router 正在停用该 agent');
      this.options.router.setAgentEnabled(this.agentId, false);
    } else if (this.stopped) {
      this.stopped = false;
      this.options.router.setAgentEnabled(this.agentId, true);
      if ((this.options.sweepIntervalMs ?? 1_000) > 0 && !this.timer) {
        this.timer = setInterval(() => this.wake(), this.options.sweepIntervalMs ?? 1_000);
        this.timer.unref?.();
      }
      this.wake();
    }
  }

  wake(): void {
    if (this.stopped) return;
    if (this.sweepPromise) {
      this.wakeAgain = true;
      return;
    }
    const sweep = this.sweepOnce()
      .catch(error => {
        this.lastErrorText = error instanceof Error ? error.message : String(error);
        this.log(`[${this.agentId}] 扫描失败：${this.lastErrorText}`);
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

  /** 扫一遍并启动可开始的 turn；启动的 turn 不在这里等待。 */
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
      if (this.dataStore.pendingThreadIds(this.now()).length === 0) return;
    }
  }

  private async sweepOnce(): Promise<void> {
    if (this.stopped) return;
    const mailbox = this.baseMailbox();
    await mailbox.sync();
    await mailbox.flushOutbox();
    if (this.stopped) return;
    for (const threadId of this.dataStore.pendingThreadIds(this.now())) {
      if (this.running.size >= this.activeLimit) break;
      if (this.running.has(threadId)) continue;
      this.startThread(threadId);
    }
  }

  /** 等待当前所有 turn 结束。 */
  async idle(): Promise<void> {
    while (this.running.size > 0) {
      await Promise.all([...this.running.values()]);
    }
  }

  async send(
    targetDid: string,
    threadId: string,
    payload: AnpPayload,
    replyTo?: string | null,
  ): Promise<{ accepted: boolean; messageId: string; queued: boolean }> {
    const result = await this.baseMailbox().send({ targetDid, threadId, payload, replyTo: replyTo ?? null });
    return { accepted: result.accepted, messageId: result.messageId, queued: result.queued };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const task of this.tasks.values()) task.abort('router 正在关闭');
    await this.idle();
    this.store?.close();
    this.store = null;
    this.log(`[${this.agentId}] 已停止`);
  }

  private async buildRuntime(definition: EmbeddedAgentDefinition): Promise<AgentRuntime> {
    const brain = this.options.brainFactory?.(definition) ?? this.options.brain;
    return AgentRuntime.create({
      agentId: this.agentId,
      definition,
      transport: anpTransport(),
      rootBase: this.options.workspaceBase ?? join(this.options.root, 'agents'),
      ...(brain ? { brain } : {}),
    });
  }

  private async applyPending(): Promise<void> {
    const entry = this.pendingEntry;
    if (!entry) return;
    this.pendingEntry = null;
    const previous = this.entry;
    this.entry = entry;
    this.runtime = await this.buildRuntime(entry.definition);
    this.options.router.upsertAgent({
      agentId: this.agentId,
      name: entry.definition.name,
      definition: entry.definition,
      did: this.did,
      enabled: !this.stopped,
    });
    await this.writeAgentFile();
    this.log(
      `[${this.agentId}] 定义已更新（${previous.definition.updatedAt} → ${entry.definition.updatedAt}）`,
    );
    this.wake();
  }

  private async writeAgentFile(): Promise<void> {
    await writeAgentJson(this.directory, {
      ...this.entry.definition,
      anp: {
        did: this.did,
        keyid: this.identity.keyid,
        didBaseUrl: this.options.endpoints.didBaseUrl,
        publicUrl: this.options.endpoints.publicUrl,
        rpcPath: this.options.endpoints.rpcPath,
        isolation: this.entry.anp.isolation,
        allowSchedules: this.entry.anp.allowSchedules,
      },
    });
  }

  private baseMailbox(): AnpMailbox {
    return this.mailboxFor('*');
  }

  private mailboxFor(threadId: string): AnpMailbox {
    const existing = this.mailboxes.get(threadId);
    if (existing) return existing;
    const mailbox = new AnpMailbox({
      store: this.dataStore,
      client: this.client!,
      threadId,
      now: this.now,
    });
    this.mailboxes.set(threadId, mailbox);
    return mailbox;
  }

  private startThread(threadId: string): void {
    if (this.running.has(threadId)) return;
    const promise = this.runThread(threadId)
      .catch(error => {
        this.lastErrorText = error instanceof Error ? error.message : String(error);
        this.log(`[${this.agentId}] thread ${threadId} 运行失败：${this.lastErrorText}`);
      })
      .finally(() => {
        this.running.delete(threadId);
        if (this.pendingEntry && this.running.size === 0) {
          void this.applyPending().catch(error => {
            this.lastErrorText = error instanceof Error ? error.message : String(error);
            this.log(`[${this.agentId}] 应用新定义失败：${this.lastErrorText}`);
          });
        }
        if (!this.stopped) this.wake();
      });
    this.running.set(threadId, promise);
  }

  private async runThread(threadId: string): Promise<void> {
    const runtime = this.runtime;
    if (!runtime || this.stopped) return;
    this.options.router.ensureThread({ threadId, ownerAgentId: this.agentId });
    this.options.router.addMember(threadId, this.agentId);
    const session = this.options.router.ensureSession({
      sessionId: `sess-${randomUUID()}`,
      agentId: this.agentId,
      threadId,
      state: 'idle',
    });
    const turnId = `turn-${randomUUID()}`;
    if (!this.options.router.claimSession(session.session_id, turnId)) return;
    const runId = `run-${randomUUID()}`;
    const current = this.options.router.getSession(session.session_id)!;
    const trigger = this.dataStore.db.get<{ message_id: string }>(
      `SELECT message_id FROM inbox WHERE thread_id = ? AND status = 'pending' ORDER BY seq LIMIT 1`,
      threadId,
    );
    const ledger = new AnpTurnLedger({
      router: this.options.router,
      store: this.dataStore,
      sessionId: session.session_id,
      turnId,
      agentId: this.agentId,
      threadId,
      runId,
      log: (level, text) => this.log(`[${this.agentId}] ${level}: ${text}`),
    });
    const toolFactory = this.options.toolFactory;
    const task = new AnpTurnSession({
      runtime,
      definition: this.entry.definition,
      store: this.dataStore,
      mailbox: this.mailboxFor(threadId),
      ledger,
      session: current,
      turnId,
      runId,
      threadId,
      triggerMessageId: trigger?.message_id ?? null,
      ...(toolFactory
        ? {
            toolFactory: toolInput => toolFactory({
              ...toolInput,
              agentId: this.agentId,
              entry: this.entry,
            }),
          }
        : {}),
    });
    this.tasks.set(threadId, task);
    let result: SessionResult | null = null;
    try {
      result = await task.run();
    } finally {
      this.tasks.delete(threadId);
      this.options.router.releaseSession(session.session_id);
    }
    if (result) {
      this.log(
        `[${this.agentId}] turn ${turnId} ${result.status}`
        + (result.summary ? `：${result.summary.slice(0, 120)}` : '')
        + (result.error ? `（${result.error}）` : ''),
      );
    }
  }
}
