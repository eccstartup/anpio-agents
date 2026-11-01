/**
 * AgentTransport：Session 真正依赖的控制面端口。
 *
 * 平台概念（operationId、mail session、embedded/runs）只留在 Collab 实现里。
 * 本地运行、未来的聊天/Webhook 接入只要实现这组端口，就能复用同一个
 * AgentRuntime 与 AgentSession。
 */

import type {
  CollabClient,
  InboxItem,
  KnowledgeSearch,
  MailEnvelope,
  MailMessage,
  MailSession,
  SpaceFile,
  TaskDetail,
  TaskOffer,
} from '../client.ts';
import type { EmbeddedTool } from '../definition.ts';
import { COLLAB_ENVIRONMENT, type EnvironmentDescription } from './prompt.ts';
import type { LogLevel, SessionOutcome, SessionResult } from './types.ts';

export type MailboxPort = {
  open(
    input: { label?: string; kind?: 'embedded' | 'external'; ttlSeconds?: number },
    signal?: AbortSignal,
  ): Promise<MailSession>;
  pull(
    sessionId: string,
    options: { limit?: number; leaseSeconds?: number; since?: number; waitMs?: number },
    signal?: AbortSignal,
  ): Promise<{ items: MailEnvelope[]; cursor: number }>;
  message(messageId: string, signal?: AbortSignal): Promise<MailMessage>;
  ack(messageId: string, deliveryId: string): Promise<void>;
  nack(messageId: string, input: { deliveryId: string; retryAfterSeconds?: number; reason?: string }): Promise<void>;
  close(sessionId: string): Promise<void>;
  /** 长期信箱：重启后继续同一 session；不支持的传输层可以省略。 */
  resume?(sessionKey: string, signal?: AbortSignal): Promise<void>;
  renew?(sessionId: string, leaseSeconds: number): Promise<void>;
  pending?(sessionId?: string): number;
};

export type RunLedgerPort = {
  heartbeat(runId: string, input?: { sessionId?: string }): Promise<void>;
  log(runId: string, level: LogLevel, text: string): Promise<void>;
  finish(runId: string, result: SessionResult): Promise<void>;
  status(runId: string): Promise<{ status: SessionOutcome | 'running' }>;
};

export type PresencePort = {
  heartbeat(input?: { state?: 'online' | 'busy' | 'offline'; note?: string }): Promise<void>;
};

/** 任务/文件/知识工具的后端；没有它的传输层只支持本地原语。 */
export type ToolBackend = {
  task(id: string): Promise<TaskDetail>;
  inbox(): Promise<InboxItem[]>;
  openOffers(): Promise<TaskOffer[]>;
  claimOffer(offerId: string, operationId: string): Promise<{ offerId: string; subtaskId: string }>;
  reject(
    subtaskId: string,
    reason: string,
    operationId: string,
    expectedVersion?: number,
  ): Promise<Record<string, unknown>>;
  accept(subtaskId: string, operationId: string, expectedVersion?: number): Promise<Record<string, unknown>>;
  progress(
    subtaskId: string,
    text: string,
    operationId: string,
    expectedVersion?: number,
  ): Promise<Record<string, unknown>>;
  submit(
    subtaskId: string,
    result: Record<string, unknown>,
    operationId: string,
    expectedVersion?: number,
  ): Promise<Record<string, unknown>>;
  comment(taskId: string, body: string, operationId: string): Promise<{ id: string; body: string }>;
  comments(taskId: string, limit?: number): Promise<unknown[]>;
  taskFiles(taskId: string): Promise<SpaceFile[]>;
  downloadTaskFile(taskId: string, fileId: string): Promise<{ file: SpaceFile; data: string }>;
  uploadTaskFile(
    taskId: string,
    input: { name: string; mime?: string; kind?: string; data: string; subtaskId?: string },
    operationId: string,
  ): Promise<SpaceFile>;
  searchKnowledge(query: string, limit?: number, budget?: number): Promise<KnowledgeSearch>;
};

export type AgentTransport = {
  mailbox: MailboxPort;
  runs: RunLedgerPort;
  presence: PresencePort;
  tools?: ToolBackend;
  /** 这个传输层是否支持某个工具；shell / 文件 / finish 这类原语由执行引擎提供。 */
  supportsTool(name: EmbeddedTool): boolean;
  /** 渲染系统提示与 AGENTS.md 的环境说明，替代写死的“平台规则”。 */
  environment: EnvironmentDescription;
  /** process 隔离时子进程的启动配置；返回 null 表示暂不支持。 */
  spawnConfig?(runId: string): Record<string, unknown> | null;
};

function finishBody(result: SessionResult): Record<string, unknown> {
  return {
    status: result.status,
    exitCode: result.status === 'succeeded' ? 0 : 1,
    turns: result.turns,
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
    outcomeUnknown: result.status === 'outcome_unknown',
    ...(result.error ? { error: result.error } : {}),
  };
}

/** 把现有 CollabClient 逐个转接成端口；平台路径的行为保持不变。 */
export function collabTransport(
  client: CollabClient,
  connection: { baseUrl: string; token: string },
): AgentTransport {
  return {
    mailbox: {
      open: (input, signal) =>
        client.createMailSession(input, `mail-session:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`, signal),
      pull: (sessionId, options, signal) => client.pullMail(sessionId, options, signal),
      message: (messageId, signal) => client.mailMessage(messageId, signal),
      ack: async (messageId, deliveryId) => {
        await client.ackMail(messageId, deliveryId);
      },
      nack: async (messageId, input) => {
        await client.nackMail(messageId, input);
      },
      close: async sessionId => {
        await client.closeMailSession(sessionId);
      },
    },
    runs: {
      heartbeat: async (runId, input = {}) => {
        await client.request(`embedded/runs/${encodeURIComponent(runId)}/heartbeat`, {
          body: input.sessionId ? { sessionId: input.sessionId } : {},
          operationId: `run-hb:${runId}:${Date.now()}`,
        });
      },
      log: async (runId, level, text) => {
        await client.request(`embedded/runs/${encodeURIComponent(runId)}/log`, {
          body: { level, text },
          operationId: `run-log:${runId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
        });
      },
      finish: async (runId, result) => {
        await client.request(`embedded/runs/${encodeURIComponent(runId)}/finish`, {
          body: finishBody(result),
          operationId: `run-finish:${runId}`,
        });
      },
      status: async runId => {
        const run = await client.request<{ status?: string }>(`embedded/runs/${encodeURIComponent(runId)}`);
        return { status: (run.status ?? 'running') as SessionOutcome | 'running' };
      },
    },
    presence: {
      heartbeat: async input => {
        await client.heartbeat(input);
      },
    },
    tools: client,
    supportsTool: () => true,
    environment: COLLAB_ENVIRONMENT,
    spawnConfig: () => ({ type: 'collab', baseUrl: connection.baseUrl, token: connection.token }),
  };
}
