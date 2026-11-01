/**
 * Router 实例：把身份、ANP 服务、公开面、多个 AgentHost 与管理接口组装起来。
 *
 * `main.ts` 只负责命令行；测试可以直接创建实例并关闭端口监听，用进程内
 * `service.call` 完成投递，避免依赖本机端口。
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Brain } from '../brains/types.ts';
import { createDidServer, type DidServerAgent, type RunningDidServer } from '../anp/did-server.ts';
import { agentDescriptionFor } from '../anp/description.ts';
import { fingerprintOfDid, type ServiceEndpoints } from '../anp/identity.ts';
import { createAnpService, RPC_PATH, type AnpService } from '../anp/service.ts';
import type { EmbeddedAgentDefinition } from '../definition.ts';
import { normalizeDefinition } from '../standalone/config.ts';
import type { AgentSummary, SpawnAgentToolInput } from '../tools/subagent.ts';
import { RouterStore } from '../store/router-store.ts';
import { createAdmin, type AdminSendInput, type AdminSendResult } from './admin.ts';
import { AgentHost } from './agent-host.ts';
import type { RouterConfig } from './config.ts';
import { Delivery } from './delivery.ts';
import { acquireLock, type RouterLock } from './lock.ts';
import { AgentRegistry, type AgentEntry, type RegistryDiff } from './registry.ts';
import { routeMessage, type RouteDecision, type RoutingCandidate } from './routing.ts';
import { RouterScheduler } from './scheduler.ts';
import { ContainerToolExecutor, probeContainer } from './container.ts';
import { createTurnTools } from './turn-tools.ts';

export type RouterStartOptions = {
  config: RouterConfig;
  log?: (line: string) => void;
  /** 测试替身：按 agentId 注入 Brain。 */
  brains?: Record<string, Brain>;
  /** 动态 agent（子 agent）的 Brain 工厂；返回值优先于 brains。 */
  brainFactory?: (agentId: string, definition: EmbeddedAgentDefinition) => Brain | undefined;
  /** false 时不监听端口；测试用进程内调用。 */
  listen?: boolean;
};

export type RouterStatus = {
  ok: boolean;
  agents: number;
  activeTurns: number;
  pendingMessages: number;
  service: { host: string; port: number };
  didServer: { host: string; port: number } | null;
  lock: RouterLock['info'];
};

export type RouterSendResult = AdminSendResult & { threadId: string };

const DEFAULT_MAX_CHILDREN = 3;
const DEFAULT_MAX_DEPTH = 2;
const DEFAULT_CHILD_TTL_MS = 3_600_000;
const MIN_CHILD_TTL_MS = 60_000;
const MAX_CHILD_TTL_MS = 86_400_000;

export type SpawnedAgent = {
  agentId: string;
  did: string;
  threadId: string;
  depth: number;
  ttlAt: string;
  taskMessageId?: string;
};

export class RouterRuntime {
  readonly config: RouterConfig;
  readonly store: RouterStore;
  readonly registry: AgentRegistry;
  readonly hosts = new Map<string, AgentHost>();
  readonly startedAt = new Date().toISOString();

  private readonly options: RouterStartOptions;
  private readonly logLine: (line: string) => void;
  private lock: RouterLock | null = null;
  private service: AnpService | null = null;
  private didServer: RunningDidServer | null = null;
  private delivery: Delivery | null = null;
  private scheduler: RouterScheduler | null = null;
  private watcher: NodeJS.Timeout | null = null;
  private childTimer: NodeJS.Timeout | null = null;
  private reloadChain: Promise<RegistryDiff>;
  private readonly hostErrors = new Map<string, string>();
  private containerReady: boolean | null = null;
  private containerError: string | null = null;
  private closing = false;

