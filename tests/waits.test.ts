import { describe, expect, it } from 'vitest';
import { createOrganisation } from '../src/server/engine/state';
import { nextWork, settle } from '../src/server/engine/work';
import * as prompts from '../src/server/engine/prompts';
import type { Organisation, Plan } from '../src/shared/types';
import { breakWaitRing, heldBy, namedWaits, pinWaits, waitMet } from '../src/shared/waits';
import { harness, runToRest } from './helpers';

function organisation(): Organisation {
  const org = createOrganisation(
    { name: 'Fernery', idea: 'Houseplants by post.', executives: [{ profileId: 'engineering' }, { profileId: 'marketing' }, { profileId: 'legal' }] },
    'org_1',
  );
  org.cycle.stage = 'work';
  return org;
}

function plan(org: Organisation, ownerId: string, fields: Partial<Plan> = {}): Plan {
  const owner = org.executives.find((e) => e.id === ownerId)!;
  const at = new Date().toISOString();
  const p: Plan = {
    id: `p${org.plans.length + 1}`,
    cycle: org.cycle.number,
    ownerId,
    origin: { type: 'directive' },
    depth: 0,
    objective: `${ownerId} objective`,
    successCriteria: 'Criteria',
    priority: 'medium',
    rationale: 'Because',
    approach: 'An approach',
    workApproachId: 'standard',
    workApproachReason: null,
    phases: owner.phases.map((ph) => ({ sopPhaseId: ph.id, name: ph.name, purpose: ph.purpose, deliverable: ph.deliverable, intent: ph.purpose, notes: '', status: 'pending', tasks: [], reworkRounds: 0, summary: null, gate: null, evidence: null, waitsFor: [], effort: null })),
    skipped: [], effort: null,
    status: 'approved',
    amendments: [],
    escalations: [],
    decisionId: null,
    reportId: null,
    cancelReason: null,
    createdAt: at,
    updatedAt: at,
    execution: 'local',
    managed: null,
    code: null,
    ...fields,
  };
  org.plans.push(p);
  return p;
}

const kinds = (org: Organisation) => nextWork(org).map((w) => `${w.kind}:${w.execId}`);
const wait = (org: Organisation, owner: string, lead: string, phase: string) => namedWaits(org, owner, [{ lead, phase }]);

