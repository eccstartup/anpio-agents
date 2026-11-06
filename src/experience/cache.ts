/**
 * 团队经验的本地缓存：只存已发布、未过期、当前可见的版本。
 *
 * 平台不可用时用缓存降级，但必须带缓存时间；被撤销/过期的版本立刻停止注入。
 */

import { nowIso, type SqliteDb } from '../store/sqlite.ts';
import { lexicalScore, redact, truncateChars } from '../memory/text.ts';

export type KnowledgeCacheRow = {
  knowledge_id: string;
  version: number;
  title: string;
  summary: string;
  content: string;
  conditions: string;
  kind: string;
  evidence: string;
  source_task_id: string | null;
  reviewer_id: string | null;
  expires_at: string | null;
  access_mode: string;
  tags: string;
  state: string;
  fetched_at: string;
  checked_at: string;
};

export type CachedKnowledge = Omit<KnowledgeCacheRow, 'tags'> & { tags: string[] };

export type KnowledgeCacheOptions = {
  ttlMs?: number;
  now?: () => number;
  maxEntries?: number;
  maxBytes?: number;
};

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 200;
const MAX_BYTES = 2 * 1024 * 1024;

export class KnowledgeCache {
  private readonly db: SqliteDb;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly maxEntries: number;
  private readonly maxBytes: number;

  constructor(db: SqliteDb, options: KnowledgeCacheOptions = {}) {
    this.db = db;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
    this.maxEntries = options.maxEntries ?? MAX_ENTRIES;
    this.maxBytes = options.maxBytes ?? MAX_BYTES;
  }

  /** 只有 published 且未过期的版本能进缓存。 */
  put(input: {
    id: string;
    version: number;
    title?: string;
    summary?: string;
    content: string;
    conditions?: string | null;
    kind?: string;
    evidence?: string;
    sourceTaskId?: string | null;
    reviewerId?: string | null;
    expiresAt?: string | null;
    accessMode?: string;
    tags?: string[];
    state?: string;
  }): CachedKnowledge | null {
    const state = input.state ?? 'published';
    if (state !== 'published') {
      this.markState(input.id, state);
      return null;
    }
    if (input.expiresAt && Date.parse(input.expiresAt) <= this.now()) {
      this.purgeExpired();
      return null;
    }
    const at = nowIso(this.now);
    this.db.run(
      `INSERT INTO knowledge_cache
        (knowledge_id, version, title, summary, content, conditions, kind, evidence,
         source_task_id, reviewer_id, expires_at, access_mode, tags, state, fetched_at, checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', ?, ?)
       ON CONFLICT(knowledge_id, version) DO UPDATE SET
         title = excluded.title, summary = excluded.summary, content = excluded.content,
         conditions = excluded.conditions, kind = excluded.kind, evidence = excluded.evidence,
         source_task_id = excluded.source_task_id, reviewer_id = excluded.reviewer_id,
         expires_at = excluded.expires_at, access_mode = excluded.access_mode,
         tags = excluded.tags, state = 'published', checked_at = excluded.checked_at`,
      input.id,
      input.version,
      redact(truncateChars(input.title ?? input.summary ?? input.content, 200)),
      redact(truncateChars(input.summary ?? input.content, 500)),
      redact(input.content),
      redact(input.conditions ?? ''),
      input.kind ?? 'experience',
      input.evidence ?? 'published',
      input.sourceTaskId ?? null,
      input.reviewerId ?? null,
      input.expiresAt ?? null,
      input.accessMode ?? 'restricted',
      JSON.stringify(input.tags ?? []),
      at,
      at,
    );
    this.trim();
    return this.get(input.id, input.version);
  }

  get(id: string, version?: number): CachedKnowledge | null {
    const row = this.db.get<KnowledgeCacheRow>(
      version === undefined
        ? `SELECT * FROM knowledge_cache WHERE knowledge_id = ?
           ORDER BY version DESC LIMIT 1`
        : 'SELECT * FROM knowledge_cache WHERE knowledge_id = ? AND version = ?',
      id,
      ...(version === undefined ? [] : [version]),
    );
    if (!row) return null;
    if (row.state !== 'published') return null;
    if (row.expires_at && Date.parse(row.expires_at) <= this.now()) return null;
    return toCached(row);
  }

