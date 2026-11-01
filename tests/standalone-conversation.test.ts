/**
 * 会话历史：按 threadId 落盘、注入下一轮、按条数/字节淘汰。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Brain, ChatMessage } from '../src/brains/types.ts';
import { normalizeDefinition } from '../src/standalone/config.ts';
import { ConversationStore } from '../src/standalone/conversation.ts';
import { createStandaloneRuntime, StandaloneAgent } from '../src/standalone/runner.ts';

function workspace(): string {
  return mkdtempSync(join(tmpdir(), 'anpio-history-'));
}

const user = (content: string): ChatMessage => ({ role: 'user', content });
const reply = (content: string): ChatMessage => ({ role: 'assistant', content });

test('会话历史：按 threadId 追加、重开实例仍可读，互不串台', async () => {
  const dir = workspace();
  try {
    const store = new ConversationStore({ dir });
    await store.append('thread-a', [user('第一问'), reply('第一答')]);
    await store.append('thread-a', [user('第二问'), reply('第二答')]);
    await store.append('thread-b', [user('另一个话题'), reply('另一个回答')]);
    await store.append('../不安全/../路径', [user('奇怪 id'), reply('照样落盘')]);

    assert.deepEqual(await store.load('thread-a'), [
      user('第一问'),
      reply('第一答'),
      user('第二问'),
      reply('第二答'),
    ]);
    assert.deepEqual(await store.load('thread-b'), [user('另一个话题'), reply('另一个回答')]);
    assert.deepEqual(await store.load('../不安全/../路径'), [user('奇怪 id'), reply('照样落盘')]);

    const reopened = new ConversationStore({ dir });
    assert.equal((await reopened.load('thread-a')).length, 4);
    assert.deepEqual(await reopened.load('没有用过的 id'), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('会话历史：超过条数上限时从最旧的成对消息淘汰', async () => {
  const dir = workspace();
  try {
    const store = new ConversationStore({ dir, maxMessages: 4 });
    for (let index = 1; index <= 5; index += 1) {
      await store.append('thread', [user(`问 ${index}`), reply(`答 ${index}`)]);
    }
    const loaded = await store.load('thread');
    assert.deepEqual(loaded, [user('问 4'), reply('答 4'), user('问 5'), reply('答 5')]);
    assert.equal(loaded[0]!.role, 'user');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('会话历史：超过字节上限时继续淘汰，且仍从用户消息开始', async () => {
  const dir = workspace();
  try {
    const store = new ConversationStore({ dir, maxBytes: 1_024 });
    for (let index = 1; index <= 6; index += 1) {
      await store.append('thread', [user(`${index}`.repeat(100)), reply('好'.repeat(100))]);
    }
    const loaded = await store.load('thread');
    assert.ok(loaded.length > 0);
    assert.equal(loaded[0]!.role, 'user');
    assert.ok(Buffer.byteLength(loaded.map(item => JSON.stringify(item)).join('\n')) <= 1_024);

    const oversized = new ConversationStore({ dir, maxBytes: 1_024 });
    await oversized.append('thread', [user('x'.repeat(2_000)), reply('好')]);
    assert.deepEqual(await oversized.load('thread'), [user('x'.repeat(2_000)), reply('好')]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('会话历史：同一 threadId 的第二轮能看到第一轮，不同 threadId 看不到', async () => {
  const dir = workspace();
  try {
    const definition = normalizeDefinition(
      {
        provider: { protocol: 'anthropic-messages', model: 'test', apiKeyEnv: null },
        tools: ['finish'],
        completion: 'text',
        concurrency: 1,
      },
      'thread-agent',
    );
    const root = join(dir, 'runs');
    const seen: ChatMessage[][] = [];
    const brain: Brain = {
      async complete(request) {
        seen.push([...request.messages]);
        return { text: `第 ${seen.length} 次回答` };
      },
    };
    const { runtime, transport } = await createStandaloneRuntime(definition, {
      root,
      brain,
      log: () => undefined,
    });
    const agent = new StandaloneAgent(runtime, transport, {
      conversations: new ConversationStore({ dir: join(root, '.local', 'conversations') }),
    });

    const first = await agent.run({ text: '第一问', threadId: 'thread-1' });
    assert.equal(first.result.status, 'succeeded');
    assert.equal(first.result.summary, '第 1 次回答');

    const second = await agent.run({ text: '第二问', threadId: 'thread-1' });
    assert.equal(second.result.status, 'succeeded');
    assert.equal(seen[1]!.length, 3);
    assert.deepEqual(seen[1]!.slice(0, 2), [user('第一问'), reply('第 1 次回答')]);
    assert.match((seen[1]![2] as { content: string }).content, /第二问/);

    await agent.run({ text: '换个话题', threadId: 'thread-2' });
    assert.equal(seen[2]!.length, 1);
    assert.match((seen[2]![0] as { content: string }).content, /换个话题/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('会话历史：失败的一轮不写入历史', async () => {
  const dir = workspace();
  try {
    const definition = normalizeDefinition(
      {
        provider: { protocol: 'anthropic-messages', model: 'test', apiKeyEnv: null },
        tools: ['finish'],
      },
      'failing-agent',
    );
    const root = join(dir, 'runs');
    const brain: Brain = {
      async complete() {
        return { text: '只回文本，但策略要求 finish' };
      },
    };
    const { runtime, transport } = await createStandaloneRuntime(definition, {
      root,
      brain,
      log: () => undefined,
    });
    const store = new ConversationStore({ dir: join(root, '.local', 'conversations') });
    const agent = new StandaloneAgent(runtime, transport, { conversations: store });

    const result = await agent.run({ text: '这一轮会失败', threadId: 'thread-1' });
    assert.equal(result.result.status, 'failed');
    assert.deepEqual(await store.load('thread-1'), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
