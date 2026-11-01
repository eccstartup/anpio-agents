/**
 * 内嵌智能体的派生令牌。
 *
 * 平台与 supervisor 共享 `COLLAB_EMBEDDED_SECRET`，同一个智能体算出的令牌
 * 永远相同：不落库、不进进程环境、不经过网络。更换 secret 等于轮换全部令牌，
 * 下一次 ensure 会更新主体上的摘要，旧令牌立即失效。
 */

import { createHmac } from 'node:crypto';

export const EMBEDDED_TOKEN_PREFIX = 'embedded:';

export function deriveEmbeddedToken(secret: string, agentId: string): string {
  if (!secret) throw new Error('缺少 COLLAB_EMBEDDED_SECRET');
  return createHmac('sha256', secret).update(`${EMBEDDED_TOKEN_PREFIX}${agentId}`).digest('hex');
}
