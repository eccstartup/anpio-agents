/**
 * Agent 身份：Ed25519 私钥只在 router 的数据空间里，DID 文档每次启动按当前
 * 端点重建并重新签名，保证 service 条目与配置一致。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AnpSigningIdentity, DidDocumentService } from '@anpio-cli/core';
import { createAnpIdentity } from '@anpio-cli/core';
import { buildBaseDidDocument, signDidDocumentProofSync } from '@anpio-cli/core/advanced';

export type StoredKey = {
  did: string;
  keyid: string;
  /** base64url，无填充。 */
  priv: string;
  publicKeyMultibase: string;
  createdAt: string;
};

export type ServiceEndpoints = {
  /** router 自己的公开地址，DID 的 host 由它决定。 */
  didBaseUrl: string;
  /** ANP 消息服务的公开地址（开发时端口与 didBaseUrl 不同）。 */
  publicUrl: string;
  rpcPath: string;
};

export function hostOf(baseUrl: string): string {
  return new URL(baseUrl).host.replace(/:/g, '%3A');
}

export function subjectOfDid(did: string): string {
  const parts = did.split(':');
  parts.pop();
  return parts.join(':');
}

export function fingerprintOfDid(did: string): string {
  return did.slice(did.lastIndexOf(':') + 1);
}

export function adpUrlOf(didBaseUrl: string, agentId: string): string {
  return `${didBaseUrl.replace(/\/$/, '')}/agents/${encodeURIComponent(agentId)}/ad.json`;
}

export function didDocumentUrl(baseUrl: string, did: string): string {
  return `${baseUrl.replace(/\/$/, '')}/agents/${did.split(':').slice(-2, -1)[0]}/${fingerprintOfDid(did)}/did.json`;
}

export function servicesFor(endpoints: ServiceEndpoints, agentId: string): (did: string) => DidDocumentService[] {
  return did => [
    {
      id: `${did}#agent-description`,
      type: 'AgentDescription',
      serviceEndpoint: adpUrlOf(endpoints.didBaseUrl, agentId),
    },
    {
      id: `${did}#anp-message-service`,
      type: 'ANPMessageService',
      serviceEndpoint: `${endpoints.publicUrl.replace(/\/$/, '')}${endpoints.rpcPath}`,
    },
  ];
}

/** 新建身份；只在第一次启动或显式轮换时调用。 */
export function newIdentity(endpoints: ServiceEndpoints, agentId: string, path: string[] = ['agents', agentId]) {
  return createAnpIdentity(hostOf(endpoints.didBaseUrl), {
    path,
    service: servicesFor(endpoints, agentId),
  });
}

function keyFileFor(agentDir: string): string {
  return join(agentDir, 'key.json');
}

function toStored(identity: AnpSigningIdentity): StoredKey {
  return {
    did: identity.did,
    keyid: identity.keyid,
    priv: Buffer.from(identity.priv).toString('base64url'),
    publicKeyMultibase: (identity.publicKey as { publicKeyMultibase: string }).publicKeyMultibase,
    createdAt: new Date().toISOString(),
  };
}

/** 用已存的私钥重建带当前 service 条目的签名文档。 */
export function identityFromStored(stored: StoredKey, endpoints: ServiceEndpoints, agentId: string): AnpSigningIdentity {
  const priv = Buffer.from(stored.priv, 'base64url');
  const document = buildBaseDidDocument({
    did: stored.did,
    keyid: stored.keyid,
    publicKeyMultibase: stored.publicKeyMultibase,
    service: servicesFor(endpoints, agentId)(stored.did),
  });
  document.proof = signDidDocumentProofSync(document, stored.keyid, priv);
  return {
    subject: subjectOfDid(stored.did),
    did: stored.did,
    keyid: stored.keyid,
    publicKey: { publicKeyMultibase: stored.publicKeyMultibase },
    priv,
    didDocument: document,
  };
}

/**
 * 读取或创建 `<agentDir>/key.json`。host 变了就不复用旧 DID：DID 里写着 host，
 * 继续用会让 didToUrl 指向另一台机器，而私钥又不该悄悄跟着配置漂移。
 */
export async function loadOrCreateIdentity(
  agentDir: string,
  endpoints: ServiceEndpoints,
  agentId: string,
): Promise<AnpSigningIdentity> {
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  const file = keyFileFor(agentDir);
  const expectedHost = hostOf(endpoints.didBaseUrl);
  try {
    const stored = JSON.parse(await readFile(file, 'utf8')) as StoredKey;
    if (!stored.did.startsWith(`did:wba:${expectedHost}:`)) {
      throw new Error(
        `${file} 里的 DID 属于 ${stored.did.split(':').slice(0, 3).join(':')}，与当前 didBaseUrl ${endpoints.didBaseUrl} 不一致；` +
          '请改回原地址，或删除该 agent 目录后重新生成身份',
      );
    }
    return identityFromStored(stored, endpoints, agentId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const identity = newIdentity(endpoints, agentId);
  const stored = toStored(identity);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, file);
  return identity;
}

export async function writeAgentJson(agentDir: string, value: unknown): Promise<void> {
  const file = join(agentDir, 'agent.json');
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}
