/**
 * 内嵌智能体的沙箱原语。
 *
 * 这是"防误伤"的边界，不是内核隔离：路径限制在一个 run 目录里，
 * shell 只拿到白名单环境变量，超时杀整个进程组，输出截断。
 * 真正的强隔离需要容器或独立用户，文档里写清楚了。
 */

import { spawn } from 'node:child_process';
import { constants as fsConstants, promises as fs } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

const MAX_COMMAND_LENGTH = 8_000;
const MAX_READ_BYTES = 256 * 1024;

export type ShellResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
};

export function runRoot(): string {
  return process.env.COLLAB_RUN_ROOT
    ? resolve(process.env.COLLAB_RUN_ROOT)
    : resolve(process.cwd(), 'collab-runs');
}

/** 目录名来自平台，这里再挡一层路径字符；agentId 与 runId 都由平台生成。 */
export function safeSegment(value: string): string {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(value)) throw new Error('运行目录名不合法');
  return value;
}

/**
 * agent 级工作根：`<runRoot>/<agentId>/`，跨 Session 存在。
 * 每个 Session 在 `sessions/<runId>` 下工作，互不共享目录。
 */
export async function ensureAgentRoot(agentId: string): Promise<string> {
  const dir = join(runRoot(), safeSegment(agentId));
  await fs.mkdir(join(dir, 'sessions'), { recursive: true, mode: 0o700 });
  return dir;
}

/** 每个 Session 一个 0700 目录，结束即清理。 */
export async function createRunDir(agentId: string, runId: string): Promise<string> {
  const dir = join(runRoot(), safeSegment(agentId), 'sessions', safeSegment(runId));
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.mkdir(join(dir, 'tmp'), { recursive: true, mode: 0o700 });
  return dir;
}

/** shell 与文件工具共用的环境：不带令牌、不带任何密钥。 */
export function scrubbedEnv(runDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: runDir,
    TMPDIR: join(runDir, 'tmp'),
    LANG: process.env.LANG ?? 'en_US.UTF-8',
  };
  return env;
}

export async function runShell(input: {
  command: string;
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  allowNetwork?: boolean;
}): Promise<ShellResult> {
  const command = String(input.command ?? '');
  if (command.length === 0) throw new Error('命令不能为空');
  if (command.length > MAX_COMMAND_LENGTH) throw new Error(`命令过长（上限 ${MAX_COMMAND_LENGTH} 字符）`);

  const env = scrubbedEnv(input.cwd);
  let file = '/bin/sh';
  let args = ['-lc', command];
  if (process.env.COLLAB_SANDBOX_EXEC === '1') {
    if (process.platform !== 'darwin') {
      throw new Error('COLLAB_SANDBOX_EXEC 目前只支持 macOS 的 sandbox-exec');
    }
    file = '/usr/bin/sandbox-exec';
    args = ['-p', sandboxProfile(input.cwd, input.allowNetwork === true), '/bin/sh', '-lc', command];
  }

  return await new Promise<ShellResult>((resolvePromise, reject) => {
    let child;
    try {
      child = spawn(file, args, {
        cwd: input.cwd,
        env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(error);
      return;
    }

    const limit = Math.max(1024, input.maxOutputBytes);
    const chunks = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
    const sizes = { stdout: 0, stderr: 0 };
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const collect = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
      const remaining = limit - sizes[stream];
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      if (chunk.length > remaining) {
        chunks[stream].push(chunk.subarray(0, remaining));
        sizes[stream] += remaining;
        truncated = true;
        return;
      }
      chunks[stream].push(chunk);
      sizes[stream] += chunk.length;
    };

    child.stdout?.on('data', (chunk: Buffer) => collect('stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer) => collect('stderr', chunk));

    const killGroup = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // 进程已经退出。
        }
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), 2_000).unref();
    }, Math.max(1_000, input.timeoutMs));
    timer.unref();

    const finish = (exitCode: number, extraError?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stderr = Buffer.concat(chunks.stderr).toString('utf8') + (extraError ? `\n${extraError}` : '');
      resolvePromise({
        exitCode,
        stdout: Buffer.concat(chunks.stdout).toString('utf8'),
        stderr,
        timedOut,
        truncated,
      });
    };

    child.on('error', error => finish(-1, String(error instanceof Error ? error.message : error)));
    child.on('close', code => finish(code ?? -1));
  });
}

