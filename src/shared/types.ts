// Domain model shared by the server (engine, API) and the browser client.

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * Where a plan's agents do their work.
 * local: on this machine, through file tools; they cannot run code.
 * managed: in a Claude Managed Agents session, a hosted sandbox where they can run and test what they build.
 */
export type ExecutionMode = 'local' | 'managed';

/** One step of a standard operating profile, e.g. "Spec" in Spec → Build → Test → Release. */
export interface SopPhase {
  id: string;
  name: string;
  /** What the phase is for. */
  purpose: string;
  /** What must exist when the phase is finished. */
  deliverable: string;
}

export type ExecutiveKind = 'ceo' | 'lead' | 'judge';

/** A profile type from the library: a role plus the operating profile it always follows. */
export interface OperatingProfile {
  id: string;
  kind: ExecutiveKind;
  /** Short code shown on badges, e.g. "CTO". */
  short: string;
  title: string;
  /** The function the role leads, e.g. "Engineering". */
  function: string;
  remit: string;
  phases: SopPhase[];
  defaultAgents: number;
  /** Hue (0-360) used for the role's colour in the UI. */
  hue: number;
}

/** A seat on the executive team of one organisation. */
export interface Executive {
  id: string;
  /** Library profile this seat was created from, or "custom". */
  profileId: string;
  kind: ExecutiveKind;
  short: string;
  title: string;
  function: string;
  remit: string;
  /** This seat's standard operating profile. Every plan it owns runs these phases in order. */
  phases: SopPhase[];
  /** Number of agents under this lead's control. Zero for the CEO and the judge. */
  agentCount: number;
  hue: number;
}

export interface OrgSettings {
  /** Who signs off decisions when leads have competing priorities. */
  arbiter: 'ceo' | 'judge';
  /** The loop pauses itself when estimated spend reaches this. */
  budgetUsd: number;
  /** Stop after this many cycles; null runs until paused. */
  maxCycles: number | null;
  /** How many generations of follow-up plans a board report may trigger within one cycle. */
  maxFollowUpDepth: number;
  /** Upper bound on tasks a lead may hand out in one phase. */
  maxTasksPerPhase: number;
  /** Let agents search the web (billed per search by the provider). */
  webResearch: boolean;
  executiveModel: string;
  workerModel: string;
  executiveEffort: Effort;
  workerEffort: Effort;
  /** Upper bound on model calls in flight at once across the organisation. */
  maxConcurrentCalls: number;
  /** How plans are carried out. */
  execution: ExecutionMode;
  /**
   * In hosted sessions: whether a lead may start workflow runs, background work that puts many
   * agents on the pieces of one phase. Every agent in a run uses tokens.
   */
  workflowRuns: boolean;
}

export type TaskStatus = 'pending' | 'running' | 'done' | 'failed';

export interface Task {
  id: string;
  title: string;
  brief: string;
  status: TaskStatus;
  /** Which of the lead's agents (1-based) took the task. */
  agent: number | null;
  /** True when the lead added it after sending a phase back for rework. */
  rework: boolean;
  /** The agent's closing report to its lead. */
  result: string | null;
  /** Set on client views when `result` was shortened for transport. */
  resultTruncated?: boolean;
  /** Workspace paths the agent wrote. */
  files: string[];
  error: string | null;
  attempts: number;
  startedAt: string | null;
  finishedAt: string | null;
  /** For work done in a hosted session: the session thread of the agent that did it. */
  threadId?: string | null;
}

export type PhaseStatus = 'pending' | 'working' | 'done';

export interface PlanPhase {
  sopPhaseId: string;
  name: string;
  purpose: string;
  deliverable: string;
  /** The lead's outline of what this phase means for this particular plan. */
  intent: string;
  /** What the lead told every agent on the phase when handing out the work. */
  notes: string;
  status: PhaseStatus;
  tasks: Task[];
  reworkRounds: number;
  /** The lead's gate review once the phase's tasks are in. */
  summary: string | null;
}

export type PlanStatus =
  | 'planning' // lead is drafting
  | 'drafted' // waiting for the board to look at it
  | 'in_review' // other leads are checking it against their priorities
  | 'contested' // a board decision is open on it
  | 'revising' // lead is applying a ruling
  | 'approved' // cleared; execution starts next
  | 'executing'
  | 'reporting' // phases done; lead is writing the board report
  | 'done'
  | 'cancelled'
  | 'failed';

export type PlanOrigin = { type: 'directive' } | { type: 'follow_up'; reportIds: string[] };

/** A cross-remit issue a lead flags while planning, for the board to settle. */
export interface Escalation {
  issue: string;
  proposal: string;
}

