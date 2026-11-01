/**
 * 定时调度：只负责把到期的 schedule 变成 thread 里的一条 ANP 消息。
 *
 * 先在同一事务里推进 `next_run_at` 并写 `schedule_fires` 唯一键，再投递；
 * 因此重复 tick、重启崩溃都不会重复触发同一次到点。catch_up 决定重启后
 * 错过的触发是跳过、补一次还是逐个补齐。
 */

import { randomUUID } from 'node:crypto';
import type { AnpPayload } from '../anp/client.ts';
import type { ScheduleSummary, ScheduleToolInput } from '../tools/schedule.ts';
import type { RouterStore, ScheduleKind, ScheduleRow } from '../store/router-store.ts';
import { CronError, nextCronAfter, parseCron } from './cron.ts';

export const DEFAULT_MAX_SCHEDULES = 20;
export const MIN_INTERVAL_MS = 60_000;
const MAX_CATCH_UP_STEPS = 10_000;

export class SchedulerError extends Error {
  override name = 'SchedulerError';
}

export type SchedulerHost = {
  enabled: boolean;
  anpConfig: { allowSchedules: boolean; maxSchedules: number | null };
};

export type SchedulerOptions = {
  store: RouterStore;
  hosts: () => Map<string, SchedulerHost>;
  send: (
    ownerAgentId: string,
    input: { threadId: string; payload: AnpPayload },
  ) => Promise<{ messageId: string }>;
  log?: (line: string) => void;
  tickIntervalMs?: number;
  now?: () => Date;
};

export function parseInterval(expr: string): number {
  const match = /^(\d+)\s*(s|m|h|d)$/i.exec(expr.trim());
  const value = match ? Number(match[1]) : Number.NaN;
  if (!match) {
    if (/^\d+$/.test(expr.trim())) return Number(expr.trim()) * 1_000;
    throw new SchedulerError('interval 格式应为 60s / 5m / 2h / 1d');
  }
  const unit = match[2]!.toLowerCase();
  const factor = unit === 's' ? 1_000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return value * factor;
}

export function scheduleSummary(row: ScheduleRow): ScheduleSummary {
  return {
    id: row.id,
    kind: row.kind,
    expr: row.expr,
    state: row.state,
    nextRunAt: row.next_run_at,
    runs: row.runs,
    maxRuns: row.max_runs,
    catchUp: row.catch_up,
    threadId: row.target_thread,
  };
}

function parsePayload(row: ScheduleRow): AnpPayload {
  let raw: Record<string, unknown> = {};
  try {
    const value = JSON.parse(row.payload_json) as unknown;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      raw = value as Record<string, unknown>;
    } else {
      raw = { text: String(value) };
    }
  } catch {
    raw = { text: row.payload_json };
  }
  return {
    type: typeof raw.type === 'string' ? raw.type : 'anp.schedule.fire',
    ...(typeof raw.task_id === 'string' ? { task_id: raw.task_id } : {}),
    ...(typeof raw.title === 'string' ? { title: raw.title } : {}),
    ...(typeof raw.text === 'string' ? { text: raw.text } : {}),
    ...('data' in raw ? { data: raw.data } : {}),
  };
}

/** 从某个已触发时间出发的下一次；`all` 保留过去的时间点，逐个补。 */
function nextOccurrence(kind: ScheduleKind, expr: string, from: Date): Date | null {
  if (kind === 'at') return null;
  if (kind === 'interval') {
    return new Date(from.getTime() + parseInterval(expr));
  }
  try {
    return nextCronAfter(expr, from);
  } catch (error) {
    throw error instanceof CronError ? new SchedulerError(error.message) : error;
  }
}

function advancePast(from: Date | null, kind: ScheduleKind, expr: string, now: Date): Date | null {
  let next: Date | null = from;
  for (let step = 0; step < MAX_CATCH_UP_STEPS; step += 1) {
    if (!next) return null;
    if (next > now) return next;
    next = nextOccurrence(kind, expr, next);
  }
  return next;
}

export class RouterScheduler {
  private readonly options: SchedulerOptions;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private readonly now: () => Date;
  private readonly log: (line: string) => void;

