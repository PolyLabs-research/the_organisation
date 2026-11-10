import { emptyBusiness } from '../../shared/business';
import { STANDARD_APPROACH } from '../../shared/approaches';
import { PROFILE_BY_ID, MAX_LEADS, executiveFromDraft } from '../../shared/profiles';
import { MAX_LADDER, MAX_RUNG_LEVEL } from '../../shared/routing';
import { describeRequest, isOpen, waitingOnPerson } from '../../shared/signatory';
import type {
  BoardMessage,
  BoardMessageType,
  CreateOrgRequest,
  CycleRecord,
  Executive,
  LadderRung,
  Organisation,
  OrgSettings,
  Pace,
  OrgSummary,
  Plan,
  PlanPhase,
  SignatoryRequest,
  UsageTotals,
} from '../../shared/types';
import { DEFAULT_MODEL } from '../providers/pricing';
import type { CallUsage } from '../providers/types';

export const DEFAULT_SETTINGS: OrgSettings = {
  reviewIntervalMinutes: 0,
  resumeOnRestart: false,
  arbiter: 'ceo',
  budgetUsd: 5,
  maxCycles: null,
  maxFollowUpDepth: 1,
  maxTasksPerPhase: 4,
  webResearch: false,
  executiveModel: DEFAULT_MODEL,
  workerModel: DEFAULT_MODEL,
  executiveEffort: 'medium',
  workerEffort: 'medium',
  maxConcurrentCalls: 4,
  pace: 'free',
  execution: 'local',
  workflowRuns: true,
  archiveSessions: false,
  signatory: 'human',
  workerLadder: [],
  workerLadderLearns: true,
};

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const PACES: Pace[] = ['step', 'slow', 'steady', 'free'];
/**
 * What a model reference may look like: "claude-opus-5-5", "openai:gpt-5", "openrouter:deepseek/deepseek-chat:free",
 * or whatever a server of the user's own calls its models, spaces and brackets included. Anything a listing can
 * hold is allowed, so that a model that is offered can always be kept; only control characters are not.
 */
const MODEL_REF = /^[^\s\p{Cc}][^\p{Cc}]{0,199}$/u;

export function isModelRef(value: unknown): value is string {
  return typeof value === 'string' && MODEL_REF.test(value);
}

/**
 * Refuse a settings change that names a model in a form no model could have. Left to the tidying below, such a
 * name would quietly become the model the organisation already had, and the change would seem to have been made.
 */
export function assertModelRefs(patch: Partial<OrgSettings> | undefined): void {
  for (const [seat, value] of [['executives', patch?.executiveModel], ['agents', patch?.workerModel]] as const) {
    if (value !== undefined && !isModelRef(value)) throw new ValidationError(`The model named for the ${seat} is not a model’s name.`);
  }
  if (patch?.workerLadder === undefined) return;
  if (!Array.isArray(patch.workerLadder)) throw new ValidationError('The cheaper models for the agents’ lighter tasks must be a list.');
  for (const rung of patch.workerLadder as unknown[]) {
    const { model, upTo } = (rung ?? {}) as Partial<LadderRung>;
    if (!isModelRef(model)) throw new ValidationError('A model named for the agents’ lighter tasks is not a model’s name.');
    if (typeof upTo !== 'number' || !Number.isInteger(upTo) || upTo < 1 || upTo > MAX_RUNG_LEVEL) {
      throw new ValidationError(`Say which tasks ${model} takes: those rated up to a level from 1 to ${MAX_RUNG_LEVEL}.`);
    }
  }
}

/**
 * A ladder as it is kept: at most three rungs, each a different model from the others and from the agents' own,
 * and each reaching higher than the one below it. What does not fit is left out or moved up, so that the
 * levels always read lightest first.
 */
function tidyLadder(value: unknown, top: string): LadderRung[] {
  const out: LadderRung[] = [];
  for (const item of Array.isArray(value) ? (value as unknown[]) : []) {
    const { model, upTo } = (item ?? {}) as Partial<LadderRung>;
    if (!isModelRef(model) || model === top || out.some((rung) => rung.model === model)) continue;
    const least = (out.at(-1)?.upTo ?? 0) + 1;
    if (out.length >= MAX_LADDER || least > MAX_RUNG_LEVEL) break;
    out.push({ model, upTo: Math.round(clamp(upTo, least, MAX_RUNG_LEVEL, least)) });
  }
  return out;
}

