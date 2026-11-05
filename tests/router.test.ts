import http from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ConnectionStore, keyHint } from '../src/server/connections';
import { ValidationError } from '../src/server/engine/state';
import { UNKNOWN_PRICE } from '../src/server/providers/openai-compatible';
import { ProviderRouter, parseRef, stateFileOf } from '../src/server/providers/router';
import { ProviderError, type CallUsage } from '../src/server/providers/types';
import { FakeOpenAI } from './fake-openai-api';

// The router that sends each call to the provider its model is on, and the
// store of API keys behind it, against a local stand-in endpoint.

const api = new FakeOpenAI();
let dir: string;
let file: string;

beforeAll(() => api.start());
afterAll(() => api.stop());
beforeEach(async () => {
  api.reset();
  api.models = [{ id: 'model-a' }, { id: 'model-b' }, { id: 'text-embedding-9' }];
  dir = await mkdtemp(path.join(os.tmpdir(), 'the-organisation-keys-'));
  file = path.join(dir, 'connections.json');
});
afterEach(() => rm(dir, { recursive: true, force: true }));

async function setup(env: NodeJS.ProcessEnv = {}, options: ConstructorParameters<typeof ProviderRouter>[1] = {}) {
  const store = new ConnectionStore(file, env);
  await store.load();
  const router = new ProviderRouter(store, { compatible: { maxRetries: 0, turnRetryDelayMs: 1 }, mock: { delayMs: 0 }, ...options });
  return { store, router };
}

const SYSTEM = { charter: 'Charter.', role: 'Role.' };
const Answer = z.object({ ok: z.boolean() });
const ask = (router: ProviderRouter, model: string, onUsage?: (u: CallUsage) => void) =>
  router.structured({ kind: 'consult', system: SYSTEM, prompt: 'Well?', schema: Answer, model, effort: 'medium', onUsage, context: {} });

describe('with no key connected', () => {
  it('simulates, and offers the models an organisation can try the loop on', async () => {
    const { router } = await setup();
    const info = router.info();
    expect(info).toMatchObject({ id: 'mock', simulated: true, managed: true, defaultModel: 'claude-opus-5-5', connections: [] });
    expect(info.models.map((m) => m.id)).toContain('claude-opus-5-5');
    expect(router.knows('anything-at-all')).toBe(true);
    expect(router.hosts('claude-opus-5-5', 'claude-opus-5-5')).toBe(true);
    // No endpoint is called.
    await router.agent({ kind: 'task', system: SYSTEM, prompt: 'x', model: 'claude-opus-5-5', effort: 'low', tools: [], webSearch: null, maxTurns: 1, shouldWrapUp: () => true, context: {} });
    expect(api.seen).toHaveLength(0);
  });

  it('keeps simulating when told to, whatever keys there are', async () => {
    const { router } = await setup({}, { forceMock: true });
    await router.connect({ presetId: 'custom', baseURL: api.baseURL, apiKey: 'sk-test' });
    expect(router.info().simulated).toBe(true);
  });
});

