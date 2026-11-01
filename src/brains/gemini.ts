/**
 * Gemini generateContent 协议。
 *
 * 工具结果以 functionResponse 放进 user 轮次；工具调用是 part.functionCall。
 * Interactions 协议还没有稳定的公开形状，明确报错而不是猜一个能跑的实现。
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

export function geminiBrain(config: BrainConfig, fetchImpl: FetchLike): Brain {
  return {
    async complete(request: BrainRequest): Promise<BrainResponse> {
      const contents: Row[] = [];
      for (const message of request.messages) {
        if (message.role === 'user') {
          contents.push({ role: 'user', parts: [{ text: message.content }] });
        } else if (message.role === 'tool') {
          contents.push({
            role: 'user',
            parts: [{ functionResponse: { name: message.name, response: { content: message.content } } }],
          });
        } else {
          const parts: unknown[] = [];
          if (message.content) parts.push({ text: message.content });
          for (const call of message.toolCalls ?? []) {
            parts.push({ functionCall: { name: call.name, args: call.input } });
          }
          if (parts.length > 0) contents.push({ role: 'model', parts });
        }
      }

      const body: Row = {
        contents,
        systemInstruction: { parts: [{ text: request.system }] },
        generationConfig: { maxOutputTokens: request.maxTokens },
      };
      if (request.tools.length > 0) {
        body.tools = [
          {
            functionDeclarations: request.tools.map(tool => ({
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            })),
          },
        ];
      }

      const url = new URL(
        joinUrl(config.baseUrl, `/models/${encodeURIComponent(config.model)}:generateContent`),
      );
      if (config.apiKey) url.searchParams.set('key', config.apiKey);
      const parsed = await postJson(fetchImpl, url.toString(), {}, body, request.signal);

      const candidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];
      const candidate = (candidates[0] ?? {}) as Row;
      const content = (candidate.content ?? {}) as Row;
      const texts: string[] = [];
      const toolCalls: ToolCall[] = [];
      for (const item of Array.isArray(content.parts) ? content.parts : []) {
        const part = item as Row;
        if (typeof part.text === 'string') texts.push(part.text);
        if (part.functionCall && typeof part.functionCall === 'object') {
          const call = part.functionCall as Row;
          toolCalls.push({
            id: `call_${toolCalls.length}`,
            name: String(call.name ?? ''),
            input: typeof call.args === 'object' && call.args !== null && !Array.isArray(call.args)
              ? (call.args as Record<string, unknown>)
              : {},
          });
        }
      }
      const usage = (parsed.usageMetadata ?? {}) as Row;
      return {
        ...(texts.length > 0 ? { text: texts.join('\n') } : {}),
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        usage: {
          promptTokens: typeof usage.promptTokenCount === 'number' ? usage.promptTokenCount : undefined,
          completionTokens: typeof usage.candidatesTokenCount === 'number' ? usage.candidatesTokenCount : undefined,
        },
        stopReason: typeof candidate.finishReason === 'string' ? candidate.finishReason : '',
      };
    },
  };
}
