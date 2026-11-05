import type { ProviderInfo } from '../../shared/types';
import { DEFAULT_MODEL, MODELS, priceUsage } from './pricing';
import {
  ProviderError,
  type AgentRequest,
  type AgentResult,
  type PlanJob,
  type PlanOutcome,
  type Provider,
  type SessionSpend,
  type StructuredRequest,
  type SystemPrompt,
} from './types';

export interface MockOptions {
  /** Latency per call in ms: a fixed number or a [min, max] range. */
  delayMs?: number | [number, number];
  /** When a lead objects to another lead's plan. first_round: once, in the first review of cycle 1. */
  objections?: 'first_round' | 'never' | 'always';
  /** When a board report triggers a follow-up plan. first_report: once per cycle. */
  followUps?: 'first_report' | 'never' | 'always';
  /** Whether a lead sends a phase back for rework. once: one phase per organisation. */
  rework?: 'once' | 'never';
  /** Whether a lead in a hosted session starts a workflow run. third_phase: one run, in the third phase of each plan. */
  runs?: 'third_phase' | 'never';
  /** How many hosted sessions of each plan end early, without a report, before one is allowed to finish. */
  lostSessions?: number;
  /** Called before each call is answered; throw from it to simulate a failure. */
  onCall?: (kind: string, context: Record<string, unknown>) => void | Promise<void>;
}

/** What the simulator remembers of a hosted session between the times it is followed. */
interface SimSession {
  spend: SessionSpend;
  /** What each agent thread was asked and what it reported, for looking up afterwards. */
  threads: Map<string, { brief: string | null; report: string | null }>;
}

interface Seat {
  id: string;
  kind: string;
  short: string;
  title: string;
  function: string;
  agentCount: number;
  phases: Array<{ id: string; name: string; deliverable: string }>;
}

interface PlanRef {
  id: string;
  owner: string;
  ownerId: string;
  objective: string;
  depth: number;
}

const STOPWORDS = new Set(['the', 'and', 'for', 'that', 'with', 'this', 'from', 'into', 'your', 'their', 'our', 'are', 'who', 'which', 'where', 'when', 'what', 'want', 'build', 'make', 'create', 'will', 'can', 'using', 'based', 'about', 'each', 'every', 'sell', 'sells', 'help', 'helps', 'people', 'local', 'online', 'new', 'day', 'days']);

const TEAM_RULES: Array<{ profileId: string; pattern: RegExp; agents: number; why: string }> = [
  { profileId: 'product', pattern: /./, agents: 2, why: 'Someone has to decide what the first version is and is not.' },
  { profileId: 'engineering', pattern: /app|software|platform|saas|api|tool|code|website|web|mobile|\bai\b|agent|data|tech|game|online|digital|automat/i, agents: 3, why: 'The idea depends on a product that has to be built and shipped.' },
  { profileId: 'marketing', pattern: /brand|market|audience|consumer|launch|community|content|social|shop|store|sell|subscri|customer|grow/i, agents: 2, why: 'The idea only works if the right people hear about it.' },
  { profileId: 'operations', pattern: /logistic|deliver|supply|warehouse|service|restaurant|cafe|bakery|physical|manufactur|shop|store|local|walk|clean|repair/i, agents: 2, why: 'There is real-world delivery to run, not only a product to build.' },
  { profileId: 'sales', pattern: /b2b|enterprise|sales|client|agency|consult|wholesale|partner/i, agents: 2, why: 'Revenue here comes from deals that have to be won one at a time.' },
  { profileId: 'legal', pattern: /legal|regulat|complian|health|medical|financ|fintech|insur|privacy|children|contract/i, agents: 1, why: 'The idea sits in regulated territory, so exposure needs an owner from day one.' },
  { profileId: 'research', pattern: /research|science|study|novel|\blab\b|experiment|discover/i, agents: 3, why: 'Open questions have to be answered before the rest of the board can commit.' },
  { profileId: 'design', pattern: /design|\bux\b|experience|consumer|game|beautiful|brand/i, agents: 2, why: 'How it looks and feels is part of what is being sold.' },
  { profileId: 'finance', pattern: /./, agents: 1, why: 'The shareholders will ask whether the numbers work; someone must own the answer.' },
];

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new ProviderError('The call was interrupted.', 'aborted', false));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ProviderError('The call was interrupted.', 'aborted', false));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

