import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CEO_QUESTION } from '../src/server/engine/state';
import { MockProvider } from '../src/server/providers/mock';
import { ProviderError, type AgentRequest, type AgentResult, type StructuredRequest } from '../src/server/providers/types';
import { Registry } from '../src/server/registry';
import { QUIET, harness, plansOf, runToRest, waitFor, type Harness } from './helpers';

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

describe('a cycle', () => {
  it('consults the leads, directs them, runs each plan through its operating profile and reports to the board', async () => {
    h = await harness();
    await runToRest(h.runner);
    const { org } = h;

    expect(org.status).toBe('paused');
    expect(org.pauseReason).toBe('cycle_limit');
    expect(org.lastError).toBeNull();
    expect(org.history).toHaveLength(1);
    expect(org.cycle.number).toBe(2);

    const plans = plansOf(org, 1);
    expect(plans.map((p) => p.ownerId).sort()).toEqual(['cmo', 'cpo', 'cto']);
    for (const plan of plans) {
      const owner = org.executives.find((e) => e.id === plan.ownerId)!;
      expect(plan.status).toBe('done');
      // The plan is the owner's standard operating profile, phase for phase.
      expect(plan.phases.map((p) => p.name)).toEqual(owner.phases.map((p) => p.name));
      for (const phase of plan.phases) {
        expect(phase.status).toBe('done');
        expect(phase.summary).toBeTruthy();
        expect(phase.tasks.length).toBeGreaterThan(0);
        for (const task of phase.tasks) {
          expect(task.status).toBe('done');
          expect(task.agent).toBeGreaterThanOrEqual(1);
          expect(task.agent).toBeLessThanOrEqual(owner.agentCount);
          expect(task.files.length).toBeGreaterThan(0);
        }
      }
      expect(org.reports.find((r) => r.id === plan.reportId)?.fromId).toBe(plan.ownerId);
    }

    const types = org.board.map((m) => m.type);
    expect(types.filter((t) => t === 'consult')).toHaveLength(3);
    expect(types.filter((t) => t === 'direction')).toHaveLength(1);
    expect(types.filter((t) => t === 'report')).toHaveLength(3);
    expect(org.board.find((m) => m.type === 'ceo_question')?.title).toBe(CEO_QUESTION);

    const files = await h.runner.workspace.list();
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((f) => /^(engineering|product|marketing)\//.test(f.path))).toBe(true);

    expect(org.usage.calls).toBeGreaterThan(20);
    expect(org.usage.costUsd).toBeGreaterThan(0);
    expect(Object.keys(org.usageByExec).sort()).toEqual(['ceo', 'cmo', 'cpo', 'cto']);
  });

  it('never starts a phase before the one before it has passed its gate', async () => {
    const order: string[] = [];
    h = await harness({
      mock: {
        delayMs: [0, 3],
        onCall: (kind, c) => {
          const plan = c.plan as { id: string } | undefined;
          const phase = c.phase as { index: number } | undefined;
          if (plan && phase) order.push(`${plan.id}:${kind}:${phase.index}`);
        },
      },
    });
    await runToRest(h.runner);

    for (const plan of plansOf(h.org, 1)) {
      const steps = order.filter((s) => s.startsWith(`${plan.id}:`)).map((s) => s.slice(plan.id.length + 1));
      let phase = 0;
      let stage: 'kickoff' | 'task' | 'phase_review' = 'kickoff';
      for (const step of steps) {
        const [kind, index] = step.split(':') as ['kickoff' | 'task' | 'phase_review', string];
        if (kind === 'kickoff') {
          // A kickoff may only follow the review of the previous phase.
          expect(stage === 'kickoff' || stage === 'phase_review').toBe(true);
          if (stage === 'phase_review') phase += 1;
        } else if (kind === 'task') {
          expect(['kickoff', 'task']).toContain(stage);
        } else {
          expect(stage).toBe('task');
        }
        expect(Number(index)).toBe(phase);
        stage = kind;
      }
      expect(phase).toBe(plan.phases.length - 1);
    }
  });

  it('never gives a lead more work at once than it has agents', async () => {
    // A lead that hands out more tasks than it has agents: the extra tasks must wait their turn.
    const busy = new Map<string, number>();
    const peak = new Map<string, number>();
    class Overcommitted extends MockProvider {
      override async structured<T>(req: StructuredRequest<T>): Promise<T> {
        if (req.kind !== 'kickoff') return super.structured(req);
        return req.schema.parse({ tasks: [1, 2, 3, 4].map((n) => ({ title: `Part ${n}`, brief: `Produce part ${n}.` })), notes: '', decisions: [] });
      }
      override async agent(req: AgentRequest): Promise<AgentResult> {
        const id = (req.context.seat as { id: string }).id;
        busy.set(id, (busy.get(id) ?? 0) + 1);
        peak.set(id, Math.max(peak.get(id) ?? 0, busy.get(id)!));
        try {
          return await super.agent(req);
        } finally {
          busy.set(id, busy.get(id)! - 1);
        }
      }
    }
    h = await harness({
      provider: new Overcommitted({ ...QUIET, delayMs: [1, 4] }),
      executives: [{ profileId: 'engineering', agentCount: 1 }, { profileId: 'research', agentCount: 3 }],
      settings: { maxConcurrentCalls: 8, maxTasksPerPhase: 4 },
    });
    await runToRest(h.runner);
    expect(peak.get('cto')).toBe(1);
    expect(peak.get('r-d')).toBe(3);
    // One agent cannot do two tasks at once, so the single-agent lead's tasks ran one after another.
    const ctoTasks = h.org.plans.filter((p) => p.ownerId === 'cto').flatMap((p) => p.phases.flatMap((ph) => ph.tasks));
    expect(ctoTasks.length).toBeGreaterThan(4);
    expect(ctoTasks.every((t) => t.status === 'done' && t.agent === 1)).toBe(true);
  });
});

describe('sharing capacity', () => {
  it('gives call slots to each lead in turn rather than serving the first until it is done', async () => {
    const order: string[] = [];
    h = await harness({
      executives: [{ profileId: 'engineering', agentCount: 2 }, { profileId: 'research', agentCount: 2 }],
      settings: { maxConcurrentCalls: 1 },
      mock: {
        onCall: (kind, c) => {
          if (kind === 'task') order.push((c.seat as { id: string }).id);
        },
      },
    });
    await runToRest(h.runner);
    expect(order.slice(0, 4)).toEqual(['cto', 'r-d', 'cto', 'r-d']);
    expect(h.org.plans.every((p) => p.status === 'done')).toBe(true);
  });

  it('never has more calls in flight than the organisation allows', async () => {
    let inFlight = 0;
    let peak = 0;
    h = await harness({
      settings: { maxConcurrentCalls: 2 },
      mock: {
        delayMs: [1, 3],
        onCall: async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 1));
          inFlight -= 1;
        },
      },
    });
    await runToRest(h.runner);
    expect(peak).toBe(2);
  });
});