  markState(id: string, state: string): void {
    this.db.run(
      'UPDATE knowledge_cache SET state = ?, checked_at = ? WHERE knowledge_id = ?',
      state,
      nowIso(this.now),
      id,
    );
  }

  isStale(row: CachedKnowledge): boolean {
    return this.now() - Date.parse(row.checked_at) > this.ttlMs;
  }

  searchLocal(query: string, limit = 8): CachedKnowledge[] {
    this.purgeExpired();
    const rows = this.db.all<KnowledgeCacheRow>(
      `SELECT * FROM knowledge_cache WHERE state = 'published'
        ORDER BY checked_at DESC LIMIT 500`,
    );
    return rows
      .map(toCached)
      .map(row => ({
        row,
        score: lexicalScore(query, `${row.title} ${row.summary} ${row.content} ${row.tags.join(' ')}`),
      }))
      .filter(item => item.score >= 0.15)
      .sort((left, right) => right.score - left.score || right.row.checked_at.localeCompare(left.row.checked_at))
      .slice(0, Math.max(1, Math.min(20, limit)))
      .map(item => item.row);
  }

  recordRef(input: {
    knowledgeId: string;
    version: number;
    taskId?: string | null;
    sessionId: string;
    turnId: string;
  }): void {
    this.db.run(
      `INSERT OR IGNORE INTO knowledge_refs
        (knowledge_id, version, task_id, session_id, turn_id, used_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      input.knowledgeId,
      input.version,
      input.taskId ?? null,
      input.sessionId,
      input.turnId,
      nowIso(this.now),
    );
  }

  stats(): { entries: number; bytes: number; oldestCheckedAt: string | null } {
    const row = this.db.get<{ entries: number; bytes: number | null; oldest: string | null }>(
      `SELECT COUNT(*) AS entries, SUM(LENGTH(content)) AS bytes,
              MIN(checked_at) AS oldest
         FROM knowledge_cache WHERE state = 'published'`,
    );
    return {
      entries: Number(row?.entries ?? 0),
      bytes: Number(row?.bytes ?? 0),
      oldestCheckedAt: row?.oldest ?? null,
    };
  }

  purgeExpired(): number {
    return this.db.run(
      `DELETE FROM knowledge_cache
        WHERE state <> 'published'
           OR (expires_at IS NOT NULL AND expires_at <= ?)`,
      nowIso(this.now),
    ).changes;
  }

  /** 200 条 / 2 MiB 上限；先淘汰最久没校验的已发布条目。 */
  private trim(): void {
    this.purgeExpired();
    const count = Number(
      this.db.get<{ count: number }>('SELECT COUNT(*) AS count FROM knowledge_cache')?.count ?? 0,
    );
    if (count > this.maxEntries) {
      this.db.run(
        `DELETE FROM knowledge_cache WHERE rowid IN (
           SELECT rowid FROM knowledge_cache ORDER BY checked_at ASC LIMIT ?
         )`,
        count - this.maxEntries,
      );
    }
    const bytes = Number(
      this.db.get<{ bytes: number | null }>(
        'SELECT SUM(LENGTH(content) + LENGTH(summary)) AS bytes FROM knowledge_cache',
      )?.bytes ?? 0,
    );
    if (bytes > this.maxBytes) {
      const rows = this.db.all<{ rowid: number; size: number }>(
        `SELECT rowid, LENGTH(content) + LENGTH(summary) AS size
           FROM knowledge_cache ORDER BY checked_at ASC`,
      );
      let current = bytes;
      const remove: number[] = [];
      for (const row of rows) {
        if (current <= this.maxBytes) break;
        remove.push(row.rowid);
        current -= row.size;
      }
      for (const rowid of remove) {
        this.db.run('DELETE FROM knowledge_cache WHERE rowid = ?', rowid);
      }
    }
  }
}

function toCached(row: KnowledgeCacheRow): CachedKnowledge {
  let tags: string[] = [];
  try {
    const parsed = JSON.parse(row.tags) as unknown;
    if (Array.isArray(parsed)) tags = parsed.filter((tag): tag is string => typeof tag === 'string');
  } catch {
    tags = [];
  }
  return { ...row, tags };
}
