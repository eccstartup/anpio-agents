/**
 * 平台订阅来源：用派生令牌打开一个长期信箱会话，把平台推送的消息
 * 转成 thread 消息。
 *
 * 平台只是消息来源之一，不创建 platform run；任务动作仍由工具完成。
 * 不调用 embedded/agents/import，也不修改平台上的定义。
 */

import { CollabClient, CollabError, type MailEnvelope } from '../client.ts';
import type { ToolBackend } from '../runtime/transport.ts';
import { COLLAB_ENVIRONMENT, type EnvironmentDescription } from '../runtime/prompt.ts';
import { deriveEmbeddedToken } from '../token.ts';
import type { InboundMessage, MessageSource } from '../threads/types.ts';

const DEFAULT_POLL_MS = 3_000;
const DEFAULT_SESSION_TTL_SECONDS = 86_400;
const LEASE_SECONDS = 300;
const MAX_BACKOFF_MS = 30_000;

export type PlatformSourceOptions = {
  id?: string;
  baseUrl: string;
  agentId: string;
  /** 默认 COLLAB_RUNTIME_TOKEN。 */
  adminTokenEnv?: string;
  /** 默认 COLLAB_EMBEDDED_SECRET。 */
  secretEnv?: string;
  pollMs?: number;
  sessionTtlSeconds?: number;
  label?: string;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  /** 测试注入用；缺省按派生令牌新建。 */
  client?: CollabClient;
  adminClient?: CollabClient;
};

export class PlatformSource implements MessageSource {
  readonly id: string;
  readonly kind = 'background' as const;
  readonly environment: EnvironmentDescription = COLLAB_ENVIRONMENT;

  private readonly agentId: string;
  private readonly pollMs: number;
  private readonly sessionTtlSeconds: number;
  private readonly label: string;
  private readonly log: (line: string) => void;

  private readonly admin: CollabClient;
  private readonly derived: CollabClient;
  private sessionId: string | null = null;
  private controller: AbortController | null = null;
  private loop: Promise<void> | null = null;
  private emitter: (() => void) | null = null;
  private buffer: InboundMessage[] = [];
  private closed = false;

  constructor(options: PlatformSourceOptions) {
    const env = options.env ?? process.env;
    this.id = options.id ?? 'platform';
    this.agentId = options.agentId;
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.sessionTtlSeconds = options.sessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS;
    this.label = options.label ?? `agent:${options.agentId}`;
    this.log = options.log ?? (() => undefined);

    const adminToken = requiredEnv(env, options.adminTokenEnv ?? 'COLLAB_RUNTIME_TOKEN');
    const secret = requiredEnv(env, options.secretEnv ?? 'COLLAB_EMBEDDED_SECRET');
    this.admin = options.adminClient ?? new CollabClient(options.baseUrl, adminToken);
    this.derived = options.client
      ?? new CollabClient(options.baseUrl, deriveEmbeddedToken(secret, this.agentId), {
        timeoutMs: this.pollMs + 10_000,
      });
  }

  async open(emit: () => void): Promise<void> {
    if (this.loop) return;
    this.emitter = emit;
    this.controller = new AbortController();
    this.loop = this.run(this.controller.signal);
  }

  poll(): Promise<InboundMessage[]> {
    return Promise.resolve(this.buffer.splice(0));
  }

  tools(): ToolBackend | undefined {
    return this.derived;
  }

  async ack(message: InboundMessage): Promise<void> {
    const deliveryId = deliveryIdOf(message);
    if (!deliveryId) return;
    await this.derived.ackMail(message.id, deliveryId);
  }

  async nack(message: InboundMessage, input: { retryAfterSeconds?: number; reason?: string }): Promise<void> {
    const deliveryId = deliveryIdOf(message);
    if (!deliveryId) return;
    await this.derived.nackMail(
      message.id,
      {
        deliveryId,
        ...(input.retryAfterSeconds !== undefined ? { retryAfterSeconds: input.retryAfterSeconds } : {}),
        ...(input.reason ? { reason: input.reason } : {}),
      },
      `mail:nack:${message.id}:${deliveryId}`,
    );
  }

