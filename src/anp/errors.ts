/**
 * 本机投递边界：v1 没有 relay，出站目标必须是本 router 托管的 agent。
 *
 * `direct.send` 在没有 relay 时会被本地服务无条件收下，因此发送前必须先
 * 判断目标是否在本机；否则消息会“发送成功”但永远到不了对方。
 */

export class UnroutableTargetError extends Error {
  readonly code = 'unroutable';

  constructor(target: string) {
    super(`目标 ${target} 不在本机 router 中；v1 未启用跨域 relay`);
    this.name = 'UnroutableTargetError';
  }
}
