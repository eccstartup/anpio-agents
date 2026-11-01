#!/usr/bin/env node
/**
 * 容器内的工具执行器：stdin 读 JSONL 请求，stdout 写 JSONL 响应。
 *
 * 只暴露 workspace 内的 shell / 文件原语。DID 私钥、模型密钥、平台令牌
 * 都不在这个进程的环境里；每轮工具 token 只用于校验调用方。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, dirname, join, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';

// 解析真实路径：macOS 的临时目录常是符号链接，比较前必须统一。
const ROOT = realpathSync(process.env.ANP_WORKSPACE ?? '/workspace');
const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 1 * 1024 * 1024;
const TOKEN = process.env.ANP_TOOL_TOKEN ?? null;
let authenticated = TOKEN === null;

function fail(message) {
  throw new Error(message);
}

function assertInside(path) {
  if (path !== ROOT && !path.startsWith(ROOT + sep)) {
    fail('路径超出工作目录');
  }
}

function resolveInside(relative) {
  if (typeof relative !== 'string' || relative.includes('\0')) fail('路径非法');
  if (isAbsolute(relative)) fail('只允许相对路径');
  const target = resolve(ROOT, relative);
  assertInside(target);

  // 已存在的部分必须落在 workspace 内，防止符号链接逃逸。
  let probe = target;
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  if (existsSync(probe)) assertInside(realpathSync(probe));
  return target;
}

function entryType(dirent) {
  if (dirent.isDirectory()) return 'dir';
  if (dirent.isSymbolicLink()) return 'link';
  return 'file';
}

function runShell(input) {
  const command = typeof input.command === 'string' ? input.command : '';
  if (command.length === 0) fail('命令不能为空');
  const timeoutMs = Number.isInteger(input.timeoutMs) && input.timeoutMs > 0 ? input.timeoutMs : 30_000;
  const maxOutputBytes =
    Number.isInteger(input.maxOutputBytes) && input.maxOutputBytes > 0
      ? Math.min(input.maxOutputBytes, MAX_OUTPUT_BYTES)
      : MAX_OUTPUT_BYTES;

  return new Promise((resolvePromise, reject) => {
    const child = spawn('/bin/sh', ['-lc', command], {
      cwd: ROOT,
      // shell 子进程不继承工具 token 或宿主环境变量。
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp', LANG: 'C.UTF-8' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let truncated = false;
    let timedOut = false;

    const collect = (chunk, target) => {
      if (bytes >= maxOutputBytes) {
        truncated = true;
        return target;
      }
      const remaining = maxOutputBytes - bytes;
      const buffer = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      bytes += buffer.length;
      if (buffer.length < chunk.length) truncated = true;
      return target + buffer.toString('utf8');
    };

    child.stdout.on('data', chunk => {
      stdout = collect(chunk, stdout);
    });
    child.stderr.on('data', chunk => {
      stderr = collect(chunk, stderr);
    });
    child.on('error', reject);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    timer.unref?.();

    child.on('close', code => {
      clearTimeout(timer);
      resolvePromise({
        exitCode: typeof code === 'number' ? code : timedOut ? 124 : 1,
        stdout,
        stderr,
        timedOut,
        truncated,
      });
    });
  });
}

const handlers = {
  async shell(input) {
    return await runShell(input);
  },
  async read(input) {
    const path = resolveInside(input.path);
    const data = readFileSync(path);
    if (data.length > MAX_READ_BYTES) fail(`文件超过 ${MAX_READ_BYTES} 字节`);
    return data.toString('utf8');
  },
  async write(input) {
    const path = resolveInside(input.path);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const content = typeof input.content === 'string' ? input.content : String(input.content ?? '');
    writeFileSync(path, content, { encoding: 'utf8', mode: 0o600 });
    return Buffer.byteLength(content);
  },
  async list(input) {
    const path = resolveInside(input.path ?? '.');
    return readdirSync(path, { withFileTypes: true })
      .slice(0, 200)
      .map(dirent => ({ name: dirent.name, type: entryType(dirent) }));
  },
};

async function handle(request) {
  if (!authenticated) {
    if (request.op !== 'auth' || request.token !== TOKEN) fail('工具 token 无效');
    authenticated = true;
    return { authenticated: true };
  }
  if (request.op === 'auth') fail('重复认证');
  const handler = handlers[request.op];
  if (!handler) fail(`未知操作：${String(request.op)}`);
  return await handler(request);
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', line => {
  if (line.trim() === '') return;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    process.stdout.write(`${JSON.stringify({ id: null, ok: false, error: '请求不是合法 JSON' })}\n`);
    return;
  }
  const id = request?.id ?? null;
  void handle(request).then(
    result => {
      process.stdout.write(`${JSON.stringify({ id, ok: true, result })}\n`);
    },
    error => {
      process.stdout.write(
        `${JSON.stringify({ id, ok: false, error: error instanceof Error ? error.message : String(error) })}\n`,
      );
    },
  );
});
