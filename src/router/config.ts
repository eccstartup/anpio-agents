/**
 * Router 配置：`router.json` + `ANP_*` 环境变量。
 *
 * 相对路径按配置文件所在目录解析；命令行没有 `--config` 时按 cwd 处理。
 * 端口、地址与路径在启动前一次校验完，避免半启动后才发现配置错误。
 */

import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

export class RouterConfigError extends Error {
  override name = 'RouterConfigError';
}

export type RouterListen = { host: string; port: number };

export type RouterConfig = {
  /** 数据空间根：router.db、anp/、agents/ 都在这里。 */
  root: string;
  /** router 自己发布 DID/ADP 的公开地址。 */
  didBaseUrl: string;
  /** 内嵌 ANP 消息服务的公开地址。 */
  publicUrl: string;
  listen: RouterListen;
  anpListen: RouterListen;
  agentsFile: string;
  adminToken: string | null;
  defaultAgent: string | null;
  /** 每个 agent 同时运行的 turn 上限；缺省用定义里的 concurrency。 */
  maxActiveTurns: number | null;
  routing: { strategy: 'deterministic' | 'model' };
  /** agents.json 的热更新轮询间隔；0 表示关闭。 */
  watchIntervalMs: number;
  /** 扫描待处理消息、重试 outbox 的间隔。 */
  sweepIntervalMs: number;
  /** 扫描过期子 agent 的间隔；0 表示关闭。 */
  childScanIntervalMs: number;
  /** 定时调度 tick 间隔；0 表示不自动触发。 */
  scheduleTickIntervalMs: number;
};

type Raw = Record<string, unknown>;

const DEFAULTS = {
  didBaseUrl: 'http://127.0.0.1:8788',
  publicUrl: 'http://127.0.0.1:8787',
  listen: { host: '127.0.0.1', port: 8788 },
  anpListen: { host: '127.0.0.1', port: 8787 },
  watchIntervalMs: 2_000,
  sweepIntervalMs: 1_000,
  childScanIntervalMs: 60_000,
  scheduleTickIntervalMs: 1_000,
};

function isRecord(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown, path: string): Raw {
  if (!isRecord(value)) throw new RouterConfigError(`${path} 必须是对象`);
  return value;
}

function fail(path: string, message: string): never {
  throw new RouterConfigError(`${path} ${message}`);
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') fail(path, '必须是字符串');
  return value.trim() === '' ? undefined : value;
}

function absolutePath(value: string, baseDir: string): string {
  return isAbsolute(value) ? value : resolve(baseDir, value);
}

