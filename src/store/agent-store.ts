/**
 * Agent 数据面：thread 镜像、inbox/outbox、turn、工具审计、幂等结果与笔记。
 *
 * inbox 是长期权威（ANP 服务的 sync.delta 只有 30 天可读窗口）；ack/nack 只改本地状态。
 */

import { randomUUID } from 'node:crypto';
import { SqliteDb, migrate, nowIso } from './sqlite.ts';

export type MessageDirection = 'in' | 'out';

export type MessageRow = {
  message_id: string;
  thread_id: string;
  direction: MessageDirection;
  sender_did: string | null;
  target_did: string | null;
  content_type: string;
  body_json: string;
  reply_to: string | null;
  created_at: string;
};

export type InboxRow = {
  seq: number;
  message_id: string;
  thread_id: string;
  sender_did: string | null;
  target_did: string;
  content_type: string;
  body_json: string;
  reply_to: string | null;
  received_at: string;
  status: 'pending' | 'acked';
  attempts: number;
  retry_at: number;
  lease_until: number | null;
  lease_token: string | null;
};

export type OutboxRow = {
  message_id: string;
  thread_id: string;
  target_did: string;
  content_type: string;
  body_json: string;
  reply_to: string | null;
  created_at: string;
  attempts: number;
  next_attempt_at: number;
  sent_at: string | null;
  service_json: string | null;
};

export type AgentTurnRow = {
  turn_id: string;
  thread_id: string;
  run_id: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  summary: string | null;
  error: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  trigger_message_id: string | null;
};

export type NewInboxMessage = {
  messageId: string;
  threadId: string;
  senderDid?: string | null;
  targetDid: string;
  contentType: string;
  body: unknown;
  replyTo?: string | null;
  receivedAt?: string;
};

export type NewOutboxMessage = {
  messageId: string;
  threadId: string;
  targetDid: string;
  contentType: string;
  body: unknown;
  replyTo?: string | null;
};

