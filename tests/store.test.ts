import { promises as fsPromises } from 'node:fs';
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_VERSION } from '../src/server/engine/state';
import { MockProvider } from '../src/server/providers/mock';
import { Registry } from '../src/server/registry';
import { Store } from '../src/server/store';
import { QUIET, TEAM, waitFor } from './helpers';

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

  it('never leaves half a state file behind: a save that is cut off leaves the last good one in place', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'the-organisation-store-'));
    const store = new Store(dir);
    await store.init();
    const registry = new Registry(store, new MockProvider(QUIET), { retryDelayMs: 1, emitIntervalMs: 1 });
    const runner = await registry.create({ name: 'Fernery', idea: 'Houseplants by post.', executives: TEAM, settings: { maxCycles: 1, budgetUsd: 1000 } });
    await runner.flush();
    const file = path.join(store.orgDir(runner.org.id), 'org.json');
    const good = await readFile(file, 'utf8');

    // The process stops after the new state has been written out but before it has taken the old one's place.
    const cut = vi.spyOn(fsPromises, 'rename').mockRejectedValueOnce(new Error('the process was stopped here'));
    try {
      await expect(store.save({ ...runner.org, name: 'Fernery, renamed' })).rejects.toThrow('stopped here');
    } finally {
      cut.mockRestore();
    }
    // What is on disk is the whole of the earlier state, not part of the new one.
    expect(await readFile(file, 'utf8')).toBe(good);
    const reloaded = new Registry(store, new MockProvider(QUIET), { retryDelayMs: 1, emitIntervalMs: 1 });
    await reloaded.load();
    expect(reloaded.unreadable).toEqual([]);
    expect(reloaded.get(runner.org.id)!.org.name).toBe('Fernery');
    // And the next save goes through as usual.
    await store.save({ ...runner.org, name: 'Fernery, renamed' });
    expect(JSON.parse(await readFile(file, 'utf8')).name).toBe('Fernery, renamed');
    runner.dispose();
    await reloaded.shutdown();
  });

  it('reads the most recent calls from a long activity log, skipping a line cut short', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'the-organisation-store-'));
    const store = new Store(dir);
    await store.init();
    await mkdir(store.orgDir('org_log'), { recursive: true });
    const entry = (n: number) => ({ id: `a${n}`, at: new Date(1_700_000_000_000 + n * 1000).toISOString(), kind: 'task' as const, execId: 'cto', label: `Call ${n}`, model: 'claude-opus-5-5', ms: 10, ok: true, error: null, inputTokens: 1, outputTokens: 1, costUsd: 0.01 });
    for (let n = 1; n <= 30; n++) await store.appendActivity('org_log', entry(n));
    expect((await store.readActivity('org_log')).map((e) => e.id)).toEqual(Array.from({ length: 30 }, (_, i) => `a${i + 1}`));
    expect((await store.readActivity('org_log', 10)).map((e) => e.id)).toEqual(Array.from({ length: 10 }, (_, i) => `a${i + 21}`));
    expect(await store.readActivity('org_log', 100)).toHaveLength(30);
    // A crash in the middle of a write leaves half a line at the end.
    await appendFile(path.join(store.orgDir('org_log'), 'activity.jsonl'), '{"id":"a31","at":"2023-11-14T22:1');
    expect((await store.readActivity('org_log', 10)).map((e) => e.id)).toEqual(Array.from({ length: 10 }, (_, i) => `a${i + 21}`));
    expect(await store.readActivity('org_none')).toEqual([]);
  });

  it('sets a damaged organisation aside, says why, leaves its file alone, and loads the rest', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'the-organisation-store-'));
    const store = new Store(dir);
    await store.init();
    const options = { retryDelayMs: 1, emitIntervalMs: 1 };
    const first = new Registry(store, new MockProvider(QUIET), options);
    const runner = await first.create({ name: 'Fernery', idea: 'Houseplants by post.', executives: TEAM, settings: { maxCycles: 1, budgetUsd: 1000 } });
    runner.start();
    await runner.idle();
    await runner.flush();
    runner.dispose();
    const id = runner.org.id;
    const good = await readFile(path.join(store.orgDir(id), 'org.json'), 'utf8');

    // What a damaged or foreign file can look like: each of these once stopped the server from starting, or would have.
    const damaged: Record<string, string> = {
      org_bare: JSON.stringify({ id: 'org_bare' }),
      org_noplans: JSON.stringify({ ...JSON.parse(good), id: 'org_noplans', plans: undefined }),
      org_noceo: JSON.stringify({ ...JSON.parse(good), id: 'org_noceo', executives: JSON.parse(good).executives.filter((e: { kind: string }) => e.kind !== 'ceo') }),
      org_badplan: JSON.stringify({ ...JSON.parse(good), id: 'org_badplan', plans: [{ id: 'p1', ownerId: 'cto', status: 'executing', phases: 'none' }] }),
      org_cut: good.slice(0, Math.floor(good.length / 2)),
      org_null: 'null',
      org_list: '[]',
      org_newer: JSON.stringify({ ...JSON.parse(good), id: 'org_newer', schemaVersion: SCHEMA_VERSION + 1, somethingNew: true }),
    };
    for (const [folder, text] of Object.entries(damaged)) {
      await mkdir(store.orgDir(folder), { recursive: true });
      await writeFile(path.join(store.orgDir(folder), 'org.json'), text);
    }
    // A folder with nothing in it is nobody's organisation, damaged or otherwise.
    await mkdir(store.orgDir('org_empty'), { recursive: true });

    const warn = console.warn;
    const warned: string[] = [];
    console.warn = (message: string) => void warned.push(message);
    const second = new Registry(store, new MockProvider(QUIET), options);
    try {
      await second.load();
    } finally {
      console.warn = warn;
    }
    expect(second.list().map((o) => o.id)).toEqual([id]);
    expect(second.get(id)!.org.cycle.number).toBe(2);
    const why = Object.fromEntries(second.unreadable.map((u) => [u.folder, u.reason]));
    expect(Object.keys(why).sort()).toEqual(Object.keys(damaged).sort());
    expect(why.org_bare).toMatch(/damaged: no name; no settings/);
    expect(why.org_noplans).toMatch(/no readable list of plans/);
    expect(why.org_noceo).toMatch(/no chief executive/);
    expect(why.org_badplan).toMatch(/no readable list of plans/);
    expect(why.org_cut).toMatch(/not valid JSON/);
    expect(why.org_null).toMatch(/damaged/);
    expect(why.org_list).toMatch(/damaged/);
    expect(why.org_newer).toMatch(new RegExp(`later version of this program \\(format ${SCHEMA_VERSION + 1}; this version reads up to format ${SCHEMA_VERSION}\\)`));
    expect(warned.filter((line) => line.includes('was not loaded'))).toHaveLength(Object.keys(damaged).length);
    // Nothing that was set aside has been touched: it is there for a person to repair, or for a later version to read.
    for (const [folder, text] of Object.entries(damaged)) expect(await readFile(path.join(store.orgDir(folder), 'org.json'), 'utf8')).toBe(text);
    await second.shutdown();
    for (const [folder, text] of Object.entries(damaged)) expect(await readFile(path.join(store.orgDir(folder), 'org.json'), 'utf8')).toBe(text);
  });

  it('reads an organisation saved before formats were numbered, and numbers it', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'the-organisation-store-'));
    const store = new Store(dir);
    await store.init();
    const options = { retryDelayMs: 1, emitIntervalMs: 1 };
    const first = new Registry(store, new MockProvider(QUIET), options);
    const runner = await first.create({ name: 'Fernery', idea: 'Houseplants by post.', executives: TEAM, settings: { maxCycles: 1, budgetUsd: 1000 } });
    expect(runner.org.schemaVersion).toBe(SCHEMA_VERSION);
    await runner.flush();
    runner.dispose();
    const file = path.join(store.orgDir(runner.org.id), 'org.json');
    const { schemaVersion: _numbered, reviewRounds: _rounds, steers: _steers, ...old } = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, JSON.stringify(old));

    const second = new Registry(store, new MockProvider(QUIET), options);
    await second.load();
    expect(second.unreadable).toEqual([]);
    const revived = second.get(runner.org.id)!;
    expect(revived.org.schemaVersion).toBe(SCHEMA_VERSION);
    expect(revived.org.reviewRounds).toEqual([]);
    await revived.flush();
    expect(JSON.parse(await readFile(file, 'utf8')).schemaVersion).toBe(SCHEMA_VERSION);
    // And it runs.
    revived.start();
    await revived.idle();
    expect(revived.org.cycle.number).toBe(2);
    await second.shutdown();
  });

  it('counts the budget as spent when what was spent was not saved as a number', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'the-organisation-store-'));
    const store = new Store(dir);
    await store.init();
    const options = { retryDelayMs: 1, emitIntervalMs: 1 };
    const first = new Registry(store, new MockProvider(QUIET), options);
    const runner = await first.create({ name: 'Fernery', idea: 'Houseplants by post.', executives: TEAM, settings: { maxCycles: 2, budgetUsd: 5 } });
    runner.start();
    await waitFor(() => runner.org.usage.calls > 3, 'some calls to be made');
    runner.pause();
    await runner.idle();
    await runner.flush();
    runner.dispose();
    const file = path.join(store.orgDir(runner.org.id), 'org.json');
    // A total that had stopped being a number is saved by JSON as null.
    const saved = JSON.parse(await readFile(file, 'utf8'));
    saved.usage.costUsd = null;
    saved.usageByExec.cto.costUsd = null;
    await writeFile(file, JSON.stringify(saved));

    const second = new Registry(store, new MockProvider(QUIET), options);
    await second.load();
    const revived = second.get(runner.org.id)!;
    expect(revived.org.usage.costUsd).toBe(5);
    expect(revived.org.usageByExec.cto!.costUsd).toBe(0);
    expect(revived.org.usage.calls).toBe(saved.usage.calls);
    expect(revived.org.pauseReason).toBe('budget');
    expect(revived.org.board.filter((m) => m.title === 'Recorded spend could not be read')).toHaveLength(1);
    expect(() => revived.start()).toThrow(/budget is spent/);
    // Said once: the totals are numbers again from here on.
    await revived.flush();
    revived.dispose();
    const third = new Registry(store, new MockProvider(QUIET), options);
    await third.load();
    expect(third.get(runner.org.id)!.org.board.filter((m) => m.title === 'Recorded spend could not be read')).toHaveLength(1);
    third.get(runner.org.id)!.updateSettings({ budgetUsd: 50 });
    third.get(runner.org.id)!.start();
    await third.get(runner.org.id)!.idle();
    expect(third.get(runner.org.id)!.org.usage.costUsd).toBeGreaterThan(5);
    await third.shutdown();
  });
});
