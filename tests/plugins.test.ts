/**
 * 插件层测试：命名/配置、`_meta`、渲染、MCP 连接、失败语义、并发、空闲回收，
 * 以及线程里的一次完整接入。
 *
 * 子进程用 `tests/fixtures/mcp-plugin.ts`：手写的最小 JSON-RPC server，
 * 这样才能模拟 stdout 污染、坏版本、中途退出这类合规 SDK 不会产生的行为。
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { Repl } from '../src/chat/repl.ts';

import type {
  Brain,
  BrainRequest,
  BrainResponse,
  ToolCall,
} from '../src/brains/types.ts';
import type { EmbeddedAgentDefinition } from '../src/definition.ts';
import { normalizeDefinition } from '../src/standalone/config.ts';
import { mergePlugins, pluginDefinitionsFromCli } from '../src/plugins/cli-spec.ts';
import { parsePlugins, resolvePluginPaths } from '../src/plugins/config.ts';
import { buildPluginMeta } from '../src/plugins/context.ts';
import { exposedToolName, isPluginToolName, sanitizePluginTool } from '../src/plugins/naming.ts';
import { PluginRegistry, PluginStartupError } from '../src/plugins/registry.ts';
import { renderPluginResult, truncateUtf8 } from '../src/plugins/render.ts';
import { withPlugins } from '../src/plugins/tools.ts';
import type { PluginCallContext, PluginDefinition, PluginProgress } from '../src/plugins/types.ts';
import { AgentRuntime } from '../src/runtime/agent.ts';
import type { BrainLoopTools } from '../src/runtime/brain-loop.ts';
import { StdinSource } from '../src/sources/stdin.ts';
import { AgentStore } from '../src/store/agent-store.ts';
import { ThreadHost } from '../src/threads/host.ts';
import { threadTransport } from '../src/threads/transport.ts';
import type { InboundMessage, MessageSource, ThreadEvent } from '../src/threads/types.ts';
import type { ToolLog } from '../src/tools.ts';

const FIXTURE = fileURLToPath(new URL('./fixtures/mcp-plugin.ts', import.meta.url));

/** 所有会改变 fixture 行为的变量；默认全部透传给插件进程。 */
const FIXTURE_ENV = [
  'MCP_FIXTURE_MODE',
  'MCP_FIXTURE_TOOLS',
  'MCP_FIXTURE_DELAY_MS',
  'MCP_FIXTURE_PROGRESS_STEPS',
  'MCP_FIXTURE_STDERR_LINES',
  'MCP_FIXTURE_CONCURRENCY_FILE',
  'MCP_FIXTURE_IGNORE_CANCEL',
  'MCP_FIXTURE_IS_ERROR',
  'MCP_FIXTURE_RPC_ERROR',
  'MCP_FIXTURE_PAGE_SIZE',
  'MCP_FIXTURE_PID_FILE',
];

function fixturePlugin(overrides: Partial<PluginDefinition> = {}): PluginDefinition {
  return {
    id: 'fixture',
    transport: 'stdio',
    command: process.execPath,
    args: [FIXTURE],
    env: [...FIXTURE_ENV],
    allow: ['echo', 'write_effect'],
    timeoutMs: 5_000,
    maxOutputBytes: 65_536,
    concurrency: 1,
    idleMs: 0,
    optional: false,
    ...overrides,
  };
}

