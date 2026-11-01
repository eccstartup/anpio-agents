/**
 * 本地信箱：一条输入就是一个 MailMessage，拉取时分配 deliveryId 与租约。
 *
 * 语义与平台信箱一致：租约到期可被其它会话重新拉取，ack 后不再投递，
 * nack 带退避退回。状态落在单个 JSON 快照里，靠文件锁支持进程隔离。
 */

import { randomUUID } from 'node:crypto';
import type { MailEnvelope, MailMessage, MailSession } from '../../client.ts';
import type { MailboxPort } from '../transport.ts';
import { readJson, withFileLock, writeJsonAtomic } from './store.ts';

type StoredMessage = {
  message: MailMessage;
  seq: number;
  state: 'pending' | 'acked';
  attempts: number;
  /** epoch ms；在此之前不重新投递。 */
  retryAt: number;
  lease: { sessionId: string; deliveryId: string; until: number } | null;
  lastReason: string | null;
};

type StoredSession = {
  id: string;
  kind: string;
  label: string;
  status: 'open' | 'closed';
  cursorSeq: number;
  delivered: string[];
  createdAt: string;
  lastSeenAt: string;
  closedAt: string | null;
};

type MailboxState = {
  version: 1;
  nextSeq: number;
  messages: StoredMessage[];
  sessions: StoredSession[];
};

export type EnqueueInput = {
  text: string;
  threadId?: string;
  kind?: string;
  topic?: string;
  priority?: string;
  summary?: string;
  content?: unknown;
  metadata?: Record<string, unknown>;
};

function emptyState(): MailboxState {
  return { version: 1, nextSeq: 0, messages: [], sessions: [] };
}

function envelopeOf(stored: StoredMessage, deliveryId: string): MailEnvelope {
  const message = stored.message;
  return {
    id: message.id,
    seq: stored.seq,
    deliveryId,
    topic: message.topic,
    kind: message.kind,
    priority: message.priority,
    summary: message.summary,
    ref: message.ref,
    publisherId: message.publisherId,
    createdAt: message.createdAt,
    expiresAt: message.expiresAt,
  };
}

export class LocalMailbox implements MailboxPort {
  private readonly file: string | undefined;
  private readonly lockPath: string | undefined;
  private readonly now: () => number;
  private memory = emptyState();

  constructor(options: { file?: string; now?: () => number } = {}) {
    this.file = options.file;
    this.lockPath = options.file ? `${options.file}.lock` : undefined;
    this.now = options.now ?? Date.now;
  }

  async enqueue(input: EnqueueInput): Promise<{ id: string; seq: number }> {
    return await this.mutate(state => {
      const id = `msg-${randomUUID()}`;
      const now = new Date(this.now()).toISOString();
      const threadId = input.threadId ?? null;
      const message: MailMessage = {
        id,
        topic: input.topic ?? 'standalone',
        kind: input.kind ?? 'user.message',
        priority: input.priority ?? 'normal',
        summary: (input.summary ?? input.text).slice(0, 80),
        ref: { type: 'message', id: threadId ?? id, taskId: null, threadId },
        publisherId: 'local',
        createdAt: now,
        expiresAt: null,
        content: input.content ?? { text: input.text, ...(input.metadata ?? {}) },
      };
      const seq = state.nextSeq + 1;
      state.nextSeq = seq;
      state.messages.push({
        message,
        seq,
        state: 'pending',
        attempts: 0,
        retryAt: 0,
        lease: null,
        lastReason: null,
      });
      return { id, seq };
    });
  }

  async open(input: { label?: string; kind?: 'embedded' | 'external'; ttlSeconds?: number } = {}): Promise<MailSession> {
    return await this.mutate(state => {
      const now = new Date(this.now()).toISOString();
      const session: StoredSession = {
        id: `mail-session-${randomUUID()}`,
        kind: input.kind ?? 'embedded',
        label: input.label ?? '',
        status: 'open',
        cursorSeq: 0,
        delivered: [],
        createdAt: now,
        lastSeenAt: now,
        closedAt: null,
      };
      state.sessions.push(session);
      return this.toSession(session, state);
    });
  }

