/**
 * 常驻 thread 运行时的最小传输层：没有平台运行账本与信箱，
 * 只保留 AgentRuntime 需要的端口。
 */

import type { AgentTransport } from '../runtime/transport.ts';
import { COLLAB_ENVIRONMENT, type EnvironmentDescription } from '../runtime/prompt.ts';

export function threadTransport(
  environment: EnvironmentDescription = COLLAB_ENVIRONMENT,
): AgentTransport {
  const unused = async (): Promise<never> => {
    throw new Error('常驻 thread 运行不经过平台传输层');
  };
  return {
    mailbox: {
      open: unused as never,
      pull: unused as never,
      message: unused as never,
      ack: unused as never,
      nack: unused as never,
      close: async () => undefined,
    },
    runs: {
      heartbeat: async () => undefined,
      log: async () => undefined,
      finish: async () => undefined,
      status: async () => ({ status: 'running' }),
    },
    presence: { heartbeat: async () => undefined },
    supportsTool: () => true,
    environment,
  };
}
