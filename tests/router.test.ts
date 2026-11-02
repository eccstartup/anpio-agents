/**
 * Router：一个进程托管多个 agent、确定性路由、崩溃隔离与单实例锁。
 *
 * 不监听端口：测试走进程内 `service.call`，与生产使用同一条投递路径。
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Brain, BrainResponse } from '../src/brains/types.ts';
import type { AnpClient } from '../src/anp/client.ts';
import { parseRouterConfig } from '../src/router/config.ts';
import { acquireLock, RouterLockError } from '../src/router/lock.ts';
import { routeMessage } from '../src/router/routing.ts';
import { startRouter, type RouterRuntime } from '../src/router/router.ts';
import { AnpMailbox } from '../src/runtime/anp/mailbox.ts';

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

function agent(id: string, capabilities: string[], description = ''): Record<string, unknown> {
  return {
    id,
    name: id,
    description,
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
  agents: unknown[],
  brains: Record<string, Brain>,
  run: (router: RouterRuntime, dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'anp-router-'));
  const agentsFile = join(dir, 'agents.json');
  await writeFile(agentsFile, JSON.stringify({ agents }));
  const config = parseRouterConfig(
    {
      root: join(dir, 'root'),
      didBaseUrl: 'http://127.0.0.1:8788',
      publicUrl: 'http://127.0.0.1:8787',
      listen: { host: '127.0.0.1', port: 0 },
      anpListen: { host: '127.0.0.1', port: 0 },
      agentsFile,
      watchIntervalMs: 0,
      sweepIntervalMs: 0,
    },
    { baseDir: dir },
  );
  const router = await startRouter({ config, brains, listen: false, log: () => undefined });
  try {
    await run(router, dir);
  } finally {
    await router.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('Router：两个 agent 在一个进程内按 DID 与能力路由，崩溃互不影响', async () => {
  await withRouter(
    [
      agent('planner', ['规划'], '负责把任务拆开'),
      agent('worker', ['整理', '目录'], '负责整理文件'),
    ],
    {
      planner: new ScriptedBrain([
        { tool: 'finish', input: { summary: 'planner 收到', outcome: 'done' } },
      ]),
      worker: new ScriptedBrain([
        { tool: 'finish', input: { summary: 'worker 完成', outcome: 'done' } },
      ]),
    },
    async router => {
      assert.equal(router.hosts.size, 2);
      const planner = router.getAgent('planner')!;
      const worker = router.getAgent('worker')!;
      assert.notEqual(planner.did, worker.did);

      // 1) 显式 DID：planner → worker。
      const sent = await router.send({
        from: 'planner',
        to: worker.did,
        threadId: 'thread-a',
        payload: { type: 'anp.task.request', task_id: 'task-1', text: '整理目录' },
      });
      assert.equal(sent.route.agentId, 'worker');
      assert.equal(sent.route.reason, 'explicit');
      await router.drain();

      const workerThread = worker.dataStore.listMessages('thread-a');
      const outbound = workerThread.find(row => row.direction === 'out');
      assert.ok(outbound, 'worker 应自动回复');
      const body = JSON.parse(outbound.body_json) as {
        payload: { type: string; text: string };
        reply_to?: string;
      };
      assert.equal(body.payload.type, 'anp.chat.message');
      assert.equal(body.payload.text, 'worker 完成');
      assert.equal(body.reply_to, sent.messageId);
      assert.equal(worker.dataStore.pendingInboxCount('thread-a'), 0);

      // planner 收到了回复；出站只有它自己发出的那条任务，没有回声。
      const plannerThread = planner.dataStore.listMessages('thread-a');
      assert.equal(plannerThread.some(row => row.direction === 'in'), true);
      const plannerOut = plannerThread.filter(row => row.direction === 'out');
      assert.equal(plannerOut.length, 1);
      assert.equal(JSON.parse(plannerOut[0]!.body_json).payload.text, '整理目录');
      assert.equal(router.store.listTurns('worker', 'thread-a')[0]?.status, 'succeeded');

      // 本地投递双方都在 thread_members 里，后续 thread 消息才能过收件规则。
      assert.deepEqual(
        router.store.listMembers('thread-a').map(row => row.agent_id).sort(),
        ['planner', 'worker'],
      );

      // 2) 能力路由。
      const bySkill = router.route({ skills: ['整理'] });
      assert.equal(bySkill?.agentId, 'worker');
      assert.equal(bySkill?.reason, 'capability');
      const byPrefix = router.route({ skills: ['整理目录'] });
      assert.equal(byPrefix?.agentId, 'worker');

      // 3) thread owner 优先于能力匹配。
      const byThread = router.route({ threadId: 'thread-a', skills: ['规划'] });
      assert.equal(byThread?.agentId, 'worker');
      assert.equal(byThread?.reason, 'thread');

      // 4) 显式 agent:<id> 覆盖 thread owner。
      const explicitAgent = router.route({ to: 'agent:planner', threadId: 'thread-a' });
      assert.equal(explicitAgent?.agentId, 'planner');
      assert.equal(explicitAgent?.reason, 'explicit');
    },
  );
});

test('Router：没有 relay 时拒绝本机之外的出站 DID', async () => {
  const external = 'did:wba:external.example:agents:someone:e1_abc';
  await withRouter(
    [agent('planner', ['规划'])],
    {
      planner: new ScriptedBrain([{ tool: 'finish', input: { summary: 'ok' } }]),
    },
    async router => {
      await assert.rejects(
        () => router.send({
          from: 'planner',
          to: external,
          threadId: 'thread-external',
          payload: { type: 'anp.task.request', text: '外面的人' },
        }),
        /不在本机 router 中/,
      );
      await assert.rejects(
        () => router.sendFrom('planner', {
          to: external,
          threadId: 'thread-external',
          payload: { type: 'anp.chat.message', text: '外面的人' },
        }),
        /不在本机 router 中/,
      );

      const host = router.getAgent('planner')!;
      const outbox = host.dataStore.db.get<{ count: number }>(
        'SELECT COUNT(*) AS count FROM outbox',
      );
      assert.equal(outbox?.count, 0, '被拒绝的目标不能进入 outbox');
    },
  );
});

test('Router：sync.delta 的 aged_out 累计进 health', async () => {
  await withRouter(
    [agent('planner', ['规划'])],
    {
      planner: new ScriptedBrain([{ tool: 'finish', input: { summary: 'ok' } }]),
    },
    async router => {
      const host = router.getAgent('planner')!;
      const client = {
        async sync() {
          return { messages: [], nextSince: 0, hasMore: false, agedOut: 5 };
        },
      } as unknown as AnpClient;
      const box = new AnpMailbox({
        store: host.dataStore,
        client,
        threadId: 'thread-aged',
      });
      await box.sync();
      assert.equal(box.agedOut(), 5);

      // host 按 thread 缓存 mailbox；把这份已同步的信箱放进缓存验证汇总。
      (host as unknown as { mailboxes: Map<string, AnpMailbox> })
        .mailboxes.set('thread-aged', box);
      assert.equal(host.agedOut(), 5);
      assert.equal(router.status().agedOutMessages, 5);
    },
  );
});

test('Router：单个 agent 的模型崩溃不影响另一个 agent', async () => {
  const broken: Brain = {
    async complete() {
      throw new Error('模型崩溃');
    },
  };
  await withRouter(
    [agent('healthy', ['整理']), agent('broken', ['写作'])],
    {
      healthy: new ScriptedBrain([{ tool: 'finish', input: { summary: '正常完成' } }]),
      broken,
    },
    async router => {
      await router.send({
        from: 'healthy',
        to: 'agent:broken',
        threadId: 'thread-broken',
        payload: { type: 'anp.task.request', task_id: 'task-b', text: '写点东西' },
      });
      await router.drain();
      assert.equal(router.store.listTurns('broken', 'thread-broken')[0]?.status, 'failed');

      const sent = await router.send({
        from: 'healthy',
        to: 'agent:healthy',
        threadId: 'thread-ok',
        payload: { type: 'anp.task.request', task_id: 'task-c', text: '整理一下' },
      });
      assert.equal(sent.route.agentId, 'healthy');
      await router.drain();
      const okTurns = router.store.listTurns('healthy', 'thread-ok');
      assert.equal(okTurns.some(turn => turn.status === 'succeeded'), true);
    },
  );
});

test('Router：agents.json 热更新新增 agent', async () => {
  await withRouter(
    [agent('planner', ['规划'])],
    {
      planner: new ScriptedBrain([{ tool: 'finish', input: { summary: 'ok' } }]),
      writer: new ScriptedBrain([{ tool: 'finish', input: { summary: '写好了' } }]),
    },
    async (router, dir) => {
      assert.equal(router.hosts.size, 1);
      await writeFile(
        join(dir, 'agents.json'),
        JSON.stringify({ agents: [agent('planner', ['规划']), agent('writer', ['写作'])] }),
      );
      const diff = await router.reload(true);
      assert.deepEqual(diff.added.map(entry => entry.definition.id), ['writer']);
      assert.equal(router.hosts.size, 2);

      await router.send({
        from: 'planner',
        to: 'agent:writer',
        threadId: 'thread-w',
        payload: { type: 'anp.task.request', text: '写一篇短文' },
      });
      await router.drain();
      assert.equal(router.store.listTurns('writer', 'thread-w')[0]?.status, 'succeeded');
    },
  );
});

test('路由规则：显式 > thread > 能力 > 默认，同分按 agentId', () => {
  const candidates = [
    { agentId: 'beta', did: 'did:wba:x:agents:beta:e1', capabilities: ['写作'], description: '', enabled: true },
    { agentId: 'alpha', did: 'did:wba:x:agents:alpha:e1', capabilities: ['写作'], description: '', enabled: true },
    { agentId: 'off', did: 'did:wba:x:agents:off:e1', capabilities: ['写作'], description: '', enabled: false },
  ];
  assert.equal(routeMessage(candidates, { skills: ['写作'] })?.agentId, 'alpha');
  assert.equal(routeMessage(candidates, { to: 'agent:off' }), null);
  assert.equal(routeMessage(candidates, { defaultAgent: 'beta' })?.agentId, 'beta');
  assert.equal(routeMessage(candidates, { to: 'did:wba:x:agents:beta:e1' })?.reason, 'explicit');
  assert.equal(routeMessage(candidates, { threadOwner: 'beta', skills: ['写作'] })?.reason, 'thread');
});

test('单实例锁：重复获取失败，stale 锁可以接管', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anp-lock-'));
  try {
    const path = join(dir, 'router.lock');
    const first = await acquireLock(path);
    await assert.rejects(() => acquireLock(path), RouterLockError);
    await first.release();
    const second = await acquireLock(path);
    await second.release();

    await writeFile(path, JSON.stringify({ pid: 2 ** 31 - 2, startedAt: new Date(0).toISOString() }));
    const takeover = await acquireLock(path);
    assert.equal(takeover.info.pid, process.pid);
    await takeover.release();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
