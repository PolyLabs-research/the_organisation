import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rename, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DataDirInUse, claimDataDir } from '../src/server/lock';

// Beats come fast, but a holder is only taken for gone after a silence no busy machine would produce by accident.
const QUICK = { beatMs: 20, staleMs: 3000, waitMs: 300 };

let dir: string | undefined;
const release: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const letGo of release.splice(0)) await letGo();
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const lock = () => path.join(dir!, 'server.lock');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(what: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await what())) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await sleep(10);
  }
}

/**
 * Another server saying that it is still there, the way a real one does: the file replaced whole, one beat at a
 * time. Returns how to stop it, which waits for a beat that is under way so that none lands afterwards.
 */
function saying(other: object, everyMs = 20): () => Promise<void> {
  let under: Promise<void> | null = null;
  const timer = setInterval(() => {
    if (under) return;
    under = (async () => {
      const beside = `${lock()}.other.tmp`;
      try {
        await writeFile(beside, JSON.stringify({ ...other, beatAt: new Date().toISOString() }));
        await rename(beside, lock());
      } catch {
        // The folder has gone: the test is over.
      } finally {
        under = null;
      }
    })();
  }, everyMs);
  return async () => {
    clearInterval(timer);
    await under;
  };
}

/** A process that is certainly not running: one that was started and has ended. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '0']);
  await new Promise((resolve) => child.once('exit', resolve));
  return child.pid!;
}

describe('one server to a data folder', () => {
  it('takes a free folder, says who holds it, and gives it back', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'the-organisation-lock-'));
    const letGo = await claimDataDir(dir, 4780, QUICK);
    const held = JSON.parse(await readFile(lock(), 'utf8'));
    expect(held).toMatchObject({ pid: process.pid, host: os.hostname(), port: 4780 });
    await letGo();
    expect(existsSync(lock())).toBe(false);
  });

  it('keeps saying it is there for as long as it holds the folder', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'the-organisation-lock-'));
    release.push(await claimDataDir(dir, 4780, QUICK));
    const beatAt = async () => Date.parse(JSON.parse(await readFile(lock(), 'utf8').catch(() => '{}')).beatAt ?? '');
    const first = await beatAt();
    await until(async () => (await beatAt()) > first);
  });

  it('is never found empty or half-written by whoever reads it, and is not put back once it has been let go', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'the-organisation-lock-'));
    // A beat every couple of milliseconds, read as fast as it can be read: a server that is starting reads this file.
    const letGo = await claimDataDir(dir, 4780, { ...QUICK, beatMs: 2 });
    release.push(letGo);
    const first = JSON.parse(await readFile(lock(), 'utf8')).beatAt as string;
    const beats = new Set<string>();
    const deadline = Date.now() + 5000;
    while (beats.size < 40 && Date.now() < deadline) {
      beats.add((JSON.parse(await readFile(lock(), 'utf8')) as { beatAt: string }).beatAt);
    }
    expect(beats.size).toBeGreaterThanOrEqual(40);
    expect([...beats].every((at) => at >= first)).toBe(true);
    // Let go in the middle of all that, the file is gone and stays gone, and nothing is left beside it.
    await letGo();
    await sleep(30);
    expect(await readdir(dir)).toEqual([]);
  });

  it('refuses a folder another running server holds, and says which', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'the-organisation-lock-'));
    // Another server on another machine, still saying it is there.
    const other = { pid: 4242, host: 'another-machine', port: 4781, startedAt: '2026-11-01T09:00:00.000Z' };
    await writeFile(lock(), JSON.stringify({ ...other, beatAt: new Date().toISOString() }));
    const stop = saying(other);
    try {
      const error = await claimDataDir(dir, 4780, QUICK).then(
        (letGo) => (release.push(letGo), null),
        (err: unknown) => err,
      );
      expect(error).toBeInstanceOf(DataDirInUse);
      expect((error as Error).message).toMatch(/in use by process 4242 on another-machine, listening on port 4781.*ORG_DATA_DIR/);
      // And it has not touched the holder's claim.
      expect(JSON.parse(await readFile(lock(), 'utf8'))).toMatchObject({ pid: 4242, host: 'another-machine' });
    } finally {
      await stop();
    }
  });

  it('waits for a server that is on its way out, as one being restarted is', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'the-organisation-lock-'));
    // The server being replaced is still there, still saying so, and lets go a moment later.
    const other = { pid: 4242, host: 'another-machine', port: 4780, startedAt: '2026-11-01T09:00:00.000Z' };
    await writeFile(lock(), JSON.stringify({ ...other, beatAt: new Date().toISOString() }));
    const stop = saying(other);
    setTimeout(() => void stop().then(() => rm(lock(), { force: true })), 100);
    const started = Date.now();
    try {
      release.push(await claimDataDir(dir, 4790, { ...QUICK, waitMs: 5000 }));
    } finally {
      await stop();
    }
    expect(Date.now() - started).toBeGreaterThanOrEqual(80);
    expect(JSON.parse(await readFile(lock(), 'utf8'))).toMatchObject({ pid: process.pid, port: 4790 });
  });

  it('takes over at once from a server on this machine that has died', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'the-organisation-lock-'));
    await writeFile(lock(), JSON.stringify({ pid: await deadPid(), host: os.hostname(), port: 4780, startedAt: new Date().toISOString(), beatAt: new Date().toISOString() }));
    const started = Date.now();
    release.push(await claimDataDir(dir, 4780, { beatMs: 20, staleMs: 60_000, waitMs: 60_000 }));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(JSON.parse(await readFile(lock(), 'utf8')).pid).toBe(process.pid);
  });

  it('takes over from a server elsewhere once it has been silent long enough, and from a file nobody can read', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'the-organisation-lock-'));
    await writeFile(lock(), JSON.stringify({ pid: 4242, host: 'another-machine', port: 4781, startedAt: '2026-11-01T09:00:00.000Z', beatAt: new Date(Date.now() - 60_000).toISOString() }));
    await (await claimDataDir(dir, 4780, QUICK))();
    await writeFile(lock(), '{"pid": 42');
    const old = new Date(Date.now() - 60_000);
    await utimes(lock(), old, old);
    release.push(await claimDataDir(dir, 4780, QUICK));
    expect(JSON.parse(await readFile(lock(), 'utf8')).pid).toBe(process.pid);
  });

  it('leaves alone, and warns about, a claim that another server has taken from under it', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'the-organisation-lock-'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const letGo = await claimDataDir(dir, 4780, QUICK);
      const usurper = { pid: 4242, host: 'another-machine', port: 4781, startedAt: '2026-11-01T09:00:00.000Z', beatAt: new Date().toISOString() };
      await writeFile(lock(), JSON.stringify(usurper));
      await until(() => warn.mock.calls.length > 0);
      await sleep(100);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toMatch(/Another server \(process 4242 on another-machine\) has taken the data folder/);
      await letGo();
      expect(JSON.parse(await readFile(lock(), 'utf8'))).toMatchObject({ pid: 4242 });
    } finally {
      warn.mockRestore();
    }
  });
});
