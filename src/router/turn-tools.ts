/**
 * 一轮 ANP Turn 的工具集：本地原语 + 协作工具。
 *
 * 写工具带上 effects 幂等键：模型重放同一个 tool call 时返回第一次的结果，
 * 不会重复发消息或创建子 agent。审计只记录工具名、耗时与状态，不记正文。
 */

import { createHash } from 'node:crypto';
import type { BrainLoopTools } from '../runtime/brain-loop.ts';
import type { AnpMailbox } from '../runtime/anp/mailbox.ts';
import type { AgentStore } from '../store/agent-store.ts';
import { createTools, type ToolExecution } from '../tools.ts';
import type { ToolCall, ToolSpec } from '../brains/types.ts';
import type { EmbeddedAgentDefinition, EmbeddedTool } from '../definition.ts';
import { isLocalTool, isRouterTool } from '../definition.ts';
import { ANP_TOOL_SPECS, executeAnpTool, type AnpToolContext } from '../tools/anp.ts';
import {
  SUBAGENT_TOOL_SPECS,
  executeSubagentTool,
  type AgentSummary,
  type SpawnAgentToolInput,
} from '../tools/subagent.ts';
import { NET_TOOL_SPECS, executeHttpFetch, type NetworkMode, type NetworkPolicy } from '../tools/net.ts';
import {
  SCHEDULE_TOOL_SPECS,
  executeScheduleTool,
  type ScheduleToolContext,
} from '../tools/schedule.ts';

export type TurnToolInput = {
  runDir: string;
  turnId: string;
  definition: EmbeddedAgentDefinition;
  threadId: string;
  triggerMessageId: string | null;
  store: AgentStore;
  mailbox: AnpMailbox;
  markReplied: () => void;
};

export type TurnToolCallbacks = {
  send: AnpToolContext['send'];
  listAgents: () => AgentSummary[];
  agentStatus: (agentId: string) => unknown;
  spawn: (input: SpawnAgentToolInput) => Promise<unknown>;
  schedules: Pick<ScheduleToolContext, 'create' | 'cancel' | 'list'>;
  network: NetworkMode;
  allowlist: string[];
  log?: (level: 'debug' | 'info' | 'warn' | 'error', text: string) => void;
};

const EXTRA_SPECS: Partial<Record<EmbeddedTool, ToolSpec>> = {
  ...ANP_TOOL_SPECS,
  ...SUBAGENT_TOOL_SPECS,
  ...SCHEDULE_TOOL_SPECS,
  ...NET_TOOL_SPECS,
};

const WRITE_TOOLS = new Set([
  'anp_send',
  'anp_reply',
  'spawn_agent',
  'schedule_create',
  'schedule_cancel',
  'memory_set',
]);
const AGENT_SCOPE_TOOLS = new Set(['spawn_agent', 'schedule_create', 'schedule_cancel']);

function hashOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex').slice(0, 12);
}

function operationIdFor(name: string, turnId: string, agentId: string, call: ToolCall): string {
  if (AGENT_SCOPE_TOOLS.has(name)) {
    return `agent:${agentId}:${call.id}-${hashOf(call.input)}`;
  }
  return `turn:${turnId}:${call.id}`;
}

function render(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 6_000 ? `${text.slice(0, 6_000)}\n…（已截断）` : text;
}

export function createTurnTools(input: TurnToolInput, callbacks: TurnToolCallbacks): BrainLoopTools {
  const enabled = new Set<string>(input.definition.tools);
  const localNames = input.definition.tools.filter(isLocalTool);
  const local = createTools({
    runDir: input.runDir,
    runId: input.turnId,
    definition: input.definition,
    tools: localNames,
    log: callbacks.log ?? (() => undefined),
  });
  const extraSpecs = input.definition.tools
    .filter(tool => isRouterTool(tool) && enabled.has(tool))
    .map(tool => EXTRA_SPECS[tool])
    .filter((spec): spec is ToolSpec => Boolean(spec));
  const specs = [...local.specs, ...extraSpecs];

  const anpContext: AnpToolContext = {
    agentId: input.definition.id,
    threadId: input.threadId,
    triggerMessageId: input.triggerMessageId,
    store: input.store,
    send: callbacks.send,
    markReplied: input.markReplied,
  };
  const network: NetworkPolicy = { mode: callbacks.network, allowlist: callbacks.allowlist };

  async function dispatch(
    name: string,
    args: Record<string, unknown>,
    call: ToolCall,
  ): Promise<{ execution: ToolExecution; audit?: string }> {
    const anp = await executeAnpTool(name, args, anpContext);
    if (anp) return { execution: anp };

    const subagent = await executeSubagentTool(name, args, {
      listAgents: callbacks.listAgents,
      agentStatus: callbacks.agentStatus,
      spawn: callbacks.spawn,
      defaultThreadId: input.threadId,
    });
    if (subagent) {
      return { execution: subagent };
    }

    const schedule = await executeScheduleTool(name, args, {
      ...callbacks.schedules,
      defaultThreadId: input.threadId,
    });
    if (schedule) return { execution: schedule };

    if (name === 'http_fetch') {
      const result = await executeHttpFetch(
        {
          url: String(args.url ?? ''),
          ...(args.method === undefined ? {} : { method: String(args.method) }),
          ...(args.headers === undefined ? {} : { headers: args.headers as Record<string, string> }),
          ...(args.body === undefined ? {} : { body: String(args.body) }),
        },
        network,
      );
      const host = new URL(result.url).host;
      callbacks.log?.('info', `http_fetch ${host} → ${result.status}，${result.bytes} 字节`);
      return {
        execution: {
          content: render({
            url: result.url,
            status: result.status,
            headers: result.headers,
            body: result.body,
            bytes: result.bytes,
            redirected: result.redirected,
          }),
        },
        audit: `${host} ${result.status} ${result.bytes}B`,
      };
    }

    return { execution: { content: `未知工具 ${name}` } };
  }

  async function execute(call: ToolCall): Promise<ToolExecution> {
    if (!enabled.has(call.name)) {
      return { content: `工具 ${call.name} 没有在这一轮启用` };
    }
    if (!isRouterTool(call.name as EmbeddedTool)) return local.execute(call);

    const args = call.input ?? {};
    const scope = AGENT_SCOPE_TOOLS.has(call.name) ? 'agent' : 'turn';
    const operationId = operationIdFor(call.name, input.turnId, input.definition.id, call);
    if (WRITE_TOOLS.has(call.name)) {
      const cached = input.store.getEffect(scope, operationId) as ToolExecution | undefined;
      if (cached) {
        if (call.name === 'anp_reply') input.markReplied();
        return cached;
      }
    }

    const started = Date.now();
    let audit = '';
    try {
      const dispatched = await dispatch(call.name, args, call);
      audit = dispatched.audit ?? '';
      if (WRITE_TOOLS.has(call.name)) {
        input.store.putEffect(scope, operationId, dispatched.execution);
      }
      input.store.audit({
        turnId: input.turnId,
        tool: call.name,
        argsHash: hashOf(args),
        status: audit ? `ok ${audit}` : 'ok',
        durationMs: Date.now() - started,
        effectId: WRITE_TOOLS.has(call.name) ? operationId : null,
      });
      return dispatched.execution;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      input.store.audit({
        turnId: input.turnId,
        tool: call.name,
        argsHash: hashOf(args),
        status: 'error',
        durationMs: Date.now() - started,
      });
      callbacks.log?.('warn', `工具 ${call.name} 失败：${message}`);
      return { content: `工具执行失败：${message}` };
    }
  }

  return { specs, execute };
}
