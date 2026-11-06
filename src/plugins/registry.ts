/**
 * 插件进程的注册表：一个 agent 一份，跨 Session 复用。
 *
 * 负责启动、工具发现与白名单过滤、并发闸门、空闲回收和失败分类。
 * 配置已经由 `config.ts` 校验过；这里只处理运行时状态。
 */

import { join } from 'node:path';
import type { ToolCall, ToolSpec } from '../brains/types.ts';
import type { ToolExecution, ToolLog } from '../tools.ts';
import { buildPluginMeta } from './context.ts';
import { exposedToolName } from './naming.ts';
import { McpClient, McpClientError, type McpTool } from './mcp-client.ts';
import { renderPluginResult } from './render.ts';
import type {
  PluginCallContext,
  PluginDefinition,
  PluginPreparation,
  PluginTool,
} from './types.ts';

export class PluginStartupError extends Error {
  override name = 'PluginStartupError';
  readonly failures: Array<{ id: string; reason: string }>;

  constructor(failures: Array<{ id: string; reason: string }>) {
    super(`插件启动失败：\n${failures.map((item) => `- ${item.id}：${item.reason}`).join('\n')}`);
    this.failures = failures;
  }
}

type SlotState = 'stopped' | 'starting' | 'ready' | 'failed';

type Slot = {
  definition: PluginDefinition;
  state: SlotState;
  client: McpClient | null;
  discovered: McpTool[];
  starting: Promise<void> | null;
  closing: Promise<void> | null;
  failure: string | null;
  inflight: number;
  queue: Array<() => void>;
  idleTimer: NodeJS.Timeout | null;
};

type Entry = { tool: PluginTool; slot: Slot };

