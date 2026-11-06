/**
 * 记忆与检索共用的文本工具：中英分词、字符截断、密钥识别与置信度计算。
 */

import { createHash } from 'node:crypto';
import type { MemoryMaturity } from './store.ts';

export const MAX_MEMORY_CONTENT = 8000;
export const MAX_INJECTED_MEMORY = 600;

const ENGLISH_STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'to', 'and', 'in', 'is', 'are', 'was', 'were', 'for', 'on',
  'with', 'this', 'that', 'it', 'be', 'as', 'at', 'or', 'by', 'from', 'we', 'you',
  'i', 'me', 'my', 'our', 'your', '其', '的', '了', '和', '是',
]);

/** 英文按词、中文按两字滑窗；两字滑窗足够覆盖大部分中文术语，又不至于爆量。 */
export function tokenize(text: string): string[] {
  const seen = new Set<string>();
  const lower = text.toLowerCase();
  for (const match of lower.match(/[a-z0-9][a-z0-9._-]*/g) ?? []) {
    if (match.length < 2 || ENGLISH_STOPWORDS.has(match)) continue;
    seen.add(match);
  }
  for (const run of lower.match(/[㐀-鿿]+/g) ?? []) {
    if (run.length === 1) {
      seen.add(run);
      continue;
    }
    for (let index = 0; index + 1 < run.length; index += 1) {
      const pair = run.slice(index, index + 2);
      if (!ENGLISH_STOPWORDS.has(pair)) seen.add(pair);
    }
  }
  return [...seen].slice(0, 400);
}

/** 0..1 的词面匹配；查询词被覆盖得越多分越高，长词命中额外加权。 */
export function lexicalScore(query: string, text: string): number {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0 || !text) return 0;
  const textTokens = new Set(tokenize(text));
  let matched = 0;
  let weight = 0;
  let totalWeight = 0;
  for (const token of queryTokens) {
    const tokenWeight = Math.min(3, Math.max(1, token.length / 2));
    totalWeight += tokenWeight;
    if (textTokens.has(token)) {
      matched += 1;
      weight += tokenWeight;
    }
  }
  if (matched === 0) return 0;
  const coverage = weight / totalWeight;
  const density = matched / queryTokens.length;
  return Math.min(1, coverage * 0.75 + density * 0.25);
}

/** 按 Unicode 码点截断，避免把 emoji 或中文截成半个。 */
export function truncateChars(text: string, max: number): string {
  if (max <= 0) return '';
  const chars = [...text];
  if (chars.length <= max) return text;
  return `${chars.slice(0, Math.max(0, max - 1)).join('')}…`;
}

export function charLength(text: string): number {
  return [...text].length;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function normalizeKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[-.]+$/, '')
    .slice(0, 64);
}

export const KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function isValidKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}

const SECRET_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'openai-key', pattern: /\bsk-[A-Za-z0-9_-]{12,}/ },
  { label: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}/ },
  { label: 'aws-key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: 'private-key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: 'bearer', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i },
  { label: 'long-hex', pattern: /\b[0-9a-f]{32,}\b/i },
];

export function detectSecret(text: string): string | null {
  for (const { label, pattern } of SECRET_PATTERNS) {
    if (pattern.test(text)) return label;
  }
  return null;
}

export function redact(text: string): string {
  let result = text;
  for (const { pattern } of SECRET_PATTERNS) {
    result = result.replace(pattern, '[redacted]');
  }
  return result;
}

/** 事件与工具结果落盘前统一脱敏；数组/对象递归处理。 */
export function redactValue<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as T;
  if (Array.isArray(value)) return value.map(item => redactValue(item)) as T;
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      output[key] = redactValue(item);
    }
    return output as T;
  }
  return value;
}

export function baseConfidence(maturity: MemoryMaturity): number {
  switch (maturity) {
    case 'observed':
      return 0.4;
    case 'corroborated':
      return 0.6;
    case 'task_verified':
      return 0.8;
    case 'published':
      return 0.95;
  }
}

export function evidenceLevel(maturity: MemoryMaturity): string {
  switch (maturity) {
    case 'observed':
      return 'E1';
    case 'corroborated':
      return 'E2';
    case 'task_verified':
      return 'E3';
    case 'published':
      return 'E4';
  }
}

export function maturityScore(maturity: MemoryMaturity): number {
  return baseConfidence(maturity);
}

export function recencyFactor(at: string | null | undefined, now = Date.now()): number {
  if (!at) return 0.5;
  const time = Date.parse(at);
  if (!Number.isFinite(time)) return 0.5;
  const days = Math.max(0, (now - time) / 86_400_000);
  if (days <= 30) return 1;
  if (days <= 90) return 0.85;
  if (days <= 365) return 0.7;
  return 0.5;
}

/** 置信度只用于排序和展示，不参与证据分级。 */
export function confidenceOf(input: {
  maturity: MemoryMaturity;
  lastUsedAt?: string | null;
  updatedAt?: string | null;
  successCount?: number;
  contradictionCount?: number;
  now?: number;
}): number {
  const base = baseConfidence(input.maturity);
  const recency = recencyFactor(input.lastUsedAt ?? input.updatedAt ?? null, input.now ?? Date.now());
  const usage = Math.min(0.15, 0.03 * Math.max(0, input.successCount ?? 0));
  const penalty = 0.2 * Math.max(0, input.contradictionCount ?? 0);
  return Math.max(0.05, Math.round((base * recency + usage - penalty) * 1000) / 1000);
}

export function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
