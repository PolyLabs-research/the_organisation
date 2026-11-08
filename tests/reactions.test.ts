import { describe, expect, it } from 'vitest';
import * as prompts from '../src/server/engine/prompts';
import { createOrganisation } from '../src/server/engine/state';
import type { BoardReport, Organisation, Plan } from '../src/shared/types';
import { harness, runToRest } from './helpers';

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

function organisation(): Organisation {
  const org = createOrganisation({ name: 'Fernery', idea: 'Houseplants by post.', executives: [{ profileId: 'marketing' }, { profileId: 'legal' }] }, 'org_1');
  org.cycle.stage = 'work';
  return org;
}

function report(org: Organisation, fields: Partial<BoardReport>): BoardReport {
  const r: BoardReport = { id: `rep${org.reports.length + 1}`, planId: 'p0', fromId: 'clo', cycle: 1, at: minutesAgo(40), headline: 'A headline', summary: 'A summary', outcomes: [], files: [], asks: [], ...fields };
  org.reports.push(r);
  return r;
}

function donePlan(org: Organisation, ownerId: string, reportId: string, files: string[]): Plan {
  const owner = org.executives.find((e) => e.id === ownerId)!;
  const at = new Date().toISOString();
  const plan: Plan = {
    id: 'p9', cycle: 1, ownerId, origin: { type: 'directive' }, depth: 0, objective: 'Deliver the research brief and a name shortlist', successCriteria: 'c', priority: 'medium', rationale: 'r',
    approach: null, workApproachId: 'standard', workApproachReason: null,
    phases: owner.phases.map((ph, i) => ({ sopPhaseId: ph.id, name: ph.name, purpose: ph.purpose, deliverable: ph.deliverable, intent: ph.purpose, notes: '', status: 'done', tasks: i ? [] : [{ id: 't1', title: 'Shortlist', brief: 'b', status: 'done', result: 'ok', files, error: null, agent: 1, attempts: 1, rework: false, startedAt: at, finishedAt: at } as never], reworkRounds: 0, summary: 's', gate: null, evidence: null, waitsFor: [], effort: null })),
    skipped: [], effort: null, status: 'done', amendments: [], escalations: [], decisionId: null, reportId, cancelReason: null, createdAt: at, updatedAt: at, execution: 'local', managed: null, code: null,
  };
  org.plans.push(plan);
  return plan;
}

describe('reading reports that may be out of date', () => {
  it('shows the lead how old a report is, what was reported since, and its own finished work and files', () => {
    const org = organisation();
    const stale = report(org, { fromId: 'clo', at: minutesAgo(42), headline: 'Legal pack drafted; knock-out waits on the CMO shortlist', asks: ['CMO: post the interim name shortlist'] });
    const mine = report(org, { fromId: 'cmo', planId: 'p9', at: minutesAgo(1), headline: 'Brief done; shortlist written', files: ['marketing/interim-name-shortlist.md'] });
    donePlan(org, 'cmo', mine.id, ['marketing/interim-name-shortlist.md']);
    const cmo = org.executives.find((e) => e.id === 'cmo')!;
    const text = prompts.reactPrompt(org, cmo, [stale], 2, [
      { path: 'marketing/interim-name-shortlist.md', size: 6000, modifiedAt: minutesAgo(55) },
      { path: 'legal/terms.md', size: 100, modifiedAt: minutesAgo(5) },
    ]);
    expect(text).toContain('filed 42 min ago');
    expect(text).toContain('# Reported since');
    expect(text).toMatch(/rep2 from .*Brief done; shortlist written/);
    expect(text).toContain('Reported 1 min ago: Brief done; shortlist written');
    expect(text).toContain('- marketing/interim-name-shortlist.md (written 55 min ago)');
    expect(text).not.toContain('legal/terms.md (written');
    expect(text).toContain('Never start one for something that already exists');
  });

  it('gives a follow-up plan the reports it answers and tells the lead to build on what exists', () => {
    const org = organisation();
    const r = report(org, { asks: ['CLO: rule on the override sentence'], files: ['marketing/site-copy.md'] });
    const clo = org.executives.find((e) => e.id === 'clo')!;
    const at = new Date().toISOString();
    const plan: Plan = {
      id: 'p1', cycle: 1, ownerId: 'clo', origin: { type: 'follow_up', reportIds: [r.id] }, depth: 1, objective: 'Rule on the sentence', successCriteria: 'c', priority: 'medium',
      rationale: 'Asked of legal.\n\nAlready in place, and what is missing: disclosure.md v0.2 exists; the ruling is missing.', approach: null, workApproachId: 'standard', workApproachReason: null,
      phases: [], skipped: [], effort: null, status: 'planning', amendments: [], escalations: [], decisionId: null, reportId: null, cancelReason: null, createdAt: at, updatedAt: at, execution: null, managed: null, code: null,
    };
    org.plans.push(plan);
    const text = prompts.planPrompt(org, clo, plan, []);
    expect(text).toContain('plan only what is missing');
    expect(text).toContain('Asks: CLO: rule on the override sentence');
    expect(text).toContain('Files: marketing/site-copy.md');
    expect(text).toContain('Already in place, and what is missing: disclosure.md v0.2 exists');
  });
});

describe('a follow-up started from a report', () => {
  it('carries what already exists into the plan', async () => {
    const h = await harness({ mock: { followUps: 'first_report' } });
    try {
      await runToRest(h.runner);
      const followUp = h.org.plans.find((p) => p.origin.type === 'follow_up');
      expect(followUp?.rationale).toMatch(/Already in place, and what is missing: .* files are in the workspace/);
    } finally {
      await h.cleanup();
    }
  });
});
