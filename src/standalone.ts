/**
 * 独立运行入口：不经过 supervisor，也不连 anpio-collab。
 *
 * 定义从文件加载，密钥仍只从环境变量读取；结果 JSON 写 stdout，日志写 stderr。
 * 退出码与 supervisor 路径一致：0 成功、2 结果未知、其他失败。
 */

import { join } from 'node:path';
import { loadDefinition, StandaloneConfigError } from './standalone/config.ts';
import {
  ConversationStore,
  DEFAULT_HISTORY_BYTES,
  DEFAULT_HISTORY_MESSAGES,
} from './standalone/conversation.ts';
import { createStandaloneRuntime, StandaloneAgent } from './standalone/runner.ts';
import { startStandaloneServer } from './standalone/server.ts';
import type { CompletionPolicy } from './definition.ts';
import { COMPLETION_POLICIES } from './definition.ts';
import type { SessionOutcome } from './runtime/types.ts';

type CliOptions = {
  agent?: string;
  message?: string;
  thread?: string;
  root?: string;
  completion?: CompletionPolicy;
  maxMessages?: number;
  allowMissingTools: boolean;
  keepRun: boolean;
  serve: boolean;
  host?: string;
  port?: number;
  help: boolean;
};

const HELP = `用法：npm run standalone -- --agent <定义文件> [选项]

选项：
  --message <文本>        要处理的输入；省略时从 stdin 读取
  --thread <id>           会话标识；同一 id 自动带上前几轮历史
  --root <目录>           运行根（默认 $AGENT_RUN_ROOT 或 ./agent-runs）
  --completion <策略>     finish（默认）或 text：纯文本回答是否算完成
  --max-messages <n>      一轮最多处理几条消息（默认 5）
  --allow-missing-tools   定义里的平台工具缺失时降级继续，而不是启动报错
  --keep-run              保留本次 Session 目录，便于排查
  --serve                 启动本地 HTTP 服务，而不是跑一次就退出
  --host <地址>           服务监听地址（默认 127.0.0.1；非回环地址必须设令牌）
  --port <端口>           服务端口（默认 8788，0 表示随机）
  -h, --help              显示本帮助

stdin 也可以传 JSON：{"text":"...","threadId":"可选"}。
服务模式下：
  POST /runs              {"text":"...","threadId":"可选"} -> 202 {"runId":"..."}
  GET  /runs/:id          状态、摘要、错误与 token 统计
  GET  /health            {ok, active, queued}
  AGENT_HTTP_TOKEN        设置后所有接口要求 Authorization: Bearer <token>
  AGENT_HISTORY_MAX_MESSAGES / AGENT_HISTORY_MAX_BYTES  会话历史保留上限
`;

function configError(message: string): never {
  throw new StandaloneConfigError(message);
}

function positiveInt(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) configError(`${name} 必须是正整数`);
  return parsed;
}

function nonNegativeInt(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) configError(`${name} 必须是非负整数`);
  return parsed;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return nonNegativeInt(raw.trim(), name);
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    allowMissingTools: false,
    keepRun: false,
    serve: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index]!;
    if (raw === '-h') {
      options.help = true;
      continue;
    }
    if (!raw.startsWith('--')) configError(`无法识别的参数：${raw}`);

    const equals = raw.indexOf('=');
    const name = equals === -1 ? raw : raw.slice(0, equals);
    const inline = equals === -1 ? undefined : raw.slice(equals + 1);
    const takeValue = (): string => {
      if (inline !== undefined) {
        if (inline === '') configError(`${name} 需要一个值`);
        return inline;
      }
      const next = argv[index + 1];
      if (next === undefined) configError(`${name} 需要一个值`);
      index += 1;
      return next;
    };
    const takeFlag = (): true => {
      if (inline !== undefined) configError(`${name} 不接受值`);
      return true;
    };

    switch (name) {
      case '--agent':
        options.agent = takeValue();
        break;
      case '--message':
        options.message = takeValue();
        break;
      case '--thread':
        options.thread = takeValue();
        break;
      case '--root':
        options.root = takeValue();
        break;
      case '--max-messages':
        options.maxMessages = positiveInt(takeValue(), '--max-messages');
        break;
      case '--completion': {
        const value = takeValue();
        if (!(COMPLETION_POLICIES as readonly string[]).includes(value)) {
          configError(`--completion 只能是 ${COMPLETION_POLICIES.join(' / ')}`);
        }
        options.completion = value as CompletionPolicy;
        break;
      }
      case '--allow-missing-tools':
        options.allowMissingTools = takeFlag();
        break;
      case '--keep-run':
        options.keepRun = takeFlag();
        break;
      case '--serve':
        options.serve = takeFlag();
        break;
      case '--host':
        options.host = takeValue();
        break;
      case '--port':
        options.port = nonNegativeInt(takeValue(), '--port');
        break;
      case '--help':
        takeFlag();
        options.help = true;
        break;
      default:
        configError(`无法识别的参数：${name}`);
    }
  }

  return options;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) configError('请用 --message 或通过 stdin 提供输入');
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseInput(raw: string): { text: string; threadId?: string } {
  const trimmed = raw.trim();
  if (!trimmed) configError('输入为空');
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        typeof (parsed as { text?: unknown }).text === 'string'
      ) {
        const value = parsed as { text: string; threadId?: unknown };
        return {
          text: value.text,
          ...(typeof value.threadId === 'string' ? { threadId: value.threadId } : {}),
        };
      }
    } catch {
      // 不是 JSON 就按普通文本处理。
    }
  }
  return { text: trimmed };
}

