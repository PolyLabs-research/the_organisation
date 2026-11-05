import type {
  ActiveWork,
  ActivityEntry,
  Organisation,
  OrgSettings,
  OrgView,
  PauseReason,
  Task,
} from '../../shared/types';
import { MAX_AGENTS_PER_LEAD } from '../../shared/profiles';
import { ProviderError, type CallUsage, type Provider } from '../providers/types';
import type { Store } from '../store';
import { Workspace } from '../workspace';
import { StaleWork, describeWork, perform, type EngineContext } from './handlers';
import {
  CEO_QUESTION,
  LIVE_CYCLES,
  ValidationError,
  addSteer,
  addUsage,
  ceoOf,
  digestCycle,
  emptyUsage,
  execById,
  planById,
  postToBoard,
  sanitiseSettings,
  syncJudge,
  toClientView,
} from './state';
import { cycleComplete, nextWork, settle, type WorkItem } from './work';

export interface RunnerOptions {
  /** Base delay before a failed call is retried; doubles each attempt. */
  retryDelayMs?: number;
  /** Minimum gap between pushes to subscribers. */
  emitIntervalMs?: number;
}

const MAX_ATTEMPTS = 3;
const MAX_ACTIVITY = 300;
const MAX_HISTORY = 60;
/** Failures that say something about one task rather than about the provider. */
const TASK_LEVEL_ERRORS = new Set(['refusal', 'truncated', 'invalid_output']);

type Listener = (event: { type: 'view'; view: OrgView } | { type: 'activity'; entry: ActivityEntry } | { type: 'closed' }) => void;

/**
 * Runs one organisation. The loop is a reconciler: ask what work is ready,
 * start as much as capacity allows, and ask again whenever something
 * finishes. All state lives in `org`, so a paused or restarted organisation
 * picks up exactly where it stopped.
 */
export class OrgRunner {
  readonly workspace: Workspace;
  readonly activity: ActivityEntry[] = [];
  private readonly inFlight = new Map<string, ActiveWork>();
  private readonly attempts = new Map<string, number>();
  private readonly backoff = new Map<string, NodeJS.Timeout>();
  /** How many tasks each lead's agents have been given, for sharing call slots fairly. */
  private readonly served = new Map<string, number>();
  private readonly listeners = new Set<Listener>();
  private abort = new AbortController();
  private halting = false;
  private disposed = false;
  private emitTimer: NodeJS.Timeout | null = null;
  private saveTimer: NodeJS.Timeout | null = null;
  private saving: Promise<void> = Promise.resolve();
  private activitySeq = 0;
  private readonly retryDelayMs: number;
  private readonly emitIntervalMs: number;

  constructor(
    readonly org: Organisation,
    private readonly provider: Provider,
    private readonly store: Store,
    options: RunnerOptions = {},
  ) {
    this.workspace = new Workspace(store.workspaceRoot(org.id));
    this.retryDelayMs = options.retryDelayMs ?? 4000;
    this.emitIntervalMs = options.emitIntervalMs ?? 150;
  }

