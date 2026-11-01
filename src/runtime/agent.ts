/**
 * AgentRuntime：一个有身份、有资源、有配额的常驻体。
 *
 * 它持有定义快照、派生令牌的客户端、Brain、工具清单与 agent 级工作根，
 * 把这些无状态的适配层在多个 Session 之间复用；自身不持有任何一次对话的状态。
 * `concurrency` 决定同一 agent 能同时开多少个 Session。
 */

import { brainFor } from '../brains/index.ts';
import type { Brain, ToolSpec } from '../brains/types.ts';
import { CollabClient } from '../client.ts';
import type { EmbeddedAgentDefinition } from '../definition.ts';
import { ensureAgentRoot } from '../sandbox.ts';
import { createTools } from '../tools.ts';
import { AgentSession } from './session.ts';
import type { SessionRequest, SessionResult } from './types.ts';

export type AgentRuntimeOptions = {
  baseUrl: string;
  token: string;
  agentId: string;
  definition: EmbeddedAgentDefinition;
  /** 测试替身：跳过真实 HTTP 客户端。 */
  client?: CollabClient;
  /** 测试替身：跳过模型适配器与密钥解析。 */
  brain?: Brain;
};

export class AgentRuntime {
  readonly agentId: string;
  readonly definition: EmbeddedAgentDefinition;
  readonly client: CollabClient;
  /** `<runRoot>/<agentId>/`，跨 Session 的目录根。 */
  readonly root: string;

  private brainInstance: Brain | null;
  private specsCache: ToolSpec[] | null = null;
  private running = 0;
  private presence = 0;
  private readonly waiters: Array<() => void> = [];

  private constructor(options: AgentRuntimeOptions, root: string) {
    this.agentId = options.agentId;
    this.definition = options.definition;
    this.client = options.client ?? new CollabClient(options.baseUrl, options.token, { timeoutMs: 20_000 });
    this.root = root;
    this.brainInstance = options.brain ?? null;
  }

  static async create(options: AgentRuntimeOptions): Promise<AgentRuntime> {
    const root = await ensureAgentRoot(options.agentId);
    return new AgentRuntime(options, root);
  }

  /** Brain 按需构造：没有待处理消息时不需要模型密钥，行为与拆分前一致。 */
  get brain(): Brain {
    if (!this.brainInstance) this.brainInstance = brainFor(this.definition.provider);
    return this.brainInstance;
  }

  /**
   * 每次 Session 取用的 Brain。真实协议适配器无状态，可以在会话间复用；
   * script 适配器把步数记在闭包里，必须给每次会话一份新的。
   */
  brainForSession(): Brain {
    return this.definition.provider.protocol === 'script' ? brainFor(this.definition.provider) : this.brain;
  }

  get toolSpecs(): ToolSpec[] {
    if (!this.specsCache) {
      this.specsCache = createTools({
        client: this.client,
        runDir: this.root,
        runId: 'spec',
        definition: this.definition,
        log: () => undefined,
      }).specs;
    }
    return this.specsCache;
  }

  get concurrency(): number {
    const value = Math.trunc(this.definition.concurrency);
    return Number.isInteger(value) && value > 0 ? value : 1;
  }

  get activeSessions(): number {
    return this.running;
  }

  /**
   * 在线状态是 agent 级的：同一 agent 的多个 Session 里，只有最后一个结束时
   * 才把平台状态置为 offline，避免一个 Session 收尾把其它仍在跑的状态覆盖掉。
   */
  sessionBegin(): void {
    this.presence += 1;
  }

  async sessionEnd(): Promise<void> {
    this.presence = Math.max(0, this.presence - 1);
    if (this.presence > 0) return;
    try {
      await this.client.heartbeat({ state: 'offline', note: '内置智能体一轮结束' });
    } catch {
      // 展示性状态，失败可忽略。
    }
  }

  createSession(request: SessionRequest): AgentSession {
    return new AgentSession(this, request);
  }

  /** 取一个并发槽位；超出配额时排队，不拒绝。 */
  async acquire(): Promise<() => void> {
    if (this.running < this.concurrency) {
      this.running += 1;
      return () => this.release();
    }
    return await new Promise<() => void>(resolve => {
      this.waiters.push(() => {
        this.running += 1;
        resolve(() => this.release());
      });
    });
  }

  /** 一次完整的会话，自动占槽与释放。 */
  async runSession(request: SessionRequest): Promise<SessionResult> {
    const release = await this.acquire();
    try {
      return await this.createSession(request).run();
    } finally {
      release();
    }
  }

  private release(): void {
    this.running -= 1;
    const next = this.waiters.shift();
    if (next) next();
  }
}
