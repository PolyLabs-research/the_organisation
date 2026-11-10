import type { z } from 'zod';
import type { BusinessAccess } from '../access';
import { accessTools } from '../access-tools';
import { codeTools } from '../access-code-tools';
import { STANDARD_APPROACH, WORK_APPROACHES, approachChoices, approachLabel } from '../../shared/approaches';
import { jobReady } from '../../shared/business';
import { applyBusinessCommand, applyBusinessUpdates, businessContext, businessTools, linkBusinessJob } from './business';
import { allows } from '../../shared/privileges';
import { describeRequest, isOpen } from '../../shared/signatory';
import { namedWaits } from '../../shared/waits';
import { clampEffort } from '../../shared/effort';
import type { BoardReport, Executive, Organisation, Plan, PlanOrigin, PlanPhase, SopPhase, Task } from '../../shared/types';
import { ProviderError, type CallUsage, type Provider, type SystemPrompt } from '../providers/types';
import { Workspace, workspaceTools } from '../workspace';
import { AGENT_BRANCHES } from '../access';
import { gateEvidence, type CheckTimes } from './evidence';
import { closeOpenWork, executeInSession } from './hosted';
import * as prompts from './prompts';
import { judgeRound } from './routing';
import { MAX_RESULT_CHARS, bullets, clean, fileReport, logRemitDecisions, newTask, now } from './records';
import * as schemas from './schemas';
import { raiseRequests, ruleOnRequest, withdrawRequests } from './signatory';
import { arbiterOf, execById, followUpsLeft, isPlanActive, leadsOf, nextId, planById, postToBoard, teamDir } from './state';
import type { WorkItem } from './work';

export interface EngineContext {
  org: Organisation;
  access: BusinessAccess;
  provider: Provider;
  workspace: Workspace;
  signal: AbortSignal;
  /** True when work in flight is to be abandoned at once: the organisation was told to stop. */
  halting(): boolean;
  /** True when the budget is spent: agents finish what they are on and say what is left. */
  overBudget(): boolean;
  recordUsage(execId: string, usage: CallUsage): void;
  /** Add what a hosted session has spent since it was last heard from. */
  recordSpend(execId: string, model: string, delta: Omit<CallUsage, 'model'>): void;
  /** The organisation changed while this work is still in flight: tell whoever is watching, and save. */
  touch(): void;
  /** Where a provider may keep its own records for this organisation. */
  stateDir: string;
  checkTimes: CheckTimes;
}

/** Applies the result of finished work to the organisation. Runs synchronously, after the model call has returned. */
export type Commit = () => void;

const MAX_TASK_TURNS = 24;
const MAX_TASK_SEARCHES = 8;
const MAX_REWORK_ROUNDS = 1;
/** A phase held to what the checks say gets more goes: seeing a build fail and fixing it is the work. */
const MAX_GATED_REWORK_ROUNDS = 3;
const MAX_FOLLOW_UPS = 1;

function need<T>(value: T | undefined, what: string): T {
  if (value === undefined || value === null) throw new StaleWork(what);
  return value;
}

/** The state this work was for has gone (plan cancelled, cycle moved on). The result is dropped without fuss. */
export class StaleWork extends Error {}

function planPhases(phases: SopPhase[]): PlanPhase[] {
  return phases.map((p) => ({
    sopPhaseId: p.id,
    name: p.name,
    purpose: p.purpose,
    deliverable: p.deliverable,
    intent: p.purpose,
    notes: '',
    status: 'pending',
    tasks: [],
    reworkRounds: 0,
    summary: null,
    gate: p.gate ?? null,
    evidence: null,
    waitsFor: [],
    effort: null,
  }));
}

/** Each organisation's plans have their own branch, so that several can share a repository. */
export function planBranch(org: Organisation, plan: Plan): string {
  return `${AGENT_BRANCHES}${org.id.replace(/[^A-Za-z0-9._-]/g, '-')}/${plan.id}`;
}

/** A plan that cannot go on: a gate says it has not done what it had to, and no more goes are left. */
function failPlan(org: Organisation, plan: Plan, reason: string): void {
  plan.status = 'failed';
  plan.cancelReason = clean(reason, 600);
  plan.updatedAt = now();
  withdrawRequests(org, plan, plan.cancelReason);
}

function newPlan(
  org: Organisation,
  owner: Executive,
  fields: { objective: string; successCriteria: string; priority: Plan['priority']; rationale: string; jobId?: string },
  origin: PlanOrigin,
  depth: number,
): Plan {
  const at = now();
  const plan: Plan = {
    id: nextId(org, 'p'),
    cycle: org.cycle.number,
    ownerId: owner.id,
    origin,
    depth,
    objective: clean(fields.objective, 1200),
    successCriteria: clean(fields.successCriteria, 1200),
    priority: fields.priority,
    rationale: clean(fields.rationale, 2000),
    approach: null,
    workApproachId: STANDARD_APPROACH,
    workApproachReason: null,
    // The plan starts as the lead's standard operating profile applied to this objective. Drafting it may choose another.
    phases: planPhases(owner.phases),
    skipped: [],
    effort: null,
    status: 'planning',
    amendments: [],
    escalations: [],
    decisionId: null,
    reportId: null,
    cancelReason: null,
    createdAt: at,
    updatedAt: at,
    execution: null,
    managed: null,
    code: null,
  };
  const known = fields.jobId || org.business.jobs.find((j) => j.ownerId === owner.id && j.title === plan.objective.slice(0, 200) && jobReady(org, j))?.id;
  const job = known ? org.business.jobs.find((j) => j.id === known) : applyBusinessCommand(org, {
    kind: 'job', record: { ownerId: owner.id, title: plan.objective.slice(0, 200), description: plan.successCriteria, nextAction: 'Carry out the approved plan and submit evidence for verification.' },
  }, { id: owner.id });
  if (job) linkBusinessJob(org, job.id, plan);
  org.plans.push(plan);
  return plan;
}

