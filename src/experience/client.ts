/**
 * 团队经验的读取端口：搜索、按需读取、引用、投稿候选。
 *
 * 平台不可用时只降级到本地缓存，并明确标注缓存时间；没有缓存就说没有，
 * 绝不凭空生成“团队经验”。agent 永远不能发布、修订或撤销。
 */

import type {
  KnowledgeCandidate,
  KnowledgeCandidateInput,
  KnowledgeEvidence,
} from '../client.ts';
import type { ToolBackend } from '../runtime/transport.ts';
import { nowIso } from '../store/sqlite.ts';
import { redact, truncateChars } from '../memory/text.ts';
import { KnowledgeCache, type CachedKnowledge } from './cache.ts';

export type ExperienceHit = {
  id: string;
  version: number;
  reference: string;
  title: string;
  summary: string;
  content: string;
  conditions: string;
  kind: string;
  evidence: string;
  state: string;
  sourceTaskId: string | null;
  reviewerId: string | null;
  expiresAt: string | null;
  accessMode: string;
  tags: string[];
  score: number;
  stale: boolean;
  cachedAt: string | null;
};

export type ExperienceSearchResult = {
  items: ExperienceHit[];
  degraded: boolean;
  note: string;
  fetchedAt: string;
};

export type ExperienceInjected = {
  id: string;
  version: number;
  reference: string;
  title: string;
  chars: number;
  score: number;
  stale: boolean;
};

export type ExperiencePrompt = {
  text: string;
  entries: ExperienceInjected[];
  chars: number;
  degraded: boolean;
  note: string;
};

export type ExperienceClientOptions = {
  now?: () => number;
  /** 注入内容的单条上限与整段预算。 */
  itemBudget?: number;
};

const FULL_KINDS = new Set(['experience', 'checklist', 'decision']);
const SUMMARY_KINDS = new Set(['playbook']);
const ON_DEMAND_KINDS = new Set(['report', 'handoff', 'document']);

export class ExperienceClient {
  readonly cache: KnowledgeCache;
  private readonly backend: ToolBackend | undefined;
  private readonly now: () => number;
  private readonly itemBudget: number;

  constructor(
    backend: ToolBackend | undefined,
    cache: KnowledgeCache,
    options: ExperienceClientOptions = {},
  ) {
    this.backend = backend;
    this.cache = cache;
    this.now = options.now ?? Date.now;
    this.itemBudget = options.itemBudget ?? 500;
  }

  async search(
    query: string,
    options: { limit?: number; budget?: number } = {},
  ): Promise<ExperienceSearchResult> {
    const limit = Math.max(1, Math.min(20, options.limit ?? 8));
    const fetchedAt = nowIso(this.now);
    if (this.backend?.searchKnowledge) {
      try {
        const result = await this.backend.searchKnowledge(query, limit, options.budget ?? 4000);
        const items: ExperienceHit[] = [];
        for (const raw of result.items) {
          const id = stringOf(raw.id);
          const version = typeof raw.version === 'number' ? raw.version : Number(raw.version ?? 0);
          if (!id || !Number.isFinite(version) || version <= 0) continue;
          const state = stringOf(raw.state) || 'published';
          if (state !== 'published') continue;
          const title = stringOf(raw.title) || truncateChars(stringOf(raw.summary), 80) || id;
          const summary = stringOf(raw.summary) || truncateChars(stringOf(raw.content), 300);
          const content = stringOf(raw.content) || summary;
          const conditions = stringOf(raw.conditions);
          const expiresAt = nullableString(raw.expiresAt);
          const cached = this.cache.put({
            id,
            version,
            title,
            summary,
            content,
            conditions,
            kind: stringOf(raw.kind) || 'experience',
            evidence: stringOf(raw.evidenceLevel) || 'published',
            sourceTaskId: nullableString(raw.sourceTaskId),
            reviewerId: nullableString(raw.reviewerId),
            expiresAt,
            accessMode: stringOf(raw.accessMode) || 'restricted',
            tags: stringArray(raw.tags),
            state,
          });
          if (!cached) continue;
          items.push(hitOf(cached, {
            reference: stringOf(raw.reference) || referenceOf(id, version),
            score: typeof raw.score === 'number' ? raw.score : 0,
            stale: false,
            cachedAt: null,
            conditions: conditions || cached.conditions,
          }));
        }
        return {
          items,
          degraded: false,
          note: result.note ?? '',
          fetchedAt,
        };
      } catch (error) {
        const note = `平台不可用（${errorText(error)}），使用本地缓存`;
        return { ...this.searchLocal(query, limit), degraded: true, note, fetchedAt };
      }
    }
    return {
      ...this.searchLocal(query, limit),
      degraded: true,
      note: '当前运行环境没有平台连接，使用本地缓存',
      fetchedAt,
    };
  }

