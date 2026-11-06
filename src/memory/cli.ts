/**
 * 本地记忆维护入口：`npm run memory -- <命令>`。
 *
 * 只读写本机 agent.db；不连接平台，也不会发布团队经验。
 */

import { join, resolve } from 'node:path';
import { SqliteDb } from '../store/sqlite.ts';
import { ensureMemorySchema } from '../store/memory-schema.ts';
import { MemoryStore, MEMORY_KINDS, type MemoryKind } from './store.ts';
import { reflect } from './consolidate.ts';
import { SessionIndex } from '../session/index.ts';
import { evidenceLevel, truncateChars } from './text.ts';

type Options = {
  agent: string;
  db: string;
  json: boolean;
  rest: string[];
  help: boolean;
};

const HELP = `用法：npm run memory -- [--agent <id>] [--db <路径>] [--root <目录>] <命令>

命令：
  list [--all] [--kind <类型>] [--limit <n>]      列出记忆
  search <query> [--limit <n>]                    按检索打分搜索
  get <key>                                       查看一条记忆与 revision
  correct <key> <content>                         人工纠正内容（保留证据等级）
  pin <key> / unpin <key>                         置顶 / 取消置顶
  forget <key> [--reason <文本>] [--force]        软删除（置顶需 --force）
  stats                                           数量、字节、证据分布
  sessions [--all] [--limit <n>]                  列出会话索引
  session-search <query>                          跨会话搜索摘要
  reflect                                         确定性反思（不新增事实）
  help                                            显示本帮助

默认 db：<root>/<agent>/agent.db；root 默认 $AGENT_RUN_ROOT 或 ./agent-runs。
`;

const COMMANDS = new Set([
  'list', 'search', 'get', 'correct', 'pin', 'unpin', 'forget', 'stats',
  'sessions', 'session-search', 'reflect', 'help',
]);

function parseArgs(argv: string[]): Options {
  const options: Options = {
    agent: process.env.AGENT_ID?.trim() || 'local',
    db: '',
    json: false,
    rest: [],
    help: false,
  };
  let root = process.env.AGENT_RUN_ROOT?.trim() || 'agent-runs';
  let dbArg = '';
  const rest: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (value === '--agent') {
      options.agent = argv[++index] ?? options.agent;
    } else if (value === '--db') {
      dbArg = argv[++index] ?? '';
    } else if (value === '--root') {
      root = argv[++index] ?? root;
    } else if (value === '--json') {
      options.json = true;
    } else if (value === '-h' || value === '--help') {
      options.help = true;
    } else {
      rest.push(value);
    }
  }
  options.rest = rest;
  options.db = dbArg || join(resolve(root), options.agent, 'agent.db');
  return options;
}

function flag(rest: string[], name: string): boolean {
  return rest.includes(name);
}

function value(rest: string[], name: string, fallback?: string): string | undefined {
  const index = rest.indexOf(name);
  if (index === -1) return fallback;
  return rest[index + 1] ?? fallback;
}

