import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { applyBusinessUpdates } from '../src/server/engine/business';
import * as schemas from '../src/server/engine/schemas';
import { strictSchema, type JsonSchema } from '../src/server/providers/schema';
import { harness } from './helpers';

// Claude's structured outputs refuse a schema with more than 16 parameters whose type is an array or anyOf,
// and one whose compiled grammar is too large, which the business commands alone were.
const UNION_LIMIT = 16;

function unions(node: unknown): number {
  if (!node || typeof node !== 'object') return 0;
  const schema = node as JsonSchema;
  const own = Array.isArray(schema.type) || 'anyOf' in schema ? 1 : 0;
  return own + Object.values(schema).reduce<number>((sum, value) => sum + (Array.isArray(value) ? value.reduce<number>((s, item) => s + unions(item), 0) : unions(value)), 0);
}

describe('structured output schemas', () => {
  const replies = Object.entries(schemas).flatMap(([name, value]) => {
    const schema = typeof value === 'function' ? (value as (...ids: string[][]) => unknown)(['cto'], ['job-1']) : value;
    return schema instanceof z.ZodType ? [[name, schema] as const] : [];
  });

  it.each(replies)('%s stays within the limit on union-typed parameters', (_name, schema) => {
    expect(unions(strictSchema(z.toJSONSchema(schema) as JsonSchema))).toBeLessThanOrEqual(UNION_LIMIT);
  });

  it('keeps business commands out of the grammar', () => {
    expect(z.toJSONSchema(schemas.Consult).properties?.operations).toMatchObject({ type: 'array', items: { type: 'string' } });
  });

  it('applies the commands a reply gives as JSON strings, with empty ids and dates as null', async () => {
    const h = await harness();
    try {
      applyBusinessUpdates(h.org, [JSON.stringify({ kind: 'job', record: { ownerId: 'cto', title: 'Deliver the quote', dueAt: '', customerId: '' } })], { id: 'person' });
      expect(h.org.business.jobs).toHaveLength(1);
      expect(h.org.business.jobs[0]).toMatchObject({ title: 'Deliver the quote', dueAt: null, customerId: null });
    } finally { await h.cleanup(); }
  });

  it('turns a command that is not JSON into a correction and applies nothing', async () => {
    const h = await harness();
    try {
      applyBusinessUpdates(h.org, [JSON.stringify({ kind: 'job', record: { ownerId: 'cto', title: 'Kept out' } }), '{kind: job'], { id: 'person' });
      expect(h.org.business.jobs).toHaveLength(0);
      expect(h.org.board.at(-1)).toMatchObject({ title: 'Operating update needs correction' });
    } finally { await h.cleanup(); }
  });
});
