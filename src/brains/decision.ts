/**
 * 决策模型（Jev / Cloudflare Clef）。
 *
 * 它不参与多轮对话：输入是一道题与一个 JSON Schema，输出是受约束的答案。
 * 运行时只用它做"该不该打断 / 该选哪个下一步"这类小判断。
 */

import {
  errorText,
  joinUrl,
  postJson,
  type BrainConfig,
  type DecisionBrain,
  type FetchLike,
} from './types.ts';

export function decisionBrain(config: BrainConfig, fetchImpl: FetchLike): DecisionBrain {
  return {
    async ask({ question, schema, context }) {
      try {
        const parsed = await postJson(
          fetchImpl,
          joinUrl(config.baseUrl, ''),
          config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {},
          {
            model: config.model,
            question,
            schema,
            ...(context === undefined ? {} : { context }),
          },
        );
        const answer = 'answer' in parsed ? parsed.answer : 'result' in parsed ? parsed.result : parsed;
        return {
          answer,
          ...(typeof parsed.confidence === 'number' ? { confidence: parsed.confidence } : {}),
        };
      } catch (error) {
        throw new Error(`决策模型调用失败：${errorText(error)}`);
      }
    },
  };
}
