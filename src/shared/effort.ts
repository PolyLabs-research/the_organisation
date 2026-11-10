import type { ActivityEntry, Organisation, Plan } from './types';
import { waitedIndex } from './waits';

/**
 * Effort, not time. Models cannot say how long work will take, but they can say how big it is. Leads rate
 * every plan, phase and task on this scale; the organisation learns what each level costs in minutes and
 * dollars from the work it has finished, and forecasts from that.
 */
export const EFFORT_SCALE: readonly string[] = [
  'Answered in the reply. No tools, or a single lookup.',
  'One small piece: a script, a query, a short document. A few tool calls, nothing to decide.',
  'One deliverable with some research or several files. Nothing to check back on.',
  'One deliverable that needs researching, building and checking. The first level where something can surprise.',
  'Several linked pieces, or one with real design decisions. Expect one review and a round of fixes.',
  'A small working system: several components, tests, and a round of fixing what did not work first time.',
  'A whole phase of work end to end: several tasks and reviews. Worth a short spec before starting.',
  'Several phases: a spec first, then a build in stages, reviewed between them.',
  'A spec, a plan for many agents, and a campaign to carry it out across several leads.',
  'A full programme: several parts, each a 7 or 8 in its own right, built over many cycles.',
];

/** The scale as a lead reads it. */
export function effortScaleText(): string {
  return EFFORT_SCALE.map((line, i) => `${i + 1}. ${line}`).join('\n');
}

/** A rating as a model gave it, made a whole number from 1 to 10, or null if it is not a number. */
export function clampEffort(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(10, Math.max(1, Math.round(n)));
}

// ---- calibration ----

export interface Sample {
  effort: number;
  minutes: number;
  costUsd: number;
  model: string;
}

/** How a forecast for one level was reached: measured at that level, read off a fitted curve, or not known. */
export type Basis = 'measured' | 'fitted';

export interface Estimate {
  minutes: number;
  costUsd: number;
  basis: Basis;
  /** Samples behind it. */
  n: number;
}

export interface LevelStat {
  effort: number;
  model: string;
  n: number;
  minutes: { median: number; min: number; max: number };
  costUsd: { median: number };
}

/** Fewest samples at one level before its median is trusted over the curve. */
const MEASURED_AT = 3;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** Least squares of log(y) on effort: work tends to grow by a factor per level, not by a fixed amount. */
function fitLog(samples: Sample[], y: (s: Sample) => number): { a: number; b: number } | null {
  const points = samples.filter((s) => y(s) > 0);
  if (points.length < 4 || new Set(points.map((s) => s.effort)).size < 2) return null;
  const xs = points.map((s) => s.effort);
  const ys = points.map((s) => Math.log(y(s)));
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  const sxx = xs.reduce((sum, x) => sum + (x - mx) ** 2, 0);
  const sxy = xs.reduce((sum, x, i) => sum + (x - mx) * (ys[i]! - my), 0);
  // Bigger work should not come out cheaper, whatever a few odd samples say.
  const b = Math.max(0, sxy / sxx);
  return { a: my - b * mx, b };
}

export class Calibration {
  readonly levels: LevelStat[];
  private readonly fits = new Map<string, { minutes: { a: number; b: number } | null; cost: { a: number; b: number } | null }>();

  constructor(readonly samples: Sample[]) {
    const groups = new Map<string, Sample[]>();
    for (const s of samples) {
      for (const key of [`${s.model}|${s.effort}`, `*|${s.effort}`]) groups.set(key, [...(groups.get(key) ?? []), s]);
    }
    this.levels = [...groups.entries()]
      .map(([key, group]) => {
        const [model, effort] = key.split('|');
        const minutes = group.map((s) => s.minutes);
        return { effort: Number(effort), model: model!, n: group.length, minutes: { median: median(minutes), min: Math.min(...minutes), max: Math.max(...minutes) }, costUsd: { median: median(group.map((s) => s.costUsd)) } };
      })
      .sort((a, b) => a.model.localeCompare(b.model) || a.effort - b.effort);
  }

