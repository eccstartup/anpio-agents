/**
 * 终端输入来源：每读到一行就是一条消息。
 *
 * 不实现 reply：回答已经通过 text-delta / assistant-text 事件直接写到终端，
 * 再 reply 一次会重复输出。
 */

import { createInterface, type Interface } from 'node:readline';
import type { InboundMessage, MessageSource } from '../threads/types.ts';

export type StdinSourceOptions = {
  id?: string;
  /** 默认 thread；新消息都归到这里，除非显式 newThread。 */
  threadId?: string;
  input?: NodeJS.ReadableStream;
  prompt?: string;
  /** 返回 true 表示命令已处理，不再当消息发送。 */
  onCommand?: (command: string) => boolean;
  /** EOF / Ctrl-D。 */
  onClose?: () => void;
};

export class StdinSource implements MessageSource {
  readonly id: string;
  readonly kind = 'interactive' as const;

  private readonly input: NodeJS.ReadableStream;
  private readonly threadId: string;
  private readonly promptText: string;
  private buffer: InboundMessage[] = [];
  private counter = 0;
  private newThreadNext = false;
  private reader: Interface | null = null;
  private stopping = false;

  onCommand: ((command: string) => boolean) | null;
  onClose: (() => void) | null;
  onSignal: (() => void) | null;

  constructor(options: StdinSourceOptions = {}) {
    this.id = options.id ?? 'stdin';
    this.threadId = options.threadId ?? 'local:main';
    this.input = options.input ?? process.stdin;
    this.promptText = options.prompt ?? '› ';
    this.onCommand = options.onCommand ?? null;
    this.onClose = options.onClose ?? null;
    this.onSignal = null;
  }

  get terminal(): boolean {
    return Boolean((this.input as NodeJS.ReadStream).isTTY);
  }

  async open(emit: () => void): Promise<void> {
    const terminal = this.terminal;
    const reader = createInterface({
      input: this.input,
      terminal,
      ...(terminal ? { output: process.stdout } : {}),
    });
    this.reader = reader;
    if (terminal) reader.setPrompt(this.promptText);

    reader.on('line', line => {
      const text = line.trim();
      if (!text) {
        this.prompt();
        return;
      }
      if (text.startsWith('/') && this.onCommand?.(text)) return;
      this.counter += 1;
      this.buffer.push({
        id: `stdin-${Date.now()}-${this.counter}`,
        text,
        threadId: this.threadId,
        kind: 'chat.message',
        receivedAt: new Date().toISOString(),
        ...(this.newThreadNext ? { newThread: true } : {}),
      });
      this.newThreadNext = false;
      emit();
    });
    reader.on('SIGINT', () => {
      this.onSignal?.();
    });
    reader.on('close', () => {
      this.reader = null;
      if (!this.stopping) this.onClose?.();
    });
  }

  poll(): Promise<InboundMessage[]> {
    return Promise.resolve(this.buffer.splice(0));
  }

  /** 下一行开一个新 thread（REPL 的 /new）。 */
  newThread(): void {
    this.newThreadNext = true;
  }

  prompt(): void {
    if (this.reader && this.terminal) this.reader.prompt();
  }

  async close(): Promise<void> {
    this.stopping = true;
    this.reader?.close();
    this.reader = null;
  }
}
