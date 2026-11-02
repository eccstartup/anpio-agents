/**
 * 投递唤醒：ANP 服务接受一条 direct.send 后，把目标 agent 从等待中叫醒。
 *
 * 只做索引与唤醒；消息正文的搬运仍由 AgentHost 的 sync 完成，所以服务重启、
 * 唤醒丢失都只会延迟，不会丢消息。
 */

import { randomUUID } from 'node:crypto';
import type { RouterStore } from '../store/router-store.ts';
import type { AgentHost } from './agent-host.ts';

export type DeliveryOptions = {
  router: RouterStore;
  hosts: () => Map<string, AgentHost>;
  log: (line: string) => void;
};

export class Delivery {
  private readonly router: RouterStore;
  private readonly hosts: () => Map<string, AgentHost>;
  private readonly log: (line: string) => void;

  constructor(options: DeliveryOptions) {
    this.router = options.router;
    this.hosts = options.hosts;
    this.log = options.log;
  }

  findByDid(did: string): AgentHost | undefined {
    for (const host of this.hosts().values()) {
      if (host.did === did) return host;
    }
    return undefined;
  }

  /** 为 thread 建索引并唤醒 agent；重复调用幂等。 */
  wake(targetDid: string, threadId: string, senderDid?: string | null): AgentHost | undefined {
    const host = this.findByDid(targetDid);
    if (!host) {
      this.log(`收到发往 ${targetDid} 的投递，但本 router 没有该 agent`);
      return undefined;
    }
    const sender = senderDid ? this.findByDid(senderDid) : undefined;
    return this.wakeHost(host, threadId, sender);
  }

  /** 目标与（本机）发送方都记入 thread_members，再叫醒目标。 */
  wakeHost(host: AgentHost, threadId: string, sender?: AgentHost): AgentHost {
    this.router.ensureThread({ threadId, ownerAgentId: host.agentId });
    this.router.ensureSession({
      sessionId: `sess-${randomUUID()}`,
      agentId: host.agentId,
      threadId,
      state: 'idle',
    });
    this.router.ensureMembers(
      threadId,
      sender && sender.agentId !== host.agentId
        ? [host.agentId, sender.agentId]
        : [host.agentId],
    );
    host.wake();
    return host;
  }
}
