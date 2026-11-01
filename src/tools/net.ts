/**
 * 受策略限制的 HTTP 出站。
 *
 * 进程模式下这是唯一由 router 真正执行的网络入口：allowlist、DNS 后的地址
 * 校验、超时、响应上限与重定向次数都在这里兑现。工具结果只回报 host /
 * status / bytes，正文交给模型；审计不记录正文。
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { ToolSpec } from '../brains/types.ts';
import type { EmbeddedTool } from '../definition.ts';
import type { FetchLike } from '../brains/types.ts';

export type NetworkMode = 'none' | 'egress' | 'open';

export type NetworkPolicy = {
  mode: NetworkMode;
  allowlist: string[];
};

export type HttpFetchInput = {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

export type HttpFetchResult = {
  url: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  bytes: number;
  redirected: number;
};

export type HttpFetchOptions = {
  fetchImpl?: FetchLike;
  lookupImpl?: (host: string) => Promise<string[]>;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 3;

type Schema = Record<string, unknown>;

export const NET_TOOL_SPECS = {
  http_fetch: {
    name: 'http_fetch',
    description:
      '按网络策略请求一个 http/https 地址。只允许 allowlist 中的主机，拒绝内网地址；响应最多 1 MiB。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '完整 http/https 地址' },
        method: { type: 'string', description: '可选：GET（默认）或 POST' },
        headers: { type: 'object', description: '可选：请求头，值必须是字符串' },
        body: { type: 'string', description: '可选：POST 正文' },
      },
      required: ['url'],
      additionalProperties: false,
    } satisfies Schema,
  },
} satisfies Partial<Record<EmbeddedTool, ToolSpec>>;

function hostOf(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
}

function allowlistEntry(entry: string): { host: string; port: string | null } {
  const trimmed = entry.trim().toLowerCase();
  if (trimmed === '') return { host: '', port: null };
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    const host = trimmed.slice(1, end);
    const rest = trimmed.slice(end + 1);
    return { host, port: rest.startsWith(':') ? rest.slice(1) : null };
  }
  const colon = trimmed.lastIndexOf(':');
  if (colon > 0 && trimmed.indexOf(':') === colon) {
    return { host: trimmed.slice(0, colon), port: trimmed.slice(colon + 1) };
  }
  return { host: trimmed, port: null };
}

function allowedHost(url: URL, allowlist: string[]): boolean {
  const host = hostOf(url);
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return allowlist.some(entry => {
    const parsed = allowlistEntry(entry);
    if (parsed.host === '') return false;
    if (parsed.port !== null && parsed.port !== port) return false;
    if (parsed.host.startsWith('*.')) {
      const suffix = parsed.host.slice(2);
      return host === suffix || host.endsWith(`.${suffix}`);
    }
    return host === parsed.host;
  });
}

function ipv4Parts(address: string): number[] | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const numbers = parts.map(part => Number(part));
  if (numbers.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return null;
  return numbers;
}

function isPrivateIpv4(address: string): boolean {
  const parts = ipv4Parts(address);
  if (!parts) return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && parts[2] === 100) return true;
  if (a === 203 && b === 0 && parts[2] === 113) return true;
  if (a >= 224) return true;
  return false;
}

function ipv4FromMapped(address: string): string | null {
  const match = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  return match ? match[1]! : null;
}

export function isPrivateAddress(raw: string): boolean {
  const address = raw.replace(/^\[|\]$/g, '').toLowerCase();
  const mapped = ipv4FromMapped(address);
  if (mapped) return isPrivateIpv4(mapped);
  if (isIP(address) === 4) return isPrivateIpv4(address);
  if (isIP(address) !== 6) return true;
  if (address === '::' || address === '::1') return true;
  if (/^f[cd]/.test(address)) return true;
  if (/^fe[89ab]/.test(address)) return true;
  if (/^ff/.test(address)) return true;
  return false;
}

function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === 'localhost'
    || host.endsWith('.localhost')
    || host.endsWith('.local')
    || host.endsWith('.internal')
    || host.endsWith('.home.arpa')
  );
}

async function defaultLookup(host: string): Promise<string[]> {
  const results = await lookup(host, { all: true, verbatim: true });
  return results.map(result => result.address);
}

async function assertPublicHost(
  url: URL,
  policy: NetworkPolicy,
  lookupImpl: (host: string) => Promise<string[]>,
): Promise<void> {
  const host = hostOf(url);
  if (host === '') throw new Error('地址缺少主机名');
  if (isPrivateHostname(host)) throw new Error(`拒绝访问内网主机：${host}`);
  if (policy.mode === 'none') throw new Error('该 agent 的网络策略是 none');
  if (policy.mode === 'egress' && !allowedHost(url, policy.allowlist)) {
    throw new Error(`主机 ${host} 不在 allowlist 中`);
  }
  let addresses: string[];
  if (isIP(host)) {
    addresses = [host];
  } else {
    addresses = await lookupImpl(host);
  }
  if (addresses.length === 0) throw new Error(`无法解析主机 ${host}`);
  for (const address of addresses) {
    if (isPrivateAddress(address)) throw new Error(`拒绝访问内网地址：${host} → ${address}`);
  }
}

function headerRecord(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

async function readCapped(response: Response, maxBytes: number): Promise<{ body: string; bytes: number }> {
  if (!response.body) {
    const text = await response.text();
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > maxBytes) throw new Error(`响应超过 ${maxBytes} 字节`);
    return { body: text, bytes };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`响应超过 ${maxBytes} 字节`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  return { body: Buffer.concat(chunks).toString('utf8'), bytes: total };
}

export async function executeHttpFetch(
  input: HttpFetchInput,
  policy: NetworkPolicy,
  options: HttpFetchOptions = {},
): Promise<HttpFetchResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const lookupImpl = options.lookupImpl ?? defaultLookup;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  const method = (input.method ?? 'GET').toUpperCase();
  if (!['GET', 'POST', 'HEAD'].includes(method)) throw new Error('method 只能是 GET / POST / HEAD');
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    throw new Error('url 不是合法地址');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('只允许 http/https 地址');
  }
  if (url.username || url.password) throw new Error('地址里不能带凭据');

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.headers ?? {})) {
    if (typeof value !== 'string') throw new Error(`请求头 ${key} 必须是字符串`);
    headers[key] = value;
  }

  let current = url;
  let redirects = 0;
  let body = input.body;
  for (;;) {
    await assertPublicHost(current, policy, lookupImpl);
    const signal = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(current, {
        method,
        headers,
        ...(method === 'GET' || method === 'HEAD' ? {} : body === undefined ? {} : { body }),
        redirect: 'manual',
        signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new Error(`请求超时（${timeoutMs}ms）`);
      }
      throw error;
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error(`HTTP ${response.status} 缺少 Location`);
      if (redirects >= maxRedirects) throw new Error(`重定向超过 ${maxRedirects} 次`);
      redirects += 1;
      const next = new URL(location, current);
      if (next.protocol !== 'http:' && next.protocol !== 'https:') {
        throw new Error('重定向到了非 http/https 地址');
      }
      if (response.status === 303) {
        body = undefined;
      }
      current = next;
      continue;
    }

    const read = await readCapped(response, maxBytes);
    return {
      url: current.toString(),
      status: response.status,
      headers: headerRecord(response.headers),
      body: read.body,
      bytes: read.bytes,
      redirected: redirects,
    };
  }
}
