/**
 * 本地 HTTP 服务：提交/查询、并发限制、失败隔离、鉴权、幂等键与 SIGTERM。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Brain } from '../src/brains/types.ts';
import { normalizeDefinition, StandaloneConfigError } from '../src/standalone/config.ts';
import { createStandaloneRuntime, StandaloneAgent } from '../src/standalone/runner.ts';
import { startStandaloneServer } from '../src/standalone/server.ts';
import { localTransport } from '../src/runtime/local/transport.ts';

type Json = Record<string, unknown>;

function workspace(): string {
  return mkdtempSync(join(tmpdir(), 'anpio-serve-'));
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function until<T>(fn: () => Promise<T>, ok: (value: T) => boolean, timeoutMs = 8_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await fn();
    if (ok(last)) return last;
    await delay(20);
  }
  throw new Error(`等待超时，最后一次结果：${JSON.stringify(last)}`);
}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<Json> {
  const response = await fetch(url, { headers });
  return (await response.json()) as Json;
}

async function postRun(
  base: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return await fetch(`${base}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

test('服务：POST /runs 返回 202，GET /runs/:id 能查到收尾结果', async () => {
  const dir = workspace();
  try {
    const definition = normalizeDefinition(
      {
        provider: {
          protocol: 'script',
          script: [{ tool: 'finish', input: { summary: 'HTTP 完成' } }],
        },
        tools: ['finish'],
      },
      'http-agent',
    );
    const root = join(dir, 'runs');
    const { runtime, transport } = await createStandaloneRuntime(definition, {
      root,
      log: () => undefined,
    });
    const agent = new StandaloneAgent(runtime, transport);
    const server = await startStandaloneServer({ agent, runtime, transport, port: 0 });
    try {
      const response = await postRun(server.url, { text: '你好', threadId: 'thread-1' });
      assert.equal(response.status, 202);
      const accepted = (await response.json()) as { runId: string };
      assert.match(accepted.runId, /^run-/);

      const record = await until(
        () => getJson(`${server.url}/runs/${accepted.runId}`),
        value => value.status !== 'running',
      );
      assert.equal(record.status, 'succeeded');
      assert.equal(record.summary, 'HTTP 完成');
      assert.equal(record.threadId, 'thread-1');
      assert.equal(record.error, null);
      assert.equal(typeof record.createdAt, 'string');
      assert.equal(typeof record.finishedAt, 'string');

      const health = await getJson(`${server.url}/health`);
      assert.deepEqual(health, { ok: true, active: 0, queued: 0 });

      const missing = await fetch(`${server.url}/runs/run-nope`);
      assert.equal(missing.status, 404);
    } finally {
      await server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('服务：并发受 concurrency 限制，第二个请求在队列里等待', async () => {
  const dir = workspace();
  try {
    const definition = normalizeDefinition(
      {
        provider: { protocol: 'anthropic-messages', model: 'test', apiKeyEnv: null },
        tools: ['finish'],
        concurrency: 1,
      },
      'gated-agent',
    );
    const root = join(dir, 'runs');

    let calls = 0;
    let maxCalls = 0;
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>(resolve => {
      markStarted = resolve;
    });
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const brain: Brain = {
      async complete() {
        calls += 1;
        maxCalls = Math.max(maxCalls, calls);
        if (calls === 1) {
          markStarted();
          await gate;
        }
        calls -= 1;
        return {
          toolCalls: [{ id: `finish-${calls}`, name: 'finish', input: { summary: '并发完成' } }],
          stopReason: 'tool_use',
        };
      },
    };

    const { runtime, transport } = await createStandaloneRuntime(definition, {
      root,
      brain,
      log: () => undefined,
    });
    const agent = new StandaloneAgent(runtime, transport);
    const server = await startStandaloneServer({ agent, runtime, transport, port: 0 });
    try {
      const first = await postRun(server.url, { text: '第一条' });
      assert.equal(first.status, 202);
      const firstRun = ((await first.json()) as { runId: string }).runId;
      await started;

      const second = await postRun(server.url, { text: '第二条' });
      assert.equal(second.status, 202);
      const secondRun = ((await second.json()) as { runId: string }).runId;

      const busy = await until(
        () => getJson(`${server.url}/health`),
        value => value.active === 1 && value.queued === 1,
      );
      assert.equal(busy.ok, true);

      release();
      const [firstRecord, secondRecord] = await Promise.all([
        until(() => getJson(`${server.url}/runs/${firstRun}`), value => value.status !== 'running'),
        until(() => getJson(`${server.url}/runs/${secondRun}`), value => value.status !== 'running'),
      ]);
      assert.equal(firstRecord.status, 'succeeded');
      assert.equal(secondRecord.status, 'succeeded');
      assert.equal(maxCalls, 1);

      const idle = await until(
        () => getJson(`${server.url}/health`),
        value => value.active === 0 && value.queued === 0,
      );
      assert.equal(idle.ok, true);
    } finally {
      await server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('服务：一个运行失败不影响另一个', async () => {
  const dir = workspace();
  try {
    const definition = normalizeDefinition(
      {
        provider: { protocol: 'anthropic-messages', model: 'test', apiKeyEnv: null },
        tools: ['finish'],
        concurrency: 2,
      },
      'isolation-agent',
    );
    const root = join(dir, 'runs');
    const brain: Brain = {
      async complete(request) {
        const last = request.messages.at(-1);
        const text = last && 'content' in last ? String(last.content ?? '') : '';
        if (text.includes('fail')) throw new Error('模拟模型失败');
        return {
          toolCalls: [{ id: 'finish-ok', name: 'finish', input: { summary: '成功' } }],
          stopReason: 'tool_use',
        };
      },
    };
    const { runtime, transport } = await createStandaloneRuntime(definition, {
      root,
      brain,
      log: () => undefined,
    });
    const agent = new StandaloneAgent(runtime, transport);
    const server = await startStandaloneServer({ agent, runtime, transport, port: 0 });
    try {
      const failing = await postRun(server.url, { text: 'please fail' });
      const succeeding = await postRun(server.url, { text: 'please pass' });
      const failRun = ((await failing.json()) as { runId: string }).runId;
      const okRun = ((await succeeding.json()) as { runId: string }).runId;

      const [failed, ok] = await Promise.all([
        until(() => getJson(`${server.url}/runs/${failRun}`), value => value.status !== 'running'),
        until(() => getJson(`${server.url}/runs/${okRun}`), value => value.status !== 'running'),
      ]);
      assert.equal(failed.status, 'failed');
      assert.match(String(failed.error), /模拟模型失败/);
      assert.equal(ok.status, 'succeeded');
      assert.equal(ok.summary, '成功');

      const health = await until(
        () => getJson(`${server.url}/health`),
        value => value.active === 0 && value.queued === 0,
      );
      assert.equal(health.ok, true);
    } finally {
      await server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('服务：Bearer 鉴权、幂等键与非回环地址保护', async () => {
  const dir = workspace();
  try {
    const definition = normalizeDefinition(
      {
        provider: {
          protocol: 'script',
          script: [{ tool: 'finish', input: { summary: '鉴权完成' } }],
        },
        tools: ['finish'],
      },
      'auth-agent',
    );
    const root = join(dir, 'runs');
    const { runtime, transport } = await createStandaloneRuntime(definition, {
      root,
      log: () => undefined,
    });
    const agent = new StandaloneAgent(runtime, transport);

    await assert.rejects(
      startStandaloneServer({ agent, runtime, transport, host: '0.0.0.0', port: 0 }),
      StandaloneConfigError,
    );

    const token = 'test-token';
    const server = await startStandaloneServer({ agent, runtime, transport, port: 0, token });
    const auth = { authorization: `Bearer ${token}` };
    try {
      const unauthorized = await postRun(server.url, { text: '你好' });
      assert.equal(unauthorized.status, 401);
      assert.equal((await fetch(`${server.url}/health`)).status, 401);

      const first = await postRun(server.url, { text: '你好' }, { ...auth, 'idempotency-key': 'k1' });
      assert.equal(first.status, 202);
      const firstRun = ((await first.json()) as { runId: string }).runId;
      await until(() => getJson(`${server.url}/runs/${firstRun}`, auth), value => value.status !== 'running');

      const replay = await postRun(server.url, { text: '你好' }, { ...auth, 'idempotency-key': 'k1' });
      assert.equal(replay.status, 202);
      assert.equal(((await replay.json()) as { runId: string }).runId, firstRun);

      const stats = await localTransport({ root }).mailbox.stats();
      assert.deepEqual(stats, { pending: 0, acked: 1, sessions: 0 });
    } finally {
      await server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('服务：SIGTERM 停止接新请求，并等在跑的一轮收尾', async () => {
  const dir = workspace();
  const root = join(dir, 'runs');
  let child: ChildProcessWithoutNullStreams | null = null;
  try {
    const file = join(dir, 'sigterm.json');
    writeFileSync(
      file,
      JSON.stringify({
        id: 'sigterm-agent',
        provider: {
          protocol: 'script',
          script: [
            { tool: 'shell', input: { command: 'sleep 1.2' } },
            { tool: 'finish', input: { summary: '收到退出信号后完成' } },
          ],
        },
        tools: ['shell', 'finish'],
        sandbox: { shell: true },
        limits: { timeoutMs: 10_000 },
      }),
    );

    const script = fileURLToPath(new URL('../src/standalone.ts', import.meta.url));
    child = spawn(
      process.execPath,
      [
        '--disable-warning=ExperimentalWarning',
        script,
        '--serve',
        '--agent',
        file,
        '--root',
        root,
        '--port',
        '0',
      ],
      {
        cwd: dir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, AGENT_SHUTDOWN_GRACE_MS: '8000' },
      },
    );

    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const base = await until(
      async () => stderr.match(/standalone 服务已启动：(http:\/\/127\.0\.0\.1:\d+)/)?.[1] ?? '',
      value => value !== '',
    );

    const accepted = await postRun(base, { text: '慢一点' });
    assert.equal(accepted.status, 202);
    const runId = ((await accepted.json()) as { runId: string }).runId;

    await until(async () => stderr.includes('调用工具 shell'), value => value);
    child.kill('SIGTERM');

    const code = await new Promise<number | null>(resolve => child!.once('close', resolve));
    assert.equal(code, 0, stderr);
    assert.match(stderr, /standalone 服务已退出/);

    const record = await localTransport({ root }).runs.get(runId);
    assert.equal(record?.status, 'succeeded');
    assert.equal(record?.summary, '收到退出信号后完成');
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});
