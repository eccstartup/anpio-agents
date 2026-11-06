/**
 * 会话结束后的记忆整理。
 *
 * 模型只负责提出 add / update / supersede / archive；写不写、能不能写由这里
 * 的确定性校验决定。任何一条校验失败就整批放弃；不覆盖 24 小时内的人工修改。
 */

import type { Brain } from '../brains/types.ts';
import type { ExperienceClient } from '../experience/client.ts';
import { nowIso } from '../store/sqlite.ts';
import { truncateChars, isValidKey, normalizeKey } from './text.ts';
import type { Memory, MemoryKind, MemoryMaturity, MemoryStore } from './store.ts';
import { MEMORY_KINDS, MEMORY_MATURITIES } from './store.ts';
import type { SessionEventLog } from '../session/events.ts';
import type { SessionIndex } from '../session/index.ts';

export type ConsolidationChange =
  | { op: 'add'; key: string; content: string; kind?: MemoryKind; tags?: string[] }
  | { op: 'update'; key: string; content?: string; kind?: MemoryKind; tags?: string[]; reason?: string }
  | { op: 'supersede'; key: string; by: string }
  | { op: 'archive'; key: string; reason?: string };

export type ConsolidateOptions = {
  memory: MemoryStore;
  events: SessionEventLog;
  index: SessionIndex;
  agentId: string;
  sessionId: string;
  brain?: Brain;
  maxChanges?: number;
  now?: () => number;
};

export type ConsolidateResult = {
  applied: number;
  changes: ConsolidationChange[];
  skipped: string[];
  summary: string;
};

const MAX_BATCH = 5;
const MAX_CONTENT = 2000;
const MAX_INDEX_CHARS = 12_000;
const HUMAN_GRACE_MS = 24 * 60 * 60 * 1000;

export async function consolidateSession(options: ConsolidateOptions): Promise<ConsolidateResult> {
  const { memory, events, index, agentId, sessionId } = options;
  const maxChanges = Math.max(1, Math.min(MAX_BATCH, options.maxChanges ?? MAX_BATCH));
  if (!options.brain) return { applied: 0, changes: [], skipped: ['没有可用的模型'], summary: '' };

  const eventSeq = events.lastSeq(sessionId);
  const session = index.get(sessionId);
  const summaries = events.turnSummaries(sessionId, 50);
  const writes = events
    .read(sessionId, { kinds: ['memory.written', 'knowledge.cited'], limit: 200 })
    .map(event => ({ kind: event.kind, payload: event.payload, seq: event.seq }));
  const rows = memory.rowsForConsolidation(agentId, 80);

  const indexText = truncateChars(
    rows.map(row => `${row.key} [${row.kind}/${row.maturity}] ${truncateChars(row.content, 160)}`).join('\n'),
    MAX_INDEX_CHARS,
  );
  const input = {
    session: {
      id: sessionId,
      title: session?.title ?? null,
      lastSummary: session?.last_summary ?? null,
      turnCount: session?.turn_count ?? summaries.length,
    },
    turns: summaries.map(item => item.summary),
    writes: writes.map(item => ({ kind: item.kind, seq: item.seq, ...item.payload })),
    memoryIndex: indexText,
  };

  const response = await options.brain.complete({
    system: [
      '你是 agent 的长期记忆整理器。',
      '只输出一个 JSON 对象，不要 Markdown 代码块，也不要解释。',
      '格式：{"summary":"本会话的一句话总结","changes":[',
      '{"op":"add","key":"kebab-case","content":"...","kind":"fact|preference|decision|procedure|episode","tags":["..."]},',
      '{"op":"update","key":"已有 key","content":"可选","reason":"为什么改"},',
      '{"op":"supersede","key":"旧 key","by":"新 key"},',
      '{"op":"archive","key":"已有 key","reason":"为什么归档"}]}',
      `最多 ${maxChanges} 条变更；只整理可复用的判断，不抄录聊天记录。`,
      '没有来源依据的判断不要写；不要写密钥、密码、令牌。',
    ].join('\n'),
    messages: [{ role: 'user', content: JSON.stringify(input) }],
    tools: [],
    maxTokens: 1200,
  });

  const parsed = parseConsolidation(response.text ?? '');
  if (!parsed) {
    return { applied: 0, changes: [], skipped: ['模型输出不是合法 JSON'], summary: '' };
  }

  const changes = parsed.changes.slice(0, maxChanges);
  const { valid, skipped } = validateChanges(changes, {
    memory,
    agentId,
    now: (options.now ?? Date.now)(),
    maxChanges,
  });
  if (skipped.length > 0) {
    return { applied: 0, changes: [], skipped, summary: parsed.summary };
  }

  let applied = 0;
  for (const change of valid) {
    try {
      applyChange(change, {
        memory,
        agentId,
        sessionId,
        eventSeq,
      });
      applied += 1;
      events.tryAppend({
        sessionId,
        kind: 'memory.written',
        payload: { op: change.op, key: change.op === 'supersede' ? change.key : change.key, sourceEventSeq: eventSeq },
      });
    } catch (error) {
      skipped.push(`${change.op} ${change.key}：${errorText(error)}`);
    }
  }

  return { applied, changes: valid, skipped, summary: parsed.summary };
}