export function cancelPlan(org: Organisation, plan: Plan, reason: string, byId: string): void {
  plan.status = 'cancelled';
  plan.cancelReason = clean(reason, 600);
  plan.updatedAt = now();
  // What the plan asked the signatory for is no longer wanted. Nobody should pay for work that has been stopped.
  withdrawRequests(org, plan, plan.cancelReason);
  // A hosted session that is being followed is wound up by whoever follows it, who is told the plan is off.
  // One that is held, or waiting at its cap, has nobody to do that: what it left open is closed here.
  if (plan.managed && plan.managed.state !== 'running' && plan.managed.state !== 'starting') {
    closeOpenWork(plan, plan.managed, 'failed', 'The plan was cancelled.');
    plan.managed.state = 'finished';
  }
  // A decision still open on a cancelled plan has nothing left to decide.
  const decision = org.decisions.find((d) => d.id === plan.decisionId && d.status !== 'resolved');
  if (decision) {
    decision.status = 'resolved';
    decision.outcome = {
      method: byId === arbiterOf(org).id && arbiterOf(org).kind === 'judge' ? 'judge' : 'ceo',
      byId,
      ruling: 'Plan cancelled before the board decided.',
      rationale: plan.cancelReason,
      planAction: 'cancel',
      amendments: [],
      at: now(),
    };
  }
}

/** What the lead says each phase will produce, and what it must wait for in other leads' plans. */
function applyIntents(org: Organisation, plan: Plan, phases: Array<{ phase: string; intent: string; effort?: number; waitsFor?: Array<{ lead: string; phase: string }> }>): void {
  for (const phase of plan.phases) {
    const entry = phases.find((p) => p.phase === phase.sopPhaseId);
    const given = entry?.intent.trim();
    if (given) phase.intent = clean(given, 800);
    if (entry && phase.status === 'pending') phase.effort = clampEffort(entry.effort) ?? phase.effort;
    if (entry && phase.status === 'pending') phase.waitsFor = namedWaits(org, plan.ownerId, entry.waitsFor);
  }
}

type PhaseEntry = { phase: string; intent: string; skip?: boolean; effort?: number; waitsFor?: Array<{ lead: string; phase: string }> };

/** A task with the effort the lead rated it at. */
function rated(task: Task, effort: unknown): Task {
  task.effort = clampEffort(effort);
  return task;
}

/** Every phase of the way of working a plan follows, whether or not the plan runs it. */
function approachPhases(owner: Executive, plan: Plan): SopPhase[] {
  if (plan.workApproachId === STANDARD_APPROACH) return owner.phases;
  return WORK_APPROACHES.find((a) => a.id === plan.workApproachId)?.phases ?? owner.phases;
}

/**
 * Settle which phases a plan runs, before any has started: every phase of its way of working except those the
 * lead skipped. A phase the system checks for itself is never skipped, and a plan that would skip everything
 * runs everything. A phase skipped earlier can be brought back.
 */
export function shapePhases(org: Organisation, owner: Executive, plan: Plan, entries: PhaseEntry[]): void {
  if (plan.phases.some((p) => p.status !== 'pending')) return applyIntents(org, plan, entries);
  const all = approachPhases(owner, plan);
  const entryFor = (id: string) => entries.find((e) => e.phase === id);
  let skip = new Set(all.filter((p) => !p.gate && entryFor(p.id)?.skip).map((p) => p.id));
  if (skip.size >= all.length) skip = new Set();
  plan.phases = all.filter((p) => !skip.has(p.id)).map((p) => plan.phases.find((x) => x.sopPhaseId === p.id) ?? planPhases([p])[0]!);
  plan.skipped = all.filter((p) => skip.has(p.id)).map((p) => ({ phase: p.name, reason: clean(entryFor(p.id)?.intent.trim() || 'Not needed for this objective.', 400) }));
  // What a lead wrote for a phase it asked to skip is why it is skipped, not what the phase will do.
  applyIntents(org, plan, entries.filter((e) => !e.skip));
}

/** The other leads a lead's plan could wait on. */
const otherLeads = (org: Organisation, exec: Executive) => leadsOf(org).filter((l) => l.id !== exec.id).map((l) => l.id);

/**
 * Do one unit of work: build the prompt from the organisation's current
 * state, call the model, and return a commit that writes the result back.
 * The commit re-checks that the state the work was for still holds.
 */
