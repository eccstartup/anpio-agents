/**
 * 跨域投递：配置、目标策略、本地优先 relay、双向端到端与一次性 thread 归档。
 *
 * 不依赖真实公网：relay 替身把请求直接交给另一个 `createAnpService`。
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  ANP_PROFILE,
  ANP_SECURITY_PROFILE,
  ANP_TARGET_KIND,
  buildMessageRequest,
  buildOriginProofAuth,
  ed25519OriginProofSigner,
  type AnpMeta,
} from '@anpio-cli/core';
import type { Relay } from '@anpio-cli/service';
import type { Brain, BrainResponse } from '../src/brains/types.ts';
import { AnpClient } from '../src/anp/client.ts';
import { loadOrCreateIdentity, type ServiceEndpoints } from '../src/anp/identity.ts';
import { createAnpService, type AnpService, type DeliveredEvent } from '../src/anp/service.ts';
import { didHostAllowed, didHostOf, parseAllowedHost } from '../src/router/cross-domain.ts';
import { parseRouterConfig } from '../src/router/config.ts';
import { Delivery } from '../src/router/delivery.ts';
import type { AgentHost } from '../src/router/agent-host.ts';
import { startRouter, type RouterRuntime } from '../src/router/router.ts';
import { AnpMailbox } from '../src/runtime/anp/mailbox.ts';
import { AgentStore } from '../src/store/agent-store.ts';
import { RouterStore } from '../src/store/router-store.ts';

const endpoints: ServiceEndpoints = {
  didBaseUrl: 'http://127.0.0.1:8788',
  publicUrl: 'http://127.0.0.1:0',
  rpcPath: '/anp-im/rpc',
};

function multibaseOf(identity: { publicKey: unknown }): string {
  const key = identity.publicKey as { publicKeyMultibase?: string };
  assert.ok(key.publicKeyMultibase, '测试身份必须是 Ed25519 multibase');
  return key.publicKeyMultibase;
}

function rawConfig(dir: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    root: join(dir, 'root'),
    didBaseUrl: 'http://127.0.0.1:8788',
    publicUrl: 'http://127.0.0.1:8787',
    listen: { host: '127.0.0.1', port: 0 },
    anpListen: { host: '127.0.0.1', port: 0 },
    agentsFile: join(dir, 'agents.json'),
    watchIntervalMs: 0,
    sweepIntervalMs: 0,
    childScanIntervalMs: 0,
    scheduleTickIntervalMs: 0,
    ...overrides,
  };
}

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

function agent(id: string, capabilities: string[]): Record<string, unknown> {
  return {
    id,
    name: id,
    description: '',
    capabilities,
    provider: {
      protocol: 'openai-chat',
      baseUrl: 'http://127.0.0.1:1',
      model: 'fake',
      apiKeyEnv: null,
    },
    systemPrompt: `你是 ${id}。`,
    tools: ['read_file', 'write_file', 'finish'],
    scopes: ['mailbox:read', 'mailbox:write'],
    limits: { maxTurns: 10, timeoutMs: 20_000, maxTokens: 1_024 },
    anp: { allowSchedules: false, isolation: 'inline' },
  };
}

async function withRouter(
  options: {
    agents: unknown[];
    brains: Record<string, Brain>;
    crossDomain?: { enabled: boolean; allowedDidHosts: string[] };
    relay?: Relay;
  },
  run: (router: RouterRuntime, dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'anp-cross-router-'));
  try {
    await writeFile(join(dir, 'agents.json'), JSON.stringify({ agents: options.agents }));
    const config = parseRouterConfig(
      rawConfig(dir, {
        ...(options.crossDomain ? { crossDomain: options.crossDomain } : {}),
        ephemeralThreadTtlMs: 60_000,
        ephemeralSweepIntervalMs: 0,
      }),
      { baseDir: dir, env: {} },
    );
    const router = await startRouter({
      config,
      brains: options.brains,
      listen: false,
      log: () => undefined,
      ...(options.relay ? { relay: options.relay } : {}),
    });
    try {
      await run(router, dir);
    } finally {
      await router.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function recordingRelay(): { relay: Relay; seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    relay: {
      async forward(_request, targetDid) {
        seen.push(targetDid);
        return {
          kind: 'answered',
          result: {
            accepted: true,
            target_did: targetDid,
            conversation_id: 'thread-remote',
            accepted_at: new Date().toISOString(),
          },
        };
      },
    },
  };
}

async function forwardTo(
  target: AnpService,
  request: unknown,
  targetDid: string,
  seen: string[],
): Promise<Awaited<ReturnType<Relay['forward']>>> {
  seen.push(targetDid);
  const reply = await target.handleRpc({
    body: JSON.stringify(request),
    headers: {},
    url: new URL(`${endpoints.publicUrl}${endpoints.rpcPath}`),
  });
  const parsed = JSON.parse(reply.body) as {
    result?: Record<string, unknown>;
    error?: { code?: number; message?: string };
  };
  if (parsed.error) {
    return {
      kind: 'refused',
      rejection: {
        code: parsed.error.code ?? -32_603,
        retryable: false,
        message: parsed.error.message ?? 'refused',
      },
    };
  }
  return { kind: 'answered', result: parsed.result ?? {} };
}

function sendRequest(
  input: {
    sender: Awaited<ReturnType<typeof loadOrCreateIdentity>>;
    targetDid: string;
    messageId: string;
    requestId: string;
    conversationId?: string;
  },
): Promise<unknown> {
  const meta: AnpMeta = {
    profile: ANP_PROFILE.directBase,
    security_profile: ANP_SECURITY_PROFILE.transportProtected,
    sender_did: input.sender.did,
    target: { kind: ANP_TARGET_KIND.agent, did: input.targetDid },
    operation_id: `send:${input.messageId}`,
    message_id: input.messageId,
    content_type: 'application/json',
  };
  const body = {
    payload: { type: 'anp.chat.message', text: 'hello' },
    ...(input.conversationId !== undefined ? { conversation_id: input.conversationId } : {}),
  };
  return buildOriginProofAuth({
    method: 'direct.send',
    meta,
    body,
    signer: ed25519OriginProofSigner(input.sender.priv, input.sender.keyid),
  }).then(auth =>
    Promise.resolve(
      buildMessageRequest({ id: input.requestId, method: 'direct.send', meta, body, auth }),
    ),
  );
}

test('跨域配置：默认关闭；启用必须有允许域名；环境变量可覆盖', () => {
  const dir = '/tmp/anp-cross-config';
  const defaults = parseRouterConfig(rawConfig(dir), { baseDir: dir, env: {} });
  assert.equal(defaults.crossDomain.enabled, false);
  assert.deepEqual(defaults.crossDomain.allowedDidHosts, []);
  assert.equal(defaults.ephemeralThreadTtlMs, 3_600_000);
  assert.equal(defaults.ephemeralSweepIntervalMs, 60_000);

  assert.throws(
    () => parseRouterConfig(
      rawConfig(dir, { crossDomain: { enabled: true } }),
      { baseDir: dir, env: {} },
    ),
    /至少配置一个允许的域名/,
  );
  assert.throws(
    () => parseRouterConfig(
      rawConfig(dir, { crossDomain: { enabled: false, allowedDidHosts: ['https://agent.example.com'] } }),
      { baseDir: dir, env: {} },
    ),
    /不是合法域名/,
  );

  const fromEnv = parseRouterConfig(rawConfig(dir), {
    baseDir: dir,
    env: {
      ANP_CROSS_DOMAIN: '1',
      ANP_ALLOWED_DID_HOSTS: 'agent.example.com, *.partner.example',
      ANP_EPHEMERAL_THREAD_TTL_MS: '0',
      ANP_EPHEMERAL_SWEEP_INTERVAL_MS: '5000',
    },
  });
  assert.equal(fromEnv.crossDomain.enabled, true);
  assert.deepEqual(fromEnv.crossDomain.allowedDidHosts, ['agent.example.com', '*.partner.example']);
  assert.equal(fromEnv.ephemeralThreadTtlMs, 0);
  assert.equal(fromEnv.ephemeralSweepIntervalMs, 5_000);

  assert.throws(
    () => parseRouterConfig(rawConfig(dir), {
      baseDir: dir,
      env: { ANP_CROSS_DOMAIN: 'maybe' },
    }),
    /不是布尔值/,
  );
});

test('跨域目标：只按 DID 域名匹配，支持精确与 *. 子域', () => {
  assert.equal(didHostOf('did:wba:agent.example:agents:a:e1_x'), 'agent.example');
  assert.equal(didHostOf('did:web:agent.example%3A8443:agents:a'), 'agent.example');
  assert.equal(didHostOf('did:wba:127.0.0.1:8788:agents:a'), '127.0.0.1');
  assert.equal(didHostOf('did:key:z6Mkabc'), undefined);
  assert.equal(didHostOf('did:wba:agent.example%253A8443:agents:a'), undefined);

  assert.equal(parseAllowedHost(' Agent.Example.COM '), 'agent.example.com');
  assert.equal(parseAllowedHost('*.partner.example'), '*.partner.example');
  assert.equal(parseAllowedHost('*.'), null);
  assert.equal(parseAllowedHost('agent.example.com:8443'), null);
  assert.equal(parseAllowedHost('https://agent.example.com'), null);
  assert.equal(parseAllowedHost('agent.example.com/path'), null);

  const allowed = ['agent.example.com', '*.partner.example'];
  assert.equal(didHostAllowed('did:wba:agent.example.com:agents:a:e1_x', allowed), true);
  assert.equal(didHostAllowed('did:wba:eu.partner.example:agents:a:e1_x', allowed), true);
  assert.equal(didHostAllowed('did:wba:partner.example:agents:a:e1_x', allowed), false);
  assert.equal(didHostAllowed('did:wba:evil.example:agents:a:e1_x', allowed), false);
  assert.equal(didHostAllowed('did:key:z6Mkabc', allowed), false);
});

test('跨域服务：本机目标不经过 relay，外部目标原样转发', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anp-cross-service-'));
  const alice = await loadOrCreateIdentity(join(dir, 'alice'), endpoints, 'alice');
  const bob = await loadOrCreateIdentity(join(dir, 'bob'), endpoints, 'bob');
  const keys = new Map([
    [alice.did, multibaseOf(alice)],
    [bob.did, multibaseOf(bob)],
  ]);
  const seen: string[] = [];
  const relay: Relay = {
    async forward(_request, targetDid) {
      seen.push(targetDid);
      return {
        kind: 'answered',
        result: { accepted: true, target_did: targetDid, conversation_id: 'thread-external' },
      };
    },
  };
  const service = await createAnpService({
    directory: join(dir, 'anp'),
    listen: { host: '127.0.0.1', port: 0 },
    publicUrl: endpoints.publicUrl,
    didBaseUrl: endpoints.didBaseUrl,
    localKeys: () => keys,
    crossDomain: {
      localTargets: () => new Set([alice.did]),
      allowedDidHosts: ['partner.example'],
      relay,
    },
    log: () => {},
  });
  try {
    const local = await service.call(await sendRequest({
      sender: alice,
      targetDid: alice.did,
      messageId: 'msg-local',
      requestId: 'r-local',
      conversationId: 'thread-local',
    })) as { result?: { accepted?: boolean } };
    assert.equal(local.result?.accepted, true);
    assert.deepEqual(seen, [], '本机目标不应调用 relay.forward');
    assert.equal(service.storage.headSeq(alice.did), 1, '本机目标应直接落库');

    const external = 'did:wba:eu.partner.example:agents:bob:e1_abc';
    const forwarded = await service.call(await sendRequest({
      sender: alice,
      targetDid: external,
      messageId: 'msg-external',
      requestId: 'r-external',
      conversationId: 'thread-external',
    })) as { result?: { accepted?: boolean } };
    assert.equal(forwarded.result?.accepted, true);
    assert.deepEqual(seen, [external]);
    assert.equal(service.storage.headSeq(external), 0, '外部目标不在本服务落库');
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('跨域端到端：两个服务双向投递、自动回复路径与幂等重放', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anp-cross-e2e-'));
  const alice = await loadOrCreateIdentity(join(dir, 'alice'), endpoints, 'alice');
  const bob = await loadOrCreateIdentity(join(dir, 'bob'), endpoints, 'bob');
  const keys = new Map([
    [alice.did, multibaseOf(alice)],
    [bob.did, multibaseOf(bob)],
  ]);
  const seenByA: string[] = [];
  const seenByB: string[] = [];
  let a: AnpService | undefined;
  let b: AnpService | undefined;
  a = await createAnpService({
    directory: join(dir, 'a'),
    listen: { host: '127.0.0.1', port: 0 },
    publicUrl: endpoints.publicUrl,
    didBaseUrl: endpoints.didBaseUrl,
    localKeys: () => keys,
    crossDomain: {
      localTargets: () => new Set([alice.did]),
      relay: { forward: (request, targetDid) => forwardTo(b!, request, targetDid, seenByB) },
    },
    log: () => {},
  });
  b = await createAnpService({
    directory: join(dir, 'b'),
    listen: { host: '127.0.0.1', port: 0 },
    publicUrl: endpoints.publicUrl,
    didBaseUrl: endpoints.didBaseUrl,
    localKeys: () => keys,
    crossDomain: {
      localTargets: () => new Set([bob.did]),
      relay: { forward: (request, targetDid) => forwardTo(a!, request, targetDid, seenByA) },
    },
    log: () => {},
  });
  const aliceStore = new AgentStore(join(dir, 'alice', 'agent.db'));
  const bobStore = new AgentStore(join(dir, 'bob', 'agent.db'));
  try {
    const aliceBox = new AnpMailbox({
      store: aliceStore,
      client: new AnpClient({ identity: alice, call: a.call }),
      threadId: 'thread-1',
    });
    const bobBox = new AnpMailbox({
      store: bobStore,
      client: new AnpClient({ identity: bob, call: b.call }),
      threadId: 'thread-1',
    });

    const request = await aliceBox.send({
      targetDid: bob.did,
      payload: { type: 'anp.task.request', task_id: 'task-1', text: '跨域派活' },
    });
    assert.equal(request.accepted, true);
    assert.equal(request.queued, false);
    assert.deepEqual(seenByB, [bob.did]);
    assert.equal(b.storage.headSeq(bob.did), 1);

    const inbound = await bobBox.sync();
    assert.equal(inbound.added, 1);
    const session = await bobBox.open({ label: 'bob-turn' });
    const pulled = await bobBox.pull(session.id);
    assert.equal(pulled.items.length, 1);
    assert.equal(pulled.items[0]!.publisherId, alice.did);

    // 自动回复走的是同一条 mailbox.send → relay 路径。
    const reply = await bobBox.send({
      targetDid: alice.did,
      payload: { type: 'anp.chat.message', text: '收到' },
      replyTo: pulled.items[0]!.id,
    });
    assert.equal(reply.accepted, true);
    assert.deepEqual(seenByA, [alice.did]);
    assert.equal(a.storage.headSeq(alice.did), 1);
    const back = await aliceBox.sync();
    assert.equal(back.added, 1);

    // 同一个请求重放：对端不重复落库，也不再转发。
    const replayed = await sendRequest({
      sender: alice,
      targetDid: bob.did,
      messageId: 'msg-replay',
      requestId: 'r-replay',
      conversationId: 'thread-1',
    });
    const first = await a.call(replayed) as { result?: { accepted?: boolean } };
    assert.equal(first.result?.accepted, true);
    assert.equal(b.storage.headSeq(bob.did), 2);
    const seenBeforeReplay = seenByB.length;
    const second = await a.call(replayed) as { result?: { accepted?: boolean } };
    assert.equal(second.result?.accepted, true);
    assert.equal(b.storage.headSeq(bob.did), 2, '重放不新增投递');
    assert.equal(seenByB.length, seenBeforeReplay, '重放不再打扰对端');
  } finally {
    aliceStore.close();
    bobStore.close();
    await a.close();
    await b.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('跨域入站：conversation_id 映射、缺失时标记 ephemeral、外部发送方不进成员表', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anp-cross-inbound-'));
  const alice = await loadOrCreateIdentity(join(dir, 'alice'), endpoints, 'alice');
  const bob = await loadOrCreateIdentity(join(dir, 'bob'), endpoints, 'bob');
  const keys = new Map([
    [alice.did, multibaseOf(alice)],
    [bob.did, multibaseOf(bob)],
  ]);
  const delivered: DeliveredEvent[] = [];
  const seen: string[] = [];
  const service = await createAnpService({
    directory: join(dir, 'anp'),
    listen: { host: '127.0.0.1', port: 0 },
    publicUrl: endpoints.publicUrl,
    didBaseUrl: endpoints.didBaseUrl,
    localKeys: () => keys,
    crossDomain: {
      localTargets: () => new Set([bob.did]),
      relay: {
        async forward(_request, targetDid) {
          seen.push(targetDid);
          return { kind: 'local' };
        },
      },
    },
    onDelivered: event => delivered.push(event),
    log: () => {},
  });
  try {
    await service.call(await sendRequest({
      sender: alice,
      targetDid: bob.did,
      messageId: 'msg-conv',
      requestId: 'r-conv',
      conversationId: 'conv-1',
    }));
    await service.call(await sendRequest({
      sender: alice,
      targetDid: bob.did,
      messageId: 'msg-no-conv',
      requestId: 'r-no-conv',
    }));
    await service.call(await sendRequest({
      sender: alice,
      targetDid: bob.did,
      messageId: 'msg-empty-conv',
      requestId: 'r-empty-conv',
      conversationId: '',
    }));

    assert.deepEqual(seen, [], '本机目标不应进入 relay');
    assert.equal(delivered.length, 3);
    assert.equal(delivered[0]!.threadId, 'conv-1');
    assert.equal(delivered[0]!.ephemeral, false);
    assert.equal(delivered[1]!.threadId, 'msg-no-conv');
    assert.equal(delivered[1]!.ephemeral, true);
    assert.equal(delivered[2]!.threadId, 'msg-empty-conv');
    assert.equal(delivered[2]!.ephemeral, true);
    assert.equal(delivered.every(event => event.senderDid === alice.did), true);

    const store = new RouterStore(join(dir, 'router.db'));
    try {
      let woken = false;
      const host = {
        agentId: 'bob',
        did: bob.did,
        wake: () => {
          woken = true;
        },
      } as unknown as AgentHost;
      const delivery = new Delivery({
        router: store,
        hosts: () => new Map([['bob', host]]),
        log: () => undefined,
      });
      delivery.wake(bob.did, 'thread-inbound', alice.did, false);
      assert.equal(woken, true);
      assert.deepEqual(
        store.listMembers('thread-inbound').map(row => row.agent_id),
        ['bob'],
        '外部发送方只由 origin_proof 授权，不进 thread_members',
      );

      delivery.wake(bob.did, 'thread-ephemeral', alice.did, true);
      assert.equal(store.getThread('thread-ephemeral')?.ephemeral, 1);
    } finally {
      store.close();
    }
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('跨域目标策略：允许域名可出站，管理接口仍只投本机', async () => {
  const remote = recordingRelay();
  await withRouter(
    {
      agents: [agent('planner', ['规划']), agent('worker', ['整理'])],
      brains: {
        planner: new ScriptedBrain([{ tool: 'finish', input: { summary: 'ok' } }]),
        worker: new ScriptedBrain([{ tool: 'finish', input: { summary: '整理完了' } }]),
      },
      crossDomain: { enabled: true, allowedDidHosts: ['*.partner.example'] },
      relay: remote.relay,
    },
    async router => {
      const external = 'did:wba:eu.partner.example:agents:someone:e1_abc';
      const sent = await router.sendFrom('planner', {
        to: external,
        threadId: 'thread-external',
        payload: { type: 'anp.chat.message', text: '给外面' },
      });
      assert.equal(sent.queued, false);
      assert.equal(sent.targetDid, external);
      assert.deepEqual(remote.seen, [external]);
      assert.equal(router.store.getThread('thread-external'), undefined, '外部目标不建本机 thread');

      await assert.rejects(
        () => router.send({
          from: 'planner',
          to: external,
          threadId: 'thread-admin',
          payload: { type: 'anp.task.request', text: '管理接口' },
        }),
        /管理接口只投本机/,
      );
      await assert.rejects(
        () => router.sendFrom('planner', {
          to: 'did:wba:evil.example:agents:someone:e1_abc',
          threadId: 'thread-evil',
          payload: { type: 'anp.chat.message', text: '不该发出去' },
        }),
        /不在本机 router 中/,
      );
      assert.deepEqual(remote.seen, [external], '被拒绝的目标不应触发 relay');

      const worker = router.getAgent('worker')!;
      await router.sendFrom('planner', {
        to: worker.did,
        threadId: 'thread-local',
        payload: { type: 'anp.task.request', task_id: 'task-local', text: '整理一下' },
      });
      await router.drain();
      assert.equal(router.store.listTurns('worker', 'thread-local')[0]?.status, 'succeeded');
      assert.deepEqual(remote.seen, [external], '本机 DID 不触发 relay');
    },
  );
});

test('一次性 thread：TTL 归档删除 workspace、归档 session，显式 conversation 才复活', async () => {
  await withRouter(
    {
      agents: [agent('planner', ['规划'])],
      brains: {
        planner: new ScriptedBrain([{ tool: 'finish', input: { summary: 'ok' } }]),
      },
    },
    async router => {
      const host = router.getAgent('planner')!;
      const threadId = 'thread-ephemeral';
      const workspace = join(host.directory, 'workspace', 'threads', threadId);
      await mkdir(workspace, { recursive: true });
      await writeFile(join(workspace, 'note.txt'), '临时文件');
      router.store.ensureThread({ threadId, ownerAgentId: 'planner', ephemeral: true });
      router.store.ensureSession({
        sessionId: 'sess-ephemeral',
        agentId: 'planner',
        threadId,
        state: 'idle',
      });

      const archived = await router.sweepEphemeralThreads(
        Date.now() + router.config.ephemeralThreadTtlMs + 1_000,
      );
      assert.deepEqual(archived.map(row => row.threadId), [threadId]);
      const row = router.store.getThread(threadId)!;
      assert.equal(row.state, 'archived');
      assert.ok(row.archived_at);
      assert.equal(router.store.getSession('sess-ephemeral')?.state, 'archived');
      await assert.rejects(() => stat(workspace), { code: 'ENOENT' });

      // 非一次性 thread 不受 TTL 影响，workspace 保留。
      const kept = 'thread-persistent';
      const keptWorkspace = join(host.directory, 'workspace', 'threads', kept);
      await mkdir(keptWorkspace, { recursive: true });
      await writeFile(join(keptWorkspace, 'note.txt'), '长期文件');
      router.store.ensureThread({ threadId: kept, ownerAgentId: 'planner' });
      await router.sweepEphemeralThreads(Date.now() + router.config.ephemeralThreadTtlMs + 2_000);
      assert.equal(router.store.getThread(kept)?.state, 'open');
      assert.equal((await stat(keptWorkspace)).isDirectory(), true);

      // 只带 thread id 的后续扫描不会复活；显式 conversation 才复活。
      router.store.ensureThread({ threadId, ownerAgentId: 'planner' });
      assert.equal(router.store.getThread(threadId)?.state, 'archived');
      const revived = router.store.ensureThread({ threadId, ownerAgentId: 'planner', explicit: true });
      assert.equal(revived.state, 'open');
      assert.equal(revived.archived_at, null);

      // 正在跑 turn 的 thread 由调用方跳过，下一轮再试。
      router.store.ensureThread({ threadId: 'thread-running', ownerAgentId: 'planner', ephemeral: true });
      const skipped = router.store.archiveEphemeralThreads(
        new Date(Date.now() + 10 * 60_000).toISOString(),
        () => true,
      );
      assert.deepEqual(skipped, []);
      assert.equal(router.store.getThread('thread-running')?.state, 'open');
    },
  );
});