function parseUrl(value: string, path: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail(path, `不是合法 URL：${value}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') fail(path, '只支持 http/https');
  return value.replace(/\/$/, '');
}

function parseListen(value: unknown, path: string, fallback: RouterListen): RouterListen {
  if (value === undefined) return { ...fallback };
  const raw = record(value, path);
  const host = optionalString(raw.host, `${path}.host`) ?? fallback.host;
  const port = raw.port === undefined ? fallback.port : raw.port;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65_535) {
    fail(`${path}.port`, '必须是 0–65535 的整数');
  }
  return { host, port };
}

function parseNonNegativeInt(value: unknown, path: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    fail(path, '必须是非负整数');
  }
  return value;
}

function parsePositiveInt(value: unknown, path: string, fallback: number | null): number | null {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    fail(path, '必须是正整数');
  }
  return value;
}

export function parseRouterConfig(
  raw: unknown,
  options: { baseDir: string; env?: NodeJS.ProcessEnv },
): RouterConfig {
  const root = record(raw ?? {}, '配置');
  const baseDir = options.baseDir;
  const env = options.env ?? process.env;

  const rootPath = absolutePath(
    env.ANP_ROOT ?? optionalString(root.root, 'root') ?? '.anp',
    baseDir,
  );
  const didBaseUrl = parseUrl(
    env.ANP_DID_BASE_URL ?? optionalString(root.didBaseUrl, 'didBaseUrl') ?? DEFAULTS.didBaseUrl,
    'didBaseUrl',
  );
  const publicUrl = parseUrl(
    env.ANP_PUBLIC_URL ?? optionalString(root.publicUrl, 'publicUrl') ?? DEFAULTS.publicUrl,
    'publicUrl',
  );

  const listen = parseListen(root.listen, 'listen', DEFAULTS.listen);
  const anpListen = parseListen(root.anpListen, 'anpListen', DEFAULTS.anpListen);
  if (env.ANP_LISTEN) listenFromEnv(env.ANP_LISTEN, 'ANP_LISTEN', listen);
  if (env.ANP_ANP_LISTEN) listenFromEnv(env.ANP_ANP_LISTEN, 'ANP_ANP_LISTEN', anpListen);

  const agentsFile = absolutePath(
    env.ANP_AGENTS_FILE ?? optionalString(root.agentsFile, 'agentsFile') ?? 'agents.json',
    baseDir,
  );

  const adminToken = optionalString(
    env.ANP_ADMIN_TOKEN ?? optionalString(root.adminToken, 'adminToken'),
    'adminToken',
  ) ?? null;

  const defaultAgent = optionalString(
    env.ANP_DEFAULT_AGENT ?? optionalString(root.defaultAgent, 'defaultAgent'),
    'defaultAgent',
  ) ?? null;

  const routingRaw = root.routing === undefined ? {} : record(root.routing, 'routing');
  const strategy = routingRaw.strategy ?? 'deterministic';
  if (strategy !== 'deterministic' && strategy !== 'model') {
    fail('routing.strategy', '只能是 deterministic / model');
  }

  return {
    root: rootPath,
    didBaseUrl,
    publicUrl,
    listen,
    anpListen,
    agentsFile,
    adminToken,
    defaultAgent,
    maxActiveTurns: parsePositiveInt(root.maxActiveTurns, 'maxActiveTurns', null),
    routing: { strategy },
    watchIntervalMs: parseNonNegativeInt(root.watchIntervalMs, 'watchIntervalMs', DEFAULTS.watchIntervalMs),
    sweepIntervalMs: parseNonNegativeInt(root.sweepIntervalMs, 'sweepIntervalMs', DEFAULTS.sweepIntervalMs),
    childScanIntervalMs: parseNonNegativeInt(
      root.childScanIntervalMs,
      'childScanIntervalMs',
      DEFAULTS.childScanIntervalMs,
    ),
    scheduleTickIntervalMs: parseNonNegativeInt(
      root.scheduleTickIntervalMs,
      'scheduleTickIntervalMs',
      DEFAULTS.scheduleTickIntervalMs,
    ),
  };
}

function listenFromEnv(value: string, path: string, target: RouterListen): void {
  const index = value.lastIndexOf(':');
  if (index <= 0) fail(path, '格式应为 host:port');
  const host = value.slice(0, index);
  const port = Number(value.slice(index + 1));
  if (!Number.isInteger(port) || port < 0 || port > 65_535) fail(path, '端口必须是 0–65535 的整数');
  target.host = host;
  target.port = port;
}

/** 解析 `--config <file>`；缺省用 `ANP_ROUTER_CONFIG`。 */
export function configPathFromArgv(argv: string[], env: NodeJS.ProcessEnv = process.env): string | null {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--config' || arg === '-c') {
      const next = argv[index + 1];
      if (!next) fail('--config', '缺少文件路径');
      return next;
    }
    if (arg.startsWith('--config=')) return arg.slice('--config='.length);
  }
  return env.ANP_ROUTER_CONFIG ?? null;
}

export async function loadRouterConfig(options: {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
} = {}): Promise<RouterConfig> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const configPath = configPathFromArgv(options.argv ?? process.argv.slice(2), env);
  if (!configPath) return parseRouterConfig({}, { baseDir: cwd, env });

  const file = isAbsolute(configPath) ? configPath : resolve(cwd, configPath);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new RouterConfigError(`配置文件不存在：${file}`);
    throw new RouterConfigError(`读取配置文件失败：${error instanceof Error ? error.message : String(error)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new RouterConfigError(`配置文件不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  return parseRouterConfig(raw, { baseDir: dirname(file), env });
}
