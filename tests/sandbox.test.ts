/**
 * 沙箱原语：路径边界、环境清洗、超时与输出截断。
 *
 * 这些是"防误伤"的边界，不是内核隔离；测试只锁住已经承诺的行为。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createRunDir,
  listFilesInside,
  readFileInside,
  removeRunDir,
  resolveInside,
  runRoot,
  runShell,
  scrubbedEnv,
  writeFileInside,
} from '../src/sandbox.ts';

function withRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const previous = process.env.COLLAB_RUN_ROOT;
  const root = mkdtempSync(join(tmpdir(), 'collab-sandbox-'));
  process.env.COLLAB_RUN_ROOT = root;
  return fn(root).finally(() => {
    if (previous === undefined) delete process.env.COLLAB_RUN_ROOT;
    else process.env.COLLAB_RUN_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  });
}

test('沙箱：shell 在运行目录里执行，环境里没有平台令牌', { timeout: 20_000 }, async () => {
  await withRoot(async () => {
    const dir = await createRunDir('agent-a', 'run-1');
    process.env.COLLAB_TOKEN = 'should-not-leak';
    process.env.OPENAI_API_KEY = 'should-not-leak-either';
    try {
      const result = await runShell({
        command: 'pwd && printenv COLLAB_TOKEN; printenv OPENAI_API_KEY; echo done',
        cwd: dir,
        timeoutMs: 5_000,
        maxOutputBytes: 10_000,
      });
      assert.equal(result.exitCode, 0);
      assert.ok(result.stdout.includes(realpathSync(dir)), result.stdout);
      assert.ok(result.stdout.includes('done'));
      assert.equal(result.stdout.includes('should-not-leak'), false);
      assert.equal(result.stdout.includes('should-not-leak-either'), false);

      const env = scrubbedEnv(dir);
      assert.deepEqual(Object.keys(env).sort(), ['HOME', 'LANG', 'PATH', 'TMPDIR']);
    } finally {
      delete process.env.COLLAB_TOKEN;
      delete process.env.OPENAI_API_KEY;
    }
  });
});

test('沙箱：路径不能跳出运行目录', { timeout: 20_000 }, async () => {
  await withRoot(async root => {
    const dir = await createRunDir('agent-b', 'run-2');
    const outside = join(root, 'secret.txt');
    writeFileSync(outside, 'top secret');

    await assert.rejects(resolveInside(dir, '../secret.txt'), /跳出/);
    await assert.rejects(resolveInside(dir, '/etc/passwd'), /相对路径/);
    await assert.rejects(resolveInside(dir, 'a\0b'), /非法字符/);
    await assert.rejects(readFileInside(dir, '../secret.txt'), /跳出/);

    symlinkSync(outside, join(dir, 'link.txt'));
    await assert.rejects(readFileInside(dir, 'link.txt'), /符号链接/);
    await assert.rejects(writeFileInside(dir, 'link.txt', 'overwrite'), /符号链接/);

    const written = await writeFileInside(dir, 'nested/notes.txt', 'hello');
    assert.equal(written, 5);
    assert.equal(await readFileInside(dir, 'nested/notes.txt'), 'hello');
    const entries = await listFilesInside(dir, 'nested');
    assert.deepEqual(entries, [{ name: 'notes.txt', type: 'file' }]);

    // 清理只允许删运行目录内的路径。
    await assert.rejects(removeRunDir(root), /拒绝/);
    await removeRunDir(join(dir, 'nested'));
  });
});

test('沙箱：超时杀掉进程组，输出按上限截断', { timeout: 20_000 }, async () => {
  await withRoot(async () => {
    const dir = await createRunDir('agent-c', 'run-3');

    const started = Date.now();
    const timedOut = await runShell({
      command: 'sleep 10',
      cwd: dir,
      timeoutMs: 500,
      maxOutputBytes: 1_024,
    });
    assert.equal(timedOut.timedOut, true);
    assert.ok(Date.now() - started < 5_000, '超时没有及时杀掉进程组');

    const big = await runShell({
      command: `head -c 200000 /dev/zero | tr '\\0' 'a'`,
      cwd: dir,
      timeoutMs: 10_000,
      maxOutputBytes: 1_024,
    });
    assert.equal(big.truncated, true);
    assert.ok(big.stdout.length <= 1_024, `输出 ${big.stdout.length} 字节没有被截断`);

    await assert.rejects(
      runShell({ command: '', cwd: dir, timeoutMs: 1_000, maxOutputBytes: 100 }),
      /命令不能为空/,
    );
  });
});

test('沙箱：runRoot 跟随 COLLAB_RUN_ROOT', async () => {
  await withRoot(async root => {
    assert.equal(runRoot(), root);
  });
});
