/**
 * 进程隔离的 Session：每个运行一个 `src/session.ts` 子进程。
 *
 * 子进程通过 stdin 收到与 supervisor 相同的配置（baseUrl、派生令牌、runId、
 * 定义），跑的是同一套 AgentSession，所以目录、ack/nack、finish 与中断后退回
 * 的语义和 inline 模式一致。父进程只做四件事：把子进程的 stderr 转发出去、
 * 收最后一行结果、超时/中断时杀掉整个进程组、子进程没来得及收尾时补一条结论。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { EmbeddedAgentDefinition } from '../definition.ts';
import { keepRunDir, removeRunDir, safeSegment } from '../sandbox.ts';
import type { AgentRuntime } from './agent.ts';
import type { SessionOutcome, SessionRequest, SessionResult, SessionTask } from './types.ts';

const SESSION_ENTRY = fileURLToPath(new URL('../session.ts', import.meta.url));
/** 中断后留给子进程收尾（nack + finish + flush）的时间，之后 SIGKILL。 */
const ABORT_GRACE_MS = 1_500;
/** 子进程自己会按 limits.timeoutMs 收尾；这里只是挂死时的兜底。 */
const BACKSTOP_EXTRA_MS = 15_000;

const OUTCOMES: readonly string[] = ['succeeded', 'failed', 'timeout', 'outcome_unknown'];

type PulledEnvelope = { id: string; deliveryId: string };
type Exit = { code: number | null; signal: NodeJS.Signals | null; error?: Error };

function toResult(event: Record<string, unknown>): SessionResult {
  const status = typeof event.status === 'string' && OUTCOMES.includes(event.status)
    ? (event.status as SessionOutcome)
    : 'outcome_unknown';
  return {
    status,
    turns: Number.isInteger(event.turns) ? Number(event.turns) : 0,
    promptTokens: Number.isFinite(event.promptTokens) ? Number(event.promptTokens) : 0,
    completionTokens: Number.isFinite(event.completionTokens) ? Number(event.completionTokens) : 0,
    error: typeof event.error === 'string' ? event.error : null,
    summary: typeof event.summary === 'string' ? event.summary : null,
    toolExecuted: event.toolExecuted === true,
    mailSessionId: typeof event.mailSessionId === 'string' ? event.mailSessionId : null,
  };
}

export class ProcessSession implements SessionTask {
  readonly runId: string;

  private readonly runtime: AgentRuntime;
  private readonly definition: EmbeddedAgentDefinition;
  private readonly maxMessages: number | undefined;
  private readonly history: SessionRequest['history'];
  private readonly pulled: PulledEnvelope[] = [];

  private child: ChildProcess | null = null;
  private interrupted: string | null = null;
  private timedOut = false;
  private exited = false;
  private result: SessionResult | null = null;
  private timer: NodeJS.Timeout | null = null;
  private killTimer: NodeJS.Timeout | null = null;

  constructor(runtime: AgentRuntime, request: SessionRequest) {
    this.runtime = runtime;
    this.runId = request.runId;
    this.definition = request.definition ?? runtime.definition;
    this.maxMessages = request.maxMessages;
    this.history = request.history;
  }

  abort(reason: string): void {
    if (this.interrupted) return;
    this.interrupted = reason;
    this.kill('SIGTERM');
    if (!this.exited) {
      this.killTimer = setTimeout(() => this.kill('SIGKILL'), ABORT_GRACE_MS);
      this.killTimer.unref?.();
    }
  }

  async run(): Promise<SessionResult> {
    if (this.interrupted) return await this.abandon('failed', this.interrupted);
    const exit = await this.execute();
    this.exited = true;
    this.clearTimers();
    if (this.result) return this.result;
    if (this.interrupted) return await this.abandon('failed', this.interrupted);
    if (this.timedOut) return await this.abandon('timeout', `超过时限 ${this.definition.limits.timeoutMs}ms`);
    const detail = exit.error ? `：${exit.error.message}` : `（${exit.signal ?? exit.code}）`;
    return await this.abandon('outcome_unknown', `Session 子进程异常退出${detail}，运行结果未知`);
  }

