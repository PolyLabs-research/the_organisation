import Anthropic from '@anthropic-ai/sdk';
import { PLAN_TOOLS, ProviderError, type BoardReportDraft, type HookReply, type PhaseRecord, type PlanJob, type PlanOutcome, type SessionSpend } from '../types';
import { Uploads, download, listOutputs } from './files';
import type { ManagedResources } from './resources';

// One plan, carried out in one Claude Managed Agents session. The lead is the
// session's agent; its team are session threads; a workflow run is background
// work the lead starts to put many agents on one phase. This file follows the
// session's event stream and tells the engine what happens through the job's
// hooks. It answers the two things the lead asks of the organisation (record a
// phase, report to the board), declines tool calls nobody is there to approve,
// keeps the session inside its spend cap, and brings its files home.

type Sessions = Anthropic.Beta.Sessions;
type Session = Anthropic.Beta.Sessions.BetaManagedAgentsSession;
type SessionEvent = Anthropic.Beta.Sessions.BetaManagedAgentsSessionEvent;
type StreamEvent = Anthropic.Beta.Sessions.BetaManagedAgentsStreamSessionEvents;
type SendEvent = Anthropic.Beta.Sessions.BetaManagedAgentsEventParams;
type StopReason = Anthropic.Beta.Sessions.BetaManagedAgentsSessionStatusIdleEvent['stop_reason'];
type BudgetLimit = Anthropic.Beta.Sessions.BetaManagedAgentsBudgetLimit;
type Usage = Anthropic.Beta.Sessions.BetaManagedAgentsSessionUsage | Anthropic.Beta.Sessions.BetaManagedAgentsSessionUsageSnapshot;
type ContentBlock = { type: string; text?: string };

export interface SessionTimings {
  /** How often the organisation is asked whether the session should be held, and new instructions are passed on. */
  tickMs: number;
  /** How often the session's spend is read when the stream has not said. */
  usagePollMs: number;
  /** How long a session may sit idle with a workflow run open before its lead is asked to carry on. */
  idleNudgeMs: number;
  /** How long to wait for a session to start again by itself before setting it going. */
  graceMs: number;
  /** How long files take to appear in the listing after the session writes them. */
  outputSettleMs: number;
  /** First delay before reconnecting a dropped stream; doubles each time. */
  reconnectMs: number;
}

export const DEFAULT_TIMINGS: SessionTimings = {
  tickMs: 2000,
  usagePollMs: 20_000,
  idleNudgeMs: 5 * 60_000,
  graceMs: 15_000,
  outputSettleMs: 2000,
  reconnectMs: 1000,
};

export interface SessionDeps {
  client: Anthropic;
  resources: ManagedResources;
  /** The workspace's name in Console links. */
  workspace: string;
  timings: SessionTimings;
}

/** How often a lead that stops without reporting is set going again before the session is given up as lost. */
const MAX_NUDGES = 3;
/** How many times in a row the stream may fail to connect before the failure is passed up. */
const MAX_RECONNECTS = 5;
/** Nothing larger than this is brought home from a session. */
const MAX_OUTPUT_BYTES = 25_000_000;
/** At the end of a plan, files up to this size are fetched again even if they look unchanged. */
const REFETCH_BYTES = 2_000_000;
/** Requests made while holding a session must not hang: the organisation is waiting to come to rest. */
const QUICK = { timeout: 20_000, maxRetries: 2 };

const DECLINED =
  'Nobody is watching this session to approve the call, so it was declined. Do the work another way, or leave this part out and say so in your report.';

const usd = (amount?: { amount: string } | null): number => (amount ? Number(amount.amount) / 100 : 0);
const round2 = (n: number): number => Math.round(n * 100) / 100;
const limit = (dollars: number): BudgetLimit => ({ type: 'limit', max_list_cost: { amount: String(Math.max(1, Math.round(dollars * 100))), currency: 'USD' } });
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const message = (text: string): SendEvent => ({ type: 'user.message', content: [{ type: 'text', text }] });