const brief = (text: string, max = 110) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
};
const lowerFirst = (text: string) => (text ? text[0]!.toLowerCase() + text.slice(1) : text);
const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'file';
const noStop = (text: string) => text.replace(/[.\s]+$/, '');

/**
 * Stands in for a model so the whole organisation can run with no credentials
 * and no spend: every seat gives a plausible, deterministic answer built from
 * the same facts a real prompt carries. Used for tests and for trying the loop.
 */
export class MockProvider implements Provider {
  private readonly reworked = new Set<string>();
  private readonly followedUp = new Set<string>();
  private readonly objected = new Set<string>();
  private readonly sessions = new Map<string, SimSession>();
  private readonly sessionsStarted = new Map<string, number>();

  constructor(private readonly options: MockOptions = {}) {}

  info(): ProviderInfo {
    return {
      id: 'mock',
      label: 'Simulation',
      simulated: true,
      defaultModel: DEFAULT_MODEL,
      models: MODELS.map((m) => ({ id: m.id, label: m.label, inputPerMTok: m.input, outputPerMTok: m.output })),
      managed: true,
    };
  }

  private async wait(signal?: AbortSignal): Promise<void> {
    const d = this.options.delayMs ?? 0;
    const ms = Array.isArray(d) ? d[0] + Math.random() * (d[1] - d[0]) : d;
    if (signal?.aborted) throw new ProviderError('The call was interrupted.', 'aborted', false);
    if (ms > 0) await sleep(ms, signal);
  }

  private charge(req: { model: string; system: SystemPrompt; prompt: string; onUsage?: StructuredRequest<unknown>['onUsage'] }, output: string): void {
    req.onUsage?.(
      priceUsage({
        model: req.model,
        inputTokens: Math.ceil(req.prompt.length / 4),
        outputTokens: Math.ceil(output.length / 4) + 200,
        cacheReadTokens: Math.ceil((req.system.charter.length + req.system.role.length) / 4),
        cacheWriteTokens: 0,
        webSearches: 0,
      }),
    );
  }

  async structured<T>(req: StructuredRequest<T>): Promise<T> {
    await this.options.onCall?.(req.kind, req.context);
    await this.wait(req.signal);
    const data = this.answer(req.kind, req.context);
    this.charge(req, JSON.stringify(data));
    const parsed = req.schema.safeParse(data);
    if (!parsed.success) throw new ProviderError(`Simulated reply for ${req.kind} did not match its schema: ${parsed.error.message}`, 'invalid_output', false);
    return parsed.data;
  }

