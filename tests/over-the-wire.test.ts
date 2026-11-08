import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConnectionStore } from '../src/server/connections';
import { ProviderRouter } from '../src/server/providers/router';
import { FakeOpenAI } from './fake-openai-api';
import { harness, runToRest, type Harness } from './helpers';
import { fill, followSchemas } from './schema-following';

// Whole organisations run on models reached over HTTP: the engine, the
// router, a provider for each kind of API, and a local stand-in that answers
// as a model would (schema-following.ts). This is the nearest thing to a
// live run that needs no key. It shows the pieces fit together; it cannot
// show that a real provider accepts what is sent.

const api = new FakeOpenAI();
beforeAll(() => api.start());
afterAll(() => api.stop());

let dir: string;
let router: ProviderRouter;
let h: Harness | undefined;
let written: { files: string[] };

beforeEach(async () => {
  api.reset();
  api.models = [];
  written = followSchemas(api);
  dir = await mkdtemp(path.join(os.tmpdir(), 'the-organisation-wire-'));
  const store = new ConnectionStore(path.join(dir, 'connections.json'), {});
  await store.load();
  router = new ProviderRouter(store, { compatible: { maxRetries: 0, turnRetryDelayMs: 1 }, mock: { delayMs: 0 } });
});
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
  await rm(dir, { recursive: true, force: true });
});

/** Add a key for a catalogue provider, pointed at the stand-in, which lists the models named. */
async function connect(presetId: string, models: string[]): Promise<void> {
  api.models = models.map((id) => ({ id }));
  await router.connect({ presetId, apiKey: 'sk-test-1234', baseURL: api.baseURL });
}

const TEAM = [{ profileId: 'engineering', agentCount: 2 }, { profileId: 'product', agentCount: 1 }];
const organisation = (executiveModel: string, workerModel: string, settings = {}) =>
  harness({ provider: router, executives: TEAM, settings: { executiveModel, workerModel, maxCycles: 1, budgetUsd: 50, ...settings } });

/** What every finished run has in common, whatever it ran on. */
function expectAWholeCycle(run: Harness): void {
  const { org } = run;
  expect(org.lastError).toBeNull();
  expect(org.status).toBe('paused');
  expect(org.pauseReason).toBe('cycle_limit');
  expect(org.plans.length).toBeGreaterThan(0);
  for (const plan of org.plans) {
    expect(plan.status).toBe('done');
    expect(plan.execution).toBe('local');
    for (const phase of plan.phases) {
      expect(phase.status).toBe('done');
      for (const task of phase.tasks) expect(task).toMatchObject({ status: 'done', result: 'Wrote the note and checked it.' });
    }
  }
  expect(org.reports.length).toBe(org.plans.length);
  expect(written.files.length).toBeGreaterThan(0);
}