/** A background run a lead started in a hosted session to put many agents on one phase's work. */
export interface WorkflowRun {
  id: string;
  name: string;
  description: string | null;
  status: 'running' | 'paused' | 'completed' | 'stopped' | 'failed';
  error: string | null;
  /** The steps the lead's workflow declared, and how far it has got. */
  steps: Array<{ id: string; name: string; status: 'pending' | 'running' | 'done' }>;
  /** Agents the run has started. */
  agents: number;
  /** Which phase of the operating profile the run belongs to. */
  phaseIndex: number;
  startedAt: string;
  endedAt: string | null;
}

/** The hosted session carrying out a plan, when the organisation runs plans as Claude Managed Agents sessions. */
export interface ManagedSession {
  sessionId: string | null;
  /** Where to watch the session in the Anthropic Console. */
  consoleUrl: string | null;
  /** The spend cap currently set on the session, enforced by the platform. */
  budgetUsd: number;
  /** What the session has spent so far at list prices, as the platform reports it. */
  spentUsd: number;
  /** Cumulative token counts behind `spentUsd`. */
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; webSearches: number };
  state: 'starting' | 'running' | 'paused' | 'at_budget' | 'finished';
  runs: WorkflowRun[];
  /** The lead's report, held until the session's files have been brought home. */
  pendingReport: { headline: string; summary: string; outcomes: string[]; asks: string[] } | null;
  /** How many of the plan's binding instructions the session has been told. */
  instructionsSent: number;
  /** Tool calls the platform could not clear as safe, declined because nobody was watching. */
  declined: number;
  /** The lead's latest note on what it is doing. */
  note: string | null;
  /** Files the session has produced, as workspace paths. */
  files: string[];
  /** Sessions of this plan that ended without a report. A lost session is replaced once; after that the organisation stops. */
  attempts: number;
  /** Outputs already brought home: file id to size in bytes. */
  synced: Record<string, number>;
  /** The session threads of the lead's own agents, in the order they were first given work. Agent 1 is the first. */
  agents: string[];
  /** The most recent tool call that was declined, for the record. */
  lastDeclined: string | null;
  /** Where to start reading the session's events when it is next followed. */
  cursor: string | null;
  /** How far the session's events have been acted on. Later than `cursor` while a call from the session awaits its answer. */
  handledTo?: string | null;
}

export interface Plan {
  id: string;
  cycle: number;
  ownerId: string;
  origin: PlanOrigin;
  /** 0 for CEO directives; +1 for each generation of follow-up. */
  depth: number;
  objective: string;
  successCriteria: string;
  priority: 'high' | 'medium' | 'low';
  rationale: string;
  /** The lead's approach, written when the plan is drafted. */
  approach: string | null;
  phases: PlanPhase[];
  status: PlanStatus;
  /** Binding instructions added by board rulings or the CEO enforcing steer. */
  amendments: string[];
  escalations: Escalation[];
  decisionId: string | null;
  reportId: string | null;
  cancelReason: string | null;
  createdAt: string;
  updatedAt: string;
  /** How this plan is being carried out; fixed when execution begins. */
  execution: ExecutionMode | null;
  managed: ManagedSession | null;
}

export interface Objection {
  planId: string;
  byId: string;
  concern: string;
  proposal: string;
}

/** One pass of the board over a batch of freshly drafted plans. */
export interface ReviewRound {
  id: string;
  cycle: number;
  planIds: string[];
  reviewerIds: string[];
  /** Objections per reviewer; an empty list means "no objection". */
  reviews: Record<string, Objection[]>;
  status: 'open' | 'closed';
}

export type Stance = 'back_plan' | 'back_objection' | 'compromise';

export interface Position {
  stance: Stance;
  argument: string;
}

export interface DecisionOutcome {
  /** lead: decided inside a remit. consensus: the board agreed and the arbiter ratified. ceo/judge: the arbiter ruled. */
  method: 'lead' | 'consensus' | 'ceo' | 'judge';
  byId: string;
  ruling: string;
  rationale: string;
  planAction: 'proceed' | 'amend' | 'cancel';
  amendments: string[];
  at: string;
}

export interface Decision {
  id: string;
  cycle: number;
  at: string;
  kind: 'in_remit' | 'contested';
  title: string;
  context: string;
  raisedById: string;
  planId: string | null;
  issues: Array<{ byId: string; concern: string; proposal: string }>;
  participantIds: string[];
  positions: Record<string, Position>;
  status: 'open' | 'deliberated' | 'resolved';
  outcome: DecisionOutcome | null;
}

export interface BoardReport {
  id: string;
  planId: string;
  fromId: string;
  cycle: number;
  at: string;
  headline: string;
  summary: string;
  outcomes: string[];
  files: string[];
  /** Requests to other leads or the board. */
  asks: string[];
}

export type BoardMessageType =
  | 'ceo_question'
  | 'consult'
  | 'direction'
  | 'plan'
  | 'review'
  | 'decision'
  | 'report'
  | 'reaction'
  | 'steer'
  | 'steer_response'
  | 'system';

