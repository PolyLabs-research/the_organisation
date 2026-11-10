import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Dialect, Price } from '../src/server/providers/catalogue';
import { OpenAIResponsesProvider } from '../src/server/providers/openai-responses';
import type { AgentTool, CallUsage } from '../src/server/providers/types';
import { FakeOpenAI } from './fake-openai-api';
import { waitFor } from './helpers';

// The provider for OpenAI's own models, which speaks the Responses API, run
// against a local stand-in (fake-openai-api.ts). These check what is sent
// and how replies and refusals are handled. They cannot check that OpenAI
// accepts the requests.

const api = new FakeOpenAI();
beforeAll(() => api.start());
afterAll(() => api.stop());
beforeEach(() => api.reset());

const DIALECT: Dialect = { maxTokensParam: 'max_completion_tokens', structured: ['json_schema', 'json_object', 'prompt'], efforts: ['low', 'medium', 'high'], echoReasoning: false, streamUsage: true };
const PRICES: Record<string, Price> = {
  'big-model': { input: 2, cached: 0.1, cacheWrite: 2.5, output: 10, long: { above: 272_000, input: 4, cached: 0.2, cacheWrite: 5, output: 15 } },
};
const provider = (extra: Partial<ConstructorParameters<typeof OpenAIResponsesProvider>[0]> = {}) =>
  new OpenAIResponsesProvider({
    label: 'OpenAI',
    baseURL: api.baseURL,
    apiKey: 'sk-test',
    dialect: DIALECT,
    priceOf: (model) => PRICES[model] ?? null,
    effortOf: (model) => (model === 'big-model' ? ['low', 'medium', 'high', 'xhigh', 'max'] : undefined),
    maxRetries: 0,
    turnRetryDelayMs: 1,
    ...extra,
  });

const SYSTEM = { charter: 'You are part of Fernery.', role: 'You are the CTO.' };
const Answer = z.object({ verdict: z.enum(['pass', 'rework']), summary: z.string(), count: z.number().int() });
const ask = (p: OpenAIResponsesProvider, onUsage?: (u: CallUsage) => void, model = 'big-model') =>
  p.structured({ kind: 'phase_review', system: SYSTEM, prompt: 'Review the phase.', schema: Answer, model, effort: 'xhigh', onUsage, context: {} });
const GOOD = JSON.stringify({ verdict: 'pass', summary: 'Fine.', count: 2 });

