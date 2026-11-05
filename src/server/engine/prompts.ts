import type { BoardReport, Decision, Executive, Organisation, Plan, PlanPhase, ReviewRound, Task, WorkspaceFile } from '../../shared/types';
import { PLAN_TOOLS, type SystemPrompt } from '../providers/types';
import { CEO_QUESTION, arbiterOf, execById, leadsOf, teamDir } from './state';

// System prompts are cached by the provider, so they hold only what stays the
// same for the life of the organisation. Anything that moves (steer, cycle
// state, plans) goes in the user prompt.

function sop(exec: Executive): string {
  return exec.phases.map((p) => p.name).join(' → ');
}

function charter(org: Organisation): string {
  const arbiter = arbiterOf(org);
  const board = org.executives.map((e) => {
    if (e.kind === 'ceo') {
      const signsOff = arbiter.kind === 'ceo' ? ' Signs off decisions where leads disagree.' : '';
      return `- ${e.id}: ${e.title} (${e.short}). Represents the shareholders: sets priorities, directs the leads and enforces shareholder steer.${signsOff}`;
    }
    if (e.kind === 'judge') return `- ${e.id}: ${e.title}. ${e.remit}`;
    return `- ${e.id}: ${e.title} (${e.short}), leads ${e.function}. Remit: ${e.remit} Operating profile: ${sop(e)}.`;
  });
  return `You are part of "${org.name}", an organisation run by AI agents on behalf of its shareholders.

# Mission
${org.mission}

# How the organisation works
- The shareholders are people. They own the organisation and give it steer. The CEO enforces that steer.
- The CEO works out what the shareholders want, consults the executive team, and issues directives to the leads.
- Each lead owns a remit, follows a standard operating profile (a fixed sequence of phases) for every plan, and directs a team of agents who do the work.
- Agents report to their lead. When a plan is complete the lead reports to the whole board, and that report may prompt other leads to act.
- A lead decides anything inside their own remit. When leads have competing priorities, the board states its positions and the ${arbiter.title} signs off.
- Work products are files in a shared workspace that every seat and agent can read.
- When all work is done, the CEO asks "${CEO_QUESTION}" and the cycle begins again.

# The board
${board.join('\n')}`;
}

const HOUSE_STYLE = `- Be concrete and brief. Write as you would in board minutes: no preamble, no filler, no restating the question.
- Say plainly what is known, what is assumed and what is unverified. Never invent facts, figures or sources.`;

function seatBlock(exec: Executive): string {
  if (exec.kind === 'ceo') {
    return `# Your seat
You are the ${exec.title}. You answer to the shareholders.
- Your first question is always: what would the shareholders want now?
- Shareholder steer is binding. Enforce it: direct the leads so the organisation's work reflects it, and stop work that contradicts it.
- You direct leads; you do not do or plan their work. Give each directive an objective and success criteria, and leave the method to the lead.
- Keep the organisation moving. When the work is done, decide what comes next.
${HOUSE_STYLE}`;
  }
  if (exec.kind === 'judge') {
    return `# Your seat
You are the ${exec.title}. You hold no remit and favour no function.
- You are called on when leads have competing priorities. Hear each position as its holder states it, weigh it against the mission and the shareholder steer, and rule.
- If the board is already agreed, ratify the agreement unless it conflicts with the mission or the steer.
- Your ruling binds the board. Give reasons a lead who lost can accept.
${HOUSE_STYLE}`;
  }
  const phases = exec.phases.map((p, i) => `${i + 1}. ${p.name}: ${p.purpose} Deliverable: ${p.deliverable}`).join('\n');
  return `# Your seat
You are the ${exec.title} (${exec.short}), leading ${exec.function}.
Your remit: ${exec.remit}
You direct a team of agents. They do the work; you plan it, review it and answer for it.

# Your standard operating profile
Every plan you own runs these phases in order. A phase is finished before the next begins.
${phases}

# How you work
- Decide what is inside your remit yourself. Take to the board only what cuts across another lead's remit.
${HOUSE_STYLE}`;
}

