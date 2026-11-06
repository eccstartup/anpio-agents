/**
 * 一轮运行里模型可以调用的工具。
 *
 * 每个工具都是"平台协议 + 沙箱原语"的薄封装：参数校验在模型适配层之外，
 * 失败以文本回到模型，让它自己决定换一种做法；只有"写请求结果未知"
 * 是致命的——这时本轮必须停下并以 outcome_unknown 收尾，不能假装成功。
 */

import { CollabError } from './client.ts';
import type { EmbeddedAgentDefinition, EmbeddedTool } from './definition.ts';
import type { ToolCall, ToolSpec } from './brains/types.ts';
import type { ExperienceClient } from './experience/client.ts';
import { parseKnowledgeReference } from './experience/client.ts';
import type { MemoryStore } from './memory/store.ts';
import { MEMORY_KINDS, type Memory } from './memory/store.ts';
import { evidenceLevel } from './memory/text.ts';
import type { SessionEventLog } from './session/events.ts';
import type { SessionIndex } from './session/index.ts';
import type { ToolBackend } from './runtime/transport.ts';
import { ANP_TOOL_SPECS } from './tools/anp.ts';
import { NET_TOOL_SPECS } from './tools/net.ts';
import { SCHEDULE_TOOL_SPECS } from './tools/schedule.ts';
import { SUBAGENT_TOOL_SPECS } from './tools/subagent.ts';
import {
  listFilesInside,
  readBytesInside,
  readFileInside,
  runShell,
  writeBytesInside,
  writeFileInside,
  type ShellResult,
} from './sandbox.ts';

export const MAX_RESULT_CHARS = 6_000;

