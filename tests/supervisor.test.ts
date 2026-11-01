/**
 * supervisor + session 的跨进程验证。
 *
 * 平台侧用最小 HTTP 桩：只实现执行引擎会调用的接口，返回一个 script 定义与
 * 一条待处理消息，然后断言结果提交、消息确认、运行收尾与沙箱目录回收。
 * 这里不引入 anpio-collab 的数据库与测试夹具，保持新仓库可独立运行。
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
import { deriveEmbeddedToken } from '../src/token.ts';

const SECRET = 'embedded-test-secret-0123456789abcdef';
const ADMIN_TOKEN = 'admin-test-token';
const AGENT_ID = 'agent1';
const SUPERVISOR = fileURLToPath(new URL('../src/supervisor.ts', import.meta.url));

function definition(): EmbeddedAgentDefinition & { unread: number; running: number } {
  const now = new Date().toISOString();
  return {
    id: AGENT_ID,
    name: '库存助手',
    description: '脚本智能体，用于运行时验证',
    capabilities: ['inventory'],
    provider: {
      id: 'script',
      protocol: 'script',
      baseUrl: '',
      model: 'script',
      apiKeyEnv: null,
      script: [
        { tool: 'task_accept', input: { subtaskId: '{{refId}}' } },
        { tool: 'task_progress', input: { subtaskId: '{{refId}}', text: '核对中' } },
        {
          tool: 'task_submit',
          input: {
            subtaskId: '{{refId}}',
            result: { summary: '库存核对完成', source: 'runtime-test', observedAt: '{{now}}' },
          },
        },
        { tool: 'finish', input: { summary: '一轮完成', outcome: 'done' } },
      ],
    },
    systemPrompt: '',
    tools: ['task_accept', 'task_progress', 'task_submit', 'read_file', 'write_file', 'list_files', 'finish'],
    scopes: ['tasks:read', 'tasks:submit', 'comments:write', 'mailbox:read', 'mailbox:write'],
    limits: { maxTurns: 10, timeoutMs: 30_000, maxTokens: 1_024 },
    sandbox: { shell: false, shellTimeoutMs: 5_000, maxOutputBytes: 16_384 },
    enabled: true,
    concurrency: 1,
    createdBy: null,
    createdAt: now,
    updatedAt: now,
    lastRunAt: null,
    lastError: null,
    unread: 1,
    running: 0,
  };
}

type Stub = {
  url: string;
  finished: Record<string, unknown> | null;
  logs: string[];
  acked: string[];
  submitted: Record<string, unknown> | null;
  authByPath: Map<string, string>;
  close: () => Promise<void>;
};

async function startStub(): Promise<Stub> {
  const state = {
    finished: null as Record<string, unknown> | null,
    logs: [] as string[],
    acked: [] as string[],
    submitted: null as Record<string, unknown> | null,
    authByPath: new Map<string, string>(),
  };
  const agent = definition();

  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const path = new URL(req.url ?? '/', 'http://stub').pathname;
    state.authByPath.set(path, String(req.headers.authorization ?? ''));

    const send = (payload: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    if (path === '/v1/embedded/agents') return send([agent]);
    if (path.endsWith('/ensure')) return send({ ok: true });
    if (path.endsWith('/supervisors/heartbeat')) return send({ ok: true });
    if (path === '/v1/embedded/recover') return send({ recovered: [] });
    if (path.endsWith('/agents/' + AGENT_ID + '/run')) {
      return send({ id: 'run1', agentId: AGENT_ID, status: 'running', workdir: null, startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() });
    }
    if (path.endsWith('/runs?limit=5') || path.endsWith('/runs')) return send([]);
    if (path === '/v1/mail/sessions') {
      return send({ id: 'sess1', kind: 'embedded', label: 'run:run1', status: 'open', unread: 1 });
    }
    if (path === '/v1/mail/sessions/sess1/messages') {
      return send({
        items: [
          {
            id: 'm1',
            seq: 1,
            deliveryId: 'd1',
            topic: 'subtask.assigned',
            kind: 'subtask.assigned',
            priority: 'normal',
            summary: '库存核对',
            ref: { type: 'subtask', id: 'st1', taskId: 't1', threadId: null },
            publisherId: 'owner',
            createdAt: new Date().toISOString(),
            expiresAt: null,
          },
        ],
        cursor: 1,
        session: { id: 'sess1' },
      });
    }
    if (path === '/v1/mail/messages/m1') {
      return send({ id: 'm1', content: { text: '请核对库存' } });
    }
    if (path.endsWith('/ack')) {
      state.acked.push(path);
      return send({ id: 'm1', state: 'acked', duplicate: false });
    }
    if (path.endsWith('/nack')) return send({ id: 'm1', state: 'pending', attempts: 1 });
    if (path.endsWith('/close')) return send({ id: 'sess1', status: 'closed' });
    if (path === '/v1/subtasks/st1/accept') return send({ id: 'st1', status: 'accepted' });
    if (path === '/v1/subtasks/st1/progress') return send({ id: 'st1', status: 'in_progress' });
    if (path === '/v1/subtasks/st1/submit') {
      state.submitted = body.result as Record<string, unknown>;
      return send({ id: 'st1', status: 'submitted' });
    }
    if (path.endsWith('/log') && body.text) {
      state.logs.push(String(body.text));
    }
    if (path.endsWith('/heartbeat')) return send({ ok: true });
    if (path === '/v1/agent/heartbeat') return send({ principalId: `embedded-${AGENT_ID}`, state: 'offline' });
    if (path.endsWith('/finish')) {
      state.finished = body;
      return send({ ok: true });
    }
    if (path === '/v1/embedded/runs/run1') {
      return send({ id: 'run1', agentId: AGENT_ID, status: state.finished ? 'succeeded' : 'running' });
    }
    send({});
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    get finished() {
      return state.finished;
    },
    get logs() {
      return state.logs;
    },
    get acked() {
      return state.acked;
    },
    get submitted() {
      return state.submitted;
    },
    authByPath: state.authByPath,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

test('supervisor：脚本智能体跨进程接活、提交并收尾', { timeout: 60_000 }, async () => {
  const stub = await startStub();
  const runRoot = mkdtempSync(join(tmpdir(), 'anpio-agents-'));
  try {
    const result = await new Promise<{ code: number; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SUPERVISOR, '--once', '--agent', AGENT_ID], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          COLLAB_BASE_URL: stub.url,
          COLLAB_RUNTIME_TOKEN: ADMIN_TOKEN,
          COLLAB_EMBEDDED_SECRET: SECRET,
          COLLAB_RUNTIME_TICK_MS: '200',
          COLLAB_RUN_ROOT: runRoot,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
      child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
      child.on('error', reject);
      child.on('exit', code => resolve({ code: code ?? 1, output }));
    });

    assert.equal(result.code, 0, result.output);
    assert.equal(stub.finished?.status, 'succeeded', JSON.stringify(stub.finished));
    assert.equal(stub.finished?.turns, 4);
    assert.equal(stub.finished?.outcomeUnknown, false);
    assert.equal((stub.submitted as { summary?: string } | null)?.summary, '库存核对完成');
    assert.equal(stub.acked.length, 1);
    assert.ok(stub.logs.some(line => line.includes('运行开始')), stub.logs.join('\n'));
    assert.ok(stub.logs.some(line => line.includes('收尾')), stub.logs.join('\n'));

    // 子进程用的是派生令牌，不是 supervisor 的管理员令牌。
    assert.equal(
      stub.authByPath.get('/v1/subtasks/st1/submit'),
      `Bearer ${deriveEmbeddedToken(SECRET, AGENT_ID)}`,
    );
    assert.equal(stub.authByPath.get('/v1/embedded/agents'), `Bearer ${ADMIN_TOKEN}`);

    // 运行目录默认在结束后清理。
    assert.equal(existsSync(join(runRoot, AGENT_ID, 'run1')), false);
  } finally {
    await stub.close();
    rmSync(runRoot, { recursive: true, force: true });
  }
});
