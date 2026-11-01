/**
 * Session：一次运行的可并发上下文。
 *
 * 持有自己的 mail session、对话历史、工作目录、deadline 与 token 预算；
 * 用的 Brain、工具策略与 agent 工作根都来自 AgentRuntime。Session 之间不共享
 * 任何可变状态，单个 Session 抛错不会影响同 agent 的其它 Session。
 */

import type { ChatMessage, ToolSpec } from '../brains/types.ts';
import type { MailEnvelope } from '../client.ts';
import type { CompletionPolicy, EmbeddedAgentDefinition } from '../definition.ts';
import { createRunDir, removeRunDir, scrubbedEnv } from '../sandbox.ts';
import { createTools } from '../tools.ts';
import type { AgentRuntime } from './agent.ts';
import { createRunLog, type RunLog, type RunLogger } from './log.ts';
import { envelopeText, substitute, systemPromptFor, writeAgentsFile } from './prompt.ts';
import type { AgentTransport } from './transport.ts';
import type { SessionRequest, SessionResult } from './types.ts';

const MAX_MESSAGES = 5;

export class AgentSession {
  readonly runId: string;
  readonly definition: EmbeddedAgentDefinition;
  readonly maxMessages: number;

  private readonly runtime: AgentRuntime;
  private readonly transport: AgentTransport;
  private readonly completion: CompletionPolicy;
  private readonly history: ChatMessage[];
  private readonly logger: RunLogger;
  private readonly log: RunLog;
  private readonly onMailPulled: SessionRequest['onMailPulled'];
  private readonly deadline = new AbortController();

  private timer: NodeJS.Timeout | null = null;
  private timedOut = false;
  private interrupted: string | null = null;
  private workdir: string | null = null;
  private mailSessionId: string | null = null;
  private toolExecuted = false;
  private settled = false;
  private readonly pulled: MailEnvelope[] = [];

  constructor(runtime: AgentRuntime, request: SessionRequest) {
    this.runtime = runtime;
    this.runId = request.runId;
    this.definition = request.definition ?? runtime.definition;
    this.maxMessages = request.maxMessages ?? MAX_MESSAGES;
    this.transport = runtime.transport;
    this.completion = this.definition.completion === 'text' ? 'text' : 'finish';
    this.history = request.history ?? [];
    this.onMailPulled = request.onMailPulled;
    this.logger = createRunLog(this.transport.runs, this.runId);
    this.log = this.logger.log;
  }

  /** 被 worker 中断时调用：让模型循环在下一次检查时停下，而不是等超时。 */
  abort(reason: string): void {
    this.interrupted = reason;
    this.deadline.abort(new Error(reason));
  }

  get directory(): string | null {
    return this.workdir;
  }

  get sessionId(): string | null {
    return this.mailSessionId;
  }

