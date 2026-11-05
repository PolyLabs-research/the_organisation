import type { CallUsage } from './types';

export interface ModelPrice {
  id: string;
  label: string;
  /** USD per million tokens. */
  input: number;
  output: number;
  cacheRead: number;
  /** 5-minute cache write, the only TTL this project uses. */
  cacheWrite: number;
  /** The web search tool version the model takes. */
  webSearch: 'web_search_20260209' | 'web_search_20250305';
}

// Anthropic first-party API list prices, as published 2026-10. Spend figures
// derived from them are estimates: check the Console for what was billed.
export const MODELS: ModelPrice[] = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, webSearch: 'web_search_20260209' },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5, webSearch: 'web_search_20260209' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5, webSearch: 'web_search_20260209' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, webSearch: 'web_search_20250305' },
];

export const DEFAULT_MODEL = 'claude-opus-5-5';

/** USD per web search request. */
const WEB_SEARCH_PRICE = 0.01;

const BY_ID = new Map(MODELS.map((m) => [m.id, m]));

export function isKnownModel(id: string): boolean {
  return BY_ID.has(id);
}

/** The newer search tool filters its own results; models it does not run on take the basic one. */
export function webSearchToolFor(model: string): ModelPrice['webSearch'] {
  return BY_ID.get(model)?.webSearch ?? 'web_search_20260209';
}

/** Tokens in, dollars out. A model missing from the table is priced as the default model. */
export function priceUsage(tokens: Omit<CallUsage, 'costUsd'>): CallUsage {
  const price = BY_ID.get(tokens.model) ?? BY_ID.get(DEFAULT_MODEL)!;
  const costUsd =
    (tokens.inputTokens * price.input +
      tokens.outputTokens * price.output +
      tokens.cacheReadTokens * price.cacheRead +
      tokens.cacheWriteTokens * price.cacheWrite) /
      1_000_000 +
    tokens.webSearches * WEB_SEARCH_PRICE;
  return { ...tokens, costUsd };
}
