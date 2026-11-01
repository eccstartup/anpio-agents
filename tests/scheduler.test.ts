/**
 * 定时调度：cron 推进、到点只触发一次、catch_up 语义与重启幂等。
 *
 * 用真实 RouterStore（临时目录）验证事务内的 schedule_fires 唯一键；
 * 投递用内存收集器，不启动 router，也不监听端口。
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AnpPayload } from '../src/anp/client.ts';
import { nextCronAfter, parseCron } from '../src/router/cron.ts';
import {
  DEFAULT_MAX_SCHEDULES,
  RouterScheduler,
  SchedulerError,
  parseInterval,
  type SchedulerHost,
} from '../src/router/scheduler.ts';
import { RouterStore } from '../src/store/router-store.ts';

type Sent = { owner: string; threadId: string; payload: AnpPayload };

function hostsWith(config: Partial<Record<string, Partial<SchedulerHost['anpConfig']>>> = {}) {
  const hosts = new Map<string, SchedulerHost>();
  for (const [id, anpConfig] of Object.entries(config)) {
    hosts.set(id, {
      enabled: true,
      anpConfig: {
        allowSchedules: anpConfig?.allowSchedules ?? true,
        maxSchedules: anpConfig?.maxSchedules ?? null,
      },
    });
  }
  return hosts;
}

async function withStore(
  run: (store: RouterStore, sent: Sent[]) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'anp-scheduler-'));
  const store = new RouterStore(join(dir, 'router.db'));
  const sent: Sent[] = [];
  try {
    await run(store, sent);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function schedulerFor(
  store: RouterStore,
  sent: Sent[],
  hosts: Map<string, SchedulerHost>,
  now: () => Date,
): RouterScheduler {
  return new RouterScheduler({
    store,
    hosts: () => hosts,
    send: async (owner, input) => {
      sent.push({ owner, threadId: input.threadId, payload: input.payload });
      return { messageId: `msg-${sent.length}` };
    },
    tickIntervalMs: 0,
    now,
  });
}

test('cron：解析字段并严格推进到下一次', () => {
  const parsed = parseCron('*/15 9-17 * jan-mar mon-fri');
  assert.deepEqual([...parsed.minute.values].sort((a, b) => a - b), [0, 15, 30, 45]);
  assert.deepEqual([...parsed.hour.values], [9, 10, 11, 12, 13, 14, 15, 16, 17]);
  assert.deepEqual([...parsed.month.values], [1, 2, 3]);
  assert.deepEqual([...parsed.dayOfWeek.values], [1, 2, 3, 4, 5]);

  const after = new Date(2026, 0, 5, 12, 7, 30); // 2026-01-05 周一 12:07
  const next = nextCronAfter('*/15 9-17 * jan-mar mon-fri', after)!;
  assert.equal(next.getFullYear(), 2026);
  assert.equal(next.getMonth(), 0);
  assert.equal(next.getDate(), 5);
  assert.equal(next.getHours(), 12);
  assert.equal(next.getMinutes(), 15);
  assert.equal(next.getSeconds(), 0);

  assert.throws(() => parseCron('* * * *'), /5 段/);
  assert.throws(() => parseCron('60 * * * *'), /范围/);
  assert.throws(() => parseCron('* * * * funday'), /无法识别/);
});

test('interval：支持单位与纯秒数，并拒绝非正数', () => {
  assert.equal(parseInterval('90s'), 90_000);
  assert.equal(parseInterval('5m'), 300_000);
  assert.equal(parseInterval('2h'), 7_200_000);
  assert.equal(parseInterval('1d'), 86_400_000);
  assert.equal(parseInterval('120'), 120_000);
  assert.equal(parseInterval('0m'), 0);
  assert.throws(() => parseInterval('soon'), /格式/);
});

