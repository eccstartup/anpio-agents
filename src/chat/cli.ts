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
import { mergePlugins, pluginDefinitionsFromCli } from '../plugins/cli-spec.ts';
import type { PluginDefinition, PluginPreparation } from '../plugins/types.ts';
import type { ToolLog } from '../tools.ts';
import type { SessionOutcome } from '../runtime/types.ts';
import { ChatRenderer, Repl, type ReplPluginControl } from './repl.ts';

type CliOptions = {
  agent?: string;
  message?: string;
  thread?: string;
  root?: string;
  stream: boolean;
  platform: boolean;
  allowMissingTools: boolean;
  mcp: string[];
  mcpAllow: string[];
  mcpEnv: string[];
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
  --mcp "<id=命令 参数>"  接入一个 MCP server，可重复（相对路径按当前目录解析）
  --mcp-allow <id=a,b>    收窄对应插件暴露的工具（默认全部）
  --mcp-env <id=VAR,..>   允许插件继承的环境变量名
  -h, --help              显示本帮助

定义文件里的 "sources" 段决定消息来源：
  {"sources":{"stdin":{"enabled":true},"platform":{"enabled":true,...}}}

交互模式下输入 /help 查看斜杠命令，/mcp 管理 MCP 插件。`;

function configError(message: string): never {
  throw new StandaloneConfigError(message);
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    stream: true,
    platform: true,
    allowMissingTools: false,
    mcp: [],
    mcpAllow: [],
    mcpEnv: [],
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
      case '--mcp':
        options.mcp.push(takeValue());
        break;
      case '--mcp-allow':
        options.mcpAllow.push(takeValue());
        break;
      case '--mcp-env':
        options.mcpEnv.push(takeValue());
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

function toolList(tools: PluginPreparation['tools']): string {
  return tools
    .map(tool => `${tool.exposedName}（${tool.effects === 'read' ? '读' : '写'}）`)
    .join('、');
}

function formatPluginList(runtime: AgentRuntime): string {
  const definitions = runtime.pluginDefinitions;
  if (definitions.length === 0) {
    return '没有接入 MCP 插件。启动时用 --mcp "id=命令 参数"，或在这里 /mcp add ci=node ./ci-mcp.ts。';
  }

  const tools = runtime.plugins?.tools() ?? [];
  const lines = [`已接入 ${definitions.length} 个 MCP 插件：`];
  for (const definition of definitions) {
    lines.push(`  ${definition.id}  ${[definition.command, ...definition.args].join(' ')}`);
    const owned = tools.filter(tool => tool.pluginId === definition.id);
    lines.push(owned.length === 0 ? '    工具尚未发现' : `    ${toolList(owned)}`);
  }
  return lines.join('\n');
}

function addedSummary(definition: PluginDefinition, prepared: PluginPreparation): string {
  const degraded = prepared.degraded.find(item => item.id === definition.id);
  if (degraded) return `插件 ${definition.id} 未启动，已按降级处理：${degraded.reason}`;
  const owned = prepared.tools.filter(tool => tool.pluginId === definition.id);
  if (owned.length === 0) return `已接入插件 ${definition.id}，但没有可用工具。`;
  return `已接入插件 ${definition.id}：${toolList(owned)}`;
}

async function addPlugin(
  runtime: AgentRuntime,
  log: ToolLog,
  spec: string,
): Promise<string> {
  const additions = pluginDefinitionsFromCli({ mcp: [spec], allow: [], env: [] });
  if (additions.length === 0) throw new Error('没有给出插件启动命令');

  try {
    const prepared = await runtime.addPlugins(additions, log);
    return additions.map(definition => addedSummary(definition, prepared)).join('\n');
  } catch (error) {
    // 只回滚这次新加进去的定义，不能误删同名的既有插件。
    const added = runtime.pluginDefinitions.filter(definition => additions.includes(definition));
    if (added.length > 0) {
      await runtime.removePlugins(added.map(definition => definition.id)).catch(() => {});
    }
    throw error;
  }
}

async function removePlugin(runtime: AgentRuntime, id: string): Promise<string> {
  const ids = runtime.pluginDefinitions.map(plugin => plugin.id);
  if (!ids.includes(id)) {
    throw new Error(`没有插件 ${id}${ids.length > 0 ? `（已接入：${ids.join(', ')}）` : ''}`);
  }
  const prepared = await runtime.removePlugins([id]);
  return `已移除插件 ${id}。${
    prepared.tools.length > 0 ? `当前工具：${toolList(prepared.tools)}` : '当前没有插件工具。'
  }`;
}

async function main(argv: string[]): Promise<number> {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (!options.agent) configError('需要 --agent <定义文件>');

  const cliPlugins = pluginDefinitionsFromCli({
    mcp: options.mcp,
    allow: options.mcpAllow,
    env: options.mcpEnv,
  });

  const loaded = await loadAgentFile(options.agent, {
    ...(cliPlugins.length > 0 ? { extraPlugins: cliPlugins } : {}),
  });
  const definition = loaded.definition;
  if (cliPlugins.length > 0) {
    definition.plugins = mergePlugins(definition.plugins, cliPlugins);
  }
  // 交互输入总要有一个槽位，平台 thread 才能与本地并行。
  definition.concurrency = Math.max(2, definition.concurrency);

  const warn = (line: string): void => {
    process.stderr.write(`${line}\n`);
  };
  const pluginLog: ToolLog = (level, text) => {
    if (level === 'warn' || level === 'error') warn(text);
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

  if (runtime.pluginDefinitions.length > 0) {
    const prepared = await runtime.preparePlugins(pluginLog);
    for (const item of prepared.degraded) {
      warn(`插件 ${item.id} 已降级：${item.reason}`);
    }
    if (prepared.tools.length > 0) {
      warn(`MCP 插件：${prepared.tools.map(tool => tool.exposedName).join('、')}`);
    }
  }

  const pluginControl: ReplPluginControl = {
    list: () => formatPluginList(runtime),
    add: spec => addPlugin(runtime, pluginLog, spec),
    remove: id => removePlugin(runtime, id),
  };

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
    repl = new Repl({ host, stdin, plugins: pluginControl });
    await repl.run(Boolean(process.stdin.isTTY));
    return 0;
  } finally {
    await host.stop();
    await runtime.close();
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
