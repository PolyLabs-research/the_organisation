import { describe, expect, it } from 'vitest';
import { Calibration, clampEffort, effortScaleText, forecast, phaseSamples, taskSamples, type Sample } from '../src/shared/effort';
import { createOrganisation } from '../src/server/engine/state';
import type { ActivityEntry, Organisation, Plan, Task } from '../src/shared/types';
import { harness, runToRest } from './helpers';

const T0 = Date.parse('2026-11-08T12:00:00Z');
const MIN = 60_000;

function entry(fields: Partial<ActivityEntry> & { kind: ActivityEntry['kind']; start: number; minutes: number }): ActivityEntry {
  const { start, minutes, ...rest } = fields;
  return { id: 'a', at: new Date(start + minutes * MIN).toISOString(), execId: 'cto', label: 'x', model: 'claude-sonnet-5-5', ms: minutes * MIN, ok: true, error: null, inputTokens: 0, outputTokens: 0, costUsd: 0.1, ...rest };
}

const sample = (effort: number, minutes: number, model = 'm'): Sample => ({ effort, minutes, costUsd: minutes / 10, model });

describe('the effort scale', () => {
  it('has ten anchors and reads as a numbered list', () => {
    expect(effortScaleText().split('\n')).toHaveLength(10);
    expect(effortScaleText()).toMatch(/^1\. Answered in the reply/);
  });

  it('turns what a model gives into a whole number from 1 to 10, or nothing', () => {
    expect([clampEffort(4), clampEffort(4.6), clampEffort(14), clampEffort(0), clampEffort(-2), clampEffort('3'), clampEffort('x'), clampEffort(undefined)]).toEqual([4, 5, 10, null, null, 3, null, null]);
  });
});

describe('learning what each level takes', () => {
  it('uses the median at a level once it has three samples', () => {
    const cal = new Calibration([sample(3, 2), sample(3, 4), sample(3, 30)]);
    expect(cal.estimate(3)).toMatchObject({ minutes: 4, basis: 'measured', n: 3 });
  });

  it('reads a level it has too few samples of off a curve fitted to the rest', () => {
    // Doubling per level: 1, 2, 4, 8 minutes at levels 1 to 4.
    const cal = new Calibration([1, 2, 3, 4].map((e) => sample(e, 2 ** (e - 1))));
    const est = cal.estimate(6)!;
    expect(est.basis).toBe('fitted');
    expect(est.minutes).toBeCloseTo(32, 0);
  });

  it('never has bigger work come out quicker, whatever a few samples say', () => {
    const cal = new Calibration([sample(2, 10), sample(2, 10), sample(5, 1), sample(5, 1)]);
    expect(cal.estimate(8)!.minutes).toBeGreaterThanOrEqual(cal.estimate(3)!.minutes - 1e-9);
  });

  it('prefers a model’s own record, and falls back to all models', () => {
    const cal = new Calibration([sample(4, 10, 'slow'), sample(4, 10, 'slow'), sample(4, 10, 'slow'), sample(4, 2, 'fast'), sample(4, 2, 'fast'), sample(4, 2, 'fast')]);
    expect(cal.estimate(4, 'slow')!.minutes).toBe(10);
    expect(cal.estimate(4, 'fast')!.minutes).toBe(2);
    expect(cal.estimate(4, 'new-model')!.minutes).toBe(6);
  });

  it('says nothing when there is nothing to go on', () => {
    expect(new Calibration([]).estimate(4)).toBeNull();
    expect(new Calibration([sample(4, 3)]).estimate(null)).toBeNull();
  });

  it('learns only from finished, rated tasks', () => {
    const samples = taskSamples([
      entry({ kind: 'task', start: T0, minutes: 3, effort: 3 }),
      entry({ kind: 'task', start: T0, minutes: 3, effort: null }),
      entry({ kind: 'task', start: T0, minutes: 3, effort: 3, ok: false }),
      entry({ kind: 'kickoff', start: T0, minutes: 1, effort: 3 }),
    ]);
    expect(samples).toEqual([{ effort: 3, minutes: 3, costUsd: 0.1, model: 'claude-sonnet-5-5' }]);
  });
});

function organisation(): Organisation {
  const org = createOrganisation({ name: 'Fernery', idea: 'Houseplants by post.', executives: [{ profileId: 'engineering', agentCount: 2 }, { profileId: 'marketing', agentCount: 1 }] }, 'org_1');
  org.cycle.stage = 'work';
  return org;
}

function task(id: string, effort: number | null, status: Task['status'] = 'pending', fields: Partial<Task> = {}): Task {
  return { id, title: id, brief: 'b', status, agent: null, rework: false, result: null, files: [], error: null, attempts: 0, startedAt: null, finishedAt: null, effort, ...fields };
}

function plan(org: Organisation, ownerId: string, id: string): Plan {
  const owner = org.executives.find((e) => e.id === ownerId)!;
  const at = new Date(T0).toISOString();
  const p: Plan = {
    id, cycle: 1, ownerId, origin: { type: 'directive' }, depth: 0, objective: 'o', successCriteria: 'c', priority: 'medium', rationale: 'r', approach: 'a', workApproachId: 'standard', workApproachReason: null,
    phases: owner.phases.map((ph) => ({ sopPhaseId: ph.id, name: ph.name, purpose: ph.purpose, deliverable: ph.deliverable, intent: ph.purpose, notes: '', status: 'pending', tasks: [], reworkRounds: 0, summary: null, gate: null, evidence: null, waitsFor: [], effort: 5 })),
    skipped: [], effort: 6, status: 'executing', amendments: [], escalations: [], decisionId: null, reportId: null, cancelReason: null, createdAt: at, updatedAt: at, execution: 'local', managed: null, code: null,
  };
  org.plans.push(p);
  return p;
}