  async agent(req: AgentRequest): Promise<AgentResult> {
    // A run that would be stopped before its first turn is not started at all.
    if (req.shouldStop?.() || req.shouldWrapUp?.()) return { text: '', turns: 0, stopped: 'interrupted' };
    await this.options.onCall?.(req.kind, req.context);
    const c = req.context;
    const seat = c.seat as Seat;
    const plan = c.plan as PlanRef;
    const phase = c.phase as { name: string; deliverable: string; index: number };
    const task = c.task as { id: string; title: string; brief: string; rework: boolean };
    const tool = (name: string) => req.tools.find((t) => t.name === name)!;

    // Turn 1: look at what is already there.
    await this.wait(req.signal);
    const listing = await tool('list_files').run({ directory: '' });
    this.charge(req, listing);
    if (req.shouldStop?.()) return { text: '', turns: 1, stopped: 'interrupted' };
    if (req.shouldWrapUp?.()) {
      const text = `Stopped before writing anything for "${brief(task.title, 80)}": only the workspace listing was read.`;
      this.charge(req, text);
      return { text, turns: 2, stopped: 'cut_short' };
    }

    // Turn 2: write the work product.
    await this.wait(req.signal);
    const path = `${c.dir as string}/${plan.id}/${slug(task.title)}.md`;
    const existing = listing.startsWith('The workspace is empty') ? 0 : listing.split('\n').length;
    const content = `# ${task.title}

> Simulated work product. No model was called; this file shows where an agent's output lands.

**Team:** ${seat.function} (reporting to the ${seat.short})
**Plan:** ${plan.objective}
**Phase:** ${phase.name}, which must end with: ${lowerFirst(phase.deliverable)}

## Brief
${task.brief}

## Output
- Addresses the brief above for the ${phase.name} phase.
- Built on ${existing} file${existing === 1 ? '' : 's'} already in the workspace.
${task.rework ? '- This is rework: it closes the gap the lead found at the phase gate.\n' : ''}
## Open points
- Assumptions are untested until a real model and real data are used.
`;
    await tool('write_file').run({ path, content });
    this.charge(req, content);
    if (req.shouldStop?.()) return { text: '', turns: 2, stopped: 'interrupted' };
    const cutShort = req.shouldWrapUp?.() ?? false;

    // Turn 3: report to the lead.
    await this.wait(req.signal);
    const text = `Produced \`${path}\` for the ${phase.name} phase. It covers the brief ("${brief(task.title, 80)}") and builds on ${existing} existing workspace file${existing === 1 ? '' : 's'}. Unresolved: the content is simulated, so nothing in it has been verified.`;
    this.charge(req, text);
    return { text, turns: 3, stopped: cutShort ? 'cut_short' : 'done' };
  }