describe('a structured answer from the Responses API', () => {
  it('is asked for with the schema, with nothing kept on the other side, and priced from the token counts', async () => {
    api.responses = [{ reasoning: 'thinking it over', text: GOOD, usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 400, cache_write_tokens: 100 }, output_tokens: 200 } }];
    const usage: CallUsage[] = [];
    expect(await ask(provider(), (u) => usage.push(u))).toEqual({ verdict: 'pass', summary: 'Fine.', count: 2 });

    expect(api.chats).toHaveLength(0);
    const [body] = api.asked;
    expect(body).toMatchObject({
      model: 'big-model',
      instructions: 'You are part of Fernery.\n\nYou are the CTO.',
      input: [{ role: 'user', content: 'Review the phase.' }],
      store: false,
      include: ['reasoning.encrypted_content'],
      // The model's own level for the organisation's setting, not the endpoint's usual top one.
      reasoning: { effort: 'xhigh' },
      max_output_tokens: 32000,
      stream: true,
    });
    expect(body.text.format).toMatchObject({ type: 'json_schema', name: 'phase_review', strict: true });
    expect(body.text.format.schema).toMatchObject({ type: 'object', additionalProperties: false, required: ['verdict', 'summary', 'count'] });
    expect(body.tools).toBeUndefined();

    // 500 plain input tokens at $2, 400 read from the cache at $0.10, 100 written to it at $2.50, 200 out at $10.
    expect(usage).toEqual([
      { model: 'big-model', inputTokens: 500, outputTokens: 200, cacheReadTokens: 400, cacheWriteTokens: 100, webSearches: 0, costUsd: expect.closeTo((500 * 2 + 400 * 0.1 + 100 * 2.5 + 200 * 10) / 1e6, 10) },
    ]);
  });

  it('charges the whole request at the long-prompt rates once the prompt is long enough for them', async () => {
    api.responses = [{ text: GOOD, usage: { input_tokens: 300_000, input_tokens_details: { cached_tokens: 100_000, cache_write_tokens: 0 }, output_tokens: 1000 } }];
    const usage: CallUsage[] = [];
    await ask(provider(), (u) => usage.push(u));
    expect(usage[0]!.costUsd).toBeCloseTo((200_000 * 4 + 100_000 * 0.2 + 1000 * 15) / 1e6, 10);
  });

  it('falls back to plain JSON when the schema is refused, and remembers', async () => {
    api.rules = [(b) => (b.text?.format?.type === 'json_schema' ? "Invalid schema for response_format 'phase_review': the schema is not supported." : undefined)];
    api.responses = [{ text: `Here you are:\n${GOOD}` }, { text: GOOD }];
    const p = provider();
    expect(await ask(p)).toMatchObject({ verdict: 'pass' });
    await ask(p);
    expect(api.asked.map((b) => b.text.format.type)).toEqual(['json_schema', 'json_object', 'json_object']);
    // Asked for in words too, with the word some endpoints insist on.
    expect(api.asked[1].input[0].content).toMatch(/^Review the phase\.\n\nReply in json: a single JSON object/);
    expect(api.asked[1].input[0].content).toContain('"verdict"');
  });

  it('gives a reply that does not fit one chance to be put right, with what was said handed back as it came', async () => {
    api.responses = [
      { reasoning: 'first thoughts', text: JSON.stringify({ verdict: 'maybe', summary: 'Hm.', count: 2 }) },
      { text: GOOD },
    ];
    const usage: CallUsage[] = [];
    expect(await ask(provider(), (u) => usage.push(u))).toMatchObject({ verdict: 'pass' });
    expect(usage).toHaveLength(2);
    const second = api.asked[1];
    expect(second.input.map((i: any) => i.type ?? i.role)).toEqual(['user', 'reasoning', 'message', 'user']);
    expect(second.input[1]).toMatchObject({ type: 'reasoning', encrypted_content: 'ENC(first thoughts)' });
    expect(second.input[3].content).toContain('does not match the required structure (verdict');

    api.responses = [{ text: 'not json' }, { text: 'still not json' }];
    expect(await ask(provider()).catch((e) => e)).toMatchObject({ code: 'invalid_output', retryable: true });
  });

  it('says how a response ended when it did not end with an answer', async () => {
    api.responses = [{ text: '{"verdict":"pa', incomplete: 'max_output_tokens' }];
    expect(await ask(provider()).catch((e) => e)).toMatchObject({ code: 'truncated', retryable: true });
    api.responses = [{ incomplete: 'content_filter' }];
    expect(await ask(provider()).catch((e) => e)).toMatchObject({ code: 'refusal', retryable: false });
    api.responses = [{ refusal: 'I cannot help with that.' }];
    expect(await ask(provider()).catch((e) => e)).toMatchObject({ code: 'refusal', message: expect.stringContaining('I cannot help with that.') });
    api.responses = [{ failed: { code: 'server_error', message: 'Something went wrong.' } }];
    expect(await ask(provider()).catch((e) => e)).toMatchObject({ code: 'unavailable', retryable: true });
    api.responses = [{ failed: { code: 'rate_limit_exceeded', message: 'Too many requests.' } }];
    expect(await ask(provider()).catch((e) => e)).toMatchObject({ code: 'rate_limit', retryable: true });
    api.responses = [{ failed: { code: 'bio_policy', message: 'This request was declined.' } }];
    expect(await ask(provider()).catch((e) => e)).toMatchObject({ code: 'refusal', retryable: false });
    api.responses = [{ failed: { code: 'invalid_prompt', message: 'The prompt was not valid.' } }];
    expect(await ask(provider()).catch((e) => e)).toMatchObject({ code: 'bad_request', retryable: false });
    api.responses = [{ text: 'half', cut: true }];
    expect(await ask(provider()).catch((e) => e)).toMatchObject({ code: 'unavailable', retryable: true });
    api.responses = [{ status: 401, error: 'Incorrect API key provided.' }];
    expect(await ask(provider()).catch((e) => e)).toMatchObject({ code: 'auth', retryable: false, message: expect.stringContaining('OpenAI rejected the API key') });
  });
});

