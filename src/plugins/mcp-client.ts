/**
 * MCP 客户端的薄封装。
 *
 * 协议本身全部交给官方 SDK（握手、版本协商、分帧、请求路由、进度、取消、
 * 超时）。这里只补引擎需要的部分：稳定的 cwd/HOME/TMPDIR、stderr 诊断环、
 * 失败分类（确定的失败 vs 请求已发出但结果未知），以及退出时的兜底关闭。
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { ToolLog } from '../tools.ts';
import type { PluginDefinition } from './types.ts';

const CLIENT_INFO = { name: 'anpio-agents', version: '0.1.0' };
const STDERR_TAIL_LINES = 50;
const MAX_TOOL_PAGES = 100;
// 握手与发现不受单次调用超时支配：调用超时配得很短时，冷启动和 tools/list
// 仍需要一段稳定预算，否则插件会因为调度抖动在启动阶段就失败。
const STARTUP_TIMEOUT_MS = 5000;

export type McpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** 只有 annotations.readOnlyHint === true 才当读；其余一律按写处理。 */
  readOnly: boolean;
};

export type McpProgress = { progress: number; total?: number; message?: string };

export type McpCallResult = {
  content: unknown[];
  isError: boolean;
  structuredContent?: unknown;
};

/**
 * startup：连接没建立，确定没执行；
 * request：服务端明确拒绝或协议错误，确定没（或明确）执行；
 * indeterminate：请求可能已经到插件，结果无法确认。
 */
export type McpFailureKind = 'startup' | 'request' | 'indeterminate';

export class McpClientError extends Error {
  override name = 'McpClientError';
  readonly kind: McpFailureKind;
  readonly pluginId: string;

  constructor(pluginId: string, kind: McpFailureKind, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.pluginId = pluginId;
    this.kind = kind;
  }
}

const liveClients = new Set<McpClient>();
let exitHookInstalled = false;

function track(client: McpClient): void {
  liveClients.add(client);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    for (const item of liveClients) void item.close();
  });
}

export type McpConnectOptions = {
  definition: PluginDefinition;
  /** 插件自己的稳定目录，跨轮常驻；不能是会被删除的 Session 目录。 */
  directory: string;
  log?: ToolLog;
};

export class McpClient {
  readonly definition: PluginDefinition;
  private readonly client: Client;
  private readonly transport: StdioClientTransport;
  private readonly stderrTail: string[] = [];
  private transportError: Error | null = null;
  private dead = false;
  private closing: Promise<void> | null = null;

  private constructor(
    definition: PluginDefinition,
    client: Client,
    transport: StdioClientTransport,
  ) {
    this.definition = definition;
    this.client = client;
    this.transport = transport;
    transport.stderr?.on('data', (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      for (const line of text.split(/\r?\n/)) {
        if (line === '') continue;
        this.stderrTail.push(line.slice(0, 500));
        if (this.stderrTail.length > STDERR_TAIL_LINES) this.stderrTail.shift();
      }
    });
  }

  static async connect(options: McpConnectOptions): Promise<McpClient> {
    const { definition, log } = options;
    const directory = options.directory;
    await mkdir(join(directory, 'tmp'), { recursive: true, mode: 0o700 });

    const env: Record<string, string> = {
      HOME: directory,
      TMPDIR: join(directory, 'tmp'),
    };
    if (process.env.LANG !== undefined) env.LANG = process.env.LANG;
    for (const name of definition.env) {
      const value = process.env[name];
      if (value !== undefined) env[name] = value;
    }

    const transport = new StdioClientTransport({
      command: definition.command,
      args: definition.args,
      cwd: directory,
      env,
      stderr: 'pipe',
      maxBufferSize: Math.max(1_048_576, definition.maxOutputBytes * 8),
    });

    const client = new Client(CLIENT_INFO, { capabilities: {} });
    const instance = new McpClient(definition, client, transport);

    // 先挂自己的钩子：SDK 的 Protocol.connect 会保留并串联已有的回调。
    transport.onerror = (error: Error) => {
      instance.transportError = error;
      if (isStdoutPollution(error)) {
        log?.('warn', `插件 ${definition.id} 向 stdout 输出了非 JSON-RPC 内容，连接已关闭；日志请写 stderr`);
      }
    };
    transport.onclose = () => {
      instance.dead = true;
    };

    try {
      await client.connect(transport, {
        timeout: Math.max(definition.timeoutMs, STARTUP_TIMEOUT_MS),
      });
    } catch (error) {
      await instance.close().catch(() => {});
      throw instance.failure(error, 'startup');
    }

    track(instance);
    return instance;
  }

