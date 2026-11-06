import type { Organisation } from './types';
export interface BusinessRecord {
  id: string; revision: number; createdAt: string; updatedAt: string; updatedBy: string;
}
/** A commitment outlives any one execution plan or cycle. */
export interface BusinessJob extends BusinessRecord {
  title: string; description: string; ownerId: string; nextAction: string;
  status: 'open' | 'blocked' | 'in_progress' | 'review' | 'done' | 'cancelled';
  blockedReason: string; notBefore: string | null; dueAt: string | null;
  recurrenceDays: number | null; dependsOn: string[]; customerId: string | null;
  metricId: string | null; reviewerId: string | null;
  plan: { id: string; cycle: number } | null;
  evidence: string; verification: { by: string; at: string; note: string } | null;
  previousJobId: string | null; nextJobId: string | null; notifiedAt: string | null;
}
export interface Customer extends BusinessRecord {
  name: string; ownerId: string; stage: 'enquiry' | 'qualified' | 'customer' | 'inactive';
  contact: string; notes: string; source: string;
}
export interface BusinessMetric extends BusinessRecord {
  title: string; ownerId: string; target: number | null; value: number | null; unit: string;
  basis: 'unknown' | 'estimate' | 'reported' | 'confirmed'; source: string; observedAt: string | null;
}
export interface FinanceEntry extends BusinessRecord {
  title: string; ownerId: string; direction: 'income' | 'expense';
  /** Integer hundredths of the stated currency; never sum different currencies. */
  amountMinor: number; currency: string;
  status: 'forecast' | 'outstanding' | 'confirmed' | 'void';
  dueAt: string | null; source: string; customerId: string | null;
}
export interface BusinessMemory extends BusinessRecord {
  title: string; ownerId: string; category: 'policy' | 'fact' | 'decision' | 'lesson';
  content: string; source: string; reviewAt: string | null;
}
export interface BusinessEvent extends BusinessRecord {
  source: string; externalId: string; title: string; detail: string; ownerId: string; jobId: string;
}
export interface BusinessAudit {
  at: string; by: string; kind: string; recordId: string; note: string; before: BusinessRecord | null;
}
export interface BusinessState {
  jobs: BusinessJob[]; customers: Customer[]; metrics: BusinessMetric[];
  finances: FinanceEntry[]; memory: BusinessMemory[]; events: BusinessEvent[]; audit: BusinessAudit[];
  waiting: boolean; nextReviewAt: string | null; reviewRequested: boolean; lastDigest: string;
}
export function emptyBusiness(): BusinessState {
  return { jobs: [], customers: [], metrics: [], finances: [], memory: [], events: [], audit: [], waiting: false, nextReviewAt: null, reviewRequested: false, lastDigest: '' };
}
export const jobOpen = (job: BusinessJob) => job.status !== 'done' && job.status !== 'cancelled';
export function dependenciesMet(org: Organisation, job: BusinessJob): boolean {
  return job.dependsOn.every((id) => org.business.jobs.some((j) => j.id === id && j.status === 'done'));
}
export function jobReady(org: Organisation, job: BusinessJob, at = Date.now()): boolean {
  return job.status === 'open' && (!job.notBefore || Date.parse(job.notBefore) <= at) && dependenciesMet(org, job);
}
export function financeTotals(entries: FinanceEntry[]) {
  const totals = new Map<string, { currency: string; income: number; expense: number; outstandingIncome: number; outstandingExpense: number }>();
  for (const entry of entries) {
    if (entry.status !== 'confirmed' && entry.status !== 'outstanding') continue;
    const value = totals.get(entry.currency) ?? { currency: entry.currency, income: 0, expense: 0, outstandingIncome: 0, outstandingExpense: 0 };
    const key = entry.status === 'confirmed' ? entry.direction : entry.direction === 'income' ? 'outstandingIncome' : 'outstandingExpense';
    value[key] += entry.amountMinor;
    totals.set(entry.currency, value);
  }
  return [...totals.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}
export function operatingDigest(org: Organisation, at = Date.now()): string {
  const b = org.business;
  const open = b.jobs.filter(jobOpen);
  const overdue = open.filter((j) => j.dueAt && Date.parse(j.dueAt) < at);
  const blocked = open.filter((j) => j.status === 'blocked' || !dependenciesMet(org, j));
  const review = open.filter((j) => j.status === 'review');
  return [
    open.length + ' open commitments; ' + overdue.length + ' overdue; ' + blocked.length + ' blocked; ' + review.length + ' awaiting verification.',
    'Model spending: USD ' + org.usage.costUsd.toFixed(2) + ' of ' + org.settings.budgetUsd.toFixed(2) + '.',
    ...financeTotals(b.finances).map((f) => f.currency + ': confirmed income ' + (f.income / 100).toFixed(2) + ', expenses ' + (f.expense / 100).toFixed(2) + '; outstanding receivables ' + (f.outstandingIncome / 100).toFixed(2) + ', payables ' + (f.outstandingExpense / 100).toFixed(2) + '. These records are not a bank balance.'),
    ...[...overdue, ...blocked, ...review].filter((j, i, all) => all.findIndex((v) => v.id === j.id) === i).slice(0, 10).map((j) => j.id + ' — ' + j.title + ' (' + j.ownerId + '): ' + (j.blockedReason || j.nextAction)),
    ...open.filter((j) => j.dueAt && Date.parse(j.dueAt) >= at).sort((a, c) => a.dueAt!.localeCompare(c.dueAt!)).slice(0, 5).map((j) => 'Upcoming: ' + j.title + ', due ' + j.dueAt + ', owner ' + j.ownerId + '.'),
    org.signatory.requests.filter((r) => r.status === 'pending' || r.status === 'authorised').length + ' payment/signature requests remain open.',
  ].join('\n');
}
