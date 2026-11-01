/**
 * 控制面数据库：注册表、thread、session 索引、turn 索引、调度与子 agent 关系。
 *
 * 只存索引，不存消息正文；消息正文与历史在各自 agent 的 agent.db。
 */

import { SqliteDb, migrate, nowIso } from './sqlite.ts';

export type AgentRow = {
  agent_id: string;
  name: string;
  definition_json: string;
  did: string;
  enabled: number;
  created_at: string;
  updated_at: string;
};

export type ThreadRow = {
  thread_id: string;
  owner_agent_id: string | null;
  title: string | null;
  state: string;
  created_at: string;
  updated_at: string;
};

export type SessionState = 'created' | 'idle' | 'running' | 'archived';

export type SessionRow = {
  session_id: string;
  agent_id: string;
  thread_id: string;
  state: SessionState;
  active_turn_id: string | null;
  heartbeat_at: string | null;
  next_seq: number;
  created_at: string;
  updated_at: string;
};

export type TurnRow = {
  turn_id: string;
  session_id: string;
  agent_id: string;
  thread_id: string;
  run_id: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  summary: string | null;
  error: string | null;
  trigger_message_id: string | null;
};

export type ScheduleKind = 'at' | 'interval' | 'cron';
export type ScheduleState = 'active' | 'firing' | 'paused' | 'done';

export type ScheduleRow = {
  id: string;
  owner_agent_id: string;
  kind: ScheduleKind;
  expr: string;
  payload_json: string;
  target_thread: string | null;
  state: ScheduleState;
  next_run_at: string | null;
  runs: number;
  max_runs: number | null;
  catch_up: 'skip' | 'once' | 'all';
  created_at: string;
};

export type AgentLinkRow = {
  parent_id: string;
  child_id: string;
  depth: number;
  created_at: string;
  ttl_at: string | null;
  state: string;
};

