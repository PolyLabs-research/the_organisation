import { afterEach, describe, expect, it } from 'vitest';
import type { Organisation, Plan } from '../src/shared/types';
import { findPhase, outputPath } from '../src/server/engine/hosted';
import { sessionAllowance, toClientView } from '../src/server/engine/state';
import { MockProvider } from '../src/server/providers/mock';
import { ProviderError, type PlanJob, type PlanOutcome, type Provider } from '../src/server/providers/types';
import { Registry } from '../src/server/registry';
import { QUIET, harness, plansOf, runToRest, waitFor, type Harness } from './helpers';

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const HOSTED = { execution: 'managed' as const };
const ONE_LEAD = [{ profileId: 'engineering', agentCount: 2 }];

/** A simulator whose hosted sessions are acted out by the test. */
class Scripted extends MockProvider {
  constructor(private readonly script: (job: PlanJob) => Promise<PlanOutcome>) {
    super(QUIET);
  }
  override executePlan(job: PlanJob): Promise<PlanOutcome> {
    return this.script(job);
  }
}

const planOf = (org: Organisation, ownerId = 'cto'): Plan => org.plans.find((p) => p.ownerId === ownerId)!;

describe('a plan carried out in a hosted session', () => {
  it('applies business updates at a phase gate once, including after a replay', async () => {
    const provider = new Scripted(async (job) => {
      job.hooks.session({ id: 'business-session', consoleUrl: null, budgetUsd: job.budgetUsd });
      const phases = job.context.phases as Array<{ name: string }>;
      const first = { phase: phases[0]!.name, summary: 'Reviewed the evidence.', decisions: [], operations: [{
        kind: 'memory', record: { ownerId: 'cto', title: 'Hosted lesson', category: 'lesson', content: 'The phase gate keeps shared knowledge current.', source: 'Hosted check' },
      }] };
      expect(job.hooks.phase(first).ok).toBe(true);
      expect(job.hooks.phase(first).ok).toBe(true);
      for (const phase of phases.slice(1)) job.hooks.phase({ phase: phase.name, summary: 'Checked.', decisions: [] });
      job.hooks.report({ headline: 'Delivered', summary: 'Checked in the scripted hosted session.', outcomes: [], asks: [] });
      return { status: 'reported' };
    });
    h = await harness({ provider, settings: HOSTED, executives: ONE_LEAD });
    await runToRest(h.runner);
    expect(h.org.business.memory.filter((m) => m.title === 'Hosted lesson')).toHaveLength(1);
    expect(h.org.business.jobs[0]!.status).toBe('review');
  });

  it('runs every phase of the operating profile in one session per plan and reports to the board', async () => {
    h = await harness({ settings: HOSTED });
    await runToRest(h.runner);
    const { org } = h;

    expect(org.lastError).toBeNull();
    expect(org.pauseReason).toBe('cycle_limit');
    const plans = plansOf(org, 1);
    expect(plans).toHaveLength(3);
    for (const plan of plans) {
      const owner = org.executives.find((e) => e.id === plan.ownerId)!;
      expect(plan.execution).toBe('managed');
      expect(plan.status).toBe('done');
      expect(plan.managed?.state).toBe('finished');
      expect(plan.managed?.sessionId).toBeTruthy();
      expect(plan.managed?.pendingReport).toBeNull();
      expect(plan.phases.map((p) => p.name)).toEqual(owner.phases.map((p) => p.name));
      for (const phase of plan.phases) {
        expect(phase.status).toBe('done');
        expect(phase.summary).toBeTruthy();
        expect(phase.tasks.length).toBeGreaterThan(0);
        for (const task of phase.tasks) {
          expect(task.status).toBe('done');
          expect(task.threadId).toBeTruthy();
          // The lead's own agents are numbered within its allocation; a run's agents carry no number.
          if (task.agent !== null) expect(task.agent).toBeLessThanOrEqual(owner.agentCount);
        }
      }
      const report = org.reports.find((r) => r.id === plan.reportId)!;
      expect(report.fromId).toBe(plan.ownerId);
      expect(report.files.length).toBeGreaterThan(0);
      expect(report.files).toEqual(plan.managed!.files.slice(0, 40));
    }

    // What the sessions produced is in the workspace, each team's files in its own directory.
    const files = await h.runner.workspace.list();
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((f) => /^(engineering|product|marketing)\//.test(f.path))).toBe(true);
    for (const plan of plans) for (const file of plan.managed!.files) expect(files.some((f) => f.path === file)).toBe(true);

    // Spend is what the sessions reported, added to the organisation's totals and to each lead's.
    const sessions = plans.reduce((sum, p) => sum + p.managed!.spentUsd, 0);
    expect(sessions).toBeGreaterThan(0);
    expect(org.usage.costUsd).toBeGreaterThan(sessions);
    expect(org.usageByExec.cto!.costUsd).toBeGreaterThanOrEqual(planOf(org).managed!.spentUsd);
    expect(org.board.filter((m) => m.type === 'report')).toHaveLength(3);
  });

  it('keeps each of the lead\'s agents on its number from phase to phase', async () => {
    h = await harness({ settings: HOSTED, executives: ONE_LEAD, mock: { runs: 'never' } });
    await runToRest(h.runner);
    const plan = planOf(h.org);
    expect(plan.managed!.agents).toHaveLength(2);
    for (const phase of plan.phases) {
      expect(phase.tasks.map((t) => t.agent)).toEqual([1, 2]);
      expect(phase.tasks.map((t) => t.threadId)).toEqual(plan.managed!.agents);
    }
  });

  it('records a workflow run the lead starts, its steps and the agents it used', async () => {
    h = await harness({ settings: HOSTED, executives: ONE_LEAD });
    await runToRest(h.runner);
    const plan = planOf(h.org);
    expect(plan.managed!.runs).toHaveLength(1);
    const run = plan.managed!.runs[0]!;
    expect(run.status).toBe('completed');
    expect(run.phaseIndex).toBe(2);
    expect(run.steps.map((s) => s.status)).toEqual(['done', 'done']);
    expect(run.agents).toBe(4);
    const runTasks = plan.phases[2]!.tasks.filter((t) => t.agent === null);
    expect(runTasks).toHaveLength(4);
    expect(runTasks.every((t) => t.status === 'done' && t.title.startsWith(run.name))).toBe(true);
  });

  it('starts no workflow run when the organisation has them switched off, and tells the lead so', async () => {
    let system = '';
    let allowed: boolean | undefined;
    class Watching extends MockProvider {
      override executePlan(job: PlanJob): Promise<PlanOutcome> {
        system = job.system;
        allowed = job.workflows;
        return super.executePlan(job);
      }
    }
    h = await harness({ settings: { ...HOSTED, workflowRuns: false }, executives: ONE_LEAD, provider: new Watching(QUIET) });
    await runToRest(h.runner);
    const plan = planOf(h.org);
    expect(plan.status).toBe('done');
    expect(plan.managed!.runs).toEqual([]);
    expect(plan.phases[2]!.tasks.every((t) => t.agent !== null)).toBe(true);
    expect(allowed).toBe(false);
    expect(system).toContain('You cannot start workflow runs in this organisation.');
    expect(system).not.toContain('start a workflow run for that phase');
  });

  it('takes phases strictly in order and no report before the last one is recorded', async () => {
    const replies: Array<{ ok: boolean; message: string }> = [];
    h = await harness({
      settings: HOSTED,
      executives: ONE_LEAD,
      provider: new Scripted(async ({ hooks }) => {
        hooks.session({ id: 'sesn_test', consoleUrl: null, budgetUsd: 5 });
        replies.push(hooks.report({ headline: 'Done', summary: 'All done.', outcomes: [], asks: [] })); // too early
        replies.push(hooks.phase({ phase: 'Build', summary: 'Built.', decisions: [] })); // out of order
        replies.push(hooks.phase({ phase: 'Deploy', summary: 'Deployed.', decisions: [] })); // not a phase
        replies.push(hooks.phase({ phase: 'Spec', summary: '', decisions: [] })); // nothing to record
        replies.push(hooks.phase({ phase: 'the Spec phase', summary: 'Specified.', decisions: [{ title: 'Scope', decision: 'One city.', rationale: 'Cheaper.' }] }));
        replies.push(hooks.phase({ phase: 'spec', summary: 'Again.', decisions: [] })); // heard twice
        replies.push(hooks.phase({ phase: 'phase 2', summary: 'Built.', decisions: [] }));
        replies.push(hooks.phase({ phase: 'Test', summary: 'Tested.', decisions: [] }));
        replies.push(hooks.report({ headline: 'Done', summary: 'All done.', outcomes: [], asks: [] })); // one phase short
        replies.push(hooks.phase({ phase: 'Release', summary: 'Released.', decisions: [] }));
        replies.push(hooks.report({ headline: 'Shipped', summary: 'The plan is delivered.', outcomes: ['It works.'], asks: [] }));
        return { status: 'reported' };
      }),
    });
    await runToRest(h.runner);

    expect(replies.map((r) => r.ok)).toEqual([false, false, false, false, true, true, true, true, false, true, true]);
    expect(replies[1]!.message).toContain('Spec comes before it');
    expect(replies[2]!.message).toContain('Spec is the next to record');
    expect(replies[5]!.message).toContain('already recorded');
    expect(replies[8]!.message).toContain('Release');
    const plan = planOf(h.org);
    expect(plan.status).toBe('done');
    expect(plan.phases.map((p) => p.summary)).toEqual(['Specified.', 'Built.', 'Tested.', 'Released.']);
    expect(h.org.reports.find((r) => r.id === plan.reportId)?.headline).toBe('Shipped');
    // The decision the lead recorded with the phase is in the register, once.
    expect(h.org.decisions.filter((d) => d.kind === 'in_remit' && d.title === 'Scope')).toHaveLength(1);
  });

  it('leaves the report to the board to the lead in its session', async () => {
    // Every phase is recorded some time before the lead reports. Nothing else may write the report meanwhile.
    let recorded = false;
    let go = () => {};
    const waiting = new Promise<void>((resolve) => (go = resolve));
    h = await harness({
      settings: HOSTED,
      executives: ONE_LEAD,
      provider: new Scripted(async ({ hooks, context }) => {
        hooks.session({ id: 'sesn_test', consoleUrl: null, budgetUsd: 5 });
        for (const phase of context.phases as Array<{ name: string }>) hooks.phase({ phase: phase.name, summary: 'Done.', decisions: [] });
        recorded = true;
        await waiting;
        hooks.report({ headline: 'From the session', summary: 'What the lead itself reported.', outcomes: [], asks: [] });
        return { status: 'reported' };
      }),
    });
    h.runner.start();
    await waitFor(() => recorded, 'the phases to be recorded');
    // Have the organisation look at what work is ready, as it does whenever anything finishes.
    h.runner.updateSettings({});
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(planOf(h.org).status).toBe('executing');
    go();
    await h.runner.idle();
    expect(h.org.reports).toHaveLength(1);
    expect(h.org.reports[0]!.headline).toBe('From the session');
  });

  it('puts what a session produced inside the team\'s own directory, wherever the session said it was', async () => {
    const paths: Array<string | null> = [];
    const known: boolean[] = [];
    h = await harness({
      settings: HOSTED,
      executives: ONE_LEAD,
      provider: new Scripted(async ({ hooks }) => {
        hooks.session({ id: 'sesn_test', consoleUrl: null, budgetUsd: 5 });
        const bytes = new TextEncoder().encode('content');
        paths.push(await hooks.output({ id: 'f1', name: 'spec.md', bytes }));
        paths.push(await hooks.output({ id: 'f2', name: 'engineering/build.md', bytes }));
        paths.push(await hooks.output({ id: 'f3', name: '/mnt/session/outputs/engineering/test.md', bytes }));
        paths.push(await hooks.output({ id: 'f4', name: 'marketing/plan.md', bytes }));
        paths.push(await hooks.output({ id: 'f5', name: '../../etc/passwd', bytes }));
        // A name that is already a folder here cannot be written, and that must not stop the plan.
        paths.push(await hooks.output({ id: 'f6', name: 'engineering/marketing', bytes }));
        known.push(hooks.hasOutput({ id: 'f1', size: bytes.length }), hooks.hasOutput({ id: 'f1', size: bytes.length + 1 }));
        while (hooks.halt() === null) await new Promise((resolve) => setTimeout(resolve, 2));
        return { status: 'paused' };
      }),
    });
    h.runner.start();
    await waitFor(() => known.length === 2, 'the outputs');
    h.runner.pause();
    await h.runner.idle();
    expect(known).toEqual([true, false]);

    expect(paths).toEqual(['engineering/spec.md', 'engineering/build.md', 'engineering/test.md', 'engineering/marketing/plan.md', null, null]);
    const files = (await h.runner.workspace.list()).map((f) => f.path);
    expect(files).toEqual(['engineering/build.md', 'engineering/marketing/plan.md', 'engineering/spec.md', 'engineering/test.md']);
    expect(planOf(h.org).managed!.note).toContain('could not be kept');
  });
});

describe('a hosted session and the organisation\'s controls', () => {
  it('is held when the organisation is paused, and carries on from where it was', async () => {
    h = await harness({ settings: HOSTED, executives: ONE_LEAD, mock: { delayMs: 2, runs: 'never' } });
    h.runner.start();
    await waitFor(() => planOf(h!.org)?.phases[1]?.status === 'working', 'the second phase to be under way');
    h.runner.pause();
    await h.runner.idle();

    const plan = planOf(h.org);
    expect(plan.status).toBe('executing');
    expect(plan.managed!.state).toBe('paused');
    // Held means capped at what it has spent, so nothing more can be spent while nobody is following it.
    expect(plan.managed!.budgetUsd).toBeLessThanOrEqual(plan.managed!.spentUsd + 0.021);
    const session = plan.managed!.sessionId;
    const recorded = plan.phases.filter((p) => p.status === 'done').length;
    expect(recorded).toBeGreaterThanOrEqual(1);
    expect(recorded).toBeLessThan(4);

    await runToRest(h.runner);
    expect(plan.status).toBe('done');
    expect(plan.managed!.sessionId).toBe(session);
    // Nothing was handed out twice.
    for (const phase of plan.phases) expect(phase.tasks).toHaveLength(2);
  });

  it('is held at once when the organisation is stopped', async () => {
    h = await harness({ settings: HOSTED, executives: ONE_LEAD, mock: { delayMs: 20, runs: 'never' } });
    h.runner.start();
    await waitFor(() => planOf(h!.org)?.managed?.state === 'running', 'the session');
    h.runner.stop();
    await h.runner.idle(2000);
    const plan = planOf(h.org);
    expect(plan.managed!.state).toBe('paused');
    expect(plan.status).toBe('executing');

    h.runner.updateSettings({ maxConcurrentCalls: 4 });
    await runToRest(h.runner);
    expect(plan.status).toBe('done');
  });

  it('comes back after a restart and picks the same session up again', async () => {
    h = await harness({ settings: HOSTED, executives: ONE_LEAD, mock: { delayMs: 2, runs: 'never' } });
    h.runner.start();
    await waitFor(() => planOf(h!.org)?.phases[0]?.status === 'done', 'the first phase');
    await h.runner.flush();
    const session = planOf(h.org).managed!.sessionId;

    // A new process: the state on disk still says the session was running.
    const registry = new Registry(h.store, new MockProvider({ ...QUIET, runs: 'never' }), { retryDelayMs: 1, emitIntervalMs: 1 });
    await registry.load();
    const revived = registry.get(h.org.id)!;
    expect(revived.org.status).toBe('paused');
    expect(revived.org.pauseReason).toBe('restart');
    expect(planOf(revived.org).managed!.state).toBe('paused');

    h.runner.stop();
    await h.runner.idle();
    await runToRest(revived);
    const plan = planOf(revived.org);
    expect(plan.status).toBe('done');
    expect(plan.managed!.sessionId).toBe(session);
    revived.dispose();
  });

  it('is told of binding instructions the board gives while it runs', async () => {
    h = await harness({ settings: HOSTED, executives: ONE_LEAD, mock: { delayMs: 3, runs: 'never' } });
    h.runner.start();
    await waitFor(() => planOf(h!.org)?.phases[0]?.status === 'done', 'the first phase');
    h.runner.steer('Keep the first version to one city.');
    await h.runner.idle();

    const plan = planOf(h.org);
    expect(plan.status).toBe('done');
    expect(plan.amendments).toHaveLength(1);
    expect(plan.managed!.instructionsSent).toBe(1);
  });

  it('is ended when the CEO cancels its plan', async () => {
    h = await harness({ settings: HOSTED, executives: ONE_LEAD, mock: { delayMs: 3, runs: 'never' } });
    h.runner.start();
    await waitFor(() => planOf(h!.org)?.phases[0]?.status === 'done', 'the first phase');
    h.runner.steer('Stop the engineering work.');
    await h.runner.idle();

    const plan = planOf(h.org);
    expect(plan.status).toBe('cancelled');
    expect(plan.managed!.state).toBe('finished');
    expect(plan.reportId).toBeNull();
    expect(plan.phases.flatMap((p) => p.tasks).some((t) => t.status === 'running')).toBe(false);
  });

  it('does not hold up the board: its calls go on while sessions run, whatever the limit on calls', async () => {
    h = await harness({ settings: { ...HOSTED, maxConcurrentCalls: 1 }, mock: { delayMs: 3, runs: 'never' } });
    h.runner.start();
    await waitFor(() => plansOf(h!.org, 1).filter((p) => p.managed?.state === 'running').length === 3, 'three sessions to be running at once');
    h.runner.steer('Keep everything to one city.');
    await waitFor(() => h!.org.steers[0]!.status === 'acknowledged', 'the CEO to answer the steer');
    // The CEO answered while the plans were still being carried out.
    expect(plansOf(h.org, 1).some((p) => p.status === 'executing')).toBe(true);
    await h.runner.idle();
    expect(h.org.lastError).toBeNull();
  });
});

describe('a hosted session and money', () => {
  it('is capped so that sessions together cannot be promised more than the budget has left', async () => {
    const caps: number[] = [];
    class Watching extends MockProvider {
      override executePlan(job: PlanJob): Promise<PlanOutcome> {
        caps.push(job.budgetUsd);
        return super.executePlan(job);
      }
    }
    h = await harness({ settings: { ...HOSTED, budgetUsd: 6 }, provider: new Watching({ ...QUIET, delayMs: 2, runs: 'never' }) });
    await runToRest(h.runner);

    expect(caps).toHaveLength(3);
    // Each plan got an equal share of what was left when the sessions started.
    expect(Math.max(...caps) - Math.min(...caps)).toBeLessThan(0.02);
    expect(caps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(6);
    expect(h.org.usage.costUsd).toBeLessThan(6);
    expect(plansOf(h.org, 1).every((p) => p.status === 'done')).toBe(true);
  });

  it('stops at its cap, pauses the organisation, and carries on in the same session once the budget is raised', async () => {
    h = await harness({ settings: { ...HOSTED, budgetUsd: 0.4 }, executives: ONE_LEAD, mock: { runs: 'never' } });
    await runToRest(h.runner);
    const { org } = h;
    const plan = planOf(org);

    expect(org.pauseReason).toBe('budget');
    expect(plan.status).toBe('executing');
    expect(plan.managed!.state).toBe('at_budget');
    // The session spent up to its cap and one request past it at most, and the organisation stayed inside its budget.
    expect(plan.managed!.spentUsd).toBeLessThan(plan.managed!.budgetUsd + 0.06);
    expect(org.usage.costUsd).toBeLessThan(0.4 + 0.06);
    expect(org.board.at(-1)?.title).toBe('Budget reached');
    const session = plan.managed!.sessionId;

    // With too little left for the session to go on, starting again is refused rather than pausing straight away.
    expect(() => h!.runner.start()).toThrow(/budget/i);

    h.runner.updateSettings({ budgetUsd: 20 });
    await runToRest(h.runner);
    expect(plan.status).toBe('done');
    expect(plan.managed!.sessionId).toBe(session);
    expect(org.board.filter((m) => m.title === 'Budget reached')).toHaveLength(1);
  });

  it('waits for money another session was promised and has not spent, rather than stopping the organisation', async () => {
    const log: string[] = [];
    let dry = false;
    const none = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, webSearches: 0 };
    const finish = (job: PlanJob): PlanOutcome => {
      for (const phase of job.context.phases as Array<{ name: string }>) job.hooks.phase({ phase: phase.name, summary: 'Done.', decisions: [] });
      job.hooks.report({ headline: 'Done', summary: 'Done.', outcomes: [], asks: [] });
      return { status: 'reported' };
    };
    h = await harness({
      settings: { ...HOSTED, budgetUsd: 2 },
      executives: [{ profileId: 'engineering' }, { profileId: 'product' }],
      provider: new Scripted(async (job) => {
        const who = (job.context.seat as { id: string }).id;
        job.hooks.session({ id: job.session?.id ?? `sesn_${who}`, consoleUrl: null, budgetUsd: job.budgetUsd });
        if (who === 'cto') {
          if (job.session) {
            log.push(`cto carried on with a cap of ${job.budgetUsd > 1.5 ? 'more than 1.50' : job.budgetUsd}`);
            return finish(job);
          }
          // Spends all it was given, then asks for more while the other session still holds its share.
          job.hooks.spend({ costUsd: job.budgetUsd, ...none });
          log.push(`cto asked for more and got ${job.hooks.moreBudget(job.budgetUsd)}`);
          dry = true;
          return { status: 'at_budget' };
        }
        // The other session spends little, and ends only after the first has run dry.
        while (!dry) await new Promise((resolve) => setTimeout(resolve, 1));
        await new Promise((resolve) => setTimeout(resolve, 30));
        log.push(`cpo finished with the organisation ${h!.org.status}`);
        job.hooks.spend({ costUsd: 0.1, ...none });
        return finish(job);
      }),
    });
    await runToRest(h.runner);

    expect(log).toEqual(['cto asked for more and got null', 'cpo finished with the organisation running', 'cto carried on with a cap of more than 1.50']);
    expect(h.org.lastError).toBeNull();
    expect(h.org.pauseReason).toBe('cycle_limit');
    expect(plansOf(h.org, 1).map((p) => p.status)).toEqual(['done', 'done']);
    expect(h.org.board.some((m) => m.title === 'Budget reached')).toBe(false);
    expect(h.org.usage.costUsd).toBeLessThan(2);
  });

  it('shares what is left between the plans that will want a session', () => {
    const plan = (id: string, managed: Partial<NonNullable<Plan['managed']>> | null, status: Plan['status'] = 'executing') =>
      ({ id, status, execution: 'managed', managed }) as unknown as Plan;
    const org = (plans: Plan[], spent = 0) => ({ plans, settings: { budgetUsd: 10, execution: 'managed' }, usage: { costUsd: spent } }) as unknown as Organisation;

    const a = plan('a', null);
    const b = plan('b', null);
    const c = plan('c', null, 'planning');
    // Three plans, nothing spent or promised: a third each.
    expect(sessionAllowance(org([a, b, c]), a, 0)).toBeCloseTo(3.33, 2);
    // One session is live with a cap of 4, having spent 1: 3 is promised to it, and the rest is shared by the other two.
    const live = plan('a', { state: 'running', budgetUsd: 4, spentUsd: 1 });
    expect(sessionAllowance(org([live, b, c], 1), b, 0)).toBeCloseTo(3, 2);
    // A top-up is on top of what the session has already spent.
    expect(sessionAllowance(org([live, b], 1), live, 1)).toBeCloseTo(5.5, 2);
    // Plans that are finished want nothing.
    expect(sessionAllowance(org([a, plan('d', null, 'done')], 2), a, 0)).toBe(8);
    // Too little left to be worth a session.
    expect(sessionAllowance(org([a], 9.9), a, 0)).toBeNull();
  });
});

describe('a hosted session that goes wrong', () => {
  it('is replaced once by a new session that takes over from the phases already recorded', async () => {
    h = await harness({ settings: HOSTED, executives: ONE_LEAD, mock: { lostSessions: 1, runs: 'never' } });
    await runToRest(h.runner);
    const plan = planOf(h.org);
    expect(h.org.lastError).toBeNull();
    expect(plan.status).toBe('done');
    expect(plan.managed!.sessionId).toMatch(/_2$/);
    expect(h.org.board.some((m) => m.title === 'CTO session ended early')).toBe(true);
    // The record keeps what both sessions did in the phase the first one was lost in.
    expect(plan.phases[0]!.tasks.map((t) => t.threadId!.replace(/^.*_(\d):/, 'session $1, '))).toEqual([
      'session 1, agent1',
      'session 1, agent2',
      'session 2, agent1',
      'session 2, agent2',
    ]);
    expect(plan.managed!.agents).toHaveLength(2);
  });

  it('marks what a lost session left unfinished as failed, not as still running', async () => {
    let sessions = 0;
    h = await harness({
      settings: HOSTED,
      executives: ONE_LEAD,
      provider: new Scripted(async ({ hooks, context }) => {
        sessions += 1;
        hooks.session({ id: `sesn_${sessions}`, consoleUrl: null, budgetUsd: 5 });
        if (sessions === 1) {
          hooks.assigned({ threadId: 'sthr_a', agentName: 'Team agent', brief: 'Write the spec.', runId: null });
          hooks.run({ id: 'run_1', event: 'created', name: 'Sweep', steps: [{ id: 's1', name: 'Check' }] });
          hooks.run({ id: 'run_1', event: 'step_started', stepId: 's1' });
          hooks.assigned({ threadId: 'sthr_r', agentName: 'Team agent', brief: null, runId: 'run_1' });
          return { status: 'lost', reason: 'the sandbox was shut down.' };
        }
        for (const phase of context.phases as Array<{ name: string }>) hooks.phase({ phase: phase.name, summary: 'Done.', decisions: [] });
        hooks.report({ headline: 'Done', summary: 'Done.', outcomes: [], asks: [] });
        return { status: 'reported' };
      }),
    });
    await runToRest(h.runner);
    const plan = planOf(h.org);
    expect(plan.status).toBe('done');
    const [own, fromRun] = plan.phases[0]!.tasks;
    expect(own).toMatchObject({ title: 'Write the spec.', agent: 1, status: 'failed', error: 'The session ended before this was finished.' });
    expect(fromRun).toMatchObject({ title: 'Sweep: Team agent 1', agent: null, status: 'failed' });
    expect(plan.managed!.runs[0]).toMatchObject({ status: 'stopped', agents: 1, steps: [{ id: 's1', name: 'Check', status: 'done' }] });
    expect(h.org.board.find((m) => m.title === 'CTO session ended early')?.body).toContain('the sandbox was shut down.');
  });

  it('stops the organisation with the reason when a second session is lost too', async () => {
    h = await harness({ settings: HOSTED, executives: ONE_LEAD, mock: { lostSessions: 2, runs: 'never' } });
    await runToRest(h.runner);
    const plan = planOf(h.org);
    expect(h.org.pauseReason).toBe('error');
    expect(h.org.lastError).toContain('could not be carried through');
    expect(plan.status).toBe('executing');
    expect(plan.managed!.sessionId).toBeNull();

    // Starting again gives the plan a fresh session.
    await runToRest(h.runner);
    expect(plan.status).toBe('done');
    expect(plan.managed!.sessionId).toMatch(/_3$/);
  });

  it('is picked up again after a failure that may pass', async () => {
    let failures = 0;
    h = await harness({
      settings: HOSTED,
      executives: ONE_LEAD,
      mock: {
        runs: 'never',
        onCall: (kind, c) => {
          if (kind === 'session_phase' && (c.phase as { index: number }).index === 2 && failures++ === 0) {
            throw new ProviderError('The connection to the session dropped.', 'unavailable', true);
          }
        },
      },
    });
    await runToRest(h.runner);
    const plan = planOf(h.org);
    expect(failures).toBe(2);
    expect(h.org.lastError).toBeNull();
    expect(plan.status).toBe('done');
    expect(plan.managed!.sessionId).toMatch(/_1$/);
    for (const phase of plan.phases) expect(phase.tasks).toHaveLength(2);
  });
});

describe('archiving hosted sessions', () => {
  const sessionsOf = (org: Organisation) => org.plans.map((p) => p.managed!.sessionId!);

  it('leaves sessions as they are unless the organisation is set to archive them', async () => {
    h = await harness({ settings: HOSTED });
    await runToRest(h.runner);
    expect((h.provider as MockProvider).archived).toEqual([]);
    expect(h.org.plans.every((p) => p.managed!.archivedAt == null)).toBe(true);
  });

  it('archives each plan\'s session once the plan has reported, and not before', async () => {
    const states: string[] = [];
    h = await harness({
      settings: { ...HOSTED, archiveSessions: true },
      mock: {
        onCall: (kind, c) => {
          if (kind !== 'archive_session') return;
          const plan = h!.org.plans.find((p) => p.managed?.sessionId === c.sessionId)!;
          states.push(`${plan.status}, report ${plan.reportId ? 'filed' : 'missing'}`);
        },
      },
    });
    await runToRest(h.runner);
    const { org } = h;
    expect(states).toEqual(Array(3).fill('done, report filed'));
    expect([...(h.provider as MockProvider).archived].sort()).toEqual(sessionsOf(org).sort());
    expect(org.plans.every((p) => !!p.managed!.archivedAt)).toBe(true);
    expect(org.reports).toHaveLength(3);
  });

  it('archives the session of a plan the CEO cancelled', async () => {
    h = await harness({ settings: { ...HOSTED, archiveSessions: true }, executives: ONE_LEAD, mock: { delayMs: 3, runs: 'never' } });
    h.runner.start();
    await waitFor(() => planOf(h!.org)?.phases[0]?.status === 'done', 'the first phase');
    h.runner.steer('Stop the engineering work.');
    await h.runner.idle();
    const plan = planOf(h.org);
    expect(plan.status).toBe('cancelled');
    expect((h.provider as MockProvider).archived).toEqual([plan.managed!.sessionId]);
    expect(plan.managed!.archivedAt).toBeTruthy();
  });

  it('archives a session that was lost as well as the one that replaced it', async () => {
    h = await harness({ settings: { ...HOSTED, archiveSessions: true }, executives: ONE_LEAD, mock: { lostSessions: 1, runs: 'never' } });
    await runToRest(h.runner);
    const plan = planOf(h.org);
    expect(plan.status).toBe('done');
    expect(plan.managed!.past).toHaveLength(1);
    expect(plan.managed!.past![0]!.sessionId).toMatch(/_1$/);
    expect(plan.managed!.past![0]!.archivedAt).toBeTruthy();
    expect(plan.managed!.archivedAt).toBeTruthy();
    expect([...(h.provider as MockProvider).archived].sort()).toEqual([plan.managed!.past![0]!.sessionId, plan.managed!.sessionId].sort());
  });

  it('does not archive the session of a plan that is still under way', async () => {
    h = await harness({ settings: { ...HOSTED, archiveSessions: true }, executives: ONE_LEAD, mock: { delayMs: 3, runs: 'never' } });
    h.runner.start();
    await waitFor(() => planOf(h!.org)?.phases[0]?.status === 'done', 'the first phase');
    h.runner.pause();
    await h.runner.idle();
    // Held, not over: asking by hand changes nothing either.
    expect(await h.runner.archiveSessions()).toEqual({ archived: 0, left: 0 });
    expect((h.provider as MockProvider).archived).toEqual([]);
    await runToRest(h.runner);
    expect((h.provider as MockProvider).archived).toEqual([planOf(h.org).managed!.sessionId]);
  });

  it('tries again later when a session was still working', async () => {
    let busy = true;
    class Slow extends MockProvider {
      override async archiveSession(sessionId: string): Promise<'archived' | 'busy' | 'gone'> {
        return busy ? 'busy' : super.archiveSession(sessionId);
      }
    }
    const provider = new Slow({ ...QUIET, runs: 'never' });
    h = await harness({ settings: { ...HOSTED, archiveSessions: true, maxCycles: 2 }, executives: ONE_LEAD, provider });
    await runToRest(h.runner);
    const first = plansOf(h.org, 1)[0]!;
    expect(first.status).toBe('done');
    expect(first.managed!.archivedAt == null).toBe(true);

    busy = false;
    expect(await h.runner.archiveSessions()).toEqual({ archived: 2, left: 0 });
    expect(provider.archived).toHaveLength(2);
    expect(h.org.plans.every((p) => !!p.managed!.archivedAt)).toBe(true);
    // Nothing is asked twice.
    expect(await h.runner.archiveSessions()).toEqual({ archived: 0, left: 0 });
  });

  it('archives every session, open ones included, when an organisation set to archive is deleted', async () => {
    h = await harness({ settings: { ...HOSTED, archiveSessions: true }, executives: ONE_LEAD, mock: { delayMs: 3, runs: 'never' } });
    const provider = h.provider as MockProvider;
    h.runner.start();
    await waitFor(() => planOf(h!.org)?.phases[0]?.status === 'done', 'the first phase');
    const session = planOf(h.org).managed!.sessionId;
    expect(await h.registry.remove(h.org.id)).toBe(true);
    expect(provider.archived).toEqual([session]);
  });

  it('leaves the sessions of a deleted organisation alone when it was not set to archive', async () => {
    h = await harness({ settings: HOSTED, executives: ONE_LEAD, mock: { delayMs: 3, runs: 'never' } });
    const provider = h.provider as MockProvider;
    h.runner.start();
    await waitFor(() => planOf(h!.org)?.phases[0]?.status === 'done', 'the first phase');
    expect(await h.registry.remove(h.org.id)).toBe(true);
    expect(provider.archived).toEqual([]);
  });
});

describe('a provider that misbehaves', () => {
  it('is retried with a delay, then stopped, when it lets go of a session nobody asked it to hold', async () => {
    let calls = 0;
    h = await harness({
      settings: HOSTED,
      executives: ONE_LEAD,
      provider: new Scripted(async ({ hooks }) => {
        calls += 1;
        hooks.session({ id: 'sesn_test', consoleUrl: null, budgetUsd: 5 });
        return { status: 'paused' };
      }),
    });
    await runToRest(h.runner);
    expect(calls).toBe(3);
    expect(h.org.pauseReason).toBe('error');
    expect(h.org.lastError).toContain('stopped being followed');
    expect(planOf(h.org).managed!.state).toBe('paused');
  });
});

describe('choosing how plans are carried out', () => {
  it('fixes the way of working when a plan starts, and lets one that has not begun follow a change', async () => {
    h = await harness({ executives: ONE_LEAD, mock: { delayMs: 3, runs: 'never' } });
    h.runner.start();
    await waitFor(() => planOf(h!.org)?.phases[0]?.status === 'working', 'the plan to begin on this machine');
    h.runner.updateSettings({ execution: 'managed' });
    await h.runner.idle();
    // The plan had begun, so it finished the way it started.
    expect(planOf(h.org).execution).toBe('local');
    expect(planOf(h.org).managed).toBeNull();
    expect(planOf(h.org).status).toBe('done');

    h.runner.updateSettings({ maxCycles: 2 });
    await runToRest(h.runner);
    const second = plansOf(h.org, 2)[0]!;
    expect(second.execution).toBe('managed');
    expect(second.status).toBe('done');
  });

  it('carries plans out on this machine when the provider has no hosted sessions', async () => {
    const mock = new MockProvider({ ...QUIET, runs: 'never' });
    const local: Provider = { info: () => ({ ...mock.info(), managed: false }), structured: (req) => mock.structured(req), agent: (req) => mock.agent(req) };
    h = await harness({ settings: HOSTED, executives: ONE_LEAD, provider: local });
    await runToRest(h.runner);
    const plan = planOf(h.org);
    expect(h.org.lastError).toBeNull();
    expect(plan.execution).toBe('local');
    expect(plan.status).toBe('done');
    expect(plan.phases.every((p) => p.tasks.every((t) => t.files.length > 0))).toBe(true);
  });
});

describe('helpers for hosted sessions', () => {
  const plan = { phases: ['Spec', 'Build', 'Test', 'Release'].map((name) => ({ name, sopPhaseId: name.toLowerCase() })) } as unknown as Plan;

  it('works out which phase a lead means', () => {
    expect(findPhase(plan, 'Build')).toBe(1);
    expect(findPhase(plan, ' test ')).toBe(2);
    expect(findPhase(plan, 'Phase 4')).toBe(3);
    expect(findPhase(plan, '2')).toBe(1);
    expect(findPhase(plan, 'the Release phase')).toBe(3);
    expect(findPhase(plan, 'Build and Test')).toBe(-1);
    expect(findPhase(plan, 'latest')).toBe(-1);
    expect(findPhase(plan, 'phase 9')).toBe(-1);
    expect(findPhase(plan, '')).toBe(-1);
  });

  it('keeps a session\'s files inside the team directory', () => {
    expect(outputPath('spec.md', 'engineering')).toBe('engineering/spec.md');
    expect(outputPath('engineering/spec.md', 'engineering')).toBe('engineering/spec.md');
    expect(outputPath('/mnt/session/outputs/engineering/a/b.md', 'engineering')).toBe('engineering/a/b.md');
    expect(outputPath('engineering-notes.md', 'engineering')).toBe('engineering/engineering-notes.md');
    expect(outputPath('', 'engineering')).toBe('engineering/unnamed');
    expect(outputPath('engineering', 'engineering')).toBe('engineering/engineering');
  });

  it('leaves the bookkeeping of fetched files out of what the browser is sent', async () => {
    h = await harness({ settings: HOSTED, executives: ONE_LEAD, mock: { runs: 'never' } });
    await runToRest(h.runner);
    expect(Object.keys(planOf(h.org).managed!.synced).length).toBeGreaterThan(0);
    expect(toClientView(h.org).plans[0]!.managed!.synced).toEqual({});
  });
});
