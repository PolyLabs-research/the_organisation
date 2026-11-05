import { describe, expect, it } from 'vitest';
import { canHost, canSearch, dollars } from '../src/client/ModelPicker';
import type { ModelOption } from '../src/shared/types';

// The rules the interface goes by when it offers hosted sessions and web search, and how it writes a price.

const model = (id: string, connectionId: string | undefined, claude: boolean): ModelOption => ({
  id,
  label: id,
  inputPerMTok: 1,
  outputPerMTok: 2,
  ...(connectionId ? { connectionId } : {}),
  provider: connectionId ?? 'Simulation',
  hosted: claude,
  web: claude,
});
const MODELS = [
  model('claude-opus-5-5', 'anthropic', true),
  model('claude-haiku-5-5', 'anthropic', true),
  model('anthropic-2:claude-opus-5-5', 'anthropic-2', true),
  model('openai:gpt-6.1-sol', 'openai', false),
];

describe('what the interface offers for a choice of models', () => {
  it('offers hosted sessions only when both models are Claude models on one key', () => {
    expect(canHost(MODELS, 'claude-opus-5-5', 'claude-haiku-5-5')).toBe(true);
    expect(canHost(MODELS, 'claude-opus-5-5', 'claude-opus-5-5')).toBe(true);
    // Two Anthropic keys are two accounts, and a session lives on one.
    expect(canHost(MODELS, 'claude-opus-5-5', 'anthropic-2:claude-opus-5-5')).toBe(false);
    expect(canHost(MODELS, 'claude-opus-5-5', 'openai:gpt-6.1-sol')).toBe(false);
    expect(canHost(MODELS, 'openai:gpt-6.1-sol', 'claude-opus-5-5')).toBe(false);
    expect(canHost(MODELS, 'openai:gpt-6.1-sol', 'openai:gpt-6.1-sol')).toBe(false);
    // A model no key can call hosts nothing.
    expect(canHost(MODELS, 'claude-opus-5-5', 'gone:model')).toBe(false);
    // The simulator's models have no key between them and can all be hosted together.
    const simulated = [model('claude-opus-5-5', undefined, true), model('claude-haiku-5-5', undefined, true)];
    expect(canHost(simulated, 'claude-opus-5-5', 'claude-haiku-5-5')).toBe(true);
  });

  it('offers web search by the agents\' model alone', () => {
    expect(canSearch(MODELS, 'claude-haiku-5-5')).toBe(true);
    expect(canSearch(MODELS, 'openai:gpt-6.1-sol')).toBe(false);
    expect(canSearch(MODELS, 'gone:model')).toBe(false);
  });

  it('writes a price the way a price list does', () => {
    expect([10, 2, 1.5, 1.32, 0.834, 0.3, 0.15, 0.075, 0.006, 0.0375, 0].map(dollars)).toEqual(['$10', '$2', '$1.50', '$1.32', '$0.834', '$0.30', '$0.15', '$0.075', '$0.006', '$0.0375', 'free']);
  });
});
