/**
 * Anthropic Messages 协议。
 *
 * 与 OpenAI 的差异集中在两处：tool_result 必须放进 user 消息里，
 * 工具调用则是 assistant 内容块中的 tool_use。
 */

import {
  joinUrl,
  type Brain,
  type BrainConfig,
  type BrainRequest,
  type BrainResponse,
  type FetchLike,
  type ToolCall,
} from './types.ts';
import { openModelResponse, parseJson, readSse } from './stream.ts';

type Row = Record<string, unknown>;

export function anthropicBrain(config: BrainConfig, fetchImpl: FetchLike): Brain {
  return {
    async complete(request: BrainRequest): Promise<BrainResponse> {
      const messages: Row[] = [];
      const push = (role: 'user' | 'assistant', blocks: unknown[]) => {
        const last = messages[messages.length - 1];
        if (last && last.role === role && Array.isArray(last.content)) {
          (last.content as unknown[]).push(...blocks);
        } else {
          messages.push({ role, content: blocks });
        }
      };

      for (const message of request.messages) {
        if (message.role === 'user') {
          push('user', [{ type: 'text', text: message.content }]);
        } else if (message.role === 'tool') {
          push('user', [
            {
              type: 'tool_result',
              tool_use_id: message.toolCallId,
              content: message.content,
            },
          ]);
        } else {
          const blocks: unknown[] = [];
          if (message.content) blocks.push({ type: 'text', text: message.content });
          for (const call of message.toolCalls ?? []) {
            blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input });
          }
          if (blocks.length > 0) push('assistant', blocks);
        }
      }

      const body: Row = {
        model: config.model,
        max_tokens: request.maxTokens,
        system: request.system,
        messages,
      };
      if (request.tools.length > 0) {
        body.tools = request.tools.map(tool => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.parameters,
        }));
      }
      const headers: Record<string, string> = { 'anthropic-version': '2023-06-01' };
      if (config.apiKey) headers['x-api-key'] = config.apiKey;
      if (request.onTextDelta) body.stream = true;

      const opened = await openModelResponse(
        fetchImpl,
        joinUrl(config.baseUrl, '/v1/messages'),
        headers,
        body,
        request.signal,
        request.onTextDelta !== undefined,
      );
      if (opened.streaming) {
        return await readAnthropicStream(opened.response, request.onTextDelta);
      }
      const parsed = opened.parsed!;
      const texts: string[] = [];
      const toolCalls: ToolCall[] = [];
      for (const item of Array.isArray(parsed.content) ? parsed.content : []) {
        const block = item as Row;
        if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
        if (block.type === 'tool_use') {
          toolCalls.push({
            id: String(block.id ?? `call_${toolCalls.length}`),
            name: String(block.name ?? ''),
            input: typeof block.input === 'object' && block.input !== null && !Array.isArray(block.input)
              ? (block.input as Record<string, unknown>)
              : {},
          });
        }
      }
      const usage = (parsed.usage ?? {}) as Row;
      return {
        ...(texts.length > 0 ? { text: texts.join('\n') } : {}),
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        usage: {
          promptTokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined,
          completionTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined,
        },
        stopReason: typeof parsed.stop_reason === 'string' ? parsed.stop_reason : '',
      };
    },
  };
}

type StreamTool = { id: string; name: string; json: string; initial: Row | null };

async function readAnthropicStream(
  response: Response,
  onTextDelta?: (delta: string) => void,
): Promise<BrainResponse> {
  let text = '';
  let promptTokens: number | undefined;
  let completionTokens: number | undefined;
  let stopReason = '';
  const tools = new Map<number, StreamTool>();

  await readSse(response, sse => {
    const data = parseJson(sse.data);
    const type = typeof data.type === 'string' ? data.type : sse.event;
    if (type === 'message_start') {
      const usage = asRow(asRow(data.message).usage);
      if (typeof usage.input_tokens === 'number') promptTokens = usage.input_tokens;
      return;
    }
    if (type === 'content_block_start') {
      const block = asRow(data.content_block);
      const index = typeof data.index === 'number' ? data.index : tools.size;
      if (block.type === 'tool_use') {
        tools.set(index, {
          id: typeof block.id === 'string' ? block.id : `call_${index}`,
          name: typeof block.name === 'string' ? block.name : '',
          json: '',
          initial: asRow(block.input),
        });
      }
      return;
    }
    if (type === 'content_block_delta') {
      const delta = asRow(data.delta);
      if (delta.type === 'text_delta' && typeof delta.text === 'string') {
        text += delta.text;
        onTextDelta?.(delta.text);
      } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        const tool = tools.get(typeof data.index === 'number' ? data.index : -1);
        if (tool) tool.json += delta.partial_json;
      }
      return;
    }
    if (type === 'message_delta') {
      const delta = asRow(data.delta);
      if (typeof delta.stop_reason === 'string') stopReason = delta.stop_reason;
      const usage = asRow(data.usage);
      if (typeof usage.output_tokens === 'number') completionTokens = usage.output_tokens;
      return;
    }
    if (type === 'error') {
      throw new Error(`模型流返回错误：${JSON.stringify(data.error ?? data).slice(0, 500)}`);
    }
  });

  const toolCalls: ToolCall[] = [...tools.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, tool]) => ({
      id: tool.id,
      name: tool.name,
      input: tool.json ? parseJson(tool.json) : (tool.initial ?? {}),
    }));

  return {
    ...(text ? { text } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    usage: { promptTokens, completionTokens },
    stopReason,
  };
}

function asRow(value: unknown): Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Row) : {};
}
