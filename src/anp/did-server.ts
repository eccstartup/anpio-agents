/**
 * Router 的公开面：DID 文档、ADP、ANP-08 发现索引、健康检查与管理接口。
 *
 * 与 ANP 消息服务分开监听：`@anpio-cli/service` 固定路由、没有扩展钩子，
 * 生产环境由同一个反向代理按路径分流。
 */

import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AGENT_DESCRIPTIONS_PATH } from '@anpio-cli/core';
import type { EmbeddedAgentDefinition } from '../definition.ts';
import { discoveryPage } from './description.ts';

export type DidServerAgent = {
  agentId: string;
  did: string;
  fingerprint: string;
  document: Record<string, unknown>;
  description: unknown;
  definition: EmbeddedAgentDefinition;
  enabled: boolean;
  didBaseUrl: string;
};

export type AdminContext = {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
};

export type DidServerOptions = {
  host: string;
  port: number;
  didBaseUrl: string;
  adminToken?: string;
  agents: () => DidServerAgent[];
  health: () => unknown;
  admin?: (context: AdminContext) => Promise<{ status: number; body: unknown }> | { status: number; body: unknown };
  log?: (line: string) => void;
  maxBodyBytes?: number;
};

export type RunningDidServer = {
  address: { host: string; port: number };
  listen: () => Promise<void>;
  close: () => Promise<void>;
};

function json(res: ServerResponse, status: number, body: unknown, contentType = 'application/json'): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

function authorized(header: string | undefined, token: string | undefined): boolean {
  if (!token) return false;
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(header ?? '');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function readBody(req: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new Error(`请求体超过 ${limit} 字节`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createDidServer(options: DidServerOptions): RunningDidServer {
  const address: { host: string; port: number } = { host: options.host, port: options.port };
  const maxBody = options.maxBodyBytes ?? 1_048_576;

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const path = url.pathname;
      const method = req.method ?? 'GET';

      if (path === '/health') {
        if (method !== 'GET') return json(res, 405, { error: 'method_not_allowed' });
        return json(res, 200, options.health());
      }

      if (path === AGENT_DESCRIPTIONS_PATH) {
        if (method !== 'GET') return json(res, 405, { error: 'method_not_allowed' });
        const page = discoveryPage(
          options.agents().map(agent => ({
            agentId: agent.agentId,
            did: agent.did,
            definition: agent.definition,
            enabled: agent.enabled,
            didBaseUrl: agent.didBaseUrl,
          })),
          options.didBaseUrl,
          {
            ...(url.searchParams.get('limit') ? { limit: Number(url.searchParams.get('limit')) } : {}),
            ...(url.searchParams.get('cursor') ? { cursor: url.searchParams.get('cursor')! } : {}),
          },
        );
        res.setHeader('x-total-count', String(page.total));
        return json(res, 200, page.index);
      }

      const adpMatch = /^\/agents\/([^/]+)\/ad\.json$/.exec(path);
      if (adpMatch) {
        if (method !== 'GET') return json(res, 405, { error: 'method_not_allowed' });
        const agent = findAgent(options.agents(), decodeURIComponent(adpMatch[1]!));
        if (!agent || !agent.enabled) return json(res, 404, { error: 'agent_not_found' });
        return json(res, 200, agent.description);
      }

      const didMatch = /^\/agents\/([^/]+)\/([^/]+)\/did\.json$/.exec(path);
      if (didMatch) {
        if (method !== 'GET') return json(res, 405, { error: 'method_not_allowed' });
        const agent = findAgent(options.agents(), decodeURIComponent(didMatch[1]!));
        if (!agent || !agent.enabled || agent.fingerprint !== didMatch[2]) {
          return json(res, 404, { error: 'did_not_found' });
        }
        return json(res, 200, agent.document, 'application/did+json');
      }

      if (path.startsWith('/admin/') || path === '/admin') {
        if (!authorized(req.headers.authorization, options.adminToken)) {
          res.setHeader('www-authenticate', 'Bearer');
          return json(res, 401, { error: 'unauthorized' });
        }
        if (!options.admin) return json(res, 404, { error: 'admin_disabled' });
        let body: unknown;
        if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
          const text = await readBody(req, maxBody);
          body = text ? JSON.parse(text) : undefined;
        }
        const result = await options.admin({ method, path, query: url.searchParams, body });
        return json(res, result.status, result.body);
      }

      return json(res, 404, { error: 'not_found' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.log?.(`DID server error: ${message}`);
      if (!res.headersSent) json(res, 500, { error: 'internal_error', message });
    }
  });

  return {
    address,
    async listen() {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.port, options.host, () => {
          server.off('error', reject);
          const info = server.address() as AddressInfo;
          address.host = info.address;
          address.port = info.port;
          resolve();
        });
      });
    },
    async close() {
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

function findAgent(agents: DidServerAgent[], agentId: string): DidServerAgent | undefined {
  return agents.find(agent => agent.agentId === agentId);
}