describe('an organisation on models reached over HTTP', () => {
  it('runs a whole cycle through Chat Completions, held to a schema', async () => {
    await connect('moonshot', ['kimi-k3.1-pro', 'kimi-k3.1-pro-highspeed']);
    h = await organisation('moonshot:kimi-k3.1-pro', 'moonshot:kimi-k3.1-pro-highspeed');
    await runToRest(h.runner);
    expectAWholeCycle(h);

    expect(api.asked).toHaveLength(0);
    const structured = api.chats.filter((b) => !b.tools);
    const agents = api.chats.filter((b) => b.tools);
    expect(structured.length).toBeGreaterThan(5);
    expect(agents.length).toBeGreaterThan(1);
    // Executives on one model and agents on the other, each under the provider's own id for it.
    expect(new Set(structured.map((b) => b.model))).toEqual(new Set(['kimi-k3.1-pro']));
    expect(new Set(agents.map((b) => b.model))).toEqual(new Set(['kimi-k3.1-pro-highspeed']));
    for (const body of structured) expect(body.response_format.type).toBe('json_schema');
    // An agent's reasoning went back with its tool call, as Kimi requires.
    const second = agents.find((b) => b.messages.some((m: any) => m.role === 'tool'))!;
    expect(second.messages.find((m: any) => m.role === 'assistant')).toMatchObject({ reasoning_content: 'I will write the note.' });
    // No web search was offered, and the agents were not told they had one.
    for (const body of agents) {
      expect(body.tools.map((t: any) => t.function.name)).toEqual(['list_files', 'read_file', 'write_file', 'edit_file', 'read_business', 'update_business', 'business_access', 'read_business_email', 'draft_business_email', 'account_browser']);
      expect(body.messages[0].content).toContain('You cannot run code or browse arbitrary websites.');
    }

    // The files are in the workspace, and the spend is counted at each model's own list price.
    for (const file of written.files) expect((await h.runner.workspace.read(file)).content).toContain('Written over the wire.');
    const perCall = (input: number, output: number) => (2000 * input + 500 * output) / 1e6;
    expect(h.org.usage.costUsd).toBeCloseTo(structured.length * perCall(2, 10) + agents.length * perCall(4, 20), 6);
    expect(h.org.usage.inputTokens).toBe(api.chats.length * 2000);
  });

  it('runs a whole cycle where the schema can only be stated in the prompt', async () => {
    // DeepSeek promises JSON and no more; MiniMax promises nothing.
    await connect('deepseek', ['deepseek-flash']);
    await connect('minimax', ['MiniMax-M3.1-Flash']);
    h = await organisation('deepseek:deepseek-flash', 'minimax:MiniMax-M3.1-Flash');
    await runToRest(h.runner);
    expectAWholeCycle(h);
    const structured = api.chats.filter((b) => !b.tools);
    for (const body of structured) {
      expect(body.model).toBe('deepseek-flash');
      expect(body.response_format).toEqual({ type: 'json_object' });
      expect(body.messages.at(-1).content).toContain('must match this JSON Schema:');
      expect(body.max_tokens).toBe(32000);
    }
    const agents = api.chats.filter((b) => b.tools);
    for (const body of agents) {
      expect(body).toMatchObject({ model: 'MiniMax-M3.1-Flash', reasoning_split: true, max_completion_tokens: 64000 });
      expect(body.tool_choice).toBeUndefined();
    }
  });

  it('runs a whole cycle through OpenAI\'s Responses API, with a second provider\'s agents beside it', async () => {
    await connect('openai', ['gpt-6.1-sol', 'gpt-6-luna']);
    await connect('zhipu', ['glm-5.3-flash']);
    h = await organisation('openai:gpt-6.1-sol', 'openai:gpt-6-luna');
    await runToRest(h.runner);
    expectAWholeCycle(h);
    expect(api.chats).toHaveLength(0);
    const agents = api.asked.filter((b) => b.tools);
    expect(agents.length).toBeGreaterThan(1);
    expect(new Set(api.asked.filter((b) => !b.tools).map((b) => b.model))).toEqual(new Set(['gpt-6.1-sol']));
    expect(new Set(agents.map((b) => b.model))).toEqual(new Set(['gpt-6-luna']));
    // A turn's reasoning travels back with the exchange, encrypted, since nothing is kept on OpenAI's side.
    const second = agents.find((b) => b.input.some((i: any) => i.type === 'function_call_output'))!;
    expect(second.input.find((i: any) => i.type === 'reasoning')).toMatchObject({ encrypted_content: 'ENC(I will write the note.)' });
    for (const body of api.asked) expect(body.store).toBe(false);

    // The same organisation, its agents moved to another maker's model: the next cycle's tasks go there.
    const before = written.files.length;
    h.runner.updateSettings({ workerModel: 'zhipu:glm-5.3-flash', maxCycles: 2 });
    await runToRest(h.runner);
    expect(h.org.lastError).toBeNull();
    expect(h.org.cycle.number).toBeGreaterThanOrEqual(2);
    expect(written.files.length).toBeGreaterThan(before);
    const moved = api.chats.filter((b) => b.tools);
    expect(moved.length).toBeGreaterThan(0);
    expect(new Set(moved.map((b) => b.model))).toEqual(new Set(['glm-5.3-flash']));
    // GLM takes no switch for turning tools off, and is not asked for token counts it sends anyway.
    for (const body of moved) {
      expect(body.tool_choice).toBeUndefined();
      expect(body.stream_options).toBeUndefined();
    }
  });

  it('pauses with the provider\'s own words when a key stops working part-way', async () => {
    await connect('moonshot', ['kimi-k3.1-pro']);
    h = await organisation('moonshot:kimi-k3.1-pro', 'moonshot:kimi-k3.1-pro');
    api.key = 'sk-a-different-key';
    await runToRest(h.runner);
    expect(h.org.status).toBe('paused');
    expect(h.org.pauseReason).toBe('error');
    expect(h.org.lastError).toMatch(/Moonshot AI rejected the API key/);
    // Put right, it carries on from where it stopped.
    api.key = '';
    await runToRest(h.runner);
    expectAWholeCycle(h);
  });
});

describe('the stand-in\'s answers', () => {
  it('fit the schema they are given', () => {
    expect(fill({ type: 'object', properties: { a: { type: 'string', enum: ['x', 'y'] }, b: { type: 'array', items: { type: 'integer', minimum: 3 } }, c: { anyOf: [{ type: 'null' }, { type: 'boolean' }] } } })).toEqual({ a: 'x', b: [3], c: false });
    expect(fill({ $ref: '#/$defs/thing', $defs: { thing: { type: 'object', properties: { n: { type: 'number' } } } } })).toEqual({ n: 1 });
  });
});
