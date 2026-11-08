import type { BoardMessageType, CycleStage, DecisionOutcome, ExecutionMode, ManagedSession, PlanStatus, SignatoryRequest, Stance, WorkflowRun } from '../shared/types';

export const CEO_QUESTION_TEXT = 'What would the shareholders want now?';

export const PLAN_STATUS: Record<PlanStatus, string> = {
  planning: 'Being drafted',
  drafted: 'Awaiting the board',
  in_review: 'Before the board',
  contested: 'Contested: the board is deciding',
  revising: 'Being revised after a ruling',
  approved: 'Cleared',
  executing: 'Under way',
  reporting: 'Writing the board report',
  done: 'Reported',
  cancelled: 'Cancelled',
  failed: 'Failed',
};

export const MESSAGE_LABEL: Record<BoardMessageType, string> = {
  ceo_question: 'CEO asks',
  consult: 'Proposal',
  direction: 'Direction',
  plan: 'Plan',
  review: 'Review',
  decision: 'Decision',
  report: 'Report',
  reaction: 'Follow-up',
  steer: 'Steer',
  steer_response: 'Steer',
  signatory: 'Signing and paying',
  system: 'Notice',
};

export const STAGES: Array<{ id: CycleStage; label: string; detail: string }> = [
  { id: 'consult', label: 'Consult', detail: 'The CEO is hearing what each lead proposes.' },
  { id: 'direct', label: 'Direct', detail: 'The CEO is deciding what the shareholders want and issuing directives.' },
  { id: 'work', label: 'Work', detail: 'Leads are planning, their agents are working, and reports are going to the board.' },
];

export const STANCE: Record<Stance, string> = {
  back_plan: 'Backs the plan',
  back_objection: 'Backs the objection',
  compromise: 'Proposes a compromise',
};

export const METHOD: Record<DecisionOutcome['method'], string> = {
  lead: 'Decided in remit',
  owner: 'Accepted by the plan’s owner',
  consensus: 'Board consensus',
  ceo: 'CEO ruling',
  judge: 'Judge’s ruling',
};

export const PLAN_ACTION: Record<DecisionOutcome['planAction'], string> = {
  proceed: 'The plan proceeds as drafted',
  amend: 'The plan proceeds with changes',
  cancel: 'The plan is cancelled',
};

export const REQUEST_STATUS: Record<SignatoryRequest['status'], string> = {
  pending: 'Waiting',
  authorised: 'Authorised, not yet done',
  done: 'Done',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
};

export const EXECUTION: Record<ExecutionMode, string> = {
  local: 'On this machine',
  managed: 'In hosted sessions',
};

export const SESSION_STATE: Record<ManagedSession['state'], string> = {
  starting: 'Starting',
  running: 'Working',
  paused: 'Held',
  at_budget: 'At its spend cap',
  finished: 'Finished',
};

export const RUN_STATUS: Record<WorkflowRun['status'], string> = {
  running: 'Running',
  paused: 'Paused',
  completed: 'Completed',
  stopped: 'Stopped',
  failed: 'Failed',
};