export async function perform(item: WorkItem, ctx: EngineContext): Promise<Commit> {
  const { org, provider, workspace } = ctx;
  const exec = need(execById(org, item.execId), `seat ${item.execId}`);
  const cycle = org.cycle.number;

  const ask = <T>(system: SystemPrompt, prompt: string, schema: z.ZodType<T>, context: Record<string, unknown>): Promise<T> =>
    provider.structured({
      kind: item.kind,
      system,
      prompt: prompt + '\n\n' + businessContext(org) + '\n\n' + ctx.access.context(exec.id),
      schema,
      model: org.settings.executiveModel,
      effort: org.settings.executiveEffort,
      signal: ctx.signal,
      onUsage: (usage) => ctx.recordUsage(exec.id, usage),
      context: { ...context, seat: seatContext(exec), cycle, organisation: org.name, mission: org.mission },
    });
  const system = prompts.systemFor(org, exec);

  switch (item.kind) {
    case 'consult': {
      const data = await ask(system, prompts.consultPrompt(org, exec), schemas.Consult, {
        steer: org.steers.at(-1)?.text ?? null,
      });
      return () => {
        if (org.cycle.number !== cycle || org.cycle.stage !== 'consult') return;
        applyBusinessUpdates(org, data.operations, { id: exec.id });
        org.cycle.consults[exec.id] = {
          proposal: clean(data.proposal),
          rationale: clean(data.rationale),
          needs: clean(data.needs),
        };
        const needs = data.needs.trim() ? `\n\n**Needs:** ${clean(data.needs)}` : '';
        postToBoard(org, 'consult', exec.id, `${exec.short} proposes`, `${clean(data.proposal)}\n\n**Why now:** ${clean(data.rationale)}${needs}`);
      };
    }

    case 'direct': {
      const leads = leadsOf(org);
      const steerIds = org.steers.filter((s) => s.status === 'new').map((s) => s.id);
      const data = await ask(system, prompts.directPrompt(org), schemas.directionSchema(leads.map((l) => l.id), org.business.jobs.filter((j) => jobReady(org, j)).map((j) => j.id)), {
        leads: leads.map(seatContext),
        readyJobs: org.business.jobs.filter((j) => jobReady(org, j)).map((j) => ({ id: j.id, ownerId: j.ownerId, title: j.title, description: j.description })),
        scheduled: org.settings.reviewIntervalMinutes > 0,
        consults: org.cycle.consults,
        newSteer: org.steers.filter((s) => s.status === 'new').map((s) => s.text),
        signatory: deskContext(org),
      });
      const seen = new Set<string>();
      const directives = data.directives.filter((d) => {
        if (!leads.some((l) => l.id === d.to) || seen.has(d.to) || !d.objective.trim()) return false;
        if (d.jobId && !org.business.jobs.some((j) => j.id === d.jobId && j.ownerId === d.to && jobReady(org, j))) return false;
        seen.add(d.to);
        return true;
      });
      if (!directives.length && org.settings.reviewIntervalMinutes === 0) throw new ProviderError('The CEO issued no directive to any lead.', 'invalid_output', true);
      return () => {
        if (org.cycle.number !== cycle || org.cycle.stage !== 'direct') return;
        applyBusinessUpdates(org, data.operations, { id: exec.id });
        org.cycle.intent = clean(data.shareholderIntent);
        org.cycle.priorities = data.priorities.map((p) => clean(p, 400)).filter(Boolean).slice(0, 6);
        org.cycle.stage = 'work';
        const lines: string[] = [];
        for (const d of directives) {
          if (d.jobId && !org.business.jobs.some((j) => j.id === d.jobId && j.ownerId === d.to && jobReady(org, j))) continue;
          const lead = leads.find((l) => l.id === d.to)!;
          newPlan(org, lead, d, { type: 'directive' }, 0);
          lines.push(`- **${lead.short}** (${d.priority}): ${clean(d.objective, 600)}`);
        }
        postToBoard(
          org,
          'direction',
          exec.id,
          `Cycle ${cycle} direction`,
          `**The shareholders want:** ${org.cycle.intent}\n\n**Priorities**\n${org.cycle.priorities.map((p, i) => `${i + 1}. ${p}`).join('\n')}\n\n**Directives**\n${lines.join('\n')}`,
        );
        const answered = org.steers.filter((s) => steerIds.includes(s.id) && s.status === 'new');
        const response = clean(data.steerResponse) || 'Taken into this cycle’s priorities and directives.';
        for (const steer of answered) {
          steer.status = 'acknowledged';
          steer.response = response;
          steer.acknowledgedAt = now();
        }
        if (answered.length) postToBoard(org, 'steer_response', exec.id, 'CEO responds to shareholder steer', response);
      };
    }

    case 'plan': {
      const plan = need(planById(org, item.planId), `plan ${item.planId}`);
      const files = await workspace.list();
      // Repository work is local: a hosted session cannot reach the vault, so nothing could check its gates.
      const choices = approachChoices(org, exec, org.settings.execution === 'local' && ctx.access.canCode(exec.id));
      const draft = schemas.planDraftSchema([...new Set(choices.flatMap((c) => c.phases.map((p) => p.id)))], otherLeads(org, exec));
      const schema = choices.length > 1 ? draft.extend(schemas.workApproachSchema(choices.map((c) => c.id)).shape) : draft;
      const data = await ask(system, prompts.planPrompt(org, exec, plan, files, choices), schema as typeof draft, {
        plan: planContext(org, plan),
        otherPlans: org.plans.filter((p) => p.cycle === cycle && p.id !== plan.id).map((p) => planContext(org, p)),
      });
      return () => {
        if (plan.status !== 'planning') return;
        const { workApproach, workApproachReason } = data as Partial<z.infer<ReturnType<typeof schemas.workApproachSchema>>>;
        const chosen = choices.find((c) => c.id === workApproach);
        if (chosen && chosen.id !== STANDARD_APPROACH) {
          plan.phases = planPhases(chosen.phases);
          plan.workApproachId = chosen.id;
        }
        plan.workApproachReason = chosen && workApproachReason ? clean(workApproachReason, 600) : null;
        applyBusinessUpdates(org, data.operations, { id: exec.id });
        plan.approach = clean(data.approach);
        plan.effort = clampEffort(data.effort);
        shapePhases(org, exec, plan, data.phases);
        plan.escalations = data.escalations
          .filter((e) => e.issue.trim())
          .slice(0, 3)
          .map((e) => ({ issue: clean(e.issue, 800), proposal: clean(e.proposal, 800) }));
        logRemitDecisions(org, exec, plan, data.decisions);
        plan.status = 'drafted';
        plan.updatedAt = now();
        postToBoard(
          org,
          'plan',
          exec.id,
          `${exec.short} plan: ${plan.objective.slice(0, 120)}`,
          `${plan.workApproachId === STANDARD_APPROACH ? '' : `**${approachLabel(plan.workApproachId)}.** ${plan.workApproachReason ?? ''}\n\n`}${plan.approach}\n\n${plan.phases.map((p) => `- **${p.name}:** ${prompts.phaseIntent(org, p)}`).join('\n')}${prompts.skippedLine(plan)}`,
          { planId: plan.id },
        );
      };
    }

    case 'review': {
      const round = need(
        org.reviewRounds.find((r) => r.id === item.roundId),
        `review round ${item.roundId}`,
      );
      const theirs = round.planIds.map((id) => planById(org, id)).filter((p): p is Plan => !!p && p.ownerId !== exec.id);
      const data = await ask(system, prompts.reviewPrompt(org, exec, round), schemas.planReviewSchema(theirs.map((p) => p.id)), {
        reviewerIndex: round.reviewerIds.indexOf(exec.id),
        plans: theirs.map((p) => planContext(org, p)),
      });
      return () => {
        if (round.status !== 'open') return;
        const objections = data.objections
          .filter((o) => theirs.some((p) => p.id === o.planId) && o.concern.trim())
          .slice(0, 3)
          .map((o) => ({ planId: o.planId, byId: exec.id, concern: clean(o.concern, 800), proposal: clean(o.proposal, 800) }));
        round.reviews[exec.id] = objections;
        for (const o of objections) {
          const owner = execById(org, planById(org, o.planId)?.ownerId ?? '');
          postToBoard(org, 'review', exec.id, `${exec.short} objects to the ${owner?.short ?? 'plan'} plan`, `${o.concern}\n\n**Proposes:** ${o.proposal}`, {
            planId: o.planId,
          });
        }
      };
    }

    case 'answer': {
      const decision = need(
        org.decisions.find((d) => d.id === item.decisionId),
        `decision ${item.decisionId}`,
      );
      const plan = need(decision.planId ? planById(org, decision.planId) : undefined, `plan of ${decision.id}`);
      const data = await ask(system, prompts.answerPrompt(org, exec, decision, plan), schemas.AnswerOut, {
        decisionId: decision.id,
        objectors: decision.issues.map((i) => i.byId),
      });
      return () => {
        if (decision.status !== 'answering' || plan.status !== 'contested') return;
        const argument = clean(data.argument);
        const amendments = data.amendments.map((a) => clean(a, 800)).filter(Boolean).slice(0, 6);
        if (data.verdict === 'accept') {
          // Each objection's own proposal stands in for any change the owner did not spell out.
          if (!amendments.length) amendments.push(...decision.issues.map((i) => clean(i.proposal, 800)).filter(Boolean).slice(0, 6));
          decision.status = 'resolved';
          decision.outcome = { method: 'owner', byId: exec.id, ruling: `The ${exec.short} accepts the objections.`, rationale: argument, planAction: 'amend', amendments, at: now() };
          plan.amendments.push(...amendments);
          plan.status = 'revising';
          plan.updatedAt = now();
          postToBoard(org, 'decision', exec.id, `${exec.short} accepts the objections to its plan`, `${argument}\n\n**Binding on the plan**\n${bullets(amendments)}`, { decisionId: decision.id, planId: plan.id });
          return;
        }
        decision.status = 'open';
        decision.positions[exec.id] = { stance: amendments.length ? 'compromise' : 'back_plan', argument: amendments.length ? `${argument}\n\nCan accept: ${amendments.join('; ')}` : argument };
        postToBoard(org, 'decision', exec.id, `Board decision opened: ${decision.title}`, `The ${exec.short} contests the objections: ${argument}\n\nThe board will state positions; the ${arbiterOf(org).short} signs off.`, { decisionId: decision.id, planId: plan.id });
      };
    }

    case 'position': {
      const decision = need(
        org.decisions.find((d) => d.id === item.decisionId),
        `decision ${item.decisionId}`,
      );
      const plan = decision.planId ? planById(org, decision.planId) : undefined;
      const data = await ask(system, prompts.positionPrompt(org, exec, decision, plan), schemas.PositionOut, {
        decisionId: decision.id,
        isOwner: plan?.ownerId === exec.id,
        isObjector: decision.issues.some((i) => i.byId === exec.id && i.byId !== plan?.ownerId),
      });
      return () => {
        if (decision.status !== 'open') return;
        decision.positions[exec.id] = { stance: data.stance, argument: clean(data.argument) };
      };
    }

    case 'signoff': {
      const decision = need(
        org.decisions.find((d) => d.id === item.decisionId),
        `decision ${item.decisionId}`,
      );
      const plan = decision.planId ? planById(org, decision.planId) : undefined;
      const stances = decision.participantIds.map((id) => decision.positions[id]?.stance);
      const data = await ask(system, prompts.signoffPrompt(org, decision, plan), schemas.SignOff, {
        decisionId: decision.id,
        stances,
        arbiterKind: exec.kind,
      });
      return () => {
        if (decision.status !== 'deliberated') return;
        const amendments = data.planAction === 'amend' ? data.amendments.map((a) => clean(a, 800)).filter(Boolean).slice(0, 6) : [];
        if (data.planAction === 'amend' && !amendments.length) amendments.push(clean(data.ruling, 800));
        // It was consensus only if every lead took the same stance and the arbiter went with it.
        const agreed = stances.length > 0 && stances.every((s) => s && s === stances[0]);
        const followed = agreed && (stances[0] === 'back_plan' ? data.planAction === 'proceed' : data.planAction !== 'proceed');
        decision.status = 'resolved';
        decision.outcome = {
          method: followed ? 'consensus' : exec.kind === 'judge' ? 'judge' : 'ceo',
          byId: exec.id,
          ruling: clean(data.ruling),
          rationale: clean(data.rationale),
          planAction: data.planAction,
          amendments,
          at: now(),
        };
        if (plan && plan.status === 'contested') {
          plan.updatedAt = now();
          if (data.planAction === 'proceed') plan.status = 'approved';
          else if (data.planAction === 'amend') {
            plan.amendments.push(...amendments);
            plan.status = 'revising';
          } else cancelPlan(org, plan, decision.outcome.ruling, exec.id);
        }
        const title = followed ? `Board agreed, ${exec.short} ratifies: ${decision.title}` : `${exec.short} rules: ${decision.title}`;
        const amended = amendments.length ? `\n\n**Binding on the plan**\n${bullets(amendments)}` : '';
        postToBoard(org, 'decision', exec.id, title, `${decision.outcome.ruling}\n\n**Reasons:** ${decision.outcome.rationale}${amended}`, {
          decisionId: decision.id,
          planId: plan?.id,
        });
      };
    }

    case 'revise': {
      const plan = need(planById(org, item.planId), `plan ${item.planId}`);
      const decision = org.decisions.find((d) => d.id === plan.decisionId);
      const all = approachPhases(exec, plan);
      const data = await ask(system, prompts.revisePrompt(org, plan, decision, all), schemas.planRevisionSchema(all.map((p) => p.id), otherLeads(org, exec)), {
        plan: planContext(org, plan),
        phases: all.map((p) => ({ id: p.id, name: p.name, skipped: !plan.phases.some((x) => x.sopPhaseId === p.id) })),
        amendments: plan.amendments,
      });
      return () => {
        if (plan.status !== 'revising') return;
        plan.approach = clean(data.approach);
        plan.effort = clampEffort(data.effort) ?? plan.effort;
        shapePhases(org, exec, plan, data.phases);
        plan.status = 'approved';
        plan.updatedAt = now();
        postToBoard(org, 'plan', exec.id, `${exec.short} plan revised to comply`, clean(data.changes), { planId: plan.id });
      };
    }

    case 'kickoff': {
      const plan = need(planById(org, item.planId), `plan ${item.planId}`);
      const phase = need(plan.phases[item.phaseIndex], `phase ${item.phaseIndex}`);
      const files = await workspace.list();
      const max = Math.min(org.settings.maxTasksPerPhase, Math.max(exec.agentCount, 1) * 2);
      const data = await ask(system, prompts.kickoffPrompt(org, exec, plan, item.phaseIndex, files), schemas.Kickoff, {
        plan: planContext(org, plan),
        phase: { name: phase.name, deliverable: phase.deliverable, index: item.phaseIndex },
        maxTasks: max,
        dir: teamDir(exec),
      });
      return () => {
        if (plan.status !== 'executing' || phase.status !== 'pending') return;
        const specs = data.tasks.filter((t) => t.title.trim() && t.brief.trim()).slice(0, max);
        // A phase always has work: if the lead named none, the phase deliverable is the task.
        if (!specs.length) specs.push({ title: `Produce the ${phase.name} deliverable`, brief: `${phase.intent}\n\nDeliverable: ${phase.deliverable}`, effort: phase.effort ?? 0 });
        phase.tasks = specs.map((t) => rated(newTask(org, t.title, t.brief, false), t.effort));
        phase.notes = clean(data.notes, 1500);
        phase.status = 'working';
        plan.updatedAt = now();
        logRemitDecisions(org, exec, plan, data.decisions);
      };
    }

    case 'task': {
      const plan = need(planById(org, item.planId), `plan ${item.planId}`);
      const phase = need(plan.phases[item.phaseIndex], `phase ${item.phaseIndex}`);
      const task = need(
        phase.tasks.find((t) => t.id === item.taskId),
        `task ${item.taskId}`,
      );
      const written: string[] = [];
      const tools = workspaceTools(workspace, (path) => {
        if (!written.includes(path)) written.push(path);
      });
      tools.push(...businessTools(org, { id: exec.id, worker: true }, ctx.touch, () => !ctx.halting() && !ctx.signal.aborted && isPlanActive(plan)));
      tools.push(...accessTools(ctx.access, exec.id, task.id, ctx.signal, () => !ctx.halting() && isPlanActive(plan)));
      tools.push(
        ...codeTools(
          ctx.access,
          exec.id,
          {
            branch: planBranch(org, plan),
            code: () => plan.code,
            record: (code) => {
              plan.code = code;
              plan.updatedAt = now();
              ctx.touch();
            },
            open: () => {
              const gated = plan.phases.filter((p) => p.gate);
              return !gated.length || gated.some((p) => p.status !== 'done');
            },
          },
          workspace,
          ctx.signal,
          () => !ctx.halting() && isPlanActive(plan),
        ),
      );
      const files = await workspace.list();
      // Web search is switched on for the organisation, but only some providers' models can do it.
      // The model the task was given to when it was started: by its rating, where the agents have a ladder of models.
      const model = task.model ?? org.settings.workerModel;
      const canSearch = org.settings.webResearch && allows(org, exec.id, 'web_search') && (provider.searches?.(model) ?? true);
      const result = await provider.agent({
        kind: 'task',
        system: prompts.systemForAgent(org, exec, canSearch),
        prompt: prompts.taskPrompt(org, exec, plan, item.phaseIndex, task, phase.notes, files, planBranch(org, plan)) + '\n\n' + businessContext(org) + '\n\n' + ctx.access.context(exec.id),
        model,
        effort: org.settings.workerEffort,
        tools,
        // The whole allowance is open in any one request, so a search is only ever refused for the limit once the task has used it up.
        webSearch: canSearch ? { perRequest: MAX_TASK_SEARCHES, perTask: MAX_TASK_SEARCHES } : null,
        maxTurns: MAX_TASK_TURNS,
        signal: ctx.signal,
        shouldStop: ctx.halting,
        shouldWrapUp: ctx.overBudget,
        onUsage: (usage) => ctx.recordUsage(exec.id, usage),
        context: {
          seat: seatContext(exec),
          cycle,
          organisation: org.name,
          mission: org.mission,
          dir: teamDir(exec),
          plan: planContext(org, plan),
          phase: { name: phase.name, deliverable: phase.deliverable, index: item.phaseIndex },
          task: { id: task.id, title: task.title, brief: task.brief, rework: task.rework },
        },
      }).finally(() => ctx.access.closeTask(task.id));
      if (result.stopped !== 'interrupted' && !result.text.trim() && !written.length) {
        throw new ProviderError('The agent ended without a report or any files.', 'invalid_output', true);
      }
      return () => {
        if (result.stopped === 'interrupted') {
          // Halted mid-run: the task goes back in the queue and starts afresh when the loop resumes.
          task.status = 'pending';
          task.agent = null;
          task.startedAt = null;
          return;
        }
        const note = result.stopped === 'cut_short' ? '\n\n[The agent was stopped before it had finished: it reached its turn limit, ran out of room for its reply, or the budget was spent.]' : '';
        task.status = 'done';
        task.result = (result.text.trim() || '(The agent gave no closing report.)').slice(0, MAX_RESULT_CHARS) + note;
        task.files = written;
        task.error = null;
        task.finishedAt = now();
        plan.updatedAt = task.finishedAt;
      };
    }

    case 'phase_review': {
      const plan = need(planById(org, item.planId), `plan ${item.planId}`);
      const phase = need(plan.phases[item.phaseIndex], `phase ${item.phaseIndex}`);
      // Before any model is called: while checks are running this waits, and costs nothing.
      const proof = await gateEvidence(ctx, plan, phase);
      const held = proof !== null && proof.state !== 'passed';
      const canRework = phase.reworkRounds < (phase.gate ? MAX_GATED_REWORK_ROUNDS : MAX_REWORK_ROUNDS);
      const written = await readForReview(workspace, [...new Set(phase.tasks.flatMap((t) => t.files))]);
      const data = await ask(system, prompts.phaseReviewPrompt(org, plan, item.phaseIndex, canRework, written, proof), schemas.PhaseReview, {
        plan: planContext(org, plan),
        phase: { name: phase.name, deliverable: phase.deliverable, index: item.phaseIndex },
        tasks: phase.tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, files: t.files })),
        canRework,
      });
      return () => {
        if (plan.status !== 'executing' || phase.status !== 'working') return;
        if (!phase.tasks.every((t) => t.status === 'done' || t.status === 'failed')) return;
        logRemitDecisions(org, exec, plan, data.decisions);
        applyBusinessUpdates(org, data.operations, { id: exec.id });
        phase.summary = clean(data.summary, 4000);
        plan.updatedAt = now();
        phase.evidence = proof;
        const rework = data.reworkTasks.filter((t) => t.title.trim() && t.brief.trim()).slice(0, Math.max(exec.agentCount, 1));
        if (held && (!canRework || proof.final)) {
          // What the system found is not the lead's to wave through, however the lead rules.
          failPlan(org, plan, `${phase.name} could not pass: ${proof.summary}`);
          postToBoard(org, 'system', 'system', `${exec.short} plan stopped at ${phase.name}`, `${proof.summary} ${proof.final ? 'Sending the phase back cannot change that' : 'The phase has been sent back as often as it can be'}, so the plan stops here. ${phase.summary}`, { planId: plan.id });
          return;
        }
        if (held || (data.verdict === 'rework' && canRework && rework.length)) {
          phase.reworkRounds += 1;
          // Check names come from the repository, so they are left out of a brief an agent takes as its instructions.
          if (held && !rework.length) rework.push({ title: `Clear the ${phase.name} gate`, brief: `The system did not pass this gate. Read the checks and the logs of any failed runs with read_repository, find out why, put it right and push the fix to the plan's branch.`, effort: 0, redoes: '' });
          const added = rework.map((t) => {
            const task = rated(newTask(org, t.title, t.brief, true), t.effort);
            // Whose work this puts right, as the lead named it: by its id, or failing that by its title.
            const named = t.redoes.trim().toLowerCase();
            task.redoes = (named ? phase.tasks.find((done) => done.id.toLowerCase() === named) ?? phase.tasks.find((done) => done.title.toLowerCase() === named) : undefined)?.id ?? null;
            return task;
          });
          // What the lead has read is judged before the new tasks join it. Work the lead named is sent back and the
          // rest stands. Stopped by the system's own checks with nobody named, all of it is taken as sent back.
          const named = new Set(added.flatMap((task) => (task.redoes ? [task.redoes] : [])));
          judgeRound(org, exec, phase, held && !named.size ? 'all' : named);
          phase.tasks.push(...added);
        } else {
          phase.status = 'done';
          judgeRound(org, exec, phase, new Set());
        }
        // What the plan now needs paid for or signed goes to the signatory. The plan does not wait for it.
        raiseRequests(org, exec, plan, phase.name, data.requests);
      };
    }

    case 'authorise': {
      const request = need(
        org.signatory.requests.find((r) => r.id === item.requestId),
        `request ${item.requestId}`,
      );
      const plan = request.planId ? planById(org, request.planId) : undefined;
      const files = await readForReview(workspace, request.files);
      const data = await ask(system, prompts.authorisePrompt(org, request, plan, files), schemas.Authorise, {
        request: { id: request.id, kind: request.kind, title: request.title, amount: request.amount, party: request.party, detail: request.detail },
      });
      return () => {
        // The seat may have been given back to a person while the AI was deciding: then it is the person's to decide.
        if (org.settings.signatory !== 'ai') return;
        ruleOnRequest(org, request, data.verdict, data.reason);
      };
    }

    case 'report': {
      const plan = need(planById(org, item.planId), `plan ${item.planId}`);
      const files = [...new Set(plan.phases.flatMap((p) => p.tasks.flatMap((t) => t.files)))];
      const data = await ask(system, prompts.reportPrompt(org, plan), schemas.ReportOut, {
        plan: planContext(org, plan),
        phases: plan.phases.map((p) => ({ name: p.name, summary: p.summary })),
        files,
      });
      return () => {
        if (plan.status !== 'reporting') return;
        applyBusinessUpdates(org, data.operations, { id: exec.id });
        fileReport(org, plan, exec, data, files);
      };
    }

    case 'react': {
      const reports = item.reportIds.map((id) => org.reports.find((r) => r.id === id)).filter((r): r is BoardReport => !!r);
      const drop = () => {
        org.inbox[exec.id] = (org.inbox[exec.id] ?? []).filter((id) => !item.reportIds.includes(id));
      };
      if (!reports.length) return drop;
      const depthOf = (reportId: string) => planById(org, org.reports.find((r) => r.id === reportId)?.planId ?? '')?.depth ?? 0;
      const files = await workspace.list();
      const data = await ask(system, prompts.reactPrompt(org, exec, reports, MAX_FOLLOW_UPS, files), schemas.reactionSchema(reports.map((r) => r.id)), {
        reports: reports.map((r) => ({ id: r.id, from: execById(org, r.fromId)?.short ?? r.fromId, headline: r.headline, asks: r.asks })),
        maxFollowUps: MAX_FOLLOW_UPS,
      });
      return () => {
        drop();
        if (org.cycle.number !== cycle) return;
        applyBusinessUpdates(org, data.operations, { id: exec.id });
        if (data.note.trim()) postToBoard(org, 'reaction', exec.id, `${exec.short} on the reports`, clean(data.note, 1200));
        for (const f of data.followUps.filter((x) => x.objective.trim()).slice(0, MAX_FOLLOW_UPS)) {
          const sources = f.reportIds.filter((id) => item.reportIds.includes(id));
          const from = sources.length ? sources : item.reportIds;
          const depth = Math.max(...from.map(depthOf)) + 1;
          if (depth > org.settings.maxFollowUpDepth || followUpsLeft(org, exec.id) === 0) continue;
          // What already exists goes with the plan, so that drafting it starts from there rather than from scratch.
          const existing = (f.existing ?? '').trim();
          const rationale = existing ? `${f.rationale.trim()}\n\nAlready in place, and what is missing: ${existing}` : f.rationale;
          const plan = newPlan(org, exec, { ...f, rationale, priority: 'medium' }, { type: 'follow_up', reportIds: from }, depth);
          postToBoard(org, 'reaction', exec.id, `${exec.short} follows up`, `${plan.objective}\n\n**Because:** ${plan.rationale}`, { planId: plan.id });
        }
      };
    }

    case 'execute': {
      const plan = need(planById(org, item.planId), `plan ${item.planId}`);
      return executeInSession(ctx, exec, plan);
    }

    case 'steer_review': {
      const active = org.plans.filter(isPlanActive);
      const data = await ask(system, prompts.steerReviewPrompt(org, item.steerIds, active), schemas.steerReviewSchema(active.map((p) => p.id)), {
        steer: org.steers.filter((s) => item.steerIds.includes(s.id)).map((s) => s.text),
        plans: active.map((p) => planContext(org, p)),
      });
      return () => {
        applyBusinessUpdates(org, data.operations, { id: exec.id });
        const changes: string[] = [];
        for (const verdict of data.verdicts) {
          const plan = planById(org, verdict.planId);
          if (!plan || !isPlanActive(plan) || !verdict.note.trim()) continue;
          const owner = execById(org, plan.ownerId)?.short ?? plan.ownerId;
          if (verdict.action === 'cancel') {
            cancelPlan(org, plan, verdict.note, exec.id);
            changes.push(`**${owner} plan cancelled:** ${clean(verdict.note, 600)}`);
          } else {
            plan.amendments.push(clean(verdict.note, 800));
            plan.updatedAt = now();
            changes.push(`**${owner} plan amended:** ${clean(verdict.note, 600)}`);
          }
        }
        const response = clean(data.response) || 'Steer received; work in progress continues unchanged.';
        for (const steer of org.steers) {
          if (item.steerIds.includes(steer.id) && steer.status === 'new') {
            steer.status = 'acknowledged';
            steer.response = response;
            steer.acknowledgedAt = now();
          }
        }
        postToBoard(org, 'steer_response', exec.id, 'CEO responds to shareholder steer', `${response}${changes.length ? `\n\n${bullets(changes)}` : ''}`);
      };
    }
  }
}

