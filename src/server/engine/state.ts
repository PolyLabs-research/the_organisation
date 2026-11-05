import { PROFILE_BY_ID, MAX_LEADS, executiveFromDraft } from '../../shared/profiles';
import type {
  BoardMessage,
  BoardMessageType,
  CreateOrgRequest,
  CycleRecord,
  Executive,
  Organisation,
  OrgSettings,
  OrgSummary,
  Plan,
  PlanPhase,
  UsageTotals,
} from '../../shared/types';
import { DEFAULT_MODEL, isKnownModel } from '../providers/pricing';
import type { CallUsage } from '../providers/types';

export const DEFAULT_SETTINGS: OrgSettings = {
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
};

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/** A ceiling on the follow-up plans one lead may start in a cycle, whatever the reports say. */
export const MAX_FOLLOW_UPS_PER_LEAD = 2;

/** How many cycles of plans, decisions and reports stay in live state; older ones are archived to disk. */
export const LIVE_CYCLES = 3;
/** A backstop only: the board is trimmed by archiving whole cycles, so nothing is dropped unarchived in normal running. */
const MAX_BOARD_MESSAGES = 3000;

export class ValidationError extends Error {}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, n));
}

/** Merge a partial settings patch over `base`, keeping every field inside its allowed range. */
export function sanitiseSettings(patch: Partial<OrgSettings> | undefined, base: OrgSettings = DEFAULT_SETTINGS): OrgSettings {
  const p = patch ?? {};
  const model = (value: unknown, fallback: string) => (typeof value === 'string' && isKnownModel(value) ? value : fallback);
  const effort = (value: unknown, fallback: OrgSettings['executiveEffort']) =>
    EFFORTS.includes(value as (typeof EFFORTS)[number]) ? (value as OrgSettings['executiveEffort']) : fallback;
  return {
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
  };
}

export function emptyUsage(): UsageTotals {
  return { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, webSearches: 0, costUsd: 0 };
}

export function addUsage(total: UsageTotals, call: CallUsage): void {
  total.calls += 1;
  total.inputTokens += call.inputTokens;
  total.outputTokens += call.outputTokens;
  total.cacheReadTokens += call.cacheReadTokens;
  total.cacheWriteTokens += call.cacheWriteTokens;
  total.webSearches += call.webSearches;
  total.costUsd += call.costUsd;
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
  refs: Pick<BoardMessage, 'planId' | 'decisionId' | 'reportId'> = {},
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

  const used = new Set<string>();
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

  const now = new Date().toISOString();
  const org: Organisation = {
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
    usage: emptyUsage(),
    usageByExec: {},
  };
  postToBoard(
    org,
    'system',
    'system',
    'Organisation established',
    `${name} is established with ${leadCount} executive lead${leadCount === 1 ? '' : 's'} under the CEO. Decisions that leads cannot settle between them are signed off by the ${settings.arbiter === 'judge' ? 'independent judge' : 'CEO'}.`,
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

/** Seat or unseat the judge so the roster matches the arbiter setting. */
export function syncJudge(org: Organisation): void {
  const hasJudge = org.executives.some((e) => e.kind === 'judge');
  if (org.settings.arbiter === 'judge' && !hasJudge) {
    org.executives.push(executiveFromDraft({ profileId: 'judge' }, 'judge')!);
  } else if (org.settings.arbiter === 'ceo' && hasJudge) {
    org.executives = org.executives.filter((e) => e.kind !== 'judge');
  }
}

/**
 * Bring a stored organisation back to a state the engine can resume from:
 * nothing is in flight after a restart, so anything recorded as running goes
 * back in the queue, and a running loop comes back paused.
 */
export function normaliseLoaded(org: Organisation): Organisation {
  org.settings = sanitiseSettings(org.settings);
  org.seq ??= 0;
  org.inbox ??= {};
  org.usageByExec ??= {};
  for (const plan of org.plans) {
    for (const phase of plan.phases) {
      for (const task of phase.tasks) {
        if (task.status === 'running') {
          task.status = 'pending';
          task.agent = null;
          task.startedAt = null;
        }
      }
    }
  }
  if (org.status === 'running') {
    org.status = 'paused';
    org.pauseReason = 'restart';
  }
  return org;
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
    createdAt: org.createdAt,
    updatedAt: org.updatedAt,
  };
}

const RESULT_PREVIEW_CHARS = 700;

/** A copy of the organisation for the browser, with long agent reports shortened (the full text is fetched on demand). */
export function toClientView(org: Organisation): Organisation {
  return {
    ...org,
    plans: org.plans.map((plan) => ({
      ...plan,
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