/** Three finished tasks at each of levels 2 and 4 (2 and 8 minutes), and two finished phases at level 5 (20 minutes). */
function history(org: Organisation): ActivityEntry[] {
  const done = plan(org, 'cto', 'p0');
  done.status = 'done';
  const entries: ActivityEntry[] = [];
  for (let i = 0; i < 3; i++) {
    entries.push(entry({ kind: 'task', start: T0, minutes: 2, effort: 2 }), entry({ kind: 'task', start: T0, minutes: 8, effort: 4 }));
  }
  for (const index of [0, 1]) {
    done.phases[index]!.status = 'done';
    entries.push(entry({ kind: 'kickoff', start: T0, minutes: 1, planId: 'p0', phaseIndex: index }), entry({ kind: 'phase_review', start: T0 + 19 * MIN, minutes: 1, planId: 'p0', phaseIndex: index }));
  }
  return entries;
}

describe('the forecast', () => {
  it('measures a phase from handing out the work to passing it', () => {
    const org = organisation();
    expect(phaseSamples(org, history(org))).toEqual([
      expect.objectContaining({ effort: 5, minutes: 20 }),
      expect.objectContaining({ effort: 5, minutes: 20 }),
    ]);
  });

  it('places a handed-out phase’s tasks on the agents expected to be free first, then the phases after it', () => {
    const org = organisation();
    const entries = history(org);
    const p = plan(org, 'cto', 'p1');
    const now = T0 + 60 * MIN;
    p.phases[0]!.status = 'working';
    p.phases[0]!.tasks = [task('t1', 4, 'running', { agent: 1, startedAt: new Date(now - 2 * MIN).toISOString() }), task('t2', 2), task('t3', 2)];
    const bars = forecast(org, entries, now);
    const byId = Object.fromEntries(bars.filter((b) => b.taskId).map((b) => [b.taskId, b]));
    // t1 started 2 minutes ago and takes 8, so it has 6 left on agent 1; t2 goes to agent 2 straight away, t3 after it.
    expect(byId.t1).toMatchObject({ agent: 1, end: now + 6 * MIN, basis: 'measured' });
    expect(byId.t2).toMatchObject({ agent: 2, start: now, end: now + 2 * MIN });
    expect(byId.t3).toMatchObject({ agent: 2, start: now + 2 * MIN, end: now + 4 * MIN });
    const later = bars.filter((b) => !b.taskId);
    expect(later.map((b) => b.label)).toEqual(['Build', 'Test', 'Release']);
    // The next phase starts once the slowest task and the gate review are done.
    expect(later[0]!.start).toBeGreaterThanOrEqual(now + 6 * MIN);
    expect(later[0]!.end - later[0]!.start).toBe(20 * MIN);
    expect(later[1]!.start).toBe(later[0]!.end);
  });

  it('starts a waiting phase no earlier than what it waits on is forecast to finish', () => {
    const org = organisation();
    const entries = history(org);
    const now = T0 + 60 * MIN;
    const cto = plan(org, 'cto', 'p1');
    const cmo = plan(org, 'cmo', 'p2');
    cmo.phases[0]!.waitsFor = [{ leadId: 'cto', phase: 'Build', planId: cto.id, phaseIndex: 1, released: null }];
    const bars = forecast(org, entries, now);
    const ctoBuild = bars.find((b) => b.planId === 'p1' && b.phaseIndex === 1)!;
    const cmoFirst = bars.find((b) => b.planId === 'p2' && b.phaseIndex === 0)!;
    expect(cmoFirst.start).toBe(ctoBuild.end);
  });

  it('stops at work it cannot rate, rather than guess past it', () => {
    const org = organisation();
    const entries = history(org);
    const p = plan(org, 'cto', 'p1');
    p.phases[1]!.effort = null;
    const bars = forecast(org, entries, T0 + 60 * MIN).filter((b) => b.planId === 'p1');
    expect(bars.map((b) => b.label)).toEqual(['Spec']);
  });

  it('forecasts nothing before anything rated has finished', () => {
    const org = organisation();
    plan(org, 'cto', 'p1');
    expect(forecast(org, [], T0)).toEqual([]);
  });
});

describe('an organisation rating its work', () => {
  it('records ratings on plans, phases and tasks, and on the log of each call', async () => {
    const h = await harness();
    try {
      await runToRest(h.runner);
      const plans = h.org.plans;
      expect(plans.every((p) => p.effort === 6)).toBe(true);
      expect(plans.every((p) => p.phases.every((ph) => ph.effort === 5))).toBe(true);
      expect(plans.flatMap((p) => p.phases.flatMap((ph) => ph.tasks)).every((t) => t.effort !== null && t.effort >= 1 && t.effort <= 10)).toBe(true);
      const history = await h.runner.history();
      const tasks = history.filter((a) => a.kind === 'task');
      expect(tasks.length).toBeGreaterThan(0);
      expect(tasks.every((a) => a.planId && a.taskId && a.phaseIndex !== null && a.agent && a.effort)).toBe(true);
      expect(history.filter((a) => a.kind === 'kickoff').every((a) => a.planId && a.phaseIndex !== null && !a.taskId)).toBe(true);
      expect(history.filter((a) => a.kind === 'consult').every((a) => a.planId === null)).toBe(true);
      // What was learned is enough to forecast with.
      expect(new Calibration(taskSamples(history)).estimate(3)).not.toBeNull();
    } finally {
      await h.cleanup();
    }
  });
});