test('创建：allowSchedules、数量上限与表达式校验', async () => {
  await withStore(async (store, sent) => {
    const hosts = hostsWith({
      off: { allowSchedules: false },
      on: { maxSchedules: 1 },
    });
    const scheduler = schedulerFor(store, sent, hosts, () => new Date('2026-01-01T00:00:00Z'));

    assert.throws(
      () => scheduler.create('off', { kind: 'interval', expr: '5m', text: 'x' }),
      /allowSchedules/,
    );
    assert.throws(
      () => scheduler.create('missing', { kind: 'interval', expr: '5m', text: 'x' }),
      SchedulerError,
    );
    assert.throws(
      () => scheduler.create('on', { kind: 'interval', expr: '30s', text: 'x' }),
      /不能小于/,
    );
    assert.throws(
      () => scheduler.create('on', { kind: 'at', expr: '2025-12-31T00:00:00Z', text: 'x' }),
      /晚于当前时间/,
    );

    const created = scheduler.create('on', { kind: 'interval', expr: '5m', text: '巡检' });
    assert.equal(created.state, 'active');
    assert.equal(created.nextRunAt, '2026-01-01T00:05:00.000Z');
    assert.equal(created.threadId, null);
    assert.equal(scheduler.list('on').length, 1);

    assert.throws(
      () => scheduler.create('on', { kind: 'interval', expr: '5m', text: '第二个' }),
      /上限 1/,
    );

    assert.deepEqual(scheduler.cancel('on', created.id), { cancelled: true });
    assert.equal(scheduler.list('on')[0]?.state, 'done');
    assert.deepEqual(scheduler.cancel('on', created.id), { cancelled: false });
  });
});

test('未配置上限时使用默认上限', async () => {
  await withStore(async (store, sent) => {
    const hosts = hostsWith({ a: {} });
    const scheduler = schedulerFor(store, sent, hosts, () => new Date());
    for (let index = 0; index < DEFAULT_MAX_SCHEDULES; index += 1) {
      scheduler.create('a', { kind: 'interval', expr: '1h', text: `第 ${index} 个` });
    }
    assert.throws(
      () => scheduler.create('a', { kind: 'interval', expr: '1h', text: '超出' }),
      /上限/,
    );
  });
});

test('tick：到点投递一次，重复 tick 不重复发送', async () => {
  await withStore(async (store, sent) => {
    const hosts = hostsWith({ worker: {} });
    const now = new Date('2026-01-01T00:01:00Z');
    const scheduler = schedulerFor(store, sent, hosts, () => now);

    const created = store.createSchedule({
      id: 'sch-once',
      ownerAgentId: 'worker',
      kind: 'at',
      expr: '2026-01-01T00:00:30Z',
      payload: { type: 'anp.schedule.fire', text: '该喝咖啡了' },
      targetThread: 'thread-1',
      nextRunAt: '2026-01-01T00:00:30Z',
    });

    const first = await scheduler.tick(now);
    assert.equal(first.length, 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.owner, 'worker');
    assert.equal(sent[0]!.threadId, 'thread-1');
    assert.equal(sent[0]!.payload.type, 'anp.schedule.fire');
    assert.equal(sent[0]!.payload.text, '该喝咖啡了');

    const second = await scheduler.tick(now);
    assert.equal(second.length, 0);
    assert.equal(sent.length, 1);

    const row = store.getSchedule(created.id)!;
    assert.equal(row.state, 'done');
    assert.equal(row.runs, 1);
  });
});

test('tick：只触发已启动且允许定时任务的 agent', async () => {
  await withStore(async (store, sent) => {
    const hosts = hostsWith({ allowed: {}, blocked: { allowSchedules: false } });
    const now = new Date('2026-01-01T00:01:00Z');
    const scheduler = schedulerFor(store, sent, hosts, () => now);
    for (const owner of ['allowed', 'blocked']) {
      store.createSchedule({
        id: `sch-${owner}`,
        ownerAgentId: owner,
        kind: 'at',
        expr: '2026-01-01T00:00:30Z',
        payload: { type: 'anp.schedule.fire', text: owner },
        nextRunAt: '2026-01-01T00:00:30Z',
      });
    }

    const fired = await scheduler.tick(now);
    assert.deepEqual(fired.map(row => row.owner_agent_id), ['allowed']);
    assert.equal(sent.length, 1);
    assert.equal(store.listSchedules('blocked')[0]?.state, 'active');
  });
});

