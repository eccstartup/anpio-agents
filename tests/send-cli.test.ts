/**
 * `anp:send`：参数解析与对管理接口的请求形状，不发真实网络请求。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSendArgs, sendViaAdmin } from '../src/anp/send-cli.ts';

test('anp:send 解析参数与默认值', () => {
  const { options, help } = parseSendArgs(
    ['--from', 'planner', '--to', 'worker', '--thread', 't1', '--text', '你好'],
    { ANP_ADMIN_URL: 'http://127.0.0.1:9999', ANP_ADMIN_TOKEN: 'secret' },
  );
  assert.equal(help, false);
  assert.equal(options.adminUrl, 'http://127.0.0.1:9999');
  assert.equal(options.token, 'secret');
  assert.equal(options.from, 'planner');
  assert.equal(options.to, 'worker');
  assert.equal(options.threadId, 't1');
  assert.equal(options.text, '你好');
});

test('anp:send 缺少目标或正文时报错', () => {
  assert.throws(() => parseSendArgs(['--from', 'planner', '--text', 'x']), /--to 与 --skills/);
  assert.throws(() => parseSendArgs(['--from', 'planner', '--to', 'worker']), /--text/);
  assert.throws(() => parseSendArgs(['--from', 'planner', '--to', 'worker', '--text', 'x', '--nope']), /未知参数/);
});

test('anp:send 向管理接口发 JSON，并带 Bearer 令牌', async () => {
  const captured: { value: { url: string; init: RequestInit } | null } = { value: null };
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    captured.value = { url: String(url), init: init ?? {} };
    return new Response(JSON.stringify({ route: { agentId: 'worker' }, messageId: 'msg-1' }), {
      status: 202,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  const result = await sendViaAdmin(
    {
      adminUrl: 'http://127.0.0.1:8788',
      token: 'secret',
      from: 'planner',
      to: 'worker',
      threadId: 't1',
      skills: [],
      text: '你好',
      title: null,
      type: 'anp.task.request',
      replyTo: null,
    },
    fetchImpl,
  );

  assert.equal(result.messageId, 'msg-1');
  const seen = captured.value;
  assert.ok(seen);
  assert.equal(seen.url, 'http://127.0.0.1:8788/admin/messages');
  assert.equal(seen.init.method, 'POST');
  assert.equal((seen.init.headers as Record<string, string>).authorization, 'Bearer secret');
  assert.deepEqual(JSON.parse(String(seen.init.body)), {
    from: 'planner',
    to: 'worker',
    threadId: 't1',
    payload: { type: 'anp.task.request', text: '你好' },
  });
});

test('anp:send 把管理接口的错误信息带回命令行', async () => {
  const fetchImpl = (async () => new Response(
    JSON.stringify({ error: 'bad_request', message: '目标 agent 不存在' }),
    { status: 400 },
  )) as typeof fetch;
  await assert.rejects(
    () => sendViaAdmin(
      {
        adminUrl: 'http://127.0.0.1:8788',
        token: null,
        from: 'planner',
        to: 'worker',
        threadId: null,
        skills: [],
        text: '你好',
        title: null,
        type: null,
        replyTo: null,
      },
      fetchImpl,
    ),
    /HTTP 400：目标 agent 不存在/,
  );
});