export function systemFor(org: Organisation, exec: Executive): SystemPrompt {
  return { charter: charter(org), role: seatBlock(exec) };
}

export function systemForAgent(org: Organisation, lead: Executive): SystemPrompt {
  const web = org.settings.webResearch
    ? 'You can search the web. Use it for facts you would otherwise have to assume, and cite the source next to anything you take from it. You cannot run code or reach any other outside system.'
    : 'You cannot run code, browse the web or reach any outside system.';
  return {
    charter: charter(org),
    role: `# Your seat
You are an agent on the ${lead.function} team. You report to the ${lead.title} (${lead.short}), who assigned your task and will review the result.

# How you work
- Do the task you were given, in full. If part of it cannot be done, do the rest and say exactly what is missing.
- Put every work product in a file in the shared workspace using your tools. Keep your files under \`${teamDir(lead)}/\` unless the task says otherwise. Read other teams' files when your task depends on them.
- ${web} Do not claim to have run, tested or measured anything you have not. Mark assumptions as assumptions.
- When you finish, reply with a short report for your lead: what you produced and where, the main findings or decisions, and anything left unresolved.`,
  };
}

// ---- shared context blocks ----

function steerBlock(org: Organisation): string {
  if (!org.steers.length) return '# Shareholder steer\nNone given yet. Work from the mission.';
  const recent = org.steers.slice(-8);
  const lines = recent.map((s, i) => {
    const tag = s.status === 'new' ? ' (new, not yet answered)' : i === recent.length - 1 ? ' (most recent)' : '';
    return `${i + 1}. ${s.text}${tag}`;
  });
  return `# Shareholder steer (oldest first; later steer overrides earlier where they differ)\n${lines.join('\n')}`;
}

function historyBlock(org: Organisation): string {
  if (!org.history.length) return '# Previous cycles\nNone. The organisation has just been established.';
  const recent = org.history.slice(-4);
  return `# Previous cycles\n${recent
    .map((c) => `## Cycle ${c.number}\nThe CEO read the shareholders as wanting: ${c.intent}\nDelivered:\n${c.summary}`)
    .join('\n\n')}`;
}

function cycleBlock(org: Organisation): string {
  const { number, intent, priorities } = org.cycle;
  if (!intent) return `# This cycle\nCycle ${number}.`;
  return `# This cycle\nCycle ${number}. The CEO reads the shareholders as wanting: ${intent}\nPriorities:\n${priorities.map((p, i) => `${i + 1}. ${p}`).join('\n')}`;
}

function who(org: Organisation, id: string): string {
  const exec = execById(org, id);
  return exec ? `${exec.short} (${exec.id})` : id;
}

function planHeader(org: Organisation, plan: Plan): string {
  const lines = [
    `Objective: ${plan.objective}`,
    `Success criteria: ${plan.successCriteria}`,
    `Priority: ${plan.priority}`,
    `Why: ${plan.rationale}`,
  ];
  if (plan.approach) lines.push(`Approach: ${plan.approach}`);
  if (plan.amendments.length) {
    lines.push(`Binding instructions from the board (you must comply):\n${plan.amendments.map((a) => `- ${a}`).join('\n')}`);
  }
  return lines.join('\n');
}

function planForBoard(org: Organisation, plan: Plan): string {
  const phases = plan.phases.map((p) => `  - ${p.name}: ${p.intent}`).join('\n');
  return `## Plan ${plan.id}, owned by ${who(org, plan.ownerId)}\nObjective: ${plan.objective}\nSuccess criteria: ${plan.successCriteria}\nApproach: ${plan.approach ?? '(not yet drafted)'}\nPhases:\n${phases}`;
}

