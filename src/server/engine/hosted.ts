import path from 'node:path';
import { allows } from '../../shared/privileges';
import { applyBusinessUpdates, businessContext } from './business';
import type { Executive, ManagedSession, Plan, PlanPhase, Task, WorkspaceFile } from '../../shared/types';
import { PLAN_TOOLS, ProviderError, type PlanHooks, type PlanJob, type PlanOutcome } from '../providers/types';
import { WorkspaceError } from '../workspace';
import type { Commit, EngineContext } from './handlers';
import * as prompts from './prompts';
import { MAX_RESULT_CHARS, clean, fileReport, logRemitDecisions, newTask, now } from './records';
import { MAX_REQUESTS_PER_GATE, alreadyRaised, raiseRequests } from './signatory';
import { execById, isPlanActive, postToBoard, sessionAllowance, teamDir } from './state';

// A plan carried out in a hosted session: the lead and its agents work in a
// sandbox on the provider's side, and tell the engine what happens through
// the hooks below. The plan's state is updated as they do, so the board sees
// phases, tasks and files appear while the session is still running.

/** How many sessions a plan may go through before the organisation stops and says so. */
export const MAX_SESSIONS_PER_PLAN = 2;
/** Workspace files mounted in a session: the most recent, and none too large to be worth carrying. */
const MAX_MOUNTED_FILES = 200;
const MAX_MOUNTED_BYTES = 5_000_000;
/** Bounds on what one plan's record keeps of a session, so a runaway session cannot bloat the state. */
const MAX_TASKS_PER_PHASE = 200;
const MAX_RUNS_KEPT = 40;
const MAX_FILES_KEPT = 400;

export function newManagedSession(): ManagedSession {
  return {
    sessionId: null,
    consoleUrl: null,
    budgetUsd: 0,
    spentUsd: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, webSearches: 0 },
    state: 'starting',
    runs: [],
    pendingReport: null,
    instructionsSent: 0,
    declined: 0,
    note: null,
    files: [],
    attempts: 0,
    synced: {},
    agents: [],
    lastDeclined: null,
    cursor: null,
    handledTo: null,
  };
}

