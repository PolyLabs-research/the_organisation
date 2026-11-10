import path from 'node:path';
import { BusinessAccess, type AccessOptions } from '../access';
import { operatingDigest } from '../../shared/business';
import { PRIVILEGE_BY_ID, allows, type Privilege } from '../../shared/privileges';
import { applyBusinessCommand, consumeBusinessWake, nextBusinessWake, syncBusinessJobs } from './business';
import type {
  ActiveWork,
  ActivityEntry,
  Organisation,
  OrgSettings,
  OrgView,
  PauseReason,
  Plan,
  Task,
} from '../../shared/types';
import { MAX_AGENTS_PER_LEAD } from '../../shared/profiles';
import { INTERRUPTED } from '../../shared/types';
import { waitsOnAi } from '../../shared/signatory';
import { ProviderError, type CallUsage, type Provider } from '../providers/types';
import type { Store } from '../store';
import { Workspace } from '../workspace';
import { changeApproach } from './approaches';
import { CHECK_TIMES, WaitingOnChecks, type CheckTimes } from './evidence';
import { StaleWork, describeWork, perform, type EngineContext } from './handlers';
import { MAX_RESULT_CHARS, clean } from './records';
import { changePrivilege } from './privileges';
import { addNote, reopenRequest, settleRequest } from './signatory';
import {
  addSpend,
  addSteer,
  addUsage,
  countable,
  assertModelRefs,
  CEO_QUESTION,
  ceoOf,
  digestCycle,
  emptyUsage,
  execById,
  isPlanActive,
  LIVE_CYCLES,
  planById,
  postToBoard,
  sanitiseSettings,
  sessionAllowance,
  syncJudge,
  toClientView,
  StorageError,
  ValidationError,
} from './state';
import { cycleComplete, nextWork, settle, type WorkItem } from './work';

export interface RunnerOptions {
  access?: AccessOptions;
  /** Base delay before a failed call is retried; doubles each attempt. */
  retryDelayMs?: number;
  /** Minimum gap between pushes to subscribers. */
  emitIntervalMs?: number;
  /** How a gate waits on a repository's checks. */
  checkTimes?: Partial<CheckTimes>;
  /** At the slow pace, the pause after one piece of work before the next starts. */
  paceGapMs?: number;
}

const MAX_ATTEMPTS = 3;
/** Long enough to read what a call produced before the next one starts. */
export const SLOW_PACE_GAP_MS = 20_000;
const MAX_ACTIVITY = 300;
const MAX_HISTORY = 60;
/** How much of the business records' edit history stays in live state, and how far past that it may run before the oldest are moved out. */
export const AUDIT_KEPT_LIVE = 100;
export const AUDIT_SPILL_AT = 100;
/** How many of the most recent model calls the whole-life views are given. An organisation can make far more than a page can draw. */
export const MAX_HISTORY_ENTRIES = 20_000;
/** Failures that say something about one task rather than about the provider. */
const TASK_LEVEL_ERRORS = new Set(['refusal', 'truncated', 'too_long', 'invalid_output']);

/** What a piece of work was part of, so the timeline can place it and the calibration can learn from it. */
function placeOf(org: Organisation, item: WorkItem, agent: number | null): Pick<ActivityEntry, 'planId' | 'phaseIndex' | 'taskId' | 'agent' | 'effort'> {
  const planId = 'planId' in item ? item.planId : null;
  const phaseIndex = 'phaseIndex' in item ? item.phaseIndex : null;
  const taskId = item.kind === 'task' ? item.taskId : null;
  const task = taskId && planId !== null && phaseIndex !== null ? planById(org, planId)?.phases[phaseIndex]?.tasks.find((t) => t.id === taskId) : undefined;
  return { planId, phaseIndex, taskId, agent: item.kind === 'task' ? agent : null, effort: task?.effort ?? null };
}

type Listener = (event: { type: 'view'; view: OrgView } | { type: 'activity'; entry: ActivityEntry } | { type: 'closed' }) => void;

/**
 * Runs one organisation. The loop is a reconciler: ask what work is ready,
 * start as much as capacity allows, and ask again whenever something
 * finishes. All state lives in `org`, so a paused or restarted organisation
 * picks up exactly where it stopped.
 */
