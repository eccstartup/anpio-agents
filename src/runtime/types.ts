/**
 * AgentRuntime 与 Session 之间的契约。
 *
 * AgentRuntime 是常驻的「有身份、有资源」的一侧：定义、令牌、Brain、工具与
 * agent 级工作根。Session 是它身上一次运行的轻量上下文：mail session、
 * 对话历史、独立目录、时限与预算。两者之间只传普通数据，方便测试桩替换。
 */

import type { CollabClient } from '../client.ts';
import type { EmbeddedAgentDefinition } from '../definition.ts';

export type SessionOutcome = 'succeeded' | 'failed' | 'timeout' | 'outcome_unknown';

/** 一次运行需要的东西；definition 缺省时用 AgentRuntime 的快照。 */
export type SessionRequest = {
  runId: string;
  definition?: EmbeddedAgentDefinition;
  maxMessages?: number;
};

export type SessionResult = {
  status: SessionOutcome;
  turns: number;
  promptTokens: number;
  completionTokens: number;
  error: string | null;
  /** finish 工具给出的结论；没有调用 finish 时为 null。 */
  summary: string | null;
  /** 是否已经执行过工具：决定中断后消息退回的退避时间。 */
  toolExecuted: boolean;
  mailSessionId: string | null;
};

/** AgentRuntime 暴露给 Session 的能力，测试可以注入替身。 */
export type RuntimeContext = {
  agentId: string;
  definition: EmbeddedAgentDefinition;
  client: CollabClient;
  root: string;
};
