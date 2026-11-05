import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeProvider } from '../src/server/providers/claude';
import { MockProvider } from '../src/server/providers/mock';
import { ProviderError, type BoardReportDraft, type PlanHooks, type PlanJob, type PlanOutcome } from '../src/server/providers/types';
import { FakeManagedApi, type FakeSession } from './fake-managed-api';
import { QUIET, harness, runToRest, waitFor, type Harness } from './helpers';

// The Claude provider's hosted sessions, run against a local stand-in for the
// Managed Agents API (see fake-managed-api.ts). These check what the provider
// sends and how it handles what a session does. They cannot check that the
// real API accepts the requests or behaves as the stand-in does.

const api = new FakeManagedApi();
let dir: string;
let provider: ClaudeProvider;
let h: Harness | undefined;

const TIMINGS = { tickMs: 5, usagePollMs: 25, idleNudgeMs: 80, graceMs: 30, outputSettleMs: 5, reconnectMs: 5 };
const newProvider = () =>
  new ClaudeProvider({ apiKey: 'test-key', baseURL: api.baseURL, maxRetries: 0, managedStateFile: path.join(dir, 'managed.json'), workspace: 'wrkspc_test', sessionTimings: TIMINGS });

beforeAll(() => api.start());
afterAll(() => api.stop());
beforeEach(async () => {
  api.reset();
  dir = await mkdtemp(path.join(os.tmpdir(), 'the-organisation-managed-'));
  provider = newProvider();
});
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
  await rm(dir, { recursive: true, force: true });
});

const PHASES = ['Spec', 'Build', 'Test', 'Release'];

/** Stands in for the engine: records what a session tells it and answers as the engine would. */
function recorder(options: { haltAfter?: string; halt?: 'pause' | 'cancel' } = {}) {
  const log: string[] = [];
  const state = {
    recorded: [] as string[],
    report: null as BoardReportDraft | null,
    halt: null as 'pause' | 'cancel' | null,
    grants: [] as Array<number | null>,
    pending: [] as string[],
    files: new Map<string, string>(),
    synced: new Map<string, number>(),
    spend: 0,
    cap: 0,
    sessionId: '',
    consoleUrl: null as string | null,
    cursor: null as string | null,
    notes: [] as string[],
    declined: [] as string[],
    runs: [] as string[],
    tasks: [] as string[],
  };
  const hooks: PlanHooks = {
    session(info) {
      state.sessionId = info.id;
      state.consoleUrl = info.consoleUrl;
      state.cap = info.budgetUsd;
      log.push(`cap ${info.budgetUsd.toFixed(2)}`);
    },
    phase(record) {
      const next = PHASES[state.recorded.length];
      if (record.phase !== next) return { ok: false, message: `${next} comes first.` };
      state.recorded.push(record.phase);
      log.push(`phase ${record.phase}`);
      if (options.haltAfter === record.phase) state.halt = options.halt ?? 'pause';
      return { ok: true, message: `Recorded. ${PHASES[state.recorded.length] ?? 'The report'} is next.` };
    },
    report(draft) {
      if (state.recorded.length < PHASES.length) return { ok: false, message: 'Not yet: phases are still open.' };
      state.report = draft;
      log.push('report');
      return { ok: true, message: 'Your report is with the board.' };
    },
    assigned(work) {
      state.tasks.push(`${work.threadId}${work.runId ? ` in ${work.runId}` : ''}: ${work.brief ?? '(no brief)'}`);
    },
    reported(threadId, text) {
      log.push(`reported ${threadId}: ${text}`);
    },
    agentEnded(threadId, how) {
      log.push(`agent ${threadId} ${how}`);
    },
    run(update) {
      state.runs.push([update.event, update.stepId, update.result, update.name].filter(Boolean).join(' '));
    },
    spend(total) {
      state.spend = Math.max(state.spend, total.costUsd);
    },
    note(text) {
      state.notes.push(text);
    },
    declined(tool, detail) {
      state.declined.push(`${tool}: ${detail}`);
    },
    async output(file) {
      state.files.set(file.name, Buffer.from(file.bytes).toString());
      state.synced.set(file.id, file.bytes.length);
      return `engineering/${file.name}`;
    },
    hasOutput(file) {
      return state.synced.get(file.id) === file.size;
    },
    instructions() {
      return state.pending.length ? { message: `Binding: ${state.pending.join('; ')}`, instructions: state.pending.length } : null;
    },
    instructed(count) {
      state.pending.splice(0, count);
      if (count) log.push(`instructed ${count}`);
    },
    halt() {
      return state.halt;
    },
    moreBudget(spent) {
      const grant = state.grants.shift() ?? null;
      log.push(`asked for more at ${spent.toFixed(2)}: ${grant}`);
      return grant;
    },
    checkpoint(at) {
      state.cursor = at;
    },
  };
  return { hooks, log, state };
}

function job(hooks: PlanHooks, overrides: Partial<PlanJob> = {}): PlanJob {
  return {
    planId: 'p1',
    title: 'Fernery · CTO: Build the first version',
    system: 'You are the CTO of Fernery.',
    kickoff: { message: 'Carry out this plan.', instructions: 0 },
    resume: () => ({ message: 'Carry on with the plan.', instructions: 0 }),
    executiveModel: 'claude-opus-5-5',
    executiveEffort: 'high',
    workerModel: 'claude-sonnet-5-5',
    workerEffort: 'medium',
    worker: { name: 'Team agent', system: 'You are a team agent.' },
    web: false,
    workflows: true,
    budgetUsd: 2,
    session: null,
    files: [],
    stateDir: path.join(dir, 'state'),
    hooks,
    context: {},
    ...overrides,
  };
}

/** One phase as a lead runs it: hand the work to an agent, spend, then record the phase. */
async function phase(s: FakeSession, name: string, cents = 10): Promise<void> {
  s.says(`Starting ${name}.`);
  s.delegate('sthr_a', `${name}: write the document`, `Wrote ${name.toLowerCase()}.md.`, { name: `engineering/${name.toLowerCase()}.md`, content: `# ${name}` });
  await s.charge(cents);
  const reply = await s.call('record_phase', { phase: name, summary: `${name} passed its gate.`, decisions: [] });
  if (reply.isError) throw new Error(`record_phase was refused: ${reply.text}`);
}

async function report(s: FakeSession): Promise<void> {
  const reply = await s.call('report_to_board', { headline: 'Shipped', summary: 'All four phases are done.', outcomes: ['It runs.'], asks: [] });
  if (reply.isError) throw new Error(`report_to_board was refused: ${reply.text}`);
  s.idle({ type: 'end_turn' });
}

/** A lead that carries the whole plan through without incident. */
async function wholePlan(s: FakeSession): Promise<void> {
  s.running();
  for (const name of PHASES) await phase(s, name);
  await report(s);
}

