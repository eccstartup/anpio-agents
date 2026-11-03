import assert from 'node:assert/strict';
import test from 'node:test';
import { anthropicBrain } from '../src/brains/anthropic.ts';
import { openaiChatBrain } from '../src/brains/openai.ts';
import { readSse, type SseEvent } from '../src/brains/stream.ts';
import type { BrainConfig } from '../src/brains/types.ts';

function streamResponse(chunks: string[], contentType = 'text/event-stream'): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': contentType } },
  );
}

function event(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

const config: BrainConfig = { baseUrl: 'http://model.test', model: 'test-model', apiKey: 'k' };

test('SSE：CRLF、跨块拆分、注释与多行 data', async () => {
  const seen: SseEvent[] = [];
  const chunks = [
    ': keep-alive\r\n',
    'event: delta\r\ndata: {"a":',
    '1}\r',
    '\n\r\n',
    'data: line-1\ndata: line-2\n\n',
  ];
  await readSse(streamResponse(chunks), item => seen.push(item));
  assert.deepEqual(seen, [
    { event: 'delta', data: '{"a":1}' },
    { event: 'message', data: 'line-1\nline-2' },
  ]);
});

test('Anthropic：文本增量与工具参数增量', async () => {
  const deltas: string[] = [];
  const body = [
    event('message_start', { type: 'message_start', message: { usage: { input_tokens: 12 } } }),
    event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你' } }),
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '好' } }),
    event('content_block_start', {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'tu1', name: 'finish', input: {} },
    }),
    event('content_block_delta', {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '{"summary":' },
    }),
    event('content_block_delta', {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '"完成"}' },
    }),
    event('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } }),
  ].join('');
  const brain = anthropicBrain(config, async () => streamResponse([body.slice(0, 61), body.slice(61)]));
  const response = await brain.complete({
    system: 's',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    maxTokens: 128,
    signal: new AbortController().signal,
    onTextDelta: delta => deltas.push(delta),
  });
  assert.deepEqual(deltas, ['你', '好']);
  assert.equal(response.text, '你好');
  assert.deepEqual(response.toolCalls, [{ id: 'tu1', name: 'finish', input: { summary: '完成' } }]);
  assert.equal(response.usage?.promptTokens, 12);
  assert.equal(response.usage?.completionTokens, 9);
  assert.equal(response.stopReason, 'tool_use');
});

test('OpenAI Chat：增量文本、工具参数拼接与 usage', async () => {
  const deltas: string[] = [];
  const chunks = [
    'data: {"choices":[{"delta":{"content":"看"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"这里"},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":"{\\"pa"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"a.txt\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":7}}\n\n',
    'data: [DONE]\n\n',
  ];
  const brain = openaiChatBrain(config, async () => streamResponse(chunks));
  const response = await brain.complete({
    system: 's',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    maxTokens: 128,
    signal: new AbortController().signal,
    onTextDelta: delta => deltas.push(delta),
  });
  assert.deepEqual(deltas, ['看', '这里']);
  assert.equal(response.text, '看这里');
  assert.deepEqual(response.toolCalls, [{ id: 'call_1', name: 'read_file', input: { path: 'a.txt' } }]);
  assert.equal(response.usage?.promptTokens, 5);
  assert.equal(response.usage?.completionTokens, 7);
});

test('请求流式但服务端返回 JSON 时回退整段解析', async () => {
  const payload = {
    content: [{ type: 'text', text: '整段回答' }],
    usage: { input_tokens: 3, output_tokens: 4 },
    stop_reason: 'end_turn',
  };
  const deltas: string[] = [];
  const brain = anthropicBrain(config, async () =>
    new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } }),
  );
  const response = await brain.complete({
    system: 's',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    maxTokens: 128,
    signal: new AbortController().signal,
    onTextDelta: delta => deltas.push(delta),
  });
  assert.equal(response.text, '整段回答');
  assert.deepEqual(deltas, []);
});
