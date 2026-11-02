/**
 * ANP 协作工具：在 thread 里发消息、回复、查历史，以及读写自己的长期笔记。
 *
 * 工具本身不碰网络；发送交给调用方注入的 `send`，这样 router 能在投递后
 * 唤醒目标 host，测试也能用进程内路径。
 */

import type { AnpPayload } from '../anp/client.ts';
import type { ToolSpec } from '../brains/types.ts';
import type { EmbeddedTool } from '../definition.ts';
import type { AgentStore, MessageRow } from '../store/agent-store.ts';
import type { ToolExecution } from '../tools.ts';

export type AnpSendToolInput = {
  to: string;
  threadId: string;
  payload: AnpPayload;
  replyTo?: string | null;
};

export type AnpSendToolResult = {
  messageId: string;
  threadId: string;
  targetDid: string;
  queued: boolean;
};

export type AnpToolContext = {
  agentId: string;
  threadId: string;
  triggerMessageId: string | null;
  store: AgentStore;
  send: (input: AnpSendToolInput) => Promise<AnpSendToolResult>;
  markReplied: () => void;
};

type Schema = Record<string, unknown>;

function schema(properties: Schema, required: string[] = Object.keys(properties)): Schema {
  return { type: 'object', properties, required, additionalProperties: false };
}

function textOf(input: Record<string, unknown>, key: string, max = 20_000): string {
  const value = input[key];
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`缺少参数 ${key}`);
  if (value.length > max) throw new Error(`参数 ${key} 过长（上限 ${max}）`);
  return value;
}

function optionalText(input: Record<string, unknown>, key: string, max = 20_000): string | undefined {
  const value = input[key];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error(`参数 ${key} 必须是字符串`);
  if (value.length > max) throw new Error(`参数 ${key} 过长（上限 ${max}）`);
  return value;
}

function render(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 6_000 ? `${text.slice(0, 6_000)}\n…（已截断）` : text;
}

function messageView(row: MessageRow): Record<string, unknown> {
  let payload: Record<string, unknown> = {};
  try {
    const body = JSON.parse(row.body_json) as { payload?: Record<string, unknown> };
    payload = body.payload ?? {};
  } catch {
    payload = {};
  }
  return {
    messageId: row.message_id,
    threadId: row.thread_id,
    direction: row.direction,
    from: row.sender_did,
    to: row.target_did,
    type: payload.type ?? row.content_type,
    title: payload.title,
    text: payload.text,
    replyTo: row.reply_to,
    createdAt: row.created_at,
  };
}

export const ANP_TOOL_SPECS = {
  anp_send: {
    name: 'anp_send',
    description:
      '向本机 router 托管的 agent 发一条 ANP 消息。to 可以写 agent id、agent:<id> 或它的完整 DID；默认发在当前 thread。v1 未启用跨域 relay，外部 DID 会被拒绝。',
    parameters: schema({
      to: { type: 'string', description: '目标 agent id、agent:<id> 或 did:...' },
      text: { type: 'string', description: '消息正文' },
      threadId: { type: 'string', description: '可选：目标 thread，默认当前 thread' },
      type: {
        type: 'string',
        description: '可选：消息类型，默认 anp.chat.message；派活时用 anp.task.request',
      },
      title: { type: 'string' },
      data: { type: 'object', description: '可选：结构化附注' },
      replyTo: { type: 'string', description: '可选：要回复的消息 id' },
    }, ['to', 'text']),
  },
  anp_reply: {
    name: 'anp_reply',
    description: '回复触发本轮的那条 ANP 消息，发在同一个 thread。',
    parameters: schema({ text: { type: 'string', description: '回复正文' } }),
  },
  anp_list_messages: {
    name: 'anp_list_messages',
    description: '列出一个 thread 里最近的 ANP 消息（收发都包含）。',
    parameters: schema({
      threadId: { type: 'string', description: '可选，默认当前 thread' },
      limit: { type: 'integer', description: '可选，默认 20，最多 100' },
    }, []),
  },
  anp_get_message: {
    name: 'anp_get_message',
    description: '按 id 读取自己 thread 里的一条 ANP 消息。',
    parameters: schema({ messageId: { type: 'string' } }),
  },
  memory_get: {
    name: 'memory_get',
    description: '读取自己的长期笔记（跨 thread 保留）。没有时返回 null。',
    parameters: schema({ key: { type: 'string', description: '笔记键，最多 256 字符' } }),
  },
  memory_set: {
    name: 'memory_set',
    description: '写入自己的长期笔记（覆盖同名键）。',
    parameters: schema({ key: { type: 'string' }, value: { type: 'string' } }),
  },
  finish_turn: {
    name: 'finish_turn',
    description: '结束本轮并给出摘要；与 finish 等价，便于 ANP 运行区分。',
    parameters: schema({
      summary: { type: 'string', description: '这一轮做了什么' },
      outcome: {
        type: 'string',
        enum: ['done', 'nothing_to_do', 'blocked'],
      },
    }, ['summary']),
  },
} satisfies Partial<Record<EmbeddedTool, ToolSpec>>;

