import { z } from 'zod';
import type { AgentTool } from './types';

// What model providers accept as a JSON Schema for structured output, and reading JSON back out of a reply.

// JSON Schema keywords that structured outputs do not accept. Zod adds numeric bounds to every integer.
const UNSUPPORTED_KEYWORDS = new Set([
  '$schema',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'minItems',
  'maxItems',
  'uniqueItems',
  'default',
]);

export type JsonSchema = Record<string, unknown>;

/** What a tool takes, as a model is shown it: the tool's own schema where it brings one, and otherwise what its zod schema gives. */
export function toolParameters(tool: Pick<AgentTool, 'schema' | 'parameters'>): JsonSchema {
  if (tool.parameters) return tool.parameters;
  const { $schema: _dialect, ...parameters } = z.toJSONSchema(tool.schema) as JsonSchema;
  return parameters;
}

/** The schema as structured outputs take it: unsupported keywords removed, objects closed, enums kept. */
export function strictSchema(node: JsonSchema): JsonSchema {
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(node)) {
    if (UNSUPPORTED_KEYWORDS.has(key)) continue;
    if (key === 'properties' || key === '$defs') {
      // The keys here are property names, not keywords, so none of them is dropped.
      out[key] = Object.fromEntries(Object.entries(value as Record<string, JsonSchema>).map(([name, sub]) => [name, strictSchema(sub)]));
    } else if (key === 'items') {
      out[key] = strictSchema(value as JsonSchema);
    } else if (key === 'anyOf' || key === 'allOf' || key === 'oneOf') {
      out[key === 'oneOf' ? 'anyOf' : key] = (value as JsonSchema[]).map(strictSchema);
    } else {
      out[key] = value;
    }
  }
  if (out.type === 'object') out.additionalProperties = false;
  return out;
}

/**
 * The JSON object in a reply from a model that was asked for JSON but not held to it: code fences and any
 * words around the object are dropped. Returns undefined if there is no object to be found.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const candidates = [trimmed];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const value: unknown = JSON.parse(candidate);
      if (value !== null && typeof value === 'object') return value;
    } catch {
      // try the next way of reading it
    }
  }
  return undefined;
}
