/**
 * Anthropic Messages 协议。
 *
 * 与 OpenAI 的差异集中在两处：tool_result 必须放进 user 消息里，
 * 工具调用则是 assistant 内容块中的 tool_use。
 */

import {
  joinUrl,
  postJson,
  type Brain,
  type BrainConfig,
  type BrainRequest,
  type BrainResponse,
  type FetchLike,
  type ToolCall,
} from './types.ts';

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

      const parsed = await postJson(
        fetchImpl,
        joinUrl(config.baseUrl, '/v1/messages'),
        headers,
        body,
        request.signal,
      );
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