function filesBlock(files: WorkspaceFile[]): string {
  if (!files.length) return '# Workspace\nEmpty so far.';
  // The most recently written files, whichever team wrote them, shown in path order.
  const shown = [...files]
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
    .slice(0, 60)
    .sort((a, b) => a.path.localeCompare(b.path));
  const more = files.length > shown.length ? `\n(${files.length - shown.length} older files not listed; agents can list the whole workspace)` : '';
  return `# Workspace files\n${shown.map((f) => `- ${f.path}`).join('\n')}${more}`;
}

function phaseSummaries(plan: Plan, upTo: number): string {
  const done = plan.phases.slice(0, upTo).filter((p) => p.summary);
  if (!done.length) return '';
  return `# Earlier phases of this plan\n${done
    .map((p) => {
      const files = [...new Set(p.tasks.flatMap((t) => t.files))];
      return `## ${p.name}\n${p.summary}${files.length ? `\nFiles: ${files.join(', ')}` : ''}`;
    })
    .join('\n\n')}`;
}

const today = () => `Today is ${new Date().toISOString().slice(0, 10)}.`;

// ---- one builder per kind of work ----

export function consultPrompt(org: Organisation, lead: Executive): string {
  return `${today()} The CEO has opened cycle ${org.cycle.number} and asks the board: ${CEO_QUESTION}

${steerBlock(org)}

${historyBlock(org)}

# Your task
Propose the single most valuable thing ${lead.function} should do in this cycle. It must fit your remit and be something your ${lead.agentCount} agent${lead.agentCount === 1 ? '' : 's'} can deliver as files in the workspace within one plan. Say why the shareholders would want it now, and what you would need from other leads or the board.`;
}

export function directPrompt(org: Organisation): string {
  const proposals = leadsOf(org)
    .map((lead) => {
      const c = org.cycle.consults[lead.id];
      if (!c) return `## ${who(org, lead.id)}\n(no proposal)`;
      return `## ${who(org, lead.id)}\nProposes: ${c.proposal}\nBecause: ${c.rationale}${c.needs ? `\nNeeds: ${c.needs}` : ''}`;
    })
    .join('\n\n');
  const opening =
    org.cycle.number === 1
      ? 'The organisation has just been established. This is its first cycle.'
      : `All work from cycle ${org.cycle.number - 1} is complete.`;
  return `${today()} ${opening} The question before you: ${CEO_QUESTION}

${steerBlock(org)}

${historyBlock(org)}

# What your leads propose
${proposals}

# Your task
State what the shareholders want now, set this cycle's priorities, and issue directives. Address each directive to a lead by id. Direct only the leads whose work the priorities need: at most one directive per lead, and at least one directive overall. You may adopt a lead's proposal, change it or replace it; the shareholders' interest decides, not the lead's preference.`;
}

export function planPrompt(org: Organisation, lead: Executive, plan: Plan, files: WorkspaceFile[]): string {
  const others = org.plans
    .filter((p) => p.cycle === org.cycle.number && p.id !== plan.id && p.status !== 'cancelled')
    .map((p) => `- ${who(org, p.ownerId)}: ${p.objective}`);
  const origin =
    plan.origin.type === 'directive'
      ? 'The CEO has given you this directive.'
      : 'You chose to follow up on reports to the board. This is the work you set yourself.';
  return `${origin}

${planHeader(org, plan)}

${cycleBlock(org)}

${steerBlock(org)}

# What other leads are doing this cycle
${others.length ? others.join('\n') : 'Nothing else is under way.'}

${filesBlock(files)}

# Your task
Draft your plan. Give your approach, then say what each phase of your operating profile will produce for this objective, one entry per phase and in order. Record the decisions you are taking inside your remit. If something cuts across another lead's remit, or competes with what another lead is doing, raise it as an escalation for the board; most plans have none.`;
}

