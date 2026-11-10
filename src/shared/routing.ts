import type { LadderRung, Organisation, PlanPhase, Task } from './types';

// Which model an agent's task goes to. Leads rate every task on the effort scale, and most tasks are small: a
// ladder puts cheaper models under the agents' model, each taking tasks up to a level. The rest of the engine
// only ever asks one question of this file: which model for this task?

/** How many cheaper models can sit below the agents' model. */
export const MAX_LADDER = 3;
/** The highest level a rung below the top may take. The top of the scale stays with the agents' model. */
export const MAX_RUNG_LEVEL = 9;

type Routed = Pick<Organisation, 'settings' | 'routing'>;

/**
 * The rungs in force, lightest first: where results have moved them, if the ladder follows results and what was
 * learned is for this ladder, and otherwise as the settings give them.
 */
export function rungsOf(org: Routed): LadderRung[] {
  const set = org.settings.workerLadder ?? [];
  if (!set.length) return [];
  const learned = org.routing?.rungs;
  const same = !!learned && learned.length === set.length && learned.every((rung, i) => rung.model === set[i]!.model);
  return org.settings.workerLadderLearns && same ? learned.map(({ model, upTo }) => ({ model, upTo })) : set;
}

/** Every model an agent's task can go to, lightest first, ending with the agents' model. */
export function agentModels(org: Routed): string[] {
  return [...rungsOf(org).map((rung) => rung.model), org.settings.workerModel];
}

/** The rung a level falls on: its place among the rungs, or their number for the agents' model above them all. */
export function rungIndex(rungs: LadderRung[], level: number | null): number {
  // Work nobody rated could be any size, so it goes to the top.
  if (level === null) return rungs.length;
  const index = rungs.findIndex((rung) => level <= rung.upTo);
  return index < 0 ? rungs.length : index;
}

/**
 * The model a task goes to. By its rating, except that work being put right goes higher: one model above the
 * one whose work it puts right, where the lead named the task, and otherwise one above where its own rating
 * would have put it. `phase` is where the task whose work it puts right is looked for.
 */
export function modelForTask(org: Routed, phase: Pick<PlanPhase, 'tasks'> | null, task: Pick<Task, 'effort' | 'rework' | 'redoes'>): string {
  const rungs = rungsOf(org);
  const models = [...rungs.map((rung) => rung.model), org.settings.workerModel];
  if (!rungs.length) return models[0]!;
  let index = rungIndex(rungs, task.effort);
  if (task.rework) {
    const redone = task.redoes ? phase?.tasks.find((other) => other.id === task.redoes) : undefined;
    const was = redone?.model ? models.indexOf(redone.model) : -1;
    index = was >= 0 ? Math.max(index, was + 1) : index + 1;
  }
  return models[Math.min(index, rungs.length)]!;
}

/** The levels a rung takes, as the two ends of a range, or null if it takes none. */
export function levelsOf(rungs: LadderRung[], index: number): { from: number; to: number } | null {
  const from = Math.max(0, ...rungs.slice(0, index).map((rung) => rung.upTo)) + 1;
  const to = index < rungs.length ? rungs[index]!.upTo : 10;
  return to >= from ? { from, to } : null;
}
