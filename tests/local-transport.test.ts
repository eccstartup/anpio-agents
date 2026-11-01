/**
 * 本地传输层：租约、ack/nack、并发拉取、落盘恢复与运行账本。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionResult } from '../src/runtime/types.ts';
import { LocalRunLedger } from '../src/runtime/local/ledger.ts';
import { LocalMailbox } from '../src/runtime/local/mailbox.ts';
import { localTransport } from '../src/runtime/local/transport.ts';

function clock(): { now: () => number; advance: (ms: number) => void } {
  let value = 1_000_000;
  return { now: () => value, advance: ms => (value += ms) };
}

function result(status: SessionResult['status']): SessionResult {
  return {
    status,
    turns: 2,
    promptTokens: 10,
    completionTokens: 5,
    error: null,
    summary: '完成',
    toolExecuted: true,
    mailSessionId: 'mail-session-1',
  };
}

test('本地信箱：两个会话并发拉取不重复投递', async () => {
  const time = clock();
  const mailbox = new LocalMailbox({ now: time.now });
  await mailbox.enqueue({ text: '第一条' });
  await mailbox.enqueue({ text: '第二条' });

  const first = await mailbox.open({ label: 'a' });
  const second = await mailbox.open({ label: 'b' });
  const [pageA, pageB] = await Promise.all([
    mailbox.pull(first.id, { limit: 1 }),
    mailbox.pull(second.id, { limit: 1 }),
  ]);

  assert.equal(pageA.items.length, 1);
  assert.equal(pageB.items.length, 1);
  assert.notEqual(pageA.items[0].id, pageB.items[0].id);
  assert.equal((await mailbox.message(pageA.items[0].id)).content && true, true);

  const body = (await mailbox.message(pageA.items[0].id)).content as { text: string };
  assert.match(body.text, /第一条|第二条/);
});

test('本地信箱：绑定 runId 的消息只会被对应运行拉走', async () => {
  const mailbox = new LocalMailbox();
  const firstMessage = await mailbox.enqueue({ text: '属于 A', runId: 'run-a' });
  const secondMessage = await mailbox.enqueue({ text: '属于 B', runId: 'run-b' });

  const sessionA = await mailbox.open({ label: 'run:run-a' });
  const sessionB = await mailbox.open({ label: 'run:run-b' });
  const pageA = await mailbox.pull(sessionA.id);
  const pageB = await mailbox.pull(sessionB.id);

  assert.deepEqual(pageA.items.map(item => item.id), [firstMessage.id]);
  assert.deepEqual(pageB.items.map(item => item.id), [secondMessage.id]);

  await mailbox.close(sessionA.id);
  const reopenedA = await mailbox.open({ label: 'run:run-a' });
  const empty = await mailbox.pull(reopenedA.id);
  assert.equal(empty.items.length, 0);
});

test('本地信箱：一次性运行结束后，未确认的输入不会一直 pending', async () => {
  const mailbox = new LocalMailbox();
  await mailbox.enqueue({ text: '会失败', runId: 'run-fail' });
  const session = await mailbox.open({ label: 'run:run-fail' });
  const page = await mailbox.pull(session.id);
  await mailbox.nack(page.items[0]!.id, {
    deliveryId: page.items[0]!.deliveryId,
    reason: '本轮失败',
  });
  assert.deepEqual(await mailbox.stats(), { pending: 1, acked: 0, sessions: 1 });

  await mailbox.close(session.id);
  assert.deepEqual(await mailbox.stats(), { pending: 0, acked: 1, sessions: 0 });
});

test('本地信箱：ack 后不再投递，nack 退避后可由新会话拉起', async () => {
  const time = clock();
  const mailbox = new LocalMailbox({ now: time.now });
  const { id } = await mailbox.enqueue({ text: '需要重试' });

  const first = await mailbox.open();
  const page = await mailbox.pull(first.id);
  assert.equal(page.items[0].id, id);
  await mailbox.nack(id, { deliveryId: page.items[0].deliveryId, retryAfterSeconds: 10, reason: '稍后再试' });
  await mailbox.close(first.id);

  const early = await mailbox.open();
  const empty = await mailbox.pull(early.id);
  assert.equal(empty.items.length, 0);

  time.advance(11_000);
  const later = await mailbox.open();
  const retried = await mailbox.pull(later.id);
  assert.equal(retried.items.length, 1);
  assert.equal(retried.items[0].id, id);

  await mailbox.ack(id, retried.items[0].deliveryId);
  const third = await mailbox.open();
  assert.equal((await mailbox.pull(third.id)).items.length, 0);
  assert.deepEqual(await mailbox.stats(), { pending: 0, acked: 1, sessions: 3 });
});

test('本地信箱：租约到期后其它会话可以接手', async () => {
  const time = clock();
  const mailbox = new LocalMailbox({ now: time.now });
  const { id } = await mailbox.enqueue({ text: '租约' });

  const first = await mailbox.open();
  assert.equal((await mailbox.pull(first.id, { leaseSeconds: 5 })).items[0].id, id);

  const blocked = await mailbox.open();
  assert.equal((await mailbox.pull(blocked.id)).items.length, 0);

  time.advance(6_000);
  const takeover = await mailbox.open();
  assert.equal((await mailbox.pull(takeover.id)).items[0].id, id);

  // 旧会话的 deliveryId 已经失效，不能把新租约 ack 掉。
  const stale = await mailbox.open();
  await assert.rejects(mailbox.ack(id, 'delivery-stale'), /投递凭据/);
  assert.equal((await mailbox.pull(stale.id)).items.length, 0);
});

test('本地信箱：JSON 快照可以被新的实例恢复', async () => {
  const root = mkdtempSync(join(tmpdir(), 'anpio-local-mail-'));
  try {
    const file = join(root, 'mailbox.json');
    const first = new LocalMailbox({ file });
    const { id } = await first.enqueue({ text: '落盘', threadId: 'thread-1' });
    const session = await first.open({ label: 'persisted' });
    const page = await first.pull(session.id);
    assert.equal(page.items[0].id, id);

    const second = new LocalMailbox({ file });
    const message = await second.message(id);
    assert.deepEqual(message.content, { text: '落盘' });
    assert.equal(message.ref.threadId, 'thread-1');
    assert.equal((await second.pull((await second.open()).id)).items.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('本地账本：心跳、日志与收尾状态', async () => {
  const root = mkdtempSync(join(tmpdir(), 'anpio-local-ledger-'));
  try {
    const ledger = new LocalRunLedger({ dir: root });
    await ledger.create('run1', { input: '做点事', threadId: 'thread-1' });
    assert.equal((await ledger.status('run1')).status, 'running');
    await ledger.heartbeat('run1', { sessionId: 'session-1' });
    await ledger.log('run1', 'info', '开始');
    await ledger.finish('run1', result('succeeded'));

    const record = await ledger.get('run1');
    assert.equal(record?.status, 'succeeded');
    assert.equal(record?.summary, '完成');
    assert.equal(record?.mailSessionId, 'mail-session-1');
    assert.equal(record?.threadId, 'thread-1');
    assert.deepEqual((await ledger.readLog('run1')).map(item => item.text), ['开始']);
    assert.equal((await ledger.status('missing')).status, 'running');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('本地传输层：只有本地原语，注入 ToolBackend 后才支持平台工具', async () => {
  const root = mkdtempSync(join(tmpdir(), 'anpio-local-transport-'));
  try {
    const bare = localTransport({ root });
    assert.equal(bare.supportsTool('shell'), true);
    assert.equal(bare.supportsTool('finish'), true);
    assert.equal(bare.supportsTool('task_get'), false);
    assert.equal(bare.spawnConfig?.('run1')?.type, 'local');

    const withTools = localTransport({
      root,
      tools: {} as never,
    });
    assert.equal(withTools.supportsTool('task_get'), true);

    const { id } = await bare.enqueue({ text: '你好' });
    const session = await bare.mailbox.open();
    const page = await bare.mailbox.pull(session.id);
    assert.equal(page.items[0].id, id);
    assert.equal((await bare.mailbox.message(id)).summary, '你好');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