/** A ceiling on the follow-up plans one lead may start in a cycle, whatever the reports say. */
export const MAX_FOLLOW_UPS_PER_LEAD = 2;

/** How many cycles of plans, decisions and reports stay in live state; older ones are archived to disk. */
export const LIVE_CYCLES = 3;
/** A backstop only: the board is trimmed by archiving whole cycles, so nothing is dropped unarchived in normal running. */
const MAX_BOARD_MESSAGES = 3000;

export class ValidationError extends Error {}

/** The organisation's state could not be written to disk. What was asked for was done, but may not outlast a restart. */
export class StorageError extends Error {}

/**
 * The version of the saved format this program writes. A new field that has a sensible default needs only its
 * line in `normaliseLoaded`. Raise this when a change needs more than that, and make the step there depend on
 * the version the file was saved with. A file saved by a later version is not loaded, and so never written over.
 */
export const SCHEMA_VERSION = 1;

/** A saved organisation that cannot be loaded. The message says why, for the person who has to put it right. */
export class UnreadableOrganisation extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isList = (value: unknown): value is unknown[] => Array.isArray(value);

/**
 * Check that what was read from disk has the bones of an organisation, before anything leans on them. This is
 * not a full description of the format: it is what the loader, the scheduler and the dashboard would otherwise
 * fall over on. Throws UnreadableOrganisation saying what is wrong.
 */
export function assertLoadable(raw: unknown): asserts raw is Organisation {
  if (!isRecord(raw)) throw new UnreadableOrganisation('its saved state is not an organisation.');
  const version = raw.schemaVersion ?? 0;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) throw new UnreadableOrganisation('its saved state has no readable format version.');
  if (version > SCHEMA_VERSION) {
    throw new UnreadableOrganisation(`it was saved by a later version of this program (format ${version}; this version reads up to format ${SCHEMA_VERSION}). Update the program. The file has been left as it is.`);
  }
  const wrong: string[] = [];
  if (typeof raw.id !== 'string' || !raw.id) wrong.push('no id');
  if (typeof raw.name !== 'string') wrong.push('no name');
  if (!isRecord(raw.settings)) wrong.push('no settings');
  if (!isList(raw.executives) || !raw.executives.every((seat) => isRecord(seat) && typeof seat.id === 'string' && typeof seat.kind === 'string' && isList(seat.phases))) wrong.push('no readable list of seats');
  else if (!raw.executives.some((seat) => isRecord(seat) && seat.kind === 'ceo')) wrong.push('no chief executive among its seats');
  if (!isRecord(raw.cycle) || !Number.isInteger(raw.cycle.number) || !['consult', 'direct', 'work'].includes(raw.cycle.stage as string) || !isRecord(raw.cycle.consults)) wrong.push('no readable cycle');
  const phasesOk = (phases: unknown) => isList(phases) && phases.every((phase) => isRecord(phase) && typeof phase.status === 'string' && isList(phase.tasks) && phase.tasks.every(isRecord));
  if (!isList(raw.plans) || !raw.plans.every((plan) => isRecord(plan) && typeof plan.id === 'string' && typeof plan.ownerId === 'string' && typeof plan.status === 'string' && phasesOk(plan.phases))) wrong.push('no readable list of plans');
  for (const key of ['reviewRounds', 'decisions', 'reports', 'board', 'steers', 'history']) {
    const value = raw[key];
    if (value !== undefined && !(isList(value) && value.every(isRecord))) wrong.push(`${key} is not a list of records`);
  }
  for (const key of ['inbox', 'usageByExec', 'privileges', 'workApproaches', 'business', 'signatory', 'usage']) {
    if (raw[key] !== undefined && !isRecord(raw[key])) wrong.push(`${key} is not a record`);
  }
  if (wrong.length) throw new UnreadableOrganisation(`its saved state is damaged: ${wrong.join('; ')}.`);
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, n));
}

