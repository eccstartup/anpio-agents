/**
 * `plugins` 段的校验与默认值。
 *
 * 平台路径和本地定义文件都走这一份解析：supervisor 只透传平台返回的定义、
 * 不做校验，所以 `AgentRuntime` 拿到之后还会再跑一次，不能假设上游已规范化。
 */

import { isAbsolute, resolve } from 'node:path';
import { exposedToolName } from './naming.ts';
import type { PluginDefinition } from './types.ts';

export class PluginConfigError extends Error {
  override name = 'PluginConfigError';
}

type Raw = Record<string, unknown>;

const ID_PATTERN = /^[a-z0-9-]{1,32}$/;
const ENV_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const KNOWN_FIELDS = new Set([
  'id',
  'transport',
  'command',
  'args',
  'env',
  'allow',
  'timeoutMs',
  'maxOutputBytes',
  'concurrency',
  'idleMs',
  'optional',
]);

const DEFAULTS = {
  timeoutMs: 30_000,
  maxOutputBytes: 65_536,
  concurrency: 1,
  idleMs: 300_000,
} as const;

function isRecord(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(path: string, message: string): never {
  throw new PluginConfigError(`${path} ${message}`);
}

function record(value: unknown, path: string): Raw {
  if (!isRecord(value)) fail(path, '必须是对象');
  return value;
}

function stringList(value: unknown, path: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(path, '必须是字符串数组');
  return value.map((item, index) => {
    if (typeof item !== 'string') fail(`${path}[${index}]`, '必须是字符串');
    return item;
  });
}

function positiveInt(value: unknown, path: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    fail(path, '必须是正整数');
  }
  return value;
}

function nonNegativeInt(value: unknown, path: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    fail(path, '必须是非负整数');
  }
  return value;
}

function parsePlugin(raw: unknown, path: string): PluginDefinition {
  const entry = record(raw, path);
  for (const key of Object.keys(entry)) {
    if (!KNOWN_FIELDS.has(key)) fail(`${path}.${key}`, '不是已知字段');
  }

  const id = entry.id;
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    fail(`${path}.id`, '必须是 1–32 位小写字母、数字或连字符');
  }

  const transport = entry.transport === undefined ? 'stdio' : entry.transport;
  if (transport === 'http') {
    fail(`${path}.transport`, '阶段 4 才支持 http，目前只能是 stdio');
  }
  if (transport !== 'stdio') fail(`${path}.transport`, '只能是 stdio');

  const command = entry.command;
  if (typeof command !== 'string' || command.trim() === '') {
    fail(`${path}.command`, '必须是非空字符串');
  }

  const args = stringList(entry.args, `${path}.args`);
  const env = stringList(entry.env, `${path}.env`).map((name, index) => {
    if (name.includes('=')) {
      fail(`${path}.env[${index}]`, '只能写环境变量名，不能写值（如 CI_TOKEN，而不是 CI_TOKEN=xxx）');
    }
    if (!ENV_PATTERN.test(name)) fail(`${path}.env[${index}]`, `不是合法的环境变量名：${name}`);
    return name;
  });

  const allowRaw = entry.allow;
  if (!Array.isArray(allowRaw) || allowRaw.length === 0) {
    fail(`${path}.allow`, '必须是非空的工具名数组');
  }
  const allow: string[] = [];
  const seen = new Set<string>();
  allowRaw.forEach((item, index) => {
    if (typeof item !== 'string' || item.trim() === '') {
      fail(`${path}.allow[${index}]`, '必须是非空字符串');
    }
    if (seen.has(item)) return;
    seen.add(item);
    allow.push(item);
  });
  // `*` 只表示“服务端暴露的全部工具”，只能单独出现。
  if (allow.includes('*') && allow.length > 1) {
    fail(`${path}.allow`, '通配符 * 不能和其它工具名混用');
  }

  const exposed = new Map<string, string>();
  for (const name of allow) {
    if (name === '*') continue;
    const key = exposedToolName(id, name);
    const previous = exposed.get(key);
    if (previous !== undefined && previous !== name) {
      fail(`${path}.allow`, `工具 ${previous} 与 ${name} 清洗后重名（${key}），请改名或用不同插件`);
    }
    exposed.set(key, name);
  }

  if (entry.optional !== undefined && typeof entry.optional !== 'boolean') {
    fail(`${path}.optional`, '必须是布尔值');
  }

  return {
    id,
    transport: 'stdio',
    command,
    args,
    env,
    allow,
    timeoutMs: positiveInt(entry.timeoutMs, `${path}.timeoutMs`, DEFAULTS.timeoutMs),
    maxOutputBytes: positiveInt(entry.maxOutputBytes, `${path}.maxOutputBytes`, DEFAULTS.maxOutputBytes),
    concurrency: positiveInt(entry.concurrency, `${path}.concurrency`, DEFAULTS.concurrency),
    idleMs: nonNegativeInt(entry.idleMs, `${path}.idleMs`, DEFAULTS.idleMs),
    optional: entry.optional === true,
  };
}

/** 返回 undefined 表示定义里没有插件段。 */
export function parsePlugins(raw: unknown, path = 'plugins'): PluginDefinition[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) fail(path, '必须是数组');
  if (raw.length === 0) return undefined;

  const plugins = raw.map((item, index) => parsePlugin(item, `${path}[${index}]`));

  const ids = new Set<string>();
  const exposed = new Map<string, string>();
  for (const [index, plugin] of plugins.entries()) {
    if (ids.has(plugin.id)) fail(`${path}[${index}].id`, `插件 id 重复：${plugin.id}`);
    ids.add(plugin.id);
    for (const name of plugin.allow) {
      if (name === '*') continue;
      const key = exposedToolName(plugin.id, name);
      const owner = exposed.get(key);
      if (owner !== undefined) {
        fail(`${path}[${index}].allow`, `工具名 ${key} 与插件 ${owner} 冲突`);
      }
      exposed.set(key, plugin.id);
    }
  }

  return plugins;
}

function resolvePathToken(token: string, baseDir: string): string {
  if (isAbsolute(token) || token.startsWith('-')) return token;
  if (token.startsWith('.') || token.includes('/')) return resolve(baseDir, token);
  return token;
}

/**
 * 定义文件里的相对路径按定义文件所在目录解析。
 * 插件进程的 cwd 是自己的稳定目录（`<agentRoot>/plugins/<id>`），
 * 不可能是作者仓库的根目录，不能指望 `apps/ci/server.js` 在那里存在。
 */
export function resolvePluginPaths(
  plugins: PluginDefinition[] | undefined,
  baseDir: string,
): PluginDefinition[] | undefined {
  if (!plugins) return undefined;
  return plugins.map((plugin) => ({
    ...plugin,
    command: resolvePathToken(plugin.command, baseDir),
    args: plugin.args.map((arg) => resolvePathToken(arg, baseDir)),
  }));
}
