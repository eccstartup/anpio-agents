import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  ANP_PROFILE,
  ANP_SECURITY_PROFILE,
  ANP_TARGET_KIND,
  buildMessageRequest,
  buildOriginProofAuth,
  ed25519OriginProofSigner,
  type AnpMeta,
} from '@anpio-cli/core';
import { createAnpService, type DeliveredEvent } from '../src/anp/service.ts';
import { loadOrCreateIdentity, type ServiceEndpoints } from '../src/anp/identity.ts';

function multibaseOf(identity: { publicKey: unknown }): string {
  const key = identity.publicKey as { publicKeyMultibase?: string };
  assert.ok(key.publicKeyMultibase, '测试身份必须是 Ed25519 multibase');
  return key.publicKeyMultibase;
}

const endpoints: ServiceEndpoints = {
  didBaseUrl: 'http://127.0.0.1:8788',
  publicUrl: 'http://127.0.0.1:0',
  rpcPath: '/anp-im/rpc',
};

test('ANP 服务：进程内 direct.send 受理、落库并唤醒目标', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anp-service-'));
  const alice = await loadOrCreateIdentity(join(dir, 'alice'), endpoints, 'alice');
  const bob = await loadOrCreateIdentity(join(dir, 'bob'), endpoints, 'bob');
  const keys = new Map([
    [alice.did, multibaseOf(alice)],
    [bob.did, multibaseOf(bob)],
  ]);
  const delivered: DeliveredEvent[] = [];
  const service = await createAnpService({
    directory: join(dir, 'anp'),
    listen: { host: '127.0.0.1', port: 0 },
    publicUrl: endpoints.publicUrl,
    didBaseUrl: endpoints.didBaseUrl,
    localKeys: () => keys,
    onDelivered: event => delivered.push(event),
    log: () => {},
  });
  try {
    const capabilities = await service.call({
      jsonrpc: '2.0',
      id: 'cap',
      method: 'anp.get_capabilities',
      params: {
        meta: { profile: ANP_PROFILE.coreBinding, security_profile: ANP_SECURITY_PROFILE.transportProtected },
        body: {},
      },
    });
    assert.equal((capabilities as { result?: unknown }).result !== undefined, true);

    const meta: AnpMeta = {
      profile: ANP_PROFILE.directBase,
      security_profile: ANP_SECURITY_PROFILE.transportProtected,
      sender_did: alice.did,
      target: { kind: ANP_TARGET_KIND.agent, did: bob.did },
      operation_id: 'op-1',
      message_id: 'msg-1',
      content_type: 'application/json',
    };
    const body = {
      payload: { type: 'anp.chat.message', title: 'hi', text: 'hello' },
      conversation_id: 'thread-1',
    };
    const auth = await buildOriginProofAuth({
      method: 'direct.send',
      meta,
      body,
      signer: ed25519OriginProofSigner(alice.priv, alice.keyid),
    });
    const reply = await service.call(
      buildMessageRequest({ id: 'r1', method: 'direct.send', meta, body, auth }),
    );
    const result = (reply as { result?: { accepted?: boolean; message_id?: string; conversation_id?: string } }).result;
    assert.equal(result?.accepted, true);
    assert.equal(result?.message_id, 'msg-1');
    assert.equal(result?.conversation_id, 'thread-1');
    assert.equal(service.storage.headSeq(bob.did), 1);
    assert.deepEqual(delivered, [
      {
        targetDid: bob.did,
        threadId: 'thread-1',
        messageId: 'msg-1',
        senderDid: alice.did,
        method: 'direct.send',
        ephemeral: false,
      },
    ]);

    const replay = await service.call(
      buildMessageRequest({ id: 'r2', method: 'direct.send', meta, body, auth }),
    );
    assert.equal((replay as { result?: { accepted?: boolean } }).result?.accepted, true);
    assert.equal(service.storage.headSeq(bob.did), 1, '重放不新增投递');
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('ANP 服务：签名错误的发送方被拒绝', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anp-service-'));
  const alice = await loadOrCreateIdentity(join(dir, 'alice'), endpoints, 'alice');
  const bob = await loadOrCreateIdentity(join(dir, 'bob'), endpoints, 'bob');
  const keys = new Map([
    [alice.did, multibaseOf(alice)],
    [bob.did, multibaseOf(bob)],
  ]);
  const service = await createAnpService({
    directory: join(dir, 'anp'),
    listen: { host: '127.0.0.1', port: 0 },
    publicUrl: endpoints.publicUrl,
    didBaseUrl: endpoints.didBaseUrl,
    localKeys: () => keys,
    log: () => {},
  });
  try {
    const meta: AnpMeta = {
      profile: ANP_PROFILE.directBase,
      security_profile: ANP_SECURITY_PROFILE.transportProtected,
      sender_did: alice.did,
      target: { kind: ANP_TARGET_KIND.agent, did: bob.did },
      operation_id: 'op-bad',
      message_id: 'msg-bad',
      content_type: 'application/json',
    };
    const body = { payload: { text: 'forged' } };
    const auth = await buildOriginProofAuth({
      method: 'direct.send',
      meta,
      body,
      signer: ed25519OriginProofSigner(bob.priv, bob.keyid),
    });
    const reply = await service.call(
      buildMessageRequest({ id: 'r1', method: 'direct.send', meta, body, auth }),
    );
    assert.equal((reply as { error?: unknown }).error !== undefined, true);
    assert.equal(service.storage.headSeq(bob.did), 0);
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
});
