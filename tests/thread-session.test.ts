/**
 * 长期 Turn：同一 thread 多轮复用 workspace；重启后继续；历史不含工具调用。
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Brain, BrainResponse } from '../src/brains/types.ts';
import type { EmbeddedAgentDefinition, EmbeddedTool } from '../src/definition.ts';
import { AnpClient } from '../src/anp/client.ts';
import { loadOrCreateIdentity, type ServiceEndpoints } from '../src/anp/identity.ts';
import { createAnpService } from '../src/anp/service.ts';
import { AgentRuntime } from '../src/runtime/agent.ts';
import { AnpMailbox } from '../src/runtime/anp/mailbox.ts';
import { AnpTurnLedger } from '../src/runtime/anp/ledger.ts';
import { AnpTurnSession } from '../src/runtime/anp/session.ts';
import { ANP_ENVIRONMENT, buildThreadContext } from '../src/runtime/anp/context.ts';
import type { AgentTransport } from '../src/runtime/transport.ts';
import { AgentStore } from '../src/store/agent-store.ts';
import { RouterStore } from '../src/store/router-store.ts';

const endpoints: ServiceEndpoints = {
  didBaseUrl: 'http://127.0.0.1:8788',
  publicUrl: 'http://127.0.0.1:0',
  rpcPath: '/anp-im/rpc',
};

class ScriptedBrain implements Brain {
  private index = 0;
  private readonly steps: Array<{ text?: string; tool?: string; input?: Record<string, unknown> }>;

  constructor(steps: Array<{ text?: string; tool?: string; input?: Record<string, unknown> }>) {
    this.steps = steps;
  }

  async complete(): Promise<BrainResponse> {
    const step = this.steps[this.index];
    this.index += 1;
    if (!step) return { text: '' };
    if (step.tool) {
      return { toolCalls: [{ id: `call-${this.index}`, name: step.tool, input: step.input ?? {} }] };
    }
    return step.text === undefined ? {} : { text: step.text };
  }
}

function definition(id: string, tools: EmbeddedTool[]): EmbeddedAgentDefinition {
  const now = new Date().toISOString();
  return {
    id,
    name: id,
    description: '',
    capabilities: ['test'],
    provider: {
      id: 'fake',
      protocol: 'openai-chat',
      baseUrl: 'http://127.0.0.1:1',
      model: 'fake',
      apiKeyEnv: null,
    },
    systemPrompt: '你是测试智能体。',
    tools,
    scopes: ['mailbox:read', 'mailbox:write'],
    limits: { maxTurns: 10, timeoutMs: 20_000, maxTokens: 1_024 },
    sandbox: { shell: false, shellTimeoutMs: 1_000, maxOutputBytes: 4_096 },
    enabled: true,
    concurrency: 1,
    completion: 'finish',
    createdBy: null,
    createdAt: now,
    updatedAt: now,
    lastRunAt: null,
    lastError: null,
  };
}

function transport(): AgentTransport {
  const unused = async () => {
    throw new Error('本测试不使用 AgentRuntime 的传输层');
  };
  return {
    mailbox: {
      open: unused as never,
      pull: unused as never,
      message: unused as never,
      ack: unused as never,
      nack: unused as never,
      close: async () => undefined,
    },
    runs: {
      heartbeat: async () => undefined,
      log: async () => undefined,
      finish: async () => undefined,
      status: async () => ({ status: 'running' }),
    },
    presence: { heartbeat: async () => undefined },
    supportsTool: () => true,
    environment: ANP_ENVIRONMENT,
  };
}

function multibaseOf(identity: { publicKey: unknown }): string {
  const key = identity.publicKey as { publicKeyMultibase?: string };
  assert.ok(key.publicKeyMultibase, '测试身份必须是 Ed25519 multibase');
  return key.publicKeyMultibase;
}

test('ANP Turn：同一个 thread 多轮复用 workspace，重启后继续，历史不含工具调用', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anp-turn-'));
  const alice = await loadOrCreateIdentity(join(dir, 'alice'), endpoints, 'alice');
  const bob = await loadOrCreateIdentity(join(dir, 'bob'), endpoints, 'bob');
  const keys = new Map([
    [alice.did, multibaseOf(alice)],
    [bob.did, multibaseOf(bob)],
  ]);
  const service = createAnpService({
    directory: join(dir, 'anp'),
    listen: { host: '127.0.0.1', port: 0 },
    publicUrl: endpoints.publicUrl,
    didBaseUrl: endpoints.didBaseUrl,
    localKeys: () => keys,
    log: () => {},
  });
  const aliceStore = new AgentStore(join(dir, 'alice-store', 'agent.db'));
  const bobStore = new AgentStore(join(dir, 'bob', 'agent.db'));
  const router = new RouterStore(join(dir, 'router.db'));
  const agentRoot = join(dir, 'agents');
  const threadId = 'thread-1';
  const sessionId = 'sess-1';
  try {
    const aliceBox = new AnpMailbox({
      store: aliceStore,
      client: new AnpClient({ identity: alice, call: service.call }),
      threadId,
    });
    const bobDefinition = definition('bob', ['write_file', 'read_file', 'finish']);
    const runtime1 = await AgentRuntime.create({
      agentId: 'bob',
      definition: bobDefinition,
      transport: transport(),
      rootBase: agentRoot,
      brain: new ScriptedBrain([
        { tool: 'write_file', input: { path: 'note.txt', content: 'hello-workspace' } },
        { tool: 'finish', input: { summary: '写好了', outcome: 'done' } },
        { tool: 'read_file', input: { path: 'note.txt' } },
        { tool: 'finish', input: { summary: '读完了', outcome: 'done' } },
      ]),
    });

    const first = await aliceBox.send({
      targetDid: bob.did,
      payload: { type: 'anp.task.request', task_id: 'task-1', title: '写个文件', text: '把 hello 写进 note.txt' },
    });
    router.ensureThread({ threadId, ownerAgentId: 'bob' });
    router.ensureSession({ sessionId, agentId: 'bob', threadId, state: 'idle' });

    const run = async (
      runtime: AgentRuntime,
      turnId: string,
      runId: string,
      mailbox: AnpMailbox,
      triggerMessageId: string,
    ) => {
      const turn = `turn-${turnId}`;
      const agentRun = `run-${runId}`;
      assert.equal(router.claimSession(sessionId, turn), true);
      const ledger = new AnpTurnLedger({
        router,
        store: bobStore,
        sessionId,
        turnId: turn,
        agentId: 'bob',
        threadId,
        runId: agentRun,
      });
      const result = await new AnpTurnSession({
        runtime,
        store: bobStore,
        mailbox,
        ledger,
        session: router.getSession(sessionId)!,
        turnId: turn,
        runId: agentRun,
        threadId,
        triggerMessageId,
      }).run();
      router.releaseSession(sessionId);
      return { result, turn: agentRun };
    };

    const bobBox1 = new AnpMailbox({
      store: bobStore,
      client: new AnpClient({ identity: bob, call: service.call }),
      threadId,
    });
    const firstRun = await run(runtime1, '1', '1', bobBox1, first.messageId);
    assert.equal(firstRun.result.status, 'succeeded');
    assert.equal(firstRun.result.summary, '写好了');
    assert.equal(firstRun.result.turns, 2);
    const notesPath = join(agentRoot, 'bob', 'workspace', 'threads', threadId, 'note.txt');
    assert.equal(await readFile(notesPath, 'utf8'), 'hello-workspace');

    const replied = await aliceBox.sync();
    assert.equal(replied.added, 1);
    const aliceSession = await aliceBox.open({ label: 'alice-check' });
    const aliceInbox = await aliceBox.pull(aliceSession.id);
    assert.equal(aliceInbox.items.length, 1);
    assert.equal(aliceInbox.items[0]!.kind, 'anp.chat.message');
    const reply = await aliceBox.message(aliceInbox.items[0]!.id);
    const replyBody = reply.content as { body: { payload: { text: string }; reply_to?: string } };
    assert.equal(replyBody.body.payload.text, '写好了');
    assert.equal(replyBody.body.reply_to, first.messageId);

    // 重启：新的 runtime / 新的 mailbox 实例，同一个 agent.db 与 workspace。
    const runtime2 = await AgentRuntime.create({
      agentId: 'bob',
      definition: bobDefinition,
      transport: transport(),
      rootBase: agentRoot,
      brain: new ScriptedBrain([
        { tool: 'read_file', input: { path: 'note.txt' } },
        { tool: 'finish', input: { summary: '读完了', outcome: 'done' } },
      ]),
    });
    const second = await aliceBox.send({
      targetDid: bob.did,
      payload: { type: 'anp.chat.message', text: '再读一遍 note.txt' },
    });
    const bobBox2 = new AnpMailbox({
      store: bobStore,
      client: new AnpClient({ identity: bob, call: service.call }),
      threadId,
    });
    const secondRun = await run(runtime2, '2', '2', bobBox2, second.messageId);
    assert.equal(secondRun.result.status, 'succeeded');
    assert.equal(secondRun.result.summary, '读完了');
    assert.equal(await readFile(notesPath, 'utf8'), 'hello-workspace', 'workspace 跨 turn 保留');

    const context = buildThreadContext(bobStore, threadId);
    assert.equal(context.messages.some(message => message.role === 'tool'), false, '工具调用不进历史');
    const rendered = context.messages.map(message => message.content ?? '').join('\n');
    assert.equal(rendered.includes('调用工具'), false);
    assert.equal(rendered.includes('写个文件'), true);
    assert.equal(rendered.includes('再读一遍 note.txt'), true);

    assert.equal(router.getTurn('turn-1')?.status, 'succeeded');
    assert.equal(router.getTurn('turn-2')?.status, 'succeeded');
    assert.equal(bobStore.db.get<{ status: string }>('SELECT status FROM turns WHERE turn_id = ?', 'turn-1')?.status, 'succeeded');
  } finally {
    aliceStore.close();
    bobStore.close();
    router.close();
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
});
