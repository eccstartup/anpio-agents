/**
 * 插件自检（`npm run plugin:check`）。
 *
 * 不启动模型、不读密钥：只回答「能不能连上、暴露了哪些工具、白名单对不对、
 * 真实调用一次多久」。失败时给出可操作的原因，而不是堆栈。
 *
 * 两种用法：
 *   plugin:check -- --command "node server.ts" --allow logs_tail,stage_status
 *   plugin:check -- --definition examples/local-plugin.json --plugin ci --call logs_tail --input '{"limit":5}'
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parsePlugins, PluginConfigError, resolvePluginPaths } from './config.ts';
import { exposedToolName } from './naming.ts';
import { McpClient } from './mcp-client.ts';
import { renderPluginResult } from './render.ts';
import type { PluginDefinition } from './types.ts';

const HELP = `用法：npm run plugin:check -- [选项]

选项：
  --command <命令>        启动插件的命令，如 "node examples/plugins/ci-logs/server.ts"
  --allow <a,b>           允许暴露给模型的工具名（命令模式必填）
  --id <id>               插件 id（默认 check）
  --env <A,B>             从当前环境透传给插件的变量名
  --timeout <ms>          单次请求超时（默认 30000）
  --definition <文件>     直接检查定义文件里的某个插件
  --plugin <id>           定义文件里有多个插件时选择其一
  --call <工具名>         试一次真实调用（缺省调用白名单里的第一个工具）
  --input <JSON>          调用参数，如 '{"limit":5}'
  --json                  输出机器可读的 JSON
  -h, --help              显示本帮助

相对路径按当前目录解析；用 --definition 时按定义文件所在目录解析。`;

type Options = {
  command?: string;
  allow: string[];
  id: string;
  env: string[];
  timeoutMs?: number;
  definition?: string;
  plugin?: string;
  call?: string;
  input?: Record<string, unknown>;
  json: boolean;
  help: boolean;
};

type ToolReport = {
  name: string;
  exposedName: string;
  allowed: boolean;
  readOnly: boolean;
  description: string;
  inputSchema: Record<string, unknown>;
};

type CallReport = {
  tool: string;
  ok: boolean;
  durationMs: number;
  isError: boolean;
  output: string;
};

type Report = {
  ok: boolean;
  plugin: string;
  server: { name: string; version: string } | null;
  tools: ToolReport[];
  allow: Array<{ name: string; exposedName: string; present: boolean }>;
  missing: string[];
  call?: CallReport;
  error?: string;
};

class UsageError extends Error {
  override name = 'UsageError';
}

function fail(message: string): never {
  throw new UsageError(message);
}

function parseArgs(argv: string[]): Options {
  const options: Options = { allow: [], id: 'check', env: [], json: false, help: false };

  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index]!;
    if (raw === '-h' || raw === '--help') {
      options.help = true;
      continue;
    }
    if (!raw.startsWith('--')) fail(`无法识别的参数：${raw}`);

    const equals = raw.indexOf('=');
    const name = equals === -1 ? raw : raw.slice(0, equals);
    const inline = equals === -1 ? undefined : raw.slice(equals + 1);
    const takeValue = (): string => {
      if (inline !== undefined) {
        if (inline === '') fail(`${name} 需要一个值`);
        return inline;
      }
      const next = argv[index + 1];
      if (next === undefined) fail(`${name} 需要一个值`);
      index += 1;
      return next;
    };
    const takeFlag = (): void => {
      if (inline !== undefined) fail(`${name} 不接受值`);
    };

    switch (name) {
      case '--command':
        options.command = takeValue();
        break;
      case '--allow':
        options.allow = takeValue().split(',').map((item) => item.trim()).filter(Boolean);
        break;
      case '--id':
        options.id = takeValue();
        break;
      case '--env':
        options.env = takeValue().split(',').map((item) => item.trim()).filter(Boolean);
        break;
      case '--timeout': {
        const value = Number(takeValue());
        if (!Number.isInteger(value) || value <= 0) fail('--timeout 必须是正整数');
        options.timeoutMs = value;
        break;
      }
      case '--definition':
        options.definition = takeValue();
        break;
      case '--plugin':
        options.plugin = takeValue();
        break;
      case '--call':
        options.call = takeValue();
        break;
      case '--input': {
        const text = takeValue();
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          fail('--input 不是合法 JSON');
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          fail('--input 必须是 JSON 对象');
        }
        options.input = parsed as Record<string, unknown>;
        break;
      }
      case '--json':
        takeFlag();
        options.json = true;
        break;
      default:
        fail(`无法识别的参数：${name}`);
    }
  }

  return options;
}

/** 支持引号的简单分词；不展开变量，避免把 shell 语义带进来。 */
function splitCommand(text: string): string[] {
  const tokens: string[] = [];
  for (const match of text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return tokens.filter((token) => token !== '');
}

function absolutize(tokens: string[]): string[] {
  return tokens.map((token) => {
    if (isAbsolute(token) || token.startsWith('-')) return token;
    return token.includes('/') ? resolve(process.cwd(), token) : token;
  });
}

async function readDefinitionPlugin(options: Options): Promise<PluginDefinition> {
  const file = resolve(process.cwd(), options.definition!);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, 'utf8')) as unknown;
  } catch (error) {
    fail(`读不了定义文件 ${options.definition}：${error instanceof Error ? error.message : String(error)}`);
  }
  const root = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const plugins = resolvePluginPaths(parsePlugins(root.plugins), dirname(file));
  if (!plugins) fail(`定义文件里没有 plugins 段：${options.definition}`);

  const id = options.plugin ?? (plugins.length === 1 ? plugins[0]!.id : undefined);
  if (!id) fail(`定义文件里有多个插件，请用 --plugin 指定（${plugins.map((item) => item.id).join('、')}）`);
  const plugin = plugins.find((item) => item.id === id);
  if (!plugin) {
    fail(`定义文件里没有插件 ${id}（有：${plugins.map((item) => item.id).join('、')}）`);
  }
  return plugin;
}