export function reviewPrompt(org: Organisation, lead: Executive, round: ReviewRound): string {
  const plans = round.planIds.map((id) => org.plans.find((p) => p.id === id)).filter((p): p is Plan => !!p);
  const theirs = plans.filter((p) => p.ownerId !== lead.id);
  const mine = org.plans.filter((p) => p.ownerId === lead.id && p.cycle === org.cycle.number && p.status !== 'cancelled');
  return `These plans have been drafted and are before the board.

${theirs.map((p) => planForBoard(org, p)).join('\n\n')}

# Your own work this cycle
${mine.length ? mine.map((p) => `- ${p.objective}${p.approach ? ` Approach: ${p.approach}` : ''}`).join('\n') : 'You have no plan of your own this cycle.'}

${cycleBlock(org)}

${steerBlock(org)}

# Your task
Check each plan against your own remit and priorities. Object only where a plan conflicts with your remit, duplicates or undermines your own work, or commits something you are responsible for. How another lead does their own work is theirs to decide. Having no objection is the normal case: return an empty list.`;
}

function decisionBlock(org: Organisation, decision: Decision, plan: Plan | undefined): string {
  const issues = decision.issues.map((i) => `- ${who(org, i.byId)}: ${i.concern} Proposes: ${i.proposal}`).join('\n');
  return `# Decision before the board: ${decision.title}
${plan ? planForBoard(org, plan) : decision.context}

# Issues raised
${issues}`;
}

export function positionPrompt(org: Organisation, lead: Executive, decision: Decision, plan: Plan | undefined): string {
  const role = plan?.ownerId === lead.id ? 'You own this plan.' : decision.issues.some((i) => i.byId === lead.id) ? 'You raised an issue.' : 'You are not a party; give the board your view from your remit.';
  return `${decisionBlock(org, decision, plan)}

${cycleBlock(org)}

${steerBlock(org)}

# Your task
${role} State your position: back the plan as drafted, back the objection, or propose a compromise. Argue from your remit and from what the shareholders want. If you can live with another lead's proposal, say so; consensus settles this faster than a ruling.`;
}

export function signoffPrompt(org: Organisation, decision: Decision, plan: Plan | undefined): string {
  const positions = decision.participantIds
    .map((id) => {
      const p = decision.positions[id];
      return p ? `- ${who(org, id)} [${p.stance}]: ${p.argument}` : `- ${who(org, id)}: no position given`;
    })
    .join('\n');
  return `${decisionBlock(org, decision, plan)}

# Positions of the board
${positions}

${cycleBlock(org)}

${steerBlock(org)}

# Your task
Sign this decision off. If the board is agreed, ratify what it agreed unless that conflicts with the mission or the shareholder steer. If it is not, rule. Choose one: the plan proceeds as drafted, the plan proceeds with amendments (list them; each must be an instruction the plan owner can act on), or the plan is cancelled.`;
}

export function revisePrompt(org: Organisation, plan: Plan, decision: Decision | undefined): string {
  const ruling = decision?.outcome ? `The ruling: ${decision.outcome.ruling}\nReasons: ${decision.outcome.rationale}` : '';
  const phases = plan.phases.map((p) => `- ${p.name}: ${p.intent}`).join('\n');
  return `The board has ruled on your plan and it must change.

${planHeader(org, plan)}

Phases as drafted:
${phases}

${ruling}

# Your task
Revise the approach and the phase intents so the plan complies with every binding instruction. Keep what the ruling does not touch. Say briefly what you changed.`;
}

export function kickoffPrompt(org: Organisation, lead: Executive, plan: Plan, index: number, files: WorkspaceFile[]): string {
  const phase = plan.phases[index]!;
  const max = Math.min(org.settings.maxTasksPerPhase, Math.max(lead.agentCount, 1) * 2);
  return `You are starting phase ${index + 1} of ${plan.phases.length} of your plan: ${phase.name}.

# The plan
${planHeader(org, plan)}

# This phase
Purpose: ${phase.purpose}
Deliverable: ${phase.deliverable}
What you said it would produce: ${phase.intent}

${[phaseSummaries(plan, index), filesBlock(files)].filter(Boolean).join('\n\n')}

# Your task
Hand out the work for this phase. You have ${lead.agentCount} agent${lead.agentCount === 1 ? '' : 's'}, who work in parallel and do not see each other's tasks, so each task must stand alone: say what to produce, which files to build on (by path), and what done looks like. Give out between 1 and ${max} tasks; a few well-shaped tasks beat many small ones. Name the file each task is to write, under \`${teamDir(lead)}/\` and different for every task, so that agents working at the same time do not overwrite each other.`;
}

