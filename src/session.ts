/**
 * 单次会话入口：由 supervisor / agent-worker 按一次运行 spawn，结束即退出。
 *
 * 令牌从 stdin 进来（不走环境变量），shell 孙进程拿不到它；
 * 会话、消息与运行记录都通过平台 HTTP 接口操作，没有第二条通道。
 * 这里只负责读配置、构造 AgentRuntime、跑一次 Session。
 *
 * 进程隔离模式下它是被 worker 拉起的子进程：stdout 只写 JSON 行
 * （已拉取的消息、最终结果），收到 SIGTERM 时中断本轮，让 AgentSession
 * 自己 ack/nack 与 finish，和同进程运行时是同一套生命周期。
 */

import { AgentRuntime, collabRuntime } from './runtime/agent.ts';
import type { SessionOutcome, SessionRequest } from './runtime/types.ts';
import type { MailEnvelope } from './client.ts';
import type { EmbeddedAgentDefinition } from './definition.ts';

type TransportConfig =
  | { type: 'collab'; baseUrl: string; token: string }
  | { type: 'local'; root?: string };

type RunConfig = {
  /** 新入口用 transport 描述连接方式；旧的 baseUrl/token 扁平配置继续可用。 */
  transport?: TransportConfig;
  baseUrl?: string;
  token?: string;
  runId: string;
  agentId: string;
  definition: EmbeddedAgentDefinition;
  workdir?: string;
  maxMessages?: number;
  /** 进程隔离模式下由 worker 开启：把事件写到 stdout。 */
  reportResult?: boolean;
};

async function readConfig(): Promise<RunConfig> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) throw new Error('没有收到运行配置（stdin 为空），应由 supervisor 启动本进程');
  const parsed = JSON.parse(raw) as Partial<RunConfig>;
  for (const key of ['runId', 'agentId'] as const) {
    if (typeof parsed[key] !== 'string' || !parsed[key]) throw new Error(`运行配置缺少 ${key}`);
  }
  const definition = parsed.definition as EmbeddedAgentDefinition | undefined;
  if (!definition || typeof definition !== 'object' || !definition.provider) {
    throw new Error('运行配置缺少 definition');
  }
  if (!parsed.transport && (typeof parsed.baseUrl !== 'string' || typeof parsed.token !== 'string')) {
    throw new Error('运行配置缺少 transport（或 baseUrl/token）');
  }
  return parsed as RunConfig;
}

function exitCode(status: SessionOutcome): number {
  return status === 'succeeded' ? 0 : status === 'outcome_unknown' ? 2 : 1;
}

/** 等 stdout 真正写出再返回：worker 靠这些行判断结果，process.exit 不等待挂起的写。 */
function writeLine(event: Record<string, unknown>): Promise<void> {
  return new Promise(resolve => {
    process.stdout.write(`${JSON.stringify(event)}\n`, () => resolve());
  });
}

async function main(): Promise<number> {
  const config = await readConfig();
  const transport: TransportConfig =
    config.transport ??
    ({ type: 'collab', baseUrl: config.baseUrl!, token: config.token! } satisfies TransportConfig);
  let runtime: AgentRuntime;
  if (transport.type === 'collab') {
    runtime = await collabRuntime({
      baseUrl: transport.baseUrl,
      token: transport.token,
      agentId: config.agentId,
      definition: config.definition,
    });
  } else {
    throw new Error('本地传输层的 process 隔离尚未启用');
  }
  const request: SessionRequest = {
    runId: config.runId,
    definition: config.definition,
    ...(config.maxMessages === undefined ? {} : { maxMessages: config.maxMessages }),
    ...(config.reportResult
      ? {
          onMailPulled: async (envelopes: MailEnvelope[]) => {
            await writeLine({
              type: 'mail-pulled',
              runId: config.runId,
              messages: envelopes.map(envelope => ({ id: envelope.id, deliveryId: envelope.deliveryId })),
            });
          },
        }
      : {}),
  };
  // 入口自己永远跑 inline：隔离级别由 worker 决定，子进程里不能再套子进程。
  const session = runtime.createSession(request);
  const stop = () => session.abort('运行时退出，本轮中断');
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  const result = await session.run();
  if (config.reportResult) await writeLine({ type: 'session-result', ...result });
  return exitCode(result.status);
}

process.stdout.on('error', () => process.exit(0));

const code = await main().catch(error => {
  process.stderr.write(`运行入口失败：${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  return 1;
});
process.exit(code);
