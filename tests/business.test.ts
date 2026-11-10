import { describe, expect, it, vi } from 'vitest';
import { applyBusinessCommand, applyBusinessUpdates, businessTools, nextBusinessWake, consumeBusinessWake } from '../src/server/engine/business';
import { AUDIT_KEPT_LIVE, AUDIT_SPILL_AT } from '../src/server/engine/runner';
import { normaliseLoaded } from '../src/server/engine/state';
import { MockProvider } from '../src/server/providers/mock';
import type { AgentRequest, StructuredRequest } from '../src/server/providers/types';
import { Registry } from '../src/server/registry';
import { createOnlyPaperclips } from '../src/server/only-paperclips';
import { financeTotals, jobReady, type BusinessJob } from '../src/shared/business';
import { harness, runToRest, waitFor, QUIET } from './helpers';

const person = { id: 'person' };
const jobInput = (extra: Record<string, unknown> = {}) => ({ ownerId: 'cto', title: 'Deliver the quote', nextAction: 'Draft and verify the quote', ...extra });
function editable(job: BusinessJob) {
  const { id, revision, title, ownerId, description, nextAction, status, blockedReason, notBefore, dueAt, recurrenceDays, dependsOn, customerId, metricId, reviewerId, evidence } = job;
  return { id, revision, title, ownerId, description, nextAction, status, blockedReason, notBefore, dueAt, recurrenceDays, dependsOn, customerId, metricId, reviewerId, evidence };
}

