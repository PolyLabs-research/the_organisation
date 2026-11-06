import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app';
import type { Config } from '../src/server/config';
import { ConnectionStore, baseUrlVariable } from '../src/server/connections';
import { PRESETS } from '../src/server/providers/catalogue';
import { MockProvider } from '../src/server/providers/mock';
import { ProviderRouter } from '../src/server/providers/router';
import type { AgentRequest, AgentResult } from '../src/server/providers/types';
import { Registry } from '../src/server/registry';
import { Store } from '../src/server/store';
import type { OrgView } from '../src/shared/types';
import { FakeOpenAI } from './fake-openai-api';
import { QUIET, harness, runToRest, type Harness } from './helpers';
import { followSchemas } from './schema-following';

// API keys from the outside in: the routes the interface adds and looks after them through, keys that come
// from the environment, and what an organisation does when its models are on a provider that cannot do
// everything Claude's can. The provider on the other end is a local stand-in.

const endpoint = new FakeOpenAI();
beforeAll(() => endpoint.start());
afterAll(() => endpoint.stop());

const SECRET = 'sk-live-do-not-leak-9876';

describe('the routes for keys', () => {
  let server: http.Server;
  let registry: Registry;
  let router: ProviderRouter;
  let base: string;
  let dir: string;

  beforeEach(async () => {
    endpoint.reset();
    endpoint.key = SECRET;
    endpoint.models = [{ id: 'model-a' }, { id: 'model-b', pricing: { prompt: '0.000001', completion: '0.000004' } }];
    dir = await mkdtemp(path.join(os.tmpdir(), 'the-organisation-keys-api-'));
    const store = new Store(dir);
    await store.init();
    const connections = new ConnectionStore(path.join(dir, 'connections.json'), {});
    await connections.load();
    router = new ProviderRouter(connections, { mock: QUIET, compatible: { maxRetries: 0, turnRetryDelayMs: 1 } });
    registry = new Registry(store, router, { retryDelayMs: 1, emitIntervalMs: 1 });
    const config: Config = { port: 0, host: '127.0.0.1', dataDir: dir, provider: 'auto', providerReason: 'test', production: false, workspace: 'default', anthropicAmbient: false, claudeCode: { command: 'claude', extraUsage: false, blocked: null } };
    server = createApp(registry, config, router).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await registry.shutdown();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });

  /** Every reply is kept as text too, so a test can check that a key is nowhere in anything the server said. */
  const said: string[] = [];
  beforeEach(() => {
    said.length = 0;
  });
  async function call<T = any>(method: string, url: string, body?: unknown): Promise<{ status: number; data: T }> {
    const res = await fetch(base + url, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    said.push(text);
    return { status: res.status, data: text ? JSON.parse(text) : (undefined as T) };
  }
  const connect = (apiKey = SECRET) => call('POST', '/api/connections', { presetId: 'custom', baseURL: endpoint.baseURL, apiKey, label: 'Stand-in' });
  const TEAM = [{ profileId: 'engineering', agentCount: 1 }];
  const IDEA = 'A subscription box that sends people a new houseplant every month.';

  it('says which providers a key can be added for, and simulates until one is', async () => {
    const { data } = await call('GET', '/api/meta');
    expect(data.provider).toMatchObject({ id: 'mock', simulated: true, connections: [] });
    expect(data.keys.forcedSimulation).toBe(false);
    const ids = data.keys.presets.map((p: any) => p.id);
    expect(ids).toEqual(PRESETS.map((p) => p.id));
    expect(ids).toContain('anthropic');
    expect(ids).toContain('custom');
    // Each says where its API is and where a person gets a key; none of the built-in ones is for Grok.
    for (const preset of data.keys.presets) {
      expect(preset.regions.length).toBeGreaterThan(0);
      expect(`${preset.id} ${preset.label} ${preset.family ?? ''}`).not.toMatch(/grok|xai|x\.ai/i);
    }
    expect((await call('GET', '/api/connections')).data).toMatchObject({ connections: [], provider: { simulated: true } });
  });

  it('takes a key, checks it with the provider, and never gives it back', async () => {
    const refused = await connect('sk-wrong-key-0000');
    expect(refused.status).toBe(400);
    expect(refused.data.error).toMatch(/did not accept that key/);
    expect((await call('GET', '/api/connections')).data.connections).toEqual([]);

    const added = await connect();
    expect(added.status).toBe(201);
    expect(added.data.connections).toEqual([
      { id: 'custom', presetId: 'custom', label: 'Stand-in', baseURL: endpoint.baseURL, keyHint: '…9876', source: 'stored', modelCount: 2, checkedAt: expect.any(String), listingError: null },
    ]);
    expect(added.data.provider).toMatchObject({ id: 'router', simulated: false, label: 'Stand-in', managed: false });
    expect(added.data.provider.models.map((m: any) => [m.id, m.priced])).toEqual([
      ['custom:model-a', false],
      ['custom:model-b', true],
    ]);

    // New organisations now start on one of the key's models.
    const meta = (await call('GET', '/api/meta')).data;
    expect(meta.provider.simulated).toBe(false);
    expect(meta.defaults).toMatchObject({ executiveModel: 'custom:model-a', workerModel: 'custom:model-a' });

    // A price, a model the listing does not have, another look, a new name: each answers with the whole picture.
    const priced = await call('PATCH', '/api/connections/custom', { price: { model: 'model-a', input: 1.5, output: 6 } });
    expect(priced.data.provider.models[0]).toMatchObject({ id: 'custom:model-a', priced: true, inputPerMTok: 1.5, outputPerMTok: 6 });
    const cleared = await call('PATCH', '/api/connections/custom', { price: { model: 'model-a', input: null } });
    expect(cleared.data.provider.models[0]).toMatchObject({ priced: false });
    expect((await call('PATCH', '/api/connections/custom', { price: { model: 'model-a', input: -1, output: 2 } })).status).toBe(400);
    const more = await call('PATCH', '/api/connections/custom', { addModel: 'model-secret', label: 'Renamed' });
    expect(more.data.provider.models.map((m: any) => m.id)).toContain('custom:model-secret');
    expect(more.data.connections[0].label).toBe('Renamed');
    endpoint.models.push({ id: 'model-c' });
    const again = await call('POST', '/api/connections/custom/refresh');
    expect(again.data.provider.models.map((m: any) => m.id)).toContain('custom:model-c');
    expect((await call('POST', '/api/connections/nope/refresh')).status).toBe(400);

    // A new key is tried before it replaces the old one.
    expect((await call('PATCH', '/api/connections/custom', { apiKey: 'sk-wrong-key-0000' })).status).toBe(400);
    endpoint.seen.length = 0;
    await call('POST', '/api/connections/custom/refresh');
    expect(endpoint.seen[0]!.headers.authorization).toBe(`Bearer ${SECRET}`);

    // The address a key is held for cannot be changed: that would send the key somewhere new.
    endpoint.seen.length = 0;
    const moved = await call('PATCH', '/api/connections/custom', { baseURL: 'http://127.0.0.1:9/v1' });
    expect(moved.status).toBe(400);
    expect(moved.data.error).toMatch(/address of a connection cannot be changed/);
    expect((await call('GET', '/api/connections')).data.connections[0].baseURL).toBe(endpoint.baseURL);
    expect(endpoint.seen).toHaveLength(0);

    // With the last key gone the server is short of a key. It does not go back to simulating.
    const removed = await call('DELETE', '/api/connections/custom');
    expect(removed.data).toMatchObject({ connections: [], provider: { simulated: false, label: 'No key connected', models: [] } });
    expect((await call('DELETE', '/api/connections/custom')).status).toBe(400);

    // Through all of that, neither key appeared in anything the server sent.
    expect(said.length).toBeGreaterThan(10);
    for (const text of said) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain('sk-wrong-key-0000');
    }
  });

  it('holds an organisation to models a connected key can call', async () => {
    await connect();
    const create = (settings: Record<string, unknown>) => call<OrgView & { error?: string }>('POST', '/api/orgs', { name: 'Fernery', idea: IDEA, executives: TEAM, settings: { maxCycles: 1, ...settings } });

    // Named or not, a new organisation's models are ones the key has.
    const plain = await create({});
    expect(plain.status).toBe(201);
    expect(plain.data.org.settings).toMatchObject({ executiveModel: 'custom:model-a', workerModel: 'custom:model-a' });
    const chosen = await create({ executiveModel: 'custom:model-b', workerModel: 'custom:model-a' });
    expect(chosen.data.org.settings).toMatchObject({ executiveModel: 'custom:model-b', workerModel: 'custom:model-a' });

    // A Claude model with no Anthropic key, and a model on a connection that does not exist, are both refused by name.
    const claude = await create({ executiveModel: 'claude-opus-5-5' });
    expect(claude.status).toBe(400);
    expect(claude.data.error).toMatch(/model chosen for the executives, "claude-opus-5-5", is not one a connected key can call/);
    const nowhere = await create({ workerModel: 'openai:gpt-9' });
    expect(nowhere.status).toBe(400);
    expect(nowhere.data.error).toMatch(/model chosen for the agents, "openai:gpt-9"/);

    // The same when settings are changed later.
    const id = plain.data.org.id;
    const bad = await call('PATCH', `/api/orgs/${id}/settings`, { workerModel: 'custom:model-z' });
    expect(bad.status).toBe(400);
    expect(bad.data.error).toMatch(/"custom:model-z", is not one a connected key can call/);
    const good = await call<OrgView>('PATCH', `/api/orgs/${id}/settings`, { workerModel: 'custom:model-b' });
    expect(good.data.org.settings.workerModel).toBe('custom:model-b');

    // With its key gone, an organisation can still have its other settings changed: only a model that is being
    // changed is checked. Its next call says which key it needs. (A second key keeps the server out of simulation.)
    await call('POST', '/api/connections', { presetId: 'custom', baseURL: endpoint.baseURL, apiKey: SECRET, label: 'Second' });
    await call('DELETE', '/api/connections/custom');
    expect(router.info().connections!.map((c) => c.id)).toEqual(['custom-2']);
    const budget = await call<OrgView>('PATCH', `/api/orgs/${id}/settings`, { budgetUsd: 9 });
    expect(budget.status).toBe(200);
    expect(budget.data.org.settings).toMatchObject({ budgetUsd: 9, executiveModel: 'custom:model-a', workerModel: 'custom:model-b' });
    await call('POST', `/api/orgs/${id}/start`);
    const runner = registry.get(id)!;
    await runner.idle();
    expect(runner.org.status).toBe('paused');
    expect(runner.org.lastError).toMatch(/No API key is connected for the "custom" connection/);
  });

  it('keeps a model under whatever name its key lists it by', async () => {
    // A server of the user's own can call its models anything.
    endpoint.models = [{ id: 'My Model (Q4)' }, { id: 'model=b' }, { id: 'x'.repeat(250) }];
    await connect();
    const offered = (await call('GET', '/api/connections')).data.provider.models.map((m: any) => m.id);
    // What cannot be kept in an organisation's settings is not offered for them.
    expect(offered).toEqual(['custom:model=b', 'custom:My Model (Q4)']);
    const made = await call<OrgView>('POST', '/api/orgs', { name: 'Fernery', idea: IDEA, executives: TEAM, settings: { executiveModel: 'custom:My Model (Q4)', workerModel: 'custom:model=b' } });
    expect(made.status).toBe(201);
    // Not quietly swapped for the default, which is what a name the settings would not hold used to become.
    expect(made.data.org.settings).toMatchObject({ executiveModel: 'custom:My Model (Q4)', workerModel: 'custom:model=b' });
    const changed = await call<OrgView>('PATCH', `/api/orgs/${made.data.org.id}/settings`, { workerModel: 'custom:My Model (Q4)' });
    expect(changed.data.org.settings.workerModel).toBe('custom:My Model (Q4)');
    expect((await call('PATCH', `/api/orgs/${made.data.org.id}/settings`, { workerModel: '' })).status).toBe(400);
    expect((await call('POST', '/api/orgs', { name: 'Fernery', idea: IDEA, executives: TEAM, settings: { executiveModel: 42 } })).status).toBe(400);
  });

  it('has a team recommended by the model new organisations start on, or by one that is named', async () => {
    await connect();
    followSchemas(endpoint);
    const idea = 'A subscription box that sends people a new houseplant every month, with care instructions.';
    expect((await call('POST', '/api/recommend', { idea })).status).toBe(200);
    expect(endpoint.chats.at(-1).model).toBe('model-a');
    expect((await call('POST', '/api/recommend', { idea, model: 'custom:model-b' })).status).toBe(200);
    expect(endpoint.chats.at(-1).model).toBe('model-b');
    // A model no key can call is refused before anything is spent on it.
    const before = endpoint.chats.length;
    const refused = await call('POST', '/api/recommend', { idea, model: 'openai:gpt-9' });
    expect(refused.status).toBe(400);
    expect(refused.data.error).toMatch(/"openai:gpt-9" is not one a connected key can call/);
    expect(endpoint.chats).toHaveLength(before);
  });

  it('answers for a server that keeps no keys', async () => {
    // The same app without a router, as the tests of the rest of the API run it.
    const bare = createApp(registry, { port: 0, host: '127.0.0.1', dataDir: dir, provider: 'mock', providerReason: 'test', production: false, workspace: 'default', anthropicAmbient: false, claudeCode: { command: 'claude', extraUsage: false, blocked: null } }).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => bare.once('listening', resolve));
    try {
      const at = `http://127.0.0.1:${(bare.address() as AddressInfo).port}`;
      expect((await (await fetch(`${at}/api/meta`)).json()).keys).toBeNull();
      expect((await fetch(`${at}/api/connections`)).status).toBe(404);
    } finally {
      bare.closeAllConnections();
      await new Promise<void>((resolve) => bare.close(() => resolve()));
    }
  });
});