const REVIEW_CHARS_PER_FILE = 12_000;
const REVIEW_CHARS_TOTAL = 48_000;

/**
 * The files a phase produced, for the lead's gate review. Long files are cut
 * and, past a total allowance, files are named without their contents, so one
 * review cannot swallow the budget.
 */
async function readForReview(workspace: Workspace, paths: string[]): Promise<prompts.ReviewFile[]> {
  const files: prompts.ReviewFile[] = [];
  let allowance = REVIEW_CHARS_TOTAL;
  for (const path of paths) {
    if (allowance <= 0) {
      files.push({ path, content: null, note: 'not shown: the review allowance was used up by earlier files' });
      continue;
    }
    try {
      const { content } = await workspace.read(path);
      const limit = Math.min(REVIEW_CHARS_PER_FILE, allowance);
      files.push({
        path,
        content: content.slice(0, limit),
        note: content.length > limit ? `cut to its first ${limit} of ${content.length} characters` : null,
      });
      allowance -= Math.min(content.length, limit);
    } catch {
      files.push({ path, content: null, note: 'reported as written but could not be read' });
    }
  }
  return files;
}

/** The signatory's desk in a few lists, for a provider that answers from facts instead of from a prompt. */
export function deskContext(org: Organisation) {
  const lately = org.signatory.requests.filter((r) => r.outcome && r.outcome.cycle >= org.cycle.number - 1);
  return {
    waiting: org.signatory.requests.filter(isOpen).map(describeRequest),
    done: lately.filter((r) => r.outcome!.result === 'done').map(describeRequest),
    rejected: lately.filter((r) => r.outcome!.result === 'rejected').map((r) => `${describeRequest(r)}: ${r.outcome!.note}`),
  };
}

