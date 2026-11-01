/**
 * Router 内部的 ANP 客户端：只走进程内 `handleRpc`，不经过回环 HTTP。
 *
 * 出站消息必须带 origin proof；`sync.delta` 是自寻址（target 是自己），
 * 所以拉取自己的信箱同样要签名。
 */

import { randomUUID } from 'node:crypto';
import type { AnpMeta, AnpSigningIdentity } from '@anpio-cli/core';
import {
  ANP_PROFILE,
  ANP_SECURITY_PROFILE,
  ANP_TARGET_KIND,
  buildMessageRequest,
  buildOriginProofAuth,
  ed25519OriginProofSigner,
} from '@anpio-cli/core';
import { EXTENSION_PROFILE, SYNC_DELTA } from '@anpio-cli/service';

export type AnpRpcCaller = (request: unknown) => Promise<Record<string, unknown>>;

export type AnpPayload = {
  type: string;
  task_id?: string;
  title?: string;
  text?: string;
  data?: unknown;
};

export type SendInput = {
  targetDid: string;
  threadId: string;
  payload: AnpPayload;
  replyTo?: string | null;
  messageId?: string;
  operationId?: string;
};

export type SendResult = {
  accepted: boolean;
  messageId: string;
  targetDid: string;
  conversationId: string | null;
  acceptedAt: string | null;
};

export type SyncMessage = {
  seq: number;
  method: string;
  meta: {
    profile: string;
    security_profile: string;
    sender_did?: string;
    operation_id?: string;
    message_id?: string;
    content_type?: string;
    target?: { kind?: string; did?: string };
  };
  body: Record<string, unknown>;
};

export type SyncResult = {
  messages: SyncMessage[];
  nextSince: number;
  hasMore: boolean;
  agedOut: number;
};

export class AnpRpcError extends Error {
  readonly code: number | undefined;
  readonly anpCode: string | undefined;

  constructor(message: string, options: { code?: number; anpCode?: string } = {}) {
    super(message);
    this.name = 'AnpRpcError';
    this.code = options.code;
    this.anpCode = options.anpCode;
  }
}

type RpcReply = {
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string; data?: { anp_code?: string } };
};

function resultOf(reply: RpcReply, method: string): Record<string, unknown> {
  if (reply.error) {
    throw new AnpRpcError(`${method} 被拒绝：${reply.error.message ?? '未知原因'}`, {
      ...(typeof reply.error.code === 'number' ? { code: reply.error.code } : {}),
      ...(reply.error.data?.anp_code ? { anpCode: reply.error.data.anp_code } : {}),
    });
  }
  return reply.result ?? {};
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export class AnpClient {
  readonly identity: AnpSigningIdentity;
  private readonly call: AnpRpcCaller;
  private readonly signer: ReturnType<typeof ed25519OriginProofSigner>;
  private readonly now: () => number;
  private readonly requestId: () => string;

  constructor(options: {
    identity: AnpSigningIdentity;
    call: AnpRpcCaller;
    now?: () => number;
    requestId?: () => string;
  }) {
    this.identity = options.identity;
    this.call = options.call;
    this.signer = ed25519OriginProofSigner(options.identity.priv, options.identity.keyid);
    this.now = options.now ?? Date.now;
    this.requestId = options.requestId ?? randomUUID;
  }

  async send(input: SendInput): Promise<SendResult> {
    const messageId = input.messageId ?? `anp-${randomUUID()}`;
    const meta: AnpMeta = {
      profile: ANP_PROFILE.directBase,
      security_profile: ANP_SECURITY_PROFILE.transportProtected,
      sender_did: this.identity.did,
      target: { kind: ANP_TARGET_KIND.agent, did: input.targetDid },
      operation_id: input.operationId ?? `send:${messageId}`,
      message_id: messageId,
      content_type: 'application/json',
    };
    const body: Record<string, unknown> = {
      payload: input.payload,
      conversation_id: input.threadId,
      ...(input.replyTo ? { reply_to: input.replyTo } : {}),
    };
    const auth = await buildOriginProofAuth({
      method: 'direct.send',
      meta,
      body,
      signer: this.signer,
    });
    const reply = (await this.call(
      buildMessageRequest({ id: this.requestId(), method: 'direct.send', meta, body, auth }),
    )) as RpcReply;
    const result = resultOf(reply, 'direct.send');
    return {
      accepted: result.accepted === true,
      messageId: stringField(result.message_id) ?? messageId,
      targetDid: stringField(result.target_did) ?? input.targetDid,
      conversationId: stringField(result.conversation_id) ?? input.threadId,
      acceptedAt: stringField(result.accepted_at) ?? null,
    };
  }

  async sync(input: { since: number; limit?: number }): Promise<SyncResult> {
    const meta: AnpMeta = {
      profile: EXTENSION_PROFILE,
      security_profile: ANP_SECURITY_PROFILE.transportProtected,
      sender_did: this.identity.did,
      target: { kind: ANP_TARGET_KIND.agent, did: this.identity.did },
      operation_id: `sync:${randomUUID()}`,
    };
    const body: Record<string, unknown> = { since: input.since };
    if (input.limit !== undefined) body.limit = input.limit;
    const auth = await buildOriginProofAuth({
      method: SYNC_DELTA,
      meta,
      body,
      signer: this.signer,
    });
    const reply = (await this.call(
      buildMessageRequest({ id: this.requestId(), method: SYNC_DELTA, meta, body, auth }),
    )) as RpcReply;
    const result = resultOf(reply, SYNC_DELTA);
    const messages = Array.isArray(result.messages)
      ? (result.messages as Array<{ seq?: unknown; method?: unknown; params?: unknown }>).flatMap(item => {
          if (typeof item.seq !== 'number' || typeof item.method !== 'string') return [];
          const params = (item.params ?? {}) as {
            meta?: SyncMessage['meta'];
            body?: Record<string, unknown>;
          };
          if (!params.meta) return [];
          return [{ seq: item.seq, method: item.method, meta: params.meta, body: params.body ?? {} }];
        })
      : [];
    return {
      messages,
      nextSince: typeof result.next_since === 'number' ? result.next_since : input.since,
      hasMore: result.has_more === true,
      agedOut: typeof result.aged_out === 'number' ? result.aged_out : 0,
    };
  }

  /** 供 router 核对服务端能力；失败抛 AnpRpcError。 */
  async capabilities(): Promise<Record<string, unknown>> {
    const meta: AnpMeta = {
      profile: ANP_PROFILE.coreBinding,
      security_profile: ANP_SECURITY_PROFILE.transportProtected,
      sender_did: this.identity.did,
    };
    const reply = (await this.call(
      buildMessageRequest({ id: this.requestId(), method: 'anp.get_capabilities', meta, body: {} }),
    )) as RpcReply;
    return resultOf(reply, 'anp.get_capabilities');
  }

  get clock(): number {
    return this.now();
  }
}
