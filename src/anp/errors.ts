/**
 * 本机投递边界：出站目标必须是本 router 托管的 agent；启用跨域时还可以是
 * 允许域名下的外部 DID。
 */

export class UnroutableTargetError extends Error {
  readonly code = 'unroutable';

  constructor(target: string) {
    super(`目标 ${target} 不在本机 router 中；未启用跨域或域名不在允许清单内`);
    this.name = 'UnroutableTargetError';
  }
}