  async run(): Promise<SessionResult> {
    const { definition, runId } = this;
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

    const runDir = await createRunDir(this.runtime.agentId, runId, this.runtime.rootBase);
    this.workdir = runDir;
    this.runtime.sessionBegin();
    await writeAgentsFile(runDir, definition, this.runtime.tools, this.transport.environment);
    this.log('info', `运行开始：${definition.name}（${definition.provider.id}/${definition.provider.model}），目录 ${runDir}`);
    this.log('debug', `子进程环境只有 ${Object.keys(scrubbedEnv(runDir)).join(', ')}`);

    const pulled = this.pulled;
    let finished: { summary: string; outcome: string } | null = null;

    const heartbeat = async () => {
      try {
        await this.transport.runs.heartbeat(
          runId,
          this.mailSessionId ? { sessionId: this.mailSessionId } : {},
        );
      } catch {
        // 心跳失败不打断本轮；控制面会按停滞时间回收。
      }
    };

    this.timer = setTimeout(() => {
      this.timedOut = true;
      this.deadline.abort(new Error('timeout'));
    }, definition.limits.timeoutMs);
    this.timer.unref?.();

    try {
      const session = await this.transport.mailbox.open(
        { label: `run:${runId}`, kind: 'embedded', ttlSeconds: 3_600 },
        this.deadline.signal,
      );
      this.mailSessionId = session.id;
      result.mailSessionId = session.id;
      await heartbeat();

      const page = await this.transport.mailbox.pull(
        session.id,
        { limit: Math.min(this.maxMessages, 20), leaseSeconds: 300 },
        this.deadline.signal,
      );
      pulled.push(...page.items);

      if (pulled.length === 0) {
        this.log('info', '信箱里没有待处理消息，本轮不做模型调用');
        return result;
      }

      await this.onMailPulled?.(pulled);
      this.log('info', `拉到 ${pulled.length} 条消息：${pulled.map(item => item.kind).join(', ')}`);

      const parts: string[] = [];
      for (const envelope of pulled) {
        try {
          const message = await this.transport.mailbox.message(envelope.id, this.deadline.signal);
          parts.push(envelopeText(envelope, message.content));
        } catch (err) {
          if (this.deadline.signal.aborted) throw err;
          this.log('warn', `消息 ${envelope.id} 正文读取失败：${err instanceof Error ? err.message : String(err)}`);
          parts.push(`【消息 ${envelope.id}】${envelope.kind}\n摘要：${envelope.summary}\n（正文不可访问）`);
        }
      }

      const brain = this.runtime.brainForSession();
      const tools = createTools({
        backend: this.transport.tools,
        runDir,
        runId,
        definition,
        tools: this.runtime.tools,
        log: this.log,
      });
      const messages: ChatMessage[] = [
        ...this.history,
        { role: 'user', content: parts.join('\n\n---\n\n') },
      ];
      const system = systemPromptFor(definition, this.transport.environment);
      const vars = {
        taskId: pulled.find(item => item.ref.taskId)?.ref.taskId ?? '',
        refId: pulled[0]?.ref.id ?? '',
        messageId: pulled[0]?.id ?? '',
        runId,
        agentId: this.runtime.agentId,
        workdir: runDir,
        now: new Date().toISOString(),
      };

      while (result.turns < definition.limits.maxTurns) {
        if (this.deadline.signal.aborted) {
          if (this.interrupted) {
            result.status = 'failed';
            result.error = this.interrupted;
          } else {
            result.status = 'timeout';
            result.error = `超过时限 ${definition.limits.timeoutMs}ms`;
          }
          break;
        }
        result.turns += 1;
        await heartbeat();
        const response = await brain.complete({
          system,
          messages,
          tools: tools.specs as ToolSpec[],
          maxTokens: definition.limits.maxTokens,
          signal: this.deadline.signal,
        });
        result.promptTokens += response.usage?.promptTokens ?? 0;
        result.completionTokens += response.usage?.completionTokens ?? 0;
        if (response.text) this.log('info', `模型：${response.text.slice(0, 500)}`);

        if (!response.toolCalls || response.toolCalls.length === 0) {
          if (response.text) messages.push({ role: 'assistant', content: response.text });
          if (this.completion === 'text' && response.text?.trim()) {
            finished = { summary: response.text.trim(), outcome: 'done' };
            this.log('info', '模型给出文本回答，按 text 完成策略收尾');
          } else {
            // finish 策略下没有 finish 就没有可交付的结论；这条消息会退回队列。
            result.status = 'failed';
            result.error = '模型没有再调用工具，本轮到此为止';
            this.log('warn', result.error);
          }
          break;
        }

        const calls = response.toolCalls.map(call => ({ ...call, input: substitute(call.input, vars) }));
        messages.push({
          role: 'assistant',
          ...(response.text ? { content: response.text } : {}),
          toolCalls: calls,
        });

        let stopped = false;
        for (const call of calls) {
          this.log('info', `调用工具 ${call.name}：${JSON.stringify(call.input).slice(0, 300)}`);
          this.toolExecuted = true;
          const execution = await tools.execute(call);
          messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: execution.content });
          if (execution.uncertain) {
            result.status = 'outcome_unknown';
            result.error = execution.uncertain;
            stopped = true;
            break;
          }
          if (execution.finish) {
            finished = execution.finish;
            stopped = true;
            break;
          }
        }
        if (stopped) break;
        await heartbeat();
      }

