/**
 * 独立运行的本地 HTTP 服务。
 *
 * 只有三个接口：提交一次运行、查询运行、健康快照。没有依赖，也不改变
 * Session 的语义；并发仍由 AgentRuntime 的信号量控制，服务只负责排队与收尾。
 */

import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AgentRuntime } from '../runtime/agent.ts';
import type { LocalTransport } from '../runtime/local/transport.ts';
import { StandaloneConfigError } from './config.ts';
import type { RunHandle, StandaloneAgent } from './runner.ts';

const MAX_BODY_BYTES = 1_048_576;
const RUN_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export type StandaloneServerOptions = {
  agent: StandaloneAgent;
  runtime: AgentRuntime;
  transport: LocalTransport;
  /** 默认只监听回环地址。 */
  host?: string;
  port?: number;
  /** 设置后所有接口都要求 Authorization: Bearer <token>。 */
  token?: string;
  /** 空闲多久自动退出；0 表示常驻。 */
  idleMs?: number;
  /** SIGTERM / close() 后等待运行收尾的时间。 */
  shutdownGraceMs?: number;
};

export type StandaloneServer = {
  url: string;
  port: number;
  /** 触发优雅退出；已经退出时返回同一个 promise。 */
  close(): Promise<void>;
  /** 服务真正退出时 resolve（包括空闲退出）。 */
  done: Promise<void>;
};

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, `请求体超过 ${MAX_BODY_BYTES} 字节`);
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) throw new HttpError(400, '请求体不能为空');
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON');
  }
}

