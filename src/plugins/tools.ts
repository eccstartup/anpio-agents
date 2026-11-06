/**
 * 把插件工具并进一轮的工具集。
 *
 * 保持同步：装配点先 `await preparePlugins()`，这里只做合并与路由。
 * 插件工具名带 `plugin__` 前缀，所以不会和内置工具撞车。
 */

import type { BrainLoopTools } from '../runtime/brain-loop.ts';
import type { ToolCall } from '../brains/types.ts';
import type { ToolExecution } from '../tools.ts';
import { isPluginToolName } from './naming.ts';
import type { PluginRegistry } from './registry.ts';
import type { PluginCallContext } from './types.ts';

export function withPlugins(
  base: BrainLoopTools,
  registry: PluginRegistry | null,
  context: PluginCallContext,
): BrainLoopTools {
  if (!registry) return base;
  const specs = registry.specs();
  if (specs.length === 0) return base;

  return {
    specs: [...base.specs, ...specs],
    async execute(call: ToolCall): Promise<ToolExecution> {
      if (isPluginToolName(call.name) && registry.has(call.name)) {
        return registry.call(call, context);
      }
      return base.execute(call);
    },
    async dispose(): Promise<void> {
      try {
        await base.dispose?.();
      } finally {
        registry.endTurn();
      }
    },
  };
}