  private searchLocal(query: string, limit: number): { items: ExperienceHit[] } {
    const rows = this.cache.searchLocal(query, limit);
    return {
      items: rows.map(row => hitOf(row, {
        reference: referenceOf(row.knowledge_id, row.version),
        score: 0,
        stale: this.cache.isStale(row),
        cachedAt: row.checked_at,
      })),
    };
  }

  async get(id: string, version?: number): Promise<ExperienceHit | null> {
    if (this.backend?.knowledgeEvidence) {
      try {
        const evidence = await this.backend.knowledgeEvidence(id);
        const state =
          evidence.currentState ??
          (stringOf((evidence as unknown as Record<string, unknown>).state) || 'published');
        if (state !== 'published') {
          this.cache.markState(id, state);
          return null;
        }
        const resolvedVersion =
          typeof evidence.version === 'number' && evidence.version > 0
            ? evidence.version
            : (version ?? evidence.currentVersion ?? 1);
        const cached = this.cache.put({
          id,
          version: resolvedVersion,
          title: evidence.title,
          summary: evidence.summary,
          content: evidence.content,
          conditions: evidence.conditions,
          kind: evidence.kind,
          evidence: evidence.evidenceLevel ?? 'published',
          sourceTaskId: evidence.sourceTaskId,
          reviewerId: evidence.reviewerId,
          expiresAt: evidence.expiresAt,
          accessMode: evidence.accessMode,
          tags: evidence.tags,
          state,
        });
        if (!cached) return null;
        return hitOf(cached, {
          reference: evidence.reference ?? referenceOf(id, resolvedVersion),
          score: 0,
          stale: false,
          cachedAt: null,
        });
      } catch {
        // 落到缓存；缓存也没有时由调用方明确告知。
      }
    }
    const row = this.cache.get(id, version);
    if (!row) return null;
    return hitOf(row, {
      reference: referenceOf(id, row.version),
      score: 0,
      stale: this.cache.isStale(row),
      cachedAt: row.checked_at,
    });
  }

  /**
   * 先记本地引用，再尝试平台确认。平台调用结果未知时不重试、不猜测。
   */
  async cite(input: {
    knowledgeId: string;
    version: number;
    sessionId: string;
    turnId: string;
    taskId?: string | null;
  }): Promise<{ reference: string; cited: boolean; error?: string }> {
    this.cache.recordRef(input);
    const reference = referenceOf(input.knowledgeId, input.version);
    if (!input.taskId) {
      return { reference, cited: false, error: '没有 taskId，只记录了本地引用' };
    }
    if (!this.backend?.referenceKnowledge) {
      return { reference, cited: false, error: '当前运行环境没有平台引用接口' };
    }
    try {
      const result = await this.backend.referenceKnowledge(input.taskId, input.knowledgeId, `cite:${input.sessionId}:${input.turnId}:${input.knowledgeId}`);
      return { reference: referenceOf(result.id, result.version), cited: true };
    } catch (error) {
      return { reference, cited: false, error: errorText(error) };
    }
  }