function sandboxProfile(runDir: string, allowNetwork: boolean): string {
  const escaped = runDir.replace(/"/g, '\\"');
  const lines = [
    '(version 1)',
    '(deny default)',
    '(allow process*)',
    '(allow sysctl-read)',
    '(allow file-read*)',
    `(allow file-write* (subpath "${escaped}"))`,
    '(allow file-write* (subpath "/dev"))',
  ];
  if (allowNetwork) lines.push('(allow network*)');
  return lines.join('\n');
}

// ------------------------------------------------------------------ 路径

/** 解析到 root 内部；绝对路径、`..`、NUL 与符号链接逃逸一律拒绝。 */
export async function resolveInside(root: string, relative: unknown): Promise<string> {
  if (typeof relative !== 'string' || relative.length === 0) throw new Error('路径不能为空');
  if (relative.includes('\0')) throw new Error('路径包含非法字符');
  if (isAbsolute(relative)) throw new Error('只接受相对路径');
  const parts = relative.split(/[\\/]+/);
  if (parts.some(part => part === '..')) throw new Error('路径不能跳出运行目录');

  const base = await realpath(root);
  const target = resolve(base, relative);
  if (target !== base && !target.startsWith(base + sep)) throw new Error('路径不能跳出运行目录');

  // 最近的已存在祖先必须是真实路径且仍在 root 内：挡住中间层符号链接。
  let ancestor = target;
  for (;;) {
    try {
      const stat = await fs.lstat(ancestor);
      if (stat.isSymbolicLink()) throw new Error('不允许通过符号链接访问');
      const real = await realpath(ancestor);
      if (real !== base && !real.startsWith(base + sep)) throw new Error('路径不能跳出运行目录');
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw new Error('路径无效');
      ancestor = parent;
    }
  }
  return target;
}

export async function readFileInside(root: string, relative: unknown): Promise<string> {
  const bytes = await readBytesInside(root, relative);
  return bytes.toString('utf8');
}

/** 下载文件时保留原始字节；上限与文本读取一致。 */
export async function readBytesInside(root: string, relative: unknown): Promise<Buffer> {
  const path = await resolveInside(root, relative);
  const stat = await fs.lstat(path);
  if (!stat.isFile()) throw new Error('只能读取普通文件');
  if (stat.size > MAX_READ_BYTES) throw new Error(`文件过大（上限 ${MAX_READ_BYTES} 字节）`);
  return await fs.readFile(path);
}

export async function writeFileInside(root: string, relative: unknown, content: string): Promise<number> {
  return await writeBytesInside(root, relative, Buffer.from(content, 'utf8'));
}

export async function writeBytesInside(root: string, relative: unknown, bytes: Uint8Array): Promise<number> {
  const path = await resolveInside(root, relative);
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // 已存在的符号链接即使指向目录内也拒绝：写入行为对调用方应该可预测。
  try {
    const stat = await fs.lstat(path);
    if (stat.isSymbolicLink()) throw new Error('不允许写入符号链接');
    if (stat.isDirectory()) throw new Error('目标是目录');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const handle = await fs.open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC, 0o600);
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
  return bytes.byteLength;
}

export async function listFilesInside(root: string, relative = '.') {
  const path = await resolveInside(root, relative);
  const entries = await fs.readdir(path, { withFileTypes: true });
  return entries
    .slice(0, 200)
    .map(entry => ({
      name: entry.name,
      type: entry.isDirectory() ? ('dir' as const) : entry.isSymbolicLink() ? ('link' as const) : ('file' as const),
    }));
}

/** 清理过期 run 目录；keepRun=1 时保留排查。 */
export async function removeRunDir(dir: string, options: { keep?: boolean } = {}): Promise<void> {
  if (options.keep) return;
  const root = await realpath(runRoot()).catch(() => runRoot());
  // 两侧都取真实路径：macOS 的 /var 指向 /private/var，只解析一侧会误判越界。
  const target = await realpath(resolve(dir)).catch(() => resolve(dir));
  if (target === root || !target.startsWith(root + sep)) throw new Error('拒绝删除运行目录之外的内容');
  await fs.rm(target, { recursive: true, force: true });
}

export async function touchHeartbeatFile(dir: string): Promise<void> {
  await fs.writeFile(join(dir, '.heartbeat'), new Date().toISOString(), { mode: 0o600 }).catch(() => {});
}
