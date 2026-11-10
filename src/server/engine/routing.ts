import { levelsOf } from '../../shared/routing';
import type { Executive, Organisation, PlanPhase, RungRecord, Task } from '../../shared/types';
import { postToBoard } from './state';

// What the ladder of agent models learns from the leads' reviews. A lead reads its agents' work at each phase
// gate and either lets it stand or sends it back. That verdict, task by task, is the only thing here that says
// whether a model was up to the level of work it was given.

/** How many of a rung's most recent tasks are kept in mind. */
export const RECENT_TASKS = 8;
/** A rung gives up its highest level when this many of those were sent back or failed. */
export const GIVES_UP_AT = 3;
/** A rung is tried one level higher when this many tasks at its highest level have stood, with nothing sent back. */
export const TAKES_ON_AFTER = 5;

/**
 * Settle what the lead's review made of each task it has just read: the ones not yet judged. `sentBack` names the
 * tasks whose work the lead is having put right, or is 'all' when the phase was stopped by the system's own
 * checks and nobody said whose work was at fault. A failed task was not up to its level whatever the lead says.
 */
export function judgeRound(org: Organisation, lead: Executive, phase: PlanPhase, sentBack: ReadonlySet<string> | 'all'): void {
  for (const task of phase.tasks) {
    if (task.judged || (task.status !== 'done' && task.status !== 'failed')) continue;
    task.judged = task.status === 'failed' ? 'failed' : sentBack === 'all' || sentBack.has(task.id) ? 'sent_back' : 'accepted';
    learn(org, lead, task, task.judged === 'accepted');
  }
}

/** Take one task's result into account for the rung it ran on, and move the rung's level if its record now calls for it. */
function learn(org: Organisation, lead: Executive, task: Task, ok: boolean): void {
  const rungs = org.routing?.rungs;
  if (!rungs || !org.settings.workerLadderLearns || !task.model || task.effort === null) return;
  const index = rungs.findIndex((rung) => rung.model === task.model);
  // The agents' own model is the top: there is nowhere higher to send its work, so nothing to learn.
  if (index < 0) return;
  const rung = rungs[index]!;
  rung.recent.push({ level: task.effort, ok });
  if (rung.recent.length > RECENT_TASKS) rung.recent.splice(0, rung.recent.length - RECENT_TASKS);

  const bad = rung.recent.filter((result) => !result.ok).length;
  if (bad >= GIVES_UP_AT && rung.upTo >= 1) return giveUp(org, lead, rungs, index, bad);
  const held = rung.recent.filter((result) => result.level === rung.upTo).length;
  if (bad === 0 && held >= TAKES_ON_AFTER) takeOn(org, lead, rungs, index, held);
}

/** A rung whose work keeps being sent back stops taking its highest level, and is not tried above the new one again. */
function giveUp(org: Organisation, lead: Executive, rungs: RungRecord[], index: number, bad: number): void {
  const rung = rungs[index]!;
  const lost = rung.upTo;
  const judged = rung.recent.length;
  rung.upTo -= 1;
  rung.ceiling = rung.upTo;
  rung.recent = [];
  // The rungs stay in order: none below reaches higher than this one now does.
  for (const lower of rungs.slice(0, index)) lower.upTo = Math.min(lower.upTo, rung.upTo);
  const next = rungs.slice(index + 1).find((higher) => higher.upTo >= lost)?.model ?? org.settings.workerModel;
  postToBoard(
    org,
    'system',
    'system',
    `Tasks rated ${lost} no longer go to ${rung.model}`,
    `Of the last ${judged} tasks ${rung.model} did for the leads, ${bad} were sent back or failed, the latest of them for the ${lead.short}. It now takes ${describeLevels(rungs, index)}, and tasks rated ${lost} go to ${next}. It will not be tried at that level again unless the ladder is changed in settings.`,
  );
}

/** A rung whose work at its highest level keeps standing is tried one level higher, unless it has given that level up before. */
function takeOn(org: Organisation, lead: Executive, rungs: RungRecord[], index: number, held: number): void {
  const rung = rungs[index]!;
  const next = rung.upTo + 1;
  // The top of the scale stays with the agents' model, and a level once given up is not taken again.
  if (next > 9 || (rung.ceiling !== null && next > rung.ceiling)) return;
  const from = rungs.slice(index + 1).find((higher) => higher.upTo >= next)?.model ?? org.settings.workerModel;
  rung.upTo = next;
  rung.recent = [];
  for (const higher of rungs.slice(index + 1)) higher.upTo = Math.max(higher.upTo, rung.upTo);
  postToBoard(
    org,
    'system',
    'system',
    `Tasks rated ${next} now go to ${rung.model}`,
    `The last ${held} tasks rated ${next - 1} that ${rung.model} did were all let stand by the leads, the latest by the ${lead.short}, with nothing of its sent back in between. It is now tried one level higher, on tasks that went to ${from}: it takes ${describeLevels(rungs, index)}. If its work there is sent back, it gives the level up again.`,
  );
}

function describeLevels(rungs: RungRecord[], index: number): string {
  const levels = levelsOf(rungs, index);
  if (!levels) return 'no tasks';
  return levels.from === levels.to ? `tasks rated ${levels.from}` : `tasks rated ${levels.from} to ${levels.to}`;
}
