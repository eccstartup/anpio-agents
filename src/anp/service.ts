/**
 * 嵌入 `@anpio-cli/service`：一个 ANP-09 消息服务，只做本机投递。
 *
 * 本地投递不走回环 HTTP：router 直接调用这里的 `handleRpc`，且不传 `method`。
 * 外层 HTTP 签名认证由此跳过，业务层 `origin_proof` 仍然由 service 校验。
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { KeyResolver, LocateOptions, ResolvedIdentityKey } from '@anpio-cli/core';
import { decodeMultibaseKey, DidKeyResolver } from '@anpio-cli/core';
import {
  buildServiceEntry,
  createDispatch,
  createServer,
  loadConfig,
  openObjectStore,
  openStorage,
  RPC_PATH,
  WELL_KNOWN_PATH,
  type Config,
  type RpcHandler,
  type RpcRequest,
  type Storage,
} from '@anpio-cli/service';

export type DeliveredEvent = {
  targetDid: string;
  threadId: string;
  messageId: string | null;
  senderDid: string | null;
  method: string;
};

export type AnpServiceOptions = {
  /** `<root>/anp`。 */
  directory: string;
  listen: { host: string; port: number };
  publicUrl: string;
  didBaseUrl: string;
  /** 本机 DID → publicKeyMultibase；用于跳过网络解析。 */
  localKeys: () => Map<string, string>;
  onDelivered?: (event: DeliveredEvent) => void;
  log?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
};

export type AnpService = {
  config: Config;
  address: { host: string; port: number };
  storage: Storage;
  handleRpc: RpcHandler;
  listen: () => Promise<void>;
  close: () => Promise<void>;
  call: (request: unknown) => Promise<Record<string, unknown>>;
};

class LocalFirstResolver implements KeyResolver {
  private readonly localKeys: () => Map<string, string>;
  private readonly fallback: KeyResolver;

  constructor(localKeys: () => Map<string, string>, fallback: KeyResolver) {
    this.localKeys = localKeys;
    this.fallback = fallback;
  }

  async resolve(identity: string, keyid: string, opts?: LocateOptions): Promise<ResolvedIdentityKey> {
    const multibase = this.localKeys().get(identity);
    if (multibase) {
      if (!keyid.startsWith(`${identity}#`)) {
        throw new Error(`keyid ${keyid} 不属于 ${identity}`);
      }
      const key = decodeMultibaseKey(multibase);
      return {
        curve: key.curve,
        bytes: key.bytes,
        identity,
        anchor: { kind: 'fingerprint', thumbprint: identity.slice(identity.lastIndexOf(':') + 1) },
      };
    }
    return await this.fallback.resolve(identity, keyid, opts);
  }
}

function envFor(options: AnpServiceOptions): NodeJS.ProcessEnv {
  const publicUrl = options.publicUrl.replace(/\/$/, '');
  const hosts = [new URL(publicUrl).host, new URL(options.didBaseUrl).host];
  return {
    ...options.env,
    ANPIOCLI_LISTEN: `${options.listen.host}:${options.listen.port}`,
    ANPIOCLI_PUBLIC_URL: publicUrl,
    ANPIOCLI_DB: join(options.directory, 'service.db'),
    ANPIOCLI_OBJECT_DIR: join(options.directory, 'objects'),
    ANPIOCLI_DID_DEV_HOSTS: hosts.join(','),
    ANPIOCLI_ALLOWED_DID_HOSTS: hosts.join(','),
    ANPIOCLI_DID_CACHE_TTL_MS: options.env?.ANPIOCLI_DID_CACHE_TTL_MS ?? '60000',
  };
}

/** 进程内调用；返回解析后的 JSON-RPC 对象，不抛业务拒绝。 */
export function parseReply(reply: { status: number; body: string }): Record<string, unknown> {
  try {
    return JSON.parse(reply.body) as Record<string, unknown>;
  } catch {
    return { status: reply.status, body: reply.body };
  }
}

export function createAnpService(options: AnpServiceOptions): AnpService {
  const config = loadConfig(envFor(options));
  mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  const storage = openStorage({ path: config.dbPath });
  const objects = openObjectStore({ directory: config.objectDir, maxBytes: config.maxObjectBytes });
  const resolver = new LocalFirstResolver(options.localKeys, new DidKeyResolver());

  let inner: RpcHandler;
  const handleRpc: RpcHandler = async (request: RpcRequest) => {
    const reply = await inner(request);
    if (options.onDelivered) {
      try {
        const parsed = JSON.parse(request.body) as {
          method?: string;
          params?: { meta?: { target?: { did?: string }; message_id?: string; sender_did?: string }; body?: { conversation_id?: string } };
        };
        const response = JSON.parse(reply.body) as { result?: { accepted?: boolean; message_id?: string; conversation_id?: string } };
        const targetDid = parsed.params?.meta?.target?.did;
        if (parsed.method === 'direct.send' && targetDid && response.result?.accepted) {
          options.onDelivered({
            targetDid,
            threadId:
              response.result.conversation_id ??
              parsed.params?.body?.conversation_id ??
              parsed.params?.meta?.message_id ??
              'unknown',
            messageId: response.result.message_id ?? parsed.params?.meta?.message_id ?? null,
            senderDid: parsed.params?.meta?.sender_did ?? null,
            method: parsed.method,
          });
        }
      } catch {
        // 唤醒只是加速；回调解析失败不能影响已经落库的投递。
      }
    }
    return reply;
  };

  inner = createDispatch({
    config,
    storage,
    objects,
    resolver,
    resolverOptions: config.didResolution,
    ...(options.log ? { log: options.log } : {}),
  });

  const wellKnown = JSON.stringify(buildServiceEntry(config), null, 2);
  const server = createServer({ config, handleRpc, wellKnown });
  const address = { host: options.listen.host, port: options.listen.port };

  const call = async (request: unknown): Promise<Record<string, unknown>> => {    const reply = await handleRpc({
      body: JSON.stringify(request),
      headers: {},
      url: new URL(`${config.publicUrl.replace(/\/$/, '')}${RPC_PATH}`),
    });
    return parseReply(reply);
  };

  let listening = false;

  return {
    config,
    address,
    storage,
    handleRpc,
    async listen() {
      await server.listen();
      listening = true;
      address.host = server.address.host;
      address.port = server.address.port;
      options.log?.(`ANP 服务监听 ${server.address.host}:${server.address.port}（${config.publicUrl}${RPC_PATH}）`);
    },
    async close() {
      if (listening) await server.close();
      storage.close();
    },
    call,
  };
}

export { RPC_PATH, WELL_KNOWN_PATH };