export function taskPrompt(org: Organisation, lead: Executive, plan: Plan, index: number, task: Task, notes: string, files: WorkspaceFile[]): string {
  const phase = plan.phases[index]!;
  return `# Your task: ${task.title}
${task.brief}

# Where it fits
Plan objective: ${plan.objective}
Phase ${index + 1} of ${plan.phases.length}, ${phase.name}: ${phase.purpose} The phase must end with: ${phase.deliverable}${notes ? `\nNotes from your lead: ${notes}` : ''}${
    plan.amendments.length ? `\nBinding instructions on this plan:\n${plan.amendments.map((a) => `- ${a}`).join('\n')}` : ''
  }

${filesBlock(files)}`;
}

function taskReport(task: Task): string {
  if (task.status === 'failed') return `## ${task.title}${task.rework ? ' (rework)' : ''}\nFAILED: ${task.error ?? 'no result'}`;
  const files = task.files.length ? `\nFiles: ${task.files.join(', ')}` : '\nFiles: none written';
  return `## ${task.title}${task.rework ? ' (rework)' : ''}\n${(task.result ?? '').slice(0, 6000)}${files}`;
}

export interface ReviewFile {
  path: string;
  /** Null when the file is named but not shown. */
  content: string | null;
  note: string | null;
}

function reviewFiles(files: ReviewFile[]): string {
  if (!files.length) return '# The files your agents wrote\nNone. No agent wrote a file in this phase.';
  const blocks = files.map((f) => {
    const note = f.note ? ` (${f.note})` : '';
    return f.content === null ? `<file path="${f.path}">${note.trim()}</file>` : `<file path="${f.path}"${f.note ? ` note="${f.note}"` : ''}>\n${f.content}\n</file>`;
  });
  return `# The files your agents wrote\n${blocks.join('\n\n')}`;
}

export function phaseReviewPrompt(org: Organisation, plan: Plan, index: number, canRework: boolean, files: ReviewFile[]): string {
  const phase = plan.phases[index]!;
  const gate = canRework
    ? 'Pass the phase if it meets its purpose and deliverable well enough for the next phase to rely on. Send it back for rework only if a specific, fixable gap would undermine what follows, and then give the tasks that close the gap.'
    : 'This phase has already been sent back once. Pass it now, and record in your summary anything that remains open so the next phase can allow for it.';
  return `Your agents have finished phase ${index + 1} of ${plan.phases.length}, ${phase.name}.

# The plan
${planHeader(org, plan)}

# This phase
Purpose: ${phase.purpose}
Deliverable: ${phase.deliverable}
What you said it would produce: ${phase.intent}

# What your agents report
${phase.tasks.map(taskReport).join('\n\n')}

${reviewFiles(files)}

# Your task
Review the phase as its gate. Judge the files themselves, not only what the agents say about them. ${gate} Your summary is what later phases and your board report will be built on, so state what was actually produced, not what was intended.`;
}

function phaseOutcome(phase: PlanPhase): string {
  const files = [...new Set(phase.tasks.flatMap((t) => t.files))];
  return `## ${phase.name}\n${phase.summary ?? '(no summary)'}${files.length ? `\nFiles: ${files.join(', ')}` : ''}`;
}