/** Merge a partial settings patch over `base`, keeping every field inside its allowed range. */
export function sanitiseSettings(patch: Partial<OrgSettings> | undefined, base: OrgSettings = DEFAULT_SETTINGS): OrgSettings {
  const p = patch ?? {};
  // A model is named by the connection it is reached through and the provider's own id for it. Whether it can
  // be called is for the provider to say, when the organisation is established and whenever it is called.
  const model = (value: unknown, fallback: string) => (isModelRef(value) ? value : fallback);
  const effort = (value: unknown, fallback: OrgSettings['executiveEffort']) =>
    EFFORTS.includes(value as (typeof EFFORTS)[number]) ? (value as OrgSettings['executiveEffort']) : fallback;
  return {
    reviewIntervalMinutes: Math.round(clamp(p.reviewIntervalMinutes, 0, 43_200, base.reviewIntervalMinutes)),
    resumeOnRestart: typeof p.resumeOnRestart === 'boolean' ? p.resumeOnRestart : base.resumeOnRestart,
    arbiter: p.arbiter === 'judge' || p.arbiter === 'ceo' ? p.arbiter : base.arbiter,
    budgetUsd: Math.round(clamp(p.budgetUsd, 0.1, 10_000, base.budgetUsd) * 100) / 100,
    maxCycles: p.maxCycles === null ? null : p.maxCycles === undefined ? base.maxCycles : Math.round(clamp(p.maxCycles, 1, 100_000, 1)),
    maxFollowUpDepth: Math.round(clamp(p.maxFollowUpDepth, 0, 3, base.maxFollowUpDepth)),
    maxTasksPerPhase: Math.round(clamp(p.maxTasksPerPhase, 1, 12, base.maxTasksPerPhase)),
    webResearch: typeof p.webResearch === 'boolean' ? p.webResearch : base.webResearch,
    executiveModel: model(p.executiveModel, base.executiveModel),
    workerModel: model(p.workerModel, base.workerModel),
    executiveEffort: effort(p.executiveEffort, base.executiveEffort),
    workerEffort: effort(p.workerEffort, base.workerEffort),
    maxConcurrentCalls: Math.round(clamp(p.maxConcurrentCalls, 1, 16, base.maxConcurrentCalls)),
    pace: PACES.includes(p.pace as Pace) ? (p.pace as Pace) : base.pace,
    execution: p.execution === 'managed' || p.execution === 'local' ? p.execution : base.execution,
    workflowRuns: typeof p.workflowRuns === 'boolean' ? p.workflowRuns : base.workflowRuns,
    archiveSessions: typeof p.archiveSessions === 'boolean' ? p.archiveSessions : base.archiveSessions,
    signatory: p.signatory === 'ai' || p.signatory === 'human' ? p.signatory : base.signatory,
    // Tidied against the agents' model as it will be: a rung that names that model is no rung.
    workerLadder: tidyLadder(p.workerLadder !== undefined ? p.workerLadder : base.workerLadder, model(p.workerModel, base.workerModel)),
    workerLadderLearns: typeof p.workerLadderLearns === 'boolean' ? p.workerLadderLearns : (base.workerLadderLearns ?? true),
  };
}

export function emptyUsage(): UsageTotals {
  return { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, webSearches: 0, costUsd: 0 };
}

const COUNTED = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'webSearches', 'costUsd'] as const;

/** Whether what a call reported can be added to the totals: every count and the cost a real number. */
export function countable(usage: Omit<CallUsage, 'model'>): boolean {
  return COUNTED.every((key) => typeof usage[key] === 'number' && Number.isFinite(usage[key]));
}

export function addUsage(total: UsageTotals, call: CallUsage): void {
  if (!call.adjustment) total.calls += 1;
  total.inputTokens += call.inputTokens;
  total.outputTokens += call.outputTokens;
  total.cacheReadTokens += call.cacheReadTokens;
  total.cacheWriteTokens += call.cacheWriteTokens;
  total.webSearches += call.webSearches;
  total.costUsd += call.costUsd;
}

