import type { Executive, ExecutiveDraft, OperatingProfile, SopPhase } from './types';

function phase(name: string, purpose: string, deliverable: string): SopPhase {
  return { id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name, purpose, deliverable };
}

/**
 * The library of executive profile types. Each one carries a standard operating
 * profile: the phases every plan owned by that role runs through, in order.
 */
export const PROFILES: OperatingProfile[] = [
  {
    id: 'ceo',
    kind: 'ceo',
    short: 'CEO',
    title: 'Chief Executive Officer',
    function: 'Leadership',
    remit:
      'Represents the shareholders. Sets priorities, directs the executive team, enforces shareholder steer, and signs off decisions where leads disagree.',
    phases: [
      phase('Sense', 'Read what the shareholders want now.', 'A statement of shareholder intent.'),
      phase('Consult', 'Hear what each lead proposes for their remit.', 'Proposals from the executive team.'),
      phase('Direct', 'Set priorities and issue directives.', 'Directives with success criteria.'),
      phase('Review', 'Hold the board to the outcome.', 'A cycle review for the shareholders.'),
    ],
    defaultAgents: 0,
    hue: 232,
  },
  {
    id: 'engineering',
    kind: 'lead',
    short: 'CTO',
    title: 'Chief Technology Officer',
    function: 'Engineering',
    remit: 'Technical architecture, building and shipping the product, engineering quality and technical risk.',
    phases: [
      phase('Spec', 'Pin down what will be built and how it will be judged.', 'A technical specification with acceptance criteria.'),
      phase('Build', 'Produce the implementation against the spec.', 'Working source files and the notes needed to run them.'),
      phase('Test', 'Check the build against the acceptance criteria.', 'A test report listing what passed, what failed and what was fixed.'),
      phase('Release', 'Package the result so others can use it.', 'Release notes and handover instructions.'),
    ],
    defaultAgents: 3,
    hue: 205,
  },
  {
    id: 'product',
    kind: 'lead',
    short: 'CPO',
    title: 'Chief Product Officer',
    function: 'Product',
    remit: 'What gets built and why: user needs, product strategy, roadmap, requirements and acceptance.',
    phases: [
      phase('Discover', 'Understand the users and the problem.', 'User and problem findings.'),
      phase('Define', 'Turn findings into a product definition.', 'A requirements document with scope and non-goals.'),
      phase('Prioritise', 'Order the work by value against cost.', 'A ranked roadmap with the reasoning for the order.'),
      phase('Validate', 'Test the definition against the evidence.', 'A validation note: what holds, what is still assumed.'),
    ],
    defaultAgents: 2,
    hue: 268,
  },
  {
    id: 'marketing',
    kind: 'lead',
    short: 'CMO',
    title: 'Chief Marketing Officer',
    function: 'Marketing',
    remit: 'Positioning, brand, messaging, channels, campaigns and audience growth.',
    phases: [
      phase('Research', 'Learn the audience, the market and the competition.', 'A market and audience brief.'),
      phase('Position', 'Decide what the offer stands for and against whom.', 'A positioning statement and message hierarchy.'),
      phase('Create', 'Produce the campaign material.', 'Launch-ready copy and assets.'),
      phase('Launch', 'Plan how the material reaches the audience.', 'A channel plan with timing and measures of success.'),
    ],
    defaultAgents: 2,
    hue: 338,
  },
  {
    id: 'finance',
    kind: 'lead',
    short: 'CFO',
    title: 'Chief Financial Officer',
    function: 'Finance',
    remit: 'Budgets, pricing, the financial model, unit economics, spend approval and financial risk.',
    phases: [
      phase('Assess', 'Establish the financial position and the question to answer.', 'A statement of assumptions and inputs.'),
      phase('Model', 'Build the numbers.', 'A financial model with its workings shown.'),
      phase('Budget', 'Allocate money against priorities.', 'A budget with limits per function.'),
      phase('Report', 'Tell the board what the numbers mean.', 'A finance report with risks and recommendations.'),
    ],
    defaultAgents: 1,
    hue: 152,
  },
  {
    id: 'operations',
    kind: 'lead',
    short: 'COO',
    title: 'Chief Operating Officer',
    function: 'Operations',
    remit: 'Operational continuity: delivery, suppliers, service levels, overdue commitments, cross-team handovers, recurring obligations and unresolved incidents. Maintain the shared jobs and calendar and bring blockers to the CEO.',
    phases: [
      phase('Map', 'Lay out how the work flows today or must flow.', 'A process map with owners and hand-offs.'),
      phase('Design', 'Design the operating process.', 'An operating procedure with service levels.'),
      phase('Implement', 'Put the process in place.', 'Runbooks, checklists and templates.'),
      phase('Monitor', 'Review live commitments and evidence, resolve blockers and arrange the next check.', 'An updated operating register, measured results and owned follow-up actions.'),
    ],
    defaultAgents: 2,
    hue: 28,
  },
  {
    id: 'sales',
    kind: 'lead',
    short: 'CRO',
    title: 'Chief Revenue Officer',
    function: 'Sales',
    remit: 'Revenue: target customers, pipeline, partnerships, pricing in the field and closing.',
    phases: [
      phase('Target', 'Decide who to sell to first.', 'An ideal customer profile and a target list.'),
      phase('Qualify', 'Work out which targets are worth pursuing.', 'Qualification criteria and a ranked pipeline.'),
      phase('Pitch', 'Prepare what is put in front of the customer.', 'A pitch, objection handling and a proposal template.'),
      phase('Close', 'Define how deals are agreed and handed over.', 'Closing terms and a handover checklist.'),
    ],
    defaultAgents: 2,
    hue: 12,
  },
  {
    id: 'legal',
    kind: 'lead',
    short: 'CLO',
    title: 'General Counsel',
    function: 'Legal',
    remit: 'Legal and regulatory exposure, contracts, intellectual property, privacy and compliance.',
    phases: [
      phase('Identify', 'Find the legal questions the work raises.', 'An issues list.'),
      phase('Analyse', 'Work through each issue.', 'An analysis per issue with the position taken.'),
      phase('Advise', 'Tell the board what to do about it.', 'Advice with the risk of each option.'),
      phase('Document', 'Write down what was agreed.', 'Draft terms, policies or notices.'),
    ],
    defaultAgents: 1,
    hue: 250,
  },
  {
    id: 'people',
    kind: 'lead',
    short: 'CHRO',
    title: 'Chief People Officer',
    function: 'People',
    remit: 'Organisation design, roles, hiring plans, culture and ways of working.',
    phases: [
      phase('Assess', 'Work out what capabilities the plan needs.', 'A capability gap assessment.'),
      phase('Design', 'Design the roles and structure.', 'Role definitions and an organisation chart.'),
      phase('Recruit', 'Plan how the roles are filled.', 'A hiring plan with interview criteria.'),
      phase('Develop', 'Plan how people grow in the roles.', 'An onboarding and development plan.'),
    ],
    defaultAgents: 1,
    hue: 300,
  },
  {
    id: 'data',
    kind: 'lead',
    short: 'CDO',
    title: 'Chief Data Officer',
    function: 'Data',
    remit: 'Data strategy, analytics, metrics, measurement and insight.',
    phases: [
      phase('Collect', 'Decide what data answers the question and gather it.', 'A data inventory and collection plan.'),
      phase('Analyse', 'Examine the data.', 'An analysis with method and caveats.'),
      phase('Model', 'Turn the analysis into something reusable.', 'A metric definition or model with its limits stated.'),
      phase('Report', 'Tell the board what the data shows.', 'An insight report with recommendations.'),
    ],
    defaultAgents: 2,
    hue: 185,
  },
  {
    id: 'research',
    kind: 'lead',
    short: 'R&D',
    title: 'Head of Research',
    function: 'Research',
    remit: 'Open questions the organisation needs answered: evidence, experiments, technical and market research.',
    phases: [
      phase('Question', 'State exactly what is being asked.', 'A research question with what would count as an answer.'),
      phase('Investigate', 'Gather the evidence.', 'Source notes with what each source supports.'),
      phase('Synthesise', 'Bring the evidence together.', 'A synthesis separating what is known from what is assumed.'),
      phase('Recommend', 'Say what the board should do.', 'A recommendation with confidence and open risks.'),
    ],
    defaultAgents: 3,
    hue: 170,
  },
  {
    id: 'design',
    kind: 'lead',
    short: 'CXO',
    title: 'Chief Design Officer',
    function: 'Design',
    remit: 'User experience, interface, visual identity and design quality.',
    phases: [
      phase('Research', 'Understand who is being designed for and what they do.', 'User journeys and design principles.'),
      phase('Concept', 'Explore directions.', 'Design concepts with trade-offs.'),
      phase('Design', 'Work the chosen concept through.', 'Detailed design: flows, screens, content.'),
      phase('Handoff', 'Give builders what they need.', 'A design specification ready for implementation.'),
    ],
    defaultAgents: 2,
    hue: 318,
  },
  {
    id: 'security',
    kind: 'lead',
    short: 'CISO',
    title: 'Chief Information Security Officer',
    function: 'Security',
    remit: 'Security posture, threat modelling, safeguards and incident readiness.',
    phases: [
      phase('Assess', 'Model the threats.', 'A threat model with ranked risks.'),
      phase('Harden', 'Define the safeguards.', 'Controls and the changes needed to apply them.'),
      phase('Verify', 'Check the safeguards hold.', 'A verification report.'),
      phase('Monitor', 'Plan for detection and response.', 'A monitoring and incident response plan.'),
    ],
    defaultAgents: 1,
    hue: 0,
  },
  {
    id: 'customer',
    kind: 'lead',
    short: 'CCO',
    title: 'Chief Customer Officer',
    function: 'Customer',
    remit: 'The customer after the sale: onboarding, support, retention and feedback.',
    phases: [
      phase('Listen', 'Gather what customers say and do.', 'A feedback digest.'),
      phase('Diagnose', 'Find what is behind it.', 'A diagnosis of the main causes.'),
      phase('Resolve', 'Fix what can be fixed now.', 'Responses, help content and fixes requested of other functions.'),
      phase('Improve', 'Stop it recurring.', 'An improvement plan with owners.'),
    ],
    defaultAgents: 2,
    hue: 45,
  },
  {
    id: 'strategy',
    kind: 'lead',
    short: 'CSO',
    title: 'Chief Strategy Officer',
    function: 'Strategy',
    remit: 'Where the organisation competes and how it wins: market analysis, competitive position and long-range bets.',
    phases: [
      phase('Scan', 'Survey the market and the competition.', 'A landscape scan.'),
      phase('Frame', 'Lay out the real choices.', 'Strategic options with what each requires.'),
      phase('Choose', 'Pick a direction and say why.', 'A recommended strategy with the options rejected.'),
      phase('Plan', 'Turn the choice into moves.', 'A strategic plan with milestones.'),
    ],
    defaultAgents: 1,
    hue: 88,
  },
  {
    id: 'assurance', kind: 'lead', short: 'QA', title: 'Head of Assurance', function: 'Assurance',
    remit: 'Independent verification of deliveries against acceptance criteria and evidence. Review assigned business commitments, record what is verified and escalate unsupported completion claims.',
    phases: [
      phase('Scope', 'Establish what completion requires.', 'Acceptance criteria and evidence to inspect.'),
      phase('Inspect', 'Examine the delivery and supporting evidence.', 'Checks and their results, with unverified claims marked.'),
      phase('Verify', 'Accept evidence or request correction.', 'Verified commitments or specific gaps assigned to the owner.'),
      phase('Report', 'Record the outcome and recurring problems.', 'An assurance report and lessons in shared knowledge.'),
    ], defaultAgents: 1, hue: 110,
  },
  {
    id: 'judge',
    kind: 'judge',
    short: 'Judge',
    title: 'Independent Judge',
    function: 'Arbitration',
    remit:
      'Independent arbiter with no remit of their own. Hears competing positions between leads and rules on the merits, bound by the mission and the shareholder steer.',
    phases: [
      phase('Hear', 'Take each position as its holder states it.', 'The positions on record.'),
      phase('Weigh', 'Test each against the mission and the steer.', 'Findings.'),
      phase('Rule', 'Decide, and say why.', 'A ruling the board is bound by.'),
    ],
    defaultAgents: 0,
    hue: 215,
  },
];

