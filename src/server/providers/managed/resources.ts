import { z } from 'zod';
import { BusinessUpdates } from '../../../shared/business-schema';
import { MEMORY_KINDS } from '../../../shared/memory';
import { strictSchema } from '../schema';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import type { Effort } from '../../../shared/types';
import { DEFAULT_MODEL } from '../pricing';
import { PLAN_TOOLS } from '../types';

// The agents and environments that hosted sessions are started from. They are
// saved on Anthropic's side and are meant to be created once: their ids are
// kept in a file beside the organisations' data and reused by every session.
// Nothing here is ever archived or deleted.

type AgentCreateParams = Anthropic.Beta.AgentCreateParams;
type Toolset = Anthropic.Beta.BetaManagedAgentsAgentToolset20260401Params;
type CustomTool = Anthropic.Beta.BetaManagedAgentsCustomToolParams;
type EnvironmentCreateParams = Anthropic.Beta.EnvironmentCreateParams;

export interface TeamSpec {
  workerModel: string;
  workerEffort: Effort;
  /** The name the lead knows its agents by, and their standing instructions. */
  workerName: string;
  workerSystem: string;
  /** Whether agents may search and fetch from the web. That needs a sandbox whose network is open. */
  web: boolean;
  /** Whether the lead may start workflow runs. */
  workflows: boolean;
}

export interface AgentRef {
  id: string;
  version: number;
  /** A digest of the definition this version was saved from, to tell when the definition has changed. */
  hash: string;
}

interface Account {
  environments: Record<string, string>;
  workers: Record<string, AgentRef>;
  leads: Record<string, AgentRef>;
}

interface StateFile {
  version: 1;
  /** Keyed by a digest of the credentials and endpoint, so ids made with one key are never offered to another. */
  accounts: Record<string, Account>;
}

/**
 * The tools every agent in a session has: the sandbox's own (shell, files).
 * Each call is judged by the platform: run when it is safe, refused when it is
 * high-risk, and held for approval when the platform cannot tell. Nobody is
 * watching these sessions, so a held call is declined (see the session loop).
 */
function toolset(web: boolean): Toolset {
  return {
    type: 'agent_toolset_20260401',
    default_config: { enabled: true, permission_policy: { type: 'auto' } },
    configs: [
      { name: 'web_search', enabled: web },
      { name: 'web_fetch', enabled: web },
    ],
  };
}

const RECORD_PHASE: CustomTool = {
  type: 'custom',
  name: PLAN_TOOLS.recordPhase,
  description:
    'Record that a phase of your operating profile has passed your gate review. Call it once for each phase, in order, after you have reviewed the files the phase produced and before you start the next phase. The reply says which phase is next and carries any new binding instructions from the board.',
  input_schema: {
    type: 'object',
    properties: {
      operations: strictSchema(z.toJSONSchema(BusinessUpdates)),
      phase: { type: 'string', description: 'The name of the phase, as it is written in your operating profile.' },
      summary: {
        type: 'string',
        description: 'What the phase produced and in which files, what you checked or ran at the gate and what that showed, and anything carried forward as an open point.',
      },
      decisions: {
        type: 'array',
        description: 'Decisions you took inside your remit during this phase. Leave empty if there were none.',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            decision: { type: 'string' },
            rationale: { type: 'string' },
          },
          required: ['title', 'decision', 'rationale'],
        },
      },
      requests: {
        type: 'array',
        description:
          'Payments to be made or documents to be signed that the plan now needs for its work to take effect. Neither you nor your agents can do either: each request goes to the Authorised Signatory, and has not happened until you are told it is done. Ask only for what the plan needs next. Leave empty if there is nothing to ask for, which is usual.',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['payment', 'signature'] },
            title: { type: 'string', description: 'What is to be paid for or signed, in a few words.' },
            detail: { type: 'string', description: 'Why the plan needs it now, and exactly what the signatory is asked to do.' },
            amount: { type: 'string', description: 'For a payment: the amount with its currency and how often, e.g. "12 GBP a year". Say so if it is an estimate. Empty for a signature.' },
            party: { type: 'string', description: 'Who is to be paid, or who the agreement is with.' },
            files: { type: 'array', items: { type: 'string' }, description: 'Paths of files the signatory should read first, such as the agreement to sign or a quote.' },
          },
          required: ['kind', 'title', 'detail'],
        },
      },
    },
    required: ['phase', 'summary'],
  },
};