  async close(): Promise<void> {
    this.closed = true;
    this.controller?.abort(new Error('平台来源关闭'));
    await this.loop?.catch(() => undefined);
    this.loop = null;
    this.controller = null;
    const sessionId = this.sessionId;
    this.sessionId = null;
    if (sessionId) {
      await this.derived.closeMailSession(sessionId).catch(() => undefined);
    }
  }

  private async run(signal: AbortSignal): Promise<void> {
    let backoff = 1_000;
    let failures = 0;
    while (!this.closed && !signal.aborted) {
      try {
        if (!this.sessionId) await this.openSession(signal);
        const result = await this.derived.pullMail(
          this.sessionId!,
          { limit: 20, leaseSeconds: LEASE_SECONDS, waitMs: this.pollMs },
          signal,
        );
        failures = 0;
        backoff = 1_000;
        if (result.session?.id && result.session.id !== this.sessionId) this.sessionId = result.session.id;
        for (const envelope of result.items ?? []) {
          await this.receive(envelope, signal);
        }
      } catch (error) {
        if (this.closed || signal.aborted) break;
        failures += 1;
        this.log(`平台订阅失败：${messageOf(error)}`);
        if (isSessionGone(error) || failures >= 3) {
          this.sessionId = null;
          failures = 0;
        }
        await sleep(backoff, signal);
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      }
    }
  }

  private async ensureAgent(signal: AbortSignal): Promise<void> {
    await this.admin.request(`embedded/agents/${encodeURIComponent(this.agentId)}/ensure`, {
      body: {},
      operationId: `ensure:${this.agentId}:${Date.now()}`,
      signal,
    });
  }

  private async openSession(signal: AbortSignal): Promise<void> {
    await this.ensureAgent(signal);
    const session = await this.derived.createMailSession(
      {
        label: this.label,
        kind: 'embedded',
        ttlSeconds: this.sessionTtlSeconds,
      },
      `mail-session:${this.agentId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      signal,
    );
    this.sessionId = session.id;
    this.log(`平台信箱已连接：${session.id}`);
  }

  private async receive(envelope: MailEnvelope, signal: AbortSignal): Promise<void> {
    let content: unknown = null;
    try {
      const message = await this.derived.mailMessage(envelope.id, signal);
      content = message.content;
    } catch (error) {
      if (this.closed || signal.aborted) return;
      this.log(`取消息 ${envelope.id} 失败：${messageOf(error)}`);
      return;
    }

    const threadId = envelope.ref?.threadId ?? envelope.ref?.taskId ?? null;
    this.buffer.push({
      id: envelope.id,
      threadId,
      text: textOf(content) ?? envelope.summary ?? '',
      title: envelope.summary,
      kind: envelope.kind,
      topic: envelope.topic,
      data: content,
      sender: envelope.publisherId,
      receivedAt: envelope.createdAt,
      delivery: { deliveryId: envelope.deliveryId },
    });
    this.emitter?.();
  }
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name] ?? '';
  if (!value) throw new Error(`需要 ${name}`);
  return value;
}

function isSessionGone(error: unknown): boolean {
  if (!(error instanceof CollabError)) return false;
  return error.status === 404 || error.status === 410;
}

function deliveryIdOf(message: InboundMessage): string | null {
  const delivery = message.delivery;
  if (typeof delivery !== 'object' || delivery === null) return null;
  const value = (delivery as { deliveryId?: unknown }).deliveryId;
  return typeof value === 'string' && value ? value : null;
}

function textOf(content: unknown): string | null {
  const record = asRecord(content);
  const direct = field(record.text) ?? field(record.content);
  if (direct) return direct;
  const payload = asRecord(record.payload);
  const fromPayload = field(payload.text);
  if (fromPayload) return fromPayload;
  const body = asRecord(record.body);
  const fromBody = field(asRecord(body.payload).text) ?? field(body.text);
  return fromBody ?? null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function field(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