PROFILES.push({
  id: 'signatory',
  kind: 'signatory',
  short: 'SIGN',
  title: 'Authorised Signatory',
  function: 'Signing and payments',
  remit:
    'Signs agreements and makes payments on the organisation’s behalf, which nothing else in it can do. Holds no remit of their own: acts only on requests from the leads, and may refuse them.',
  phases: [
    phase('Check', 'Read what is to be paid or signed, for whom and why.', 'A request understood well enough to decide on.'),
    phase('Authorise', 'Decide whether the organisation should commit to it.', 'An authorisation, or a refusal with its reason.'),
    phase('Carry out', 'Make the payment or sign the document.', 'The payment made or the document signed.'),
    phase('Confirm', 'Tell the organisation what was done.', 'A confirmation on the record.'),
  ],
  defaultAgents: 0,
  hue: 158,
});

export const PROFILE_BY_ID: Record<string, OperatingProfile> = Object.fromEntries(PROFILES.map((p) => [p.id, p]));

/** Profiles a founder can seat on the executive team (the CEO and the signatory are always seated; the judge follows the arbiter setting). */
export const LEAD_PROFILES = PROFILES.filter((p) => p.kind === 'lead');

export const MAX_AGENTS_PER_LEAD = 8;
export const MAX_LEADS = 8;