async function withEnv(
  values: Record<string, string | undefined>,
  run: () => Promise<void>,
): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function registryFor(
  plugins: PluginDefinition[],
  log?: ToolLog,
): Promise<{
  registry: PluginRegistry;
  close: () => Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'plugin-test-'));
  const registry = new PluginRegistry({
    agentId: 'plugin-test',
    agentRoot: directory,
    plugins,
    ...(log === undefined ? {} : { log }),
  });
  return {
    registry,
    close: async () => {
      await registry.closeAll();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function call(name: string, input: Record<string, unknown> = {}, id = 'call-1'): ToolCall {
  return { id, name, input };
}

function context(overrides: Partial<PluginCallContext> = {}): PluginCallContext {
  return { runId: 'run-1', agentId: 'agent-1', turnId: 'turn-1', ...overrides };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function alive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readPid(file: string): Promise<number> {
  return Number((await readFile(file, 'utf8')).trim());
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(20);
  }
  throw new Error(`等待条件超时（${timeoutMs}ms）`);
}

test('命名规则与配置校验', () => {
  assert.equal(sanitizePluginTool('stage status/1'), 'stage-status-1');
  const long = exposedToolName('ci', 'x'.repeat(80));
  assert.equal(long.length, 64);
  assert.equal(long, exposedToolName('ci', 'x'.repeat(80)));
  assert.notEqual(long, exposedToolName('ci', `${'x'.repeat(79)}y`));
  assert.ok(long.startsWith('plugin__ci__'));
  assert.equal(isPluginToolName('plugin__ci__logs'), true);
  assert.equal(isPluginToolName('shell'), false);

  const plugins = parsePlugins([{ id: 'ci', command: 'node', allow: ['a', 'a'] }]);
  const first = plugins![0]!;
  assert.equal(first.transport, 'stdio');
  assert.deepEqual(first.allow, ['a']);
  assert.deepEqual(first.args, []);
  assert.deepEqual(first.env, []);
  assert.equal(first.timeoutMs, 30_000);
  assert.equal(first.maxOutputBytes, 65_536);
  assert.equal(first.concurrency, 1);
  assert.equal(first.idleMs, 300_000);
  assert.equal(first.optional, false);
  assert.equal(parsePlugins(undefined), undefined);
  assert.equal(parsePlugins([]), undefined);

  assert.throws(() => parsePlugins([{ id: 'Bad', command: 'x', allow: ['a'] }]), /id/);
  assert.throws(() => parsePlugins([{ id: 'ci', command: 'x', allow: [] }]), /allow/);
  assert.throws(
    () => parsePlugins([{ id: 'ci', command: 'x', allow: ['a'], env: ['TOKEN=1'] }]),
    /环境变量名/,
  );
  assert.throws(
    () => parsePlugins([{ id: 'ci', command: 'x', allow: ['a'], transport: 'http' }]),
    /阶段 4/,
  );
  assert.throws(
    () => parsePlugins([
      { id: 'ci', command: 'x', allow: ['a'] },
      { id: 'ci', command: 'y', allow: ['b'] },
    ]),
    /重复/,
  );
  assert.throws(
    () => parsePlugins([{ id: 'ci', command: 'x', allow: ['a b', 'a-b'] }]),
    /重名/,
  );
  assert.throws(
    () => parsePlugins([{ id: 'ci', command: 'x', allow: ['a'], extra: true }]),
    /不是已知字段/,
  );

  const resolved = resolvePluginPaths(
    parsePlugins([
      { id: 'ci', command: './bin/server', args: ['./server.ts', '--flag', 'plain'], allow: ['a'] },
    ]),
    '/defs',
  )!;
  assert.equal(resolved[0]!.command, '/defs/bin/server');
  assert.deepEqual(resolved[0]!.args, ['/defs/server.ts', '--flag', 'plain']);
});

test('script 协议接受已声明的插件工具，拒绝未声明的', () => {
  const definition = (tool: string): unknown => ({
    provider: { protocol: 'script', script: [{ tool }] },
    plugins: [{ id: 'ci', command: 'true', allow: ['echo'] }],
    tools: [],
  });

  const parsed = normalizeDefinition(definition('plugin__ci__echo'), 'demo');
  assert.equal(parsed.plugins?.[0]?.id, 'ci');
  assert.throws(
    () => normalizeDefinition(definition('plugin__ci__missing'), 'demo'),
    /插件工具要写 plugin__<id>__<tool>/,
  );

  // 命令行接入的插件还没写进定义文件，脚本也应该能引用。
  const cliOnly = normalizeDefinition(
    { provider: { protocol: 'script', script: [{ tool: 'plugin__cli__echo' }] }, tools: [] },
    'demo',
    { extraPlugins: [fixturePlugin({ id: 'cli', allow: ['echo'] })] },
  );
  assert.deepEqual(cliOnly.plugins, undefined);
  assert.throws(
    () => normalizeDefinition(
      { provider: { protocol: 'script', script: [{ tool: 'plugin__cli__echo' }] }, tools: [] },
      'demo',
    ),
    /插件工具要写 plugin__<id>__<tool>/,
  );
});

test('withPlugins 只路由插件工具，dispose 一定 endTurn', async () => {
  let ended = 0;
  const registry = {
    specs: () => [
      { name: 'plugin__ci__echo', description: 'echo', parameters: { type: 'object' } },
    ],
    has: (name: string) => name === 'plugin__ci__echo',
    call: async () => ({ content: 'plugin-result' }),
    endTurn: () => {
      ended += 1;
    },
  } as unknown as PluginRegistry;

  const base: BrainLoopTools = {
    specs: [{ name: 'finish', description: '结束', parameters: { type: 'object' } }],
    execute: async (invoked) => ({ content: `base:${invoked.name}` }),
  };

  const tools = withPlugins(base, registry, context());
  assert.deepEqual(tools.specs.map((spec) => spec.name), ['finish', 'plugin__ci__echo']);
  assert.equal((await tools.execute(call('finish'))).content, 'base:finish');
  assert.equal((await tools.execute(call('plugin__ci__echo'))).content, 'plugin-result');
  assert.equal((await tools.execute(call('plugin__ci__other'))).content, 'base:plugin__ci__other');
  assert.equal(withPlugins(base, null, context()), base);

  const failing: BrainLoopTools = {
    specs: [],
    execute: async () => ({ content: '' }),
    dispose: async () => {
      throw new Error('dispose 失败');
    },
  };
  const wrapped = withPlugins(failing, registry, context());
  await assert.rejects(wrapped.dispose!(), /dispose 失败/);
  assert.equal(ended, 1);
});

test('_meta 只带上下文、幂等键与 deadline', () => {
  const meta = buildPluginMeta(
    call('plugin__ci__stage_run', {}, 'call-7'),
    'ci',
    'stage_run',
    { runId: 'run-1', agentId: 'agent-1', threadId: 'th', turnId: 'turn-9', taskId: 'task-2' },
    1_000,
    Date.parse('2026-01-01T00:00:00.000Z'),
  );
  assert.deepEqual(meta, {
    runId: 'run-1',
    agentId: 'agent-1',
    threadId: 'th',
    turnId: 'turn-9',
    taskId: 'task-2',
    pluginId: 'ci',
    tool: 'stage_run',
    idempotencyKey: 'turn:turn-9:call-7',
    deadline: '2026-01-01T00:00:01.000Z',
  });
  assert.equal(/token|secret|apiKey/i.test(JSON.stringify(meta)), false);

  const noTurn = buildPluginMeta(
    call('plugin__ci__echo', {}, 'c1'),
    'ci',
    'echo',
    { runId: 'r', agentId: 'a' },
    0,
    0,
  );
  assert.equal(noTurn.idempotencyKey, 'run:r:c1');
  assert.equal(noTurn.deadline, '1970-01-01T00:00:00.000Z');
  assert.equal('turnId' in noTurn, false);
});

test('渲染 content 块、多字节截断与 isError', () => {
  const text = renderPluginResult(
    {
      content: [
        { type: 'text', text: '第一行' },
        { type: 'image', mimeType: 'image/png', data: '' },
        { type: 'resource', resource: { uri: 'file:///a', text: '资源正文' } },
        { type: 'resource_link', uri: 'https://example.com/x', name: '文档' },
      ],
      isError: false,
    },
    65_536,
  );
  assert.equal(text, '第一行\n[image/png]\n资源正文\n[link 文档]');
  assert.equal(
    renderPluginResult({ content: [], isError: false, structuredContent: { a: 1 } }, 1_000),
    '{"a":1}',
  );
  assert.equal(
    renderPluginResult({ content: [{ type: 'text', text: 'boom' }], isError: true }, 1_000),
    '工具失败：boom',
  );

  const cut = truncateUtf8('中'.repeat(10), 7);
  assert.ok(cut.startsWith('中中'));
  assert.ok(cut.includes('已截断到 7 字节'));
  assert.ok(!cut.slice(0, cut.indexOf('\n')).includes('�'));
});

test('只暴露 allow 命中的工具，并按 nextCursor 翻页', async () => {
  await withEnv(
    { MCP_FIXTURE_TOOLS: 'echo,write_effect,echo_meta', MCP_FIXTURE_PAGE_SIZE: '1' },
    async () => {
      const { registry, close } = await registryFor([
        fixturePlugin({ allow: ['echo', 'echo_meta'] }),
      ]);
      try {
        const prepared = await registry.prepare();
        assert.deepEqual(prepared.tools.map((tool) => tool.name), ['echo', 'echo_meta']);
        assert.deepEqual(prepared.tools.map((tool) => tool.exposedName), [
          'plugin__fixture__echo',
          'plugin__fixture__echo_meta',
        ]);
        assert.deepEqual(prepared.degraded, []);
        assert.deepEqual(registry.specs().map((spec) => spec.name), [
          'plugin__fixture__echo',
          'plugin__fixture__echo_meta',
        ]);
        assert.equal(prepared.tools[0]!.effects, 'read');
        assert.equal(prepared.tools[0]!.spec.description, 'echo fixture tool');
        assert.equal(prepared.tools[0]!.spec.parameters.type, 'object');
      } finally {
        await close();
      }
    },
  );
});

test('required 插件缺 allow 工具时启动失败并点名', async () => {
  const { registry, close } = await registryFor([
    fixturePlugin({ allow: ['echo', 'missing_tool'] }),
  ]);
  try {
    await assert.rejects(registry.prepare(), (error: unknown) => {
      assert.ok(error instanceof PluginStartupError);
      assert.match(error.message, /fixture/);
      assert.match(error.message, /missing_tool/);
      return true;
    });
    assert.deepEqual(registry.specs(), []);
  } finally {
    await close();
  }
});

test('optional 插件失败时降级，不影响其它插件', async () => {
  const logs: string[] = [];
  const { registry, close } = await registryFor(
    [
      fixturePlugin({ id: 'broken', allow: ['missing_tool'], optional: true }),
      fixturePlugin({ id: 'good', allow: ['echo'] }),
    ],
    (level, text) => logs.push(`${level}:${text}`),
  );
  try {
    const prepared = await registry.prepare();
    assert.deepEqual(prepared.tools.map((tool) => tool.exposedName), ['plugin__good__echo']);
    assert.equal(prepared.degraded.length, 1);
    assert.equal(prepared.degraded[0]!.id, 'broken');
    assert.match(prepared.degraded[0]!.reason, /missing_tool/);
    assert.ok(logs.some((line) => line.startsWith('warn:插件 broken 不可用')));

    const result = await registry.call(call('plugin__good__echo', { text: 'hi' }), context());
    assert.equal(result.content, 'hi');
  } finally {
    await close();
  }
});

test('启动失败：命令不存在、进程立刻退出、协议版本不支持', async () => {
  {
    const { registry, close } = await registryFor([
      fixturePlugin({ command: join(tmpdir(), 'anpio-mcp-does-not-exist') }),
    ]);
    try {
      await assert.rejects(registry.prepare(), /ENOENT/);
    } finally {
      await close();
    }
  }

  await withEnv({ MCP_FIXTURE_MODE: 'exit-on-start' }, async () => {
    const { registry, close } = await registryFor([fixturePlugin()]);
    try {
      await assert.rejects(registry.prepare(), /fixture/);
    } finally {
      await close();
    }
  });

  await withEnv({ MCP_FIXTURE_MODE: 'bad-version' }, async () => {
    const { registry, close } = await registryFor([fixturePlugin()]);
    try {
      await assert.rejects(registry.prepare(), /protocol version/);
    } finally {
      await close();
    }
  });
});

test('stdout 污染：连接关闭、调用失败、污染内容不进结果', async () => {
  await withEnv({ MCP_FIXTURE_MODE: 'pollute-stdout' }, async () => {
    const logs: string[] = [];
    const { registry, close } = await registryFor(
      [fixturePlugin({ allow: ['echo'], timeoutMs: 500 })],
      (level, text) => logs.push(`${level}:${text}`),
    );
    try {
      await registry.prepare();
      const result = await registry.call(call('plugin__fixture__echo', { text: 'hi' }), context());
      assert.ok(result.content.startsWith('工具失败：'));
      assert.ok(!result.content.includes('这一行不是'));
      assert.ok(logs.some((line) => line.includes('stdout')));
    } finally {
      await close();
    }
  });
});

test('超时：读工具是普通失败，写工具标记为结果未知', async () => {
  await withEnv({ MCP_FIXTURE_DELAY_MS: '500' }, async () => {
    const { registry, close } = await registryFor([
      fixturePlugin({ allow: ['echo', 'write_effect'], timeoutMs: 100 }),
    ]);
    try {
      await registry.prepare();
      const read = await registry.call(call('plugin__fixture__echo', { text: 'x' }), context());
      assert.ok(read.content.startsWith('工具失败：'));
      assert.equal(read.uncertain, undefined);

      const write = await registry.call(
        call('plugin__fixture__write_effect', { target: 'prod' }),
        context(),
      );
      assert.ok(write.content.startsWith('写请求结果未知：'));
      assert.equal(typeof write.uncertain, 'string');
    } finally {
      await close();
    }
  });
});

test('进程中途退出：读失败，写标记结果未知', async () => {
  await withEnv({ MCP_FIXTURE_MODE: 'exit-on-call' }, async () => {
    const { registry, close } = await registryFor([
      fixturePlugin({ allow: ['echo', 'write_effect'] }),
    ]);
    try {
      await registry.prepare();
      const read = await registry.call(call('plugin__fixture__echo'), context());
      assert.ok(read.content.startsWith('工具失败：'));
      assert.equal(read.uncertain, undefined);

      const write = await registry.call(call('plugin__fixture__write_effect'), context());
      assert.ok(write.content.startsWith('写请求结果未知：'));
      assert.ok(write.uncertain);
    } finally {
      await close();
    }
  });
});

test('进度通知带插件与工具，条数与 total 正确', async () => {
  await withEnv(
    { MCP_FIXTURE_TOOLS: 'progress', MCP_FIXTURE_PROGRESS_STEPS: '3' },
    async () => {
      const { registry, close } = await registryFor([fixturePlugin({ allow: ['progress'] })]);
      try {
        await registry.prepare();
        const events: PluginProgress[] = [];
        const result = await registry.call(
          call('plugin__fixture__progress', {}, 'call-p'),
          context({ onProgress: (event) => events.push(event) }),
        );
        assert.equal(result.content, '进度完成：3');
        assert.equal(events.length, 3);
        assert.deepEqual(events.map((event) => event.progress), [1, 2, 3]);
        assert.deepEqual(events.map((event) => event.total), [3, 3, 3]);
        assert.equal(events[0]!.pluginId, 'fixture');
        assert.equal(events[0]!.tool, 'progress');
        assert.equal(events[2]!.message, '3/3');
      } finally {
        await close();
      }
    },
  );
});

test('调用时把 _meta 发给插件（工具名用原名，键是幂等键）', async () => {
  await withEnv({ MCP_FIXTURE_TOOLS: 'echo_meta' }, async () => {
    const { registry, close } = await registryFor([fixturePlugin({ allow: ['echo_meta'] })]);
    try {
      await registry.prepare();
      const result = await registry.call(
        call('plugin__fixture__echo_meta', {}, 'call-9'),
        context({ turnId: 'turn-5' }),
      );
      const meta = JSON.parse(result.content) as Record<string, unknown>;
      assert.equal(meta.pluginId, 'fixture');
      assert.equal(meta.tool, 'echo_meta');
      assert.equal(meta.idempotencyKey, 'turn:turn-5:call-9');
      assert.equal(meta.agentId, 'agent-1');
      assert.equal(typeof meta.deadline, 'string');
      assert.equal(JSON.stringify(meta).includes('机密'), false);
    } finally {
      await close();
    }
  });
});

test('endTurn 不立即关连接，空闲到期后回收并在下次调用时重启', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plugin-idle-'));
  const pidFile = join(directory, 'pid');
  try {
    await withEnv(
      { MCP_FIXTURE_TOOLS: 'echo', MCP_FIXTURE_PID_FILE: pidFile },
      async () => {
        const { registry, close } = await registryFor([
          fixturePlugin({ allow: ['echo'], idleMs: 100 }),
        ]);
        try {
          await registry.prepare();
          const first = await registry.call(
            call('plugin__fixture__echo', { text: 'a' }),
            context(),
          );
          assert.equal(first.content, 'a');

          const firstPid = await readPid(pidFile);
          assert.ok(alive(firstPid));

          registry.endTurn();
          await delay(30);
          assert.ok(alive(firstPid), 'endTurn 不应该立即关连接');

          await waitFor(() => !alive(firstPid));

          const again = await registry.call(
            call('plugin__fixture__echo', { text: 'b' }),
            context(),
          );
          assert.equal(again.content, 'b');
          await waitFor(async () => (await readPid(pidFile)) !== firstPid);
          assert.ok(alive(await readPid(pidFile)));
        } finally {
          await close();
        }
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('concurrency 控制插件的并行调用', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plugin-concurrency-'));
  try {
    for (const concurrency of [1, 2]) {
      const file = join(directory, `calls-${concurrency}.log`);
      await withEnv(
        {
          MCP_FIXTURE_TOOLS: 'echo',
          MCP_FIXTURE_DELAY_MS: '120',
          MCP_FIXTURE_CONCURRENCY_FILE: file,
        },
        async () => {
          const { registry, close } = await registryFor([
            fixturePlugin({ allow: ['echo'], concurrency }),
          ]);
          try {
            await registry.prepare();
            const [first, second] = await Promise.all([
              registry.call(call('plugin__fixture__echo', { text: 'a' }, 'c1'), context()),
              registry.call(call('plugin__fixture__echo', { text: 'b' }, 'c2'), context()),
            ]);
            assert.equal(first.content, 'a');
            assert.equal(second.content, 'b');

            const lines = (await readFile(file, 'utf8'))
              .trim()
              .split('\n')
              .map((line) => line.split(' ')[0]);
            assert.deepEqual(
              lines,
              concurrency === 1
                ? ['start', 'end', 'start', 'end']
                : ['start', 'start', 'end', 'end'],
            );
          } finally {
            await close();
          }
        },
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('中止挂起的调用会及时返回且不留进程', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plugin-abort-'));
  const pidFile = join(directory, 'pid');
  try {
    await withEnv(
      { MCP_FIXTURE_TOOLS: 'hang', MCP_FIXTURE_PID_FILE: pidFile },
      async () => {
        const { registry, close } = await registryFor([
          fixturePlugin({ allow: ['hang'], timeoutMs: 10_000 }),
        ]);
        let pid = 0;
        try {
          await registry.prepare();
          pid = await readPid(pidFile);

          const controller = new AbortController();
          const started = Date.now();
          const pending = registry.call(
            call('plugin__fixture__hang'),
            context({ signal: controller.signal }),
          );
          await delay(80);
          controller.abort();

          const result = await pending;
          assert.ok(Date.now() - started < 3_000);
          assert.ok(result.content.startsWith('工具失败：'));
          assert.equal(result.uncertain, undefined);
        } finally {
          await close();
        }
        await waitFor(() => !alive(pid));
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('审计日志只有插件、工具、耗时与状态', async () => {
  const logs: string[] = [];
  const { registry, close } = await registryFor(
    [fixturePlugin({ allow: ['echo'] })],
    (level, text) => logs.push(`${level}:${text}`),
  );
  try {
    await registry.prepare();
    await registry.call(call('plugin__fixture__echo', { text: '机密参数' }), context());
    const line = logs.find((item) => item.includes('插件 fixture 工具 echo'));
    assert.ok(line);
    assert.match(line, /^debug:插件 fixture 工具 echo \d+ms ok$/);
    assert.ok(!line!.includes('机密参数'));
  } finally {
    await close();
  }
});

// ---- 线程集成 ----

class ToolBrain implements Brain {
  readonly requests: BrainRequest[] = [];
  private readonly steps: BrainResponse[];

  constructor(steps: BrainResponse[]) {
    this.steps = steps;
  }

  async complete(request: BrainRequest): Promise<BrainResponse> {
    this.requests.push(request);
    return this.steps.shift() ?? { text: '结束', stopReason: 'stop' };
  }
}

class FakeSource implements MessageSource {
  readonly id = 'stdin';
  readonly kind = 'interactive' as const;
  private queue: InboundMessage[] = [];
  private notify: (() => void) | null = null;

  async open(emit: () => void): Promise<void> {
    this.notify = emit;
  }

  async poll(): Promise<InboundMessage[]> {
    return this.queue.splice(0);
  }

  push(message: InboundMessage): void {
    this.queue.push(message);
    this.notify?.();
  }
}

function threadDefinition(plugins: PluginDefinition[]): EmbeddedAgentDefinition {
  const now = new Date().toISOString();
  return {
    id: 'plugin-thread-test',
    name: 'plugin-thread-test',
    description: '',
    capabilities: [],
    provider: {
      id: 'fake',
      protocol: 'openai-chat',
      baseUrl: 'http://127.0.0.1:1',
      model: 'fake',
      apiKeyEnv: null,
    },
    systemPrompt: '',
    tools: ['finish'],
    scopes: [],
    limits: { maxTurns: 4, timeoutMs: 5_000, maxTokens: 512 },
    sandbox: { shell: false, shellTimeoutMs: 1_000, maxOutputBytes: 1_024 },
    enabled: true,
    concurrency: 2,
    sessionIsolation: 'inline',
    completion: 'text',
    createdBy: null,
    createdAt: now,
    updatedAt: now,
    lastRunAt: null,
    lastError: null,
    plugins,
  };
}

test('线程集成：模型调用插件、进度事件透出、轮次正常收尾', async () => {
  await withEnv(
    { MCP_FIXTURE_TOOLS: 'progress', MCP_FIXTURE_PROGRESS_STEPS: '2' },
    async () => {
      const brain = new ToolBrain([
        {
          toolCalls: [{ id: 'p1', name: 'plugin__fixture__progress', input: {} }],
          stopReason: 'tool_use',
        },
        {
          toolCalls: [
            {
              id: 'f1',
              name: 'finish',
              input: { summary: '完成', outcome: 'done' },
            },
          ],
          stopReason: 'tool_use',
        },
        { text: '结束', stopReason: 'stop' },
      ]);

      const directory = await mkdtemp(join(tmpdir(), 'plugin-thread-'));
      const definition = threadDefinition([
        fixturePlugin({ allow: ['progress'], idleMs: 0 }),
      ]);
      const runtime = await AgentRuntime.create({
        agentId: definition.id,
        definition,
        transport: threadTransport(),
        rootBase: directory,
        brain,
      });
      const store = new AgentStore(join(runtime.root, 'agent.db'));
      const source = new FakeSource();
      const events: ThreadEvent[] = [];
      const logs: string[] = [];
      const host = new ThreadHost({
        runtime,
        definition,
        store,
        sources: [source],
        tickMs: 0,
        onEvent: (event) => events.push(event),
        log: (line) => logs.push(line),
      });

      try {
        await host.start();
        source.push({ id: 'm1', threadId: 'th', text: '跑插件' });
        await host.settle();

        const visible = events.filter((event) => event.type !== 'log');
        const end = visible.at(-1);
        assert.equal(end?.type, 'turn-end');
        assert.equal(end?.type === 'turn-end' ? end.status : null, 'succeeded');

        const progress = events.filter(
          (event): event is Extract<ThreadEvent, { type: 'plugin-progress' }> =>
            event.type === 'plugin-progress',
        );
        assert.equal(progress.length, 2);
        assert.deepEqual(progress.map((event) => event.progress), [1, 2]);
        assert.equal(progress[0]!.pluginId, 'fixture');
        assert.equal(progress[0]!.tool, 'progress');
        assert.equal(progress[1]!.total, 2);

        const result = visible.find(
          (event): event is Extract<ThreadEvent, { type: 'tool-result' }> =>
            event.type === 'tool-result',
        );
        assert.ok(result);
        assert.equal(result.name, 'plugin__fixture__progress');
        assert.match(result.content, /进度完成：2/);

        assert.ok(logs.some((line) => /插件 fixture 工具 progress \d+ms ok/.test(line)));
        assert.ok(!logs.join('\n').includes('progressToken'));
      } finally {
        await host.stop();
        await runtime.close();
        store.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});

test('命令行 --mcp：拆词、id、白名单、环境变量与相对路径', () => {
  const definitions = pluginDefinitionsFromCli(
    {
      mcp: ['ci=node ./server.ts --label "a b"'],
      allow: ['ci=logs_tail,stage_status'],
      env: ['ci=CI_TOKEN'],
    },
    '/work',
  );

  assert.equal(definitions.length, 1);
  const plugin = definitions[0]!;
  assert.equal(plugin.id, 'ci');
  assert.equal(plugin.command, 'node');
  assert.deepEqual(plugin.args, ['/work/server.ts', '--label', 'a b']);
  assert.deepEqual(plugin.allow, ['logs_tail', 'stage_status']);
  assert.deepEqual(plugin.env, ['CI_TOKEN']);
  // 其余字段走默认值，命令行只需要一条命令。
  assert.equal(plugin.transport, 'stdio');
  assert.equal(plugin.timeoutMs, 30_000);
  assert.equal(plugin.optional, false);

  // 不写 id 时从路径参数推导；重名自动加后缀。
  const derived = pluginDefinitionsFromCli(
    { mcp: ['node ./server.ts', 'node ./server.ts'], allow: [], env: [] },
    '/work',
  );
  assert.deepEqual(derived.map((item) => item.id), ['server', 'server-2']);
  // 命令行默认信任服务端的全部工具。
  assert.deepEqual(derived[0]!.allow, ['*']);
});

test('命令行 --mcp：错误提示可操作', () => {
  assert.throws(
    () => pluginDefinitionsFromCli({ mcp: ['ci=node "x'], allow: [], env: [] }),
    /引号没有闭合/,
  );
  assert.throws(
    () => pluginDefinitionsFromCli({ mcp: ['ci=node x'], allow: ['nope=echo'], env: [] }),
    /不存在的插件：nope/,
  );
  assert.throws(
    () => pluginDefinitionsFromCli({ mcp: [], allow: ['ci=echo'], env: [] }),
    /需要同时提供 --mcp/,
  );
  assert.throws(() => mergePlugins([fixturePlugin()], [fixturePlugin({ id: 'fixture' })]), /重复/);
  assert.throws(
    () => parsePlugins([{ id: 'x', command: 'node', allow: ['*', 'echo'] }]),
    /通配符/,
  );
});

test('allow: * 暴露全部工具；服务端没有工具时启动失败', async () => {
  const all = await registryFor([fixturePlugin({ allow: ['*'] })]);
  try {
    const prepared = await all.registry.prepare();
    assert.deepEqual(all.registry.tools().map((tool) => tool.name).sort(), ['echo', 'write_effect']);
    assert.deepEqual(prepared.tools.map((tool) => tool.exposedName).sort(), [
      'plugin__fixture__echo',
      'plugin__fixture__write_effect',
    ]);
  } finally {
    await all.close();
  }

  await withEnv({ MCP_FIXTURE_TOOLS: '' }, async () => {
    const empty = await registryFor([fixturePlugin({ allow: ['*'] })]);
    try {
      await assert.rejects(empty.registry.prepare(), /没有提供任何工具/);
    } finally {
      await empty.close();
    }
  });
});

test('运行时接入与移除插件：工具清单随之更新，其余连接保留', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plugin-runtime-'));
  const runtime = await AgentRuntime.create({
    agentId: 'plugin-runtime-test',
    definition: threadDefinition([]),
    transport: threadTransport(),
    rootBase: directory,
  });

  try {
    let prepared = await runtime.addPlugins([fixturePlugin({ id: 'one', allow: ['echo'] })]);
    assert.deepEqual(prepared.tools.map((tool) => tool.exposedName), ['plugin__one__echo']);

    await assert.rejects(
      runtime.addPlugins([fixturePlugin({ id: 'one', allow: ['echo'] })]),
      /插件 id 重复/,
    );

    prepared = await runtime.addPlugins([
      fixturePlugin({ id: 'two', allow: ['write_effect'] }),
    ]);
    assert.deepEqual(prepared.tools.map((tool) => tool.exposedName).sort(), [
      'plugin__one__echo',
      'plugin__two__write_effect',
    ]);
    assert.deepEqual(runtime.pluginDefinitions.map((plugin) => plugin.id), ['one', 'two']);

    prepared = await runtime.removePlugins(['one']);
    assert.deepEqual(prepared.tools.map((tool) => tool.exposedName), [
      'plugin__two__write_effect',
    ]);

    prepared = await runtime.removePlugins(['two']);
    assert.equal(prepared.tools.length, 0);
    assert.deepEqual(runtime.pluginDefinitions, []);
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('REPL /mcp：查看、接入、移除都经过插件控制层', async () => {
  const input = new PassThrough();
  const stdin = new StdinSource({ input });
  const out: string[] = [];
  const err: string[] = [];
  const collect = (sink: string[]): Writable => new Writable({
    write(chunk, _encoding, callback) {
      sink.push(String(chunk));
      callback();
    },
  });

  const calls: string[] = [];
  const control = {
    list: () => '已接入 1 个 MCP 插件：\n  demo  node server.ts\n    plugin__demo__echo（读）',
    add: async (spec: string) => {
      calls.push(`add:${spec}`);
      return '已接入插件 demo：plugin__demo__echo（读）';
    },
    remove: async (id: string) => {
      calls.push(`remove:${id}`);
      return `已移除插件 ${id}。`;
    },
  };
  const host = {
    snapshot: () => ({ threads: 0, pending: 0, sources: [] }),
    stop: async () => undefined,
    abortThread: () => false,
  } as unknown as ThreadHost;

  await stdin.open(() => undefined);
  const repl = new Repl({
    host,
    stdin,
    plugins: control,
    output: collect(out),
    error: collect(err),
  });
  const running = repl.run(false);

  input.write('/mcp\n');
  await delay(20);
  input.write('/mcp add demo=node server.ts\n');
  await delay(20);
  input.write('/mcp remove demo\n');
  await delay(20);
  input.write('/exit\n');
  input.end();
  await running;

  assert.deepEqual(calls, ['add:demo=node server.ts', 'remove:demo']);
  const text = out.join('');
  assert.match(text, /已接入 1 个 MCP 插件/);
  assert.match(text, /已接入插件 demo：plugin__demo__echo（读）/);
  assert.match(text, /已移除插件 demo。/);
  assert.equal(err.join(''), '');
});