const REPORT_TO_BOARD: CustomTool = {
  type: 'custom',
  name: PLAN_TOOLS.reportToBoard,
  description:
    'Report the finished plan to the whole board. Call it once, after every phase has been recorded. Other leads read the report and may start work of their own because of it, so state only what was delivered.',
  input_schema: {
    type: 'object',
    properties: {
      headline: { type: 'string', description: 'One line: what the plan delivered.' },
      summary: { type: 'string', description: 'What was done, measured against the success criteria. Say plainly what was run or verified and what was not.' },
      outcomes: { type: 'array', items: { type: 'string' }, description: 'The concrete results, one per item, naming the files where they are.' },
      asks: { type: 'array', items: { type: 'string' }, description: 'Requests to other leads or to the board. Leave empty if there are none.' },
    },
    required: ['headline', 'summary', 'outcomes'],
  },
};

const RECALL: CustomTool = {
  type: 'custom',
  name: PLAN_TOOLS.recall,
  description:
    'Search the organisation’s memory: everything it has reported, decided, planned and written in every cycle so far, however long ago, and the text of the files in its workspace. Use it before a phase that may repeat earlier work, and to find what was decided on a matter before you go against it. A search returns the passages that match, each with an id; a read returns the whole of one item by its id. It matches words, so ask in the words the thing itself would use. It changes nothing, and you may call it at any time. Your agents cannot call it: put what they need of it in their task.',
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['search', 'read'], description: 'search: find what matches a few words. read: the whole of one item a search found.' },
      query: { type: 'string', description: 'For a search: a few words on what you are looking for.' },
      kind: { type: 'string', enum: [...MEMORY_KINDS], description: 'For a search: keep it to one kind of thing. Leave it out to look among everything.' },
      id: { type: 'string', description: 'For a read: an id that a search gave.' },
    },
    required: ['action'],
  },
};

function workerParams(spec: TeamSpec): AgentCreateParams {
  return {
    name: spec.workerName,
    description: "A member of a lead's team in the_organisation. Does the task its lead gives it in the shared sandbox and reports back.",
    model: { id: spec.workerModel, effort: spec.workerEffort },
    system: spec.workerSystem,
    tools: [toolset(spec.web)],
    metadata: { app: 'the_organisation', role: 'team-agent' },
  };
}

function leadParams(spec: TeamSpec, worker: AgentRef): AgentCreateParams {
  const team = { type: 'agent' as const, id: worker.id, version: worker.version };
  return {
    name: 'Executive lead',
    description: 'An executive lead in the_organisation. Carries a plan through its operating profile with a team of agents. Its model and instructions are set for each session.',
    // Every session replaces the model and the instructions with those of the organisation and seat it is for.
    model: { id: DEFAULT_MODEL },
    system: `You are an executive lead. Your organisation, your seat and how plans are run are given at the start of each session.${
      spec.workflows
        ? ' When a phase of a plan has many separate pieces of the same kind of work, more than your agents could take one each, start a workflow run for it. Hand a handful of tasks out to your agents directly, without a run.'
        : ' Hand every task out to your agents yourself.'
    }`,
    tools: [toolset(spec.web), RECORD_PHASE, REPORT_TO_BOARD, RECALL],
    multiagent: {
      type: 'multiagent_20261001',
      // The lead's agents are copies of the team agent and nothing else: it cannot define agents of its own,
      // which would run on the lead's model with the lead's tools.
      subagents: { type: 'enabled', predefined_agents: [team], inline_agents: { type: 'disabled' } },
      // Dynamic workflows: the lead can write a program that puts many team agents on one phase's pieces and
      // have it run in the background. They are on unless the organisation's shareholders switched them off.
      workflows: spec.workflows ? { type: 'enabled', predefined_agents: [team], inline_agents: { type: 'disabled' } } : { type: 'disabled' },
    },
    metadata: { app: 'the_organisation', role: 'lead' },
  };
}