  private constructor(options: RouterStartOptions, store: RouterStore) {
    this.options = options;
    this.config = options.config;
    this.store = store;
    this.registry = new AgentRegistry(options.config.agentsFile);
    const file = join(options.config.root, 'router.log');
    this.logLine = line => {
      const text = `${new Date().toISOString()} ${line}`;
      (options.log ?? ((value: string) => console.log(value)))(text);
      void appendFile(file, `${text}\n`).catch(() => undefined);
    };
    this.reloadChain = Promise.resolve({ added: [], updated: [], removed: [] });
  }

  static async start(options: RouterStartOptions): Promise<RouterRuntime> {
    await mkdir(options.config.root, { recursive: true, mode: 0o700 });
    const store = new RouterStore(join(options.config.root, 'router.db'));
    const runtime = new RouterRuntime(options, store);
    await runtime.bootstrap();
    return runtime;
  }

  get serviceAddress(): { host: string; port: number } | null {
    return this.service ? { ...this.service.address } : null;
  }

  get didServerAddress(): { host: string; port: number } | null {
    return this.didServer ? { ...this.didServer.address } : null;
  }

  getAgent(agentId: string): AgentHost | undefined {
    return this.hosts.get(agentId);
  }

  candidates(): RoutingCandidate[] {
    return [...this.hosts.values()].map(host => ({
      agentId: host.agentId,
      did: host.did,
      capabilities: host.definition.capabilities,
      description: host.definition.description,
      enabled: host.enabled,
    }));
  }

  route(input: { to?: string | null; threadId?: string | null; skills?: string[] }): RouteDecision | null {
    const threadOwner = input.threadId ? this.store.getThread(input.threadId)?.owner_agent_id ?? null : null;
    return routeMessage(this.candidates(), {
      to: input.to ?? null,
      threadOwner,
      skills: input.skills ?? [],
      defaultAgent: this.config.defaultAgent,
    });
  }

  /** 以某个本地 agent 的身份投递；目标由路由规则决定。 */
  async send(input: AdminSendInput): Promise<RouterSendResult> {
    const from = this.hosts.get(input.from);
    if (!from) throw new Error(`agent 不存在或未启动：${input.from}`);
    const route = this.route({ to: input.to, threadId: input.threadId, skills: input.skills });
    if (!route) throw new Error('没有可投递的目标 agent');
    const target = this.hosts.get(route.agentId);
    if (!target) throw new Error(`路由目标未启动：${route.agentId}`);
    const threadId = input.threadId ?? `thread-${randomUUID()}`;
    this.delivery?.wakeHost(target, threadId);
    const sent = await from.send(route.did, threadId, input.payload, input.replyTo ?? null);
    return { route, messageId: sent.messageId, queued: sent.queued, threadId };
  }

  /** Turn 内工具投递：to 必须是明确的 DID 或本机 agent id，不做能力兜底。 */
  async sendFrom(
    fromAgentId: string,
    input: { to: string; threadId: string; payload: AdminSendInput['payload']; replyTo?: string | null },
  ): Promise<{ messageId: string; threadId: string; targetDid: string; queued: boolean }> {
    const from = this.hosts.get(fromAgentId);
    if (!from) throw new Error(`agent 不存在或未启动：${fromAgentId}`);
    const target = this.resolveTarget(input.to);
    if (target.host) this.delivery?.wakeHost(target.host, input.threadId);
    const sent = await from.send(target.did, input.threadId, input.payload, input.replyTo ?? null);
    return {
      messageId: sent.messageId,
      threadId: input.threadId,
      targetDid: target.did,
      queued: sent.queued,
    };
  }

  agentSummaries(): AgentSummary[] {
    return [...this.hosts.values()].map(host => {
      const link = this.store.getLink(host.agentId);
      return {
        agentId: host.agentId,
        name: host.definition.name,
        did: host.did,
        description: host.definition.description,
        capabilities: host.definition.capabilities,
        enabled: host.enabled,
        activeTurns: host.activeTurns,
        parentId: link?.parent_id ?? null,
        depth: link?.depth ?? 0,
      };
    });
  }

