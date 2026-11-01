/**
 * agent-worker：每个定义一个常驻进程，承载多个 Session。
 *
 * 控制面走 stdin，事件走 stdout，都是一行一个 JSON；诊断信息走 stderr
 * （supervisor 会加 `[名称]` 前缀转发）。worker 只拿派生令牌，管理面令牌
 * 留在 supervisor 里；两者不共享进程内存。
 *
 * 并发上限来自定义里的 `concurrency`。空闲超过 idleMs 自行退出，supervisor
 * 下次有活时再拉起；定义变更由 supervisor 在空闲时重建。
 */

import { createInterface } from 'node:readline';
import type { EmbeddedAgentDefinition } from './definition.ts';
import { AgentRuntime } from './runtime/agent.ts';
import type { AgentSession } from './runtime/session.ts';
import type { SessionOutcome } from './runtime/types.ts';

type WorkerConfig = {
  type: 'config';
  baseUrl: string;
  token: string;
  agentId: string;
  definition: EmbeddedAgentDefinition;
  idleMs?: number;
};

type Command =
  | { type: 'run'; runId: string }
  | { type: 'drain' }
  | { type: 'shutdown'; graceMs?: number };

const IDLE_MS = Number(process.env.COLLAB_AGENT_IDLE_MS ?? 60_000);
const SHUTDOWN_GRACE_MS = Number(process.env.COLLAB_WORKER_GRACE_MS ?? 20_000);

function emit(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class AgentWorker {
  private readonly runtime: AgentRuntime;
  private readonly idleMs: number;
  private readonly queue: string[] = [];
  private readonly sessions = new Map<string, AgentSession>();
  private active = 0;
  private accepting = true;
  private idleTimer: NodeJS.Timeout | null = null;
  private idleWaiter: (() => void) | null = null;

  constructor(runtime: AgentRuntime, idleMs: number) {
    this.runtime = runtime;
    this.idleMs = idleMs;
  }

  /** 没有活时才开始计时；收到 run 会取消。 */
  arm(): void {
    this.scheduleIdle();
  }

  get busy(): number {
    return this.active + this.queue.length;
  }

  enqueue(runId: string): void {
    if (!this.accepting) {
      emit({ type: 'rejected', runId, reason: 'worker 正在退出' });
      return;
    }
    this.clearIdle();
    this.queue.push(runId);
    this.pump();
  }

  /** 不再接新活，等已接的跑完。 */
  async drain(): Promise<void> {
    this.accepting = false;
    if (this.busy === 0) return;
    await new Promise<void>(resolve => {
      this.idleWaiter = resolve;
    });
  }

  /** 停止接活、限时等待，然后中断剩余 Session。 */
  async shutdown(graceMs: number): Promise<void> {
    this.accepting = false;
    this.queue.length = 0;
    this.clearIdle();
    if (this.busy > 0) {
      await Promise.race([
        new Promise<void>(resolve => {
          this.idleWaiter = resolve;
        }),
        sleep(graceMs),
      ]);
    }
    for (const session of this.sessions.values()) session.abort('运行时退出，本轮中断');
    if (this.busy > 0) {
      await Promise.race([
        new Promise<void>(resolve => {
          this.idleWaiter = resolve;
        }),
        sleep(2_000),
      ]);
    }
  }

  private pump(): void {
    while (this.active < this.runtime.concurrency && this.queue.length > 0) {
      const runId = this.queue.shift()!;
      this.active += 1;
      const session = this.runtime.createSession({ runId });
      this.sessions.set(runId, session);
      emit({ type: 'session-start', runId });
      void session
        .run()
        .then(result => this.settle(runId, result.status, result.turns, result.error))
        .catch(error => this.settle(runId, 'failed', 0, error instanceof Error ? error.message : String(error)));
    }
    if (this.busy === 0) this.scheduleIdle();
  }

  private settle(runId: string, status: SessionOutcome, turns: number, error: string | null): void {
    this.active -= 1;
    this.sessions.delete(runId);
    emit({ type: 'session-end', runId, status, turns, error });
    if (this.queue.length > 0) this.pump();
    else if (this.busy === 0) {
      this.idleWaiter?.();
      this.idleWaiter = null;
      this.scheduleIdle();
    }
  }

  private scheduleIdle(): void {
    if (!this.accepting || this.idleMs <= 0) return;
    this.clearIdle();
    this.idleTimer = setTimeout(() => {
      emit({ type: 'idle-exit' });
      process.exit(0);
    }, this.idleMs);
    this.idleTimer.unref?.();
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}

async function main(): Promise<void> {
  const lines = createInterface({ input: process.stdin });
  const buffered: string[] = [];
  let delivered = false;
  let resolveConfig: ((line: string) => void) | null = null;
  let worker: AgentWorker | null = null;

  lines.on('line', line => {
    if (!delivered) {
      delivered = true;
      resolveConfig?.(line);
      return;
    }
    if (!worker) {
      buffered.push(line);
      return;
    }
    handleCommand(worker, line);
  });

  const configLine = await new Promise<string>(resolve => {
    resolveConfig = resolve;
  });
  const config = JSON.parse(configLine) as WorkerConfig;
  for (const key of ['baseUrl', 'token', 'agentId'] as const) {
    if (typeof config[key] !== 'string' || !config[key]) throw new Error(`worker 配置缺少 ${key}`);
  }
  if (!config.definition || typeof config.definition !== 'object') throw new Error('worker 配置缺少 definition');

  const runtime = await AgentRuntime.create({
    baseUrl: config.baseUrl,
    token: config.token,
    agentId: config.agentId,
    definition: config.definition,
  });
  const idleMs = Number.isFinite(config.idleMs) ? Number(config.idleMs) : IDLE_MS;
  worker = new AgentWorker(runtime, idleMs);

  const stop = (graceMs: number) => {
    if (!worker) process.exit(0);
    void worker.shutdown(graceMs).finally(() => process.exit(0));
  };
  process.on('SIGTERM', () => stop(SHUTDOWN_GRACE_MS));
  process.on('SIGINT', () => stop(SHUTDOWN_GRACE_MS));
  process.stdout.on('error', () => process.exit(0));

  emit({ type: 'ready', agentId: config.agentId, concurrency: runtime.concurrency });
  worker.arm();
  for (const line of buffered) handleCommand(worker, line);
}

function handleCommand(worker: AgentWorker, line: string): void {
  let command: Command;
  try {
    command = JSON.parse(line) as Command;
  } catch {
    process.stderr.write(`无法解析的控制消息：${line.slice(0, 200)}\n`);
    return;
  }
  switch (command.type) {
    case 'run':
      if (typeof command.runId !== 'string' || !command.runId) {
        process.stderr.write('控制消息 run 缺少 runId\n');
        return;
      }
      worker.enqueue(command.runId);
      return;
    case 'drain':
      void worker.drain().then(() => {
        emit({ type: 'drained' });
        process.exit(0);
      });
      return;
    case 'shutdown':
      void worker
        .shutdown(Number.isFinite(command.graceMs) ? Number(command.graceMs) : SHUTDOWN_GRACE_MS)
        .finally(() => process.exit(0));
      return;
    default:
      process.stderr.write(`未知控制消息：${line.slice(0, 200)}\n`);
  }
}

await main().catch(error => {
  process.stderr.write(`agent-worker 失败：${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