describe('the loop', () => {
  it('asks what the shareholders want again each time all jobs are done', async () => {
    h = await harness({ settings: { maxCycles: 2 } });
    await runToRest(h.runner);
    const { org } = h;
    expect(org.history.map((c) => c.number)).toEqual([1, 2]);
    expect(org.board.filter((m) => m.type === 'ceo_question').map((m) => m.cycle)).toEqual([1, 2]);
    expect(org.board.filter((m) => m.type === 'direction')).toHaveLength(2);
    // Later cycles are told what earlier ones delivered.
    expect(org.history[0]!.summary).toContain('CTO');
    expect(org.cycle.number).toBe(3);
  });

  it('keeps running with no cycle limit until it is paused', async () => {
    h = await harness({ settings: { maxCycles: null }, mock: { delayMs: [0, 2] } });
    h.runner.start();
    await waitFor(() => h!.org.cycle.number >= 3, 'the third cycle');
    h.runner.pause();
    await h.runner.idle();
    expect(h.org.pauseReason).toBe('user');
    expect(h.org.history.length).toBeGreaterThanOrEqual(2);
  });

  it('moves old cycles out of live state and into the archive', async () => {
    h = await harness({ settings: { maxCycles: 4 } });
    await runToRest(h.runner);
    await h.runner.flush();
    expect(plansOf(h.org, 1)).toHaveLength(0);
    expect(plansOf(h.org, 4)).toHaveLength(3);
    await waitFor(() => existsSync(path.join(h!.store.orgDir(h!.org.id), 'archive', 'cycle-1.json')), 'the archive file');
    const archived = JSON.parse(await readFile(path.join(h.store.orgDir(h.org.id), 'archive', 'cycle-1.json'), 'utf8'));
    expect(archived.plans).toHaveLength(3);
    expect(archived.reports).toHaveLength(3);
    // The board feed of an archived cycle goes with it, and its digest stays in the history.
    expect(archived.board.some((m: { type: string }) => m.type === 'direction')).toBe(true);
    expect(archived.record.number).toBe(1);
    expect(h.org.board.every((m) => m.cycle > 2)).toBe(true);
    expect(h.org.history.map((c) => c.number)).toEqual([1, 2, 3, 4]);
  });
});

