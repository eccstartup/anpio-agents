import assert from 'node:assert/strict';
import test from 'node:test';
import type { KnowledgeSearch } from '../src/client.ts';
import { ExperienceClient } from '../src/experience/client.ts';
import { KnowledgeCache } from '../src/experience/cache.ts';
import type { ToolBackend } from '../src/runtime/transport.ts';
import { ensureMemorySchema } from '../src/store/memory-schema.ts';
import { SqliteDb } from '../src/store/sqlite.ts';

function setup() {
  const db = new SqliteDb(':memory:');
  ensureMemorySchema(db);
  let clock = Date.parse('2026-01-01T00:00:00.000Z');
  const cache = new KnowledgeCache(db, { now: () => clock });
  const advance = (ms: number): void => {
    clock += ms;
  };
  return { db, cache, advance };
}

function backendOf(overrides: Partial<ToolBackend>): ToolBackend {
  return overrides as unknown as ToolBackend;
}

function hit(overrides: Partial<KnowledgeSearch['items'][number]> = {}): KnowledgeSearch['items'][number] {
  return {
    id: 'k1',
    version: 3,
    title: '部署检查清单',
    summary: '部署前先确认端口与防火墙',
    content: '部署前先确认端口开放，再同步防火墙规则。',
    reference: 'knowledge:k1:3',
    score: 0.9,
    contentTruncated: false,
    kind: 'checklist',
    state: 'published',
    evidenceLevel: 'published',
    accessMode: 'restricted',
    ...overrides,
  };
}

function searchResult(items: KnowledgeSearch['items'], note = ''): KnowledgeSearch {
  return {
    items,
    truncated: false,
    usedChars: 0,
    budgetChars: 4000,
    budgetUnit: 'chars',
    retrieval: 'lexical',
    note,
  };
}

test('缓存只收已发布且未过期的版本', () => {
  const { db, cache } = setup();
  assert.ok(cache.put({ id: 'k1', version: 1, content: '已发布经验' }));
  assert.equal(cache.get('k1', 1)?.content, '已发布经验');

  assert.equal(cache.put({ id: 'k2', version: 1, content: '草稿', state: 'draft' }), null);
  assert.equal(cache.get('k2', 1), null);

  assert.equal(
    cache.put({ id: 'k3', version: 1, content: '过期', expiresAt: '2025-12-31T00:00:00.000Z' }),
    null,
  );
  assert.equal(cache.get('k3', 1), null);

  const stats = cache.stats();
  assert.equal(stats.entries, 1);
  db.close();
});

test('本地检索按词面打分过滤', () => {
  const { db, cache } = setup();
  cache.put({ id: 'k1', version: 1, title: '部署端口', content: '部署端口固定 8080' });
  cache.put({ id: 'k2', version: 1, title: '无关', content: '会议室在三楼' });

  const rows = cache.searchLocal('部署端口');
  assert.equal(rows[0]?.knowledge_id, 'k1');
  assert.equal(rows.length, 1);
  db.close();
});

test('搜索平台结果会写缓存并返回 reference；缓存过期后仍可用但标记 stale', async () => {
  const parts = setup();
  const client = new ExperienceClient(
    backendOf({ searchKnowledge: async () => searchResult([hit()]) }),
    parts.cache,
  );

  const result = await client.search('部署端口');
  assert.equal(result.degraded, false);
  assert.equal(result.items[0]?.reference, 'knowledge:k1:3');
  assert.equal(result.items[0]?.id, 'k1');
  assert.equal(parts.cache.get('k1', 3)?.title, '部署检查清单');

  parts.advance(25 * 60 * 60 * 1000);
  const offline = new ExperienceClient(undefined, parts.cache);
  const degraded = await offline.search('部署端口');
  assert.equal(degraded.degraded, true);
  assert.ok(degraded.note.includes('没有平台连接'));
  assert.equal(degraded.items[0]?.stale, true);
  assert.ok(degraded.items[0]?.cachedAt);
  parts.db.close();
});

test('平台调用失败时降级到缓存，不编造结果', async () => {
  const parts = setup();
  parts.cache.put({ id: 'k1', version: 1, title: '部署端口', content: '部署端口固定 8080' });
  const client = new ExperienceClient(
    backendOf({
      searchKnowledge: async () => {
        throw new Error('HTTP 503');
      },
    }),
    parts.cache,
  );

  const result = await client.search('部署端口');
  assert.equal(result.degraded, true);
  assert.ok(result.note.includes('HTTP 503'));
  assert.equal(result.items[0]?.id, 'k1');
  assert.equal(result.items[0]?.stale, false);
  parts.db.close();
});

test('promptBlock：report 类不注入，playbook 只给摘要，预算不超', async () => {
  const parts = setup();
  const client = new ExperienceClient(
    backendOf({
      searchKnowledge: async () => searchResult([
        hit(),
        hit({
          id: 'k2',
          version: 1,
          reference: 'knowledge:k2:1',
          kind: 'playbook',
          title: '发布手册',
          summary: '发布手册摘要',
          content: '发布手册完整正文不应出现',
        }),
        hit({
          id: 'k3',
          version: 1,
          reference: 'knowledge:k3:1',
          kind: 'report',
          title: '事故报告',
          summary: '事故报告摘要',
        }),
      ]),
    }),
    parts.cache,
  );

  const block = await client.promptBlock('部署', { budget: 1000 });
  assert.ok(block.text.includes('knowledge:k1:3'));
  assert.ok(block.text.includes('发布手册摘要'));
  assert.ok(!block.text.includes('发布手册完整正文不应出现'));
  assert.ok(!block.text.includes('事故报告'));
  assert.ok(block.chars <= 1000);
  assert.deepEqual(block.entries.map(entry => entry.id), ['k1', 'k2']);
  parts.db.close();
});

test('引用先记本地，平台失败不猜测；投稿必须带 taskId', async () => {
  const parts = setup();
  const client = new ExperienceClient(
    backendOf({
      referenceKnowledge: async (_taskId, id) => ({ id, version: 4 }),
      createKnowledgeCandidate: async () => {
        throw new Error('HTTP 403 forbidden');
      },
    }),
    parts.cache,
  );

  const local = await client.cite({ knowledgeId: 'k1', version: 3, sessionId: 's1', turnId: 't1' });
  assert.equal(local.cited, false);
  assert.equal(local.reference, 'knowledge:k1:3');
  assert.ok(local.error?.includes('taskId'));

  const refs = parts.db.get<{ count: number }>(
    `SELECT COUNT(*) AS count FROM knowledge_refs WHERE knowledge_id = 'k1' AND session_id = 's1'`,
  );
  assert.equal(refs?.count, 1);

  const remote = await client.cite({
    knowledgeId: 'k1',
    version: 3,
    sessionId: 's1',
    turnId: 't1',
    taskId: 'task-1',
  });
  assert.equal(remote.cited, true);
  assert.equal(remote.reference, 'knowledge:k1:4');

  const missing = await client.contribute({ knowledge: { content: '经验' } });
  assert.equal(missing.ok, false);
  assert.ok(missing.error?.includes('taskId'));

  const forbidden = await client.contribute({ taskId: 'task-1', knowledge: { content: '经验' } });
  assert.equal(forbidden.ok, false);
  assert.equal(forbidden.forbidden, true);

  const offline = new ExperienceClient(undefined, parts.cache);
  const unavailable = await offline.contribute({ taskId: 'task-1', knowledge: { content: '经验' } });
  assert.equal(unavailable.ok, false);
  assert.ok(unavailable.error?.includes('没有平台连接'));
  parts.db.close();
});
