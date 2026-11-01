/**
 * 本地传输层的最小持久化：原子 JSON 快照 + 跨进程文件锁。
 *
 * 没用数据库，是因为独立运行的规模很小；只要保证同一份状态不会在
 * 父子进程同时改写时互相覆盖即可。
 */

import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 10_000;

export async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, file);
}

export async function appendJsonLine(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await appendFile(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

/** 互斥锁：拿到锁的进程读-改-写；进程崩溃留下的锁超过 10 秒视为过期。 */
export async function withFileLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    let handle;
    try {
      await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
      handle = await open(lockPath, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const info = await stat(lockPath).catch(() => null);
      if (info && Date.now() - info.mtimeMs > LOCK_STALE_MS) {
        await rm(lockPath, { force: true }).catch(() => undefined);
        continue;
      }
      if (Date.now() > deadline) throw new Error('本地状态锁等待超时');
      await new Promise(resolve => setTimeout(resolve, 5 + Math.floor(Math.random() * 20)));
      continue;
    }
    try {
      await handle.writeFile(String(process.pid));
    } catch {
      // 锁文件内容只用于诊断。
    }
    try {
      return await fn();
    } finally {
      await handle.close().catch(() => undefined);
      await rm(lockPath, { force: true }).catch(() => undefined);
    }
  }
}
