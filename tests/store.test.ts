import { cp, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MockProvider } from '../src/server/providers/mock';
import { Registry } from '../src/server/registry';
import { Store } from '../src/server/store';
import { QUIET, TEAM } from './helpers';

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('organisations on disk', () => {
  it('ignores a copy of an organisation folder instead of loading it over the original', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'the-organisation-store-'));
    const store = new Store(dir);
    await store.init();
    const options = { retryDelayMs: 1, emitIntervalMs: 1 };
    const first = new Registry(store, new MockProvider(QUIET), options);
    const runner = await first.create({ name: 'Fernery', idea: 'Houseplants by post.', executives: TEAM, settings: { maxCycles: 1, budgetUsd: 1000 } });
    const id = runner.org.id;

    // A backup taken before any work was done...
    await cp(store.orgDir(id), `${store.orgDir(id)}.bak`, { recursive: true });
    // ...then the organisation runs a cycle.
    runner.start();
    await runner.idle();
    await runner.flush();
    const calls = runner.org.usage.calls;
    expect(calls).toBeGreaterThan(0);
    runner.dispose();

    const second = new Registry(store, new MockProvider(QUIET), options);
    await second.load();
    expect(second.list().map((o) => o.id)).toEqual([id]);
    const revived = second.get(id)!;
    expect(revived.org.usage.calls).toBe(calls);
    expect(revived.org.cycle.number).toBe(2);
    await revived.flush();
    revived.dispose();

    // And the stale copy has not been written over the real state.
    const third = new Registry(store, new MockProvider(QUIET), options);
    await third.load();
    expect(third.get(id)!.org.usage.calls).toBe(calls);
    third.get(id)!.dispose();
  });
});
