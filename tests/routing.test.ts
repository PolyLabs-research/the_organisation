import { afterEach, describe, expect, it } from 'vitest';
import { GIVES_UP_AT, RECENT_TASKS, TAKES_ON_AFTER, judgeRound } from '../src/server/engine/routing';
import { ValidationError, assertModelRefs, createOrganisation, sanitiseSettings, syncRouting } from '../src/server/engine/state';
import { forecast } from '../src/shared/effort';
import { levelsOf, modelForTask, rungsOf } from '../src/shared/routing';
import type { ActivityEntry, LadderRung, Organisation, PlanPhase, Task } from '../src/shared/types';
import { MockProvider } from '../src/server/providers/mock';
import { QUIET, harness, runToRest, type Harness } from './helpers';

// Which model an agent's task goes to: by the task's rating, from a ladder of cheaper models under the agents' own,
// one model up for work that is being put right, and with levels that follow what the leads make of the work.

const HAIKU = 'claude-haiku-5-5';
const SONNET = 'claude-sonnet-5-5';
const OPUS = 'claude-opus-5-5';
const LADDER: LadderRung[] = [
  { model: HAIKU, upTo: 2 },
  { model: SONNET, upTo: 4 },
];

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

function organisation(settings: Partial<Organisation['settings']> = {}): Organisation {
  return createOrganisation({ name: 'Fernery', idea: 'Houseplants by post.', executives: [{ profileId: 'engineering', agentCount: 3 }], settings: { workerModel: OPUS, workerLadder: LADDER, ...settings } }, 'org_routing');
}

let seq = 0;
function task(fields: Partial<Task> = {}): Task {
  return { id: `t${++seq}`, title: 'A task', brief: 'Do it.', status: 'done', agent: 1, rework: false, result: 'Done.', files: [], error: null, attempts: 1, startedAt: null, finishedAt: null, effort: 2, ...fields };
}

const phaseOf = (tasks: Task[]): PlanPhase => ({ sopPhaseId: 'spec', name: 'Spec', purpose: '', deliverable: '', intent: '', notes: '', status: 'working', tasks, reworkRounds: 0, summary: null, gate: null, evidence: null, waitsFor: [], effort: null });

describe('the model a task goes to', () => {
  it('is the agents’ model for every task when there is no ladder', () => {
    const org = organisation({ workerLadder: [] });
    expect(org.routing).toBeNull();
    for (const effort of [1, 5, 10, null]) expect(modelForTask(org, null, { effort, rework: false })).toBe(OPUS);
  });

  it('goes by the task’s rating: the lightest model that takes that level, and the agents’ model above them all', () => {
    const org = organisation();
    const at = (effort: number | null) => modelForTask(org, null, { effort, rework: false });
    expect([1, 2, 3, 4, 5, 10].map(at)).toEqual([HAIKU, HAIKU, SONNET, SONNET, OPUS, OPUS]);
    // Work nobody rated could be any size.
    expect(at(null)).toBe(OPUS);
  });

  it('sends work that is being put right one model above the one that fell short', () => {
    const org = organisation();
    const light = task({ effort: 2, model: HAIKU });
    const middling = task({ effort: 4, model: SONNET });
    const phase = phaseOf([light, middling]);
    // The lead named the task: one above the model that did it, and never below what its own rating calls for.
    expect(modelForTask(org, phase, { effort: 1, rework: true, redoes: light.id })).toBe(SONNET);
    expect(modelForTask(org, phase, { effort: 5, rework: true, redoes: light.id })).toBe(OPUS);
    expect(modelForTask(org, phase, { effort: 2, rework: true, redoes: middling.id })).toBe(OPUS);
    // Nobody was named: one above where its own rating would have put it, and no higher than the top.
    expect(modelForTask(org, phase, { effort: 2, rework: true, redoes: null })).toBe(SONNET);
    expect(modelForTask(org, phase, { effort: 4, rework: true })).toBe(OPUS);
    expect(modelForTask(org, phase, { effort: 9, rework: true })).toBe(OPUS);
  });
});