  get id(): string {
    return this.definition.id;
  }

  /** 服务端在握手时报告的名字与版本；用于自检输出。 */
  get serverInfo(): { name: string; version: string } | null {
    const info = this.client.getServerVersion();
    return info ? { name: info.name, version: info.version } : null;
  }

  get alive(): boolean {
    return !this.dead && this.closing === null;
  }

  get stderr(): readonly string[] {
    return this.stderrTail;
  }

  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    const seenNames = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;

    for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
      const result = await this.request(
        () =>
          this.client.listTools(cursor === undefined ? undefined : { cursor }, {
            timeout: Math.max(this.definition.timeoutMs, STARTUP_TIMEOUT_MS),
          }),
        'request',
      );
      for (const tool of result.tools) {
        if (seenNames.has(tool.name)) continue;
        seenNames.add(tool.name);
        tools.push({
          name: tool.name,
          description: tool.description ?? '',
          inputSchema: tool.inputSchema as Record<string, unknown>,
          readOnly: tool.annotations?.readOnlyHint === true,
        });
      }
      const next = result.nextCursor;
      if (!next || seenCursors.has(next)) break;
      seenCursors.add(next);
      cursor = next;
    }

    return tools;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    options: {
      meta: Record<string, unknown>;
      timeoutMs: number;
      signal?: AbortSignal;
      onProgress?: (progress: McpProgress) => void;
    },
  ): Promise<McpCallResult> {
    const wasDead = this.dead;
    const result = await this.request(
      () =>
        this.client.callTool({ name, arguments: args, _meta: options.meta }, undefined, {
          timeout: options.timeoutMs,
          maxTotalTimeout: options.timeoutMs * 5,
          resetTimeoutOnProgress: true,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          ...(options.onProgress === undefined
            ? {}
            : {
                onprogress: (progress) => {
                  options.onProgress?.({
                    progress: progress.progress,
                    ...(progress.total === undefined ? {} : { total: progress.total }),
                    ...(progress.message === undefined ? {} : { message: progress.message }),
                  });
                },
              }),
        }),
      wasDead ? 'request' : 'indeterminate',
    );

    return {
      content: Array.isArray(result.content) ? result.content : [],
      isError: result.isError === true,
      ...(result.structuredContent === undefined
        ? {}
        : { structuredContent: result.structuredContent }),
    };
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      liveClients.delete(this);
      this.dead = true;
      try {
        await this.client.close();
      } catch {
        // 关闭失败只能放弃：子进程会因 stdin EOF 或进程退出收尾。
      }
    })();
    return this.closing;
  }

  private async request<T>(operation: () => Promise<T>, sendFailure: McpFailureKind): Promise<T> {
    if (this.dead) throw this.failure(this.transportError ?? new Error('连接已关闭'), sendFailure);
    try {
      return await operation();
    } catch (error) {
      throw this.failure(error, sendFailure);
    }
  }

  private failure(error: unknown, sendFailure: McpFailureKind): McpClientError {
    if (error instanceof McpClientError) return error;

    const cause = this.transportError ?? error;
    const kind: McpFailureKind = this.classify(cause) ?? sendFailure;

    let text = `插件 ${this.definition.id} 调用失败：${messageOf(cause)}`;
    if (isStdoutPollution(cause)) {
      text =
        `插件 ${this.definition.id} 向 stdout 输出了非 JSON-RPC 内容，连接已关闭。` +
        'stdout 只能走 MCP 协议，日志请写 stderr。';
    }
    const tail = this.stderrTail.slice(-5);
    if (tail.length > 0) text += `\n（插件 stderr 最近 ${tail.length} 行）\n${tail.join('\n')}`;

    return new McpClientError(this.definition.id, kind, text, error);
  }

  /** 明确的“请求已发出、结果未知”才返回 indeterminate；其余返回 null。 */
  private classify(error: unknown): McpFailureKind | null {
    if (error instanceof McpError) {
      if (error.code === ErrorCode.RequestTimeout) return 'indeterminate';
      if (error.code === ErrorCode.ConnectionClosed) return 'indeterminate';
      return 'request';
    }
    if (error instanceof Error && error.name === 'AbortError') return 'indeterminate';
    if (this.dead) return 'indeterminate';
    return null;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isStdoutPollution(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error instanceof SyntaxError || error.name === 'ZodError' || /\bJSON\b/.test(error.message);
}
