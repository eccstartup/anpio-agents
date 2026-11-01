/**
 * 确定性脚本模型：演示与测试用，不发网络请求。
 *
 * 每一步要么说一句话，要么调一个工具；步数用尽后自动提交 finish，
 * 这样即使定义里忘了写收尾，一轮运行也能正常结束。
 */

import type { Brain, BrainConfig, BrainRequest, BrainResponse, DecisionBrain } from './types.ts';

export function scriptBrain(config: BrainConfig): Brain & DecisionBrain {
  const steps = config.script ?? [];
  let index = 0;
  let autoFinished = false;

  return {
    async complete(_request: BrainRequest): Promise<BrainResponse> {
      if (index < steps.length) {
        const step = steps[index]!;
        index += 1;
        if (step.tool) {
          return {
            toolCalls: [{ id: `script_${index}`, name: step.tool, input: step.input ?? {} }],
            stopReason: 'tool_use',
          };
        }
        return { text: step.text ?? '', stopReason: 'stop' };
      }
      if (!autoFinished) {
        autoFinished = true;
        return {
          toolCalls: [{ id: 'script_finish', name: 'finish', input: { summary: '脚本执行完毕' } }],
          stopReason: 'tool_use',
        };
      }
      return { text: '脚本已结束。', stopReason: 'stop' };
    },

    async ask({ question }) {
      return { answer: { ok: true, question }, confidence: 1 };
    },
  };
}