function applyChange(
  change: ConsolidationChange,
  context: { memory: MemoryStore; agentId: string; sessionId: string; eventSeq: number },
): void {
  const { memory, agentId, sessionId, eventSeq } = context;
  switch (change.op) {
    case 'add': {
      memory.write({
        agentId,
        key: change.key,
        content: change.content,
        kind: change.kind ?? 'fact',
        tags: change.tags,
        maturity: 'observed',
        actor: 'consolidation',
        sourceSessionId: sessionId,
        sourceEventSeq: eventSeq,
        reason: '会话结束整理',
      });
      return;
    }
    case 'update': {
      const existing = memory.getByKey(agentId, change.key);
      if (!existing) throw new Error('记忆不存在');
      memory.write({
        agentId,
        key: change.key,
        content: change.content ?? existing.content,
        kind: change.kind ?? existing.kind,
        tags: change.tags ?? existing.tags,
        maturity: existing.maturity,
        conditions: existing.conditions,
        scope: existing.scope,
        sourceSessionId: sessionId,
        sourceEventSeq: eventSeq,
        pinned: existing.pinned,
        actor: 'consolidation',
        reason: change.reason ?? '会话结束整理',
      });
      return;
    }
    case 'supersede': {
      if (!memory.supersede(agentId, change.key, change.by)) {
        throw new Error('旧记忆或新记忆不存在');
      }
      return;
    }
    case 'archive': {
      if (!memory.archive(agentId, change.key, change.reason ?? '会话结束整理', 'consolidation')) {
        throw new Error('记忆不存在');
      }
      return;
    }
  }
}

function validateChanges(
  changes: ConsolidationChange[],
  context: { memory: MemoryStore; agentId: string; now: number; maxChanges: number },
): { valid: ConsolidationChange[]; skipped: string[] } {
  const skipped: string[] = [];
  if (changes.length > context.maxChanges) {
    return { valid: [], skipped: [`变更超过 ${context.maxChanges} 条`] };
  }
  const seen = new Set<string>();
  const valid: ConsolidationChange[] = [];

  for (const change of changes) {
    if (!change || typeof change !== 'object' || typeof change.op !== 'string') {
      skipped.push('变更格式不合法');
      continue;
    }
    const rawKey = (change as { key?: unknown }).key;
    if (typeof rawKey !== 'string') {
      skipped.push(`${change.op} 缺少 key`);
      continue;
    }
    const key = normalizeKey(rawKey);
    if (!isValidKey(key)) {
      skipped.push(`key 不合法：${rawKey}`);
      continue;
    }
    if (seen.has(key)) {
      skipped.push(`同一批里重复的 key：${key}`);
      continue;
    }
    seen.add(key);

    switch (change.op) {
      case 'add': {
        if (!nonEmpty(change.content)) {
          skipped.push(`add ${key} 缺少内容`);
          break;
        }
        if (change.content.length > MAX_CONTENT) {
          skipped.push(`add ${key} 内容过长`);
          break;
        }
        if (change.kind && !MEMORY_KINDS.includes(change.kind)) {
          skipped.push(`add ${key} 类型不合法`);
          break;
        }
        valid.push({ op: 'add', key, content: change.content.trim(), ...(change.kind ? { kind: change.kind } : {}), ...(change.tags ? { tags: change.tags } : {}) });
        break;
      }
      case 'update': {
        const existing = context.memory.getByKey(context.agentId, key);
        if (!existing) {
          skipped.push(`update ${key} 记忆不存在`);
          break;
        }
        if (existing.pinned) {
          skipped.push(`update ${key} 是置顶记忆，不自动修改`);
          break;
        }
        if (humanEditedWithin(existing, context, context.memory)) {
          skipped.push(`update ${key} 24 小时有人工修改`);
          break;
        }
        if (change.content !== undefined && (!nonEmpty(change.content) || change.content.length > MAX_CONTENT)) {
          skipped.push(`update ${key} 内容不合法`);
          break;
        }
        if (change.kind && !MEMORY_KINDS.includes(change.kind)) {
          skipped.push(`update ${key} 类型不合法`);
          break;
        }
        valid.push({
          op: 'update',
          key,
          ...(change.content !== undefined ? { content: change.content.trim() } : {}),
          ...(change.kind ? { kind: change.kind } : {}),
          ...(change.tags ? { tags: change.tags } : {}),
          ...(change.reason ? { reason: change.reason } : {}),
        });
        break;
      }
      case 'supersede': {
        const by = typeof (change as { by?: unknown }).by === 'string'
          ? normalizeKey((change as { by: string }).by)
          : '';
        const existing = context.memory.getByKey(context.agentId, key);
        if (!existing || !isValidKey(by) || !context.memory.getByKey(context.agentId, by)) {
          skipped.push(`supersede ${key} 缺少有效的新 key`);
          break;
        }
        if (existing.pinned) {
          skipped.push(`supersede ${key} 是置顶记忆`);
          break;
        }
        valid.push({ op: 'supersede', key, by });
        break;
      }
      case 'archive': {
        const existing = context.memory.getByKey(context.agentId, key);
        if (!existing) {
          skipped.push(`archive ${key} 记忆不存在`);
          break;
        }
        if (existing.pinned) {
          skipped.push(`archive ${key} 是置顶记忆，不自动归档`);
          break;
        }
        if (humanEditedWithin(existing, context, context.memory)) {
          skipped.push(`archive ${key} 24 小时有人工修改`);
          break;
        }
        valid.push({ op: 'archive', key, ...(change.reason ? { reason: change.reason } : {}) });
        break;
      }
      default:
        skipped.push(`未知操作：${String((change as { op?: unknown }).op)}`);
    }
  }

  return skipped.length > 0 ? { valid: [], skipped } : { valid, skipped: [] };
}

