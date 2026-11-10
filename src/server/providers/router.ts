import Anthropic from '@anthropic-ai/sdk';
import type { ConnectionInfo, ModelOption, PresetInfo, ProviderInfo } from '../../shared/types';
import { ConnectionStore, address, keyHint, type Connection } from '../connections';
import { ValidationError, isModelRef } from '../engine/state';
import { PLAIN_DIALECT, PRESETS, presetById, ratesOn, type CatalogueModel, type Preset, type Price } from './catalogue';
import { ClaudeProvider, type ClaudeProviderOptions } from './claude';
import { CLAUDE_CODE_STARTER, ClaudeCodeProvider, checkClaudeCode, describeStatus, type ClaudeCodeOptions } from './claude-code';
import { MockProvider, type MockOptions } from './mock';
import { OpenAICompatibleProvider, UNKNOWN_PRICE, scrub, type CompatibleOptions, type ListedModel } from './openai-compatible';
import { OpenAIResponsesProvider } from './openai-responses';
import { DEFAULT_MODEL, MODELS } from './pricing';
import { ProviderError, type AgentRequest, type AgentResult, type CallUsage, type PlanJob, type PlanOutcome, type Provider, type StructuredRequest } from './types';

// One provider in front of all the others. An organisation's settings name a
// model as "<connection>:<model id>"; each call is sent to the provider that
// connection is for. A bare model id is a Claude model on the first Anthropic
// connection, which is how organisations named their models before there was
// more than one provider.
//
// One kind of connection is not a key: Claude Code, the program on this
// machine, run on the login it already has. It is there when asked for, and
// never what a new organisation starts on while there is a key.
//
// With nothing connected at all, everything goes to the simulator.

export interface RouterOptions {
  /** Never call a real model, whatever keys there are. */
  forceMock?: boolean;
  mock?: MockOptions;
  /** Passed to each Claude provider: where the ids for hosted sessions are kept, and the workspace for Console links. */
  claude?: Pick<ClaudeProviderOptions, 'managedStateFile' | 'workspace' | 'sessionTimings' | 'turnRetryDelayMs'>;
  /** Passed to each OpenAI-compatible provider. For tests. */
  compatible?: { maxRetries?: number; turnRetryDelayMs?: number };
  /** How Claude Code is run. Without this, that connection can be neither added nor used. */
  claudeCode?: ClaudeCodeOptions & {
    /** Why the connection may not be used on this server, in words for the person, if it may not. */
    blocked?: string;
  };
}

export interface NewConnection {
  presetId: string;
  apiKey?: string;
  /** One of the preset's regions, by id. */
  region?: string;
  /** An address of your own, which stands over the region's. Needed for the "custom" preset. */
  baseURL?: string;
  label?: string;
}

type Callable = ClaudeProvider | OpenAICompatibleProvider | ClaudeCodeProvider;

/** Split a model reference into the connection it names and the provider's own id for the model. */
export function parseRef(ref: string): { connectionId: string | null; model: string } {
  const at = ref.indexOf(':');
  return at < 0 ? { connectionId: null, model: ref } : { connectionId: ref.slice(0, at), model: ref.slice(at + 1) };
}

export class ProviderRouter implements Provider {
  private readonly mock: MockProvider;
  private readonly clients = new Map<string, { provider: Callable; signature: string }>();

  constructor(
    private readonly store: ConnectionStore,
    private readonly options: RouterOptions = {},
  ) {
    this.mock = new MockProvider(options.mock);
  }

  /**
   * True when no real model is called: because the server was told to simulate, or because it has never had a
   * key. A server that had keys and has none left does not simulate: its organisations were set up on real
   * models, and made-up answers passed off as theirs would be worse than a pause that says which key is missing.
   */
  get simulated(): boolean {
    return !!this.options.forceMock || !this.store.hadKeys;
  }

  // ---- which models there are ----

  private preset(connection: Connection): Preset {
    return presetById(connection.presetId) ?? presetById('custom')!;
  }

  private refOf(connection: Connection, model: string): string {
    return connection.id === this.plainAnthropic()?.id ? model : `${connection.id}:${model}`;
  }

