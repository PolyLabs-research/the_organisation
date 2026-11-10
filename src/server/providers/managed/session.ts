import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { PLAN_TOOLS, ProviderError, type BoardReportDraft, type Briefing, type HookReply, type PhaseRecord, type PlanJob, type PlanOutcome, type SessionSpend } from '../types';
import { Uploads, download, listOutputs, type SessionFile } from './files';
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
type EventType = Anthropic.Beta.Sessions.BetaManagedAgentsSessionEventType;
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
  /** First delay before connecting to the stream again; doubles each time nothing new was heard. */
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

/** How often in a row a lead that stops short is set going again before the session is given up. Counted afresh after each phase it records. */
const MAX_NUDGES = 3;
/** How many times in a row following the session may fail, with nothing new heard, before the failure is passed up. */
const MAX_RECONNECTS = 5;
/** Nothing larger than this is brought home from a session. */
const MAX_OUTPUT_BYTES = 25_000_000;
/** At the end of a plan, files up to this size are fetched again even if they look unchanged. */
const REFETCH_BYTES = 2_000_000;
/** History is read from a little before where reading stopped: events are not promised to arrive in the order of their times. */
const OVERLAP_MS = 5000;
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
    operations: Array.isArray(input.operations) ? input.operations.slice(0, 12) : [],
    phase: str(input.phase),
    summary: str(input.summary),
    decisions: decisions
      .filter((d): d is Record<string, unknown> => typeof d === 'object' && d !== null)
      .map((d) => ({ title: str(d.title), decision: str(d.decision), rationale: str(d.rationale) })),
    requests: listOf(input.requests)
      .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null && !Array.isArray(r))
      .map((r) => ({ kind: plain(r.kind), title: plain(r.title), detail: plain(r.detail), amount: plain(r.amount), party: plain(r.party), files: listOf(r.files).map(plain).filter(Boolean) })),
  };
}

/** Text or a number as text. Anything else is no answer, where `str` would make "[object Object]" of it. */
const plain = (value: unknown): string => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '');

/** A list a model was asked for, however it wrote it: as a list, as JSON in a string, or as the one item on its own. */
function listOf(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return [];
    try {
      const parsed: unknown = JSON.parse(text);
      return Array.isArray(parsed) ? parsed : typeof parsed === 'object' && parsed !== null ? [parsed] : [text];
    } catch {
      return [text];
    }
  }
  return typeof value === 'object' && value !== null ? [value] : [];
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

const timeOf = (event: SessionEvent | StreamEvent): string | null => ('processed_at' in event && typeof event.processed_at === 'string' ? event.processed_at : null);

/**
 * A request to create a plan's session, kept on disk from before it goes out until it is known what came of
 * it. A request can get through although its reply never arrives, and the session it made is then working on the
 * plan, under its cap, with nothing here that knows of it.
 */
interface Creating {
  /** The mark put on the request. The session carries it if the request got through. */
  attempt: string;
  /** A little before the request went out: sessions older than this are not the one. */
  since: string;
  leadId: string;
  /** How far the plan's first message brought the lead up to date with the board's instructions. */
  instructions: number;
}

/** Something the session is waiting for this side to answer. */
interface PendingCall {
  id: string;
  kind: 'custom' | 'approval';
  name: string;
  input: Record<string, unknown>;
  /** Set when the call came from one of the lead's agents rather than the lead. */
  threadId: string | null;
  /** When the call was made. Reading of the session's history never moves past a call that is still unanswered. */
  at: string | null;
}

export class PlanSession {
  private readonly client: Anthropic;
  private readonly sessions: Sessions;
  private readonly hooks: PlanJob['hooks'];
  private readonly timings: SessionTimings;

  private sessionId = '';
  private consoleUrl: string | null = null;
  private capUsd = 0;
  private spentUsd = 0;
  /** The session's own copies of the files mounted into it. They are inputs, never work products. */
  private readonly inputs = new Set<string>();

  /** Where the next attachment starts reading, and how far events have been acted on. */
  private cursor: string | null = null;
  private latestAt: string | null = null;
  /** Events before this were acted on by an earlier attachment: the engine has been told about them. */
  private floor: string | null = null;
  /** Counts events not seen before, to tell an attachment that got somewhere from one that did not. */
  private progress = 0;

  private readonly seen = new Set<string>();
  private readonly answered = new Set<string>();
  private readonly pending = new Map<string, PendingCall>();
  private readonly openRuns = new Set<string>();
  private readonly runThreads = new Set<string>();
  private readonly unfetchable = new Set<string>();
  /** Messages sent to the lead, by event id, and the instructions each brings it up to date with once the session takes it up. */
  private readonly awaiting = new Map<string, number>();
  /** Messages the session has been seen to take up. One can be seen on the stream before the request that sent it has returned. */
  private readonly takenUp = new Set<string>();
  /** True once this attachment has given the session room to spend (created it, or raised its cap). */
  private live = false;
  private reported = false;
  private replaying = false;
  /** The lead was interrupted the last time the session was held, so its work waits for a message. */
  private interrupted = false;
  /** The session's status says that it has ended, and its history has still to be read to the end. */
  private over = false;

