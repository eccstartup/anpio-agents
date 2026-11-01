import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AGENT_DESCRIPTIONS_PATH, verifyDidDocument } from '@anpio-cli/core';
import type { EmbeddedAgentDefinition } from '../src/definition.ts';
import { agentDescriptionFor, discoveryPage } from '../src/anp/description.ts';
import { createDidServer } from '../src/anp/did-server.ts';
import { adpUrlOf, loadOrCreateIdentity, type ServiceEndpoints } from '../src/anp/identity.ts';

const endpoints: ServiceEndpoints = {
  didBaseUrl: 'http://127.0.0.1:8788',
  publicUrl: 'http://127.0.0.1:8787',
  rpcPath: '/anp-im/rpc',
};

function definition(id: string, name = id): EmbeddedAgentDefinition {
  return {
    id,
    name,
    description: `${name} agent`,
    capabilities: ['chat'],
    provider: { id: 'p', protocol: 'script', baseUrl: '', model: '', apiKeyEnv: null, script: [] },
    systemPrompt: '',
    tools: [],
    scopes: [],
    limits: { maxTurns: 1, timeoutMs: 1000, maxTokens: 100 },
    sandbox: { shell: false, shellTimeoutMs: 1000, maxOutputBytes: 1024 },
    enabled: true,
    concurrency: 1,
    createdBy: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lastRunAt: null,
    lastError: null,
  };
}

test('身份：DID 文档自验、重启复用、host 变化拒绝', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anp-identity-'));
  try {
    const first = await loadOrCreateIdentity(dir, endpoints, 'alice');
    assert.match(first.did, /^did:wba:127\.0\.0\.1%3A8788:agents:alice:/);
    assert.doesNotThrow(() => verifyDidDocument(first.didDocument, first.did));
    const services = (first.didDocument.service ?? []) as Array<{ type: string; serviceEndpoint: string }>;
    assert.equal(
      services.find(service => service.type === 'ANPMessageService')?.serviceEndpoint,
      'http://127.0.0.1:8787/anp-im/rpc',
    );
    assert.equal(
      services.find(service => service.type === 'AgentDescription')?.serviceEndpoint,
      adpUrlOf(endpoints.didBaseUrl, 'alice'),
    );

    const again = await loadOrCreateIdentity(dir, endpoints, 'alice');
    assert.equal(again.did, first.did);
    assert.equal(again.keyid, first.keyid);

    await assert.rejects(
      () => loadOrCreateIdentity(dir, { ...endpoints, didBaseUrl: 'http://127.0.0.1:9999' }, 'alice'),
      /不一致/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ADP 字段完整，发现索引分页有界', () => {
  const agents = ['c', 'a', 'b'].map(agentId => ({
    agentId,
    did: `did:wba:127.0.0.1%3A8788:agents:${agentId}:e1_${agentId}`,
    definition: definition(agentId),
    enabled: agentId !== 'b',
    didBaseUrl: endpoints.didBaseUrl,
  }));
  const adp = agentDescriptionFor(agents[0]!);
  assert.equal(adp.name, 'c');
  assert.equal(adp.did, agents[0]!.did);
  assert.equal(adp.url, adpUrlOf(endpoints.didBaseUrl, 'c'));
  assert.equal((adp.interfaces?.[0] as { type?: string } | undefined)?.type, 'ANP');

  const first = discoveryPage(agents, endpoints.didBaseUrl, { limit: 1 });
  assert.equal(first.total, 2);
  assert.deepEqual(
    first.index.items.map(item => item.name),
    ['a'],
  );
  assert.ok(first.next, '还有第二页');

  const second = discoveryPage(agents, endpoints.didBaseUrl, { limit: 1, cursor: '1' });
  assert.deepEqual(
    second.index.items.map(item => item.name),
    ['c'],
  );
  assert.equal(second.next, undefined);

  const clamped = discoveryPage(agents, endpoints.didBaseUrl, { limit: 10_000 });
  assert.equal(clamped.index.items.length, 2);
  assert.equal(discoveryPage(agents, endpoints.didBaseUrl, { limit: 0 }).index.items.length, 1);
});

test('DID server：健康检查、发现索引、ADP、DID 文档与管理鉴权', async () => {
  const agents = ['a', 'b'].map(agentId => ({
    agentId,
    did: `did:wba:127.0.0.1%3A8788:agents:${agentId}:e1_${agentId}`,
    fingerprint: `e1_${agentId}`,
    document: { id: `did:wba:127.0.0.1%3A8788:agents:${agentId}:e1_${agentId}` },
    description: agentDescriptionFor({
      agentId,
      did: `did:wba:127.0.0.1%3A8788:agents:${agentId}:e1_${agentId}`,
      definition: definition(agentId),
      enabled: true,
      didBaseUrl: endpoints.didBaseUrl,
    }),
    definition: definition(agentId),
    enabled: agentId === 'a',
    didBaseUrl: endpoints.didBaseUrl,
  }));
  const server = createDidServer({
    host: '127.0.0.1',
    port: 0,
    didBaseUrl: endpoints.didBaseUrl,
    adminToken: 'secret',
    agents: () => agents,
    health: () => ({ ok: true }),
    admin: ({ method, path }) =>
      method === 'GET' && path === '/admin/ping' ? { status: 200, body: { pong: true } } : { status: 404, body: {} },
  });
  try {
    await server.listen();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      return;
    }
    throw error;
  }
  try {
    const base = `http://127.0.0.1:${server.address.port}`;
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    const index = await fetch(`${base}${AGENT_DESCRIPTIONS_PATH}?limit=1`);
    assert.equal(index.status, 200);
    assert.equal(index.headers.get('x-total-count'), '1');
    assert.equal(((await index.json()) as { items: unknown[] }).items.length, 1);

    assert.equal((await fetch(`${base}/agents/a/ad.json`)).status, 200);
    assert.equal((await fetch(`${base}/agents/b/ad.json`)).status, 404, '禁用的 agent 不发布');
    assert.equal((await fetch(`${base}/agents/a/e1_a/did.json`)).status, 200);
    assert.equal((await fetch(`${base}/agents/a/wrong/did.json`)).status, 404);

    assert.equal((await fetch(`${base}/admin/ping`)).status, 401);
    const admin = await fetch(`${base}/admin/ping`, { headers: { authorization: 'Bearer secret' } });
    assert.equal(admin.status, 200);
    assert.deepEqual(await admin.json(), { pong: true });
  } finally {
    await server.close();
  }
});