  /**
   * The Anthropic key that plain Claude model names belong to: the one called "anthropic", and no other. An
   * organisation set up on plain names stays on that key whatever other Anthropic keys come and go; if the key
   * is removed, its calls say so instead of going out on a different account.
   */
  private plainAnthropic(): Connection | undefined {
    const connection = this.store.get('anthropic');
    return connection && this.preset(connection).kind === 'anthropic' ? connection : undefined;
  }

  private anthropicKeys(): Connection[] {
    return this.store.list().filter((c) => this.preset(c).kind === 'anthropic');
  }

  /**
   * The catalogue's models for the platform a connection is on. A provider with separate international and
   * mainland-China platforms can have different models, and different prices, on each.
   */
  private catalogueFor(connection: Connection): CatalogueModel[] {
    const preset = this.preset(connection);
    const region = preset.regions.find((r) => r.baseURL === connection.baseURL)?.id;
    // At an address of the user's own there is no telling which platform it is, so nothing is ruled out.
    return preset.models.filter((m) => !m.only || !region || m.only.includes(region));
  }

  /**
   * The price that spend on a model is counted at: one set by hand; else the one the provider's own listing
   * gives, which only a gateway's does and which is then the live price; else the catalogue's list price as it
   * stands today. Null if none is known.
   */
  private priceOf(connection: Connection, model: string): Price | null {
    // Looked up as the connection's own entry: a model may be named after something every object has.
    const own = Object.hasOwn(connection.prices, model) ? connection.prices[model] : undefined;
    if (own) return own;
    const live = connection.models.find((m) => m.id === model)?.price;
    if (live) return live;
    const known = this.catalogueFor(connection).find((m) => m.id === model);
    return known ? ratesOn(known) : null;
  }

  /** The effort levels a model takes: what the provider's listing says, else what the catalogue says. Undefined if neither does. */
  private effortsOf(connection: Connection, model: string): string[] | null | undefined {
    const live = connection.models.find((m) => m.id === model)?.efforts;
    return live !== undefined ? live : this.catalogueFor(connection).find((m) => m.id === model)?.efforts;
  }

  /** The models one connection offers: the catalogue's picks first, then whatever else the key can call. */
  private optionsOf(connection: Connection): ModelOption[] {
    const preset = this.preset(connection);
    if (preset.kind === 'anthropic' || preset.kind === 'claude-code') {
      // Claude Code reaches the same Claude models as a key does. Hosted sessions and web search are the API's alone.
      const api = preset.kind === 'anthropic';
      return MODELS.map((m) => ({
        id: this.refOf(connection, m.id),
        label: m.label,
        inputPerMTok: m.input,
        outputPerMTok: m.output,
        connectionId: connection.id,
        provider: connection.label,
        priced: true,
        recommended: true,
        tier: m.tier,
        hosted: api,
        web: api,
        ...(api ? {} : { note: 'On your Claude Code login: spend is counted at these API prices. A subscription is not billed for it; if Claude Code says a call is being billed, the organisation pauses.' }),
      }));
    }
    const listed = new Map<string, ListedModel>(connection.models.map((m) => [m.id, m]));
    const option = (model: string, known?: CatalogueModel): ModelOption => {
      const price = this.priceOf(connection, model);
      const entry = listed.get(model);
      return {
        id: this.refOf(connection, model),
        label: known?.label ?? entry?.name ?? model,
        inputPerMTok: (price ?? UNKNOWN_PRICE).input,
        outputPerMTok: (price ?? UNKNOWN_PRICE).output,
        connectionId: connection.id,
        provider: connection.label,
        priced: price !== null,
        recommended: !!known,
        ...(known ? { tier: known.tier } : {}),
        hosted: false,
        web: false,
        ...(known?.note ? { note: known.note } : {}),
      };
    };
    // A provider that does not list its models, or whose listing could not be read, still offers the catalogue's.
    const picks = this.catalogueFor(connection).filter((m) => listed.size === 0 || listed.has(m.id));
    const picked = new Set(picks.map((m) => m.id));
    const others = [...new Set([...connection.extraModels, ...connection.models.filter((m) => m.tools !== false).map((m) => m.id)])]
      .filter((id) => !picked.has(id))
      .sort((a, b) => a.localeCompare(b));
    // A model whose name could not be kept in an organisation's settings is not offered for them.
    return [...picks.map((m) => option(m.id, m)), ...others.map((id) => option(id))].filter((m) => isModelRef(m.id));
  }

