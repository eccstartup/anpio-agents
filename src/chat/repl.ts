/**
 * 终端里的 thread 事件渲染与斜杠命令。
 *
 * 本地 thread 的文本写 stdout；后台来源（平台等）只写带前缀的 stderr 日志，
 * 不打断正在输出的答案。
 */

import type { ThreadHost } from '../threads/host.ts';
import type { ThreadEvent } from '../threads/types.ts';
import type { StdinSource } from '../sources/stdin.ts';

const HELP = `命令：
  /new       下一条消息开一个新的 thread
  /status    查看运行中的 thread 与来源
  /exit      退出（Ctrl-D 也可以）
  /help      显示本帮助`;

type TurnState = { printed: boolean; streamed: boolean; needsNewline: boolean };

export type ChatRendererOptions = {
  interactive: boolean;
  output?: NodeJS.WritableStream;
  error?: NodeJS.WritableStream;
};

export class ChatRenderer {
  private readonly interactive: boolean;
  private readonly out: NodeJS.WritableStream;
  private readonly err: NodeJS.WritableStream;
  private readonly turns = new Map<string, TurnState>();

  constructor(options: ChatRendererOptions) {
    this.interactive = options.interactive;
    this.out = options.output ?? process.stdout;
    this.err = options.error ?? process.stderr;
  }

  handle(event: ThreadEvent): void {
    if (event.sourceId !== 'stdin') {
      this.background(event);
      return;
    }
    const state = this.stateOf(event.turnId);
    switch (event.type) {
      case 'turn-start':
        break;
      case 'text-delta':
        this.write(event.text, state);
        state.streamed = true;
        break;
      case 'assistant-text':
        if (!state.streamed) this.write(event.text, state);
        break;
      case 'tool-call':
        this.lineBreak(state);
        this.err.write(`→ ${event.name}\n`);
        break;
      case 'tool-result': {
        const first = event.content.trim().split('\n')[0] ?? '';
        const suffix = event.uncertain ? '（结果未知）' : '';
        this.err.write(`← ${event.name}: ${truncate(first, 160)}${suffix}\n`);
        break;
      }
      case 'log':
        if (event.level === 'warn') this.err.write(`[${event.threadId}] ${event.text}\n`);
        break;
      case 'turn-end':
        this.finishLocal(event, state);
        break;
    }
  }

  private finishLocal(
    event: Extract<ThreadEvent, { type: 'turn-end' }>,
    state: TurnState,
  ): void {
    if (!state.printed && event.summary) this.write(event.summary, state);
    if (state.printed) this.lineBreak(state);
    else if (this.interactive) this.out.write('（本轮没有文本输出）\n');
    if (event.status !== 'succeeded') {
      this.err.write(`本轮结束：${event.status}${event.error ? `（${event.error}）` : ''}\n`);
    }
    this.turns.delete(event.turnId);
  }

  private background(event: ThreadEvent): void {
    const prefix = `[${event.sourceId}]`;
    switch (event.type) {
      case 'assistant-text':
        if (event.text.trim()) this.err.write(`${prefix} ${truncate(event.text.trim(), 400)}\n`);
        break;
      case 'tool-call':
        this.err.write(`${prefix} → ${event.name}\n`);
        break;
      case 'tool-result':
        this.err.write(`${prefix} ← ${event.name}\n`);
        break;
      case 'turn-end':
        this.err.write(
          `${prefix} 完成：${event.status}${event.summary ? ` ${truncate(event.summary, 200)}` : ''}`
          + `${event.error ? `（${event.error}）` : ''}\n`,
        );
        this.turns.delete(event.turnId);
        break;
      default:
        break;
    }
  }

  private write(text: string, state: TurnState): void {
    if (!text) return;
    this.out.write(text);
    state.printed = true;
    state.needsNewline = !text.endsWith('\n');
  }

  private lineBreak(state: TurnState): void {
    if (state.needsNewline) {
      this.out.write('\n');
      state.needsNewline = false;
    }
  }

  private stateOf(turnId: string): TurnState {
    const existing = this.turns.get(turnId);
    if (existing) return existing;
    const created: TurnState = { printed: false, streamed: false, needsNewline: false };
    this.turns.set(turnId, created);
    return created;
  }
}

export type ReplOptions = {
  host: ThreadHost;
  stdin: StdinSource;
  output?: NodeJS.WritableStream;
  error?: NodeJS.WritableStream;
};

export class Repl {
  private readonly host: ThreadHost;
  private readonly stdin: StdinSource;
  private readonly out: NodeJS.WritableStream;
  private readonly err: NodeJS.WritableStream;
  private currentThreadId = 'local:main';
  private closed = false;
  private resolveExit: (() => void) | null = null;
  private lastSigint = 0;
  private readonly onSigint = (): void => this.signal();

  constructor(options: ReplOptions) {
    this.host = options.host;
    this.stdin = options.stdin;
    this.out = options.output ?? process.stdout;
    this.err = options.error ?? process.stderr;
    this.stdin.onCommand = command => this.command(command);
    this.stdin.onClose = () => this.exit();
    if (!this.stdin.terminal) process.on('SIGINT', this.onSigint);
  }

  get threadId(): string {
    return this.currentThreadId;
  }

  /** 与 ChatRenderer 一起挂在 host 的 onEvent 上：只跟踪当前 thread 与提示符。 */
  handleEvent(event: ThreadEvent): void {
    if (event.sourceId !== 'stdin') return;
    if (event.type === 'turn-start') this.currentThreadId = event.threadId;
    if (event.type === 'turn-end') this.stdin.prompt();
  }

  async run(banner = true): Promise<void> {
    if (this.stdin.terminal) {
      this.stdin.onSignal = () => this.signal();
      if (banner) this.out.write('输入 /help 查看命令，/exit 退出。\n\n');
    }
    this.stdin.prompt();
    await new Promise<void>(resolve => {
      this.resolveExit = resolve;
    });
    if (!this.stdin.terminal) process.off('SIGINT', this.onSigint);
    await this.host.stop();
  }

  private command(raw: string): boolean {
    const name = raw.trim().split(/\s+/)[0] ?? '';
    switch (name) {
      case '/exit':
      case '/quit':
        this.exit();
        return true;
      case '/new':
        this.stdin.newThread();
        this.out.write('下一条消息会开一个新的 thread。\n');
        this.stdin.prompt();
        return true;
      case '/status': {
        const snapshot = this.host.snapshot();
        this.out.write(
          `运行中的 thread：${snapshot.threads}，待处理：${snapshot.pending}，`
          + `来源：${snapshot.sources.map(source => `${source.id}/${source.kind}`).join('、')}\n`,
        );
        this.stdin.prompt();
        return true;
      }
      case '/help':
        this.out.write(`${HELP}\n`);
        this.stdin.prompt();
        return true;
      default:
        return false;
    }
  }

  private signal(): void {
    if (this.host.abortThread(this.currentThreadId)) {
      this.err.write('已中断当前 thread 的本轮。\n');
      return;
    }
    const now = Date.now();
    if (now - this.lastSigint < 1_500) {
      this.exit();
      return;
    }
    this.lastSigint = now;
    this.err.write('再按一次 Ctrl-C 退出。\n');
  }

  private exit(): void {
    if (this.closed) return;
    this.closed = true;
    this.resolveExit?.();
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