describe('waiting on another lead’s work', () => {
  it('keeps only other leads on the board, once each, and only a few', () => {
    const org = organisation();
    const given = [
      { lead: 'cto', phase: 'Spec' },
      { lead: 'cto', phase: 'spec' },
      { lead: 'cmo', phase: 'Research' },
      { lead: 'nobody', phase: 'Spec' },
      { lead: 'clo', phase: '' },
    ];
    expect(namedWaits(org, 'cmo', given).map((w) => `${w.leadId}:${w.phase}`)).toEqual(['cto:Spec']);
  });

  it('holds a phase until the phase it waits on has passed, then lets it start', () => {
    const org = organisation();
    const cto = plan(org, 'cto');
    const cmo = plan(org, 'cmo');
    cmo.phases[0]!.waitsFor = wait(org, 'cmo', 'cto', 'Spec');
    settle(org);
    expect(cmo.phases[0]!.waitsFor[0]).toMatchObject({ planId: cto.id, phaseIndex: 0, released: null });
    expect(kinds(org)).toEqual(['kickoff:cto']);

    cto.phases[0]!.status = 'done';
    expect(kinds(org)).toEqual(['kickoff:cto', 'kickoff:cmo']);
  });

  it('matches a phase by its id as well as its name, and waits for the whole plan when no phase matches', () => {
    const org = organisation();
    const cto = plan(org, 'cto');
    const cmo = plan(org, 'cmo');
    cmo.phases[0]!.waitsFor = wait(org, 'cmo', 'cto', 'build');
    cmo.phases[1]!.waitsFor = wait(org, 'cmo', 'cto', 'Deploy everywhere');
    pinWaits(org, cmo);
    expect(cmo.phases[0]!.waitsFor[0]!.phaseIndex).toBe(1);
    expect(cmo.phases[1]!.waitsFor[0]!.phaseIndex).toBeNull();
    for (const phase of cto.phases) phase.status = 'done';
    expect(waitMet(org, cmo.phases[1]!.waitsFor[0]!)).toBe(false);
    cto.status = 'done';
    expect(waitMet(org, cmo.phases[1]!.waitsFor[0]!)).toBe(true);
  });

  it('lets a phase go when what it waited on was cancelled, and says so to the lead', () => {
    const org = organisation();
    const cto = plan(org, 'cto');
    const cmo = plan(org, 'cmo');
    cmo.phases[0]!.waitsFor = wait(org, 'cmo', 'cto', 'Spec');
    settle(org);
    expect(heldBy(org, cmo)).toHaveLength(1);
    cto.status = 'cancelled';
    cto.cancelReason = 'Steer changed.';
    expect(heldBy(org, cmo)).toHaveLength(0);
    expect(prompts.kickoffPrompt(org, org.executives.find((e) => e.id === 'cmo')!, cmo, 0, [])).toContain('was cancelled before finishing: Steer changed.');
  });

  it('is not held up by a plan the other lead takes on after this one started', () => {
    const org = organisation();
    const cmo = plan(org, 'cmo');
    cmo.phases[0]!.waitsFor = wait(org, 'cmo', 'cto', 'Spec');
    settle(org);
    expect(cmo.phases[0]!.waitsFor[0]!.released).toMatch(/no plan under way/);
    plan(org, 'cto', { status: 'planning' });
    expect(heldBy(org, cmo)).toHaveLength(0);
  });

  it('breaks a ring of plans waiting on each other, and tells the board', () => {
    const org = organisation();
    const cto = plan(org, 'cto');
    const cmo = plan(org, 'cmo');
    const clo = plan(org, 'clo');
    cto.phases[0]!.waitsFor = wait(org, 'cto', 'cmo', 'Research');
    cmo.phases[0]!.waitsFor = wait(org, 'cmo', 'clo', 'Identify');
    clo.phases[0]!.waitsFor = wait(org, 'clo', 'cto', 'Spec');
    settle(org);
    const released = [cto, cmo, clo].filter((p) => p.phases[0]!.waitsFor[0]!.released);
    expect(released).toHaveLength(1);
    expect(nextWork(org).filter((w) => w.kind === 'kickoff')).toHaveLength(1);
    expect(org.board.at(-1)!.title).toMatch(/no longer waits/);
    expect(breakWaitRing(org)).toBeNull();
  });

  it('leaves a chain that is not a ring alone', () => {
    const org = organisation();
    plan(org, 'cto');
    const cmo = plan(org, 'cmo');
    const clo = plan(org, 'clo');
    cmo.phases[0]!.waitsFor = wait(org, 'cmo', 'cto', 'Spec');
    clo.phases[0]!.waitsFor = wait(org, 'clo', 'cmo', 'Research');
    settle(org);
    expect(breakWaitRing(org)).toBeNull();
    expect(kinds(org)).toEqual(['kickoff:cto']);
  });

  it('holds a plan for a hosted session until everything it waits on is finished', () => {
    const org = organisation();
    const cto = plan(org, 'cto');
    const cmo = plan(org, 'cmo', { execution: 'managed' });
    cmo.phases[2]!.waitsFor = wait(org, 'cmo', 'cto', 'Build');
    settle(org);
    expect(kinds(org)).toEqual(['kickoff:cto']);
    cto.phases[0]!.status = 'done';
    cto.phases[1]!.status = 'done';
    expect(kinds(org)).toContain('execute:cmo');
  });

  it('shows the board what a phase waits for', () => {
    const org = organisation();
    plan(org, 'cto');
    const cmo = plan(org, 'cmo');
    cmo.phases[0]!.waitsFor = wait(org, 'cmo', 'cto', 'Spec');
    settle(org);
    expect(prompts.phaseIntent(org, cmo.phases[0]!)).toContain('(waits for CTO: Spec)');
  });
});

describe('an organisation whose plans wait on each other', () => {
  it('starts the waiting phase only after the phase it waits on has passed, and still finishes the cycle', async () => {
    const h = await harness({ mock: { waits: { cmo: { phase: 'research', lead: 'cto', on: 'Spec' } } } });
    try {
      await runToRest(h.runner);
      const cmo = h.org.plans.find((p) => p.ownerId === 'cmo')!;
      expect(cmo.phases[0]!.waitsFor[0]).toMatchObject({ leadId: 'cto', phaseIndex: 0, released: null });
      const at = (kind: string, execId: string, label: RegExp) => h.runner.activity.find((a) => a.kind === kind && a.execId === execId && label.test(a.label))!;
      const specPassed = at('phase_review', 'cto', /Spec/);
      const researchStarted = at('kickoff', 'cmo', /Research/);
      expect(Date.parse(researchStarted.at) - researchStarted.ms).toBeGreaterThanOrEqual(Date.parse(specPassed.at) - 1);
      expect(h.org.plans.every((p) => p.status === 'done')).toBe(true);
    } finally {
      await h.cleanup();
    }
  });
});
