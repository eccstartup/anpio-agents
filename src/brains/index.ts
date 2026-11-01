/**
 * 按协议选择适配器，并在这里统一解析密钥环境变量。
 *
 * 密钥只从进程环境读；定义里存的是变量名，数据库里没有任何明文密钥。
 */

import type { EmbeddedProviderConfig } from '../definition.ts';
import { anthropicBrain } from './anthropic.ts';
import { decisionBrain } from './decision.ts';
import { geminiBrain } from './gemini.ts';
import { openaiChatBrain, openaiResponsesBrain } from './openai.ts';
import { scriptBrain } from './script.ts';
import type { Brain, BrainConfig, DecisionBrain, FetchLike } from './types.ts';

export * from './types.ts';

export type BrainOptions = {
  fetch?: FetchLike;
  env?: NodeJS.ProcessEnv;
};

function configOf(provider: EmbeddedProviderConfig, options: BrainOptions): { config: BrainConfig; fetchImpl: FetchLike } {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetch ?? (globalThis.fetch as FetchLike);
  if (!fetchImpl) throw new Error('当前 Node 版本没有 fetch');
  let apiKey: string | null = null;
  if (provider.apiKeyEnv) {
    apiKey = env[provider.apiKeyEnv] ?? null;
    if (!apiKey) throw new Error(`缺少环境变量 ${provider.apiKeyEnv}（密钥只从环境变量读取）`);
  }
  return {
    config: {
      baseUrl: provider.baseUrl,
      model: provider.model,
      apiKey,
      ...(provider.script ? { script: provider.script } : {}),
    },
    fetchImpl,
  };
}

export function brainFor(provider: EmbeddedProviderConfig, options: BrainOptions = {}): Brain {
  if (provider.protocol === 'script') {
    return scriptBrain({
      baseUrl: '',
      model: 'script',
      apiKey: null,
      ...(provider.script ? { script: provider.script } : {}),
    });
  }
  if (provider.protocol === 'subscription-cli') {
    throw new Error(
      '订阅型 CLI（Kiro/Codex）还没有可用的适配器：本机安装 CLI 后再启用，运行时不会假装它能用',
    );
  }
  if (provider.protocol === 'decision-jev') {
    throw new Error('decision-jev 是决策协议，不支持多轮对话；请改用 resolveDecision()');
  }
  if (provider.protocol === 'gemini-interactions') {
    throw new Error('Gemini Interactions 协议尚未实现，请改用 gemini-generate 或 OpenAI 兼容地址');
  }

  const { config, fetchImpl } = configOf(provider, options);
  switch (provider.protocol) {
    case 'openai-chat':
    case 'workers-ai':
      return openaiChatBrain(config, fetchImpl);
    case 'openai-responses':
      return openaiResponsesBrain(config, fetchImpl);
    case 'anthropic-messages':
      return anthropicBrain(config, fetchImpl);
    case 'gemini-generate':
      return geminiBrain(config, fetchImpl);
    default:
      throw new Error(`未知协议 ${String(provider.protocol)}`);
  }
}

export function resolveDecision(
  provider: EmbeddedProviderConfig,
  options: BrainOptions = {},
): DecisionBrain {
  const { config, fetchImpl } = configOf(provider, options);
  if (provider.protocol !== 'decision-jev') throw new Error('这个供应商不是决策协议');
  return decisionBrain(config, fetchImpl);
}