/** Add to the totals what a hosted session spent since it was last heard from. Its model requests are not counted singly. */
export function addSpend(total: UsageTotals, delta: Omit<CallUsage, 'model'>): void {
  total.inputTokens += delta.inputTokens;
  total.outputTokens += delta.outputTokens;
  total.cacheReadTokens += delta.cacheReadTokens;
  total.cacheWriteTokens += delta.cacheWriteTokens;
  total.webSearches += delta.webSearches;
  total.costUsd += delta.costUsd;
}

/** The smallest spend cap worth starting or topping up a hosted session with. */
export const MIN_SESSION_ALLOWANCE_USD = 0.25;

/**
 * How high a hosted session's spend cap may be set, in dollars, or null if the
 * organisation's budget has too little left for it. The money not yet spent,
 * and not already promised to other sessions, is shared equally between this
 * plan and the other plans that will want a session. Every session is capped
 * by the platform and the caps never add up to more than the budget, so what
 * the organisation can overspend through its sessions is bounded: the request
 * in flight in each thread when a cap is reached still completes.
 */
export function sessionAllowance(org: Organisation, plan: Plan, spentUsd: number): number | null {
  const others = org.plans.filter((p) => p.id !== plan.id && isPlanActive(p));
  const live = (p: Plan) => p.managed?.state === 'starting' || p.managed?.state === 'running';
  // A session that is not being followed can still hold a cap above what it has spent, and could spend up to it.
  const promised = others.reduce((sum, p) => sum + (p.managed ? Math.max(0, p.managed.budgetUsd - p.managed.spentUsd) : 0), 0);
  const waiting = others.filter((p) => (p.execution ?? org.settings.execution) === 'managed' && !live(p)).length;
  const share = (org.settings.budgetUsd - org.usage.costUsd - promised) / (waiting + 1);
  if (share < MIN_SESSION_ALLOWANCE_USD) return null;
  return Math.round((spentUsd + share) * 100) / 100;
}

/** A short id unique within the organisation, e.g. "p12". Short ids keep model prompts and outputs readable. */
export function nextId(org: Organisation, prefix: string): string {
  org.seq += 1;
  return `${prefix}${org.seq}`;
}

export function slugify(text: string, fallback = 'item'): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return slug || fallback;
}

export function ceoOf(org: Organisation): Executive {
  const ceo = org.executives.find((e) => e.kind === 'ceo');
  if (!ceo) throw new Error(`organisation ${org.id} has no CEO`);
  return ceo;
}

/** The seat that signs off contested decisions: the judge if the organisation uses one, otherwise the CEO. */
export function arbiterOf(org: Organisation): Executive {
  if (org.settings.arbiter === 'judge') {
    const judge = org.executives.find((e) => e.kind === 'judge');
    if (judge) return judge;
  }
  return ceoOf(org);
}

export function leadsOf(org: Organisation): Executive[] {
  return org.executives.filter((e) => e.kind === 'lead');
}

export function execById(org: Organisation, id: string): Executive | undefined {
  return org.executives.find((e) => e.id === id);
}

export function planById(org: Organisation, id: string): Plan | undefined {
  return org.plans.find((p) => p.id === id);
}

/** The directory in the shared workspace where a seat's team keeps its files. */
export function teamDir(exec: Executive): string {
  return slugify(exec.function, exec.id);
}

/** How many more follow-up plans a lead may start in the current cycle. */
export function followUpsLeft(org: Organisation, leadId: string): number {
  const started = org.plans.filter((p) => p.ownerId === leadId && p.cycle === org.cycle.number && p.origin.type === 'follow_up').length;
  return Math.max(0, MAX_FOLLOW_UPS_PER_LEAD - started);
}

export function isPlanActive(plan: Plan): boolean {
  return plan.status !== 'done' && plan.status !== 'cancelled' && plan.status !== 'failed';
}

export function currentPhase(plan: Plan): { phase: PlanPhase; index: number } | null {
  const index = plan.phases.findIndex((p) => p.status !== 'done');
  const phase = plan.phases[index];
  return phase ? { phase, index } : null;
}

