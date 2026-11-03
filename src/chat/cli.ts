/**
 * anpio-agents：像 Claude Code / codex CLI 一样启动一个常驻智能体。
 *
 * 本地终端输入与平台推送走同一套 thread 与模型循环；平台只是消息来源之一。
 * 接口与既有入口保持不变，这里只是多了一个可交互的启动方式。
 */

import { join } from 'node:path';
import { AgentRuntime } from '../runtime/agent.ts';
import { threadTransport } from '../threads/transport.ts';
import { ThreadHost } from '../threads/host.ts';
import type { MessageSource } from '../threads/types.ts';
import { AgentStore } from '../store/agent-store.ts';
import { StdinSource } from '../sources/stdin.ts';
import { PlatformSource } from '../sources/platform.ts';
import { isLocalTool, type EmbeddedAgentDefinition } from '../definition.ts';
import { loadAgentFile, StandaloneConfigError, type LoadedAgentFile } from '../standalone/config.ts';
import type { SessionOutcome } from '../runtime/types.ts';
import { ChatRenderer, Repl } from './repl.ts';

type CliOptions = {
  agent?: string;
  message?: string;
  thread?: string;
  root?: string;
  stream: boolean;
  platform: boolean;
  allowMissingTools: boolean;
  help: boolean;
};

const HELP = `用法：anpio-agents --agent <定义文件> [选项]

选项：
  --message <文本>        只处理这一条消息，然后退出
  --thread <id>           默认 thread（默认 local:main）
  --root <目录>           运行根（默认 $COLLAB_RUN_ROOT 或 ./collab-runs）
  --no-stream             不逐字输出，等模型整段返回
  --no-platform           即使配置里启用了平台来源，也不连接平台
  --allow-missing-tools   平台工具不可用时降级为本地工具
  -h, --help              显示本帮助

定义文件里的 "sources" 段决定消息来源：
  {"sources":{"stdin":{"enabled":true},"platform":{"enabled":true,...}}}

交互模式下输入 /help 查看斜杠命令。`;

function configError(message: string): never {
  throw new StandaloneConfigError(message);
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    stream: true,
    platform: true,
    allowMissingTools: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index]!;
    if (raw === '-h' || raw === '--help') {
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
      case '--no-stream':
        takeFlag();
        options.stream = false;
        break;
      case '--no-platform':
        takeFlag();
        options.platform = false;
        break;
      case '--allow-missing-tools':
        options.allowMissingTools = takeFlag();
        break;
      default:
        configError(`无法识别的参数：${name}`);
    }
  }

  return options;
}

function exitCode(status: SessionOutcome): number {
  return status === 'succeeded' ? 0 : status === 'outcome_unknown' ? 2 : 1;
}

function buildPlatform(
  loaded: LoadedAgentFile,
  options: CliOptions,
  warn: (line: string) => void,
): PlatformSource | null {
  const platform = loaded.sources.platform;
  if (!platform || !options.platform) return null;
  try {
    return new PlatformSource({
      baseUrl: platform.baseUrl,
      agentId: platform.agentId,
      adminTokenEnv: platform.adminTokenEnv,
      secretEnv: platform.secretEnv,
      pollMs: platform.pollMs,
      log: line => warn(`[platform] ${line}`),
    });
  } catch (error) {
    warn(`平台来源未启用：${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function validateTools(definition: EmbeddedAgentDefinition, platform: PlatformSource | null): void {
  if (platform) return;
  const missing = definition.tools.filter(tool => !isLocalTool(tool));
  if (missing.length > 0) {
    throw new StandaloneConfigError(
      `没有平台工具后端，定义里的这些工具不可用：${missing.join(', ')}`
      + '（启用平台来源，或加 --allow-missing-tools 降级）',
    );
  }
}

async function main(argv: string[]): Promise<number> {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (!options.agent) configError('需要 --agent <定义文件>');

  const loaded = await loadAgentFile(options.agent);
  const definition = loaded.definition;
  // 交互输入总要有一个槽位，平台 thread 才能与本地并行。
  definition.concurrency = Math.max(2, definition.concurrency);

  const warn = (line: string): void => {
    process.stderr.write(`${line}\n`);
  };

  const platform = buildPlatform(loaded, options, warn);
  validateTools(definition, platform);

  if (!loaded.sources.stdin && !platform && !options.message) {
    throw new StandaloneConfigError('没有可用的消息来源：stdin 被关闭，平台也未启用');
  }

  const runtime = await AgentRuntime.create({
    agentId: definition.id,
    definition,
    transport: threadTransport(),
    ...(options.root ? { rootBase: options.root } : {}),
  });
  const store = new AgentStore(join(runtime.root, 'agent.db'));

  const renderer = new ChatRenderer({ interactive: Boolean(process.stdin.isTTY) && !options.message });
  let repl: Repl | null = null;

  const defaultThread = options.thread ?? 'local:main';
  const sources: MessageSource[] = [];
  let stdin: StdinSource | null = null;

  if (options.message !== undefined) {
    sources.push({ id: 'stdin', kind: 'interactive', poll: async () => [] });
  } else if (loaded.sources.stdin) {
    stdin = new StdinSource({ threadId: defaultThread });
    sources.push(stdin);
  }
  if (platform) sources.push(platform);

  const host = new ThreadHost({
    runtime,
    definition,
    store,
    sources,
    stream: options.stream,
    allowMissingTools: options.allowMissingTools,
    log: warn,
    onEvent: event => {
      renderer.handle(event);
      repl?.handleEvent(event);
    },
  });

  try {
    await host.start();
    if (options.message !== undefined) {
      const { done } = host.submit({ text: options.message, threadId: defaultThread });
      const result = await done;
      return exitCode(result?.status ?? 'failed');
    }

    if (!stdin) throw new StandaloneConfigError('没有可交互的输入来源');
    repl = new Repl({ host, stdin });
    await repl.run(Boolean(process.stdin.isTTY));
    return 0;
  } finally {
    await host.stop();
    store.close();
  }
}

process.stdout.on('error', () => process.exit(0));

const code = await main(process.argv.slice(2)).catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`anpio-agents 启动失败：${message}\n`);
  return 1;
});
process.exit(code);