  private models(): ModelOption[] {
    if (this.simulated) return this.mock.info().models;
    return this.store.list().flatMap((c) => this.optionsOf(c));
  }

  info(): ProviderInfo {
    const simulated = this.simulated;
    const connections = this.store.list();
    return {
      id: simulated ? 'mock' : 'router',
      label: simulated ? 'Simulation' : connections.map((c) => c.label).join(', ') || 'No key connected',
      simulated,
      defaultModel: this.defaultModel(),
      models: this.models(),
      managed: simulated || this.anthropicKeys().length > 0,
      connections: connections.map((c) => this.describe(c)),
    };
  }

  describe(connection: Connection): ConnectionInfo {
    return {
      id: connection.id,
      presetId: connection.presetId,
      label: connection.label,
      baseURL: connection.baseURL,
      keyHint: keyHint(connection.apiKey),
      source: connection.source,
      modelCount: this.optionsOf(connection).length,
      checkedAt: connection.checkedAt,
      listingError: connection.listingError,
      ...(connection.detail ? { detail: connection.detail } : {}),
      ...this.usageOf(connection),
    };
  }

  /** What Claude Code last said of the login's usage limits, in words, once it has run since the server started. */
  private usageOf(connection: Connection): { usage?: string } {
    const live = this.clients.get(connection.id)?.provider;
    const limits = live instanceof ClaudeCodeProvider ? live.limits() : null;
    if (!limits) return {};
    const window = limits.window === 'seven_day' ? 'weekly' : limits.window === 'five_hour' ? 'five-hour' : (limits.window ?? '').replace(/_/g, ' ');
    const used = limits.utilization === null ? '' : `${Math.round(limits.utilization * 100)}% of the plan’s ${window} limit was used when Claude Code last ran. `.replace('  ', ' ');
    const extra = limits.usingExtra
      ? 'The plan’s included usage is spent, and further usage is being billed as extra.'
      : limits.extraAllowed
        ? `Paid extra usage is switched on for this account${this.options.claudeCode?.extraUsage ? ', and this server is set to carry on into it' : ': an organisation pauses rather than start using it'}.`
        : '';
    const said = `${used}${extra}`.trim();
    return said ? { usage: said } : {};
  }

  presets(): PresetInfo[] {
    return PRESETS.map((p) => ({
      id: p.id,
      label: p.label,
      ...(p.family ? { family: p.family } : {}),
      kind: p.kind,
      regions: p.regions,
      keysUrl: p.keysUrl,
      ...(p.note ? { note: p.note } : {}),
      env: p.env,
      models:
        p.kind === 'anthropic'
          ? MODELS.map((m) => ({ id: m.id, label: m.label, tier: m.tier, inputPerMTok: m.input, outputPerMTok: m.output }))
          : p.models.map((m) => {
              const rates = ratesOn(m);
              return { id: m.id, label: m.label, tier: m.tier, inputPerMTok: rates.input, outputPerMTok: rates.output, ...(m.only ? { only: m.only } : {}), ...(m.note ? { note: m.note } : {}) };
            }),
      sources: p.sources,
    }));
  }

  /**
   * The model a new organisation starts on: on a Claude key if there is one and otherwise on the first key that
   * has any, the model the catalogue marks to start on, else the first it picks out, else the first there is.
   */
  defaultModel(): string {
    if (this.simulated) return DEFAULT_MODEL;
    // A Claude key comes first where there is one: its models are the ones everything here can be done with.
    // A Claude Code login comes last, whenever it was added: it is there to be chosen, and is never the default
    // while there is a key of any kind.
    const claude = this.plainAnthropic() ?? this.anthropicKeys()[0];
    const login = (c: Connection) => this.preset(c).kind === 'claude-code';
    const keys = this.store.list().filter((c) => !login(c));
    const order = [...(claude ? [claude, ...keys.filter((c) => c !== claude)] : keys), ...this.store.list().filter(login)];
    for (const connection of order) {
      const offered = this.optionsOf(connection);
      if (login(connection)) {
        // On a plan, the balanced model: an organisation on the strongest one would soon use up what the plan includes.
        const starter = offered.find((m) => m.id === this.refOf(connection, CLAUDE_CODE_STARTER)) ?? offered[0];
        if (starter) return starter.id;
        continue;
      }
      const starter = this.catalogueFor(connection).find((m) => m.starter && offered.some((o) => o.id === this.refOf(connection, m.id)));
      const pick = starter ? this.refOf(connection, starter.id) : (offered.find((m) => m.recommended) ?? offered[0])?.id;
      if (pick) return pick;
    }
    return DEFAULT_MODEL;
  }

