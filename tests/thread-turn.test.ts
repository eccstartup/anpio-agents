import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Brain, BrainRequest, BrainResponse, ChatMessage } from '../src/brains/types.ts';
import type { EmbeddedAgentDefinition } from '../src/definition.ts';
import { AgentRuntime } from '../src/runtime/agent.ts';
import { AgentStore } from '../src/store/agent-store.ts';
import { ThreadHost } from '../src/threads/host.ts';
import { threadTransport } from '../src/threads/transport.ts';
import type { InboundMessage, MessageSource, ThreadEvent } from '../src/threads/types.ts';

class ScriptedBrain implements Brain {
  readonly requests: Array<{ system: string; messages: ChatMessage[] }> = [];
  private readonly scripts: Array<string | Error>;

  constructor(scripts: Array<string | Error>) {
    this.scripts = scripts;
  }

  async complete(request: BrainRequest): Promise<BrainResponse> {
    this.requests.push({
      system: request.system,
      messages: request.messages.map(message => ({ ...message })),
    });
    const script = this.scripts[this.requests.length - 1];
    if (script instanceof Error) throw script;
    return { text: script ?? '结束' };
  }
}

class FakeSource implements MessageSource {
  readonly id = 'stdin';
  readonly kind = 'interactive' as const;
  readonly acks: string[] = [];
  readonly nacks: string[] = [];
  private queue: InboundMessage[] = [];
  private emit: (() => void) | null = null;

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

function definition(): EmbeddedAgentDefinition {
  const now = new Date().toISOString();
  return {
    id: 'thread-turn-test',
    name: 'thread-turn-test',
    description: '',
    capabilities: [],
    provider: { id: 'fake', protocol: 'openai-chat', baseUrl: 'http://127.0.0.1:1', model: 'fake', apiKeyEnv: null },
    systemPrompt: '',
    tools: ['finish'],
    scopes: [],
    limits: { maxTurns: 4, timeoutMs: 5_000, maxTokens: 512 },
    sandbox: { shell: false, shellTimeoutMs: 1_000, maxOutputBytes: 1_024 },
    enabled: true,
    concurrency: 2,
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
  brain: Brain,
  run: (context: {
    host: ThreadHost;
    store: AgentStore;
    source: FakeSource;
    root: string;
    events: ThreadEvent[];
  }) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'thread-turn-'));
  const runtime = await AgentRuntime.create({
    agentId: 'thread-turn-test',
    definition: definition(),
    transport: threadTransport(),
    rootBase: dir,
    brain,
  });
  const store = new AgentStore(join(runtime.root, 'agent.db'));
  const source = new FakeSource();
  const events: ThreadEvent[] = [];
  const host = new ThreadHost({
    runtime,
    definition: definition(),
    store,
    sources: [source],
    tickMs: 0,
    onEvent: event => events.push(event),
  });
  try {
    await host.start();
    await run({ host, store, source, root: runtime.root, events });
  } finally {
    await host.stop();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('同一 thread 的第二轮带上历史与上一轮回答，workspace 跨 turn 保留', async () => {
  const brain = new ScriptedBrain(['第一轮完成', '第二轮完成']);
  await withHost(brain, async ({ host, source, root }) => {
    source.push({ id: 'm1', threadId: 'th', text: '第一条' });
    await host.settle();

    const workspace = join(root, 'workspace', 'threads', 'th');
    await access(join(workspace, 'AGENTS.md'));
    await writeFile(join(workspace, 'marker.txt'), '保留\n');

    source.push({ id: 'm2', threadId: 'th', text: '第二条' });
    await host.settle();

    assert.equal(brain.requests.length, 2);
    const second = brain.requests[1]!;
    const history = second.messages.map(message => message.content ?? '').join('\n');
    assert.match(history, /第一条/);
    assert.match(history, /第一轮完成/);
    assert.match(history, /第二条/);
    assert.match(second.system, /thread：th/);
    assert.equal(await readFile(join(workspace, 'marker.txt'), 'utf8'), '保留\n');
    assert.deepEqual(source.acks, ['m1', 'm2']);
  });
});

test('没有结束信号时 nack，消息留在队列且不写回答', async () => {
  const brain = new ScriptedBrain(['']);
  await withHost(brain, async ({ host, store, source }) => {
    source.push({ id: 'm1', threadId: 'th', text: '坏消息' });
    await host.settle();

    assert.deepEqual(source.nacks, ['m1']);
    assert.equal(store.inboxByMessage('m1')?.status, 'pending');
    assert.equal(store.history('th').filter(row => row.direction === 'out').length, 0);
  });
});

test('事件顺序：turn-start 在最前，turn-end 在最后', async () => {
  const brain = new ScriptedBrain(['回答']);
  await withHost(brain, async ({ host, source, events }) => {
    source.push({ id: 'm1', threadId: 'th', text: '你好' });
    await host.settle();

    const visible = events.filter(event => event.type !== 'log');
    assert.equal(visible[0]?.type, 'turn-start');
    assert.equal(visible.at(-1)?.type, 'turn-end');
    const text = visible.findIndex(event => event.type === 'assistant-text');
    assert.ok(text > 0);
    assert.ok(text < visible.length - 1);
    assert.deepEqual(
      visible.map(event => event.threadId),
      visible.map(() => 'th'),
    );
  });
});
