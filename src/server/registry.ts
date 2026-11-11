import { randomBytes } from 'node:crypto';
import { operatingDigest } from '../shared/business';
import type { CreateOrgRequest, OrgSummary } from '../shared/types';
import { OrgRunner, type RunnerOptions } from './engine/runner';
import { UnreadableOrganisation, ValidationError, assertLoadable, assertModelRefs, createOrganisation, normaliseLoaded, summarise, toClientView } from './engine/state';
import { nextWork } from './engine/work';
import type { Provider } from './providers/types';
import type { SandboxRuntime } from './sandbox';
import type { Store } from './store';

/** How long deleting an organisation waits for its hosted sessions to be held. */
const HOLD_BEFORE_REMOVAL_MS = 30_000;

/** Every organisation this server knows about, each with the runner that drives it. */
export class Registry {
  private readonly runners = new Map<string, OrgRunner>();

  constructor(
    private readonly store: Store,
    readonly provider: Provider,
    private readonly options: RunnerOptions = {},
  ) {}

  /** What this server runs code with, if anything: for telling a person whether it can. */
  get sandbox(): SandboxRuntime | null {
    return this.options.sandbox ?? null;
  }

  /**
   * Organisations on disk that could not be loaded, and why. One damaged file must not stand between a person
   * and every other organisation, so it is set aside, said out loud, and left on disk exactly as it was.
   */
  readonly unreadable: Array<{ folder: string; reason: string }> = [];

  async load(): Promise<void> {
    const resume: OrgRunner[] = [];
    const found = await this.store.scan();
    this.unreadable.length = 0;
    this.unreadable.push(...found.unreadable);
    for (const saved of found.orgs) {
      const folder = typeof saved?.id === 'string' ? saved.id : '';
      try {
        assertLoadable(saved);
        const shouldResume = saved.settings.resumeOnRestart === true && (saved.status === 'running' || (saved.status === 'paused' && saved.pauseReason === 'restart'));
        const org = normaliseLoaded(saved);
        // Everything the dashboard and the scheduler will ask of it, asked once now. What would otherwise throw on
        // every request, or in the middle of a run, is found here, where it costs one organisation and not the server.
        summarise(org);
        toClientView(org);
        operatingDigest(org);
        nextWork(org);
        const runner = new OrgRunner(org, this.provider, this.store, this.options);
        await runner.workspace.init();
        this.runners.set(org.id, runner);
        if (shouldResume) resume.push(runner);
      } catch (err) {
        const reason = err instanceof UnreadableOrganisation ? err.message : `its saved state could not be used (${(err as Error).message}).`;
        this.unreadable.push({ folder, reason });
      }
    }
    for (const { folder, reason } of this.unreadable) console.warn(`Organisation ${folder} was not loaded: ${reason}`);
    for (const runner of resume) {
      try { runner.start(); } catch (error) { runner.org.lastError = 'Automatic resume: ' + (error as Error).message; await runner.flush(); }
    }
    // A hosted session that was at work when the server stopped without warning had nobody to hold it, and can go on
    // spending up to its cap. One whose organisation has just started again and is picking it up is left to that. The
    // others are held, beside everything else: starting must not wait on the provider, which may be out of reach.
    for (const runner of this.runners.values()) runner.holdAdrift();
  }

  list(): OrgSummary[] {
    return [...this.runners.values()].map((r) => summarise(r.org)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): OrgRunner | undefined {
    return this.runners.get(id);
  }

  async create(req: CreateOrgRequest): Promise<OrgRunner> {
    const id = `org_${randomBytes(5).toString('hex')}`;
    // Models not named in the request are the provider's default, which depends on which keys are connected.
    const fallback = this.provider.defaultModel?.();
    assertModelRefs(req.settings);
    const settings = { ...req.settings };
    if (fallback) {
      settings.executiveModel ??= fallback;
      settings.workerModel ??= fallback;
    }
    for (const [seat, model] of [['executives', settings.executiveModel], ['agents', settings.workerModel], ...(settings.workerLadder ?? []).map((rung) => ['agents’ lighter tasks', rung.model] as const)] as const) {
      if (model && this.provider.knows && !this.provider.knows(model)) {
        throw new ValidationError(`The model chosen for the ${seat}, "${model}", is not one a connected key can call. Add its key under Models and keys, or pick another model.`);
      }
    }
    const runner = new OrgRunner(createOrganisation({ ...req, settings }, id), this.provider, this.store, this.options);
    await runner.workspace.init();
    await runner.flush();
    this.runners.set(id, runner);
    return runner;
  }

  async remove(id: string): Promise<boolean> {
    const runner = this.runners.get(id);
    if (!runner) return false;
    // Out of the registry first: a request arriving while the work winds down must not find it.
    this.runners.delete(id);
    runner.stop();
    await runner.idle().catch(() => {});
    // Once the organisation is gone nothing knows of its hosted sessions, so none may be left with room to spend.
    // The ones that were being followed have just been held. Any other that is not finished is held here: it is
    // usually at its cap already, and then this changes nothing. It is given half a minute and no longer, so that
    // an organisation can still be deleted while the provider is out of reach.
    await Promise.race([
      runner.holdSessions({ all: true }).catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, HOLD_BEFORE_REMOVAL_MS).unref()),
    ]);
    // Its hosted sessions would be left with nothing to say what they were for. Where the organisation was
    // set to archive sessions, the ones still open are archived with it.
    if (runner.org.settings.archiveSessions) await runner.archiveSessions({ all: true }).catch(() => {});
    // What its plans' commands left in sandboxes is removed with it. Half a minute, as above: the container service may be away.
    await Promise.race([runner.clearSandboxes(true), new Promise<void>((resolve) => setTimeout(resolve, HOLD_BEFORE_REMOVAL_MS).unref())]);
    await runner.flush();
    runner.dispose();
    await runner.access.dispose();
    await this.store.remove(id);
    return true;
  }

  /** Halt every organisation and write its state, ready for the process to exit. */
  async shutdown(): Promise<void> {
    await Promise.all(
      [...this.runners.values()].map(async (runner) => {
        runner.pause('restart');
        runner.stop();
        // Long enough for a hosted session to be capped at what it has spent before the process goes.
        await runner.idle(8000).catch(() => {});
        await runner.flush();
        runner.dispose();
        await runner.access.dispose();
      }),
    );
  }
}