  agentStatus(agentId: string): unknown {
    const host = this.hosts.get(agentId);
    if (!host) return null;
    const summary = this.agentSummaries().find(item => item.agentId === agentId);
    const link = this.store.getLink(agentId);
    return {
      ...summary,
      anp: host.anpConfig,
      children: this.store.listChildren(agentId).map(child => child.child_id),
      sessions: this.store.listSessions(agentId).map(session => ({
        sessionId: session.session_id,
        threadId: session.thread_id,
        state: session.state,
      })),
      turns: this.store.listTurns(agentId, undefined, 5),
      ttlAt: link?.ttl_at ?? null,
      lastError: host.lastError,
    };
  }

  /**
   * 创建子 agent：工具只能收缩，深度与每个父的子数量都有上限。
   * 子 agent 用独立身份与存储，workspace 落在父的 workspace/subagents 下。
   */
  async spawnAgent(parentId: string, input: SpawnAgentToolInput): Promise<SpawnedAgent> {
    const parent = this.hosts.get(parentId);
    if (!parent) throw new Error(`父 agent 不存在或未启动：${parentId}`);
    const anp = parent.anpConfig;
    if (!anp.allowSpawn) throw new Error(`agent ${parentId} 未开启 anp.allowSpawn`);

    const parentDepth = this.store.getLink(parentId)?.depth ?? 0;
    const maxDepth = anp.maxDepth ?? DEFAULT_MAX_DEPTH;
    const depth = parentDepth + 1;
    if (depth > maxDepth) throw new Error(`子 agent 深度超过上限 ${maxDepth}`);
    const maxChildren = anp.maxChildren ?? DEFAULT_MAX_CHILDREN;
    if (this.store.countChildren(parentId) >= maxChildren) {
      throw new Error(`agent ${parentId} 的子 agent 已达到上限 ${maxChildren}`);
    }

    const parentTools = new Set(parent.definition.tools);
    const requested = input.tools ?? parent.definition.tools;
    const invalid = requested.filter(tool => !parentTools.has(tool));
    if (invalid.length > 0) {
      throw new Error(`子 agent 工具必须是父工具的子集；不允许：${invalid.join(', ')}`);
    }
    const childAllowSpawn = anp.allowSpawn && depth < maxDepth;
    const tools = requested.filter(tool => childAllowSpawn || tool !== 'spawn_agent');

    const ttlMs = Math.min(
      MAX_CHILD_TTL_MS,
      Math.max(MIN_CHILD_TTL_MS, input.ttlMs ?? DEFAULT_CHILD_TTL_MS),
    );
    const ttlAt = new Date(Date.now() + ttlMs).toISOString();
    const childId = childIdFor(parentId, input.name);
    const definition = normalizeDefinition(
      {
        ...parent.definition,
        id: childId,
        name: input.name,
        description: input.description,
        capabilities: input.capabilities.length > 0
          ? input.capabilities
          : parent.definition.capabilities,
        systemPrompt: [
          parent.definition.systemPrompt,
          `# 子 agent`,
          `你是 ${parent.definition.name}（${parentId}）创建的子 agent，通过同一个 thread 与它协作。`,
          `职责：${input.description}`,
        ].join('\n\n'),
        tools,
        limits: {
          ...parent.definition.limits,
          maxTurns: input.maxTurns ?? Math.min(parent.definition.limits.maxTurns, 10),
        },
        concurrency: 1,
        enabled: true,
        completion: 'finish',
        createdAt: undefined,
        updatedAt: undefined,
        lastRunAt: null,
        lastError: null,
      },
      childId,
    );
    const entry: AgentEntry = {
      definition,
      anp: {
        allowSchedules: false,
        allowSpawn: childAllowSpawn,
        isolation: anp.isolation,
        maxActiveTurns: 1,
        network: anp.network,
        networkAllowlist: [...anp.networkAllowlist],
        maxChildren: anp.maxChildren,
        maxDepth: anp.maxDepth,
        maxSchedules: anp.maxSchedules,
      },
    };

    const brain = this.options.brains?.[childId]
      ?? this.options.brainFactory?.(childId, definition);
    const host = this.newHost({
      entry,
      maxActiveTurns: 1,
      workspaceBase: join(parent.directory, 'workspace', 'subagents'),
      ...(brain ? { brain } : {}),
    });
    await host.start();
    try {
      this.hosts.set(childId, host);
      this.store.createLink({ parentId, childId, depth, ttlAt });
      this.store.upsertAgent({
        agentId: childId,
        name: definition.name,
        definition,
        did: host.did,
        enabled: true,
      });
      this.logLine(
        `[${childId}] 子 agent 已创建：parent=${parentId} depth=${depth} ttl=${ttlAt}`,
      );
    } catch (error) {
      this.hosts.delete(childId);
      await host.stop().catch(() => undefined);
      throw error;
    }

    const threadId = input.threadId?.trim() || `thread-${randomUUID()}`;
    const result: SpawnedAgent = { agentId: childId, did: host.did, threadId, depth, ttlAt };
    if (input.task) {
      const taskId = `task-${randomUUID()}`;
      const sent = await this.sendFrom(parentId, {
        to: childId,
        threadId,
        payload: { type: 'anp.task.request', task_id: taskId, text: input.task },
      });
      result.taskMessageId = sent.messageId;
    }
    return result;
  }