describe('keys from the environment', () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    endpoint.reset();
    dir = await mkdtemp(path.join(os.tmpdir(), 'the-organisation-keys-env-'));
    file = path.join(dir, 'connections.json');
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const withEnv = async (env: NodeJS.ProcessEnv, ambient = false) => {
    const store = new ConnectionStore(file, env, ambient);
    await store.load();
    return { store, router: new ProviderRouter(store, { mock: QUIET, compatible: { maxRetries: 0 } }) };
  };
  /** A provider other than Anthropic that takes its key from the environment, whichever the catalogue lists first. */
  const other = PRESETS.find((p) => p.kind === 'openai' && p.env.length)!;

  it('are connections like any other, except that the key is never written down and cannot be changed from here', async () => {
    const { router, store } = await withEnv({ ANTHROPIC_API_KEY: ' sk-ant-from-env-1234 ' });
    expect(store.list()).toMatchObject([{ id: 'anthropic', presetId: 'anthropic', source: 'env', apiKey: 'sk-ant-from-env-1234', baseURL: 'https://api.anthropic.com' }]);
    const info = router.info();
    expect(info).toMatchObject({ simulated: false, managed: true, defaultModel: 'claude-opus-5-5' });
    expect(info.connections).toMatchObject([{ id: 'anthropic', source: 'env', keyHint: '…1234' }]);
    // Claude models on the first Anthropic key keep their plain names, as organisations had them before there were other providers.
    expect(info.models.map((m) => m.id)).toEqual(['claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
    expect(info.models.every((m) => m.hosted && m.web && m.priced)).toBe(true);
    expect(router.hosts('claude-opus-5-5', 'claude-haiku-5-5')).toBe(true);

    await expect(router.disconnect('anthropic')).rejects.toThrow(/comes from the environment/);
    await expect(router.update('anthropic', { apiKey: 'sk-other' })).rejects.toThrow(/comes from the environment/);
    // What is learned about it is remembered, without the key.
    await router.update('anthropic', { label: 'Work account' });
    await router.addModel('anthropic', 'claude-next');
    const onDisk = await readFile(file, 'utf8');
    expect(onDisk).not.toContain('sk-ant-from-env');
    expect(JSON.parse(onDisk)).toMatchObject({ connections: [], environment: { anthropic: { extraModels: ['claude-next'] } } });
  });

  it('stand beside a key added by hand for the same provider', async () => {
    // Adding a key through the router would ask Anthropic about it, so this one goes straight into the store.
    const first = await withEnv({});
    await first.store.add({ id: 'anthropic', presetId: 'anthropic', label: 'Mine', baseURL: 'https://api.anthropic.com', apiKey: 'sk-ant-stored-0001', source: 'stored', addedAt: new Date().toISOString(), models: [], checkedAt: null, listingError: null, prices: {}, extraModels: [] });
    const { store, router } = await withEnv({ ANTHROPIC_API_KEY: 'sk-ant-from-env-1234' });
    expect(store.list().map((c) => [c.id, c.source])).toEqual([
      ['anthropic-env', 'env'],
      ['anthropic', 'stored'],
    ]);
    // Plain names stay with the key called "anthropic", the one organisations were set up on, though the key
    // from the environment is listed first. The other's models say which key they are on.
    expect(router.info().models.map((m) => m.id).filter((id) => id.includes('opus'))).toEqual(['anthropic-env:claude-opus-5-5', 'claude-opus-5-5']);
    expect(router.hosts('claude-opus-5-5', 'anthropic-env:claude-opus-5-5')).toBe(false);
    expect(router.hosts('anthropic-env:claude-opus-5-5', 'anthropic-env:claude-haiku-5-5')).toBe(true);
    expect(router.defaultModel()).toBe('claude-opus-5-5');
  });

  it('are read for every provider that names a variable, at the address the environment gives if it gives one', async () => {
    const name = other.env[0]!;
    const plain = await withEnv({ [name]: 'sk-env-key-5678' });
    expect(plain.store.list()).toMatchObject([{ id: other.id, source: 'env', baseURL: other.regions[0]!.baseURL, apiKey: 'sk-env-key-5678' }]);
    // Before the provider has been asked, the models on offer are the ones the catalogue picks out for it.
    expect(plain.router.info().models.map((m) => m.id)).toEqual(other.models.filter((m) => !m.only || m.only.includes(other.regions[0]!.id)).map((m) => `${other.id}:${m.id}`));

    const moved = await withEnv({ [name]: 'sk-env-key-5678', [baseUrlVariable(other.id)]: `${endpoint.baseURL}/` });
    expect(moved.store.list()[0]!.baseURL).toBe(endpoint.baseURL);
    const junk = await withEnv({ [name]: 'sk-env-key-5678', [baseUrlVariable(other.id)]: 'not an address' });
    expect(junk.store.list()[0]!.baseURL).toBe(other.regions[0]!.baseURL);

    // Asked in the background when the server starts, a key from the environment learns what it can really call.
    endpoint.models = [{ id: 'model-x' }, { id: other.models[0]!.id }];
    await moved.router.refreshStale();
    const offered = moved.router.info().models.map((m) => m.id);
    expect(offered).toContain(`${other.id}:model-x`);
    expect(offered[0]).toBe(`${other.id}:${other.models[0]!.id}`);
    expect(moved.router.info().connections![0]).toMatchObject({ listingError: null, checkedAt: expect.any(String) });
    // Asked lately, it is not asked again.
    endpoint.seen.length = 0;
    await moved.router.refreshStale();
    expect(endpoint.seen).toHaveLength(0);
    expect(JSON.stringify(await readFile(file, 'utf8'))).not.toContain('sk-env-key');
  });

  it('include Anthropic credentials found some other way than a key', async () => {
    const { store, router } = await withEnv({}, true);
    expect(store.list()).toMatchObject([{ id: 'anthropic', source: 'env', apiKey: '' }]);
    expect(router.info()).toMatchObject({ simulated: false, managed: true });
    expect(router.info().connections![0]!.keyHint).toBe('');
  });

  it('keeps going, and says why, when a provider cannot be asked what a key can call', async () => {
    const name = other.env[0]!;
    endpoint.modelsStatus = 404;
    const { router } = await withEnv({ [name]: 'sk-env-key-5678', [baseUrlVariable(other.id)]: endpoint.baseURL });
    await router.refreshStale();
    const [connection] = router.info().connections!;
    expect(connection!.listingError).toMatch(/list of models could not be read/);
    // The catalogue's models for the provider are still on offer.
    expect(router.info().models.length).toBeGreaterThan(0);
    expect(router.knows(`${other.id}:${other.models[0]!.id}`)).toBe(true);
  });
});

describe('an organisation on models that are not Claude’s', () => {
  /** The simulator, standing in for a provider that has no hosted sessions and no web search. */
  class Elsewhere extends MockProvider {
    readonly agents: AgentRequest[] = [];
    constructor() {
      super({ ...QUIET });
    }
    hosts(): boolean {
      return false;
    }
    searches(): boolean {
      return false;
    }
    override agent(req: AgentRequest): Promise<AgentResult> {
      this.agents.push(req);
      return super.agent(req);
    }
  }
  let h: Harness;
  afterEach(() => h?.cleanup());

  it('carries its plans out on this machine, even when set to hosted sessions', async () => {
    const provider = new Elsewhere();
    h = await harness({ provider, executives: [{ profileId: 'engineering', agentCount: 2 }], settings: { execution: 'managed' } });
    await runToRest(h.runner);
    expect(h.org.lastError).toBeNull();
    expect(h.org.plans.length).toBeGreaterThan(0);
    for (const plan of h.org.plans) {
      expect(plan.status).toBe('done');
      expect(plan.execution).toBe('local');
      expect(plan.managed).toBeNull();
    }
    // The work was done by agents called one at a time, not in a session.
    expect(provider.agents.length).toBeGreaterThan(0);
    expect(h.org.reports.length).toBe(h.org.plans.length);
  });

  it('does not offer its agents a web search, or tell them they have one', async () => {
    const provider = new Elsewhere();
    h = await harness({ provider, executives: [{ profileId: 'engineering', agentCount: 1 }], settings: { webResearch: true } });
    await runToRest(h.runner);
    expect(provider.agents.length).toBeGreaterThan(0);
    for (const req of provider.agents) {
      expect(req.webSearch).toBeNull();
      expect(req.system.role).toContain('You cannot run code or browse arbitrary websites.');
      expect(req.system.role).not.toContain('You can search the web');
    }
  });

  it('does offer one where the provider has it', async () => {
    class Searching extends Elsewhere {
      override searches(): boolean {
        return true;
      }
    }
    const provider = new Searching();
    h = await harness({ provider, executives: [{ profileId: 'engineering', agentCount: 1 }], settings: { webResearch: true } });
    await runToRest(h.runner);
    expect(provider.agents[0]!.webSearch).toEqual({ perRequest: 3, perTask: expect.any(Number) });
    expect(provider.agents[0]!.system.role).toContain('You can search the web');
  });
});