const sent = (s: FakeSession, type: string) => s.received.filter((e) => e.type === type);
const messages = (s: FakeSession) => sent(s, 'user.message').map((e) => e.content[0].text as string);
const body = (method: string, route: string | RegExp, nth = 0) =>
  api.requests.filter((r) => r.method === method && (typeof route === 'string' ? r.path === route : route.test(r.path)))[nth]!.body;

describe('starting a session for a plan', () => {
  it('creates the session from the lead agent with the seat\'s model and instructions, a spend cap, the plan as its first message and the workspace mounted', async () => {
    const workspace = path.join(dir, 'workspace');
    await mkdir(path.join(workspace, 'product'), { recursive: true });
    await writeFile(path.join(workspace, 'product', 'brief.md'), '# Brief');
    await writeFile(path.join(workspace, 'notes.md'), 'Notes');
    const files = await Promise.all(
      ['notes.md', 'product/brief.md'].map(async (p) => {
        const s = await stat(path.join(workspace, p));
        return { path: p, absolutePath: path.join(workspace, p), size: s.size, modifiedAt: s.mtime.toISOString() };
      }),
    );
    api.script = wholePlan;
    const r = recorder();
    const outcome = await provider.executePlan(job(r.hooks, { files, kickoff: { message: 'Carry out this plan.', instructions: 2 } }));
    const session = api.session();

    expect(session.failure).toBeNull();
    expect(outcome).toEqual({ status: 'reported' });

    // The team agent, then the lead whose roster and workflow runs are limited to it.
    const worker = body('POST', '/v1/agents', 0);
    const lead = body('POST', '/v1/agents', 1);
    const [workerId, leadId] = [...api.agents.keys()];
    expect(worker).toMatchObject({ name: 'Team agent', model: { id: 'claude-sonnet-5-5', effort: 'medium' }, system: 'You are a team agent.' });
    expect(worker.multiagent).toBeUndefined();
    expect(worker.tools).toEqual([
      {
        type: 'agent_toolset_20260401',
        default_config: { enabled: true, permission_policy: { type: 'auto' } },
        configs: [
          { name: 'web_search', enabled: false },
          { name: 'web_fetch', enabled: false },
        ],
      },
    ]);
    const roster = [{ type: 'agent', id: workerId, version: 1 }];
    expect(lead.multiagent).toEqual({
      type: 'multiagent_20261001',
      subagents: { type: 'enabled', predefined_agents: roster, inline_agents: { type: 'disabled' } },
      workflows: { type: 'enabled', predefined_agents: roster, inline_agents: { type: 'disabled' } },
    });
    expect(lead.tools.map((t: { name?: string; type: string }) => t.name ?? t.type)).toEqual(['agent_toolset_20260401', 'record_phase', 'report_to_board']);
    // With workflows on, the agent's own instructions say when a run is called for and when it is not.
    expect(lead.system).toMatch(/workflow run/);
    expect(lead.system).toMatch(/without a run/);

    // A sandbox that can install packages and reach nothing else.
    expect(body('POST', '/v1/environments').config).toEqual({
      type: 'cloud',
      networking: { type: 'limited', allow_package_managers: true, allow_mcp_servers: false, allowed_hosts: [] },
    });

    const created = session.created;
    expect(created.agent).toEqual({ type: 'agent_with_overrides', id: leadId, version: 1, model: { id: 'claude-opus-5-5', effort: 'high' }, system: 'You are the CTO of Fernery.' });
    expect(created.environment_id).toBe([...api.environments.keys()][0]);
    expect(created.budget).toEqual({ type: 'limit', max_list_cost: { amount: '200', currency: 'USD' } });
    expect(created.initial_events).toEqual([{ type: 'user.message', content: [{ type: 'text', text: 'Carry out this plan.' }] }]);
    expect(created.title).toBe('Fernery · CTO: Build the first version');
    expect(created.resources.map((x: { mount_path: string }) => x.mount_path)).toEqual(['/workspace/notes.md', '/workspace/product/brief.md']);
    expect(created.resources.every((x: { type: string; file_id: string }) => x.type === 'file' && api.files.has(x.file_id))).toBe(true);
    expect([...api.files.values()].map((f) => `${f.filename}=${f.bytes}`).sort()).toEqual(['brief.md=# Brief', 'notes.md=Notes']);
    const create = api.requests.find((x) => x.method === 'POST' && x.path === '/v1/sessions')!;
    expect(String(create.headers['anthropic-beta'])).toContain('managed-agents-2026-04-01');

    // What the engine was told.
    expect(r.state.sessionId).toBe(session.id);
    expect(r.state.consoleUrl).toBe(`https://platform.claude.com/workspaces/wrkspc_test/sessions/${session.id}`);
    expect(r.state.recorded).toEqual(PHASES);
    expect(r.state.report).toEqual({ headline: 'Shipped', summary: 'All four phases are done.', outcomes: ['It runs.'], asks: [] });
    expect(r.state.spend).toBeCloseTo(0.4, 5);
    expect(r.state.tasks).toContain('sthr_a: Spec: write the document');
    expect(r.log).toContain('reported sthr_a: Wrote spec.md.');
    expect(r.log).toContain('instructed 2');
    expect(r.state.notes).toContain('Starting Spec.');
    expect(r.state.cursor).toBeTruthy();

    // The lead got its answers, and nothing else was said to the session.
    expect(sent(session, 'user.custom_tool_result').map((e) => [e.content[0].text, !!e.is_error])).toEqual([
      ['Recorded. Build is next.', false],
      ['Recorded. Test is next.', false],
      ['Recorded. Release is next.', false],
      ['Recorded. The report is next.', false],
      ['Your report is with the board.', false],
    ]);
    expect(messages(session)).toEqual(['Carry out this plan.']);
    expect(sent(session, 'user.interrupt')).toHaveLength(0);

    // What the session wrote came home; its copies of the mounted files did not.
    expect([...r.state.files.entries()].sort()).toEqual([
      ['engineering/build.md', '# Build'],
      ['engineering/release.md', '# Release'],
      ['engineering/spec.md', '# Spec'],
      ['engineering/test.md', '# Test'],
    ]);
    const listing = api.requests.find((x) => x.method === 'GET' && x.path === '/v1/files')!;
    expect(listing.query.get('scope_id')).toBe(session.id);
    expect(String(listing.headers['anthropic-beta'])).toContain('managed-agents-2026-04-01');
    // The session is left as it is: never archived or deleted from here.
    expect(api.requests.some((x) => x.method === 'DELETE' || x.path.endsWith('/archive'))).toBe(false);
  });

  it('creates the agents and the environment once and uses them again, also from a new process', async () => {
    api.script = wholePlan;
    const workspace = path.join(dir, 'workspace');
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, 'notes.md'), 'Notes');
    const s = await stat(path.join(workspace, 'notes.md'));
    const files = [{ path: 'notes.md', absolutePath: path.join(workspace, 'notes.md'), size: s.size, modifiedAt: s.mtime.toISOString() }];

    await provider.executePlan(job(recorder().hooks, { files }));
    await Promise.all([provider.executePlan(job(recorder().hooks, { files, planId: 'p2' })), provider.executePlan(job(recorder().hooks, { files, planId: 'p3' }))]);
    await newProvider().executePlan(job(recorder().hooks, { files, planId: 'p4' }));

    expect(api.sessions.size).toBe(4);
    expect(api.count('POST', '/v1/agents')).toBe(2);
    expect(api.count('POST', /^\/v1\/agents\/.+/)).toBe(0);
    expect(api.count('POST', '/v1/environments')).toBe(1);
    // An unchanged file is uploaded once and mounted in every session.
    expect(api.count('POST', '/v1/files')).toBe(1);
    const saved = JSON.parse(await readFile(path.join(dir, 'managed.json'), 'utf8'));
    expect(Object.values<any>(saved.accounts)[0].leads['claude-sonnet-5-5|medium|no-web|runs'].id).toBe([...api.agents.keys()][1]);
  });

  it('saves a changed definition as a new version of the same agents', async () => {
    api.script = wholePlan;
    await provider.executePlan(job(recorder().hooks));
    await provider.executePlan(job(recorder().hooks, { worker: { name: 'Team agent', system: 'You are a team agent. Be brief.' } }));

    expect(api.count('POST', '/v1/agents')).toBe(2);
    const updates = api.requests.filter((x) => x.method === 'POST' && /^\/v1\/agents\/.+/.test(x.path));
    expect(updates.map((u) => u.body.version)).toEqual([1, 1]);
    const [workerId, leadId] = [...api.agents.keys()];
    expect(api.agents.get(workerId!)).toMatchObject({ version: 2, system: 'You are a team agent. Be brief.' });
    // The lead's roster follows the team agent to its new version, and new sessions start from the new lead.
    expect(api.agents.get(leadId!)!.multiagent.subagents.predefined_agents).toEqual([{ type: 'agent', id: workerId, version: 2 }]);
    expect(api.session().created.agent).toMatchObject({ id: leadId, version: 2 });
  });

  it('opens the sandbox\'s network and gives agents the web only when web research is on', async () => {
    api.script = wholePlan;
    await provider.executePlan(job(recorder().hooks, { web: true }));
    expect(body('POST', '/v1/environments').config).toEqual({ type: 'cloud', networking: { type: 'unrestricted' } });
    expect(body('POST', '/v1/agents', 0).tools[0].configs).toEqual([
      { name: 'web_search', enabled: true },
      { name: 'web_fetch', enabled: true },
    ]);

    // An organisation without web research gets agents and a sandbox of its own.
    await provider.executePlan(job(recorder().hooks, { web: false }));
    expect(api.count('POST', '/v1/environments')).toBe(2);
    expect(api.count('POST', '/v1/agents')).toBe(4);
    expect(api.session().created.environment_id).toBe([...api.environments.keys()][1]);
  });

  it('starts a lead that cannot start workflow runs from an agent saved with workflows disabled', async () => {
    api.script = wholePlan;
    await provider.executePlan(job(recorder().hooks, { workflows: false }));
    const lead = body('POST', '/v1/agents', 1);
    expect(lead.multiagent.workflows).toEqual({ type: 'disabled' });
    expect(lead.multiagent.subagents.type).toBe('enabled');
    expect(lead.system).not.toMatch(/workflow run/);

    // An organisation that allows runs gets a lead of its own; the team agent is shared.
    await provider.executePlan(job(recorder().hooks, { workflows: true }));
    expect(api.count('POST', '/v1/agents')).toBe(3);
    expect(body('POST', '/v1/agents', 2).multiagent.workflows.type).toBe('enabled');
    expect(api.session().created.agent.id).toBe([...api.agents.keys()][2]);
  });

  it('makes its agents again, once, when the ones on file no longer exist', async () => {
    api.script = wholePlan;
    await provider.executePlan(job(recorder().hooks));
    api.agents.clear();
    api.environments.clear();

    const r = recorder();
    expect(await provider.executePlan(job(r.hooks, { planId: 'p2' }))).toEqual({ status: 'reported' });
    expect(api.count('POST', '/v1/sessions')).toBe(3); // one refused with "not found", then one that worked
    expect(api.agents.size).toBe(2);
    expect(api.session().created.agent.id).toBe([...api.agents.keys()][1]);
  });

  it('passes on a refusal it cannot do anything about, without trying again', async () => {
    api.failOnce((x) => x.method === 'POST' && x.path === '/v1/sessions', 400, 'budget.max_list_cost: model_not_budgetable');
    const failure = await provider.executePlan(job(recorder().hooks)).catch((err) => err);
    expect(failure).toBeInstanceOf(ProviderError);
    expect(failure).toMatchObject({ code: 'bad_request', retryable: false });
    expect(failure.message).toContain('model_not_budgetable');
    expect(api.count('POST', '/v1/sessions')).toBe(1);
  });
});

