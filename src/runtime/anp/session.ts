/**
 * ANP 的长期 Turn：一个 Session 绑定一个 thread，workspace 跨 turn 保留。
 *
 * 与 AgentSession 的区别只在「目录与信箱」：对话历史来自 agent.db.messages，
 * 不删除工作目录；模型循环本身复用 brain-loop。
 */

import type { ChatMessage } from '../../brains/types.ts';
import type { MailEnvelope } from '../../client.ts';
import type { EmbeddedAgentDefinition, EmbeddedTool } from '../../definition.ts';
import { isLocalTool } from '../../definition.ts';
import { createTools } from '../../tools.ts';
import type { AgentRuntime } from '../agent.ts';
import { runBrainLoop, type BrainLoopTools } from '../brain-loop.ts';
import { systemPromptFor, writeAgentsFile } from '../prompt.ts';
import type { SessionResult, SessionTask } from '../types.ts';
import type { AgentStore } from '../../store/agent-store.ts';
import type { SessionRow } from '../../store/router-store.ts';
import type { AnpMailbox } from './mailbox.ts';
import { ANP_ENVIRONMENT, buildThreadContext, ensureThreadWorkspace } from './context.ts';
import type { AnpTurnLedger } from './ledger.ts';

const MAX_MESSAGES = 5;

export type AnpTurnSessionOptions = {
  runtime: AgentRuntime;
  definition?: EmbeddedAgentDefinition;
  store: AgentStore;
  mailbox: AnpMailbox;
  ledger: AnpTurnLedger;
  session: SessionRow;
  turnId: string;
  runId: string;
  threadId: string;
  triggerMessageId?: string | null;
  maxMessages?: number;
  /** 目标 DID 是否由本 router 托管；缺省视为可投递。 */
  canDeliver?: (did: string) => boolean;
  log?: (level: 'info' | 'warn', text: string) => void;
  /** 后续阶段注入 ANP/子 agent/联网工具；缺省只用本地原语。 */
  toolFactory?: (input: {
    runDir: string;
    turnId: string;
    definition: EmbeddedAgentDefinition;
    threadId: string;
    triggerMessageId: string | null;
    store: AgentStore;
    mailbox: AnpMailbox;
    markReplied: () => void;
  }) => BrainLoopTools;
};

export class AnpTurnSession implements SessionTask {
  readonly runId: string;
  readonly turnId: string;
  readonly sessionId: string;
  readonly threadId: string;

  private readonly runtime: AgentRuntime;
  private readonly definition: EmbeddedAgentDefinition;
  private readonly store: AgentStore;
  private readonly mailbox: AnpMailbox;
  private readonly ledger: AnpTurnLedger;
  private readonly session: SessionRow;
  private readonly maxMessages: number;
  private readonly toolFactory: AnpTurnSessionOptions['toolFactory'];
  private readonly triggerMessageId: string | null;
  private readonly canDeliver: (did: string) => boolean;
  private readonly log: (level: 'info' | 'warn', text: string) => void;
  private readonly deadline = new AbortController();

  private timer: NodeJS.Timeout | null = null;
  private timedOut = false;
  private interrupted: string | null = null;
  private mailSessionId: string | null = null;
  private toolExecuted = false;
  private settled = false;
  private replied = false;
  private readonly pulled: MailEnvelope[] = [];

  constructor(options: AnpTurnSessionOptions) {
    this.runtime = options.runtime;
    this.definition = options.definition ?? options.runtime.definition;
    this.store = options.store;
    this.mailbox = options.mailbox;
    this.ledger = options.ledger;
    this.session = options.session;
    this.runId = options.runId;
    this.turnId = options.turnId;
    this.threadId = options.threadId;
    this.sessionId = options.session.session_id;
    this.maxMessages = options.maxMessages ?? MAX_MESSAGES;
    this.toolFactory = options.toolFactory;
    this.triggerMessageId = options.triggerMessageId ?? null;
    this.canDeliver = options.canDeliver ?? (() => true);
    this.log = options.log ?? (() => undefined);
  }

  abort(reason: string): void {
    this.interrupted = reason;
    this.deadline.abort(new Error(reason));
  }

