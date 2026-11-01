/**
 * P2：同一 agent 的 worker 并发承载多个 Session。
 *
 * 平台桩同时保存两条待处理消息与两次运行：定义 concurrency=2 时 supervisor
 * 应一次下发两个 run，worker 并发处理；其中一个写请求在传输层失败
 * （结果未知）不能影响另一个，各自目录与信箱独立。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EmbeddedAgentDefinition } from '../src/definition.ts';

const SECRET = 'embedded-test-secret-0123456789abcdef';
const ADMIN_TOKEN = 'admin-test-token';
const AGENT_ID = 'agent1';
const SUPERVISOR = fileURLToPath(new URL('../src/supervisor.ts', import.meta.url));

function definition(): EmbeddedAgentDefinition {
  const now = new Date().toISOString();
  return {
    id: AGENT_ID,
    name: '并发助手',
    description: '两个 Session 并发',
    capabilities: [],
    provider: {
      id: 'script',
      protocol: 'script',
      baseUrl: '',
      model: 'script',
      apiKeyEnv: null,
      script: [
        { tool: 'task_accept', input: { subtaskId: '{{refId}}' } },
        { tool: 'task_submit', input: { subtaskId: '{{refId}}', result: { summary: '完成', source: 'worker-test', observedAt: '{{now}}' } } },
        { tool: 'finish', input: { summary: '一轮完成', outcome: 'done' } },
      ],
    },
    systemPrompt: '',
    tools: ['task_accept', 'task_submit', 'finish'],
    scopes: ['tasks:read', 'tasks:submit', 'mailbox:read', 'mailbox:write'],
    limits: { maxTurns: 10, timeoutMs: 30_000, maxTokens: 1_024 },
    sandbox: { shell: false, shellTimeoutMs: 5_000, maxOutputBytes: 16_384 },
    enabled: true,
    concurrency: 2,
    createdBy: null,
    createdAt: now,
    updatedAt: now,
    lastRunAt: null,
    lastError: null,
  };
}

type Message = {
  id: string;
  refId: string;
  leasedBy: string | null;
  acked: boolean;
  nacked: number[]; // 每次 nack 的 retryAfterSeconds
};

type Run = { id: string; status: string; startedAt: string; heartbeatAt: string };

type Stub = {
  url: string;
  messages: Message[];
  runs: Run[];
  finished: Map<string, Record<string, unknown>>;
  logs: string[];
  openSessions: number;
  maxOpenSessions: number;
  mailFetched: boolean;
  close: () => Promise<void>;
};

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function startStub(options: { delayMailMs?: number } = {}): Promise<Stub> {
  const agent = definition();
  const state = {
    messages: [
      { id: 'm1', refId: 'st1', leasedBy: null, acked: false, nacked: [] },
      { id: 'm2', refId: 'st2', leasedBy: null, acked: false, nacked: [] },
    ] as Message[],
    runs: [] as Run[],
    finished: new Map<string, Record<string, unknown>>(),
    logs: [] as string[],
    openSessions: 0,
    maxOpenSessions: 0,
    mailFetched: false,
    sessions: new Map<string, string>(), // mail session id -> message id
    counter: 0,
  };

  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const path = new URL(req.url ?? '/', 'http://stub').pathname;

    const send = (payload: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    if (path === '/v1/embedded/agents') {
      const unread = state.messages.filter(item => !item.acked && !item.leasedBy).length;
      const running = state.runs.filter(run => run.status === 'running').length;
      return send([{ ...agent, unread, running }]);
    }
    if (path.endsWith('/ensure')) return send({ ok: true });
    if (path.endsWith('/supervisors/heartbeat')) return send({ ok: true });
    if (path === '/v1/agent/heartbeat') return send({ principalId: `embedded-${AGENT_ID}`, state: 'offline' });
    if (path === '/v1/embedded/recover') return send({ recovered: [] });
    if (path.endsWith(`/agents/${AGENT_ID}/runs?limit=5`) || path.endsWith(`/agents/${AGENT_ID}/runs`)) {
      return send(state.runs.map(run => ({ ...run, agentId: AGENT_ID, workdir: null })));
    }
    if (path.endsWith(`/agents/${AGENT_ID}/run`)) {
      state.counter += 1;
      const now = new Date().toISOString();
      const run: Run = { id: `run${state.counter}`, status: 'running', startedAt: now, heartbeatAt: now };
      state.runs.push(run);
      return send({ ...run, agentId: AGENT_ID, workdir: null });
    }
    if (path === '/v1/mail/sessions') {
      const free = state.messages.find(item => !item.acked && !item.leasedBy);
      if (!free) return send({ id: 'sess-empty', kind: 'embedded', label: 'run:empty', status: 'open', unread: 0 });
      const id = `sess${state.sessions.size + 1}`;
      free.leasedBy = id;
      state.sessions.set(id, free.id);
      state.openSessions += 1;
      state.maxOpenSessions = Math.max(state.maxOpenSessions, state.openSessions);
      return send({ id, kind: 'embedded', label: String(body.label ?? ''), status: 'open', unread: 1 });
    }
    const pull = /^\/v1\/mail\/sessions\/([^/]+)\/messages$/.exec(path);
    if (pull) {
      const sessionId = pull[1]!;
      const messageId = state.sessions.get(sessionId);
      const message = state.messages.find(item => item.id === messageId);
      if (!message) return send({ items: [], cursor: 0, session: { id: sessionId } });
      return send({
        items: [
          {
            id: message.id,
            seq: 1,
            deliveryId: `d-${message.id}`,
            topic: 'subtask.assigned',
            kind: 'subtask.assigned',
            priority: 'normal',
            summary: `任务 ${message.refId}`,
            ref: { type: 'subtask', id: message.refId, taskId: 't1', threadId: null },
            publisherId: 'owner',
            createdAt: new Date().toISOString(),
            expiresAt: null,
          },
        ],
        cursor: 1,
        session: { id: sessionId },
      });
    }
    const messageMatch = /^\/v1\/mail\/messages\/([^/]+)$/.exec(path);
    if (messageMatch) {
      state.mailFetched = true;
      if (options.delayMailMs) await sleep(options.delayMailMs);
      return send({ id: messageMatch[1], content: { text: `请处理 ${messageMatch[1]}` } });
    }
    if (path.endsWith('/ack')) {
      const id = /messages\/([^/]+)\/ack/.exec(path)?.[1];
      const message = state.messages.find(item => item.id === id);
      if (message) message.acked = true;
      return send({ id, state: 'acked', duplicate: false });
    }
    if (path.endsWith('/nack')) {
      const id = /messages\/([^/]+)\/nack/.exec(path)?.[1];
      const message = state.messages.find(item => item.id === id);
      if (message) message.nacked.push(Number(body.retryAfterSeconds ?? 0));
      return send({ id, state: 'pending', attempts: 1 });
    }
    const close = /^\/v1\/mail\/sessions\/([^/]+)\/close$/.exec(path);
    if (close) {
      state.openSessions = Math.max(0, state.openSessions - 1);
      return send({ id: close[1], status: 'closed' });
    }
    if (path === '/v1/subtasks/st1/accept') return send({ id: 'st1', status: 'accepted' });
    if (path === '/v1/subtasks/st2/accept') {
      // 传输层失败：客户端必须把它当成「结果未知」，不能继续假装成功。
      req.socket.destroy();
      return;
    }
    if (path.endsWith('/submit')) {
      return send({ id: path.split('/')[3], status: 'submitted' });
    }
    if (path.endsWith('/log')) {
      if (body.text) state.logs.push(String(body.text));
      return send({ ok: true });
    }
    if (path.endsWith('/finish')) {
      const id = /runs\/([^/]+)\/finish/.exec(path)?.[1] ?? '';
      state.finished.set(id, body);
      const run = state.runs.find(item => item.id === id);
      if (run) run.status = String(body.status ?? 'finished');
      return send({ ok: true });
    }
    if (path.startsWith('/v1/embedded/runs/')) {
      const id = /runs\/([^/]+)$/.exec(path)?.[1] ?? '';
      const run = state.runs.find(item => item.id === id);
      return send({ id, agentId: AGENT_ID, status: run?.status ?? 'unknown' });
    }
    if (path.endsWith('/heartbeat')) {
      const id = /runs\/([^/]+)\/heartbeat/.exec(path)?.[1];
      const run = state.runs.find(item => item.id === id);
      if (run) run.heartbeatAt = new Date().toISOString();
      return send({ ok: true });
    }
    send({});
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    get messages() {
      return state.messages;
    },
    get runs() {
      return state.runs;
    },
    get finished() {
      return state.finished;
    },
    get logs() {
      return state.logs;
    },
    get openSessions() {
      return state.openSessions;
    },
    get maxOpenSessions() {
      return state.maxOpenSessions;
    },
    get mailFetched() {
      return state.mailFetched;
    },
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

test('worker：同一 agent 并发两个 Session，一个失败不影响另一个', { timeout: 60_000 }, async () => {
  const stub = await startStub();
  const runRoot = mkdtempSync(join(tmpdir(), 'anpio-worker-'));
  try {
    const result = await new Promise<{ code: number; output: string }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['--disable-warning=ExperimentalWarning', SUPERVISOR, '--once', '--agent', AGENT_ID],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            COLLAB_BASE_URL: stub.url,
            COLLAB_RUNTIME_TOKEN: ADMIN_TOKEN,
            COLLAB_EMBEDDED_SECRET: SECRET,
            COLLAB_RUNTIME_TICK_MS: '200',
            COLLAB_RUNTIME_CONCURRENCY: '4',
            COLLAB_RUN_ROOT: runRoot,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
      child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
      child.on('error', reject);
      child.on('exit', code => resolve({ code: code ?? 1, output }));
    });

    assert.equal(result.code, 0, result.output);
    assert.equal(stub.runs.length, 2, result.output);
    assert.deepEqual(
      stub.runs.map(run => stub.finished.get(run.id)?.status).sort(),
      ['outcome_unknown', 'succeeded'],
      result.output,
    );
    // 成功的那条已确认；失败的那条退回队列并带长退避（结果未知）。
    assert.equal(stub.messages.find(item => item.id === 'm1')?.acked, true);
    assert.equal(stub.messages.find(item => item.id === 'm2')?.acked, false);
    assert.ok((stub.messages.find(item => item.id === 'm2')?.nacked[0] ?? 0) >= 300, JSON.stringify(stub.messages));

    // 两次运行各用各的目录与信箱，并且确实同时在跑。
    assert.ok(stub.logs.some(line => line.includes('sessions/run1')), stub.logs.join('\n'));
    assert.ok(stub.logs.some(line => line.includes('sessions/run2')), stub.logs.join('\n'));
    assert.equal(stub.maxOpenSessions, 2, result.output);
    assert.equal(existsSync(join(runRoot, AGENT_ID, 'sessions', 'run1')), false);
    assert.equal(existsSync(join(runRoot, AGENT_ID, 'sessions', 'run2')), false);

    // worker 只有一个：两个 Session 在同一个常驻进程里跑。
    const started = result.output.split('\n').filter(line => line.startsWith('▶')).length;
    assert.ok(started >= 3, result.output); // worker 启动 + 两个 session-start
  } finally {
    await stub.close();
    rmSync(runRoot, { recursive: true, force: true });
  }
});

test('worker：SIGTERM 优雅退出，未完成的运行退回消息', { timeout: 60_000 }, async () => {
  const stub = await startStub({ delayMailMs: 10_000 });
  const runRoot = mkdtempSync(join(tmpdir(), 'anpio-shutdown-'));
  const child = spawn(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', SUPERVISOR, '--agent', AGENT_ID],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        COLLAB_BASE_URL: stub.url,
        COLLAB_RUNTIME_TOKEN: ADMIN_TOKEN,
        COLLAB_EMBEDDED_SECRET: SECRET,
        COLLAB_RUNTIME_TICK_MS: '200',
        COLLAB_RUNTIME_CONCURRENCY: '4',
        COLLAB_WORKER_GRACE_MS: '300',
        COLLAB_RUN_ROOT: runRoot,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
  try {
    const deadline = Date.now() + 15_000;
    while (!stub.mailFetched && Date.now() < deadline) await sleep(50);
    assert.equal(stub.mailFetched, true, output);

    child.kill('SIGTERM');
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`supervisor 未退出：${output}`)), 20_000);
      child.on('exit', exitCode => {
        clearTimeout(timer);
        resolve(exitCode);
      });
    });
    assert.equal(code, 0, output);

    assert.ok(stub.runs.length >= 1, output);
    const finishedRuns = stub.runs.map(run => stub.finished.get(run.id));
    assert.ok(
      finishedRuns.every(run => run?.status === 'failed'),
      JSON.stringify(finishedRuns),
    );
    // 至少有一个运行是在执行中被中断的，不能悄悄记成成功。
    assert.ok(
      finishedRuns.some(run => /中断/.test(String(run?.error ?? ''))),
      JSON.stringify(finishedRuns),
    );
    // 没有确认的消息都已退回队列并带退避，不需要等租约到期。
    assert.equal(stub.messages.some(message => message.acked), false, JSON.stringify(stub.messages));
    assert.ok(
      stub.messages.some(message => (message.nacked[0] ?? 0) >= 300),
      JSON.stringify(stub.messages),
    );
    assert.equal(existsSync(join(runRoot, AGENT_ID, 'sessions', stub.runs[0]!.id)), false);
  } finally {
    child.kill('SIGKILL');
    await stub.close();
    rmSync(runRoot, { recursive: true, force: true });
  }
});