describe('adding a key', () => {
  it('asks the provider what the key can call, keeps the key to itself, and stops simulating', async () => {
    api.key = 'sk-secret-1234';
    const { router } = await setup();
    const connection = await router.connect({ presetId: 'custom', baseURL: `${api.baseURL}/`, apiKey: ' sk-secret-1234 ', label: 'My server' });

    expect(connection).toMatchObject({ id: 'custom', label: 'My server', baseURL: api.baseURL, source: 'stored', listingError: null });
    const info = router.info();
    expect(info).toMatchObject({ id: 'router', simulated: false, label: 'My server', managed: false });
    expect(info.connections).toEqual([
      { id: 'custom', presetId: 'custom', label: 'My server', baseURL: api.baseURL, keyHint: '…1234', source: 'stored', modelCount: 2, checkedAt: expect.any(String), listingError: null },
    ]);
    // Chat models only, each named by the connection it is on.
    expect(info.models.map((m) => m.id)).toEqual(['custom:model-a', 'custom:model-b']);
    expect(info.models[0]).toMatchObject({ provider: 'My server', priced: false, inputPerMTok: UNKNOWN_PRICE.input, outputPerMTok: UNKNOWN_PRICE.output, hosted: false, web: false });
    expect(info.defaultModel).toBe('custom:model-a');
    expect(JSON.stringify(info)).not.toContain('sk-secret');

    // On disk, where only this user can read it.
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, 'utf8')).connections[0].apiKey).toBe('sk-secret-1234');
  });

  it('refuses a key the provider does not accept, and keeps nothing', async () => {
    api.key = 'sk-right';
    const { router, store } = await setup();
    const failure = await router.connect({ presetId: 'custom', baseURL: api.baseURL, apiKey: 'sk-wrong' }).catch((e) => e);
    expect(failure).toBeInstanceOf(ValidationError);
    expect(failure.message).toMatch(/did not accept that key/);
    // The refusal is shown to the person who typed the key, without the key in it.
    expect(failure.message).not.toContain('sk-wrong');
    expect(store.list()).toEqual([]);
    expect(router.info().simulated).toBe(true);
  });

  it('refuses what is plainly not a key or an address', async () => {
    const { router } = await setup();
    await expect(router.connect({ presetId: 'nope', apiKey: 'x' })).rejects.toThrow(/Choose the provider/);
    await expect(router.connect({ presetId: 'custom', baseURL: 'not a url', apiKey: 'x' })).rejects.toThrow(/address of the endpoint/);
    await expect(router.connect({ presetId: 'custom', baseURL: 'ftp://example.com', apiKey: 'x' })).rejects.toThrow(/address of the endpoint/);
    await expect(router.connect({ presetId: 'custom', baseURL: api.baseURL, apiKey: 'two words' })).rejects.toThrow(/does not look like an API key/);
  });

  it('takes a server that needs no key, such as one on this machine', async () => {
    const { router } = await setup();
    const connection = await router.connect({ presetId: 'custom', baseURL: api.baseURL });
    expect(connection.apiKey).toBe('');
    expect(router.info().connections![0]!.keyHint).toBe('');
  });

  it('will not take an endpoint it cannot ask for its models when it knows none for it', async () => {
    api.modelsStatus = 404;
    const { router } = await setup();
    await expect(router.connect({ presetId: 'custom', baseURL: api.baseURL, apiKey: 'sk-test' })).rejects.toThrow(/could not be asked which models it serves/);
  });

  it('gives two keys added at the same moment names of their own', async () => {
    const { router } = await setup();
    const [one, two] = await Promise.all([
      router.connect({ presetId: 'custom', baseURL: api.baseURL, apiKey: 'sk-one', label: 'One' }),
      router.connect({ presetId: 'custom', baseURL: api.baseURL, apiKey: 'sk-two', label: 'Two' }),
    ]);
    expect([one.id, two.id].sort()).toEqual(['custom', 'custom-2']);
    expect(router.info().connections!.map((c) => c.label).sort()).toEqual(['One', 'Two']);
  });

  it('gives a second key for the same provider a name of its own', async () => {
    const { router } = await setup();
    await router.connect({ presetId: 'custom', baseURL: api.baseURL, apiKey: 'sk-one' });
    const second = await router.connect({ presetId: 'custom', baseURL: api.baseURL, apiKey: 'sk-two' });
    expect(second.id).toBe('custom-2');
    expect(router.info().models.map((m) => m.id)).toEqual(['custom:model-a', 'custom:model-b', 'custom-2:model-a', 'custom-2:model-b']);
  });
});

