/**
 * 平台 HTTP 客户端：只包含执行引擎会用到的那部分协议。
 *
 * 覆盖外部智能体同样拥有的能力：待办、开放池认领、子任务流转、评论、
 * 任务文件读写、知识检索与信箱；登录、邀请、任务管理等管理面方法不在这里。
 * 语义保持一致：
 *  - 不自动重试写请求，传输层失败标记为 uncertain（结果未知）；
 *  - 写请求必须显式给 operationId（作为 Idempotency-Key）；
 *  - 只依赖 fetch，Node 22 自带。
 */

export class CollabError extends Error {
  readonly status: number;
  readonly code: string;
  /** 写请求在传输层失败：请求可能已经生效，结果未知。 */
  readonly uncertain: boolean;

  constructor(message: string, options: { status?: number; code?: string; uncertain?: boolean; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = 'CollabError';
    this.status = options.status ?? 0;
    this.code = options.code ?? 'network';
    this.uncertain = options.uncertain ?? false;
  }
}

export type MailRef = {
  type: string;
  id: string;
  taskId: string | null;
  threadId: string | null;
};

export type MailEnvelope = {
  id: string;
  seq: number;
  deliveryId: string;
  topic: string;
  kind: string;
  priority: string;
  summary: string;
  ref: MailRef;
  publisherId: string;
  createdAt: string;
  expiresAt: string | null;
};

export type MailSession = {
  id: string;
  kind: string;
  label: string;
  status: string;
  cursorSeq: number;
  unread: number;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string | null;
  closedAt: string | null;
};

export type MailMessage = {
  id: string;
  topic: string;
  kind: string;
  priority: string;
  summary: string;
  ref: MailRef;
  publisherId: string;
  createdAt: string;
  expiresAt: string | null;
  content: unknown;
};

/** task_get 工具需要的字段子集；平台返回的其余字段原样透出给模型。 */
export type TaskDetail = {
  task: Record<string, unknown>;
  subtasks: Record<string, unknown>[];
  coordinators: unknown[];
  materials: unknown[];
};

/** 与外部智能体共用的待办、开放池与文件结构。 */
export type InboxItem = {
  id: string;
  taskId: string;
  kind: string;
  status: string;
  version: number;
  dueAt: string | null;
  dependsOn: string[];
  task: {
    id: string;
    title: string;
    type: string;
    priority: string;
    acceptance: string;
    dueAt: string;
    input: Record<string, unknown>;
  };
};

export type TaskOffer = {
  id: string;
  taskId: string;
  kind: string;
  description: string;
  capability: string | null;
  dueAt: string;
  status: string;
  claimedBy: string | null;
  subtaskId: string | null;
  createdAt: string;
  /** 只在开放池列表里出现。 */
  taskTitle?: string;
};

export type SpaceFile = {
  id: string;
  taskId: string | null;
  name: string;
  mime: string;
  size: number;
  kind: string;
  status: string;
  version: number;
  createdAt: string;
  [field: string]: unknown;
};

export type KnowledgeSearch = {
  items: {
    id: string;
    title: string;
    summary: string;
    version: number;
    reference: string;
    score: number;
    contentTruncated: boolean;
    [field: string]: unknown;
  }[];
  truncated: boolean;
  usedChars: number;
  budgetChars: number;
  budgetUnit: string;
  retrieval: string;
  note: string;
};

export type RequestOptions = {
  method?: 'GET' | 'POST';
  body?: unknown;
  operationId?: string;
  expectedVersion?: number;
  /** 外部取消信号（例如 Session 的 deadline）；与超时合并。 */
  signal?: AbortSignal;
};

export type ClientOptions = { timeoutMs?: number };

export class CollabClient {
  readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(baseUrl: string, token: string, options: ClientOptions = {}) {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('期望不带凭据的 HTTP(S) 服务地址');
    }
    this.baseUrl = url.origin;
    this.token = token;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1) throw new Error('超时设置不合法');
  }

  async request<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
    if (path.startsWith('/') || path.includes('://') || path.includes('#')) {
      throw new Error('期望 /v1 之下的相对路径');
    }
    const method = options.method ?? (options.body === undefined ? 'GET' : 'POST');
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}` };
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      if (!options.operationId) throw new Error('写请求需要 operationId');
      headers['idempotency-key'] = options.operationId;
    }
    if (options.expectedVersion !== undefined) headers['if-match'] = `"${options.expectedVersion}"`;

    let response: Response;
    try {
      const timeout = AbortSignal.timeout(this.timeoutMs);
      response = await fetch(new URL(`/v1/${path}`, this.baseUrl), {
        method,
        headers,
        redirect: 'error',
        signal: options.signal ? AbortSignal.any([timeout, options.signal]) : timeout,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
    } catch (error) {
      throw new CollabError(
        method === 'POST'
          ? '写请求结果未知：请用同一 operationId 重放，或先查询当前状态'
          : '读请求失败',
        { uncertain: method === 'POST', cause: error },
      );
    }

    const text = await response.text();
    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        throw new CollabError(`服务返回了非 JSON 响应（HTTP ${response.status}）`, { status: response.status });
      }
    }
    if (!response.ok) {
      const detail = (payload as { error?: { code?: string; message?: string } } | null)?.error;
      throw new CollabError(detail?.message ?? `请求失败（HTTP ${response.status}）`, {
        status: response.status,
        code: detail?.code ?? 'http_error',
      });
    }
    return payload as T;
  }

  // ------------------------------------------------------------ 任务协作
  task(id: string) {
    return this.request<TaskDetail>(`tasks/${encodeURIComponent(id)}`);
  }

  inbox() {
    return this.request<InboxItem[]>('inbox');
  }

  openOffers() {
    return this.request<TaskOffer[]>('offers');
  }

  claimOffer(offerId: string, operationId: string) {
    return this.request<{ offerId: string; subtaskId: string }>(
      `offers/${encodeURIComponent(offerId)}/claim`,
      { body: {}, operationId },
    );
  }

  reject(subtaskId: string, reason: string, operationId: string, expectedVersion?: number) {
    return this.request<Record<string, unknown>>(`subtasks/${encodeURIComponent(subtaskId)}/reject`, {
      body: { reason },
      operationId,
      expectedVersion,
    });
  }

  accept(subtaskId: string, operationId: string, expectedVersion?: number) {
    return this.request<Record<string, unknown>>(`subtasks/${encodeURIComponent(subtaskId)}/accept`, {
      body: {},
      operationId,
      expectedVersion,
    });
  }

  progress(subtaskId: string, text: string, operationId: string, expectedVersion?: number) {
    return this.request<Record<string, unknown>>(`subtasks/${encodeURIComponent(subtaskId)}/progress`, {
      body: { text },
      operationId,
      expectedVersion,
    });
  }

  submit(subtaskId: string, result: Record<string, unknown>, operationId: string, expectedVersion?: number) {
    return this.request<Record<string, unknown>>(`subtasks/${encodeURIComponent(subtaskId)}/submit`, {
      body: { result },
      operationId,
      expectedVersion,
    });
  }

  comment(taskId: string, body: string, operationId: string) {
    return this.request<{ id: string; body: string }>(`tasks/${encodeURIComponent(taskId)}/comments`, {
      body: { body },
      operationId,
    });
  }

  comments(taskId: string, limit = 200) {
    return this.request<unknown[]>(`tasks/${encodeURIComponent(taskId)}/comments?limit=${limit}`);
  }

  taskFiles(taskId: string) {
    return this.request<SpaceFile[]>(`tasks/${encodeURIComponent(taskId)}/files`);
  }

  downloadTaskFile(taskId: string, fileId: string) {
    return this.request<{ file: SpaceFile; data: string }>(
      `tasks/${encodeURIComponent(taskId)}/files/${encodeURIComponent(fileId)}`,
    );
  }

  uploadTaskFile(
    taskId: string,
    input: { name: string; mime?: string; kind?: string; data: string; subtaskId?: string },
    operationId: string,
  ) {
    return this.request<SpaceFile>(`tasks/${encodeURIComponent(taskId)}/files`, {
      body: input,
      operationId,
    });
  }

  searchKnowledge(query: string, limit = 10, budget = 4000) {
    return this.request<KnowledgeSearch>(
      `knowledge/search?q=${encodeURIComponent(query)}&limit=${limit}&budget=${budget}`,
    );
  }

  heartbeat(input: { state?: 'online' | 'busy' | 'offline'; note?: string; client?: string } = {}) {
    return this.request<{ principalId: string; state: string; lastSeenAt: string }>('agent/heartbeat', {
      body: input,
      operationId: `heartbeat:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    });
  }

  // ------------------------------------------------------------ 信箱
  createMailSession(
    input: {
      label?: string;
      kind?: 'external' | 'embedded';
      ttlSeconds?: number;
      subscriptions?: { topic: string; mode?: 'fanout' | 'queue' }[];
    },
    operationId: string,
    signal?: AbortSignal,
  ) {
    return this.request<MailSession>('mail/sessions', { body: input, operationId, signal });
  }

  closeMailSession(sessionId: string) {
    return this.request<{ id: string; status: 'closed' }>(
      `mail/sessions/${encodeURIComponent(sessionId)}/close`,
      { body: {}, operationId: `mail:close:${sessionId}:${Date.now()}` },
    );
  }

  pullMail(
    sessionId: string,
    options: { limit?: number; leaseSeconds?: number; includeDigest?: boolean; since?: number; waitMs?: number } = {},
    signal?: AbortSignal,
  ) {
    const params = new URLSearchParams();
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    if (options.leaseSeconds !== undefined) params.set('leaseSeconds', String(options.leaseSeconds));
    if (options.includeDigest) params.set('include', 'digest');
    if (options.since !== undefined) params.set('since', String(options.since));
    if (options.waitMs !== undefined) params.set('waitMs', String(options.waitMs));
    const suffix = params.size ? `?${params}` : '';
    return this.request<{ items: MailEnvelope[]; cursor: number; session: MailSession }>(
      `mail/sessions/${encodeURIComponent(sessionId)}/messages${suffix}`,
      { signal },
    );
  }

  mailMessage(messageId: string, signal?: AbortSignal) {
    return this.request<MailMessage>(`mail/messages/${encodeURIComponent(messageId)}`, { signal });
  }

  ackMail(messageId: string, deliveryId: string, operationId = `mail:ack:${messageId}:${deliveryId}`) {
    return this.request<{ id: string; state: string; duplicate: boolean }>(
      `mail/messages/${encodeURIComponent(messageId)}/ack`,
      { body: { deliveryId }, operationId },
    );
  }

  nackMail(
    messageId: string,
    input: { deliveryId: string; retryAfterSeconds?: number; reason?: string },
    operationId = `mail:nack:${messageId}:${input.deliveryId}:${Date.now()}`,
  ) {
    return this.request<{ id: string; state: string; attempts: number }>(
      `mail/messages/${encodeURIComponent(messageId)}/nack`,
      { body: input, operationId },
    );
  }
}