function positional(rest: string[]): string[] {
  const out: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index]!;
    if (item.startsWith('--')) {
      if (item !== '--all' && item !== '--force') index += 1;
      continue;
    }
    out.push(item);
  }
  return out;
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const command = options.rest[0] ?? '';
  if (!COMMANDS.has(command)) {
    process.stderr.write(`未知命令：${command || '(空)'}\n\n${HELP}`);
    return 2;
  }
  if (command === 'help') {
    process.stdout.write(HELP);
    return 0;
  }

  const args = positional(options.rest.slice(1));
  const db = new SqliteDb(options.db);
  ensureMemorySchema(db);
  const memory = new MemoryStore(db, { agentId: options.agent, migrateNotes: true });
  const index = new SessionIndex(db);

  try {
    switch (command) {
      case 'list': {
        const rawKind = value(options.rest, '--kind');
        const kind = rawKind && (MEMORY_KINDS as readonly string[]).includes(rawKind)
          ? (rawKind as MemoryKind)
          : undefined;
        const limit = Number(value(options.rest, '--limit', '50'));
        const rows = memory.list(options.agent, {
          includeArchived: flag(options.rest, '--all'),
          ...(kind ? { kind } : {}),
          limit: Number.isFinite(limit) ? limit : 50,
        });
        if (options.json) {
          process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
          break;
        }
        if (rows.length === 0) {
          process.stdout.write('没有记忆。\n');
          break;
        }
        for (const row of rows) {
          printMemory(row);
        }
        break;
      }
      case 'search': {
        const query = args.join(' ');
        if (!query) throw new Error('search 需要 query');
        const limit = Number(value(options.rest, '--limit', '10'));
        const hits = memory.search(options.agent, query, {
          limit: Number.isFinite(limit) ? limit : 10,
        });
        if (options.json) {
          process.stdout.write(`${JSON.stringify(hits, null, 2)}\n`);
          break;
        }
        if (hits.length === 0) process.stdout.write('没有匹配。\n');
        for (const hit of hits) {
          process.stdout.write(`${hit.score.toFixed(2)}  `);
          printMemory(hit.memory);
        }
        break;
      }
      case 'get': {
        const key = args[0];
        if (!key) throw new Error('get 需要 key');
        const row = memory.getByKey(options.agent, key, { includeArchived: true });
        if (!row) {
          process.stderr.write(`没有记忆 ${key}\n`);
          return 1;
        }
        printMemory(row);
        const revisions = memory.revisions(row.id, 10);
        if (revisions.length > 0) {
          process.stdout.write('\nrevisions:\n');
          for (const revision of revisions) {
            process.stdout.write(
              `  ${revision.created_at}  ${revision.actor}  ${revision.maturity}  ${revision.reason ?? ''}\n`,
            );
          }
        }
        break;
      }
      case 'correct': {
        const [key, ...contentParts] = args;
        if (!key || contentParts.length === 0) throw new Error('correct 需要 key 和内容');
        const result = memory.correct(options.agent, key, contentParts.join(' '));
        process.stdout.write(`已纠正 ${result.memory.key}（${result.memory.maturity}）\n`);
        break;
      }
      case 'pin':
      case 'unpin': {
        const key = args[0];
        if (!key) throw new Error(`${command} 需要 key`);
        const row = memory.setPinned(options.agent, key, command === 'pin');
        process.stdout.write(`${row.key} pinned=${row.pinned ? 'true' : 'false'}\n`);
        break;
      }
      case 'forget': {
        const key = args[0];
        if (!key) throw new Error('forget 需要 key');
        const existing = memory.getByKey(options.agent, key);
        if (!existing) {
          process.stderr.write(`没有记忆 ${key}\n`);
          return 1;
        }
        if (existing.pinned) {
          if (!flag(options.rest, '--force')) {
            process.stderr.write(`记忆 ${key} 已置顶；先 unpin，或加 --force。\n`);
            return 1;
          }
          memory.setPinned(options.agent, key, false);
        }
        memory.archive(options.agent, key, value(options.rest, '--reason', '人工遗忘'), 'human');
        process.stdout.write(`已归档 ${key}（revision 保留）\n`);
        break;
      }
      case 'stats': {
        const stats = memory.stats(options.agent);
        if (options.json) {
          process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
          break;
        }
        process.stdout.write(
          [
            `agent: ${options.agent}`,
            `记忆: ${stats.total}（活跃 ${stats.active}，归档 ${stats.archived}，待复核 ${stats.needsReview}，置顶 ${stats.pinned}）`,
            `体积: ${stats.bytes} 字节`,
            `证据: ${Object.entries(stats.byMaturity).map(([key, count]) => `${key}=${count}`).join(' ')}`,
            `类型: ${Object.entries(stats.byKind).map(([key, count]) => `${key}=${count}`).join(' ')}`,
            `引用次数: ${stats.citations}`,
            `最后写入: ${stats.lastWriteAt ?? '从未'}`,
          ].join('\n') + '\n',
        );
        break;
      }
      case 'sessions': {
        const limit = Number(value(options.rest, '--limit', '50'));
        const rows = index.list({
          limit: Number.isFinite(limit) ? limit : 50,
          includeArchived: flag(options.rest, '--all'),
        });
        if (rows.length === 0) {
          process.stdout.write('没有会话索引。\n');
          break;
        }
        for (const row of rows) {
          process.stdout.write(
            `${row.last_at}  ${row.kind}  ${row.session_id}  turns=${row.turn_count}  ${truncateChars(row.title ?? row.last_summary ?? '', 80)}\n`,
          );
        }
        break;
      }
      case 'session-search': {
        const query = args.join(' ');
        if (!query) throw new Error('session-search 需要 query');
        const hits = index.search(query, { limit: 10 });
        if (hits.length === 0) process.stdout.write('没有匹配的会话。\n');
        for (const hit of hits) {
          process.stdout.write(`${hit.score.toFixed(2)}  ${hit.sessionId}  ${hit.title ?? ''}\n`);
          for (const match of hit.matches) {
            process.stdout.write(`  ${truncateChars(match.summary, 160)}\n`);
          }
        }
        break;
      }
      case 'reflect': {
        const result = reflect({ memory, agentId: options.agent });
        process.stdout.write(
          [
            `升级 E1→E2: ${result.promoted.length > 0 ? result.promoted.join(', ') : '无'}`,
            `一年未使用: ${result.stale.length > 0 ? result.stale.join(', ') : '无'}`,
            `待复核: ${result.needsReview.length > 0 ? result.needsReview.join(', ') : '无'}`,
          ].join('\n') + '\n',
        );
        break;
      }
      default:
        break;
    }
  } finally {
    db.close();
  }
  return 0;
}

function printMemory(row: {
  key: string;
  kind: string;
  maturity: Parameters<typeof evidenceLevel>[0];
  content: string;
  pinned: boolean;
  state: string;
  use_count: number;
  success_count: number;
  archived_at: string | null;
  source_session_id: string | null;
}): void {
  const flags = [
    row.pinned ? '置顶' : '',
    row.state !== 'active' ? row.state : '',
    row.archived_at ? '已归档' : '',
  ].filter(Boolean);
  process.stdout.write(
    `${row.key} [${row.kind}/${evidenceLevel(row.maturity)}/${row.maturity}]`
    + `${flags.length > 0 ? ` (${flags.join(',')})` : ''}`
    + ` 用${row.use_count}/成${row.success_count}`
    + `${row.source_session_id ? ` ←${row.source_session_id}` : ''}\n`
    + `  ${truncateChars(row.content.replace(/\s+/g, ' '), 300)}\n`,
  );
}

process.stdout.on('error', () => process.exit(0));
try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(`memory 命令失败：${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