  view(): OrgView {
    return {
      org: toClientView(this.org),
      active: [...this.inFlight.values()],
      draining: this.org.status !== 'running' && this.inFlight.size > 0,
    };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** True while any model call for this organisation is still in flight. */
  get busy(): boolean {
    return this.inFlight.size > 0;
  }

  // ---- controls ----

  start(): void {
    const org = this.org;
    if (this.disposed) throw new ValidationError('This organisation has been deleted.');
    if (org.status === 'running') return;
    if (org.usage.costUsd >= org.settings.budgetUsd) {
      throw new ValidationError('The budget is spent. Raise it before starting the organisation again.');
    }
    if (org.settings.maxCycles !== null && org.cycle.number > org.settings.maxCycles) {
      throw new ValidationError('The cycle limit has been reached. Raise or remove it before starting again.');
    }
    if (this.abort.signal.aborted) this.abort = new AbortController();
    this.halting = false;
    org.status = 'running';
    org.pauseReason = null;
    org.lastError = null;
    if (!org.board.some((m) => m.type === 'ceo_question' && m.cycle === org.cycle.number)) {
      postToBoard(
        org,
        'ceo_question',
        ceoOf(org).id,
        CEO_QUESTION,
        org.cycle.number === 1
          ? 'The organisation is established. Before setting direction, the CEO asks each lead what their function should do first.'
          : `Before setting direction for cycle ${org.cycle.number}, the CEO asks each lead what their function should do next.`,
      );
    }
    this.pump();
  }

  /** Stop starting new work. Calls already in flight finish and their results are kept. */
  pause(reason: PauseReason = 'user', error: string | null = null): void {
    const org = this.org;
    if (org.status !== 'running') return;
    org.status = 'paused';
    org.pauseReason = reason;
    org.lastError = error;
    for (const timer of this.backoff.values()) clearTimeout(timer);
    this.backoff.clear();
    this.changed();
  }

  /** Pause and cut off the calls in flight. Interrupted work goes back in the queue. */
  stop(): void {
    this.pause('user');
    this.halting = true;
    this.abort.abort();
    this.changed();
  }

  steer(text: string): void {
    if (!text.trim()) throw new ValidationError('The steer is empty.');
    addSteer(this.org, text);
    this.changed();
    this.pump();
  }

  updateSettings(patch: Partial<OrgSettings>): void {
    const org = this.org;
    org.settings = sanitiseSettings(patch, org.settings);
    syncJudge(org);
    this.changed();
    this.pump();
  }

  setAgentCount(execId: string, count: number): void {
    const exec = execById(this.org, execId);
    if (!exec || exec.kind !== 'lead') throw new ValidationError('Only an executive lead can be allocated agents.');
    if (!Number.isFinite(count)) throw new ValidationError('The number of agents must be a number.');
    exec.agentCount = Math.min(MAX_AGENTS_PER_LEAD, Math.max(1, Math.round(count)));
    this.changed();
    this.pump();
  }

  /** Write the current state to disk now and wait for it. */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.queueSave();
    await this.saving;
  }