export async function executeAnpTool(
  name: string,
  input: Record<string, unknown>,
  context: AnpToolContext,
): Promise<ToolExecution | null> {
  switch (name) {
    case 'anp_send': {
      const to = textOf(input, 'to', 2_000);
      const text = textOf(input, 'text', 20_000);
      const threadId = optionalText(input, 'threadId', 200) ?? context.threadId;
      const type = optionalText(input, 'type', 120) ?? 'anp.chat.message';
      const title = optionalText(input, 'title', 200);
      const replyTo = optionalText(input, 'replyTo', 200) ?? null;
      const result = await context.send({
        to,
        threadId,
        payload: {
          type,
          text,
          ...(title ? { title } : {}),
          ...('data' in input ? { data: input.data } : {}),
        },
        replyTo,
      });
      return { content: render({ sent: true, ...result }) };
    }

    case 'anp_reply': {
      const text = textOf(input, 'text', 20_000);
      const triggerId = context.triggerMessageId;
      if (!triggerId) return { content: '这一轮没有可回复的触发消息' };
      const trigger = context.store.inboxByMessage(triggerId);
      const targetDid = trigger?.sender_did;
      if (!targetDid) return { content: '触发消息没有发送方 DID，无法回复' };
      const result = await context.send({
        to: targetDid,
        threadId: context.threadId,
        payload: { type: 'anp.chat.message', text },
        replyTo: triggerId,
      });
      context.markReplied();
      return { content: render({ replied: true, ...result }) };
    }

    case 'anp_list_messages': {
      const threadId = optionalText(input, 'threadId', 200) ?? context.threadId;
      const limitRaw = input.limit === undefined ? 20 : Number(input.limit);
      if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > 100) {
        throw new Error('limit 必须是 1..100 的整数');
      }
      // listMessages 按时间正序返回；这里给模型看最近的消息。
      const rows = context.store.listMessages(threadId, limitRaw);
      return { content: render(rows.map(messageView)) };
    }

    case 'anp_get_message': {
      const messageId = textOf(input, 'messageId', 200);
      const row = context.store.getMessage(messageId);
      if (!row) return { content: `消息 ${messageId} 不存在` };
      return { content: render(messageView(row)) };
    }

    case 'memory_get': {
      const key = textOf(input, 'key', 256);
      return { content: render({ key, value: context.store.getNote(key) ?? null }) };
    }

    case 'memory_set': {
      const key = textOf(input, 'key', 256);
      const value = typeof input.value === 'string' ? input.value : JSON.stringify(input.value ?? null);
      if (value.length > 64_000) throw new Error('笔记内容过长（上限 64000 字符）');
      context.store.setNote(key, value);
      return { content: render({ saved: true, key, bytes: Buffer.byteLength(value, 'utf8') }) };
    }

    case 'finish_turn': {
      const summary = textOf(input, 'summary', 2_000);
      const outcome = typeof input.outcome === 'string' ? input.outcome : 'done';
      return { content: '本轮结束。', finish: { summary, outcome } };
    }

    default:
      return null;
  }
}