  private execute(): Promise<Exit> {
    const transport = this.runtime.transport.spawnConfig?.(this.runId) ?? null;
    if (!transport) {
      return Promise.resolve({
        code: null,
        signal: null,
        error: new Error('当前传输层不支持 process 隔离'),
      });
    }
    const config = {
      transport,
      runId: this.runId,
      agentId: this.runtime.agentId,
      definition: this.definition,
      // 让子进程把拉取到的消息与最终结果作为 JSON 行写到 stdout。
      reportResult: true,
      ...(this.maxMessages === undefined ? {} : { maxMessages: this.maxMessages }),
      ...(this.history && this.history.length > 0 ? { history: this.history } : {}),
    };

    return new Promise<Exit>(resolve => {
      let child: ChildProcess;
      try {
        child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SESSION_ENTRY], {
          cwd: process.cwd(),
          env: process.env,
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: true,
        });
      } catch (error) {
        resolve({ code: null, signal: null, error: error instanceof Error ? error : new Error(String(error)) });
        return;
      }
      this.child = child;
      process.stderr.write(`Session ${this.runId} 在独立进程中运行（pid ${child.pid ?? '?'}）\n`);

      // 子进程可能在我们写完之前退出，EPIPE 不算错误。
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(`${JSON.stringify(config)}\n`);
      if (child.stderr) {
        createInterface({ input: child.stderr }).on('line', line => {
          process.stderr.write(`[Session ${this.runId}] ${line}\n`);
        });
      }
      if (child.stdout) {
        createInterface({ input: child.stdout }).on('line', line => this.onLine(line));
      }

      const backstop = Math.max(1_000, this.definition.limits.timeoutMs) + BACKSTOP_EXTRA_MS;
      this.timer = setTimeout(() => {
        this.timedOut = true;
        process.stderr.write(`Session ${this.runId} 超出时限，终止进程组\n`);
        this.kill('SIGTERM');
        this.killTimer = setTimeout(() => this.kill('SIGKILL'), ABORT_GRACE_MS);
        this.killTimer.unref?.();
      }, backstop);
      this.timer.unref?.();

      let settled = false;
      const finish = (exit: Exit) => {
        if (settled) return;
        settled = true;
        resolve(exit);
      };
      child.once('error', error => finish({ code: null, signal: null, error }));
      child.once('close', (code, signal) => finish({ code, signal }));
    });
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      process.stderr.write(`[Session ${this.runId}] ${line}\n`);
      return;
    }
    if (event.type === 'mail-pulled' && Array.isArray(event.messages)) {
      for (const item of event.messages) {
        if (item && typeof item === 'object' && typeof (item as PulledEnvelope).id === 'string') {
          this.pulled.push(item as PulledEnvelope);
        }
      }
      return;
    }
    if (event.type === 'session-result') {
      this.result = toResult(event);
      return;
    }
    process.stderr.write(`[Session ${this.runId}] ${line}\n`);
  }

  /**
   * 子进程没有交出结果：补一条运行结论，并且只在运行仍未结束时退回消息，
   * 避免把已经 finish 的运行又改一遍。
   */
  private async abandon(status: SessionOutcome, error: string): Promise<SessionResult> {
    const result: SessionResult = {
      status,
      turns: 0,
      promptTokens: 0,
      completionTokens: 0,
      error,
      summary: null,
      toolExecuted: false,
      mailSessionId: null,
    };
    if (await this.runStillRunning()) {
      await this.releaseMessages(status);
      try {
        await this.finishRun(status, error);
      } catch {
        // 平台不可达时留给 supervisor 的 recover 与租约到期兜底。
      }
    }
    await this.cleanup();
    return result;
  }

  private async runStillRunning(): Promise<boolean> {
    try {
      const run = await this.runtime.transport.runs.status(this.runId);
      return run.status === 'running';
    } catch {
      return true;
    }
  }

  private async releaseMessages(status: SessionOutcome): Promise<void> {
    if (this.pulled.length === 0) return;
    const retryAfterSeconds = status === 'outcome_unknown' ? 3_600 : 300;
    const reason = status === 'outcome_unknown'
      ? '运行结果未知，等待人工核对'
      : this.interrupted
        ? `运行时中断：${this.interrupted}`
        : '运行未完成，消息退回队列';
    for (const envelope of this.pulled) {
      try {
        await this.runtime.transport.mailbox.nack(envelope.id, {
          deliveryId: envelope.deliveryId,
          retryAfterSeconds,
          reason,
        });
      } catch {
        // 租约到期后控制面会自行退回。
      }
    }
  }

  private async finishRun(status: SessionOutcome, error: string): Promise<void> {
    await this.runtime.transport.runs.finish(this.runId, {
      status,
      turns: 0,
      promptTokens: 0,
      completionTokens: 0,
      error,
      summary: null,
      toolExecuted: false,
      mailSessionId: null,
    });
  }

  private async cleanup(): Promise<void> {
    if (keepRunDir()) return;
    try {
      await removeRunDir(join(this.runtime.root, 'sessions', safeSegment(this.runId)), {
        root: this.runtime.rootBase,
      });
    } catch {
      // 目录可能已经由子进程清掉，或者从未创建。
    }
  }

  private kill(signal: NodeJS.Signals): void {
    const child = this.child;
    if (!child || child.pid === undefined || this.exited) return;
    try {
      // 子进程是进程组组长（detached），连同它的 shell 孙进程一起终止。
      process.kill(-child.pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // 已经退出。
      }
    }
  }

  private clearTimers(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.killTimer) clearTimeout(this.killTimer);
    this.timer = null;
    this.killTimer = null;
  }
}
