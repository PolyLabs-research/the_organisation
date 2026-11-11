import type { Executive, Organisation, PhaseGate, SopPhase } from './types';

// Standard ways of working a lead can choose between, plan by plan. A role always has its own operating profile. These
// are the alternatives for work that profile does not suit, such as a bug or an outage. The shareholders say which ones
// a role may use. An approach is only phases and gates, so the engine runs it as it runs any profile.

export const STANDARD_APPROACH = 'standard';

export interface WorkApproach {
  id: string;
  label: string;
  /** The kind of work it is for, which is what a lead chooses by. */
  when: string;
  /** The seats from the library it suits. */
  profileIds: string[];
  phases: SopPhase[];
  /** Whether it works on a connected repository. Then a role needs one assigned, and may be held to what the checks say. */
  needsCode?: boolean;
}

function phase(name: string, purpose: string, deliverable: string, gate?: PhaseGate): SopPhase {
  return { id: name.toLowerCase(), name, purpose, deliverable, ...(gate ? { gate } : {}) };
}

export const WORK_APPROACHES: readonly WorkApproach[] = [
  {
    id: 'devops',
    label: 'DevOps delivery',
    when: 'A change to software in a connected repository, where automated checks can prove it works.',
    profileIds: ['engineering'],
    needsCode: true,
    phases: [
      phase('Plan', 'Scope one small change and say how it will be proved.', 'A change plan naming the repository, the checks that must pass and how to back the change out.'),
      phase('Build', 'Make the change and push it to the plan’s branch.', 'The change committed on the plan’s branch.'),
      phase('Verify', 'Get the repository’s automated checks passing on that branch.', 'Every check green on the latest commit of the branch.', 'checks'),
      phase('Release', 'Put the change forward for a person to review and merge.', 'An open pull request with release notes and how to roll back.', 'pull_request'),
      phase('Improve', 'Say what slowed this change down and what to automate next.', 'A short note of what to keep, what to fix and what to automate.'),
    ],
  },
  {
    id: 'bug_fix',
    label: 'Bug fix',
    when: 'Something that worked has stopped working, or does the wrong thing.',
    profileIds: ['engineering'],
    phases: [
      phase('Reproduce', 'Show the fault happening, and pin down when it does and does not.', 'The steps that produce the fault, with what was expected and what happened.'),
      phase('Diagnose', 'Find the cause, not the symptom.', 'The cause, with the evidence for it.'),
      phase('Fix', 'Make the smallest change that removes the cause.', 'The fix, and what else it could affect.'),
      phase('Confirm', 'Check the fault has gone and nothing nearby has broken.', 'The reproduction steps checked again, and how to stop it coming back.'),
    ],
  },
  {
    id: 'incident',
    label: 'Incident response',
    when: 'Something live is broken or at risk now, and getting back to safety comes before anything else.',
    profileIds: ['engineering', 'operations', 'security'],
    phases: [
      phase('Contain', 'Stop the harm spreading, and say who is affected.', 'What is affected, what has been done to limit it and what is still at risk.'),
      phase('Diagnose', 'Find what went wrong, from evidence.', 'The cause and the timeline, with what is known and what is not.'),
      phase('Repair', 'Put it right properly, not only around it.', 'The repair, and how it was checked.'),
      phase('Review', 'Learn from it, without blame.', 'A short review: what happened, why it was not caught and the actions that follow.'),
    ],
  },
  {
    id: 'build_measure_learn',
    label: 'Build-Measure-Learn',
    when: 'An idea whose value is unproven, where a small test teaches more than a full build.',
    profileIds: ['product'],
    phases: [
      phase('Assume', 'State the riskiest assumption, and what result would prove it wrong.', 'The assumption, the measure and the threshold, written before the test.'),
      phase('Build', 'Make the smallest thing that can test it.', 'A test that can be put in front of real people.'),
      phase('Measure', 'Gather what the test showed, and mark what a person has confirmed.', 'The results against the threshold, with where each number came from.'),
      phase('Learn', 'Decide what the results mean.', 'A recommendation to carry on, change course or stop, with the reason.'),
    ],
  },
  {
    id: 'pdca',
    label: 'Plan-Do-Check-Act',
    when: 'Improving a process that already runs.',
    profileIds: ['operations'],
    phases: [
      phase('Plan', 'Say what to improve, by how much and how it will be measured.', 'The target, the baseline and the change to try.'),
      phase('Do', 'Try the change on a small scale.', 'The change tried, with what was done differently.'),
      phase('Check', 'Compare the result with the target.', 'The result against the baseline, with what was learned.'),
      phase('Act', 'Adopt the change, adjust it or drop it.', 'The decision, and the updated way of working.'),
    ],
  },
];

export type OrgApproaches = Record<string, Record<string, boolean>>;

/** The approaches that suit a seat, whether or not it may use them. */
export function approachesOf(seat: Pick<Executive, 'kind' | 'profileId'>): WorkApproach[] {
  return seat.kind === 'lead' ? WORK_APPROACHES.filter((a) => a.profileIds.includes(seat.profileId)) : [];
}

/** An approach stands open to a role until the shareholders close it: choosing one has no effect outside the organisation. */
export function approachAllowed(org: Pick<Organisation, 'workApproaches'>, seatId: string, approachId: string): boolean {
  return org.workApproaches[seatId]?.[approachId] ?? true;
}

/** What a lead can choose from for a plan: its own profile first, then whatever is allowed and can work today. */
export function approachChoices(org: Pick<Organisation, 'workApproaches'>, seat: Executive, canUseCode: boolean): Array<Pick<WorkApproach, 'id' | 'label' | 'when' | 'phases'>> {
  return [
    { id: STANDARD_APPROACH, label: 'Standard operating profile', when: 'Anything else. This is the default.', phases: seat.phases },
    ...approachesOf(seat).filter((a) => approachAllowed(org, seat.id, a.id) && (!a.needsCode || canUseCode)),
  ];
}

export function approachLabel(id: string): string {
  return WORK_APPROACHES.find((a) => a.id === id)?.label ?? 'Standard operating profile';
}