  async pull(
    sessionId: string,
    options: { limit?: number; leaseSeconds?: number; since?: number; waitMs?: number } = {},
    _signal?: AbortSignal,
  ): Promise<{ items: MailEnvelope[]; cursor: number }> {
    return await this.mutate(state => {
      const session = state.sessions.find(item => item.id === sessionId);
      if (!session || session.status !== 'open') throw new Error('信箱会话不存在或已关闭');
      const now = this.now();
      const limit = Math.max(1, Math.min(Math.trunc(options.limit ?? 20), 100));
      const leaseMs = Math.max(0, options.leaseSeconds ?? 300) * 1_000;
      const candidates = state.messages
        .filter(item => item.state === 'pending')
        .filter(item => item.retryAt <= now)
        .filter(item => !session.delivered.includes(item.message.id))
        .filter(item => !item.lease || item.lease.until <= now)
        .filter(item => options.since === undefined || item.seq > options.since)
        .sort((left, right) => left.seq - right.seq)
        .slice(0, limit);

      const items = candidates.map(stored => {
        const deliveryId = `delivery-${randomUUID()}`;
        stored.lease = { sessionId, deliveryId, until: now + leaseMs };
        stored.attempts += 1;
        session.delivered.push(stored.message.id);
        session.cursorSeq = Math.max(session.cursorSeq, stored.seq);
        return envelopeOf(stored, deliveryId);
      });
      session.lastSeenAt = new Date(now).toISOString();
      return { items, cursor: session.cursorSeq };
    });
  }

  async message(messageId: string, _signal?: AbortSignal): Promise<MailMessage> {
    const state = await this.read();
    const stored = state.messages.find(item => item.message.id === messageId);
    if (!stored) throw new Error(`消息 ${messageId} 不存在`);
    return stored.message;
  }

  async ack(messageId: string, deliveryId: string): Promise<void> {
    await this.mutate(state => {
      const stored = state.messages.find(item => item.message.id === messageId);
      if (!stored) throw new Error(`消息 ${messageId} 不存在`);
      if (stored.state === 'acked') return;
      if (!stored.lease || stored.lease.deliveryId !== deliveryId) {
        throw new Error(`消息 ${messageId} 的投递凭据不匹配`);
      }
      stored.state = 'acked';
      stored.lease = null;
      stored.lastReason = null;
    });
  }

  async nack(
    messageId: string,
    input: { deliveryId: string; retryAfterSeconds?: number; reason?: string },
  ): Promise<void> {
    await this.mutate(state => {
      const stored = state.messages.find(item => item.message.id === messageId);
      if (!stored) throw new Error(`消息 ${messageId} 不存在`);
      if (stored.state === 'acked') return;
      if (!stored.lease || stored.lease.deliveryId !== input.deliveryId) {
        throw new Error(`消息 ${messageId} 的投递凭据不匹配`);
      }
      stored.state = 'pending';
      stored.lease = null;
      stored.retryAt = this.now() + Math.max(0, input.retryAfterSeconds ?? 0) * 1_000;
      stored.lastReason = input.reason ?? null;
    });
  }

  async close(sessionId: string): Promise<void> {
    await this.mutate(state => {
      const session = state.sessions.find(item => item.id === sessionId);
      if (!session || session.status === 'closed') return;
      const now = this.now();
      session.status = 'closed';
      session.closedAt = new Date(now).toISOString();
      for (const stored of state.messages) {
        if (stored.lease?.sessionId === sessionId) {
          stored.lease = null;
          stored.retryAt = now;
        }
      }
    });
  }

  /** 测试与健康检查用：当前待处理与已确认数量。 */
  async stats(): Promise<{ pending: number; acked: number; sessions: number }> {
    const state = await this.read();
    return {
      pending: state.messages.filter(item => item.state === 'pending').length,
      acked: state.messages.filter(item => item.state === 'acked').length,
      sessions: state.sessions.filter(item => item.status === 'open').length,
    };
  }

  private toSession(session: StoredSession, state: MailboxState): MailSession {
    return {
      id: session.id,
      kind: session.kind,
      label: session.label,
      status: session.status,
      cursorSeq: session.cursorSeq,
      unread: state.messages.filter(item => item.state === 'pending').length,
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
      expiresAt: null,
      closedAt: session.closedAt,
    };
  }

  private async read(): Promise<MailboxState> {
    if (!this.file) return this.memory;
    return (await readJson<MailboxState>(this.file)) ?? emptyState();
  }

  private async mutate<T>(fn: (state: MailboxState) => T | Promise<T>): Promise<T> {
    if (!this.file) {
      const result = await fn(this.memory);
      return result;
    }
    return await withFileLock(this.lockPath!, async () => {
      const state = (await readJson<MailboxState>(this.file!)) ?? emptyState();
      const result = await fn(state);
      await writeJsonAtomic(this.file!, state);
      return result;
    });
  }
}
