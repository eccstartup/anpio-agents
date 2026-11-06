/**
 * MCP 结果转成模型可读文本。
 *
 * 两层上限：先按插件自己的 `maxOutputBytes` 做 UTF-8 安全截断（保护进程内存和
 * 日志），再走引擎统一的 `MAX_RESULT_CHARS`（保护模型上下文）。
 */

import { truncateResult } from '../tools.ts';

export type RenderedContent = {
  content: unknown[];
  isError: boolean;
  structuredContent?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function blockText(block: unknown): string {
  const entry = asRecord(block);
  if (!entry) return String(block);
  const type = entry.type;

  if (type === 'text' && typeof entry.text === 'string') return entry.text;
  if (type === 'image' || type === 'audio') {
    return `[${typeof entry.mimeType === 'string' ? entry.mimeType : String(type)}]`;
  }
  if (type === 'resource') {
    const resource = asRecord(entry.resource);
    if (resource && typeof resource.text === 'string') return resource.text;
    if (resource && typeof resource.uri === 'string') return `[resource ${resource.uri}]`;
    return '[resource]';
  }
  if (type === 'resource_link') {
    const uri = typeof entry.uri === 'string' ? entry.uri : '';
    const name = typeof entry.name === 'string' ? entry.name : '';
    return `[link ${name || uri}]`;
  }
  return JSON.stringify(block);
}

/** 按字节截断，不切开多字节码点。 */
export function truncateUtf8(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return text;
  const decoder = new TextDecoder('utf-8');
  const head = decoder.decode(buffer.subarray(0, maxBytes)).replace(/�+$/, '');
  return `${head}\n…（已截断到 ${maxBytes} 字节）`;
}

export function renderPluginResult(result: RenderedContent, maxBytes: number): string {
  const parts: string[] = [];
  for (const block of result.content) {
    const text = blockText(block);
    if (text !== '') parts.push(text);
  }
  let text = parts.join('\n');
  if (text === '' && result.structuredContent !== undefined) {
    text = JSON.stringify(result.structuredContent);
  }
  text = truncateUtf8(text, maxBytes);
  text = truncateResult(text);
  return result.isError ? `工具失败：${text}` : text;
}