  /** 过期子 agent：停 host、标记 disabled；workspace 与数据保留。 */
  async expireChildren(now = new Date()): Promise<string[]> {
    const expired = this.store.expireLinks(now.toISOString());
    const ids: string[] = [];
    for (const link of expired) {
      const host = this.hosts.get(link.child_id);
      if (!host) continue;
      this.hosts.delete(link.child_id);
      await host.stop().catch(() => undefined);
      this.store.setAgentEnabled(link.child_id, false);
      this.logLine(`[${link.child_id}] 子 agent 已过期，host 停止（workspace 保留）`);
      ids.push(link.child_id);
    }
    return ids;
  }

  /** 把所有 host 的待处理消息跑到静止；主要给测试和一次性的管理操作使用。 */
  async drain(rounds = 8): Promise<void> {
    let previous = '';
    for (let round = 0; round < rounds; round += 1) {
      for (const host of this.hosts.values()) {
        if (host.enabled) await host.settle();
      }
      const snapshot = [...this.hosts.values()]
        .map(host => `${host.agentId}:${host.dataStore.getCursor('last_seq')}:`
          + `${host.dataStore.pendingThreadIds(Date.now()).length}:${host.activeTurns}`)
        .join('|');
      if (snapshot === previous) return;
      previous = snapshot;
    }
  }

  status(): RouterStatus {
    const agents = [...this.hosts.values()];
    return {
      ok: true,
      agents: agents.length,
      activeTurns: agents.reduce((total, host) => total + host.activeTurns, 0),
      pendingMessages: agents.reduce((total, host) => total + host.dataStore.pendingInboxCount(), 0),
      service: this.serviceAddress ?? { host: this.config.anpListen.host, port: this.config.anpListen.port },
      didServer: this.didServerAddress,
      lock: this.lock?.info ?? { pid: process.pid, startedAt: this.startedAt },
    };
  }

  /** 重新读取 agents.json；文件没变时不重复应用（force 用于管理接口）。 */
  reload(force = false): Promise<RegistryDiff> {
    const next = this.reloadChain.then(() => this.reloadNow(force));
    this.reloadChain = next.catch(() => ({ added: [], updated: [], removed: [] }));
    return next;
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.scheduler?.stop();
    this.scheduler = null;
    if (this.watcher) clearInterval(this.watcher);
    this.watcher = null;
    if (this.childTimer) clearInterval(this.childTimer);
    this.childTimer = null;
    for (const host of this.hosts.values()) {
      await host.stop().catch(() => undefined);
    }
    this.hosts.clear();
    await this.didServer?.close().catch(() => undefined);
    this.didServer = null;
    await this.service?.close().catch(() => undefined);
    this.service = null;
    this.store.close();
    await this.lock?.release().catch(() => undefined);
    this.lock = null;
    this.logLine('router 已停止');
  }

