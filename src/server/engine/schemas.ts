import { z } from 'zod';
import { BusinessUpdates } from '../../shared/business-schema';
import { LEAD_PROFILES } from '../../shared/profiles';

// Shapes of what each seat is asked to return. They are sent to the model as
// structured-output schemas, so they stick to what that supports: every field
// required, no numeric or length constraints (limits are applied in code).

/** An enum over ids that are only known at run time. Falls back to a plain string when there are none. */
export function idEnum(ids: string[]) {
  return ids.length ? z.enum(ids as [string, ...string[]]) : z.string();
}

const PhaseSpec = z.object({
  name: z.string(),
  purpose: z.string(),
  deliverable: z.string(),
});

export const RecommendTeam = z.object({
  name: z.string().describe('A short name for the organisation'),
  mission: z.string().describe('One or two sentences stating what the organisation exists to achieve'),
  executives: z.array(
    z.object({
      profileId: z.enum([...LEAD_PROFILES.map((p) => p.id), 'custom']).describe('The id of a profile from the library, or "custom" when no library profile fits'),
      title: z.string().describe('For a custom seat: the job title. For a library profile: leave empty'),
      short: z.string().describe('For a custom seat: a short code of up to five letters. Otherwise empty'),
      function: z.string().describe('For a custom seat: the function it leads. Otherwise empty'),
      remit: z.string().describe('What this seat is responsible for in this particular organisation'),
      phases: z.array(PhaseSpec).describe('For a custom seat: its standard operating profile, three to five phases. Otherwise empty'),
      agents: z.number().int().describe('How many agents this lead should direct, 1 to 6'),
      rationale: z.string().describe('One sentence on why this organisation needs the seat'),
    }),
  ),
});
export type RecommendTeam = z.infer<typeof RecommendTeam>;

export const Consult = z.object({
  operations: BusinessUpdates,
  proposal: z.string().describe('What your function should do next and what it would deliver'),
  rationale: z.string().describe('Why the shareholders would want that now'),
  needs: z.string().describe('What you need from other leads or the board; empty if nothing'),
});
export type Consult = z.infer<typeof Consult>;

export function directionSchema(leadIds: string[], jobIds: string[] = []) {
  return z.object({
    operations: BusinessUpdates,
    shareholderIntent: z.string().describe('Your answer to: what would the shareholders want now?'),
    priorities: z.array(z.string()).describe('The priorities for this cycle, most important first'),
    steerResponse: z
      .string()
      .describe('If there is shareholder steer you have not yet answered, your reply saying how this cycle enforces it; otherwise empty'),
    directives: z.array(
      z.object({
        to: idEnum(leadIds),
        jobId: idEnum(['', ...jobIds]).default('').describe('The ready business commitment to execute, or empty for new work.'),
        objective: z.string(),
        successCriteria: z.string(),
        priority: z.enum(['high', 'medium', 'low']),
        rationale: z.string().describe('How this serves what the shareholders want'),
      }),
    ),
  });
}
export type Direction = z.infer<ReturnType<typeof directionSchema>>;

const RemitDecision = z.object({
  title: z.string(),
  decision: z.string(),
  rationale: z.string(),
});

/** The choice of work approach, asked for only when a lead has more than one open to it. */
export function workApproachSchema(ids: string[]) {
  return z.object({
    workApproach: idEnum(ids).describe('The work approach this plan follows'),
    workApproachReason: z.string().describe('Why that one suits this objective, in a sentence'),
  });
}

/** Phases of other leads' plans that one of this plan's phases must not start before. */
function waitsFor(leadIds: string[]) {
  return z
    .array(
      z.object({
        lead: idEnum(leadIds).describe('The other lead whose plan this cycle produces what this phase needs'),
        phase: z.string().describe('The name of the phase of their plan that must be finished first, as their operating profile names it'),
      }),
    )
    .describe('Only when this phase needs something another lead is producing this cycle; usually empty. The system holds the phase until that phase is finished.');
}

export function planDraftSchema(phaseIds: string[], leadIds: string[] = []) {
  return z.object({
    operations: BusinessUpdates,
    approach: z.string().describe('How you will meet the objective, in a short paragraph'),
    phases: z.array(
      z.object({
        phase: idEnum(phaseIds),
        intent: z.string().describe('What this phase will produce for this objective; if you skip it, why the objective does not need it'),
        skip: z.boolean().describe('True to leave this phase out because the objective does not need it'),
        waitsFor: waitsFor(leadIds),
      }),
    ),
    decisions: z.array(RemitDecision).describe('Decisions you are taking inside your own remit'),
    escalations: z
      .array(z.object({ issue: z.string(), proposal: z.string() }))
      .describe('Issues that cut across another lead’s remit and need the board; usually empty'),
  });
}
export type PlanDraft = z.infer<ReturnType<typeof planDraftSchema>>;

