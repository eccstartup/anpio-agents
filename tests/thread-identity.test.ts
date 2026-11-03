import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeThreadKey, type InboundMessage } from '../src/threads/types.ts';

function message(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return { id: 'm1', text: 'hi', ...overrides };
}

test('threadId 优先于 taskId 与 conversationId', () => {
  assert.equal(
    normalizeThreadKey('platform', message({ threadId: 'th', taskId: 't1', conversationId: 'c1' })),
    'th',
  );
  assert.equal(normalizeThreadKey('platform', message({ taskId: 't1', conversationId: 'c1' })), 't1');
  assert.equal(normalizeThreadKey('platform', message({ conversationId: 'c1' })), 'c1');
});

test('没有标识时每条消息自成一个 thread', () => {
  assert.equal(normalizeThreadKey('platform', message({ id: 'a' })), 'platform:a');
  assert.notEqual(
    normalizeThreadKey('platform', message({ id: 'a' })),
    normalizeThreadKey('platform', message({ id: 'b' })),
  );
});

test('同一标识归一化到同一 thread，空白会被清理', () => {
  assert.equal(normalizeThreadKey('p', message({ threadId: '  th  ' })), 'th');
  assert.equal(normalizeThreadKey('p', message({ threadId: '' })), 'p:m1');
  assert.equal(normalizeThreadKey('p', message({ threadId: 'x'.repeat(400) })).length, 256);
});

test('newThread 用时间戳开新线程，即使带了 threadId', () => {
  const key = normalizeThreadKey('stdin', message({ threadId: 'local:main', newThread: true }), 1700000000000);
  assert.equal(key, 'stdin:1700000000000');
  assert.notEqual(
    key,
    normalizeThreadKey('stdin', message({ threadId: 'local:main', newThread: true }), 1700000000001),
  );
});