describe('persistent business records', () => {
  it('migrates old state without changing its existing controls', async () => {
    const h = await harness();
    try {
      const old = structuredClone(h.org);
      delete (old as Partial<typeof old>).business;
      delete (old.settings as Partial<typeof old.settings>).reviewIntervalMinutes;
      delete (old.settings as Partial<typeof old.settings>).resumeOnRestart;
      normaliseLoaded(old);
      expect(old.business.jobs).toEqual([]);
      expect(old.settings.reviewIntervalMinutes).toBe(0);
      expect(old.settings.resumeOnRestart).toBe(false);
    } finally { await h.cleanup(); }
  });

  it('brings live plans from an older organisation into the calendar without claiming verified delivery', async () => {
    const h = await harness({ executives: [{ profileId: 'engineering', agentCount: 1 }] });
    try {
      await runToRest(h.runner);
      const old = structuredClone(h.org);
      delete (old as Partial<typeof old>).business;
      const migrated = normaliseLoaded(old);
      expect(migrated.business.jobs).toHaveLength(old.plans.length);
      expect(migrated.business.jobs[0]!.plan?.id).toBe(old.plans[0]!.id);
      expect(migrated.business.jobs[0]!.status).toBe('review');
      expect(migrated.business.jobs[0]!.verification).toBeNull();
      normaliseLoaded(migrated);
      expect(migrated.business.jobs).toHaveLength(old.plans.length);
    } finally { await h.cleanup(); }
  });

  it('rejects stale revisions, invalid dates, dependency cycles and changes outside a remit', async () => {
    const h = await harness();
    try {
      const create = (record: Record<string, unknown>) => applyBusinessCommand(h.org, { kind: 'job', record: jobInput(record) }, person) as BusinessJob;
      const first = create({ dueAt: '2030-01-01T10:00:00+02:00' });
      expect(first.dueAt).toBe('2030-01-01T08:00:00.000Z');
      const second = create({ title: 'Deliver the order', dependsOn: [first.id] });
      expect(jobReady(h.org, second)).toBe(false);
      expect(() => applyBusinessCommand(h.org, { kind: 'job', record: { ...editable(first), dependsOn: [second.id] } }, person)).toThrow('indirectly');
      expect(() => create({ notBefore: 'tomorrow' })).toThrow();
      expect(() => create({ notBefore: '2030-02-02T00:00:00Z', dueAt: '2030-02-01T00:00:00Z' })).toThrow('deadline');
      expect(() => applyBusinessCommand(h.org, { kind: 'job', record: { ...editable(first), title: 'Changed' } }, { id: 'cmo' })).toThrow('another lead');
      applyBusinessCommand(h.org, { kind: 'job', record: { ...editable(first), title: 'A revised quote' } }, person);
      expect(() => applyBusinessCommand(h.org, { kind: 'job', record: editable(first) }, person)).toThrow('revision');
      expect(h.org.business.audit.at(-1)?.before).toMatchObject({ title: first.title });
    } finally { await h.cleanup(); }
  });

  it('requires evidence and the assigned reviewer, and releases dependencies only on verification', async () => {
    const h = await harness();
    try {
      const first = applyBusinessCommand(h.org, { kind: 'job', record: jobInput({ reviewerId: 'cpo' }) }, person) as BusinessJob;
      const second = applyBusinessCommand(h.org, { kind: 'job', record: jobInput({ title: 'Delivery', dependsOn: [first.id] }) }, person) as BusinessJob;
      expect(() => applyBusinessCommand(h.org, { kind: 'job', record: { ...editable(first), reviewerId: null } }, { id: 'cto' })).toThrow('independent reviewer');
      expect(() => applyBusinessCommand(h.org, { kind: 'job', record: { ...editable(first), status: 'review' } }, person)).toThrow('evidence');
      const review = applyBusinessCommand(h.org, { kind: 'job', record: { ...editable(first), status: 'review', evidence: 'Quote checked against the customer brief: workspace/quote.md' } }, person)!;
      const verification = { kind: 'verify', id: review.id, revision: review.revision, evidence: 'Checked the quote and customer requirements.' };
      expect(() => applyBusinessCommand(h.org, verification, { id: 'cto' })).toThrow('assigned reviewer');
      expect(() => applyBusinessCommand(h.org, verification, { id: 'cpo', worker: true })).toThrow('Agents submit');
      applyBusinessCommand(h.org, verification, { id: 'cpo' });
      expect(jobReady(h.org, second)).toBe(true);
      expect(h.org.business.jobs[0]!.verification?.by).toBe('cpo');
    } finally { await h.cleanup(); }
  });

  it('keeps confirmed finances separate from forecasts and currencies, with human confirmation', async () => {
    const h = await harness();
    try {
      const entry = { ownerId: 'cto', title: 'Order payment', direction: 'income', amountMinor: 12500, currency: 'GBP', status: 'confirmed', source: 'Receipt 123' };
      expect(() => applyBusinessCommand(h.org, { kind: 'finance', record: entry }, { id: 'cto' })).toThrow('Only a person');
      applyBusinessCommand(h.org, { kind: 'finance', record: entry }, person);
      applyBusinessCommand(h.org, { kind: 'finance', record: { ...entry, currency: 'USD', amountMinor: 900 } }, person);
      applyBusinessCommand(h.org, { kind: 'finance', record: { ...entry, status: 'forecast', amountMinor: 99999 } }, person);
      expect(financeTotals(h.org.business.finances)).toEqual([
        { currency: 'GBP', income: 12500, expense: 0, outstandingIncome: 0, outstandingExpense: 0 },
        { currency: 'USD', income: 900, expense: 0, outstandingIncome: 0, outstandingExpense: 0 },
      ]);
      const original = h.org.business.finances[0]!;
      expect(() => applyBusinessCommand(h.org, { kind: 'finance', record: { ...entry, id: original.id, revision: original.revision, status: 'void' } }, { id: 'cto' })).toThrow('Only a person');
      expect(h.org.signatory.requests).toEqual([]);
    } finally { await h.cleanup(); }
  });

  it('keeps unknown measurements unknown and requires provenance for values', async () => {
    const h = await harness();
    try {
      const record = { ownerId: 'cto', title: 'Orders delivered', unit: 'orders', target: 10 };
      applyBusinessCommand(h.org, { kind: 'metric', record }, person);
      expect(h.org.business.metrics[0]).toMatchObject({ value: null, basis: 'unknown' });
      expect(() => applyBusinessCommand(h.org, { kind: 'metric', record: { ...record, value: 5 } }, person)).toThrow('source');
      expect(() => applyBusinessCommand(h.org, { kind: 'metric', record: { ...record, value: 5, basis: 'confirmed', source: 'ledger', observedAt: new Date().toISOString() } }, { id: 'cto' })).toThrow('Only a person');
    } finally { await h.cleanup(); }
  });

  it('deduplicates incoming events across reloads and creates exactly one owned job', async () => {
    const h = await harness();
    try {
      const command = { kind: 'event', record: { ownerId: 'cto', source: 'inbox', externalId: 'msg-1', title: 'Customer enquiry', detail: 'Please quote for paperclips.' } };
      await h.runner.businessCommand(command);
      const loaded = normaliseLoaded((await h.store.loadAll())[0]!);
      applyBusinessCommand(loaded, command, person);
      expect(loaded.business.events).toHaveLength(1);
      expect(loaded.business.jobs).toHaveLength(1);
      expect(loaded.business.reviewRequested).toBe(true);
      expect(loaded.status).toBe('idle');
    } finally { await h.cleanup(); }
  });

  it('takes an incoming event from a person or a local integration only, never from a seat or its agents', async () => {
    const h = await harness();
    try {
      // An event creates a commitment, wakes a waiting organisation and is announced on the board as having come
      // from outside. A seat that could file one could give itself work and call it a customer's.
      const event = { kind: 'event', record: { ownerId: 'cto', title: 'A customer wrote in', detail: 'Wants a quote for 100 boxes.', source: 'inbox', externalId: 'message-1' } };
      for (const actor of [{ id: 'cto' }, { id: 'cto', worker: true }, { id: 'ceo' }]) {
        expect(() => applyBusinessCommand(h.org, event, actor), JSON.stringify(actor)).toThrow(/Only a person or a local integration/);
      }
      applyBusinessUpdates(h.org, [JSON.stringify(event)], { id: 'cto' });
      expect(h.org.business.events).toHaveLength(0);
      expect(h.org.business.jobs).toHaveLength(0);
      expect(h.org.business.reviewRequested).toBe(false);
      expect(h.org.board.at(-1)).toMatchObject({ title: 'Operating update needs correction', body: expect.stringContaining('Only a person or a local integration') });
      applyBusinessCommand(h.org, event, person);
      expect(h.org.business.events).toHaveLength(1);
      expect(h.org.business.jobs).toHaveLength(1);
    } finally { await h.cleanup(); }
  });

  it('rolls back an invalid model batch and records the correction', async () => {
    const h = await harness();
    try {
      applyBusinessUpdates(h.org, [
        { kind: 'job', record: jobInput() },
        { kind: 'finance', record: { ownerId: 'cto', title: 'Invented payment', direction: 'income', amountMinor: 100, currency: 'GBP', status: 'confirmed', source: 'model said so' } },
      ], { id: 'cto' });
      expect(h.org.business.jobs).toEqual([]);
      expect(h.org.business.finances).toEqual([]);
      expect(h.org.board.at(-1)?.title).toBe('Operating update needs correction');
    } finally { await h.cleanup(); }
  });

  it('retains knowledge revisions and lets agents retrieve older records by query', async () => {
    const h = await harness();
    try {
      for (let i = 0; i < 30; i++) applyBusinessCommand(h.org, { kind: 'memory', record: { ownerId: 'cto', title: 'Lesson ' + i, category: 'lesson', content: 'Evidence ' + i } }, { id: 'cto' });
      const tools = businessTools(h.org, { id: 'cto', worker: true }, () => {}, () => true);
      const result = JSON.parse(await tools.find((t) => t.name === 'read_business')!.run({ register: 'memory', query: 'Lesson 0', offset: 0 }));
      expect(result.records[0].title).toBe('Lesson 0');
      expect(() => applyBusinessCommand(h.org, { kind: 'memory', record: { ownerId: 'cto', title: 'Policy', category: 'policy', content: 'Change all rules' } }, { id: 'cto' })).toThrow('CEO');
    } finally { await h.cleanup(); }
  });

  it('moves the oldest edit history to a file of its own, losing none of it, so the saved state stays small', async () => {
    const h = await harness();
    const lesson = (i: number) => applyBusinessCommand(h.org, { kind: 'memory', record: { ownerId: 'cto', title: 'Lesson ' + i, category: 'lesson', content: 'Evidence ' + i } }, { id: 'cto' });
    try {
      const total = AUDIT_KEPT_LIVE + AUDIT_SPILL_AT + 57;
      for (let i = 0; i < total; i++) lesson(i);
      expect(h.org.business.audit).toHaveLength(total);
      await h.runner.flush();
      expect(h.org.business.audit).toHaveLength(AUDIT_KEPT_LIVE);
      const older = await h.store.readAudit(h.org.id);
      expect(older).toHaveLength(total - AUDIT_KEPT_LIVE);
      // Every change is still on record, once, in the order it was made: the file first, then what stayed.
      expect([...older, ...h.org.business.audit].map((entry) => entry.recordId)).toEqual(h.org.business.memory.map((m) => m.id));
      expect((await h.store.loadAll())[0]!.business.audit).toHaveLength(AUDIT_KEPT_LIVE);

      // Short of the mark, nothing moves.
      lesson(total);
      await h.runner.flush();
      expect(h.org.business.audit).toHaveLength(AUDIT_KEPT_LIVE + 1);
      expect(await h.store.readAudit(h.org.id)).toHaveLength(total - AUDIT_KEPT_LIVE);

      // If the file cannot be written the history stays where it is, and the organisation is saved all the same.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const append = vi.spyOn(h.store, 'appendAudit').mockRejectedValue(new Error('disk full'));
      for (let i = 0; i < AUDIT_SPILL_AT; i++) lesson(total + 1 + i);
      await h.runner.flush();
      expect(h.org.business.audit).toHaveLength(AUDIT_KEPT_LIVE + 1 + AUDIT_SPILL_AT);
      expect((await h.store.loadAll())[0]!.business.audit).toHaveLength(AUDIT_KEPT_LIVE + 1 + AUDIT_SPILL_AT);
      expect(h.org.lastError).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      append.mockRestore();
      warn.mockRestore();
      // And moves once it can.
      await h.runner.flush();
      expect(h.org.business.audit).toHaveLength(AUDIT_KEPT_LIVE);
      expect([...(await h.store.readAudit(h.org.id)), ...h.org.business.audit].map((entry) => entry.recordId)).toEqual(h.org.business.memory.map((m) => m.id));
    } finally { await h.cleanup(); }
  });

  it('coalesces missed recurrences into one future occurrence, preserving the verified result', async () => {
    const h = await harness();
    try {
      const job = applyBusinessCommand(h.org, { kind: 'job', record: jobInput({ dueAt: '2020-01-01T09:00:00Z', recurrenceDays: 7, status: 'review', evidence: 'Reviewed stock records.' }) }, person) as BusinessJob;
      applyBusinessCommand(h.org, { kind: 'verify', id: job.id, revision: job.revision, evidence: 'Matched the stock report.' }, person);
      expect(h.org.business.jobs).toHaveLength(2);
      const next = h.org.business.jobs[1]!;
      expect(Date.parse(next.dueAt!)).toBeGreaterThan(Date.now());
      expect(next.previousJobId).toBe(job.id);
      expect(h.org.business.jobs[0]!.status).toBe('done');
      expect(next.verification).toBeNull();
    } finally { await h.cleanup(); }
  });
});

