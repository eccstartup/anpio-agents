/**
 * 插件工具命名。定义校验、注册表、AGENTS.md 与 script 协议共用这一份规则，
 * 避免同一对 (id, tool) 在不同地方算出不同名字。
 */

import { createHash } from 'node:crypto';
import type { PluginDefinition } from './types.ts';

export const PLUGIN_TOOL_PREFIX = 'plugin__';
export const MAX_PLUGIN_TOOL_NAME = 64;

export function sanitizePluginTool(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '-');
}

/**
 * `plugin__<id>__<tool>`；超过 64 字符时截断并追加 6 位哈希。
 * 哈希基于原始 (id, tool)，避免不同原名在清洗后撞名。
 */
export function exposedToolName(pluginId: string, tool: string): string {
  const base = `${PLUGIN_TOOL_PREFIX}${sanitizePluginTool(pluginId)}__${sanitizePluginTool(tool)}`;
  if (base.length <= MAX_PLUGIN_TOOL_NAME) return base;
  const digest = createHash('sha256').update(`${pluginId}\0${tool}`).digest('hex').slice(0, 6);
  return `${base.slice(0, MAX_PLUGIN_TOOL_NAME - 7)}-${digest}`;
}

export function isPluginToolName(name: string): boolean {
  return name.startsWith(PLUGIN_TOOL_PREFIX);
}

export type DeclaredPluginTool = { pluginId: string; name: string; exposedName: string };

/** 定义里声明的全部插件工具（不依赖启动插件）。 */
export function declaredPluginTools(
  plugins: readonly PluginDefinition[] | undefined,
): DeclaredPluginTool[] {
  if (!plugins) return [];
  const declared: DeclaredPluginTool[] = [];
  for (const plugin of plugins) {
    for (const name of plugin.allow) {
      declared.push({ pluginId: plugin.id, name, exposedName: exposedToolName(plugin.id, name) });
    }
  }
  return declared;
}