describe('decisions', () => {
  it('records what a lead decides inside their own remit', async () => {
    h = await harness();
    await runToRest(h.runner);
    const inRemit = h.org.decisions.filter((d) => d.kind === 'in_remit');
    expect(inRemit.length).toBeGreaterThanOrEqual(3);
    for (const d of inRemit) {
      expect(d.status).toBe('resolved');
      expect(d.outcome?.method).toBe('lead');
      expect(d.outcome?.byId).toBe(d.raisedById);
    }
  });

  it('takes competing priorities to the board and has the CEO sign off', async () => {
    h = await harness({ mock: { objections: 'first_round' } });
    await runToRest(h.runner);
    const { org } = h;
    const contested = org.decisions.filter((d) => d.kind === 'contested');
    expect(contested).toHaveLength(1);
    const decision = contested[0]!;
    expect(decision.status).toBe('resolved');
    expect(Object.keys(decision.positions).sort()).toEqual(['cmo', 'cpo', 'cto']);
    // The leads disagreed, so this is a ruling rather than consensus.
    expect(decision.outcome?.method).toBe('ceo');
    expect(decision.outcome?.byId).toBe('ceo');
    expect(decision.outcome?.planAction).toBe('amend');

    const plan = org.plans.find((p) => p.id === decision.planId)!;
    expect(plan.amendments).toEqual(decision.outcome!.amendments);
    expect(plan.status).toBe('done');
    expect(org.board.some((m) => m.type === 'plan' && m.title.includes('revised'))).toBe(true);
    // The other plans were not held up by the dispute.
    expect(plansOf(org, 1).every((p) => p.status === 'done')).toBe(true);
  });

  it('has the judge sign off instead when the organisation uses one', async () => {
    h = await harness({ mock: { objections: 'first_round' }, settings: { arbiter: 'judge' } });
    expect(h.org.executives.some((e) => e.kind === 'judge')).toBe(true);
    await runToRest(h.runner);
    const decision = h.org.decisions.find((d) => d.kind === 'contested')!;
    expect(decision.outcome?.method).toBe('judge');
    expect(decision.outcome?.byId).toBe('judge');
    // The judge arbitrates but holds no remit: no plans, no position.
    expect(h.org.plans.some((p) => p.ownerId === 'judge')).toBe(false);
    expect(decision.positions.judge).toBeUndefined();
  });

  it('calls it consensus when every lead takes the same position and the arbiter goes with it', async () => {
    class Agreeable extends MockProvider {
      override async structured<T>(req: StructuredRequest<T>): Promise<T> {
        if (req.kind === 'position') return req.schema.parse({ stance: 'back_plan', argument: 'On reflection the plan is fine as drafted.' });
        return super.structured(req);
      }
    }
    h = await harness({ provider: new Agreeable({ ...QUIET, objections: 'first_round' }) });
    await runToRest(h.runner);
    const decision = h.org.decisions.find((d) => d.kind === 'contested')!;
    expect(decision.outcome?.method).toBe('consensus');
    expect(decision.outcome?.planAction).toBe('proceed');
    expect(h.org.plans.find((p) => p.id === decision.planId)?.amendments).toEqual([]);
  });

  it('cancels a plan the arbiter rules against', async () => {
    class Strict extends MockProvider {
      override async structured<T>(req: StructuredRequest<T>): Promise<T> {
        if (req.kind === 'signoff') return req.schema.parse({ ruling: 'The plan is withdrawn.', rationale: 'It duplicates work.', planAction: 'cancel', amendments: [] });
        return super.structured(req);
      }
    }
    h = await harness({ provider: new Strict({ ...QUIET, objections: 'first_round' }) });
    await runToRest(h.runner);
    const decision = h.org.decisions.find((d) => d.kind === 'contested')!;
    const plan = h.org.plans.find((p) => p.id === decision.planId)!;
    expect(plan.status).toBe('cancelled');
    expect(plan.phases.every((p) => p.tasks.length === 0)).toBe(true);
    expect(h.org.history[0]!.summary).toContain('cancelled');
  });
});

