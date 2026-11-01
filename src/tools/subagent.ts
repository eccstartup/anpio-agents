/**
 * 子 agent 与注册表查询工具。
 *
 * 真正的深度、数量与工具子集校验在 router 侧完成；这里只做参数形状校验，
 * 把 router 的拒绝原样回到模型。
 */

import type { EmbeddedTool } from '../definition.ts';
import type { ToolSpec } from '../brains/types.ts';
import type { ToolExecution } from '../tools.ts';

export type SpawnAgentToolInput = {
  name: string;
  description: string;
  capabilities: string[];
  tools?: EmbeddedTool[];
  ttlMs?: number;
  maxTurns?: number;
  task?: string;
  threadId?: string;
};

export type AgentSummary = {
  agentId: string;
  name: string;
  did: string;
  description: string;
  capabilities: string[];
  enabled: boolean;
  activeTurns: number;
  parentId: string | null;
  depth: number;
};

export type SubagentToolContext = {
  listAgents: () => AgentSummary[];
  agentStatus: (agentId: string) => unknown;
  spawn: (input: SpawnAgentToolInput) => Promise<unknown>;
  defaultThreadId: string;
};

type Schema = Record<string, unknown>;

function schema(properties: Schema, required: string[] = Object.keys(properties)): Schema {
  return { type: 'object', properties, required, additionalProperties: false };
}

function textOf(input: Record<string, unknown>, key: string, max = 2_000): string {
  const value = input[key];
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`缺少参数 ${key}`);
  if (value.length > max) throw new Error(`参数 ${key} 过长（上限 ${max}）`);
  return value.trim();
}

function stringsOf(input: Record<string, unknown>, key: string, maxItems = 16): string[] {
  const value = input[key];
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`参数 ${key} 必须是字符串数组`);
  if (value.length > maxItems) throw new Error(`参数 ${key} 最多 ${maxItems} 项`);
  return value.map((item, index) => {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new Error(`参数 ${key}[${index}] 必须是非空字符串`);
    }
    return item.trim();
  });
}

function render(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 6_000 ? `${text.slice(0, 6_000)}\n…（已截断）` : text;
}

export const SUBAGENT_TOOL_SPECS = {
  list_agents: {
    name: 'list_agents',
    description: '列出 router 里已注册的 agent（含子 agent）：能力、在线状态与从属关系。',
    parameters: schema({}, []),
  },
  agent_status: {
    name: 'agent_status',
    description: '查看一个 agent 的状态、当前 turn 数与从属关系。',
    parameters: schema({ agentId: { type: 'string' } }),
  },
  spawn_agent: {
    name: 'spawn_agent',
    description:
      '创建一个子 agent 在同一 thread 里协作。需要父定义的 anp.allowSpawn=true；工具只能从父已有的工具里收缩。',
    parameters: schema({
      name: { type: 'string', description: '子 agent 名称' },
      description: { type: 'string', description: '职责说明' },
      capabilities: { type: 'array', items: { type: 'string' }, description: '能力标签' },
      tools: {
        type: 'array',
        items: { type: 'string' },
        description: '可选：子 agent 的工具，必须是父 agent 工具的子集；缺省继承父工具',
      },
      ttlMs: { type: 'integer', description: '可选：存活时长，默认 1 小时，最长 24 小时' },
      maxTurns: { type: 'integer', description: '可选：子 agent 每轮最多模型往返次数' },
      task: { type: 'string', description: '可选：创建后立即在当前 thread 派一条任务' },
      threadId: { type: 'string', description: '可选：协作 thread，默认当前 thread' },
    }, ['name', 'description']),
  },
} satisfies Partial<Record<EmbeddedTool, ToolSpec>>;

export async function executeSubagentTool(
  name: string,
  input: Record<string, unknown>,
  context: SubagentToolContext,
): Promise<ToolExecution | null> {
  switch (name) {
    case 'list_agents':
      return { content: render(context.listAgents()) };

    case 'agent_status': {
      const agentId = textOf(input, 'agentId', 128);
      const status = context.agentStatus(agentId);
      if (status === null || status === undefined) return { content: `agent ${agentId} 不存在` };
      return { content: render(status) };
    }

    case 'spawn_agent': {
      const tools = stringsOf(input, 'tools') as EmbeddedTool[];
      const ttlMs = input.ttlMs === undefined ? undefined : Number(input.ttlMs);
      if (ttlMs !== undefined && (!Number.isInteger(ttlMs) || ttlMs <= 0)) {
        throw new Error('ttlMs 必须是正整数');
      }
      const maxTurns = input.maxTurns === undefined ? undefined : Number(input.maxTurns);
      if (maxTurns !== undefined && (!Number.isInteger(maxTurns) || maxTurns <= 0 || maxTurns > 50)) {
        throw new Error('maxTurns 必须是 1..50 的整数');
      }
      const result = await context.spawn({
        name: textOf(input, 'name', 120),
        description: textOf(input, 'description', 2_000),
        capabilities: stringsOf(input, 'capabilities'),
        ...(tools.length > 0 ? { tools } : {}),
        ...(ttlMs !== undefined ? { ttlMs } : {}),
        ...(maxTurns !== undefined ? { maxTurns } : {}),
        ...(input.task === undefined ? {} : { task: textOf(input, 'task', 20_000) }),
        threadId: input.threadId === undefined
          ? context.defaultThreadId
          : textOf(input, 'threadId', 200),
      });
      return { content: render({ spawned: true, ...(result as Record<string, unknown>) }) };
    }

    default:
      return null;
  }
}
