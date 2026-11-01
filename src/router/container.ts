/**
 * 容器隔离：模型循环、ANP 签名与数据库都在主机侧，只有 shell / 文件工具
 * 通过 `docker exec` 进入容器执行。容器里没有 DID 私钥、模型密钥或平台令牌，
 * 每轮只拿一个短期工具 token；默认无网络、只读根文件系统。
 */

import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import type { ShellResult } from '../sandbox.ts';
import type { LocalToolExecutor } from '../tools.ts';

export type ContainerOptions = {
  docker: string;
  image: string;
  memory: string;
  cpus: string;
  pidsLimit: number;
};

export class ContainerError extends Error {
  override name = 'ContainerError';
}

export type ContainerProbe = {
  available: boolean;
  version: string | null;
  error: string | null;
};

type ProcessResult = {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

function runProcess(
  command: string,
  args: string[],
  options: { timeoutMs: number; input?: string } = { timeoutMs: 10_000 },
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const finish = (result: ProcessResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs);
    timer.unref?.();

    child.stdout.on('data', chunk => {
      if (stdout.length < 1_000_000) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', chunk => {
      if (stderr.length < 100_000) stderr += chunk.toString('utf8');
    });
    child.on('error', error => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(timer);
      finish({
        code: typeof code === 'number' ? code : timedOut ? 124 : 1,
        stdout,
        stderr,
        timedOut,
      });
    });

    if (options.input !== undefined) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}

export async function probeContainer(options: Pick<ContainerOptions, 'docker'>): Promise<ContainerProbe> {
  try {
    const result = await runProcess(
      options.docker,
      ['version', '--format', '{{.Server.Version}}'],
      { timeoutMs: 5_000 },
    );
    if (result.code === 0) {
      return { available: true, version: result.stdout.trim() || null, error: null };
    }
    return {
      available: false,
      version: null,
      error: (result.stderr || result.stdout).trim() || `docker version 退出码 ${result.code}`,
    };
  } catch (error) {
    return {
      available: false,
      version: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export type ContainerToolContext = ContainerOptions & {
  /** 主机侧 thread workspace，挂到容器 /workspace。 */
  workspace: string;
  agentId: string;
  threadId: string;
  log?: (line: string) => void;
};

export class ContainerToolExecutor implements LocalToolExecutor {
  private readonly options: ContainerToolContext;
  private name: string | null = null;
  private token: string | null = null;
  private starting: Promise<void> | null = null;

  constructor(options: ContainerToolContext) {
    this.options = options;
  }

  async shell(input: {
    command: string;
    timeoutMs: number;
    maxOutputBytes: number;
  }): Promise<ShellResult> {
    return await this.request(
      {
        op: 'shell',
        command: input.command,
        timeoutMs: input.timeoutMs,
        maxOutputBytes: input.maxOutputBytes,
      },
      input.timeoutMs + 10_000,
    ) as ShellResult;
  }

  async readFile(relative: string): Promise<string> {
    return await this.request({ op: 'read', path: relative }, 15_000) as string;
  }

  async writeFile(relative: string, content: string): Promise<number> {
    return await this.request({ op: 'write', path: relative, content }, 15_000) as number;
  }

  async listFiles(relative: string): Promise<Array<{ name: string; type: 'dir' | 'file' | 'link' }>> {
    return await this.request({ op: 'list', path: relative }, 15_000) as Array<{
      name: string;
      type: 'dir' | 'file' | 'link';
    }>;
  }

  async dispose(): Promise<void> {
    const name = this.name;
    this.name = null;
    this.token = null;
    this.starting = null;
    if (!name) return;
    try {
      await runProcess(this.options.docker, ['rm', '-f', name], { timeoutMs: 15_000 });
    } catch {
      // 容器可能已经退出；labels 与 --rm 会兜底清理。
    }
  }

  private async ensureStarted(): Promise<void> {
    if (this.name) return;
    if (!this.starting) {
      this.starting = this.start().catch(error => {
        this.starting = null;
        throw error;
      });
    }
    await this.starting;
  }

  private async start(): Promise<void> {
    const name = `anp-${randomUUID().slice(0, 12)}`;
    const token = randomBytes(32).toString('hex');
    const args = [
      'run',
      '--rm',
      '-d',
      '--pull',
      'never',
      '--name',
      name,
      '--label',
      `anp.session=${this.options.threadId}`,
      '--label',
      `anp.agent=${this.options.agentId}`,
      '--network',
      'none',
      '--read-only',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,size=64m',
      '--user',
      '10001:10001',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--pids-limit',
      String(this.options.pidsLimit),
      '--memory',
      this.options.memory,
      '--cpus',
      this.options.cpus,
      '-v',
      `${this.options.workspace}:/workspace:rw`,
      this.options.image,
    ];

    let result: ProcessResult;
    try {
      result = await runProcess(this.options.docker, args, { timeoutMs: 60_000 });
    } catch (error) {
      throw new ContainerError(
        `无法启动容器（${this.options.docker}）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout).trim();
      throw new ContainerError(
        `无法启动容器：${detail || `退出码 ${result.code}`}；`
        + `请先运行 container/build.sh 并把 container.image 设为 ${this.options.image}`,
      );
    }

    this.name = name;
    this.token = token;
    this.options.log?.(`[container ${name}] 已启动（agent ${this.options.agentId}）`);
  }

  private async request(payload: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    await this.ensureStarted();
    const name = this.name;
    const token = this.token;
    if (!name || !token) throw new ContainerError('容器尚未启动');

    const id = randomUUID();
    const child = spawn(
      this.options.docker,
      ['exec', '-i', '-e', `ANP_TOOL_TOKEN=${token}`, name, 'node', '/opt/anp/exec.mjs'],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );

    return await new Promise<unknown>((resolve, reject) => {
      let settled = false;
      let buffer = '';
      let stderr = '';
      const settle = (error: Error | null, value?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.stdin.end();
        child.kill('SIGKILL');
        if (error) reject(error);
        else resolve(value);
      };
      const timer = setTimeout(() => {
        settle(new ContainerError(`容器工具调用超时（${timeoutMs}ms）`));
      }, timeoutMs);
      timer.unref?.();

      child.on('error', error => {
        settle(new ContainerError(`无法连接容器：${error.message}`));
      });
      child.stderr.on('data', chunk => {
        if (stderr.length < 10_000) stderr += chunk.toString('utf8');
      });
      child.stdout.on('data', chunk => {
        buffer += chunk.toString('utf8');
        for (;;) {
          const index = buffer.indexOf('\n');
          if (index < 0) break;
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (line === '') continue;
          let message: { id?: unknown; ok?: boolean; result?: unknown; error?: string };
          try {
            message = JSON.parse(line) as typeof message;
          } catch {
            continue;
          }
          if (message.id !== id) continue;
          if (message.ok) settle(null, message.result);
          else settle(new ContainerError(message.error ?? '容器工具执行失败'));
        }
      });
      child.on('close', code => {
        if (settled) return;
        settle(
          new ContainerError(
            `容器执行通道退出（${code ?? 'signal'}）${stderr.trim() ? `：${stderr.trim()}` : ''}`,
          ),
        );
      });

      child.stdin.write(`${JSON.stringify({ op: 'auth', token })}\n`);
      child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
    });
  }
}
