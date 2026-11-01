/**
 * 模型协议适配器。
 *
 * 适配器只依赖注入的 fetch：这里用本地 mock 断言 URL、鉴权头、
 * 请求体形状与工具调用解析，不发任何真实网络请求。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { anthropicBrain } from '../src/brains/anthropic.ts';
import { decisionBrain } from '../src/brains/decision.ts';
import { geminiBrain } from '../src/brains/gemini.ts';
import { brainFor, resolveDecision } from '../src/brains/index.ts';
import { openaiChatBrain, openaiResponsesBrain } from '../src/brains/openai.ts';
import { scriptBrain } from '../src/brains/script.ts';
import type { BrainRequest, FetchLike } from '../src/brains/types.ts';
import type { EmbeddedProviderConfig } from '../src/definition.ts';

type Captured = { url: string; init: RequestInit };

function mockFetch(payload: unknown, captured: Captured[] = []): FetchLike {
  return async (input, init) => {
    captured.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

const request: BrainRequest = {
  system: '你是助手',
  messages: [{ role: 'user', content: '做点事' }],
  tools: [{ name: 'task_get', description: '读任务', parameters: { type: 'object', properties: {} } }],
  maxTokens: 512,
};

const bodyOf = (captured: Captured[]) => JSON.parse(String(captured[0]!.init.body)) as Record<string, any>;

test('openai-chat 适配器：URL、鉴权、工具调用解析', async () => {
  const captured: Captured[] = [];
  const brain = openaiChatBrain(
    { baseUrl: 'https://example.test/v1', model: 'test-model', apiKey: 'secret' },
    mockFetch(
      {
        choices: [
          {
            message: {
              content: '先看任务',
              tool_calls: [
                { id: 'call_1', type: 'function', function: { name: 'task_get', arguments: '{"taskId":"t1"}' } },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 4 },
      },
      captured,
    ),
  );
  const response = await brain.complete(request);
  assert.equal(captured[0]!.url, 'https://example.test/v1/chat/completions');
  const headers = captured[0]!.init.headers as Record<string, string>;
  assert.equal(headers.authorization, 'Bearer secret');
  const body = bodyOf(captured);
  assert.equal(body.model, 'test-model');
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.tools[0].function.name, 'task_get');
  assert.equal(response.text, '先看任务');
  assert.deepEqual(response.toolCalls, [{ id: 'call_1', name: 'task_get', input: { taskId: 't1' } }]);
  assert.deepEqual(response.usage, { promptTokens: 3, completionTokens: 4 });
});

test('openai-responses 适配器：input 项与函数调用', async () => {
  const captured: Captured[] = [];
  const brain = openaiResponsesBrain(
    { baseUrl: 'https://example.test/v1', model: 'test-model', apiKey: 'secret' },
    mockFetch(
      {
        output: [
          { type: 'message', content: [{ type: 'output_text', text: '好' }] },
          { type: 'function_call', call_id: 'call_9', name: 'task_get', arguments: '{"taskId":"t9"}' },
        ],
        usage: { input_tokens: 1, output_tokens: 2 },
      },
      captured,
    ),
  );
  const response = await brain.complete(request);
  assert.equal(captured[0]!.url, 'https://example.test/v1/responses');
  const body = bodyOf(captured);
  assert.ok(Array.isArray(body.input));
  assert.equal(body.input[0].role, 'user');
  assert.equal(body.tools[0].type, 'function');
  assert.equal(response.text, '好');
  assert.equal(response.toolCalls?.[0]?.input.taskId, 't9');
  assert.deepEqual(response.usage, { promptTokens: 1, completionTokens: 2 });
});

test('anthropic-messages 适配器：system 头与 tool_use', async () => {
  const captured: Captured[] = [];
  const brain = anthropicBrain(
    { baseUrl: 'https://example.test', model: 'claude-test', apiKey: 'secret' },
    mockFetch(
      {
        content: [
          { type: 'text', text: '看任务' },
          { type: 'tool_use', id: 'tu_1', name: 'task_get', input: { taskId: 't2' } },
        ],
        usage: { input_tokens: 5, output_tokens: 6 },
      },
      captured,
    ),
  );
  const response = await brain.complete(request);
  assert.equal(captured[0]!.url, 'https://example.test/v1/messages');
  const headers = captured[0]!.init.headers as Record<string, string>;
  assert.equal(headers['x-api-key'], 'secret');
  assert.equal(headers['anthropic-version'], '2023-06-01');
  const body = bodyOf(captured);
  assert.equal(body.system, '你是助手');
  assert.equal(body.tools[0].input_schema.type, 'object');
  assert.deepEqual(response.toolCalls?.[0]?.input, { taskId: 't2' });
  assert.deepEqual(response.usage, { promptTokens: 5, completionTokens: 6 });
});

test('gemini-generate 适配器：key 查询参数与 functionCall', async () => {
  const captured: Captured[] = [];
  const brain = geminiBrain(
    { baseUrl: 'https://example.test/v1beta', model: 'gemini-test', apiKey: 'secret' },
    mockFetch(
      {
        candidates: [
          {
            content: {
              parts: [{ text: '看任务' }, { functionCall: { name: 'task_get', args: { taskId: 't3' } } }],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3 },
      },
      captured,
    ),
  );
  const response = await brain.complete(request);
  assert.match(captured[0]!.url, /\/v1beta\/models\/gemini-test:generateContent\?key=secret$/);
  const body = bodyOf(captured);
  assert.equal(body.systemInstruction.parts[0].text, '你是助手');
  assert.equal(body.tools[0].functionDeclarations[0].name, 'task_get');
  assert.equal(response.toolCalls?.[0]?.input.taskId, 't3');
  assert.deepEqual(response.usage, { promptTokens: 2, completionTokens: 3 });
});

test('决策适配器与脚本适配器', async () => {
  const captured: Captured[] = [];
  const decision = decisionBrain(
    { baseUrl: 'https://example.test/decide', model: 'jev', apiKey: 'secret' },
    mockFetch({ answer: { interrupt: false }, confidence: 0.8 }, captured),
  );
  const decided = await decision.ask({ question: '要打断吗', schema: { type: 'object' } });
  assert.deepEqual(decided.answer, { interrupt: false });
  assert.equal(decided.confidence, 0.8);
  assert.equal(bodyOf(captured).question, '要打断吗');

  const script = scriptBrain({
    baseUrl: '',
    model: 'script',
    apiKey: null,
    script: [{ text: '开始' }, { tool: 'task_get', input: { taskId: 't' } }],
  });
  const first = await script.complete(request);
  assert.equal(first.text, '开始');
  const second = await script.complete(request);
  assert.equal(second.toolCalls?.[0]?.name, 'task_get');
  const third = await script.complete(request);
  assert.equal(third.toolCalls?.[0]?.name, 'finish');
});

test('brainFor：密钥只从环境变量读，未实现的协议明确报错', () => {
  const provider: EmbeddedProviderConfig = {
    id: 'custom',
    protocol: 'openai-chat',
    baseUrl: 'https://example.test/v1',
    model: 'm',
    apiKeyEnv: 'CUSTOM_API_KEY',
  };
  assert.throws(() => brainFor(provider, { env: {}, fetch: mockFetch({}) }), /CUSTOM_API_KEY/);
  assert.ok(brainFor(provider, { env: { CUSTOM_API_KEY: 'k' }, fetch: mockFetch({}) }));

  assert.throws(
    () =>
      brainFor(
        { ...provider, protocol: 'subscription-cli', apiKeyEnv: null },
        { env: {}, fetch: mockFetch({}) },
      ),
    /订阅型 CLI/,
  );
  assert.throws(
    () => resolveDecision({ ...provider, protocol: 'openai-chat' }, { env: { CUSTOM_API_KEY: 'k' } }),
    /决策协议/,
  );
});
