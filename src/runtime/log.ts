/**
 * 运行日志：只走平台接口，串行发送，进程退出前可等待队列清空。
 */

import type { RunLedgerPort } from './transport.ts';
import type { LogLevel } from './types.ts';

export type { LogLevel };
export type RunLog = (level: LogLevel, text: string) => void;

export type RunLogger = {
  log: RunLog;
  flush: () => Promise<void>;
};

export function createRunLog(runs: RunLedgerPort, runId: string): RunLogger {
  let chain: Promise<void> = Promise.resolve();
  // supervisor 会把子进程的 stderr 也转成运行日志；这里再写一遍会出现两条
  // 一模一样的记录，未捕获的崩溃仍会被 stderr 捕获。
  const log: RunLog = (level, text) => {
    const line = `[${new Date().toISOString()}] ${text}`.slice(0, 7_900);
    chain = chain
      .then(async () => {
        await runs.log(runId, level, line);
      })
      .catch(() => undefined);
  };
  // 进程结束前必须等队列清空，否则最后的收尾日志会丢（process.exit 不等待挂起的请求）。
  return { log, flush: () => chain };
}