  /**
   * A hosted session, acted out: the lead hands each phase's work to its
   * agents, they leave files and report, the lead records the phase, and at
   * the end reports to the board. Everything reaches the engine through the
   * same hooks a real session uses, including the spend cap, so the engine's
   * side of the protocol can be exercised without a session existing anywhere.
   */
  async executePlan(job: PlanJob): Promise<PlanOutcome> {
    const { hooks } = job;
    const c = job.context;
    const seat = c.seat as Seat;
    const plan = c.plan as PlanRef;
    const dir = c.dir as string;
    const org = String(c.organisation ?? '');
    const phases = c.phases as Array<{ id: string; name: string; deliverable: string; done: boolean }>;
    const agentCount = Math.max(1, seat.agentCount);
    await this.options.onCall?.('execute', c);

    const planKey = `${org}:${plan.id}`;
    let id = job.session?.id ?? null;
    if (!id) {
      const n = (this.sessionsStarted.get(planKey) ?? 0) + 1;
      this.sessionsStarted.set(planKey, n);
      id = `sim_${slug(org)}_${plan.id}_${n}`;
    }
    const sessionId = id;
    const state = this.sessions.get(sessionId) ?? {
      spend: { costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, webSearches: 0 },
      threads: new Map<string, { brief: string | null; report: string | null }>(),
    };
    this.sessions.set(sessionId, state);
    const sessionNumber = this.sessionsStarted.get(planKey) ?? 1;
    let cap = job.budgetUsd;
    hooks.session({ id: sessionId, consoleUrl: null, budgetUsd: cap });
    if (!job.session) hooks.instructed(job.kickoff.instructions);

    /** Hold the session where it is: its cap comes down to what it has spent, as a real one's does. */
    const hold = (status: 'paused' | 'cancelled'): PlanOutcome => {
      hooks.session({ id: sessionId, consoleUrl: null, budgetUsd: Math.round((state.spend.costUsd + 0.02) * 100) / 100 });
      return { status };
    };
    /**
     * One model request by the lead or an agent. Returns how the session must end if it cannot go on:
     * held by the organisation, or out of money. As with a real session, the request that crosses the cap completes.
     */
    const step = async (model: string, input: number, output: number): Promise<PlanOutcome | null> => {
      const halt = hooks.halt();
      if (halt) return hold(halt === 'cancel' ? 'cancelled' : 'paused');
      while (state.spend.costUsd >= cap) {
        const more = hooks.moreBudget(state.spend.costUsd);
        if (more === null) return { status: 'at_budget' };
        cap = more;
        hooks.session({ id: sessionId, consoleUrl: null, budgetUsd: cap });
      }
      try {
        await this.wait(job.signal);
      } catch {
        return hold('paused');
      }
      const usage = priceUsage({ model, inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0, webSearches: 0 });
      state.spend.costUsd += usage.costUsd;
      state.spend.inputTokens += input;
      state.spend.outputTokens += output;
      hooks.spend({ ...state.spend });
      const told = hooks.instructions();
      if (told) hooks.instructed(told.instructions);
      return null;
    };
    const leadTurn = () => step(job.executiveModel, 2500, 500);
    const agentTurn = () => step(job.workerModel, 6000, 1500);
    const encoder = new TextEncoder();
    /** An agent leaves a file in the session's output folder, and it is brought home. */
    const produce = async (name: string, content: string): Promise<string> => {
      const bytes = encoder.encode(content);
      const file = { id: `${sessionId}:${name}`, name, bytes };
      const path = hooks.hasOutput({ id: file.id, size: bytes.length }) ? `${dir}/${name}` : await hooks.output(file);
      return path ?? `${dir}/${name}`;
    };

    for (const [index, phase] of phases.entries()) {
      if (phase.done) continue;
      await this.options.onCall?.('session_phase', { ...c, phase: { name: phase.name, index } });
      const stopped = await leadTurn();
      if (stopped) return stopped;
      hooks.note(`Handing out the ${phase.name} work to ${agentCount} agent${agentCount === 1 ? '' : 's'}.`);

      // The lead's own agents take the phase's tasks, one each, and keep their numbers from phase to phase.
      const parts = ['the core deliverable', 'the supporting analysis', 'a review against the success criteria'];
      const count = Math.max(1, Math.min(agentCount, Number(c.maxTasks ?? 3), parts.length));
      const tasks = Array.from({ length: count }, (_, i) => ({
        threadId: `${sessionId}:agent${i + 1}`,
        title: `${phase.name}: ${parts[i]}`,
        brief: `${phase.name}: ${parts[i]}\nYou are on the ${seat.function} team of ${org}. Produce ${parts[i]} for the ${phase.name} phase of the plan "${brief(plan.objective, 120)}". The phase must end with: ${lowerFirst(phase.deliverable)} Build on what is already under the workspace folder. Write ${dir}/${plan.id}-${slug(phase.name)}-${i + 1}.md in the outputs folder. Done means a file your lead can review without asking questions.`,
        file: `${plan.id}-${slug(phase.name)}-${i + 1}.md`,
      }));
      const mode = this.options.rework ?? 'once';
      if (mode === 'once' && index === 1 && !this.reworked.has(org)) {
        this.reworked.add(org);
        tasks.push({
          threadId: `${sessionId}:agent1`,
          title: `${phase.name}: reconcile with the previous phase`,
          brief: `${phase.name}: reconcile with the previous phase\nThe gate found that the ${phase.name} files do not yet line up with what the previous phase set out. Read both and write one reconciled version to ${dir}/${plan.id}-${slug(phase.name)}-reconciled.md in the outputs folder.`,
          file: `${plan.id}-${slug(phase.name)}-reconciled.md`,
        });
      }
      for (const task of tasks) {
        hooks.assigned({ threadId: task.threadId, agentName: job.worker.name, brief: task.brief, runId: null });
        const cut = await agentTurn();
        if (cut) return cut;
        const path = await produce(
          task.file,
          `# ${task.title}

> Simulated work product. No model was called and nothing was run; this file shows where an agent's output lands when a plan is carried out in a hosted session.

**Team:** ${seat.function} (reporting to the ${seat.short})
**Plan:** ${plan.objective}
**Phase:** ${phase.name}, which must end with: ${lowerFirst(phase.deliverable)}

## Output
- Addresses the task for the ${phase.name} phase.

## Open points
- Assumptions are untested until a real model and a real sandbox are used.
`,
        );
        const report = `Produced \`${path}\` for the ${phase.name} phase ("${brief(task.title, 80)}"). Unresolved: the content is simulated, so nothing in it has been run or verified.`;
        state.threads.set(task.threadId, { brief: task.brief, report });
        hooks.reported(task.threadId, report);
      }

      // One phase with many pieces: the lead starts a workflow run that works through them in the background.
      if (job.workflows && (this.options.runs ?? 'third_phase') === 'third_phase' && index === 2) {
        const runId = `${sessionId}:run${index}`;
        const pieces = Math.min(6, agentCount * 2);
        hooks.note(`Starting a workflow run to check ${pieces} pieces of the ${phase.name} work, ${agentCount} at a time.`);
        hooks.run({
          id: runId,
          event: 'created',
          name: `${phase.name} sweep`,
          description: `Check each ${phase.name} work product against the plan, ${agentCount} at a time, then bring the findings together.`,
          steps: [
            { id: `${runId}:check`, name: 'Check each piece' },
            { id: `${runId}:combine`, name: 'Bring the findings together' },
          ],
        });
        hooks.run({ id: runId, event: 'running' });
        hooks.run({ id: runId, event: 'step_started', stepId: `${runId}:check` });
        for (let piece = 1; piece <= pieces; piece++) {
          const threadId = `${runId}:piece${piece}`;
          hooks.assigned({ threadId, agentName: job.worker.name, brief: null, runId });
          const cut = await agentTurn();
          if (cut) return cut;
          state.threads.set(threadId, {
            brief: `Check piece ${piece} of ${pieces} of the ${phase.name} work against the plan "${brief(plan.objective, 120)}".`,
            report: `Piece ${piece} is consistent with the plan as far as a simulation can tell.`,
          });
          hooks.agentEnded(threadId, 'finished');
        }
        hooks.run({ id: runId, event: 'step_ended', stepId: `${runId}:check` });
        hooks.run({ id: runId, event: 'step_started', stepId: `${runId}:combine` });
        const cut = await agentTurn();
        if (cut) return cut;
        await produce(`${plan.id}-${slug(phase.name)}-sweep.md`, `# ${phase.name} sweep\n\n> Simulated. A workflow run checked ${pieces} pieces and found nothing to report.\n`);
        hooks.run({ id: runId, event: 'step_ended', stepId: `${runId}:combine` });
        hooks.run({ id: runId, event: 'ended', result: 'completed' });
      }

      if (index === 0 && sessionNumber <= (this.options.lostSessions ?? 0)) {
        return { status: 'lost', reason: 'the simulated session was told to end early.' };
      }

      // The gate: the lead reviews the files, then records the phase.
      const gate = await leadTurn();
      if (gate) return gate;
      const reply = hooks.phase({
        phase: phase.name,
        summary: `${phase.name} is complete: ${tasks.length} work product${tasks.length === 1 ? '' : 's'} under ${dir}/. The next phase can rely on them as written. Nothing was run: this session is simulated.`,
        decisions: [],
      });
      if (!reply.ok) throw new ProviderError(`The simulated lead's phase record was refused: ${reply.message}`, 'invalid_output', false);
    }

    const closing = await leadTurn();
    if (closing) return closing;
    const lastPhase = seat.phases.at(-1);
    const reply = hooks.report({
      headline: `${seat.function}: ${lowerFirst(noStop(lastPhase?.deliverable ?? 'the plan'))} delivered`,
      summary: `The plan ran ${seat.phases.map((p) => p.name).join(' → ')} in a hosted session and left its files under ${dir}/. Measured against the success criteria the deliverable exists; its content is simulated and nothing has been run or verified.`,
      outcomes: phases.map((p) => `${p.name}: completed and recorded.`),
      asks: Number(c.cycle ?? 1) === 1 ? [`Other leads to check the ${seat.function.toLowerCase()} files against their own plans before the next cycle.`] : [],
    });
    if (!reply.ok) throw new ProviderError(`The simulated lead's report was refused: ${reply.message}`, 'invalid_output', false);
    return { status: 'reported' };
  }