describe('fitting a request to what a model takes', () => {
  it('sends the nearest effort level a model has, and none to a model that takes none', async () => {
    api.responses = [{ text: GOOD }, { text: GOOD }, { text: GOOD }];
    const p = provider({ effortOf: (model) => (model === 'old-model' ? null : model === 'big-model' ? ['low', 'medium', 'high', 'xhigh', 'max'] : undefined) });
    await ask(p);
    await ask(p, undefined, 'unlisted-model');
    await ask(p, undefined, 'old-model');
    // Its own five levels; the endpoint's usual three, where xhigh rounds down to high; and nothing at all.
    expect(api.asked.map((b) => b.reasoning)).toEqual([{ effort: 'xhigh' }, { effort: 'high' }, undefined]);
  });

  it('stops sending what a model turns out not to take, whether or not the refusal says what that was', async () => {
    api.rules = [
      (b) => (b.reasoning && b.model === 'plain-model' ? "Unsupported parameter: 'reasoning.effort' is not supported with this model." : undefined),
      (b) => (b.include && b.model === 'odd-model' ? 'Invalid request (1210)' : undefined),
    ];
    api.responses = [{ text: GOOD }, { text: GOOD }, { text: GOOD }, { text: GOOD }];
    const p = provider();
    await ask(p, undefined, 'plain-model');
    await ask(p, undefined, 'plain-model');
    expect(api.asked.map((b) => b.reasoning?.effort)).toEqual(['high', undefined, undefined]);

    api.seen.length = 0;
    await ask(p, undefined, 'odd-model');
    await ask(p, undefined, 'odd-model');
    // Refused as sent, twice; refused without the effort level; accepted without the request for encrypted
    // reasoning, which is then the only thing left out from there on.
    expect(api.asked.map((b) => [b.reasoning?.effort, b.include?.[0]])).toEqual([
      ['high', 'reasoning.encrypted_content'],
      ['high', 'reasoning.encrypted_content'],
      [undefined, 'reasoning.encrypted_content'],
      ['high', undefined],
      ['high', undefined],
    ]);
  });

  it('reports what a response cost even when the response is no use', async () => {
    const usage: CallUsage[] = [];
    api.responses = [{ refusal: 'I cannot help with that.', usage: { input_tokens: 1000, output_tokens: 20 } }];
    expect(await ask(provider(), (u) => usage.push(u)).catch((e) => e)).toMatchObject({ code: 'refusal' });
    expect(usage).toEqual([expect.objectContaining({ inputTokens: 1000, outputTokens: 20, costUsd: expect.closeTo((1000 * 2 + 20 * 10) / 1e6, 10) })]);
    // A response that failed and says nothing of tokens is taken to have cost none.
    api.responses = [{ failed: { code: 'server_error', message: 'Something went wrong.' }, usage: null }];
    await ask(provider(), (u) => usage.push(u)).catch(() => {});
    expect(usage).toHaveLength(1);
    // One that was cut off was paid for as far as it got.
    api.responses = [{ text: '{"verdict":"pa', incomplete: 'max_output_tokens', usage: { input_tokens: 500, output_tokens: 32000 } }];
    await ask(provider(), (u) => usage.push(u)).catch(() => {});
    expect(usage[1]).toMatchObject({ inputTokens: 500, outputTokens: 32000 });
  });

  it('counts a response that was lost part-way, by its length, since it never said what it cost', async () => {
    const usage: CallUsage[] = [];
    // The connection drops after 4,000 characters of the answer have arrived.
    api.responses = [{ text: 'x'.repeat(4000), cut: true }];
    expect(await ask(provider(), (u) => usage.push(u)).catch((e) => e)).toMatchObject({ code: 'unavailable', retryable: true });
    expect(usage).toHaveLength(1);
    // About four characters to a token, for the exchange that went in and for what had come back.
    expect(usage[0]!.inputTokens).toBe(Math.ceil((JSON.stringify(api.asked[0].input).length + api.asked[0].instructions.length) / 4));
    expect(usage[0]!.outputTokens).toBeGreaterThanOrEqual(1000);
    expect(usage[0]!.outputTokens).toBeLessThan(1100);
    expect(usage[0]!.costUsd).toBeCloseTo((usage[0]!.inputTokens * 2 + usage[0]!.outputTokens * 10) / 1e6, 10);
    // So is one that an error stopped after it had started.
    api.responses = [{ text: 'x'.repeat(4000), streamError: { code: 'server_error', message: 'The server had an error.' } }];
    await ask(provider(), (u) => usage.push(u)).catch(() => {});
    expect(usage).toHaveLength(2);
    expect(usage[1]!.outputTokens).toBeGreaterThanOrEqual(1000);
  });

  it('counts nothing for a call that was stopped on purpose', async () => {
    const stop = new AbortController();
    const usage: CallUsage[] = [];
    api.responses = [{ text: 'x'.repeat(4000), hold: true }];
    const call = provider()
      .structured({ kind: 'phase_review', system: SYSTEM, prompt: 'Review the phase.', schema: Answer, model: 'big-model', effort: 'xhigh', onUsage: (u) => usage.push(u), signal: stop.signal, context: {} })
      .catch((e) => e);
    await waitFor(() => api.asked.length === 1, 'the request to arrive');
    await new Promise((resolve) => setTimeout(resolve, 50));
    stop.abort();
    await call;
    expect(usage).toHaveLength(0);
  });

  it('makes room when the exchange and its reply together overflow the model, and gives the work up when it cannot fit', async () => {
    const overflow = 'Your input exceeds the context window of this model. Please adjust your input and try again.';
    api.rules = [(b) => (b.max_output_tokens > 8000 ? overflow : undefined)];
    api.responses = [{ text: GOOD }];
    const p = provider();
    expect(await ask(p)).toMatchObject({ verdict: 'pass' });
    expect(api.asked.map((b) => b.max_output_tokens)).toEqual([32000, 4096]);
    // For that request alone: nothing is concluded about the model.
    api.rules = [];
    api.responses = [{ text: GOOD }];
    await ask(p);
    expect(api.asked.at(-1).max_output_tokens).toBe(32000);

    api.rules = [() => overflow];
    expect(await ask(p).catch((e) => e)).toMatchObject({ code: 'invalid_output', retryable: false });
  });

  it('does not mistake a refusal about a reasoning item for one about the effort level', async () => {
    // As when an item of the model's reasoning is sent back without what has to follow it.
    api.rules = [(b) => (b.model === 'big-model' && api.asked.length <= 1 ? "Item 'rs_123' of type 'reasoning' was provided without its required following item." : undefined)];
    api.responses = [{ text: GOOD }, { text: GOOD }];
    const p = provider();
    await ask(p);
    await ask(p);
    // The effort level went out every time: it was never what was objected to.
    expect(api.asked.map((b) => b.reasoning?.effort)).toEqual(['xhigh', 'xhigh', 'xhigh']);
  });

  it('lowers the output cap to the limit the endpoint names', async () => {
    api.rules = [(b) => (b.max_output_tokens > 16384 ? 'Invalid max_output_tokens: the maximum for this model is 16384 output tokens.' : undefined)];
    api.responses = [{ text: GOOD }, { text: GOOD }];
    const p = provider();
    await ask(p);
    await ask(p);
    expect(api.asked.map((b) => b.max_output_tokens)).toEqual([32000, 16384, 16384]);
    api.seen.length = 0;
    api.rules = [];
    api.responses = [{ text: GOOD }];
    await ask(provider({ maxOutputOf: () => 8000 }));
    expect(api.asked[0].max_output_tokens).toBe(8000);
  });
});

