/**
 * 容器工具执行：容器内执行器、路径限制、docker 缺失时的明确跳过。
 *
 * 真正跑 Docker 的验收测试由 ANP_TEST_CONTAINER=1 控制；常规测试只验证
 * 主机侧脚本协议与回退路径，不依赖本机 Docker。
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Brain, BrainResponse } from '../src/brains/types.ts';
import { parseRouterConfig } from '../src/router/config.ts';
import { ContainerToolExecutor, probeContainer } from '../src/router/container.ts';
import { startRouter } from '../src/router/router.ts';

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

type ExecClient = { request(op: Record<string, unknown>): Promise<unknown> };

async function withExec(
  run: (client: ExecClient, workspace: string, token: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'anp-exec-'));
  const workspace = join(dir, 'workspace');
  await mkdir(workspace, { recursive: true });
  const token = 'test-tool-token';
  const child = spawn(process.execPath, [join(process.cwd(), 'container', 'exec.mjs')], {
    env: { ...process.env, ANP_WORKSPACE: workspace, ANP_TOOL_TOKEN: token },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let buffer = '';
  let sequence = 0;
  child.stdout.on('data', chunk => {
    buffer += chunk.toString('utf8');
    for (;;) {
      const index = buffer.indexOf('\n');
      if (index < 0) break;
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line === '') continue;
      const message = JSON.parse(line) as { id?: string; ok?: boolean; result?: unknown; error?: string };
      if (message.id === undefined) continue;
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      if (message.ok) waiter.resolve(message.result);
      else waiter.reject(new Error(message.error ?? '执行失败'));
    }
  });

  const request = (op: Record<string, unknown>) => new Promise<unknown>((resolve, reject) => {
    const id = `req-${sequence += 1}`;
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ id, ...op })}\n`);
  });

  try {
    await run({ request }, workspace, token);
  } finally {
    child.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  }
}

test('容器执行器：token 校验、文件读写、列目录与 shell', async () => {
  await withExec(async ({ request }, workspace, token) => {
    await assert.rejects(() => request({ op: 'auth', token: 'wrong' }), /token/);
    await request({ op: 'auth', token });

    assert.equal(await request({ op: 'write', path: 'notes/a.txt', content: '你好' }), 6);
    assert.equal(await request({ op: 'read', path: 'notes/a.txt' }), '你好');

    const entries = await request({ op: 'list', path: 'notes' }) as Array<{ name: string; type: string }>;
    assert.deepEqual(entries, [{ name: 'a.txt', type: 'file' }]);

    const result = await request({ op: 'shell', command: 'printf hello', timeoutMs: 5_000 }) as {
      exitCode: number;
      stdout: string;
    };
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, 'hello');

    const timedOut = await request({
      op: 'shell',
      command: 'sleep 5',
      timeoutMs: 200,
    }) as { timedOut: boolean };
    assert.equal(timedOut.timedOut, true);

    await readFile(join(workspace, 'notes', 'a.txt'), 'utf8');
  });
});

test('容器执行器：拒绝越界路径与符号链接逃逸', async () => {
  await withExec(async ({ request }, workspace) => {
    await request({ op: 'auth', token: 'test-tool-token' });

    await assert.rejects(() => request({ op: 'read', path: '../secret.txt' }), /工作目录/);
    await assert.rejects(() => request({ op: 'read', path: '/etc/passwd' }), /相对路径/);

    const outside = join(workspace, '..', 'outside');
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'secret.txt'), 'secret');
    await symlink(outside, join(workspace, 'link'));
    await assert.rejects(() => request({ op: 'read', path: 'link/secret.txt' }), /工作目录/);
  });
});

test('probeContainer：docker 不可用时返回原因', async () => {
  const probe = await probeContainer({ docker: '/definitely/not/a/docker/binary' });
  assert.equal(probe.available, false);
  assert.ok(probe.error);
});

test('容器启动失败给出构建镜像的提示', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anp-fake-docker-'));
  const docker = join(dir, 'docker');
  await writeFile(
    docker,
    '#!/bin/sh\nif [ "$1" = "version" ]; then echo 27.0.0; exit 0; fi\necho "no such image" >&2\nexit 1\n',
  );
  await chmod(docker, 0o755);
  try {
    assert.equal((await probeContainer({ docker })).available, true);
    const executor = new ContainerToolExecutor({
      docker,
      image: 'anp-toolbox:latest',
      memory: '1g',
      cpus: '1',
      pidsLimit: 256,
      workspace: dir,
      agentId: 'a',
      threadId: 't',
    });
    await assert.rejects(() => executor.readFile('x'), /container\/build\.sh/);
    await executor.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function containerAgent(id: string, isolation: 'container' | 'inline'): Record<string, unknown> {
  return {
    id,
    name: id,
    description: id,
    capabilities: [],
    provider: {
      protocol: 'openai-chat',
      baseUrl: 'http://127.0.0.1:1',
      model: 'fake',
      apiKeyEnv: null,
    },
    systemPrompt: `你是 ${id}。`,
    tools: ['shell', 'read_file', 'finish'],
    scopes: ['mailbox:read', 'mailbox:write'],
    limits: { maxTurns: 10, timeoutMs: 20_000, maxTokens: 1_024 },
    anp: { isolation },
  };
}

function containerRouterConfig(
  dir: string,
  options: { allowMissing: boolean },
): ReturnType<typeof parseRouterConfig> {
  return parseRouterConfig(
    {
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
      container: {
        docker: '/definitely/not/a/docker/binary',
        image: 'anp-toolbox:latest',
        allowMissing: options.allowMissing,
      },
    },
    { baseDir: dir },
  );
}

async function writeAgents(dir: string, agents: unknown[]): Promise<void> {
  await writeFile(join(dir, 'agents.json'), JSON.stringify({ agents }));
}

test('未允许缺失 docker 时，container agent 不启动', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anp-container-router-'));
  try {
    await writeAgents(dir, [containerAgent('box', 'container')]);
    const router = await startRouter({
      config: containerRouterConfig(dir, { allowMissing: false }),
      brains: { box: new ScriptedBrain([]) },
      listen: false,
      log: () => undefined,
    });
    try {
      assert.equal(router.getAgent('box'), undefined);
      assert.equal(router.status().agents, 0);
    } finally {
      await router.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('允许缺失 docker 时回退为进程内工具执行并留下工作产物', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anp-container-router-'));
  try {
    await writeAgents(dir, [containerAgent('box', 'container'), containerAgent('caller', 'inline')]);
    const router = await startRouter({
      config: containerRouterConfig(dir, { allowMissing: true }),
      brains: {
        caller: new ScriptedBrain([{ tool: 'finish', input: { summary: '已发送' } }]),
        box: new ScriptedBrain([
          { tool: 'shell', input: { command: 'printf host-side > skip.txt' } },
          { tool: 'finish', input: { summary: '已写入' } },
        ]),
      },
      listen: false,
      log: () => undefined,
    });
    try {
      assert.ok(router.getAgent('box'));
      await router.send({
        from: 'caller',
        to: 'agent:box',
        threadId: 'thread-box',
        payload: { type: 'anp.task.request', task_id: 'task-box', text: '写一个文件' },
      });
      await router.drain();

      const file = join(dir, 'root', 'agents', 'box', 'workspace', 'threads', 'thread-box', 'skip.txt');
      assert.equal((await readFile(file, 'utf8')).trim(), 'host-side');
    } finally {
      await router.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ANP_TEST_CONTAINER=1 时验收容器边界', { skip: process.env.ANP_TEST_CONTAINER !== '1' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anp-real-container-'));
  try {
    const workspace = join(dir, 'workspace');
    await mkdir(workspace, { recursive: true });
    const executor = new ContainerToolExecutor({
      docker: process.env.ANP_CONTAINER_DOCKER ?? 'docker',
      image: process.env.ANP_CONTAINER_IMAGE ?? 'anp-toolbox:latest',
      memory: '256m',
      cpus: '1',
      pidsLimit: 64,
      workspace,
      agentId: 'it',
      threadId: 'thread-it',
    });
    try {
      await executor.writeFile('probe.txt', 'inside');
      assert.equal(await executor.readFile('probe.txt'), 'inside');
      const env = await executor.shell({
        command: 'env',
        timeoutMs: 5_000,
        maxOutputBytes: 100_000,
      });
      assert.equal(/OPENAI|ANTHROPIC|API_KEY|ANP_ADMIN_TOKEN/i.test(env.stdout), false);
      const net = await executor.shell({
        command: 'command -v curl >/dev/null && curl -sS --max-time 2 http://127.0.0.1:8787/ || true',
        timeoutMs: 5_000,
        maxOutputBytes: 100_000,
      });
      assert.equal(net.stdout.trim(), '');
    } finally {
      await executor.dispose();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
