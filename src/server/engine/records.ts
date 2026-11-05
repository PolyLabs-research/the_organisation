import type { BoardReport, Executive, Organisation, Plan, Task } from '../../shared/types';
import { leadsOf, nextId, postToBoard } from './state';

// Small pieces of record-keeping shared by the steps of a plan, however the plan is carried out.

export const now = () => new Date().toISOString();
export const clean = (text: string, max = 2000) => text.trim().slice(0, max);
export const bullets = (items: string[]) => items.map((i) => `- ${i}`).join('\n');

export const MAX_RESULT_CHARS = 12_000;

export function newTask(org: Organisation, title: string, brief: string, rework: boolean): Task {
  return {
    id: nextId(org, 't'),
    title: clean(title, 160),
    brief: clean(brief, 4000),
    status: 'pending',
    agent: null,
    rework,
    result: null,
    files: [],
    error: null,
    attempts: 0,
    startedAt: null,
    finishedAt: null,
  };
}

/** Record a decision a lead took inside their own remit. */
export function logRemitDecisions(
  org: Organisation,
  lead: Executive,
  plan: Plan,
  decisions: Array<{ title: string; decision: string; rationale: string }>,
): void {
  for (const d of decisions.slice(0, 4)) {
    if (!d.title.trim() || !d.decision.trim()) continue;
    // The same decision can be recorded twice when a hosted session is re-read after a reconnect.
    const title = clean(d.title, 200);
    if (org.decisions.some((x) => x.kind === 'in_remit' && x.planId === plan.id && x.title === title)) continue;
    const at = now();
    org.decisions.push({
      id: nextId(org, 'd'),
      cycle: org.cycle.number,
      at,
      kind: 'in_remit',
      title,
      context: plan.objective,
      raisedById: lead.id,
      planId: plan.id,
      issues: [],
      participantIds: [],
      positions: {},
      status: 'resolved',
      outcome: {
        method: 'lead',
        byId: lead.id,
        ruling: clean(d.decision),
        rationale: clean(d.rationale),
        planAction: 'proceed',
        amendments: [],
        at,
      },
    });
  }
}

/**
 * File a lead's report to the board and close the plan. The report is the
 * trigger for the rest of the board: every other lead gets it to react to,
 * unless this plan is already as deep as follow-ups may go.
 */
export function fileReport(
  org: Organisation,
  plan: Plan,
  lead: Executive,
  data: { headline: string; summary: string; outcomes: string[]; asks: string[] },
  files: string[],
): BoardReport {
  const report: BoardReport = {
    id: nextId(org, 'rep'),
    planId: plan.id,
    fromId: lead.id,
    cycle: plan.cycle,
    at: now(),
    headline: clean(data.headline, 240),
    summary: clean(data.summary, 3000),
    outcomes: data.outcomes.map((o) => clean(o, 500)).filter(Boolean).slice(0, 8),
    files: files.slice(0, 40),
    asks: data.asks.map((a) => clean(a, 500)).filter(Boolean).slice(0, 5),
  };
  org.reports.push(report);
  plan.reportId = report.id;
  plan.status = 'done';
  plan.updatedAt = report.at;
  const asks = report.asks.length ? `\n\n**Asks of the board**\n${bullets(report.asks)}` : '';
  postToBoard(org, 'report', lead.id, `${lead.short} reports: ${report.headline}`, `${report.summary}\n\n${bullets(report.outcomes)}${asks}`, {
    planId: plan.id,
    reportId: report.id,
  });
  if (plan.depth < org.settings.maxFollowUpDepth) {
    for (const other of leadsOf(org)) {
      if (other.id !== lead.id) (org.inbox[other.id] ??= []).push(report.id);
    }
  }
  return report;
}
