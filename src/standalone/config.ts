/**
 * 独立运行的定义文件加载器。
 *
 * 平台路径的定义由 anpio-collab 规范化；从文件跑时没有人替我们补默认值，
 * 所以这里做同一件事：校验协议与工具、补齐 id / 时间戳 / 限额，并在启动前
 * 确认密钥环境变量存在，避免跑到一半才发现缺配置。
 */

import { readFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import {
  COMPLETION_POLICIES,
  EMBEDDED_TOOLS,
  PROTOCOLS,
  SESSION_ISOLATIONS,
  type AgentScope,
  type CompletionPolicy,
  type EmbeddedAgentDefinition,
  type EmbeddedProviderConfig,
  type EmbeddedTool,
  type Protocol,
  type ScriptStep,
  type SessionIsolation,
} from '../definition.ts';
import { parsePlugins, PluginConfigError, resolvePluginPaths } from '../plugins/config.ts';
import { declaredPluginTools } from '../plugins/naming.ts';
import type { PluginDefinition } from '../plugins/types.ts';

type Raw = Record<string, unknown>;

export class StandaloneConfigError extends Error {
  override name = 'StandaloneConfigError';
}

export type LoadDefinitionOptions = {
  /** 命令行覆盖定义里的完成策略。 */
  completion?: CompletionPolicy;
  /** 命令行接入、还没写进定义文件的插件；脚本步骤可以引用它们的工具。 */
  extraPlugins?: PluginDefinition[];
  now?: Date;
};

const DEFAULT_BASE_URLS: Partial<Record<Protocol, string>> = {
  'openai-chat': 'https://api.openai.com/v1',
  'openai-responses': 'https://api.openai.com/v1',
  'anthropic-messages': 'https://api.anthropic.com',
  'gemini-generate': 'https://generativelanguage.googleapis.com/v1beta',
  script: '',
};

const DEFAULT_KEY_ENV: Partial<Record<Protocol, string | null>> = {
  'openai-chat': 'OPENAI_API_KEY',
  'openai-responses': 'OPENAI_API_KEY',
  'anthropic-messages': 'ANTHROPIC_API_KEY',
  'gemini-generate': 'GEMINI_API_KEY',
  'workers-ai': 'CLOUDFLARE_API_TOKEN',
  script: null,
};

/** 能独立跑多轮对话的协议；其余协议要么未实现，要么不适合对话。 */
const STANDALONE_PROTOCOLS = new Set<Protocol>([
  'script',
  'openai-chat',
  'openai-responses',
  'anthropic-messages',
  'gemini-generate',
  'workers-ai',
]);

const DEFAULT_TOOLS: EmbeddedTool[] = ['read_file', 'write_file', 'list_files', 'finish'];
const DEFAULT_LIMITS = { maxTurns: 12, timeoutMs: 180_000, maxTokens: 8_192 };
const DEFAULT_SANDBOX = { shellTimeoutMs: 30_000, maxOutputBytes: 65_536 };
const MAX_ID_LENGTH = 128;

const SCOPES: readonly AgentScope[] = [
  'tasks:read',
  'tasks:submit',
  'offers:claim',
  'knowledge:read',
  'comments:write',
  'presence:write',
  'mailbox:read',
  'mailbox:write',
];

function isRecord(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown, path: string): Raw {
  if (!isRecord(value)) throw new StandaloneConfigError(`${path} 必须是对象`);
  return value;
}

function fail(path: string, message: string): never {
  throw new StandaloneConfigError(`${path} ${message}`);
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') fail(path, '必须是字符串');
  return value;
}

function positiveInt(value: unknown, path: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    fail(path, '必须是正整数');
  }
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

function normalizeId(value: string): string {
  const cleaned = value
    .trim()
    .replace(/[^A-Za-z0-9._:-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, MAX_ID_LENGTH);
  return cleaned || 'agent';
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') fail(path, '必须是非空字符串');
  return value.trim();
}

function parseScriptSteps(value: unknown, pluginTools: readonly string[]): ScriptStep[] {
  if (!Array.isArray(value)) fail('provider.script', '必须是数组');
  const known = new Set<string>([...EMBEDDED_TOOLS, ...pluginTools]);
  return value.map((item, index) => {
    const path = `provider.script[${index}]`;
    const step = record(item, path);
    const text = optionalString(step.text, `${path}.text`);
    const tool = optionalString(step.tool, `${path}.tool`);
    if (text === undefined && tool === undefined) fail(path, '需要 text 或 tool 至少一项');
    if (tool !== undefined && !known.has(tool)) {
      fail(
        `${path}.tool`,
        `不是已知工具：${tool}（插件工具要写 plugin__<id>__<tool>，并出现在 plugins[].allow 里）`,
      );
    }
    if (step.input !== undefined && !isRecord(step.input)) fail(`${path}.input`, '必须是对象');
    return {
      ...(text === undefined ? {} : { text }),
      ...(tool === undefined ? {} : { tool }),
      ...(step.input === undefined ? {} : { input: step.input as Record<string, unknown> }),
    };
  });
}

function parseTools(value: unknown): EmbeddedTool[] {
  if (value === undefined) return [...DEFAULT_TOOLS];
  if (!Array.isArray(value)) fail('tools', '必须是工具名数组');
  const seen = new Set<string>();
  const tools: EmbeddedTool[] = [];
  value.forEach((item, index) => {
    if (typeof item !== 'string' || !(EMBEDDED_TOOLS as readonly string[]).includes(item)) {
      fail(`tools[${index}]`, `不是已知工具：${String(item)}`);
    }
    if (seen.has(item)) return;
    seen.add(item);
    tools.push(item as EmbeddedTool);
  });
  return tools;
}

function parseProvider(
  raw: unknown,
  providerIdFallback: string,
  pluginTools: readonly string[],
): EmbeddedProviderConfig {
  const provider = record(raw, 'provider');
  const protocol = requireString(provider.protocol, 'provider.protocol') as Protocol;
  if (!(PROTOCOLS as readonly string[]).includes(protocol)) {
    fail('provider.protocol', `不是已知协议：${protocol}`);
  }
  if (!STANDALONE_PROTOCOLS.has(protocol)) {
    fail('provider.protocol', `协议 ${protocol} 暂不支持独立多轮运行`);
  }

  const model =
    protocol === 'script'
      ? optionalString(provider.model, 'provider.model') ?? 'script'
      : requireString(provider.model, 'provider.model');

  const defaultBaseUrl = DEFAULT_BASE_URLS[protocol];
  const baseUrl =
    optionalString(provider.baseUrl, 'provider.baseUrl') ??
    defaultBaseUrl ??
    fail(
      'provider.baseUrl',
      protocol === 'workers-ai'
        ? '必须提供（Workers AI 的地址包含账户 id，没有通用默认值）'
        : '必须提供',
    );
  if (protocol !== 'script' && !baseUrl) fail('provider.baseUrl', '必须是非空字符串');

  let apiKeyEnv: string | null;
  if (provider.apiKeyEnv === null) {
    apiKeyEnv = null;
  } else {
    const explicit = optionalString(provider.apiKeyEnv, 'provider.apiKeyEnv');
    apiKeyEnv = explicit ?? DEFAULT_KEY_ENV[protocol] ?? null;
  }
  const apiKey = optionalString(provider.apiKey, 'provider.apiKey');
  const apiKeyFile = optionalString(provider.apiKeyFile, 'provider.apiKeyFile');

  const script =
    protocol === 'script'
      ? parseScriptSteps(provider.script, pluginTools)
      : provider.script === undefined
        ? undefined
        : parseScriptSteps(provider.script, pluginTools);

  return {
    id: optionalString(provider.id, 'provider.id') ?? providerIdFallback,
    protocol,
    baseUrl,
    model,
    apiKeyEnv,
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(apiKeyFile === undefined ? {} : { apiKeyFile }),
    ...(script === undefined ? {} : { script }),
  };
}

function parseCompletion(value: unknown, override: CompletionPolicy | undefined): CompletionPolicy {
  if (override) return override;
  if (value === undefined) return 'finish';
  if (typeof value !== 'string' || !(COMPLETION_POLICIES as readonly string[]).includes(value)) {
    fail('completion', `只能是 ${COMPLETION_POLICIES.join(' / ')}`);
  }
  return value as CompletionPolicy;
}

function parseIsolation(value: unknown): SessionIsolation {
  if (value === undefined) return 'inline';
  if (typeof value !== 'string' || !(SESSION_ISOLATIONS as readonly string[]).includes(value)) {
    fail('sessionIsolation', `只能是 ${SESSION_ISOLATIONS.join(' / ')}`);
  }
  return value as SessionIsolation;
}

export function normalizeDefinition(
  raw: unknown,
  fallbackId: string,
  options: LoadDefinitionOptions = {},
): EmbeddedAgentDefinition {
  const root = record(raw, '定义');
  const id =
    root.id === undefined
      ? normalizeId(fallbackId)
      : requireString(root.id, 'id');
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(id)) {
    fail('id', '只能包含字母、数字、. _ : -，长度 1–128');
  }

  let plugins: PluginDefinition[] | undefined;
  try {
    plugins = parsePlugins(root.plugins);
  } catch (error) {
    if (error instanceof PluginConfigError) throw new StandaloneConfigError(error.message);
    throw error;
  }
  const pluginToolNames = declaredPluginTools([
    ...(plugins ?? []),
    ...(options.extraPlugins ?? []),
  ]).map((entry) => entry.exposedName);

  const provider = parseProvider(root.provider, `standalone-${id}`, pluginToolNames);
  const tools = parseTools(root.tools);

  const limitsRaw = root.limits === undefined ? {} : record(root.limits, 'limits');
  const limits = {
    maxTurns: positiveInt(limitsRaw.maxTurns, 'limits.maxTurns', DEFAULT_LIMITS.maxTurns),
    timeoutMs: positiveInt(limitsRaw.timeoutMs, 'limits.timeoutMs', DEFAULT_LIMITS.timeoutMs),
    maxTokens: positiveInt(limitsRaw.maxTokens, 'limits.maxTokens', DEFAULT_LIMITS.maxTokens),
  };

  const sandboxRaw = root.sandbox === undefined ? {} : record(root.sandbox, 'sandbox');
  if (sandboxRaw.shell !== undefined && typeof sandboxRaw.shell !== 'boolean') {
    fail('sandbox.shell', '必须是布尔值');
  }
  const shell = sandboxRaw.shell === undefined ? tools.includes('shell') : sandboxRaw.shell;
  if (!shell && tools.includes('shell')) {
    fail('sandbox.shell', 'tools 含 shell 时必须开启（否则工具会在运行时报错）');
  }
  const sandbox = {
    shell,
    shellTimeoutMs: positiveInt(sandboxRaw.shellTimeoutMs, 'sandbox.shellTimeoutMs', DEFAULT_SANDBOX.shellTimeoutMs),
    maxOutputBytes: positiveInt(sandboxRaw.maxOutputBytes, 'sandbox.maxOutputBytes', DEFAULT_SANDBOX.maxOutputBytes),
  };

  const scopes = stringList(root.scopes, 'scopes').map((scope, index) => {
    if (!(SCOPES as readonly string[]).includes(scope)) fail(`scopes[${index}]`, `不是已知范围：${scope}`);
    return scope as AgentScope;
  });

  if (root.enabled !== undefined && typeof root.enabled !== 'boolean') fail('enabled', '必须是布尔值');

  const now = (options.now ?? new Date()).toISOString();
  const completion = parseCompletion(root.completion, options.completion);
  const definition: EmbeddedAgentDefinition = {
    id,
    name: optionalString(root.name, 'name') ?? id,
    description: optionalString(root.description, 'description') ?? '',
    capabilities: stringList(root.capabilities, 'capabilities'),
    provider,
    systemPrompt: optionalString(root.systemPrompt, 'systemPrompt') ?? '',
    tools,
    ...(plugins === undefined ? {} : { plugins }),
    scopes,
    limits,
    sandbox,
    enabled: root.enabled === undefined ? true : root.enabled,
    concurrency: positiveInt(root.concurrency, 'concurrency', 1),
    sessionIsolation: parseIsolation(root.sessionIsolation),
    completion,
    createdBy: null,
    createdAt: optionalString(root.createdAt, 'createdAt') ?? now,
    updatedAt: optionalString(root.updatedAt, 'updatedAt') ?? now,
    lastRunAt: null,
    lastError: null,
  };

  if (provider.apiKeyEnv && !provider.apiKey && !provider.apiKeyFile && !process.env[provider.apiKeyEnv]) {
    fail('provider.apiKeyEnv', `缺少环境变量 ${provider.apiKeyEnv}（密钥只从环境变量读取）`);
  }

  return definition;
}

export async function loadDefinition(
  file: string,
  options: LoadDefinitionOptions = {},
): Promise<EmbeddedAgentDefinition> {
  const { raw, fallbackId } = await readDefinitionFile(file);
  return resolvePlugins(normalizeDefinition(raw, fallbackId, options), file);
}

/** 定义文件里的插件路径相对定义文件解析，与插件自己的 cwd 无关。 */
function resolvePlugins(definition: EmbeddedAgentDefinition, file: string): EmbeddedAgentDefinition {
  const plugins = resolvePluginPaths(definition.plugins, dirname(file));
  return plugins === undefined ? definition : { ...definition, plugins };
}

export type PlatformSourceConfig = {
  enabled: boolean;
  baseUrl: string;
  agentId: string;
  adminTokenEnv: string;
  secretEnv: string;
  pollMs: number;
};

export type ChatSourcesConfig = {
  stdin: boolean;
  platform: PlatformSourceConfig | null;
};

export type LoadedAgentFile = {
  definition: EmbeddedAgentDefinition;
  sources: ChatSourcesConfig;
};

/**
 * 聊天 CLI 用的定义文件：与 loadDefinition 相同的定义规范化，
 * 另外解析本地才有的 sources 段（平台定义里没有这一项）。
 *
 * 聊天默认 `completion: text`：文件里没写时才覆盖；写了就尊重文件。
 * sessionIsolation 强制 inline，交互流式不能进子进程。
 */
export async function loadAgentFile(
  file: string,
  options: LoadDefinitionOptions = {},
): Promise<LoadedAgentFile> {
  const { raw, fallbackId } = await readDefinitionFile(file);
  const root = record(raw, '定义');
  const definition = normalizeDefinition(raw, fallbackId, {
    ...(root.completion === undefined ? { completion: 'text' as CompletionPolicy } : {}),
    ...options,
  });
  definition.sessionIsolation = 'inline';
  return {
    definition: resolvePlugins(definition, file),
    sources: parseChatSources(root.sources, definition.id),
  };
}

function parseChatSources(raw: unknown, agentId: string): ChatSourcesConfig {
  if (raw === undefined) return { stdin: true, platform: null };
  const sources = record(raw, 'sources');
  for (const key of Object.keys(sources)) {
    if (key !== 'stdin' && key !== 'platform') fail(`sources.${key}`, '不是已知来源');
  }

  let stdin = true;
  if (sources.stdin !== undefined) {
    const entry = record(sources.stdin, 'sources.stdin');
    for (const key of Object.keys(entry)) {
      if (key !== 'enabled') fail(`sources.stdin.${key}`, '不是已知字段');
    }
    if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') {
      fail('sources.stdin.enabled', '必须是布尔值');
    }
    stdin = entry.enabled !== false;
  }

  if (sources.platform === undefined) return { stdin, platform: null };
  const platform = record(sources.platform, 'sources.platform');
  for (const key of Object.keys(platform)) {
    if (key === 'adminToken' || key === 'secret' || key === 'token') {
      fail(`sources.platform.${key}`, '不能写明文凭据，只能给环境变量名');
    }
    if (!['enabled', 'baseUrl', 'agentId', 'adminTokenEnv', 'secretEnv', 'pollMs'].includes(key)) {
      fail(`sources.platform.${key}`, '不是已知字段');
    }
  }
  if (platform.enabled !== undefined && typeof platform.enabled !== 'boolean') {
    fail('sources.platform.enabled', '必须是布尔值');
  }
  if (platform.enabled === false) return { stdin, platform: null };

  const baseUrl = requireString(platform.baseUrl, 'sources.platform.baseUrl');
  try {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      fail('sources.platform.baseUrl', '必须是不带凭据的 HTTP(S) 地址');
    }
  } catch (error) {
    if (error instanceof StandaloneConfigError) throw error;
    fail('sources.platform.baseUrl', '不是合法地址');
  }

  return {
    stdin,
    platform: {
      enabled: true,
      baseUrl,
      agentId: optionalString(platform.agentId, 'sources.platform.agentId') ?? agentId,
      adminTokenEnv:
        optionalString(platform.adminTokenEnv, 'sources.platform.adminTokenEnv') ?? 'COLLAB_RUNTIME_TOKEN',
      secretEnv: optionalString(platform.secretEnv, 'sources.platform.secretEnv') ?? 'COLLAB_EMBEDDED_SECRET',
      pollMs: positiveInt(platform.pollMs, 'sources.platform.pollMs', 3_000),
    },
  };
}

async function readDefinitionFile(file: string): Promise<{ raw: unknown; fallbackId: string }> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new StandaloneConfigError(`定义文件不存在：${file}`);
    throw new StandaloneConfigError(`读取定义文件失败：${error instanceof Error ? error.message : String(error)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new StandaloneConfigError(`定义文件不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  return { raw, fallbackId: basename(file).replace(/\.json$/i, '') };
}
