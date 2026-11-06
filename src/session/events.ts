/**
 * 会话事件日志：模型看见过什么、工具做过什么，都以追加事件为准。
 *
 * 事件永不原地修改；记忆、会话索引都是从这里派生出的投影。写入前统一脱敏。
 */

import { randomUUID } from 'node:crypto';
import type { ChatMessage } from '../brains/types.ts';
import { nowIso, type SqliteDb } from '../store/sqlite.ts';
import { redactValue } from '../memory/text.ts';

export type SessionEventKind =
  | 'session.start'
  | 'turn.start'
  | 'context.assembled'
  | 'model.request'
  | 'model.response'
  | 'tool.call'
  | 'tool.result'
  | 'memory.injected'
  | 'knowledge.injected'
  | 'memory.written'
  | 'knowledge.cited'
  | 'knowledge.candidate_failed'
  | 'context.compacted'
  | 'turn.end'
  | 'session.end'
  | (string & {});

export type SessionEvent = {
  seq: number;
  session_id: string;
  turn_id: string | null;
  run_id: string | null;
  kind: string;
  actor: string;
  payload: Record<string, unknown>;
  ref: string | null;
  at: string;
};

export type AppendEventInput = {
  sessionId: string;
  turnId?: string | null;
  runId?: string | null;
  kind: SessionEventKind;
  actor?: string;
  payload?: Record<string, unknown>;
  ref?: string | null;
};

type SessionEventRow = Omit<SessionEvent, 'payload'> & { payload: string };

export class SessionEventLog {
  private readonly db: SqliteDb;

  constructor(db: SqliteDb) {
    this.db = db;
  }

  append(input: AppendEventInput): SessionEvent {
    const at = nowIso();
    const payload = JSON.stringify(redactValue(input.payload ?? {}));
    const ref = input.ref ?? null;
    const result = this.db.run(
      `INSERT INTO session_events (session_id, turn_id, run_id, kind, actor, payload, ref, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      input.sessionId,
      input.turnId ?? null,
      input.runId ?? null,
      input.kind,
      input.actor ?? 'agent',
      payload,
      ref,
      at,
    );
    return {
      seq: result.lastInsertRowid,
      session_id: input.sessionId,
      turn_id: input.turnId ?? null,
      run_id: input.runId ?? null,
      kind: input.kind,
      actor: input.actor ?? 'agent',
      payload: input.payload ?? {},
      ref,
      at,
    };
  }

  /** 追加事件失败不应该让一轮对话失败；调用方需要尽力而为时用它。 */
  tryAppend(input: AppendEventInput): SessionEvent | null {
    try {
      return this.append(input);
    } catch {
      return null;
    }
  }

  read(
    sessionId: string,
    options: { afterSeq?: number; limit?: number; kinds?: string[] } = {},
  ): SessionEvent[] {
    const conditions = ['session_id = ?', 'seq > ?'];
    const params: Array<string | number> = [sessionId, options.afterSeq ?? 0];
    if (options.kinds && options.kinds.length > 0) {
      conditions.push(`kind IN (${options.kinds.map(() => '?').join(', ')})`);
      params.push(...options.kinds);
    }
    const limit = Math.max(1, Math.min(1000, options.limit ?? 200));
    params.push(limit);
    const rows = this.db.all<SessionEventRow>(
      `SELECT * FROM session_events WHERE ${conditions.join(' AND ')} ORDER BY seq ASC LIMIT ?`,
      ...params,
    );
    return rows.map(parseRow);
  }

  lastSeq(sessionId: string): number {
    return Number(
      this.db.get<{ seq: number | null }>(
        'SELECT MAX(seq) AS seq FROM session_events WHERE session_id = ?',
        sessionId,
      )?.seq ?? 0,
    );
  }

  count(sessionId: string): number {
    return Number(
      this.db.get<{ count: number }>(
        'SELECT COUNT(*) AS count FROM session_events WHERE session_id = ?',
        sessionId,
      )?.count ?? 0,
    );
  }

  /**
   * 结构化重放：最近一次 model.request 的快照就是模型当时看到的完整消息，
   * 之后的 response / tool.result 追加在后面。
   */
  replay(sessionId: string): ChatMessage[] {
    const events = this.read(sessionId, { limit: 1000 });
    let snapshot: ChatMessage[] | null = null;
    let tail: ChatMessage[] = [];
    for (const event of events) {
      if (event.kind === 'model.request') {
        const messages = event.payload.messages;
        if (Array.isArray(messages)) {
          snapshot = messages as ChatMessage[];
          tail = [];
        }
        continue;
      }
      if (snapshot === null) continue;
      if (event.kind === 'model.response') {
        const text = typeof event.payload.text === 'string' ? event.payload.text : '';
        if (text.trim()) tail.push({ role: 'assistant', content: text });
      } else if (event.kind === 'tool.result') {
        const toolCallId = typeof event.payload.toolCallId === 'string' ? event.payload.toolCallId : '';
        const name = typeof event.payload.name === 'string' ? event.payload.name : '';
        const content = typeof event.payload.content === 'string' ? event.payload.content : '';
        if (toolCallId) tail.push({ role: 'tool', toolCallId, name, content });
      }
    }
    return [...(snapshot ?? []), ...tail];
  }

  /** 删除超过保留期的事件；会话索引与记忆不受影响。 */
  prune(days = 365, now = Date.now()): number {
    const cutoff = new Date(now - days * 86_400_000).toISOString();
    return this.db.run('DELETE FROM session_events WHERE at < ?', cutoff).changes;
  }

  /** 给跨会话检索用的摘要事件：只取 turn.end 的 summary。 */
  turnSummaries(sessionId: string, limit = 50): Array<{ turnId: string | null; summary: string; at: string }> {
    return this.read(sessionId, { limit: 500 })
      .filter(event => event.kind === 'turn.end' && typeof event.payload.summary === 'string')
      .map(event => ({
        turnId: event.turn_id,
        summary: String(event.payload.summary),
        at: event.at,
      }))
      .slice(-limit);
  }
}

function parseRow(row: SessionEventRow): SessionEvent {
  let payload: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.payload) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      payload = parsed as Record<string, unknown>;
    }
  } catch {
    payload = { raw: row.payload };
  }
  return { ...row, payload };
}

/** 供测试或手工回放使用：把一次快照事件伪装成模型请求。 */
export function modelRequestPayload(input: {
  system: string;
  messages: ChatMessage[];
  tools: string[];
  promptHash?: string;
}): Record<string, unknown> {
  return {
    system: input.system,
    messages: input.messages,
    tools: input.tools,
    ...(input.promptHash ? { promptHash: input.promptHash } : {}),
    eventId: randomUUID(),
  };
}