describe('what a session asks of the organisation', () => {
  it('passes a refused phase record back to the lead as an error, with the reason', async () => {
    let refused: { text: string; isError: boolean } | undefined;
    let early: { text: string; isError: boolean } | undefined;
    api.script = async (s) => {
      s.running();
      early = await s.call('report_to_board', { headline: 'Done', summary: 'Done.', outcomes: [] });
      refused = await s.call('record_phase', { phase: 'Build', summary: 'Built.' });
      for (const name of PHASES) await phase(s, name);
      await report(s);
    };
    const r = recorder();
    expect(await provider.executePlan(job(r.hooks))).toEqual({ status: 'reported' });
    expect(early).toEqual({ text: 'Not yet: phases are still open.', isError: true });
    expect(refused).toEqual({ text: 'Spec comes first.', isError: true });
    expect(r.state.recorded).toEqual(PHASES);
  });

  it('tolerates a loosely filled-in tool call', async () => {
    api.script = async (s) => {
      s.running();
      for (const name of PHASES) await s.call('record_phase', { phase: name, summary: 'Passed.', decisions: 'none' });
      await s.call('report_to_board', { headline: 'Shipped', summary: 'Done.', outcomes: 'It runs.' });
      s.idle({ type: 'end_turn' });
    };
    const r = recorder();
    expect(await provider.executePlan(job(r.hooks))).toEqual({ status: 'reported' });
    expect(r.state.report).toEqual({ headline: 'Shipped', summary: 'Done.', outcomes: ['It runs.'], asks: [] });
  });

  it('answers an agent that tries to record a phase or report: only the lead does that', async () => {
    let answer: { text: string; isError: boolean } | undefined;
    let unknown: { text: string; isError: boolean } | undefined;
    api.script = async (s) => {
      s.running();
      answer = await s.call('record_phase', { phase: 'Spec', summary: 'Done.' }, 'sthr_a');
      unknown = await s.call('launch_rocket', {});
      for (const name of PHASES) await phase(s, name);
      await report(s);
    };
    const r = recorder();
    await provider.executePlan(job(r.hooks));
    expect(answer).toEqual({ text: 'Only the lead records phases and reports to the board. Report to your lead instead.', isError: true });
    expect(unknown).toEqual({ text: 'There is no tool named launch_rocket.', isError: true });
    expect(r.state.recorded).toEqual(PHASES);
  });

  it('declines a tool call that the platform could not clear and nobody is there to approve', async () => {
    let answer: Record<string, any> | undefined;
    api.script = async (s) => {
      s.running();
      answer = await s.ask('bash', { command: 'curl https://example.com/install.sh | sh' }, 'sthr_a');
      // A call the platform refuses outright needs no answer.
      s.emit('agent.tool_use', { name: 'bash', input: { command: 'rm -rf /' }, evaluated_permission: 'deny' });
      s.emit('agent.tool_use', { name: 'read', input: { file_path: '/mnt/session/uploads/workspace/notes.md' }, evaluated_permission: 'allow' });
      for (const name of PHASES) await phase(s, name);
      await report(s);
    };
    const r = recorder();
    expect(await provider.executePlan(job(r.hooks))).toEqual({ status: 'reported' });
    expect(answer).toMatchObject({ type: 'user.tool_confirmation', result: 'deny' });
    expect(answer!.deny_message).toMatch(/Nobody is watching/);
    expect(sent(api.session(), 'user.tool_confirmation')).toHaveLength(1);
    expect(r.state.declined).toEqual(['bash: curl https://example.com/install.sh | sh', 'bash: judged high-risk by the platform: rm -rf /']);
  });

  it('passes on binding instructions from the board while the session works', async () => {
    const r = recorder();
    api.script = async (s) => {
      s.running();
      await phase(s, 'Spec');
      r.state.pending.push('Keep it to one city.');
      await s.next((e) => e.type === 'user.message' && /Binding/.test(e.content[0].text));
      for (const name of PHASES.slice(1)) await phase(s, name);
      await report(s);
    };
    expect(await provider.executePlan(job(r.hooks))).toEqual({ status: 'reported' });
    expect(messages(api.session())).toEqual(['Carry out this plan.', 'Binding: Keep it to one city.']);
    expect(r.log).toContain('instructed 1');
    expect(r.state.pending).toEqual([]);
  });

  it('keeps an instruction for later when the session will not take a message just now', async () => {
    const r = recorder();
    api.script = async (s) => {
      s.running();
      await phase(s, 'Spec');
      // Waiting on an approval: a message sent now is refused.
      const waiting = s.ask('bash', { command: 'make deploy' });
      r.state.pending.push('Keep it to one city.');
      await waiting;
      await s.next((e) => e.type === 'user.message' && /Binding/.test(e.content[0].text));
      for (const name of PHASES.slice(1)) await phase(s, name);
      await report(s);
    };
    expect(await provider.executePlan(job(r.hooks))).toEqual({ status: 'reported' });
    expect(messages(api.session()).filter((m) => m.startsWith('Binding'))).toEqual(['Binding: Keep it to one city.']);
    expect(r.log.filter((l) => l === 'instructed 1')).toHaveLength(1);
  });
});