describe('board reports as triggers', () => {
  it('lets a report prompt another lead to start follow-up work', async () => {
    h = await harness({ mock: { followUps: 'first_report' } });
    await runToRest(h.runner);
    const { org } = h;
    const followUps = org.plans.filter((p) => p.origin.type === 'follow_up');
    expect(followUps).toHaveLength(1);
    const plan = followUps[0]!;
    expect(plan.depth).toBe(1);
    expect(plan.status).toBe('done');
    const source = org.reports.find((r) => plan.origin.type === 'follow_up' && plan.origin.reportIds.includes(r.id))!;
    expect(source.fromId).not.toBe(plan.ownerId);
    expect(org.board.some((m) => m.type === 'reaction' && m.planId === plan.id)).toBe(true);
    expect(Object.values(org.inbox).flat()).toEqual([]);
  });

  it('stops follow-ups at the configured depth', async () => {
    h = await harness({ mock: { followUps: 'always' }, settings: { maxFollowUpDepth: 2 } });
    await runToRest(h.runner);
    const depths = h.org.plans.map((p) => p.depth);
    expect(Math.max(...depths)).toBe(2);
    expect(h.org.plans.every((p) => p.status === 'done')).toBe(true);
  });

  it('caps the follow-ups one lead may start in a cycle, however many reports call for one', async () => {
    h = await harness({
      mock: { followUps: 'always', delayMs: [0, 3] },
      executives: [{ profileId: 'engineering', agentCount: 3 }, { profileId: 'product' }, { profileId: 'marketing' }, { profileId: 'finance' }, { profileId: 'operations' }],
      settings: { maxConcurrentCalls: 8 },
    });
    await runToRest(h.runner);
    const { org } = h;
    expect(org.pauseReason).toBe('cycle_limit');
    for (const lead of org.executives.filter((e) => e.kind === 'lead')) {
      const followUps = org.plans.filter((p) => p.ownerId === lead.id && p.origin.type === 'follow_up');
      expect(followUps.length).toBeLessThanOrEqual(2);
    }
    expect(org.plans.every((p) => p.status === 'done')).toBe(true);
  });

  it('skips reactions entirely when follow-ups are switched off', async () => {
    const kinds: string[] = [];
    h = await harness({ mock: { followUps: 'always', onCall: (kind) => void kinds.push(kind) }, settings: { maxFollowUpDepth: 0 } });
    await runToRest(h.runner);
    expect(kinds).not.toContain('react');
    expect(h.org.plans).toHaveLength(3);
  });
});

