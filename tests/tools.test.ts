/**
 * 工具层与外部智能体的能力对齐。
 *
 * 用注入的 fetch 代替真实平台：验证每个工具打到的路径、请求体与本地文件落盘，
 * 不绑定端口，也不依赖 anpio-collab 的数据库与夹具。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CollabClient } from '../src/client.ts';
import { EMBEDDED_TOOLS, type EmbeddedAgentDefinition } from '../src/definition.ts';
import { TOOL_SPECS, createTools } from '../src/tools.ts';

const ALL_TOOLS: EmbeddedAgentDefinition['tools'] = [
  'task_get',
  'subtask_inbox',
  'task_accept',
  'task_progress',
  'task_submit',
  'subtask_reject',
  'task_comment',
  'task_comments',
  'offer_list',
  'offer_claim',
  'task_files',
  'file_download',
  'file_upload',
  'knowledge_search',
  'shell',
  'read_file',
  'write_file',
  'list_files',
  'finish',
];

function definition(tools = ALL_TOOLS): EmbeddedAgentDefinition {
  const now = new Date().toISOString();
  return {
    id: 'agent1',
    name: '能力对齐',
    description: '',
    capabilities: ['inventory'],
    provider: { id: 'script', protocol: 'script', baseUrl: '', model: 'script', apiKeyEnv: null },
    systemPrompt: '',
    tools,
    scopes: ['tasks:read', 'tasks:submit', 'offers:claim'],
    limits: { maxTurns: 5, timeoutMs: 10_000, maxTokens: 1_024 },
    sandbox: { shell: false, shellTimeoutMs: 1_000, maxOutputBytes: 4_096 },
    enabled: true,
    concurrency: 1,
    createdBy: null,
    createdAt: now,
    updatedAt: now,
    lastRunAt: null,
    lastError: null,
  };
}

type Seen = { method: string; path: string; body: Record<string, unknown> };

const FILE = {
  id: 'f1',
  taskId: 't1',
  name: '材料.txt',
  mime: 'text/plain',
  size: 5,
  kind: 'input',
  status: 'ready',
  version: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
};

function payloadFor(path: string, method: string, body: Record<string, unknown>): unknown {
  if (path === '/v1/inbox') {
    return [
      {
        id: 's1',
        taskId: 't1',
        kind: 'inventory',
        status: 'invited',
        version: 1,
        dueAt: null,
        dependsOn: [],
        task: { id: 't1', title: '核对库存', type: 'inventory', priority: 'normal', acceptance: '', dueAt: '', input: {} },
      },
    ];
  }
  if (path === '/v1/subtasks/s1/reject') return { id: 's1', status: 'rejected' };
  if (path === '/v1/tasks/t1/comments') return [{ id: 'c1', body: '先看材料' }];
  if (path === '/v1/offers') {
    return [
      {
        id: 'o1',
        taskId: 't2',
        taskTitle: '补货',
        kind: 'inventory',
        description: '',
        capability: 'inventory',
        dueAt: '2026-01-01T00:00:00.000Z',
        status: 'open',
        claimedBy: null,
        subtaskId: null,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ];
  }
  if (path === '/v1/offers/o1/claim') return { offerId: 'o1', subtaskId: 's9' };
  if (path === '/v1/tasks/t1/files' && method === 'GET') return [FILE];
  if (path === '/v1/tasks/t1/files/f1') {
    return { file: FILE, data: Buffer.from('hello', 'utf8').toString('base64') };
  }
  if (path === '/v1/tasks/t1/files' && method === 'POST') {
    return { ...FILE, id: 'f2', name: String(body.name), kind: 'output' };
  }
  return {};
}

function stubFetch(seen: Seen[]): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const method = init.method ?? 'GET';
    seen.push({ method, path: url.pathname, body });
    return new Response(JSON.stringify(payloadFor(url.pathname, method, body)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

test('工具清单：定义里的每个工具都有实现', () => {
  assert.deepEqual(Object.keys(TOOL_SPECS).sort(), [...EMBEDDED_TOOLS].sort());
});

test('工具：待办、拒绝、评论、开放池与任务文件与外部智能体一致', { timeout: 30_000 }, async () => {
  const runDir = mkdtempSync(join(tmpdir(), 'anpio-tools-'));
  const seen: Seen[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = stubFetch(seen);
  try {
    const tools = createTools({
      backend: new CollabClient('http://platform.test', 'agent-token'),
      runDir,
      runId: 'run1',
      definition: definition(),
      log: () => {},
    });

    const call = async (id: string, name: string, input: Record<string, unknown> = {}) => {
      const result = await tools.execute({ id, name, input });
      assert.equal(result.uncertain, undefined, result.content);
      return result.content;
    };

    assert.match(await call('c1', 'subtask_inbox'), /核对库存/);
    assert.match(await call('c2', 'subtask_reject', { subtaskId: 's1', reason: '没有该物料资料' }), /rejected/);
    assert.match(await call('c3', 'task_comments', { taskId: 't1' }), /先看材料/);
    assert.match(await call('c4', 'offer_list'), /补货/);
    assert.match(await call('c5', 'offer_claim', { offerId: 'o1' }), /s9/);
    assert.match(await call('c6', 'task_files', { taskId: 't1' }), /材料\.txt/);

    const downloaded = await call('c7', 'file_download', { taskId: 't1', fileId: 'f1' });
    assert.match(downloaded, /材料\.txt/);
    assert.equal(readFileSync(join(runDir, '材料.txt'), 'utf8'), 'hello');

    writeFileSync(join(runDir, 'result.txt'), 'hello');
    const uploaded = await call('c8', 'file_upload', { taskId: 't1', path: 'result.txt', kind: 'output' });
    assert.match(uploaded, /"id":"f2"/);

    const reject = seen.find(entry => entry.path === '/v1/subtasks/s1/reject');
    assert.equal(reject?.body.reason, '没有该物料资料');
    const upload = seen.find(entry => entry.path === '/v1/tasks/t1/files' && entry.method === 'POST');
    assert.equal(upload?.body.name, 'result.txt');
    assert.equal(upload?.body.data, Buffer.from('hello', 'utf8').toString('base64'));

    // 未启用的工具不会打到平台。
    const limited = createTools({
      backend: new CollabClient('http://platform.test', 'agent-token'),
      runDir,
      runId: 'run2',
      definition: definition(['task_get']),
      log: () => {},
    });
    const denied = await limited.execute({ id: 'c9', name: 'offer_claim', input: { offerId: 'o1' } });
    assert.match(denied.content, /没有在这一轮启用/);
    assert.equal(seen.filter(entry => entry.path === '/v1/offers/o1/claim').length, 1);
  } finally {
    globalThis.fetch = original;
    rmSync(runDir, { recursive: true, force: true });
  }
});
