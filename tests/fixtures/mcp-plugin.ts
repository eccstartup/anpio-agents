/**
 * 测试用的最小 stdio MCP server。
 *
 * 故意不用官方 SDK：这里要模拟 SDK 不会产生的行为——stdout 污染、不支持的
 * 协议版本、调用中途退出、忽略取消。分帧与真实 server 一致：一行一条 JSON-RPC。
 * 行为由 MCP_FIXTURE_* 环境变量切换，见 tests/plugins.test.ts 顶部。
 */

import { appendFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

type Json = Record<string, unknown>;

const env = process.env;
const mode = env.MCP_FIXTURE_MODE ?? 'normal';
const pageSize = Number(env.MCP_FIXTURE_PAGE_SIZE ?? 0);
const delayMs = Number(env.MCP_FIXTURE_DELAY_MS ?? 0);
const concurrencyFile = env.MCP_FIXTURE_CONCURRENCY_FILE;
const WRITE_TOOLS = new Set(['write_effect']);

const toolNames = (env.MCP_FIXTURE_TOOLS ?? 'echo,write_effect')
  .split(',')
  .map((name) => name.trim())
  .filter((name) => name !== '');

function send(message: Json): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id: unknown, result: unknown): void {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id: unknown, code: number, message: string): void {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function record(file: string | undefined, line: string): void {
  if (file !== undefined) appendFileSync(file, `${line}\n`);
}

if (env.MCP_FIXTURE_PID_FILE !== undefined) {
  writeFileSync(env.MCP_FIXTURE_PID_FILE, String(process.pid));
}
for (let index = 0; index < Number(env.MCP_FIXTURE_STDERR_LINES ?? 0); index += 1) {
  process.stderr.write(`fixture stderr line ${index + 1}\n`);
}
if (mode === 'exit-on-start') process.exit(1);

function toolList(): Json[] {
  return toolNames.map((name) => ({
    name,
    description: `${name} fixture tool`,
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        target: { type: 'string' },
        steps: { type: 'number' },
      },
    },
    ...(WRITE_TOOLS.has(name) ? {} : { annotations: { readOnlyHint: true } }),
  }));
}

function toolsPage(id: unknown, cursor: string | undefined): void {
  const all = toolList();
  const size = Number.isFinite(pageSize) && pageSize > 0 ? Math.floor(pageSize) : all.length;
  const start = cursor === undefined ? 0 : Number(cursor);
  const offset = Number.isInteger(start) && start >= 0 ? start : 0;
  const slice = all.slice(offset, offset + size);
  const next = offset + slice.length;
  reply(id, next < all.length ? { tools: slice, nextCursor: String(next) } : { tools: slice });
}

async function callTool(id: unknown, params: Json): Promise<void> {
  if (mode === 'exit-on-call') process.exit(1);

  const name = typeof params.name === 'string' ? params.name : '';
  const args = isRecord(params.arguments) ? params.arguments : {};
  const meta = isRecord(params._meta) ? params._meta : {};
  if (mode === 'pollute-stdout') {
    process.stdout.write('插件把日志写到了 stdout，这一行不是 JSON-RPC\n');
    return;
  }
  if (name === 'hang' || mode === 'hang') return;

  record(concurrencyFile, `start ${name} ${Date.now()}`);
  try {
    if (delayMs > 0) await sleep(delayMs);

    if (env.MCP_FIXTURE_IS_ERROR !== undefined || name === 'is_error') {
      reply(id, { content: [{ type: 'text', text: 'boom' }], isError: true });
      return;
    }
    if (env.MCP_FIXTURE_RPC_ERROR !== undefined || name === 'rpc_error') {
      replyError(id, -32000, 'boom');
      return;
    }
  } finally {
    record(concurrencyFile, `end ${name} ${Date.now()}`);
  }

  switch (name) {
    case 'echo':
      reply(id, { content: [{ type: 'text', text: String(args.text ?? '') }] });
      return;
    case 'echo_meta':
      reply(id, { content: [{ type: 'text', text: JSON.stringify(meta) }] });
      return;
    case 'write_effect':
      reply(id, { content: [{ type: 'text', text: `wrote ${String(args.target ?? '')}` }] });
      return;
    case 'progress': {
      const steps = Number(args.steps ?? env.MCP_FIXTURE_PROGRESS_STEPS ?? 3);
      for (let step = 1; step <= steps; step += 1) {
        send({
          jsonrpc: '2.0',
          method: 'notifications/progress',
          params: {
            progressToken: meta.progressToken,
            progress: step,
            total: steps,
            message: `${step}/${steps}`,
          },
        });
      }
      // 给客户端一点处理通知的时间：真实插件在长调用里也不会把进度和结果挤在同一拍。
      await sleep(20);
      reply(id, { content: [{ type: 'text', text: `进度完成：${steps}` }] });
      return;
    }
    default:
      replyError(id, -32602, `unknown tool ${name}`);
  }
}

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function dispatch(message: Json): void | Promise<void> {
  const id = message.id;
  const params = isRecord(message.params) ? message.params : {};

  if (message.method === 'initialize') {
    const requested = params.protocolVersion;
    const version =
      mode === 'bad-version'
        ? '1999-01-01'
        : typeof requested === 'string'
          ? requested
          : '2025-06-18';
    reply(id, {
      protocolVersion: version,
      capabilities: { tools: {} },
      serverInfo: { name: 'fixture', version: '0.0.1' },
    });
    return;
  }
  if (message.method === 'notifications/initialized') return;
  if (message.method === 'notifications/cancelled') {
    if (env.MCP_FIXTURE_IGNORE_CANCEL === undefined) process.exit(0);
    return;
  }
  if (message.method === 'ping') {
    reply(id, {});
    return;
  }
  if (message.method === 'tools/list') {
    toolsPage(id, typeof params.cursor === 'string' ? params.cursor : undefined);
    return;
  }
  if (message.method === 'tools/call') return callTool(id, params);
  if (id !== undefined) replyError(id, -32601, `method not found: ${String(message.method)}`);
}

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const text = line.trim();
  if (text === '') return;
  let message: unknown;
  try {
    message = JSON.parse(text);
  } catch {
    process.stderr.write('fixture: 收到不是 JSON 的一行\n');
    return;
  }
  if (isRecord(message)) void dispatch(message);
});

// stdin EOF 与真实 server 一样退出；引擎关闭连接后不应该留下进程。
lines.on('close', () => process.exit(0));
