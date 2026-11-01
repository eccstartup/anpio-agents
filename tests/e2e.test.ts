/**
 * P9 端到端：脚本 agent 离线协作 + 两 agent 与定时任务。
 *
 * 第一条用例直接加载 `examples/anp/agents.json`，不发网络请求、不需要密钥；
 * 第二条用无状态的脚本 brain 覆盖 schedule 触发后的第二轮运行。
 */

import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Brain, BrainResponse } from '../src/brains/types.ts';
import { parseRouterConfig } from '../src/router/config.ts';
import { startRouter, type RouterRuntime } from '../src/router/router.ts';

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

function configFor(dir: string, agentsFile: string): ReturnType<typeof parseRouterConfig> {
  return parseRouterConfig(
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
}

function payloads(router: RouterRuntime, agentId: string, threadId: string): Array<Record<string, unknown>> {
  return router.getAgent(agentId)!.dataStore.listMessages(threadId).map(row => {
    const body = JSON.parse(row.body_json) as { payload?: Record<string, unknown> };
    return { direction: row.direction, from: row.sender_did, to: row.target_did, ...body.payload };
  });
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`等待超时（${timeoutMs}ms）`);
}

test('P9：examples/anp 的两个脚本 agent 离线协作，worker 回复后 planner 收到', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anp-e2e-script-'));
  try {
    const config = configFor(dir, join(process.cwd(), 'examples', 'anp', 'agents.json'));
    const router = await startRouter({ config, listen: false, log: () => undefined });
    try {
      assert.ok(router.getAgent('planner'));
      assert.ok(router.getAgent('worker'));

      await router.send({
        from: 'planner',
        to: 'agent:worker',
        threadId: 'e2e-thread',
        payload: { type: 'anp.task.request', task_id: 'e2e-task', text: '请清点当前目录' },
      });
      await router.drain();

      const resultFile = join(
        dir,
        'root',
        'agents',
        'worker',
        'workspace',
        'threads',
        'e2e-thread',
        'worker-result.md',
      );
      assert.equal((await readFile(resultFile, 'utf8')).includes('清点结果'), true);

      const workerMessages = payloads(router, 'worker', 'e2e-thread');
      assert.ok(
        workerMessages.some(item => item.direction === 'out' && item.text === '清点完成，结果写在 worker-result.md。'),
        'worker 应回复 planner',
      );

      const plannerMessages = payloads(router, 'planner', 'e2e-thread');
      assert.ok(
        plannerMessages.some(item => item.direction === 'in' && item.text === '清点完成，结果写在 worker-result.md。'),
        'planner 应收到 worker 的回复',
      );
    } finally {
      await router.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('P9：两个 agent 协作后，定时任务在同一 thread 再触发一轮', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anp-e2e-schedule-'));
  const fireAt = new Date(Date.now() + 500).toISOString();
  const agent = (id: string, tools: string[], allowSchedules = false): Record<string, unknown> => ({
    id,
    name: id,
    description: `${id} 的描述`,
    capabilities: [],
    provider: {
      protocol: 'openai-chat',
      baseUrl: 'http://127.0.0.1:1',
      model: 'fake',
      apiKeyEnv: null,
    },
    systemPrompt: `你是 ${id}。`,
    tools,
    scopes: ['mailbox:read', 'mailbox:write'],
    limits: { maxTurns: 10, timeoutMs: 20_000, maxTokens: 1_024 },
    anp: { isolation: 'inline', allowSchedules },
  });

  try {
    const agentsFile = join(dir, 'agents.json');
    await writeFile(
      agentsFile,
      JSON.stringify({
        agents: [
          agent('orchestrator', ['anp_send', 'schedule_create', 'list_schedules', 'write_file', 'finish_turn'], true),
          agent('field', ['write_file', 'finish_turn']),
        ],
      }),
    );

    const router = await startRouter({
      config: configFor(dir, agentsFile),
      listen: false,
      log: () => undefined,
      brains: {
        orchestrator: new ScriptedBrain([
          { tool: 'schedule_create', input: { kind: 'at', expr: fireAt, text: '到点复查' } },
          { tool: 'anp_send', input: { to: 'agent:field', text: '请记录本轮结果' } },
          { tool: 'finish_turn', input: { summary: '已安排复查并派活' } },
          { tool: 'write_file', input: { path: 'scheduled-turn.txt', content: '定时回访已执行\n' } },
          { tool: 'finish_turn', input: { summary: '已执行定时回访' } },
        ]),
        field: new ScriptedBrain([
          { tool: 'write_file', input: { path: 'field.txt', content: 'field 已记录\n' } },
          { tool: 'finish_turn', input: { summary: '已记录' } },
        ]),
      },
    });
    try {
      await router.send({
        from: 'field',
        to: 'agent:orchestrator',
        threadId: 'thread-e2e',
        payload: { type: 'anp.task.request', task_id: 'task-e2e', text: '开始' },
      });
      await router.drain();

      const fieldFile = join(dir, 'root', 'agents', 'field', 'workspace', 'threads', 'thread-e2e', 'field.txt');
      assert.equal((await stat(fieldFile)).isFile(), true);

      const scheduledFile = join(
        dir,
        'root',
        'agents',
        'orchestrator',
        'workspace',
        'threads',
        'thread-e2e',
        'scheduled-turn.txt',
      );
      await waitFor(async () => {
        try {
          return (await stat(scheduledFile)).isFile();
        } catch {
          return false;
        }
      });
      await router.drain();

      const schedules = router.store.listSchedules('orchestrator');
      assert.equal(schedules.length, 1);
      assert.equal(schedules[0]!.state, 'done');
      assert.equal(schedules[0]!.runs, 1);

      const fired = payloads(router, 'orchestrator', 'thread-e2e').filter(
        item => item.type === 'anp.schedule.fire' && item.text === '到点复查',
      );
      assert.equal(fired.length, 1, '定时消息只应触发一次');
    } finally {
      await router.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
