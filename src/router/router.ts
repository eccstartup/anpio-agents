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
import { RouterStore } from '../store/router-store.ts';
import { createAdmin, type AdminSendInput, type AdminSendResult } from './admin.ts';
import { AgentHost } from './agent-host.ts';
import type { RouterConfig } from './config.ts';
import { Delivery } from './delivery.ts';
import { acquireLock, type RouterLock } from './lock.ts';
import { AgentRegistry, type AgentEntry, type RegistryDiff } from './registry.ts';
import { routeMessage, type RouteDecision, type RoutingCandidate } from './routing.ts';

export type RouterStartOptions = {
  config: RouterConfig;
  log?: (line: string) => void;
  /** 测试替身：按 agentId 注入 Brain。 */
  brains?: Record<string, Brain>;
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
  private watcher: NodeJS.Timeout | null = null;
  private reloadChain: Promise<RegistryDiff>;
  private readonly hostErrors = new Map<string, string>();
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
    if (this.watcher) clearInterval(this.watcher);
    this.watcher = null;
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
    const brain = this.options.brains?.[agentId];
    const host = new AgentHost({
      root: this.config.root,
      entry,
      endpoints: {
        didBaseUrl: this.config.didBaseUrl,
        publicUrl: this.config.publicUrl,
        rpcPath: RPC_PATH,
      },
      call: request => this.service!.call(request),
      router: this.store,
      log: line => this.logLine(line),
      maxActiveTurns,
      sweepIntervalMs: this.config.sweepIntervalMs,
      ...(brain ? { brain, brainFactory: () => brain } : {}),
    });
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
}

export async function startRouter(options: RouterStartOptions): Promise<RouterRuntime> {
  return RouterRuntime.start(options);
}

