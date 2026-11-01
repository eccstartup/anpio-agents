/**
 * agents.json：每个 agent 的定义与 ANP 运行参数。
 *
 * 定义字段与平台下发的 EmbeddedAgentDefinition 一致（复用独立运行的校验），
 * `anp` 段只放 router 自己的运行策略，不混进模型提示词。
 */

import { readFile, stat } from 'node:fs/promises';
import type { EmbeddedAgentDefinition } from '../definition.ts';
import { normalizeDefinition } from '../standalone/config.ts';

export class AgentRegistryError extends Error {
  override name = 'AgentRegistryError';
}

export type AgentAnpConfig = {
  /** 允许该 agent 创建定时任务（P7）。 */
  allowSchedules: boolean;
  /** 允许该 agent 创建子 agent；默认 false。 */
  allowSpawn: boolean;
  /** 工具执行的隔离级别；缺省 process。 */
  isolation: 'inline' | 'process' | 'container';
  /** 覆盖定义里的 concurrency。 */
  maxActiveTurns: number | null;
  /** 出站网络策略；缺省 egress（allowlist 为空时等于不能联网）。 */
  network: 'none' | 'egress' | 'open';
  /** http_fetch 的主机 allowlist，支持 *.example.com 与 host:port。 */
  networkAllowlist: string[];
  /** 每个父 agent 同时存活的子 agent 上限；缺省 3。 */
  maxChildren: number | null;
  /** 允许的子 agent 深度；缺省 2（顶层父为 0）。 */
  maxDepth: number | null;
  /** 每个 agent 的定时任务上限；缺省 20。 */
  maxSchedules: number | null;
};

export type AgentEntry = {
  definition: EmbeddedAgentDefinition;
  anp: AgentAnpConfig;
};

export type RegistryDiff = {
  added: AgentEntry[];
  updated: AgentEntry[];
  removed: string[];
};

const ISOLATIONS = ['inline', 'process', 'container'] as const;
const NETWORK_MODES = ['none', 'egress', 'open'] as const;

const DEFAULT_ANP: AgentAnpConfig = {
  allowSchedules: false,
  allowSpawn: false,
  isolation: 'process',
  maxActiveTurns: null,
  network: 'egress',
  networkAllowlist: [],
  maxChildren: null,
  maxDepth: null,
  maxSchedules: null,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new AgentRegistryError(message);
}

function parseAnp(value: unknown, agentId: string): AgentAnpConfig {
  if (value === undefined) return { ...DEFAULT_ANP };
  if (!isRecord(value)) fail(`agents[${agentId}].anp 必须是对象`);
  if (value.allowSchedules !== undefined && typeof value.allowSchedules !== 'boolean') {
    fail(`agents[${agentId}].anp.allowSchedules 必须是布尔值`);
  }
  if (value.allowSpawn !== undefined && typeof value.allowSpawn !== 'boolean') {
    fail(`agents[${agentId}].anp.allowSpawn 必须是布尔值`);
  }
  const isolationRaw = value.isolation ?? 'process';
  if (typeof isolationRaw !== 'string' || !(ISOLATIONS as readonly string[]).includes(isolationRaw)) {
    fail(`agents[${agentId}].anp.isolation 只能是 ${ISOLATIONS.join(' / ')}`);
  }
  const isolation = isolationRaw as AgentAnpConfig['isolation'];
  const networkRaw = value.network ?? 'egress';
  if (typeof networkRaw !== 'string' || !(NETWORK_MODES as readonly string[]).includes(networkRaw)) {
    fail(`agents[${agentId}].anp.network 只能是 ${NETWORK_MODES.join(' / ')}`);
  }
  const allowlistRaw = value.networkAllowlist ?? [];
  if (!Array.isArray(allowlistRaw)) fail(`agents[${agentId}].anp.networkAllowlist 必须是字符串数组`);
  const networkAllowlist = allowlistRaw.map((item, index) => {
    if (typeof item !== 'string' || item.trim() === '') {
      fail(`agents[${agentId}].anp.networkAllowlist[${index}] 必须是非空字符串`);
    }
    return item.trim();
  });
  const maxActiveTurns = value.maxActiveTurns;
  if (
    maxActiveTurns !== undefined
    && (typeof maxActiveTurns !== 'number' || !Number.isInteger(maxActiveTurns) || maxActiveTurns <= 0)
  ) {
    fail(`agents[${agentId}].anp.maxActiveTurns 必须是正整数`);
  }
  const positiveOrNull = (raw: unknown, path: string): number | null => {
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
      fail(`agents[${agentId}].anp.${path} 必须是正整数`);
    }
    return raw;
  };
  return {
    allowSchedules: value.allowSchedules === true,
    allowSpawn: value.allowSpawn === true,
    isolation,
    maxActiveTurns: typeof maxActiveTurns === 'number' ? maxActiveTurns : null,
    network: networkRaw as AgentAnpConfig['network'],
    networkAllowlist,
    maxChildren: positiveOrNull(value.maxChildren, 'maxChildren'),
    maxDepth: positiveOrNull(value.maxDepth, 'maxDepth'),
    maxSchedules: positiveOrNull(value.maxSchedules, 'maxSchedules'),
  };
}

