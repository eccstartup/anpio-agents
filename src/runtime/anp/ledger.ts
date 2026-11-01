/**
 * Turn 账本：把现有 RunLedgerPort 映射到 router/agent 两个数据库。
 *
 * `router.db.turns` 是调度索引，`agent.db.turns` 是 agent 自己的运行记录；
 * 两边用同一个 turnId/runId，方便对照，但互不替代。
 */

import type { AgentStore } from '../../store/agent-store.ts';
import type { RouterStore, TurnRow } from '../../store/router-store.ts';
import type { RunLedgerPort } from '../transport.ts';
import type { LogLevel, SessionOutcome, SessionResult } from '../types.ts';

export type AnpTurnLedgerOptions = {
  router: RouterStore;
  store: AgentStore;
  sessionId: string;
  turnId: string;
  agentId: string;
  threadId: string;
  runId: string;
  /** 诊断日志出口；缺省丢弃。 */
  log?: (level: LogLevel, text: string) => void;
};

export class AnpTurnLedger implements RunLedgerPort {
  private readonly router: RouterStore;
  private readonly store: AgentStore;
  private readonly sessionId: string;
  private readonly turnId: string;
  private readonly agentId: string;
  private readonly threadId: string;
  private readonly runId: string;
  private readonly writeLog: ((level: LogLevel, text: string) => void) | undefined;

  constructor(options: AnpTurnLedgerOptions) {
    this.router = options.router;
    this.store = options.store;
    this.sessionId = options.sessionId;
    this.turnId = options.turnId;
    this.agentId = options.agentId;
    this.threadId = options.threadId;
    this.runId = options.runId;
    this.writeLog = options.log;
  }

  /** 幂等：row 已存在时不重复插入。 */
  start(triggerMessageId?: string | null): void {
    if (!this.router.getTurn(this.turnId)) {
      this.router.createTurn({
        turnId: this.turnId,
        sessionId: this.sessionId,
        agentId: this.agentId,
        threadId: this.threadId,
        runId: this.runId,
        triggerMessageId: triggerMessageId ?? null,
      });
    }
    const agentTurn = this.store.db.get<{ turn_id: string }>(
      'SELECT turn_id FROM turns WHERE turn_id = ?',
      this.turnId,
    );
    if (!agentTurn) {
      this.store.startTurn({
        turnId: this.turnId,
        threadId: this.threadId,
        runId: this.runId,
        triggerMessageId: triggerMessageId ?? null,
      });
    }
  }

  async heartbeat(_runId: string, input: { sessionId?: string } = {}): Promise<void> {
    void input;
    this.router.heartbeatSession(this.sessionId);
  }

  async log(_runId: string, level: LogLevel, text: string): Promise<void> {
    this.writeLog?.(level, text);
  }

  async finish(_runId: string, result: SessionResult): Promise<void> {
    this.router.finishTurn(this.turnId, {
      status: result.status,
      summary: result.summary,
      error: result.error,
    });
    this.store.finishTurn(this.turnId, {
      status: result.status,
      summary: result.summary,
      error: result.error,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
    });
  }

  async status(_runId: string): Promise<{ status: SessionOutcome | 'running' }> {
    return { status: statusOf(this.router.getTurn(this.turnId)) };
  }
}

function statusOf(turn: TurnRow | undefined): SessionOutcome | 'running' {
  const status = turn?.status as SessionOutcome | 'running' | undefined;
  return status ?? 'running';
}
