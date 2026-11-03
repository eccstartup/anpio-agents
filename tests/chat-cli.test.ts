import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const repo = new URL('..', import.meta.url).pathname;

type RunResult = { code: number | null; stdout: string; stderr: string };

function runCli(args: string[], input: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', 'src/chat/cli.ts', ...args],
      { cwd: repo, env: process.env },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => {
      stdout += String(chunk);
    });
    child.stderr.on('data', chunk => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('exit', code => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

test('交互模式：逐条处理 piped 输入，/exit 时先把消息跑完', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chat-cli-'));
  try {
    const result = await runCli(
      ['--agent', 'examples/local-demo.json', '--root', root],
      '跑一下\n/exit\n',
    );
    assert.equal(result.code, 0);
    assert.match(result.stdout, /已查看沙箱并写入 result\.txt/);
    assert.match(result.stderr, /→ shell/);

    const workspace = join(root, 'local-demo', 'workspace', 'threads', 'local:main');
    assert.equal(await readFile(join(workspace, 'result.txt'), 'utf8'), '独立运行完成。\n');
    await access(join(workspace, 'AGENTS.md'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('--message 只跑一条，正常退出', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chat-cli-msg-'));
  try {
    const result = await runCli(
      ['--agent', 'examples/local-demo.json', '--root', root, '--message', '跑一下'],
      '',
    );
    assert.equal(result.code, 0);
    assert.match(result.stdout, /已查看沙箱并写入 result\.txt/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