function environmentParams(network: 'limited' | 'unrestricted'): EnvironmentCreateParams {
  return network === 'limited'
    ? {
        name: 'the_organisation sandbox (package registries only)',
        description: 'Sandbox for plans carried out without web research. Code can install packages; nothing else outside is reachable.',
        config: { type: 'cloud', networking: { type: 'limited', allow_package_managers: true, allow_mcp_servers: false, allowed_hosts: [] } },
        metadata: { app: 'the_organisation' },
      }
    : {
        name: 'the_organisation sandbox (open network)',
        description: 'Sandbox for organisations whose shareholders switched web research on. Code the agents run can reach any site.',
        config: { type: 'cloud', networking: { type: 'unrestricted' } },
        metadata: { app: 'the_organisation' },
      };
}

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);

export class ManagedResources {
  private state: StateFile | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly client: Anthropic,
    /** Where the ids are kept. */
    private readonly file: string,
  ) {}

  /** One at a time: two plans starting together must not each create the same agent. */
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }

  private async load(): Promise<StateFile> {
    if (this.state) return this.state;
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8')) as StateFile;
      this.state = parsed?.version === 1 && parsed.accounts ? parsed : { version: 1, accounts: {} };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT' && !(err instanceof SyntaxError)) throw err;
      this.state = { version: 1, accounts: {} };
    }
    return this.state;
  }

  private async save(): Promise<void> {
    if (!this.state) return;
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.state, null, 2), 'utf8');
    await fs.rename(tmp, this.file);
  }

  private async account(): Promise<Account> {
    const state = await this.load();
    const key = digest([this.client.baseURL, this.client.apiKey ?? this.client.authToken ?? 'profile']);
    return (state.accounts[key] ??= { environments: {}, workers: {}, leads: {} });
  }

  /**
   * The environment and lead agent for a team of this kind, created the first
   * time they are needed. If the definition in this file has changed since an
   * agent was saved, the agent is updated, which gives it a new version;
   * sessions already running keep the version they started with.
   */
  ensure(spec: TeamSpec): Promise<{ environmentId: string; lead: AgentRef; worker: AgentRef }> {
    return this.exclusive(async () => {
      const account = await this.account();
      const network = spec.web ? 'unrestricted' : 'limited';
      const environmentId = (account.environments[network] ??= await this.environment(network));
      await this.save();
      // One team agent for each kind of agent in use, and for each of those a lead that may start workflow runs and one that may not.
      const key = `${spec.workerModel}|${spec.workerEffort}|${spec.web ? 'web' : 'no-web'}`;
      const worker = await this.agent(account.workers, key, workerParams(spec));
      const lead = await this.agent(account.leads, `${key}|${spec.workflows ? 'runs' : 'no-runs'}`, leadParams(spec, worker));
      return { environmentId, lead, worker };
    });
  }

  /** The ids on file turned out not to exist (another workspace's, or removed by hand). The next `ensure` makes new ones. */
  forget(): Promise<void> {
    return this.exclusive(async () => {
      const account = await this.account();
      account.environments = {};
      account.workers = {};
      account.leads = {};
      await this.save();
    });
  }

  private async environment(network: 'limited' | 'unrestricted'): Promise<string> {
    const params = environmentParams(network);
    try {
      return (await this.client.beta.environments.create(params)).id;
    } catch (err) {
      if (!(err instanceof Anthropic.ConflictError)) throw err;
      // One of that name is already there, from an earlier run whose record was lost. Use it.
      for await (const existing of this.client.beta.environments.list()) {
        if (existing.name === params.name && !existing.archived_at) return existing.id;
      }
      throw err;
    }
  }

  private async agent(known: Record<string, AgentRef>, key: string, params: AgentCreateParams): Promise<AgentRef> {
    const hash = digest(params);
    const existing = known[key];
    if (existing?.hash === hash) return existing;
    const saved = existing ? await this.update(existing, params) : await this.client.beta.agents.create(params);
    const ref = { id: saved.id, version: saved.version, hash };
    known[key] = ref;
    await this.save();
    return ref;
  }

  private async update(existing: AgentRef, params: AgentCreateParams): Promise<Anthropic.Beta.BetaManagedAgentsAgent> {
    const { agents } = this.client.beta;
    try {
      return await agents.update(existing.id, { ...params, version: existing.version });
    } catch (err) {
      if (err instanceof Anthropic.NotFoundError) return agents.create(params);
      // The agent was changed elsewhere since this version was saved. The definition here is the one sessions are written for.
      if (err instanceof Anthropic.ConflictError || err instanceof Anthropic.BadRequestError) return agents.update(existing.id, params);
      throw err;
    }
  }
}