function authorized(req: IncomingMessage, token: string | undefined): boolean {
  if (!token) return true;
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const provided = Buffer.from(header.slice('Bearer '.length));
  const expected = Buffer.from(token);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function delay(ms: number): Promise<void> {
  // 不使用 unref：优雅退出等待期间必须让事件循环保持存活。
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function startStandaloneServer(options: StandaloneServerOptions): Promise<StandaloneServer> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 8788;
  const token = options.token;
  const idleMs = Math.max(0, options.idleMs ?? 0);
  const shutdownGraceMs = Math.max(0, options.shutdownGraceMs ?? 15_000);

  if (!LOOPBACK.has(host) && !token) {
    throw new StandaloneConfigError('监听非回环地址时必须设置 AGENT_HTTP_TOKEN');
  }

  const { agent, runtime, transport } = options;
  const inFlight = new Map<string, RunHandle>();
  const starting = new Set<Promise<RunHandle>>();
  const idempotency = new Map<string, Promise<RunHandle>>();
  let stopping = false;
  let doneResolve: () => void = () => undefined;
  const done = new Promise<void>(resolve => {
    doneResolve = resolve;
  });
  let shutdownPromise: Promise<void> | null = null;
  let idleTimer: NodeJS.Timeout | null = null;

  const clearIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  };

  const touch = () => {
    if (!idleMs || stopping) return;
    clearIdle();
    idleTimer = setTimeout(() => {
      if (inFlight.size === 0 && starting.size === 0 && agent.queued === 0) {
        void shutdown('服务空闲，自动退出');
      } else {
        touch();
      }
    }, idleMs);
    idleTimer.unref?.();
  };

  const shutdown = (reason: string): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      stopping = true;
      clearIdle();
      server.closeIdleConnections?.();
      await new Promise<void>(resolve => server.close(() => resolve()));

      const deadline = Date.now() + shutdownGraceMs;
      while ((inFlight.size > 0 || starting.size > 0) && Date.now() < deadline) {
        await delay(50);
      }
      if (inFlight.size > 0 || starting.size > 0) {
        process.stderr.write(`[warn] ${reason}：超时后中断剩余运行\n`);
        agent.abortAll(reason);
        const finalDeadline = Date.now() + 2_000;
        while ((inFlight.size > 0 || starting.size > 0) && Date.now() < finalDeadline) {
          await delay(50);
        }
      }
      server.closeAllConnections?.();
      doneResolve();
    })();
    return shutdownPromise;
  };

  const handleRun = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await readJsonBody(req);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new HttpError(400, '请求体必须是对象');
    }
    const value = body as { text?: unknown; threadId?: unknown };
    if (typeof value.text !== 'string' || !value.text.trim()) {
      throw new HttpError(400, 'text 必须是非空字符串');
    }
    if (value.threadId !== undefined && typeof value.threadId !== 'string') {
      throw new HttpError(400, 'threadId 必须是字符串');
    }
    const text = value.text as string;
    const threadId = typeof value.threadId === 'string' && value.threadId ? value.threadId : undefined;

    const keyHeader = req.headers['idempotency-key'];
    const idempotencyKey = typeof keyHeader === 'string' && keyHeader.trim() ? keyHeader.trim() : null;

    const submit = (): Promise<RunHandle> => {
      if (idempotencyKey) {
        const existing = idempotency.get(idempotencyKey);
        if (existing) return existing;
      }
      const promise = agent.start({
        text,
        ...(threadId ? { threadId } : {}),
      });
      starting.add(promise);
      if (idempotencyKey) idempotency.set(idempotencyKey, promise);
      void promise.finally(() => starting.delete(promise)).catch(() => undefined);
      return promise;
    };

    let handle: RunHandle;
    try {
      handle = await submit();
    } catch (error) {
      if (idempotencyKey) idempotency.delete(idempotencyKey);
      throw error;
    }

    if (stopping) {
      handle.abort('服务正在退出');
    }
    inFlight.set(handle.runId, handle);
    void handle.done
      .finally(() => {
        inFlight.delete(handle.runId);
        touch();
      })
      .catch(() => undefined);

    sendJson(res, 202, { runId: handle.runId });
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      touch();
      if (!authorized(req, token)) {
        res.setHeader('www-authenticate', 'Bearer');
        throw new HttpError(401, '需要 Bearer 令牌');
      }

      const method = req.method ?? 'GET';
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/health' && method === 'GET') {
        sendJson(res, 200, {
          ok: !stopping,
          active: runtime.activeSessions,
          queued: agent.queued,
        });
        return;
      }
      if (url.pathname === '/runs' && method === 'POST') {
        if (stopping) throw new HttpError(503, '服务正在退出，不再接受新运行');
        await handleRun(req, res);
        return;
      }
      if (url.pathname.startsWith('/runs/') && method === 'GET') {
        const runId = decodeURIComponent(url.pathname.slice('/runs/'.length));
        if (!RUN_ID.test(runId)) throw new HttpError(404, '没有这个运行');
        const record = await transport.runs.get(runId);
        if (!record) throw new HttpError(404, '没有这个运行');
        sendJson(res, 200, {
          runId: record.runId,
          status: record.status,
          summary: record.summary,
          error: record.error,
          turns: record.turns,
          promptTokens: record.promptTokens,
          completionTokens: record.completionTokens,
          toolExecuted: record.toolExecuted,
          threadId: record.threadId ?? null,
          createdAt: record.createdAt,
          startedAt: record.startedAt,
          finishedAt: record.finishedAt,
        });
        return;
      }
      throw new HttpError(404, '没有这个接口');
    })().catch((error: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof HttpError) {
        sendJson(res, error.status, { error: error.message });
        return;
      }
      if (error instanceof StandaloneConfigError) {
        sendJson(res, 400, { error: error.message });
        return;
      }
      sendJson(res, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve();
    });
  });

  const address = server.address();
  if (typeof address !== 'object' || address === null) {
    await shutdown('服务启动失败');
    throw new Error('无法确定监听端口');
  }
  const actualPort = address.port;
  const displayHost = host.includes(':') ? `[${host}]` : host;
  touch();

  return {
    url: `http://${displayHost}:${actualPort}`,
    port: actualPort,
    close: () => shutdown('服务关闭'),
    done,
  };
}
