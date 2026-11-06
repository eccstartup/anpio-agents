/**
 * node:sqlite 的最小封装：WAL、忙等待、事务与版本化迁移。
 *
 * 三份数据库（router / agent / ANP 服务）各自独立连接，不做跨库事务；
 * 需要跨库一致的写入一律按 message_id 幂等重放。
 */

import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type SqlValue = string | number | bigint | null | Uint8Array;

export type Migration = {
  version: number;
  statements: string[];
};

export class SqliteDb {
  readonly path: string;
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.path = path;
    if (path !== ':memory:') {
      mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(path);
    // busy_timeout 要先设：切 WAL 需要短暂的写锁，多进程同时首次打开会撞锁。
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA synchronous = NORMAL');
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  run(sql: string, ...params: SqlValue[]): { changes: number; lastInsertRowid: number } {
    const result = this.db.prepare(sql).run(...params);
    return {
      changes: Number(result.changes),
      lastInsertRowid: Number(result.lastInsertRowid),
    };
  }

  get<T>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  all<T>(sql: string, ...params: SqlValue[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  /** BEGIN IMMEDIATE：写事务一开始就拿写锁，避免读后升级时撞上 SQLITE_BUSY。 */
  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // 事务可能已被 SQLite 自己回滚。
      }
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}

export function migrate(db: SqliteDb, migrations: Migration[]): number {
  const current = Number((db.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? 0));
  let applied = current;
  for (const migration of [...migrations].sort((left, right) => left.version - right.version)) {
    if (migration.version <= applied) continue;
    db.tx(() => {
      for (const statement of migration.statements) db.exec(statement);
      db.exec(`PRAGMA user_version = ${migration.version}`);
    });
    applied = migration.version;
  }
  return applied;
}

export function nowIso(now: () => number = Date.now): string {
  return new Date(now()).toISOString();
}
