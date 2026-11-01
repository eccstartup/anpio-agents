/**
 * 单次会话入口：由 supervisor / agent-worker 按一次运行 spawn，结束即退出。
 *
 * 令牌从 stdin 进来（不走环境变量），shell 孙进程拿不到它；
 * 会话、消息与运行记录都通过平台 HTTP 接口操作，没有第二条通道。
 * 这里只负责读配置、构造 AgentRuntime、跑一次 Session。
 */

import { AgentRuntime } from './runtime/agent.ts';
import type { SessionOutcome } from './runtime/types.ts';
import type { EmbeddedAgentDefinition } from './definition.ts';

type RunConfig = {
  baseUrl: string;
  token: string;
  runId: string;
  agentId: string;
  definition: EmbeddedAgentDefinition;
  workdir?: string;
  maxMessages?: number;
};

async function readConfig(): Promise<RunConfig> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) throw new Error('没有收到运行配置（stdin 为空），应由 supervisor 启动本进程');
  const parsed = JSON.parse(raw) as Partial<RunConfig>;
  for (const key of ['baseUrl', 'token', 'runId', 'agentId'] as const) {
    if (typeof parsed[key] !== 'string' || !parsed[key]) throw new Error(`运行配置缺少 ${key}`);
  }
  const definition = parsed.definition as EmbeddedAgentDefinition | undefined;
  if (!definition || typeof definition !== 'object' || !definition.provider) {
    throw new Error('运行配置缺少 definition');
  }
  return parsed as RunConfig;
}

function exitCode(status: SessionOutcome): number {
  return status === 'succeeded' ? 0 : status === 'outcome_unknown' ? 2 : 1;
}

async function main(): Promise<number> {
  const config = await readConfig();
  const runtime = await AgentRuntime.create({
    baseUrl: config.baseUrl,
    token: config.token,
    agentId: config.agentId,
    definition: config.definition,
  });
  const result = await runtime.runSession({
    runId: config.runId,
    definition: config.definition,
    ...(config.maxMessages === undefined ? {} : { maxMessages: config.maxMessages }),
  });
  return exitCode(result.status);
}

const code = await main().catch(error => {
  process.stderr.write(`运行入口失败：${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  return 1;
});
process.exit(code);
