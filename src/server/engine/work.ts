import { waitsOnAi } from '../../shared/signatory';
import type { Decision, Organisation, Plan, ReviewRound } from '../../shared/types';
import { breakWaitRing, describeWait, heldBy, pinWaits } from '../../shared/waits';
import { signatoryOf } from './signatory';
import { ceoOf, arbiterOf, currentPhase, execById, followUpsLeft, isPlanActive, leadsOf, nextId, planById, postToBoard } from './state';

/**
 * One unit of work the organisation can do next. Each maps to a single model
 * call (or one agent run, for `task`). `key` identifies the unit so the same
 * work is never started twice.
 */
export type WorkItem =
  | { kind: 'steer_review'; key: string; execId: string; steerIds: string[] }
  | { kind: 'consult'; key: string; execId: string }
  | { kind: 'direct'; key: string; execId: string }
  | { kind: 'plan'; key: string; execId: string; planId: string }
  | { kind: 'review'; key: string; execId: string; roundId: string }
  | { kind: 'answer'; key: string; execId: string; decisionId: string }
  | { kind: 'position'; key: string; execId: string; decisionId: string }
  | { kind: 'signoff'; key: string; execId: string; decisionId: string }
  | { kind: 'revise'; key: string; execId: string; planId: string }
  | { kind: 'kickoff'; key: string; execId: string; planId: string; phaseIndex: number }
  | { kind: 'task'; key: string; execId: string; planId: string; phaseIndex: number; taskId: string }
  | { kind: 'phase_review'; key: string; execId: string; planId: string; phaseIndex: number }
  | { kind: 'report'; key: string; execId: string; planId: string }
  | { kind: 'react'; key: string; execId: string; reportIds: string[] }
  /** An AI signatory deciding whether a payment or a signature a lead asked for is authorised. */
  | { kind: 'authorise'; key: string; execId: string; requestId: string }
  /** Carry a whole plan through in a hosted session: every phase, and the report to the board. */
  | { kind: 'execute'; key: string; execId: string; planId: string };

function openRound(org: Organisation, drafted: Plan[]): ReviewRound {
  const round: ReviewRound = {
    id: nextId(org, 'r'),
    cycle: org.cycle.number,
    planIds: drafted.map((p) => p.id),
    // A lead reviews the batch only if it holds a plan that is not their own.
    reviewerIds: leadsOf(org)
      .filter((lead) => drafted.some((p) => p.ownerId !== lead.id))
      .map((lead) => lead.id),
    reviews: {},
    status: 'open',
  };
  for (const plan of drafted) plan.status = 'in_review';
  org.reviewRounds.push(round);
  return round;
}

/** Every review is in: clear the plans nobody contests and open a board decision on the rest. */
function closeRound(org: Organisation, round: ReviewRound): void {
  round.status = 'closed';
  const objections = Object.values(round.reviews).flat();
  for (const planId of round.planIds) {
    const plan = planById(org, planId);
    if (!plan || plan.status !== 'in_review') continue;
    const owner = execById(org, plan.ownerId);
    const who = owner?.short ?? plan.ownerId;
    const issues = [
      ...objections.filter((o) => o.planId === planId).map((o) => ({ byId: o.byId, concern: o.concern, proposal: o.proposal })),
      ...plan.escalations.map((e) => ({ byId: plan.ownerId, concern: e.issue, proposal: e.proposal })),
    ];
    plan.updatedAt = new Date().toISOString();
    if (!issues.length) {
      plan.status = 'approved';
      postToBoard(org, 'review', plan.ownerId, `${who} plan cleared`, `No lead objected, so this stays in the ${who}'s remit: ${plan.objective}`, {
        planId: plan.id,
      });
      continue;
    }
    const decision: Decision = {
      id: nextId(org, 'd'),
      cycle: org.cycle.number,
      at: new Date().toISOString(),
      kind: 'contested',
      title: `Competing priorities on the ${who} plan`,
      context: plan.objective,
      raisedById: issues[0]!.byId,
      planId: plan.id,
      issues,
      participantIds: leadsOf(org).map((lead) => lead.id),
      positions: {},
      status: 'open',
      outcome: null,
    };
    // When only other leads object, the owner answers first: most objections are accepted, and then the board need not sit.
    // What the owner raised itself is for the board to settle.
    if (!plan.escalations.length) decision.status = 'answering';
    org.decisions.push(decision);
    plan.status = 'contested';
    plan.decisionId = decision.id;
    const lines = issues.map((issue) => {
      const by = execById(org, issue.byId)?.short ?? issue.byId;
      return `- **${by}:** ${issue.concern} Proposes: ${issue.proposal}`;
    });
    postToBoard(
      org,
      'decision',
      decision.raisedById,
      decision.status === 'answering' ? `Objections to the ${who} plan` : `Board decision opened: ${decision.title}`,
      decision.status === 'answering'
        ? `Plan: ${plan.objective}\n\n${lines.join('\n')}\n\nThe ${who} answers first. If the ${who} accepts, the plan is revised; if not, the board states positions and the ${arbiterOf(org).short} signs off.`
        : `Plan: ${plan.objective}\n\n${lines.join('\n')}\n\nThe board will state positions; the ${arbiterOf(org).short} signs off.`,
      { planId: plan.id, decisionId: decision.id },
    );
  }
}