describe('workflow runs', () => {
  it('follows a run the lead starts: its steps, its agents and how it ended', async () => {
    api.script = async (s) => {
      s.running();
      await phase(s, 'Spec');
      const run = 'wrun_1';
      s.emit('workflow_run.created', { workflow_run_id: run, name: 'Build sweep', description: 'Check every module.', phases: [{ id: 'ph_1', name: 'Check', description: null }] });
      s.emit('workflow_run.status_running', { workflow_run_id: run });
      const started = s.emit('workflow_run.phase_started', { workflow_run_id: run, workflow_run_phase_id: 'ph_1' });
      s.emit('session.thread_created', { session_thread_id: 'sthr_r1', agent_name: 'Team agent', workflow_run_id: run });
      s.emit('session.thread_status_running', { session_thread_id: 'sthr_r1', agent_name: 'Team agent' });
      // A run's agent can go idle and carry on: only the end of its thread says it is done.
      s.emit('session.thread_status_idle', { session_thread_id: 'sthr_r1', agent_name: 'Team agent', stop_reason: { type: 'end_turn' }, stop_details: null });
      s.emit('session.thread_status_terminated', { session_thread_id: 'sthr_r1', agent_name: 'Team agent' });
      s.emit('workflow_run.phase_ended', { workflow_run_id: run, workflow_run_phase_id: 'ph_1', phase_started_id: started.id });
      s.emit('workflow_run.status_ended', { workflow_run_id: run, result: { type: 'completed' } });
      for (const name of PHASES.slice(1)) await phase(s, name);
      await report(s);
    };
    const r = recorder();
    expect(await provider.executePlan(job(r.hooks))).toEqual({ status: 'reported' });
    expect(r.state.runs).toEqual(['created Build sweep', 'running', 'step_started ph_1', 'step_ended ph_1', 'ended completed']);
    expect(r.state.tasks).toContain('sthr_r1 in wrun_1: (no brief)');
    expect(r.log.filter((l) => l.startsWith('agent sthr_r1'))).toEqual(['agent sthr_r1 finished']);
  });

  it('does not take the plan as finished while a run is still open, and has the lead see to it', async () => {
    api.script = async (s) => {
      s.running();
      s.emit('workflow_run.created', { workflow_run_id: 'wrun_1', name: 'Sweep', description: null, phases: [] });
      s.emit('workflow_run.status_idle', { workflow_run_id: 'wrun_1' });
      for (const name of PHASES) await phase(s, name);
      const reply = await s.call('report_to_board', { headline: 'Shipped', summary: 'Done.', outcomes: [] });
      if (reply.isError) throw new Error(reply.text);
      // The lead ends its turn with the run still open.
      s.idle({ type: 'end_turn' });
      await s.next((e) => e.type === 'user.message' && e.content[0].text === 'Carry on with the plan.');
      s.running();
      s.emit('workflow_run.status_ended', { workflow_run_id: 'wrun_1', result: { type: 'stopped' } });
      s.idle({ type: 'end_turn' });
    };
    const r = recorder();
    expect(await provider.executePlan(job(r.hooks))).toEqual({ status: 'reported' });
    expect(r.state.runs).toEqual(['created Sweep', 'paused', 'ended stopped']);
    expect(messages(api.session())).toEqual(['Carry out this plan.', 'Carry on with the plan.']);
  });

  it('reports a run that failed, and one that could not be started', async () => {
    api.script = async (s) => {
      s.running();
      s.emit('workflow_run.error', { workflow_run_id: null, error: { type: 'max_workflow_runs_error', message: 'Too many runs are open.' } });
      s.emit('workflow_run.created', { workflow_run_id: 'wrun_1', name: 'Sweep', description: null, phases: [] });
      s.emit('workflow_run.status_ended', { workflow_run_id: 'wrun_1', result: { type: 'error', error: { type: 'timeout_error', message: 'The run reached its time limit.' } } });
      for (const name of PHASES) await phase(s, name);
      await report(s);
    };
    const r = recorder();
    const updates: unknown[] = [];
    const run = r.hooks.run;
    r.hooks.run = (update) => {
      updates.push(update);
      run(update);
    };
    expect(await provider.executePlan(job(r.hooks))).toEqual({ status: 'reported' });
    expect(r.state.notes).toContain('A workflow run could not be started: Too many runs are open.');
    expect(updates.at(-1)).toEqual({ id: 'wrun_1', event: 'ended', result: 'failed', error: 'The run reached its time limit.' });
  });
});

