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
  /** How many web searches the agent may make: in one model request, and over the whole run. */
  webSearch: { perRequest: number; perTask: number } | null;
  maxTurns: number;
  /** Checked between turns. True ends the run at once and nothing from it is kept. */
  shouldStop?: () => boolean;
  /** Checked between turns. True has the agent stop using tools and give its closing report. */
  shouldWrapUp?: () => boolean;
}

export interface AgentResult {
  /** The agent's closing message. */
  text: string;
  turns: number;
  /** done: finished by itself. cut_short: told to wrap up before it had finished. interrupted: `shouldStop` fired. */
  stopped: 'done' | 'cut_short' | 'interrupted';
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

// ---- running a whole plan in a hosted session ----

/** The two things a lead in a session tells the organisation, by name. The lead's instructions refer to them by these names. */
export const PLAN_TOOLS = { recordPhase: 'record_phase', reportToBoard: 'report_to_board' } as const;

/** What a lead recorded when a phase of its operating profile passed its gate. */
export interface PhaseRecord {
  /** The phase, by name or id, as the lead gave it. */
  phase: string;
  summary: string;
  decisions: Array<{ title: string; decision: string; rationale: string }>;
}

export interface BoardReportDraft {
  headline: string;
  summary: string;
  outcomes: string[];
  asks: string[];
}

/** A workflow run the lead started: background work that puts many agents on one phase. */
export interface RunUpdate {
  id: string;
  event: 'created' | 'running' | 'paused' | 'step_started' | 'step_ended' | 'ended';
  name?: string;
  description?: string | null;
  steps?: Array<{ id: string; name: string }>;
  stepId?: string;
  result?: 'completed' | 'stopped' | 'failed';
  error?: string;
}

/** A session's spend so far, cumulative, as the platform reports it. */
export interface SessionSpend {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  webSearches: number;
}

/** The answer to something a lead recorded: whether it stands, and what to tell the lead. */
export interface HookReply {
  ok: boolean;
  message: string;
}

/** A message for the lead, and how far it brings the lead up to date with the board's binding instructions. */
export interface Briefing {
  message: string;
  /** The message states every instruction the board has given up to this one, counting from the first. */
  instructions: number;
}

/**
 * How a hosted session talks back to the engine while it runs. A session is
 * re-read from its history after a reconnect, so every hook is safe to call
 * again with something it has already been told.
 */
export interface PlanHooks {
  /** A session exists, or its spend cap changed. */
  session(info: { id: string; consoleUrl: string | null; budgetUsd: number }): void;
  phase(record: PhaseRecord): HookReply;
  report(draft: BoardReportDraft): HookReply;
  /** An agent was given work: by the lead (with the brief), or by a workflow run (the brief is not on the lead's stream). */
  assigned(work: { threadId: string; agentName: string; brief: string | null; runId: string | null }): void;
  /** An agent reported back to the lead. */
  reported(threadId: string, text: string): void;
  /** An agent's work ended without a report reaching the lead's stream. */
  agentEnded(threadId: string, how: 'finished' | 'failed', detail?: string): void;
  run(update: RunUpdate): void;
  spend(total: SessionSpend): void;
  /** Something the lead said. */
  note(text: string): void;
  /** A tool call was declined: the platform judged it unsafe, or could not judge it and nobody was there to approve it. */
  declined(tool: string, detail: string): void;
  /** A file the session produced, to be put in the workspace. Returns the workspace path, or null if it could not be kept. */
  output(file: { id: string; name: string; bytes: Uint8Array }): Promise<string | null>;
  /** Whether a produced file has already been brought home at this size. */
  hasOutput(file: { id: string; size: number }): boolean;
  /** Binding instructions the session has not been told yet, as a message for the lead. */
  instructions(): Briefing | null;
  /** The session has now been told the board's instructions up to this one, counting from the first. Safe to say twice. */
  instructed(upTo: number): void;
  /** pause: hold the session where it is. cancel: the plan is off. null: carry on. */
  halt(): 'pause' | 'cancel' | null;
  /** The session is at its spend cap. A higher cap in dollars, or null to leave it there. */
  moreBudget(spentUsd: number): number | null;
  /**
   * Where a later attachment should start reading the session's events, and how far they have already been
   * acted on. The two differ while a call from the session is still waiting for its answer.
   */
  checkpoint(readFrom: string, handledTo: string): void;
}

export interface PlanJob {
  planId: string;
  /** Shown as the session's title in the Console. */
  title: string;
  /** The lead's system prompt for this organisation and seat. */
  system: string;
  /** The message that starts the plan in a new session. */
  kickoff: Briefing;
  /** The message that sets a session going again when it has stopped short of reporting. Built when needed, from the plan as it then stands. */
  resume(): Briefing;
  executiveModel: string;
  executiveEffort: Effort;
  workerModel: string;
  workerEffort: Effort;
  /** The agent the lead hands work to: the name the lead knows it by, and its standing instructions. */
  worker: { name: string; system: string };
  /** Whether agents may use the web. In a hosted session this also opens the sandbox's network. */
  web: boolean;
  /** Whether the lead may start workflow runs. The lead's instructions say the same. */
  workflows: boolean;
  /** The session's spend cap, in dollars. */
  budgetUsd: number;
  /** An existing session to pick up, or null to start one. */
  session: {
    id: string;
    /** Read the session's events from this time on. */
    cursor: string | null;
    /** Events before this time have already been acted on. */
    handled: string | null;
    /** Workflow runs that had not ended when the session was last followed. */
    openRuns: string[];
    /** Threads known to belong to workflow runs, whose agents are not the lead's own. */
    runThreads: string[];
    /** Whether the lead's report to the board has already been taken. */
    reported: boolean;
  } | null;
  /** Workspace files to mount read-only in the sandbox. */
  files: Array<{ path: string; absolutePath: string; size: number; modifiedAt: string }>;
  /** Where the provider may keep its own records for this organisation. */
  stateDir: string;
  /** Aborted when work in flight is to be dropped at once. The session is still held properly. */
  signal?: AbortSignal;
  hooks: PlanHooks;
  /** The same facts the messages state, as data, for providers that do not read prose (the simulator). */
  context: Record<string, unknown>;
}

export type PlanOutcome =
  /** The lead reported to the board and the session's files are home. */
  | { status: 'reported' }
  /** Held: by a pause, or at a spend cap that was not raised. The session can be picked up again. */
  | { status: 'paused' | 'at_budget' }
  | { status: 'cancelled' }
  /** The session ended without a report and cannot be continued. */
  | { status: 'lost'; reason: string };

export interface Provider {
  info(): ProviderInfo;
  /** One call that returns data matching `schema`. */
  structured<T>(req: StructuredRequest<T>): Promise<T>;
  /** A tool-using agent run that ends with a closing message. */
  agent(req: AgentRequest): Promise<AgentResult>;
  /** Carry a whole plan through in a hosted session. Present only on providers that can. */
  executePlan?(job: PlanJob): Promise<PlanOutcome>;
  /** What one agent in a hosted session was asked and what it reported, fetched on demand. */
  agentDetail?(sessionId: string, threadId: string): Promise<{ brief: string | null; report: string | null }>;
}
