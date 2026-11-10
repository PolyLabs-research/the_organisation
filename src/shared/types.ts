// Domain model shared by the server (engine, API) and the browser client.
import type { BusinessState } from './business';
import type { OrgApproaches } from './approaches';
import type { OrgPrivileges } from './privileges';

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
  /** Something the system checks for itself at this phase's gate, whatever the lead and its agents say. */
  gate?: PhaseGate;
}

/** `checks`: every automated check passes on the plan's latest commit. `pull_request`: that, and a pull request is open for it. */
export type PhaseGate = 'checks' | 'pull_request';

export interface CheckResult {
  name: string;
  /** `skipped` finished without objecting, but proves nothing: GitHub's "neutral" and "skipped". */
  state: 'passed' | 'failed' | 'pending' | 'skipped';
  url: string;
}

/** What the system found at a gate, as opposed to what anyone reported. */
export interface GateEvidence {
  gate: PhaseGate;
  state: 'waiting' | 'passed' | 'failed';
  sha: string | null;
  summary: string;
  checks: CheckResult[];
  /** How long the gate has waited on this commit. Time the organisation spent paused does not count. */
  waitedMs: number;
  /** Another go cannot change this, so the plan stops rather than spending one. */
  final?: boolean;
  at: string;
}

/** The repository work behind a plan. Recorded by the tools that did it, never by what a model says. */
export interface PlanCode {
  repositoryId: string;
  /** owner/name */
  repository: string;
  branch: string;
  branchUrl: string;
  sha: string;
  pull: { number: number; url: string } | null;
}

/**
 * ceo and lead are the executive team. judge is seated when the organisation uses one to sign off decisions.
 * signatory is the seat that signs and pays: it is always there, and is held by a person unless set otherwise.
 */
export type ExecutiveKind = 'ceo' | 'lead' | 'judge' | 'signatory';

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
  /** Number of agents under this lead's control. Zero for every seat that is not a lead. */
  agentCount: number;
  hue: number;
}

/**
 * How fast the organisation moves on. step: nothing starts until a person says so, one piece of work each
 * time. slow: one piece of work at a time, with a pause after each. steady: one at a time, no pause.
 * free: as many at once as maxConcurrentCalls allows, as fast as the provider answers.
 */
export type Pace = 'step' | 'slow' | 'steady' | 'free';

export interface OrgSettings {
  /** Minutes between standing reviews. Zero retains the continuous loop. */
  reviewIntervalMinutes: number;
  /** Resume only organisations running before a restart. */
  resumeOnRestart: boolean;
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
  /** How fast work is started, so a person can follow it. */
  pace: Pace;
  /** How plans are carried out. */
  execution: ExecutionMode;
  /**
   * In hosted sessions: whether a lead may start workflow runs, background work that puts many
   * agents on the pieces of one phase. Every agent in a run uses tokens.
   */
  workflowRuns: boolean;
  /**
   * In hosted sessions: archive a plan's session once the plan is over. An archived session stays
   * readable in the Console but can no longer be changed, and archiving cannot be undone.
   */
  archiveSessions: boolean;
  /**
   * Who holds the seat that signs and pays.
   * human: a person, who acts outside this system and says here what was done or why it was refused.
   * ai: an AI seat authorises or declines each request. What it authorises still has to be carried out by a
   * person, since nothing here can move money or sign a document.
   */
  signatory: SignatoryHolder;
}

export type SignatoryHolder = 'human' | 'ai';

/**
 * A payment to make or a document to sign, put to the signatory by a lead. The organisation cannot do either
 * for itself, so this is the only way such a thing happens, and until a request is done it has not happened.
 */
export interface SignatoryRequest {
  id: string;
  /** The cycle it was raised in. */
  cycle: number;
  kind: 'payment' | 'signature';
  /** The lead who asked. */
  fromId: string;
  planId: string | null;
  /** The phase of the plan at whose gate it was raised. */
  phase: string | null;
  title: string;
  /** Why the organisation needs it now, and what exactly the signatory is asked to do. */
  detail: string;
  /** For a payment: the amount and its currency, in the lead's words. Empty for a signature. */
  amount: string;
  /** Who is to be paid, or who the agreement is with. */
  party: string;
  /** Workspace files to read first: the agreement to sign, a quote, the reasoning. */
  files: string[];
  /**
   * pending: waiting for the signatory to decide. authorised: an AI signatory has agreed to it, and it waits for a
   * person to carry it out. done: carried out. rejected: turned down, by the AI signatory or by the person.
   * withdrawn: the organisation no longer wants it (its plan was cancelled).
   */
  status: 'pending' | 'authorised' | 'done' | 'rejected' | 'withdrawn';
  raisedAt: string;
  /** What an AI signatory decided, when one holds the seat. */
  ruling: { verdict: 'authorised' | 'declined'; reason: string; at: string } | null;
  /** How it ended, who ended it, and what they said. */
  outcome: { result: 'done' | 'rejected' | 'withdrawn'; by: 'person' | 'ai' | 'organisation'; note: string; at: string; cycle: number } | null;
}

