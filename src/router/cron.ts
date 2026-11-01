/**
 * 5 段 cron 解析（分 时 日 月 周），本地时区，支持通配符、范围、步长、列表与
 * 月份/星期英文缩写。只用于把 schedule 推进到下一次触发，不执行任何东西。
 */

export class CronError extends Error {
  override name = 'CronError';
}

type CronField = { values: Set<number>; wildcard: boolean };

export type ParsedCron = {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
};

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function numberValue(token: string, min: number, max: number, names?: string[]): number {
  const named = names ? names.indexOf(token.toLowerCase()) : -1;
  if (named >= 0) return names === MONTHS ? named + 1 : named;
  if (!/^\d+$/.test(token)) throw new CronError(`无法识别的取值：${token}`);
  const value = Number(token);
  if (value < min || value > max) throw new CronError(`取值超出范围 ${min}-${max}：${value}`);
  return value;
}

function parseField(
  raw: string,
  min: number,
  max: number,
  names?: string[],
  options: { dayOfWeek?: boolean } = {},
): CronField {
  const field = raw.trim();
  if (field === '') throw new CronError('存在空字段');
  const wildcard = field.startsWith('*');
  const values = new Set<number>();
  for (const item of field.split(',')) {
    const slash = item.indexOf('/');
    const base = slash >= 0 ? item.slice(0, slash) : item;
    const step = slash >= 0 ? item.slice(slash + 1) : '1';
    if (!/^\d+$/.test(step) || Number(step) <= 0) throw new CronError(`步长必须是正整数：${item}`);
    const stepValue = Number(step);
    let start: number;
    let end: number;
    if (base === '*') {
      start = min;
      end = max;
    } else if (base.includes('-')) {
      const [left, right, ...rest] = base.split('-');
      if (rest.length > 0 || !left || !right) throw new CronError(`无法识别的范围：${base}`);
      start = numberValue(left, min, max, names);
      end = numberValue(right, min, max, names);
      if (start > end) throw new CronError(`范围起点大于终点：${base}`);
    } else {
      start = numberValue(base, min, max, names);
      end = slash >= 0 ? max : start;
    }
    for (let value = start; value <= end; value += stepValue) {
      values.add(options.dayOfWeek && value === 7 ? 0 : value);
    }
  }
  if (values.size === 0) throw new CronError(`字段没有取值：${field}`);
  return { values, wildcard };
}

export function parseCron(expr: string): ParsedCron {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new CronError('cron 必须是 5 段：分 时 日 月 周');
  return {
    minute: parseField(fields[0]!, 0, 59),
    hour: parseField(fields[1]!, 0, 23),
    dayOfMonth: parseField(fields[2]!, 1, 31),
    month: parseField(fields[3]!, 1, 12, MONTHS),
    dayOfWeek: parseField(fields[4]!, 0, 6, DAYS, { dayOfWeek: true }),
  };
}

function dayMatches(parsed: ParsedCron, date: Date): boolean {
  const dom = parsed.dayOfMonth;
  const dow = parsed.dayOfWeek;
  const domMatch = dom.values.has(date.getDate());
  const dowMatch = dow.values.has(date.getDay());
  if (dom.wildcard && dow.wildcard) return true;
  if (dom.wildcard) return dowMatch;
  if (dow.wildcard) return domMatch;
  return domMatch || dowMatch;
}

function sorted(field: CronField): number[] {
  return [...field.values].sort((left, right) => left - right);
}

/** 严格晚于 `after` 的下一次触发；5 年内没有则返回 null。 */
export function nextCronAfter(expr: string, after: Date): Date | null {
  const parsed = parseCron(expr);
  const hours = sorted(parsed.hour);
  const minutes = sorted(parsed.minute);
  const day = new Date(after.getFullYear(), after.getMonth(), after.getDate());
  const limit = new Date(after.getTime());
  limit.setFullYear(limit.getFullYear() + 5);

  while (day <= limit) {
    if (parsed.month.values.has(day.getMonth() + 1) && dayMatches(parsed, day)) {
      for (const hour of hours) {
        for (const minute of minutes) {
          const candidate = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute, 0, 0);
          if (candidate > after) return candidate;
        }
      }
    }
    day.setDate(day.getDate() + 1);
  }
  return null;
}