export class OrgRunner {
  readonly workspace: Workspace;
  readonly access: BusinessAccess;
  readonly activity: ActivityEntry[] = [];
  private readonly inFlight = new Map<string, ActiveWork>();
  private readonly attempts = new Map<string, number>();
  private readonly backoff = new Map<string, NodeJS.Timeout>();
  /** How many tasks each lead's agents have been given, for sharing call slots fairly. */
  private readonly served = new Map<string, number>();
  private readonly listeners = new Set<Listener>();
  /** Hosted sessions being archived right now, so that none is asked twice. */
  private readonly archiving = new Set<string>();
  /** Work done beside the loop (archiving sessions), so that coming to rest can wait for it. */
  private chores: Promise<unknown> = Promise.resolve();
  private abort = new AbortController();
  private halting = false;
  private disposed = false;
  private wakeTimer: NodeJS.Timeout | null = null;
  /** Under the slow pace: wakes the loop when the pause after the last piece of work is over. */
  private paceTimer: NodeJS.Timeout | null = null;
  /** When the last piece of work finished, which the slow pace counts its pause from. */
  private lastFinished = 0;
  /** Under the step pace: how many pieces of work a person has just released. Never banked past one pump. */
  private released = 0;
  private readonly paceGapMs: number;
  private emitTimer: NodeJS.Timeout | null = null;
  private saveTimer: NodeJS.Timeout | null = null;
  private saving: Promise<void> = Promise.resolve();
  private saveError: Error | null = null;
  private auditWarned = false;
  private activityWarned = false;
  private activitySeq = 0;
  private readonly retryDelayMs: number;
  private readonly emitIntervalMs: number;
  private readonly checkTimes: CheckTimes;

  constructor(
    readonly org: Organisation,
    private readonly provider: Provider,
    private readonly store: Store,
    options: RunnerOptions = {},
  ) {
    this.workspace = new Workspace(store.workspaceRoot(org.id));
    this.access = new BusinessAccess(path.join(store.orgDir(org.id), 'access-vault.json'), org.id, () => org.executives.filter(exec => exec.kind === 'lead' || exec.kind === 'ceo').map(exec => exec.id), { ...options.access, allows: (actorId, privilege) => allows(org, actorId, privilege) });
    this.retryDelayMs = options.retryDelayMs ?? 4000;
    this.checkTimes = { ...CHECK_TIMES, ...options.checkTimes };
    this.emitIntervalMs = options.emitIntervalMs ?? 150;
    this.paceGapMs = options.paceGapMs ?? SLOW_PACE_GAP_MS;
  }

  view(): OrgView {
    return {
      org: toClientView(this.org),
      active: [...this.inFlight.values()],
      draining: this.org.status !== 'running' && this.inFlight.size > 0,
      pace: {
        next: this.org.status === 'running' ? this.ordered(this.startable()).slice(0, 3).map((item) => ({ kind: item.kind, execId: item.execId, label: describeWork(this.org, item) })) : [],
        nextAt: this.paceTimer ? new Date(this.lastFinished + this.paceGapMs).toISOString() : null,
      },
    };
  }