  // ------------------------------------------------------------ bootstrap

  private async bootstrap(): Promise<void> {
    this.lock = await acquireLock(join(this.config.root, 'router.lock'));
    this.logLine(`router 启动：root=${this.config.root} agents=${this.config.agentsFile}`);

    const recovered = this.store.recoverStaleSessions();
    if (recovered.length > 0) this.logLine(`恢复 ${recovered.length} 个未正常结束的 session`);

    const endpoints: ServiceEndpoints = {
      didBaseUrl: this.config.didBaseUrl,
      publicUrl: this.config.publicUrl,
      rpcPath: RPC_PATH,
    };

    this.service = createAnpService({
      directory: join(this.config.root, 'anp'),
      listen: this.config.anpListen,
      publicUrl: this.config.publicUrl,
      didBaseUrl: this.config.didBaseUrl,
      localKeys: () => this.localKeys(),
      onDelivered: event => {
        this.delivery?.wake(event.targetDid, event.threadId);
      },
      log: line => this.logLine(`[anp] ${line}`),
    });
    this.delivery = new Delivery({
      router: this.store,
      hosts: () => this.hosts,
      log: line => this.logLine(line),
    });

    await this.registry.load();
    for (const entry of this.registry.list()) {
      await this.applyEntry(entry, true);
    }

    this.scheduler = new RouterScheduler({
      store: this.store,
      hosts: () => this.hosts,
      send: (ownerAgentId, input) => this.sendFrom(ownerAgentId, {
        to: ownerAgentId,
        threadId: input.threadId,
        payload: input.payload,
      }),
      log: line => this.logLine(line),
      tickIntervalMs: this.config.scheduleTickIntervalMs,
    });
    this.scheduler.start();

    this.didServer = createDidServer({
      host: this.config.listen.host,
      port: this.config.listen.port,
      didBaseUrl: this.config.didBaseUrl,
      ...(this.config.adminToken ? { adminToken: this.config.adminToken } : {}),
      agents: () => this.publicAgents(),
      health: () => this.status(),
      admin: createAdmin({
        config: this.config,
        router: this.store,
        hosts: () => this.hosts,
        startedAt: this.startedAt,
        status: () => this.status(),
        send: input => this.send(input),
        reload: async () => {
          const result = await this.reload(true);
          return {
            added: result.added.map(entry => entry.definition.id),
            updated: result.updated.map(entry => entry.definition.id),
            removed: result.removed,
          };
        },
      }),
      log: line => this.logLine(`[did] ${line}`),
    });

    if (this.options.listen !== false) {
      await this.service.listen();
      await this.didServer.listen();
      this.logLine(
        `监听：ANP ${this.serviceAddress!.host}:${this.serviceAddress!.port}，`
        + `DID ${this.didServerAddress!.host}:${this.didServerAddress!.port}`,
      );
    }

    if (this.config.watchIntervalMs > 0) {
      this.watcher = setInterval(() => {
        void this.reload(false).catch(error => {
          this.logLine(`agents.json 热更新失败：${error instanceof Error ? error.message : String(error)}`);
        });
      }, this.config.watchIntervalMs);
      this.watcher.unref?.();
    }

    if (this.config.childScanIntervalMs > 0) {
      this.childTimer = setInterval(() => {
        void this.expireChildren().catch(error => {
          this.logLine(`子 agent 过期扫描失败：${error instanceof Error ? error.message : String(error)}`);
        });
      }, this.config.childScanIntervalMs);
      this.childTimer.unref?.();
    }
  }

  private localKeys(): Map<string, string> {
    const keys = new Map<string, string>();
    for (const host of this.hosts.values()) {
      const key = host.identity.publicKey as { publicKeyMultibase?: string };
      if (key.publicKeyMultibase) keys.set(host.did, key.publicKeyMultibase);
    }
    return keys;
  }