function textOf(content: ContentBlock[] | undefined): string {
  return (content ?? [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function spendOf(usage: Usage): SessionSpend {
  const cache = usage.cache_creation;
  return {
    costUsd: usd(usage.list_cost),
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: (cache?.ephemeral_1h_input_tokens ?? 0) + (cache?.ephemeral_5m_input_tokens ?? 0),
    webSearches: usage.server_tool_use?.web_search_requests ?? 0,
  };
}

const str = (value: unknown): string => (typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value));
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.map(str).filter(Boolean) : typeof value === 'string' && value.trim() ? [value] : []);

function phaseRecord(input: Record<string, unknown>): PhaseRecord {
  const decisions = Array.isArray(input.decisions) ? input.decisions : [];
  return {
    phase: str(input.phase),
    summary: str(input.summary),
    decisions: decisions
      .filter((d): d is Record<string, unknown> => typeof d === 'object' && d !== null)
      .map((d) => ({ title: str(d.title), decision: str(d.decision), rationale: str(d.rationale) })),
  };
}

function reportDraft(input: Record<string, unknown>): BoardReportDraft {
  return { headline: str(input.headline), summary: str(input.summary), outcomes: strings(input.outcomes), asks: strings(input.asks) };
}

/** What a tool call was for, in a line, for the record of declined calls. */
function describe(input: Record<string, unknown>): string {
  const command = input.command ?? input.url ?? input.query ?? input.file_path ?? input.path;
  const text = typeof command === 'string' ? command : JSON.stringify(input);
  return text.length > 160 ? `${text.slice(0, 159)}…` : text;
}

/** Something the session is waiting for this side to answer. */
interface PendingCall {
  id: string;
  kind: 'custom' | 'approval';
  name: string;
  input: Record<string, unknown>;
  /** Set when the call came from one of the lead's agents rather than the lead. */
  threadId: string | null;
}

export class PlanSession {
  private readonly client: Anthropic;
  private readonly sessions: Sessions;
  private readonly hooks: PlanJob['hooks'];
  private readonly timings: SessionTimings;

  private sessionId = '';
  private consoleUrl: string | null = null;
  private cursor: string | null = null;
  private capUsd = 0;
  private spentUsd = 0;
  /** The session's own copies of the files mounted into it. They are inputs, never work products. */
  private readonly inputs = new Set<string>();

  private readonly seen = new Set<string>();
  private readonly answered = new Set<string>();
  private readonly pending = new Map<string, PendingCall>();
  private readonly openRuns = new Set<string>();
  private readonly runThreads = new Set<string>();
  private readonly tooLarge = new Set<string>();
  private reported = false;
  private replaying = false;

  /** Why the session is idle, as far as is known; null while it is working. */
  private idle: StopReason | null = null;
  /** A time at which, if the session has not started again by itself, its lead is set going. */
  private wake: { at: number; why: string } | null = null;
  private nudges = 0;
  private lastError: string | null = null;
  private lastEventAt = Date.now();
  private lastPollAt = Date.now();

  private outcome: PlanOutcome | null = null;
  /** Why the stream is being left: to hold the session, or only to connect again. */
  private leaving: 'pause' | 'cancel' | 'reconnect' | null = null;
  private stream: AbortController | null = null;
  private ticking = false;

  constructor(
    private readonly deps: SessionDeps,
    private readonly job: PlanJob,
  ) {
    this.client = deps.client;
    this.sessions = deps.client.beta.sessions;
    this.hooks = job.hooks;
    this.timings = deps.timings;
  }

  async run(): Promise<PlanOutcome> {
    const onAbort = () => this.leave('pause');
    this.job.signal?.addEventListener('abort', onAbort, { once: true });
    let timer: NodeJS.Timeout | null = null;
    try {
      await this.open();
      if (this.job.signal?.aborted) this.leave('pause');
      timer = setInterval(() => void this.tick(), this.timings.tickMs);
      let failures = 0;
      while (!this.outcome) {
        if (this.leaving === 'pause' || this.leaving === 'cancel') {
          await this.hold();
          this.outcome = { status: this.leaving === 'cancel' ? 'cancelled' : 'paused' };
          break;
        }
        this.leaving = null;
        const before = this.lastEventAt;
        try {
          await this.follow();
          failures = 0;
        } catch (err) {
          if (this.outcome || this.leaving) continue;
          if (this.lastEventAt !== before) failures = 0;
          failures += 1;
          if (failures >= MAX_RECONNECTS || !retryable(err)) throw err;
          await sleep(this.timings.reconnectMs * 2 ** (failures - 1));
        }
      }
      const outcome: PlanOutcome | null = this.outcome;
      if (!outcome) throw new ProviderError('The session was left without knowing how it ended.', 'unavailable', true);
      return outcome;
    } finally {
      if (timer) clearInterval(timer);
      this.job.signal?.removeEventListener('abort', onAbort);
      this.stream?.abort();
    }
  }

  // ---- starting, or picking up, the session ----

  private async open(): Promise<void> {
    const { job } = this;
    const team = {
      workerModel: job.workerModel,
      workerEffort: job.workerEffort,
      workerName: job.worker.name,
      workerSystem: job.worker.system,
      web: job.web,
      workflows: job.workflows,
    };

    if (job.session) {
      this.sessionId = job.session.id;
      this.consoleUrl = this.linkTo(this.sessionId);
      this.cursor = job.session.cursor;
      this.reported = job.session.reported;
      for (const id of job.session.openRuns) this.openRuns.add(id);
      let session: Session;
      try {
        session = await this.sessions.retrieve(this.sessionId);
      } catch (err) {
        if (!(err instanceof Anthropic.NotFoundError)) throw err;
        this.outcome = { status: 'lost', reason: 'the session no longer exists.' };
        return;
      }
      if (session.status === 'terminated' || session.archived_at) {
        this.outcome = { status: 'lost', reason: session.archived_at ? 'the session was archived.' : 'the session had ended.' };
        return;
      }
      this.read(session);
      // The cap was brought down to what the session had spent when it was held. Raising it sets its work going again.
      await this.raise(job.budgetUsd);
      return;
    }

    const uploads = new Uploads(this.client, job.stateDir);
    let resources = await this.deps.resources.ensure(team);
    let mounts = await uploads.ensure(job.files, job.signal);
    const create = () =>
      this.sessions.create({
        // The lead agent is shared by every organisation. Each session gives it the model and the instructions of the seat it is for.
        agent: {
          type: 'agent_with_overrides',
          id: resources.lead.id,
          version: resources.lead.version,
          model: { id: job.executiveModel, effort: job.executiveEffort },
          system: job.system,
        },
        environment_id: resources.environmentId,
        // Every agent the lead starts, and every agent in a workflow run, spends from this one cap.
        budget: limit(job.budgetUsd),
        // The plan goes in with the session, so there is never a session that exists but was not told what to do.
        initial_events: [{ type: 'user.message', content: [{ type: 'text', text: job.kickoff.message }] }],
        resources: mounts.map((m) => ({ type: 'file' as const, file_id: m.fileId, mount_path: `/workspace/${m.path}` })),
        title: job.title,
        metadata: { app: 'the_organisation', plan: job.planId },
      });
    let session: Session;
    try {
      session = await create();
    } catch (err) {
      // Ids kept from an earlier run can stop being valid: made with another key, or removed by hand.
      // Make them again, once. Any other refusal is passed up as it is.
      if (err instanceof Anthropic.NotFoundError) {
        await this.deps.resources.forget();
        await uploads.forget();
      } else if (err instanceof Anthropic.BadRequestError && /file/i.test(err.message)) {
        await uploads.forget();
      } else {
        throw err;
      }
      resources = await this.deps.resources.ensure(team);
      mounts = await uploads.ensure(job.files, job.signal);
      session = await create();
    }
    this.sessionId = session.id;
    this.consoleUrl = this.linkTo(session.id);
    this.capUsd = job.budgetUsd;
    this.hooks.session({ id: session.id, consoleUrl: this.consoleUrl, budgetUsd: job.budgetUsd });
    this.hooks.instructed(job.kickoff.instructions);
    this.read(session);
  }

  private linkTo(sessionId: string): string {
    return `https://platform.claude.com/workspaces/${this.deps.workspace}/sessions/${sessionId}`;
  }

  /** Take what a session object says about spend and mounted files. */
  private read(session: Session): void {
    for (const resource of session.resources) if (resource.type === 'file') this.inputs.add(resource.file_id);
    this.spent(session.usage);
  }

  private spent(usage: Usage): void {
    const spend = spendOf(usage);
    this.spentUsd = Math.max(this.spentUsd, spend.costUsd);
    this.hooks.spend(spend);
  }

  private async retrieve(): Promise<Session> {
    const session = await this.sessions.retrieve(this.sessionId);
    this.spent(session.usage);
    return session;
  }

  // ---- the spend cap ----

  private capped(dollars: number): void {
    this.capUsd = dollars;
    this.hooks.session({ id: this.sessionId, consoleUrl: this.consoleUrl, budgetUsd: dollars });
  }

  /** Set the cap. False if the session has already spent as much: the platform only accepts a cap above what was consumed. */
  private async setCap(dollars: number, options?: typeof QUICK): Promise<boolean> {
    try {
      await this.sessions.update(this.sessionId, { budget: limit(dollars) }, options);
    } catch (err) {
      if (err instanceof Anthropic.BadRequestError) return false;
      throw err;
    }
    this.capped(dollars);
    return true;
  }

  /** Give the session more to spend. Work paused at the old cap starts again by itself. Ends the run if the organisation has no more to give. */
  private async raise(dollars: number | null): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (dollars === null) {
        this.outcome = { status: 'at_budget' };
        return;
      }
      if (await this.setCap(dollars)) return;
      // It has spent more than was known here. Ask again with the true figure.
      await this.retrieve();
      dollars = this.hooks.moreBudget(this.spentUsd);
    }
    throw new ProviderError("The session's spend cap could not be raised: it keeps spending past the new cap.", 'unavailable', true);
  }

  /**
   * Hold the session where it is: bring its cap down to what it has spent.
   * From then on the platform starts no new model request in the session, in
   * any thread or workflow run, and the work waits, intact, until the cap is
   * raised. (An interrupt would stop the lead's turn but not its runs.)
   */
  private async hold(): Promise<void> {
    try {
      for (const margin of [0.01, 0.05, 0.25]) {
        const session = await this.sessions.retrieve(this.sessionId, {}, QUICK);
        this.spent(session.usage);
        if (session.status === 'terminated') return;
        const consumed = usd(session.usage.list_cost);
        const cap = round2(consumed + margin);
        const current = session.budget ? usd(session.budget.max_list_cost) : Infinity;
        if (cap >= current) {
          this.capped(current);
          return;
        }
        if (await this.setCap(cap, QUICK)) return;
      }
    } catch {
      // Fall through: the cap is where it was.
    }
    // The cap could not be brought down. Stop the lead instead, and say that the session can still spend.
    await this.send([{ type: 'user.interrupt' }], true, QUICK).catch(() => false);
    this.hooks.note('This session could not be capped at what it has spent, so its lead was interrupted instead. A workflow run it started may carry on until it ends or the cap is reached.');
  }

  // ---- following the session ----

  /** Whether the organisation wants the session held. If so, the stream is left so that it can be. */
  private halted(): boolean {
    if (this.leaving === 'pause' || this.leaving === 'cancel') return true;
    const halt = this.hooks.halt();
    if (halt) this.leave(halt);
    return halt !== null;
  }

  private leave(why: 'pause' | 'cancel' | 'reconnect'): void {
    if (why !== 'reconnect' || !this.leaving) this.leaving = why;
    this.stream?.abort();
  }

  private end(outcome: PlanOutcome): void {
    this.outcome ??= outcome;
    this.stream?.abort();
  }

  /** One attachment to the stream: open it, read what was missed, then follow it until the plan ends or the stream does. */
  private async follow(): Promise<void> {
    const controller = new AbortController();
    this.stream = controller;
    try {
      // Opened before anything else, so that nothing said while the history is read is lost.
      const stream = await this.sessions.events.stream(this.sessionId, {}, { signal: controller.signal });
      await this.catchUp();
      if (this.outcome || this.leaving) return;
      for await (const event of stream) {
        this.lastEventAt = Date.now();
        // Asked before each event is acted on, not only on the timer: answering the lead lets it go on to the
        // next phase, and a session that is to be held must not be let any further.
        if (this.halted()) return;
        await this.handle(event);
        if (this.outcome || this.leaving) return;
      }
    } catch (err) {
      if (this.outcome || this.leaving) return; // the stream was closed from this side
      throw err;
    } finally {
      controller.abort();
      if (this.stream === controller) this.stream = null;
    }
  }

  /** Read the session's history from where it was last read, then settle where things stand. */
  private async catchUp(): Promise<void> {
    this.replaying = true;
    let briefed = this.cursor !== null;
    try {
      const since = this.cursor ? { 'created_at[gte]': this.cursor } : {};
      for await (const event of this.sessions.events.list(this.sessionId, since)) {
        if (event.type === 'user.message') briefed = true;
        this.lastEventAt = Date.now();
        await this.handle(event);
        if (this.outcome) return;
      }
    } finally {
      this.replaying = false;
    }
    if (this.leaving || this.halted()) return;

    for (const call of [...this.pending.values()]) await this.answer(call);
    const session = await this.retrieve();
    this.lastPollAt = Date.now();
    if (session.status === 'terminated') return this.end({ status: 'lost', reason: this.lastError ?? 'the session ended by itself.' });
    if (!briefed) {
      // The session exists but was never given its plan.
      await this.send([message(this.job.kickoff.message)]);
      return;
    }
    if (session.status !== 'idle') return;
    // Idle: find out why, if the history just read did not say, and act on it.
    this.idle ??= await this.latestIdle();
    if (this.idle) await this.onIdle(this.idle);
    else this.wake = { at: Date.now() + this.timings.graceMs, why: 'the session was idle and did not start again.' };
  }

  private async latestIdle(): Promise<StopReason | null> {
    for await (const event of this.sessions.events.list(this.sessionId, { types: ['session.status_idle'], order: 'desc', limit: 1 })) {
      if (event.type === 'session.status_idle') return event.stop_reason;
    }
    return null;
  }

  /** Look up calls the session says it is waiting on that were not seen on the stream. */
  private async findCalls(ids: string[]): Promise<PendingCall[]> {
    const wanted = new Set(ids);
    const found: PendingCall[] = [];
    const types: Anthropic.Beta.Sessions.BetaManagedAgentsSessionEventType[] = ['agent.custom_tool_use', 'agent.tool_use', 'agent.mcp_tool_use'];
    for await (const event of this.sessions.events.list(this.sessionId, { types, order: 'desc' })) {
      if (!wanted.has(event.id)) continue;
      const call = callOf(event);
      if (call) found.push(call);
      wanted.delete(event.id);
      if (!wanted.size) break;
    }
    return found;
  }

  private async send(events: SendEvent[], tolerate = false, options?: typeof QUICK): Promise<boolean> {
    try {
      await this.sessions.events.send(this.sessionId, { events }, options);
      return true;
    } catch (err) {
      // A session waiting on an answer, or paused at its cap, takes no new messages; an answer to a call
      // that has since lapsed is refused. Neither is a failure of the plan.
      if (tolerate && err instanceof Anthropic.BadRequestError) return false;
      throw err;
    }
  }

  // ---- events ----

  private async handle(event: SessionEvent | StreamEvent): Promise<void> {
    if (event.type === 'event_start' || event.type === 'event_delta') return; // previews of text; the finished event follows
    if (event.id) {
      if (this.seen.has(event.id)) return;
      this.seen.add(event.id);
    }
    const { hooks } = this;

    switch (event.type) {
      // -- the lead --
      case 'agent.message': {
        const text = textOf(event.content);
        if (text) hooks.note(text);
        break;
      }
      case 'agent.custom_tool_use':
      case 'agent.tool_use':
      case 'agent.mcp_tool_use': {
        const call = callOf(event);
        if (!call) {
          // Not waiting on this side. A call the platform refused as high-risk is worth a line in the record.
          if (event.type !== 'agent.custom_tool_use' && event.evaluated_permission === 'deny') {
            hooks.declined(event.name, `judged high-risk by the platform: ${describe(event.input)}`);
          }
          break;
        }
        if (this.answered.has(call.id)) break;
        if (this.replaying) this.pending.set(call.id, call);
        else await this.answer(call);
        break;
      }
      case 'user.custom_tool_result':
        this.answered.add(event.custom_tool_use_id);
        this.pending.delete(event.custom_tool_use_id);
        break;
      case 'user.tool_confirmation':
        this.answered.add(event.tool_use_id);
        this.pending.delete(event.tool_use_id);
        break;

      // -- the lead's agents --
      case 'session.thread_created':
        if (event.workflow_run_id) this.runThreads.add(event.session_thread_id);
        hooks.assigned({ threadId: event.session_thread_id, agentName: event.agent_name, brief: null, runId: event.workflow_run_id });
        break;
      case 'agent.thread_message_sent':
        hooks.assigned({ threadId: event.to_session_thread_id, agentName: event.to_agent_name ?? this.job.worker.name, brief: textOf(event.content), runId: null });
        break;
      case 'agent.thread_message_received':
        hooks.reported(event.from_session_thread_id, textOf(event.content));
        break;
      case 'session.thread_status_idle':
        if (event.stop_reason.type === 'retries_exhausted') {
          hooks.agentEnded(event.session_thread_id, 'failed', 'The agent gave up after repeated errors.');
        } else if (event.stop_reason.type === 'refusal') {
          hooks.agentEnded(event.session_thread_id, 'failed', `The agent's turn was declined${event.stop_details?.explanation ? `: ${event.stop_details.explanation}` : '.'}`);
        } else if (event.stop_reason.type === 'end_turn' && !this.runThreads.has(event.session_thread_id)) {
          // One of the lead's own agents has finished its turn. (A run's agent can go idle and carry on; its end is the thread's.)
          hooks.agentEnded(event.session_thread_id, 'finished');
        }
        break;
      case 'session.thread_status_terminated':
        hooks.agentEnded(event.session_thread_id, 'finished');
        break;

      // -- workflow runs --
      case 'workflow_run.created':
        this.openRuns.add(event.workflow_run_id);
        hooks.run({
          id: event.workflow_run_id,
          event: 'created',
          name: event.name,
          description: event.description,
          steps: event.phases.map((phase) => ({ id: phase.id, name: phase.name })),
        });
        break;
      case 'workflow_run.status_running':
        hooks.run({ id: event.workflow_run_id, event: 'running' });
        break;
      case 'workflow_run.status_idle':
        hooks.run({ id: event.workflow_run_id, event: 'paused' });
        break;
      case 'workflow_run.phase_started':
        hooks.run({ id: event.workflow_run_id, event: 'step_started', stepId: event.workflow_run_phase_id });
        break;
      case 'workflow_run.phase_ended':
        hooks.run({ id: event.workflow_run_id, event: 'step_ended', stepId: event.workflow_run_phase_id });
        break;
      case 'workflow_run.status_ended': {
        this.openRuns.delete(event.workflow_run_id);
        const { result } = event;
        hooks.run({
          id: event.workflow_run_id,
          event: 'ended',
          // More ways of ending may be added: anything unrecognised is a run that did not complete.
          result: result.type === 'completed' ? 'completed' : result.type === 'stopped' ? 'stopped' : 'failed',
          error: result.type === 'error' ? result.error.message : undefined,
        });
        break;
      }
      case 'workflow_run.error':
        if (!event.workflow_run_id) hooks.note(`A workflow run could not be started: ${event.error.message}`);
        break;

      // -- the session --
      case 'session.usage':
        this.spent(event.usage);
        break;
      case 'session.error':
        this.lastError = event.error.message;
        if (event.error.retry_status.type !== 'retrying') hooks.note(`The session met an error: ${event.error.message}`);
        break;
      case 'session.status_running':
        this.idle = null;
        this.wake = null;
        break;
      case 'session.status_idle':
        this.idle = event.stop_reason;
        // While the history is read, only where the session ended up matters; that is acted on afterwards.
        if (!this.replaying) await this.onIdle(event.stop_reason);
        break;
      case 'session.status_terminated':
        this.end({ status: 'lost', reason: this.lastError ?? 'the session ended by itself.' });
        break;
      case 'session.deleted':
        this.end({ status: 'lost', reason: 'the session was deleted.' });
        break;
      default:
        break;
    }

    if ('processed_at' in event && typeof event.processed_at === 'string' && (!this.cursor || event.processed_at > this.cursor)) {
      this.cursor = event.processed_at;
      hooks.checkpoint(event.processed_at);
    }
  }

  private async answer(call: PendingCall): Promise<void> {
    if (this.answered.has(call.id)) return;
    const { hooks } = this;
    if (call.kind === 'approval') {
      // The platform could not tell whether the call was safe, and nobody is here to say.
      hooks.declined(call.name, describe(call.input));
      await this.send([{ type: 'user.tool_confirmation', tool_use_id: call.id, result: 'deny', deny_message: DECLINED }], true);
    } else {
      let reply: HookReply;
      if (call.threadId) {
        reply = { ok: false, message: 'Only the lead records phases and reports to the board. Report to your lead instead.' };
      } else if (call.name === PLAN_TOOLS.recordPhase) {
        // The phase's files come home before it is recorded, so the board can read them as soon as it is.
        await this.syncOutputs(false);
        reply = hooks.phase(phaseRecord(call.input));
      } else if (call.name === PLAN_TOOLS.reportToBoard) {
        reply = hooks.report(reportDraft(call.input));
        if (reply.ok) this.reported = true;
      } else {
        reply = { ok: false, message: `There is no tool named ${call.name}.` };
      }
      await this.send([{ type: 'user.custom_tool_result', custom_tool_use_id: call.id, content: [{ type: 'text', text: reply.message }], is_error: !reply.ok }], true);
    }
    this.answered.add(call.id);
    this.pending.delete(call.id);
  }

  /** The session has stopped. Decide what that means: done, waiting on this side, out of money, or stuck. */
  private async onIdle(reason: StopReason): Promise<void> {
    switch (reason.type) {
      case 'requires_action': {
        const unknown = reason.event_ids.filter((id) => !this.answered.has(id) && !this.pending.has(id));
        if (unknown.length) for (const call of await this.findCalls(unknown)) this.pending.set(call.id, call);
        for (const call of [...this.pending.values()]) await this.answer(call);
        return;
      }
      case 'budget_reached': {
        // If the cap is already above what was spent, this stop is older than the last raise and the work is on its way again.
        if (this.capUsd - this.spentUsd >= 0.01) return;
        await this.raise(this.hooks.moreBudget(this.spentUsd));
        return;
      }
      case 'end_turn': {
        if (this.reported && this.openRuns.size === 0) {
          await this.syncOutputs(true);
          return this.end({ status: 'reported' });
        }
        if (this.openRuns.size > 0) {
          // A run that is working keeps the session running, so one that is open now is paused. Give it time to
          // start again by itself (it does when a cap is raised) before asking the lead to see to it.
          this.wake = { at: Date.now() + (this.reported ? this.timings.graceMs : this.timings.idleNudgeMs), why: 'a workflow run was left open and idle.' };
          return;
        }
        return this.nudge('the lead stopped without reporting to the board.');
      }
      case 'retries_exhausted':
        // The lead gave up on an error. It may be about to take a turn on a run that has just ended; if not, set it going.
        this.wake = { at: Date.now() + this.timings.graceMs, why: `the lead gave up after repeated errors${this.lastError ? ` (${this.lastError})` : ''}.` };
        return;
      case 'refusal':
        return this.nudge("the lead's turn was declined by the model's safeguards.");
    }
  }

  /** Set a lead that has stopped short going again. After a few times the session is given up as lost. */
  private async nudge(why: string): Promise<void> {
    this.wake = null;
    if (this.nudges >= MAX_NUDGES) return this.end({ status: 'lost', reason: why });
    const briefing = this.job.resume();
    if (await this.send([message(briefing.message)], true)) {
      this.nudges += 1;
      this.hooks.instructed(briefing.instructions);
    } else {
      // It would not take a message just now (it is waiting on an answer, or at its cap). Try again shortly.
      this.wake = { at: Date.now() + this.timings.graceMs, why };
    }
  }

  /** Housekeeping beside the stream: holds, new instructions, spend, and a session that has gone quiet. */
  private async tick(): Promise<void> {
    if (this.ticking || this.outcome || this.leaving === 'pause' || this.leaving === 'cancel') return;
    this.ticking = true;
    try {
      if (this.halted() || this.replaying || !this.stream) return;

      const briefing = this.hooks.instructions();
      if (briefing && (await this.send([message(briefing.message)], true))) this.hooks.instructed(briefing.instructions);

      const now = Date.now();
      if (now - this.lastPollAt >= this.timings.usagePollMs) {
        this.lastPollAt = now;
        const session = await this.retrieve();
        if (session.status === 'terminated') return this.end({ status: 'lost', reason: this.lastError ?? 'the session ended by itself.' });
        // Stopped, but the stream never said so: it has gone quiet. Connect again and read what was missed.
        if (session.status === 'idle' && this.idle === null && now - this.lastEventAt >= this.timings.usagePollMs) return this.leave('reconnect');
      }
      if (this.wake && Date.now() >= this.wake.at && this.idle?.type !== 'requires_action') await this.nudge(this.wake.why);
    } catch {
      // Housekeeping that fails is tried again on the next tick; the stream is what decides the plan's fate.
    } finally {
      this.ticking = false;
    }
  }

  // ---- files ----

  /** Bring home what the session has written to its output folder. At the end of the plan, look again until nothing new appears. */
  private async syncOutputs(final: boolean): Promise<void> {
    let previous = -1;
    for (let pass = 0; pass < (final ? 3 : 1); pass++) {
      if (pass > 0) await sleep(this.timings.outputSettleMs);
      const files = await listOutputs(this.client, this.sessionId, this.inputs);
      for (const file of files) {
        if (this.tooLarge.has(file.id)) continue;
        // A file is fetched once at each size. At the end, small files are fetched once more whatever their size says,
        // in case one was rewritten to the same length.
        const again = final && pass === 0 && file.size <= REFETCH_BYTES;
        if (!again && this.hooks.hasOutput({ id: file.id, size: file.size })) continue;
        if (file.size > MAX_OUTPUT_BYTES) {
          this.tooLarge.add(file.id);
          this.hooks.note(`A file the session produced is too large to bring home (${file.name}, ${Math.round(file.size / 1e6)} MB). It is still in the session.`);
          continue;
        }
        let bytes: Uint8Array;
        try {
          bytes = await download(this.client, file.id);
        } catch (err) {
          if (err instanceof Anthropic.NotFoundError) continue; // removed since it was listed
          throw err;
        }
        await this.hooks.output({ id: file.id, name: file.name, bytes });
      }
      if (final && files.length === previous) return;
      previous = files.length;
    }
  }
}