describe('the spend cap', () => {
  it('raises the cap when the session reaches it and the organisation has more to give', async () => {
    api.script = wholePlan;
    const r = recorder();
    r.state.grants.push(0.6);
    expect(await provider.executePlan(job(r.hooks, { budgetUsd: 0.25 }))).toEqual({ status: 'reported' });
    const session = api.session();
    expect(session.created.budget.max_list_cost.amount).toBe('25');
    // Three phases at ten cents reach a cap of twenty-five; the session waited there until it was raised.
    expect(r.log.filter((l) => l.startsWith('asked'))).toEqual(['asked for more at 0.30: 0.6']);
    const updates = api.requests.filter((x) => x.method === 'POST' && x.path === `/v1/sessions/${session.id}`);
    expect(updates.map((u) => u.body)).toEqual([{ budget: { type: 'limit', max_list_cost: { amount: '60', currency: 'USD' } } }]);
    expect(r.state.cap).toBe(0.6);
    expect(r.state.recorded).toEqual(PHASES);
    // Raising the cap is what sets the work going again: no message is sent.
    expect(messages(session)).toEqual(['Carry out this plan.']);
  });

  it('stops at the cap, with the session intact, when there is no more to give', async () => {
    api.script = wholePlan;
    const r = recorder();
    expect(await provider.executePlan(job(r.hooks, { budgetUsd: 0.25 }))).toEqual({ status: 'at_budget' });
    const session = api.session();
    expect(r.state.recorded).toEqual(['Spec', 'Build']);
    expect(r.state.spend).toBeCloseTo(0.3, 5);
    expect(api.count('POST', `/v1/sessions/${session.id}`)).toBe(0);
    expect(session.status).toBe('idle');
    expect(session.blocked).toBe('budget_reached');

    // Later, with money: the same session carries on from the cap.
    const again = recorder();
    again.state.recorded.push('Spec', 'Build');
    const outcome = await provider.executePlan(job(again.hooks, { budgetUsd: 1, session: { id: session.id, cursor: r.state.cursor, openRuns: [], reported: false } }));
    expect(outcome).toEqual({ status: 'reported' });
    expect(api.sessions.size).toBe(1);
    expect(again.state.recorded).toEqual(PHASES);
    expect(again.log.some((l) => l.startsWith('asked'))).toBe(false);
    expect(messages(session)).toEqual(['Carry out this plan.']);
  });

  it('asks again with the true figure when the session has spent more than the organisation knew', async () => {
    api.script = wholePlan;
    const r = recorder();
    await provider.executePlan(job(r.hooks, { budgetUsd: 0.25 }));
    const session = api.session();

    // The organisation thinks 0.20 was spent and offers a cap of 0.28; the session has in fact spent 0.30.
    const again = recorder();
    again.state.recorded.push('Spec', 'Build');
    again.state.grants.push(0.9);
    const outcome = await provider.executePlan(job(again.hooks, { budgetUsd: 0.28, session: { id: session.id, cursor: r.state.cursor, openRuns: [], reported: false } }));
    expect(outcome).toEqual({ status: 'reported' });
    expect(again.log.filter((l) => l.startsWith('asked'))).toEqual(['asked for more at 0.30: 0.9']);
    expect(again.state.cap).toBe(0.9);
  });
});

describe('holding a session', () => {
  it('holds it by bringing the cap down to what it has spent, and sets it going again by raising the cap', async () => {
    api.script = wholePlan;
    const r = recorder({ haltAfter: 'Spec' });
    expect(await provider.executePlan(job(r.hooks))).toEqual({ status: 'paused' });
    const session = api.session();

    expect(r.state.recorded).toEqual(['Spec']);
    // Capped within a few cents of what it had spent; the engine was told the new cap; nothing was interrupted.
    expect(session.capCents).toBeLessThan(200);
    expect(session.capCents).toBeLessThanOrEqual(session.spentCents + 5);
    expect(r.state.cap).toBe(session.capCents / 100);
    expect(sent(session, 'user.interrupt')).toHaveLength(0);
    expect(messages(session)).toEqual(['Carry out this plan.']);

    // The session cannot get past its cap while nobody is following it.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(session.spentCents).toBeLessThanOrEqual(30);

    const again = recorder();
    again.state.recorded.push('Spec');
    const outcome = await provider.executePlan(job(again.hooks, { budgetUsd: 1.5, session: { id: session.id, cursor: r.state.cursor, openRuns: [], reported: false } }));
    expect(outcome).toEqual({ status: 'reported' });
    expect(session.failure).toBeNull();
    expect(api.sessions.size).toBe(1);
    expect(session.capCents).toBe(150);
    expect(again.state.recorded).toEqual(PHASES);
    expect(again.state.spend).toBeCloseTo(0.4, 5);
    // Every phase was answered exactly once across the two attachments.
    expect(sent(session, 'user.custom_tool_result')).toHaveLength(5);
  });

  it('looks again when the session spent more while it was being capped', async () => {
    api.script = wholePlan;
    const r = recorder({ haltAfter: 'Spec' });
    api.failOnce((x) => x.method === 'POST' && /^\/v1\/sessions\/sesn_\d+$/.test(x.path), 400, "budget.max_list_cost must be greater than the session's consumed list cost");
    expect(await provider.executePlan(job(r.hooks))).toEqual({ status: 'paused' });
    const session = api.session();
    expect(api.count('POST', `/v1/sessions/${session.id}`)).toBe(2);
    expect(session.capCents).toBeLessThanOrEqual(session.spentCents + 5);
    expect(sent(session, 'user.interrupt')).toHaveLength(0);
  });

  it('interrupts the lead instead, and says so, when the cap cannot be brought down', async () => {
    api.script = wholePlan;
    const r = recorder({ haltAfter: 'Spec' });
    for (let i = 0; i < 3; i++) api.failOnce((x) => x.method === 'POST' && /^\/v1\/sessions\/sesn_\d+$/.test(x.path), 400, 'budget cannot be changed');
    expect(await provider.executePlan(job(r.hooks))).toEqual({ status: 'paused' });
    const session = api.session();
    expect(session.capCents).toBe(200);
    expect(r.state.cap).toBe(2);
    expect(sent(session, 'user.interrupt')).toHaveLength(1);
    expect(r.state.notes.at(-1)).toMatch(/could not be capped/);
  });

  it('holds the session the same way when its plan is cancelled', async () => {
    api.script = wholePlan;
    const r = recorder({ haltAfter: 'Build', halt: 'cancel' });
    expect(await provider.executePlan(job(r.hooks))).toEqual({ status: 'cancelled' });
    const session = api.session();
    expect(session.capCents).toBeLessThanOrEqual(session.spentCents + 5);
    expect(r.state.recorded).toEqual(['Spec', 'Build']);
    expect(api.requests.some((x) => x.method === 'DELETE' || x.path.endsWith('/archive'))).toBe(false);
  });

  it('holds the session at once when work in flight is dropped', async () => {
    const stop = new AbortController();
    api.script = async (s) => {
      s.running();
      await phase(s, 'Spec');
      stop.abort();
      for (const name of PHASES.slice(1)) await phase(s, name);
      await report(s);
    };
    const r = recorder();
    expect(await provider.executePlan(job(r.hooks, { signal: stop.signal }))).toEqual({ status: 'paused' });
    expect(api.session().capCents).toBeLessThan(200);
  });
});

