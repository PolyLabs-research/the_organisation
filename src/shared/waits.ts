import type { Organisation, PhaseWait, Plan } from './types';

/**
 * Ordering between plans within a cycle. A lead can say that a phase of its plan needs something another
 * lead is producing this cycle; the phase then does not start until that phase is finished. Work here
 * takes minutes, so this, not a calendar date, is how one lead's work follows another's.
 */

/** How many other plans' phases one phase may wait on. */
export const MAX_WAITS_PER_PHASE = 3;

const live = (plan: Plan) => plan.status !== 'done' && plan.status !== 'cancelled' && plan.status !== 'failed';
const matchPhase = (plan: Plan, name: string) => {
  const wanted = name.trim().toLowerCase();
  return plan.phases.findIndex((p) => p.name.toLowerCase() === wanted || p.sopPhaseId.toLowerCase() === wanted);
};

/** The waits a lead named for a phase, kept to other leads on the board, without repeats and at most a few. */
export function namedWaits(org: Organisation, ownerId: string, given: ReadonlyArray<{ lead: string; phase: string }> | undefined): PhaseWait[] {
  const leads = new Set(org.executives.filter((e) => e.kind === 'lead').map((e) => e.id));
  const out: PhaseWait[] = [];
  for (const w of given ?? []) {
    const phase = (w.phase ?? '').trim().slice(0, 80);
    if (!leads.has(w.lead) || w.lead === ownerId || !phase) continue;
    if (out.some((o) => o.leadId === w.lead && o.phase.toLowerCase() === phase.toLowerCase())) continue;
    out.push({ leadId: w.lead, phase, planId: null, phaseIndex: null, released: null });
    if (out.length >= MAX_WAITS_PER_PHASE) break;
  }
  return out;
}

/**
 * Pin each wait of a plan that is starting to the plan it waits on: the other lead's plan this cycle that has
 * the phase named, or failing that their first plan under way, waited on as a whole. With no plan to wait on,
 * the wait is let go.
 */
export function pinWaits(org: Organisation, plan: Plan): void {
  for (const phase of plan.phases) {
    for (const wait of phase.waitsFor) {
      if (wait.planId || wait.released) continue;
      const theirs = org.plans.filter((p) => p.cycle === plan.cycle && p.ownerId === wait.leadId && p.id !== plan.id && live(p));
      const target = theirs.find((p) => matchPhase(p, wait.phase) >= 0) ?? theirs[0];
      if (!target) {
        wait.released = 'That lead had no plan under way to wait on.';
        continue;
      }
      wait.planId = target.id;
      const index = matchPhase(target, wait.phase);
      wait.phaseIndex = index >= 0 ? index : null;
      // The plan waited on may not have settled which phases it runs: one that is contested is revised after this,
      // and a revision can drop a phase or bring one back. So the phase is kept by what it is, not by where it stood.
      wait.phaseId = index >= 0 ? target.phases[index]!.sopPhaseId : null;
    }
  }
}

/**
 * Where in the plan it waits on a wait points now: the phase's place among that plan's phases, null for the whole
 * plan, or 'gone' when the plan has been reshaped and no longer runs that phase.
 */
export function waitedIndex(target: Plan, wait: PhaseWait): number | null | 'gone' {
  // A wait pinned before phases were kept by id has only the place the phase stood in.
  if (!wait.phaseId) return wait.phaseIndex;
  const index = target.phases.findIndex((p) => p.sopPhaseId === wait.phaseId);
  return index >= 0 ? index : 'gone';
}

/** True when a wait no longer holds anything up: what it waited on is finished, or can no longer be. */
export function waitMet(org: Organisation, wait: PhaseWait): boolean {
  if (wait.released || !wait.planId) return true;
  const target = org.plans.find((p) => p.id === wait.planId);
  if (!target || !live(target)) return true;
  const at = waitedIndex(target, wait);
  // A phase the plan no longer runs will never finish, so there is nothing left to wait for.
  if (at === 'gone') return true;
  if (at === null) return false;
  return (target.phases[at]?.status ?? 'done') === 'done';
}

/**
 * The waits holding a plan up right now: those on its next phase, before that phase starts. A plan carried
 * out in a hosted session runs every phase in one go, so before it starts it waits on everything it named.
 */
export function heldBy(org: Organisation, plan: Plan): PhaseWait[] {
  if (plan.status !== 'executing') return [];
  if (plan.execution === 'managed') return plan.managed ? [] : plan.phases.flatMap((p) => p.waitsFor ?? []).filter((w) => !waitMet(org, w));
  const phase = plan.phases.find((p) => p.status !== 'done');
  if (!phase || phase.status !== 'pending') return [];
  return (phase.waitsFor ?? []).filter((w) => !waitMet(org, w));
}

/**
 * Plans that wait on each other in a ring can never start. Let go of one plan's waits on the ring, which is
 * enough to set the ring moving; call again for any other ring. Returns the plan let go, or null.
 */
export function breakWaitRing(org: Organisation): Plan | null {
  const edges = new Map<string, string[]>();
  for (const plan of org.plans) {
    const held = heldBy(org, plan);
    if (held.length) edges.set(plan.id, held.map((w) => w.planId!));
  }
  if (!edges.size) return null;
  // A held plan gets moving once everything it waits on is moving. What is left when nothing more moves is stuck.
  const moving = new Set<string>();
  for (let changed = true; changed; ) {
    changed = false;
    for (const [id, targets] of edges) {
      if (!moving.has(id) && targets.every((t) => !edges.has(t) || moving.has(t))) {
        moving.add(id);
        changed = true;
      }
    }
  }
  const stuck = [...edges.keys()].filter((id) => !moving.has(id));
  const reaches = (from: string, to: string): boolean => {
    const seen = new Set<string>();
    const stack = [...(edges.get(from) ?? [])];
    while (stack.length) {
      const id = stack.pop()!;
      if (id === to) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...(edges.get(id) ?? []));
    }
    return false;
  };
  const id = stuck.find((s) => reaches(s, s));
  if (!id) return null;
  const plan = org.plans.find((p) => p.id === id)!;
  for (const wait of heldBy(org, plan)) {
    if (stuck.includes(wait.planId!)) wait.released = 'Plans were waiting on each other, so none could start.';
  }
  return plan;
}

/** One line on what a wait is for, such as "CTO: Spec". */
export function describeWait(org: Organisation, wait: PhaseWait): string {
  const lead = org.executives.find((e) => e.id === wait.leadId)?.short ?? wait.leadId;
  const target = wait.planId ? org.plans.find((p) => p.id === wait.planId) : undefined;
  const at = target ? waitedIndex(target, wait) : null;
  const phase = target && typeof at === 'number' ? target.phases[at]?.name ?? wait.phase : target && at === null ? 'their whole plan' : wait.phase;
  return `${lead}: ${phase}`;
}