  /** The model calls this organisation has made, from its log on disk, for views that span its whole life: the most recent, where there are more than a page can use. */
  history(): Promise<ActivityEntry[]> {
    return this.store.readActivity(this.org.id, MAX_HISTORY_ENTRIES);
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
    const waiting = nextWork(org);
    if (waiting.length && waiting.every((item) => !this.fundable(item))) {
      throw new ValidationError('What is left of the budget is too little for the hosted sessions waiting to carry on. Raise it before starting again.');
    }
    if (this.abort.signal.aborted) this.abort = new AbortController();
    this.halting = false;
    // Sessions that could not be archived when their plans ended (the provider was out of reach, say) are tried again.
    if (org.settings.archiveSessions) this.tidy();
    org.status = 'running';
    if (!org.business.waiting) consumeBusinessWake(org);
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

  /** Under the step pace: start the next piece of work, the one the dashboard shows as next. */
  step(): void {
    const org = this.org;
    if (org.settings.pace !== 'step') throw new ValidationError('Steps are taken one at a time only at the step pace.');
    if (org.status !== 'running') throw new ValidationError('Start the organisation first, then take a step.');
    if (!this.startable().length) {
      throw new ValidationError(this.inFlight.size ? 'Nothing is ready to start yet: the work under way has to finish first.' : 'Nothing is ready to start.');
    }
    this.released = 1;
    try {
      this.pump();
    } finally {
      this.released = 0;
    }
  }

  /** Stop starting new work. Calls already in flight finish and their results are kept. */
  pause(reason: PauseReason = 'user', error: string | null = null): void {
    const org = this.org;
    if (org.status !== 'running') return;
    this.clearWake();
    this.clearPace();
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
    this.org.business.reviewRequested = true;
    this.changed();
    this.pump();
  }

  updateSettings(patch: Partial<OrgSettings>): void {
    const org = this.org;
    const before = org.settings.execution;
    const holder = org.settings.signatory;
    assertModelRefs(patch);
    const next = sanitiseSettings(patch, org.settings);
    // A model that cannot be called would stop the organisation at its next call. Better to say so now.
    for (const [seat, model] of [['executives', next.executiveModel], ['agents', next.workerModel]] as const) {
      const changed = model !== (seat === 'executives' ? org.settings.executiveModel : org.settings.workerModel);
      if (changed && this.provider.knows && !this.provider.knows(model)) {
        throw new ValidationError(`The model chosen for the ${seat}, "${model}", is not one a connected key can call. Add its key under Models and keys, or pick another model.`);
      }
    }
    const oldInterval = org.settings.reviewIntervalMinutes;
    org.settings = next;
    if (next.reviewIntervalMinutes !== 0 && next.reviewIntervalMinutes !== oldInterval) org.business.nextReviewAt = new Date(Date.now() + next.reviewIntervalMinutes * 60_000).toISOString();
    if (next.reviewIntervalMinutes === 0) { org.business.waiting = false; this.clearWake(); }
    if (org.settings.execution !== before) {
      // A plan keeps the way of working it started with. One that has not yet begun follows the new setting.
      for (const plan of org.plans) {
        if (plan.status !== 'executing' || !plan.execution || plan.execution === org.settings.execution) continue;
        if (this.inFlight.has(`execute:${plan.id}`)) continue;
        // A hosted session could not be held to a plan's gates, so a plan that has them stays where they can be checked.
        if (plan.phases.some((p) => p.gate)) continue;
        const begun = plan.execution === 'managed' ? !!plan.managed?.sessionId : plan.phases.some((p) => p.status !== 'pending' || p.tasks.length > 0);
        if (begun) continue;
        plan.execution = org.settings.execution;
        plan.managed = null;
      }
    }
    syncJudge(org);
    if (org.settings.signatory !== holder) {
      // What the person took back from an earlier AI ruling stays with the person, so it is not counted.
      const waiting = org.signatory.requests.filter((r) => waitsOnAi(r, 'ai')).length;
      postToBoard(
        org,
        'signatory',
        'system',
        org.settings.signatory === 'ai' ? 'The signatory is now an AI seat' : 'The signatory is now a person',
        org.settings.signatory === 'ai'
          ? `The shareholders have put an AI in the signatory's seat. It authorises or declines each request; a person still carries out what it authorises.${waiting ? ` ${waiting} request${waiting === 1 ? '' : 's'} already waiting ${waiting === 1 ? 'goes' : 'go'} to it.` : ''}`
          : `The shareholders have put a person in the signatory's seat. Requests wait for that person to carry them out or refuse them.`,
      );
    }
    if (org.settings.archiveSessions) this.tidy();
    this.changed();
    this.pump();
  }

  /**
   * Archive the hosted sessions of plans that are over (reported, cancelled or failed), and of sessions that
   * were lost and replaced. With `all`, every session the organisation has, for when it is being deleted.
   * An archived session stays readable on the provider's side but can no longer be changed; this cannot be
   * undone, so it is only ever done because the shareholders asked: by the setting, or by hand.
   */
  async archiveSessions(scope: { planId?: string; all?: boolean } = {}): Promise<{ archived: number; left: number }> {
    const provider = this.provider;
    let archived = 0;
    let left = 0;
    if (!provider.archiveSession) return { archived, left };
    for (const plan of this.org.plans) {
      const managed = plan.managed;
      if (!managed || (scope.planId && plan.id !== scope.planId)) continue;
      const targets: Array<{ id: string; mark: (at: string) => void }> = [];
      for (const past of managed.past ?? []) if (!past.archivedAt) targets.push({ id: past.sessionId, mark: (at) => (past.archivedAt = at) });
      const over = scope.all || !isPlanActive(plan);
      if (managed.sessionId && !managed.archivedAt && over && !this.inFlight.has(`execute:${plan.id}`)) {
        targets.push({ id: managed.sessionId, mark: (at) => (managed.archivedAt = at) });
      }
      for (const target of targets) {
        if (this.archiving.has(target.id)) continue;
        this.archiving.add(target.id);
        try {
          // A session that is gone needs no archiving; one that is still working is left for another time.
          if ((await provider.archiveSession(target.id)) === 'busy') left += 1;
          else {
            target.mark(new Date().toISOString());
            archived += 1;
            this.changed();
          }
        } catch {
          left += 1;
        } finally {
          this.archiving.delete(target.id);
        }
      }
    }
    return { archived, left };
  }

  /** Archive what can be archived, beside the loop. Failures wait for the next time. */
  private tidy(): void {
    this.chores = this.chores.then(() => this.archiveSessions()).catch(() => {});
  }

  // ---- the signatory's desk ----

  /** The person says a request has been carried out, or refuses it and says why. The organisation is told. */
  settleRequest(requestId: string, result: 'done' | 'rejected', note: string): void {
    settleRequest(this.org, requestId, result, note);
    this.changed();
    this.pump();
  }

  /** Take back what was recorded about a request, so that it is open again. */
  reopenRequest(requestId: string): void {
    reopenRequest(this.org, requestId);
    this.changed();
    this.pump();
  }

  /** Something the person wants the organisation to know that is not an answer to one request. */
  noteFromSignatory(text: string): void {
    addNote(this.org, text);
    this.changed();
  }

  /** A person sets what a role may do. It holds from now on, for work under way as well. */
  async setPrivilege(seatId: unknown, privilege: unknown, allowed: unknown): Promise<void> {
    const { changed, removed } = changePrivilege(this.org, seatId, privilege, allowed);
    // Hosted sessions cannot reach the vault, so a privilege that does not apply there is one that works through it.
    if (removed && !PRIVILEGE_BY_ID[privilege as Privilege].hosted) await this.access.revoke(String(seatId));
    if (changed) this.changed();
  }

  setWorkApproach(seatId: unknown, approachId: unknown, allowed: unknown): void {
    if (changeApproach(this.org, seatId, approachId, allowed)) this.changed();
  }

  setAgentCount(execId: string, count: number): void {
    const exec = execById(this.org, execId);
    if (!exec || exec.kind !== 'lead') throw new ValidationError('Only an executive lead can be allocated agents.');
    if (!Number.isFinite(count)) throw new ValidationError('The number of agents must be a number.');
    exec.agentCount = Math.min(MAX_AGENTS_PER_LEAD, Math.max(1, Math.round(count)));
    this.changed();
    this.pump();
  }

  /**
   * One task in full. An agent in a workflow run is given its work by the run,
   * not by the lead, so neither what it was asked nor what it returned is on
   * the lead's stream: both are read from the agent's own thread, the first
   * time someone asks, and kept.
   */
  async taskDetail(taskId: string): Promise<{ task: Task; planId: string; phase: string } | null> {
    for (const plan of this.org.plans) {
      for (const phase of plan.phases) {
        const task = phase.tasks.find((t) => t.id === taskId);
        if (!task) continue;
        const sessionId = plan.managed?.sessionId;
        if (task.threadId && sessionId && !task.result && this.provider.agentDetail) {
          // A thread that cannot be read (its session was replaced, say) leaves the task as it is.
          const detail = await this.provider.agentDetail(sessionId, task.threadId).catch(() => null);
          if (detail?.brief && task.agent === null) task.brief = clean(detail.brief, 4000);
          if (detail?.report && task.status !== 'running') task.result = detail.report.trim().slice(0, MAX_RESULT_CHARS);
          if (detail?.brief || detail?.report) this.changed();
        }
        return { task, planId: plan.id, phase: phase.name };
      }
    }
    return null;
  }

  /** User/integration mutations are saved before the HTTP response acknowledges them. */
  async businessCommand(command: unknown): Promise<void> {
    applyBusinessCommand(this.org, command, { id: 'person' });
    this.changed();
    await this.flush();
    this.pump();
  }

  reviewNow(): void {
    this.org.business.reviewRequested = true;
    this.changed();
    this.pump();
  }

  private clearPace(): void {
    if (this.paceTimer) clearTimeout(this.paceTimer);
    this.paceTimer = null;
  }

  /**
   * How many more pieces of work the pace lets start now. At the slow pace a timer is set to come back when
   * the pause is over. Hosted sessions run beside the model calls, so only their start is paced.
   */
  private paceAllowance(): number {
    const pace = this.org.settings.pace;
    this.clearPace();
    if (pace === 'free') return Infinity;
    if (pace === 'step') return this.released;
    if (this.callsInFlight() > 0) return 0;
    const wait = pace === 'slow' ? this.lastFinished + this.paceGapMs - Date.now() : 0;
    if (wait <= 0) return 1;
    this.paceTimer = setTimeout(() => { this.paceTimer = null; this.pump(); }, wait);
    this.paceTimer.unref();
    return 0;
  }

  /** Work in the order the loop starts it: hosted sessions, then the leads' own calls, then agents' tasks. */
  private ordered(items: WorkItem[]): WorkItem[] {
    const rank = (item: WorkItem) => (item.kind === 'execute' ? 0 : item.kind === 'task' ? 2 : 1);
    return [...items].sort((a, b) => rank(a) - rank(b));
  }

  private clearWake(): void {
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
  }

  private waitForBusiness(): boolean {
    const org = this.org;
    if (!org.business.waiting || org.settings.reviewIntervalMinutes === 0) return false;
    this.clearWake();
    const due = nextBusinessWake(org);
    if (due <= Date.now()) {
      org.business.waiting = false;
      consumeBusinessWake(org);
      postToBoard(org, 'system', 'system', 'Operating review started', 'A scheduled review, incoming event or commitment is ready for attention.');
      return false;
    }
    // Node timers have a signed 32-bit delay. Long waits are re-armed without model calls.
    this.wakeTimer = setTimeout(() => { this.wakeTimer = null; this.pump(); }, Math.min(due - Date.now(), 2_147_000_000));
    this.wakeTimer.unref();
    this.changed();
    return true;
  }

  /** Write the current state to disk now and wait for it. */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.queueSave();
    await this.saving;
    if (this.saveError) throw new StorageError(`The organisation could not be saved (${this.saveError.message}), so this may not outlast a restart. Restore storage, then try again.`);
  }