  async agentDetail(sessionId: string, threadId: string): Promise<{ brief: string | null; report: string | null }> {
    return this.sessions.get(sessionId)?.threads.get(threadId) ?? { brief: null, report: null };
  }

  private answer(kind: string, c: Record<string, unknown>): unknown {
    const seat = c.seat as Seat | undefined;
    const org = String(c.organisation ?? '');
    const cycle = Number(c.cycle ?? 1);
    const mission = String(c.mission ?? '');
    const plan = c.plan as PlanRef | undefined;
    const phaseList = seat?.phases ?? [];
    const firstPhase = phaseList[0];
    const lastPhase = phaseList.at(-1);
    const sopText = phaseList.map((p) => p.name).join(' → ');

    switch (kind) {
      case 'recommend_team': {
        const idea = String(c.idea ?? '');
        const rule = (id: string) => TEAM_RULES.find((r) => r.profileId === id)!;
        // Product always sits; then whatever the idea calls for; then the usual seats until there are at least three leads.
        const picked = [rule('product'), ...TEAM_RULES.filter((r) => r.pattern.source !== '.' && r.pattern.test(idea)).slice(0, 3)];
        for (const id of ['finance', 'engineering', 'marketing']) {
          if (picked.length >= (id === 'finance' ? 4 : 3)) continue;
          if (!picked.some((r) => r.profileId === id)) picked.push(rule(id));
        }
        const words = idea
          .replace(/[^a-zA-Z\s-]/g, ' ')
          .split(/\s+/)
          .filter((w) => w.length > 2 && !STOPWORDS.has(w.toLowerCase()))
          .slice(0, 2)
          .map((w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase());
        const sentence = noStop(idea.split(/(?<=[.!?])\s/)[0] ?? idea);
        return {
          name: words.length ? `${words.join(' ')} Co` : 'New Organisation',
          mission: `Turn this into a working, sustainable business: ${brief(lowerFirst(sentence), 220)}.`,
          executives: picked.map((seat) => ({
            profileId: seat.profileId,
            title: '',
            short: '',
            function: '',
            remit: '',
            phases: [],
            agents: seat.agents,
            rationale: seat.why,
          })),
        };
      }

      case 'consult':
        return {
          proposal: `Take ${seat!.function.toLowerCase()} through ${sopText} for the next step of the mission, ending with ${lowerFirst(noStop(lastPhase?.deliverable ?? 'a finished deliverable'))}.`,
          rationale:
            cycle === 1
              ? `Nothing else on the board can be judged until ${seat!.function.toLowerCase()} has a first ${firstPhase?.name.toLowerCase() ?? 'pass'} on the table.`
              : `Cycle ${cycle - 1} left ${seat!.function.toLowerCase()} questions open; closing them now is cheaper than carrying them.`,
          needs: seat!.agentCount > 2 ? '' : 'Sight of the other leads’ first deliverables as soon as they exist.',
        };

      case 'direct': {
        const leads = c.leads as Seat[];
        const consults = c.consults as Record<string, { proposal: string }>;
        const steer = (c.newSteer as string[]) ?? [];
        const latest = steer.at(-1);
        return {
          shareholderIntent: latest
            ? `What they have just said: ${brief(latest, 200)}`
            : cycle === 1
              ? `A credible first version of what the mission describes, with the riskiest assumptions tested before money is committed. (${brief(mission, 120)})`
              : `To build on what cycle ${cycle - 1} delivered and close the gaps the leads reported, without widening scope.`,
          priorities: [
            latest ? `Deliver on the shareholders’ steer: ${brief(latest, 120)}` : 'Get a first version in front of the board that can be judged.',
            'Test the assumption most likely to sink the plan.',
            'Keep every function’s work visible in the workspace.',
          ],
          steerResponse: latest ? `Understood. This cycle’s directives are set to deliver on your steer: "${brief(latest, 160)}".` : '',
          directives: leads.map((lead, i) => ({
            to: lead.id,
            objective: brief(consults[lead.id]?.proposal ?? `Run ${lead.function} through its operating profile for this cycle.`, 300),
            successCriteria: `${noStop(lead.phases.at(-1)?.deliverable ?? 'The deliverable')} is in the workspace and the board can act on it.`,
            priority: i === 0 ? 'high' : 'medium',
            rationale: latest ? 'It is the part of the steer that falls in this remit.' : 'It is the next step the mission needs from this function.',
          })),
        };
      }

      case 'plan':
        return {
          approach: `Work through ${sopText} in order with ${seat!.agentCount} agent${seat!.agentCount === 1 ? '' : 's'}. ${firstPhase?.name ?? 'The first phase'} settles scope before agent time is spent on later phases.`,
          phases: phaseList.map((p) => ({ phase: p.id, intent: `${noStop(p.deliverable)}, for: ${brief(plan!.objective, 90)}` })),
          decisions: [
            {
              title: `Scope of the ${seat!.function.toLowerCase()} work this cycle`,
              decision: `Limit the plan to what ${seat!.agentCount} agent${seat!.agentCount === 1 ? '' : 's'} can finish in one pass through the operating profile.`,
              rationale: 'A short cycle lets the CEO redirect sooner.',
            },
          ],
          escalations: [],
        };

      case 'review': {
        const plans = c.plans as PlanRef[];
        const mode = this.options.objections ?? 'first_round';
        const target = plans[0];
        let object = false;
        if (target && mode === 'always') object = true;
        else if (target && mode === 'first_round' && cycle === 1 && c.reviewerIndex === 0 && !this.objected.has(org)) {
          this.objected.add(org);
          object = true;
        }
        return {
          objections: object
            ? [
                {
                  planId: target!.id,
                  concern: `The ${target!.owner} plan assumes input from ${seat!.function.toLowerCase()} that my own plan does not produce until its ${firstPhase?.name ?? 'first'} phase is done. As drafted, the two plans collide.`,
                  proposal: `Sequence it after our ${firstPhase?.name ?? 'first'} deliverable, or cut the part that depends on us.`,
                },
              ]
            : [],
        };
      }

      case 'position':
        if (c.isOwner) return { stance: 'back_plan', argument: 'The plan is inside my remit and meets the directive as drafted. Re-sequencing would cost time the directive does not allow for.' };
        if (c.isObjector) return { stance: 'back_objection', argument: 'The dependency is real. If the plan runs as drafted, my team is pulled off its own directive to feed it.' };
        return { stance: 'compromise', argument: 'Keep the plan, but start the dependent part only once the other function’s first deliverable exists. Neither directive slips much.' };

      case 'signoff': {
        const stances = (c.stances as Array<string | undefined>).filter(Boolean);
        const agreed = stances.length > 0 && stances.every((s) => s === stances[0]);
        if (agreed && stances[0] === 'back_plan') {
          return { ruling: 'The plan proceeds as drafted.', rationale: 'The board is agreed and nothing in the plan conflicts with the mission or the steer.', planAction: 'proceed', amendments: [] };
        }
        return {
          ruling: 'The plan proceeds with one change to its sequencing.',
          rationale: 'The shareholders are better served by both functions delivering than by either winning. Sequencing costs less than the collision would.',
          planAction: 'amend',
          amendments: ['Do not start work that depends on another function until that function’s first deliverable is in the workspace.'],
        };
      }

      case 'revise':
        return {
          approach: `Work through ${sopText} in order, starting with the parts that depend on nobody else. Dependent work begins only once the other function’s first deliverable is in the workspace.`,
          phases: phaseList.map((p) => ({ phase: p.id, intent: `${noStop(p.deliverable)}, for: ${brief(plan!.objective, 90)}` })),
          changes: 'Re-sequenced the plan so nothing in it waits on another function’s unfinished work, as the ruling requires.',
        };

      case 'kickoff': {
        const phase = c.phase as { name: string; deliverable: string; index: number };
        const count = Math.max(1, Math.min(seat!.agentCount, Number(c.maxTasks ?? 3), 3));
        const parts = ['the core deliverable', 'the supporting analysis', 'a review against the success criteria'];
        return {
          tasks: Array.from({ length: count }, (_, i) => ({
            title: `${phase.name}: ${parts[i]}`,
            brief: `Produce ${parts[i]} for the ${phase.name} phase of the plan "${brief(plan!.objective, 120)}". The phase must end with: ${lowerFirst(phase.deliverable)} Read what is already in the workspace first and build on it. Done means a file under ${c.dir as string}/ that the lead can review without asking questions.`,
          })),
          notes: 'Keep each file short enough to review in one sitting.',
          decisions: [],
        };
      }

      case 'phase_review': {
        const phase = c.phase as { name: string; index: number };
        const tasks = c.tasks as Array<{ title: string; status: string; files: string[] }>;
        const done = tasks.filter((t) => t.status === 'done').length;
        const failed = tasks.length - done;
        const mode = this.options.rework ?? 'once';
        if (mode === 'once' && c.canRework && phase.index === 1 && !this.reworked.has(org)) {
          this.reworked.add(org);
          return {
            verdict: 'rework',
            summary: `${phase.name} produced ${done} of ${tasks.length} work products, but they do not yet line up with what the previous phase set out.`,
            reworkTasks: [
              {
                title: `${phase.name}: reconcile with the previous phase`,
                brief: `Read the files from the previous phase and the ${phase.name} files, and write one reconciled version that removes the contradictions between them.`,
              },
            ],
            decisions: [],
          };
        }
        return {
          verdict: 'pass',
          summary: `${phase.name} is complete: ${done} work product${done === 1 ? '' : 's'} in the workspace${failed ? `, ${failed} task${failed === 1 ? '' : 's'} failed and ${failed === 1 ? 'is' : 'are'} carried as an open point` : ''}. The next phase can rely on them as written.`,
          reworkTasks: [],
          decisions: [],
        };
      }

      case 'report': {
        const phases = c.phases as Array<{ name: string; summary: string | null }>;
        const files = c.files as string[];
        return {
          headline: `${seat!.function}: ${lowerFirst(noStop(lastPhase?.deliverable ?? 'the plan'))} delivered`,
          summary: `The plan ran ${sopText} and left ${files.length} file${files.length === 1 ? '' : 's'} in the workspace. Measured against the success criteria the deliverable exists; its content is simulated and has not been verified.`,
          outcomes: phases.map((p) => `${p.name}: ${brief(p.summary ?? 'completed', 140)}`),
          asks: cycle === 1 ? [`Other leads to check the ${seat!.function.toLowerCase()} files against their own plans before the next cycle.`] : [],
        };
      }

      case 'react': {
        const reports = c.reports as Array<{ id: string; from: string; headline: string; asks: string[] }>;
        const mode = this.options.followUps ?? 'first_report';
        const key = `${org}:${cycle}`;
        const first = reports[0]!;
        let act = mode === 'always';
        if (mode === 'first_report' && !this.followedUp.has(key)) {
          this.followedUp.add(key);
          act = true;
        }
        return {
          note: act
            ? `The ${first.from} report changes what ${seat!.function.toLowerCase()} should do next; we are acting on it now rather than waiting for the next cycle.`
            : '',
          followUps: act
            ? [
                {
                  objective: `Check the ${first.from} deliverable against ${seat!.function.toLowerCase()} and resolve what does not fit.`,
                  successCriteria: 'A short note in the workspace listing each mismatch and how it was resolved.',
                  rationale: `The ${first.from} report asks other leads to check its files against their own plans.`,
                  reportIds: [first.id],
                },
              ]
            : [],
        };
      }

      case 'steer_review': {
        const steer = (c.steer as string[]).join(' ');
        const plans = c.plans as PlanRef[];
        const target = plans[0];
        const cancel = /\b(stop|cancel|drop|halt|abandon)\b/i.test(steer);
        return {
          response: target
            ? `Understood: "${brief(steer, 160)}". I have checked the work in progress against it and ${cancel ? 'stopped' : 'redirected'} the ${target.owner} plan; the rest continues, and the next cycle will be set by this steer.`
            : `Understood: "${brief(steer, 160)}". Nothing is in progress that conflicts with it; the next cycle will be set by this steer.`,
          verdicts: target
            ? [
                {
                  planId: target.id,
                  action: cancel ? 'cancel' : 'amend',
                  note: cancel ? `The shareholders have asked for this to stop: ${brief(steer, 200)}` : `Reflect the shareholders’ new steer in the remaining phases: ${brief(steer, 200)}`,
                },
              ]
            : [],
        };
      }

      default:
        throw new ProviderError(`The simulator has no answer for "${kind}".`, 'bad_request', false);
    }
  }
}
