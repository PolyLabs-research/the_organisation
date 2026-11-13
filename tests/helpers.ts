import type { RunnerOptions } from '../src/server/engine/runner';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
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
    /** Anything further for the organisation's runner, such as a stand-in for a code host. */
    runner?: RunnerOptions;
  } = {},
): Promise<Harness> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'the-organisation-'));
  const store = new Store(dir);
  await store.init();
  const provider = options.provider ?? new MockProvider({ ...QUIET, ...options.mock });
  const registry = new Registry(store, provider, { retryDelayMs: 1, emitIntervalMs: 1, ...options.runner });
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

/**
 * Start the organisation and wait until it comes to rest (paused, with nothing in flight). The wait is a little shorter
 * than the time a test is given, so that an organisation that never rests fails here, saying where it had got to, and not
 * as a test that merely ran out of time. A test that is given longer says how long to wait.
 */
export async function runToRest(runner: OrgRunner, timeoutMs = 18_000): Promise<void> {
  runner.start();
  await runner.idle(timeoutMs).catch((err: Error) => {
    const org = runner.org;
    throw new Error(
      `${err.message}: it is ${org.status}${org.pauseReason ? ` (${org.pauseReason})` : ''} in cycle ${org.cycle.number}, at ${org.cycle.stage}, having spent $${org.usage.costUsd.toFixed(2)} of a budget of $${org.settings.budgetUsd.toFixed(2)}`,
    );
  });
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

/** Where the tests that drive a real browser look for Chrome. */
export const CHROME = process.env.CHROME_PATH ?? '/opt/google/chrome/chrome';

/**
 * Whether the tests that drive a real browser have to be left out here. They need Chrome, and the ones that open
 * the dashboard need a built client. On a person's own machine, without those, they are skipped. Where the suite
 * decides whether a change may go in, set REQUIRE_BROWSER=1: a test that was skipped has checked nothing, so there
 * a missing browser or a missing build stops the run and says what is missing.
 */
/** The command the sandbox tests run containers with, and the image they run them from: anything with a shell and the usual tools. */
export const DOCKER = process.env.ORG_SANDBOX_COMMAND ?? 'docker';
export const SANDBOX_IMAGE = process.env.ORG_SANDBOX_TEST_IMAGE ?? 'alpine:3.20';

let sandboxMissing: string | null | undefined;
/**
 * Whether the tests that run real containers have to be left out: the container service is not running here, or the
 * image cannot be had. Like the tests that need a browser, they are skipped then on your own machine. Where a run
 * decides whether a change may go in, set REQUIRE_SANDBOX=1, and a missing service stops the run and says so.
 */
export function withoutSandbox(): boolean {
  if (sandboxMissing === undefined) {
    const ask = (args: string[], timeout: number) => spawnSync(DOCKER, args, { timeout, encoding: 'utf8' });
    if (ask(['version', '--format', '{{.Server.Version}}'], 15_000).status !== 0) sandboxMissing = `no container service answered the ${DOCKER} command`;
    else if (ask(['image', 'inspect', '--format', '{{.Id}}', SANDBOX_IMAGE], 20_000).status !== 0 && ask(['pull', '--quiet', SANDBOX_IMAGE], 240_000).status !== 0) sandboxMissing = `the image ${SANDBOX_IMAGE} is not here and could not be fetched (set ORG_SANDBOX_TEST_IMAGE to one that can)`;
    else sandboxMissing = null;
  }
  if (sandboxMissing && process.env.REQUIRE_SANDBOX === '1') throw new Error(`REQUIRE_SANDBOX is set, but ${sandboxMissing}.`);
  return sandboxMissing !== null;
}

export function withoutBrowser(needs: { build?: boolean } = {}): boolean {
  const missing = [
    ...(existsSync(CHROME) ? [] : [`Chrome was not found at ${CHROME} (set CHROME_PATH to where it is)`]),
    ...(needs.build && !existsSync('dist/client/index.html') ? ['the client has not been built (run "npm run build" first)'] : []),
  ];
  if (missing.length && process.env.REQUIRE_BROWSER === '1') throw new Error(`REQUIRE_BROWSER is set, but ${missing.join(', and ')}.`);
  return missing.length > 0;
}