  knows(ref: string): boolean {
    if (this.simulated) return true;
    return this.models().some((m) => m.id === ref);
  }

  hosts(executiveModel: string, workerModel: string): boolean {
    if (this.simulated) return true;
    const lead = this.connectionFor(executiveModel);
    const team = this.connectionFor(workerModel);
    // A session's lead and its agents are on one account.
    return !!lead && !!team && lead.id === team.id && this.preset(lead).kind === 'anthropic';
  }

  searches(model: string): boolean {
    if (this.simulated) return true;
    const connection = this.connectionFor(model);
    return !!connection && this.preset(connection).kind === 'anthropic';
  }

  // ---- sending calls where they belong ----

  private connectionFor(ref: string): Connection | undefined {
    const { connectionId } = parseRef(ref);
    return connectionId === null ? this.plainAnthropic() : this.store.get(connectionId);
  }

  private client(connection: Connection): Callable {
    // A provider is built once for a key and an address, and again only if either changes.
    const signature = `${connection.baseURL}|${connection.apiKey}`;
    const existing = this.clients.get(connection.id);
    if (existing?.signature === signature) return existing.provider;
    const preset = this.preset(connection);
    if (preset.kind === 'claude-code') {
      const provider = new ClaudeCodeProvider(this.claudeCode());
      this.clients.set(connection.id, { provider, signature });
      return provider;
    }
    // Looked up each time they are wanted, so that a price corrected by hand, or a fresh listing, counts from the next call.
    const current = () => this.store.get(connection.id) ?? connection;
    const options: CompatibleOptions = {
      label: connection.label,
      baseURL: connection.baseURL,
      apiKey: connection.apiKey,
      dialect: preset.dialect ?? PLAIN_DIALECT,
      priceOf: (model) => this.priceOf(current(), model),
      maxOutputOf: (model) => this.catalogueFor(current()).find((m) => m.id === model)?.maxOutput ?? current().models.find((m) => m.id === model)?.maxOutput,
      effortOf: (model) => this.effortsOf(current(), model),
      ...this.options.compatible,
    };
    const provider =
      preset.kind === 'anthropic'
        ? new ClaudeProvider({
            ...this.options.claude,
            ...this.stateFileFor(connection),
            ...(connection.apiKey ? { apiKey: connection.apiKey } : {}),
            // Always said outright: left unsaid, the client would take an address from the environment instead.
            baseURL: connection.baseURL,
            ...(connection.source === 'stored' ? { defaultHeaders: environmentHeadersCleared(connection.apiKey) } : {}),
          })
        : preset.kind === 'responses'
          ? new OpenAIResponsesProvider(options)
          : new OpenAICompatibleProvider(options);
    this.clients.set(connection.id, { provider, signature });
    return provider;
  }

  /** How Claude Code is to be run, or the reason it may not be, as an error that says so. */
  private claudeCode(): ClaudeCodeOptions {
    const options = this.options.claudeCode;
    if (!options) throw new ProviderError('This server was not started in a way that can run Claude Code.', 'auth', false);
    if (options.blocked) throw new ProviderError(options.blocked, 'auth', false);
    return options;
  }

  /**
   * Where the ids of a key's saved agents and environments for hosted sessions are kept. They belong to the
   * account the key is for, so each Anthropic key has a file of its own; the key called "anthropic" keeps the
   * file there has always been.
   */
  private stateFileFor(connection: Connection): { managedStateFile?: string } {
    const file = this.options.claude?.managedStateFile;
    return file ? { managedStateFile: stateFileOf(file, connection.id) } : {};
  }

  private resolve(ref: string): { provider: Callable; model: string } {
    const { connectionId, model } = parseRef(ref);
    const connection = this.connectionFor(ref);
    if (!connection) {
      if (connectionId && presetById(connectionId)?.kind === 'claude-code') {
        throw new ProviderError(`Claude Code is not connected, which the model "${ref}" needs. Connect it under Models and keys, or choose another model in this organisation's settings.`, 'auth', false);
      }
      const what = connectionId ? `the "${connectionId}" connection` : 'Anthropic';
      throw new ProviderError(
        `No API key is connected for ${what}, which the model "${ref}" needs. Add the key under Models and keys, or choose another model in this organisation's settings.`,
        'auth',
        false,
      );
    }
    return { provider: this.client(connection), model };
  }