  private publicAgents(): DidServerAgent[] {
    const agents: DidServerAgent[] = [];
    for (const host of this.hosts.values()) {
      if (!host.enabled) continue;
      agents.push({
        agentId: host.agentId,
        did: host.did,
        fingerprint: fingerprintOfDid(host.did),
        document: host.identity.didDocument as unknown as Record<string, unknown>,
        description: agentDescriptionFor({
          agentId: host.agentId,
          did: host.did,
          definition: host.definition,
          enabled: host.enabled,
          didBaseUrl: this.config.didBaseUrl,
        }),
        definition: host.definition,
        enabled: host.enabled,
        didBaseUrl: this.config.didBaseUrl,
      });
    }
    return agents;
  }

  private async reloadNow(force: boolean): Promise<RegistryDiff> {
    if (this.closing) return { added: [], updated: [], removed: [] };
    const diff = force ? await this.registry.load() : await this.registry.refresh();
    if (!diff) return { added: [], updated: [], removed: [] };
    const touched = diff.added.length + diff.updated.length + diff.removed.length;
    if (touched === 0) return diff;
    for (const entry of diff.added) await this.applyEntry(entry, true);
    for (const entry of diff.updated) {
      const host = this.hosts.get(entry.definition.id);
      await this.applyEntry(entry, !host);
    }
    for (const agentId of diff.removed) {
      const host = this.hosts.get(agentId);
      this.hosts.delete(agentId);
      await host?.stop().catch(() => undefined);
      this.store.setAgentEnabled(agentId, false);
      this.logLine(`[${agentId}] 已从 agents.json 移除，host 停止`);
    }
    this.logLine(
      `agents.json 已更新：新增 ${diff.added.length}，变更 ${diff.updated.length}，移除 ${diff.removed.length}`,
    );
    return diff;
  }

  private async containerUsable(): Promise<boolean> {
    if (this.containerReady !== null) return this.containerReady;
    const probe = await probeContainer(this.config.container);
    this.containerReady = probe.available;
    this.containerError = probe.error;
    if (probe.available) {
      this.logLine(`容器运行时可用：${probe.version ?? this.config.container.docker}`);
    }
    return probe.available;
  }

