import { createOrganisation } from '../src/server/engine/state';
import type { Organisation, Plan } from '../src/shared/types';

// Pieces of an organisation for tests that draw parts of the dashboard as text, without a browser.

export function organisation(): Organisation {
  const org = createOrganisation({ name: 'Fernery', idea: 'Houseplants by post.', executives: [{ profileId: 'engineering', agentCount: 2 }, { profileId: 'marketing', agentCount: 1 }] }, 'org_1');
  org.cycle.stage = 'work';
  return org;
}

/** A plan under way for one of the leads, with the phases of that lead's operating profile and no work handed out yet. */
export function plan(org: Organisation, ownerId: string, id: string): Plan {
  const owner = org.executives.find((e) => e.id === ownerId)!;
  const at = '2026-11-08T12:00:00.000Z';
  const p: Plan = {
    id, cycle: 1, ownerId, origin: { type: 'directive' }, depth: 0, objective: 'Open the shop', successCriteria: 'It takes an order', priority: 'medium', rationale: 'r', approach: 'a', workApproachId: 'standard', workApproachReason: null,
    phases: owner.phases.map((ph) => ({ sopPhaseId: ph.id, name: ph.name, purpose: ph.purpose, deliverable: ph.deliverable, intent: ph.purpose, notes: '', status: 'pending', tasks: [], reworkRounds: 0, summary: null, gate: null, evidence: null, waitsFor: [], effort: null })),
    skipped: [], effort: null, status: 'executing', amendments: [], escalations: [], decisionId: null, reportId: null, cancelReason: null, createdAt: at, updatedAt: at, execution: 'local', managed: null, code: null,
  };
  org.plans.push(p);
  return p;
}