  /** Resolves when the loop is not running and nothing is in flight. For tests and shutdown. */
  async idle(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.org.status === 'running' || this.inFlight.size > 0) {
      if (Date.now() > deadline) throw new Error('timed out waiting for the organisation to come to rest');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  // ---- the loop ----

  private pump(): void {
    const org = this.org;
    if (org.status !== 'running') return;
    try {
      if (org.usage.costUsd >= org.settings.budgetUsd) {
        postToBoard(org, 'system', 'system', 'Budget reached', `Estimated spend has reached the $${org.settings.budgetUsd.toFixed(2)} budget. The organisation is paused until the shareholders raise it.`);
        this.pause('budget');
        return;
      }
      settle(org);
      let items = this.startable();
      if (!items.length && this.inFlight.size === 0 && this.backoff.size === 0) {
        if (cycleComplete(org)) {
          this.rollover();
          if (org.status !== 'running') return;
          settle(org);
          items = this.startable();
        } else {
          this.pause('error', 'The organisation has unfinished work but nothing it can start. This is a bug in the engine; the state is saved for inspection.');
          return;
        }
      }
      const room = () => this.inFlight.size < org.settings.maxConcurrentCalls;
      // A lead's own calls are short and unblock everything after them, so they go first.
      for (const item of items) {
        if (!room()) break;
        if (item.kind !== 'task') this.launch(item, null);
      }
      // Agent slots are then shared out: the next task goes to the lead with the
      // fewest agents working, and among equals to the one served least so far.
      // Otherwise the first lead in the list would take every free slot.
      const tasks = items.filter((item) => item.kind === 'task');
      while (room() && tasks.length) {
        let best = -1;
        let bestAgent: number | null = null;
        let bestRank = Infinity;
        tasks.forEach((item, index) => {
          const agent = this.freeAgent(item.execId);
          if (agent === null) return;
          const rank = this.busyAgents(item.execId) * 1e6 + (this.served.get(item.execId) ?? 0);
          if (rank < bestRank) {
            best = index;
            bestAgent = agent;
            bestRank = rank;
          }
        });
        if (best < 0) break;
        const [item] = tasks.splice(best, 1);
        this.served.set(item!.execId, (this.served.get(item!.execId) ?? 0) + 1);
        this.launch(item!, bestAgent);
      }
      this.changed();
    } catch (err) {
      this.pause('error', `Engine error: ${(err as Error).message}`);
    }
  }

  private startable(): WorkItem[] {
    return nextWork(this.org).filter((item) => !this.inFlight.has(item.key) && !this.backoff.has(item.key));
  }

  private busyAgents(execId: string): number {
    let n = 0;
    for (const work of this.inFlight.values()) if (work.kind === 'task' && work.execId === execId) n += 1;
    return n;
  }

  /** The lowest-numbered agent of a lead that is not on a task, or null if all are busy. */
  private freeAgent(execId: string): number | null {
    const exec = execById(this.org, execId);
    const count = Math.max(exec?.agentCount ?? 1, 1);
    const busy = new Set<number>();
    for (const work of this.inFlight.values()) {
      if (work.kind === 'task' && work.execId === execId && work.agent !== null) busy.add(work.agent);
    }
    for (let n = 1; n <= count; n++) if (!busy.has(n)) return n;
    return null;
  }

  private taskOf(item: WorkItem): Task | undefined {
    if (item.kind !== 'task') return undefined;
    return planById(this.org, item.planId)?.phases[item.phaseIndex]?.tasks.find((t) => t.id === item.taskId);
  }

  private launch(item: WorkItem, agent: number | null): void {
    const org = this.org;
    const active: ActiveWork = {
      key: item.key,
      kind: item.kind,
      execId: item.execId,
      agent,
      label: describeWork(org, item),
      planId: 'planId' in item ? item.planId : null,
      startedAt: new Date().toISOString(),
    };
    this.inFlight.set(item.key, active);
    const task = this.taskOf(item);
    if (task) {
      task.status = 'running';
      task.agent = agent;
      task.startedAt = active.startedAt;
      task.attempts += 1;
    }
    void this.run(item, active);
  }

  private async run(item: WorkItem, active: ActiveWork): Promise<void> {
    const org = this.org;
    const started = Date.now();
    const spent = { model: '', inputTokens: 0, outputTokens: 0, costUsd: 0 };
    const ctx: EngineContext = {
      org,
      provider: this.provider,
      workspace: this.workspace,
      signal: this.abort.signal,
      halting: () => this.halting,
      overBudget: () => org.usage.costUsd >= org.settings.budgetUsd,
      recordUsage: (execId: string, usage: CallUsage) => {
        addUsage(org.usage, usage);
        addUsage((org.usageByExec[execId] ??= emptyUsage()), usage);
        spent.model = usage.model;
        spent.inputTokens += usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
        spent.outputTokens += usage.outputTokens;
        spent.costUsd += usage.costUsd;
        this.changed();
      },
    };
    let error: string | null = null;
    try {
      const commit = await perform(item, ctx);
      commit();
      this.attempts.delete(item.key);
    } catch (err) {
      error = this.fail(item, err);
    } finally {
      this.inFlight.delete(item.key);
      this.record({
        id: `a${++this.activitySeq}`,
        at: new Date().toISOString(),
        kind: item.kind,
        execId: item.execId,
        label: active.agent ? `Agent ${active.agent}: ${active.label}` : active.label,
        model: spent.model,
        ms: Date.now() - started,
        ok: error === null,
        error,
        inputTokens: spent.inputTokens,
        outputTokens: spent.outputTokens,
        costUsd: spent.costUsd,
      });
      this.changed();
      this.pump();
    }
  }

  /** Decide what a failed call means. Returns the message to log, or null if the failure needs no mention. */
  private fail(item: WorkItem, err: unknown): string | null {
    if (err instanceof StaleWork) return null;
    const task = this.taskOf(item);
    const requeue = () => {
      if (task && task.status === 'running') {
        task.status = 'pending';
        task.agent = null;
        task.startedAt = null;
      }
    };
    const providerError = err instanceof ProviderError ? err : null;
    const message = err instanceof Error ? err.message : String(err);
    if (providerError?.code === 'aborted' || this.abort.signal.aborted) {
      requeue();
      return 'Interrupted';
    }
    const attempts = (this.attempts.get(item.key) ?? 0) + 1;
    this.attempts.set(item.key, attempts);
    if (providerError?.retryable && attempts < MAX_ATTEMPTS) {
      requeue();
      // While paused there is nothing to time: the work is simply picked up again on resume.
      if (this.org.status === 'running') {
        const timer = setTimeout(
          () => {
            this.backoff.delete(item.key);
            this.pump();
          },
          this.retryDelayMs * 2 ** (attempts - 1),
        );
        this.backoff.set(item.key, timer);
      }
      return `${message} (will retry)`;
    }
    this.attempts.delete(item.key);
    if (task && providerError && TASK_LEVEL_ERRORS.has(providerError.code)) {
      // The lead sees the failure at the phase gate and decides what to do about it.
      task.status = 'failed';
      task.error = message;
      task.finishedAt = new Date().toISOString();
      return message;
    }
    requeue();
    this.pause('error', message);
    return message;
  }

  /** All jobs are done: close the cycle and put the CEO's question to the board again. */
  private rollover(): void {
    const org = this.org;
    const finished = org.cycle.number;
    const endedAt = new Date().toISOString();
    org.history.push(digestCycle(org, endedAt));
    if (org.history.length > MAX_HISTORY) org.history.splice(0, org.history.length - MAX_HISTORY);

    const next = finished + 1;
    const archiveUpTo = next - LIVE_CYCLES;
    const old = (cycle: number) => cycle <= archiveUpTo;
    const leaving = new Set([...org.plans, ...org.board].filter((x) => old(x.cycle)).map((x) => x.cycle));
    for (const cycle of leaving) {
      const data = {
        cycle,
        record: org.history.find((c) => c.number === cycle),
        plans: org.plans.filter((p) => p.cycle === cycle),
        decisions: org.decisions.filter((d) => d.cycle === cycle),
        reports: org.reports.filter((r) => r.cycle === cycle),
        reviewRounds: org.reviewRounds.filter((r) => r.cycle === cycle),
        board: org.board.filter((m) => m.cycle === cycle),
      };
      this.store.archiveCycle(org.id, cycle, data).catch((err) => console.warn(`Could not archive cycle ${cycle} of ${org.id}: ${err.message}`));
    }
    org.plans = org.plans.filter((p) => !old(p.cycle));
    org.decisions = org.decisions.filter((d) => !old(d.cycle));
    org.reports = org.reports.filter((r) => !old(r.cycle));
    org.reviewRounds = org.reviewRounds.filter((r) => !old(r.cycle));
    org.board = org.board.filter((m) => !old(m.cycle));
    org.inbox = {};

    org.cycle = { number: next, stage: 'consult', consults: {}, intent: null, priorities: [], startedAt: endedAt };
    if (org.settings.maxCycles !== null && finished >= org.settings.maxCycles) {
      postToBoard(org, 'system', 'system', 'Cycle limit reached', `The organisation has completed ${finished} cycle${finished === 1 ? '' : 's'}, the limit set by the shareholders, and is paused.`);
      this.pause('cycle_limit');
      return;
    }
    postToBoard(
      org,
      'ceo_question',
      ceoOf(org).id,
      CEO_QUESTION,
      `All work from cycle ${finished} is complete. Before setting direction for cycle ${next}, the CEO asks each lead what their function should do next.`,
    );
  }

  // ---- persistence and notification ----

  private record(entry: ActivityEntry): void {
    if (this.disposed) return;
    this.activity.push(entry);
    if (this.activity.length > MAX_ACTIVITY) this.activity.splice(0, this.activity.length - MAX_ACTIVITY);
    this.store.appendActivity(this.org.id, entry).catch(() => {});
    for (const listener of this.listeners) listener({ type: 'activity', entry });
  }

  private changed(): void {
    if (this.disposed) return;
    this.org.updatedAt = new Date().toISOString();
    if (!this.emitTimer) {
      this.emitTimer = setTimeout(() => {
        this.emitTimer = null;
        if (!this.listeners.size) return;
        const view = this.view();
        for (const listener of this.listeners) listener({ type: 'view', view });
      }, this.emitIntervalMs);
    }
    if (!this.saveTimer) {
      this.saveTimer = setTimeout(() => {
        this.saveTimer = null;
        this.queueSave();
      }, 400);
    }
  }

  private queueSave(): void {
    if (this.disposed) return;
    this.saving = this.saving
      .then(() => this.store.save(this.org))
      .catch((err) => console.warn(`Could not save ${this.org.id}: ${(err as Error).message}`));
  }

  /** Cancel timers and let go of subscribers. The state must already be flushed; nothing is written after this. */
  dispose(): void {
    this.disposed = true;
    for (const listener of this.listeners) listener({ type: 'closed' });
    for (const timer of this.backoff.values()) clearTimeout(timer);
    this.backoff.clear();
    if (this.emitTimer) clearTimeout(this.emitTimer);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.emitTimer = this.saveTimer = null;
    this.listeners.clear();
  }
}