describe('adding an Anthropic key', () => {
  // The one thing asked of Anthropic when a key is added: its list of models, which only a good key gets.
  let anthropic: http.Server;
  let address: string;
  const seen: http.IncomingHttpHeaders[] = [];
  beforeAll(async () => {
    anthropic = http.createServer((req, res) => {
      seen.push(req.headers);
      // The client sends the key as a bearer token; older ones sent it in a header of its own.
      const key = String(req.headers['x-api-key'] ?? '') || String(req.headers.authorization ?? '').replace(/^Bearer /, '');
      if (!req.url?.startsWith('/v1/models')) return void res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'Not found' } }));
      if (key !== 'sk-ant-good-key-7777') {
        // The refusal quotes the key that was offered.
        return void res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key: ${key}` } }));
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({ data: [{ id: 'claude-opus-5-5', type: 'model', display_name: 'Claude Opus 5.5', created_at: '2026-06-01T00:00:00Z' }], has_more: false, first_id: 'claude-opus-5-5', last_id: 'claude-opus-5-5' }),
      );
    });
    await new Promise<void>((resolve) => anthropic.listen(0, '127.0.0.1', resolve));
    address = `http://127.0.0.1:${(anthropic.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    anthropic.closeAllConnections();
    await new Promise<void>((resolve) => anthropic.close(() => resolve()));
  });
  beforeEach(() => {
    seen.length = 0;
  });

  it('checks the key with Anthropic before keeping it, and says why in Anthropic\'s words when it is refused', async () => {
    const { router, store } = await setup();
    const failure = await router.connect({ presetId: 'anthropic', apiKey: 'sk-ant-wrong-key-0000', baseURL: address }).catch((e) => e);
    expect(failure).toBeInstanceOf(ValidationError);
    // What Anthropic said, without the envelope it came in and without the key it quoted.
    expect(failure.message).toBe('Anthropic did not accept that key: 401 invalid x-api-key: [the key]');
    expect(store.list()).toEqual([]);
    expect(router.info().simulated).toBe(true);
  });

  it('offers Claude\'s models under their plain names, with hosted sessions and web search, once the key is good', async () => {
    const { router } = await setup();
    const connection = await router.connect({ presetId: 'anthropic', apiKey: 'sk-ant-good-key-7777', baseURL: address });
    expect(connection).toMatchObject({ id: 'anthropic', label: 'Anthropic', listingError: null });
    expect(seen.at(-1)!.authorization ?? seen.at(-1)!['x-api-key']).toContain('sk-ant-good-key-7777');
    const info = router.info();
    expect(info).toMatchObject({ simulated: false, managed: true, defaultModel: 'claude-opus-5-5', label: 'Anthropic' });
    expect(info.models.map((m) => [m.id, m.tier, m.hosted, m.web, m.priced])).toEqual([
      ['claude-opus-5-5', 'flagship', true, true, true],
      ['claude-fable-5-1', 'flagship', true, true, true],
      ['claude-sonnet-5-5', 'balanced', true, true, true],
      ['claude-haiku-5-5', 'fast', true, true, true],
    ]);
    expect(router.hosts('claude-opus-5-5', 'claude-haiku-5-5')).toBe(true);
    expect(router.searches('claude-haiku-5-5')).toBe(true);
    expect(router.knows('claude-sonnet-5-5')).toBe(true);
    expect(JSON.stringify(info)).not.toContain('sk-ant-good');

    // Beside another maker's key, hosted sessions are for the pair of Claude models only.
    await router.connect({ presetId: 'custom', baseURL: api.baseURL, apiKey: 'sk-test' });
    expect(router.hosts('claude-opus-5-5', 'custom:model-a')).toBe(false);
    expect(router.hosts('custom:model-a', 'claude-opus-5-5')).toBe(false);
    expect(router.info().managed).toBe(true);
    // A new organisation starts on Claude where there is a Claude key, whatever other keys there are.
    expect(router.defaultModel()).toBe('claude-opus-5-5');
    // A second Anthropic key's models say which key they are on, and a session's two models must share a key.
    const second = await router.connect({ presetId: 'anthropic', apiKey: 'sk-ant-good-key-7777', baseURL: address, label: 'Work' });
    expect(second.id).toBe('anthropic-2');
    expect(router.knows('anthropic-2:claude-opus-5-5')).toBe(true);
    expect(router.hosts('anthropic-2:claude-opus-5-5', 'anthropic-2:claude-haiku-5-5')).toBe(true);
    expect(router.hosts('claude-opus-5-5', 'anthropic-2:claude-haiku-5-5')).toBe(false);
  });
});