function commandPlugin(options: Options): PluginDefinition {
  if (!options.command) fail('需要 --command，或用 --definition 指定定义文件');
  if (options.allow.length === 0) fail('命令模式需要 --allow（要暴露给模型的工具名，逗号分隔）');

  const tokens = absolutize(splitCommand(options.command));
  if (tokens.length === 0) fail('--command 不能为空');
  const parsed = parsePlugins([
    {
      id: options.id,
      command: tokens[0],
      args: tokens.slice(1),
      allow: options.allow,
      ...(options.env.length === 0 ? {} : { env: options.env }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    },
  ]);
  return parsed![0]!;
}

async function runCheck(options: Options): Promise<{ code: number; report: Report }> {
  if (options.definition && options.command) fail('--definition 与 --command 只能选一个');
  const definition = options.definition
    ? await readDefinitionPlugin(options)
    : commandPlugin(options);

  const directory = await mkdtemp(join(tmpdir(), 'anpio-plugin-check-'));
  const report: Report = {
    ok: false,
    plugin: definition.id,
    server: null,
    tools: [],
    allow: [],
    missing: [],
  };

  let client: McpClient | null = null;
  try {
    client = await McpClient.connect({
      definition,
      directory,
      log: (level, text) => {
        if (!options.json && (level === 'warn' || level === 'error')) {
          process.stderr.write(`[${definition.id}] ${text}\n`);
        }
      },
    });
    report.server = client.serverInfo;

    const discovered = await client.listTools();
    const byName = new Map(discovered.map((tool) => [tool.name, tool]));
    const allow = definition.allow.includes('*')
      ? discovered.map((tool) => tool.name)
      : definition.allow;

    report.tools = discovered.map((tool) => ({
      name: tool.name,
      exposedName: exposedToolName(definition.id, tool.name),
      allowed: allow.includes(tool.name),
      readOnly: tool.readOnly,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
    report.allow = allow.map((name) => ({
      name,
      exposedName: exposedToolName(definition.id, name),
      present: byName.has(name),
    }));
    report.missing = report.allow.filter((item) => !item.present).map((item) => item.name);

    if (report.missing.length > 0) {
      report.error = `插件没有提供这些工具：${report.missing.join(', ')}`;
      return { code: 1, report };
    }
    if (discovered.length === 0) {
      report.error = '插件没有提供任何工具';
      return { code: 1, report };
    }

    const toolName = options.call ?? allow[0]!;
    if (!allow.includes(toolName)) {
      report.error = `工具 ${toolName} 不在白名单里（allow：${allow.join(', ')}）`;
      return { code: 1, report };
    }

    const started = Date.now();
    const result = await client.callTool(toolName, options.input ?? {}, {
      meta: {},
      timeoutMs: definition.timeoutMs,
      onProgress: (progress) => {
        if (options.json) return;
        process.stderr.write(
          `进度 ${progress.progress}${progress.total === undefined ? '' : `/${progress.total}`}`
          + `${progress.message === undefined ? '' : ` ${progress.message}`}\n`,
        );
      },
    });
    const output = renderPluginResult(result, definition.maxOutputBytes);
    report.call = {
      tool: toolName,
      ok: !result.isError,
      durationMs: Date.now() - started,
      isError: result.isError,
      output,
    };
    if (result.isError) {
      report.error = '工具返回了 isError，插件没有正常完成';
      return { code: 1, report };
    }

    report.ok = true;
    return { code: 0, report };
  } catch (error) {
    report.error = describe(error);
    return { code: 1, report };
  } finally {
    await client?.close();
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/ENOENT/.test(message)) {
    return `${message}\n（找不到可执行文件：检查 --command 的第一个词是否在 PATH 里）`;
  }
  if (/timed out|timeout/i.test(message)) {
    return `${message}\n（插件没有在超时内响应；检查它是否在 stderr 里报错，或加大 --timeout）`;
  }
  return message;
}

function printHuman(report: Report): void {
  if (!report.ok) {
    process.stderr.write(`插件 ${report.plugin} 自检失败：${report.error ?? '未知原因'}\n`);
    if (report.tools.length > 0) {
      process.stderr.write(`插件实际提供的工具：${report.tools.map((tool) => tool.name).join('、')}\n`);
    }
    return;
  }

  const server = report.server ? `（${report.server.name} ${report.server.version}）` : '';
  process.stdout.write(`插件 ${report.plugin} 已连接${server}\n`);
  process.stdout.write(`发现 ${report.tools.length} 个工具：\n`);
  for (const tool of report.tools) {
    const effects = tool.readOnly ? '读' : '写';
    const mark = tool.allowed ? '✓' : '（未在 allow 中）';
    process.stdout.write(`  - ${tool.name}（${effects}）${mark}：${tool.description || '没有描述'}\n`);
    process.stdout.write(`    暴露名：${tool.exposedName}\n`);
    process.stdout.write(`    参数：${JSON.stringify(tool.inputSchema)}\n`);
  }
  if (report.call) {
    const status = report.call.ok ? '成功' : '失败';
    process.stdout.write(`调用 ${report.call.tool}：${report.call.durationMs}ms，${status}\n`);
    const first = report.call.output.split('\n').slice(0, 5).join('\n');
    if (first) process.stdout.write(`  输出：${first}\n`);
  }
  process.stdout.write(
    `白名单：${report.allow.map((item) => `${item.name} ${item.present ? '✓' : '✗'}`).join('、')}\n`,
  );
  process.stdout.write('自检通过：插件可以接入定义文件的 plugins 段。\n');
}

async function main(argv: string[]): Promise<number> {
  let options: Options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`参数错误：${error.message}\n\n${HELP}\n`);
      return 2;
    }
    throw error;
  }

  if (options.help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }

  try {
    const { code, report } = await runCheck(options);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      printHuman(report);
    }
    return code;
  } catch (error) {
    if (error instanceof UsageError || error instanceof PluginConfigError) {
      process.stderr.write(`配置错误：${error.message}\n`);
      return 2;
    }
    process.stderr.write(`自检失败：${describe(error)}\n`);
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