/** One line of the conversation between the organisation and whoever signs and pays for it. */
export interface SignatoryMessage {
  id: string;
  at: string;
  cycle: number;
  /** An executive id (the lead who asked, or the signatory's seat when an AI speaks for it), "person" for the human, or "system". */
  fromId: string;
  kind: 'request' | 'authorised' | 'declined' | 'done' | 'rejected' | 'withdrawn' | 'reopened' | 'note';
  text: string;
  requestId?: string;
}

/** What has been put to the signatory and what has been said about it. */
export interface SignatoryDesk {
  requests: SignatoryRequest[];
  messages: SignatoryMessage[];
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
  /** How big the lead rated the task, 1 to 10 on the effort scale; null when it was not rated. */
  effort: number | null;
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
  /** What the system itself must find before this phase can pass, if anything. */
  gate: PhaseGate | null;
  evidence: GateEvidence | null;
  /** Work in other leads' plans this phase must not start before. */
  waitsFor: PhaseWait[];
  /** How big the lead rated the phase, 1 to 10 on the effort scale; null when it was not rated. */
  effort: number | null;
}

/**
 * A phase of another lead's plan that must be finished before a phase can start. The lead names the
 * other lead and the phase; when the plan starts, the wait is pinned to that lead's plan, so a plan
 * the other lead takes on later cannot hold it up.
 */
export interface PhaseWait {
  leadId: string;
  /** The phase as the lead named it. */
  phase: string;
  /** The plan waited on, once pinned. Null before the plan starts, or when the lead had no plan to wait on. */
  planId: string | null;
  /** The phase of that plan waited on, by where it stood among the plan's phases when the wait was pinned; null to wait for the whole plan. */
  phaseIndex: number | null;
  /**
   * The same phase by its id in that plan's way of working, which is what the wait follows: a plan that is revised
   * after this can drop a phase or bring one back, and the places shift. Absent on a wait pinned before this was kept.
   */
  phaseId?: string | null;
  /** Why the wait was let go before it was met, if it was. */
  released: string | null;
}

export interface SkippedPhase {
  phase: string;
  reason: string;
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
  /** When the current session was archived, if it has been. */
  archivedAt?: string | null;
  /** Sessions this plan used before the current one: ones that were lost and replaced. */
  past?: Array<{ sessionId: string; archivedAt: string | null }>;
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
  /** The way of working the lead chose for this plan, and why. */
  workApproachId: string;
  workApproachReason: string | null;
  phases: PlanPhase[];
  /** Phases of the work approach the lead left out because the objective does not need them, with why. */
  skipped: SkippedPhase[];
  /** How big the lead rated the whole plan, 1 to 10 on the effort scale; null when it was not rated. */
  effort: number | null;
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
  code: PlanCode | null;
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
  method: 'lead' | 'owner' | 'consensus' | 'ceo' | 'judge';
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
  /** answering: only the plan's owner is asked first, and if it accepts the objections the board need not sit. */
  status: 'answering' | 'open' | 'deliberated' | 'resolved';
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
  | 'signatory'
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
  requestId?: string;
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
  /** Which version of the saved format this is. Absent on an organisation saved before formats were numbered. */
  schemaVersion?: number;
  business: BusinessState;
  /** What each role and its agents may do, as far as the shareholders have said. */
  privileges: OrgPrivileges;
  /** Which work approaches the shareholders have closed to a role. */
  workApproaches: OrgApproaches;
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
  /** Payments and signatures asked of the signatory, and the conversation about them. */
  signatory: SignatoryDesk;
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
  | 'answer'
  | 'position'
  | 'signoff'
  | 'revise'
  | 'kickoff'
  | 'task'
  | 'phase_review'
  | 'report'
  | 'react'
  | 'steer_review'
  | 'authorise'
  | 'execute';

/** The error an activity entry carries when the call was cut off by a pause or stop, not by a fault. It is started again. */
export const INTERRUPTED = 'Interrupted';

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
  /** What the call was part of, for placing it on a timeline. Absent on entries from before this was recorded. */
  planId?: string | null;
  phaseIndex?: number | null;
  taskId?: string | null;
  /** The agent slot (1-based) that did a task. */
  agent?: number | null;
  /** The effort the task was rated at, for learning what each level takes. */
  effort?: number | null;
}

