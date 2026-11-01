#!/usr/bin/env node
/**
 * `npm run router -- --config examples/anp/router.local.json`
 */

import { pathToFileURL } from 'node:url';
import { loadRouterConfig } from './config.ts';
import { RouterRuntime } from './router.ts';

export async function main(argv = process.argv.slice(2)): Promise<RouterRuntime> {
  const config = await loadRouterConfig({ argv });
  const runtime = await RouterRuntime.start({ config });
  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`收到 ${signal}，正在停止 router…`);
    void runtime.close().then(
      () => process.exit(0),
      error => {
        console.error(error);
        process.exit(1);
      },
    );
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  return runtime;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`router 启动失败：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
