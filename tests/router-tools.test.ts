/**
 * P6 工具：ANP 协作、子 agent、受控联网与写工具幂等。
 *
 * Router 测试仍不监听端口；子 agent 由 brainFactory 按动态 id 注入脚本。
 * 联网部分只测策略与地址校验，请求本身用注入的 fetch 替身。
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Brain, BrainResponse } from '../src/brains/types.ts';
import { parseRouterConfig } from '../src/router/config.ts';
import { startRouter, type RouterRuntime } from '../src/router/router.ts';
import { createTurnTools } from '../src/router/turn-tools.ts';
import { normalizeDefinition } from '../src/standalone/config.ts';
import { AgentStore } from '../src/store/agent-store.ts';
import { executeHttpFetch } from '../src/tools/net.ts';

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

function agent(
  id: string,
  options: {
    capabilities?: string[];
    tools?: string[];
    anp?: Record<string, unknown>;
  } = {},
): Record<string, unknown> {
  return {
    id,
    name: id,
    description: `${id} 的描述`,
    capabilities: options.capabilities ?? [],
    provider: {
      protocol: 'openai-chat',
      baseUrl: 'http://127.0.0.1:1',
      model: 'fake',
      apiKeyEnv: null,
    },
    systemPrompt: `你是 ${id}。`,
    tools: options.tools ?? ['read_file', 'finish'],
    scopes: ['mailbox:read', 'mailbox:write'],
    limits: { maxTurns: 10, timeoutMs: 20_000, maxTokens: 1_024 },
    anp: options.anp ?? { isolation: 'inline' },
  };
}

async function withRouter(
  agents: unknown[],
  options: {
    brains: Record<string, Brain>;
    brainFactory?: (agentId: string) => Brain | undefined;
  },
  run: (router: RouterRuntime) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'anp-router-tools-'));
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
      childScanIntervalMs: 0,
      scheduleTickIntervalMs: 20,
    },
    { baseDir: dir },
  );
  const router = await startRouter({
    config,
    brains: options.brains,
    ...(options.brainFactory ? { brainFactory: (id: string) => options.brainFactory!(id) } : {}),
    listen: false,
    log: () => undefined,
  });
  try {
    await run(router);
  } finally {
    await router.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('P6：父 agent 创建子 agent，子 agent 回复同一 thread', async () => {
  const parentTools = ['read_file', 'finish', 'spawn_agent', 'anp_send', 'anp_reply'];
  await withRouter(
    [
      agent('caller', { tools: ['finish'] }),
      agent('parent', {
        capabilities: ['协调'],
        tools: parentTools,
        anp: { isolation: 'inline', allowSpawn: true, maxChildren: 3, maxDepth: 2 },
      }),
    ],
    {
      brains: {
        caller: new ScriptedBrain([
          { tool: 'finish', input: { summary: '收到' } },
        ]),
        parent: new ScriptedBrain([
          {
            tool: 'spawn_agent',
            input: {
              name: 'helper',
              description: '回答一个具体问题',
              capabilities: ['回答'],
              tools: ['anp_reply', 'finish'],
              task: '请给出答案',
            },
          },
          { tool: 'finish', input: { summary: '已派给子 agent' } },
          { tool: 'finish', input: { summary: '收到子 agent 回复' } },
        ]),
      },
      brainFactory: agentId => (agentId !== 'parent' && agentId !== 'caller'
        ? new ScriptedBrain([
            { tool: 'anp_reply', input: { text: '子任务完成' } },
            { tool: 'finish', input: { summary: 'child done' } },
          ])
        : undefined),
    },
    async router => {
      await router.send({
        from: 'caller',
        to: 'agent:parent',
        threadId: 'thread-p',
        payload: { type: 'anp.task.request', task_id: 'task-1', text: '请安排一个子任务' },
      });
      await router.drain();

      const children = router.store.listChildren('parent');
      assert.equal(children.length, 1);
      const childId = children[0]!.child_id;
      assert.equal(children[0]!.depth, 1);
      assert.ok(router.getAgent(childId), '子 agent 应已启动');

      const child = router.getAgent(childId)!;
      assert.deepEqual(child.definition.tools, ['anp_reply', 'finish']);
      assert.deepEqual(child.definition.capabilities, ['回答']);
      assert.equal(child.anpConfig.allowSpawn, true);

      const parentMessages = router.getAgent('parent')!.dataStore.listMessages('thread-p');
      const inbound = parentMessages.filter(
        row => row.direction === 'in' && row.sender_did === child.did,
      );
      assert.equal(inbound.length, 1);
      assert.equal(JSON.parse(inbound[0]!.body_json).payload.text, '子任务完成');

      assert.equal(router.store.listTurns(childId, 'thread-p')[0]?.status, 'succeeded');
    },
  );
});

test('P6：子 agent 受 allowSpawn、数量、深度与工具子集约束', async () => {
  await withRouter(
    [
      agent('solo', { tools: ['finish', 'spawn_agent'] }),
      agent('boss', {
        tools: ['finish', 'spawn_agent'],
        anp: { isolation: 'inline', allowSpawn: true, maxChildren: 1, maxDepth: 1 },
      }),
    ],
    {
      brains: {
        solo: new ScriptedBrain([]),
        boss: new ScriptedBrain([]),
      },
      brainFactory: () => new ScriptedBrain([]),
    },
    async router => {
      const base = { name: 'kid', description: '临时子 agent', capabilities: ['临时'] };
      await assert.rejects(() => router.spawnAgent('solo', base), /allowSpawn/);

      await assert.rejects(
        () => router.spawnAgent('boss', { ...base, tools: ['http_fetch'] as never }),
        /子集/,
      );

      const spawned = await router.spawnAgent('boss', base);
      assert.equal(router.store.countChildren('boss'), 1);
      assert.equal(router.getAgent(spawned.agentId)?.anpConfig.allowSpawn, false);

      await assert.rejects(() => router.spawnAgent('boss', base), /上限/);
      await assert.rejects(
        () => router.spawnAgent(spawned.agentId, base),
        /allowSpawn/,
      );
    },
  );
});

test('P6：http_fetch 拒绝内网地址，egress 只放行 allowlist', async () => {
  await assert.rejects(
    () => executeHttpFetch(
      { url: 'http://127.0.0.1:9/' },
      { mode: 'open', allowlist: [] },
    ),
    /内网/,
  );

  await assert.rejects(
    () => executeHttpFetch(
      { url: 'https://example.com/' },
      { mode: 'egress', allowlist: ['example.com'] },
      { lookupImpl: async () => ['10.0.0.1'] },
    ),
    /内网地址/,
  );

  await assert.rejects(
    () => executeHttpFetch(
      { url: 'https://other.example.org/' },
      { mode: 'egress', allowlist: ['example.com'] },
    ),
    /allowlist/,
  );

  const result = await executeHttpFetch(
    { url: 'https://example.com/path' },
    { mode: 'egress', allowlist: ['example.com'] },
    {
      lookupImpl: async () => ['93.184.216.34'],
      fetchImpl: async () => new Response('hello', { status: 200 }),
    },
  );
  assert.equal(result.status, 200);
  assert.equal(result.body, 'hello');
  assert.equal(result.bytes, 5);
});

test('P7：agent 通过 schedule_create 创建一次性任务并触发到同一 thread', async () => {
  const fireAt = new Date(Date.now() + 300).toISOString();
  await withRouter(
    [
      agent('caller', { tools: ['finish'] }),
      agent('sched', {
        tools: ['finish', 'schedule_create', 'list_schedules'],
        anp: { isolation: 'inline', allowSchedules: true },
      }),
    ],
    {
      brains: {
        caller: new ScriptedBrain([{ tool: 'finish', input: { summary: '已发送' } }]),
        sched: new ScriptedBrain([
          {
            tool: 'schedule_create',
            input: { kind: 'at', expr: fireAt, text: '到点提醒' },
          },
          { tool: 'finish', input: { summary: '已安排提醒' } },
          { tool: 'finish', input: { summary: '收到提醒' } },
        ]),
      },
    },
    async router => {
      await router.send({
        from: 'caller',
        to: 'agent:sched',
        threadId: 'thread-s',
        payload: { type: 'anp.task.request', task_id: 'task-s', text: '安排一个提醒' },
      });
      await router.drain();

      const schedules = router.store.listSchedules('sched');
      assert.equal(schedules.length, 1);
      assert.equal(schedules[0]!.kind, 'at');
      assert.equal(schedules[0]!.state, 'active');
      assert.equal(schedules[0]!.target_thread, 'thread-s');

      const deadline = Date.now() + 5_000;
      let fired = 0;
      while (Date.now() < deadline) {
        const messages = router.getAgent('sched')!.dataStore.listMessages('thread-s');
        fired = messages.filter(row => {
          const body = JSON.parse(row.body_json) as { payload?: { type?: string; text?: string } };
          return body.payload?.type === 'anp.schedule.fire' && body.payload.text === '到点提醒';
        }).length;
        if (fired > 0) break;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.equal(fired, 1, '定时消息应触发一次');
      assert.equal(router.store.listSchedules('sched')[0]?.state, 'done');
    },
  );
});

test('P6：写工具按 tool call id 幂等，重放不重复发送', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anp-router-effects-'));
  const store = new AgentStore(join(dir, 'agent.db'));
  try {
    const definition = normalizeDefinition(
      {
        id: 'effects',
        name: 'effects',
        provider: {
          protocol: 'openai-chat',
          baseUrl: 'http://127.0.0.1:1',
          model: 'fake',
          apiKeyEnv: null,
        },
        tools: ['anp_send', 'finish'],
        limits: { maxTurns: 5, timeoutMs: 10_000, maxTokens: 512 },
      },
      'effects',
    );
    let sends = 0;
    let replied = 0;
    const tools = createTurnTools(
      {
        runDir: join(dir, 'workspace'),
        turnId: 'turn-1',
        definition,
        threadId: 'thread-1',
        triggerMessageId: null,
        store,
        mailbox: {} as never,
        markReplied: () => {
          replied += 1;
        },
      },
      {
        send: async input => {
          sends += 1;
          return {
            messageId: 'msg-1',
            threadId: input.threadId,
            targetDid: input.to,
            queued: true,
          };
        },
        listAgents: () => [],
        agentStatus: () => null,
        spawn: async () => ({}),
        schedules: {
          create: () => {
            throw new Error('not used');
          },
          cancel: () => ({ cancelled: false }),
          list: () => [],
        },
        network: 'none',
        allowlist: [],
      },
    );

    const call = { id: 'call-1', name: 'anp_send', input: { to: 'did:wba:x:agents:other:e1', text: 'hi' } };
    const first = await tools.execute(call);
    const second = await tools.execute(call);
    assert.equal(sends, 1);
    assert.equal(first.content, second.content);
    assert.equal(replied, 0);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