export function postToBoard(
  org: Organisation,
  type: BoardMessageType,
  fromId: string,
  title: string,
  body: string,
  refs: Pick<BoardMessage, 'planId' | 'decisionId' | 'reportId' | 'requestId'> = {},
): BoardMessage {
  const message: BoardMessage = {
    id: nextId(org, 'm'),
    at: new Date().toISOString(),
    cycle: org.cycle.number,
    type,
    fromId,
    title,
    body,
    ...refs,
  };
  org.board.push(message);
  if (org.board.length > MAX_BOARD_MESSAGES) org.board.splice(0, org.board.length - MAX_BOARD_MESSAGES);
  return message;
}

export const CEO_QUESTION = 'What would the shareholders want now?';

/** Build a new organisation from a founder's request. Throws ValidationError when the request cannot make one. */
export function createOrganisation(req: CreateOrgRequest, id: string): Organisation {
  const name = (req.name ?? '').trim().slice(0, 80);
  const idea = (req.idea ?? '').trim().slice(0, 6000);
  if (!name) throw new ValidationError('The organisation needs a name.');
  if (!idea) throw new ValidationError('Describe the idea the organisation exists to pursue.');
  const settings = sanitiseSettings(req.settings);

  // "person" is how the human is told apart from every seat, in grants and in what only a person may confirm.
  const used = new Set<string>(['person', 'system']);
  const seatId = (short: string) => {
    const base = slugify(short, 'lead');
    let candidate = base;
    for (let n = 2; used.has(candidate); n++) candidate = `${base}-${n}`;
    used.add(candidate);
    return candidate;
  };

  const executives: Executive[] = [executiveFromDraft({ profileId: 'ceo' }, seatId('ceo'))!];
  for (const draft of req.executives ?? []) {
    const profile = PROFILE_BY_ID[draft.profileId];
    if (profile && profile.kind !== 'lead') continue; // the CEO and the judge are seated by the organisation, not the founder
    const short = draft.short ?? profile?.short ?? draft.title ?? 'lead';
    const exec = executiveFromDraft(draft, seatId(short));
    if (exec) executives.push(exec);
  }
  const leadCount = executives.filter((e) => e.kind === 'lead').length;
  if (leadCount === 0) throw new ValidationError('Seat at least one executive lead besides the CEO.');
  if (leadCount > MAX_LEADS) throw new ValidationError(`An executive team can seat at most ${MAX_LEADS} leads.`);
  if (settings.arbiter === 'judge') executives.push(executiveFromDraft({ profileId: 'judge' }, seatId('judge'))!);
  // Someone has to be able to sign and pay. The seat is always there; who holds it is a setting.
  executives.push(executiveFromDraft({ profileId: 'signatory' }, seatId('signatory'))!);

  const now = new Date().toISOString();
  const org: Organisation = {
    schemaVersion: SCHEMA_VERSION,
    business: emptyBusiness(),
    id,
    seq: 0,
    name,
    idea,
    mission: (req.mission ?? '').trim().slice(0, 600) || idea.slice(0, 600),
    createdAt: now,
    updatedAt: now,
    settings,
    executives,
    status: 'idle',
    pauseReason: null,
    lastError: null,
    cycle: { number: 1, stage: 'consult', consults: {}, intent: null, priorities: [], startedAt: now },
    history: [],
    plans: [],
    reviewRounds: [],
    decisions: [],
    reports: [],
    inbox: {},
    board: [],
    steers: [],
    signatory: { requests: [], messages: [] },
    privileges: {},
    workApproaches: {},
    usage: emptyUsage(),
    usageByExec: {},
  };
  syncRouting(org);
  postToBoard(
    org,
    'system',
    'system',
    'Organisation established',
    `${name} is established with ${leadCount} executive lead${leadCount === 1 ? '' : 's'} under the CEO. Decisions that leads cannot settle between them are signed off by the ${settings.arbiter === 'judge' ? 'independent judge' : 'CEO'}. Anything that has to be paid for or signed goes to the Authorised Signatory, a seat held by ${settings.signatory === 'ai' ? 'an AI, with a person carrying out what it authorises' : 'a person'}.`,
  );
  const steer = (req.steer ?? '').trim();
  if (steer) addSteer(org, steer);
  return org;
}

