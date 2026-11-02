/**
 * ANP 信箱：本地 inbox 是权威，`sync.delta` 只是搬运。
 *
 * service 没有 ack 概念，投递在 30 天窗口内可反复拉取；所以 ack/nack 只改
 * `agent.db.inbox`，`sync.delta` 的游标只记录已经搬进本地的位置。
 */

import { randomUUID } from 'node:crypto';
import type { MailEnvelope, MailMessage, MailSession } from '../../client.ts';
import type { MailboxPort } from '../transport.ts';
import type { AgentStore, InboxRow } from '../../store/agent-store.ts';
import { nowIso } from '../../store/sqlite.ts';
import type { AnpClient, AnpPayload, SendResult } from '../../anp/client.ts';
import { AnpRpcError } from '../../anp/client.ts';
import { UnroutableTargetError } from '../../anp/errors.ts';

const CURSOR_KEY = 'last_seq';
const BACKOFF_SECONDS = [1, 5, 30, 300, 1_800];

type OpenSession = {
  id: string;
  label: string;
  status: 'open' | 'closed';
  cursorSeq: number;
  createdAt: string;
  lastSeenAt: string;
  closedAt: string | null;
};

export type AnpMailboxOptions = {
  store: AgentStore;
  client: AnpClient;
  /** 这个 Session 绑定的 thread；pull 只返回该 thread 的待处理消息。 */
  threadId: string;
  now?: () => number;
  /** 目标 DID 是否由本 router 托管；缺省视为可投递（独立信箱测试）。 */
  canDeliver?: (did: string) => boolean;
  log?: (line: string) => void;
};

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function field(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function summaryOf(body: Record<string, unknown>): string {
  const payload = asRecord(body.payload);
  return field(payload.title) ?? field(payload.text) ?? field(body.text) ?? field(payload.type) ?? 'ANP 消息';
}

function envelopeOf(row: InboxRow & { delivery_id: string }): MailEnvelope {
  const body = asRecord(JSON.parse(row.body_json));
  const payload = asRecord(body.payload);
  const kind = field(payload.type) ?? 'anp.message';
  return {
    id: row.message_id,
    seq: row.seq,
    deliveryId: row.delivery_id,
    topic: kind,
    kind,
    priority: 'normal',
    summary: summaryOf(body).slice(0, 80),
    ref: {
      type: 'anp',
      id: row.message_id,
      taskId: field(payload.task_id) ?? null,
      threadId: row.thread_id,
    },
    publisherId: row.sender_did ?? '',
    createdAt: row.received_at,
    expiresAt: null,
  };
}

function mailMessageOf(row: InboxRow): MailMessage {
  const body = asRecord(JSON.parse(row.body_json));
  const envelope = envelopeOf({ ...row, delivery_id: '' });
  return {
    id: row.message_id,
    topic: envelope.topic,
    kind: envelope.kind,
    priority: envelope.priority,
    summary: envelope.summary,
    ref: envelope.ref,
    publisherId: envelope.publisherId,
    createdAt: envelope.createdAt,
    expiresAt: null,
    content: { body, senderDid: row.sender_did, targetDid: row.target_did },
  };
}

export class AnpMailbox implements MailboxPort {
  private readonly store: AgentStore;
  private readonly client: AnpClient;
  private readonly threadId: string;
  private readonly now: () => number;
  private readonly canDeliver: (did: string) => boolean;
  private readonly log: (line: string) => void;
  private readonly sessions = new Map<string, OpenSession>();
  private readonly leases = new Map<string, Set<string>>();

  constructor(options: AnpMailboxOptions) {
    this.store = options.store;
    this.client = options.client;
    this.threadId = options.threadId;
    this.now = options.now ?? Date.now;
    this.canDeliver = options.canDeliver ?? (() => true);
    this.log = options.log ?? (() => undefined);
  }

  /** 把 service 上还没搬过的投递拉进本地 inbox，按 message_id 去重。 */
  async sync(): Promise<{ added: number; cursor: number; hasMore: boolean }> {
    let cursor = this.store.getCursor(CURSOR_KEY) ?? 0;
    let added = 0;
    let hasMore = false;
    for (let page = 0; page < 50; page += 1) {
      const result = await this.client.sync({ since: cursor, limit: 100 });
      for (const message of result.messages) {
        if (message.method !== 'direct.incoming') continue;
        const messageId = field(message.meta.message_id);
        if (!messageId) continue;
        const body = asRecord(message.body);
        const threadId = field(body.conversation_id) ?? messageId;
        const targetDid = field(asRecord(message.meta.target).did) ?? this.client.identity.did;
        const inserted = this.store.recordIncoming({
          messageId,
          threadId,
          senderDid: field(message.meta.sender_did) ?? null,
          targetDid,
          contentType: field(message.meta.content_type) ?? 'application/json',
          body,
          replyTo: field(body.reply_to) ?? null,
          receivedAt: nowIso(this.now),
        });
        if (inserted) added += 1;
      }
      if (result.agedOut > 0) {
        this.log(`sync.delta 有 ${result.agedOut} 条投递已超出保留窗口，无法再拉取`);
      }
      const next = result.nextSince;
      this.store.setCursor(CURSOR_KEY, next);
      hasMore = result.hasMore;
      if (!hasMore) {
        cursor = next;
        break;
      }
      if (next <= cursor) break;
      cursor = next;
    }
    return { added, cursor, hasMore };
  }

  async send(input: {
    targetDid: string;
    threadId?: string;
    payload: AnpPayload;
    replyTo?: string | null;
  }): Promise<SendResult & { queued: boolean }> {
    if (!this.canDeliver(input.targetDid)) throw new UnroutableTargetError(input.targetDid);
    const threadId = input.threadId ?? this.threadId;
    const messageId = `anp-${randomUUID()}`;
    const body = {
      payload: input.payload,
      conversation_id: threadId,
      ...(input.replyTo ? { reply_to: input.replyTo } : {}),
    };
    this.store.queueOutbox({
      messageId,
      threadId,
      targetDid: input.targetDid,
      contentType: 'application/json',
      body,
      replyTo: input.replyTo ?? null,
    });
    const flushed = await this.flushOutbox([messageId]);
    const row = this.store.getOutbox(messageId);
    if (row?.sent_at) {
      return {
        accepted: true,
        messageId,
        targetDid: input.targetDid,
        conversationId: threadId,
        acceptedAt: row.sent_at,
        queued: false,
      };
    }
    return {
      accepted: false,
      messageId,
      targetDid: input.targetDid,
      conversationId: threadId,
      acceptedAt: null,
      queued: flushed.failed > 0 || !row?.sent_at,
    };
  }

  /** 重试所有到期的出站消息；单条失败只记录下次重试时间。 */
  async flushOutbox(only?: string[]): Promise<{ sent: number; failed: number }> {
    let sent = 0;
    let failed = 0;
    const due = this.store.dueOutbox(this.now());
    for (const row of due) {
      if (only && !only.includes(row.message_id)) continue;
      if (!this.canDeliver(row.target_did)) {
        const error = new UnroutableTargetError(row.target_did);
        this.store.retireOutbox(row.message_id, error.message);
        this.log(`出站 ${row.message_id} 已终止重试：${error.message}`);
        failed += 1;
        continue;
      }
      try {
        const body = asRecord(JSON.parse(row.body_json));
        const payload = asRecord(body.payload);
        const result = await this.client.send({
          targetDid: row.target_did,
          threadId: row.thread_id,
          payload: {
            type: field(payload.type) ?? 'anp.chat.message',
            ...(field(payload.text) ? { text: field(payload.text)! } : {}),
            ...(field(payload.title) ? { title: field(payload.title)! } : {}),
            ...(field(payload.task_id) ? { task_id: field(payload.task_id)! } : {}),
            ...('data' in payload ? { data: payload.data } : {}),
          },
          replyTo: row.reply_to,
          messageId: row.message_id,
          operationId: `send:${row.message_id}`,
        });
        this.store.markOutboxSent(row.message_id, result);
        sent += 1;
      } catch (error) {
        const index = Math.min(row.attempts, BACKOFF_SECONDS.length - 1);
        const next = this.now() + (BACKOFF_SECONDS[index] ?? 1_800) * 1_000;
        this.store.failOutbox(row.message_id, next, {
          error: error instanceof Error ? error.message : String(error),
          ...(error instanceof AnpRpcError && error.anpCode ? { anpCode: error.anpCode } : {}),
        });
        failed += 1;
      }
    }
    return { sent, failed };
  }

  async open(
    input: { label?: string; kind?: 'embedded' | 'external'; ttlSeconds?: number } = {},
  ): Promise<MailSession> {
    const label = input.label ?? `session:${randomUUID()}`;
    const existing = this.sessions.get(label);
    const now = new Date(this.now()).toISOString();
    // 同一 label 关闭后再次 open 要拿到新的会话；否则下一个 turn 会继承已关闭状态。
    const session: OpenSession = existing && existing.status === 'open'
      ? existing
      : {
          id: `mail-session-${randomUUID()}`,
          label,
          status: 'open',
          cursorSeq: this.store.getCursor(CURSOR_KEY) ?? 0,
          createdAt: now,
          lastSeenAt: now,
          closedAt: null,
        };
    this.sessions.set(label, session);
    return this.toSession(session);
  }

  async pull(
    sessionId: string,
    options: { limit?: number; leaseSeconds?: number; since?: number; waitMs?: number } = {},
  ): Promise<{ items: MailEnvelope[]; cursor: number }> {
    const session = this.findSession(sessionId);
    if (!session || session.status !== 'open') throw new Error('信箱会话不存在或已关闭');
    await this.sync();
    this.store.releaseExpiredLeases(this.now());
    const rows = this.store.pullInbox({
      threadId: this.threadId,
      limit: options.limit ?? 20,
      leaseSeconds: options.leaseSeconds ?? 300,
      now: this.now(),
    });
    if (rows.length > 0) {
      const tokens = this.leases.get(sessionId) ?? new Set<string>();
      tokens.add(rows[0]!.delivery_id);
      this.leases.set(sessionId, tokens);
      session.cursorSeq = Math.max(session.cursorSeq, ...rows.map(row => row.seq));
      session.lastSeenAt = new Date(this.now()).toISOString();
    }
    return { items: rows.map(envelopeOf), cursor: session.cursorSeq };
  }

  async message(messageId: string): Promise<MailMessage> {
    const row = this.store.inboxByMessage(messageId);
    if (!row) throw new Error(`消息 ${messageId} 不存在`);
    return mailMessageOf(row);
  }

  async ack(messageId: string, deliveryId: string): Promise<void> {
    if (!this.store.ackInbox(messageId, deliveryId)) {
      throw new Error(`消息 ${messageId} 的投递凭据不匹配`);
    }
    for (const tokens of this.leases.values()) tokens.delete(deliveryId);
  }

  async nack(
    messageId: string,
    input: { deliveryId: string; retryAfterSeconds?: number; reason?: string },
  ): Promise<void> {
    const retryAt = this.now() + Math.max(0, input.retryAfterSeconds ?? 0) * 1_000;
    if (!this.store.nackInbox(messageId, { deliveryId: input.deliveryId, retryAt })) {
      throw new Error(`消息 ${messageId} 的投递凭据不匹配`);
    }
    for (const tokens of this.leases.values()) tokens.delete(input.deliveryId);
  }

  async close(sessionId: string): Promise<void> {
    const session = this.findSession(sessionId);
    if (!session || session.status === 'closed') return;
    session.status = 'closed';
    session.closedAt = new Date(this.now()).toISOString();
    for (const token of this.leases.get(sessionId) ?? []) this.store.releaseLease(token);
    this.leases.delete(sessionId);
  }

  /** Session 恢复：只搬消息，不重建租约。 */
  async resume(_sessionKey: string): Promise<void> {
    await this.sync();
  }

  async renew(sessionId: string, leaseSeconds = 300): Promise<void> {
    const session = this.findSession(sessionId);
    if (!session || session.status !== 'open') return;
    for (const token of this.leases.get(sessionId) ?? []) {
      this.store.renewInboxLease(token, leaseSeconds);
    }
  }

  pending(sessionId?: string): number {
    if (sessionId) {
      const session = this.findSession(sessionId);
      if (!session || session.status !== 'open') return 0;
    }
    return this.store.pendingInboxCount(this.threadId);
  }

  private findSession(sessionId: string): OpenSession | undefined {
    for (const session of this.sessions.values()) {
      if (session.id === sessionId) return session;
    }
    return undefined;
  }

  private toSession(session: OpenSession): MailSession {
    return {
      id: session.id,
      kind: 'embedded',
      label: session.label,
      status: session.status,
      cursorSeq: session.cursorSeq,
      unread: this.store.pendingInboxCount(this.threadId),
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
      expiresAt: null,
      closedAt: session.closedAt,
    };
  }
}