/** The workspace files a session gets to read: the most recently written, largest files left out. */
export function mountable(files: WorkspaceFile[]): WorkspaceFile[] {
  return files
    .filter((f) => f.size > 0 && f.size <= MAX_MOUNTED_BYTES)
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
    .slice(0, MAX_MOUNTED_FILES)
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** Which phase of the plan a lead means by what it wrote, or -1. Leads name phases loosely ("Build", "phase 2", "the Build phase"). */
export function findPhase(plan: Plan, given: string): number {
  const key = given.trim().toLowerCase();
  if (!key) return -1;
  const exact = plan.phases.findIndex((p) => p.name.toLowerCase() === key || p.sopPhaseId.toLowerCase() === key);
  if (exact >= 0) return exact;
  const numbered = /^(?:phase\s*)?(\d+)\b/.exec(key);
  if (numbered) {
    const index = Number(numbered[1]) - 1;
    if (plan.phases[index]) return index;
  }
  const named = plan.phases
    .map((p, index) => ({ index, hit: new RegExp(`\\b${p.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(key) }))
    .filter((p) => p.hit);
  return named.length === 1 ? named[0]!.index : -1;
}

/** Where in the workspace a file from a session's output folder belongs: always inside the team's own directory. */
export function outputPath(name: string, team: string): string {
  let rel = name
    .replace(/\\/g, '/')
    .replace(/^\/?mnt\/session\/outputs\//, '')
    .replace(/^\/+/, '');
  if (!rel) rel = 'unnamed';
  if (!rel.startsWith(`${team}/`)) rel = `${team}/${rel}`;
  return rel;
}

/**
 * The workspace path of a file a lead in a session names. The lead knows its own files by where they are in the
 * sandbox, and the organisation's by where they are mounted there; neither is where they are in the workspace.
 */
export function homePath(name: string, team: string, brought: string[]): string {
  const given = name.replace(/\\/g, '/').trim();
  if (/^\/?mnt\/session\/outputs\//.test(given)) return outputPath(given, team);
  const rel = given.replace(/^\/?mnt\/session\/uploads\/workspace\//, '').replace(/^\/+/, '');
  // A bare name is most likely one of the session's own files, which come home under the team's directory.
  return !brought.includes(rel) && brought.includes(`${team}/${rel}`) ? `${team}/${rel}` : rel;
}

function titleOf(brief: string): string {
  const line =
    brief
      .split('\n')
      .map((l) => l.replace(/^[#>*\-\s]+/, '').trim())
      .find(Boolean) ?? 'Task';
  return line.length > 120 ? `${line.slice(0, 119).trimEnd()}…` : line;
}

function latestTask(plan: Plan, threadId: string): Task | undefined {
  let found: Task | undefined;
  for (const phase of plan.phases) for (const task of phase.tasks) if (task.threadId === threadId) found = task;
  return found;
}

function workingPhase(plan: Plan): PlanPhase | undefined {
  return plan.phases.find((p) => p.status !== 'done') ?? plan.phases.at(-1);
}

/** Close whatever a session left open when it is no longer being followed. */
export function closeOpenWork(plan: Plan, managed: ManagedSession, as: 'done' | 'failed', error: string | null): void {
  const at = now();
  for (const phase of plan.phases) {
    for (const task of phase.tasks) {
      if (task.status !== 'running' || !task.threadId) continue;
      task.status = as;
      task.error = as === 'failed' ? error : null;
      task.finishedAt = at;
    }
  }
  for (const run of managed.runs) {
    if (run.status !== 'running' && run.status !== 'paused') continue;
    run.status = 'stopped';
    run.endedAt = at;
    for (const step of run.steps) if (step.status === 'running') step.status = 'done';
  }
}

/**
 * Carry a plan through in a hosted session. Returns when the lead has
 * reported, when the session is held (paused, out of money, cancelled), or
 * when it is lost. Unlike the other steps, most of the result is written to
 * the plan while the work runs; the commit only settles how it ended.
 */
export async function executeInSession(ctx: EngineContext, lead: Executive, plan: Plan): Promise<Commit> {
  const { org, provider, workspace } = ctx;
  if (!provider.executePlan) {
    throw new ProviderError('This provider cannot carry out plans in hosted sessions. Set the organisation to work on this machine.', 'bad_request', false);
  }
  if (plan.status !== 'executing' || plan.execution !== 'managed') return () => {};
  const managed = (plan.managed ??= newManagedSession());
  const team = teamDir(lead);

  // Money first, in the same tick the work was started in, so that plans
  // starting together each see what the others have been promised.
  const cap = sessionAllowance(org, plan, managed.spentUsd);
  if (cap === null) {
    managed.state = 'at_budget';
    ctx.touch();
    return () => {};
  }
  const capBefore = managed.sessionId ? managed.budgetUsd : 0;
  let capConfirmed = false;
  // The budget the cap was worked out from. See `halt`.
  let budgetThen = org.settings.budgetUsd;
  managed.budgetUsd = cap;
  managed.state = 'starting';
  ctx.touch();

  const models = org.settings.executiveModel === org.settings.workerModel ? org.settings.executiveModel : `${org.settings.executiveModel} + ${org.settings.workerModel}`;
  const pendingInstructions = () => plan.amendments.slice(managed.instructionsSent);
  const changed = () => {
    plan.updatedAt = now();
    ctx.touch();
  };

  const hooks: PlanHooks = {
    session(info) {
      if (managed.sessionId !== info.id) {
        // A new session: what the last one spent stays in the organisation's totals, but this one starts from nothing.
        managed.sessionId = info.id;
        managed.spentUsd = 0;
        managed.tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, webSearches: 0 };
        managed.synced = {};
        managed.agents = [];
        managed.cursor = null;
        managed.handledTo = null;
      }
      managed.consoleUrl = info.consoleUrl;
      managed.budgetUsd = info.budgetUsd;
      if (managed.state === 'starting' || managed.state === 'paused' || managed.state === 'at_budget') managed.state = 'running';
      capConfirmed = true;
      changed();
    },

    phase(record) {
      const index = plan.phases.findIndex((p) => p.status !== 'done');
      const current = plan.phases[index];
      if (!current) return { ok: true, message: `Every phase is already recorded. Report to the board with ${PLAN_TOOLS.reportToBoard}.` };
      const named = findPhase(plan, record.phase);
      const order = plan.phases.map((p) => p.name).join(', ');
      if (named < 0) {
        return { ok: false, message: `"${record.phase}" is not a phase of your operating profile. The phases are ${order}, and ${current.name} is the next to record.` };
      }
      if (named < index) {
        // A record that is sent twice is the same record. What it asks of the signatory is not filed a second time.
        // The answer to the first may never have reached the lead (it is written again when it could not be sent),
        // so this one says what became of what the record asks for, and carries what the board has since ruled.
        const asked = record.requests?.length ?? 0;
        const filed = asked ? alreadyRaised(org, plan, plan.phases[named]!.name, record.requests ?? []) : 0;
        const unfiled = !asked
          ? ''
          : !filed
            ? ' Nothing it asks of the signatory was filed: ask when you record a phase for the first time.'
            : ` ${filed} request${filed === 1 ? '' : 's'} it asks for went to the signatory when the phase was first recorded.${asked > filed ? ` ${asked - filed} ${asked - filed === 1 ? 'was' : 'were'} not filed.` : ''}`;
        const pending = pendingInstructions();
        const binding = pending.length ? `\n\n${prompts.sessionInstructions(pending)}` : '';
        return { ok: true, message: `${plan.phases[named]!.name} was already recorded.${unfiled} ${current.name} is next.${binding}`, instructions: plan.amendments.length };
      }
      if (named > index) {
        return { ok: false, message: `${plan.phases[named]!.name} cannot be recorded yet: ${current.name} comes before it and has not been recorded.` };
      }
      if (!record.summary.trim()) return { ok: false, message: 'Give a summary: what the phase produced, in which files, and how it passed your gate.' };
      if (plan.status === 'executing') applyBusinessUpdates(org, record.operations ?? [], { id: lead.id });
      current.status = 'done';
      current.summary = clean(record.summary, 4000);
      logRemitDecisions(org, lead, plan, record.decisions);
      // What the plan now needs paid for or signed goes to the signatory. The session does not wait for it.
      // A plan that was cancelled while this record was on its way asks for nothing.
      const wanted = plan.status === 'executing' ? (record.requests ?? []) : [];
      const asked = raiseRequests(
        org,
        lead,
        plan,
        current.name,
        wanted.map((spec) => ({ ...spec, files: (Array.isArray(spec.files) ? spec.files : []).map((file) => homePath(String(file), team, managed.files)) })),
      );
      const next = plan.phases[index + 1];
      // The record's reply is a sure way to reach the lead, so anything the board has since ruled goes with it.
      // It counts as told when the reply has been sent (`instructed`), not here: a reply can fail on the way.
      const pending = pendingInstructions();
      changed();
      const binding = pending.length ? `\n\n${prompts.sessionInstructions(pending)}` : '';
      const left = wanted.length - asked.length;
      const put =
        (asked.length ? ` ${asked.length} request${asked.length === 1 ? ' has' : 's have'} gone to the signatory.` : '') +
        (left > 0 ? ` ${left} ${left === 1 ? 'was' : 'were'} not filed: ${allows(org, lead.id, 'ask_signatory') ? `a request needs a title, is filed once while it is open, and a phase may raise ${MAX_REQUESTS_PER_GATE}` : 'your role may not ask the signatory'}.` : '') +
        (record.operations?.length && !allows(org, lead.id, 'update_records') ? ' Your role may not change business records, so those updates were not applied.' : '');
      // The reply is also where the lead hears what became of what it asked for earlier.
      const desk = (prompts.deskHasNews(org) ? `\n\n${prompts.signatoryBlock(org)}` : '') + '\n\n' + businessContext(org);
      return {
        ok: true,
        message: `Recorded.${put} ${next ? `${next.name} is next.` : `Every phase is now recorded: report to the board with ${PLAN_TOOLS.reportToBoard}.`}${binding}${desk}`,
        instructions: plan.amendments.length,
      };
    },

    report(draft) {
      const open = plan.phases.filter((p) => p.status !== 'done').map((p) => p.name);
      if (open.length) {
        return {
          ok: false,
          message: `Not yet. ${open.join(', ')} ${open.length === 1 ? 'has' : 'have'} not been recorded. Record each phase with ${PLAN_TOOLS.recordPhase} when it passes its gate, then report.`,
        };
      }
      if (!draft.headline.trim() || !draft.summary.trim()) return { ok: false, message: 'A report to the board needs a headline and a summary.' };
      managed.pendingReport = {
        headline: clean(draft.headline, 240),
        summary: clean(draft.summary, 3000),
        outcomes: draft.outcomes.map((o) => clean(o, 500)).filter(Boolean).slice(0, 8),
        asks: draft.asks.map((a) => clean(a, 500)).filter(Boolean).slice(0, 5),
      };
      changed();
      return { ok: true, message: 'Your report is with the board. End your turn now and start nothing further.' };
    },

    assigned({ threadId, agentName, brief, runId }) {
      const phase = workingPhase(plan);
      if (!phase) return;
      const latest = latestTask(plan, threadId);
      if (runId) {
        if (latest) return; // a run's agent does one piece of work
        const run = managed.runs.find((r) => r.id === runId);
        if (run) run.agents += 1;
        if (phase.tasks.length >= MAX_TASKS_PER_PHASE) return; // counted on the run, not listed singly
        const task = newTask(
          org,
          `${run?.name ?? 'Workflow run'}: ${agentName}${run ? ` ${run.agents}` : ''}`,
          brief ?? 'Given its work by the workflow run. Open the task to read what it was asked and what it returned.',
          false,
        );
        task.status = 'running';
        task.threadId = threadId;
        task.startedAt = now();
        task.attempts = 1;
        phase.tasks.push(task);
      } else {
        // One of the lead's own agents. It keeps its number for the whole plan.
        if (!managed.agents.includes(threadId)) managed.agents.push(threadId);
        const text = clean(brief ?? '', 4000);
        if (!text) return;
        // Something this agent was already given, heard again when the session's history is re-read.
        const known = plan.phases.some((p) => p.tasks.some((t) => t.threadId === threadId && (t.brief === text || t.brief.includes(text.slice(0, 200)))));
        if (known) return;
        if (latest?.status === 'running') {
          // More from the lead while the agent is still on its task: part of the same task.
          latest.brief = clean(`${latest.brief}\n\n[The lead added]\n${text}`, 4000);
          changed();
          return;
        }
        if (phase.tasks.length >= MAX_TASKS_PER_PHASE) return;
        const task = newTask(org, titleOf(text), text, false);
        task.status = 'running';
        task.threadId = threadId;
        task.agent = managed.agents.indexOf(threadId) + 1;
        task.startedAt = now();
        task.attempts = 1;
        phase.tasks.push(task);
      }
      if (phase.status === 'pending') phase.status = 'working';
      changed();
    },

    reported(threadId, text) {
      const task = latestTask(plan, threadId);
      if (!task) return;
      const report = text.trim().slice(0, MAX_RESULT_CHARS) || '(The agent gave no report.)';
      // A report already on record for this agent, heard again when the session's history is re-read.
      const known = plan.phases.some((p) => p.tasks.some((t) => t.threadId === threadId && !!t.result && (t.result === report || t.result.includes(report.slice(0, 200)))));
      if (known) return;
      if (task.status === 'running') {
        task.status = 'done';
        task.result = report;
        task.error = null;
        task.finishedAt = now();
      } else if (!task.result) {
        task.result = report;
      } else {
        task.result = `${task.result}\n\n${report}`.slice(0, MAX_RESULT_CHARS);
      }
      changed();
    },

    agentEnded(threadId, how, detail) {
      const task = latestTask(plan, threadId);
      if (!task || task.status !== 'running') return;
      task.finishedAt = now();
      if (how === 'finished') {
        task.status = 'done';
      } else {
        task.status = 'failed';
        task.error = clean(detail ?? 'The agent stopped before it had finished.', 400);
      }
      changed();
    },

    run(update) {
      let run = managed.runs.find((r) => r.id === update.id);
      if (!run) {
        if (update.event !== 'created') return;
        const index = plan.phases.findIndex((p) => p.status !== 'done');
        run = {
          id: update.id,
          name: clean(update.name ?? 'Workflow run', 80),
          description: update.description ? clean(update.description, 300) : null,
          status: 'running',
          error: null,
          steps: (update.steps ?? []).slice(0, 30).map((s) => ({ id: s.id, name: clean(s.name, 80), status: 'pending' as const })),
          agents: 0,
          phaseIndex: index < 0 ? plan.phases.length - 1 : index,
          startedAt: now(),
          endedAt: null,
        };
        managed.runs.push(run);
        if (managed.runs.length > MAX_RUNS_KEPT) managed.runs.splice(0, managed.runs.length - MAX_RUNS_KEPT);
        changed();
        return;
      }
      const ended = run.status === 'completed' || run.status === 'stopped' || run.status === 'failed';
      switch (update.event) {
        case 'created':
          return;
        case 'running':
          if (!ended) run.status = 'running';
          break;
        case 'paused':
          if (!ended) run.status = 'paused';
          break;
        case 'step_started':
        case 'step_ended': {
          let step = run.steps.find((s) => s.id === update.stepId);
          if (!step && update.stepId && run.steps.length < 30) {
            step = { id: update.stepId, name: 'Step', status: 'pending' };
            run.steps.push(step);
          }
          if (step) step.status = update.event === 'step_started' && step.status !== 'done' ? 'running' : update.event === 'step_ended' ? 'done' : step.status;
          break;
        }
        case 'ended':
          run.status = update.result ?? 'completed';
          run.error = update.error ? clean(update.error, 400) : run.error;
          run.endedAt ??= now();
          for (const step of run.steps) if (step.status === 'running') step.status = 'done';
          break;
      }
      changed();
    },

    spend(total) {
      const t = managed.tokens;
      const delta = {
        costUsd: Math.max(0, total.costUsd - managed.spentUsd),
        inputTokens: Math.max(0, total.inputTokens - t.input),
        outputTokens: Math.max(0, total.outputTokens - t.output),
        cacheReadTokens: Math.max(0, total.cacheReadTokens - t.cacheRead),
        cacheWriteTokens: Math.max(0, total.cacheWriteTokens - t.cacheWrite),
        webSearches: Math.max(0, total.webSearches - t.webSearches),
      };
      if (!Object.values(delta).some((n) => n > 0)) return;
      managed.spentUsd = Math.max(managed.spentUsd, total.costUsd);
      managed.tokens = {
        input: Math.max(t.input, total.inputTokens),
        output: Math.max(t.output, total.outputTokens),
        cacheRead: Math.max(t.cacheRead, total.cacheReadTokens),
        cacheWrite: Math.max(t.cacheWrite, total.cacheWriteTokens),
        webSearches: Math.max(t.webSearches, total.webSearches),
      };
      ctx.recordSpend(lead.id, models, delta);
    },

    note(text) {
      const note = clean(text, 600);
      if (!note || note === managed.note) return;
      managed.note = note;
      ctx.touch();
    },

    declined(tool, detail) {
      managed.declined += 1;
      managed.lastDeclined = clean(`${tool}: ${detail}`, 300);
      ctx.touch();
    },

    async output(file) {
      let rel: string;
      try {
        rel = workspace.normalise(outputPath(file.name, team));
        // A name can climb out of the team's directory and still be inside the workspace ("../marketing/plan.md"),
        // where it would replace another team's file.
        if (!rel.startsWith(`${team}/`)) throw new WorkspaceError(`path leaves ${team}/`);
        const written = await workspace.writeBytes(rel, file.bytes);
        rel = written.path;
      } catch (err) {
        // A file that cannot be written here (a path that would leave the workspace, a name that is already a
        // folder, a full disk) is left in the session and noted. It is no reason to stop the plan, and not
        // worth asking for again: it would fail the same way.
        const reason = err instanceof WorkspaceError ? err.message : ((err as NodeJS.ErrnoException).code ?? (err as Error).message);
        managed.synced[file.id] = file.bytes.length;
        managed.note = clean(`A file the session produced could not be kept (${file.name}): ${reason}`, 600);
        ctx.touch();
        return null;
      }
      managed.synced[file.id] = file.bytes.length;
      if (!managed.files.includes(rel)) {
        managed.files.push(rel);
        if (managed.files.length > MAX_FILES_KEPT) managed.files.splice(0, managed.files.length - MAX_FILES_KEPT);
      }
      changed();
      return rel;
    },

    hasOutput(file) {
      return managed.synced[file.id] === file.size;
    },

    instructions() {
      const pending = pendingInstructions();
      return pending.length ? { message: prompts.sessionInstructions(pending), instructions: plan.amendments.length } : null;
    },

    instructed(upTo) {
      const sent = Math.max(managed.instructionsSent, Math.min(plan.amendments.length, upTo));
      if (sent === managed.instructionsSent) return;
      managed.instructionsSent = sent;
      ctx.touch();
    },

    halt() {
      if (!isPlanActive(plan) || plan.status !== 'executing' || plan.execution !== 'managed' || !execById(org, lead.id)) return 'cancel';
      if (ctx.halting() || org.status !== 'running' || ctx.overBudget()) return 'pause';
      // The budget has been lowered since the session's cap was worked out. The platform still holds the session
      // to the old cap, which may be more than the budget now has left for it. The session is held, and is picked
      // up again with a cap worked out from the budget as it stands.
      if (org.settings.budgetUsd < budgetThen) return 'pause';
      return null;
    },

    moreBudget(spentUsd) {
      budgetThen = org.settings.budgetUsd;
      const more = sessionAllowance(org, plan, spentUsd);
      if (more !== null) {
        managed.budgetUsd = more;
        ctx.touch();
      }
      return more;
    },

    checkpoint(readFrom, handledTo) {
      if (!managed.cursor || readFrom > managed.cursor) managed.cursor = readFrom;
      if (!managed.handledTo || handledTo > managed.handledTo) managed.handledTo = handledTo;
    },
  };

  let outcome: PlanOutcome;
  try {
    const files = mountable(await workspace.list());
    const web = org.settings.webResearch && allows(org, lead.id, 'web_search');
    const job: PlanJob = {
      planId: plan.id,
      title: `${org.name} · ${lead.short}: ${plan.objective}`.slice(0, 120),
      system: prompts.sessionSystem(org, lead),
      // The kickoff states every instruction the board has given so far.
      kickoff: { message: prompts.sessionKickoff(org, lead, plan, files) + '\n\n' + businessContext(org), instructions: plan.amendments.length },
      resume: () => ({ message: prompts.sessionResume(org, lead, plan, pendingInstructions()) + '\n\n' + businessContext(org), instructions: plan.amendments.length }),
      executiveModel: org.settings.executiveModel,
      executiveEffort: org.settings.executiveEffort,
      workerModel: org.settings.workerModel,
      workerEffort: org.settings.workerEffort,
      worker: { name: prompts.TEAM_AGENT_NAME, system: prompts.teamAgentSystem(web) },
      web,
      workflows: org.settings.workflowRuns,
      // A session that takes over from one that was lost starts from nothing. What the lost one spent is in the
      // organisation's totals, and is not the new one's to spend again: its cap is the plan's share and no more.
      budgetUsd: managed.sessionId ? cap : Math.round((cap - managed.spentUsd) * 100) / 100,
      session: managed.sessionId
        ? {
            id: managed.sessionId,
            cursor: managed.cursor,
            handled: managed.handledTo ?? managed.cursor,
            openRuns: managed.runs.filter((r) => r.status === 'running' || r.status === 'paused').map((r) => r.id),
            runThreads: plan.phases.flatMap((p) => p.tasks).flatMap((t) => (t.threadId && t.agent === null ? [t.threadId] : [])),
            reported: managed.pendingReport !== null,
          }
        : null,
      files: files.map((f) => ({ ...f, absolutePath: path.join(workspace.root, f.path) })),
      stateDir: ctx.stateDir,
      signal: ctx.signal,
      hooks,
      context: {
        seat: {
          id: lead.id,
          kind: lead.kind,
          short: lead.short,
          title: lead.title,
          function: lead.function,
          agentCount: lead.agentCount,
          phases: lead.phases.map((p) => ({ id: p.id, name: p.name, deliverable: p.deliverable })),
        },
        cycle: org.cycle.number,
        organisation: org.name,
        mission: org.mission,
        dir: team,
        plan: { id: plan.id, owner: lead.short, ownerId: lead.id, objective: plan.objective, depth: plan.depth },
        phases: plan.phases.map((p) => ({ id: p.sopPhaseId, name: p.name, deliverable: p.deliverable, done: p.status === 'done' })),
        maxTasks: org.settings.maxTasksPerPhase,
      },
    };
    outcome = await provider.executePlan(job);
  } catch (err) {
    // The session, if there is one, is still there and can be picked up again.
    if (managed.state === 'starting' || managed.state === 'running') managed.state = 'paused';
    if (!capConfirmed) managed.budgetUsd = capBefore;
    ctx.touch();
    throw err;
  }

  return () => {
    const lose = (reason: string) => {
      closeOpenWork(plan, managed, 'failed', 'The session ended before this was finished.');
      managed.pendingReport = null;
      // The session is given up, not forgotten: it is still there on the provider's side.
      if (managed.sessionId) (managed.past ??= []).push({ sessionId: managed.sessionId, archivedAt: managed.archivedAt ?? null });
      managed.archivedAt = null;
      managed.sessionId = null;
      managed.budgetUsd = 0;
      managed.state = 'paused';
      if (plan.status !== 'executing') return;
      managed.attempts += 1;
      if (managed.attempts < MAX_SESSIONS_PER_PLAN) {
        postToBoard(
          org,
          'system',
          'system',
          `${lead.short} session ended early`,
          `The session carrying out the ${lead.short} plan ended before the lead reported: ${reason} A new session takes over from the phases already recorded.`,
          { planId: plan.id },
        );
        return;
      }
      // Stop here rather than start session after session. Starting the organisation again gives the plan a fresh set of tries.
      managed.attempts = 0;
      throw new ProviderError(`The ${lead.short} plan could not be carried through in a hosted session: ${reason}`, 'unavailable', false);
    };

    switch (outcome.status) {
      case 'reported': {
        const report = managed.pendingReport;
        if (plan.status !== 'executing') {
          closeOpenWork(plan, managed, 'done', null);
          managed.state = 'finished';
          return;
        }
        if (!report || plan.phases.some((p) => p.status !== 'done')) return lose('it finished without a complete report.');
        closeOpenWork(plan, managed, 'done', null);
        managed.state = 'finished';
        managed.pendingReport = null;
        fileReport(org, plan, lead, report, managed.files);
        return;
      }
      case 'paused':
        managed.state = 'paused';
        // A session is only held when the organisation asks for it. One that stopped being followed for no
        // reason is picked up again, but as a failure, so that it is retried with a delay and not in a loop.
        if (hooks.halt() === null) throw new ProviderError('The session stopped being followed before the plan was finished.', 'unavailable', true);
        return;
      case 'at_budget':
        managed.state = 'at_budget';
        return;
      case 'cancelled':
        closeOpenWork(plan, managed, 'failed', 'The plan was cancelled.');
        managed.state = 'finished';
        return;
      case 'lost': {
        // A report the lead has already made, with every phase recorded, stands whatever became of the session
        // afterwards. Its files came home as each phase was recorded; only a last look for more was missed.
        const report = managed.pendingReport;
        if (plan.status !== 'executing' || !report || plan.phases.some((p) => p.status !== 'done')) return lose(outcome.reason);
        closeOpenWork(plan, managed, 'done', null);
        managed.state = 'finished';
        managed.pendingReport = null;
        fileReport(org, plan, lead, report, managed.files);
        return;
      }
    }
  };
}