export function addSteer(org: Organisation, text: string): void {
  const steer = {
    id: nextId(org, 's'),
    at: new Date().toISOString(),
    text: text.trim().slice(0, 4000),
    status: 'new' as const,
    response: null,
    acknowledgedAt: null,
  };
  org.steers.push(steer);
  postToBoard(org, 'steer', 'shareholders', 'Shareholder steer', steer.text);
}

/**
 * Bring what the organisation has learned about its ladder of agent models into line with its settings. The
 * ladder starts where the settings put it. A change to the ladder itself (a model, a level, or whether it follows
 * results) starts it afresh: what was learned was about another ladder.
 */
export function syncRouting(org: Organisation): void {
  const set = org.settings.workerLadder;
  if (!set.length || !org.settings.workerLadderLearns) {
    org.routing = null;
    return;
  }
  const same = (a: LadderRung[], b: LadderRung[]) => a.length === b.length && a.every((rung, i) => rung.model === b[i]!.model && rung.upTo === b[i]!.upTo);
  if (org.routing && Array.isArray(org.routing.from) && Array.isArray(org.routing.rungs) && same(org.routing.from, set)) return;
  org.routing = { from: set.map((rung) => ({ ...rung })), rungs: set.map((rung) => ({ model: rung.model, upTo: rung.upTo, ceiling: null, recent: [] })) };
}

/** Seat or unseat the judge so the roster matches the arbiter setting. */
export function syncJudge(org: Organisation): void {
  const hasJudge = org.executives.some((e) => e.kind === 'judge');
  if (org.settings.arbiter === 'judge' && !hasJudge) {
    // Beside the board, ahead of the signatory, where a judge seated at the start would be.
    const at = org.executives.findIndex((e) => e.kind === 'signatory');
    // A seat is found by its id, and a lead the founders called "Judge" already answers to this one.
    let id = 'judge';
    for (let n = 2; org.executives.some((e) => e.id === id); n++) id = `judge-${n}`;
    org.executives.splice(at < 0 ? org.executives.length : at, 0, executiveFromDraft({ profileId: 'judge' }, id)!);
  } else if (org.settings.arbiter === 'ceo' && hasJudge) {
    org.executives = org.executives.filter((e) => e.kind !== 'judge');
  }
}

/** Seat the signatory in an organisation that was established before there was one. */
export function syncSignatory(org: Organisation): void {
  org.signatory ??= { requests: [], messages: [] };
  org.signatory.requests ??= [];
  org.signatory.messages ??= [];
  if (org.executives.some((e) => e.kind === 'signatory')) return;
  let id = 'signatory';
  for (let n = 2; org.executives.some((e) => e.id === id); n++) id = `signatory-${n}`;
  org.executives.push(executiveFromDraft({ profileId: 'signatory' }, id)!);
}

/** Text written by a model, made safe to sit in a record that is shown as Markdown: it cannot become a link. */
const inert = (text: string) => text.replace(/[\[\]<]/g, '\\$&');

/**
 * The line a cycle's record keeps about a request to the signatory. It names the request, so that the line can
 * be found again and put right if the answer it records is later taken back.
 */
export function requestRecordLine(org: Organisation, request: SignatoryRequest, came: string): string {
  const asker = execById(org, request.fromId)?.short ?? request.fromId;
  return `- Signatory, ${request.id}, for ${asker}: ${inert(describeRequest(request))}: ${came}`;
}

/**
 * Bring a stored organisation back to a state the engine can resume from:
 * nothing is in flight after a restart, so anything recorded as running goes
 * back in the queue, and a running loop comes back paused.
 */
