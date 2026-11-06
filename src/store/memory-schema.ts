/**
 * 会话日志、记忆、经验缓存与上下文清单的表结构。
 *
 * 这些表同时被 AgentStore（迁移）和 MemoryStore（独立打开）创建；两边都只用
 * `CREATE TABLE IF NOT EXISTS`，不碰 `PRAGMA user_version`，所以谁先打开同一份
 * agent.db 都不会把对方的迁移版本顶掉。
 */

import { nowIso, type SqliteDb } from './sqlite.ts';

export const MEMORY_SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS session_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    turn_id TEXT,
    run_id TEXT,
    kind TEXT NOT NULL,
    actor TEXT NOT NULL,
    payload TEXT NOT NULL,
    ref TEXT,
    at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS session_events_session ON session_events (session_id, seq)',
  'CREATE INDEX IF NOT EXISTS session_events_kind ON session_events (kind, at)',
  `CREATE TABLE IF NOT EXISTS session_index (
    session_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    title TEXT,
    started_at TEXT NOT NULL,
    last_at TEXT NOT NULL,
    turn_count INTEGER NOT NULL DEFAULT 0,
    last_summary TEXT,
    archived_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS projection_state (
    name TEXT PRIMARY KEY,
    last_seq INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    key TEXT NOT NULL,
    kind TEXT NOT NULL,
    content TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]',
    maturity TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0.4,
    scope TEXT NOT NULL DEFAULT 'agent',
    conditions TEXT,
    source_session_id TEXT,
    source_turn_id TEXT,
    source_event_seq INTEGER,
    source_knowledge_id TEXT,
    source_knowledge_version INTEGER,
    superseded_by TEXT,
    archived_at TEXT,
    expires_at TEXT,
    pinned INTEGER NOT NULL DEFAULT 0,
    use_count INTEGER NOT NULL DEFAULT 0,
    success_count INTEGER NOT NULL DEFAULT 0,
    last_used_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'active',
    contradiction_count INTEGER NOT NULL DEFAULT 0,
    UNIQUE (agent_id, key)
  )`,
  'CREATE INDEX IF NOT EXISTS memories_agent ON memories (agent_id, archived_at, maturity)',
  'CREATE INDEX IF NOT EXISTS memories_key ON memories (agent_id, key)',
  `CREATE TABLE IF NOT EXISTS memory_revisions (
    id TEXT PRIMARY KEY,
    memory_id TEXT NOT NULL,
    content TEXT NOT NULL,
    maturity TEXT NOT NULL,
    reason TEXT,
    actor TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS memory_revisions_memory ON memory_revisions (memory_id, created_at)',
  `CREATE TABLE IF NOT EXISTS memory_citations (
    id TEXT PRIMARY KEY,
    memory_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    outcome TEXT NOT NULL,
    at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS memory_citations_memory ON memory_citations (memory_id, at)',
  `CREATE TABLE IF NOT EXISTS knowledge_cache (
    knowledge_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    content TEXT NOT NULL,
    conditions TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL,
    evidence TEXT NOT NULL,
    source_task_id TEXT,
    reviewer_id TEXT,
    expires_at TEXT,
    access_mode TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]',
    state TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    checked_at TEXT NOT NULL,
    PRIMARY KEY (knowledge_id, version)
  )`,
  `CREATE TABLE IF NOT EXISTS knowledge_refs (
    knowledge_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    task_id TEXT,
    session_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    used_at TEXT NOT NULL,
    PRIMARY KEY (knowledge_id, version, session_id, turn_id)
  )`,
  `CREATE TABLE IF NOT EXISTS context_manifests (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    prompt_hash TEXT NOT NULL,
    sections TEXT NOT NULL,
    injected TEXT NOT NULL,
    at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS context_manifests_session ON context_manifests (session_id, at)',
];

/** 幂等建表；可以在任何连接上重复调用。 */
export function ensureMemorySchema(db: SqliteDb): void {
  for (const statement of MEMORY_SCHEMA_STATEMENTS) db.exec(statement);
}

/**
 * 把旧的 notes 投影成 observed 记忆。
 *
 * notes 继续保留（只读一个版本）；导入本身用 NOT EXISTS 保证重复执行不会多写。
 */
export function importNotes(db: SqliteDb, agentId: string): number {
  const at = nowIso();
  const rows = db.all<{ key: string; value: string; updated_at: string }>(
    'SELECT key, value, updated_at FROM notes',
  );
  let imported = 0;
  for (const row of rows) {
    const key = normalizeImportedKey(row.key);
    if (!key || row.value.length > 8000) continue;
    const result = db.run(
      `INSERT INTO memories
        (id, agent_id, key, kind, content, tags, maturity, confidence, scope,
         source_session_id, source_turn_id, source_event_seq, created_at, updated_at, state)
       SELECT ?, ?, ?, 'fact', ?, '[]', 'observed', 0.4, 'agent',
              'notes', NULL, NULL, ?, ?, 'active'
       WHERE NOT EXISTS (
         SELECT 1 FROM memories WHERE agent_id = ? AND key = ?
       )`,
      `mem_import_${agentId}_${key}`.slice(0, 120),
      agentId,
      key,
      row.value,
      row.updated_at,
      row.updated_at,
      agentId,
      key,
    );
    imported += result.changes;
  }
  return imported;
}

/**
 * notes 的 key 是自由文本，记忆 key 有字符集限制；转不动的条目跳过，
 * 由 `npm run memory -- list` 之外的人工手段处理。
 */
export function normalizeImportedKey(raw: string): string | null {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 64);
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(normalized) ? normalized : null;
}
