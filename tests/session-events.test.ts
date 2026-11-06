import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionEventLog, modelRequestPayload } from '../src/session/events.ts';
import { ensureMemorySchema } from '../src/store/memory-schema.ts';
import { SqliteDb } from '../src/store/sqlite.ts';

function open(): { db: SqliteDb; events: SessionEventLog } {
  const db = new SqliteDb(':memory:');
  ensureMemorySchema(db);
  return { db, events: new SessionEventLog(db) };
}

test('追加事件：seq 递增、按会话读取、支持 afterSeq 与 kind 过滤', () => {
  const { db, events } = open();
  const first = events.append({ sessionId: 's1', turnId: 't1', kind: 'session.start' });
  const second = events.append({ sessionId: 's1', turnId: 't1', kind: 'turn.start' });
  events.append({ sessionId: 's2', turnId: 't2', kind: 'turn.start' });

  assert.ok(second.seq > first.seq);
  assert.equal(events.lastSeq('s1'), second.seq);
  assert.equal(events.count('s1'), 2);

  const tail = events.read('s1', { afterSeq: first.seq });
  assert.deepEqual(tail.map(event => event.kind), ['turn.start']);

  const filtered = events.read('s1', { kinds: ['session.start'] });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0]?.turn_id, 't1');
  db.close();
});

test('落盘前统一脱敏，读回来是脱敏后的值', () => {
  const { db, events } = open();
  events.append({
    sessionId: 's1',
    kind: 'tool.call',
    payload: {
      args: { header: 'Authorization: Bearer abcdefghijklmnop' },
      nested: ['sk-abcdefghijklmnopqrstuvwxyz'],
      ok: 1,
    },
  });

  const [event] = events.read('s1');
  const payload = JSON.stringify(event?.payload);
  assert.ok(!payload.includes('abcdefghijklmnop'));
  assert.ok(payload.includes('[redacted]'));
  assert.equal((event?.payload.ok as number), 1);
  db.close();
});

test('重放：最近一次请求快照 + 之后的回复与工具结果', () => {
  const { db, events } = open();
  events.append({ sessionId: 's1', kind: 'turn.start' });
  events.append({
    sessionId: 's1',
    kind: 'model.request',
    payload: modelRequestPayload({
      system: 'sys',
      messages: [{ role: 'user', content: '你好' }],
      tools: ['memory_get'],
    }),
  });
  events.append({ sessionId: 's1', kind: 'model.response', payload: { text: '我在' } });
  events.append({
    sessionId: 's1',
    kind: 'tool.result',
    payload: { toolCallId: 'call-1', name: 'memory_get', content: '{"key":"a"}' },
  });
  events.append({
    sessionId: 's1',
    kind: 'model.request',
    payload: modelRequestPayload({
      system: 'sys',
      messages: [{ role: 'user', content: '第二轮' }],
      tools: [],
    }),
  });

  const replayed = events.replay('s1');
  assert.equal(replayed.length, 1);
  assert.equal(replayed[0]?.content, '第二轮');

  events.append({ sessionId: 's1', kind: 'model.response', payload: { text: '第二轮回复' } });
  const withTail = events.replay('s1');
  assert.equal(withTail.length, 2);
  assert.deepEqual(withTail[1], { role: 'assistant', content: '第二轮回复' });
  db.close();
});

test('turn 摘要只取 turn.end；prune 只删旧事件', () => {
  const { db, events } = open();
  events.append({ sessionId: 's1', turnId: 't1', kind: 'turn.end', payload: { summary: '修好了部署脚本' } });
  events.append({ sessionId: 's1', turnId: 't2', kind: 'turn.end', payload: { summary: '补充了测试' } });
  events.append({ sessionId: 's1', turnId: 't3', kind: 'turn.start' });

  const summaries = events.turnSummaries('s1');
  assert.equal(summaries.length, 2);
  assert.equal(summaries[0]?.summary, '修好了部署脚本');
  assert.equal(summaries[1]?.turnId, 't2');

  const removed = events.prune(0, Date.now() + 60_000);
  assert.equal(removed, 3);
  assert.equal(events.count('s1'), 0);
  db.close();
});
