/**
 * 消息来源与线程事件的公共形状。
 *
 * 平台、stdin、以后的 IM / 定时抓取都只是 `MessageSource`：拉消息、确认消息、
 * 送回回复、提供工具。thread 的划分与模型循环都在 ThreadHost / ThreadTurn 里，
 * 来源不关心这些。
 */

import type { ToolBackend } from '../runtime/transport.ts';
import type { EnvironmentDescription } from '../runtime/prompt.ts';
import type { SessionResult } from '../runtime/types.ts';

export type InboundMessage = {
  id: string;
  /** 来源给出的对话标识；优先于 taskId / conversationId。 */
  threadId?: string | null;
  taskId?: string | null;
  conversationId?: string | null;
  text: string;
  title?: string;
  kind?: string;
  topic?: string;
  data?: unknown;
  sender?: string | null;
  replyTo?: string | null;
  receivedAt?: string;
  /** 显式要求开一个新 thread（REPL 的 /new）。 */
  newThread?: boolean;
  /** 来源自己的投递凭据；ack/nack 时原样带回来源。 */
  delivery?: unknown;
};

export type SourceAckInput = { retryAfterSeconds?: number; reason?: string };

export type TurnHandle = { finish(result: SessionResult): Promise<void> };

export type MessageSource = {
  id: string;
  kind: 'interactive' | 'background';
  /**
   * 启动订阅。push / long-poll 型来源在这里起自己的后台循环，收到消息后调用
   * emit() 叫醒 host，并放进自己的待取队列。不实现 open 的来源由 host 定期 poll()。
   */
  open?(emit: () => void): Promise<void>;
  /** 取走已缓冲的消息；必须立即返回，不能阻塞扫描循环。 */
  poll(): Promise<InboundMessage[]>;
  ack?(message: InboundMessage): Promise<void>;
  nack?(message: InboundMessage, input: SourceAckInput): Promise<void>;
  /** 可选：把 assistant 最终文本送回来源。没有发送接口的来源可省略。 */
  reply?(message: InboundMessage, text: string): Promise<void>;
  /** 可选：来源提供的工具后端；平台来源返回派生令牌的 CollabClient。 */
  tools?(): ToolBackend | undefined;
  environment?: EnvironmentDescription;
  /** 可选：turn 级记账钩子（平台以后可用它建 run / finish）。 */
  beginTurn?(message: InboundMessage): Promise<TurnHandle | null>;
  close?(): Promise<void>;
};

type EventBase = { threadId: string; turnId: string; sourceId: string };

export type ThreadEvent =
  | ({ type: 'turn-start' } & EventBase)
  | ({ type: 'text-delta'; text: string } & EventBase)
  | ({ type: 'assistant-text'; text: string } & EventBase)
  | ({ type: 'tool-call'; name: string; input: unknown } & EventBase)
  | ({ type: 'tool-result'; name: string; content: string; uncertain?: string } & EventBase)
  | ({
      type: 'plugin-progress';
      pluginId: string;
      tool: string;
      progress: number;
      total?: number;
      message?: string;
    } & EventBase)
  | ({ type: 'log'; level: 'info' | 'warn'; text: string } & EventBase)
  | ({
      type: 'turn-end';
      status: SessionResult['status'];
      summary: string | null;
      error: string | null;
    } & EventBase);

const MAX_THREAD_KEY = 256;

function clean(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, MAX_THREAD_KEY) : null;
}

/**
 * 判断一条消息属于哪个 thread：显式 threadId → taskId → conversationId →
 * 这条消息自己（一个任务一条消息）。newThread 用时间戳开新线程。
 */
export function normalizeThreadKey(sourceId: string, message: InboundMessage, now = Date.now()): string {
  if (message.newThread) return `${sourceId}:${now}`;
  return (
    clean(message.threadId)
    ?? clean(message.taskId)
    ?? clean(message.conversationId)
    ?? `${sourceId}:${message.id}`
  );
}
