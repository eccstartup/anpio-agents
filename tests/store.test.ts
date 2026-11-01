import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentStore } from '../src/store/agent-store.ts';
import { RouterStore } from '../src/store/router-store.ts';
import { SqliteDb, migrate } from '../src/store/sqlite.ts';

test('migrate 幂等：重复执行不重复建表', () => {
  const db = new SqliteDb(':memory:');
  const migrations = [{ version: 1, statements: ['CREATE TABLE t (id TEXT PRIMARY KEY)'] }];
  assert.equal(migrate(db, migrations), 1);
  assert.equal(migrate(db, migrations), 1);
  db.run('INSERT INTO t (id) VALUES (?)', 'a');
  assert.equal(db.all<{ id: string }>('SELECT * FROM t').length, 1);
  db.close();
});

test('事务失败会回滚', () => {
  const db = new SqliteDb(':memory:');
  db.exec('CREATE TABLE t (id TEXT PRIMARY KEY)');
  assert.throws(() =>
    db.tx(() => {
      db.run('INSERT INTO t (id) VALUES (?)', 'a');
      throw new Error('boom');
    }),
  );
  assert.equal(db.all('SELECT * FROM t').length, 0);
  db.close();
});

test('RouterStore：注册、session CAS 与恢复', () => {
  const store = new RouterStore(':memory:');
  store.upsertAgent({ agentId: 'a', name: 'A', definition: { id: 'a' }, did: 'did:wba:x:agents:a:e1_x' });
  assert.equal(store.listAgents(true).length, 1);
  assert.equal(store.getAgentByDid('did:wba:x:agents:a:e1_x')?.agent_id, 'a');

  store.ensureThread({ threadId: 't1', ownerAgentId: 'a' });
  const session = store.ensureSession({ sessionId: 's1', agentId: 'a', threadId: 't1' });
  assert.equal(session.state, 'created');

  assert.equal(store.claimSession('s1', 'turn1'), true);
  assert.equal(store.claimSession('s1', 'turn2'), false);
  assert.equal(store.getSession('s1')?.active_turn_id, 'turn1');

  store.releaseSession('s1');
  assert.equal(store.getSession('s1')?.state, 'idle');
  assert.equal(store.claimSession('s1', 'turn2'), true);

  store.db.run("UPDATE sessions SET heartbeat_at = '2000-01-01T00:00:00.000Z' WHERE session_id = 's1'");
  assert.equal(store.recoverStaleSessions().length, 1);
  assert.equal(store.getSession('s1')?.state, 'idle');
  store.close();
});

test('RouterStore：schedule 只触发一次', () => {
  const store = new RouterStore(':memory:');
  const now = '2026-01-01T00:00:00.000Z';
  store.createSchedule({
    id: 'sch1',
    ownerAgentId: 'a',
    kind: 'interval',
    expr: '60',
    payload: { text: 'ping' },
    nextRunAt: now,
    maxRuns: null,
  });
  const first = store.claimDue(now, 50, () => '2026-01-01T00:01:00.000Z');
  assert.equal(first.length, 1);
  assert.equal(first[0]!.scheduledAt, now);
  assert.equal(store.claimDue(now, 50, () => '2026-01-01T00:01:00.000Z').length, 0);
  assert.equal(store.getSchedule('sch1')?.runs, 1);
  store.close();
});

test('AgentStore：inbox 幂等、租约与 ack', () => {
  const store = new AgentStore(':memory:');
  const input = {
    messageId: 'm1',
    threadId: 't1',
    senderDid: 'did:wba:x:agents:a:e1_a',
    targetDid: 'did:wba:x:agents:b:e1_b',
    contentType: 'application/json',
    body: { payload: { type: 'anp.chat.message', text: 'hi' }, conversation_id: 't1' },
  };
  assert.equal(store.recordIncoming(input), true);
  assert.equal(store.recordIncoming(input), false);
  assert.equal(store.pendingInboxCount('t1'), 1);

  const pulled = store.pullInbox({ threadId: 't1', leaseSeconds: 300 });
  assert.equal(pulled.length, 1);
  assert.equal(store.pullInbox({ threadId: 't1' }).length, 0, '同一租约内不重复投递');

  assert.equal(store.nackInbox('m1', { deliveryId: pulled[0]!.delivery_id, retryAt: Date.now() }), true);
  const retried = store.pullInbox({ threadId: 't1' });
  assert.equal(retried.length, 1);
  assert.equal(store.ackInbox('m1', retried[0]!.delivery_id), true);
  assert.equal(store.pendingInboxCount(), 0);
  assert.equal(store.ackInbox('m1', retried[0]!.delivery_id), false);
  store.close();
});

test('AgentStore：outbox 去重与历史预算', () => {
  const store = new AgentStore(':memory:');
  store.queueOutbox({
    messageId: 'o1',
    threadId: 't1',
    targetDid: 'did:wba:x:agents:b:e1_b',
    contentType: 'application/json',
    body: { payload: { type: 'anp.chat.message', text: 'one' } },
  });
  store.queueOutbox({
    messageId: 'o1',
    threadId: 't1',
    targetDid: 'did:wba:x:agents:b:e1_b',
    contentType: 'application/json',
    body: { payload: { type: 'anp.chat.message', text: 'dup' } },
  });
  assert.equal(store.dueOutbox().length, 1);
  assert.equal(store.history('t1')[0]?.body_json.includes('one'), true);
  assert.equal(store.getOutbox('o1')?.attempts, 0);
  store.markOutboxSent('o1');
  assert.equal(store.dueOutbox().length, 0);
  store.close();
});
