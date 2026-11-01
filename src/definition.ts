/**
 * 平台下发的智能体定义。
 *
 * 校验与默认值在平台侧完成（anpio-collab 的 embedded 服务）；执行引擎只消费
 * 已经规范化的结构，离线时也可以用 examples/agents.json 里的定义自测。
 */

export const PROTOCOLS = [
  'openai-chat',
  'openai-responses',
  'anthropic-messages',
  'gemini-generate',
  'gemini-interactions',
  'workers-ai',
  'decision-jev',
  'subscription-cli',
  'script',
] as const;

export type Protocol = (typeof PROTOCOLS)[number];

export const EMBEDDED_TOOLS = [
  'task_get',
  'subtask_inbox',
  'task_accept',
  'task_progress',
  'task_submit',
  'subtask_reject',
  'task_comment',
  'task_comments',
  'offer_list',
  'offer_claim',
  'task_files',
  'file_download',
  'file_upload',
  'knowledge_search',
  'shell',
  'read_file',
  'write_file',
  'list_files',
  'finish',
  'anp_send',
  'anp_reply',
  'anp_list_messages',
  'anp_get_message',
  'list_agents',
  'agent_status',
  'spawn_agent',
  'schedule_create',
  'schedule_cancel',
  'list_schedules',
  'http_fetch',
  'memory_get',
  'memory_set',
  'finish_turn',
] as const;

export type EmbeddedTool = (typeof EMBEDDED_TOOLS)[number];

/** 执行引擎自己提供的工具，不依赖任何控制面。 */
export const LOCAL_TOOLS = ['shell', 'read_file', 'write_file', 'list_files', 'finish'] as const;

/** 常驻 router 才有的协作工具；进程内的 AgentHost 负责提供。 */
export const ROUTER_TOOLS = [
  'anp_send',
  'anp_reply',
  'anp_list_messages',
  'anp_get_message',
  'list_agents',
  'agent_status',
  'spawn_agent',
  'schedule_create',
  'schedule_cancel',
  'list_schedules',
  'http_fetch',
  'memory_get',
  'memory_set',
  'finish_turn',
] as const;

export function isLocalTool(tool: EmbeddedTool): boolean {
  return (LOCAL_TOOLS as readonly string[]).includes(tool);
}

export function isRouterTool(tool: EmbeddedTool): boolean {
  return (ROUTER_TOOLS as readonly string[]).includes(tool);
}

export const COMPLETION_POLICIES = ['finish', 'text'] as const;

/** finish：必须调用 finish 才算完成；text：模型给出纯文本回答即视为完成。 */
export type CompletionPolicy = (typeof COMPLETION_POLICIES)[number];

export const SESSION_ISOLATIONS = ['inline', 'process'] as const;

/** inline：Session 在 worker 进程内并发；process：每个 Session 一个子进程。 */
export type SessionIsolation = (typeof SESSION_ISOLATIONS)[number];

export type AgentScope =
  | 'tasks:read'
  | 'tasks:submit'
  | 'offers:claim'
  | 'knowledge:read'
  | 'comments:write'
  | 'presence:write'
  | 'mailbox:read'
  | 'mailbox:write';

export type ScriptStep = {
  text?: string;
  tool?: string;
  input?: Record<string, unknown>;
};

export type EmbeddedProviderConfig = {
  id: string;
  protocol: Protocol;
  baseUrl: string;
  model: string;
  apiKeyEnv: string | null;
  /** 只给 script 协议用：每一步要么说一句话，要么调一个工具。 */
  script?: ScriptStep[];
};

export type EmbeddedLimits = {
  maxTurns: number;
  timeoutMs: number;
  maxTokens: number;
};

export type EmbeddedSandbox = {
  shell: boolean;
  shellTimeoutMs: number;
  maxOutputBytes: number;
};

export type EmbeddedAgentDefinition = {
  id: string;
  name: string;
  description: string;
  capabilities: string[];
  provider: EmbeddedProviderConfig;
  systemPrompt: string;
  tools: EmbeddedTool[];
  scopes: AgentScope[];
  limits: EmbeddedLimits;
  sandbox: EmbeddedSandbox;
  enabled: boolean;
  concurrency: number;
  /** 缺省 inline，保持既有行为；process 让每个 Session 跑在独立子进程里。 */
  sessionIsolation?: SessionIsolation;
  /** 缺省 finish，保持平台行为；text 适合聊天式独立运行。 */
  completion?: CompletionPolicy;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
  lastError: string | null;
};

/** supervisor 从 GET /v1/embedded/agents 拿到的视图。 */
export type EmbeddedAgentView = EmbeddedAgentDefinition & { unread: number; running: number };