describe('the ladder as it is kept', () => {
  it('keeps rungs in order, each a different model, none of them the agents’ own', () => {
    const tidy = (workerLadder: unknown, workerModel = OPUS) => sanitiseSettings({ workerModel, workerLadder: workerLadder as LadderRung[] }).workerLadder;
    expect(tidy(LADDER)).toEqual(LADDER);
    // A rung that does not reach above the one below it is moved up to the next level.
    expect(tidy([{ model: HAIKU, upTo: 4 }, { model: SONNET, upTo: 2 }])).toEqual([{ model: HAIKU, upTo: 4 }, { model: SONNET, upTo: 5 }]);
    // The agents' own model is the top of the ladder, not a rung of it, and no model is on it twice.
    expect(tidy([{ model: OPUS, upTo: 2 }, { model: HAIKU, upTo: 3 }, { model: HAIKU, upTo: 5 }])).toEqual([{ model: HAIKU, upTo: 3 }]);
    // Three rungs at most, and the top of the scale stays with the agents' model.
    expect(tidy([{ model: 'a', upTo: 1 }, { model: 'b', upTo: 2 }, { model: 'c', upTo: 30 }, { model: 'd', upTo: 9 }])).toEqual([{ model: 'a', upTo: 1 }, { model: 'b', upTo: 2 }, { model: 'c', upTo: 9 }]);
    expect(tidy('haiku')).toEqual([]);
  });

  it('drops a rung when the agents are moved onto its model', () => {
    const before = sanitiseSettings({ workerModel: OPUS, workerLadder: LADDER });
    expect(sanitiseSettings({ workerModel: SONNET }, before).workerLadder).toEqual([{ model: HAIKU, upTo: 2 }]);
  });

  it('refuses a rung that names no model or no level, and says which', () => {
    expect(() => assertModelRefs({ workerLadder: [{ model: '', upTo: 2 }] })).toThrow(ValidationError);
    expect(() => assertModelRefs({ workerLadder: [{ model: HAIKU, upTo: 0 }] })).toThrow(/those rated up to a level from 1 to 9/);
    expect(() => assertModelRefs({ workerLadder: 'haiku' as unknown as LadderRung[] })).toThrow(/must be a list/);
    expect(() => assertModelRefs({ workerLadder: LADDER })).not.toThrow();
  });

  it('starts what it has learned afresh when the ladder itself is changed, and not otherwise', () => {
    const org = organisation();
    org.routing!.rungs[0]!.upTo = 3;
    org.routing!.rungs[0]!.recent.push({ level: 3, ok: true });
    // Another setting altogether.
    org.settings = sanitiseSettings({ budgetUsd: 50 }, org.settings);
    syncRouting(org);
    expect(org.routing!.rungs[0]).toMatchObject({ upTo: 3, recent: [{ level: 3, ok: true }] });
    expect(rungsOf(org)[0]).toEqual({ model: HAIKU, upTo: 3 });
    // A level set by hand.
    org.settings = sanitiseSettings({ workerLadder: [{ model: HAIKU, upTo: 1 }, { model: SONNET, upTo: 4 }] }, org.settings);
    syncRouting(org);
    expect(org.routing!.rungs.map((rung) => [rung.upTo, rung.recent.length, rung.ceiling])).toEqual([[1, 0, null], [4, 0, null]]);
    // Told not to follow results, it keeps to what was set and keeps no record.
    org.settings = sanitiseSettings({ workerLadderLearns: false }, org.settings);
    syncRouting(org);
    expect(org.routing).toBeNull();
    expect(rungsOf(org)).toEqual([{ model: HAIKU, upTo: 1 }, { model: SONNET, upTo: 4 }]);
  });
});

