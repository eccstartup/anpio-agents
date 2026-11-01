#!/usr/bin/env node
/**
 * `npm run anp:send -- --from planner --to worker --thread t1 --text "…"`
 *
 * 调 router 的管理接口，走与外部调用方相同的投递路径；不直接写数据库。
 */

import { pathToFileURL } from 'node:url';

export type SendCliOptions = {
  adminUrl: string;
  token: string | null;
  from: string;
  to: string | null;
  threadId: string | null;
  skills: string[];
  text: string | null;
  title: string | null;
  type: string | null;
  replyTo: string | null;
};

type Parsed = { options: SendCliOptions; help: boolean };

const USAGE = `用法：npm run anp:send -- --from <agent> [--to <agent|did>] [--thread <id>] --text <正文>

可选：
  --type <类型>       默认 anp.task.request
  --title <标题>
  --skills a,b        按能力路由（没有 --to 时）
  --reply-to <id>
  --admin-url <url>   默认 http://127.0.0.1:8788
  --token <token>     等价于 ANP_ADMIN_TOKEN
  --help`;

class CliError extends Error {
  override name = 'CliError';
}

function valueOf(argv: string[], index: number, name: string): string {
  const next = argv[index + 1];
  if (next === undefined || next.startsWith('--')) throw new CliError(`${name} 缺少值`);
  return next;
}

export function parseSendArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): Parsed {
  const options: SendCliOptions = {
    adminUrl: env.ANP_ADMIN_URL ?? 'http://127.0.0.1:8788',
    token: env.ANP_ADMIN_TOKEN ?? null,
    from: '',
    to: null,
    threadId: null,
    skills: [],
    text: null,
    title: null,
    type: null,
    replyTo: null,
  };
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    switch (arg) {
      case '--from':
        options.from = valueOf(argv, index, arg);
        index += 1;
        break;
      case '--to':
        options.to = valueOf(argv, index, arg);
        index += 1;
        break;
      case '--thread':
      case '--thread-id':
      case '--threadId':
        options.threadId = valueOf(argv, index, arg);
        index += 1;
        break;
      case '--skills':
        options.skills = valueOf(argv, index, arg).split(',').map(item => item.trim()).filter(Boolean);
        index += 1;
        break;
      case '--text':
        options.text = valueOf(argv, index, arg);
        index += 1;
        break;
      case '--title':
        options.title = valueOf(argv, index, arg);
        index += 1;
        break;
      case '--type':
        options.type = valueOf(argv, index, arg);
        index += 1;
        break;
      case '--reply-to':
        options.replyTo = valueOf(argv, index, arg);
        index += 1;
        break;
      case '--admin-url':
        options.adminUrl = valueOf(argv, index, arg).replace(/\/+$/, '');
        index += 1;
        break;
      case '--token':
        options.token = valueOf(argv, index, arg);
        index += 1;
        break;
      case '--help':
      case '-h':
        help = true;
        break;
      default:
        throw new CliError(`未知参数：${arg}\n\n${USAGE}`);
    }
  }
  if (help) return { options, help };
  if (options.from.trim() === '') throw new CliError(`--from 必填\n\n${USAGE}`);
  if (!options.to && options.skills.length === 0) {
    throw new CliError(`--to 与 --skills 至少给一个\n\n${USAGE}`);
  }
  if (!options.text && !options.title) throw new CliError(`--text 至少给一项\n\n${USAGE}`);
  return { options, help };
}

export async function sendViaAdmin(
  options: SendCliOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {
    from: options.from,
    ...(options.to ? { to: options.to } : {}),
    ...(options.threadId ? { threadId: options.threadId } : {}),
    ...(options.skills.length > 0 ? { skills: options.skills } : {}),
    ...(options.replyTo ? { replyTo: options.replyTo } : {}),
    payload: {
      type: options.type ?? 'anp.task.request',
      ...(options.text ? { text: options.text } : {}),
      ...(options.title ? { title: options.title } : {}),
    },
  };
  const response = await fetchImpl(`${options.adminUrl}/admin/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const detail = parsed && typeof parsed === 'object' && 'message' in parsed
      ? String((parsed as { message: unknown }).message)
      : text.slice(0, 500);
    throw new CliError(`发送失败 HTTP ${response.status}：${detail || '无响应体'}`);
  }
  if (!parsed || typeof parsed !== 'object') throw new CliError('管理接口没有返回 JSON 对象');
  return parsed as Record<string, unknown>;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { options, help } = parseSendArgs(argv);
  if (help) {
    console.log(USAGE);
    return;
  }
  const result = await sendViaAdmin(options);
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`anp:send 失败：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