/** 结果截断的唯一实现；插件结果也走这一层，保证模型看到的上限一致。 */
export function truncateResult(text: string): string {
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n…（已截断）` : text;
}

/**
 * 本地原语的实际执行位置。默认是进程内 sandbox；容器模式换成容器内的
 * 短期执行通道，模型循环仍然在主机侧。
 */
export type LocalToolExecutor = {
  shell(input: { command: string; timeoutMs: number; maxOutputBytes: number }): Promise<ShellResult>;
  readFile(relative: string): Promise<string>;
  writeFile(relative: string, content: string): Promise<number>;
  listFiles(relative: string): Promise<Array<{ name: string; type: 'dir' | 'file' | 'link' }>>;
};

export type RememberItem = {
  key: string;
  content: string;
  kind?: 'fact' | 'preference' | 'decision' | 'procedure' | 'episode';
  tags?: string[];
};

export type ToolExecution = {
  content: string;
  /** finish 工具被调用时返回，运行时据此结束本轮。 */
  finish?: { summary: string; outcome: string; remember?: RememberItem[] };
  /** 写请求结果未知：本轮必须以 outcome_unknown 结束。 */
  uncertain?: string;
};

export type ToolLog = (level: 'debug' | 'info' | 'warn' | 'error', text: string) => void;

export type ToolOptions = {
  /** 任务/文件/知识工具的后端；独立运行没有它时只暴露本地原语。 */
  backend?: ToolBackend;
  runDir: string;
  runId: string;
  definition: EmbeddedAgentDefinition;
  /** 实际生效的工具清单；缺省用 definition.tools。 */
  tools?: readonly EmbeddedTool[];
  /** 本地原语的执行位置；缺省在当前进程的 runDir 内。 */
  local?: LocalToolExecutor;
  log: ToolLog;
  /** 记忆/会话/团队经验；由三个入口统一注入。 */
  memory?: MemoryStore;
  events?: SessionEventLog;
  sessionIndex?: SessionIndex;
  experience?: ExperienceClient;
  agentId?: string;
  sessionId?: string;
  turnId?: string;
  taskId?: string | null;
};

type Schema = Record<string, unknown>;

function schema(properties: Schema, required: string[] = Object.keys(properties)): Schema {
  return { type: 'object', properties, required, additionalProperties: false };
}

export const TOOL_SPECS: Record<EmbeddedTool, ToolSpec> = {
  task_get: {
    name: 'task_get',
    description: '读取一个任务的详情：验收条件、子任务、事件与材料清单。',
    parameters: schema({ taskId: { type: 'string', description: '任务 id' } }),
  },
  subtask_inbox: {
    name: 'subtask_inbox',
    description: '列出分配给我、依赖已满足、可以处理的子任务（邀请、进行中、被退回）。与外部智能体的 /v1/inbox 一致。',
    parameters: schema({}, []),
  },
  task_accept: {
    name: 'task_accept',
    description: '接下分配给你的子任务。接活前应先看任务详情确认能做。',
    parameters: schema({
      subtaskId: { type: 'string' },
      version: { type: 'integer', description: '可选：当前版本号，用于并发保护' },
    }, ['subtaskId']),
  },
  task_progress: {
    name: 'task_progress',
    description: '汇报进展。若等待外部条件，用这个而不是猜测结果。',
    parameters: schema({
      subtaskId: { type: 'string' },
      text: { type: 'string', description: '给人看的一句话进展' },
      version: { type: 'integer' },
    }, ['subtaskId', 'text']),
  },
  task_submit: {
    name: 'task_submit',
    description:
      '提交子任务结果。result 是结构化对象：summary 或 quantity 至少一个，另需 source（结果来源）与 observedAt（UTC 时间）。',
    parameters: schema({
      subtaskId: { type: 'string' },
      result: { type: 'object', description: '结构化结果，例如 {summary, artifacts, checks}' },
      version: { type: 'integer' },
    }, ['subtaskId', 'result']),
  },
  subtask_reject: {
    name: 'subtask_reject',
    description: '拒绝分配给我的子任务并说明原因。资料不足或做不了时用它，而不是编造结果。',
    parameters: schema({
      subtaskId: { type: 'string' },
      reason: { type: 'string', description: '拒绝原因，给人看' },
      version: { type: 'integer' },
    }, ['subtaskId', 'reason']),
  },
  task_comment: {
    name: 'task_comment',
    description: '在任务评论区留言，可 @ 人（body 里写 @名称 或 @主体 id）。',
    parameters: schema({
      taskId: { type: 'string' },
      body: { type: 'string', description: '留言正文，最长 20000 字' },
    }),
  },
  task_comments: {
    name: 'task_comments',
    description: '读取任务评论流，用于接手前了解上下文。',
    parameters: schema({
      taskId: { type: 'string' },
      limit: { type: 'integer', description: '可选，默认 200，最多 500' },
    }, ['taskId']),
  },
  offer_list: {
    name: 'offer_list',
    description: '列出开放池中与我能力匹配、尚未被认领的子任务。',
    parameters: schema({}, []),
  },
  offer_claim: {
    name: 'offer_claim',
    description: '认领开放池里的一个子任务，返回新建的子任务 id；之后照常 accept / submit。',
    parameters: schema({ offerId: { type: 'string', description: '开放子任务 id' } }),
  },
  task_files: {
    name: 'task_files',
    description: '列出任务空间里的文件（输入材料、中间产物与成果）。',
    parameters: schema({ taskId: { type: 'string' } }),
  },
  file_download: {
    name: 'file_download',
    description: '把任务空间里的文件下载到本次运行的工作目录，返回本地路径与大小。',
    parameters: schema({
      taskId: { type: 'string' },
      fileId: { type: 'string' },
      path: { type: 'string', description: '可选：保存到工作目录里的相对路径，默认使用文件名' },
    }, ['taskId', 'fileId']),
  },
  file_upload: {
    name: 'file_upload',
    description: '把工作目录里的文件上传到任务空间（单文件 ≤256 KiB），可作为成果或证据。',
    parameters: schema({
      taskId: { type: 'string' },
      path: { type: 'string', description: '工作目录里要上传的文件路径' },
      name: { type: 'string', description: '可选：上传后的文件名，默认用路径最后一段' },
      mime: { type: 'string' },
      kind: {
        type: 'string',
        enum: ['input', 'intermediate', 'output', 'evidence', 'attachment'],
      },
      subtaskId: { type: 'string', description: '可选：关联的子任务' },
    }, ['taskId', 'path']),
  },
  knowledge_search: {
    name: 'knowledge_search',
    description: '在公司知识库里检索，返回带版本、证据等级与有效期的团队经验条目。',
    parameters: schema({
      query: { type: 'string' },
      limit: { type: 'integer', description: '可选，默认 10，最多 20' },
    }, ['query']),
  },
  knowledge_get: {
    name: 'knowledge_get',
    description: '按 reference（knowledge:<id>:<version>）读取一条团队经验的正文与适用条件。',
    parameters: schema({
      reference: { type: 'string', description: 'knowledge:<id>:<version>' },
    }),
  },
  knowledge_cite: {
    name: 'knowledge_cite',
    description: '把一条团队经验引用到当前任务；任务上下文里会记录版本。',
    parameters: schema({
      reference: { type: 'string', description: 'knowledge:<id>:<version>' },
      taskId: { type: 'string', description: '可选，默认使用当前任务' },
    }),
  },
  knowledge_contribute: {
    name: 'knowledge_contribute',
    description: '把本轮可复用的经验提交为团队经验候选；只生成 candidate，必须由人审核发布。',
    parameters: schema({
      taskId: { type: 'string', description: '已完成或已验收的任务 id' },
      content: { type: 'string', description: '可复用的经验正文' },
      title: { type: 'string' },
      summary: { type: 'string' },
      conditions: { type: 'string', description: '适用条件' },
      kind: { type: 'string', enum: ['experience', 'checklist', 'decision', 'playbook'] },
      tags: { type: 'array', items: { type: 'string' } },
    }, ['taskId', 'content']),
  },
  memory_search: {
    name: 'memory_search',
    description: '检索自己的长期记忆；返回带证据等级的条目。省略 query 时列出最近的记忆。',
    parameters: schema({
      query: { type: 'string' },
      kind: { type: 'string', enum: MEMORY_KINDS },
      limit: { type: 'integer', description: '默认 10，最多 20' },
    }, []),
  },
  memory_forget: {
    name: 'memory_forget',
    description: '软删除一条长期记忆；历史 revision 保留。置顶记忆需要先取消置顶。',
    parameters: schema({
      key: { type: 'string' },
      reason: { type: 'string' },
    }),
  },
  session_search: {
    name: 'session_search',
    description: '跨会话搜索过去的摘要；只返回摘要片段，不返回其他会话的完整事件。',
    parameters: schema({
      query: { type: 'string' },
      limit: { type: 'integer', description: '默认 10，最多 20' },
    }, ['query']),
  },
  session_peek: {
    name: 'session_peek',
    description: '查看某个会话最近的事件（脱敏，最多 20 条），用于确认当时发生了什么。',
    parameters: schema({
      sessionId: { type: 'string' },
      limit: { type: 'integer', description: '默认 20，最多 20' },
    }, ['sessionId']),
  },
  shell: {
    name: 'shell',
    description:
      '在本次运行的沙箱工作目录里执行 shell 命令。环境里没有平台令牌和模型密钥；超时与输出长度都有限制。',
    parameters: schema({
      command: { type: 'string', description: '在 /bin/sh -lc 下执行的命令，最多 8000 字符' },
    }),
  },
  read_file: {
    name: 'read_file',
    description: '读取工作目录里的文本文件（最多 256 KiB）。',
    parameters: schema({ path: { type: 'string', description: '相对工作目录的路径' } }),
  },
  write_file: {
    name: 'write_file',
    description: '在工作目录里写入文本文件。目录外的路径会被拒绝。',
    parameters: schema({
      path: { type: 'string' },
      content: { type: 'string' },
    }),
  },
  list_files: {
    name: 'list_files',
    description: '列出工作目录（或其中的子目录）条目。',
    parameters: schema({ path: { type: 'string', description: '可选，默认 "."' } }, []),
  },
  finish: {
    name: 'finish',
    description: '结束本轮。调用前应已经把该做的提交、留言做完。可选地留下最多 3 条长期记忆。',
    parameters: schema({
      summary: { type: 'string', description: '这一轮做了什么，一到三句话' },
      outcome: {
        type: 'string',
        enum: ['done', 'nothing_to_do', 'blocked'],
        description: 'done=处理完毕；nothing_to_do=消息不需要行动；blocked=需要人参与',
      },
      remember: {
        type: 'array',
        maxItems: 3,
        description: '可选：最多 3 条值得跨会话保留的判断，每条不超过 1000 字符',
        items: {
          type: 'object',
          properties: {
            key: { type: 'string', description: '稳定的记忆键，例如 project.test-command' },
            content: { type: 'string', description: '一条可复用的判断' },
            kind: { type: 'string', enum: MEMORY_KINDS },
            tags: { type: 'array', items: { type: 'string' } },
          },
          required: ['key', 'content'],
          additionalProperties: false,
        },
      },
    }, ['summary']),
  },
  ...ANP_TOOL_SPECS,
  ...SUBAGENT_TOOL_SPECS,
  ...SCHEDULE_TOOL_SPECS,
  ...NET_TOOL_SPECS,
};

function textOf(input: Record<string, unknown>, key: string, max = 20_000): string {
  const value = input[key];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`缺少参数 ${key}`);
  if (value.length > max) throw new Error(`参数 ${key} 过长（上限 ${max}）`);
  return value;
}

function optionalVersion(input: Record<string, unknown>): number | undefined {
  const value = input.version;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error('参数 version 必须是整数');
  }
  return value;
}

function render(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return truncateResult(text);
}

/** 下载文件名来自平台，落到本地前去掉路径分隔符、控制字符与前导点。 */
function safeName(name: string): string {
  const cleaned = name
    .replace(/[\/\\\u0000-\u001f\u007f]+/g, '_')
    .replace(/^\.+/, '')
    .trim();
  return cleaned.slice(0, 120) || 'download.bin';
}

function memoryView(row: Memory): Record<string, unknown> {
  return {
    key: row.key,
    kind: row.kind,
    maturity: row.maturity,
    evidence: evidenceLevel(row.maturity),
    confidence: Number(row.confidence.toFixed(2)),
    content: row.content,
    tags: row.tags,
    pinned: row.pinned,
    ...(row.conditions ? { conditions: row.conditions } : {}),
    sourceSessionId: row.source_session_id,
    useCount: row.use_count,
    successCount: row.success_count,
    updatedAt: row.updated_at,
    ...(row.archived_at ? { archivedAt: row.archived_at } : {}),
  };
}

function compactPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === 'string') {
      out[key] = value.length > 300 ? `${value.slice(0, 300)}…` : value;
    } else if (Array.isArray(value)) {
      out[key] = value.slice(0, 5);
    } else if (value && typeof value === 'object') {
      out[key] = '[object]';
    } else {
      out[key] = value;
    }
  }
  return out;
}

function rememberOf(input: Record<string, unknown>): RememberItem[] | undefined {
  if (!Array.isArray(input.remember)) return undefined;
  const items: RememberItem[] = [];
  for (const raw of input.remember.slice(0, 3)) {
    if (!raw || typeof raw !== 'object') continue;
    const record = raw as Record<string, unknown>;
    if (typeof record.key !== 'string' || typeof record.content !== 'string') continue;
    const kind = typeof record.kind === 'string' && (MEMORY_KINDS as readonly string[]).includes(record.kind)
      ? (record.kind as RememberItem['kind'])
      : undefined;
    const tags = Array.isArray(record.tags)
      ? record.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 12)
      : undefined;
    items.push({
      key: record.key.slice(0, 64),
      content: record.content.slice(0, 2_000),
      ...(kind ? { kind } : {}),
      ...(tags && tags.length > 0 ? { tags } : {}),
    });
  }
  return items.length > 0 ? items : undefined;
}

export function createTools(options: ToolOptions) {
  const { backend, runDir, runId, definition, log } = options;
  const enabledTools = options.tools ?? definition.tools;
  const enabled = new Set<string>(enabledTools);
  const specs = enabledTools.map(tool => TOOL_SPECS[tool]).filter((spec): spec is ToolSpec => Boolean(spec));
  const local: LocalToolExecutor = options.local ?? {
    shell: input => runShell({ ...input, cwd: runDir }),
    readFile: relative => readFileInside(runDir, relative),
    writeFile: (relative, content) => writeFileInside(runDir, relative, content),
    listFiles: relative => listFilesInside(runDir, relative),
  };

  const platform = (): ToolBackend => {
    if (!backend) throw new Error('当前运行环境没有平台工具后端');
    return backend;
  };

  const memoryStore = (): { memory: MemoryStore; agentId: string } => {
    if (!options.memory) throw new Error('当前运行环境没有记忆存储');
    const agentId = options.agentId ?? options.sessionId;
    if (!agentId) throw new Error('当前运行环境缺少 agentId，无法读写记忆');
    return { memory: options.memory, agentId };
  };

  const sourceSeq = (): number | undefined => {
    if (!options.events || !options.sessionId) return undefined;
    return options.events.lastSeq(options.sessionId);
  };

  const operation = (call: ToolCall, suffix = '') => `run:${runId}:${call.id}${suffix ? `:${suffix}` : ''}`;

  async function execute(call: ToolCall): Promise<ToolExecution> {
    if (!enabled.has(call.name)) {
      return { content: `工具 ${call.name} 没有在这一轮启用` };
    }
    const input = call.input ?? {};
    try {
      switch (call.name) {
        case 'task_get': {
          const taskId = textOf(input, 'taskId', 128);
          const task = await platform().task(taskId);
          return {
            content: render({
              task: task.task,
              subtasks: task.subtasks,
              coordinators: task.coordinators,
              materials: task.materials,
            }),
          };
        }
        case 'subtask_inbox':
          return { content: render(await platform().inbox()) };
        case 'task_accept':
          return {
            content: render(
              await platform().accept(textOf(input, 'subtaskId', 128), operation(call), optionalVersion(input)),
            ),
          };
        case 'task_progress':
          return {
            content: render(
              await platform().progress(
                textOf(input, 'subtaskId', 128),
                textOf(input, 'text', 4_000),
                operation(call),
                optionalVersion(input),
              ),
            ),
          };
        case 'task_submit': {
          const result = input.result;
          if (!result || typeof result !== 'object' || Array.isArray(result)) {
            throw new Error('参数 result 必须是对象');
          }
          return {
            content: render(
              await platform().submit(
                textOf(input, 'subtaskId', 128),
                result as Record<string, unknown>,
                operation(call),
                optionalVersion(input),
              ),
            ),
          };
        }
        case 'subtask_reject':
          return {
            content: render(
              await platform().reject(
                textOf(input, 'subtaskId', 128),
                textOf(input, 'reason', 4_000),
                operation(call),
                optionalVersion(input),
              ),
            ),
          };
        case 'task_comment':
          return {
            content: render(
              await platform().comment(textOf(input, 'taskId', 128), textOf(input, 'body', 20_000), operation(call)),
            ),
          };
        case 'task_comments': {
          const limit = input.limit === undefined ? 200 : Number(input.limit);
          if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('limit 必须是 1..500 的整数');
          return { content: render(await platform().comments(textOf(input, 'taskId', 128), limit)) };
        }
        case 'offer_list':
          return { content: render(await platform().openOffers()) };
        case 'offer_claim':
          return {
            content: render(await platform().claimOffer(textOf(input, 'offerId', 128), operation(call))),
          };
        case 'task_files':
          return { content: render(await platform().taskFiles(textOf(input, 'taskId', 128))) };
        case 'file_download': {
          const downloaded = await platform().downloadTaskFile(
            textOf(input, 'taskId', 128),
            textOf(input, 'fileId', 128),
          );
          const path = input.path === undefined ? safeName(downloaded.file.name) : textOf(input, 'path', 1_000);
          const bytes = await writeBytesInside(runDir, path, Buffer.from(downloaded.data, 'base64'));
          return {
            content: render({ path, bytes, name: downloaded.file.name, mime: downloaded.file.mime }),
          };
        }
        case 'file_upload': {
          const path = textOf(input, 'path', 1_000);
          const bytes = await readBytesInside(runDir, path);
          const name = input.name === undefined ? path.split('/').pop()! : textOf(input, 'name', 200);
          const mime = input.mime === undefined ? undefined : textOf(input, 'mime', 200);
          const kind = input.kind === undefined ? undefined : textOf(input, 'kind', 40);
          const subtaskId = input.subtaskId === undefined ? undefined : textOf(input, 'subtaskId', 128);
          return {
            content: render(
              await platform().uploadTaskFile(
                textOf(input, 'taskId', 128),
                {
                  name,
                  ...(mime === undefined ? {} : { mime }),
                  ...(kind === undefined ? {} : { kind }),
                  ...(subtaskId === undefined ? {} : { subtaskId }),
                  data: bytes.toString('base64'),
                },
                operation(call),
              ),
            ),
          };
        }
        case 'knowledge_search': {
          const limit = input.limit === undefined ? 10 : Number(input.limit);
          if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('limit 必须是 1..50 的整数');
          const query = textOf(input, 'query', 500);
          if (options.experience) {
            const found = await options.experience.search(query, { limit });
            return {
              content: render({
                items: found.items.map(item => ({
                  reference: item.reference,
                  id: item.id,
                  version: item.version,
                  title: item.title,
                  summary: item.summary,
                  conditions: item.conditions,
                  kind: item.kind,
                  evidence: item.evidence,
                  state: item.state,
                  expiresAt: item.expiresAt,
                  reviewerId: item.reviewerId,
                  stale: item.stale,
                  cachedAt: item.cachedAt,
                })),
                degraded: found.degraded,
                note: found.note,
                fetchedAt: found.fetchedAt,
              }),
            };
          }
          const found = await platform().searchKnowledge(query, limit);
          return { content: render(found) };
        }
        case 'knowledge_get': {
          if (!options.experience) throw new Error('当前运行环境没有团队经验缓存');
          const parsed = parseKnowledgeReference({ reference: textOf(input, 'reference', 200) });
          if (!parsed) throw new Error('reference 必须是 knowledge:<id>:<version>');
          const entry = await options.experience.get(parsed.id, parsed.version);
          if (!entry) {
            return {
              content: render({
                found: false,
                note: '没有可用的团队经验：可能已撤销、已过期，或当前平台不可用且无缓存。不要编造。',
              }),
            };
          }
          return { content: render({ found: true, ...entry }) };
        }
        case 'knowledge_cite': {
          if (!options.experience) throw new Error('当前运行环境没有团队经验缓存');
          if (!options.sessionId || !options.turnId) throw new Error('缺少会话上下文，无法记录引用');
          const parsed = parseKnowledgeReference({ reference: textOf(input, 'reference', 200) });
          if (!parsed) throw new Error('reference 必须是 knowledge:<id>:<version>');
          const taskId = typeof input.taskId === 'string' ? input.taskId : options.taskId ?? undefined;
          const cited = await options.experience.cite({
            knowledgeId: parsed.id,
            version: parsed.version,
            sessionId: options.sessionId,
            turnId: options.turnId,
            taskId: taskId ?? null,
          });
          options.events?.tryAppend({
            sessionId: options.sessionId,
            turnId: options.turnId,
            kind: 'knowledge.cited',
            payload: {
              reference: cited.reference,
              cited: cited.cited,
              taskId: taskId ?? null,
              ...(cited.error ? { error: cited.error } : {}),
            },
          });
          return { content: render(cited) };
        }
        case 'knowledge_contribute': {
          if (!options.experience) throw new Error('当前运行环境没有团队经验缓存');
          const result = await options.experience.contribute({
            taskId: textOf(input, 'taskId', 128),
            knowledge: {
              content: textOf(input, 'content', 8_000),
              ...(typeof input.title === 'string' ? { title: input.title.slice(0, 200) } : {}),
              ...(typeof input.summary === 'string' ? { summary: input.summary.slice(0, 500) } : {}),
              ...(typeof input.conditions === 'string' ? { conditions: input.conditions.slice(0, 500) } : {}),
              ...(typeof input.kind === 'string' ? { kind: input.kind } : {}),
              ...(Array.isArray(input.tags)
                ? { tags: input.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 12) }
                : {}),
            },
          });
          return {
            content: render({
              ok: result.ok,
              ...(result.candidate ? { candidate: result.candidate } : {}),
              ...(result.error ? { error: result.error } : {}),
              note: result.ok
                ? '已提交团队经验候选；它需要人工审核后才能发布。'
                : '候选提交失败；不要重试发布或撤销。',
            }),
          };
        }
        case 'memory_search': {
          const { memory, agentId } = memoryStore();
          const limit = input.limit === undefined ? 10 : Number(input.limit);
          if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('limit 必须是 1..20 的整数');
          const query = typeof input.query === 'string' ? input.query : '';
          if (query.trim()) {
            const hits = memory.search(agentId, query, { limit });
            return { content: render(hits.map(hit => ({ score: hit.score, ...memoryView(hit.memory) }))) };
          }
          const kind = typeof input.kind === 'string' ? input.kind : undefined;
          const rows = memory.list(agentId, {
            limit,
            ...(kind && (MEMORY_KINDS as readonly string[]).includes(kind)
              ? { kind: kind as (typeof MEMORY_KINDS)[number] }
              : {}),
          });
          return { content: render(rows.map(memoryView)) };
        }
        case 'memory_get': {
          const { memory, agentId } = memoryStore();
          const key = textOf(input, 'key', 256);
          const row = memory.getByKey(agentId, key, { includeArchived: true });
          return { content: render(row ? { ...memoryView(row), revisions: memory.revisions(row.id, 5) } : { key, value: null }) };
        }
        case 'memory_set': {
          const { memory, agentId } = memoryStore();
          const key = textOf(input, 'key', 256);
          const content = typeof input.content === 'string'
            ? input.content
            : typeof input.value === 'string'
              ? input.value
              : JSON.stringify(input.value ?? '');
          const kind = typeof input.kind === 'string' ? input.kind : undefined;
          const result = memory.write({
            agentId,
            key,
            content,
            ...(kind && (MEMORY_KINDS as readonly string[]).includes(kind)
              ? { kind: kind as (typeof MEMORY_KINDS)[number] }
              : {}),
            ...(Array.isArray(input.tags)
              ? { tags: input.tags.filter((tag): tag is string => typeof tag === 'string') }
              : {}),
            ...(typeof input.conditions === 'string' ? { conditions: input.conditions } : {}),
            sourceSessionId: options.sessionId ?? 'tool',
            sourceTurnId: options.turnId ?? null,
            sourceEventSeq: sourceSeq() ?? null,
            actor: 'agent',
          });
          options.events?.tryAppend({
            sessionId: options.sessionId ?? 'tool',
            turnId: options.turnId ?? null,
            kind: 'memory.written',
            payload: { key: result.memory.key, created: result.created, sourceEventSeq: sourceSeq() ?? null },
          });
          return {
            content: render({
              saved: true,
              unchanged: result.unchanged,
              key: result.memory.key,
              maturity: result.memory.maturity,
            }),
          };
        }
        case 'memory_forget': {
          const { memory, agentId } = memoryStore();
          const key = textOf(input, 'key', 256);
          const reason = typeof input.reason === 'string' ? input.reason.slice(0, 200) : 'agent 主动遗忘';
          try {
            const archived = memory.archive(agentId, key, reason, 'agent');
            return { content: render({ archived, key }) };
          } catch (error) {
            return { content: `无法删除 ${key}：${error instanceof Error ? error.message : String(error)}` };
          }
        }
        case 'session_search': {
          if (!options.sessionIndex) throw new Error('当前运行环境没有会话索引');
          const limit = input.limit === undefined ? 10 : Number(input.limit);
          if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('limit 必须是 1..20 的整数');
          const hits = options.sessionIndex.search(textOf(input, 'query', 500), { limit });
          return {
            content: render({
              sessions: hits,
              note: '这些是会话摘要；需要细节时用 session_peek 查看脱敏事件。',
            }),
          };
        }
        case 'session_peek': {
          if (!options.events) throw new Error('当前运行环境没有会话事件日志');
          const sessionId = textOf(input, 'sessionId', 200);
          const limit = input.limit === undefined ? 20 : Number(input.limit);
          if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('limit 必须是 1..20 的整数');
          const all = options.events.read(sessionId, { limit: 1000 });
          const events = all.slice(-limit).map(event => ({
            seq: event.seq,
            kind: event.kind,
            turnId: event.turn_id,
            actor: event.actor,
            at: event.at,
            payload: compactPayload(event.payload),
          }));
          return { content: render({ sessionId, events }) };
        }
        case 'shell': {
          if (!definition.sandbox.shell) throw new Error('这一轮没有开启 shell');
          const result = await local.shell({
            command: textOf(input, 'command', 8_000),
            timeoutMs: definition.sandbox.shellTimeoutMs,
            maxOutputBytes: definition.sandbox.maxOutputBytes,
          });
          return {
            content: render({
              exitCode: result.exitCode,
              stdout: result.stdout,
              stderr: result.stderr,
              timedOut: result.timedOut,
              truncated: result.truncated,
            }),
          };
        }
        case 'read_file':
          return { content: render(await local.readFile(textOf(input, 'path', 1_000))) };
        case 'write_file': {
          const bytes = await local.writeFile(textOf(input, 'path', 1_000), textOf(input, 'content'));
          return { content: `已写入 ${bytes} 字节` };
        }
        case 'list_files': {
          const entries = await local.listFiles(input.path === undefined ? '.' : textOf(input, 'path', 1_000));
          return { content: render(entries) };
        }
        case 'finish':
          return {
            content: '本轮结束。',
            finish: {
              summary: textOf(input, 'summary', 2_000),
              outcome: typeof input.outcome === 'string' ? input.outcome : 'done',
              ...(rememberOf(input) ? { remember: rememberOf(input) } : {}),
            },
          };
        case 'anp_send':
        case 'anp_reply':
        case 'anp_list_messages':
        case 'anp_get_message':
        case 'list_agents':
        case 'agent_status':
        case 'spawn_agent':
        case 'schedule_create':
        case 'schedule_cancel':
        case 'list_schedules':
        case 'http_fetch':
        case 'finish_turn':
          return { content: `工具 ${call.name} 只在 router 常驻模式下可用` };
        default:
          return { content: `未知工具 ${call.name}` };
      }
    } catch (error) {
      if (error instanceof CollabError && error.uncertain) {
        log('error', `工具 ${call.name} 的结果未知：${error.message}`);
        return { content: `写请求结果未知：${error.message}`, uncertain: error.message };
      }
      const message = error instanceof Error ? error.message : String(error);
      log('warn', `工具 ${call.name} 失败：${message}`);
      return { content: `工具执行失败：${message}` };
    }
  }

  return { specs, execute };
}
