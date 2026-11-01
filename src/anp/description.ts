/**
 * ANP-07 AgentDescription 与 ANP-08 发现索引。
 *
 * ADP 的 proof 在 ANP-07 里可选，v1 先发布未签名但字段完整的文档；
 * 发现索引只列启用 agent，分页由 URL query 控制。
 */

import type { AgentDescription } from '@anpio-cli/core';
import { agentDescriptionIndexUrl, buildAgentDescription, buildAgentDescriptionIndex } from '@anpio-cli/core';
import type { EmbeddedAgentDefinition } from '../definition.ts';
import { adpUrlOf } from './identity.ts';

export type PublicAgent = {
  agentId: string;
  did: string;
  definition: EmbeddedAgentDefinition;
  enabled: boolean;
  didBaseUrl: string;
};

export function agentDescriptionFor(agent: PublicAgent): AgentDescription {
  const url = adpUrlOf(agent.didBaseUrl, agent.agentId);
  const capabilities = agent.definition.capabilities ?? [];
  return buildAgentDescription({
    name: agent.definition.name,
    did: agent.did,
    url,
    description: agent.definition.description,
    interfaces: [
      {
        type: 'ANP',
        protocol: 'anp',
        version: '1.0.0',
        capabilities,
      },
    ],
    created: agent.definition.createdAt,
  });
}

export function discoveryPage(agents: PublicAgent[], origin: string, options: { limit?: number; cursor?: string } = {}) {
  const enabled = agents.filter(agent => agent.enabled).sort((left, right) => left.agentId.localeCompare(right.agentId));
  const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
  const offset = Math.max(0, Number.parseInt(options.cursor ?? '0', 10) || 0);
  const page = enabled.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  const base = agentDescriptionIndexUrl(origin.replace(/\/$/, ''));
  const next = nextOffset < enabled.length ? `${base}?cursor=${nextOffset}&limit=${limit}` : undefined;
  return {
    index: buildAgentDescriptionIndex({
      url: base,
      items: page.map(agent => ({ id: adpUrlOf(agent.didBaseUrl, agent.agentId), name: agent.definition.name })),
      ...(next ? { next } : {}),
    }),
    total: enabled.length,
    next,
  };
}
