/**
 * 模型循环：一次运行里「模型 → 工具 → 模型」的纯逻辑。
 *
 * 从 AgentSession 抽出，行为与日志逐字不变；调用方负责信箱、目录、超时
 * 信号与收尾。它只读写传入的 messages 数组，不碰任何控制面。
 */

import type { ChatMessage, ToolCall, ToolSpec } from '../brains/types.ts';
import type { Brain, BrainUsage } from '../brains/types.ts';
import type { RememberItem, ToolExecution } from '../tools.ts';
import { substitute } from './prompt.ts';
import type { LogLevel } from './types.ts';

export type BrainLoopTools = {
  specs: ToolSpec[];
  execute(call: ToolCall): Promise<ToolExecution>;
  /** 本轮结束后释放工具侧资源（例如容器）。 */
  dispose?(): Promise<void>;
};

export type BrainLoopEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'assistant-text'; text: string }
  | { type: 'tool-call'; name: string; input: Record<string, unknown> }
  | { type: 'tool-result'; name: string; content: string; uncertain?: string };

export type BrainLoopOptions = {
  brain: Brain;
  tools: BrainLoopTools;
  messages: ChatMessage[];
  system: string;
  maxTurns: number;
  maxTokens: number;
  completion: 'text' | 'finish';
  vars: Record<string, string>;
  signal: AbortSignal;
  log: (level: LogLevel, text: string) => void;
  heartbeat?: () => Promise<void>;
  /** 每次真正执行工具前调用；供调用方记录「这一轮动过手」。 */
  onToolExecuted?: () => void;
  /** 逐字流式输出；需要同时提供 onEvent。 */
  stream?: boolean;
  /** 运行事件的细粒度观察口；不影响日志与结果。 */
  onEvent?: (event: BrainLoopEvent) => void;
  /** 每次模型调用前重新装配系统提示（记忆/团队经验按调用而不是按轮次）。 */
  contextProvider?: (input: {
    turn: number;
    messages: ChatMessage[];
  }) => Promise<{ system: string }> | { system: string };
  onModelRequest?: (input: {
    turn: number;
    system: string;
    messages: ChatMessage[];
    tools: ToolSpec[];
  }) => void | Promise<void>;
  onModelResponse?: (input: {
    turn: number;
    text: string;
    toolCalls: ToolCall[];
    usage?: BrainUsage;
    stopReason?: string;
  }) => void | Promise<void>;
};

export type BrainLoopResult = {
  finished: { summary: string; outcome: string; remember?: RememberItem[] } | null;
  status: 'succeeded' | 'failed' | 'outcome_unknown';
  error: string | null;
  turns: number;
  promptTokens: number;
  completionTokens: number;
  toolExecuted: boolean;
  /** 信号中止导致提前退出；status 由调用方按中断/超时决定。 */
  aborted: boolean;
};

export async function runBrainLoop(options: BrainLoopOptions): Promise<BrainLoopResult> {
  const { brain, tools, messages, system, completion, signal, log } = options;
  const vars = Object.fromEntries(
    Object.entries(options.vars).map(([key, value]) => [key, String(value)]),
  );
  const outcome: BrainLoopResult = {
    finished: null,
    status: 'succeeded',
    error: null,
    turns: 0,
    promptTokens: 0,
    completionTokens: 0,
    toolExecuted: false,
    aborted: false,
  };

  while (outcome.turns < options.maxTurns) {
    if (signal.aborted) {
      outcome.aborted = true;
      break;
    }
    outcome.turns += 1;
    await options.heartbeat?.();
    const turnSystem = options.contextProvider
      ? (await options.contextProvider({ turn: outcome.turns, messages })).system
      : system;
    await options.onModelRequest?.({
      turn: outcome.turns,
      system: turnSystem,
      messages,
      tools: tools.specs,
    });
    const response = await brain.complete({
      system: turnSystem,
      messages,
      tools: tools.specs,
      maxTokens: options.maxTokens,
      signal,
      ...(options.stream && options.onEvent
        ? { onTextDelta: (delta: string) => options.onEvent!({ type: 'text-delta', text: delta }) }
        : {}),
    });
    await options.onModelResponse?.({
      turn: outcome.turns,
      text: response.text ?? '',
      toolCalls: response.toolCalls ?? [],
      ...(response.usage ? { usage: response.usage } : {}),
      ...(response.stopReason ? { stopReason: response.stopReason } : {}),
    });
    outcome.promptTokens += response.usage?.promptTokens ?? 0;
    outcome.completionTokens += response.usage?.completionTokens ?? 0;
    if (response.text) {
      log('info', `模型：${response.text.slice(0, 500)}`);
      options.onEvent?.({ type: 'assistant-text', text: response.text });
    }

    if (!response.toolCalls || response.toolCalls.length === 0) {
      if (response.text) messages.push({ role: 'assistant', content: response.text });
      if (completion === 'text' && response.text?.trim()) {
        outcome.finished = { summary: response.text.trim(), outcome: 'done' };
        log('info', '模型给出文本回答，按 text 完成策略收尾');
      } else {
        // finish 策略下没有 finish 就没有可交付的结论；这条消息会退回队列。
        outcome.status = 'failed';
        outcome.error = '模型没有再调用工具，本轮到此为止';
        log('warn', outcome.error);
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
      log('info', `调用工具 ${call.name}：${JSON.stringify(call.input).slice(0, 300)}`);
      options.onEvent?.({ type: 'tool-call', name: call.name, input: call.input });
      outcome.toolExecuted = true;
      options.onToolExecuted?.();
      const execution = await tools.execute(call);
      options.onEvent?.({
        type: 'tool-result',
        name: call.name,
        content: execution.content,
        ...(execution.uncertain ? { uncertain: execution.uncertain } : {}),
      });
      messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: execution.content });
      if (execution.uncertain) {
        outcome.status = 'outcome_unknown';
        outcome.error = execution.uncertain;
        stopped = true;
        break;
      }
      if (execution.finish) {
        outcome.finished = execution.finish;
        stopped = true;
        break;
      }
    }
    if (stopped) break;
    await options.heartbeat?.();
  }

  if (!outcome.aborted && outcome.status === 'succeeded' && !outcome.finished && outcome.turns >= options.maxTurns) {
    log('warn', `达到轮次上限 ${options.maxTurns}，按未完成收尾`);
    outcome.status = 'failed';
    outcome.error = `达到轮次上限 ${options.maxTurns} 仍未结束`;
  }

  return outcome;
}