  /** The request as the chosen provider takes it: its own id for the model, and spend reported under the name the organisation knows the model by. */
  private routed<R extends { model: string; onUsage?: (usage: CallUsage) => void }>(req: R): { provider: Callable; req: R } {
    const { provider, model } = this.resolve(req.model);
    const ref = req.model;
    // A request that another model ended up serving (Claude's fallback after a refusal) keeps that model's name.
    return { provider, req: { ...req, model, onUsage: (usage: CallUsage) => req.onUsage?.({ ...usage, model: usage.model === model ? ref : usage.model }) } };
  }

  async structured<T>(req: StructuredRequest<T>): Promise<T> {
    if (this.simulated) return this.mock.structured(req);
    const to = this.routed(req);
    return to.provider.structured(to.req);
  }

  async agent(req: AgentRequest): Promise<AgentResult> {
    if (this.simulated) return this.mock.agent(req);
    const to = this.routed(req);
    // Only Claude's own API has a web search this project uses. On any other provider the agent is not offered one.
    return to.provider.agent(to.provider instanceof ClaudeProvider ? to.req : { ...to.req, webSearch: null });
  }

  async executePlan(job: PlanJob): Promise<PlanOutcome> {
    if (this.simulated) return this.mock.executePlan(job);
    if (job.session) {
      // Picking a session up needs the account it lives on, not the models: those were fixed when it started,
      // and the organisation's may have changed since. The key the executives are on now is asked first.
      if (!this.anthropicKeys().length) {
        throw new ProviderError('This plan is being carried out in a hosted session, and no Anthropic key is connected to pick it up with. Add one under Models and keys.', 'auth', false);
      }
      const now = this.connectionFor(job.executiveModel);
      const owner = (await this.sessionOwner(job.session.id, now)) ?? (now && this.preset(now).kind === 'anthropic' ? now : this.anthropicKeys()[0]!);
      const provider = this.client(owner) as ClaudeProvider;
      return provider.executePlan({ ...job, executiveModel: parseRef(job.executiveModel).model, workerModel: parseRef(job.workerModel).model });
    }
    if (!this.hosts(job.executiveModel, job.workerModel)) {
      throw new ProviderError('Plans can be carried out in hosted sessions only when both the executives and the agents are on Claude models from one Anthropic key.', 'bad_request', false);
    }
    const lead = this.resolve(job.executiveModel);
    if (!(lead.provider instanceof ClaudeProvider)) throw new ProviderError('Hosted sessions need a Claude model.', 'bad_request', false);
    return lead.provider.executePlan({ ...job, executiveModel: lead.model, workerModel: parseRef(job.workerModel).model });
  }

  /**
   * The Anthropic key whose account a hosted session is on, or undefined if none of the keys connected knows
   * it. A session does not say which key made it, so each is asked, the likeliest first.
   */
  async sessionOwner(sessionId: string, first?: Connection): Promise<Connection | undefined> {
    const keys = this.anthropicKeys();
    const order = first && keys.includes(first) ? [first, ...keys.filter((c) => c !== first)] : keys;
    for (const connection of order) {
      if (await (this.client(connection) as ClaudeProvider).hasSession(sessionId).catch(() => false)) return connection;
    }
    return undefined;
  }

  /** The Claude provider a hosted session belongs to. Sessions do not say which key made them, so each Anthropic key is tried in turn. */
  private async onAnthropic<T>(work: (provider: ClaudeProvider) => Promise<T>, missing: (result: T) => boolean): Promise<T | undefined> {
    let last: T | undefined;
    for (const connection of this.anthropicKeys()) {
      last = await work(this.client(connection) as ClaudeProvider);
      if (!missing(last)) return last;
    }
    return last;
  }

  async agentDetail(sessionId: string, threadId: string): Promise<{ brief: string | null; report: string | null }> {
    if (this.simulated) return this.mock.agentDetail(sessionId, threadId);
    const found = await this.onAnthropic(
      (provider) => provider.agentDetail(sessionId, threadId).catch(() => ({ brief: null, report: null })),
      (detail) => !detail.brief && !detail.report,
    );
    return found ?? { brief: null, report: null };
  }