describe('scheduled business operation', () => {
  it('gives a repeat with only a due date the time from the previous due date to its own', async () => {
    const h = await harness();
    try {
      const dueAt = new Date(Date.now() + 3_600_000).toISOString();
      const job = applyBusinessCommand(h.org, { kind: 'job', record: jobInput({ dueAt, recurrenceDays: 7, status: 'review', evidence: 'Reviewed stock records.' }) }, person) as BusinessJob;
      applyBusinessCommand(h.org, { kind: 'verify', id: job.id, revision: job.revision, evidence: 'Matched the stock report.' }, person);
      const next = h.org.business.jobs[1]!;
      expect(next.notBefore).toBe(dueAt);
      expect(Date.parse(next.dueAt!) - Date.parse(dueAt)).toBe(7 * 86_400_000);
    } finally { await h.cleanup(); }
  });

  it('keeps a repeat at the same local time across a clock change', async () => {
    const zone = process.env.TZ;
    process.env.TZ = 'Europe/London';
    const h = await harness();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // British Summer Time ends on 25 October 2026: 09:00 is 08:00Z before it and 09:00Z after.
      vi.setSystemTime(new Date('2026-10-20T12:00:00Z'));
      const job = applyBusinessCommand(h.org, { kind: 'job', record: jobInput({ notBefore: '2026-10-22T08:00:00Z', dueAt: '2026-10-23T08:00:00Z', recurrenceDays: 7, status: 'review', evidence: 'Reviewed stock records.' }) }, person) as BusinessJob;
      applyBusinessCommand(h.org, { kind: 'verify', id: job.id, revision: job.revision, evidence: 'Matched the stock report.' }, person);
      const next = h.org.business.jobs[1]!;
      expect(next.notBefore).toBe('2026-10-29T09:00:00.000Z');
      expect(next.dueAt).toBe('2026-10-30T09:00:00.000Z');
    } finally {
      vi.useRealTimers();
      if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone;
      await h.cleanup();
    }
  });

  it('lets executives schedule a commitment and agents update that same job through their tools', async () => {
    class OperatingProvider extends MockProvider {
      updated = false;
      override async structured<T>(request: StructuredRequest<T>): Promise<T> {
        const response = await super.structured(request);
        if (request.kind !== 'consult') return response;
        return request.schema.parse({ ...response as object, operations: [JSON.stringify({
          kind: 'job', record: { ownerId: 'cto', title: 'A model-scheduled delivery', dueAt: new Date(Date.now() + 86400000).toISOString(), nextAction: 'Produce a checked draft.' },
        })] });
      }
      override async agent(request: AgentRequest) {
        if (!this.updated) {
          const reader = request.tools.find((t) => t.name === 'read_business')!;
          const writer = request.tools.find((t) => t.name === 'update_business')!;
          const record = JSON.parse(await reader.run({ register: 'jobs', query: 'A model-scheduled delivery', offset: 0 })).records[0] as BusinessJob;
          await writer.run({ command: { kind: 'job', record: { ...editable(record), evidence: 'Worker checked the input requirements.', nextAction: 'Finish the reviewed draft.' } } });
          this.updated = true;
        }
        return super.agent(request);
      }
    }
    const provider = new OperatingProvider(QUIET);
    const h = await harness({ provider, executives: [{ profileId: 'engineering', agentCount: 1 }], settings: { maxFollowUpDepth: 0 } });
    try {
      await runToRest(h.runner);
      expect(provider.updated).toBe(true);
      expect(h.org.business.jobs).toHaveLength(1);
      const job = h.org.business.jobs[0]!;
      expect(job.title).toBe('A model-scheduled delivery');
      expect(job.status).toBe('review');
      expect(job.evidence).toContain('Worker checked the input requirements.');
      expect(job.evidence).toContain('Files:');
      expect(job.plan?.id).toBe(h.org.plans[0]!.id);
    } finally { await h.cleanup(); }
  });

  it('does not acknowledge an event when saving fails and surfaces storage failure while waiting', async () => {
    const h = await harness({ settings: { reviewIntervalMinutes: 60, maxCycles: null, maxFollowUpDepth: 0 } });
    try {
      await runToRest(h.runner);
      const save = vi.spyOn(h.store, 'save').mockRejectedValueOnce(new Error('disk full'));
      const command = { kind: 'event', record: { ownerId: 'cto', title: 'An enquiry', detail: 'Needs a durable record.', source: 'inbox', externalId: 'failure-test' } };
      await expect(h.runner.businessCommand(command)).rejects.toThrow('disk full');
      expect(h.org.status).toBe('paused');
      expect(h.org.lastError).toContain('Could not save');
      save.mockRestore();
      await h.runner.businessCommand(command);
      expect(h.org.business.events).toHaveLength(1);
      expect((await h.store.loadAll())[0]!.business.events).toHaveLength(1);
    } finally { await h.cleanup(); }
  });

  it('honours limits reduced while waiting and still records incoming events', async () => {
    const h = await harness({ settings: { reviewIntervalMinutes: 60, maxCycles: null, maxFollowUpDepth: 0 } });
    try {
      await runToRest(h.runner);
      h.runner.updateSettings({ maxCycles: 1 });
      expect(h.org.pauseReason).toBe('cycle_limit');
      const calls = h.org.usage.calls;
      await h.runner.businessCommand({ kind: 'event', record: { ownerId: 'cto', title: 'Queued event', detail: 'Must wait for permission to run again.', source: 'test', externalId: 'limited' } });
      expect(h.org.usage.calls).toBe(calls);
      expect(() => h.runner.start()).toThrow('cycle limit');
      h.runner.updateSettings({ maxCycles: null, budgetUsd: 0.1 });
      expect(() => h.runner.start()).toThrow('budget');
    } finally { await h.cleanup(); }
  });

  it('waits without extra calls and wakes for a due commitment', async () => {
    const h = await harness({ settings: { reviewIntervalMinutes: 60, maxCycles: null, maxFollowUpDepth: 0 } });
    try {
      await runToRest(h.runner);
      expect(h.org.business.waiting).toBe(true);
      const calls = h.org.usage.calls;
      await new Promise((r) => setTimeout(r, 30));
      expect(h.org.usage.calls).toBe(calls);
      const date = new Date(Date.now() + 100).toISOString();
      await h.runner.businessCommand({ kind: 'job', record: jobInput({ title: 'Timed quote', notBefore: date, dueAt: date }) });
      const timed = h.org.business.jobs.find((j) => j.title === 'Timed quote')!;
      expect(timed.plan).toBeNull();
      await waitFor(() => timed.plan !== null, 'the calendar to start its commitment');
      await h.runner.idle();
      expect(timed.status).toBe('review');
      expect(h.org.business.waiting).toBe(true);
    } finally { await h.cleanup(); }
  });

  it('an event wakes a waiting organisation but never overrides a manual pause', async () => {
    const h = await harness({ settings: { reviewIntervalMinutes: 60, maxCycles: null, maxFollowUpDepth: 0 } });
    try {
      await runToRest(h.runner);
      h.runner.pause();
      const calls = h.org.usage.calls;
      await h.runner.businessCommand({ kind: 'event', record: { ownerId: 'cto', title: 'New enquiry', detail: 'A real input is ready.', source: 'test', externalId: 'e1' } });
      await new Promise((r) => setTimeout(r, 20));
      expect(h.org.usage.calls).toBe(calls);
      expect(h.org.pauseReason).toBe('user');
      h.runner.start();
      await waitFor(() => h.org.usage.calls > calls, 'the queued event after resume');
      await h.runner.idle();
      expect(h.org.business.events).toHaveLength(1);
    } finally { await h.cleanup(); }
  });

  it('auto-resumes waiting state on restart only when enabled; manual pauses stay paused', async () => {
    const h = await harness({ settings: { reviewIntervalMinutes: 60, resumeOnRestart: true, maxCycles: null, maxFollowUpDepth: 0 } });
    let reloaded: Registry | undefined;
    try {
      await runToRest(h.runner);
      await h.runner.flush();
      const wakeAt = h.org.business.nextReviewAt;
      const calls = h.org.usage.calls;
      h.runner.dispose();
      reloaded = new Registry(h.store, h.provider);
      await reloaded.load();
      const resumed = reloaded.get(h.org.id)!;
      expect(resumed.org.status).toBe('running');
      expect(resumed.org.business.nextReviewAt).toBe(wakeAt);
      expect(resumed.org.usage.calls).toBe(calls);
      resumed.pause();
      await resumed.flush();
      resumed.dispose();
      reloaded = new Registry(h.store, h.provider);
      await reloaded.load();
      expect(reloaded.get(h.org.id)!.org.pauseReason).toBe('user');
      expect(reloaded.get(h.org.id)!.org.status).toBe('paused');
    } finally { await reloaded?.shutdown(); await h.cleanup(); }
  });

  it('delivers each past scheduling boundary once and respects cycle/budget limits', async () => {
    const h = await harness({ settings: { reviewIntervalMinutes: 60, maxCycles: 1 } });
    try {
      applyBusinessCommand(h.org, { kind: 'job', record: jobInput({ dueAt: '2020-01-01T00:00:00Z' }) }, person);
      h.org.business.reviewRequested = false;
      h.org.business.nextReviewAt = new Date(Date.now() + 60_000).toISOString();
      expect(nextBusinessWake(h.org)).toBeLessThanOrEqual(Date.now());
      consumeBusinessWake(h.org);
      expect(nextBusinessWake(h.org)).toBeGreaterThan(Date.now());
      await runToRest(h.runner);
      expect(h.org.pauseReason).toBe('cycle_limit');
      const calls = h.org.usage.calls;
      h.runner.reviewNow();
      expect(h.org.usage.calls).toBe(calls);
    } finally { await h.cleanup(); }
  });

  it('keeps commitment evidence after execution plans are archived', async () => {
    const h = await harness({ settings: { maxCycles: 5, maxFollowUpDepth: 0 }, executives: [{ profileId: 'engineering', agentCount: 1 }] });
    try {
      await runToRest(h.runner);
      const first = h.org.business.jobs.find((j) => j.plan?.cycle === 1)!;
      expect(first.status).toBe('review');
      expect(first.evidence).not.toBe('');
      expect(h.org.plans.some((p) => p.id === first.plan!.id)).toBe(false);
      expect(first.verification).toBeNull();
    } finally { await h.cleanup(); }
  });

  it('runs the fictional Only Paperclips enquiry to an evidenced delivery, then unlocks its dependent job', async () => {
    const h = await harness();
    const demo = await createOnlyPaperclips(h.registry);
    try {
      expect(demo.org.name).toBe('Only Paperclips');
      expect(demo.org.business.finances[0]!.status).toBe('forecast');
      demo.start();
      await demo.idle();
      const enquiry = demo.org.business.jobs.find((j) => j.id === demo.org.business.events[0]!.jobId)!;
      expect(enquiry.status).toBe('review');
      expect(enquiry.evidence).not.toBe('');
      const delivery = demo.org.business.jobs.find((j) => j.dependsOn.includes(enquiry.id))!;
      expect(delivery.plan).toBeNull();
      await demo.businessCommand({ kind: 'verify', id: enquiry.id, revision: enquiry.revision, evidence: 'Inspected the simulated quote artifact; this verifies the demo only.' });
      await waitFor(() => delivery.plan !== null, 'the verified handover to operations');
      await demo.idle();
      expect(delivery.status).toBe('review');
      expect(delivery.reviewerId).toBe('qa');
      expect(demo.org.business.jobs.filter((j) => j.id === enquiry.id)).toHaveLength(1);
      expect(demo.org.business.lastDigest).toContain('awaiting verification');
    } finally { demo.stop(); await demo.idle(); await demo.flush(); demo.dispose(); await h.cleanup(); }
  });
});

