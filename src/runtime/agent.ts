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
import type { EmbeddedAgentDefinition, EmbeddedTool, SessionIsolation } from '../definition.ts';
import { ensureAgentRoot } from '../sandbox.ts';
import { createTools } from '../tools.ts';
import { ProcessSession } from './process-session.ts';
import { AgentSession } from './session.ts';
import { collabTransport, type AgentTransport } from './transport.ts';
import type { SessionRequest, SessionResult, SessionTask } from './types.ts';

export type AgentRuntimeOptions = {
  agentId: string;
  definition: EmbeddedAgentDefinition;
  transport: AgentTransport;
  /** 工作根；缺省用运行环境的 COLLAB_RUN_ROOT。 */
  rootBase?: string;
  /** 测试替身：跳过模型适配器与密钥解析。 */
  brain?: Brain;
};

export type CollabRuntimeOptions = {
  baseUrl: string;
  token: string;
  agentId: string;
  definition: EmbeddedAgentDefinition;
  rootBase?: string;
  brain?: Brain;
};

export class AgentRuntime {
  readonly agentId: string;
  readonly definition: EmbeddedAgentDefinition;
  readonly transport: AgentTransport;
  /** `<runRoot>/<agentId>/`，跨 Session 的目录根。 */
  readonly root: string;
  /** 调用方指定的工作根；缺省时由运行环境决定。 */
  readonly rootBase: string | undefined;

  private brainInstance: Brain | null;
  private specsCache: ToolSpec[] | null = null;
  private running = 0;
  private presence = 0;
  private readonly waiters: Array<() => void> = [];

  private constructor(options: AgentRuntimeOptions, root: string) {
    this.agentId = options.agentId;
    this.definition = options.definition;
    this.transport = options.transport;
    this.root = root;
    this.rootBase = options.rootBase;
    this.brainInstance = options.brain ?? null;
  }

  static async create(options: AgentRuntimeOptions): Promise<AgentRuntime> {
    const root = await ensureAgentRoot(options.agentId, options.rootBase);
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

  /** 定义里声明、且当前传输层确实能提供的工具。 */
  get tools(): EmbeddedTool[] {
    return this.definition.tools.filter(tool => this.transport.supportsTool(tool));
  }

  /** 定义里声明、但当前传输层无法提供的工具。 */
  get missingTools(): EmbeddedTool[] {
    return this.definition.tools.filter(tool => !this.transport.supportsTool(tool));
  }

  /** 启动时校验；missingTools 非空且不允许降级时直接报错。 */
  validateTools(allowMissing = false): void {
    if (!allowMissing && this.missingTools.length > 0) {
      throw new Error(
        `当前运行环境不支持这些工具：${this.missingTools.join(', ')}（需要对应的 ToolBackend）`,
      );
    }
  }

  get toolSpecs(): ToolSpec[] {
    if (!this.specsCache) {
      this.specsCache = createTools({
        backend: this.transport.tools,
        runDir: this.root,
        runId: 'spec',
        definition: this.definition,
        tools: this.tools,
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
      await this.transport.presence.heartbeat({ state: 'offline', note: '内置智能体一轮结束' });
    } catch {
      // 展示性状态，失败可忽略。
    }
  }

  createSession(request: SessionRequest): AgentSession {
    return new AgentSession(this, request);
  }

  /** 定义里的隔离级别；缺省 inline，老定义行为不变。 */
  get isolation(): SessionIsolation {
    return this.definition.sessionIsolation === 'process' ? 'process' : 'inline';
  }

  /**
   * worker 用的入口：按定义选择同进程 Session 或子进程 Session。
   * `runSession` 与 `session.ts` 入口保持 inline，避免子进程再套子进程。
   */
  createSessionTask(request: SessionRequest): SessionTask {
    const isolation = request.definition?.sessionIsolation ?? this.isolation;
    return isolation === 'process' ? new ProcessSession(this, request) : this.createSession(request);
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

/** anpio-collab 路径的工厂：保留原有连接方式，把客户端包成 AgentTransport。 */
export async function collabRuntime(options: CollabRuntimeOptions): Promise<AgentRuntime> {
  const client = new CollabClient(options.baseUrl, options.token, { timeoutMs: 20_000 });
  return await AgentRuntime.create({
    agentId: options.agentId,
    definition: options.definition,
    transport: collabTransport(client, { baseUrl: options.baseUrl, token: options.token }),
    ...(options.rootBase === undefined ? {} : { rootBase: options.rootBase }),
    ...(options.brain === undefined ? {} : { brain: options.brain }),
  });
}