  private fitFor(model: string) {
    let fit = this.fits.get(model);
    if (!fit) {
      const pool = model === '*' ? this.samples : this.samples.filter((s) => s.model === model);
      fit = { minutes: fitLog(pool, (s) => s.minutes), cost: fitLog(pool, (s) => s.costUsd) };
      this.fits.set(model, fit);
    }
    return fit;
  }

  /**
   * What work of this effort should take on this model: its own record first, then all models'. A level
   * measured often enough is taken as it is; otherwise the fitted curve; failing both, whatever was measured
   * at that level, however little (the sample count says how little).
   */
  estimate(effort: number | null | undefined, model = '*'): Estimate | null {
    if (!effort) return null;
    const models = model === '*' ? ['*'] : [model, '*'];
    const level = (m: string) => this.levels.find((l) => l.model === m && l.effort === effort);
    const measured = (l: LevelStat): Estimate => ({ minutes: l.minutes.median, costUsd: l.costUsd.median, basis: 'measured', n: l.n });
    for (const m of models) {
      const l = level(m);
      if (l && l.n >= MEASURED_AT) return measured(l);
      const fit = this.fitFor(m);
      if (fit.minutes) {
        const n = m === '*' ? this.samples.length : this.samples.filter((s) => s.model === m).length;
        return { minutes: Math.exp(fit.minutes.a + fit.minutes.b * effort), costUsd: fit.cost ? Math.exp(fit.cost.a + fit.cost.b * effort) : 0, basis: 'fitted', n };
      }
    }
    for (const m of models) {
      const l = level(m);
      if (l) return measured(l);
    }
    return null;
  }
}

/** Finished agent tasks that were rated, one sample each. */
export function taskSamples(activity: ActivityEntry[]): Sample[] {
  return activity
    .filter((a) => a.kind === 'task' && a.ok && a.effort)
    .map((a) => ({ effort: a.effort!, minutes: a.ms / 60_000, costUsd: a.costUsd, model: a.model || '?' }));
}

/** Finished phases that were rated: from the lead handing out the work to the lead passing it. */
export function phaseSamples(org: Organisation, activity: ActivityEntry[]): Sample[] {
  const out: Sample[] = [];
  for (const plan of org.plans) {
    plan.phases.forEach((phase, index) => {
      if (phase.status !== 'done' || !phase.effort) return;
      const mine = activity.filter((a) => a.planId === plan.id && a.phaseIndex === index);
      const kickoff = mine.find((a) => a.kind === 'kickoff');
      const review = mine.filter((a) => a.kind === 'phase_review' && a.ok).at(-1);
      if (!kickoff || !review) return;
      const start = startOf(kickoff);
      const end = Date.parse(review.at);
      const model = mine.find((a) => a.kind === 'task')?.model || org.settings.workerModel;
      out.push({ effort: phase.effort, minutes: Math.max(0, end - start) / 60_000, costUsd: mine.reduce((sum, a) => sum + a.costUsd, 0), model });
    });
  }
  return out;
}

export const startOf = (a: Pick<ActivityEntry, 'at' | 'ms'>) => Date.parse(a.at) - a.ms;

// ---- forecast ----

/** A piece of work not yet finished, placed where the calibration says it will fall. */
export interface ProjectedBar {
  execId: string;
  planId: string;
  phaseIndex: number;
  /** For a task: its id and the agent row it is expected on. For a whole phase not yet handed out: null. */
  taskId: string | null;
  agent: number | null;
  label: string;
  effort: number;
  start: number;
  end: number;
  basis: Basis;
  /** What the work is expected to cost, from the same calibration. */
  costUsd: number;
}

const MINUTE = 60_000;
/** A lead's gate review, when there is nothing to measure it by. */
const DEFAULT_REVIEW_MS = 40_000;

/**
 * Where the unfinished work of every plan under way should fall, from its ratings and what this organisation
 * has taken at each level. Work with no rating, or before anything has been measured, is left out: a
 * forecast with nothing behind it is worse than none.
 */
