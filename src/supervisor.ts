/**
 * 内嵌智能体 supervisor：常驻但不加载模型。
 *
 * 每个定义对应一个 agent-worker 子进程，由 supervisor 按需拉起；worker 内部
 * 在 `definition.concurrency` 以内并发跑多个 Session。supervisor 只做调度：
 * 发现、放置、全局并发、心跳、recover、运行生命周期与日志前缀，
 * 不持有模型密钥之外任何一次运行的上下文。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CollabClient } from './client.ts';
import type { EmbeddedAgentDefinition, EmbeddedAgentView } from './definition.ts';
import { pruneSessionDirs } from './sandbox.ts';
import { deriveEmbeddedToken } from './token.ts';

type RunView = {
  id: string;
  agentId: string;
  status: string;
  workdir: string | null;
  startedAt?: string;
  heartbeatAt?: string | null;
};

type Options = {
  baseUrl: string;
  token: string;
  secret: string;
  tickMs: number;
  concurrency: number;
  once: boolean;
  agentFilter: string | null;
  agentsFile: string | null;
  idleMs: number;
  graceMs: number;
  healthFile: string | null;
  orphanTtlMs: number;
};

type WorkerEvent = {
  type?: string;
  runId?: string;
  status?: string;
  turns?: number;
  error?: string | null;
  reason?: string;
  concurrency?: number;
};

type WorkerHandle = {
  agentId: string;
  name: string;
  child: ChildProcess;
  hash: string;
  /** worker 已报告的运行中 Session。 */
  sessions: Set<string>;
  /** 已下发、worker 还没报告开始或结束的运行。 */
  pending: Set<string>;
  timers: Map<string, NodeJS.Timeout>;
  ready: boolean;
  stopping: boolean;
  lastActiveAt: number;
};