function clampAgents(n: number | undefined, fallback: number): number {
  const v = Number.isFinite(n) ? Math.round(n as number) : fallback;
  return Math.min(MAX_AGENTS_PER_LEAD, Math.max(1, v));
}

function cleanPhases(phases: SopPhase[] | undefined): SopPhase[] | null {
  if (!phases) return null;
  const cleaned = phases
    .filter((p) => p && typeof p.name === 'string' && p.name.trim())
    .slice(0, 6)
    .map((p) => phase(p.name.trim().slice(0, 40), (p.purpose ?? '').trim().slice(0, 300), (p.deliverable ?? '').trim().slice(0, 300)));
  return cleaned.length >= 2 ? cleaned : null;
}

/**
 * Turn a draft seat (from the wizard or a recommendation) into an executive.
 * A draft naming a library profile inherits its operating profile unless the
 * draft overrides it; "custom" drafts must supply their own.
 */
export function executiveFromDraft(draft: ExecutiveDraft, id: string): Executive | null {
  const base = PROFILE_BY_ID[draft.profileId];
  const phases = cleanPhases(draft.phases) ?? base?.phases ?? null;
  const title = (draft.title ?? base?.title ?? '').trim();
  if (!phases || !title) return null;
  const kind = base?.kind ?? 'lead';
  const short = (draft.short ?? base?.short ?? title.split(/\s+/).map((w) => w[0]).join('')).trim().slice(0, 6) || 'Lead';
  return {
    id,
    profileId: base ? base.id : 'custom',
    kind,
    short,
    title: title.slice(0, 80),
    function: (draft.function ?? base?.function ?? title).trim().slice(0, 40),
    remit: (draft.remit ?? base?.remit ?? '').trim().slice(0, 600),
    phases,
    agentCount: kind === 'lead' ? clampAgents(draft.agentCount, base?.defaultAgents ?? 2) : 0,
    hue: base?.hue ?? hueFor(title),
  };
}

/** A stable hue for roles that are not in the library. */
export function hueFor(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) % 360;
  return h;
}