export function normaliseLoaded(org: Organisation): Organisation {
  const migrateJobs = !org.business;
  org.business = { ...emptyBusiness(), ...org.business };
  org.settings = sanitiseSettings(org.settings);
  org.seq ??= 0;
  org.inbox ??= {};
  org.usageByExec ??= {};
  org.reviewRounds ??= [];
  org.decisions ??= [];
  org.reports ??= [];
  org.board ??= [];
  org.steers ??= [];
  org.history ??= [];
  repairUsage(org);
  // From before there were privileges: every role stands at the defaults.
  org.privileges ??= {};
  // From before there were work approaches: every plan ran the lead's own profile.
  org.workApproaches ??= {};
  syncSignatory(org);
  syncRouting(org);
  for (const plan of org.plans) {
    plan.execution ??= null;
    plan.managed ??= null;
    plan.workApproachId ??= STANDARD_APPROACH;
    plan.workApproachReason ??= null;
    plan.code ??= null;
    plan.skipped ??= [];
    plan.effort ??= null;
    for (const phase of plan.phases) {
      phase.gate ??= null;
      phase.evidence ??= null;
      phase.waitsFor ??= [];
      phase.effort ??= null;
      for (const task of phase.tasks) {
        // Local work that was in flight is lost with the process and goes back in the queue. An agent
        // in a hosted session carries on there, and is caught up with when the session is picked up.
        if (task.status === 'running' && !task.threadId) {
          task.status = 'pending';
          task.agent = null;
          task.startedAt = null;
        }
      }
    }
    if (plan.managed && (plan.managed.state === 'running' || plan.managed.state === 'starting')) {
      plan.managed.state = 'paused';
      // A session is held by whoever follows it, as it lets go. This one was still being followed when the state
      // was last saved, so the server stopped without that: the session is paused in name only until it is held.
      if (plan.managed.sessionId) plan.managed.adrift = true;
    }
  }
  if (migrateJobs) {
    for (const plan of org.plans) {
      const report = org.reports.find((r) => r.id === plan.reportId);
      const status = plan.status === 'done' ? 'review' : plan.status === 'cancelled' ? 'cancelled' : plan.status === 'failed' ? 'blocked' : 'in_progress';
      org.business.jobs.push({
        id: nextId(org, 'b'), revision: 1, createdAt: plan.createdAt, updatedAt: plan.updatedAt, updatedBy: 'system',
        title: plan.objective.slice(0, 200), description: plan.successCriteria, ownerId: plan.ownerId, status,
        nextAction: status === 'review' ? 'Inspect the delivery evidence and verify completion.' : status === 'blocked' ? 'Resolve the failed execution before reopening this commitment.' : 'Continue the existing execution plan.',
        blockedReason: status === 'blocked' ? 'The execution plan failed before business tracking was introduced.' : '',
        notBefore: null, dueAt: null, recurrenceDays: null, dependsOn: [], customerId: null, metricId: null, reviewerId: null,
        plan: { id: plan.id, cycle: plan.cycle },
        evidence: [report?.summary, report?.files.length ? 'Files: ' + report.files.join(', ') : ''].filter(Boolean).join('\n\n'),
        verification: null, previousJobId: null, nextJobId: null, notifiedAt: null,
      });
    }
  }
  if (org.status === 'running') {
    org.status = 'paused';
    org.pauseReason = 'restart';
  }
  org.schemaVersion = SCHEMA_VERSION;
  return org;
}

/**
 * Make the spend totals numbers again. An earlier version could add a cost that was not a number to them, after
 * which they were saved as nothing at all. A total that is not a number never reaches a budget, and what was
 * really spent can no longer be known, so the budget is counted as spent until a person raises it.
 */
function repairUsage(org: Organisation): void {
  const tidy = (saved: UsageTotals | undefined): UsageTotals => {
    const totals = emptyUsage();
    for (const key of Object.keys(totals) as Array<keyof UsageTotals>) {
      const value = saved?.[key];
      if (typeof value === 'number' && Number.isFinite(value)) totals[key] = value;
    }
    return totals;
  };
  const known = typeof org.usage?.costUsd === 'number' && Number.isFinite(org.usage.costUsd);
  org.usage = tidy(org.usage);
  for (const seat of Object.keys(org.usageByExec)) org.usageByExec[seat] = tidy(org.usageByExec[seat]);
  if (known) return;
  org.usage.costUsd = org.settings.budgetUsd;
  if (org.status !== 'idle') {
    org.status = 'paused';
    org.pauseReason = 'budget';
  }
  postToBoard(
    org,
    'system',
    'system',
    'Recorded spend could not be read',
    `What this organisation had spent was not saved as a number, so it is no longer known. Its $${org.settings.budgetUsd.toFixed(2)} budget is counted as spent. Check what was charged with your provider, then raise the budget to carry on.`,
  );
}

