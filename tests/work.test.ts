import { describe, expect, it } from 'vitest';
import { MAX_FOLLOW_UPS_PER_LEAD, createOrganisation, followUpsLeft } from '../src/server/engine/state';
import { cycleComplete, nextWork, settle } from '../src/server/engine/work';
import type { Organisation, Plan } from '../src/shared/types';

function organisation(): Organisation {
  return createOrganisation({ name: 'Fernery', idea: 'Houseplants by post.', executives: [{ profileId: 'engineering' }, { profileId: 'marketing' }] }, 'org_1');
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
    objective: 'An objective',
    successCriteria: 'Criteria',
    priority: 'medium',
    rationale: 'Because',
    approach: 'An approach',
    phases: owner.phases.map((ph) => ({ sopPhaseId: ph.id, name: ph.name, purpose: ph.purpose, deliverable: ph.deliverable, intent: ph.purpose, notes: '', status: 'pending', tasks: [], reworkRounds: 0, summary: null })),
    status: 'planning',
    amendments: [],
    escalations: [],
    decisionId: null,
    reportId: null,
    cancelReason: null,
    createdAt: at,
    updatedAt: at,
    ...fields,
  };
  org.plans.push(p);
  return p;
}

const kinds = (org: Organisation) => nextWork(org).map((w) => `${w.kind}:${w.execId}`);

describe('what work is ready', () => {
  it('opens a cycle by consulting every lead, then has the CEO direct', () => {
    const org = organisation();
    expect(kinds(org)).toEqual(['consult:cto', 'consult:cmo']);
    org.cycle.consults.cto = { proposal: 'p', rationale: 'r', needs: '' };
    settle(org);
    expect(kinds(org)).toEqual(['consult:cmo']);
    org.cycle.consults.cmo = { proposal: 'p', rationale: 'r', needs: '' };
    settle(org);
    expect(org.cycle.stage).toBe('direct');
    expect(kinds(org)).toEqual(['direct:ceo']);
  });

  it('holds drafted plans for the board until nobody is still drafting, then has each lead review the others', () => {
    const org = organisation();
    org.cycle.stage = 'work';
    const a = plan(org, 'cto', { status: 'drafted' });
    const b = plan(org, 'cmo');
    settle(org);
    expect(a.status).toBe('drafted');
    expect(kinds(org)).toEqual(['plan:cmo']);
    b.status = 'drafted';
    settle(org);
    expect([a.status, b.status]).toEqual(['in_review', 'in_review']);
    expect(kinds(org)).toEqual(['review:cto', 'review:cmo']);
  });

  it('clears a plan nobody objects to and takes a contested one to the board', () => {
    const org = organisation();
    org.cycle.stage = 'work';
    const a = plan(org, 'cto', { status: 'drafted' });
    const b = plan(org, 'cmo', { status: 'drafted' });
    settle(org);
    const round = org.reviewRounds[0]!;
    round.reviews.cto = [{ planId: b.id, byId: 'cto', concern: 'It collides with ours.', proposal: 'Sequence it.' }];
    round.reviews.cmo = [];
    settle(org);
    expect(a.status).toBe('executing');
    expect(b.status).toBe('contested');
    const decision = org.decisions.find((d) => d.id === b.decisionId)!;
    expect(decision.participantIds).toEqual(['cto', 'cmo']);
    expect(kinds(org)).toEqual(['position:cto', 'position:cmo', 'kickoff:cto']);
    decision.positions.cto = { stance: 'back_objection', argument: 'x' };
    decision.positions.cmo = { stance: 'back_plan', argument: 'y' };
    settle(org);
    expect(kinds(org)).toEqual(['signoff:ceo', 'kickoff:cto']);
  });

  it('lets a lead read board reports only once their own plan is off their desk', () => {
    const org = organisation();
    org.cycle.stage = 'work';
    const mine = plan(org, 'cmo', { status: 'executing' });
    mine.phases[0]!.status = 'working';
    mine.phases[0]!.tasks = [{ id: 't1', title: 'T', brief: 'B', status: 'running', agent: 1, rework: false, result: null, files: [], error: null, attempts: 1, startedAt: null, finishedAt: null }];
    org.inbox.cmo = ['rep1'];
    expect(kinds(org)).toEqual([]);
    expect(cycleComplete(org)).toBe(false);
    mine.status = 'done';
    expect(kinds(org)).toEqual(['react:cmo']);
    expect(cycleComplete(org)).toBe(false);
    org.inbox.cmo = [];
    expect(cycleComplete(org)).toBe(true);
  });

  it('stops asking a lead about reports once it has started its follow-ups for the cycle', () => {
    const org = organisation();
    org.cycle.stage = 'work';
    for (let i = 0; i < MAX_FOLLOW_UPS_PER_LEAD; i++) plan(org, 'cmo', { status: 'done', origin: { type: 'follow_up', reportIds: ['rep0'] }, depth: 1 });
    expect(followUpsLeft(org, 'cmo')).toBe(0);
    expect(followUpsLeft(org, 'cto')).toBe(MAX_FOLLOW_UPS_PER_LEAD);
    org.inbox.cmo = ['rep1', 'rep2'];
    org.inbox.cto = ['rep3'];
    settle(org);
    expect(org.inbox.cmo).toEqual([]);
    expect(kinds(org)).toEqual(['react:cto']);
    // Follow-ups from an earlier cycle do not count against this one.
    org.cycle.number += 1;
    expect(followUpsLeft(org, 'cmo')).toBe(MAX_FOLLOW_UPS_PER_LEAD);
  });

  it('applies new steer through the CEO only once work is under way', () => {
    const org = organisation();
    org.steers.push({ id: 's1', at: '', text: 'UK first.', status: 'new', response: null, acknowledgedAt: null });
    expect(kinds(org)).not.toContain('steer_review:ceo');
    org.cycle.stage = 'work';
    expect(kinds(org)[0]).toBe('steer_review:ceo');
    org.steers[0]!.status = 'acknowledged';
    expect(kinds(org)).toEqual([]);
  });
});