  private async applyEntry(entry: AgentEntry, startIfMissing: boolean): Promise<void> {
    const agentId = entry.definition.id;
    const existing = this.hosts.get(agentId);
    if (!entry.definition.enabled) {
      if (existing) {
        this.hosts.delete(agentId);
        await existing.stop().catch(() => undefined);
      }
      this.store.setAgentEnabled(agentId, false);
      this.logLine(`[${agentId}] 定义为 disabled，未启动`);
      return;
    }

    if (entry.anp.isolation === 'container') {
      const usable = await this.containerUsable();
      if (!usable) {
        if (!this.config.container.allowMissing) {
          const message = `容器运行时不可用：${this.containerError ?? this.config.container.docker}`;
          this.hostErrors.set(agentId, message);
          this.store.setAgentEnabled(agentId, false);
          this.logLine(`[${agentId}] ${message}，未启动`);
          return;
        }
        this.logLine(`[${agentId}] 容器运行时不可用，回退为进程内工具执行：${this.containerError ?? ''}`);
      }
    }

    const maxActiveTurns = entry.anp.maxActiveTurns
      ?? this.config.maxActiveTurns
      ?? entry.definition.concurrency;
    if (existing && !startIfMissing) {
      await existing.reconfigure(entry, maxActiveTurns);
      return;
    }
    if (existing) {
      this.hosts.delete(agentId);
      await existing.stop().catch(() => undefined);
    }
    const host = this.newHost({ entry, maxActiveTurns });
    try {
      await host.start();
      this.hosts.set(agentId, host);
      this.hostErrors.delete(agentId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.hostErrors.set(agentId, message);
      this.store.setAgentEnabled(agentId, false);
      this.logLine(`[${agentId}] 启动失败，已跳过：${message}`);
    }
  }

  private newHost(input: {
    entry: AgentEntry;
    maxActiveTurns: number;
    workspaceBase?: string;
    brain?: Brain;
  }): AgentHost {
    const agentId = input.entry.definition.id;
    const injected = input.brain
      ?? this.options.brains?.[agentId]
      ?? this.options.brainFactory?.(agentId, input.entry.definition);
    const brainFactory = this.options.brainFactory
      ? (definition: EmbeddedAgentDefinition) =>
          this.options.brainFactory!(agentId, definition)
      : undefined;
    return new AgentHost({
      root: this.config.root,
      entry: input.entry,
      endpoints: {
        didBaseUrl: this.config.didBaseUrl,
        publicUrl: this.config.publicUrl,
        rpcPath: RPC_PATH,
      },
      call: request => this.service!.call(request),
      router: this.store,
      log: line => this.logLine(line),
      maxActiveTurns: input.maxActiveTurns,
      sweepIntervalMs: this.config.sweepIntervalMs,
      ...(input.workspaceBase ? { workspaceBase: input.workspaceBase } : {}),
      ...(injected ? { brain: injected } : {}),
      ...(brainFactory ? { brainFactory } : {}),
      toolFactory: toolInput => {
        const { docker, image, memory, cpus, pidsLimit } = this.config.container;
        const container = toolInput.entry.anp.isolation === 'container' && this.containerReady === true
          ? new ContainerToolExecutor({
              docker,
              image,
              memory,
              cpus,
              pidsLimit,
              workspace: toolInput.runDir,
              agentId: toolInput.agentId,
              threadId: toolInput.threadId,
              log: line => this.logLine(`[${toolInput.agentId}] ${line}`),
            })
          : null;
        return createTurnTools(
          {
            runDir: toolInput.runDir,
            turnId: toolInput.turnId,
            definition: toolInput.definition,
            threadId: toolInput.threadId,
            triggerMessageId: toolInput.triggerMessageId,
            store: toolInput.store,
            mailbox: toolInput.mailbox,
            markReplied: toolInput.markReplied,
            ...(container ? { local: container, dispose: () => container.dispose() } : {}),
          },
          {
            send: sendInput => this.sendFrom(toolInput.agentId, sendInput),
            listAgents: () => this.agentSummaries(),
            agentStatus: id => this.agentStatus(id),
            spawn: spawnInput => this.spawnAgent(toolInput.agentId, spawnInput),
            schedules: {
              create: scheduleInput => {
                if (!this.scheduler) throw new Error('调度器未启动');
                return this.scheduler.create(toolInput.agentId, scheduleInput);
              },
              cancel: id => {
                if (!this.scheduler) throw new Error('调度器未启动');
                return this.scheduler.cancel(toolInput.agentId, id);
              },
              list: () => {
                if (!this.scheduler) throw new Error('调度器未启动');
                return this.scheduler.list(toolInput.agentId);
              },
            },
            network: toolInput.entry.anp.network,
            allowlist: toolInput.entry.anp.networkAllowlist,
            log: (level, text) => this.logLine(`[${toolInput.agentId}] ${level}: ${text}`),
          },
        );
      },
    });
  }

  private resolveTarget(to: string): { did: string; host: AgentHost | null } {
    const target = to.trim();
    if (target === '') throw new Error('目标 agent 不能为空');
    if (target.startsWith('did:')) {
      const host = [...this.hosts.values()].find(item => item.did === target) ?? null;
      return { did: target, host };
    }
    const agentId = target.startsWith('agent:') ? target.slice('agent:'.length) : target;
    const host = this.hosts.get(agentId);
    if (!host) throw new Error(`目标 agent 不存在：${target}`);
    return { did: host.did, host };
  }
}

export async function startRouter(options: RouterStartOptions): Promise<RouterRuntime> {
  return RouterRuntime.start(options);
}

function childIdFor(parentId: string, name: string): string {
  const slug = `${parentId}--${name}`
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100);
  return `${slug || 'agent'}-${randomUUID().slice(0, 8)}`;
}

