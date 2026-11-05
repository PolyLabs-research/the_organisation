import type { z } from 'zod';
import type { Effort, ProviderInfo, WorkKind } from '../../shared/types';

/** What one model response cost. */
export interface CallUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  webSearches: number;
  costUsd: number;
}

/**
 * A system prompt in two parts so the provider can cache them separately: the
 * charter is identical for every seat in an organisation, the role differs.
 * Neither may contain anything that changes between calls.
 */
export interface SystemPrompt {
  charter: string;
  role: string;
}

interface BaseRequest {
  kind: WorkKind | 'recommend_team';
  system: SystemPrompt;
  prompt: string;
  model: string;
  effort: Effort;
  signal?: AbortSignal;
  /** Called once per model response, so spend is counted even if the call later fails. */
  onUsage?: (usage: CallUsage) => void;
  /** The same facts the prompt states, as data, for providers that do not read prose (the simulator). */
  context: Record<string, unknown>;
}

export interface StructuredRequest<T> extends BaseRequest {
  schema: z.ZodType<T>;
}

export interface AgentTool {
  name: string;
  description: string;
  schema: z.ZodType<Record<string, unknown>>;
  run(input: Record<string, unknown>): Promise<string>;
}

export interface AgentRequest extends BaseRequest {
  tools: AgentTool[];
  webSearch: { maxUses: number } | null;
  maxTurns: number;
  /** Checked between turns; returning true ends the run early. */
  shouldStop?: () => boolean;
}

export interface AgentResult {
  /** The agent's closing message. */
  text: string;
  turns: number;
  /** done: finished by itself. max_turns: ran out of turns. interrupted: `shouldStop` fired. */
  stopped: 'done' | 'max_turns' | 'interrupted';
}

export type ProviderErrorCode =
  | 'auth'
  | 'refusal'
  | 'truncated'
  | 'rate_limit'
  | 'bad_request'
  | 'invalid_output'
  | 'unavailable'
  | 'aborted';

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly code: ProviderErrorCode,
    /** Whether trying the same call again could succeed. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export interface Provider {
  info(): ProviderInfo;
  /** One call that returns data matching `schema`. */
  structured<T>(req: StructuredRequest<T>): Promise<T>;
  /** A tool-using agent run that ends with a closing message. */
  agent(req: AgentRequest): Promise<AgentResult>;
}
