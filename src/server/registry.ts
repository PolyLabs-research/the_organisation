import { randomBytes } from 'node:crypto';
import type { CreateOrgRequest, OrgSummary } from '../shared/types';
import { OrgRunner, type RunnerOptions } from './engine/runner';
import { ValidationError, assertModelRefs, createOrganisation, normaliseLoaded, summarise } from './engine/state';
import type { Provider } from './providers/types';
import type { Store } from './store';

/** Every organisation this server knows about, each with the runner that drives it. */
export class Registry {
  private readonly runners = new Map<string, OrgRunner>();

  constructor(
    private readonly store: Store,
    readonly provider: Provider,
    private readonly options: RunnerOptions = {},
  ) {}

  async load(): Promise<void> {
    for (const org of await this.store.loadAll()) {
      const runner = new OrgRunner(normaliseLoaded(org), this.provider, this.store, this.options);
      await runner.workspace.init();
      this.runners.set(org.id, runner);
    }
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
    for (const [seat, model] of [['executives', settings.executiveModel], ['agents', settings.workerModel]] as const) {
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
    // Its hosted sessions would be left with nothing to say what they were for. Where the organisation was
    // set to archive sessions, the ones still open are archived with it.
    if (runner.org.settings.archiveSessions) await runner.archiveSessions({ all: true }).catch(() => {});
    await runner.flush();
    runner.dispose();
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
      }),
    );
  }
}