export type PluginRegistryOptions = {
  agentId: string;
  /** `<runRoot>/<agentId>/`，跨 Session 稳定。 */
  agentRoot: string;
  plugins: PluginDefinition[];
  log?: ToolLog;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class PluginRegistry {
  private readonly agentId: string;
  private readonly agentRoot: string;
  private readonly log: ToolLog | undefined;
  private slots: Slot[];
  private entries: Entry[] = [];
  private prepared: PluginPreparation | null = null;
  private preparing: Promise<PluginPreparation> | null = null;

  constructor(options: PluginRegistryOptions) {
    this.agentId = options.agentId;
    this.agentRoot = options.agentRoot;
    this.log = options.log;
    this.slots = options.plugins.map((definition) => ({
      definition,
      state: 'stopped',
      client: null,
      discovered: [],
      starting: null,
      closing: null,
      failure: null,
      inflight: 0,
      queue: [],
      idleTimer: null,
    }));
  }

  get empty(): boolean {
    return this.slots.length === 0;
  }

  /** 已声明的插件定义，顺序与工具清单一致。 */
  definitions(): PluginDefinition[] {
    return this.slots.map((slot) => slot.definition);
  }

  /** 运行时接入：新插件参与下一次 prepare，已有连接不受影响。 */
  add(definitions: PluginDefinition[]): void {
    for (const definition of definitions) {
      if (this.slots.some((slot) => slot.definition.id === definition.id)) {
        throw new Error(`插件 id 重复：${definition.id}`);
      }
      this.slots.push({
        definition,
        state: 'stopped',
        client: null,
        discovered: [],
        starting: null,
        closing: null,
        failure: null,
        inflight: 0,
        queue: [],
        idleTimer: null,
      });
    }
    this.prepared = null;
  }

  /** 运行时移除：关闭对应进程并重算工具清单。 */
  async remove(ids: ReadonlySet<string>): Promise<void> {
    const removed = this.slots.filter((slot) => ids.has(slot.definition.id));
    if (removed.length === 0) return;
    this.slots = this.slots.filter((slot) => !ids.has(slot.definition.id));
    this.prepared = null;
    await Promise.all(removed.map((slot) => this.shutdown(slot)));
  }

  /** 记忆化：同一轮或多轮并发调用只启动一次；失败后清缓存，下一轮重试。 */
  async prepare(): Promise<PluginPreparation> {
    if (this.prepared) return this.prepared;
    if (this.preparing) return this.preparing;
    const promise = this.doPrepare();
    this.preparing = promise;
    try {
      return await promise;
    } finally {
      this.preparing = null;
    }
  }

  tools(): PluginTool[] {
    return this.entries.map((entry) => entry.tool);
  }

  specs(): ToolSpec[] {
    return this.entries.map((entry) => entry.tool.spec);
  }

  has(name: string): boolean {
    return this.entries.some((entry) => entry.tool.exposedName === name);
  }

  /** 一轮结束：不关连接，只给空闲回收一个起点。 */
  endTurn(): void {
    for (const slot of this.slots) this.scheduleIdle(slot);
  }

  /**
   * 执行一次插件工具调用。这里必须吞掉所有异常：`runBrainLoop` 不捕获
   * execute 抛出的错误，漏一个就会把整轮打断。
   */
  async call(call: ToolCall, context: PluginCallContext): Promise<ToolExecution> {
    const entry = this.entries.find((item) => item.tool.exposedName === call.name);
    if (!entry) return { content: `工具 ${call.name} 没有启用` };

    const { tool, slot } = entry;
    const started = Date.now();
    let status = 'ok';

    try {
      const client = await this.ensureReady(slot);
      if (!slot.discovered.some((item) => item.name === tool.name)) {
        throw new Error(`插件 ${slot.definition.id} 当前没有提供工具 ${tool.name}`);
      }

      const release = await this.acquire(slot);
      let result;
      try {
        result = await client.callTool(tool.name, call.input ?? {}, {
          meta: buildPluginMeta(
            call,
            slot.definition.id,
            tool.name,
            context,
            slot.definition.timeoutMs,
          ),
          timeoutMs: slot.definition.timeoutMs,
          ...(context.signal === undefined ? {} : { signal: context.signal }),
          onProgress: (progress) => {
            context.onProgress?.({
              pluginId: slot.definition.id,
              tool: tool.name,
              progress: progress.progress,
              ...(progress.total === undefined ? {} : { total: progress.total }),
              ...(progress.message === undefined ? {} : { message: progress.message }),
            });
          },
        });
      } finally {
        release();
      }

      if (result.isError) status = 'error';
      return { content: renderPluginResult(result, slot.definition.maxOutputBytes) };
    } catch (error) {
      const message = messageOf(error);
      const kind = error instanceof McpClientError ? error.kind : 'request';

      if (slot.client && !slot.client.alive) await this.shutdown(slot);

      if (kind === 'indeterminate' && tool.effects === 'write') {
        status = 'uncertain';
        return { content: `写请求结果未知：${message}`, uncertain: message };
      }

      status = 'error';
      return { content: `工具失败：${message}` };
    } finally {
      const duration = Date.now() - started;
      // 审计只记插件、工具、耗时、状态；参数与正文都不落日志。
      this.log?.(status === 'ok' ? 'debug' : 'warn', `插件 ${slot.definition.id} 工具 ${tool.name} ${duration}ms ${status}`);
    }
  }

  async closeAll(): Promise<void> {
    this.entries = [];
    this.prepared = null;
    await Promise.all(this.slots.map((slot) => this.shutdown(slot)));
  }

  private async doPrepare(): Promise<PluginPreparation> {
    const tools: PluginTool[] = [];
    const entries: Entry[] = [];
    const degraded: Array<{ id: string; reason: string }> = [];
    const failures: Array<{ id: string; reason: string }> = [];

    for (const slot of this.slots) {
      if (slot.state === 'failed') slot.state = 'stopped';
      slot.failure = null;
      try {
        await this.ensureReady(slot);
        const allow = slot.definition.allow.includes('*')
          ? slot.discovered.map((item) => item.name)
          : slot.definition.allow;
        if (slot.definition.allow.includes('*') && allow.length === 0) {
          throw new Error('插件没有提供任何工具');
        }
        const missing = allow.filter(
          (name) => !slot.discovered.some((item) => item.name === name),
        );
        if (missing.length > 0) {
          throw new Error(`插件没有提供这些工具：${missing.join(', ')}`);
        }
        for (const name of allow) {
          const tool = this.toTool(slot, name);
          tools.push(tool);
          entries.push({ tool, slot });
        }
      } catch (error) {
        const reason = messageOf(error);
        slot.failure = reason;
        slot.state = 'failed';
        if (slot.definition.optional) {
          degraded.push({ id: slot.definition.id, reason });
          this.log?.('warn', `插件 ${slot.definition.id} 不可用，按 optional 降级：${reason}`);
        } else {
          failures.push({ id: slot.definition.id, reason });
        }
      }
    }

    if (failures.length > 0) {
      await this.closeAll();
      throw new PluginStartupError(failures);
    }

    this.entries = entries;
    this.prepared = { tools, degraded };
    for (const slot of this.slots) this.scheduleIdle(slot);
    return this.prepared;
  }

  private toTool(slot: Slot, name: string): PluginTool {
    const found = slot.discovered.find((item) => item.name === name);
    const exposedName = exposedToolName(slot.definition.id, name);
    return {
      pluginId: slot.definition.id,
      name,
      exposedName,
      spec: {
        name: exposedName,
        description:
          found?.description && found.description !== ''
            ? found.description
            : `插件 ${slot.definition.id} 的工具 ${name}`,
        parameters: found?.inputSchema ?? { type: 'object', properties: {} },
      },
      effects: found?.readOnly === true ? 'read' : 'write',
    };
  }

  private directoryOf(slot: Slot): string {
    return join(this.agentRoot, 'plugins', slot.definition.id);
  }

  private async ensureReady(slot: Slot): Promise<McpClient> {
    if (slot.closing) await slot.closing;
    if (slot.state === 'ready' && slot.client?.alive) return slot.client;

    if (slot.starting) {
      await slot.starting;
      if (slot.state === 'ready' && slot.client) return slot.client;
      throw new Error(slot.failure ?? '插件启动失败');
    }

    slot.state = 'starting';
    slot.failure = null;
    const attempt = (async () => {
      const client = await McpClient.connect({
        definition: slot.definition,
        directory: this.directoryOf(slot),
        ...(this.log === undefined ? {} : { log: this.log }),
      });
      try {
        slot.discovered = await client.listTools();
      } catch (error) {
        await client.close().catch(() => {});
        throw error;
      }
      slot.client = client;
      slot.state = 'ready';
    })();
    slot.starting = attempt.finally(() => {
      slot.starting = null;
    });

    try {
      await slot.starting;
    } catch (error) {
      slot.state = 'failed';
      slot.failure = messageOf(error);
      slot.client = null;
      throw error;
    }

    const client = slot.client;
    if (!client) throw new Error('插件没有连接');
    return client;
  }

  private async shutdown(slot: Slot): Promise<void> {
    if (slot.idleTimer) {
      clearTimeout(slot.idleTimer);
      slot.idleTimer = null;
    }
    if (slot.closing) return slot.closing;
    const client = slot.client;
    slot.client = null;
    slot.discovered = [];
    slot.state = 'stopped';
    slot.closing = (async () => {
      try {
        await client?.close();
      } finally {
        slot.closing = null;
      }
    })();
    return slot.closing;
  }

  private acquire(slot: Slot): Promise<() => void> {
    const release = (): void => {
      slot.inflight -= 1;
      const next = slot.queue.shift();
      if (next) next();
      else this.scheduleIdle(slot);
    };

    if (slot.inflight < slot.definition.concurrency) {
      slot.inflight += 1;
      return Promise.resolve(release);
    }

    return new Promise<() => void>((resolve) => {
      slot.queue.push(() => {
        slot.inflight += 1;
        resolve(release);
      });
    });
  }

  private scheduleIdle(slot: Slot): void {
    if (slot.idleTimer) {
      clearTimeout(slot.idleTimer);
      slot.idleTimer = null;
    }
    const idleMs = slot.definition.idleMs;
    if (idleMs <= 0) return;
    if (slot.state !== 'ready' || slot.inflight > 0 || slot.queue.length > 0) return;

    const timer = setTimeout(() => {
      slot.idleTimer = null;
      if (slot.inflight > 0 || slot.state !== 'ready') return;
      this.log?.('debug', `插件 ${slot.definition.id} 空闲 ${idleMs}ms，关闭进程`);
      void this.shutdown(slot).catch(() => {});
    }, idleMs);
    timer.unref?.();
    slot.idleTimer = timer;
  }
}