test('interval：每次触发后推进，且 maxRuns 到期结束', async () => {
  await withStore(async (store, sent) => {
    const hosts = hostsWith({ worker: {} });
    let now = new Date('2026-01-01T00:00:00Z');
    const scheduler = schedulerFor(store, sent, hosts, () => now);
    const created = scheduler.create('worker', {
      kind: 'interval',
      expr: '1m',
      text: '心跳',
      maxRuns: 2,
    });

    now = new Date('2026-01-01T00:01:00Z');
    await scheduler.tick(now);
    assert.equal(store.getSchedule(created.id)?.next_run_at, '2026-01-01T00:02:00.000Z');

    now = new Date('2026-01-01T00:01:30Z');
    await scheduler.tick(now);
    assert.equal(sent.length, 1, '未到下一次不触发');

    now = new Date('2026-01-01T00:02:00Z');
    await scheduler.tick(now);
    assert.equal(sent.length, 2);
    assert.equal(store.getSchedule(created.id)?.state, 'done');
    assert.equal(store.getSchedule(created.id)?.next_run_at, null);
  });
});

test('catch_up=skip：重启时错过的一次直接推进，不补投', async () => {
  await withStore(async (store, sent) => {
    const hosts = hostsWith({ worker: {} });
    const now = new Date('2026-01-01T00:10:00Z');
    const scheduler = schedulerFor(store, sent, hosts, () => now);
    const created = store.createSchedule({
      id: 'sch-skip',
      ownerAgentId: 'worker',
      kind: 'interval',
      expr: '5m',
      payload: { text: '巡检' },
      nextRunAt: '2026-01-01T00:00:00Z',
      catchUp: 'skip',
    });

    scheduler.skipMissed(now);
    assert.equal(store.getSchedule(created.id)?.next_run_at, '2026-01-01T00:15:00.000Z');
    await scheduler.tick(now);
    assert.equal(sent.length, 0);
  });
});

test('catch_up=once：重启后只补最近一次，然后跳到未来', async () => {
  await withStore(async (store, sent) => {
    const hosts = hostsWith({ worker: {} });
    const now = new Date('2026-01-01T00:10:00Z');
    const scheduler = schedulerFor(store, sent, hosts, () => now);
    const created = store.createSchedule({
      id: 'sch-once',
      ownerAgentId: 'worker',
      kind: 'interval',
      expr: '5m',
      payload: { text: '巡检' },
      nextRunAt: '2026-01-01T00:00:00Z',
      catchUp: 'once',
    });

    scheduler.skipMissed(now);
    assert.equal(store.getSchedule(created.id)?.next_run_at, '2026-01-01T00:00:00Z');

    await scheduler.tick(now);
    assert.equal(sent.length, 1);
    assert.equal(store.getSchedule(created.id)?.next_run_at, '2026-01-01T00:15:00.000Z');
    await scheduler.tick(now);
    assert.equal(sent.length, 1);
  });
});

test('catch_up=all：逐个补齐错过的触发', async () => {
  await withStore(async (store, sent) => {
    const hosts = hostsWith({ worker: {} });
    const now = new Date('2026-01-01T00:02:30Z');
    const scheduler = schedulerFor(store, sent, hosts, () => now);
    const created = store.createSchedule({
      id: 'sch-all',
      ownerAgentId: 'worker',
      kind: 'interval',
      expr: '1m',
      payload: { text: '巡检' },
      nextRunAt: '2026-01-01T00:00:00Z',
      catchUp: 'all',
    });

    for (let index = 0; index < 3; index += 1) await scheduler.tick(now);
    assert.equal(sent.length, 3);
    assert.equal(store.getSchedule(created.id)?.next_run_at, '2026-01-01T00:03:00.000Z');

    await scheduler.tick(now);
    assert.equal(sent.length, 3);
  });
});

test('重启幂等：已触发的时间点不会再次投递', async () => {
  await withStore(async (store, sent) => {
    const hosts = hostsWith({ worker: {} });
    const now = new Date('2026-01-01T00:01:00Z');
    store.createSchedule({
      id: 'sch-restart',
      ownerAgentId: 'worker',
      kind: 'at',
      expr: '2026-01-01T00:00:30Z',
      payload: { text: '一次性' },
      nextRunAt: '2026-01-01T00:00:30Z',
      catchUp: 'once',
    });

    await schedulerFor(store, sent, hosts, () => now).tick(now);
    assert.equal(sent.length, 1);

    // 模拟重启：同一 DB 上新建 scheduler，到点记录已存在。
    await schedulerFor(store, sent, hosts, () => now).tick(now);
    assert.equal(sent.length, 1);
  });
});