describe('what the ladder learns from the leads’ reviews', () => {
  const lead = (org: Organisation) => org.executives.find((seat) => seat.kind === 'lead')!;
  /** One review of a phase in which `model` did tasks at these levels, of which the lead sent back the ones marked false. */
  function review(org: Organisation, model: string, results: Array<[level: number, stood: boolean]>): void {
    const tasks = results.map(([effort]) => task({ effort, model }));
    judgeRound(org, lead(org), phaseOf(tasks), new Set(tasks.filter((_, i) => !results[i]![1]).map((t) => t.id)));
  }
  const notes = (org: Organisation) => org.board.filter((m) => /Tasks rated/.test(m.title)).map((m) => m.title);

  it('marks each task the lead has read as let stand, sent back or failed, once', () => {
    const org = organisation();
    const stood = task({ model: HAIKU });
    const back = task({ model: HAIKU });
    const failed = task({ model: HAIKU, status: 'failed', error: 'declined' });
    const running = task({ model: HAIKU, status: 'running' });
    const phase = phaseOf([stood, back, failed, running]);
    judgeRound(org, lead(org), phase, new Set([back.id]));
    expect([stood.judged, back.judged, failed.judged, running.judged]).toEqual(['accepted', 'sent_back', 'failed', undefined]);
    expect(org.routing!.rungs[0]!.recent).toEqual([{ level: 2, ok: true }, { level: 2, ok: false }, { level: 2, ok: false }]);
    // The next review of the same phase judges only what is new.
    running.status = 'done';
    judgeRound(org, lead(org), phase, new Set());
    expect(running.judged).toBe('accepted');
    expect(org.routing!.rungs[0]!.recent).toHaveLength(4);
  });

  it('takes every task as sent back when the system’s own checks stopped the phase and nobody was named', () => {
    const org = organisation();
    const tasks = [task({ model: HAIKU }), task({ model: SONNET, effort: 4 })];
    judgeRound(org, lead(org), phaseOf(tasks), 'all');
    expect(tasks.map((t) => t.judged)).toEqual(['sent_back', 'sent_back']);
  });

  it('has a model give up its highest level when its work keeps being sent back, and does not try it there again', () => {
    const org = organisation();
    review(org, HAIKU, [[2, true], [2, false], [1, true], [2, false]]);
    expect(rungsOf(org)[0]!.upTo).toBe(2);
    expect(notes(org)).toEqual([]);
    review(org, HAIKU, [[2, false]]);
    expect(GIVES_UP_AT).toBe(3);
    expect(org.routing!.rungs[0]).toEqual({ model: HAIKU, upTo: 1, ceiling: 1, recent: [] });
    expect(modelForTask(org, null, { effort: 2, rework: false })).toBe(SONNET);
    expect(notes(org)).toEqual([`Tasks rated 2 no longer go to ${HAIKU}`]);
    expect(org.board.at(-1)!.body).toContain(`Of the last 5 tasks ${HAIKU} did for the leads, 3 were sent back or failed`);
    expect(org.board.at(-1)!.body).toContain(`tasks rated 2 go to ${SONNET}`);
    // Any number of tasks at the level it has left that stand do not take it back up.
    review(org, HAIKU, Array.from({ length: 12 }, () => [1, true] as [number, boolean]));
    expect(rungsOf(org)[0]!.upTo).toBe(1);
    expect(notes(org)).toHaveLength(1);
  });

  it('forgets what was sent back once enough has stood since', () => {
    const org = organisation();
    review(org, HAIKU, [[2, false], [2, false]]);
    // Eight tasks are kept in mind: the two that were sent back have passed out of them.
    review(org, HAIKU, Array.from({ length: RECENT_TASKS }, () => [1, true] as [number, boolean]));
    review(org, HAIKU, [[2, false], [2, false]]);
    expect(rungsOf(org)[0]!.upTo).toBe(2);
    expect(notes(org)).toEqual([]);
  });

  it('tries a model one level higher once its work at its highest level has kept standing', () => {
    const org = organisation();
    // Lighter tasks say nothing about the level above its highest.
    review(org, HAIKU, Array.from({ length: 8 }, () => [1, true] as [number, boolean]));
    expect(rungsOf(org)[0]!.upTo).toBe(2);
    review(org, HAIKU, Array.from({ length: TAKES_ON_AFTER }, () => [2, true] as [number, boolean]));
    expect(org.routing!.rungs[0]).toEqual({ model: HAIKU, upTo: 3, ceiling: null, recent: [] });
    expect(modelForTask(org, null, { effort: 3, rework: false })).toBe(HAIKU);
    expect(notes(org)).toEqual([`Tasks rated 3 now go to ${HAIKU}`]);
    expect(org.board.at(-1)!.body).toContain(`on tasks that went to ${SONNET}`);
    // Tried there and sent back, it gives the level up, and that is where it stays.
    review(org, HAIKU, [[3, false], [3, false], [3, false]]);
    expect(org.routing!.rungs[0]).toMatchObject({ upTo: 2, ceiling: 2 });
    review(org, HAIKU, Array.from({ length: 10 }, () => [2, true] as [number, boolean]));
    expect(rungsOf(org)[0]!.upTo).toBe(2);
  });

  it('keeps the rungs in order as they move, and leaves the top of the scale to the agents’ model', () => {
    const org = organisation({ workerLadder: [{ model: HAIKU, upTo: 4 }, { model: SONNET, upTo: 5 }] });
    // The lighter model takes the level the one above it had: that one is left with none of its own.
    review(org, HAIKU, Array.from({ length: 5 }, () => [4, true] as [number, boolean]));
    expect(org.routing!.rungs.map((rung) => rung.upTo)).toEqual([5, 5]);
    expect(levelsOf(rungsOf(org), 1)).toBeNull();
    expect(modelForTask(org, null, { effort: 5, rework: false })).toBe(HAIKU);
    // The upper model gives a level up, and the one below it does not reach past it.
    review(org, SONNET, [[5, false], [5, false], [5, false]]);
    expect(org.routing!.rungs.map((rung) => rung.upTo)).toEqual([4, 4]);
    expect(modelForTask(org, null, { effort: 5, rework: false })).toBe(OPUS);

    const top = organisation({ workerLadder: [{ model: HAIKU, upTo: 9 }] });
    review(top, HAIKU, Array.from({ length: 8 }, () => [9, true] as [number, boolean]));
    expect(rungsOf(top)[0]!.upTo).toBe(9);
    expect(modelForTask(top, null, { effort: 10, rework: false })).toBe(OPUS);
  });

  it('learns nothing when told not to follow results, or about the agents’ own model', () => {
    const fixed = organisation({ workerLadderLearns: false });
    review(fixed, HAIKU, [[2, false], [2, false], [2, false], [2, false]]);
    expect(rungsOf(fixed)).toEqual(LADDER);
    const org = organisation();
    review(org, OPUS, [[7, false], [7, false], [7, false]]);
    expect(org.routing!.rungs.map((rung) => rung.recent.length)).toEqual([0, 0]);
    expect(notes(org)).toEqual([]);
  });
});