/** 反思只能调整状态，不新增事实。 */
export function reflect(options: {
  memory: MemoryStore;
  agentId: string;
  now?: number;
  publishedKnowledgeIds?: string[];
}): {
  promoted: string[];
  stale: string[];
  needsReview: string[];
  coveredByKnowledge: string[];
} {
  const { memory, agentId } = options;
  const now = options.now ?? Date.now();
  const promoted: string[] = [];
  for (const memoryRow of memory.list(agentId, { limit: 500 })) {
    if (memoryRow.maturity !== 'observed') continue;
    if (memory.promoteFromCitations(memoryRow.id, now)) promoted.push(memoryRow.key);
  }

  const stale = memory.stale(agentId, 365, now).map(item => item.key);
  const needsReview = memory
    .list(agentId, { limit: 500 })
    .filter(item => item.state === 'needs_review')
    .map(item => item.key);

  const coveredByKnowledge: string[] = [];
  const published = new Set(options.publishedKnowledgeIds ?? []);
  if (published.size > 0) {
    for (const item of memory.list(agentId, { limit: 500 })) {
      if (item.source_knowledge_id && published.has(item.source_knowledge_id)) {
        if (memory.markNeedsReview(agentId, item.key, '被已发布团队经验覆盖')) {
          coveredByKnowledge.push(item.key);
        }
      }
    }
  }

  return { promoted, stale, needsReview, coveredByKnowledge };
}

/**
 * 投稿候选：只有任务已完成（或子任务已提交/验收）且内容可复用时才调用；
 * 永远只创建 candidate，不发布。失败写一条 knowledge.candidate_failed。
 */
export async function proposeKnowledgeCandidate(options: {
  experience: ExperienceClient;
  taskId?: string | null;
  taskVerified: boolean;
  title: string;
  summary: string;
  content: string;
  conditions?: string;
  kind?: string;
  tags?: string[];
  events?: SessionEventLog;
  sessionId?: string;
  turnId?: string;
}): Promise<{ ok: boolean; candidateId?: string; state?: string; skipped?: string; error?: string }> {
  if (!options.taskId) return { ok: false, skipped: '没有 taskId' };
  if (!options.taskVerified) return { ok: false, skipped: '任务尚未完成/验收' };
  if (!options.content.trim()) return { ok: false, skipped: '没有可投稿的内容' };

  const result = await options.experience.contribute({
    taskId: options.taskId,
    knowledge: {
      title: options.title,
      summary: options.summary,
      content: options.content,
      ...(options.conditions ? { conditions: options.conditions } : {}),
      ...(options.kind ? { kind: options.kind } : {}),
      ...(options.tags && options.tags.length > 0 ? { tags: options.tags } : {}),
    },
  });

  if (!result.ok) {
    if (options.events && options.sessionId) {
      options.events.tryAppend({
        sessionId: options.sessionId,
        turnId: options.turnId ?? null,
        kind: 'knowledge.candidate_failed',
        payload: { taskId: options.taskId, error: result.error ?? 'unknown', forbidden: result.forbidden === true },
      });
    }
    return { ok: false, error: result.error };
  }

  return {
    ok: true,
    candidateId: result.candidate?.id,
    state: String(result.candidate?.state ?? 'candidate'),
  };
}

function parseConsolidation(text: string): { summary: string; changes: ConsolidationChange[] } | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as { summary?: unknown; changes?: unknown };
    if (!Array.isArray(record.changes)) return null;
    return {
      summary: typeof record.summary === 'string' ? record.summary : '',
      changes: record.changes.filter(isChange),
    };
  } catch {
    return null;
  }
}

function isChange(value: unknown): value is ConsolidationChange {
  return Boolean(value) && typeof value === 'object' && typeof (value as { op?: unknown }).op === 'string';
}

function humanEditedWithin(
  memory: Memory,
  context: { now: number },
  store: MemoryStore,
): boolean {
  const last = store.lastHumanRevision(memory.id);
  if (!last) return false;
  const at = Date.parse(last);
  return Number.isFinite(at) && context.now - at < HUMAN_GRACE_MS;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type { MemoryMaturity };