export function forecast(org: Organisation, activity: ActivityEntry[], now = Date.now()): ProjectedBar[] {
  const tasks = new Calibration(taskSamples(activity));
  const phases = new Calibration(phaseSamples(org, activity));
  const reviews = activity.filter((a) => a.kind === 'phase_review' && a.ok).map((a) => a.ms);
  const reviewMs = reviews.length ? median(reviews) : DEFAULT_REVIEW_MS;
  const model = org.settings.workerModel;
  const live = org.plans.filter((p) => p.status === 'executing' || p.status === 'approved');

  // When each phase is expected to end, for phases that wait on it. Refined over a few passes, since a plan's
  // forecast depends on the plans it waits on.
  let ends = new Map<string, number>();
  let bars: ProjectedBar[] = [];
  for (let pass = 0; pass < 4; pass++) {
    const next = new Map<string, number>();
    bars = live.flatMap((plan) => planForecast(org, plan, tasks, phases, reviewMs, model, now, ends, next));
    ends = next;
  }
  return bars;
}

function planForecast(
  org: Organisation,
  plan: Plan,
  tasks: Calibration,
  phases: Calibration,
  reviewMs: number,
  model: string,
  now: number,
  waitEnds: Map<string, number>,
  ends: Map<string, number>,
): ProjectedBar[] {
  const lead = org.executives.find((e) => e.id === plan.ownerId);
  const slots = Math.max(1, lead?.agentCount ?? 1);
  const bars: ProjectedBar[] = [];
  let cursor = now;
  for (let index = 0; index < plan.phases.length; index++) {
    const phase = plan.phases[index]!;
    if (phase.status === 'done') continue;
    // A phase starts no earlier than what it waits on is expected to finish.
    for (const w of phase.waitsFor ?? []) {
      if (w.released || !w.planId) continue;
      const target = org.plans.find((p) => p.id === w.planId);
      if (!target || target.status === 'done' || target.status === 'cancelled' || target.status === 'failed') continue;
      const at = waitedIndex(target, w);
      if (at === 'gone') continue;
      const end = waitEnds.get(`${w.planId}:${at ?? 'all'}`);
      if (end) cursor = Math.max(cursor, end);
    }
    let end: number | null = null;
    if (phase.status === 'working' && phase.tasks.length) {
      // Handed out: place each unfinished task on the agent expected to be free first.
      const free = Array.from({ length: slots }, () => now);
      for (const task of phase.tasks.filter((t) => t.status === 'running')) {
        const est = tasks.estimate(task.effort, model);
        const slot = Math.min(Math.max((task.agent ?? 1) - 1, 0), slots - 1);
        const started = task.startedAt ? Date.parse(task.startedAt) : now;
        const taskEnd = est ? Math.max(now + MINUTE / 6, started + est.minutes * MINUTE) : now;
        free[slot] = Math.max(free[slot]!, taskEnd);
        if (est) bars.push({ execId: plan.ownerId, planId: plan.id, phaseIndex: index, taskId: task.id, agent: slot + 1, label: task.title, effort: task.effort!, start: started, end: taskEnd, basis: est.basis, costUsd: est.costUsd });
      }
      let complete = true;
      for (const task of phase.tasks.filter((t) => t.status === 'pending')) {
        const est = tasks.estimate(task.effort, model);
        if (!est) {
          complete = false;
          continue;
        }
        const slot = free.indexOf(Math.min(...free));
        const start = free[slot]!;
        const taskEnd = start + est.minutes * MINUTE;
        free[slot] = taskEnd;
        bars.push({ execId: plan.ownerId, planId: plan.id, phaseIndex: index, taskId: task.id, agent: slot + 1, label: task.title, effort: task.effort!, start, end: taskEnd, basis: est.basis, costUsd: est.costUsd });
      }
      end = complete ? Math.max(...free) + reviewMs : null;
    } else {
      const est = phases.estimate(phase.effort, model);
      if (est) {
        end = cursor + est.minutes * MINUTE;
        bars.push({ execId: plan.ownerId, planId: plan.id, phaseIndex: index, taskId: null, agent: null, label: phase.name, effort: phase.effort!, start: cursor, end, basis: est.basis, costUsd: est.costUsd });
      }
    }
    // Past a phase that cannot be forecast, nothing after it can be placed either.
    if (end === null) break;
    ends.set(`${plan.id}:${index}`, end);
    cursor = end;
  }
  if (bars.length && plan.phases.every((p, i) => p.status === 'done' || ends.has(`${plan.id}:${i}`))) ends.set(`${plan.id}:all`, cursor);
  return bars;
}
