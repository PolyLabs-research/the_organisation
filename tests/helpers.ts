import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ExecutiveDraft, OrgSettings, Organisation, Plan } from '../src/shared/types';
import type { OrgRunner } from '../src/server/engine/runner';
import { MockProvider, type MockOptions } from '../src/server/providers/mock';
import type { Provider } from '../src/server/providers/types';
import { Registry } from '../src/server/registry';
import { Store } from '../src/server/store';

export const TEAM: ExecutiveDraft[] = [{ profileId: 'engineering', agentCount: 2 }, { profileId: 'product' }, { profileId: 'marketing' }];

/** A quiet simulator: no objections, follow-ups or rework unless a test asks for them. */
export const QUIET: MockOptions = { delayMs: 0, objections: 'never', followUps: 'never', rework: 'never', requests: 'never' };

export interface Harness {
  runner: OrgRunner;
  org: Organisation;
  registry: Registry;
  store: Store;
  provider: Provider;
  dir: string;
  cleanup(): Promise<void>;
}

export async function harness(
  options: {
    mock?: MockOptions;
    provider?: Provider;
    settings?: Partial<OrgSettings>;
    executives?: ExecutiveDraft[];
    steer?: string;
  } = {},
): Promise<Harness> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'the-organisation-'));
  const store = new Store(dir);
  await store.init();
  const provider = options.provider ?? new MockProvider({ ...QUIET, ...options.mock });
  const registry = new Registry(store, provider, { retryDelayMs: 1, emitIntervalMs: 1 });
  const runner = await registry.create({
    name: 'Fernery',
    idea: 'A subscription box that sends people a new houseplant every month, with care instructions.',
    executives: options.executives ?? TEAM,
    settings: { maxCycles: 1, budgetUsd: 1000, ...options.settings },
    steer: options.steer,
  });
  return {
    runner,
    org: runner.org,
    registry,
    store,
    provider,
    dir,
    async cleanup() {
      runner.stop();
      await runner.idle().catch(() => {});
      await runner.flush();
      runner.dispose();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** Start the organisation and wait until it comes to rest (paused, with nothing in flight). */
export async function runToRest(runner: OrgRunner): Promise<void> {
  runner.start();
  await runner.idle();
}

export async function waitFor(condition: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

export function plansOf(org: Organisation, cycle: number): Plan[] {
  return org.plans.filter((p) => p.cycle === cycle);
}
