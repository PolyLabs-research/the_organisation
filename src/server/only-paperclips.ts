import type { Registry } from './registry';
import { ValidationError } from './engine/state';

/** Explicitly fictional, deterministic example. Never connects to real customers or money. */
export async function createOnlyPaperclips(registry: Registry) {
  if (!registry.provider.info().simulated) throw new ValidationError('The Only Paperclips example uses simulation. Start the server with ORG_PROVIDER=mock.');
  const runner = await registry.create({
    name: 'Only Paperclips',
    idea: 'A small business supplying paperclips to local offices. Earn repeat orders through useful service and reliable delivery. The universe is not raw material.',
    executives: [{ profileId: 'sales', agentCount: 1 }, { profileId: 'operations', agentCount: 1 }, { profileId: 'finance', agentCount: 1 }, { profileId: 'assurance', agentCount: 1 }],
    settings: { reviewIntervalMinutes: 60, maxFollowUpDepth: 0, budgetUsd: 5, resumeOnRestart: false },
    steer: 'This is a fictional demonstration. Use clearly labelled example data. No real orders, messages, payments or signatures. Optimise customer satisfaction and a viable business, not the number of paperclips in existence.',
  });
  const add = (kind: string, record: unknown) => runner.businessCommand({ kind, record });
  const due = new Date(Date.now() + 86_400_000).toISOString();
  await add('customer', { name: 'Example Office (fictional)', ownerId: 'cro', stage: 'enquiry', notes: 'Demo enquiry for 100 boxes of paperclips.', source: 'Only Paperclips demonstration' });
  const customerId = runner.org.business.customers[0]!.id;
  await add('metric', { title: 'Verified demo orders delivered', ownerId: 'coo', target: 1, value: null, unit: 'orders', basis: 'unknown' });
  await add('memory', { title: 'Only Paperclips operating charter', ownerId: 'ceo', category: 'policy', content: 'Serve customers who want paperclips. Keep commitments, record evidence and stay within the agreed budget. Planetary conversion is outside our product roadmap.', source: 'Shareholders — fictional example' });
  await add('event', { title: 'Prepare a quote for Example Office', detail: 'Fictional enquiry: 100 boxes, with a clear price and delivery estimate. Produce a draft for review; nothing is sent.', ownerId: 'cro', source: 'demo-inbox', externalId: 'only-paperclips-enquiry-001', customerId, dueAt: due });
  const enquiryJob = runner.org.business.jobs[0]!;
  await add('job', { title: 'Prepare the demo delivery plan', ownerId: 'coo', description: 'A checked fulfilment plan for the fictional order, with unknown supplier facts marked.', nextAction: 'Wait for the quote to be verified, then plan the delivery.', dependsOn: [enquiryJob.id], customerId, metricId: runner.org.business.metrics[0]!.id, reviewerId: 'qa', dueAt: due });
  await add('job', { title: 'Review paperclip stock and supplier assumptions', ownerId: 'coo', description: 'Weekly check using available evidence; record what is still unknown.', nextAction: 'Review stock evidence at the next due date.', notBefore: new Date(Date.now() + 7 * 86_400_000).toISOString(), dueAt: new Date(Date.now() + 7 * 86_400_000).toISOString(), recurrenceDays: 7 });
  await add('finance', { title: 'Illustrative order value — not an invoice or payment', ownerId: 'cfo', direction: 'income', amountMinor: 25000, currency: 'GBP', status: 'forecast', customerId, source: 'Fictional example estimate' });
  return runner;
}