/** What a finished cycle delivered, as the CEO will be told at the start of later cycles. */
export function digestCycle(org: Organisation, endedAt: string): CycleRecord {
  const cycle = org.cycle;
  const plans = org.plans.filter((p) => p.cycle === cycle.number);
  const lines: string[] = [];
  for (const plan of plans) {
    const owner = execById(org, plan.ownerId);
    const report = org.reports.find((r) => r.id === plan.reportId);
    const who = `${owner?.short ?? plan.ownerId}${plan.origin.type === 'follow_up' ? ' (follow-up)' : ''}`;
    if (report) {
      lines.push(`- ${who}: ${report.headline}`);
      for (const outcome of report.outcomes.slice(0, 4)) lines.push(`  - ${outcome}`);
      for (const ask of report.asks.slice(0, 3)) lines.push(`  - Asks: ${ask}`);
    } else if (plan.status === 'cancelled') {
      lines.push(`- ${who}: plan cancelled ("${plan.objective}")${plan.cancelReason ? ` — ${plan.cancelReason}` : ''}`);
    } else {
      lines.push(`- ${who}: "${plan.objective}" ended ${plan.status} without a report`);
    }
  }
  // What was paid for or signed, refused, or left waiting is part of what the cycle came to.
  for (const request of org.signatory.requests) {
    if (request.outcome?.cycle === cycle.number) {
      const said = request.outcome.note ? ` (${inert(request.outcome.note.replace(/\s+/g, ' ').slice(0, 200))})` : '';
      const how = request.outcome.result === 'done' ? 'done' : request.outcome.result === 'rejected' ? 'REJECTED' : 'withdrawn';
      lines.push(requestRecordLine(org, request, `${how}${said}`));
    } else if (isOpen(request) && request.cycle <= cycle.number) {
      lines.push(requestRecordLine(org, request, 'still waiting, so it has not happened'));
    }
  }
  return {
    number: cycle.number,
    intent: cycle.intent ?? '',
    priorities: cycle.priorities,
    summary: lines.join('\n') || 'No plans were completed.',
    planCount: plans.length,
    startedAt: cycle.startedAt,
    endedAt,
  };
}

export function summarise(org: Organisation): OrgSummary {
  return {
    waitingForSchedule: org.status === 'running' && org.business.waiting,
    id: org.id,
    name: org.name,
    mission: org.mission,
    status: org.status,
    pauseReason: org.pauseReason,
    cycle: org.cycle.number,
    stage: org.cycle.stage,
    costUsd: org.usage.costUsd,
    budgetUsd: org.settings.budgetUsd,
    executives: org.executives.map((e) => ({
      id: e.id,
      short: e.short,
      title: e.title,
      hue: e.hue,
      kind: e.kind,
      agentCount: e.agentCount,
    })),
    waiting: waitingOnPerson(org).length,
    createdAt: org.createdAt,
    updatedAt: org.updatedAt,
  };
}

const RESULT_PREVIEW_CHARS = 700;

/** A copy of the organisation for the browser, with long agent reports shortened (the full text is fetched on demand). */
export function toClientView(org: Organisation): Organisation {
  return {
    ...org,
    business: { ...org.business, audit: org.business.audit.slice(-100) },
    plans: org.plans.map((plan) => ({
      ...plan,
      // The record of which outputs are already home is bookkeeping, and can be long.
      managed: plan.managed ? { ...plan.managed, synced: {} } : null,
      phases: plan.phases.map((phase) => ({
        ...phase,
        tasks: phase.tasks.map((task) =>
          task.result && task.result.length > RESULT_PREVIEW_CHARS
            ? { ...task, result: task.result.slice(0, RESULT_PREVIEW_CHARS), resultTruncated: true }
            : task,
        ),
      })),
    })),
  };
}
