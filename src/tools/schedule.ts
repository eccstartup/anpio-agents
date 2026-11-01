/**
 * 定时任务工具：agent 只能创建/取消/查看自己的 schedule，规则校验在 router 侧。
 *
 * 工具只做参数形状与长度校验，避免把无效表达式写进控制面；真正的
 * `anp.allowSchedules`、数量上限与下次触发时间由 RouterScheduler 决定。
 */

import type { ToolSpec } from '../brains/types.ts';
import type { EmbeddedTool } from '../definition.ts';
import type { ToolExecution } from '../tools.ts';
import type { ScheduleKind, ScheduleState } from '../store/router-store.ts';

export type ScheduleToolInput = {
  kind: ScheduleKind;
  expr: string;
  text: string;
  type?: string;
  title?: string;
  data?: unknown;
  threadId?: string;
  catchUp?: 'skip' | 'once' | 'all';
  maxRuns?: number;
};

export type ScheduleSummary = {
  id: string;
  kind: ScheduleKind;
  expr: string;
  state: ScheduleState;
  nextRunAt: string | null;
  runs: number;
  maxRuns: number | null;
  catchUp: 'skip' | 'once' | 'all';
  threadId: string | null;
};

export type ScheduleToolContext = {
  create: (input: ScheduleToolInput) => ScheduleSummary;
  cancel: (id: string) => { cancelled: boolean };
  list: () => ScheduleSummary[];
  defaultThreadId: string;
};

type Schema = Record<string, unknown>;

function schema(properties: Schema, required: string[] = Object.keys(properties)): Schema {
  return { type: 'object', properties, required, additionalProperties: false };
}

function textOf(input: Record<string, unknown>, key: string, max = 2_000): string {
  const value = input[key];
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`缺少参数 ${key}`);
  if (value.length > max) throw new Error(`参数 ${key} 过长（上限 ${max}）`);
  return value.trim();
}

function optionalText(input: Record<string, unknown>, key: string, max = 2_000): string | undefined {
  const value = input[key];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error(`参数 ${key} 必须是字符串`);
  if (value.length > max) throw new Error(`参数 ${key} 过长（上限 ${max}）`);
  return value.trim() === '' ? undefined : value;
}

function render(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 6_000 ? `${text.slice(0, 6_000)}\n…（已截断）` : text;
}

export const SCHEDULE_TOOL_SPECS = {
  schedule_create: {
    name: 'schedule_create',
    description:
      '创建一个属于自己的定时任务。触发时向 thread 投递一条 ANP 消息。'
      + 'kind=at 用 ISO 时间；interval 用 60s / 5m / 2h / 1d；cron 用 5 段表达式。',
    parameters: schema({
      kind: { type: 'string', enum: ['at', 'interval', 'cron'] },
      expr: { type: 'string', description: 'at=ISO 时间；interval=时长；cron=分 时 日 月 周' },
      text: { type: 'string', description: '触发时投递的消息正文' },
      type: { type: 'string', description: '可选：消息类型，默认 anp.schedule.fire' },
      title: { type: 'string' },
      data: { type: 'object', description: '可选：结构化附注' },
      threadId: { type: 'string', description: '可选：目标 thread，默认当前 thread' },
      catchUp: {
        type: 'string',
        enum: ['skip', 'once', 'all'],
        description: '可选：重启后如何处理错过的触发，默认 skip',
      },
      maxRuns: { type: 'integer', description: '可选：最多触发次数' },
    }, ['kind', 'expr', 'text']),
  },
  schedule_cancel: {
    name: 'schedule_cancel',
    description: '取消自己的一个定时任务。',
    parameters: schema({ id: { type: 'string' } }),
  },
  list_schedules: {
    name: 'list_schedules',
    description: '列出自己的定时任务：状态、下次触发时间与已触发次数。',
    parameters: schema({}, []),
  },
} satisfies Partial<Record<EmbeddedTool, ToolSpec>>;

export async function executeScheduleTool(
  name: string,
  input: Record<string, unknown>,
  context: ScheduleToolContext,
): Promise<ToolExecution | null> {
  switch (name) {
    case 'schedule_create': {
      const kindRaw = textOf(input, 'kind', 20);
      if (kindRaw !== 'at' && kindRaw !== 'interval' && kindRaw !== 'cron') {
        throw new Error('kind 只能是 at / interval / cron');
      }
      const catchUpRaw = optionalText(input, 'catchUp', 20);
      if (catchUpRaw !== undefined && !['skip', 'once', 'all'].includes(catchUpRaw)) {
        throw new Error('catchUp 只能是 skip / once / all');
      }
      let maxRuns: number | undefined;
      if (input.maxRuns !== undefined) {
        maxRuns = Number(input.maxRuns);
        if (!Number.isInteger(maxRuns) || maxRuns <= 0) throw new Error('maxRuns 必须是正整数');
      }
      const summary = context.create({
        kind: kindRaw,
        expr: textOf(input, 'expr', 200),
        text: textOf(input, 'text', 20_000),
        ...(optionalText(input, 'type', 120) ? { type: optionalText(input, 'type', 120)! } : {}),
        ...(optionalText(input, 'title', 200) ? { title: optionalText(input, 'title', 200)! } : {}),
        ...('data' in input ? { data: input.data } : {}),
        threadId: optionalText(input, 'threadId', 200) ?? context.defaultThreadId,
        ...(catchUpRaw ? { catchUp: catchUpRaw as 'skip' | 'once' | 'all' } : {}),
        ...(maxRuns !== undefined ? { maxRuns } : {}),
      });
      return { content: render({ created: true, ...summary }) };
    }

    case 'schedule_cancel': {
      const id = textOf(input, 'id', 200);
      const result = context.cancel(id);
      return { content: render(result) };
    }

    case 'list_schedules':
      return { content: render(context.list()) };

    default:
      return null;
  }
}