  /** Why the session is idle, as far as is known; null while it is working. */
  private idle: StopReason | null = null;
  private idleActed = false;
  /** A time at which, if the session has not started again by itself, its lead is set going. */
  private wake: { at: number; why: string } | null = null;
  /** A time at which a session that says it is at its cap, with a cap above its spend, is looked at again. */
  private budgetCheckAt: number | null = null;
  private nudges = 0;
  private lastError: string | null = null;
  private lastEventAt = Date.now();
  private lastPollAt = Date.now();

  private outcome: PlanOutcome | null = null;
  private failure: unknown = null;
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
      let quiet = 0;
      while (!this.outcome) {
        if (this.failure) throw this.failure;
        if (this.leaving === 'pause' || this.leaving === 'cancel') {
          await this.hold();
          this.outcome = { status: this.leaving === 'cancel' ? 'cancelled' : 'paused' };
          break;
        }
        const asked = this.leaving === 'reconnect';
        this.leaving = null;
        const before = this.progress;
        try {
          await this.follow();
        } catch (err) {
          if (this.outcome || this.leaving || this.failure) continue;
          // Only something new from the session counts as having got somewhere. Re-reading what was already read does not.
          if (this.progress !== before) failures = 0;
          failures += 1;
          if (failures >= MAX_RECONNECTS || !retryable(err)) throw err;
          await sleep(this.timings.reconnectMs * 2 ** (failures - 1));
          continue;
        }
        if (this.outcome || this.leaving || this.failure) continue;
        // The stream ended by itself. Connect again, but never in a tight loop.
        quiet = this.progress !== before || asked ? 0 : quiet + 1;
        if (this.progress !== before) failures = 0;
        await sleep(this.timings.reconnectMs * Math.min(30, 2 ** quiet));
      }
      const outcome: PlanOutcome | null = this.outcome;
      if (!outcome) throw new ProviderError('The session was left without knowing how it ended.', 'unavailable', true);
      // What the session spent in the end, as the platform has it now.
      if (outcome.status === 'reported' || outcome.status === 'lost') await this.retrieve().catch(() => {});
      return outcome;
    } catch (err) {
      // Whatever went wrong on this side, the session is still there and can still spend up to its cap.
      // Bring the cap down before letting go of it. It is raised again when the plan is picked up.
      if (this.live && !this.outcome) await this.hold().catch(() => {});
      throw err;
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
      // The plan's session is known, so a request for one that is still on file is not waiting for an answer.
      await this.creating(null);
      this.sessionId = job.session.id;
      this.consoleUrl = this.linkTo(this.sessionId);
      this.cursor = job.session.cursor;
      this.latestAt = job.session.handled ?? job.session.cursor;
      this.floor = this.latestAt;
      this.reported = job.session.reported;
      for (const id of job.session.openRuns) this.openRuns.add(id);
      for (const id of job.session.runThreads) this.runThreads.add(id);
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

    if (await this.takeUp()) return;

    const uploads = new Uploads(this.client, job.stateDir);
    let resources = await this.deps.resources.ensure(team);
    let mounts = await uploads.ensure(job.files, job.signal);
    // Marks the session this attempt creates, so that it can be found again if the reply to the request is lost.
    const attempt = randomUUID();
    const since = new Date(Date.now() - 60_000).toISOString();
    const create = () =>
      this.sessions.create(
        {
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
          metadata: { app: 'the_organisation', plan: job.planId, attempt },
        },
        // Not sent again automatically: a second request could start a second session working on the same plan.
        { maxRetries: 0 },
      );
    const request = async () => {
      // On file before it goes out. If this try ends without learning what came of it, the next one looks first.
      await this.creating({ attempt, since, leadId: resources.lead.id, instructions: job.kickoff.instructions });
      return create();
    };
    let session: Session;
    try {
      session = await request();
    } catch (err) {
      if (err instanceof Anthropic.NotFoundError || (err instanceof Anthropic.BadRequestError && /file/i.test(err.message))) {
        // Ids kept from an earlier run can stop being valid: made with another key, or removed by hand.
        // Make again what the refusal names, once. Any other refusal is passed up as it is.
        if (/file/i.test(err.message)) await uploads.forget();
        else await this.deps.resources.forget();
        resources = await this.deps.resources.ensure(team);
        mounts = await uploads.ensure(job.files, job.signal);
        session = await request();
      } else if (reached(err)) {
        // The request may have got through although no reply came back. If it did, that session is this plan's.
        // If it cannot be found now, the request stays on file and the next try looks again (see `takeUp`).
        const made = await this.find(resources.lead.id, attempt, since).catch(() => null);
        if (!made) throw err;
        session = made;
      } else {
        // Refused, so no session was made and there is nothing to look for.
        await this.creating(null);
        throw err;
      }
    }
    this.sessionId = session.id;
    this.consoleUrl = this.linkTo(session.id);
    this.capped(job.budgetUsd);
    await this.creating(null);
    this.hooks.instructed(job.kickoff.instructions);
    this.read(session);
  }

  /** Keep on disk the request for this plan's session that is about to go out, or with null remove it. */
  private async creating(request: Creating | null): Promise<void> {
    const file = path.join(this.job.stateDir, `creating-${this.job.planId}.json`);
    if (!request) return fs.rm(file, { force: true });
    await fs.mkdir(this.job.stateDir, { recursive: true });
    await fs.writeFile(file, JSON.stringify(request), 'utf8');
  }

  /**
   * Take up the session that an earlier try at starting this plan asked for, if that try ended without learning
   * what came of its request and the request did get through. True if it did: the session is this plan's, and
   * no other is created beside it.
   */
  private async takeUp(): Promise<boolean> {
    let asked: Creating;
    try {
      asked = JSON.parse(await fs.readFile(path.join(this.job.stateDir, `creating-${this.job.planId}.json`), 'utf8')) as Creating;
    } catch (err) {
      // Nothing is on file. (A request cut off while it was being written down never went out.)
      if ((err as NodeJS.ErrnoException).code === 'ENOENT' || err instanceof SyntaxError) return false;
      throw err;
    }
    // If this look fails, so does the try. While it is not known whether a session exists, no second one is made.
    const session = await this.find(asked.leadId, asked.attempt, asked.since);
    if (!session) {
      await this.creating(null);
      return false;
    }
    this.sessionId = session.id;
    this.consoleUrl = this.linkTo(session.id);
    // It still has the cap it was created with. The engine is told of it before anything else can fail.
    this.capped(session.budget ? usd(session.budget.max_list_cost) : this.job.budgetUsd);
    await this.creating(null);
    this.hooks.instructed(asked.instructions);
    this.read(session);
    // One that has ended since is this plan's all the same: what it spent is counted, and it is given up as lost.
    if (session.status === 'terminated') this.outcome = { status: 'lost', reason: 'the session had ended.' };
    // It has been working under its first cap. From here on it has what the plan is allowed now.
    else await this.raise(this.job.budgetUsd);
    return true;
  }

  /** The session an earlier request created, if it did create one. */
  private async find(leadId: string, attempt: string, since: string): Promise<Session | null> {
    let looked = 0;
    // Oldest first: the look can come long after the request, and the lead's later sessions are not the one.
    for await (const session of this.sessions.list({ agent_id: leadId, 'created_at[gte]': since, order: 'asc' }, QUICK)) {
      if (session.metadata?.attempt === attempt) return session;
      if (++looked >= 50) break;
    }
    return null;
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

  /** True, and the plan's session is given up, if the session can no longer be worked with. */
  private gone(session: Session): boolean {
    if (session.archived_at) this.end({ status: 'lost', reason: 'the session was archived.' });
    else if (session.status === 'terminated') this.end({ status: 'lost', reason: this.lastError ?? 'the session ended by itself.' });
    else return false;
    return true;
  }

  /**
   * The same, asked beside the stream. A session that has ended is not given up from here: the stream may not
   * have been read as far as its end, and what the session said last, and why it ended, is in its history.
   * The stream is left, and the history is read to the end in its place (see `follow`).
   */
  private ended(session: Session): boolean {
    if (session.archived_at || session.status !== 'terminated') return this.gone(session);
    this.over = true;
    this.leave('reconnect');
    return true;
  }

  // ---- the spend cap ----

  private capped(dollars: number): void {
    this.capUsd = dollars;
    this.live = true;
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
   * any thread or workflow run, and the work waits until the cap is raised.
   * (An interrupt would stop the lead's turn but not its runs.)
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
    const stopped = await this.send([{ type: 'user.interrupt' }], true, QUICK).then(
      (sent) => sent !== null,
      () => false,
    );
    this.hooks.note(
      stopped
        ? 'This session could not be capped at what it has spent, so its lead was interrupted instead. A workflow run it started may carry on until it ends or the cap is reached.'
        : 'This session could not be reached to hold it. It may carry on by itself until its lead next records a phase, or until its spend cap is reached.',
    );
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

  /** Something went wrong beside the stream that the plan cannot go on past. */
  private fail(err: unknown): void {
    this.failure ??= err;
    this.stream?.abort();
  }

  /** One attachment to the stream: open it, read what was missed, then follow it until the plan ends or the stream does. */
  private async follow(): Promise<void> {
    const controller = new AbortController();
    this.stream = controller;
    try {
      // A session that has ended says nothing more on a stream. Its history is read to the end, and that is all.
      if (this.over) {
        this.over = false;
        return await this.catchUp();
      }
      // Opened before anything else, so that nothing said while the history is read is lost.
      const stream = await this.sessions.events.stream(this.sessionId, {}, { signal: controller.signal });
      await this.catchUp();
      if (this.outcome || this.leaving || this.failure) return;
      for await (const event of stream) {
        // Asked before each event is acted on, not only on the timer: answering the lead lets it go on to the
        // next phase, and a session that is to be held must not be let any further.
        if (this.halted()) return;
        await this.handle(event);
        if (this.outcome || this.leaving || this.failure) return;
      }
    } catch (err) {
      if (this.outcome || this.leaving || this.failure) return; // the stream was closed from this side
      throw err;
    } finally {
      controller.abort();
      if (this.stream === controller) this.stream = null;
    }
  }

  /**
   * Read the session's history from where it was last read, then settle where things stand. The session's
   * status is read after its history, and can show a stop or an end that came in between. The history is then
   * read once more (`again`), so that nothing is acted on ahead of the events that led up to it.
   */
  private async catchUp(again = false): Promise<void> {
    this.replaying = true;
    let briefed = this.cursor !== null;
    try {
      const since = this.cursor ? { 'created_at[gte]': new Date(Date.parse(this.cursor) - OVERLAP_MS).toISOString() } : {};
      for await (const event of this.sessions.events.list(this.sessionId, since)) {
        if (event.type === 'user.message') briefed = true;
        await this.handle(event);
        if (this.outcome) return;
      }
    } finally {
      this.replaying = false;
    }
    this.checkpoint();
    if (this.leaving || this.halted()) return;

    // What is still waiting on this side gets its answer now.
    for (const call of [...this.pending.values()]) await this.answer(call);
    if (this.openRuns.size) await this.refreshRuns();
    const session = await this.retrieve();
    this.lastPollAt = Date.now();
    // It has ended since its history was read: what it said last, and why it ended, is read before it is given up.
    if (!again && session.status === 'terminated' && !session.archived_at) return this.catchUp(true);
    if (this.gone(session)) return;
    if (!briefed) {
      // The session exists but was never given its plan.
      await this.send([message(this.job.kickoff.message)]);
      return;
    }
    if (this.interrupted) {
      // Held by an interrupt, when its cap could not be brought down. Its work, and any run of its, waits for a word.
      this.interrupted = false;
      await this.say(this.job.resume());
      return;
    }
    // The history can end on a stop that the session's status does not show yet, so what the history says is
    // acted on whatever the status reads. A stop from before the history read here is looked up.
    if (!this.idle && session.status === 'idle') {
      const stop = await this.latestIdle();
      // A stop that is not in the history just read came before it, or has come since. One that has come since
      // has the events that led up to it still unread: a call it names would be answered before the work that
      // went before the call had been heard of. The second reading meets it in its turn.
      if (stop && !again && !this.seen.has(stop.id)) return this.catchUp(true);
      this.idle = stop?.stop_reason ?? null;
      this.idleActed = false;
    }
    if (this.idle && !this.idleActed) await this.onIdle(this.idle);
    else if (!this.idle && session.status === 'idle') this.wake = { at: Date.now() + this.timings.graceMs, why: 'the session was idle and did not start again.' };
  }

  /** The session's most recent stop. */
  private async latestIdle(): Promise<Anthropic.Beta.Sessions.BetaManagedAgentsSessionStatusIdleEvent | null> {
    for await (const event of this.sessions.events.list(this.sessionId, { types: ['session.status_idle'], order: 'desc', limit: 1 })) {
      if (event.type === 'session.status_idle') return event;
    }
    return null;
  }

  /** Look up calls the session says it is waiting on that were not seen on the stream. */
  private async findCalls(ids: string[]): Promise<PendingCall[]> {
    const wanted = new Set(ids);
    const found: PendingCall[] = [];
    const types: EventType[] = ['agent.custom_tool_use', 'agent.tool_use', 'agent.mcp_tool_use'];
    for await (const event of this.sessions.events.list(this.sessionId, { types, order: 'desc' })) {
      if (!wanted.has(event.id)) continue;
      const call = callOf(event);
      if (call) found.push(call);
      wanted.delete(event.id);
      if (!wanted.size) break;
    }
    return found;
  }

  /**
   * Which workflow runs are open, read from the session itself. There is no
   * listing of runs, and one missed ending would have the plan wait for a run
   * that is long over.
   */
  private async refreshRuns(): Promise<void> {
    const types: EventType[] = ['workflow_run.created', 'workflow_run.status_ended'];
    const open = new Set<string>();
    for await (const event of this.sessions.events.list(this.sessionId, { types })) {
      if (event.type === 'workflow_run.created') open.add(event.workflow_run_id);
      else if (event.type === 'workflow_run.status_ended') {
        open.delete(event.workflow_run_id);
        if (this.openRuns.has(event.workflow_run_id)) this.runEnded(event);
      }
    }
    this.openRuns.clear();
    for (const id of open) this.openRuns.add(id);
  }

  private runEnded(event: Anthropic.Beta.Sessions.BetaManagedAgentsWorkflowRunStatusEndedEvent): void {
    this.openRuns.delete(event.workflow_run_id);
    const { result } = event;
    this.hooks.run({
      id: event.workflow_run_id,
      event: 'ended',
      // More ways of ending may be added: anything unrecognised is a run that did not complete.
      result: result.type === 'completed' ? 'completed' : result.type === 'stopped' ? 'stopped' : 'failed',
      error: result.type === 'error' ? result.error.message : undefined,
    });
  }

  /**
   * Send events to the session. Returns what the session echoed back, or null
   * if it would not take them (when `tolerate` is set): a session waiting on an
   * answer, or paused at its cap, takes no new messages, and an answer to a
   * call that has since lapsed is refused. Neither is a failure of the plan.
   */
  private async send(events: SendEvent[], tolerate = false, options?: typeof QUICK): Promise<Array<{ id?: string }> | null> {
    try {
      return (await this.sessions.events.send(this.sessionId, { events }, options)).data ?? [];
    } catch (err) {
      if (err instanceof Anthropic.ConflictError) {
        // The session no longer takes events at all: it was archived, or has ended.
        this.end({ status: 'lost', reason: 'the session no longer takes events (it may have been archived).' });
        return null;
      }
      if (tolerate && err instanceof Anthropic.BadRequestError) return null;
      throw err;
    }
  }

  /**
   * Say something to the lead. The instructions a message carries count as
   * delivered when the session takes the message up, not when it is queued: a
   * turn that dies on an error drops what was queued behind it.
   */
  private async say(briefing: Briefing): Promise<boolean> {
    const sent = await this.send([message(briefing.message)], true);
    if (!sent) return false;
    const id = sent[0]?.id;
    if (id && !this.takenUp.has(id)) this.awaiting.set(id, briefing.instructions);
    else this.hooks.instructed(briefing.instructions);
    return true;
  }

  // ---- events ----

  private async handle(event: SessionEvent | StreamEvent): Promise<void> {
    if (event.type === 'event_start' || event.type === 'event_delta') return; // previews of text; the finished event follows
    const at = timeOf(event);
    // A message from this side shows up twice: when it is queued, and again when the session takes it up.
    if (event.type === 'user.message' && at && event.id) {
      this.takenUp.add(event.id);
      const upTo = this.awaiting.get(event.id);
      if (upTo !== undefined) {
        this.awaiting.delete(event.id);
        this.hooks.instructed(upTo);
      }
    }
    if (event.id) {
      if (this.seen.has(event.id)) return;
      this.seen.add(event.id);
    }
    this.progress += 1;
    this.lastEventAt = Date.now();
    const { hooks } = this;
    // Read again from before where an earlier attachment stopped: the engine has been told about this already.
    // Calls, runs and the session's own state are still followed, because those decide what happens next.
    const told = this.replaying && this.floor !== null && at !== null && at < this.floor;

    switch (event.type) {
      // -- the lead --
      case 'agent.message': {
        const text = textOf(event.content);
        if (text && !told) hooks.note(text);
        break;
      }
      case 'agent.custom_tool_use':
      case 'agent.tool_use':
      case 'agent.mcp_tool_use': {
        const call = callOf(event);
        if (!call) {
          // Not waiting on this side. A call the platform refused is worth a line in the record.
          if (!told && event.type !== 'agent.custom_tool_use' && event.evaluated_permission === 'deny') {
            const why = event.evaluation?.type === 'auto' ? 'judged high-risk by the platform' : 'refused by the platform';
            hooks.declined(event.name, `${why}: ${describe(event.input)}`);
          }
          break;
        }
        if (this.answered.has(call.id)) break;
        // Kept until it has been answered, so that an answer that fails to send is tried again.
        this.pending.set(call.id, call);
        if (!this.replaying) await this.answer(call);
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
      case 'user.interrupt':
        if (this.replaying) this.interrupted = true;
        break;

      // -- the lead's agents --
      case 'session.thread_created':
        if (event.workflow_run_id) this.runThreads.add(event.session_thread_id);
        if (!told) hooks.assigned({ threadId: event.session_thread_id, agentName: event.agent_name, brief: null, runId: event.workflow_run_id });
        break;
      case 'agent.thread_message_sent':
        if (!told) hooks.assigned({ threadId: event.to_session_thread_id, agentName: event.to_agent_name ?? this.job.worker.name, brief: textOf(event.content), runId: null });
        break;
      case 'agent.thread_message_received':
        if (!told) hooks.reported(event.from_session_thread_id, textOf(event.content));
        break;
      case 'session.thread_status_idle':
        if (told) break;
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
        if (!told) hooks.agentEnded(event.session_thread_id, 'finished');
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
      case 'workflow_run.status_ended':
        this.runEnded(event);
        break;
      case 'workflow_run.error':
        if (!event.workflow_run_id && !told) hooks.note(`A workflow run could not be started: ${event.error.message}`);
        break;

      // -- the session --
      case 'session.usage':
        this.spent(event.usage);
        break;
      case 'session.error':
        this.lastError = event.error.message;
        if (event.error.retry_status.type !== 'retrying' && !told) hooks.note(`The session met an error: ${event.error.message}`);
        break;
      case 'session.status_running':
        this.idle = null;
        this.idleActed = false;
        this.wake = null;
        this.budgetCheckAt = null;
        this.interrupted = false;
        break;
      case 'session.status_idle':
        this.idle = event.stop_reason;
        this.idleActed = false;
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

    if (at && (!this.latestAt || at > this.latestAt)) this.latestAt = at;
    this.checkpoint();
  }

  /** Tell the engine where reading can start next time: the oldest call still unanswered, or else the latest event acted on. */
  private checkpoint(): void {
    // Not while the history is being read: a call that an earlier attachment read and left unanswered is only
    // known to be unanswered once the reading has come to it again, and the place must not move past it before then.
    if (!this.latestAt || this.replaying) return;
    let from = this.latestAt;
    for (const call of this.pending.values()) if (call.at && call.at < from) from = call.at;
    if (!this.cursor || from > this.cursor) this.cursor = from;
    this.hooks.checkpoint(this.cursor, this.latestAt);
  }

  private async answer(call: PendingCall): Promise<void> {
    if (this.answered.has(call.id)) return;
    const { hooks } = this;
    if (call.kind === 'approval') {
      // The platform could not tell whether the call was safe, and nobody is here to say.
      await this.send([{ type: 'user.tool_confirmation', tool_use_id: call.id, result: 'deny', deny_message: DECLINED }], true);
      hooks.declined(call.name, describe(call.input));
    } else {
      let reply: HookReply;
      if (call.threadId) {
        reply = { ok: false, message: 'Only the lead records phases and reports to the board. Report to your lead instead.' };
      } else if (call.name === PLAN_TOOLS.recordPhase) {
        // The phase's files come home before it is recorded, so the board can read them as soon as it is.
        await this.syncOutputs(false);
        reply = hooks.phase(phaseRecord(call.input));
        // A lead that records a phase is getting somewhere.
        if (reply.ok) this.nudges = 0;
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
    this.checkpoint();
  }

  /** Act on a stop, once. If what it called for could not be done, it has not been acted on. */
  private async onIdle(reason: StopReason): Promise<void> {
    this.idleActed = true;
    try {
      await this.settle(reason);
    } catch (err) {
      // A request failed on the way. While the session still stands at this stop, the stop is still to be acted
      // on: by the next attachment if this one fails with it, or when a session that has gone quiet is looked at.
      // Left marked as acted on, nothing would come back to it, and the plan would wait on it for good.
      if (this.idle === reason) this.idleActed = false;
      throw err;
    }
  }

  /** The session has stopped. Decide what that means: done, waiting on this side, out of money, or stuck. */
  private async settle(reason: StopReason): Promise<void> {
    const soon = Date.now() + this.timings.graceMs;
    switch (reason.type) {
      case 'requires_action': {
        const unknown = reason.event_ids.filter((id) => !this.answered.has(id) && !this.pending.has(id));
        if (unknown.length) for (const call of await this.findCalls(unknown)) this.pending.set(call.id, call);
        for (const call of [...this.pending.values()]) await this.answer(call);
        return;
      }
      case 'budget_reached': {
        // The lead may have finished on the very request that reached the cap. Nothing more is needed of the session then.
        if (this.reported && this.openRuns.size === 0) return this.finish();
        if (this.capUsd - this.spentUsd >= 0.01) {
          // The cap is above what was spent. Most likely this stop is older than the last raise and the work is on
          // its way again; if the session is still stopped in a moment, it is looked at again.
          this.budgetCheckAt = soon;
          return;
        }
        await this.raise(this.hooks.moreBudget(this.spentUsd));
        return;
      }
      case 'end_turn': {
        // Before waiting on a run, make sure it really is still open.
        if (this.openRuns.size) await this.refreshRuns();
        if (this.reported && this.openRuns.size === 0) return this.finish();
        if (this.openRuns.size > 0) {
          // A run that is working keeps the session running, so one that is open now is paused. Give it time to
          // start again by itself (it does when a cap is raised) before asking the lead to see to it.
          this.wake = { at: this.reported ? soon : Date.now() + this.timings.idleNudgeMs, why: 'a workflow run was left open and idle.' };
          return;
        }
        // A lead's turn can end a moment before it is woken by an agent's report. Only one that stays stopped is set going.
        this.wake = { at: soon, why: 'the lead stopped without reporting to the board.' };
        return;
      }
      case 'retries_exhausted':
        // The lead gave up on an error, and whatever was queued behind its turn was dropped with it. It may be
        // about to take a turn on a run that has just ended; if not, it is set going.
        this.awaiting.clear();
        this.wake = { at: soon, why: `the lead gave up after repeated errors${this.lastError ? ` (${this.lastError})` : ''}.` };
        return;
      case 'refusal':
        this.wake = { at: soon, why: "the lead's turn was declined by the model's safeguards." };
        return;
    }
  }

  /** The lead has reported and nothing of its is still running: bring the last files home and call the plan done. */
  private async finish(): Promise<void> {
    await this.syncOutputs(true);
    this.end({ status: 'reported' });
  }

  /** Set a lead that has stopped short going again. After a few times in a row the session is given up. */
  private async nudge(why: string): Promise<void> {
    // Tried again shortly unless it gets done here. A request that fails on the way must not leave the lead
    // stopped with nothing set to wake it.
    const again = (this.wake = { at: Date.now() + this.timings.graceMs, why });
    if (this.nudges >= MAX_NUDGES) {
      // Whatever is left in the session must not be able to spend once nobody is following it.
      await this.hold();
      // A report that is already in stands, even if the lead then left something open.
      if (this.reported) return this.finish();
      return this.end({ status: 'lost', reason: why });
    }
    // It may not take a message just now (it is waiting on an answer, or at its cap). That, too, is tried again.
    if (!(await this.say(this.job.resume()))) return;
    this.nudges += 1;
    // Unless the session has stopped anew while the message was on its way: that stop has its own time to be looked at.
    if (this.wake === again) this.wake = null;
  }

  /** Housekeeping beside the stream: holds, new instructions, spend, and a session that has gone quiet. */
  private async tick(): Promise<void> {
    if (this.ticking || this.outcome || this.failure || this.leaving === 'pause' || this.leaving === 'cancel') return;
    this.ticking = true;
    try {
      if (this.halted() || this.replaying || !this.stream) return;

      // One message at a time: the next goes when the session has taken up the last.
      if (this.awaiting.size === 0) {
        const briefing = this.hooks.instructions();
        if (briefing) await this.say(briefing);
      }

      const now = Date.now();
      if (now - this.lastPollAt >= this.timings.usagePollMs) {
        this.lastPollAt = now;
        const session = await this.retrieve();
        if (this.ended(session)) return;
        if (session.status === 'idle' && now - this.lastEventAt >= this.timings.usagePollMs) {
          // Stopped, but the stream never said so: it has gone quiet. Connect again and read what was missed.
          if (this.idle === null) return this.leave('reconnect');
          // Stopped, and the stop is known but was never acted on.
          if (!this.idleActed) await this.onIdle(this.idle);
        }
      }

      if (this.budgetCheckAt && Date.now() >= this.budgetCheckAt && this.idle?.type === 'budget_reached') {
        const session = await this.retrieve();
        if (this.ended(session)) return;
        // Not stopped as far as its status says: either its work is on its way again (the stream will say so, and
        // that ends this watch) or the status is a moment behind. Look again shortly. The same if the cap has to
        // be raised and the request fails: the watch ends when the raise is done, not before.
        this.budgetCheckAt = Date.now() + this.timings.graceMs;
        if (session.status !== 'idle') return;
        if (this.capUsd - this.spentUsd < 0.01) {
          await this.raise(this.hooks.moreBudget(this.spentUsd));
          this.budgetCheckAt = null;
          return;
        }
        // At its budget with money left under its cap: a higher cap will not help. (A session stops like this
        // when its usage includes a model the platform has no price for.) It needs someone to look.
        return this.fail(
          new ProviderError(
            `The session says it is at its budget, but its cap ($${this.capUsd.toFixed(2)}) is above what it has spent ($${this.spentUsd.toFixed(2)}). Look at it in the Anthropic Console before resuming.`,
            'bad_request',
            false,
          ),
        );
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
    let settled = 0;
    for (let pass = 0; pass < (final ? 6 : 1); pass++) {
      if (pass > 0) await sleep(this.timings.outputSettleMs);
      // If a name appears more than once, the session wrote the file again: the newest is the one that counts.
      const newest = new Map<string, SessionFile>();
      for (const file of await listOutputs(this.client, this.sessionId, this.inputs)) {
        const other = newest.get(file.name);
        if (!other || file.createdAt >= other.createdAt) newest.set(file.name, file);
      }
      let fetched = 0;
      for (const file of newest.values()) {
        if (this.unfetchable.has(file.id)) continue;
        // A file is fetched once at each size. At the end, small files are fetched once more whatever their size says,
        // in case one was rewritten to the same length.
        const again = final && pass === 0 && file.size <= REFETCH_BYTES;
        if (!again && this.hooks.hasOutput({ id: file.id, size: file.size })) continue;
        if (file.size > MAX_OUTPUT_BYTES) {
          this.unfetchable.add(file.id);
          this.hooks.note(`A file the session produced is too large to bring home (${file.name}, ${Math.round(file.size / 1e6)} MB). It is still in the session.`);
          continue;
        }
        let bytes: Uint8Array;
        try {
          bytes = await download(this.client, file.id);
        } catch (err) {
          // One file that cannot be fetched (removed since it was listed, or not offered for download) is left
          // where it is. It must not stop a phase from being recorded.
          if (!(err instanceof Anthropic.APIError) || !err.status || err.status < 400 || err.status >= 500 || err.status === 401 || err.status === 429) throw err;
          this.unfetchable.add(file.id);
          if (err.status !== 404) this.hooks.note(`A file the session produced could not be fetched (${file.name}). It is still in the session.`);
          continue;
        }
        await this.hooks.output({ id: file.id, name: file.name, bytes });
        fetched += 1;
      }
      // Files take a moment to appear in the listing. The plan's files are all home after two looks in a row found nothing new.
      settled = pass > 0 && fetched === 0 ? settled + 1 : 0;
      if (settled >= 2) return;
    }
  }
}

/** A call the session is waiting on this side to answer, or null if the event is not one. */
function callOf(event: SessionEvent | StreamEvent): PendingCall | null {
  if (event.type === 'agent.custom_tool_use') {
    return { id: event.id, kind: 'custom', name: event.name, input: event.input, threadId: event.session_thread_id ?? null, at: timeOf(event) };
  }
  if ((event.type === 'agent.tool_use' || event.type === 'agent.mcp_tool_use') && event.evaluated_permission === 'ask') {
    return { id: event.id, kind: 'approval', name: event.name, input: event.input, threadId: event.session_thread_id ?? null, at: timeOf(event) };
  }
  return null;
}

/** Whether trying again could help. A refusal of the request itself will be refused again. */
function retryable(err: unknown): boolean {
  if (err instanceof ProviderError) return err.retryable;
  if (err instanceof Anthropic.APIConnectionError) return true;
  if (err instanceof Anthropic.APIError) return err.status === undefined || err.status >= 500 || err.status === 408 || err.status === 429;
  return err instanceof Error && err.cause !== undefined && err.cause !== null;
}

/** Whether a failed request may nonetheless have reached the server and been carried out. */
function reached(err: unknown): boolean {
  if (err instanceof Anthropic.APIConnectionError) return true;
  if (err instanceof Anthropic.APIError) return err.status === undefined || err.status >= 500 || err.status === 408;
  return err instanceof Error && err.cause !== undefined && err.cause !== null;
}

/**
 * Archive a session whose plan is over. A session cannot be archived while it is working, and its status can
 * trail a moment behind its last event, so it is given a few seconds to come to rest. One that is still
 * working after that is left alone: archiving it could cut off work in progress.
 */
export async function archiveSession(client: Anthropic, sessionId: string, waitMs = 300): Promise<'archived' | 'busy' | 'gone'> {
  const { sessions } = client.beta;
  try {
    for (let look = 0; ; look++) {
      const session = await sessions.retrieve(sessionId);
      if (session.archived_at) return 'archived';
      if (session.status !== 'running' && session.status !== 'rescheduling') break;
      if (look >= 10) return 'busy';
      await sleep(waitMs);
    }
    await sessions.archive(sessionId);
    return 'archived';
  } catch (err) {
    if (err instanceof Anthropic.NotFoundError) return 'gone';
    // Refused: the session started working again, or a workflow run in it is still open.
    if (err instanceof Anthropic.BadRequestError || err instanceof Anthropic.ConflictError) return 'busy';
    throw err;
  }
}

/** What one agent in a session was asked and what it returned, read from its own thread. */
export async function threadDetail(client: Anthropic, sessionId: string, threadId: string): Promise<{ brief: string | null; report: string | null }> {
  let brief: string | null = null;
  let said: string | null = null;
  let reported: string | null = null;
  let read = 0;
  for await (const event of client.beta.sessions.threads.events.list(threadId, { session_id: sessionId })) {
    // On an agent's own thread, what it was asked arrives as a message to it.
    if (!brief && (event.type === 'agent.thread_message_received' || event.type === 'user.message')) brief = textOf(event.content) || null;
    // What it reports to its lead is a message it sends. An agent in a workflow run sends none: its last words are its result.
    if (event.type === 'agent.thread_message_sent') reported = textOf(event.content) || reported;
    if (event.type === 'agent.message') said = textOf(event.content) || said;
    if (++read >= 2000) break;
  }
  return { brief, report: reported ?? said };
}