describe('calling a model', () => {
  it('sends the call to the connection the model names, under the provider\'s own id for it', async () => {
    const { router } = await setup();
    await router.connect({ presetId: 'custom', baseURL: api.baseURL, apiKey: 'sk-test' });
    api.replies = [{ content: '{"ok":true}', usage: { prompt_tokens: 100, completion_tokens: 10 } }];
    const usage: CallUsage[] = [];
    expect(await ask(router, 'custom:model-a', (u) => usage.push(u))).toEqual({ ok: true });
    expect(api.chats[0].model).toBe('model-a');
    // Spend is reported under the name the organisation knows the model by.
    expect(usage[0]).toMatchObject({ model: 'custom:model-a', inputTokens: 100, outputTokens: 10 });
  });

  it('says which key is missing when a model\'s connection is not there', async () => {
    const { router } = await setup();
    await router.connect({ presetId: 'custom', baseURL: api.baseURL, apiKey: 'sk-test' });
    const gone = await ask(router, 'openai:gpt-9').catch((e) => e);
    expect(gone).toBeInstanceOf(ProviderError);
    expect(gone).toMatchObject({ code: 'auth', retryable: false });
    expect(gone.message).toMatch(/No API key is connected for the "openai" connection/);
    // A bare id is a Claude model, and there is no Anthropic key here.
    expect((await ask(router, 'claude-opus-5-5').catch((e) => e)).message).toMatch(/No API key is connected for Anthropic/);
    expect(router.knows('custom:model-a')).toBe(true);
    expect(router.knows('custom:model-z')).toBe(false);
    expect(router.knows('claude-opus-5-5')).toBe(false);
  });

  it('offers hosted sessions and web search only on Claude', async () => {
    const { router } = await setup();
    await router.connect({ presetId: 'custom', baseURL: api.baseURL, apiKey: 'sk-test' });
    expect(router.hosts('custom:model-a', 'custom:model-a')).toBe(false);
    expect(router.searches('custom:model-a')).toBe(false);
    // An agent on another provider is never offered a web search, even if the organisation has it switched on.
    api.replies = [{ content: 'Done.' }];
    await router.agent({ kind: 'task', system: SYSTEM, prompt: 'x', model: 'custom:model-a', effort: 'low', tools: [], webSearch: { perRequest: 3, perTask: 8 }, maxTurns: 2, context: {} });
    expect(JSON.stringify(api.chats[0])).not.toContain('web_search');
    await expect(router.executePlan({ executiveModel: 'custom:model-a', workerModel: 'custom:model-a', session: null } as never)).rejects.toThrow(/only when both the executives and the agents are on Claude/);
  });

  it('counts spend at a price set by hand from the next call on, and at a stand-in price until then', async () => {
    const { router } = await setup();
    await router.connect({ presetId: 'custom', baseURL: api.baseURL, apiKey: 'sk-test' });
    const usage: CallUsage[] = [];
    const reply = { content: '{"ok":true}', usage: { prompt_tokens: 1_000_000, completion_tokens: 100_000 } };
    api.replies = [reply, reply, reply];
    await ask(router, 'custom:model-a', (u) => usage.push(u));
    await router.setPrice('custom', 'model-a', { input: 0.5, output: 2 });
    await ask(router, 'custom:model-a', (u) => usage.push(u));
    await router.setPrice('custom', 'model-a', null);
    await ask(router, 'custom:model-a', (u) => usage.push(u));
    expect(usage.map((u) => u.costUsd)).toEqual([UNKNOWN_PRICE.input + UNKNOWN_PRICE.output / 10, 0.5 + 0.2, UNKNOWN_PRICE.input + UNKNOWN_PRICE.output / 10]);

    await router.setPrice('custom', 'model-a', { input: 0.5, output: 2 });
    expect(router.info().models[0]).toMatchObject({ id: 'custom:model-a', priced: true, inputPerMTok: 0.5, outputPerMTok: 2 });
    await expect(router.setPrice('custom', 'model-a', { input: -1, output: 2 })).rejects.toThrow(/A price is a number/);
  });

  it('uses the prices a gateway\'s own listing gives', async () => {
    api.models = [{ id: 'maker/model-a', name: 'Maker: Model A', pricing: { prompt: '0.000003', completion: '0.000015' }, supported_parameters: ['tools'] }, { id: 'maker/no-tools', pricing: { prompt: '0', completion: '0' }, supported_parameters: [] }];
    const { router } = await setup();
    await router.connect({ presetId: 'custom', baseURL: api.baseURL, apiKey: 'sk-test' });
    // A model that cannot call tools cannot do an agent's work, so it is not offered.
    expect(router.info().models).toEqual([expect.objectContaining({ id: 'custom:maker/model-a', label: 'Maker: Model A', priced: true, inputPerMTok: 3, outputPerMTok: 15 })]);
  });
});

