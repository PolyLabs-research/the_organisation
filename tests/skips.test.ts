import { describe, expect, it } from 'vitest';
import { shapePhases } from '../src/server/engine/handlers';
import * as prompts from '../src/server/engine/prompts';
import { createOrganisation } from '../src/server/engine/state';
import type { Organisation, Plan } from '../src/shared/types';
import { WORK_APPROACHES } from '../src/shared/approaches';
import { harness, runToRest } from './helpers';

function organisation(): Organisation {
  return createOrganisation({ name: 'Fernery', idea: 'Houseplants by post.', executives: [{ profileId: 'engineering' }, { profileId: 'marketing' }] }, 'org_1');
}

function draft(org: Organisation, ownerId: string, approach = 'standard'): Plan {
  const owner = org.executives.find((e) => e.id === ownerId)!;
  const phases = approach === 'standard' ? owner.phases : WORK_APPROACHES.find((a) => a.id === approach)!.phases;
  const at = new Date().toISOString();
  const plan: Plan = {
    id: 'p1', cycle: 1, ownerId, origin: { type: 'directive' }, depth: 0, objective: 'An objective', successCriteria: 'Criteria', priority: 'medium', rationale: 'Because',
    approach: null, workApproachId: approach, workApproachReason: null,
    phases: phases.map((ph) => ({ sopPhaseId: ph.id, name: ph.name, purpose: ph.purpose, deliverable: ph.deliverable, intent: ph.purpose, notes: '', status: 'pending', tasks: [], reworkRounds: 0, summary: null, gate: ph.gate ?? null, evidence: null, waitsFor: [], effort: null })),
    skipped: [], effort: null, status: 'planning', amendments: [], escalations: [], decisionId: null, reportId: null, cancelReason: null, createdAt: at, updatedAt: at, execution: null, managed: null, code: null,
  };
  org.plans.push(plan);
  return plan;
}

const entry = (phase: string, skip: boolean, intent = skip ? `No ${phase} needed.` : `Do ${phase}.`) => ({ phase, intent, skip, effort: 3, waitsFor: [] });
const cmo = (org: Organisation) => org.executives.find((e) => e.id === 'cmo')!;

describe('running only the phases a plan needs', () => {
  it('leaves out the phases a lead skips, and records why', () => {
    const org = organisation();
    const plan = draft(org, 'cmo');
    shapePhases(org, cmo(org), plan, [entry('research', false), entry('position', true), entry('create', true), entry('launch', true)]);
    expect(plan.phases.map((p) => p.name)).toEqual(['Research']);
    expect(plan.phases[0]!.intent).toBe('Do research.');
    expect(plan.skipped).toEqual([
      { phase: 'Position', reason: 'No position needed.' },
      { phase: 'Create', reason: 'No create needed.' },
      { phase: 'Launch', reason: 'No launch needed.' },
    ]);
    expect(prompts.skippedLine(plan)).toContain('Skips: Position (No position needed.)');
  });

  it('runs every phase when a lead would skip them all', () => {
    const org = organisation();
    const plan = draft(org, 'cmo');
    shapePhases(org, cmo(org), plan, ['research', 'position', 'create', 'launch'].map((p) => entry(p, true)));
    expect(plan.phases).toHaveLength(4);
    expect(plan.skipped).toEqual([]);
  });

  it('never skips a phase the system checks for itself', () => {
    const org = organisation();
    const cto = org.executives.find((e) => e.id === 'cto')!;
    const plan = draft(org, 'cto', 'devops');
    shapePhases(org, cto, plan, [entry('plan', false), entry('build', false), entry('verify', true), entry('release', true), entry('improve', true)]);
    expect(plan.phases.map((p) => p.name)).toEqual(['Plan', 'Build', 'Verify', 'Release']);
    expect(plan.phases.find((p) => p.name === 'Verify')!.intent).not.toBe('No verify needed.');
    expect(plan.skipped.map((s) => s.phase)).toEqual(['Improve']);
  });

  it('brings a skipped phase back when a revision clears the skip, keeping what the others had', () => {
    const org = organisation();
    const plan = draft(org, 'cmo');
    shapePhases(org, cmo(org), plan, [entry('research', false), entry('position', true), entry('create', true), entry('launch', true)]);
    plan.phases[0]!.waitsFor = [{ leadId: 'cto', phase: 'Spec', planId: null, phaseIndex: null, released: null }];
    shapePhases(org, cmo(org), plan, [{ ...entry('research', false), waitsFor: [{ lead: 'cto', phase: 'Spec' }] }, entry('position', false), entry('create', true), entry('launch', true)]);
    expect(plan.phases.map((p) => p.name)).toEqual(['Research', 'Position']);
    expect(plan.phases[0]!.waitsFor).toHaveLength(1);
    expect(plan.skipped.map((s) => s.phase)).toEqual(['Create', 'Launch']);
    expect(prompts.revisePrompt(org, plan, undefined, cmo(org).phases)).toContain('- Create: skipped (No create needed.)');
  });

  it('leaves the phases alone once the plan has started', () => {
    const org = organisation();
    const plan = draft(org, 'cmo');
    plan.phases[0]!.status = 'done';
    shapePhases(org, cmo(org), plan, [entry('research', false), entry('position', true)]);
    expect(plan.phases).toHaveLength(4);
  });
});

describe('an organisation whose lead skips phases', () => {
  it('runs only the phases kept, and finishes the cycle', async () => {
    const h = await harness({ mock: { skips: { cmo: ['position', 'create', 'launch'] } } });
    try {
      await runToRest(h.runner);
      const plan = h.org.plans.find((p) => p.ownerId === 'cmo')!;
      expect(plan.phases.map((p) => p.name)).toEqual(['Research']);
      expect(plan.status).toBe('done');
      const kickoffs = h.runner.activity.filter((a) => a.kind === 'kickoff' && a.execId === 'cmo').map((a) => a.label);
      expect(kickoffs).toEqual(['Handing out work for Research']);
      expect(h.org.board.some((m) => m.type === 'plan' && m.body.includes('Skips: Position'))).toBe(true);
      expect(h.org.plans.every((p) => p.status === 'done')).toBe(true);
    } finally {
      await h.cleanup();
    }
  });
});
