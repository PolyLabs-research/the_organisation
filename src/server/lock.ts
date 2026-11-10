import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// One server to a data folder. Two would each save over the other's state, and both could run the same
// organisation, spending its budget twice. The first to start puts its name in a file in the folder and keeps
// saying it is still there; a second one that finds a name still being said does not start.

interface Holder {
  pid: number;
  host: string;
  port: number;
  startedAt: string;
  /** When the holder last said it was still there. */
  beatAt: string;
}

export interface LockTimes {
  /** How often the holder says it is still there. */
  beatMs: number;
  /** How long a holder may be silent before it is taken for gone. */
  staleMs: number;
  /** How long to wait for a holder to go, or to fall silent, before giving up. A server being restarted is on its way out. */
  waitMs: number;
}
export const LOCK_TIMES: LockTimes = { beatMs: 2_000, staleMs: 8_000, waitMs: 12_000 };

export class DataDirInUse extends Error {}

/** Whether a process with this id is running on this machine. */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // Not allowed to signal it means it is there, and someone else's.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function holderOf(file: string): Promise<{ holder: Holder | null; silentMs: number } | null> {
  try {
    const [text, stat] = await Promise.all([fs.readFile(file, 'utf8'), fs.stat(file)]);
    let holder: Holder | null = null;
    try {
      const read = JSON.parse(text) as Partial<Holder>;
      if (typeof read.pid === 'number' && typeof read.host === 'string') holder = read as Holder;
    } catch {
      // Caught in the middle of being rewritten, or damaged: the file's own age says whether anyone is behind it.
    }
    const beat = holder ? Date.parse(holder.beatAt) : Number.NaN;
    return { holder, silentMs: Date.now() - (Number.isFinite(beat) ? beat : stat.mtimeMs) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Take the data folder for this server, or throw DataDirInUse if another server has it. Returns how to let go.
 * A name left behind by a server that died is recognised as such: at once if it ran on this machine, and
 * otherwise once it has been silent for long enough.
 */
export async function claimDataDir(dataDir: string, port: number, times: Partial<LockTimes> = {}): Promise<() => Promise<void>> {
  const { beatMs, staleMs, waitMs } = { ...LOCK_TIMES, ...times };
  const file = path.join(dataDir, 'server.lock');
  const mine = { pid: process.pid, host: os.hostname(), port, startedAt: new Date().toISOString() };
  const said = () => JSON.stringify({ ...mine, beatAt: new Date().toISOString() } satisfies Holder);
  // The first write fails if the file is already there, which is what makes one server the holder and no other.
  const take = () => fs.writeFile(file, said(), { flag: 'wx' });
  // Every later one replaces the file whole, written beside it and renamed over it: a server that is starting
  // reads this file, and should never find it empty or half-written because it looked while a beat was going in.
  const beside = `${file}.${process.pid}.tmp`;
  const sayAgain = async () => {
    await fs.writeFile(beside, said());
    await fs.rename(beside, file);
  };
  await fs.mkdir(dataDir, { recursive: true });

  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      await take();
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const found = await holderOf(file);
    if (!found) continue;
    const { holder, silentMs } = found;
    const gone = silentMs > staleMs || (holder !== null && holder.host === mine.host && (holder.pid === mine.pid || !running(holder.pid)));
    if (gone) {
      await fs.rm(file, { force: true });
      continue;
    }
    if (Date.now() > deadline) {
      const who = holder ? `process ${holder.pid} on ${holder.host}, listening on port ${holder.port} since ${holder.startedAt}` : 'another server';
      throw new DataDirInUse(
        `The data folder ${dataDir} is in use by ${who}. Two servers on one folder would save over each other and could run the same organisation twice. Stop that server, or start this one with ORG_DATA_DIR set to another folder.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(500, beatMs)));
  }

  const isMine = (holder: Holder | null) => holder !== null && holder.pid === mine.pid && holder.host === mine.host && holder.startedAt === mine.startedAt;
  let warned = false;
  // The beat under way, if there is one. Letting go waits for it: a beat that landed after the file had been
  // removed would put it back. And the next beat waits its turn behind it: two at once would share the file
  // beside the lock, and one could rename it into place while the other had only just emptied it.
  let beating: Promise<void> | null = null;
  const beat = setInterval(() => {
    if (beating) return;
    beating = (async () => {
      try {
        const found = await holderOf(file);
        if (found && found.holder && !isMine(found.holder)) {
          // This server was silent long enough (a suspended machine, say) for another to take it for gone.
          if (!warned) console.warn(`Another server (process ${found.holder.pid} on ${found.holder.host}) has taken the data folder ${dataDir} while this one was running. Stop one of them: they will save over each other.`);
          warned = true;
          return;
        }
        await sayAgain();
      } catch {
        // A beat that could not be written is tried again at the next one.
      } finally {
        beating = null;
      }
    })();
  }, beatMs);
  beat.unref();

  return async () => {
    clearInterval(beat);
    await beating;
    const found = await holderOf(file).catch(() => null);
    if (found && isMine(found.holder)) await fs.rm(file, { force: true });
    await fs.rm(beside, { force: true });
  };
}