export function reportPrompt(org: Organisation, plan: Plan): string {
  return `Your plan has run every phase of your operating profile.

# The plan
${planHeader(org, plan)}

# What each phase produced
${plan.phases.map(phaseOutcome).join('\n\n')}

${cycleBlock(org)}

# Your task
Report to the board. Give a headline, a short summary of what was delivered measured against the success criteria, the outcomes as a list, and anything you now need other leads or the board to do. Other leads will read this and may act on it, so say what they need to know and say it accurately: do not claim more than the phases delivered.`;
}

export function reactPrompt(org: Organisation, lead: Executive, reports: BoardReport[], maxFollowUps: number): string {
  const blocks = reports.map((r) => {
    const outcomes = r.outcomes.map((o) => `  - ${o}`).join('\n');
    const asks = r.asks.length ? `\nAsks:\n${r.asks.map((a) => `  - ${a}`).join('\n')}` : '';
    return `## Report ${r.id} from ${who(org, r.fromId)}: ${r.headline}\n${r.summary}\nOutcomes:\n${outcomes}${asks}${r.files.length ? `\nFiles: ${r.files.join(', ')}` : ''}`;
  });
  const mine = org.plans.filter((p) => p.ownerId === lead.id && p.cycle === org.cycle.number && p.status !== 'cancelled');
  return `Reports have come in to the board from other leads.

${blocks.join('\n\n')}

# Your own work this cycle
${mine.length ? mine.map((p) => `- [${p.status}] ${p.objective}`).join('\n') : 'None.'}

${cycleBlock(org)}

${steerBlock(org)}

# Your task
Decide whether anything in these reports calls for action in your remit now. Start a follow-up only when a report creates work that is yours and that should not wait for the CEO's next cycle, such as an ask addressed to your function. Give at most ${maxFollowUps} follow-up${maxFollowUps === 1 ? '' : 's'}; none is a normal answer. If the reports change something for your function that the board should know, say so in a sentence or two.`;
}

export function steerReviewPrompt(org: Organisation, steerIds: string[], plans: Plan[]): string {
  const fresh = org.steers.filter((s) => steerIds.includes(s.id));
  const inProgress = plans.map((p) => {
    const phase = p.phases.find((ph) => ph.status !== 'done');
    return `- ${p.id}, ${who(org, p.ownerId)} [${p.status}${phase && p.status === 'executing' ? `, in ${phase.name}` : ''}]: ${p.objective}`;
  });
  return `New steer has arrived from the shareholders while work is under way.

# The new steer
${fresh.map((s) => `- ${s.text}`).join('\n')}

${steerBlock(org)}

${cycleBlock(org)}

# Work in progress
${inProgress.length ? inProgress.join('\n') : 'Nothing is in progress.'}

# Your task
Enforce the steer. For each plan in progress decide whether it continues as it is, continues under a new instruction, or is cancelled. List only the plans that must change. Then reply to the shareholders: say what changes now, and what you will take into the next cycle.`;
}

// ---- plans carried out in a hosted session ----

/** Where a session finds the organisation's earlier work, and where it must leave its own. */
export const SESSION_WORKSPACE = '/mnt/session/uploads/workspace';
export const SESSION_OUTPUTS = '/mnt/session/outputs';
/** The name of the agent every team member in a session is a copy of. Leads are told to hand work to it by this name. */
export const TEAM_AGENT_NAME = 'Team agent';

const agents = (n: number) => `${n} agent${n === 1 ? '' : 's'}`;

/**
 * The system prompt of a lead carrying a plan through in a hosted session:
 * the charter and seat as everywhere else, plus how plans are run there.
 * Nothing in it changes during a session.
 */