function options(): Options {
  const token = process.env.COLLAB_RUNTIME_TOKEN ?? '';
  if (!token) throw new Error('需要 COLLAB_RUNTIME_TOKEN（管理员令牌）');
  const secret = process.env.COLLAB_EMBEDDED_SECRET ?? '';
  if (!secret) throw new Error('需要 COLLAB_EMBEDDED_SECRET（用来派生内嵌智能体令牌）');
  const baseUrl = process.env.COLLAB_BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? 8787}`;
  const tickMs = Number(process.env.COLLAB_RUNTIME_TICK_MS ?? 3_000);
  if (!Number.isInteger(tickMs) || tickMs < 200) throw new Error('COLLAB_RUNTIME_TICK_MS 至少 200');
  const concurrency = Number(process.env.COLLAB_RUNTIME_CONCURRENCY ?? 2);
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('COLLAB_RUNTIME_CONCURRENCY 至少 1');
  const idleMs = Number(process.env.COLLAB_AGENT_IDLE_MS ?? 60_000);
  if (!Number.isInteger(idleMs) || idleMs < 0) throw new Error('COLLAB_AGENT_IDLE_MS 不能为负');
  const graceMs = Number(process.env.COLLAB_WORKER_GRACE_MS ?? 20_000);
  if (!Number.isInteger(graceMs) || graceMs < 0) throw new Error('COLLAB_WORKER_GRACE_MS 不能为负');
  const orphanTtlMs = Number(process.env.COLLAB_ORPHAN_TTL_MS ?? 24 * 60 * 60 * 1_000);
  if (!Number.isInteger(orphanTtlMs) || orphanTtlMs < 1_000) throw new Error('COLLAB_ORPHAN_TTL_MS 至少 1000');

  const args = process.argv.slice(2);
  let once = false;
  let agentFilter: string | null = process.env.COLLAB_AGENT_ID ?? null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--once') once = true;
    else if (arg === '--agent') {
      agentFilter = args[index + 1] ?? null;
      index += 1;
    } else if (arg.startsWith('--agent=')) agentFilter = arg.slice('--agent='.length);
    else throw new Error(`未知参数 ${arg}`);
  }
  return {
    baseUrl,
    token,
    secret,
    tickMs,
    concurrency,
    once,
    agentFilter,
    agentsFile: process.env.COLLAB_AGENTS_FILE ?? null,
    idleMs,
    graceMs,
    healthFile: process.env.COLLAB_HEALTH_FILE ?? null,
    orphanTtlMs,
  };
}

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    'COLLAB_RUNTIME_TOKEN',
    'COLLAB_EMBEDDED_SECRET',
    'COLLAB_BOOTSTRAP_TOKEN',
    'COLLAB_TOKEN',
    'DATABASE_URL',
    'COLLAB_TEST_DATABASE',
  ]) {
    delete env[key];
  }
  return env;
}

/** 定义快照：去掉随每次扫描变化的运行时字段，hash 才稳定。 */
function snapshot(agent: EmbeddedAgentView): EmbeddedAgentDefinition {
  const { unread: _unread, running: _running, ...definition } = agent;
  return definition;
}

function definitionHash(definition: EmbeddedAgentDefinition): string {
  return createHash('sha256').update(JSON.stringify(definition)).digest('hex').slice(0, 16);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class Supervisor {
  private readonly client: CollabClient;
  private readonly settings: Options;
  private readonly workerPath: string;
  private readonly workers = new Map<string, WorkerHandle>();
  private readonly startedAt = Date.now();

  constructor(settings: Options) {
    this.settings = settings;
    this.client = new CollabClient(settings.baseUrl, settings.token, { timeoutMs: 20_000 });
    this.workerPath = fileURLToPath(new URL('./agent-worker.ts', import.meta.url));
  }

  /** 可选的健康快照：外部探针读文件即可，写失败不影响调度。 */
  async writeHealth(): Promise<void> {
    const file = this.settings.healthFile;
    if (!file) return;
    const agents = [...this.workers.values()].map(handle => ({
      agentId: handle.agentId,
      name: handle.name,
      ready: handle.ready,
      stopping: handle.stopping,
      sessions: [...handle.sessions],
      pending: [...handle.pending],
      lastActiveAt: new Date(handle.lastActiveAt).toISOString(),
    }));
    const payload = {
      pid: process.pid,
      startedAt: new Date(this.startedAt).toISOString(),
      updatedAt: new Date().toISOString(),
      workers: agents.length,
      sessions: this.totalInFlight(),
      agents,
    };
    await writeFile(file, `${JSON.stringify(payload)}\n`, { mode: 0o600 }).catch(() => undefined);
  }

  async heartbeat(): Promise<void> {
    await this.client
      .request('embedded/supervisors/heartbeat', {
        body: { host: hostname(), pid: process.pid },
        operationId: `supervisor-hb:${hostname()}:${process.pid}`,
      })
      .catch(() => undefined);
  }

  async recover(): Promise<void> {
    const staleSeconds = Math.max(30, Math.ceil((this.settings.tickMs * 10) / 1000));
    const result = await this.client
      .request<{ recovered: string[] }>('embedded/recover', {
        body: { staleSeconds },
        operationId: `supervisor-recover:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`,
      })
      .catch(() => null);
    if (result && result.recovered.length > 0) {
      process.stderr.write(`回收了 ${result.recovered.length} 个心跳停滞的运行：${result.recovered.join(', ')}\n`);
    }
  }

  async importAgents(): Promise<void> {
    const file = this.settings.agentsFile;
    if (!file) return;
    try {
      const raw = await readFile(file, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      const agents = Array.isArray(parsed) ? parsed : (parsed as { agents?: unknown }).agents;
      if (!Array.isArray(agents)) throw new Error('文件里没有 agents 数组');
      const result = await this.client.request<{ imported: number }>('embedded/agents/import', {
        body: { agents },
        operationId: `supervisor-import:${Date.now()}`,
      });
      process.stderr.write(`从 ${file} 导入了 ${result.imported} 个定义\n`);
    } catch (error) {
      process.stderr.write(`导入 ${file} 失败：${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  async tick(): Promise<void> {
    await this.heartbeat();
    await this.recover();

    const agents = await this.client.request<EmbeddedAgentView[]>('embedded/agents');
    for (const agent of agents) {
      if (!agent.enabled) continue;
      if (this.settings.agentFilter && agent.id !== this.settings.agentFilter) continue;

      let handle = this.workers.get(agent.id) ?? null;
      const definition = snapshot(agent);
      if (handle && handle.stopping) handle = null;
      if (handle && handle.hash !== definitionHash(definition)) {
        if (this.inFlight(handle) === 0) {
          this.stopWorker(handle, '定义已变更');
          this.workers.delete(agent.id);
          handle = null;
        }
      }

      if (agent.running > 0) {
        // 控制台点「立即运行」会先建一行运行记录。这里接管这种刚创建、
        // 还没有任何心跳的运行，否则它永远不会被真正执行。
        const manual = await this.orphanRun(agent.id);
        if (manual && !this.isTracked(agent.id, manual.id) && !this.overCapacity()) {
          handle ??= await this.spawnWorker(agent, definition);
          if (handle) this.sendRun(handle, manual.id, agent.limits.timeoutMs);
        }
      }

      if (agent.unread <= 0) continue;
      const inFlight = handle ? this.inFlight(handle) : 0;
      const slots = Math.min(
        Math.max(0, agent.concurrency - inFlight),
        Math.max(0, this.settings.concurrency - this.totalInFlight()),
      );
      // 已下发的运行还没开始拉取时 unread 不会减少，用 pending 去重。
      const allowance = agent.unread - (handle?.pending.size ?? 0);
      for (let index = 0; index < Math.min(slots, Math.max(0, allowance)); index += 1) {
        handle ??= await this.spawnWorker(agent, definition);
        if (!handle) break;
        const run = await this.createRun(agent);
        if (!run) break;
        this.sendRun(handle, run.id, agent.limits.timeoutMs);
      }
    }
    await this.writeHealth();
  }

  /** 手动创建、尚未被任何 worker 认领的运行：心跳还等于创建时间。 */
  private async orphanRun(agentId: string): Promise<RunView | null> {
    try {
      const runs = await this.client.request<RunView[]>(
        `embedded/agents/${encodeURIComponent(agentId)}/runs?limit=5`,
      );
      const now = Date.now();
      return (
        runs.find(run => {
          if (run.status !== 'running') return false;
          if (!run.startedAt || !run.heartbeatAt) return false;
          if (run.heartbeatAt !== run.startedAt) return false;
          const started = Date.parse(run.startedAt);
          return !Number.isNaN(started) && now - started < 60_000;
        }) ?? null
      );
    } catch {
      return null;
    }
  }

  private async createRun(agent: EmbeddedAgentView): Promise<RunView | null> {
    try {
      return await this.client.request<RunView>(`embedded/agents/${encodeURIComponent(agent.id)}/run`, {
        body: {},
        operationId: `run:${agent.id}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      });
    } catch (error) {
      process.stderr.write(`启动 ${agent.name} 失败：${error instanceof Error ? error.message : String(error)}\n`);
      return null;
    }
  }

  private async spawnWorker(
    agent: EmbeddedAgentView,
    definition: EmbeddedAgentDefinition,
  ): Promise<WorkerHandle | null> {
    try {
      await this.client.request(`embedded/agents/${encodeURIComponent(agent.id)}/ensure`, {
        body: {},
        operationId: `ensure:${agent.id}:${Date.now()}`,
      });
    } catch (error) {
      process.stderr.write(`准备 ${agent.name} 的令牌失败：${error instanceof Error ? error.message : String(error)}\n`);
      return null;
    }

    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', this.workerPath], {
      cwd: process.cwd(),
      env: childEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const handle: WorkerHandle = {
      agentId: agent.id,
      name: agent.name,
      child,
      hash: definitionHash(definition),
      sessions: new Set(),
      pending: new Set(),
      timers: new Map(),
      ready: false,
      stopping: false,
      lastActiveAt: Date.now(),
    };
    this.workers.set(agent.id, handle);
    this.attach(handle);
    process.stderr.write(`▶ ${agent.name} 的 worker 已启动（并发 ${agent.concurrency}）\n`);

    this.write(handle, {
      type: 'config',
      baseUrl: this.settings.baseUrl,
      token: deriveEmbeddedToken(this.settings.secret, agent.id),
      agentId: agent.id,
      definition,
      idleMs: this.settings.idleMs,
    });
    return handle;
  }

  private attach(handle: WorkerHandle): void {
    const stdout = createInterface({ input: handle.child.stdout! });
    stdout.on('line', line => this.onEvent(handle, line));
    const stderr = createInterface({ input: handle.child.stderr! });
    stderr.on('line', line => {
      if (line.trim()) process.stderr.write(`[${handle.name}] ${line}\n`);
    });
    handle.child.on('error', error => {
      process.stderr.write(`[${handle.name}] worker 错误：${error.message}\n`);
    });
    handle.child.on('exit', (code, signal) => this.onExit(handle, code, signal));
  }

  private onEvent(handle: WorkerHandle, line: string): void {
    let event: WorkerEvent;
    try {
      event = JSON.parse(line) as WorkerEvent;
    } catch {
      process.stderr.write(`[${handle.name}] ${line}\n`);
      return;
    }
    handle.lastActiveAt = Date.now();
    switch (event.type) {
      case 'ready':
        handle.ready = true;
        return;
      case 'session-start':
        if (!event.runId) return;
        handle.pending.delete(event.runId);
        handle.sessions.add(event.runId);
        process.stderr.write(`▶ ${handle.name}（run ${event.runId}）\n`);
        return;
      case 'session-end': {
        if (!event.runId) return;
        handle.pending.delete(event.runId);
        handle.sessions.delete(event.runId);
        const timer = handle.timers.get(event.runId);
        if (timer) clearTimeout(timer);
        handle.timers.delete(event.runId);
        process.stderr.write(`■ ${handle.name}（run ${event.runId}）${event.status ?? '结束'}\n`);
        return;
      }
      case 'rejected':
        if (!event.runId) return;
        handle.pending.delete(event.runId);
        void this.finishIfRunning(event.runId, 'failed', event.reason ?? 'worker 拒绝接活');
        return;
      case 'idle-exit':
        process.stderr.write(`· ${handle.name} 的 worker 空闲退出\n`);
        return;
      default:
        process.stderr.write(`[${handle.name}] ${line}\n`);
    }
  }

  private sendRun(handle: WorkerHandle, runId: string, timeoutMs: number): void {
    handle.pending.add(runId);
    handle.lastActiveAt = Date.now();
    const timer = setTimeout(() => {
      process.stderr.write(`运行 ${runId} 超时未结束，终止 ${handle.name} 的 worker\n`);
      void this.finishIfRunning(runId, 'outcome_unknown', '运行超时，worker 被终止');
      handle.child.kill('SIGKILL');
    }, timeoutMs + 60_000);
    timer.unref?.();
    handle.timers.set(runId, timer);
    this.write(handle, { type: 'run', runId });
  }

  private onExit(handle: WorkerHandle, code: number | null, signal: string | null): void {
    if (this.workers.get(handle.agentId) === handle) this.workers.delete(handle.agentId);
    for (const timer of handle.timers.values()) clearTimeout(timer);
    handle.timers.clear();
    const started = [...handle.sessions];
    const queued = [...handle.pending];
    handle.sessions.clear();
    handle.pending.clear();
    process.stderr.write(`■ ${handle.name} 的 worker 退出：${signal ?? code}\n`);
    for (const runId of started) {
      void this.finishIfRunning(runId, 'outcome_unknown', `agent worker 退出（${signal ?? code}），运行结果未知`);
    }
    for (const runId of queued) {
      void this.finishIfRunning(runId, 'failed', `agent worker 退出（${signal ?? code}），该运行没有启动`);
    }
  }

  private write(handle: WorkerHandle, message: Record<string, unknown>): void {
    const stdin = handle.child.stdin;
    if (!stdin || stdin.destroyed || handle.child.exitCode !== null) {
      process.stderr.write(`[${handle.name}] worker 已退出，无法下发 ${String(message.type)}\n`);
      return;
    }
    stdin.write(`${JSON.stringify(message)}\n`);
  }

  private inFlight(handle: WorkerHandle): number {
    return handle.sessions.size + handle.pending.size;
  }

  private totalInFlight(): number {
    let total = 0;
    for (const handle of this.workers.values()) total += this.inFlight(handle);
    return total;
  }

  private overCapacity(): boolean {
    return this.totalInFlight() >= this.settings.concurrency;
  }

  private isTracked(agentId: string, runId: string): boolean {
    const handle = this.workers.get(agentId);
    return Boolean(handle && (handle.sessions.has(runId) || handle.pending.has(runId)));
  }

  private stopWorker(handle: WorkerHandle, reason: string): void {
    handle.stopping = true;
    process.stderr.write(`· 停止 ${handle.name} 的 worker：${reason}\n`);
    this.write(handle, { type: 'drain' });
  }

  /** worker 没有自己收尾（被杀死、崩溃）时补一条结论。 */
  private async finishIfRunning(
    runId: string,
    status: 'failed' | 'outcome_unknown',
    note: string,
  ): Promise<void> {
    try {
      const run = await this.client.request<RunView>(`embedded/runs/${encodeURIComponent(runId)}`);
      if (run.status !== 'running') return;
      await this.client.request(`embedded/runs/${encodeURIComponent(runId)}/finish`, {
        body: {
          status,
          exitCode: 1,
          outcomeUnknown: status === 'outcome_unknown',
          error: note,
        },
        operationId: `run-supervisor-finish:${runId}`,
      });
    } catch {
      // 平台不可达时留给下一轮的 recover。
    }
  }

  /** `--once`：等所有下发的 Session 结束，再让 worker 退出。 */
  async drain(): Promise<void> {
    while (this.totalInFlight() > 0) await sleep(100);
    const handles = [...this.workers.values()];
    for (const handle of handles) this.write(handle, { type: 'drain' });
    const deadline = Date.now() + 10_000;
    while (this.workers.size > 0 && Date.now() < deadline) await sleep(100);
    for (const handle of this.workers.values()) handle.child.kill('SIGKILL');
  }

  async shutdown(): Promise<void> {
    for (const handle of this.workers.values()) {
      handle.stopping = true;
      this.write(handle, { type: 'shutdown', graceMs: this.settings.graceMs });
    }
    const deadline = Date.now() + this.settings.graceMs + 5_000;
    while (this.workers.size > 0 && Date.now() < deadline) await sleep(100);
    for (const handle of this.workers.values()) handle.child.kill('SIGKILL');
    await sleep(200);
  }

  get active(): number {
    return this.totalInFlight();
  }
}

async function main(): Promise<void> {
  const settings = options();
  const supervisor = new Supervisor(settings);
  process.stderr.write(
    `supervisor 启动：${settings.baseUrl}，tick ${settings.tickMs}ms，全局并发 ${settings.concurrency}${settings.once ? '，单轮模式' : ''}\n`,
  );
  await supervisor.recover();
  await supervisor.importAgents();
  await supervisor.heartbeat();
  if (process.env.COLLAB_KEEP_RUN !== '1') {
    const removed = await pruneSessionDirs(settings.orphanTtlMs).catch(() => 0);
    if (removed > 0) process.stderr.write(`回收了 ${removed} 个残留的 Session 目录\n`);
  }

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    process.stderr.write('supervisor 收到退出信号，停止接活并等待未完成的运行\n');
    await supervisor.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());

  if (settings.once) {
    await supervisor.tick();
    await supervisor.drain();
    return;
  }

  for (;;) {
    try {
      await supervisor.tick();
    } catch (error) {
      process.stderr.write(`tick 失败：${error instanceof Error ? error.message : String(error)}\n`);
    }
    await sleep(settings.tickMs);
  }
}

void main();