  /** Resolves when paused or waiting for a scheduled review, with nothing in flight. */
  async idle(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while ((this.org.status === 'running' && !this.org.business.waiting) || this.inFlight.size > 0) {
      if (Date.now() > deadline) throw new Error('timed out waiting for the organisation to come to rest');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await this.chores;
  }

  // ---- the loop ----

  private pump(): void {
    const org = this.org;
    if (org.status !== 'running') return;
    try {
      syncBusinessJobs(org);
      if (org.settings.maxCycles !== null && org.cycle.number > org.settings.maxCycles) { this.pause('cycle_limit'); return; }
      if (org.usage.costUsd >= org.settings.budgetUsd) {
        postToBoard(org, 'system', 'system', 'Budget reached', `Estimated spend has reached the $${org.settings.budgetUsd.toFixed(2)} budget. The organisation is paused until the shareholders raise it.`);
        this.pause('budget');
        return;
      }
      if (this.waitForBusiness()) return;
      settle(org);
      this.keepToWhatTheProviderCan();
      let items = this.startable();
      // A hosted session needs money set aside for it before it can start or carry on. One that
      // cannot be funded waits for other sessions to finish and release what they did not spend.
      const starved = items.filter((item) => !this.fundable(item));
      if (starved.length) items = items.filter((item) => !starved.includes(item));
      if (!items.length && this.inFlight.size === 0 && this.backoff.size === 0) {
        if (starved.length) {
          const left = Math.max(0, org.settings.budgetUsd - org.usage.costUsd);
          postToBoard(
            org,
            'system',
            'system',
            'Budget reached',
            `What is left of the $${org.settings.budgetUsd.toFixed(2)} budget ($${left.toFixed(2)}) is too little for the hosted session${starved.length === 1 ? '' : 's'} waiting to carry on. The organisation is paused until the shareholders raise it.`,
          );
          this.pause('budget');
          return;
        }
        if (cycleComplete(org)) {
          this.rollover();
          if (org.status !== 'running' || this.waitForBusiness()) return;
          settle(org);
          items = this.startable();
        } else {
          this.pause('error', 'The organisation has unfinished work but nothing it can start. This is a bug in the engine; the state is saved for inspection.');
          return;
        }
      }
      // A hosted session runs on the provider's side for as long as its plan takes. It is not one
      // of this machine's model calls, and holding a call slot for it would stall the board.
      let allowance = this.paceAllowance();
      for (const item of items) {
        if (allowance <= 0) break;
        if (item.kind === 'execute') { this.launch(item, null); allowance--; }
      }
      const room = () => allowance > 0 && this.callsInFlight() < org.settings.maxConcurrentCalls;
      // A lead's own calls are short and unblock everything after them, so they go first.
      for (const item of items) {
        if (!room()) break;
        if (item.kind !== 'task' && item.kind !== 'execute') { this.launch(item, null); allowance--; }
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
        allowance--;
      }
      this.changed();
    } catch (err) {
      this.pause('error', `Engine error: ${(err as Error).message}`);
    }
  }

  private startable(): WorkItem[] {
    return nextWork(this.org).filter((item) => !this.inFlight.has(item.key) && !this.backoff.has(item.key));
  }

  private callsInFlight(): number {
    let n = 0;
    for (const work of this.inFlight.values()) if (work.kind !== 'execute') n += 1;
    return n;
  }

  /** Whether the budget has enough left, after what other sessions were promised, for this work to start. Only hosted sessions need money up front. */
  private fundable(item: WorkItem): boolean {
    if (item.kind !== 'execute') return true;
    const plan = planById(this.org, item.planId);
    return !plan || sessionAllowance(this.org, plan, plan.managed?.spentUsd ?? 0) !== null;
  }

  /**
   * Where hosted sessions cannot be had (the provider has none, or the organisation's models are not ones it
   * can host), plans marked for one are carried out on this machine instead. A plan already in a session
   * stays there: its session was started with models that could be hosted.
   */
  private keepToWhatTheProviderCan(): void {
    const { executiveModel, workerModel } = this.org.settings;
    const can = !!this.provider.executePlan && (this.provider.hosts?.(executiveModel, workerModel) ?? true);
    if (can) return;
    for (const plan of this.org.plans) {
      if (plan.execution !== 'managed' || !isPlanActive(plan)) continue;
      if (this.provider.executePlan && plan.managed?.sessionId) continue;
      this.toLocal(plan);
    }
  }

  private toLocal(plan: Plan): void {
    plan.execution = 'local';
    plan.managed = null;
    for (const phase of plan.phases) {
      for (const task of phase.tasks) {
        if (task.status !== 'running') continue;
        task.status = 'pending';
        task.agent = null;
        task.startedAt = null;
        task.threadId = null;
      }
    }
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
      access: this.access,
      provider: this.provider,
      workspace: this.workspace,
      signal: this.abort.signal,
      halting: () => this.halting,
      overBudget: () => org.usage.costUsd >= org.settings.budgetUsd,
      recordUsage: (execId: string, usage: CallUsage) => {
        if (!countable(usage)) return this.uncounted(usage.model);
        addUsage(org.usage, usage);
        addUsage((org.usageByExec[execId] ??= emptyUsage()), usage);
        spent.model = usage.model;
        spent.inputTokens += usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
        spent.outputTokens += usage.outputTokens;
        spent.costUsd += usage.costUsd;
        this.changed();
      },
      recordSpend: (execId, model, delta) => {
        if (!countable(delta)) return this.uncounted(model);
        addSpend(org.usage, delta);
        addSpend((org.usageByExec[execId] ??= emptyUsage()), delta);
        spent.model = model;
        spent.inputTokens += delta.inputTokens + delta.cacheReadTokens + delta.cacheWriteTokens;
        spent.outputTokens += delta.outputTokens;
        spent.costUsd += delta.costUsd;
        this.changed();
        // A session reports its spend while it runs, so the budget is checked as it does, not only when work finishes.
        if (org.status === 'running' && org.usage.costUsd >= org.settings.budgetUsd) this.pump();
      },
      touch: () => this.changed(),
      stateDir: path.join(this.store.orgDir(org.id), 'managed'),
      checkTimes: this.checkTimes,
    };
    let error: string | null = null;
    let waiting = false;
    try {
      const commit = await perform(item, ctx);
      commit();
      this.attempts.delete(item.key);
    } catch (err) {
      waiting = err instanceof WaitingOnChecks;
      error = this.fail(item, err);
    } finally {
      this.inFlight.delete(item.key);
      this.lastFinished = Date.now();
      // A plan's session is archived once the plan is over, if the shareholders asked for that.
      if (item.kind === 'execute' && org.settings.archiveSessions) this.tidy();
      // A look at the checks costs nothing and says nothing new, however many it takes.
      if (!waiting) this.record({
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
        ...placeOf(org, item, active.agent),
      });
      this.changed();
      this.pump();
    }
  }