const AGENT_MIGRATIONS = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS threads (
        thread_id TEXT PRIMARY KEY,
        title TEXT,
        state TEXT NOT NULL DEFAULT 'open',
        last_seq INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS messages (
        message_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        sender_did TEXT,
        target_did TEXT,
        content_type TEXT NOT NULL,
        body_json TEXT NOT NULL,
        reply_to TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS inbox (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL UNIQUE,
        thread_id TEXT NOT NULL,
        sender_did TEXT,
        target_did TEXT NOT NULL,
        content_type TEXT NOT NULL,
        body_json TEXT NOT NULL,
        reply_to TEXT,
        received_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        retry_at INTEGER NOT NULL DEFAULT 0,
        lease_until INTEGER,
        lease_token TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS outbox (
        message_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        target_did TEXT NOT NULL,
        content_type TEXT NOT NULL,
        body_json TEXT NOT NULL,
        reply_to TEXT,
        created_at TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        sent_at TEXT,
        service_json TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS turns (
        turn_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        summary TEXT,
        error TEXT,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        trigger_message_id TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS tool_audit (
        id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        args_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        effect_id TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS effects (
        scope TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (scope, operation_id)
      )`,
      `CREATE TABLE IF NOT EXISTS notes (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS context_state (
        session_id TEXT PRIMARY KEY,
        last_seq INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      )`,
      'CREATE INDEX IF NOT EXISTS messages_thread ON messages (thread_id, created_at)',
      'CREATE INDEX IF NOT EXISTS inbox_pending ON inbox (status, thread_id, seq)',
      'CREATE INDEX IF NOT EXISTS outbox_due ON outbox (sent_at, next_attempt_at)',
      'CREATE INDEX IF NOT EXISTS turns_thread ON turns (thread_id, started_at)',
    ],
  },
];

export class AgentStore {
  readonly db: SqliteDb;

  constructor(path: string) {
    this.db = new SqliteDb(path);
    migrate(this.db, AGENT_MIGRATIONS);
  }

  close(): void {
    this.db.close();
  }

  // --------------------------------------------------------------- threads

  touchThread(threadId: string, title?: string | null): void {
    this.db.run(
      `INSERT INTO threads (thread_id, title, state, last_seq, updated_at)
       VALUES (?, ?, 'open', 0, ?)
       ON CONFLICT(thread_id) DO UPDATE SET
         title = COALESCE(threads.title, excluded.title),
         updated_at = excluded.updated_at`,
      threadId,
      title ?? null,
      nowIso(),
    );
  }

  listThreads(limit = 50): Array<{ thread_id: string; title: string | null; state: string; last_seq: number; updated_at: string }> {
    return this.db.all(
      'SELECT thread_id, title, state, last_seq, updated_at FROM threads ORDER BY updated_at DESC LIMIT ?',
      limit,
    );
  }

  // -------------------------------------------------------------- messages

  insertMessage(input: MessageRow): boolean {
    const result = this.db.run(
      `INSERT OR IGNORE INTO messages
        (message_id, thread_id, direction, sender_did, target_did, content_type, body_json, reply_to, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.message_id,
      input.thread_id,
      input.direction,
      input.sender_did ?? null,
      input.target_did ?? null,
      input.content_type,
      input.body_json,
      input.reply_to ?? null,
      input.created_at,
    );
    return result.changes === 1;
  }

  /** 入站消息同时写镜像与 inbox，按 message_id 幂等。 */
  recordIncoming(input: NewInboxMessage): boolean {
    return this.db.tx(() => {
      const receivedAt = input.receivedAt ?? nowIso();
      const bodyJson = JSON.stringify(input.body ?? {});
      const inserted = this.db.run(
        `INSERT OR IGNORE INTO inbox
          (message_id, thread_id, sender_did, target_did, content_type, body_json, reply_to, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        input.messageId,
        input.threadId,
        input.senderDid ?? null,
        input.targetDid,
        input.contentType,
        bodyJson,
        input.replyTo ?? null,
        receivedAt,
      );
      if (inserted.changes === 0) return false;
      this.insertMessage({
        message_id: input.messageId,
        thread_id: input.threadId,
        direction: 'in',
        sender_did: input.senderDid ?? null,
        target_did: input.targetDid,
        content_type: input.contentType,
        body_json: bodyJson,
        reply_to: input.replyTo ?? null,
        created_at: receivedAt,
      });
      this.touchThread(input.threadId);
      this.db.run(
        'UPDATE threads SET last_seq = MAX(last_seq, ?), updated_at = ? WHERE thread_id = ?',
        inserted.lastInsertRowid,
        receivedAt,
        input.threadId,
      );
      return true;
    });
  }

  listMessages(threadId: string, limit = 50): MessageRow[] {
    return this.db.all<MessageRow>(
      'SELECT * FROM messages WHERE thread_id = ? ORDER BY rowid DESC LIMIT ?',
      threadId,
      limit,
    ).reverse();
  }

  /** 历史预算：保留最近 maxMessages 条 / maxBytes 字节；返回按时间正序的行。 */
  history(threadId: string, options: { maxMessages?: number; maxBytes?: number } = {}): MessageRow[] {
    const maxMessages = options.maxMessages ?? 60;
    const maxBytes = options.maxBytes ?? 256 * 1024;
    const rows = this.db.all<MessageRow>(
      'SELECT * FROM messages WHERE thread_id = ? ORDER BY rowid DESC LIMIT ?',
      threadId,
      maxMessages,
    ).reverse();
    let total = 0;
    const kept: MessageRow[] = [];
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index]!;
      const size = Buffer.byteLength(row.body_json, 'utf8');
      if (kept.length > 0 && total + size > maxBytes) break;
      kept.push(row);
      total += size;
    }
    return kept.reverse();
  }

  deleteMessagesOlderThan(threadId: string, keep: number): number {
    const result = this.db.run(
      `DELETE FROM messages WHERE thread_id = ? AND rowid NOT IN (
        SELECT rowid FROM messages WHERE thread_id = ? ORDER BY rowid DESC LIMIT ?
      )`,
      threadId,
      threadId,
      keep,
    );
    return result.changes;
  }

  // ----------------------------------------------------------------- inbox

  pullInbox(options: {
    threadId?: string;
    limit?: number;
    leaseSeconds?: number;
    now?: number;
  } = {}): Array<InboxRow & { delivery_id: string }> {
    const now = options.now ?? Date.now();
    const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
    const leaseMs = Math.max(1, options.leaseSeconds ?? 300) * 1_000;
    return this.db.tx(() => {
      const rows = options.threadId
        ? this.db.all<InboxRow>(
            `SELECT * FROM inbox
             WHERE status = 'pending' AND thread_id = ? AND retry_at <= ?
               AND (lease_until IS NULL OR lease_until <= ?)
             ORDER BY seq LIMIT ?`,
            options.threadId,
            now,
            now,
            limit,
          )
        : this.db.all<InboxRow>(
            `SELECT * FROM inbox
             WHERE status = 'pending' AND retry_at <= ?
               AND (lease_until IS NULL OR lease_until <= ?)
             ORDER BY seq LIMIT ?`,
            now,
            now,
            limit,
          );
      const token = `lease-${randomUUID()}`;
      for (const row of rows) {
        this.db.run(
          `UPDATE inbox SET attempts = attempts + 1, lease_until = ?, lease_token = ?
           WHERE seq = ? AND status = 'pending'`,
          now + leaseMs,
          token,
          row.seq,
        );
      }
      return rows.map(row => ({ ...row, delivery_id: token }));
    });
  }

  ackInbox(messageId: string, deliveryId: string): boolean {
    const result = this.db.run(
      `UPDATE inbox SET status = 'acked', lease_until = NULL, lease_token = NULL
       WHERE message_id = ? AND status = 'pending' AND lease_token = ?`,
      messageId,
      deliveryId,
    );
    return result.changes === 1;
  }

  nackInbox(messageId: string, input: { deliveryId: string; retryAt: number }): boolean {
    const result = this.db.run(
      `UPDATE inbox SET status = 'pending', lease_until = NULL, lease_token = NULL, retry_at = ?
       WHERE message_id = ? AND status = 'pending' AND lease_token = ?`,
      input.retryAt,
      messageId,
      input.deliveryId,
    );
    return result.changes === 1;
  }

  renewInboxLease(deliveryId: string, leaseSeconds = 300): void {
    this.db.run(
      `UPDATE inbox SET lease_until = ? WHERE lease_token = ? AND status = 'pending'`,
      Date.now() + Math.max(1, leaseSeconds) * 1_000,
      deliveryId,
    );
  }

  releaseExpiredLeases(now = Date.now()): number {
    return this.db.run(
      `UPDATE inbox SET lease_until = NULL, lease_token = NULL
       WHERE status = 'pending' AND lease_until IS NOT NULL AND lease_until <= ?`,
      now,
    ).changes;
  }

  pendingInboxCount(threadId?: string): number {
    return Number(
      (threadId
        ? this.db.get<{ count: number }>(
            "SELECT COUNT(*) AS count FROM inbox WHERE status = 'pending' AND thread_id = ?",
            threadId,
          )
        : this.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM inbox WHERE status = 'pending'"))?.count ?? 0,
    );
  }

  inboxByMessage(messageId: string): InboxRow | undefined {
    return this.db.get<InboxRow>('SELECT * FROM inbox WHERE message_id = ?', messageId);
  }

  // ---------------------------------------------------------------- outbox

  queueOutbox(input: NewOutboxMessage): OutboxRow {
    const now = nowIso();
    this.db.run(
      `INSERT OR IGNORE INTO outbox
        (message_id, thread_id, target_did, content_type, body_json, reply_to, created_at, attempts, next_attempt_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)`,
      input.messageId,
      input.threadId,
      input.targetDid,
      input.contentType,
      JSON.stringify(input.body ?? {}),
      input.replyTo ?? null,
      now,
    );
    this.insertMessage({
      message_id: input.messageId,
      thread_id: input.threadId,
      direction: 'out',
      sender_did: null,
      target_did: input.targetDid,
      content_type: input.contentType,
      body_json: JSON.stringify(input.body ?? {}),
      reply_to: input.replyTo ?? null,
      created_at: now,
    });
    this.touchThread(input.threadId);
    return this.db.get<OutboxRow>('SELECT * FROM outbox WHERE message_id = ?', input.messageId)!;
  }

  getOutbox(messageId: string): OutboxRow | undefined {
    return this.db.get<OutboxRow>('SELECT * FROM outbox WHERE message_id = ?', messageId);
  }

  markOutboxSent(messageId: string, service?: unknown): void {
    this.db.run(
      'UPDATE outbox SET sent_at = ?, service_json = ? WHERE message_id = ?',
      nowIso(),
      service === undefined ? null : JSON.stringify(service),
      messageId,
    );
  }

  failOutbox(messageId: string, nextAttemptAt: number, service?: unknown): void {
    this.db.run(
      `UPDATE outbox SET attempts = attempts + 1, next_attempt_at = ?, service_json = ?
       WHERE message_id = ?`,
      nextAttemptAt,
      service === undefined ? null : JSON.stringify(service),
      messageId,
    );
  }

  dueOutbox(now = Date.now(), limit = 20): OutboxRow[] {
    return this.db.all<OutboxRow>(
      `SELECT * FROM outbox WHERE sent_at IS NULL AND next_attempt_at <= ?
       ORDER BY created_at LIMIT ?`,
      now,
      limit,
    );
  }

  // ----------------------------------------------------------------- turns

  startTurn(input: {
    turnId: string;
    threadId: string;
    runId: string;
    triggerMessageId?: string | null;
  }): void {
    this.db.run(
      `INSERT INTO turns (turn_id, thread_id, run_id, status, started_at, trigger_message_id)
       VALUES (?, ?, ?, 'running', ?, ?)`,
      input.turnId,
      input.threadId,
      input.runId,
      nowIso(),
      input.triggerMessageId ?? null,
    );
  }

  finishTurn(
    turnId: string,
    input: {
      status: string;
      summary?: string | null;
      error?: string | null;
      promptTokens?: number;
      completionTokens?: number;
    },
  ): void {
    this.db.run(
      `UPDATE turns SET status = ?, summary = ?, error = ?, prompt_tokens = ?, completion_tokens = ?, finished_at = ?
       WHERE turn_id = ?`,
      input.status,
      input.summary ?? null,
      input.error ?? null,
      input.promptTokens ?? 0,
      input.completionTokens ?? 0,
      nowIso(),
      turnId,
    );
  }

  listTurns(threadId: string, limit = 20): AgentTurnRow[] {
    return this.db.all<AgentTurnRow>(
      'SELECT * FROM turns WHERE thread_id = ? ORDER BY started_at DESC LIMIT ?',
      threadId,
      limit,
    );
  }

  // ------------------------------------------------------------ audit/notes

  audit(input: {
    turnId: string;
    tool: string;
    argsHash: string;
    status: string;
    durationMs: number;
    effectId?: string | null;
  }): void {
    this.db.run(
      `INSERT INTO tool_audit (id, turn_id, tool, args_hash, status, duration_ms, effect_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      `audit-${randomUUID()}`,
      input.turnId,
      input.tool,
      input.argsHash,
      input.status,
      input.durationMs,
      input.effectId ?? null,
      nowIso(),
    );
  }

  getEffect(scope: string, operationId: string): unknown | undefined {
    const row = this.db.get<{ result_json: string }>(
      'SELECT result_json FROM effects WHERE scope = ? AND operation_id = ?',
      scope,
      operationId,
    );
    return row ? JSON.parse(row.result_json) : undefined;
  }

  putEffect(scope: string, operationId: string, result: unknown): void {
    this.db.run(
      `INSERT OR IGNORE INTO effects (scope, operation_id, result_json, created_at)
       VALUES (?, ?, ?, ?)`,
      scope,
      operationId,
      JSON.stringify(result ?? null),
      nowIso(),
    );
  }

  getNote(key: string): string | undefined {
    return this.db.get<{ value: string }>('SELECT value FROM notes WHERE key = ?', key)?.value;
  }

  setNote(key: string, value: string): void {
    this.db.run(
      `INSERT INTO notes (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      key,
      value,
      nowIso(),
    );
  }

  listNotes(): Array<{ key: string; value: string; updated_at: string }> {
    return this.db.all('SELECT key, value, updated_at FROM notes ORDER BY key');
  }

  getCursor(sessionId: string): number {
    return Number(
      this.db.get<{ last_seq: number }>(
        'SELECT last_seq FROM context_state WHERE session_id = ?',
        sessionId,
      )?.last_seq ?? 0,
    );
  }

  setCursor(sessionId: string, lastSeq: number): void {
    this.db.run(
      `INSERT INTO context_state (session_id, last_seq, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET last_seq = excluded.last_seq, updated_at = excluded.updated_at`,
      sessionId,
      lastSeq,
      nowIso(),
    );
  }
}

export { AGENT_MIGRATIONS };
