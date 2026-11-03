/**
 * 模型接口的流式读取：SSE 解析 + 统一的开流入口。
 *
 * 适配器只在调用方给了 `onTextDelta` 时才请求事件流；服务端仍返回 JSON 时
 * 自动回退到整段解析，行为与旧的 postJson 一致。
 */

import type { FetchLike } from './types.ts';

type Row = Record<string, unknown>;

export type SseEvent = { event: string; data: string };

export type ModelResponse = {
  streaming: boolean;
  parsed?: Row;
  response: Response;
};

const CRLF = /\r\n|\n|\r/;

function createParser(onEvent: (event: SseEvent) => void) {
  let buffer = '';
  let event = '';
  let data: string[] = [];

  const dispatch = () => {
    if (data.length > 0) onEvent({ event: event || 'message', data: data.join('\n') });
    event = '';
    data = [];
  };

  const line = (text: string) => {
    if (text === '') {
      dispatch();
      return;
    }
    if (text.startsWith(':')) return;
    const colon = text.indexOf(':');
    const field = colon < 0 ? text : text.slice(0, colon);
    let value = colon < 0 ? '' : text.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  };

  return {
    push(text: string) {
      buffer += text;
      for (;;) {
        const match = CRLF.exec(buffer);
        if (!match) break;
        // 分块边界正好落在 CRLF 中间时，等下一个块再处理。
        if (match[0] === '\r' && match.index === buffer.length - 1) break;
        const next = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        line(next);
      }
    },
    end() {
      if (buffer) line(buffer);
      buffer = '';
      dispatch();
    },
  };
}

export async function readSse(response: Response, onEvent: (event: SseEvent) => void): Promise<void> {
  if (!response.body) throw new Error('模型接口没有返回响应体');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = createParser(onEvent);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
    }
    parser.push(decoder.decode());
    parser.end();
  } finally {
    reader.releaseLock();
  }
}

export function isEventStream(response: Response): boolean {
  return (response.headers.get('content-type') ?? '').toLowerCase().includes('text/event-stream');
}

/** 统一开流：`stream=false` 时与 postJson 等价；`stream=true` 但服务端回 JSON 时也能解析。 */
export async function openModelResponse(
  fetchImpl: FetchLike,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal | undefined,
  stream: boolean,
): Promise<ModelResponse> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(stream ? { accept: 'text/event-stream' } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const text = await response.text();
    let detail = text.slice(0, 500);
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      if (parsed?.error !== undefined) detail = JSON.stringify(parsed.error).slice(0, 500);
    } catch {
      // 保留原始文本。
    }
    throw new Error(`模型接口返回 HTTP ${response.status}：${detail || '无响应体'}`);
  }
  if (stream && response.body && isEventStream(response)) {
    return { streaming: true, response };
  }
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('模型接口没有返回 JSON 对象');
  }
  return { streaming: false, response, parsed: parsed as Row };
}

export function parseJson(raw: string): Row {
  if (raw.trim() === '') return {};
  try {
    const value = JSON.parse(raw) as unknown;
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Row) : {};
  } catch {
    return {};
  }
}