function exitCode(status: SessionOutcome): number {
  return status === 'succeeded' ? 0 : status === 'outcome_unknown' ? 2 : 1;
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (!options.agent) configError('缺少 --agent <定义文件>');
  if (options.serve && (options.message !== undefined || options.thread !== undefined)) {
    configError('--serve 模式不接受 --message / --thread；请通过 POST /runs 提交');
  }

  if (options.keepRun) process.env.AGENT_KEEP_RUN = '1';

  const definition = await loadDefinition(options.agent, {
    ...(options.completion ? { completion: options.completion } : {}),
  });

  const { runtime, transport } = await createStandaloneRuntime(definition, {
    ...(options.root ? { root: options.root } : {}),
    allowMissingTools: options.allowMissingTools,
  });
  const agent = new StandaloneAgent(runtime, transport, {
    ...(options.completion ? { completion: options.completion } : {}),
    ...(options.maxMessages === undefined ? {} : { maxMessages: options.maxMessages }),
    conversations: new ConversationStore({
      dir: join(transport.root, '.local', 'conversations'),
      maxMessages: envInt('AGENT_HISTORY_MAX_MESSAGES', DEFAULT_HISTORY_MESSAGES),
      maxBytes: envInt('AGENT_HISTORY_MAX_BYTES', DEFAULT_HISTORY_BYTES),
    }),
  });

  if (options.serve) {
    const token = process.env.AGENT_HTTP_TOKEN?.trim() || undefined;
    const server = await startStandaloneServer({
      agent,
      runtime,
      transport,
      ...(options.host ? { host: options.host } : {}),
      ...(options.port === undefined ? {} : { port: options.port }),
      ...(token ? { token } : {}),
      idleMs: envInt('AGENT_IDLE_MS', 0),
      shutdownGraceMs: envInt('AGENT_SHUTDOWN_GRACE_MS', 15_000),
    });
    process.stderr.write(
      `standalone 服务已启动：${server.url}（agent: ${definition.id}；${
        token ? 'Bearer 鉴权已启用' : '仅本机访问，未启用令牌'
      }）\n`,
    );
    const stop = () => {
      void server.close();
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    await server.done;
    process.stderr.write('standalone 服务已退出\n');
    return 0;
  }

  const raw = options.message ?? (await readStdin());
  const input = parseInput(raw);
  const threadId = options.thread ?? input.threadId;

  const { runId, result } = await agent.run({
    text: input.text,
    ...(threadId ? { threadId } : {}),
  });
  process.stdout.write(`${JSON.stringify({ runId, ...result })}\n`);
  return exitCode(result.status);
}

process.stdout.on('error', () => process.exit(0));

try {
  process.exitCode = await main();
} catch (error) {
  if (error instanceof StandaloneConfigError) {
    process.stderr.write(`配置错误：${error.message}\n`);
    process.exitCode = 2;
  } else {
    process.stderr.write(
      `运行入口失败：${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