export function normalizeAgentEntry(raw: unknown, index: number, now?: Date): AgentEntry {
  if (!isRecord(raw)) fail(`agents[${index}] 必须是对象`);
  const fallbackId = typeof raw.id === 'string' && raw.id.trim() !== '' ? raw.id : `agent-${index + 1}`;
  const definition = normalizeDefinition(raw, fallbackId, now ? { now } : {});
  return { definition, anp: parseAnp(raw.anp, definition.id) };
}

export function parseAgentsFile(raw: unknown, now?: Date): AgentEntry[] {
  const list = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw.agents)
      ? raw.agents
      : fail('agents.json 必须是数组或 { agents: [...] }');
  const entries = list.map((item, index) => normalizeAgentEntry(item, index, now));
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.definition.id)) fail(`agent id 重复：${entry.definition.id}`);
    seen.add(entry.definition.id);
  }
  return entries;
}

export async function loadAgentsFile(file: string, now?: Date): Promise<AgentEntry[]> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') fail(`agents 文件不存在：${file}`);
    fail(`读取 agents 文件失败：${error instanceof Error ? error.message : String(error)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    fail(`agents 文件不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  return parseAgentsFile(raw, now);
}

/** 只比较会影响运行的内容；时间戳每次加载都会变，不参与。 */
export function agentFingerprint(entry: AgentEntry): string {
  const { createdAt: _createdAt, updatedAt: _updatedAt, lastRunAt: _lastRunAt, lastError: _lastError, ...rest } =
    entry.definition;
  void _createdAt;
  void _updatedAt;
  void _lastRunAt;
  void _lastError;
  return JSON.stringify({ definition: rest, anp: entry.anp });
}

/**
 * 内存注册表 + 文件 mtime 观察。重载失败时保留上一份可用快照，
 * 由调用方决定是否停掉出错的 agent。
 */
export class AgentRegistry {
  readonly file: string;
  private entries = new Map<string, AgentEntry>();
  private fingerprint = new Map<string, string>();
  private mtimeMs: number | null = null;

  constructor(file: string) {
    this.file = file;
  }

  get size(): number {
    return this.entries.size;
  }

  get(agentId: string): AgentEntry | undefined {
    return this.entries.get(agentId);
  }

  list(): AgentEntry[] {
    return [...this.entries.values()].sort((left, right) => left.definition.id.localeCompare(right.definition.id));
  }

  /** 首次加载；文件不存在或校验失败直接抛错。 */
  async load(now?: Date): Promise<RegistryDiff> {
    const { mtimeMs } = await stat(this.file).catch(() => ({ mtimeMs: null }));
    const entries = await loadAgentsFile(this.file, now);
    const diff = this.replace(entries);
    this.mtimeMs = mtimeMs;
    return diff;
  }

  /** 文件 mtime 变了才重新解析；返回 null 表示没有变化。 */
  async refresh(now?: Date): Promise<RegistryDiff | null> {
    const info = await stat(this.file).catch(() => null);
    if (!info) throw new AgentRegistryError(`agents 文件不存在：${this.file}`);
    if (this.mtimeMs !== null && info.mtimeMs === this.mtimeMs) return null;
    const entries = await loadAgentsFile(this.file, now);
    const diff = this.replace(entries);
    this.mtimeMs = info.mtimeMs;
    return diff;
  }

  private replace(entries: AgentEntry[]): RegistryDiff {
    const next = new Map(entries.map(entry => [entry.definition.id, entry]));
    const nextFingerprint = new Map(entries.map(entry => [entry.definition.id, agentFingerprint(entry)]));
    const added: AgentEntry[] = [];
    const updated: AgentEntry[] = [];
    const removed: string[] = [];
    for (const entry of entries) {
      if (!this.entries.has(entry.definition.id)) {
        added.push(entry);
      } else if (this.fingerprint.get(entry.definition.id) !== nextFingerprint.get(entry.definition.id)) {
        updated.push(entry);
      }
    }
    for (const agentId of this.entries.keys()) {
      if (!next.has(agentId)) removed.push(agentId);
    }
    this.entries = next;
    this.fingerprint = nextFingerprint;
    return { added, updated, removed };
  }
}
