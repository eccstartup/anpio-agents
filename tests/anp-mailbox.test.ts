import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AnpClient } from '../src/anp/client.ts';
import { loadOrCreateIdentity, type ServiceEndpoints } from '../src/anp/identity.ts';
import { createAnpService } from '../src/anp/service.ts';
import { AgentStore } from '../src/store/agent-store.ts';
import { AnpMailbox } from '../src/runtime/anp/mailbox.ts';

const endpoints: ServiceEndpoints = {
  didBaseUrl: 'http://127.0.0.1:8788',
  publicUrl: 'http://127.0.0.1:0',
  rpcPath: '/anp-im/rpc',
};

function multibaseOf(identity: { publicKey: unknown }): string {
  const key = identity.publicKey as { publicKeyMultibase?: string };
  assert.ok(key.publicKeyMultibase, '测试身份必须是 Ed25519 multibase');
  return key.publicKeyMultibase;
}

test('ANP 信箱：发送、同步、拉取、确认与去重', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anp-mailbox-'));
  const alice = await loadOrCreateIdentity(join(dir, 'alice'), endpoints, 'alice');
  const bob = await loadOrCreateIdentity(join(dir, 'bob'), endpoints, 'bob');
  const keys = new Map([
    [alice.did, multibaseOf(alice)],
    [bob.did, multibaseOf(bob)],
  ]);
  const service = createAnpService({
    directory: join(dir, 'anp'),
    listen: { host: '127.0.0.1', port: 0 },
    publicUrl: endpoints.publicUrl,
    didBaseUrl: endpoints.didBaseUrl,
    localKeys: () => keys,
    log: () => {},
  });
  const aliceStore = new AgentStore(join(dir, 'alice', 'agent.db'));
  const bobStore = new AgentStore(join(dir, 'bob', 'agent.db'));
  try {
    const aliceBox = new AnpMailbox({
      store: aliceStore,
      client: new AnpClient({ identity: alice, call: service.call }),
      threadId: 'thread-1',
    });
    const bobBox = new AnpMailbox({
      store: bobStore,
      client: new AnpClient({ identity: bob, call: service.call }),
      threadId: 'thread-1',
    });

    const sent = await aliceBox.send({
      targetDid: bob.did,
      payload: { type: 'anp.chat.message', title: 'hi', text: 'hello' },
    });
    assert.equal(sent.accepted, true);
    assert.equal(sent.queued, false);
    assert.equal(sent.conversationId, 'thread-1');
    assert.ok(sent.messageId.startsWith('anp-'));

    const first = await bobBox.sync();
    assert.equal(first.added, 1);
    const second = await bobBox.sync();
    assert.equal(second.added, 0, '同一条投递不会重复入库');

    const session = await bobBox.open({ label: 'run:1' });
    assert.equal(session.label, 'run:1');
    assert.equal(session.unread, 1);
    const pulled = await bobBox.pull(session.id);
    assert.equal(pulled.items.length, 1);
    const item = pulled.items[0]!;
    assert.equal(item.id, sent.messageId);
    assert.equal(item.kind, 'anp.chat.message');
    assert.equal(item.publisherId, alice.did);
    assert.equal(item.ref.threadId, 'thread-1');
    assert.equal(item.ref.type, 'anp');

    const detail = await bobBox.message(sent.messageId);
    const content = detail.content as { body: { payload: { text: string } } };
    assert.equal(content.body.payload.text, 'hello');

    await bobBox.ack(sent.messageId, item.deliveryId);
    assert.equal(bobBox.pending(session.id), 0);
    const again = await bobBox.pull(session.id);
    assert.equal(again.items.length, 0, '确认后不再投递');

    const resumed = new AnpMailbox({
      store: bobStore,
      client: new AnpClient({ identity: bob, call: service.call }),
      threadId: 'thread-1',
    });
    const afterRestart = await resumed.sync();
    assert.equal(afterRestart.added, 0, '游标从本地恢复，不重复搬运');
  } finally {
    aliceStore.close();
    bobStore.close();
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('ANP 信箱：没有 relay 时拒绝外部 DID，已排队的旧出站不再重试', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anp-mailbox-'));
  const alice = await loadOrCreateIdentity(join(dir, 'alice'), endpoints, 'alice');
  const store = new AgentStore(join(dir, 'alice', 'agent.db'));
  const external = 'did:wba:external.example:agents:someone:e1_abc';
  try {
    const box = new AnpMailbox({
      store,
      client: new AnpClient({
        identity: alice,
        call: async () => {
          throw new Error('不应该调用本机服务');
        },
      }),
      threadId: 'thread-external',
      canDeliver: () => false,
    });

    await assert.rejects(
      () => box.send({
        targetDid: external,
        payload: { type: 'anp.chat.message', text: '外面的人' },
      }),
      /不在本机 router 中/,
    );
    assert.equal(
      store.db.get<{ count: number }>('SELECT COUNT(*) AS count FROM outbox')?.count,
      0,
      '被拒绝的目标不能进入 outbox',
    );

    // 升级前已经排队的跨域出站：退休而不是投递给本机服务。
    store.queueOutbox({
      messageId: 'anp-old',
      threadId: 'thread-external',
      targetDid: external,
      contentType: 'application/json',
      body: { payload: { type: 'anp.chat.message', text: '旧消息' } },
    });
    const flushed = await box.flushOutbox();
    assert.equal(flushed.failed, 1);
    const row = store.getOutbox('anp-old');
    assert.equal(row?.sent_at, null);
    assert.ok((row?.next_attempt_at ?? 0) > Date.now());
    assert.equal(store.dueOutbox(Date.now()).some(item => item.message_id === 'anp-old'), false);
    assert.match(String(row?.service_json), /unroutable/);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('ANP 信箱：nack 延迟重投；离线时出站排队并退避', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anp-mailbox-'));
  const alice = await loadOrCreateIdentity(join(dir, 'alice'), endpoints, 'alice');
  const bob = await loadOrCreateIdentity(join(dir, 'bob'), endpoints, 'bob');
  const keys = new Map([
    [alice.did, multibaseOf(alice)],
    [bob.did, multibaseOf(bob)],
  ]);
  const service = createAnpService({
    directory: join(dir, 'anp'),
    listen: { host: '127.0.0.1', port: 0 },
    publicUrl: endpoints.publicUrl,
    didBaseUrl: endpoints.didBaseUrl,
    localKeys: () => keys,
    log: () => {},
  });
  const aliceStore = new AgentStore(join(dir, 'alice', 'agent.db'));
  const bobStore = new AgentStore(join(dir, 'bob', 'agent.db'));
  let clock = Date.now();
  try {
    const aliceBox = new AnpMailbox({
      store: aliceStore,
      client: new AnpClient({ identity: alice, call: service.call }),
      threadId: 'thread-1',
      now: () => clock,
    });
    const bobBox = new AnpMailbox({
      store: bobStore,
      client: new AnpClient({ identity: bob, call: service.call }),
      threadId: 'thread-1',
      now: () => clock,
    });

    const sent = await aliceBox.send({
      targetDid: bob.did,
      payload: { type: 'anp.task.request', task_id: 'task-9', text: 'do it' },
    });
    const session = await bobBox.open({ label: 'run:1' });
    const pulled = await bobBox.pull(session.id);
    assert.equal(pulled.items.length, 1);
    await bobBox.nack(pulled.items[0]!.id, {
      deliveryId: pulled.items[0]!.deliveryId,
      retryAfterSeconds: 60,
    });
    const held = await bobBox.pull(session.id);
    assert.equal(held.items.length, 0, 'nack 后到重试时间之前不再投递');
    clock += 61_000;
    const retried = await bobBox.pull(session.id);
    assert.equal(retried.items.length, 1, '退避到期后重新投递');
    assert.equal(retried.items[0]!.id, sent.messageId);
    assert.equal(retried.items[0]!.ref.taskId, 'task-9');

    const offline = new AnpMailbox({
      store: aliceStore,
      client: new AnpClient({
        identity: alice,
        call: async () => {
          throw new Error('offline');
        },
      }),
      threadId: 'thread-2',
      now: () => clock,
    });
    const queued = await offline.send({
      targetDid: bob.did,
      payload: { type: 'anp.chat.message', text: 'later' },
    });
    assert.equal(queued.accepted, false);
    assert.equal(queued.queued, true);
    const row = aliceStore.getOutbox(queued.messageId);
    assert.equal(row?.sent_at, null);
    assert.equal(row?.attempts, 1);
    assert.ok((row?.next_attempt_at ?? 0) > clock);
    assert.equal(aliceStore.dueOutbox(clock).some(item => item.message_id === queued.messageId), false);
    clock += 2_000;
    assert.equal(aliceStore.dueOutbox(clock).some(item => item.message_id === queued.messageId), true);
  } finally {
    aliceStore.close();
    bobStore.close();
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
});