  constructor(options: SchedulerOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => undefined);
  }

  start(): void {
    const interval = this.options.tickIntervalMs ?? 1_000;
    try {
      this.skipMissed(this.now());
    } catch (error) {
      this.log(`调度补投检查失败：${error instanceof Error ? error.message : String(error)}`);
    }
    if (interval <= 0) return;
    this.timer = setInterval(() => {
      void this.tick().catch(error => {
        this.log(`调度 tick 失败：${error instanceof Error ? error.message : String(error)}`);
      });
    }, interval);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** catch_up=skip：把重启时已经错过的触发直接推进到未来。 */
  skipMissed(now = this.now()): void {
    const at = now.toISOString();
    for (const row of this.options.store.listAllSchedules()) {
      if (row.state !== 'active' || row.next_run_at === null) continue;
      if (row.catch_up !== 'skip') continue;
      if (row.next_run_at > at) continue;
      try {
        const next = advancePast(new Date(row.next_run_at), row.kind, row.expr, now);
        this.options.store.skipScheduleTo(row.id, next ? next.toISOString() : null);
        if (next) {
          this.log(`[schedule ${row.id}] 跳过错过的触发，下次 ${next.toISOString()}`);
        }
      } catch (error) {
        this.log(`[schedule ${row.id}] 无法推进：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  async tick(now = this.now()): Promise<ScheduleRow[]> {
    if (this.ticking) return [];
    this.ticking = true;
    try {
      const hosts = this.options.hosts();
      const ownerIds = [...hosts.entries()]
        .filter(([, host]) => host.enabled && host.anpConfig.allowSchedules)
        .map(([agentId]) => agentId);
      const claimed = this.options.store.claimDue(
        now.toISOString(),
        50,
        row => this.nextFor(row, now),
        ownerIds,
      );
      const fired: ScheduleRow[] = [];
      for (const item of claimed) {
        const owner = item.schedule.owner_agent_id;
        const host = hosts.get(owner);
        if (!host || !host.enabled) continue;
        const threadId = item.schedule.target_thread ?? `schedule-${item.schedule.id}`;
        try {
          await this.options.send(owner, {
            threadId,
            payload: parsePayload(item.schedule),
          });
          fired.push(item.schedule);
          this.log(`[schedule ${item.schedule.id}] 已投递到 ${threadId}（${item.scheduledAt}）`);
        } catch (error) {
          this.log(
            `[schedule ${item.schedule.id}] 投递失败：${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return fired;
    } finally {
      this.ticking = false;
    }
  }

  create(ownerAgentId: string, input: ScheduleToolInput): ScheduleSummary {
    const host = this.options.hosts().get(ownerAgentId);
    if (!host || !host.enabled) throw new SchedulerError(`agent ${ownerAgentId} 未启动`);
    if (!host.anpConfig.allowSchedules) {
      throw new SchedulerError(`agent ${ownerAgentId} 未开启 anp.allowSchedules`);
    }
    const maxSchedules = host.anpConfig.maxSchedules ?? DEFAULT_MAX_SCHEDULES;
    const active = this.options.store.listSchedules(ownerAgentId)
      .filter(row => row.state === 'active' || row.state === 'firing');
    if (active.length >= maxSchedules) {
      throw new SchedulerError(`agent ${ownerAgentId} 的定时任务已达到上限 ${maxSchedules}`);
    }

    const now = this.now();
    const nextRunAt = nextRunFor(input, now);
    const id = `sch-${randomUUID()}`;
    const payload = {
      type: input.type ?? 'anp.schedule.fire',
      text: input.text,
      ...(input.title ? { title: input.title } : {}),
      ...(input.data !== undefined ? { data: input.data } : {}),
    };
    const row = this.options.store.createSchedule({
      id,
      ownerAgentId,
      kind: input.kind,
      expr: input.expr,
      payload,
      targetThread: input.threadId ?? null,
      nextRunAt,
      maxRuns: input.maxRuns ?? null,
      catchUp: input.catchUp ?? 'skip',
    });
    return scheduleSummary(row);
  }

  cancel(ownerAgentId: string, id: string): { cancelled: boolean } {
    return { cancelled: this.options.store.cancelSchedule(id, ownerAgentId) };
  }

  list(ownerAgentId: string): ScheduleSummary[] {
    return this.options.store.listSchedules(ownerAgentId).map(scheduleSummary);
  }

  private nextFor(row: ScheduleRow, now: Date): string | null {
    const from = new Date(row.next_run_at ?? now.toISOString());
    const next = row.catch_up === 'all'
      ? nextOccurrence(row.kind, row.expr, from)
      : advancePast(
          nextOccurrence(row.kind, row.expr, from),
          row.kind,
          row.expr,
          now,
        );
    return next ? next.toISOString() : null;
  }
}

function nextRunFor(input: ScheduleToolInput, now: Date): string {
  if (input.kind === 'at') {
    const at = Date.parse(input.expr);
    if (!Number.isFinite(at)) throw new SchedulerError('at 的 expr 必须是 ISO 时间');
    if (at <= now.getTime()) throw new SchedulerError('at 必须晚于当前时间');
    return new Date(at).toISOString();
  }
  if (input.kind === 'interval') {
    const interval = parseInterval(input.expr);
    if (interval < MIN_INTERVAL_MS) {
      throw new SchedulerError(`interval 不能小于 ${MIN_INTERVAL_MS / 1_000} 秒`);
    }
    return new Date(now.getTime() + interval).toISOString();
  }
  try {
    parseCron(input.expr);
    const next = nextCronAfter(input.expr, now);
    if (!next) throw new SchedulerError('cron 在 5 年内没有下一次触发');
    return next.toISOString();
  } catch (error) {
    if (error instanceof SchedulerError) throw error;
    throw new SchedulerError(error instanceof Error ? error.message : String(error));
  }
}
