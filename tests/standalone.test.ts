/**
 * 独立入口：定义文件默认值、脚本运行、text 完成策略、工具/密钥校验与 CLI。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDefinition, StandaloneConfigError } from '../src/standalone/config.ts';
import { ConversationStore } from '../src/standalone/conversation.ts';
import { createStandaloneRuntime, StandaloneAgent } from '../src/standalone/runner.ts';
import { localTransport } from '../src/runtime/local/transport.ts';

function workspace(): string {
  return mkdtempSync(join(tmpdir(), 'anpio-standalone-'));
}

function writeDefinition(dir: string, name: string, value: unknown): string {
  const file = join(dir, name);
  writeFileSync(file, JSON.stringify(value));
  return file;
}

function scriptDefinition(script: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: { protocol: 'script', script },
    ...extra,
  };
}

test('定义加载器：补齐 id、工具、限额与时间戳', async () => {
  const dir = workspace();
  try {
    const file = writeDefinition(dir, 'script agent.json', {
      provider: {
        protocol: 'script',
        script: [{ tool: 'finish', input: { summary: '完成' } }],
      },
    });
    const definition = await loadDefinition(file, { now: new Date('2026-01-02T03:04:05.000Z') });

    assert.equal(definition.id, 'script-agent');
    assert.equal(definition.name, 'script-agent');
    assert.deepEqual(definition.tools, ['read_file', 'write_file', 'list_files', 'finish']);
    assert.equal(definition.sandbox.shell, false);
    assert.equal(definition.sandbox.shellTimeoutMs, 30_000);
    assert.deepEqual(definition.limits, { maxTurns: 12, timeoutMs: 180_000, maxTokens: 8_192 });
    assert.equal(definition.concurrency, 1);
    assert.equal(definition.sessionIsolation, 'inline');
    assert.equal(definition.completion, 'finish');
    assert.equal(definition.createdAt, '2026-01-02T03:04:05.000Z');
    assert.equal(definition.provider.baseUrl, '');
    assert.equal(definition.provider.apiKeyEnv, null);
    assert.equal(definition.enabled, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('定义加载器：非 script 协议补默认地址，缺密钥启动即报错', async () => {
  const dir = workspace();
  const envName = 'ANPIO_TEST_MISSING_KEY';
  const previous = process.env[envName];
  delete process.env[envName];
  try {
    const file = writeDefinition(dir, 'openai.json', {
      provider: { protocol: 'openai-chat', model: 'gpt-test', apiKeyEnv: envName },
      tools: ['finish'],
    });
    await assert.rejects(loadDefinition(file), /缺少环境变量 ANPIO_TEST_MISSING_KEY/);

    process.env[envName] = 'test-key';
    const definition = await loadDefinition(file);
    assert.equal(definition.provider.baseUrl, 'https://api.openai.com/v1');
  } finally {
    if (previous === undefined) delete process.env[envName];
    else process.env[envName] = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('定义加载器：拒绝不可用协议、未知工具与未开启的 shell', async () => {
  const dir = workspace();
  try {
    const decision = writeDefinition(dir, 'decision.json', {
      provider: { protocol: 'decision-jev', model: 'x' },
    });
    await assert.rejects(loadDefinition(decision), /暂不支持独立多轮运行/);

    const unknownTool = writeDefinition(dir, 'unknown-tool.json', {
      provider: { protocol: 'script', script: [] },
      tools: ['rm_rf'],
    });
    await assert.rejects(loadDefinition(unknownTool), /不是已知工具/);

    const shellOff = writeDefinition(dir, 'shell-off.json', {
      provider: { protocol: 'script', script: [] },
      tools: ['shell', 'finish'],
      sandbox: { shell: false },
    });
    await assert.rejects(loadDefinition(shellOff), /tools 含 shell 时必须开启/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('独立运行：script 定义完成一轮、ack 消息并落账', async () => {
  const dir = workspace();
  try {
    const file = writeDefinition(
      dir,
      'demo.json',
      scriptDefinition(
        [
          { tool: 'write_file', input: { path: 'notes.txt', content: '独立运行\n' } },
          { tool: 'finish', input: { summary: '写好了 notes.txt', outcome: 'done' } },
        ],
        { tools: ['write_file', 'finish'] },
      ),
    );
    const definition = await loadDefinition(file);
    const root = join(dir, 'runs');
    const { runtime, transport } = await createStandaloneRuntime(definition, {
      root,
      log: () => undefined,
    });
    const agent = new StandaloneAgent(runtime, transport);
    const { runId, result } = await agent.run({ text: '写一份笔记' });

    assert.equal(result.status, 'succeeded');
    assert.equal(result.summary, '写好了 notes.txt');
    assert.equal(result.toolExecuted, true);
    assert.equal(result.mailSessionId?.startsWith('mail-session-'), true);
    assert.deepEqual(await transport.mailbox.stats(), { pending: 0, acked: 1, sessions: 0 });

    const record = await transport.runs.get(runId);
    assert.equal(record?.status, 'succeeded');
    assert.equal(record?.summary, '写好了 notes.txt');
    assert.equal(record?.input, '写一份笔记');

    const sessions = join(root, definition.id, 'sessions');
    assert.equal(existsSync(sessions), true);
    assert.deepEqual(readdirSync(sessions), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('独立运行：completion=text 时纯文本回答也算完成', async () => {
  const dir = workspace();
  try {
    const file = writeDefinition(
      dir,
      'chat.json',
      scriptDefinition([{ text: '这是直接回答。' }], { completion: 'text', tools: ['finish'] }),
    );
    const definition = await loadDefinition(file);
    const root = join(dir, 'runs');
    const { runtime, transport } = await createStandaloneRuntime(definition, {
      root,
      log: () => undefined,
    });
    const agent = new StandaloneAgent(runtime, transport);
    const { result } = await agent.run({ text: '你好' });

    assert.equal(result.status, 'succeeded');
    assert.equal(result.summary, '这是直接回答。');
    assert.deepEqual(await transport.mailbox.stats(), { pending: 0, acked: 1, sessions: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('独立运行：缺平台工具默认报错，允许降级后只用本地工具', async () => {
  const dir = workspace();
  try {
    const file = writeDefinition(
      dir,
      'mixed.json',
      scriptDefinition([{ tool: 'finish', input: { summary: '完成' } }], {
        tools: ['task_get', 'finish'],
      }),
    );
    const definition = await loadDefinition(file);
    const root = join(dir, 'runs');

    await assert.rejects(
      createStandaloneRuntime(definition, { root, log: () => undefined }),
      StandaloneConfigError,
    );

    const { runtime } = await createStandaloneRuntime(definition, {
      root,
      allowMissingTools: true,
      log: () => undefined,
    });
    assert.deepEqual(runtime.tools, ['finish']);
    assert.deepEqual(runtime.missingTools, ['task_get']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function runCli(args: string[], cwd: string, input?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const script = fileURLToPath(new URL('../src/standalone.ts', import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', script, ...args],
      { cwd, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', code => {
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

test('CLI：--message 输出结果 JSON，日志只进 stderr', async () => {
  const dir = workspace();
  try {
    const file = writeDefinition(
      dir,
      'demo.json',
      scriptDefinition(
        [
          { tool: 'write_file', input: { path: 'answer.txt', content: 'ok\n' } },
          { tool: 'finish', input: { summary: 'CLI 完成' } },
        ],
        { tools: ['write_file', 'finish'] },
      ),
    );
    const root = join(dir, 'runs');
    const outcome = await runCli(['--agent', file, '--message', '跑一下', '--root', root], dir);

    assert.equal(outcome.code, 0, outcome.stderr);
    const result = JSON.parse(outcome.stdout.trim()) as { runId: string; status: string; summary: string };
    assert.match(result.runId, /^run-/);
    assert.equal(result.status, 'succeeded');
    assert.equal(result.summary, 'CLI 完成');
    assert.match(outcome.stderr, /\[info\]/);
    assert.equal(outcome.stdout.trim().split('\n').length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI：stdin JSON 可带 threadId，配置错误退出码为 2', async () => {
  const dir = workspace();
  try {
    const file = writeDefinition(
      dir,
      'demo.json',
      scriptDefinition([{ tool: 'finish', input: { summary: 'stdin 完成' } }]),
    );
    const root = join(dir, 'runs');
    const ok = await runCli(
      ['--agent', file, '--root', root],
      dir,
      JSON.stringify({ text: '来自 stdin', threadId: 'thread-1' }),
    );
    assert.equal(ok.code, 0, ok.stderr);
    const parsed = JSON.parse(ok.stdout.trim()) as { runId: string; status: string };
    assert.equal(parsed.status, 'succeeded');

    const transport = localTransport({ root });
    const record = await transport.runs.get(parsed.runId);
    assert.equal(record?.threadId, 'thread-1');

    const bad = await runCli(['--agent', join(dir, 'missing.json')], dir, '你好');
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /定义文件不存在/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('独立运行：sessionIsolation=process 时在子进程里完成一轮并 ack', async () => {
  const dir = workspace();
  try {
    const file = writeDefinition(
      dir,
      'process-agent.json',
      scriptDefinition(
        [
          { tool: 'write_file', input: { path: 'from-child.txt', content: 'ok\n' } },
          { tool: 'finish', input: { summary: '子进程完成' } },
        ],
        {
          id: 'process-agent',
          tools: ['write_file', 'finish'],
          sessionIsolation: 'process',
          limits: { timeoutMs: 15_000 },
        },
      ),
    );
    const root = join(dir, 'runs');
    const definition = await loadDefinition(file);
    const { runtime, transport } = await createStandaloneRuntime(definition, {
      root,
      log: () => undefined,
    });
    const agent = new StandaloneAgent(runtime, transport, {
      conversations: new ConversationStore({ dir: join(root, '.local', 'conversations') }),
    });

    const { result } = await agent.run({ text: '在子进程里跑', threadId: 'process-thread' });
    assert.equal(result.status, 'succeeded');
    assert.equal(result.summary, '子进程完成');
    assert.deepEqual(await transport.mailbox.stats(), { pending: 0, acked: 1, sessions: 0 });

    const store = new ConversationStore({ dir: join(root, '.local', 'conversations') });
    assert.deepEqual(await store.load('process-thread'), [
      { role: 'user', content: '在子进程里跑' },
      { role: 'assistant', content: '子进程完成' },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI：同一 --thread 的两轮都会写进本地会话历史', async () => {
  const dir = workspace();
  try {
    const file = writeDefinition(
      dir,
      'demo.json',
      scriptDefinition([{ tool: 'finish', input: { summary: '脚本完成' } }]),
    );
    const root = join(dir, 'runs');
    const first = await runCli(
      ['--agent', file, '--message', '第一轮输入', '--thread', 'thread-1', '--root', root],
      dir,
    );
    assert.equal(first.code, 0, first.stderr);
    const second = await runCli(
      ['--agent', file, '--message', '第二轮输入', '--thread', 'thread-1', '--root', root],
      dir,
    );
    assert.equal(second.code, 0, second.stderr);

    const store = new ConversationStore({ dir: join(root, '.local', 'conversations') });
    assert.deepEqual(await store.load('thread-1'), [
      { role: 'user', content: '第一轮输入' },
      { role: 'assistant', content: '脚本完成' },
      { role: 'user', content: '第二轮输入' },
      { role: 'assistant', content: '脚本完成' },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
