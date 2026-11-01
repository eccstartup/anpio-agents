/**
 * 模型适配层的公共形状。
 *
 * 适配器只做协议翻译：把同一份对话与工具清单变成各家请求，再把响应变回
 * 文本 / 工具调用。运行时不关心是哪一家，测试也只需要 mock 一个 fetch。
 */

export type ToolCall = { id: string; name: string; input: Record<string, unknown> };

export type ToolSpec = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type ChatMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content?: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export type BrainRequest = {
  system: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  maxTokens: number;
  signal?: AbortSignal;
};

export type BrainUsage = { promptTokens?: number; completionTokens?: number };

export type BrainResponse = {
  text?: string;
  toolCalls?: ToolCall[];
  usage?: BrainUsage;
  stopReason?: string;
};

export interface Brain {
  complete(request: BrainRequest): Promise<BrainResponse>;
}

export interface DecisionBrain {
  ask(request: {
    question: string;
    schema: Record<string, unknown>;
    context?: unknown;
  }): Promise<{ answer: unknown; confidence?: number }>;
}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type BrainConfig = {
  baseUrl: string;
  model: string;
  apiKey: string | null;
  /** 只给 script 协议用。 */
  script?: { text?: string; tool?: string; input?: Record<string, unknown> }[];
};

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
}

export async function postJson(
  fetchImpl: FetchLike,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal,
  });
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const message =
      parsed && typeof parsed === 'object' && 'error' in parsed
        ? JSON.stringify((parsed as { error: unknown }).error).slice(0, 500)
        : text.slice(0, 500);
    throw new Error(`模型接口返回 HTTP ${response.status}：${message || '无响应体'}`);
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('模型接口没有返回 JSON 对象');
  return parsed as Record<string, unknown>;
}

/** 模型调用出错时保留原始信息，但不要把它拼成整页日志。 */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
