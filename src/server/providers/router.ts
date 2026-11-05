import Anthropic from '@anthropic-ai/sdk';
import type { ConnectionInfo, ModelOption, PresetInfo, ProviderInfo } from '../../shared/types';
import { ConnectionStore, address, keyHint, type Connection } from '../connections';
import { ValidationError } from '../engine/state';
import { PLAIN_DIALECT, PRESETS, presetById, ratesOn, type CatalogueModel, type Preset, type Price } from './catalogue';
import { ClaudeProvider, type ClaudeProviderOptions } from './claude';
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
// With no key connected at all, everything goes to the simulator.

export interface RouterOptions {
  /** Never call a real model, whatever keys there are. */
  forceMock?: boolean;
  mock?: MockOptions;
  /** Passed to each Claude provider: where the ids for hosted sessions are kept, and the workspace for Console links. */
  claude?: Pick<ClaudeProviderOptions, 'managedStateFile' | 'workspace' | 'sessionTimings' | 'turnRetryDelayMs'>;
  /** Passed to each OpenAI-compatible provider. For tests. */
  compatible?: { maxRetries?: number; turnRetryDelayMs?: number };
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

type Callable = ClaudeProvider | OpenAICompatibleProvider;

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

  /** True when no real model is called: because none is connected, or because the server was told to simulate. */
  get simulated(): boolean {
    return !!this.options.forceMock || this.store.list().length === 0;
  }

  // ---- which models there are ----

  private preset(connection: Connection): Preset {
    return presetById(connection.presetId) ?? presetById('custom')!;
  }

  private refOf(connection: Connection, model: string): string {
    return connection.id === this.firstAnthropic()?.id ? model : `${connection.id}:${model}`;
  }

