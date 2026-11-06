/**
 * 命令行与 REPL 的 MCP 接入：`--mcp "id=命令 参数"` 直接变成插件定义。
 *
 * 目标是“不用先写定义文件”：用户显式给出启动命令，就视为授权；
 * 默认暴露服务端的全部工具，`--mcp-allow` 再收窄白名单。
 */

import { basename } from 'node:path';
import { parsePlugins, PluginConfigError, resolvePluginPaths } from './config.ts';
import type { PluginDefinition } from './types.ts';

const ID_PREFIX = /^([a-z0-9][a-z0-9-]*)=(.*)$/;
const ID_PATTERN = /^[a-z0-9-]{1,32}$/;
const MAX_ID = 32;

export type PluginCliOptions = {
  /** 每个元素是一整条插件启动命令，可以带 `id=` 前缀。 */
  mcp: string[];
  /** `id=tool1,tool2`，收窄对应插件的白名单。 */
  allow: string[];
  /** `id=VAR1,VAR2`，允许插件继承的环境变量名。 */
  env: string[];
};

function fail(message: string): never {
  throw new PluginConfigError(message);
}

/** 按 shell 习惯拆词：支持单双引号与反斜杠转义。 */
export function splitCommandLine(input: string): string[] {
  const words: string[] = [];
  let current = '';
  let quoted: '"' | "'" | null = null;
  let escaped = false;
  let started = false;

  for (const char of input) {
    if (escaped) {
      current += char;
      escaped = false;
      started = true;
      continue;
    }
    if (char === '\\' && quoted !== "'") {
      escaped = true;
      continue;
    }
    if (quoted) {
      if (char === quoted) quoted = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quoted = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) {
        words.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }

  if (escaped) current += '\\';
  if (quoted) fail(`--mcp 里的引号没有闭合：${input}`);
  if (started) words.push(current);
  return words;
}

function sanitizeId(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_ID);
  return cleaned === '' ? 'mcp' : cleaned;
}

/** 没写 id 时从命令或第一个路径参数推导，例如 `node ./ci-logs/server.ts` -> server。 */
function deriveId(words: string[]): string {
  const argument = words.slice(1).find((word) => !word.startsWith('-'));
  const candidate = argument ?? words[0] ?? 'mcp';
  const base = basename(candidate).replace(/\.[^.]+$/, '');
  return sanitizeId(base);
}

function uniqueId(base: string, used: Set<string>): string {
  let id = base;
  let counter = 2;
  while (used.has(id)) {
    const suffix = `-${counter}`;
    counter += 1;
    id = `${base.slice(0, MAX_ID - suffix.length)}${suffix}`;
  }
  return id;
}

function parseAssignments(values: string[], flag: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const value of values) {
    const equals = value.indexOf('=');
    if (equals <= 0) {
      fail(`--${flag} 需要 id=值 的形式，例如 --${flag} ci=logs_tail,stage_status`);
    }
    const id = value.slice(0, equals).trim();
    const items = value
      .slice(equals + 1)
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item !== '');
    if (items.length === 0) fail(`--${flag} 里 ${id} 的值为空`);
    map.set(id, items);
  }
  return map;
}

export function pluginDefinitionsFromCli(
  options: PluginCliOptions,
  baseDir = process.cwd(),
): PluginDefinition[] {
  if (options.mcp.length === 0) {
    if (options.allow.length > 0 || options.env.length > 0) {
      fail('--mcp-allow / --mcp-env 需要同时提供 --mcp');
    }
    return [];
  }

  const allowMap = parseAssignments(options.allow, 'mcp-allow');
  const envMap = parseAssignments(options.env, 'mcp-env');
  const used = new Set<string>();

  const raw = options.mcp.map((spec, index) => {
    const words = splitCommandLine(spec);
    if (words.length === 0) fail(`--mcp 第 ${index + 1} 个值为空`);

    let id: string;
    let command: string;
    let args: string[];
    const prefixed = ID_PREFIX.exec(words[0]!);
    if (prefixed && prefixed[2] !== '') {
      id = prefixed[1]!;
      if (!ID_PATTERN.test(id)) {
        fail(`--mcp 的 id 不合法：${id}（1–32 位小写字母、数字或连字符）`);
      }
      command = prefixed[2]!;
      args = words.slice(1);
    } else {
      command = words[0]!;
      args = words.slice(1);
      id = uniqueId(deriveId(words), used);
    }

    if (used.has(id)) fail(`--mcp 的 id 重复：${id}`);
    used.add(id);

    return {
      id,
      command,
      args,
      // 命令行显式给了启动命令，就默认信任它的全部工具；--mcp-allow 可收窄。
      allow: allowMap.get(id) ?? ['*'],
      env: envMap.get(id) ?? [],
    };
  });

  for (const id of [...allowMap.keys(), ...envMap.keys()]) {
    if (!used.has(id)) {
      fail(`--mcp-allow / --mcp-env 指向不存在的插件：${id}（已声明：${[...used].join(', ')}）`);
    }
  }

  const parsed = parsePlugins(raw, '--mcp') ?? [];
  return resolvePluginPaths(parsed, baseDir) ?? [];
}

/** 合并定义文件与命令行里声明的插件，id 冲突直接报错。 */
export function mergePlugins(
  existing: PluginDefinition[] | undefined,
  additions: PluginDefinition[],
): PluginDefinition[] {
  if (additions.length === 0) return existing ?? [];
  const ids = new Set((existing ?? []).map((plugin) => plugin.id));
  for (const plugin of additions) {
    if (ids.has(plugin.id)) {
      fail(`插件 id 重复：${plugin.id}（定义文件与命令行各声明了一次）`);
    }
  }
  return [...(existing ?? []), ...additions];
}
