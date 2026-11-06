import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ConnectionStore, type Connection } from '../src/server/connections';
import { sanitiseSettings, DEFAULT_SETTINGS } from '../src/server/engine/state';
import { PRESETS, PRICES_CHECKED, nearestEffort, presetById, ratesOn } from '../src/server/providers/catalogue';
import { ProviderRouter } from '../src/server/providers/router';
import type { CallUsage } from '../src/server/providers/types';
import { FakeOpenAI } from './fake-openai-api';

// The catalogue of providers, and what the router makes of it. The first
// part checks that the catalogue is well formed. It cannot check that what
// it says about a provider is true: that was read from the providers' pages.
// The second part runs keys for catalogue providers against a local stand-in.

describe('the catalogue of providers', () => {
  // Providers a key is added for. The two that are not: an endpoint of the person's own, and Claude Code, which has no key.
  const real = PRESETS.filter((p) => p.id !== 'custom' && p.kind !== 'claude-code');

  it('covers the frontier makers, Chinese ones among them, and leaves Grok out', () => {
    const ids = PRESETS.map((p) => p.id);
    expect(ids).toEqual(['anthropic', 'claude-code', 'openai', 'google', 'meta', 'moonshot', 'deepseek', 'alibaba', 'zhipu', 'tencent', 'minimax', 'bytedance', 'openrouter', 'custom']);
    expect(new Set(ids).size).toBe(ids.length);
    for (const preset of PRESETS) {
      const everything = JSON.stringify(preset).toLowerCase();
      expect(everything).not.toMatch(/grok|xai\b|x\.ai/);
    }
  });

  it('says where each provider is, where to get a key, and which variable a key can be given in', () => {
    const variables = PRESETS.flatMap((p) => p.env);
    expect(new Set(variables).size).toBe(variables.length);
    for (const preset of real) {
      expect(preset.id).toMatch(/^[a-z][a-z0-9-]{0,39}$/);
      expect(preset.label).not.toBe('');
      expect(preset.env.length).toBeGreaterThan(0);
      for (const name of preset.env) expect(name).toMatch(/^[A-Z][A-Z0-9_]+_API_KEY$/);
      expect(preset.keysUrl).toMatch(/^https:\/\//);
      expect(preset.sources.length).toBeGreaterThan(0);
      for (const source of preset.sources) expect(source).toMatch(/^https:\/\//);
      expect(preset.regions.length).toBeGreaterThan(0);
      expect(new Set(preset.regions.map((r) => r.id)).size).toBe(preset.regions.length);
      for (const region of preset.regions) {
        // An address the client can be pointed at as it stands: https, and no slash on the end.
        expect(region.baseURL).toMatch(/^https:\/\/[a-z0-9.-]+(\/[A-Za-z0-9._/-]*[A-Za-z0-9])?$/);
        expect(region.label).not.toBe('');
      }
    }
    expect(presetById('custom')).toMatchObject({ env: [], models: [], regions: [{ baseURL: '' }] });
    // Claude Code is the program on this machine: it has no address, takes no key, and says whose use it is for.
    expect(presetById('claude-code')).toMatchObject({ kind: 'claude-code', env: [], models: [], regions: [{ id: 'local', baseURL: '' }] });
    expect(presetById('claude-code')!.note).toContain('It is for your own use here.');
    expect(presetById('nope')).toBeUndefined();
    expect(PRICES_CHECKED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('gives every platform of every provider models to pick, each with a price that makes sense', () => {
    const LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    for (const preset of real.filter((p) => p.kind !== 'anthropic')) {
      const regions = preset.regions.map((r) => r.id);
      for (const region of regions) {
        const here = preset.models.filter((m) => !m.only || m.only.includes(region));
        expect(here.length, `${preset.id} ${region}`).toBeGreaterThan(0);
        expect(new Set(here.map((m) => m.id)).size, `${preset.id} ${region}`).toBe(here.length);
        expect(here.filter((m) => m.starter).length, `${preset.id} ${region}`).toBeLessThanOrEqual(1);
        expect(here.some((m) => m.tier === 'flagship'), `${preset.id} ${region}`).toBe(true);
      }
      for (const model of preset.models) {
        const what = `${preset.id}:${model.id}`;
        // A reference to it is something an organisation's settings will hold.
        expect(sanitiseSettings({ executiveModel: what }, DEFAULT_SETTINGS).executiveModel, what).toBe(what);
        expect(model.label, what).not.toBe('');
        for (const only of model.only ?? []) expect(regions, what).toContain(only);
        for (const level of model.efforts ?? []) expect(LEVELS, what).toContain(level);
        for (const rates of [model, model.next, model.long, model.next?.long].filter((r) => r !== undefined)) {
          expect(rates.input, what).toBeGreaterThan(0);
          expect(rates.output, what).toBeGreaterThanOrEqual(rates.input);
          expect(rates.output, what).toBeLessThan(200);
          if (rates.cached !== undefined) expect(rates.cached, what).toBeLessThan(rates.input);
          if (rates.cacheWrite !== undefined) expect(rates.cacheWrite, what).toBeGreaterThanOrEqual(rates.input);
        }
        if (model.long) {
          expect(model.long.above, what).toBeGreaterThan(10_000);
          expect(model.long.input, what).toBeGreaterThan(model.input);
        }
        if (model.next) {
          // A change that had already happened when the prices were read would simply be the price.
          expect(Date.parse(model.next.from), what).toBeGreaterThan(Date.parse(PRICES_CHECKED));
        }
        if (model.maxOutput !== undefined) expect(model.maxOutput, what).toBeGreaterThanOrEqual(32_000);
      }
      for (const level of preset.dialect.efforts ?? []) expect(LEVELS).toContain(level);
      expect(preset.dialect.structured.length).toBeGreaterThan(0);
    }
  });

  it('charges a model at its announced new price from the day that price starts', () => {
    const argon = presetById('google')!.models.find((m) => m.id === 'gemini-4-argon')!;
    expect(ratesOn(argon, new Date('2026-11-30T23:59:59Z'))).toEqual({ input: 2, cached: 0.1, output: 10 });
    expect(ratesOn(argon, new Date('2026-12-01T00:00:00Z'))).toEqual({ input: 4, cached: 0.2, output: 20 });
    const sol = presetById('openai')!.models.find((m) => m.id === 'gpt-6.1-sol')!;
    expect(ratesOn(sol, new Date('2030-01-01'))).toEqual({ input: 2, cached: 0.1, cacheWrite: 2.5, output: 10, long: { above: 272_000, input: 4, cached: 0.2, cacheWrite: 5, output: 15 } });
  });

  it('sends an effort setting as the nearest level a model takes, the stronger of two equally near, and never as none', () => {
    const all = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
    const sent = (levels: string[] | null) => all.map((effort) => nearestEffort(effort, levels));
    expect(sent(['low', 'medium', 'high', 'xhigh', 'max'])).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(sent(['low', 'medium', 'high'])).toEqual(['low', 'medium', 'high', 'high', 'high']);
    expect(sent(['low', 'high', 'max'])).toEqual(['low', 'high', 'high', 'max', 'max']);
    expect(sent(['low', 'medium', 'xhigh'])).toEqual(['low', 'medium', 'xhigh', 'xhigh', 'xhigh']);
    expect(sent(['none', 'minimal', 'high'])).toEqual(['minimal', 'high', 'high', 'high', 'high']);
    expect(sent(['none'])).toEqual([undefined, undefined, undefined, undefined, undefined]);
    expect(sent([])).toEqual([undefined, undefined, undefined, undefined, undefined]);
    expect(sent(null)).toEqual([undefined, undefined, undefined, undefined, undefined]);
  });
});

describe('keys for catalogue providers', () => {
  const api = new FakeOpenAI();
  let dir: string;
  let store: ConnectionStore;
  let router: ProviderRouter;

  beforeAll(() => api.start());
  afterAll(() => api.stop());
  beforeEach(async () => {
    api.reset();
    dir = await mkdtemp(path.join(os.tmpdir(), 'the-organisation-catalogue-'));
    store = new ConnectionStore(path.join(dir, 'connections.json'), {});
    await store.load();
    router = new ProviderRouter(store, { compatible: { maxRetries: 0, turnRetryDelayMs: 1 }, mock: { delayMs: 0 } });
  });
  afterEach(async () => {
    vi.useRealTimers();
    await rm(dir, { recursive: true, force: true });
  });

  /** A key added through the router, with the provider's address swapped for the stand-in's. */
  const connect = (presetId: string) => router.connect({ presetId, apiKey: 'sk-test-1234', baseURL: api.baseURL });
  /** A key put straight into the store at one of the provider's own addresses, with no listing: nothing is called. */
  const place = (presetId: string, region: string, more: Partial<Connection> = {}) => {
    const preset = presetById(presetId)!;
    return store.add({
      id: presetId,
      presetId,
      label: preset.label,
      baseURL: preset.regions.find((r) => r.id === region)!.baseURL,
      apiKey: 'sk-test-1234',
      source: 'stored',
      addedAt: new Date().toISOString(),
      models: [],
      checkedAt: null,
      listingError: null,
      prices: {},
      extraModels: [],
      ...more,
    });
  };
  const SYSTEM = { charter: 'Charter.', role: 'Role.' };
  const Answer = z.object({ ok: z.boolean() });
  const ask = (model: string, effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' = 'high', onUsage?: (u: CallUsage) => void) =>
    router.structured({ kind: 'consult', system: SYSTEM, prompt: 'Well?', schema: Answer, model, effort, onUsage, context: {} });
  const ids = () => router.info().models.map((m) => m.id);

  it('offers the picks a key can call first, then whatever else it can call, and starts new organisations on the one marked for that', async () => {
    api.models = [{ id: 'gpt-4.1' }, { id: 'gpt-6.1-sol' }, { id: 'gpt-6-astra' }, { id: 'text-embedding-3-large' }, { id: 'gpt-image-2' }];
    await connect('openai');
    const info = router.info();
    // Only the picks this key has, in the catalogue's order; then the rest of its chat models.
    expect(info.models.map((m) => [m.id, m.recommended, m.tier, m.priced])).toEqual([
      ['openai:gpt-6-astra', true, 'flagship', true],
      ['openai:gpt-6.1-sol', true, 'balanced', true],
      ['openai:gpt-4.1', false, undefined, false],
    ]);
    expect(info.models[0]).toMatchObject({ label: 'GPT-6 Astra', inputPerMTok: 10, outputPerMTok: 50, provider: 'OpenAI', hosted: false, web: false });
    expect(info.defaultModel).toBe('openai:gpt-6.1-sol');
    expect(info.managed).toBe(false);

    // A key that cannot call the one marked starts on the first pick it can.
    api.models = [{ id: 'gpt-6-luna' }, { id: 'gpt-6.1-terra' }];
    await router.refresh('openai');
    expect(router.defaultModel()).toBe('openai:gpt-6.1-terra');
  });

  it('calls OpenAI through its Responses API, and every other provider through Chat Completions', async () => {
    api.models = [{ id: 'gpt-6.1-sol' }, { id: 'kimi-k3.1-pro' }];
    await connect('openai');
    await connect('moonshot');
    api.responses = [{ text: '{"ok":true}' }];
    api.replies = [{ content: '{"ok":true}' }];
    expect(await ask('openai:gpt-6.1-sol', 'max')).toEqual({ ok: true });
    expect(await ask('moonshot:kimi-k3.1-pro', 'medium')).toEqual({ ok: true });
    expect(api.asked).toHaveLength(1);
    expect(api.chats).toHaveLength(1);
    // Each in the provider's own terms: the level the model takes that is nearest the organisation's setting.
    expect(api.asked[0]).toMatchObject({ model: 'gpt-6.1-sol', reasoning: { effort: 'max' }, store: false });
    expect(api.chats[0]).toMatchObject({ model: 'kimi-k3.1-pro', reasoning_effort: 'high', max_completion_tokens: 32000 });
    expect(api.chats[0].response_format.type).toBe('json_schema');
  });

  it('counts spend at the catalogue price, at a gateway\'s own price where its listing gives one, and at a price set by hand over both', async () => {
    api.models = [
      { id: 'anthropic/claude-opus-5.5', name: 'Anthropic: Claude Opus 5.5', pricing: { prompt: '0.0000045', completion: '0.0000225' } },
      { id: 'maker/unknown-model' },
    ];
    await connect('openrouter');
    // OpenRouter reports token counts on every reply without being asked, and is not asked.
    api.alwaysUsage = true;
    const opus = () => router.info().models.find((m) => m.id === 'openrouter:anthropic/claude-opus-5.5')!;
    // The listing's price, not the catalogue's $4 and $20.
    expect(opus()).toMatchObject({ label: 'Claude Opus 5.5', inputPerMTok: 4.5, outputPerMTok: 22.5, priced: true, recommended: true });
    const usage: CallUsage[] = [];
    api.replies = [{ content: '{"ok":true}', usage: { prompt_tokens: 1_000_000, completion_tokens: 0 } }];
    await ask('openrouter:anthropic/claude-opus-5.5', 'high', (u) => usage.push(u));
    expect(usage[0]).toMatchObject({ model: 'openrouter:anthropic/claude-opus-5.5', costUsd: 4.5 });
    expect(api.chats[0].stream_options).toBeUndefined();

    await router.setPrice('openrouter', 'anthropic/claude-opus-5.5', { input: 1, output: 2 });
    expect(opus()).toMatchObject({ inputPerMTok: 1, outputPerMTok: 2 });

    // What the gateway says a call cost stands over any of these.
    api.replies = [{ content: '{"ok":true}', usage: { prompt_tokens: 1_000_000, completion_tokens: 0, cost: 0.123 } }];
    await ask('openrouter:anthropic/claude-opus-5.5', 'high', (u) => usage.push(u));
    expect(usage[1]!.costUsd).toBe(0.123);

    // A listing that cannot be read for once does not throw away what the last one said.
    api.modelsStatus = 500;
    await router.refresh('openrouter');
    await router.setPrice('openrouter', 'anthropic/claude-opus-5.5', null);
    expect(opus()).toMatchObject({ inputPerMTok: 4.5, outputPerMTok: 22.5, priced: true });
    expect(router.info().connections![0]!.listingError).toMatch(/could not be read .*The list from the last time it could is kept/);

    // A key added while the listing cannot be read at all is offered the catalogue's picks, at the catalogue's prices.
    await router.disconnect('openrouter');
    await connect('openrouter');
    expect(opus()).toMatchObject({ inputPerMTok: 4, outputPerMTok: 20, priced: true, recommended: true });
    expect(router.info().connections![0]!.listingError).toMatch(/usual models for OpenRouter are offered instead/);
    expect(ids()).toHaveLength(presetById('openrouter')!.models.length);
  });

  it('moves to a provider\'s announced new price on the day it starts', async () => {
    await place('google', 'default');
    const argon = () => router.info().models.find((m) => m.id === 'google:gemini-4-argon')!;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-20T12:00:00Z'));
    expect(argon()).toMatchObject({ inputPerMTok: 2, outputPerMTok: 10 });
    vi.setSystemTime(new Date('2026-12-01T00:00:01Z'));
    expect(argon()).toMatchObject({ inputPerMTok: 4, outputPerMTok: 20 });
    expect(router.presets().find((p) => p.id === 'google')!.models[0]).toMatchObject({ id: 'gemini-4-argon', inputPerMTok: 4, outputPerMTok: 20 });
  });

  it('offers the models of the platform a key is on, where a provider\'s platforms differ', async () => {
    await place('bytedance', 'cn');
    expect(ids()).toEqual(['bytedance:doubao-seed-2-1-pro-260915', 'bytedance:doubao-seed-2-1-turbo-260628', 'bytedance:doubao-seed-2-1-lite-260915']);
    expect(router.defaultModel()).toBe('bytedance:doubao-seed-2-1-pro-260915');
    // Priced in yuan, counted in dollars.
    expect(router.info().models[0]).toMatchObject({ inputPerMTok: 0.825, outputPerMTok: 4.127 });

    await store.remove('bytedance');
    await place('bytedance', 'intl');
    expect(ids()).toEqual(['bytedance:dola-seed-2-1-turbo-260628', 'bytedance:seed-2-0-pro-260328', 'bytedance:seed-2-0-mini-260428']);

    // At an address of the user's own there is no telling which platform it is, so nothing is ruled out.
    await store.remove('bytedance');
    await place('bytedance', 'intl', { baseURL: 'https://ark.example.test/api/v3' });
    expect(ids()).toHaveLength(6);
  });

  it('takes what a provider\'s own listing says about a model over what the catalogue says', async () => {
    // The listing says this model has four effort levels where the catalogue knows three, and a smaller output limit.
    api.models = [{ id: 'deepseek-flash', effort: { supported_levels: ['low', 'medium', 'high', 'max'] }, max_output_tokens: 8192 }, { id: 'deepseek-v4-pro' }];
    await connect('deepseek');
    api.replies = [{ content: '{"ok":true}' }, { content: '{"ok":true}' }];
    await ask('deepseek:deepseek-flash', 'medium');
    await ask('deepseek:deepseek-v4-pro', 'medium');
    // The catalogue's levels for the provider are low, high and max, so medium is sent as high where nothing better is known.
    expect(api.chats.map((b) => b.reasoning_effort)).toEqual(['medium', 'high']);
    // The catalogue's figure for a model it knows stands; DeepSeek caps output under its old name, and takes plain JSON.
    expect(api.chats[0]).toMatchObject({ max_tokens: 32000, response_format: { type: 'json_object' } });
    expect(api.chats[0].messages[1].content).toContain('Reply in json');
  });

  it('sends no effort level to a model the catalogue says takes none, and the nearest to one that takes its own', async () => {
    api.models = [{ id: 'qwen3.8-max' }, { id: 'qwen3.7-plus' }];
    await connect('alibaba');
    api.replies = [{ content: '{"ok":true}' }, { content: '{"ok":true}' }];
    await ask('alibaba:qwen3.8-max', 'high');
    await ask('alibaba:qwen3.7-plus', 'high');
    expect(api.chats.map((b) => b.reasoning_effort)).toEqual(['xhigh', undefined]);
  });

  it('matches a listing that prefixes its ids to the catalogue\'s picks', async () => {
    api.models = [{ id: 'models/gemini-4-argon' }, { id: 'models/gemini-3.8-flash' }, { id: 'models/gemini-embedding-2' }, { id: 'models/gemma-4-27b-it' }];
    await connect('google');
    expect(router.info().models.map((m) => [m.id, m.recommended])).toEqual([
      ['google:gemini-4-argon', true],
      ['google:gemini-3.8-flash', true],
      ['google:gemma-4-27b-it', false],
    ]);
  });

  it('keeps working with a key for a provider this version no longer lists', async () => {
    api.models = [{ id: 'model-a' }];
    await store.add({ id: 'gone', presetId: 'gone', label: 'Gone Inc.', baseURL: api.baseURL, apiKey: 'sk-test-1234', source: 'stored', addedAt: new Date().toISOString(), models: [{ id: 'model-a' }], checkedAt: null, listingError: null, prices: {}, extraModels: [] });
    expect(ids()).toEqual(['gone:model-a']);
    api.replies = [{ content: '{"ok":true}' }];
    expect(await ask('gone:model-a')).toEqual({ ok: true });
  });
});