  async archiveSession(sessionId: string): Promise<'archived' | 'busy' | 'gone'> {
    if (this.simulated) return this.mock.archiveSession(sessionId);
    // With no Anthropic key there is nobody to ask. That is not the same as the session being gone.
    if (!this.anthropicKeys().length) throw new ProviderError('No Anthropic key is connected to archive this session with. Add one under Models and keys.', 'auth', false);
    return (await this.onAnthropic((provider) => provider.archiveSession(sessionId), (result) => result === 'gone')) ?? 'gone';
  }

  async holdSession(sessionId: string): Promise<{ budgetUsd: number; spentUsd: number } | null> {
    if (this.simulated) return this.mock.holdSession(sessionId);
    // With no Anthropic key there is nobody to ask. That is not the same as there being nothing to hold.
    if (!this.anthropicKeys().length) throw new ProviderError('No Anthropic key is connected to hold this session with. Add one under Models and keys.', 'auth', false);
    return (await this.onAnthropic((provider) => provider.holdSession(sessionId), (result) => result === null)) ?? null;
  }

  // ---- adding and looking after keys ----

  /** Add a key. The provider is asked what the key can call, which is also how a wrong key is found out. */
  async connect(input: NewConnection): Promise<Connection> {
    const preset = presetById(input.presetId);
    if (!preset) throw new ValidationError('Choose the provider the key is for.');
    if (preset.kind === 'claude-code') return this.connectClaudeCode(preset, input.label);
    const apiKey = (input.apiKey ?? '').trim();
    const baseURL = address(input.baseURL || preset.regions.find((r) => r.id === input.region)?.baseURL || preset.regions[0]!.baseURL);
    if (!baseURL) throw new ValidationError('Give the address of the endpoint, for example http://127.0.0.1:8080/v1.');
    if (!apiKey && preset.id !== 'custom') throw new ValidationError('Paste the API key.');
    if (apiKey.length > 500 || /\s/.test(apiKey)) throw new ValidationError('That does not look like an API key: it has spaces in it or is far too long.');
    const connection: Connection = {
      id: this.store.freeId(preset.id),
      presetId: preset.id,
      // An endpoint of the user's own has no name but its address.
      label: (input.label ?? '').trim().slice(0, 60) || (preset.id === 'custom' ? new URL(baseURL).host : preset.label),
      baseURL,
      apiKey,
      source: 'stored',
      addedAt: new Date().toISOString(),
      models: [],
      checkedAt: null,
      listingError: null,
      prices: {},
      extraModels: [],
    };
    await this.look(connection, true);
    // The provider was asked in the meantime, and another key for it may have been added while it answered.
    connection.id = this.store.freeId(preset.id);
    await this.store.add(connection);
    return connection;
  }

  /**
   * Connect the Claude Code on this machine. There is no key to keep: what is kept is that the person asked for
   * it, and what Claude Code said of itself. It is asked its version and whether it is signed in, neither of
   * which calls a model.
   */
  private async connectClaudeCode(preset: Preset, label?: string): Promise<Connection> {
    if (this.store.list().some((c) => this.preset(c).kind === 'claude-code')) {
      throw new ValidationError('Claude Code is already connected. There is one login on this machine, so there is one connection for it.');
    }
    const connection: Connection = {
      id: this.store.freeId(preset.id),
      presetId: preset.id,
      label: (label ?? '').trim().slice(0, 60) || preset.label,
      baseURL: '',
      apiKey: '',
      source: 'stored',
      addedAt: new Date().toISOString(),
      models: [],
      checkedAt: null,
      listingError: null,
      prices: {},
      extraModels: [],
    };
    await this.look(connection, true);
    if (this.store.list().some((c) => this.preset(c).kind === 'claude-code')) throw new ValidationError('Claude Code is already connected.');
    await this.store.add(connection);
    return connection;
  }