      if (result.status === 'succeeded' && !finished && result.turns >= definition.limits.maxTurns) {
        this.log('warn', `达到轮次上限 ${definition.limits.maxTurns}，按未完成收尾`);
        result.status = 'failed';
        result.error = `达到轮次上限 ${definition.limits.maxTurns} 仍未结束`;
      }

      if (finished) {
        result.summary = finished.summary;
        this.log('info', `收尾：${finished.outcome} — ${finished.summary}`);
        // 只有明确收尾的消息才算处理完；blocked 也算处理过（已经留言说明）。
        for (const envelope of pulled) {
          try {
            await this.transport.mailbox.ack(envelope.id, envelope.deliveryId);
          } catch (err) {
            this.log('warn', `消息 ${envelope.id} 确认失败：${err instanceof Error ? err.message : String(err)}`);
          }
        }
        this.settled = true;
      } else {
        // succeeded 只能来自 finish；没有 finish 的运行不能留在成功状态。
        if (result.status === 'succeeded') {
          result.status = 'failed';
          result.error = '本轮没有调用 finish';
        }
        const reason =
          result.status === 'outcome_unknown'
            ? '运行结果未知，等待人工核对'
            : '模型没有调用 finish，这一轮不算处理完成';
        this.log('warn', `${reason}；${pulled.length} 条消息退回队列（带退避）`);
        await this.releaseMessages(pulled, result.status === 'outcome_unknown' ? 3600 : 300, reason);
        this.settled = true;
      }
    } catch (err) {
      if (this.interrupted) {
        result.status = 'failed';
        result.error = this.interrupted;
      } else if (this.timedOut || this.deadline.signal.aborted) {
        result.status = 'timeout';
        result.error = `超过时限 ${definition.limits.timeoutMs}ms`;
      } else {
        result.status = 'failed';
        result.error = err instanceof Error ? err.message : String(err);
      }
      this.log('error', `运行失败：${result.error}`);
    } finally {
      if (this.timer) clearTimeout(this.timer);
      result.toolExecuted = this.toolExecuted;
      // 没有走到 ack / nack 的运行（崩溃、超时、被 worker 中断）在这里退回消息，
      // 否则只能等租约到期。已经执行过工具的按结果未知处理，退避更久。
      if (!this.settled && this.pulled.length > 0) {
        const interrupted = this.interrupted !== null;
        const reason = interrupted
          ? `运行时中断：${this.interrupted}`
          : result.status === 'outcome_unknown'
            ? '运行结果未知，等待人工核对'
            : '运行未完成，消息退回队列';
        const retryAfterSeconds = interrupted || result.status === 'outcome_unknown'
          ? (this.toolExecuted ? 3600 : 300)
          : 300;
        await this.releaseMessages(this.pulled, retryAfterSeconds, reason);
      }
      if (this.mailSessionId) {
        try {
          await this.transport.mailbox.close(this.mailSessionId);
        } catch {
          // 会话关闭失败不影响结论；过期后会被清理。
        }
      }
      await this.runtime.sessionEnd();
      await this.finishRun(result);
      if (process.env.COLLAB_KEEP_RUN === '1') {
        this.log('info', `保留运行目录：${runDir}`);
      } else {
        await removeRunDir(runDir, { root: this.runtime.rootBase }).catch(() => undefined);
      }
      await this.logger.flush();
    }

    return result;
  }

  private async releaseMessages(envelopes: MailEnvelope[], retryAfterSeconds: number, reason: string): Promise<void> {
    for (const envelope of envelopes) {
      try {
        await this.transport.mailbox.nack(envelope.id, {
          deliveryId: envelope.deliveryId,
          retryAfterSeconds,
          reason,
        });
      } catch (err) {
        this.log('warn', `消息 ${envelope.id} 退回失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private async finishRun(result: SessionResult): Promise<void> {
    try {
      await this.transport.runs.finish(this.runId, result);
    } catch {
      // 收尾失败由控制面的恢复扫描兜底。
    }
  }
}