/** One entry in the board feed. `fromId` is an executive id, "shareholders" or "system". */
export interface BoardMessage {
  id: string;
  at: string;
  cycle: number;
  type: BoardMessageType;
  fromId: string;
  title: string;
  body: string;
  planId?: string;
  decisionId?: string;
  reportId?: string;
}

export interface Steer {
  id: string;
  at: string;
  text: string;
  status: 'new' | 'acknowledged';
  /** The CEO's response once it has acted on the steer. */
  response: string | null;
  acknowledgedAt: string | null;
}

export interface ConsultInput {
  proposal: string;
  rationale: string;
  needs: string;
}

export type CycleStage = 'consult' | 'direct' | 'work';

export interface CycleState {
  number: number;
  stage: CycleStage;
  consults: Record<string, ConsultInput>;
  /** The CEO's reading of what the shareholders want now. */
  intent: string | null;
  priorities: string[];
  startedAt: string;
}

export interface CycleRecord {
  number: number;
  intent: string;
  priorities: string[];
  /** Digest of what the cycle delivered, built from the board reports. */
  summary: string;
  planCount: number;
  startedAt: string;
  endedAt: string;
}

export interface UsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  webSearches: number;
  costUsd: number;
}

export type OrgStatus = 'idle' | 'running' | 'paused';
export type PauseReason = 'user' | 'budget' | 'error' | 'restart' | 'cycle_limit';

export interface Organisation {
  id: string;
  /** Counter behind the short ids of plans, tasks, decisions and messages. */
  seq: number;
  name: string;
  /** The idea as the founder described it. */
  idea: string;
  mission: string;
  createdAt: string;
  updatedAt: string;
  settings: OrgSettings;
  executives: Executive[];
  status: OrgStatus;
  pauseReason: PauseReason | null;
  lastError: string | null;
  cycle: CycleState;
  history: CycleRecord[];
  plans: Plan[];
  reviewRounds: ReviewRound[];
  decisions: Decision[];
  reports: BoardReport[];
  /** Board reports each lead has not yet reacted to. */
  inbox: Record<string, string[]>;
  board: BoardMessage[];
  steers: Steer[];
  usage: UsageTotals;
  usageByExec: Record<string, UsageTotals>;
}

/** Something the organisation is doing right now; transient, never persisted. */
export interface ActiveWork {
  key: string;
  kind: WorkKind;
  /** The executive doing it, or whose agent is doing it. */
  execId: string;
  /** Agent slot (1-based) for worker tasks. */
  agent: number | null;
  label: string;
  planId: string | null;
  startedAt: string;
}

export type WorkKind =
  | 'consult'
  | 'direct'
  | 'plan'
  | 'review'
  | 'position'
  | 'signoff'
  | 'revise'
  | 'kickoff'
  | 'task'
  | 'phase_review'
  | 'report'
  | 'react'
  | 'steer_review'
  | 'execute';

/** A record of one model call, for the activity log. */
export interface ActivityEntry {
  id: string;
  at: string;
  kind: WorkKind | 'recommend_team';
  execId: string | null;
  label: string;
  model: string;
  ms: number;
  ok: boolean;
  error: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface OrgSummary {
  id: string;
  name: string;
  mission: string;
  status: OrgStatus;
  pauseReason: PauseReason | null;
  cycle: number;
  stage: CycleStage;
  costUsd: number;
  budgetUsd: number;
  executives: Array<Pick<Executive, 'id' | 'short' | 'title' | 'hue' | 'kind' | 'agentCount'>>;
  createdAt: string;
  updatedAt: string;
}

/** What the server pushes to an open dashboard. */
export interface OrgView {
  org: Organisation;
  active: ActiveWork[];
  /** True while a pause is draining calls that were already in flight. */
  draining: boolean;
}

export interface ProviderInfo {
  id: 'claude' | 'mock';
  label: string;
  /** True when no real model is being called and spend figures are simulated. */
  simulated: boolean;
  defaultModel: string;
  models: Array<{ id: string; label: string; inputPerMTok: number; outputPerMTok: number }>;
  /** True when plans can be run as hosted sessions (Claude Managed Agents). */
  managed: boolean;
}

// ---- API payloads ----

export interface ExecutiveDraft {
  profileId: string;
  short?: string;
  title?: string;
  function?: string;
  remit?: string;
  phases?: SopPhase[];
  agentCount?: number;
  /** Why this seat was recommended (shown in the wizard only). */
  rationale?: string;
}

export interface TeamRecommendation {
  name: string;
  mission: string;
  executives: ExecutiveDraft[];
  /** What asking for the recommendation cost. It belongs to no organisation, so no budget covers it. */
  costUsd: number;
}

export interface CreateOrgRequest {
  name: string;
  idea: string;
  mission?: string;
  executives: ExecutiveDraft[];
  settings?: Partial<OrgSettings>;
  steer?: string;
}

export interface WorkspaceFile {
  path: string;
  size: number;
  modifiedAt: string;
}