  /**
   * A call reported tokens or a cost that is not a number. Added to the totals it would make them not a number
   * either, and such a total compares as less than any budget: the organisation would never pause on spend again.
   * So it is left out, and the organisation stops until a person has put the model's price right.
   */
  private uncounted(model: string): void {
    console.warn(`Organisation ${this.org.id}: a call on ${model || 'an unnamed model'} reported usage that is not a number.`);
    this.pause(
      'error',
      `A call on ${model || 'a model'} reported a cost that is not a number, so what it spent could not be counted and the budget could not be kept. Nothing has been added to the spend for it. Check the price set for this model under Models and keys, or choose another model, before starting again.`,
    );
  }

  /** Decide what a failed call means. Returns the message to log, or null if the failure needs no mention. */
  private fail(item: WorkItem, err: unknown): string | null {
    if (err instanceof StaleWork) return null;
    if (err instanceof WaitingOnChecks) {
      // GitHub answered, so any trouble it had earlier in a long wait is over and should not add up.
      this.attempts.delete(item.key);
      // Held like a retry, so that it takes no slot, a pause drops it, and resuming picks it up.
      if (this.org.status === 'running') {
        const timer = setTimeout(() => {
          this.backoff.delete(item.key);
          this.pump();
        }, this.checkTimes.pollMs);
        timer.unref();
        this.backoff.set(item.key, timer);
      }
      return null;
    }
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
      return INTERRUPTED;
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
    syncBusinessJobs(org);
    org.business.lastDigest = operatingDigest(org);
    postToBoard(org, 'system', 'system', 'Operating digest', org.business.lastDigest);
    const finished = org.cycle.number;
    const endedAt = new Date().toISOString();
    org.history.push(digestCycle(org, endedAt));
    if (org.history.length > MAX_HISTORY) org.history.splice(0, org.history.length - MAX_HISTORY);

    const next = finished + 1;
    const archiveUpTo = next - LIVE_CYCLES;
    const old = (cycle: number) => cycle <= archiveUpTo;
    // A request to the signatory leaves with the cycle it was settled in, and takes everything said about it
    // along, whenever that was said. One that is still open stays, however old: it is still waiting for someone.
    const desk = org.signatory;
    const settledIn = new Map(desk.requests.filter((r) => r.outcome && old(r.outcome.cycle)).map((r) => [r.id, r.outcome!.cycle]));
    const leavesWith = (m: { cycle: number; requestId?: string }): number | null => {
      const request = m.requestId ? desk.requests.find((r) => r.id === m.requestId) : undefined;
      if (request) return settledIn.get(request.id) ?? null;
      return old(m.cycle) ? m.cycle : null;
    };
    const leaving = new Set([...org.plans, ...org.board].filter((x) => old(x.cycle)).map((x) => x.cycle));
    // A cycle leaves live state only once it is in the archive. One that cannot be written there (a full disk, say)
    // stays where it is and is tried again when the next cycle closes: the record is worth more than the room.
    const staying = new Set<number>();
    for (const cycle of leaving) {
      const data = {
        cycle,
        record: org.history.find((c) => c.number === cycle),
        plans: org.plans.filter((p) => p.cycle === cycle),
        decisions: org.decisions.filter((d) => d.cycle === cycle),
        reports: org.reports.filter((r) => r.cycle === cycle),
        reviewRounds: org.reviewRounds.filter((r) => r.cycle === cycle),
        board: org.board.filter((m) => m.cycle === cycle),
        signatory: {
          requests: desk.requests.filter((r) => settledIn.get(r.id) === cycle),
          messages: desk.messages.filter((m) => leavesWith(m) === cycle),
        },
      };
      try {
        this.store.archiveCycleNow(org.id, cycle, data);
      } catch (err) {
        staying.add(cycle);
        console.warn(`Could not archive cycle ${cycle} of ${org.id}: ${(err as Error).message}. It stays in the organisation's state for now.`);
      }
    }
    const goes = (cycle: number | null | undefined) => cycle !== null && cycle !== undefined && old(cycle) && !staying.has(cycle);
    org.plans = org.plans.filter((p) => !goes(p.cycle));
    org.decisions = org.decisions.filter((d) => !goes(d.cycle));
    org.reports = org.reports.filter((r) => !goes(r.cycle));
    org.reviewRounds = org.reviewRounds.filter((r) => !goes(r.cycle));
    org.board = org.board.filter((m) => !goes(m.cycle));
    desk.messages = desk.messages.filter((m) => !goes(leavesWith(m)));
    desk.requests = desk.requests.filter((r) => !goes(settledIn.get(r.id)));
    org.inbox = {};

    org.cycle = { number: next, stage: 'consult', consults: {}, intent: null, priorities: [], startedAt: endedAt };
    if (org.settings.maxCycles !== null && finished >= org.settings.maxCycles) {
      postToBoard(org, 'system', 'system', 'Cycle limit reached', `The organisation has completed ${finished} cycle${finished === 1 ? '' : 's'}, the limit set by the shareholders, and is paused.`);
      this.pause('cycle_limit');
      return;
    }
    if (org.settings.reviewIntervalMinutes > 0) {
      org.business.waiting = true;
      org.business.nextReviewAt = new Date(Date.now() + org.settings.reviewIntervalMinutes * 60_000).toISOString();
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
    this.store.appendActivity(this.org.id, entry).then(
      () => (this.activityWarned = false),
      (err: Error) => {
        // The work itself is safe in the organisation's state; what is lost is its line in the log of calls. Said once, not per call.
        if (!this.activityWarned) console.warn(`Could not write to the activity log of ${this.org.id}: ${err.message}. Calls made until this is put right will be missing from the timeline and the spend history.`);
        this.activityWarned = true;
      },
    );
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
      .then(async () => { await this.spillAudit(); await this.store.save(this.org); this.saveError = null; })
      .catch((err) => {
        this.saveError = err as Error;
        const message = 'Could not save the organisation: ' + this.saveError.message + '. Restore storage before resuming.';
        console.warn(message);
        if (this.org.status === 'running') {
          this.clearWake();
          this.org.status = 'paused';
          this.org.pauseReason = 'error';
          this.org.lastError = message;
          for (const timer of this.backoff.values()) clearTimeout(timer);
          this.backoff.clear();
          for (const listener of this.listeners) listener({ type: 'view', view: this.view() });
        }
      });
  }

  /**
   * Keep the edit history of the business records from growing inside the saved state, which is written out whole
   * on every change. The oldest entries move to a file of their own once there are enough of them. They leave live
   * state only after they have been written there; if the process stops between the two, they are written again
   * next time, so the file can hold an entry twice but never lose one. If the file cannot be written they stay.
   */
  private async spillAudit(): Promise<void> {
    const over = this.org.business.audit.length - (AUDIT_KEPT_LIVE + AUDIT_SPILL_AT);
    if (over < 0) return;
    const leaving = this.org.business.audit.slice(0, over + AUDIT_SPILL_AT);
    try {
      await this.store.appendAudit(this.org.id, leaving);
    } catch (err) {
      if (!this.auditWarned) console.warn(`Could not move older edit history of ${this.org.id} to its own file: ${(err as Error).message}. It stays in the organisation's state.`);
      this.auditWarned = true;
      return;
    }
    this.auditWarned = false;
    // Entries are only ever added at the end, so the ones written are still the first ones, whatever happened meanwhile.
    this.org.business.audit.splice(0, leaving.length);
  }

  /** Cancel timers and let go of subscribers. The state must already be flushed; nothing is written after this. */
  dispose(): void {
    this.disposed = true;
    this.clearWake();
    this.clearPace();
    for (const listener of this.listeners) listener({ type: 'closed' });
    for (const timer of this.backoff.values()) clearTimeout(timer);
    this.backoff.clear();
    if (this.emitTimer) clearTimeout(this.emitTimer);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.emitTimer = this.saveTimer = null;
    this.listeners.clear();
  }
}