  /** 只能生成 candidate；失败不自动重试。 */
  async contribute(input: {
    taskId?: string | null;
    knowledge: KnowledgeCandidateInput;
  }): Promise<{ ok: boolean; candidate?: KnowledgeCandidate; error?: string; forbidden?: boolean }> {
    if (!input.taskId) {
      return { ok: false, error: '投稿团队经验需要 taskId（只能在任务上下文中生成候选）' };
    }
    if (!this.backend?.createKnowledgeCandidate) {
      return { ok: false, error: '当前运行环境没有平台连接，无法提交团队经验候选' };
    }
    try {
      const candidate = await this.backend.createKnowledgeCandidate(
        input.taskId,
        input.knowledge,
        `candidate:${input.taskId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      );
      return { ok: true, candidate };
    } catch (error) {
      const message = errorText(error);
      return {
        ok: false,
        error: message,
        ...(/HTTP\s*403|forbidden|not\s+allowed/i.test(message) ? { forbidden: true } : {}),
      };
    }
  }

  /**
   * 模型调用前的团队经验段。experience / checklist / decision 注入正文，
   * playbook 只注入摘要，report / handoff / document 只在显式读取时出现。
   */
  async promptBlock(
    query: string,
    options: { budget?: number; limit?: number } = {},
  ): Promise<ExperiencePrompt> {
    const budget = options.budget ?? 1000;
    const empty = { text: '', entries: [], chars: 0, degraded: false, note: '' };
    if (!query.trim()) return empty;

    const result = await this.search(query, { limit: options.limit ?? 6 });
    const lines: string[] = [];
    const entries: ExperienceInjected[] = [];
    let used = 0;

    for (const item of result.items) {
      const kind = item.kind.toLowerCase();
      if (ON_DEMAND_KINDS.has(kind)) continue;
      const body = SUMMARY_KINDS.has(kind) || !FULL_KINDS.has(kind)
        ? truncateChars(item.summary || item.content, this.itemBudget)
        : truncateChars(item.content || item.summary, this.itemBudget);
      const header =
        `- [${item.evidence}/${item.state}] ${item.reference} ${truncateChars(redact(item.title), 100)}`
        + (item.stale ? `（缓存于 ${item.cachedAt ?? '未知时间'}，可能已过期）` : '');
      const meta: string[] = [];
      if (item.conditions.trim()) meta.push(`适用条件：${truncateChars(redact(item.conditions), 180)}`);
      if (item.expiresAt) meta.push(`有效期至：${item.expiresAt}`);
      if (item.reviewerId) meta.push(`审核人：${item.reviewerId}`);
      const rendered = [
        header,
        ...(meta.length > 0 ? [`  ${meta.join('；')}`] : []),
        `  ${SUMMARY_KINDS.has(kind) || !FULL_KINDS.has(kind) ? '摘要' : '内容'}：${redact(body)}`,
      ].join('\n');
      const length = [...rendered].length + 1;
      if (used + length > budget) continue;
      lines.push(rendered);
      used += length;
      entries.push({
        id: item.id,
        version: item.version,
        reference: item.reference,
        title: item.title,
        chars: length,
        score: item.score,
        stale: item.stale,
      });
    }

    if (lines.length === 0) {
      if (result.degraded) {
        return {
          text: [
            '# 团队经验',
            `当前没有可用的团队经验（${result.note || '平台不可用且无本地缓存'}）；不要编造团队经验。`,
          ].join('\n'),
          entries: [],
          chars: 0,
          degraded: true,
          note: result.note,
        };
      }
      return { ...empty, note: result.note };
    }

    const header = ['# 团队经验（平台已发布；引用时带上 reference）'];
    if (result.degraded) header.push(`> ${result.note}`);
    const text = [...header, ...lines].join('\n');
    return {
      text,
      entries,
      chars: [...text].length,
      degraded: result.degraded,
      note: result.note,
    };
  }

  stats(): { entries: number; bytes: number; oldestCheckedAt: string | null } {
    return this.cache.stats();
  }
}

export function referenceOf(id: string, version: number): string {
  return `knowledge:${id}:${version}`;
}

function hitOf(
  row: CachedKnowledge,
  extra: { reference: string; score: number; stale: boolean; cachedAt: string | null; conditions?: string },
): ExperienceHit {
  return {
    id: row.knowledge_id,
    version: row.version,
    reference: extra.reference,
    title: row.title,
    summary: row.summary,
    content: row.content,
    conditions: extra.conditions ?? row.conditions,
    kind: row.kind,
    evidence: row.evidence,
    state: row.state,
    sourceTaskId: row.source_task_id,
    reviewerId: row.reviewer_id,
    expiresAt: row.expires_at,
    accessMode: row.access_mode,
    tags: row.tags,
    score: extra.score,
    stale: extra.stale,
    cachedAt: extra.cachedAt,
  };
}

function referenceParts(reference: string): { id: string; version: number } | null {
  const match = /^knowledge:([^:]+):(\d+)$/.exec(reference.trim());
  if (!match) return null;
  return { id: match[1]!, version: Number(match[2]) };
}

export function parseKnowledgeReference(
  input: { id?: string; version?: number; reference?: string },
): { id: string; version: number } | null {
  if (input.reference) {
    const parsed = referenceParts(input.reference);
    if (parsed) return parsed;
  }
  if (input.id) {
    return { id: input.id, version: input.version ?? 1 };
  }
  return null;
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type { KnowledgeEvidence, CachedKnowledge };
