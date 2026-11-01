/**
 * 管理接口：状态、agent 列表、热重载、按路由规则投递消息。
 *
 * 鉴权由 did-server 的 Bearer token 完成；这里只做参数校验与数据汇总。
 */

import type { AnpPayload } from '../anp/client.ts';
import type { AdminContext } from '../anp/did-server.ts';
import type { RouterStore } from '../store/router-store.ts';
import type { AgentHost } from './agent-host.ts';
import type { RouterConfig } from './config.ts';
import type { RouteDecision } from './routing.ts';

export type AdminSendInput = {
  from: string;
  to?: string | null;
  threadId?: string | null;
  skills?: string[];
  payload: AnpPayload;
  replyTo?: string | null;
};

export type AdminSendResult = {
  route: RouteDecision;
  messageId: string;
  queued: boolean;
};

export type AdminDeps = {
  config: RouterConfig;
  router: RouterStore;
  hosts: () => Map<string, AgentHost>;
  startedAt: string;
  status: () => unknown;
  send: (input: AdminSendInput) => Promise<AdminSendResult>;
  reload: () => Promise<{ added: string[]; updated: string[]; removed: string[] }>;
};

type Reply = { status: number; body: unknown };

function reply(status: number, body: unknown): Reply {
  return { status, body };
}

function parseBody(context: AdminContext): Record<string, unknown> {
  if (typeof context.body !== 'object' || context.body === null || Array.isArray(context.body)) {
    throw new Error('请求体必须是对象');
  }
  return context.body as Record<string, unknown>;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${path} 必须是非空字符串`);
  return value.trim();
}

function optionalString(value: unknown, path: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error(`${path} 必须是字符串`);
  return value.trim() === '' ? null : value;
}

function stringList(value: unknown, path: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${path} 必须是字符串数组`);
  return value.map((item, index) => {
    if (typeof item !== 'string') throw new Error(`${path}[${index}] 必须是字符串`);
    return item;
  });
}

function parsePayload(body: Record<string, unknown>): AnpPayload {
  const raw = body.payload === undefined ? body : body.payload;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('payload 必须是对象');
  const fields = raw as Record<string, unknown>;
  const text = optionalString(fields.text, 'text');
  const title = optionalString(fields.title, 'title');
  const type = optionalString(fields.type, 'type') ?? 'anp.task.request';
  if (!text && !title && !('data' in fields)) throw new Error('payload 或 text 至少提供一项');
  return {
    type,
    ...(text ? { text } : {}),
    ...(title ? { title } : {}),
    ...('data' in fields ? { data: fields.data } : {}),
  };
}

function agentSummary(host: AgentHost): unknown {
  return {
    id: host.agentId,
    name: host.definition.name,
    did: host.did,
    capabilities: host.definition.capabilities,
    enabled: host.enabled,
    activeTurns: host.activeTurns,
    lastError: host.lastError,
  };
}

export function createAdmin(deps: AdminDeps): (context: AdminContext) => Promise<Reply> {
  return async context => {
    const { method, path, query } = context;
    try {
      if (path === '/admin' || path === '/admin/status') {
        if (method !== 'GET') return reply(405, { error: 'method_not_allowed' });
        return reply(200, {
          ...(deps.status() as Record<string, unknown>),
          root: deps.config.root,
          startedAt: deps.startedAt,
          uptimeMs: Date.now() - Date.parse(deps.startedAt),
          agents: [...deps.hosts().values()].map(agentSummary),
        });
      }

      if (path === '/admin/agents') {
        if (method !== 'GET') return reply(405, { error: 'method_not_allowed' });
        return reply(200, { agents: [...deps.hosts().values()].map(agentSummary) });
      }

      const agentMatch = /^\/admin\/agents\/([^/]+)(?:\/(enable|disable))?$/.exec(path);
      if (agentMatch) {
        const agentId = decodeURIComponent(agentMatch[1]!);
        const host = deps.hosts().get(agentId);
        if (!host) return reply(404, { error: 'agent_not_found', agentId });
        const action = agentMatch[2];
        if (!action) {
          if (method !== 'GET') return reply(405, { error: 'method_not_allowed' });
          const threadId = query.get('threadId');
          const turns = deps.router.listTurns(agentId, threadId ?? undefined, Number(query.get('limit') ?? 20));
          return reply(200, {
            ...(agentSummary(host) as Record<string, unknown>),
            definition: host.definition,
            sessions: deps.router.listSessions(agentId).map(session => ({
              sessionId: session.session_id,
              threadId: session.thread_id,
              state: session.state,
              activeTurnId: session.active_turn_id,
              updatedAt: session.updated_at,
            })),
            turns,
          });
        }
        if (method !== 'POST') return reply(405, { error: 'method_not_allowed' });
        host.setEnabled(action === 'enable');
        return reply(200, { agentId, enabled: host.enabled });
      }

      if (path === '/admin/messages') {
        if (method !== 'POST') return reply(405, { error: 'method_not_allowed' });
        const body = parseBody(context);
        const from = requireString(body.from, 'from');
        const payload = parsePayload(body);
        const result = await deps.send({
          from,
          to: optionalString(body.to, 'to'),
          threadId: optionalString(body.threadId, 'threadId'),
          skills: stringList(body.skills, 'skills'),
          payload,
          replyTo: optionalString(body.replyTo, 'replyTo'),
        });
        return reply(202, result);
      }

      if (path === '/admin/reload') {
        if (method !== 'POST') return reply(405, { error: 'method_not_allowed' });
        return reply(200, await deps.reload());
      }

      return reply(404, { error: 'not_found' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply(400, { error: 'bad_request', message });
    }
  };
}