/** A call the session is waiting on this side to answer, or null if the event is not one. */
function callOf(event: SessionEvent | StreamEvent): PendingCall | null {
  if (event.type === 'agent.custom_tool_use') {
    return { id: event.id, kind: 'custom', name: event.name, input: event.input, threadId: event.session_thread_id ?? null };
  }
  if ((event.type === 'agent.tool_use' || event.type === 'agent.mcp_tool_use') && event.evaluated_permission === 'ask') {
    return { id: event.id, kind: 'approval', name: event.name, input: event.input, threadId: event.session_thread_id ?? null };
  }
  return null;
}

/** Whether connecting again could help. A refusal of the request itself will be refused again. */
function retryable(err: unknown): boolean {
  if (err instanceof ProviderError) return err.retryable;
  if (err instanceof Anthropic.APIConnectionError) return true;
  if (err instanceof Anthropic.APIError) return err.status === undefined || err.status >= 500 || err.status === 408 || err.status === 409 || err.status === 429;
  return err instanceof Error && err.cause !== undefined && err.cause !== null;
}

/** What one agent in a session was asked and what it returned, read from its own thread. */
export async function threadDetail(client: Anthropic, sessionId: string, threadId: string): Promise<{ brief: string | null; report: string | null }> {
  let brief: string | null = null;
  let report: string | null = null;
  let read = 0;
  for await (const event of client.beta.sessions.threads.events.list(threadId, { session_id: sessionId })) {
    // On an agent's own thread, what it was asked arrives as a message to it; what it says last is its report.
    if (!brief && (event.type === 'agent.thread_message_received' || event.type === 'user.message')) brief = textOf(event.content) || null;
    if (event.type === 'agent.message') report = textOf(event.content) || report;
    if (++read >= 2000) break;
  }
  return { brief, report };
}
