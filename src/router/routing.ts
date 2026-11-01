/**
 * 确定性路由：显式目标 → thread owner → 能力匹配 → 默认 agent。
 *
 * v1 不做模型路由；同分按 agentId 字典序，保证同样的输入总落在同一个 agent。
 */

export type RoutingCandidate = {
  agentId: string;
  did: string;
  capabilities: string[];
  description: string;
  enabled: boolean;
};

export type RouteInput = {
  /** DID 或 `agent:<id>`。 */
  to?: string | null;
  threadOwner?: string | null;
  /** 消息里声明的技能/需求标签。 */
  skills?: string[];
  defaultAgent?: string | null;
};

export type RouteReason = 'explicit' | 'thread' | 'capability' | 'default';

export type RouteDecision = {
  agentId: string;
  did: string;
  reason: RouteReason;
  score: number;
};

function explicitTarget(to: string | null | undefined): { kind: 'did' | 'agent'; value: string } | null {
  if (!to) return null;
  if (to.startsWith('did:')) return { kind: 'did', value: to };
  if (to.startsWith('agent:')) return { kind: 'agent', value: to.slice('agent:'.length) };
  return { kind: 'agent', value: to };
}

function normalized(tags: string[]): string[] {
  return tags.map(tag => tag.trim()).filter(tag => tag !== '');
}

function scoreCapabilities(candidate: RoutingCandidate, skills: string[]): number {
  const capabilities = normalized(candidate.capabilities);
  const description = candidate.description.toLowerCase();
  let total = 0;
  for (const skill of skills) {
    const lower = skill.toLowerCase();
    let best = 0;
    for (const capability of capabilities) {
      if (capability === skill) {
        best = Math.max(best, 3);
      } else if (capability.startsWith(skill) || skill.startsWith(capability)) {
        best = Math.max(best, 2);
      }
    }
    if (best === 0 && description.includes(lower)) best = 1;
    total += best;
  }
  return total;
}

export function routeMessage(
  candidates: RoutingCandidate[],
  input: RouteInput,
): RouteDecision | null {
  const enabled = candidates.filter(candidate => candidate.enabled);
  if (enabled.length === 0) return null;
  const byId = new Map(enabled.map(candidate => [candidate.agentId, candidate]));

  const explicit = explicitTarget(input.to);
  if (explicit) {
    const match = explicit.kind === 'did'
      ? enabled.find(candidate => candidate.did === explicit.value)
      : byId.get(explicit.value);
    if (match) return { agentId: match.agentId, did: match.did, reason: 'explicit', score: 0 };
  }

  if (input.threadOwner) {
    const owner = byId.get(input.threadOwner);
    if (owner) return { agentId: owner.agentId, did: owner.did, reason: 'thread', score: 0 };
  }

  const skills = normalized(input.skills ?? []);
  if (skills.length > 0) {
    const ranked = enabled
      .map(candidate => ({ candidate, score: scoreCapabilities(candidate, skills) }))
      .filter(item => item.score > 0)
      .sort((left, right) =>
        right.score - left.score || left.candidate.agentId.localeCompare(right.candidate.agentId));
    const best = ranked[0];
    if (best) {
      return { agentId: best.candidate.agentId, did: best.candidate.did, reason: 'capability', score: best.score };
    }
  }

  const fallback = input.defaultAgent ? byId.get(input.defaultAgent) : undefined;
  if (fallback) return { agentId: fallback.agentId, did: fallback.did, reason: 'default', score: 0 };
  return null;
}
