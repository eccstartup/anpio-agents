/**
 * 运行日志：只走平台接口，串行发送，进程退出前可等待队列清空。
 */

import type { CollabClient } from '../client.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type RunLog = (level: LogLevel, text: string) => void;

export type RunLogger = {
  log: RunLog;
  flush: () => Promise<void>;
};

export function createRunLog(client: CollabClient, runId: string): RunLogger {
  let chain: Promise<void> = Promise.resolve();
  // supervisor 会把子进程的 stderr 也转成运行日志；这里再写一遍会出现两条
  // 一模一样的记录，未捕获的崩溃仍会被 stderr 捕获。
  const log: RunLog = (level, text) => {
    const line = `[${new Date().toISOString()}] ${text}`.slice(0, 7_900);
    chain = chain
      .then(async () => {
        await client.request(`embedded/runs/${encodeURIComponent(runId)}/log`, {
          body: { level, text: line },
          operationId: `run-log:${runId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
        });
      })
      .catch(() => undefined);
  };
  // 进程结束前必须等队列清空，否则最后的收尾日志会丢（process.exit 不等待挂起的请求）。
  return { log, flush: () => chain };
}
