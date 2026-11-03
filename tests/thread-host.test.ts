import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Brain, BrainRequest, BrainResponse } from '../src/brains/types.ts';
import type { EmbeddedAgentDefinition } from '../src/definition.ts';
import { AgentRuntime } from '../src/runtime/agent.ts';
import { AgentStore } from '../src/store/agent-store.ts';
import { ThreadHost } from '../src/threads/host.ts';
import { threadTransport } from '../src/threads/transport.ts';
import type { InboundMessage, MessageSource } from '../src/threads/types.ts';

class FakeSource implements MessageSource {
  readonly id: string;
  readonly kind: 'interactive' | 'background';
  readonly acks: string[] = [];
  readonly nacks: string[] = [];
  private queue: InboundMessage[] = [];
  private emit: (() => void) | null = null;

  constructor(id: string, kind: 'interactive' | 'background') {
    this.id = id;
    this.kind = kind;
  }

  async open(emit: () => void): Promise<void> {
    this.emit = emit;
  }

  async poll(): Promise<InboundMessage[]> {
    return this.queue.splice(0);
  }

  async ack(message: InboundMessage): Promise<void> {
    this.acks.push(message.id);
  }

  async nack(message: InboundMessage): Promise<void> {
    this.nacks.push(message.id);
  }

  push(message: InboundMessage): void {
    this.queue.push(message);
    this.emit?.();
  }
}

class CountingBrain implements Brain {
  inFlight = 0;
  maxInFlight = 0;
  readonly texts: string[] = [];
  readonly delayMs: number;
  readonly failOn: string | null;

  constructor(delayMs = 2, failOn: string | null = null) {
    this.delayMs = delayMs;
    this.failOn = failOn;
  }

  async complete(request: BrainRequest): Promise<BrainResponse> {
    const last = [...request.messages].reverse().find(message => message.role === 'user');
    const text = last?.content ?? '';
    this.texts.push(text);
    if (this.failOn && text.includes(this.failOn)) throw new Error('模型故障');
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    await new Promise(resolve => setTimeout(resolve, this.delayMs));
    this.inFlight -= 1;
    return { text: `回答：${text.slice(0, 40)}` };
  }
}

function definition(concurrency = 2): EmbeddedAgentDefinition {
  const now = new Date().toISOString();
  return {
    id: 'thread-host-test',
    name: 'thread-host-test',
    description: '',
    capabilities: [],
    provider: { id: 'fake', protocol: 'openai-chat', baseUrl: 'http://127.0.0.1:1', model: 'fake', apiKeyEnv: null },
    systemPrompt: '',
    tools: ['finish'],
    scopes: [],
    limits: { maxTurns: 4, timeoutMs: 5_000, maxTokens: 512 },
    sandbox: { shell: false, shellTimeoutMs: 1_000, maxOutputBytes: 1_024 },
    enabled: true,
    concurrency,
    sessionIsolation: 'inline',
    completion: 'text',
    createdBy: null,
    createdAt: now,
    updatedAt: now,
    lastRunAt: null,
    lastError: null,
  };
}

async function withHost(
  run: (context: {
    host: ThreadHost;
    store: AgentStore;
    brain: CountingBrain;
    source: FakeSource;
  }) => Promise<void>,
  brain = new CountingBrain(),
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'thread-host-'));
  const runtime = await AgentRuntime.create({
    agentId: 'thread-host-test',
    definition: definition(),
    transport: threadTransport(),
    rootBase: dir,
    brain,
  });
  const store = new AgentStore(join(runtime.root, 'agent.db'));
  const source = new FakeSource('stdin', 'interactive');
  const host = new ThreadHost({ runtime, definition: definition(), store, sources: [source], tickMs: 0 });
  try {
    await host.start();
    await run({ host, store, brain, source });
  } finally {
    await host.stop();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('同一 thread 的多条消息在一轮里处理，all ack', async () => {
  await withHost(async ({ host, store, brain, source }) => {
    source.push({ id: 'm1', threadId: 'th', text: '第一句' });
    source.push({ id: 'm2', threadId: 'th', text: '第二句' });
    await host.settle();

    assert.equal(brain.texts.length, 1);
    assert.match(brain.texts[0]!, /第一句[\s\S]*第二句/);
    assert.deepEqual(source.acks.sort(), ['m1', 'm2']);
    assert.equal(source.nacks.length, 0);
    assert.equal(store.inboxByMessage('m1')?.status, 'acked');
    assert.equal(store.history('th').filter(row => row.direction === 'out').length, 1);
  });
});

test('不同 thread 并行受 concurrency 限制', async () => {
  const brain = new CountingBrain(20);
  await withHost(async ({ host, source }) => {
    source.push({ id: 'a', threadId: 'th-a', text: 'A' });
    source.push({ id: 'b', threadId: 'th-b', text: 'B' });
    await host.settle();
    assert.equal(brain.maxInFlight, 2);
  }, brain);
});

test('模型失败时 nack，消息退回来源与本地队列', async () => {
  const brain = new CountingBrain(1, '坏消息');
  await withHost(async ({ host, source }) => {
    source.push({ id: 'ok', threadId: 'th-ok', text: '好消息' });
    source.push({ id: 'bad', threadId: 'th-bad', text: '坏消息' });
    await host.settle();

    assert.deepEqual(source.acks, ['ok']);
    assert.deepEqual(source.nacks, ['bad']);
  }, brain);
});

test('交互来源优先占用并发槽位', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'thread-host-prio-'));
  const brain = new CountingBrain(1);
  const runtime = await AgentRuntime.create({
    agentId: 'thread-host-prio',
    definition: definition(1),
    transport: threadTransport(),
    rootBase: dir,
    brain,
  });
  const store = new AgentStore(join(runtime.root, 'agent.db'));
  const background = new FakeSource('platform', 'background');
  const interactive = new FakeSource('stdin', 'interactive');
  const host = new ThreadHost({
    runtime,
    definition: definition(1),
    store,
    sources: [background, interactive],
    tickMs: 0,
  });
  try {
    await host.start();
    background.push({ id: 'bg', threadId: 'bg-1', text: '后台任务' });
    interactive.push({ id: 'fg', threadId: 'fg-1', text: '本地任务' });
    await host.settle();
    assert.equal(brain.texts.length, 2);
    assert.match(brain.texts[0]!, /本地任务/);
  } finally {
    await host.stop();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
