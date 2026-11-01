/**
 * LocalTransport：不依赖任何控制面的 AgentTransport 实现。
 *
 * 信箱与运行账本落在 `<root>/.local/`，进程隔离时父子进程共享同一份文件，
 * 靠文件锁保证拉取、ack/nack 与收尾不会互相覆盖。
 */

import { join, resolve } from 'node:path';
import { isLocalTool, type EmbeddedTool } from '../../definition.ts';
import { LOCAL_ENVIRONMENT } from '../prompt.ts';
import type { AgentTransport, PresencePort, ToolBackend } from '../transport.ts';
import { LocalRunLedger } from './ledger.ts';
import { LocalMailbox, type EnqueueInput } from './mailbox.ts';
import { writeJsonAtomic } from './store.ts';

export function defaultLocalRoot(): string {
  return process.env.AGENT_RUN_ROOT
    ? resolve(process.env.AGENT_RUN_ROOT)
    : resolve(process.cwd(), 'agent-runs');
}

export class LocalPresence implements PresencePort {
  private state: 'online' | 'busy' | 'offline' = 'online';
  private note: string | undefined;
  private lastSeenAt = new Date().toISOString();
  private readonly file: string | undefined;

  constructor(file?: string) {
    this.file = file;
  }

  async heartbeat(input: { state?: 'online' | 'busy' | 'offline'; note?: string } = {}): Promise<void> {
    if (input.state) this.state = input.state;
    if (input.note !== undefined) this.note = input.note;
    this.lastSeenAt = new Date().toISOString();
    if (this.file) {
      await writeJsonAtomic(this.file, {
        state: this.state,
        note: this.note ?? null,
        lastSeenAt: this.lastSeenAt,
      });
    }
  }

  snapshot(): { state: string; note: string | null; lastSeenAt: string } {
    return { state: this.state, note: this.note ?? null, lastSeenAt: this.lastSeenAt };
  }
}

export type LocalTransport = AgentTransport & {
  mailbox: LocalMailbox;
  runs: LocalRunLedger;
  presence: LocalPresence;
  root: string;
  enqueue(input: EnqueueInput): Promise<{ id: string; seq: number }>;
};

export type LocalTransportOptions = {
  root?: string;
  /** 以后接本地任务库、Slack、GitHub 等系统时注入；缺省只有本地原语。 */
  tools?: ToolBackend;
  mailbox?: LocalMailbox;
  ledger?: LocalRunLedger;
  presence?: LocalPresence;
};

export function localTransport(options: LocalTransportOptions = {}): LocalTransport {
  const root = resolve(options.root ?? defaultLocalRoot());
  const stateDir = join(root, '.local');
  const mailbox = options.mailbox ?? new LocalMailbox({ file: join(stateDir, 'mailbox.json') });
  const runs = options.ledger ?? new LocalRunLedger({ dir: join(stateDir, 'runs') });
  const presence = options.presence ?? new LocalPresence(join(stateDir, 'presence.json'));
  const tools = options.tools;

  return {
    mailbox,
    runs,
    presence,
    root,
    tools,
    supportsTool: (name: EmbeddedTool) => isLocalTool(name) || Boolean(tools),
    environment: LOCAL_ENVIRONMENT,
    spawnConfig: () => ({ type: 'local', root }),
    enqueue: input => mailbox.enqueue(input),
  };
}