  get directory(): string | null {
    return this.workdir;
  }

  private workdir: string | null = null;

  async run(): Promise<SessionResult> {
    const result: SessionResult = {
      status: 'succeeded',
      turns: 0,
      promptTokens: 0,
      completionTokens: 0,
      error: null,
      summary: null,
      toolExecuted: false,
      mailSessionId: null,
    };
    this.ledger.start(this.triggerMessageId);
    const workdir = await ensureThreadWorkspace(this.runtime.root, this.threadId);
    this.workdir = workdir;
    this.runtime.sessionBegin();
    const available = this.availableTools();
    await writeAgentsFile(workdir, this.definition, available, ANP_ENVIRONMENT);

    this.timer = setTimeout(() => {
      this.timedOut = true;
      this.deadline.abort(new Error('timeout'));
    }, this.definition.limits.timeoutMs);
    this.timer.unref?.();

    const heartbeat = async () => {
      await this.ledger.heartbeat(this.runId, this.mailSessionId ? { sessionId: this.mailSessionId } : {});
    };

    let turnTools: BrainLoopTools | null = null;
    try {
      const mailSession = await this.mailbox.open(
        { label: `session:${this.sessionId}`, kind: 'embedded', ttlSeconds: 3_600 },
      );
      this.mailSessionId = mailSession.id;
      result.mailSessionId = mailSession.id;
      await heartbeat();

      const page = await this.mailbox.pull(mailSession.id, {
        limit: Math.min(this.maxMessages, 20),
        leaseSeconds: 300,
      });
      this.pulled.push(...page.items);

      if (this.pulled.length === 0) {
        this.settled = true;
        return result;
      }

      const context = buildThreadContext(this.store, this.threadId);
      const messages: ChatMessage[] = context.messages;
      const tools = this.toolsFor(workdir);
      turnTools = tools;
      const system = [
        systemPromptFor(this.definition, ANP_ENVIRONMENT),
        [
          '# 当前会话',
          '',
          `- thread：${this.threadId}`,
          `- 工作目录：${workdir}`,
          `- 本轮消息：${this.pulled.map(item => item.id).join(', ')}`,
          context.omitted > 0 ? `- 历史：省略了 ${context.omitted} 条较早消息` : '',
        ].filter(Boolean).join('\n'),
      ].join('\n\n');

      const loop = await runBrainLoop({
        brain: this.runtime.brainForSession(),
        tools,
        messages,
        system,
        maxTurns: this.definition.limits.maxTurns,
        maxTokens: this.definition.limits.maxTokens,
        completion: this.definition.completion === 'text' ? 'text' : 'finish',
        vars: this.vars(),
        signal: this.deadline.signal,
        log: () => undefined,
        heartbeat,
        onToolExecuted: () => {
          this.toolExecuted = true;
        },
      });
      result.turns = loop.turns;
      result.promptTokens = loop.promptTokens;
      result.completionTokens = loop.completionTokens;
      result.toolExecuted = loop.toolExecuted;
      if (loop.aborted) {
        if (this.interrupted) {
          result.status = 'failed';
          result.error = this.interrupted;
        } else {
          result.status = 'timeout';
          result.error = `超过时限 ${this.definition.limits.timeoutMs}ms`;
        }
      } else {
        result.status = loop.status;
        result.error = loop.error;
      }

      if (loop.finished) {
        result.summary = loop.finished.summary;
        await this.replyIfNeeded(loop.finished.summary);
        for (const envelope of this.pulled) {
          try {
            await this.mailbox.ack(envelope.id, envelope.deliveryId);
          } catch {
            // 确认失败只会导致租约到期后重投；本地 inbox 仍去重。
          }
        }
        this.settled = true;
      } else {
        if (result.status === 'succeeded') {
          result.status = 'failed';
          result.error = '本轮没有结束信号';
        }
        const reason =
          result.status === 'outcome_unknown'
            ? '运行结果未知，等待人工核对'
            : '模型没有结束本轮，消息退回队列';
        await this.releaseMessages(this.pulled, result.status === 'outcome_unknown' ? 3_600 : 300, reason);
        this.settled = true;
      }
    } catch (err) {
      if (this.interrupted) {
        result.status = 'failed';
        result.error = this.interrupted;
      } else if (this.timedOut || this.deadline.signal.aborted) {
        result.status = 'timeout';
        result.error = `超过时限 ${this.definition.limits.timeoutMs}ms`;
      } else {
        result.status = 'failed';
        result.error = err instanceof Error ? err.message : String(err);
      }
    } finally {
      if (this.timer) clearTimeout(this.timer);
      result.toolExecuted = this.toolExecuted;
      if (!this.settled && this.pulled.length > 0) {
        const retryAfterSeconds = this.interrupted || this.timedOut ? (this.toolExecuted ? 3_600 : 300) : 300;
        await this.releaseMessages(this.pulled, retryAfterSeconds, '运行未完成，消息退回队列');
      }
      if (this.mailSessionId) {
        try {
          await this.mailbox.close(this.mailSessionId);
        } catch {
          // 过期租约由 pull 前的 releaseExpiredLeases 兜底。
        }
      }
      if (turnTools?.dispose) {
        try {
          await turnTools.dispose();
        } catch {
          // 容器清理失败不影响本轮结果；残留容器由 labels 与超时兜底。
        }
      }
      try {
        await this.ledger.finish(this.runId, result);
      } catch {
        // 控制面的恢复扫描会兜底。
      }
      await this.runtime.sessionEnd();
    }

    return result;
  }