describe('an agent run through the Responses API', () => {
  const files: Record<string, string> = {};
  const tools = (): AgentTool[] => [
    { name: 'list_files', description: 'List the files.', schema: z.object({ directory: z.string() }), run: async () => Object.keys(files).join('\n') || 'The workspace is empty.' },
    {
      name: 'write_file',
      description: 'Write a file.',
      schema: z.object({ path: z.string(), content: z.string() }),
      run: async (input) => {
        files[String(input.path)] = String(input.content);
        return `Wrote ${String(input.path)}.`;
      },
    },
  ];
  const run = (p: OpenAIResponsesProvider, extra: Partial<Parameters<OpenAIResponsesProvider['agent']>[0]> = {}) =>
    p.agent({ kind: 'task', system: SYSTEM, prompt: 'Write the spec.', model: 'big-model', effort: 'medium', tools: tools(), webSearch: null, maxTurns: 8, context: {}, ...extra });
  beforeEach(() => {
    for (const key of Object.keys(files)) delete files[key];
  });

  it('runs the tools the model calls and hands everything the model produced back exactly as it came', async () => {
    api.responses = [
      { reasoning: 'look first', text: 'Looking first.', calls: [{ id: 'call_a', name: 'list_files', arguments: { directory: '' } }] },
      { reasoning: 'now write', calls: [{ id: 'call_b', name: 'write_file', arguments: { path: 'engineering/spec.md', content: '# Spec' } }, { id: 'call_c', name: 'list_files', arguments: { directory: 'engineering' } }] },
      { text: 'Wrote engineering/spec.md.' },
    ];
    const usage: CallUsage[] = [];
    const result = await run(provider(), { onUsage: (u) => usage.push(u) });
    expect(result).toEqual({ text: 'Wrote engineering/spec.md.', turns: 3, stopped: 'done' });
    expect(files['engineering/spec.md']).toBe('# Spec');
    expect(usage).toHaveLength(3);

    const [first, second, third] = api.asked;
    // Tools in the Responses form: flat, and not strict.
    expect(first.tools).toEqual([
      { type: 'function', name: 'list_files', description: 'List the files.', parameters: expect.objectContaining({ type: 'object', required: ['directory'] }), strict: false },
      { type: 'function', name: 'write_file', description: 'Write a file.', parameters: expect.objectContaining({ type: 'object', required: ['path', 'content'] }), strict: false },
    ]);
    expect(first.tools[0].parameters.$schema).toBeUndefined();
    expect(first).toMatchObject({ store: false, include: ['reasoning.encrypted_content'], reasoning: { effort: 'medium' }, max_output_tokens: 64000, instructions: expect.stringContaining('You are the CTO.') });
    expect(first.tool_choice).toBeUndefined();
    expect(first.input).toEqual([{ role: 'user', content: 'Write the spec.' }]);

    // The exchange only ever grows. After the first turn: its reasoning (encrypted, unread), its words and its call, then the call's result.
    expect(second.input.slice(0, 1)).toEqual(first.input);
    expect(second.input.slice(1)).toEqual([
      { id: 'rs_1', type: 'reasoning', summary: [], encrypted_content: 'ENC(look first)' },
      { id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Looking first.', annotations: [] }] },
      { id: 'fc_1_0', type: 'function_call', call_id: 'call_a', name: 'list_files', arguments: '{"directory":""}', status: 'completed' },
      { type: 'function_call_output', call_id: 'call_a', output: 'The workspace is empty.' },
    ]);
    expect(third.input.slice(0, second.input.length)).toEqual(second.input);
    expect(third.input.slice(second.input.length).map((i: any) => [i.type, i.call_id])).toEqual([
      ['reasoning', undefined],
      ['function_call', 'call_b'],
      ['function_call', 'call_c'],
      ['function_call_output', 'call_b'],
      ['function_call_output', 'call_c'],
    ]);
    expect(third.input.at(-1).output).toBe('engineering/spec.md');
  });

  it('takes the items from the stream when the finished response does not list them', async () => {
    api.responses = [{ reasoning: 'r', calls: [{ id: 'call_a', name: 'list_files', arguments: { directory: '' } }], bareFinal: true }, { text: 'Done.', bareFinal: true }];
    expect(await run(provider())).toEqual({ text: 'Done.', turns: 2, stopped: 'done' });
    expect(api.asked[1].input.map((i: any) => i.type ?? i.role)).toEqual(['user', 'reasoning', 'function_call', 'function_call_output']);
  });

  it('tells the model when a call cannot be read, answers a call to a tool that does not exist, and gives up on a model that keeps getting it wrong', async () => {
    api.responses = [
      { calls: [{ id: 'call_a', name: 'write_file', arguments: '{"path": "x.md"' }, { id: 'call_b', name: 'run_code', arguments: {} }] },
      { text: 'Done.' },
    ];
    expect((await run(provider())).stopped).toBe('done');
    const outputs = api.asked[1].input.filter((i: any) => i.type === 'function_call_output');
    expect(outputs[0].output).toMatch(/^Error: the arguments were not valid JSON/);
    expect(outputs[1].output).toBe('Error: there is no tool named run_code.');

    api.responses = Array.from({ length: 4 }, () => ({ calls: [{ name: 'write_file', arguments: { path: 1 } }] }));
    expect(await run(provider()).catch((e) => e)).toMatchObject({ code: 'invalid_output', retryable: false });
  });

  it('has the agent stop and report when told to wrap up, with its tools switched off', async () => {
    let wrap = false;
    api.responses = [{ calls: [{ id: 'call_a', name: 'list_files', arguments: { directory: '' } }] }, { text: 'Stopped: only the listing was read.' }];
    const result = await run(provider(), { shouldWrapUp: () => wrap, onUsage: () => (wrap = true) });
    expect(result).toEqual({ text: 'Stopped: only the listing was read.', turns: 2, stopped: 'cut_short' });
    expect(api.asked[1].tool_choice).toBe('none');
    expect(api.asked[1].input.at(-1)).toEqual({ role: 'user', content: expect.stringContaining('You have to stop here.') });

    // Nothing is started when it is already time to stop, and a run told to stop part-way is dropped.
    api.seen.length = 0;
    expect(await run(provider(), { shouldWrapUp: () => true })).toEqual({ text: '', turns: 0, stopped: 'interrupted' });
    expect(api.asked).toHaveLength(0);
    let stop = false;
    api.responses = [{ calls: [{ id: 'call_a', name: 'list_files', arguments: { directory: '' } }] }];
    expect(await run(provider(), { shouldStop: () => stop, onUsage: () => (stop = true) })).toEqual({ text: '', turns: 1, stopped: 'interrupted' });
  });

  it('sends a turn again after a failure that may pass, without starting the run over or running a tool twice', async () => {
    let writes = 0;
    const counting = tools().map((t) => (t.name === 'write_file' ? { ...t, run: async () => `Wrote it (${++writes}).` } : t));
    api.responses = [
      { calls: [{ id: 'call_a', name: 'write_file', arguments: { path: 'a.md', content: 'A' } }] },
      { status: 500, error: 'upstream error' },
      { failed: { code: 'server_error', message: 'The server had an error.' } },
      { streamError: { code: 'rate_limit_exceeded', message: 'Slow down.' } },
      { text: 'Done.' },
    ];
    const usage: CallUsage[] = [];
    const result = await run(provider(), { tools: counting, onUsage: (u) => usage.push(u) });
    expect(result).toEqual({ text: 'Done.', turns: 2, stopped: 'done' });
    expect(writes).toBe(1);
    // Five requests for two turns: the second turn was sent four times, each time with the same exchange.
    expect(api.asked).toHaveLength(5);
    for (const again of api.asked.slice(2)) expect(again.input).toEqual(api.asked[1].input);
    // Two turns, the response that failed after it had been charged for, and the one an error stopped part-way.
    expect(usage).toHaveLength(4);

    // A failure that keeps coming is given up on.
    api.seen.length = 0;
    api.responses = Array.from({ length: 6 }, () => ({ status: 503, error: 'overloaded' }));
    expect(await run(provider()).catch((e) => e)).toMatchObject({ code: 'unavailable', retryable: true });
    expect(api.asked).toHaveLength(4);
  });

  it('never runs a tool call that was cut off at the output limit', async () => {
    api.responses = [{ calls: [{ id: 'call_a', name: 'write_file', arguments: '{"path":"x.md","content":"ha' }], incomplete: 'max_output_tokens' }];
    expect(await run(provider()).catch((e) => e)).toMatchObject({ code: 'truncated', retryable: true });
    expect(files['x.md']).toBeUndefined();
    // Words cut off at the limit are still a report, and say so.
    api.responses = [{ text: 'I wrote the first half and', incomplete: 'max_output_tokens' }];
    expect(await run(provider())).toEqual({ text: 'I wrote the first half and', turns: 1, stopped: 'cut_short' });
  });

  it('counts tokens itself, roughly, when the response does not report them', async () => {
    api.responses = [{ text: 'Done.', usage: null }];
    const usage: CallUsage[] = [];
    await run(provider(), { onUsage: (u) => usage.push(u) });
    expect(usage[0]!.inputTokens).toBeGreaterThan(5);
    expect(usage[0]!.outputTokens).toBeGreaterThan(0);
    expect(usage[0]!.costUsd).toBeGreaterThan(0);
  });
});