/**
 * Apply every transition that needs no model call: gather finished steps into
 * the next stage. Returns true if anything changed.
 */
export function settle(org: Organisation): boolean {
  let changed = false;
  for (let guard = 0; guard < 100; guard++) {
    let stepped = false;

    if (org.cycle.stage === 'consult' && leadsOf(org).every((lead) => org.cycle.consults[lead.id])) {
      org.cycle.stage = 'direct';
      stepped = true;
    }

    // Plans are reviewed in batches, so wait until nobody is still drafting.
    const drafted = org.plans.filter((p) => p.status === 'drafted');
    if (drafted.length && !org.plans.some((p) => p.status === 'planning')) {
      openRound(org, drafted);
      stepped = true;
    }

    for (const round of org.reviewRounds) {
      if (round.status === 'open' && round.reviewerIds.every((id) => round.reviews[id])) {
        closeRound(org, round);
        stepped = true;
      }
    }

    for (const decision of org.decisions) {
      if (decision.status === 'open' && decision.participantIds.every((id) => decision.positions[id])) {
        decision.status = 'deliberated';
        stepped = true;
      }
    }

    // A lead that has started all the follow-ups it may this cycle has nothing left to decide
    // about further reports. They stay on the board for the CEO's next cycle.
    for (const lead of leadsOf(org)) {
      if ((org.inbox[lead.id]?.length ?? 0) > 0 && followUpsLeft(org, lead.id) === 0) {
        org.inbox[lead.id] = [];
        stepped = true;
      }
    }

    for (const plan of org.plans) {
      if (plan.status === 'approved') {
        plan.status = 'executing';
        // How a plan is carried out is settled when it starts and does not change under it.
        // A plan with gates to check stays here: a hosted session cannot reach the repository to be checked.
        plan.execution ??= plan.phases.some((phase) => phase.gate) ? 'local' : org.settings.execution;
        // What the plan waits on in other leads' plans is fixed now, so later plans of theirs cannot hold it up.
        pinWaits(org, plan);
        stepped = true;
      } else if (plan.status === 'executing' && plan.execution !== 'managed' && plan.phases.every((phase) => phase.status === 'done')) {
        // A plan in a hosted session reports from inside the session; this is for plans run here.
        plan.status = 'reporting';
        stepped = true;
      }
    }

    const ring = breakWaitRing(org);
    if (ring) {
      const owner = execById(org, ring.ownerId)?.short ?? ring.ownerId;
      const released = ring.phases.flatMap((p) => p.waitsFor).filter((w) => w.released?.startsWith('Plans were waiting'));
      postToBoard(
        org,
        'system',
        'system',
        `${owner} plan no longer waits`,
        `The ${owner} plan and the plans it was waiting on were each waiting on the other, so none could start. The ${owner} plan carries on without waiting for ${released.map((w) => describeWait(org, w)).join(', ')}.`,
        { planId: ring.id },
      );
      stepped = true;
    }

    if (!stepped) break;
    changed = true;
  }
  return changed;
}