  /** Ask the provider again what a key can call. */
  async refresh(id: string): Promise<Connection> {
    const connection = this.store.get(id);
    if (!connection) throw new ValidationError('There is no such connection.');
    const looked: Connection = { ...connection };
    await this.look(looked, false);
    const updated = await this.store.update(id, (c) => {
      // The key may have been changed while the provider was answering for the old one. Its answer is then of no use.
      if (c.apiKey === looked.apiKey && c.baseURL === looked.baseURL) {
        Object.assign(c, { models: looked.models, checkedAt: looked.checkedAt, listingError: looked.listingError });
        if (looked.detail) c.detail = looked.detail;
        else delete c.detail;
      }
    });
    if (!updated) throw new ValidationError('There is no such connection.');
    return updated;
  }

  /**
   * Ask again about every key that has not been asked about lately: one that came from the environment and has
   * never been checked, or one whose list of models is a day old. For when the server starts. Never throws.
   */
  async refreshStale(maxAgeMs = 24 * 60 * 60 * 1000): Promise<void> {
    if (this.options.forceMock) return;
    await Promise.all(
      this.store.list().map(async (connection) => {
        // Claude Code is asked every time: it costs nothing, and whether it can be used may have changed with how
        // the server was started.
        const local = this.preset(connection).kind === 'claude-code';
        if (!local && connection.checkedAt && Date.now() - Date.parse(connection.checkedAt) < maxAgeMs) return;
        await this.refresh(connection.id).catch(() => {});
      }),
    );
  }

  /**
   * Fill in what a key can call. A provider that refuses the key is an error
   * when the key is being added. A provider that has no list of models, or
   * cannot be reached just now, is not: the catalogue's models are offered,
   * and the reason is kept to be shown.
   */
  private async look(connection: Connection, adding: boolean): Promise<void> {
    const preset = this.preset(connection);
    if (preset.kind === 'claude-code') {
      try {
        const options = this.claudeCode();
        connection.detail = describeStatus(await checkClaudeCode(options.command, options.env));
        connection.listingError = null;
      } catch (err) {
        // Not installed, too old, not signed in, or not allowed on this server: each says what to do about it.
        const message = err instanceof Error ? err.message : String(err);
        if (adding) throw new ValidationError(message);
        connection.listingError = message;
        // What it was found to be last time is no longer known to be so.
        delete connection.detail;
      }
      connection.models = [];
      connection.checkedAt = new Date().toISOString();
      return;
    }
    try {
      if (preset.kind === 'anthropic') {
        // Claude's models are the ones this project has prices for; the call is only to see that the key is good.
        const client = new Anthropic({
          ...(connection.apiKey ? { apiKey: connection.apiKey } : {}),
          baseURL: connection.baseURL,
          maxRetries: 1,
          ...(connection.source === 'stored' ? { defaultHeaders: environmentHeadersCleared(connection.apiKey) } : {}),
        });
        await client.models.list({ limit: 1 });
        connection.models = [];
      } else {
        const provider = new OpenAICompatibleProvider({ label: connection.label, baseURL: connection.baseURL, apiKey: connection.apiKey, dialect: preset.dialect, priceOf: () => null, maxRetries: 1 });
        connection.models = await provider.listModels();
      }
      connection.listingError = null;
    } catch (err) {
      const refused = err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError || (err instanceof ProviderError && err.code === 'auth');
      // What the provider said is shown to the user and kept on disk, so a key it quotes back is taken out.
      const message = scrub(plain(err), connection.apiKey);
      if (refused) {
        const said = `${connection.label} did not accept that key: ${message.replace(/^.*? rejected the (?:API key|credentials): /, '')}`;
        if (adding) throw new ValidationError(said);
        connection.listingError = said;
      } else if (preset.models.length || connection.extraModels.length || !adding) {
        // No list to be had. What was listed before is kept; failing that, the models the catalogue knows for this provider are offered.
        connection.listingError = connection.models.length
          ? `The list of models could not be read (${message}). The list from the last time it could is kept.`
          : `The list of models could not be read (${message}). The usual models for ${preset.label} are offered instead.`;
      } else {
        throw new ValidationError(`That endpoint could not be asked which models it serves. ${message}`);
      }
    }
    connection.checkedAt = new Date().toISOString();
  }

