import type { CallUsage } from './types';

interface Rates {
  /** USD per million tokens. */
  input: number;
  output: number;
  cacheRead: number;
  /** 5-minute cache write, the only TTL this project uses. */
  cacheWrite: number;
}

export interface ModelPrice extends Rates {
  id: string;
  label: string;
  /** The web search tool version the model takes. */
  webSearch: 'web_search_20260209' | 'web_search_20250305';
  /** Rates that apply instead when one request's prompt is longer than `above` tokens. */
  longPrompt?: Rates & { above: number };
}

// Anthropic first-party API list prices, as published 2026-10. Spend figures
// derived from them are estimates: check the Console for what was billed.

/** The models an organisation can be set to run on. */
export const MODELS: ModelPrice[] = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, webSearch: 'web_search_20260209' },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5, webSearch: 'web_search_20260209' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5, webSearch: 'web_search_20260209' },
  {
    id: 'claude-haiku-5-5',
    label: 'Claude Haiku 5.5',
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite: 0.125,
    webSearch: 'web_search_20250305',
    longPrompt: { above: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 },
  },
];

/**
 * Models an organisation cannot be set to, but which can end up serving a
 * request: when a safety classifier declines one, the API retries it on a
 * fallback model, and that attempt is billed at the fallback model's rates.
 */
const FALLBACK_RATES: Record<string, Rates> = {
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

export const DEFAULT_MODEL = 'claude-opus-5-5';

/** USD per web search request. */
export const WEB_SEARCH_PRICE = 0.01;

const BY_ID = new Map(MODELS.map((m) => [m.id, m]));

export function isKnownModel(id: string): boolean {
  return BY_ID.has(id);
}

/** The newer search tool filters its own results; models it does not run on take the basic one. */
export function webSearchToolFor(model: string): ModelPrice['webSearch'] {
  return BY_ID.get(model)?.webSearch ?? 'web_search_20260209';
}

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * What one model request cost. A model missing from both tables is priced as
 * the default model rather than as free.
 */
export function costOfRequest(model: string, tokens: TokenCounts): number {
  const price = BY_ID.get(model);
  let rates: Rates = price ?? FALLBACK_RATES[model] ?? BY_ID.get(DEFAULT_MODEL)!;
  const prompt = tokens.inputTokens + tokens.cacheReadTokens + tokens.cacheWriteTokens;
  if (price?.longPrompt && prompt > price.longPrompt.above) rates = price.longPrompt;
  return (
    (tokens.inputTokens * rates.input +
      tokens.outputTokens * rates.output +
      tokens.cacheReadTokens * rates.cacheRead +
      tokens.cacheWriteTokens * rates.cacheWrite) /
    1_000_000
  );
}

/** Tokens in, dollars out, for a call that was one request to one model. */
export function priceUsage(tokens: Omit<CallUsage, 'costUsd'>): CallUsage {
  return { ...tokens, costUsd: costOfRequest(tokens.model, tokens) + tokens.webSearches * WEB_SEARCH_PRICE };
}