describe('picking a session up again', () => {
  it('answers a call the session has been waiting on since before it was last read', async () => {
    // The lead recorded Spec and is waiting for the answer, but whoever was following the session went away
    // after reading past the call without answering it.
    api.script = wholePlan;
    const first = recorder({ halt: 'pause' });
    first.state.halt = 'pause';
    expect(await provider.executePlan(job(first.hooks))).toEqual({ status: 'paused' });
    const session = api.session();
    await waitFor(() => session.blocked !== null, 'the session to stop and wait');
    const cursor = session.events.at(-1)!.processed_at as string;

    const again = recorder();
    const outcome = await provider.executePlan(job(again.hooks, { session: { id: session.id, cursor, openRuns: [], reported: false } }));
    expect(outcome).toEqual({ status: 'reported' });
    expect(again.state.recorded).toEqual(PHASES);
  });

  it('gives a session that was never told its plan the plan', async () => {
    api.script = wholePlan;
    await provider.executePlan(job(recorder({ halt: 'pause' }).hooks)).catch(() => {});
    // A session exists that got no first message (as if the process died between creating it and saying anything).
    const lead = [...api.agents.keys()][1]!;
    const response = await fetch(`${api.baseURL}/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: { id: lead }, environment_id: [...api.environments.keys()][0], budget: { type: 'limit', max_list_cost: { amount: '10', currency: 'USD' } } }),
    });
    const { id } = (await response.json()) as { id: string };
    const session = api.sessions.get(id)!;
    void (async () => {
      await session.next((e) => e.type === 'user.message');
      await wholePlan(session);
    })();

    const r = recorder();
    expect(await provider.executePlan(job(r.hooks, { session: { id, cursor: null, openRuns: [], reported: false } }))).toEqual({ status: 'reported' });
    expect(messages(session)).toEqual(['Carry out this plan.']);
    expect(session.capCents).toBe(200);
  });

  it('takes a plan as finished when the report was already in and the session has since stopped', async () => {
    api.script = wholePlan;
    const first = recorder();
    await provider.executePlan(job(first.hooks));
    const session = api.session();

    const again = recorder();
    again.state.recorded.push(...PHASES);
    const outcome = await provider.executePlan(job(again.hooks, { session: { id: session.id, cursor: first.state.cursor, openRuns: [], reported: true } }));
    expect(outcome).toEqual({ status: 'reported' });
    expect(messages(session)).toEqual(['Carry out this plan.']);
  });

  it('reports a session that no longer exists, or has ended, as lost', async () => {
    api.script = wholePlan;
    const gone = await provider.executePlan(job(recorder().hooks, { session: { id: 'sesn_missing', cursor: null, openRuns: [], reported: false } }));
    expect(gone).toEqual({ status: 'lost', reason: 'the session no longer exists.' });

    await provider.executePlan(job(recorder().hooks));
    const session = api.session();
    session.archived = true;
    const archived = await provider.executePlan(job(recorder().hooks, { session: { id: session.id, cursor: null, openRuns: [], reported: false } }));
    expect(archived).toEqual({ status: 'lost', reason: 'the session was archived.' });
  });
});

describe('a session that goes wrong', () => {
  it('reads what it missed when the stream drops, and hears nothing twice', async () => {
    api.script = async (s) => {
      s.running();
      await phase(s, 'Spec');
      s.drop();
      // Said while nobody was listening.
      s.delegate('sthr_b', 'Build: write the module', 'Wrote module.py.', { name: 'engineering/module.py', content: 'print(1)' });
      await phase(s, 'Build');
      s.drop();
      for (const name of PHASES.slice(2)) await phase(s, name);
      await report(s);
    };
    const r = recorder();
    expect(await provider.executePlan(job(r.hooks))).toEqual({ status: 'reported' });
    expect(api.session().failure).toBeNull();
    expect(api.count('GET', `/v1/sessions/${api.session().id}/events/stream`)).toBeGreaterThanOrEqual(3);
    expect(r.state.recorded).toEqual(PHASES);
    expect(r.log.filter((l) => l.startsWith('phase'))).toHaveLength(4);
    expect(r.log.filter((l) => l === 'reported sthr_b: Wrote module.py.')).toHaveLength(1);
    expect(r.state.files.get('engineering/module.py')).toBe('print(1)');
    expect(sent(api.session(), 'user.custom_tool_result')).toHaveLength(5);
  });

  it('acts once on something that is both in the history it reads and on the stream', async () => {
    // The lead stops, without reporting, just as the client attaches: the stop is on the stream that has
    // just opened and in the history read straight after.
    let stopped = false;
    api.onStream = (s) => {
      if (stopped) return;
      stopped = true;
      s.running();
      s.idle({ type: 'end_turn' });
    };
    api.script = async (s) => {
      await s.next((e) => e.type === 'user.message' && e.content[0].text === 'Carry on with the plan.');
      s.running();
      for (const name of PHASES) await phase(s, name);
      await report(s);
    };
    const r = recorder();
    expect(await provider.executePlan(job(r.hooks))).toEqual({ status: 'reported' });
    expect(messages(api.session())).toEqual(['Carry out this plan.', 'Carry on with the plan.']);
  });

  it('notices a session that stopped without the stream saying so', async () => {
    api.script = async (s) => {
      s.running();
      for (const name of PHASES) await phase(s, name);
      const reply = await s.call('report_to_board', { headline: 'Shipped', summary: 'Done.', outcomes: [] });
      if (reply.isError) throw new Error(reply.text);
      // The session stops, but the event that says so never reaches the stream.
      const streams = [...s.streams];
      s.streams.clear();
      s.idle({ type: 'end_turn' });
      for (const stream of streams) s.streams.add(stream);
    };
    const r = recorder();
    expect(await provider.executePlan(job(r.hooks))).toEqual({ status: 'reported' });
    expect(api.count('GET', `/v1/sessions/${api.session().id}/events/stream`)).toBe(2);
  });

  it('sets a lead going again when it stops without reporting', async () => {
    api.script = async (s) => {
      s.running();
      for (const name of PHASES) await phase(s, name);
      s.idle({ type: 'end_turn' }); // forgot to report
      await s.next((e) => e.type === 'user.message' && e.content[0].text === 'Carry on with the plan.');
      s.running();
      await report(s);
    };
    const r = recorder();
    expect(await provider.executePlan(job(r.hooks, { resume: () => ({ message: 'Carry on with the plan.', instructions: 1 }) }))).toEqual({ status: 'reported' });
    expect(messages(api.session())).toEqual(['Carry out this plan.', 'Carry on with the plan.']);
    expect(r.log).toContain('instructed 1');
  });

  it('gives a session up as lost when its lead keeps stopping without reporting', async () => {
    api.script = async (s) => {
      for (;;) {
        s.running();
        s.says('I think I am done.');
        s.idle({ type: 'end_turn' });
        await s.next((e) => e.type === 'user.message' && e.content[0].text === 'Carry on with the plan.');
      }
    };
    const r = recorder();
    expect(await provider.executePlan(job(r.hooks))).toEqual({ status: 'lost', reason: 'the lead stopped without reporting to the board.' });
    expect(messages(api.session())).toEqual(['Carry out this plan.', 'Carry on with the plan.', 'Carry on with the plan.', 'Carry on with the plan.']);
  });

  it('waits a moment for a lead that gave up on an error, then sets it going', async () => {
    api.script = async (s) => {
      s.running();
      await phase(s, 'Spec');
      s.emit('session.error', { error: { type: 'model_overloaded_error', message: 'The model is overloaded.', retry_status: { type: 'exhausted' } } });
      s.idle({ type: 'retries_exhausted' });
      await s.next((e) => e.type === 'user.message' && e.content[0].text === 'Carry on with the plan.');
      s.running();
      for (const name of PHASES.slice(1)) await phase(s, name);
      await report(s);
    };
    const r = recorder();
    expect(await provider.executePlan(job(r.hooks))).toEqual({ status: 'reported' });
    expect(r.state.notes).toContain('The session met an error: The model is overloaded.');
    expect(r.state.recorded).toEqual(PHASES);
  });

  it('reports a session that ended by itself as lost, with the reason', async () => {
    api.script = async (s) => {
      s.running();
      await phase(s, 'Spec');
      s.emit('session.error', { error: { type: 'unknown_error', message: 'The sandbox could not be restored.', retry_status: { type: 'terminal' } } });
      s.terminate();
    };
    const r = recorder();
    expect(await provider.executePlan(job(r.hooks))).toEqual({ status: 'lost', reason: 'The sandbox could not be restored.' });
    expect(r.state.recorded).toEqual(['Spec']);
  });

  it('marks an agent that gave up or was declined as failed', async () => {
    api.script = async (s) => {
      s.running();
      s.emit('session.thread_created', { session_thread_id: 'sthr_x', agent_name: 'Team agent', workflow_run_id: null });
      s.emit('agent.thread_message_sent', { to_session_thread_id: 'sthr_x', to_agent_name: 'Team agent', content: [{ type: 'text', text: 'Write the spec.' }] });
      s.emit('session.thread_status_idle', { session_thread_id: 'sthr_x', agent_name: 'Team agent', stop_reason: { type: 'retries_exhausted' }, stop_details: null });
      for (const name of PHASES) await phase(s, name);
      await report(s);
    };
    const r = recorder();
    const ended: unknown[] = [];
    r.hooks.agentEnded = (threadId, how, detail) => void ended.push([threadId, how, detail]);
    await provider.executePlan(job(r.hooks));
    expect(ended[0]).toEqual(['sthr_x', 'failed', 'The agent gave up after repeated errors.']);
  });
});

describe('files a session produces', () => {
  it('fetches a small file again at the end, in case it was rewritten to the same length', async () => {
    api.script = async (s) => {
      s.running();
      s.writes('engineering/config.json', '{"n":1}');
      await phase(s, 'Spec');
      s.writes('engineering/config.json', '{"n":2}');
      for (const name of PHASES.slice(1)) await phase(s, name);
      await report(s);
    };
    const r = recorder();
    await provider.executePlan(job(r.hooks));
    expect(r.state.files.get('engineering/config.json')).toBe('{"n":2}');
  });

  it('brings home what appears in the listing a moment after the session stops', async () => {
    api.script = async (s) => {
      s.running();
      for (const name of PHASES) await phase(s, name);
      await report(s);
      setTimeout(() => s.writes('engineering/late.md', 'Late'), 2);
    };
    const r = recorder();
    await provider.executePlan(job(r.hooks));
    expect(r.state.files.get('engineering/late.md')).toBe('Late');
  });

  it('leaves alone what it cannot download', async () => {
    api.script = async (s) => {
      s.running();
      s.writes('engineering/locked.bin', 'x', false);
      for (const name of PHASES) await phase(s, name);
      await report(s);
    };
    const r = recorder();
    expect(await provider.executePlan(job(r.hooks))).toEqual({ status: 'reported' });
    expect(r.state.files.has('engineering/locked.bin')).toBe(false);
    expect(r.state.files.size).toBe(4);
  });

  it('reads what an agent was asked and what it returned from the agent\'s own thread', async () => {
    api.script = wholePlan;
    await provider.executePlan(job(recorder().hooks));
    const detail = await provider.agentDetail(api.session().id, 'sthr_a');
    expect(detail).toEqual({ brief: 'Spec: write the document', report: 'Wrote release.md.' });
    expect(await provider.agentDetail(api.session().id, 'sthr_none')).toEqual({ brief: null, report: null });
  });
});

describe('the organisation on hosted sessions, end to end', () => {
  /** Board work from the simulator; plans carried out through the Claude provider against the stand-in API. */
  class Hybrid extends MockProvider {
    constructor(private readonly claude: ClaudeProvider) {
      super({ ...QUIET, runs: 'never' });
    }
    override executePlan(plan: PlanJob): Promise<PlanOutcome> {
      return this.claude.executePlan(plan);
    }
    override agentDetail(sessionId: string, threadId: string) {
      return this.claude.agentDetail(sessionId, threadId);
    }
  }
  const setup = (settings = {}) =>
    harness({ provider: new Hybrid(provider), executives: [{ profileId: 'engineering', agentCount: 2 }], settings: { execution: 'managed', budgetUsd: 5, ...settings } });

  it('carries a plan from directive to board report through a session', async () => {
    api.script = wholePlan;
    h = await setup();
    await runToRest(h.runner);
    const { org } = h;
    const plan = org.plans[0]!;
    const session = api.session();

    expect(session.failure).toBeNull();
    expect(org.lastError).toBeNull();
    expect(plan.status).toBe('done');
    expect(plan.managed).toMatchObject({ sessionId: session.id, state: 'finished', spentUsd: 0.4, pendingReport: null, declined: 0 });
    expect(plan.managed!.consoleUrl).toContain(session.id);
    expect(plan.phases.map((p) => [p.name, p.status, p.summary])).toEqual(PHASES.map((name) => [name, 'done', `${name} passed its gate.`]));
    // One agent did a task in each phase and kept its number.
    expect(plan.phases.map((p) => p.tasks.map((t) => [t.title, t.agent, t.status, t.result]))).toEqual(
      PHASES.map((name) => [[`${name}: write the document`, 1, 'done', `Wrote ${name.toLowerCase()}.md.`]]),
    );
    expect(org.reports[0]).toMatchObject({ headline: 'Shipped', files: ['engineering/spec.md', 'engineering/build.md', 'engineering/test.md', 'engineering/release.md'] });
    expect((await h.runner.workspace.read('engineering/build.md')).content).toBe('# Build');
    // The session's spend, as the platform reported it, is in the organisation's total and the lead's.
    expect(org.usageByExec.cto!.costUsd).toBeGreaterThanOrEqual(0.4);
    expect(org.usage.costUsd).toBeGreaterThanOrEqual(0.4);

    // What the session was given: the lead's seat, the plan, and how plans are run in a sandbox.
    const created = session.created;
    expect(created.agent.system).toContain('You are the Chief Technology Officer (CTO), leading Engineering.');
    expect(created.agent.system).toContain('call record_phase');
    expect(created.agent.system).toMatch(/start a workflow run for that phase/);
    expect(created.agent.system).toMatch(/do not start a run/);
    const kickoff = created.initial_events[0].content[0].text as string;
    expect(kickoff).toContain(plan.objective);
    expect(kickoff).toContain('You have 2 agents.');
    expect(kickoff).toContain('/mnt/session/outputs/engineering/');
    // The session's cap is what the budget had left for it.
    expect(Number(created.budget.max_list_cost.amount) / 100).toBeLessThanOrEqual(5);
    expect(Number(created.budget.max_list_cost.amount) / 100).toBeGreaterThan(4);
    expect(body('POST', '/v1/agents', 0).system).toContain('/mnt/session/outputs/');
  });

  it('holds the session when the organisation is paused and carries on in it when started again', async () => {
    api.script = wholePlan;
    h = await setup();
    h.runner.start();
    await waitFor(() => h!.org.plans[0]?.phases[0]?.status === 'done', 'the first phase to be recorded');
    h.runner.pause();
    await h.runner.idle();
    const plan = h.org.plans[0]!;
    const session = api.session();
    expect(plan.managed!.state).toBe('paused');
    expect(session.capCents).toBeLessThan(100);
    expect(plan.managed!.budgetUsd).toBe(session.capCents / 100);

    await runToRest(h.runner);
    expect(session.failure).toBeNull();
    expect(plan.status).toBe('done');
    expect(api.sessions.size).toBe(1);
    expect(plan.phases.every((p) => p.tasks.length === 1)).toBe(true);
    expect(plan.managed!.spentUsd).toBe(0.4);
  });

  it('pauses on the budget when the session runs dry, and finishes in the same session once it is raised', async () => {
    api.script = async (s) => {
      s.running();
      for (const name of PHASES) await phase(s, name, 20);
      await report(s);
    };
    h = await setup({ budgetUsd: 0.5 });
    await runToRest(h.runner);
    const plan = h.org.plans[0]!;
    expect(h.org.pauseReason).toBe('budget');
    expect(plan.status).toBe('executing');
    // The request that reaches the cap completes, so the session ends a little past it, and with it the
    // organisation's budget: the session is then held like any other work when the budget is spent.
    expect(['at_budget', 'paused']).toContain(plan.managed!.state);
    expect(h.org.usage.costUsd).toBeLessThan(0.5 + 0.2);
    expect(api.session().spentCents).toBe(60);
    expect(h.org.board.filter((m) => m.title === 'Budget reached')).toHaveLength(1);

    h.runner.updateSettings({ budgetUsd: 3 });
    await runToRest(h.runner);
    expect(api.session().failure).toBeNull();
    expect(plan.status).toBe('done');
    expect(api.sessions.size).toBe(1);
    expect(plan.managed!.spentUsd).toBe(0.8);
  });

  it('starts a fresh session when the first is lost, with the phases already recorded marked as such', async () => {
    let sessions = 0;
    api.script = async (s) => {
      sessions += 1;
      s.running();
      if (sessions === 1) {
        await phase(s, 'Spec');
        s.emit('session.error', { error: { type: 'unknown_error', message: 'The sandbox could not be restored.', retry_status: { type: 'terminal' } } });
        return s.terminate();
      }
      for (const name of PHASES.slice(1)) await phase(s, name);
      await report(s);
    };
    h = await setup();
    await runToRest(h.runner);
    const plan = h.org.plans[0]!;
    expect(plan.status).toBe('done');
    expect(api.sessions.size).toBe(2);
    const kickoff = api.session().created.initial_events[0].content[0].text as string;
    expect(kickoff).toContain('Already recorded: Spec passed its gate.');
    expect(kickoff).toContain('starting with Build');
    // The file the first session produced is mounted in the second.
    expect(api.session().created.resources.map((x: { mount_path: string }) => x.mount_path)).toEqual(['/workspace/engineering/spec.md']);
    expect(h.org.board.some((m) => m.title === 'CTO session ended early' && m.body.includes('The sandbox could not be restored.'))).toBe(true);
    // Both sessions' spend is counted.
    expect(h.org.usageByExec.cto!.costUsd).toBeGreaterThanOrEqual(0.4);
  });
});
