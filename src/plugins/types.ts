/**
 * 外部插件（MCP server）在引擎内的形态。
 *
 * 定义文件里的 `plugins` 由 `config.ts` 校验并补全默认值；运行时只消费
 * 这种补全后的结构，不再判断缺省。协议层由官方 MCP SDK 负责，这里只描述
 * 引擎自己关心的那部分：白名单、上限、生命周期与审计。
 */

import type { ToolCall, ToolSpec } from '../brains/types.ts';
import type { ToolExecution, ToolLog } from '../tools.ts';

export type PluginTransport = 'stdio';

export type PluginDefinition = {
  id: string;
  transport: PluginTransport;
  command: string;
  args: string[];
  env: string[];
  allow: string[];
  timeoutMs: number;
  maxOutputBytes: number;
  concurrency: number;
  /** 常驻进程空闲多久关闭；0 表示不自动关闭。 */
  idleMs: number;
  /** 启动失败时是否允许降级；默认 false，直接让本轮失败。 */
  optional: boolean;
};

export type PluginTool = {
  pluginId: string;
  /** 插件内的原始工具名。 */
  name: string;
  /** 模型看到的名字：plugin__<id>__<tool>。 */
  exposedName: string;
  spec: ToolSpec;
  effects: 'read' | 'write';
};

export type PluginProgress = {
  pluginId: string;
  tool: string;
  progress: number;
  total?: number;
  message?: string;
};

export type PluginCallContext = {
  runId: string;
  agentId: string;
  threadId?: string;
  turnId?: string;
  taskId?: string;
  signal?: AbortSignal;
  onProgress?: (event: PluginProgress) => void;
  log?: ToolLog;
};

export type PluginPreparation = {
  tools: PluginTool[];
  /** optional 插件启动失败或缺少工具时的降级记录，写入运行日志。 */
  degraded: Array<{ id: string; reason: string }>;
};

/** 插件调用内部使用：注册表把 ToolCall 拆开后再执行。 */
export type PluginInvocation = {
  call: ToolCall;
  tool: PluginTool;
  context: PluginCallContext;
};

export type PluginExecution = ToolExecution;
