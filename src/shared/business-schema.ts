import { z } from 'zod';

const text = z.string().trim().max(4000);
const title = z.string().trim().min(1).max(200);
const id = z.string().trim().min(1).max(100);
const date = z.string().datetime({ offset: true }).nullable().default(null);
const ref = id.nullable().default(null);
const base = { id: ref, revision: z.number().int().nonnegative().nullable().default(null) };
const owner = { ownerId: id };
export const JobInput = z.object({
  ...base, ...owner, title, description: text.default(''), nextAction: text.default(''),
  status: z.enum(['open', 'blocked', 'in_progress', 'review', 'cancelled']).default('open'),
  blockedReason: text.default(''), notBefore: date, dueAt: date,
  recurrenceDays: z.number().int().min(1).max(3650).nullable().default(null),
  dependsOn: z.array(id).max(40).default([]), customerId: ref, metricId: ref, reviewerId: ref,
  evidence: z.string().trim().max(12000).default(''),
}).strict();
export const CustomerInput = z.object({
  ...base, ...owner, name: title, stage: z.enum(['enquiry', 'qualified', 'customer', 'inactive']).default('enquiry'),
  contact: text.default(''), notes: text.default(''), source: text.default(''),
}).strict();
export const MetricInput = z.object({
  ...base, ...owner, title, target: z.number().finite().nullable().default(null),
  value: z.number().finite().nullable().default(null), unit: z.string().max(60),
  basis: z.enum(['unknown', 'estimate', 'reported', 'confirmed']).default('unknown'),
  source: text.default(''), observedAt: date,
}).strict();
export const FinanceInput = z.object({
  ...base, ...owner, title, direction: z.enum(['income', 'expense']),
  amountMinor: z.number().int().min(0).max(1_000_000_000_000), currency: z.string().regex(/^[A-Z]{3}$/),
  status: z.enum(['forecast', 'outstanding', 'confirmed', 'void']).default('forecast'),
  dueAt: date, source: text.default(''), customerId: ref,
}).strict();
export const MemoryInput = z.object({
  ...base, ...owner, title, category: z.enum(['policy', 'fact', 'decision', 'lesson']),
  content: z.string().trim().min(1).max(12000), source: text.default(''), reviewAt: date,
}).strict();
export const EventInput = z.object({
  source: title, externalId: id, title, detail: text, ...owner, customerId: ref, dueAt: date,
}).strict();
export const BusinessCommand = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('noop') }).strict(),
  z.object({ kind: z.literal('job'), record: JobInput }).strict(),
  z.object({ kind: z.literal('customer'), record: CustomerInput }).strict(),
  z.object({ kind: z.literal('metric'), record: MetricInput }).strict(),
  z.object({ kind: z.literal('finance'), record: FinanceInput }).strict(),
  z.object({ kind: z.literal('memory'), record: MemoryInput }).strict(),
  z.object({ kind: z.literal('event'), record: EventInput }).strict(),
  z.object({ kind: z.literal('verify'), id, revision: z.number().int().nonnegative(), evidence: title }).strict(),
]);
export type BusinessCommand = z.infer<typeof BusinessCommand>;
/** Optional on old provider replies; the schema still describes it to real models. */
export const BusinessUpdates = z.array(BusinessCommand).max(12).default([]).describe('Updates to the shared business records, within your remit. Empty when no change is needed. Use the record revision from the current context; never invent confirmed facts or payments.');