describe('looking after keys', () => {
  it('asks again what a key can call, and takes a model added by hand', async () => {
    const { router } = await setup();
    await router.connect({ presetId: 'custom', baseURL: api.baseURL, apiKey: 'sk-test' });
    api.models = [{ id: 'model-a' }, { id: 'model-c' }];
    await router.refresh('custom');
    await router.addModel('custom', 'model-by-hand');
    expect(router.info().models.map((m) => m.id)).toEqual(['custom:model-a', 'custom:model-by-hand', 'custom:model-c']);
    await expect(router.addModel('custom', 'two words')).rejects.toThrow(/exactly as the provider/);

    // A listing that cannot be read later does not take the connection away.
    api.modelsStatus = 500;
    const kept = await router.refresh('custom');
    expect(kept.listingError).toMatch(/could not be read/);
    expect(router.info().models.map((m) => m.id)).toContain('custom:model-a');
  });

  it('checks a new key before swapping it in', async () => {
    api.key = 'sk-first';
    const { router, store } = await setup();
    await router.connect({ presetId: 'custom', baseURL: api.baseURL, apiKey: 'sk-first' });
    await expect(router.update('custom', { apiKey: 'sk-wrong' })).rejects.toThrow(/did not accept that key/);
    expect(store.get('custom')!.apiKey).toBe('sk-first');
    api.key = 'sk-second';
    await router.update('custom', { apiKey: 'sk-second', label: 'Renamed' });
    expect(store.get('custom')).toMatchObject({ apiKey: 'sk-second', label: 'Renamed' });
    // Calls go out with the new key.
    api.replies = [{ content: '{"ok":true}' }];
    await ask(router, 'custom:model-a');
    expect(api.seen.at(-1)!.headers.authorization).toBe('Bearer sk-second');
  });

  it('forgets a key when asked, and goes back to simulating when none is left', async () => {
    const { router } = await setup();
    await router.connect({ presetId: 'custom', baseURL: api.baseURL, apiKey: 'sk-test' });
    await router.disconnect('custom');
    expect(router.info().simulated).toBe(true);
    expect(JSON.parse(await readFile(file, 'utf8')).connections).toEqual([]);
    await expect(router.disconnect('custom')).rejects.toThrow(/no such connection/);
  });

  it('comes back after a restart with the keys it was given', async () => {
    const first = await setup();
    await first.router.connect({ presetId: 'custom', baseURL: api.baseURL, apiKey: 'sk-test' });
    await first.router.setPrice('custom', 'model-a', { input: 1, output: 2 });
    const { router } = await setup();
    expect(router.info().models[0]).toMatchObject({ id: 'custom:model-a', priced: true, inputPerMTok: 1 });
  });
});

describe('small things', () => {
  it('splits a model reference at the first colon only', () => {
    expect(parseRef('claude-opus-5-5')).toEqual({ connectionId: null, model: 'claude-opus-5-5' });
    expect(parseRef('openai:gpt-5')).toEqual({ connectionId: 'openai', model: 'gpt-5' });
    expect(parseRef('openrouter:maker/model:free')).toEqual({ connectionId: 'openrouter', model: 'maker/model:free' });
  });

  it('keeps each Anthropic key\'s hosted-session ids in a file of its own', () => {
    // The ids are of agents and environments saved on the key's account, and mean nothing on another.
    expect(stateFileOf('data/managed.json', 'anthropic')).toBe('data/managed.json');
    expect(stateFileOf('data/managed.json', 'anthropic-2')).toBe('data/managed-anthropic-2.json');
    expect(stateFileOf('data/managed.json', 'anthropic-env')).toBe('data/managed-anthropic-env.json');
    expect(stateFileOf('/tmp/state', 'anthropic-2')).toBe('/tmp/state-anthropic-2');
  });

  it('shows the end of a key and no more', () => {
    expect(keyHint('sk-abcdefghijkl')).toBe('…ijkl');
    expect(keyHint('short')).toBe('…');
    expect(keyHint('')).toBe('');
  });
});
