/**
 * 单实例锁：`<root>/router.lock`，内容是 pid + 启动时间。
 *
 * 进程已不存在时视为 stale；只有确认锁属于自己才删除，避免误删刚接手的新实例。
 */

import { readFile, unlink, writeFile } from 'node:fs/promises';

export type LockInfo = {
  pid: number;
  startedAt: string;
};

export class RouterLockError extends Error {
  override name = 'RouterLockError';
  readonly holder: LockInfo;

  constructor(message: string, holder: LockInfo) {
    super(message);
    this.holder = holder;
  }
}

export type RouterLock = {
  path: string;
  info: LockInfo;
  release: () => Promise<void>;
};

function isLockInfo(value: unknown): value is LockInfo {
  if (typeof value !== 'object' || value === null) return false;
  const info = value as Record<string, unknown>;
  return typeof info.pid === 'number' && Number.isInteger(info.pid) && info.pid > 0
    && typeof info.startedAt === 'string';
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function readLock(path: string): Promise<LockInfo | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    return isLockInfo(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function acquireLock(path: string, now: () => Date = () => new Date()): Promise<RouterLock> {
  const info: LockInfo = { pid: process.pid, startedAt: now().toISOString() };
  const content = `${JSON.stringify(info, null, 2)}\n`;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFile(path, content, { mode: 0o600, flag: 'wx' });
      return {
        path,
        info,
        async release() {
          const current = await readLock(path);
          if (current?.pid === info.pid && current.startedAt === info.startedAt) {
            await unlink(path).catch(() => undefined);
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const holder = await readLock(path);
      if (holder && alive(holder.pid)) {
        throw new RouterLockError(
          `已有 router 在运行（pid ${holder.pid}，启动于 ${holder.startedAt}）：${path}`,
          holder,
        );
      }
      // stale 锁：删掉后重试一次；仍失败就让调用方看到真实错误。
      await unlink(path).catch(() => undefined);
    }
  }
  throw new Error(`无法获取单实例锁：${path}`);
}