export function seatContext(exec: Executive) {
  return {
    id: exec.id,
    kind: exec.kind,
    short: exec.short,
    title: exec.title,
    function: exec.function,
    agentCount: exec.agentCount,
    phases: exec.phases.map((p) => ({ id: p.id, name: p.name, deliverable: p.deliverable })),
  };
}

export function planContext(org: Organisation, plan: Plan) {
  return {
    id: plan.id,
    owner: execById(org, plan.ownerId)?.short ?? plan.ownerId,
    ownerId: plan.ownerId,
    objective: plan.objective,
    depth: plan.depth,
    origin: plan.origin.type,
  };
}

/** A human label for a unit of work, for the live "who is doing what" display. */
export function describeWork(org: Organisation, item: WorkItem): string {
  const plan = 'planId' in item ? planById(org, item.planId) : undefined;
  switch (item.kind) {
    case 'consult':
      return 'Preparing a proposal for the CEO';
    case 'direct':
      return 'Deciding what the shareholders want now';
    case 'plan':
      return 'Drafting a plan';
    case 'review':
      return 'Reviewing other leads’ plans';
    case 'answer':
      return 'Answering objections to the plan';
    case 'position':
      return 'Stating a position to the board';
    case 'signoff':
      return 'Signing off a board decision';
    case 'revise':
      return 'Revising the plan to comply with a ruling';
    case 'kickoff':
      return `Handing out work for ${plan?.phases[item.phaseIndex]?.name ?? 'the next phase'}`;
    case 'task': {
      const task = plan?.phases[item.phaseIndex]?.tasks.find((t) => t.id === item.taskId);
      return task?.title ?? 'Working on a task';
    }
    case 'phase_review':
      return `Reviewing the ${plan?.phases[item.phaseIndex]?.name ?? ''} phase`.replace('  ', ' ');
    case 'report':
      return 'Writing the report to the board';
    case 'react':
      return 'Reading board reports';
    case 'steer_review':
      return 'Applying new shareholder steer';
    case 'authorise': {
      const request = org.signatory.requests.find((r) => r.id === item.requestId);
      return request ? `Deciding on a ${request.kind === 'payment' ? 'payment' : 'signature'}: ${request.title}` : 'Deciding on a request';
    }
    case 'execute':
      return 'Carrying out the plan with its team in a hosted session';
  }
}