  /**
   * The Anthropic key that plain Claude model names belong to: the one called "anthropic" if there is one, else
   * the first there is. Going by the name keeps an organisation on the key it was set up with when a second
   * Anthropic key appears, whichever order the two are listed in.
   */
  private firstAnthropic(): Connection | undefined {
    const all = this.store.list().filter((c) => this.preset(c).kind === 'anthropic');
    return all.find((c) => c.id === 'anthropic') ?? all[0];
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
    const own = connection.prices[model];
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
    if (preset.kind === 'anthropic') {
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
        hosted: true,
        web: true,
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
    return [...picks.map((m) => option(m.id, m)), ...others.map((id) => option(id))];
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
      label: simulated ? 'Simulation' : connections.map((c) => c.label).join(', '),
      simulated,
      defaultModel: this.defaultModel(),
      models: this.models(),
      managed: simulated || !!this.firstAnthropic(),
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
    };
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
    const plain = this.firstAnthropic();
    const order = plain ? [plain, ...this.store.list().filter((c) => c !== plain)] : this.store.list();
    for (const connection of order) {
      const offered = this.optionsOf(connection);
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
    return connectionId === null ? this.firstAnthropic() : this.store.get(connectionId);
  }

  private client(connection: Connection): Callable {
    // A provider is built once for a key and an address, and again only if either changes.
    const signature = `${connection.baseURL}|${connection.apiKey}`;
    const existing = this.clients.get(connection.id);
    if (existing?.signature === signature) return existing.provider;
    const preset = this.preset(connection);
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
            ...(connection.baseURL && connection.baseURL !== preset.regions[0]!.baseURL ? { baseURL: connection.baseURL } : {}),
          })
        : preset.kind === 'responses'
          ? new OpenAIResponsesProvider(options)
          : new OpenAICompatibleProvider(options);
    this.clients.set(connection.id, { provider, signature });
    return provider;
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
      // Picking a session up needs the account it lives on, not the models: those were fixed when it started.
      const connection = this.connectionFor(job.executiveModel) ?? this.firstAnthropic();
      const provider = connection && this.preset(connection).kind === 'anthropic' ? this.client(connection) : this.firstAnthropic() && this.client(this.firstAnthropic()!);
      if (!(provider instanceof ClaudeProvider)) {
        throw new ProviderError('This plan is being carried out in a hosted session, and no Anthropic key is connected to pick it up with. Add one under Models and keys.', 'auth', false);
      }
      return provider.executePlan({ ...job, executiveModel: parseRef(job.executiveModel).model, workerModel: parseRef(job.workerModel).model });
    }
    if (!this.hosts(job.executiveModel, job.workerModel)) {
      throw new ProviderError('Plans can be carried out in hosted sessions only when both the executives and the agents are on Claude models from one Anthropic key.', 'bad_request', false);
    }
    const lead = this.resolve(job.executiveModel);
    if (!(lead.provider instanceof ClaudeProvider)) throw new ProviderError('Hosted sessions need a Claude model.', 'bad_request', false);
    return lead.provider.executePlan({ ...job, executiveModel: lead.model, workerModel: parseRef(job.workerModel).model });
  }

  /** The Claude provider a hosted session belongs to. Sessions do not say which key made them, so each Anthropic key is tried in turn. */
  private async onAnthropic<T>(work: (provider: ClaudeProvider) => Promise<T>, missing: (result: T) => boolean): Promise<T | undefined> {
    let last: T | undefined;
    for (const connection of this.store.list()) {
      const provider = this.client(connection);
      if (!(provider instanceof ClaudeProvider)) continue;
      last = await work(provider);
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
    return (await this.onAnthropic((provider) => provider.archiveSession(sessionId), (result) => result === 'gone')) ?? 'gone';
  }

  // ---- adding and looking after keys ----

  /** Add a key. The provider is asked what the key can call, which is also how a wrong key is found out. */
  async connect(input: NewConnection): Promise<Connection> {
    const preset = presetById(input.presetId);
    if (!preset) throw new ValidationError('Choose the provider the key is for.');
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

  /** Ask the provider again what a key can call. */
  async refresh(id: string): Promise<Connection> {
    const connection = this.store.get(id);
    if (!connection) throw new ValidationError('There is no such connection.');
    const looked: Connection = { ...connection };
    await this.look(looked, false);
    return (await this.store.update(id, (c) => Object.assign(c, { models: looked.models, checkedAt: looked.checkedAt, listingError: looked.listingError })))!;
  }

  /**
   * Ask again about every key that has not been asked about lately: one that came from the environment and has
   * never been checked, or one whose list of models is a day old. For when the server starts. Never throws.
   */
  async refreshStale(maxAgeMs = 24 * 60 * 60 * 1000): Promise<void> {
    if (this.options.forceMock) return;
    await Promise.all(
      this.store.list().map(async (connection) => {
        if (connection.checkedAt && Date.now() - Date.parse(connection.checkedAt) < maxAgeMs) return;
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
    try {
      if (preset.kind === 'anthropic') {
        // Claude's models are the ones this project has prices for; the call is only to see that the key is good.
        const client = new Anthropic({ ...(connection.apiKey ? { apiKey: connection.apiKey } : {}), ...(connection.baseURL !== preset.regions[0]!.baseURL ? { baseURL: connection.baseURL } : {}), maxRetries: 1 });
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

  /** Change a connection's name, key or address. A new key or address is checked before it is kept. */
  async update(id: string, patch: { label?: string; apiKey?: string; baseURL?: string }): Promise<Connection> {
    const connection = this.store.get(id);
    if (!connection) throw new ValidationError('There is no such connection.');
    if (connection.source === 'env' && (patch.apiKey !== undefined || patch.baseURL !== undefined)) {
      throw new ValidationError('This key comes from the environment the server was started in. Change it there and restart.');
    }
    const next: Connection = { ...connection };
    if (patch.label !== undefined) next.label = patch.label.trim().slice(0, 60) || connection.label;
    if (patch.apiKey !== undefined && patch.apiKey.trim()) next.apiKey = patch.apiKey.trim();
    if (patch.baseURL !== undefined && patch.baseURL.trim()) next.baseURL = address(patch.baseURL);
    if (next.apiKey !== connection.apiKey || next.baseURL !== connection.baseURL) await this.look(next, true);
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
    if (!name || name.length > 200 || /\s/.test(name)) throw new ValidationError('Give the model id exactly as the provider’s API takes it.');
    return (await this.store.update(id, (c) => {
      if (!c.extraModels.includes(name)) c.extraModels.push(name);
    }))!;
  }

  async disconnect(id: string): Promise<void> {
    const connection = this.store.get(id);
    if (!connection) throw new ValidationError('There is no such connection.');
    if (connection.source === 'env') throw new ValidationError('This key comes from the environment the server was started in. Remove it there and restart.');
    await this.store.remove(id);
    this.clients.delete(id);
  }
}

/** The file one Anthropic key's hosted-session ids are kept in: the usual one for the key called "anthropic", one named after the key for any other. */
export function stateFileOf(file: string, connectionId: string): string {
  if (connectionId === 'anthropic') return file;
  return /\.json$/.test(file) ? file.replace(/\.json$/, `-${connectionId}.json`) : `${file}-${connectionId}`;
}

/** What went wrong, in the provider's own words where it gave some, without the envelope they came in. */
function plain(err: unknown): string {
  if (err instanceof Anthropic.APIError) {
    const said = (err.error as { error?: { message?: unknown } } | undefined)?.error?.message;
    if (typeof said === 'string' && said) return `${err.status ?? ''} ${said}`.trim();
  }
  return err instanceof Error ? err.message : String(err);
}