  /** 供后续阶段替换：把显式 anp_reply 标记为已回复。 */
  markReplied(): void {
    this.replied = true;
  }

  private availableTools(): EmbeddedTool[] {
    if (this.toolFactory) return this.definition.tools;
    return this.definition.tools.filter(tool => isLocalTool(tool));
  }

  private toolsFor(runDir: string): BrainLoopTools {
    if (this.toolFactory) {
      return this.toolFactory({
        runDir,
        turnId: this.turnId,
        definition: this.definition,
        threadId: this.threadId,
        triggerMessageId: this.triggerMessageId,
        store: this.store,
        mailbox: this.mailbox,
        markReplied: () => this.markReplied(),
      });
    }
    return createTools({
      runDir,
      runId: this.turnId,
      definition: this.definition,
      tools: this.availableTools(),
      log: () => undefined,
    });
  }

  private vars(): Record<string, string> {
    const withTask = this.pulled.find(item => item.ref.taskId);
    return {
      taskId: withTask?.ref.taskId ?? '',
      refId: this.pulled[0]?.ref.id ?? '',
      messageId: this.pulled[0]?.id ?? '',
      threadId: this.threadId,
      runId: this.runId,
      turnId: this.turnId,
      agentId: this.runtime.agentId,
      workdir: this.workdir ?? '',
      now: new Date().toISOString(),
    };
  }

  private async replyIfNeeded(summary: string): Promise<void> {
    if (this.replied) return;
    const trigger = this.pulled[0];
    const targetDid = trigger?.publisherId;
    if (!trigger || !targetDid || !summary.trim()) return;
    // 聊天消息与定时触发没有明确要求回复时不再兜底回信，避免回声。
    if (
      !trigger.ref.taskId
      && (trigger.kind === 'anp.chat.message' || trigger.kind === 'anp.schedule.fire')
    ) return;
    if (!this.canDeliver(targetDid)) {
      this.log('warn', `触发消息来自外部 DID ${targetDid}，v1 未启用跨域 relay，跳过自动回复`);
      return;
    }
    try {
      await this.mailbox.send({
        targetDid,
        threadId: this.threadId,
        payload: { type: 'anp.chat.message', text: summary.trim() },
        replyTo: trigger.id,
      });
      this.replied = true;
    } catch {
      // 回复已写进 outbox 就不会丢；发送失败由 outbox 重试。
    }
  }

  private async releaseMessages(
    envelopes: MailEnvelope[],
    retryAfterSeconds: number,
    reason: string,
  ): Promise<void> {
    for (const envelope of envelopes) {
      try {
        await this.mailbox.nack(envelope.id, {
          deliveryId: envelope.deliveryId,
          retryAfterSeconds,
          reason,
        });
      } catch {
        // 租约到期后会重新投递。
      }
    }
  }
}