describe('phase gates', () => {
  it('sends a phase back for rework once, then moves on', async () => {
    h = await harness({ mock: { rework: 'once' } });
    await runToRest(h.runner);
    const phases = h.org.plans.flatMap((p) => p.phases);
    const reworked = phases.filter((p) => p.reworkRounds > 0);
    expect(reworked).toHaveLength(1);
    expect(reworked[0]!.reworkRounds).toBe(1);
    expect(reworked[0]!.tasks.some((t) => t.rework && t.status === 'done')).toBe(true);
    expect(reworked[0]!.status).toBe('done');
  });

  it('shows the lead the files the agents wrote, cutting the long ones', async () => {
    const reviews: string[] = [];
    class Verbose extends MockProvider {
      override async structured<T>(req: StructuredRequest<T>): Promise<T> {
        if (req.kind === 'phase_review') reviews.push(req.prompt);
        return super.structured(req);
      }
      override async agent(req: AgentRequest): Promise<AgentResult> {
        const result = await super.agent(req);
        // One more, very long, file per task.
        const task = req.context.task as { id: string };
        await req.tools.find((t) => t.name === 'write_file')!.run({ path: `engineering/long-${task.id}.md`, content: 'x'.repeat(20_000) });
        return result;
      }
    }
    h = await harness({ provider: new Verbose(QUIET), executives: [{ profileId: 'engineering', agentCount: 2 }] });
    await runToRest(h.runner);
    expect(reviews).toHaveLength(4);
    const first = reviews[0]!;
    // The work product itself is in front of the lead, not only the agent's account of it.
    expect(first).toMatch(/<file path="engineering\/p\d+\/spec-the-core-deliverable\.md">\n# Spec: the core deliverable/);
    expect(first).toContain('note="cut to its first 12000 of 20000 characters"');
    expect(first).not.toContain('x'.repeat(12_001));
    // Past the total allowance a file is named but not shown.
    const total = (first.match(/<file /g) ?? []).length;
    expect(total).toBe(4);
    expect(first.length).toBeLessThan(60_000);
  });

  it('leaves a failed task for the lead to deal with at the gate, without stopping the organisation', async () => {
    let failed = false;
    h = await harness({
      mock: {
        onCall: (kind) => {
          if (kind === 'task' && !failed) {
            failed = true;
            throw new ProviderError('The model declined this request (cyber).', 'refusal', false);
          }
        },
      },
    });
    await runToRest(h.runner);
    const tasks = h.org.plans.flatMap((p) => p.phases.flatMap((ph) => ph.tasks));
    const lost = tasks.filter((t) => t.status === 'failed');
    expect(lost).toHaveLength(1);
    expect(lost[0]!.error).toContain('declined');
    expect(h.org.pauseReason).toBe('cycle_limit');
    expect(h.org.plans.every((p) => p.status === 'done')).toBe(true);
  });

  it('treats a task that has outgrown what the model takes the same way: it is that task’s failure, not the organisation’s', async () => {
    let failed = false;
    h = await harness({
      mock: {
        onCall: (kind) => {
          if (kind === 'task' && !failed) {
            failed = true;
            throw new ProviderError('The prompt is longer than the model takes: 412,031 tokens against a limit of 400,000.', 'too_long', false);
          }
        },
      },
    });
    await runToRest(h.runner);
    const lost = h.org.plans.flatMap((p) => p.phases.flatMap((ph) => ph.tasks)).filter((t) => t.status === 'failed');
    expect(lost).toHaveLength(1);
    expect(lost[0]!.error).toContain('longer than the model takes');
    expect(h.org.pauseReason).toBe('cycle_limit');
    expect(h.org.plans.every((p) => p.status === 'done')).toBe(true);
  });
});

describe('shareholder steer', () => {
  it('is read by the CEO when setting direction, and answered', async () => {
    h = await harness({ steer: 'Focus on customers in the UK first.' });
    await runToRest(h.runner);
    const steer = h.org.steers[0]!;
    expect(steer.status).toBe('acknowledged');
    expect(steer.response).toContain('UK');
    expect(h.org.history[0]!.intent).toContain('UK');
    expect(h.org.board.some((m) => m.type === 'steer' && m.fromId === 'shareholders')).toBe(true);
    expect(h.org.board.some((m) => m.type === 'steer_response' && m.fromId === 'ceo')).toBe(true);
  });

  it('is enforced on work already under way', async () => {
    let sent = false;
    h = await harness({
      mock: {
        delayMs: [1, 3],
        onCall: (kind) => {
          if (kind === 'kickoff' && !sent) {
            sent = true;
            h!.runner.steer('Everything must work for people who live in small flats.');
          }
        },
      },
    });
    await runToRest(h.runner);
    const { org } = h;
    expect(org.steers[0]!.status).toBe('acknowledged');
    const amended = org.plans.filter((p) => p.amendments.length > 0);
    expect(amended).toHaveLength(1);
    expect(amended[0]!.amendments[0]).toContain('small flats');
    expect(amended[0]!.status).toBe('done');
    expect(org.board.filter((m) => m.type === 'steer_response')).toHaveLength(1);
  });

  it('can stop a plan outright', async () => {
    let sent = false;
    h = await harness({
      mock: {
        delayMs: [1, 3],
        onCall: (kind) => {
          if (kind === 'kickoff' && !sent) {
            sent = true;
            h!.runner.steer('Stop the engineering work; we are not building software yet.');
          }
        },
      },
    });
    await runToRest(h.runner);
    const cancelled = h.org.plans.filter((p) => p.status === 'cancelled');
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]!.cancelReason).toContain('Stop the engineering work');
    expect(h.org.plans.filter((p) => p.status === 'done')).toHaveLength(2);
    // Nothing is left looking busy on the cancelled plan.
    expect(cancelled[0]!.phases.flatMap((p) => p.tasks).every((t) => t.status !== 'running')).toBe(true);
  });

  it('given while paused waits for the CEO and is picked up on resume', async () => {
    h = await harness({ mock: { delayMs: [1, 3] } });
    h.runner.start();
    await waitFor(() => h!.org.cycle.stage === 'work', 'work to begin');
    h.runner.pause();
    await h.runner.idle();
    h.runner.steer('Keep costs under control.');
    expect(h.org.steers[0]!.status).toBe('new');
    await runToRest(h.runner);
    expect(h.org.steers[0]!.status).toBe('acknowledged');
  });
});

