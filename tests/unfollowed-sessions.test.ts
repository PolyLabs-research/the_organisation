import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Organisation, Plan } from '../src/shared/types';
import type { OrgRunner } from '../src/server/engine/runner';
import { MockProvider } from '../src/server/providers/mock';
import { ProviderError } from '../src/server/providers/types';
import { Registry } from '../src/server/registry';
import { harness, runToRest, waitFor, type Harness } from './helpers';

// A hosted session is held by whoever follows it, as it lets go. These are the sessions that had nobody to do
// that: the ones at work when the server stopped without warning, and the ones of an organisation being deleted.

let h: Harness | undefined;
let revived: OrgRunner | undefined;
afterEach(async () => {
  revived?.dispose();
  revived = undefined;
  await h?.cleanup();
  h = undefined;
});

const HOSTED = { execution: 'managed' as const };
const ONE_LEAD = [{ profileId: 'engineering', agentCount: 2 }];
const planOf = (org: Organisation): Plan => org.plans.find((p) => p.ownerId === 'cto')!;

/**
 * Leave on disk what would be there had the server died while the plan's session was at work: the organisation
 * running, the session being followed, its cap as it stood. Returns the session's id and that cap.
 */
async function diedAtWork(h: Harness): Promise<{ session: string; capAtWork: number }> {
  h.runner.start();
  await waitFor(() => planOf(h.org)?.phases[0]?.status === 'done', 'the first phase');
  const capAtWork = planOf(h.org).managed!.budgetUsd;
  h.runner.pause();
  await h.runner.idle();
  await h.runner.flush();
  const file = path.join(h.store.orgDir(h.org.id), 'org.json');
  const saved = JSON.parse(await readFile(file, 'utf8')) as Organisation;
  saved.status = 'running';
  saved.pauseReason = null;
  const managed = planOf(saved).managed!;
  managed.state = 'running';
  managed.budgetUsd = capAtWork;
  await writeFile(file, JSON.stringify(saved));
  return { session: managed.sessionId!, capAtWork };
}

/** The same account, seen from a new process. */
async function restart(h: Harness, options: { holdRetryMs?: number } = {}): Promise<OrgRunner> {
  const registry = new Registry(h.store, h.provider, { retryDelayMs: 1, emitIntervalMs: 1, ...options });
  await registry.load();
  return registry.get(h.org.id)!;
}

describe('a hosted session that was at work when the server stopped without warning', () => {
  it('is held when the server comes back, and carries on when the organisation is started', async () => {
    h = await harness({ settings: HOSTED, executives: ONE_LEAD, mock: { delayMs: 2, runs: 'never' } });
    const platform = h.provider as MockProvider;
    const { session, capAtWork } = await diedAtWork(h);

    revived = await restart(h);
    expect(revived.org.pauseReason).toBe('restart');
    await revived.idle();
    // Its cap is down to what it has spent, and the organisation knows the cap it now has.
    expect(platform.held).toEqual([session]);
    const managed = planOf(revived.org).managed!;
    expect(managed.adrift).toBe(false);
    expect(managed.budgetUsd).toBe(Math.round((managed.spentUsd + 0.02) * 100) / 100);
    expect(managed.budgetUsd).toBeLessThan(capAtWork);
    expect(revived.org.board.map((m) => m.title).filter((title) => /held/.test(title))).toEqual([]);
    // It is not asked a second time.
    revived.holdAdrift();
    await revived.idle();
    expect(platform.held).toEqual([session]);

    await runToRest(revived);
    expect(planOf(revived.org).status).toBe('done');
    expect(planOf(revived.org).managed!.sessionId).toBe(session);
  });

  it('is picked up, not held, when its organisation starts by itself after a restart', async () => {
    h = await harness({ settings: { ...HOSTED, resumeOnRestart: true }, executives: ONE_LEAD, mock: { delayMs: 2, runs: 'never' } });
    const platform = h.provider as MockProvider;
    const { session } = await diedAtWork(h);

    revived = await restart(h);
    await revived.idle();
    expect(platform.held).toEqual([]);
    expect(planOf(revived.org).status).toBe('done');
    expect(planOf(revived.org).managed).toMatchObject({ sessionId: session, adrift: false });
  });

  it('is tried again when it cannot be held, and the board is told that it may still be spending', async () => {
    let refusals = 2;
    h = await harness({
      settings: HOSTED,
      executives: ONE_LEAD,
      mock: {
        delayMs: 2,
        runs: 'never',
        onCall: (kind) => {
          if (kind === 'hold_session' && refusals-- > 0) throw new ProviderError('The provider could not be reached.', 'unavailable', true);
        },
      },
    });
    const platform = h.provider as MockProvider;
    const { session } = await diedAtWork(h);

    revived = await restart(h, { holdRetryMs: 5 });
    const back = revived;
    const said = () => back.org.board.map((m) => m.title).filter((title) => /held/.test(title));
    await waitFor(() => said().length > 0, 'the board to be told');
    const note = back.org.board.find((m) => m.title === 'A hosted session could not be held')!;
    expect(note.body).toContain('The provider could not be reached.');
    expect(note.body).toMatch(/up to about \$\d+\.\d\d more, although the organisation is paused/);

    await waitFor(() => platform.held.length > 0, 'the session to be held');
    await back.idle();
    expect(platform.held).toEqual([session]);
    expect(planOf(back.org).managed!.adrift).toBe(false);
    // Said once that it failed, however many tries that took, and once that it is done.
    expect(said()).toEqual(['A hosted session could not be held', 'Hosted sessions held']);
  });
});

describe('the hosted sessions of an organisation that is deleted', () => {
  it('are held first, whether or not anyone was following them', async () => {
    h = await harness({ settings: HOSTED, executives: ONE_LEAD, mock: { delayMs: 3, runs: 'never' } });
    const platform = h.provider as MockProvider;
    h.runner.start();
    await waitFor(() => planOf(h!.org)?.phases[0]?.status === 'done', 'the first phase');
    h.runner.pause();
    await h.runner.idle();
    const session = planOf(h.org).managed!.sessionId;
    expect(planOf(h.org).status).toBe('executing');

    expect(await h.registry.remove(h.org.id)).toBe(true);
    expect(platform.held).toEqual([session]);
  });
});