describe('an organisation whose agents have a ladder of models', () => {
  const ONE_LEAD = [{ profileId: 'engineering', agentCount: 3 }];
  const tasksOf = (run: Harness) => run.org.plans.flatMap((plan) => plan.phases.flatMap((phase) => phase.tasks));
  const calls = (run: Harness): ActivityEntry[] => run.runner.activity.filter((entry) => entry.kind === 'task' && entry.ok);

  it('gives each task to the model for its rating, and spends less than on the agents’ model alone', async () => {
    // The simulated lead hands out three tasks a phase, rated 4, 3 and 2.
    h = await harness({ executives: ONE_LEAD, settings: { workerModel: OPUS, workerLadder: [{ model: HAIKU, upTo: 2 }, { model: SONNET, upTo: 3 }] } });
    await runToRest(h.runner);
    expect(h.org.lastError).toBeNull();
    const byRating = new Map<number, Set<string>>();
    for (const entry of calls(h)) byRating.set(entry.effort!, (byRating.get(entry.effort!) ?? new Set()).add(entry.model));
    expect([...byRating].sort(([a], [b]) => a - b).map(([level, models]) => [level, [...models]])).toEqual([[2, [HAIKU]], [3, [SONNET]], [4, [OPUS]]]);
    // What each task was given to is on the task, and every one was let stand.
    expect(tasksOf(h).map((t) => [t.effort, t.model, t.judged])).toEqual(tasksOf(h).map((t) => [t.effort, { 2: HAIKU, 3: SONNET, 4: OPUS }[t.effort!], 'accepted']));
    const laddered = calls(h).reduce((sum, entry) => sum + entry.costUsd, 0);
    await h.cleanup();

    h = await harness({ executives: ONE_LEAD, settings: { workerModel: OPUS } });
    await runToRest(h.runner);
    expect(new Set(calls(h).map((entry) => entry.model))).toEqual(new Set([OPUS]));
    const plain = calls(h).reduce((sum, entry) => sum + entry.costUsd, 0);
    expect(laddered).toBeLessThan(plain * 0.7);
  });

  it('has work that a lead sends back done again one model up, and counts it against the model that fell short', async () => {
    // Tasks rated 3 and 2 go to the lighter model. The simulated lead sends one phase back, naming its lightest task.
    h = await harness({ executives: ONE_LEAD, settings: { workerModel: OPUS, workerLadder: [{ model: HAIKU, upTo: 3 }] }, mock: { rework: 'once' } });
    await runToRest(h.runner);
    expect(h.org.lastError).toBeNull();
    const rework = tasksOf(h).filter((t) => t.rework);
    expect(rework).toHaveLength(1);
    const redone = tasksOf(h).find((t) => t.id === rework[0]!.redoes)!;
    expect([redone.effort, redone.model, redone.judged]).toEqual([2, HAIKU, 'sent_back']);
    // Rated 3, which the lighter model takes, but it is putting that model's work right.
    expect([rework[0]!.effort, rework[0]!.model, rework[0]!.judged]).toEqual([3, OPUS, 'accepted']);
    // The other tasks of that review stood.
    expect(tasksOf(h).filter((t) => t.judged === 'sent_back')).toHaveLength(1);
    expect(h.org.routing!.rungs[0]!.recent.filter((result) => !result.ok)).toEqual([{ level: 2, ok: false }]);
  });

  it('forecasts a task that has not started on the model it will be given to', () => {
    const org = organisation();
    const entry = (model: string, effort: number, minutes: number): ActivityEntry => ({ id: 'a', at: new Date(Date.parse('2026-11-08T12:00:00Z')).toISOString(), kind: 'task', execId: 'cto', label: 'x', model, ms: minutes * 60_000, ok: true, error: null, inputTokens: 0, outputTokens: 0, costUsd: minutes / 10, effort });
    const activity = [...[1, 1, 1].map(() => entry(HAIKU, 2, 1)), ...[1, 1, 1].map(() => entry(OPUS, 2, 9)), ...[1, 1, 1].map(() => entry(OPUS, 6, 20))];
    const phase = phaseOf([task({ status: 'pending', effort: 2, agent: null }), task({ status: 'pending', effort: 6, agent: null })]);
    org.plans.push({ id: 'p1', ownerId: 'cto', status: 'executing', phases: [phase] } as unknown as Organisation['plans'][number]);
    const bars = forecast(org, activity, Date.parse('2026-11-08T13:00:00Z'));
    // A minute on the lighter model, where the agents' own model takes nine at that level.
    expect(bars.map((bar) => [bar.effort, Math.round((bar.end - bar.start) / 60_000)])).toEqual([[2, 1], [6, 20]]);
  });

  it('refuses a ladder that names a model no connected key can call', async () => {
    // A provider that says which models it can call, as the one that holds the keys does. The simulator takes any.
    class Keyed extends MockProvider {
      knows(model: string): boolean {
        return [HAIKU, SONNET, OPUS].includes(model);
      }
    }
    h = await harness({ executives: ONE_LEAD, provider: new Keyed(QUIET), settings: { executiveModel: OPUS, workerModel: OPUS } });
    expect(() => h!.runner.updateSettings({ workerLadder: [{ model: 'nobody:no-such-model', upTo: 2 }] })).toThrow(/agents' lighter tasks.*not one a connected key can call/);
    expect(h.org.settings.workerLadder).toEqual([]);
    h.runner.updateSettings({ workerLadder: [{ model: HAIKU, upTo: 2 }] });
    expect(h.org.routing!.rungs).toEqual([{ model: HAIKU, upTo: 2, ceiling: null, recent: [] }]);
    await expect(h.registry.create({ name: 'Other', idea: 'Another idea.', executives: ONE_LEAD, settings: { executiveModel: OPUS, workerModel: OPUS, workerLadder: [{ model: 'nobody:no-such-model', upTo: 2 }] } })).rejects.toThrow(/agents’ lighter tasks, "nobody:no-such-model", is not one a connected key can call/);
  });
});
