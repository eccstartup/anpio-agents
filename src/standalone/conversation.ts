/**
 * 本地会话历史：按 threadId 落成 JSONL，供下一轮拼进模型上下文。
 *
 * 只存「用户输入 + 最终回答」两类消息；工具调用属于单轮内部过程，不进历史。
 * 文件名用 threadId 的哈希，避免任意字符进入路径。
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ChatMessage } from '../brains/types.ts';
import { appendJsonLine, withFileLock } from '../runtime/local/store.ts';

export const DEFAULT_HISTORY_MESSAGES = 40;
export const DEFAULT_HISTORY_BYTES = 262_144;

export type ConversationStoreOptions = {
  dir: string;
  /** 保留的最大消息条数，从最旧的成对消息开始淘汰。 */
  maxMessages?: number;
  /** 保留的最大字节数，按序列化后的大小算。 */
  maxBytes?: number;
};

export class ConversationStore {
  private readonly dir: string;
  private readonly maxMessages: number;
  private readonly maxBytes: number;

  constructor(options: ConversationStoreOptions) {
    this.dir = options.dir;
    this.maxMessages = Math.max(2, options.maxMessages ?? DEFAULT_HISTORY_MESSAGES);
    this.maxBytes = Math.max(1_024, options.maxBytes ?? DEFAULT_HISTORY_BYTES);
  }

  /** 读取某个 threadId 的历史；文件不存在时返回空数组。 */
  async load(threadId: string): Promise<ChatMessage[]> {
    const file = this.fileFor(threadId);
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const messages: ChatMessage[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        // 最后一行可能只写了一半，忽略即可。
        continue;
      }
      const message = asMessage(value);
      if (message) messages.push(message);
    }
    return trim(messages, this.maxMessages, this.maxBytes);
  }

  /** 追加一轮对话；超过保留上限时从最旧处淘汰并重写文件。 */
  async append(threadId: string, messages: ChatMessage[]): Promise<void> {
    if (messages.length === 0) return;
    const file = this.fileFor(threadId);
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await withFileLock(`${file}.lock`, async () => {
      const existing = await this.load(threadId);
      const combined = [...existing, ...messages];
      const merged = trim(combined, this.maxMessages, this.maxBytes);
      if (merged.length === combined.length) {
        // 没有淘汰时直接追加，避免整文件重写。
        if (existing.length === 0) await appendJsonLine(file, { type: 'meta', threadId });
        for (const message of messages) await appendJsonLine(file, message);
        return;
      }
      const payload = [
        JSON.stringify({ type: 'meta', threadId }),
        ...merged.map(message => JSON.stringify(message)),
        '',
      ].join('\n');
      const temp = `${file}.${process.pid}.tmp`;
      await writeFile(temp, payload, { mode: 0o600 });
      await rename(temp, file);
    });
  }

  private fileFor(threadId: string): string {
    const trimmed = threadId.trim();
    if (!trimmed) throw new Error('threadId 不能为空');
    const digest = createHash('sha256').update(trimmed).digest('hex').slice(0, 32);
    return join(this.dir, `${digest}.jsonl`);
  }
}

function asMessage(value: unknown): ChatMessage | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.role === 'user' && typeof record.content === 'string') {
    return { role: 'user', content: record.content };
  }
  if (record.role === 'assistant' && (record.content === undefined || typeof record.content === 'string')) {
    return { role: 'assistant', ...(record.content === undefined ? {} : { content: record.content }) };
  }
  return null;
}

function trim(messages: ChatMessage[], maxMessages: number, maxBytes: number): ChatMessage[] {
  let start = 0;
  while (messages.length - start > maxMessages) start += 2;
  while (start < messages.length && messages[start]!.role !== 'user') start += 1;
  while (start < messages.length - 1 && byteLength(messages, start) > maxBytes) {
    start += 2;
    while (start < messages.length && messages[start]!.role !== 'user') start += 1;
  }
  if (start >= messages.length) {
    // 单轮就超过字节上限时，至少保留最近的用户输入，别把上下文清空。
    const lastUser = messages.findLastIndex(message => message.role === 'user');
    start = lastUser >= 0 ? lastUser : Math.max(0, messages.length - 1);
  }
  return messages.slice(start);
}

function byteLength(messages: ChatMessage[], start: number): number {
  let total = 0;
  for (let index = start; index < messages.length; index += 1) {
    total += Buffer.byteLength(JSON.stringify(messages[index])) + 1;
  }
  return total;
}