export interface OrgSummary {
  waitingForSchedule: boolean;
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
  /** Requests to the signatory that are waiting for a person to act. */
  waiting: number;
  createdAt: string;
  updatedAt: string;
}

export interface PaceView {
  /** What is ready to start, in the order it would start. */
  next: Array<{ kind: WorkKind; execId: string; label: string }>;
  /** When the next piece of work may start under the slow pace; null when it is not waiting on the clock. */
  nextAt: string | null;
}

/** What the server pushes to an open dashboard. */
export interface OrgView {
  org: Organisation;
  active: ActiveWork[];
  /** True while a pause is draining calls that were already in flight. */
  draining: boolean;
  /** What would start next, for the pace control: what a step would do, and when a paced step is due. */
  pace: PaceView;
}

/** A model an organisation can be set to run on. */
export interface ModelOption {
  /**
   * What an organisation's settings hold: "<connection>:<model id>" (e.g. "openai:gpt-5"), or a bare Claude
   * model id for the first Anthropic connection.
   */
  id: string;
  label: string;
  /** List price in US dollars per million tokens. A stand-in rate when `priced` is false. */
  inputPerMTok: number;
  outputPerMTok: number;
  /** The connection (API key) the model is reached through. */
  connectionId?: string;
  /** The provider's name, for grouping models in a list. */
  provider?: string;
  /** False when the model's price is not known, so its spend is counted at a stand-in rate until one is set. */
  priced?: boolean;
  /** One of the models picked out for this provider: its strongest, its best-value, its quickest. */
  recommended?: boolean;
  tier?: 'flagship' | 'balanced' | 'fast';
  /** Whether plans can be carried out in hosted sessions on it. */
  hosted?: boolean;
  /** Whether agents on it can search the web. */
  web?: boolean;
  note?: string;
}

/** An API key the server holds, as the browser is told about it. The key itself never leaves the server. */
export interface ConnectionInfo {
  id: string;
  presetId: string;
  label: string;
  baseURL: string;
  /** The last characters of the key. */
  keyHint: string;
  /** stored: added here and kept on disk. env: read from the environment when the server started. */
  source: 'stored' | 'env';
  modelCount: number;
  checkedAt: string | null;
  /** Why the provider's list of models could not be read, if it could not. */
  listingError: string | null;
  /** For a connection that is not a key: what it is, such as which Claude Code and how it is signed in. */
  detail?: string;
  /** What is known of the login's usage limits, where the connection has such a thing. */
  usage?: string;
}

/** A provider the server knows how to reach, for the form that adds a key. */
export interface PresetInfo {
  id: string;
  label: string;
  family?: string;
  /**
   * anthropic: Claude's own API. responses: OpenAI's Responses API. openai: an endpoint that speaks OpenAI's Chat
   * Completions. claude-code: the Claude Code program on the server's machine, which needs no key.
   */
  kind: 'anthropic' | 'responses' | 'openai' | 'claude-code';
  regions: Array<{ id: string; label: string; baseURL: string }>;
  keysUrl: string;
  note?: string;
  /** Environment variables a key can be given in instead. */
  env: string[];
  /** The models picked out for this provider, with list prices in US dollars per million tokens as they stand today. */
  models: Array<{
    id: string;
    label: string;
    tier: 'flagship' | 'balanced' | 'fast';
    inputPerMTok: number;
    outputPerMTok: number;
    /** The regions (by id) whose platform has the model, where the provider's platforms differ. */
    only?: string[];
    note?: string;
  }>;
  /** The pages the prices were read from. */
  sources: string[];
}

export interface ProviderInfo {
  id: 'claude' | 'mock' | 'router';
  label: string;
  /** True when no real model is being called and spend figures are simulated. */
  simulated: boolean;
  defaultModel: string;
  models: ModelOption[];
  /** True when plans can be run as hosted sessions (Claude Managed Agents). */
  managed: boolean;
  /** The API keys the server holds. Absent for a provider that is not a set of connections. */
  connections?: ConnectionInfo[];
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
