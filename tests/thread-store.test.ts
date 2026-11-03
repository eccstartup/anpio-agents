import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentStore } from '../src/store/agent-store.ts';

function incoming(store: AgentStore, id: string, threadId: string, source = 'platform') {
  return store.recordIncoming({
    messageId: id,
    threadId,
    senderDid: 'owner',
    targetDid: 'agent-1',
    contentType: 'application/json',
    body: { payload: { type: 'chat.message', text: id } },
    source,
    sourceDelivery: { deliveryId: `d-${id}` },
  });
}

test('source 与投递凭据往返，旧行默认 anp', () => {
  const store = new AgentStore(':memory:');
  assert.equal(incoming(store, 'm1', 'th1'), true);
  const row = store.inboxByMessage('m1');
  assert.equal(row?.source, 'platform');
  assert.deepEqual(JSON.parse(row!.source_delivery!), { deliveryId: 'd-m1' });
  assert.equal(row?.status, 'pending');

  store.recordIncoming({
    messageId: 'm2',
    threadId: 'th1',
    targetDid: 'agent-1',
    contentType: 'application/json',
    body: {},
  });
  assert.equal(store.inboxByMessage('m2')?.source, 'anp');
  assert.equal(store.inboxByMessage('m2')?.source_delivery, null);
  assert.equal(store.history('th1').find(item => item.message_id === 'm2')?.source, 'anp');
  store.close();
});

test('recordIncoming 幂等：重复投递不新增消息', () => {
  const store = new AgentStore(':memory:');
  assert.equal(incoming(store, 'm1', 'th1'), true);
  assert.equal(incoming(store, 'm1', 'th1'), false);
  assert.equal(store.countMessages('th1'), 1);
  store.close();
});

test('pendingThreads 聚合来源并按最早消息排序', () => {
  const store = new AgentStore(':memory:');
  incoming(store, 'a1', 'shared', 'stdin');
  incoming(store, 'a2', 'shared', 'platform');
  incoming(store, 'b1', 'other', 'platform');

  const pending = store.pendingThreads(Date.now() + 1, 10);
  assert.deepEqual(pending.map(item => item.threadId), ['shared', 'other']);
  assert.deepEqual(pending[0]!.sources.sort(), ['platform', 'stdin']);
  assert.deepEqual(pending[1]!.sources, ['platform']);

  const [lease] = store.pullInbox({ threadId: 'shared', limit: 1 });
  store.ackInbox(lease!.message_id, lease!.delivery_id);
  const after = store.pendingThreads(Date.now() + 1, 10);
  assert.deepEqual(after.find(item => item.threadId === 'shared')?.sources, ['platform']);
  store.close();
});

test('nack 后按退避时间重新可见', () => {
  const store = new AgentStore(':memory:');
  incoming(store, 'm1', 'th1');
  const now = Date.now();
  const [row] = store.pullInbox({ threadId: 'th1', limit: 1, leaseSeconds: 30, now });
  store.nackInbox(row!.message_id, { deliveryId: row!.delivery_id, retryAt: now + 60_000 });
  assert.equal(store.pendingThreads(now, 10).length, 0);
  assert.equal(store.pendingThreads(now + 60_001, 10).length, 1);
  store.close();
});
