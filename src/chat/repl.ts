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
  /mcp       查看已接入的 MCP 插件
  /mcp add <id=命令 参数>   运行时接入一个 MCP server
  /mcp remove <id>          断开并移除插件
  /exit      退出（Ctrl-D 也可以）
  /help      显示本帮助`;

/** REPL 与插件层的接口；由入口负责把命令翻译成注册表操作。 */
export type ReplPluginControl = {
  list(): string;
  add(spec: string): Promise<string>;
  remove(id: string): Promise<string>;
};

type TurnState = {
  printed: boolean;
  streamed: boolean;
  needsNewline: boolean;
  progress: Map<string, number>;
};

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
  private readonly backgroundProgress = new Map<string, number>();

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
      case 'plugin-progress':
        if (reportProgress(state.progress, `${event.pluginId}\u0000${event.tool}`, event)) {
          this.lineBreak(state);
          this.err.write(`… ${progressText(event)}\n`);
        }
        break;
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
      case 'plugin-progress':
        if (
          reportProgress(
            this.backgroundProgress,
            `${event.threadId}\u0000${event.turnId}\u0000${event.pluginId}\u0000${event.tool}`,
            event,
          )
        ) {
          this.err.write(`${prefix} … ${progressText(event)}\n`);
        }
        break;
      case 'turn-end':
        this.forgetProgress(event.threadId, event.turnId);
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
    const created: TurnState = {
      printed: false,
      streamed: false,
      needsNewline: false,
      progress: new Map(),
    };
    this.turns.set(turnId, created);
    return created;
  }

  private forgetProgress(threadId: string, turnId: string): void {
    const prefix = `${threadId}\u0000${turnId}\u0000`;
    for (const key of this.backgroundProgress.keys()) {
      if (key.startsWith(prefix)) this.backgroundProgress.delete(key);
    }
  }
}

export type ReplOptions = {
  host: ThreadHost;
  stdin: StdinSource;
  plugins?: ReplPluginControl;
  output?: NodeJS.WritableStream;
  error?: NodeJS.WritableStream;
};

export class Repl {
  private readonly host: ThreadHost;
  private readonly stdin: StdinSource;
  private readonly pluginControl: ReplPluginControl | undefined;
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
    this.pluginControl = options.plugins;
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
      case '/mcp':
      case '/plugin': {
        const rest = raw.trim().slice(name.length).trim();
        void this.pluginCommand(rest);
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

  /** `/mcp` 查看，`/mcp add <spec>` 接入，`/mcp remove <id>` 移除。 */
  private async pluginCommand(rest: string): Promise<void> {
    const control = this.pluginControl;
    if (!control) {
      this.err.write('这个入口没有启用插件管理。\n');
      this.stdin.prompt();
      return;
    }

    try {
      const match = /^(add|connect|remove|rm|list)?\s*([\s\S]*)$/.exec(rest);
      const verb = match?.[1] ?? '';
      const argument = (match?.[2] ?? '').trim();

      if (verb === '' || verb === 'list') {
        if (argument !== '') {
          await this.pluginAdd(control, argument);
        } else {
          this.out.write(`${control.list()}\n`);
        }
      } else if (verb === 'add' || verb === 'connect') {
        if (argument === '') {
          this.err.write('用法：/mcp add <id=命令 参数>，例如 /mcp add ci=node ./ci-mcp.ts\n');
        } else {
          await this.pluginAdd(control, argument);
        }
      } else if (verb === 'remove' || verb === 'rm') {
        if (argument === '') {
          this.err.write('用法：/mcp remove <id>\n');
        } else if (!this.busy()) {
          this.out.write(`${await control.remove(argument)}\n`);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.err.write(`插件操作失败：${message}\n`);
    }

    this.stdin.prompt();
  }

  private async pluginAdd(control: ReplPluginControl, spec: string): Promise<void> {
    if (this.busy()) return;
    this.out.write(`${await control.add(spec)}\n`);
  }

  private busy(): boolean {
    if (this.host.snapshot().threads === 0) return false;
    this.err.write('有 thread 正在运行，等本轮结束再改插件。\n');
    return true;
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

/** 进度每 10 条报一次；到终值那一条一定报，避免话痨插件刷屏。 */
function reportProgress(
  counts: Map<string, number>,
  key: string,
  event: Extract<ThreadEvent, { type: 'plugin-progress' }>,
): boolean {
  const count = (counts.get(key) ?? 0) + 1;
  counts.set(key, count);
  return (event.total !== undefined && event.progress >= event.total) || count % 10 === 0;
}

function progressText(event: Extract<ThreadEvent, { type: 'plugin-progress' }>): string {
  const total = event.total === undefined ? '' : `/${event.total}`;
  const message = event.message === undefined ? '' : ` ${truncate(event.message, 120)}`;
  return `插件 ${event.pluginId} ${event.tool} ${event.progress}${total}${message}`;
}
