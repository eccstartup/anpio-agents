/**
 * OpenAI Chat Completions 与 Responses 两种协议。
 *
 * Workers AI 的 REST 接口兼容 Chat Completions，直接复用同一个适配器。
 */

import {
  joinUrl,
  postJson,
  type Brain,
  type BrainConfig,
  type BrainRequest,
  type BrainResponse,
  type ChatMessage,
  type FetchLike,
  type ToolCall,
} from './types.ts';

type Row = Record<string, unknown>;

export function openaiChatBrain(config: BrainConfig, fetchImpl: FetchLike): Brain {
  return {
    async complete(request: BrainRequest): Promise<BrainResponse> {
      const body: Row = {
        model: config.model,
        messages: [
          { role: 'system', content: request.system },
          ...request.messages.map(toChatMessage),
        ],
        max_tokens: request.maxTokens,
      };
      if (request.tools.length > 0) {
        body.tools = request.tools.map(tool => ({
          type: 'function',
          function: { name: tool.name, description: tool.description, parameters: tool.parameters },
        }));
        body.tool_choice = 'auto';
      }
      const parsed = await postJson(
        fetchImpl,
        joinUrl(config.baseUrl, '/chat/completions'),
        authHeaders(config.apiKey),
        body,
        request.signal,
      );
      const choices = asArray(parsed.choices);
      const message = (choices[0] as Row | undefined)?.message as Row | undefined;
      if (!message) throw new Error('模型响应缺少 choices[0].message');
      const text = typeof message.content === 'string' ? message.content : undefined;
      const toolCalls: ToolCall[] = asArray(message.tool_calls).map((item, index) => {
        const call = item as Row;
        const fn = (call.function ?? {}) as Row;
        return {
          id: typeof call.id === 'string' ? call.id : `call_${index}`,
          name: String(fn.name ?? ''),
          input: parseArguments(fn.arguments),
        };
      });
      const usage = (parsed.usage ?? {}) as Row;
      return {
        ...(text ? { text } : {}),
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        usage: {
          promptTokens: numberOrUndefined(usage.prompt_tokens),
          completionTokens: numberOrUndefined(usage.completion_tokens),
        },
        stopReason: typeof choices[0] === 'object' ? String(((choices[0] as Row).finish_reason ?? '')) : '',
      };
    },
  };
}

export function openaiResponsesBrain(config: BrainConfig, fetchImpl: FetchLike): Brain {
  return {
    async complete(request: BrainRequest): Promise<BrainResponse> {
      const input: unknown[] = [];
      for (const message of request.messages) {
        if (message.role === 'user') {
          input.push({ role: 'user', content: [{ type: 'input_text', text: message.content }] });
        } else if (message.role === 'assistant') {
          if (message.content) {
            input.push({ role: 'assistant', content: [{ type: 'output_text', text: message.content }] });
          }
          for (const call of message.toolCalls ?? []) {
            input.push({
              type: 'function_call',
              call_id: call.id,
              name: call.name,
              arguments: JSON.stringify(call.input),
            });
          }
        } else {
          input.push({ type: 'function_call_output', call_id: message.toolCallId, output: message.content });
        }
      }
      const body: Row = {
        model: config.model,
        instructions: request.system,
        input,
        max_output_tokens: request.maxTokens,
      };
      if (request.tools.length > 0) {
        body.tools = request.tools.map(tool => ({
          type: 'function',
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        }));
      }
      const parsed = await postJson(
        fetchImpl,
        joinUrl(config.baseUrl, '/responses'),
        authHeaders(config.apiKey),
        body,
        request.signal,
      );
      const texts: string[] = [];
      const toolCalls: ToolCall[] = [];
      for (const item of asArray(parsed.output)) {
        const entry = item as Row;
        if (entry.type === 'function_call') {
          toolCalls.push({
            id: String(entry.call_id ?? entry.id ?? `call_${toolCalls.length}`),
            name: String(entry.name ?? ''),
            input: parseArguments(entry.arguments),
          });
          continue;
        }
        if (entry.type === 'message') {
          for (const part of asArray(entry.content)) {
            const content = part as Row;
            if (content.type === 'output_text' && typeof content.text === 'string') texts.push(content.text);
          }
        }
      }
      const usage = (parsed.usage ?? {}) as Row;
      return {
        ...(texts.length > 0 ? { text: texts.join('\n') } : {}),
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        usage: {
          promptTokens: numberOrUndefined(usage.input_tokens),
          completionTokens: numberOrUndefined(usage.output_tokens),
        },
        stopReason: typeof parsed.status === 'string' ? parsed.status : '',
      };
    },
  };
}

function toChatMessage(message: ChatMessage): Row {
  if (message.role === 'user') return { role: 'user', content: message.content };
  if (message.role === 'tool') {
    return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
  }
  return {
    role: 'assistant',
    content: message.content ?? null,
    ...(message.toolCalls?.length
      ? {
          tool_calls: message.toolCalls.map(call => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.input) },
          })),
        }
      : {}),
  };
}

function authHeaders(apiKey: string | null): Record<string, string> {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}

export function parseArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string' || raw.trim() === '') return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { value: parsed };
  } catch {
    return { raw };
  }
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