const ROUTER_MIGRATIONS = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS agents (
        agent_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        definition_json TEXT NOT NULL,
        did TEXT NOT NULL UNIQUE,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS threads (
        thread_id TEXT PRIMARY KEY,
        owner_agent_id TEXT,
        title TEXT,
        state TEXT NOT NULL DEFAULT 'open',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS thread_members (
        thread_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        role TEXT NOT NULL,
        joined_at TEXT NOT NULL,
        PRIMARY KEY (thread_id, agent_id)
      )`,
      `CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'created',
        active_turn_id TEXT,
        heartbeat_at TEXT,
        next_seq INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (agent_id, thread_id)
      )`,
      `CREATE TABLE IF NOT EXISTS turns (
        turn_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        summary TEXT,
        error TEXT,
        trigger_message_id TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY,
        owner_agent_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        expr TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        target_thread TEXT,
        state TEXT NOT NULL DEFAULT 'active',
        next_run_at TEXT,
        runs INTEGER NOT NULL DEFAULT 0,
        max_runs INTEGER,
        catch_up TEXT NOT NULL DEFAULT 'skip',
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS schedule_fires (
        schedule_id TEXT NOT NULL,
        scheduled_at TEXT NOT NULL,
        fired_at TEXT NOT NULL,
        PRIMARY KEY (schedule_id, scheduled_at)
      )`,
      `CREATE TABLE IF NOT EXISTS agent_links (
        parent_id TEXT NOT NULL,
        child_id TEXT NOT NULL,
        depth INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        ttl_at TEXT,
        state TEXT NOT NULL DEFAULT 'active',
        PRIMARY KEY (child_id)
      )`,
      'CREATE INDEX IF NOT EXISTS sessions_agent_thread ON sessions (agent_id, thread_id)',
      'CREATE INDEX IF NOT EXISTS sessions_state ON sessions (state, heartbeat_at)',
      'CREATE INDEX IF NOT EXISTS turns_agent_thread ON turns (agent_id, thread_id, started_at)',
      'CREATE INDEX IF NOT EXISTS schedules_due ON schedules (state, next_run_at)',
      'CREATE INDEX IF NOT EXISTS agent_links_parent ON agent_links (parent_id, state)',
    ],
  },
];

export type AgentRegistration = {
  agentId: string;
  name: string;
  definition: unknown;
  did: string;
  enabled?: boolean;
};

export type DueSchedule = {
  schedule: ScheduleRow;
  scheduledAt: string;
};

export class RouterStore {
  readonly db: SqliteDb;

  constructor(path: string) {
    this.db = new SqliteDb(path);
    migrate(this.db, ROUTER_MIGRATIONS);
  }

  close(): void {
    this.db.close();
  }

  // ---------------------------------------------------------------- agents

  upsertAgent(input: AgentRegistration): AgentRow {
    const now = nowIso();
    this.db.run(
      `INSERT INTO agents (agent_id, name, definition_json, did, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET
         name = excluded.name,
         definition_json = excluded.definition_json,
         did = excluded.did,
         enabled = excluded.enabled,
         updated_at = excluded.updated_at`,
      input.agentId,
      input.name,
      JSON.stringify(input.definition),
      input.did,
      input.enabled === false ? 0 : 1,
      now,
      now,
    );
    return this.getAgent(input.agentId)!;
  }

  getAgent(agentId: string): AgentRow | undefined {
    return this.db.get<AgentRow>('SELECT * FROM agents WHERE agent_id = ?', agentId);
  }

  getAgentByDid(did: string): AgentRow | undefined {
    return this.db.get<AgentRow>('SELECT * FROM agents WHERE did = ?', did);
  }

  listAgents(enabledOnly = false): AgentRow[] {
    return enabledOnly
      ? this.db.all<AgentRow>('SELECT * FROM agents WHERE enabled = 1 ORDER BY agent_id')
      : this.db.all<AgentRow>('SELECT * FROM agents ORDER BY agent_id');
  }

  setAgentEnabled(agentId: string, enabled: boolean): void {
    this.db.run(
      'UPDATE agents SET enabled = ?, updated_at = ? WHERE agent_id = ?',
      enabled ? 1 : 0,
      nowIso(),
      agentId,
    );
  }

  // --------------------------------------------------------------- threads

  ensureThread(input: {
    threadId: string;
    ownerAgentId?: string | null;
    title?: string | null;
    state?: string;
  }): ThreadRow {
    const now = nowIso();
    this.db.run(
      `INSERT INTO threads (thread_id, owner_agent_id, title, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET
         owner_agent_id = COALESCE(threads.owner_agent_id, excluded.owner_agent_id),
         title = COALESCE(threads.title, excluded.title),
         updated_at = excluded.updated_at`,
      input.threadId,
      input.ownerAgentId ?? null,
      input.title ?? null,
      input.state ?? 'open',
      now,
      now,
    );
    return this.getThread(input.threadId)!;
  }

  getThread(threadId: string): ThreadRow | undefined {
    return this.db.get<ThreadRow>('SELECT * FROM threads WHERE thread_id = ?', threadId);
  }

  listThreads(agentId?: string, limit = 50): ThreadRow[] {
    if (!agentId) {
      return this.db.all<ThreadRow>('SELECT * FROM threads ORDER BY updated_at DESC LIMIT ?', limit);
    }
    return this.db.all<ThreadRow>(
      `SELECT t.* FROM threads t
       JOIN thread_members m ON m.thread_id = t.thread_id
       WHERE m.agent_id = ?
       ORDER BY t.updated_at DESC LIMIT ?`,
      agentId,
      limit,
    );
  }

  setThreadState(threadId: string, state: string): void {
    this.db.run('UPDATE threads SET state = ?, updated_at = ? WHERE thread_id = ?', state, nowIso(), threadId);
  }

  addMember(threadId: string, agentId: string, role = 'member'): void {
    this.db.run(
      `INSERT INTO thread_members (thread_id, agent_id, role, joined_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(thread_id, agent_id) DO NOTHING`,
      threadId,
      agentId,
      role,
      nowIso(),
    );
  }

  ensureMembers(threadId: string, agentIds: string[]): void {
    this.db.tx(() => {
      for (const agentId of agentIds) this.addMember(threadId, agentId);
    });
  }

  isMember(threadId: string, agentId: string): boolean {
    return Boolean(
      this.db.get<{ one: number }>(
        'SELECT 1 AS one FROM thread_members WHERE thread_id = ? AND agent_id = ?',
        threadId,
        agentId,
      ),
    );
  }

  listMembers(threadId: string): Array<{ agent_id: string; role: string; joined_at: string }> {
    return this.db.all('SELECT agent_id, role, joined_at FROM thread_members WHERE thread_id = ? ORDER BY joined_at', threadId);
  }

  // -------------------------------------------------------------- sessions

  ensureSession(input: {
    sessionId: string;
    agentId: string;
    threadId: string;
    state?: SessionState;
  }): SessionRow {
    const now = nowIso();
    this.db.run(
      `INSERT INTO sessions (session_id, agent_id, thread_id, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(agent_id, thread_id) DO UPDATE SET updated_at = excluded.updated_at`,
      input.sessionId,
      input.agentId,
      input.threadId,
      input.state ?? 'created',
      now,
      now,
    );
    return this.getSessionByThread(input.agentId, input.threadId)!;
  }

  getSession(sessionId: string): SessionRow | undefined {
    return this.db.get<SessionRow>('SELECT * FROM sessions WHERE session_id = ?', sessionId);
  }

  getSessionByThread(agentId: string, threadId: string): SessionRow | undefined {
    return this.db.get<SessionRow>(
      'SELECT * FROM sessions WHERE agent_id = ? AND thread_id = ?',
      agentId,
      threadId,
    );
  }

  listSessions(agentId?: string): SessionRow[] {
    return agentId
      ? this.db.all<SessionRow>('SELECT * FROM sessions WHERE agent_id = ? ORDER BY updated_at DESC', agentId)
      : this.db.all<SessionRow>('SELECT * FROM sessions ORDER BY updated_at DESC');
  }

  /** 抢一个 session：只有 created/idle 能被改成 running。 */
  claimSession(sessionId: string, turnId: string): boolean {
    const now = nowIso();
    const result = this.db.run(
      `UPDATE sessions
       SET state = 'running', active_turn_id = ?, heartbeat_at = ?, updated_at = ?
       WHERE session_id = ? AND state IN ('created', 'idle')`,
      turnId,
      now,
      now,
      sessionId,
    );
    return result.changes === 1;
  }

  heartbeatSession(sessionId: string): void {
    const now = nowIso();
    this.db.run(
      "UPDATE sessions SET heartbeat_at = ?, updated_at = ? WHERE session_id = ? AND state = 'running'",
      now,
      now,
      sessionId,
    );
  }

  releaseSession(sessionId: string, state: 'idle' | 'archived' = 'idle'): void {
    this.db.run(
      `UPDATE sessions SET state = ?, active_turn_id = NULL, updated_at = ?
       WHERE session_id = ? AND state = 'running'`,
      state,
      nowIso(),
      sessionId,
    );
  }

  archiveSession(sessionId: string): void {
    this.db.run(
      "UPDATE sessions SET state = 'archived', active_turn_id = NULL, updated_at = ? WHERE session_id = ?",
      nowIso(),
      sessionId,
    );
  }

  /** 启动恢复：心跳超过 staleMs 的 running session 回到 idle。 */
  recoverStaleSessions(staleMs = 90_000): SessionRow[] {
    const cutoff = new Date(Date.now() - staleMs).toISOString();
    return this.db.tx(() => {
      const rows = this.db.all<SessionRow>(
        "SELECT * FROM sessions WHERE state = 'running' AND (heartbeat_at IS NULL OR heartbeat_at < ?)",
        cutoff,
      );
      for (const row of rows) {
        this.db.run(
          `UPDATE sessions SET state = 'idle', active_turn_id = NULL, updated_at = ? WHERE session_id = ?`,
          nowIso(),
          row.session_id,
        );
      }
      return rows;
    });
  }

  // ----------------------------------------------------------------- turns

  createTurn(input: {
    turnId: string;
    sessionId: string;
    agentId: string;
    threadId: string;
    runId: string;
    triggerMessageId?: string | null;
  }): TurnRow {
    const now = nowIso();
    this.db.run(
      `INSERT INTO turns (turn_id, session_id, agent_id, thread_id, run_id, status, started_at, trigger_message_id)
       VALUES (?, ?, ?, ?, ?, 'running', ?, ?)`,
      input.turnId,
      input.sessionId,
      input.agentId,
      input.threadId,
      input.runId,
      now,
      input.triggerMessageId ?? null,
    );
    return this.getTurn(input.turnId)!;
  }

  getTurn(turnId: string): TurnRow | undefined {
    return this.db.get<TurnRow>('SELECT * FROM turns WHERE turn_id = ?', turnId);
  }

  finishTurn(
    turnId: string,
    input: { status: string; summary?: string | null; error?: string | null },
  ): void {
    this.db.run(
      `UPDATE turns SET status = ?, summary = ?, error = ?, finished_at = ?
       WHERE turn_id = ?`,
      input.status,
      input.summary ?? null,
      input.error ?? null,
      nowIso(),
      turnId,
    );
  }

  listTurns(agentId: string, threadId?: string, limit = 20): TurnRow[] {
    return threadId
      ? this.db.all<TurnRow>(
          'SELECT * FROM turns WHERE agent_id = ? AND thread_id = ? ORDER BY started_at DESC LIMIT ?',
          agentId,
          threadId,
          limit,
        )
      : this.db.all<TurnRow>(
          'SELECT * FROM turns WHERE agent_id = ? ORDER BY started_at DESC LIMIT ?',
          agentId,
          limit,
        );
  }

  // ------------------------------------------------------------- schedules

  createSchedule(input: {
    id: string;
    ownerAgentId: string;
    kind: ScheduleKind;
    expr: string;
    payload: unknown;
    targetThread?: string | null;
    nextRunAt: string | null;
    maxRuns?: number | null;
    catchUp?: 'skip' | 'once' | 'all';
  }): ScheduleRow {
    this.db.run(
      `INSERT INTO schedules (id, owner_agent_id, kind, expr, payload_json, target_thread,
        state, next_run_at, runs, max_runs, catch_up, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      input.id,
      input.ownerAgentId,
      input.kind,
      input.expr,
      JSON.stringify(input.payload ?? {}),
      input.targetThread ?? null,
      input.nextRunAt ? 'active' : 'done',
      input.nextRunAt,
      input.maxRuns ?? null,
      input.catchUp ?? 'skip',
      nowIso(),
    );
    return this.getSchedule(input.id)!;
  }

  getSchedule(id: string): ScheduleRow | undefined {
    return this.db.get<ScheduleRow>('SELECT * FROM schedules WHERE id = ?', id);
  }

  listSchedules(ownerAgentId: string): ScheduleRow[] {
    return this.db.all<ScheduleRow>(
      'SELECT * FROM schedules WHERE owner_agent_id = ? ORDER BY created_at DESC',
      ownerAgentId,
    );
  }

  listAllSchedules(): ScheduleRow[] {
    return this.db.all<ScheduleRow>('SELECT * FROM schedules ORDER BY created_at');
  }

  cancelSchedule(id: string, ownerAgentId: string): boolean {
    const result = this.db.run(
      "UPDATE schedules SET state = 'done' WHERE id = ? AND owner_agent_id = ? AND state IN ('active', 'firing')",
      id,
      ownerAgentId,
    );
    return result.changes === 1;
  }

  /** catch_up=skip：重启时把错过的触发直接推到下一次，不补投。 */
  skipScheduleTo(id: string, nextRunAt: string | null): void {
    this.db.run(
      'UPDATE schedules SET state = ?, next_run_at = ? WHERE id = ?',
      nextRunAt ? 'active' : 'done',
      nextRunAt,
      id,
    );
  }

  /**
   * 取到期 schedule 并推进下一次时间。`nextFor` 返回 null 表示这条 schedule 结束。
   * 整个过程在一个 IMMEDIATE 事务里，且 schedule_fires 的唯一键保证重复 tick 只触发一次。
   */
  claimDue(
    now: string,
    limit: number,
    nextFor: (row: ScheduleRow) => string | null,
    ownerIds?: string[],
  ): DueSchedule[] {
    return this.db.tx(() => {
      const filter = ownerIds === undefined
        ? ''
        : ownerIds.length === 0
          ? ' AND 0'
          : ` AND owner_agent_id IN (${ownerIds.map(() => '?').join(',')})`;
      const rows = this.db.all<ScheduleRow>(
        `SELECT * FROM schedules
         WHERE state = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ?${filter}
         ORDER BY next_run_at LIMIT ?`,
        now,
        ...(ownerIds ?? []),
        limit,
      );
      const claimed: DueSchedule[] = [];
      for (const row of rows) {
        const scheduledAt = row.next_run_at!;
        const fire = this.db.run(
          `INSERT OR IGNORE INTO schedule_fires (schedule_id, scheduled_at, fired_at)
           VALUES (?, ?, ?)`,
          row.id,
          scheduledAt,
          now,
        );
        if (fire.changes === 0) continue;
        const runs = row.runs + 1;
        const maxed = row.max_runs !== null && runs >= row.max_runs;
        const nextRunAt = maxed ? null : nextFor(row);
        this.db.run(
          `UPDATE schedules SET state = ?, next_run_at = ?, runs = ? WHERE id = ? AND next_run_at = ?`,
          nextRunAt ? 'active' : 'done',
          nextRunAt,
          runs,
          row.id,
          scheduledAt,
        );
        claimed.push({ schedule: { ...row, runs }, scheduledAt });
      }
      return claimed;
    });
  }

  // ------------------------------------------------------------ agent links

  createLink(input: {
    parentId: string;
    childId: string;
    depth: number;
    ttlAt?: string | null;
  }): void {
    this.db.run(
      `INSERT INTO agent_links (parent_id, child_id, depth, created_at, ttl_at, state)
       VALUES (?, ?, ?, ?, ?, 'active')`,
      input.parentId,
      input.childId,
      input.depth,
      nowIso(),
      input.ttlAt ?? null,
    );
  }

  getLink(childId: string): AgentLinkRow | undefined {
    return this.db.get<AgentLinkRow>('SELECT * FROM agent_links WHERE child_id = ?', childId);
  }

  listChildren(parentId: string): AgentLinkRow[] {
    return this.db.all<AgentLinkRow>(
      "SELECT * FROM agent_links WHERE parent_id = ? AND state = 'active' ORDER BY created_at",
      parentId,
    );
  }

  countChildren(parentId: string): number {
    return Number(
      this.db.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM agent_links WHERE parent_id = ? AND state = 'active'",
        parentId,
      )?.count ?? 0,
    );
  }

  expireLinks(now = nowIso()): AgentLinkRow[] {
    return this.db.tx(() => {
      const rows = this.db.all<AgentLinkRow>(
        "SELECT * FROM agent_links WHERE state = 'active' AND ttl_at IS NOT NULL AND ttl_at <= ?",
        now,
      );
      for (const row of rows) {
        this.db.run(
          "UPDATE agent_links SET state = 'expired' WHERE child_id = ?",
          row.child_id,
        );
      }
      return rows;
    });
  }
}

export { ROUTER_MIGRATIONS };
