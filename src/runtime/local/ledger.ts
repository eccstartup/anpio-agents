/**
 * 本地运行账本：每个 run 一个 JSON 记录 + 一个 JSONL 日志。
 *
 * 与平台 embedded/runs 的语义对齐：running → succeeded / failed / timeout /
 * outcome_unknown，`finish` 只能收尾一次。
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { safeSegment } from '../../sandbox.ts';
import type { RunLedgerPort } from '../transport.ts';
import type { LogLevel, SessionOutcome, SessionResult } from '../types.ts';
import { appendJsonLine, readJson, withFileLock, writeJsonAtomic } from './store.ts';

export type LocalRunRecord = {
  runId: string;
  status: SessionOutcome | 'running';
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  lastHeartbeatAt: string | null;
  summary: string | null;
  error: string | null;
  turns: number;
  promptTokens: number;
  completionTokens: number;
  toolExecuted: boolean;
  mailSessionId: string | null;
  threadId?: string | null;
  input?: string;
};

export type CreateRunInput = {
  threadId?: string | null;
  input?: string;
  sessionId?: string;
};

export class LocalRunLedger implements RunLedgerPort {
  private readonly dir: string;
  private readonly now: () => number;

  constructor(options: { dir: string; now?: () => number }) {
    this.dir = options.dir;
    this.now = options.now ?? Date.now;
  }

  async create(runId: string, input: CreateRunInput = {}): Promise<LocalRunRecord> {
    const now = new Date(this.now()).toISOString();
    const record: LocalRunRecord = {
      runId,
      status: 'running',
      createdAt: now,
      startedAt: now,
      finishedAt: null,
      lastHeartbeatAt: now,
      summary: null,
      error: null,
      turns: 0,
      promptTokens: 0,
      completionTokens: 0,
      toolExecuted: false,
      mailSessionId: input.sessionId ?? null,
      ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
      ...(input.input === undefined ? {} : { input: input.input }),
    };
    await writeJsonAtomic(this.recordPath(runId), record);
    return record;
  }

  async get(runId: string): Promise<LocalRunRecord | null> {
    return await readJson<LocalRunRecord>(this.recordPath(runId));
  }

  async heartbeat(runId: string, input: { sessionId?: string } = {}): Promise<void> {
    await this.mutate(runId, record => {
      record.lastHeartbeatAt = new Date(this.now()).toISOString();
      if (input.sessionId) record.mailSessionId = input.sessionId;
    });
  }

  async log(runId: string, level: LogLevel, text: string): Promise<void> {
    await appendJsonLine(this.logPath(runId), {
      at: new Date(this.now()).toISOString(),
      level,
      text,
    });
  }

  async finish(runId: string, result: SessionResult): Promise<void> {
    await this.mutate(runId, record => {
      record.status = result.status;
      record.finishedAt = new Date(this.now()).toISOString();
      record.summary = result.summary;
      record.error = result.error;
      record.turns = result.turns;
      record.promptTokens = result.promptTokens;
      record.completionTokens = result.completionTokens;
      record.toolExecuted = result.toolExecuted;
      record.mailSessionId = result.mailSessionId;
    });
  }

  async status(runId: string): Promise<{ status: SessionOutcome | 'running' }> {
    const record = await this.get(runId);
    return { status: record?.status ?? 'running' };
  }

  async readLog(runId: string, limit = 200): Promise<Array<Record<string, unknown>>> {
    try {
      const lines = (await readFile(this.logPath(runId), 'utf8')).trim().split('\n').filter(Boolean);
      return lines.slice(-limit).map(line => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return { text: line };
        }
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  private recordPath(runId: string): string {
    return join(this.dir, `${safeSegment(runId)}.json`);
  }

  private logPath(runId: string): string {
    return join(this.dir, `${safeSegment(runId)}.log`);
  }

  private async mutate(runId: string, fn: (record: LocalRunRecord) => void): Promise<void> {
    const file = this.recordPath(runId);
    await withFileLock(`${file}.lock`, async () => {
      const existing = await readJson<LocalRunRecord>(file);
      const now = new Date(this.now()).toISOString();
      const record: LocalRunRecord = existing ?? {
        runId,
        status: 'running',
        createdAt: now,
        startedAt: now,
        finishedAt: null,
        lastHeartbeatAt: now,
        summary: null,
        error: null,
        turns: 0,
        promptTokens: 0,
        completionTokens: 0,
        toolExecuted: false,
        mailSessionId: null,
      };
      fn(record);
      await writeJsonAtomic(file, record);
    });
  }
}
