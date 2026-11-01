/**
 * AgentRuntime / Session 的契约测试。
 *
 * 用内存替身代替平台 HTTP：同一 agent 上顺序与并发跑多个 Session，
 * 验证目录隔离、信箱独立、确认与收尾，以及并发配额。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CollabClient } from '../src/client.ts';
import type { EmbeddedAgentDefinition } from '../src/definition.ts';
import { AgentRuntime } from '../src/runtime/agent.ts';

function definition(concurrency = 1): EmbeddedAgentDefinition {
  const now = new Date().toISOString();
  return {
    id: 'agent1',
    name: '抽层验证',
    description: '',
    capabilities: [],
    provider: {
      id: 'script',
      protocol: 'script',
      baseUrl: '',
      model: 'script',
      apiKeyEnv: null,
      script: [
        { tool: 'task_accept', input: { subtaskId: '{{refId}}' } },
        { tool: 'task_submit', input: { subtaskId: '{{refId}}', result: { summary: '完成', source: 'test', observedAt: '{{now}}' } } },
        { tool: 'finish', input: { summary: '一轮完成', outcome: 'done' } },
      ],
    },
    systemPrompt: '',
    tools: ['task_accept', 'task_submit', 'finish'],
    scopes: ['tasks:read', 'tasks:submit'],
    limits: { maxTurns: 10, timeoutMs: 20_000, maxTokens: 1_024 },
    sandbox: { shell: false, shellTimeoutMs: 1_000, maxOutputBytes: 4_096 },
    enabled: true,
    concurrency,
    createdBy: null,
    createdAt: now,
    updatedAt: now,
    lastRunAt: null,
    lastError: null,
  };
}

type Fake = {
  client: CollabClient;
  sessions: { id: string; label: string }[];
  acked: string[];
  closed: string[];
  finished: { runId: string; body: Record<string, unknown> }[];
  submitted: Record<string, unknown>[];
  accepted: string[];
  maxActive: () => number;
};

function fakeClient(active: () => number): Fake {
  let counter = 0;
  let maxActive = 0;
  const state = {
    sessions: [] as { id: string; label: string }[],
    acked: [] as string[],
    closed: [] as string[],
    finished: [] as { runId: string; body: Record<string, unknown> }[],
    submitted: [] as Record<string, unknown>[],
    accepted: [] as string[],
  };

  const client = {
    async request(path: string, options: { body?: Record<string, unknown> } = {}) {
      const runId = /embedded\/runs\/([^/]+)\//.exec(path)?.[1] ?? '';
      if (path.endsWith('/finish')) state.finished.push({ runId, body: options.body ?? {} });
      return {};
    },
    async createMailSession(input: { label?: string }) {
      counter += 1;
      const id = `sess${counter}`;
      state.sessions.push({ id, label: input.label ?? '' });
      return { id, kind: 'embedded', label: input.label ?? '', status: 'open', unread: 0, cursorSeq: 0 };
    },
    async pullMail() {
      maxActive = Math.max(maxActive, active());
      return {
        items: [
          {
            id: 'm1',
            seq: 1,
            deliveryId: 'd1',
            topic: 'subtask.assigned',
            kind: 'subtask.assigned',
            priority: 'normal',
            summary: '做点事',
            ref: { type: 'subtask', id: 'st1', taskId: 't1', threadId: null },
            publisherId: 'owner',
            createdAt: new Date().toISOString(),
            expiresAt: null,
          },
        ],
        cursor: 1,
        session: { id: 'sess' },
      };
    },
    async mailMessage() {
      return { id: 'm1', content: { text: '请处理' } };
    },
    async ackMail(id: string) {
      state.acked.push(id);
      return { id, state: 'acked', duplicate: false };
    },
    async nackMail(id: string) {
      return { id, state: 'pending', attempts: 1 };
    },
    async closeMailSession(id: string) {
      state.closed.push(id);
      return { id, status: 'closed' };
    },
    async heartbeat() {
      return {};
    },
    async accept(subtaskId: string) {
      state.accepted.push(subtaskId);
      return { id: subtaskId, status: 'accepted' };
    },
    async submit(_subtaskId: string, result: Record<string, unknown>) {
      state.submitted.push(result);
      return { status: 'submitted' };
    },
    async progress() {
      return {};
    },
  } as unknown as CollabClient;

  return {
    client,
    get sessions() {
      return state.sessions;
    },
    get acked() {
      return state.acked;
    },
    get closed() {
      return state.closed;
    },
    get finished() {
      return state.finished;
    },
    get submitted() {
      return state.submitted;
    },
    get accepted() {
      return state.accepted;
    },
    maxActive: () => maxActive,
  };
}

async function withRuntime<T>(
  concurrency: number,
  fn: (runtime: AgentRuntime, fake: Fake, root: string) => Promise<T>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'anpio-runtime-'));
  const previous = process.env.COLLAB_RUN_ROOT;
  process.env.COLLAB_RUN_ROOT = root;
  let runtime: AgentRuntime | null = null;
  const fake = fakeClient(() => runtime?.activeSessions ?? 0);
  try {
    runtime = await AgentRuntime.create({
      baseUrl: 'http://127.0.0.1:1',
      token: 'test-token',
      agentId: 'agent1',
      definition: definition(concurrency),
      client: fake.client,
    });
    await fn(runtime, fake, root);
  } finally {
    if (previous === undefined) delete process.env.COLLAB_RUN_ROOT;
    else process.env.COLLAB_RUN_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

test('AgentRuntime：同一 agent 顺序两次运行，目录与信箱各自独立', { timeout: 20_000 }, async () => {
  await withRuntime(1, async (runtime, fake, root) => {
    const first = await runtime.runSession({ runId: 'run1' });
    const second = await runtime.runSession({ runId: 'run2' });

    assert.equal(first.status, 'succeeded');
    assert.equal(second.status, 'succeeded');
    assert.equal(first.turns, 3);
    assert.equal(first.error, null);
    assert.equal(first.mailSessionId, 'sess1');
    assert.equal(second.mailSessionId, 'sess2');
    assert.equal(runtime.activeSessions, 0);

    assert.deepEqual(fake.sessions.map(item => item.label), ['run:run1', 'run:run2']);
    assert.deepEqual(fake.closed, ['sess1', 'sess2']);
    assert.deepEqual(fake.acked, ['m1', 'm1']);
    assert.deepEqual(fake.finished.map(item => item.runId), ['run1', 'run2']);
    assert.ok(fake.finished.every(item => item.body.status === 'succeeded'));
    assert.deepEqual(fake.accepted, ['st1', 'st1']);

    // 会话目录随运行清理；agent 级工作根保留给下一个 Session。
    assert.equal(existsSync(join(root, 'agent1', 'sessions', 'run1')), false);
    assert.equal(existsSync(join(root, 'agent1', 'sessions', 'run2')), false);
    assert.equal(existsSync(join(root, 'agent1', 'sessions')), true);
  });
});

test('AgentRuntime：并发 Session 受 definition.concurrency 约束', { timeout: 20_000 }, async () => {
  await withRuntime(2, async (runtime, fake) => {
    const results = await Promise.all([
      runtime.runSession({ runId: 'run1' }),
      runtime.runSession({ runId: 'run2' }),
    ]);
    assert.deepEqual(results.map(result => result.status), ['succeeded', 'succeeded']);
    assert.equal(runtime.activeSessions, 0);
    assert.equal(fake.maxActive(), 2);
    assert.deepEqual(new Set(fake.sessions.map(item => item.label)), new Set(['run:run1', 'run:run2']));
  });

  await withRuntime(1, async (runtime, fake) => {
    const results = await Promise.all([
      runtime.runSession({ runId: 'run1' }),
      runtime.runSession({ runId: 'run2' }),
    ]);
    assert.deepEqual(results.map(result => result.status), ['succeeded', 'succeeded']);
    // 配额为 1 时第二个 Session 排队，不会同时占两个信箱。
    assert.equal(fake.maxActive(), 1);
  });
});