describe('limits and controls', () => {
  it('stops, with its totals intact, when a call reports a cost that is not a number', async () => {
    // A price that is not a number, or token counts that are not, would make the total not a number, and such a
    // total is never "at least the budget": the organisation would never again pause on what it had spent.
    let broken = 0;
    class Unpriced extends MockProvider {
      override async agent(req: AgentRequest): Promise<AgentResult> {
        const result = await super.agent(req);
        if (!broken++) req.onUsage?.({ model: req.model, inputTokens: 1200, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0, webSearches: 0, costUsd: Number.NaN });
        return result;
      }
    }
    h = await harness({ provider: new Unpriced(QUIET), executives: [{ profileId: 'engineering', agentCount: 1 }] });
    await runToRest(h.runner);
    expect(broken).toBeGreaterThan(0);
    expect(h.org.status).toBe('paused');
    expect(h.org.pauseReason).toBe('error');
    expect(h.org.lastError).toMatch(/cost that is not a number.*Models and keys/);
    expect(Number.isFinite(h.org.usage.costUsd)).toBe(true);
    expect(Number.isFinite(h.org.usageByExec.cto!.costUsd)).toBe(true);
    expect(h.org.usage.costUsd).toBeGreaterThan(0);
    // Started again, it carries on counting from where it was.
    const before = h.org.usage.costUsd;
    await runToRest(h.runner);
    expect(h.org.pauseReason).toBe('cycle_limit');
    expect(h.org.usage.costUsd).toBeGreaterThan(before);
  });

  it('holds a hosted session’s spend to the same rule', async () => {
    const { countable } = await import('../src/server/engine/state');
    expect(countable({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, webSearches: 0, costUsd: 0.5 })).toBe(true);
    expect(countable({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, webSearches: 0, costUsd: Number.POSITIVE_INFINITY })).toBe(false);
    expect(countable({ inputTokens: '12' as unknown as number, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, webSearches: 0, costUsd: 0.5 })).toBe(false);
    expect(countable({ inputTokens: 1, outputTokens: undefined as unknown as number, cacheReadTokens: 0, cacheWriteTokens: 0, webSearches: 0, costUsd: 0.5 })).toBe(false);
  });

  it('pauses itself when the budget is spent and carries on once it is raised', async () => {
    h = await harness({ settings: { budgetUsd: 0.1 } });
    await runToRest(h.runner);
    const { org } = h;
    expect(org.pauseReason).toBe('budget');
    expect(org.usage.costUsd).toBeGreaterThanOrEqual(0.1);
    expect(org.usage.costUsd).toBeLessThan(0.2);
    expect(org.history).toHaveLength(0);
    expect(() => h!.runner.start()).toThrow(/budget/i);
    // Agents that were at work when the money ran out finished what they were on:
    // nothing is left half-run to be paid for again.
    const atPause = org.plans.flatMap((p) => p.phases.flatMap((ph) => ph.tasks));
    expect(atPause.some((t) => t.status === 'running')).toBe(false);

    h.runner.updateSettings({ budgetUsd: 1000 });
    await runToRest(h.runner);
    expect(org.pauseReason).toBe('cycle_limit');
    expect(plansOf(org, 1).every((p) => p.status === 'done')).toBe(true);
    // No task was started twice.
    expect(org.plans.flatMap((p) => p.phases.flatMap((ph) => ph.tasks)).every((t) => t.attempts === 1)).toBe(true);
  });

  it('never abandons a run to the budget, however small the top-ups', async () => {
    let runs = 0;
    h = await harness({ settings: { budgetUsd: 0.1, maxConcurrentCalls: 8 }, mock: { onCall: (kind) => void (kind === 'task' && runs++) } });
    for (let i = 0; i < 400 && h.org.pauseReason !== 'cycle_limit'; i++) {
      if (h.org.status !== 'running') h.runner.updateSettings({ budgetUsd: h.org.usage.costUsd + 0.02 });
      if (h.org.status !== 'running') h.runner.start();
      await h.runner.idle();
    }
    expect(h.org.pauseReason).toBe('cycle_limit');
    const tasks = h.org.plans.flatMap((p) => p.phases.flatMap((ph) => ph.tasks));
    // Every agent run that was started was kept: one run per task.
    expect(runs).toBe(tasks.length);
  });

  it('pauses without losing work in flight, and resumes where it left off', async () => {
    h = await harness({ mock: { delayMs: [2, 6] } });
    h.runner.start();
    await waitFor(() => h!.org.plans.some((p) => p.status === 'executing'), 'a plan to start executing');
    h.runner.pause();
    expect(h.org.status).toBe('paused');
    await h.runner.idle();
    const callsAtPause = h.org.usage.calls;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.org.usage.calls).toBe(callsAtPause);

    await runToRest(h.runner);
    expect(h.org.pauseReason).toBe('cycle_limit');
    expect(plansOf(h.org, 1).every((p) => p.status === 'done')).toBe(true);
  });

  it('stops at once when told to, putting interrupted work back in the queue', async () => {
    h = await harness({ mock: { delayMs: 40 } });
    h.runner.start();
    await waitFor(() => h!.org.plans.flatMap((p) => p.phases.flatMap((ph) => ph.tasks)).some((t) => t.status === 'running'), 'a task to be running');
    h.runner.stop();
    await h.runner.idle();
    const tasks = () => h!.org.plans.flatMap((p) => p.phases.flatMap((ph) => ph.tasks));
    expect(tasks().some((t) => t.status === 'running')).toBe(false);
    expect(tasks().some((t) => t.status === 'pending')).toBe(true);
    expect(h.org.lastError).toBeNull();

    await runToRest(h.runner);
    expect(tasks().every((t) => t.status === 'done')).toBe(true);
  });

  it('comes back paused after a restart and finishes the cycle when started again', async () => {
    h = await harness({ mock: { delayMs: [2, 6] } });
    h.runner.start();
    await waitFor(() => h!.org.plans.some((p) => p.status === 'executing'), 'a plan to start executing');
    await h.runner.flush();

    // A second process reading the same data directory, as after a crash.
    const registry = new Registry(h.store, new MockProvider(QUIET), { retryDelayMs: 1, emitIntervalMs: 1 });
    await registry.load();
    const revived = registry.get(h.org.id)!;
    expect(revived.org.status).toBe('paused');
    expect(revived.org.pauseReason).toBe('restart');
    expect(revived.org.plans.flatMap((p) => p.phases.flatMap((ph) => ph.tasks)).some((t) => t.status === 'running')).toBe(false);

    h.runner.stop();
    await h.runner.idle();
    await runToRest(revived);
    expect(revived.org.pauseReason).toBe('cycle_limit');
    expect(revived.org.plans.every((p) => p.status === 'done')).toBe(true);
    revived.dispose();
  });

  it('retries a call that fails in a way that may pass', async () => {
    let failures = 0;
    h = await harness({
      mock: {
        onCall: (kind) => {
          if (kind === 'direct' && failures < 2) {
            failures += 1;
            throw new ProviderError('Rate limited', 'rate_limit', true);
          }
        },
      },
    });
    await runToRest(h.runner);
    expect(failures).toBe(2);
    expect(h.org.pauseReason).toBe('cycle_limit');
    expect(h.runner.activity.filter((a) => a.kind === 'direct' && !a.ok)).toHaveLength(2);
  });

  it('pauses with the error when a call fails for good', async () => {
    h = await harness({
      mock: {
        onCall: (kind) => {
          if (kind === 'direct') throw new ProviderError('Anthropic rejected the credentials: invalid x-api-key', 'auth', false);
        },
      },
    });
    await runToRest(h.runner);
    expect(h.org.status).toBe('paused');
    expect(h.org.pauseReason).toBe('error');
    expect(h.org.lastError).toContain('credentials');
    // Nothing was lost: the consults are in, and direction is still to be set.
    expect(h.org.cycle.stage).toBe('direct');
  });

  it('applies a change in agent allocation to work that follows', async () => {
    h = await harness({ executives: [{ profileId: 'research', agentCount: 1 }], mock: { delayMs: [1, 3] } });
    h.runner.setAgentCount('r-d', 3);
    expect(h.org.executives.find((e) => e.id === 'r-d')?.agentCount).toBe(3);
    await runToRest(h.runner);
    const agents = new Set(h.org.plans.flatMap((p) => p.phases.flatMap((ph) => ph.tasks.map((t) => t.agent))));
    expect(agents.size).toBeGreaterThan(1);
    expect(() => h!.runner.setAgentCount('ceo', 2)).toThrow();
  });
});