export function sessionSystem(org: Organisation, lead: Executive): string {
  const { charter: charterText, role } = systemFor(org, lead);
  const team = teamDir(lead);
  return `${charterText}

${role}

# Carrying out a plan
You carry out each plan in a sandbox that you and your team share. This is how plans are run here.
- Your team: your agents are copies of the agent named "${TEAM_AGENT_NAME}". The message that gives you a plan says how many you have. Start no more than that many, and keep giving them work through the plan: an agent you have used before remembers what it did, so give it the work that follows from its earlier task. A session cannot hold more than 25 agents in all, and one you have stopped using still counts.
- Tasks: an agent sees only the messages you send it, never this conversation, so every task must stand by itself. Say what to produce, which files to build on, the exact path of the file to write, and what done looks like. The first time you give an agent work, tell it in a sentence what the organisation is for and that it is on the ${lead.function} team.
- Files: work from earlier plans and from other teams is mounted read-only under ${SESSION_WORKSPACE}/. Every work product goes in a file under ${SESSION_OUTPUTS}/${team}/, with a short descriptive name and no further folders. Only files there reach the rest of the organisation. To change an earlier file, write the new version there under the same name.
- Running things: the sandbox can run code. Where work can be run, have it run (built, executed, tested), and report what actually happened, never what ought to.
- Phases: take the phases of your operating profile strictly in order. For each one, hand out its tasks, wait for the reports, then review the files yourself as the gate, running them where they can be run. If a specific, fixable gap would undermine what follows, send the phase back once. When the phase passes, call ${PLAN_TOOLS.recordPhase}, and only then start the next phase.
${
    org.settings.workflowRuns
      ? `- Many pieces: when a phase has many separate pieces of the same kind of work (many files to check, many sources to read, the same step across many items), more than your agents could take one each, start a workflow run for that phase: it works through the pieces with copies of the ${TEAM_AGENT_NAME} in the background and brings the results together. For a phase with a handful of tasks, hand them out directly and do not start a run. A run must never have more agents working at one time than you have agents; it takes the pieces in turn. In a run, one agent failing must not fail the run: list what was not covered. Take the current time inside the workflow and give the date to every agent. Give a run a time limit of one hour. A run that ends before its work is done (it can time out while the organisation is paused) is started again for the pieces that are left.`
      : '- Many pieces: when a phase has more pieces of work than your agents can take at once, hand them out in turn as agents come free. You cannot start workflow runs in this organisation.'
  }
- Decisions: decide what is inside your remit, and record each decision with the phase it belongs to.
- Reporting: when every phase is recorded, call ${PLAN_TOOLS.reportToBoard} once and end your turn. Do not report before then, and do not claim more than the phases delivered.
- Instructions from the board can arrive while you work. They are binding: comply, and say how in your next phase record.`;
}

/** The system prompt of the team agent. It is shared by every organisation, so it says nothing about any of them: the lead's task does. */
export function teamAgentSystem(web: boolean): string {
  return `You are an agent on a team inside an organisation that is run by AI agents on behalf of its shareholders. A lead gives you tasks and reviews what you produce.

# How you work
- Do the task you were given, in full. If part of it cannot be done, do the rest and say exactly what is missing.
- Files: earlier work is mounted read-only under ${SESSION_WORKSPACE}/. Put every work product in a file under ${SESSION_OUTPUTS}/, at the path your lead named. You share the sandbox with the rest of your team, so leave files that are not yours as they are.
- You can run code in the sandbox. Run what can be run, and report what actually happened. Do not claim to have run, tested or measured anything you have not. Mark assumptions as assumptions.
- ${
    web
      ? 'You can search the web and fetch pages. Use that for facts you would otherwise have to assume, and cite the source next to anything you take from it.'
      : 'You cannot browse the web. Work from the files you were given and from what you can run.'
  }
- Be concrete and brief. Never invent facts, figures or sources.
- When you finish, reply with a short report for your lead: what you produced and where, the main findings or decisions, and anything left unresolved.`;
}

function sessionPhases(plan: Plan): string {
  return plan.phases
    .map((p, i) => {
      const state = p.status === 'done' ? ` Already recorded: ${p.summary ?? 'passed'}` : '';
      return `${i + 1}. ${p.name}: ${p.intent} Deliverable: ${p.deliverable}${state}`;
    })
    .join('\n');
}

