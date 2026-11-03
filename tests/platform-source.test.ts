import assert from 'node:assert/strict';
import test from 'node:test';
import { CollabError, type CollabClient, type MailEnvelope } from '../src/client.ts';
import { PlatformSource } from '../src/sources/platform.ts';

const envelope: MailEnvelope = {
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
};

class FakeClient {
  readonly requests: string[] = [];
  readonly acked: Array<[string, string]> = [];
  readonly nacked: Array<[string, string, string]> = [];
  created = 0;
  closed: string[] = [];
  pulls = 0;
  expireOnce = false;
  private readonly pullWaiters = new Set<(value: { items: MailEnvelope[]; cursor: number; session: { id: string } }) => void>();

  async request<T>(path: string): Promise<T> {
    this.requests.push(path);
    return {} as T;
  }

  async createMailSession(): Promise<{ id: string }> {
    this.created += 1;
    return { id: `sess-${this.created}` };
  }

  async pullMail(
    sessionId: string,
    _options: unknown,
    signal?: AbortSignal,
  ): Promise<{ items: MailEnvelope[]; cursor: number; session: { id: string } }> {
    this.pulls += 1;
    if (this.expireOnce) {
      this.expireOnce = false;
      throw new CollabError('会话不存在', { status: 404, code: 'not_found' });
    }
    if (this.pulls === 1) return { items: [envelope], cursor: 1, session: { id: sessionId } };
    return await new Promise((_resolve, reject) => {
      const abort = (): void => reject(new Error('aborted'));
      if (signal?.aborted) return abort();
      signal?.addEventListener('abort', abort, { once: true });
    });
  }

  async mailMessage(id: string): Promise<{ id: string; content: unknown }> {
    return { id, content: { body: { payload: { text: '请核对库存' } }, extra: 1 } };
  }

  async ackMail(messageId: string, deliveryId: string): Promise<void> {
    this.acked.push([messageId, deliveryId]);
  }

  async nackMail(messageId: string, input: { deliveryId: string }, operationId: string): Promise<void> {
    this.nacked.push([messageId, input.deliveryId, operationId]);
  }

  async closeMailSession(sessionId: string): Promise<void> {
    this.closed.push(sessionId);
  }
}

function sourceWith(fake: FakeClient): PlatformSource {
  return new PlatformSource({
    baseUrl: 'http://platform.test',
    agentId: 'worker-1',
    pollMs: 1_000,
    env: { COLLAB_RUNTIME_TOKEN: 'admin', COLLAB_EMBEDDED_SECRET: 'secret' },
    adminClient: fake as unknown as CollabClient,
    client: fake as unknown as CollabClient,
  });
}

async function until(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('等待超时');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('平台来源：ensure 一次、拉取消息、thread key 与投递凭据', async () => {
  const fake = new FakeClient();
  const source = sourceWith(fake);
  let emitted = 0;
  await source.open(() => {
    emitted += 1;
  });
  await until(() => emitted > 0);

  const messages = await source.poll();
  assert.equal(messages.length, 1);
  assert.equal(messages[0]!.id, 'm1');
  assert.equal(messages[0]!.threadId, 't1');
  assert.equal(messages[0]!.text, '请核对库存');
  assert.deepEqual(messages[0]!.delivery, { deliveryId: 'd1' });
  assert.deepEqual(messages[0]!.data, { body: { payload: { text: '请核对库存' } }, extra: 1 });

  assert.deepEqual(fake.requests, ['embedded/agents/worker-1/ensure']);
  assert.equal(fake.requests.some(path => path.includes('import')), false);
  assert.equal(fake.created, 1);

  await source.ack(messages[0]!);
  assert.deepEqual(fake.acked, [['m1', 'd1']]);
  await source.nack(messages[0]!, { retryAfterSeconds: 300, reason: '失败' });
  assert.equal(fake.nacked[0]![0], 'm1');
  assert.equal(fake.nacked[0]![1], 'd1');

  assert.equal(source.tools(), fake);
  await source.close();
  assert.deepEqual(fake.closed, ['sess-1']);
});

test('信箱会话过期后重建，不重复消费已确认消息', async () => {
  const fake = new FakeClient();
  fake.expireOnce = true;
  fake.pulls = 0;
  const source = sourceWith(fake);
  await source.open(() => undefined);
  await until(() => fake.created >= 2, 2_000);
  await source.close();
  assert.equal(fake.created, 2);
  assert.equal(fake.requests.length, 2);
});
