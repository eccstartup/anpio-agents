/**
 * 内嵌智能体 supervisor：常驻但不加载模型。
 *
 * 每个 tick 只做三件事：回收心跳停滞的运行、看哪些定义有未读、为它们各 spawn
 * 一个一次性的 session 子进程。空闲时它只是一个定时器，不持有智能体上下文。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CollabClient } from './client.ts';
import type { EmbeddedAgentView } from './definition.ts';
import { runRoot } from './sandbox.ts';
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

class Supervisor {
  private readonly client: CollabClient;
  private readonly settings: Options;
  private readonly sessionPath: string;
  private readonly children = new Map<string, { child: ChildProcess; startedAt: number }>();

  constructor(settings: Options) {
    this.settings = settings;
    this.client = new CollabClient(settings.baseUrl, settings.token, { timeoutMs: 20_000 });
    this.sessionPath = fileURLToPath(new URL('./session.ts', import.meta.url));
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
      if (this.children.has(agent.id)) continue;
      if (this.children.size >= this.settings.concurrency) break;
      if (agent.running > 0) {
        // 控制台点「立即运行」会先建一行运行记录。这里接管这种刚创建、
        // 还没有任何心跳的运行，否则它永远不会被真正执行。
        const manual = await this.orphanRun(agent.id);
        if (manual) await this.launch(agent, manual);
        continue;
      }
      if (agent.unread <= 0) continue;
      await this.launch(agent);
    }
  }

  /** 手动创建、尚未被任何子进程认领的运行：心跳还等于创建时间。 */
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

  private async launch(agent: EmbeddedAgentView, existing?: RunView): Promise<void> {
    let run: RunView;
    let token: string;
    try {
      await this.client.request(`embedded/agents/${encodeURIComponent(agent.id)}/ensure`, {
        body: {},
        operationId: `ensure:${agent.id}:${Date.now()}`,
      });
      token = deriveEmbeddedToken(this.settings.secret, agent.id);
      run =
        existing ??
        (await this.client.request<RunView>(`embedded/agents/${encodeURIComponent(agent.id)}/run`, {
          body: {},
          operationId: `run:${agent.id}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
        }));
    } catch (error) {
      process.stderr.write(`启动 ${agent.name} 失败：${error instanceof Error ? error.message : String(error)}\n`);
      return;
    }

    const workdir = join(runRoot(), agent.id, run.id);
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', this.sessionPath], {
      cwd: process.cwd(),
      env: childEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.children.set(agent.id, { child, startedAt: Date.now() });
    process.stderr.write(`▶ ${agent.name}（run ${run.id}）\n`);

    child.stdin?.end(
      JSON.stringify({
        baseUrl: this.settings.baseUrl,
        token,
        runId: run.id,
        agentId: agent.id,
        definition: agent,
        workdir,
      }),
    );

    this.forward(agent.id, run.id, child);
    const safety = setTimeout(
      () => {
        if (this.children.has(agent.id)) {
          process.stderr.write(`运行 ${run.id} 超时未退出，终止子进程\n`);
          child.kill('SIGKILL');
        }
      },
      agent.limits.timeoutMs + 60_000,
    );
    safety.unref?.();

    child.on('exit', (code, signal) => {
      clearTimeout(safety);
      this.children.delete(agent.id);
      process.stderr.write(`■ ${agent.name}（run ${run.id}）退出：${signal ?? code}\n`);
      void this.finishIfRunning(run.id, code, signal);
    });
  }

  private forward(agentId: string, runId: string, child: ChildProcess): void {
    const write = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (!text) return;
      void this.client
        .request(`embedded/runs/${encodeURIComponent(runId)}/log`, {
          body: { level: stream === 'stderr' ? 'warn' : 'debug', text: `[${stream}] ${text}`.slice(0, 7_900) },
          operationId: `run-fwd:${runId}:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`,
        })
        .catch(() => undefined);
    };
    child.stdout?.on('data', (chunk: Buffer) => write('stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer) => write('stderr', chunk));
  }

  /** 子进程没有自己收尾（被杀死、崩溃）时补一条结论。 */
  private async finishIfRunning(runId: string, code: number | null, signal: string | null): Promise<void> {
    try {
      const run = await this.client.request<RunView>(`embedded/runs/${encodeURIComponent(runId)}`);
      if (run.status !== 'running') return;
      const uncertain = signal === 'SIGKILL' || code === null || code === 2;
      await this.client.request(`embedded/runs/${encodeURIComponent(runId)}/finish`, {
        body: {
          status: uncertain ? 'outcome_unknown' : 'failed',
          exitCode: code ?? 1,
          outcomeUnknown: uncertain,
          error: `子进程退出（${signal ?? code}），没有自行收尾`,
        },
        operationId: `run-supervisor-finish:${runId}`,
      });
    } catch {
      // 平台不可达时留给下一轮的 recover。
    }
  }

  async shutdown(): Promise<void> {
    for (const { child } of this.children.values()) child.kill('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 500));
    for (const { child } of this.children.values()) child.kill('SIGKILL');
  }

  get active(): number {
    return this.children.size;
  }
}

async function main(): Promise<void> {
  const settings = options();
  const supervisor = new Supervisor(settings);
  process.stderr.write(
    `supervisor 启动：${settings.baseUrl}，tick ${settings.tickMs}ms，并发 ${settings.concurrency}${settings.once ? '，单轮模式' : ''}\n`,
  );
  await supervisor.recover();
  await supervisor.importAgents();
  await supervisor.heartbeat();

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await supervisor.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());

  if (settings.once) {
    await supervisor.tick();
    while (supervisor.active > 0) await new Promise(resolve => setTimeout(resolve, 200));
    return;
  }

  for (;;) {
    try {
      await supervisor.tick();
    } catch (error) {
      process.stderr.write(`tick 失败：${error instanceof Error ? error.message : String(error)}\n`);
    }
    await new Promise(resolve => setTimeout(resolve, settings.tickMs));
  }
}

await main();