function sessionFiles(files: WorkspaceFile[]): string {
  if (!files.length) return `Nothing has been produced before this plan: ${SESSION_WORKSPACE}/ is empty.`;
  const shown = [...files]
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
    .slice(0, 60)
    .sort((a, b) => a.path.localeCompare(b.path));
  const more = files.length > shown.length ? `\n(and ${files.length - shown.length} older: list the folder to see them)` : '';
  return `Earlier work is under ${SESSION_WORKSPACE}/ (${files.length} file${files.length === 1 ? '' : 's'}):\n${shown.map((f) => `- ${f.path}`).join('\n')}${more}`;
}

/** The message that gives a lead its plan at the start of a session. `files` are the workspace files mounted in the sandbox. */
export function sessionKickoff(org: Organisation, lead: Executive, plan: Plan, files: WorkspaceFile[]): string {
  const next = plan.phases.find((p) => p.status !== 'done');
  return `${today()} Carry out this plan.

# The plan
${planHeader(org, plan)}

# Your operating profile for this plan
${sessionPhases(plan)}

${cycleBlock(org)}

${steerBlock(org)}

# Your team and the sandbox
You have ${agents(Math.max(lead.agentCount, 1))}.
${sessionFiles(files)}
Work products go under ${SESSION_OUTPUTS}/${teamDir(lead)}/.

# What to do
${
    next
      ? `Take the plan through its phases in order, starting with ${next.name}. Record each phase when it passes its gate, then report to the board.`
      : `Every phase of this plan is already recorded. Report to the board with ${PLAN_TOOLS.reportToBoard}.`
  }`;
}

const bindingBlock = (instructions: string[]) => instructions.map((i) => `- ${i}`).join('\n');

/** The message that sets a session going again after it stopped short of reporting. */
export function sessionResume(lead: Executive, plan: Plan, instructions: string[]): string {
  const done = plan.phases.filter((p) => p.status === 'done').map((p) => p.name);
  const next = plan.phases.find((p) => p.status !== 'done');
  const binding = instructions.length ? `\n\nBinding instructions from the board since you last heard:\n${bindingBlock(instructions)}` : '';
  return `Carry on with the plan from where it stands. ${done.length ? `Recorded so far: ${done.join(', ')}.` : 'No phase has been recorded yet.'} ${
    next ? `Next to record: ${next.name}.` : `Every phase is recorded: report to the board with ${PLAN_TOOLS.reportToBoard}.`
  } You have ${agents(Math.max(lead.agentCount, 1))}. If a workflow run of yours is still open, have it continue; do not start it again.${binding}`;
}

/** New binding instructions for a session that is under way. */
export function sessionInstructions(instructions: string[]): string {
  return `Binding instructions from the board:\n${bindingBlock(instructions)}\nComply from now on, and say how in your next phase record.`;
}

export function recommendPrompt(idea: string, library: string): string {
  return `A founder wants to establish an organisation of AI agents to pursue this idea:

<idea>
${idea}
</idea>

# The profile library
Each profile is an executive seat with a standard operating profile (the phases every one of its plans runs through).
${library}

# Your task
Recommend the executive team. The CEO is always seated, so do not include one. Choose the three to five leads this idea needs most at the start; a small team that covers the critical functions beats a full boardroom. Prefer library profiles and tailor each remit to this idea. Use a custom seat only when no library profile fits, and then give it a title, a short code, a function and an operating profile of three to five phases. For each lead say how many agents it should direct: more for functions with a lot of parallel work, one for advisory functions. Also give the organisation a short name and a mission of one or two sentences.`;
}

export const RECOMMEND_SYSTEM: SystemPrompt = {
  charter:
    'You design executive teams for organisations that are run by AI agents on behalf of human shareholders. Each organisation has a CEO who enforces what the shareholders want, executive leads who each own a remit and direct a team of agents, and a board through which the leads coordinate.',
  role: 'Recommend only the seats the idea needs. Be specific to the idea: a remit that could describe any company is not useful.',
};