  /**
   * Change a connection's name or its key. A new key is checked, at the address the connection has, before it
   * is kept. The address itself cannot be changed: the key held for it would be sent wherever the new one
   * pointed. A key for another address is added as a connection of its own.
   */
  async update(id: string, patch: { label?: string; apiKey?: string }): Promise<Connection> {
    const connection = this.store.get(id);
    if (!connection) throw new ValidationError('There is no such connection.');
    if (connection.source === 'env' && patch.apiKey !== undefined) {
      throw new ValidationError('This key comes from the environment the server was started in. Change it there and restart.');
    }
    if (this.preset(connection).kind === 'claude-code' && patch.apiKey?.trim()) {
      throw new ValidationError('This connection has no key: it uses the login Claude Code has on this machine. To use a key, add it as a connection of its own.');
    }
    const next: Connection = { ...connection };
    if (patch.label !== undefined) next.label = patch.label.trim().slice(0, 60) || connection.label;
    if (patch.apiKey !== undefined && patch.apiKey.trim()) {
      const apiKey = patch.apiKey.trim();
      if (apiKey.length > 500 || /\s/.test(apiKey)) throw new ValidationError('That does not look like an API key: it has spaces in it or is far too long.');
      next.apiKey = apiKey;
    }
    if (next.apiKey !== connection.apiKey) await this.look(next, true);
    return (await this.store.update(id, (c) => Object.assign(c, next)))!;
  }

  /** Set, or with null clear, the price spend on one model is counted at. */
  async setPrice(id: string, model: string, price: Price | null): Promise<Connection> {
    const connection = this.store.get(id);
    if (!connection) throw new ValidationError('There is no such connection.');
    if (price && !(price.input >= 0 && price.output >= 0 && price.input <= 10_000 && price.output <= 10_000)) {
      throw new ValidationError('A price is a number of US dollars per million tokens, zero or more.');
    }
    return (await this.store.update(id, (c) => {
      if (price) c.prices[model] = { input: price.input, output: price.output, ...(price.cached !== undefined && price.cached >= 0 ? { cached: price.cached } : {}) };
      else delete c.prices[model];
    }))!;
  }

  /** Add a model id by hand, for a provider whose list does not have it. */
  async addModel(id: string, model: string): Promise<Connection> {
    const connection = this.store.get(id);
    if (!connection) throw new ValidationError('There is no such connection.');
    const name = model.trim();
    if (!name || /\s/.test(name) || !isModelRef(`${connection.id}:${name}`)) throw new ValidationError('Give the model id exactly as the provider’s API takes it.');
    return (await this.store.update(id, (c) => {
      if (!c.extraModels.includes(name)) c.extraModels.push(name);
    }))!;
  }

  async disconnect(id: string): Promise<void> {
    const connection = this.store.get(id);
    if (!connection) throw new ValidationError('There is no such connection.');
    if (connection.source === 'env') throw new ValidationError('This key comes from the environment the server was started in. Remove it there and restart.');
    await this.store.remove(id);
    const client = this.clients.get(id)?.provider;
    if (client instanceof ClaudeCodeProvider) client.close();
    this.clients.delete(id);
  }
}

/** The file one Anthropic key's hosted-session ids are kept in: the usual one for the key called "anthropic", one named after the key for any other. */
export function stateFileOf(file: string, connectionId: string): string {
  if (connectionId === 'anthropic') return file;
  return /\.json$/.test(file) ? file.replace(/\.json$/, `-${connectionId}.json`) : `${file}-${connectionId}`;
}

/**
 * Headers the Anthropic client would add from ANTHROPIC_CUSTOM_HEADERS, each set to be left out. They were written
 * for the key the environment gives and wherever that key goes, and a key added in the interface is another
 * account's, perhaps at another address. An Authorization among them would also go out in place of the key, which
 * the client sends as a bearer token, so there the key's own is said outright.
 */
function environmentHeadersCleared(apiKey: string): Record<string, string | null> {
  const cleared: Record<string, string | null> = {};
  for (const line of (process.env.ANTHROPIC_CUSTOM_HEADERS ?? '').split('\n')) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim();
    cleared[name] = apiKey && name.toLowerCase() === 'authorization' ? `Bearer ${apiKey}` : null;
  }
  return cleared;
}

/** What went wrong, in the provider's own words where it gave some, without the envelope they came in. */
function plain(err: unknown): string {
  if (err instanceof Anthropic.APIError) {
    const said = (err.error as { error?: { message?: unknown } } | undefined)?.error?.message;
    if (typeof said === 'string' && said) return `${err.status ?? ''} ${said}`.trim();
  }
  return err instanceof Error ? err.message : String(err);
}

