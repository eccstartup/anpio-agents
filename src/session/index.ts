/**
 * 会话目录：跨会话连续性只靠这里和记忆，不把别的会话事件塞进当前上下文。
 */

import { nowIso, type SqliteDb } from '../store/sqlite.ts';
import { lexicalScore, truncateChars } from '../memory/text.ts';

export type SessionIndexRow = {
  session_id: string;
  kind: string;
  title: string | null;
  started_at: string;
  last_at: string;
  turn_count: number;
  last_summary: string | null;
  archived_at: string | null;
};

export type SessionSearchHit = {
  sessionId: string;
  kind: string;
  title: string | null;
  startedAt: string;
  lastAt: string;
  summary: string | null;
  score: number;
  matches: Array<{ turnId: string | null; summary: string; at: string }>;
};

export class SessionIndex {
  private readonly db: SqliteDb;

  constructor(db: SqliteDb) {
    this.db = db;
  }

  ensure(input: {
    sessionId: string;
    kind: string;
    title?: string | null;
    at?: string;
  }): SessionIndexRow {
    const at = input.at ?? nowIso();
    const title = input.title === undefined ? null : truncateChars(input.title ?? '', 120);
    this.db.run(
      `INSERT INTO session_index (session_id, kind, title, started_at, last_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         kind = excluded.kind,
         title = COALESCE(session_index.title, excluded.title),
         last_at = excluded.last_at`,
      input.sessionId,
      input.kind,
      title,
      at,
      at,
    );
    return this.get(input.sessionId)!;
  }

  recordTurn(input: {
    sessionId: string;
    turnId: string;
    status: string;
    summary?: string | null;
    at?: string;
  }): void {
    const at = input.at ?? nowIso();
    const summary = input.summary ? truncateChars(input.summary, 500) : null;
    this.db.run(
      `UPDATE session_index
          SET last_at = ?,
              turn_count = turn_count + 1,
              last_summary = COALESCE(?, last_summary)
        WHERE session_id = ?`,
      at,
      summary,
      input.sessionId,
    );
  }

  archive(sessionId: string, at = nowIso()): void {
    this.db.run(
      'UPDATE session_index SET archived_at = ? WHERE session_id = ?',
      at,
      sessionId,
    );
  }

  get(sessionId: string): SessionIndexRow | undefined {
    return this.db.get<SessionIndexRow>(
      'SELECT * FROM session_index WHERE session_id = ?',
      sessionId,
    );
  }

  list(input: { limit?: number; includeArchived?: boolean; kind?: string } = {}): SessionIndexRow[] {
    const conditions: string[] = [];
    const params: Array<string | number> = [];
    if (!input.includeArchived) conditions.push('archived_at IS NULL');
    if (input.kind) {
      conditions.push('kind = ?');
      params.push(input.kind);
    }
    const limit = Math.max(1, Math.min(500, input.limit ?? 50));
    params.push(limit);
    return this.db.all<SessionIndexRow>(
      `SELECT * FROM session_index
       ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
       ORDER BY last_at DESC LIMIT ?`,
      ...params,
    );
  }

  /**
   * 跨会话搜索只返回摘要与命中片段；要看具体事件必须显式 session_peek。
   * turn 摘要在事件表里，避免索引表存第二份可变内容。
   */
  search(query: string, input: { limit?: number; includeArchived?: boolean } = {}): SessionSearchHit[] {
    const limit = Math.max(1, Math.min(50, input.limit ?? 10));
    const sessions = this.list({ limit: 500, includeArchived: input.includeArchived ?? false });
    const hits: SessionSearchHit[] = [];

    for (const session of sessions) {
      const summaries = this.turnSummaries(session.session_id);
      const titleScore = lexicalScore(query, `${session.title ?? ''} ${session.kind}`);
      const lastScore = lexicalScore(query, session.last_summary ?? '');
      const scored = summaries
        .map(item => ({ ...item, score: lexicalScore(query, item.summary) }))
        .filter(item => item.score >= 0.1)
        .sort((left, right) => right.score - left.score);
      const bestTurn = scored[0]?.score ?? 0;
      const matches = scored
        .slice(0, 3)
        .map(item => ({ turnId: item.turnId, summary: item.summary, at: item.at }));
      const score = Math.max(titleScore, lastScore, bestTurn);
      if (score < 0.15) continue;
      hits.push({
        sessionId: session.session_id,
        kind: session.kind,
        title: session.title,
        startedAt: session.started_at,
        lastAt: session.last_at,
        summary: session.last_summary,
        score: Math.round(score * 1000) / 1000,
        matches,
      });
    }

    return hits
      .sort((left, right) => right.score - left.score || right.lastAt.localeCompare(left.lastAt))
      .slice(0, limit);
  }

  private turnSummaries(
    sessionId: string,
    limit = 200,
  ): Array<{ turnId: string | null; summary: string; at: string }> {
    return this.db
      .all<{ turn_id: string | null; payload: string; at: string }>(
        `SELECT turn_id, payload, at FROM session_events
          WHERE session_id = ? AND kind = 'turn.end'
          ORDER BY seq DESC LIMIT ?`,
        sessionId,
        limit,
      )
      .map(row => {
        let summary = '';
        try {
          const parsed = JSON.parse(row.payload) as { summary?: unknown };
          summary = typeof parsed.summary === 'string' ? parsed.summary : '';
        } catch {
          summary = '';
        }
        return { turnId: row.turn_id, summary, at: row.at };
      })
      .filter(item => item.summary.trim() !== '');
  }
}

/** 会话标题只取第一条用户消息的开头，不把整段输入塞进索引。 */
export function sessionTitle(text: string, max = 60): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  return truncateChars(compact, max);
}