/** Everything that could be started right now, most urgent first. The runner decides how much of it fits. */
export function nextWork(org: Organisation): WorkItem[] {
  const items: WorkItem[] = [];
  const ceo = ceoOf(org);

  // New steer reaches work in progress through the CEO. Before any work is
  // under way the CEO simply reads it when setting direction.
  const newSteers = org.steers.filter((s) => s.status === 'new');
  if (newSteers.length && org.cycle.stage === 'work') {
    items.push({ kind: 'steer_review', key: 'steer_review', execId: ceo.id, steerIds: newSteers.map((s) => s.id) });
  }

  for (const decision of org.decisions) {
    const owner = decision.planId ? planById(org, decision.planId)?.ownerId : undefined;
    if (decision.status === 'answering' && owner) {
      items.push({ kind: 'answer', key: `answer:${decision.id}`, execId: owner, decisionId: decision.id });
    } else if (decision.status === 'deliberated') {
      items.push({ kind: 'signoff', key: `signoff:${decision.id}`, execId: arbiterOf(org).id, decisionId: decision.id });
    } else if (decision.status === 'open') {
      for (const id of decision.participantIds) {
        if (!decision.positions[id]) items.push({ kind: 'position', key: `position:${decision.id}:${id}`, execId: id, decisionId: decision.id });
      }
    }
  }

  if (org.cycle.stage === 'consult') {
    for (const lead of leadsOf(org)) {
      if (!org.cycle.consults[lead.id]) items.push({ kind: 'consult', key: `consult:${org.cycle.number}:${lead.id}`, execId: lead.id });
    }
  } else if (org.cycle.stage === 'direct') {
    items.push({ kind: 'direct', key: `direct:${org.cycle.number}`, execId: ceo.id });
  }

  // With an AI in the signatory's seat, each request waits for its ruling. With a person there, requests wait
  // for the person and the organisation gets on with its work.
  for (const request of org.signatory.requests) {
    if (waitsOnAi(request, org.settings.signatory)) {
      items.push({ kind: 'authorise', key: `authorise:${request.id}`, execId: signatoryOf(org).id, requestId: request.id });
    }
  }

  for (const round of org.reviewRounds) {
    if (round.status !== 'open') continue;
    for (const id of round.reviewerIds) {
      if (!round.reviews[id]) items.push({ kind: 'review', key: `review:${round.id}:${id}`, execId: id, roundId: round.id });
    }
  }

  for (const plan of org.plans) {
    const base = { execId: plan.ownerId, planId: plan.id };
    if (plan.status === 'planning') items.push({ kind: 'plan', key: `plan:${plan.id}`, ...base });
    else if (plan.status === 'revising') items.push({ kind: 'revise', key: `revise:${plan.id}`, ...base });
    else if (plan.status === 'reporting') items.push({ kind: 'report', key: `report:${plan.id}`, ...base });
    // A plan waiting on another lead's work starts nothing new until that work is finished.
    else if (plan.status === 'executing' && heldBy(org, plan).length) continue;
    else if (plan.status === 'executing' && plan.execution === 'managed') {
      items.push({ kind: 'execute', key: `execute:${plan.id}`, ...base });
    } else if (plan.status === 'executing') {
      const current = currentPhase(plan);
      if (!current) continue;
      const { phase, index } = current;
      if (phase.status === 'pending') {
        items.push({ kind: 'kickoff', key: `kickoff:${plan.id}:${index}`, ...base, phaseIndex: index });
      } else if (phase.tasks.every((t) => t.status === 'done' || t.status === 'failed')) {
        items.push({ kind: 'phase_review', key: `phase_review:${plan.id}:${index}:${phase.reworkRounds}`, ...base, phaseIndex: index });
      } else {
        for (const task of phase.tasks) {
          if (task.status === 'pending') {
            items.push({ kind: 'task', key: `task:${task.id}`, ...base, phaseIndex: index, taskId: task.id });
          }
        }
      }
    }
  }

  // A lead turns to the board's reports once their own plan is off their desk,
  // so reports that arrive meanwhile are read together.
  for (const lead of leadsOf(org)) {
    const reportIds = org.inbox[lead.id] ?? [];
    const busy = org.plans.some((p) => p.ownerId === lead.id && isPlanActive(p));
    if (reportIds.length && !busy) items.push({ kind: 'react', key: `react:${lead.id}`, execId: lead.id, reportIds: [...reportIds] });
  }

  return items;
}

/** True when every job of the current cycle is finished and the CEO should ask what comes next. */
export function cycleComplete(org: Organisation): boolean {
  if (org.cycle.stage !== 'work') return false;
  if (org.plans.some(isPlanActive)) return false;
  if (org.decisions.some((d) => d.status !== 'resolved')) return false;
  if (org.reviewRounds.some((r) => r.status === 'open')) return false;
  return Object.values(org.inbox).every((ids) => ids.length === 0);
}