export function planReviewSchema(planIds: string[]) {
  return z.object({
    objections: z.array(
      z.object({
        planId: idEnum(planIds),
        concern: z.string().describe('How the plan conflicts with your remit or priorities'),
        proposal: z.string().describe('What you want changed'),
      }),
    ),
  });
}
export type PlanReview = z.infer<ReturnType<typeof planReviewSchema>>;

export const PositionOut = z.object({
  stance: z.enum(['back_plan', 'back_objection', 'compromise']),
  argument: z.string().describe('Your position in a few sentences; for a compromise, say what it is'),
});
export type PositionOut = z.infer<typeof PositionOut>;

export const SignOff = z.object({
  ruling: z.string().describe('What is decided'),
  rationale: z.string().describe('Why, with reference to the mission and the shareholder steer'),
  planAction: z.enum(['proceed', 'amend', 'cancel']),
  amendments: z.array(z.string()).describe('For "amend": the binding changes the plan owner must make. Otherwise empty'),
});
export type SignOff = z.infer<typeof SignOff>;

export function planRevisionSchema(phaseIds: string[], leadIds: string[] = []) {
  return z.object({
    approach: z.string(),
    phases: z.array(z.object({ phase: idEnum(phaseIds), intent: z.string(), skip: z.boolean(), waitsFor: waitsFor(leadIds) })),
    changes: z.string().describe('What you changed to comply with the ruling'),
  });
}
export type PlanRevision = z.infer<ReturnType<typeof planRevisionSchema>>;

const TaskSpec = z.object({
  title: z.string(),
  brief: z.string().describe('What to produce, which files to build on, and what done looks like'),
});

export const Kickoff = z.object({
  tasks: z.array(TaskSpec),
  notes: z.string().describe('Anything every agent on this phase should know; may be empty'),
  decisions: z.array(RemitDecision).describe('Decisions you are taking inside your remit at this point; may be empty'),
});
export type Kickoff = z.infer<typeof Kickoff>;

/** A payment to make or a document to sign, as a lead asks for it. */
export const RequestSpec = z.object({
  kind: z.enum(['payment', 'signature']),
  title: z.string().describe('What is to be paid for or signed, in a few words'),
  detail: z.string().describe('Why the plan needs it now, and exactly what the signatory is asked to do'),
  amount: z.string().describe('For a payment: the amount with its currency and how often, e.g. "12 GBP a year"; say so if it is an estimate. For a signature: empty'),
  party: z.string().describe('Who is to be paid, or who the agreement is with'),
  files: z.array(z.string()).describe('Workspace paths the signatory should read first, such as the agreement to sign or a quote; may be empty'),
});
export type RequestSpec = z.infer<typeof RequestSpec>;

export const PhaseReview = z.object({
  operations: BusinessUpdates,
  verdict: z.enum(['pass', 'rework']),
  summary: z.string().describe('What the phase produced and what the next phase should rely on'),
  reworkTasks: z.array(TaskSpec).describe('For "rework": the tasks that close the gap. Otherwise empty'),
  decisions: z.array(RemitDecision),
  requests: z.array(RequestSpec).describe('Payments to be made or documents to be signed that the plan now needs from the signatory. Empty at most gates'),
});
export type PhaseReview = z.infer<typeof PhaseReview>;

export const Authorise = z.object({
  verdict: z.enum(['authorise', 'decline']),
  reason: z.string().describe('Why, in a sentence or two, for the lead who asked. For "decline": what would have to change for you to agree'),
});
export type Authorise = z.infer<typeof Authorise>;

export const ReportOut = z.object({
  operations: BusinessUpdates,
  headline: z.string().describe('One line the board can read at a glance'),
  summary: z.string().describe('What was delivered against the success criteria, stated honestly'),
  outcomes: z.array(z.string()),
  asks: z.array(z.string()).describe('What you need other leads or the board to do next; may be empty'),
});
export type ReportOut = z.infer<typeof ReportOut>;

export function reactionSchema(reportIds: string[]) {
  return z.object({
    operations: BusinessUpdates,
    note: z.string().describe('One or two sentences to the board if the reports change anything for your function; empty if they do not'),
    followUps: z.array(
      z.object({
        objective: z.string(),
        successCriteria: z.string(),
        rationale: z.string(),
        existing: z
          .string()
          .describe('What the workspace and the work since already provide toward this, by file path, and exactly what is still missing. If nothing is missing, do not start the follow-up'),
        reportIds: z.array(idEnum(reportIds)).describe('The reports that prompted this'),
      }),
    ),
  });
}
export type Reaction = z.infer<ReturnType<typeof reactionSchema>>;

export function steerReviewSchema(planIds: string[]) {
  return z.object({
    operations: BusinessUpdates,
    response: z.string().describe('Your reply to the shareholders: what changes as a result of their steer'),
    verdicts: z
      .array(
        z.object({
          planId: idEnum(planIds),
          action: z.enum(['amend', 'cancel']),
          note: z.string().describe('For "amend": the instruction the lead must follow. For "cancel": why'),
        }),
      )
      .describe('Only the plans that must change; plans not listed continue as they are'),
  });
}
export type SteerReview = z.infer<ReturnType<typeof steerReviewSchema>>;
