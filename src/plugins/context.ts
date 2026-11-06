/**
 * 每次插件调用附带的 `_meta`。
 *
 * 只放标识与幂等键：没有模型密钥、平台令牌、环境变量，也没有 workspace
 * 之外的主机路径。插件需要路径就自己在定义里配置。
 */

import type { ToolCall } from '../brains/types.ts';
import type { PluginCallContext } from './types.ts';

export type PluginMeta = {
  runId: string;
  agentId: string;
  threadId?: string;
  turnId?: string;
  taskId?: string;
  pluginId: string;
  tool: string;
  idempotencyKey: string;
  /** 本次调用的客户端超时时刻。 */
  deadline: string;
};

/**
 * 同一个 ToolCall 重放时 key 不变；模型重新发起的同名调用会拿到新的 call.id，
 * 不构成语义去重——真正的幂等要插件配合。
 */
export function idempotencyKey(call: ToolCall, context: PluginCallContext): string {
  return context.turnId
    ? `turn:${context.turnId}:${call.id}`
    : `run:${context.runId}:${call.id}`;
}

export function buildPluginMeta(
  call: ToolCall,
  pluginId: string,
  toolName: string,
  context: PluginCallContext,
  timeoutMs: number,
  now = Date.now(),
): PluginMeta {
  return {
    runId: context.runId,
    agentId: context.agentId,
    ...(context.threadId === undefined ? {} : { threadId: context.threadId }),
    ...(context.turnId === undefined ? {} : { turnId: context.turnId }),
    ...(context.taskId === undefined ? {} : { taskId: context.taskId }),
    pluginId,
    tool: toolName,
    idempotencyKey: idempotencyKey(call, context),
    deadline: new Date(now + timeoutMs).toISOString(),
  };
}
