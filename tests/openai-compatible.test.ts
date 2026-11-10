import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Dialect, Price } from '../src/server/providers/catalogue';
import { OpenAICompatibleProvider, UNKNOWN_PRICE } from '../src/server/providers/openai-compatible';
import { ProviderError, type AgentTool, type CallUsage } from '../src/server/providers/types';
import { FakeOpenAI } from './fake-openai-api';
import { waitFor } from './helpers';

// The provider for OpenAI-compatible endpoints, run against a local stand-in
// (fake-openai-api.ts). These check what is sent and how replies and refusals
// are handled. They cannot check that any real provider accepts the requests.

const api = new FakeOpenAI();
beforeAll(() => api.start());
afterAll(() => api.stop());
beforeEach(() => api.reset());

const OPENAI_LIKE: Dialect = {
  maxTokensParam: 'max_completion_tokens',
  structured: ['json_schema', 'json_object', 'prompt'],
  efforts: ['low', 'medium', 'high', 'xhigh'],
  echoReasoning: false,
  streamUsage: true,
};
const PLAIN: Dialect = { maxTokensParam: 'max_tokens', structured: ['json_object', 'prompt'], efforts: null, echoReasoning: true, streamUsage: true };

const PRICES: Record<string, Price> = { 'big-model': { input: 2, output: 10, cached: 0.5 } };
const provider = (dialect: Dialect = OPENAI_LIKE, extra: Partial<ConstructorParameters<typeof OpenAICompatibleProvider>[0]> = {}) =>
  new OpenAICompatibleProvider({
    label: 'Testco',
    baseURL: api.baseURL,
    apiKey: 'sk-test',
    dialect,
    priceOf: (model) => PRICES[model] ?? null,
    maxRetries: 0,
    turnRetryDelayMs: 1,
    ...extra,
  });

const SYSTEM = { charter: 'You are part of Fernery.', role: 'You are the CTO.' };
const Answer = z.object({ verdict: z.enum(['pass', 'rework']), summary: z.string(), count: z.number().int() });
const ask = (p: OpenAICompatibleProvider, onUsage?: (u: CallUsage) => void, model = 'big-model') =>
  p.structured({ kind: 'phase_review', system: SYSTEM, prompt: 'Review the phase.', schema: Answer, model, effort: 'high', onUsage, context: {} });
const GOOD = JSON.stringify({ verdict: 'pass', summary: 'Fine.', count: 2 });

describe('a structured answer', () => {
  it('is asked for with the schema where the endpoint holds a reply to one, and priced from the token counts', async () => {
    api.replies = [{ content: GOOD, usage: { prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 400 } } }];
    const usage: CallUsage[] = [];
    expect(await ask(provider(), (u) => usage.push(u))).toEqual({ verdict: 'pass', summary: 'Fine.', count: 2 });

    const [body] = api.chats;
    expect(body.model).toBe('big-model');
    expect(body.messages).toEqual([
      { role: 'system', content: 'You are part of Fernery.\n\nYou are the CTO.' },
      { role: 'user', content: 'Review the phase.' },
    ]);
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema).toMatchObject({ name: 'phase_review', strict: true });
    // Closed, with the enum kept and the bounds zod adds to integers dropped.
    const schema = body.response_format.json_schema.schema;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.verdict.enum).toEqual(['pass', 'rework']);
    expect(JSON.stringify(schema)).not.toMatch(/minimum|maximum/);
    expect(body.max_completion_tokens).toBe(32000);
    expect(body.max_tokens).toBeUndefined();
    expect(body.reasoning_effort).toBe('high');
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(api.seen[0]!.headers.authorization).toBe('Bearer sk-test');

    // 600 fresh input at $2, 400 cached at $0.50, 200 output at $10, per million.
    expect(usage).toEqual([{ model: 'big-model', inputTokens: 600, outputTokens: 200, cacheReadTokens: 400, cacheWriteTokens: 0, webSearches: 0, costUsd: (600 * 2 + 400 * 0.5 + 200 * 10) / 1e6 }]);
  });

  it('is asked for as plain JSON, with the schema in the prompt, where that is all the endpoint offers', async () => {
    api.replies = [{ content: GOOD }];
    await ask(provider(PLAIN));
    const [body] = api.chats;
    expect(body.response_format).toEqual({ type: 'json_object' });
    // The word "json" is in the prompt in lower case: some endpoints refuse a request for JSON without it.
    expect(body.messages[1].content).toMatch(/^Review the phase\.\n\nReply in json: a single JSON object and nothing else/);
    expect(body.messages[1].content).toContain('"verdict"');
    expect(body.max_tokens).toBe(32000);
    expect(body.reasoning_effort).toBeUndefined();
  });

  it('falls back to plain JSON when the endpoint refuses a schema, and remembers', async () => {
    api.rules = [(b) => (b.response_format?.type === 'json_schema' ? "Invalid parameter: 'response_format' of type 'json_schema' is not supported with this model." : undefined)];
    api.replies = [{ content: GOOD }, { content: GOOD }];
    const p = provider();
    await ask(p);
    await ask(p);
    // One refusal, then two calls that went through: the second did not try the schema again.
    expect(api.chats.map((b) => b.response_format.type)).toEqual(['json_schema', 'json_object', 'json_object']);
  });

  it('falls all the way back to asking in words when the endpoint has no JSON mode either', async () => {
    api.rules = [(b) => (b.response_format ? 'response_format is not supported' : undefined)];
    api.replies = [{ content: `Here is the review:\n\`\`\`json\n${GOOD}\n\`\`\`\nLet me know if you need more.` }];
    expect(await ask(provider())).toEqual({ verdict: 'pass', summary: 'Fine.', count: 2 });
    expect(api.chats.at(-1).response_format).toBeUndefined();
  });

  it('gives a model that was not held to the schema one chance to put a wrong reply right', async () => {
    api.replies = [{ content: JSON.stringify({ verdict: 'maybe', summary: 'Hm.' }) }, { content: GOOD }];
    const usage: CallUsage[] = [];
    expect(await ask(provider(PLAIN), (u) => usage.push(u))).toEqual({ verdict: 'pass', summary: 'Fine.', count: 2 });
    const second = api.chats[1];
    expect(second.messages.at(-2)).toEqual({ role: 'assistant', content: JSON.stringify({ verdict: 'maybe', summary: 'Hm.' }) });
    expect(second.messages.at(-1).content).toMatch(/does not match the required structure \(verdict: /);
    // Both requests were paid for.
    expect(usage).toHaveLength(2);
  });

  it('gives the same chance to an endpoint that was handed the schema and still returned something else', async () => {
    // As a provider does that takes the schema and then answers with nothing but spaces.
    api.replies = [{ content: '   ' }, { content: GOOD }];
    expect(await ask(provider())).toMatchObject({ verdict: 'pass' });
    const [first, second] = api.chats;
    expect(second.response_format).toEqual(first.response_format);
    expect(second.response_format.type).toBe('json_schema');
    expect(second.messages.slice(2)).toEqual([
      { role: 'assistant', content: '(nothing)' },
      { role: 'user', content: expect.stringContaining('does not match the required structure (it was not a JSON object)') },
    ]);
  });

  it('reports a rate limit met on the way down as a rate limit, not as the refusal that came before it', async () => {
    api.rules = [(b) => (b.response_format?.type === 'json_schema' ? 'Invalid parameter (1214)' : undefined)];
    api.replies = [{ status: 429, error: 'Rate limit reached for requests' }];
    const failure = await ask(provider({ ...OPENAI_LIKE, efforts: null, streamUsage: false })).catch((e) => e);
    // Something to wait out and try again, where the earlier refusal would have paused the organisation for good.
    expect(failure).toMatchObject({ code: 'rate_limit', retryable: true });
    expect(api.chats.map((b) => b.response_format?.type)).toEqual(['json_schema', 'json_schema', 'json_object']);
  });

  it('gives up, as something worth trying again, when the second reply is wrong too', async () => {
    api.replies = [{ content: 'I cannot produce JSON.' }, { content: '{"verdict":"pass"}' }];
    const failure = await ask(provider(PLAIN)).catch((e) => e);
    expect(failure).toBeInstanceOf(ProviderError);
    expect(failure).toMatchObject({ code: 'invalid_output', retryable: true });
    expect(api.chats).toHaveLength(2);
  });

  it('says a reply cut off at the output limit was cut off, and one the provider withheld was declined', async () => {
    api.replies = [{ content: '{"verdict":"pa', finish: 'length' }];
    expect(await ask(provider()).catch((e) => e)).toMatchObject({ code: 'truncated', retryable: true });
    api.replies = [{ content: '', finish: 'content_filter' }];
    expect(await ask(provider()).catch((e) => e)).toMatchObject({ code: 'refusal', retryable: false });
  });
});

describe('fitting a request to the endpoint', () => {
  it('lowers the output cap to the limit the endpoint names, and keeps to it', async () => {
    api.rules = [(b) => ((b.max_completion_tokens ?? 0) > 8192 ? 'Invalid max_completion_tokens value, the valid range of max_tokens is [1, 8192]' : undefined)];
    api.replies = [{ content: GOOD }, { content: GOOD }];
    const p = provider();
    await ask(p);
    await ask(p);
    expect(api.chats.map((b) => b.max_completion_tokens)).toEqual([32000, 8192, 8192]);
  });

  it('halves the cap when the endpoint refuses it without naming a limit', async () => {
    api.rules = [(b) => ((b.max_completion_tokens ?? 0) > 5000 ? 'max_completion_tokens is too large for this model' : undefined)];
    api.replies = [{ content: GOOD }];
    await ask(provider());
    expect(api.chats.map((b) => b.max_completion_tokens)).toEqual([32000, 16000, 8000, 4000]);
  });

  it('makes room when a prompt and its reply together overflow the model, without shrinking the replies that follow', async () => {
    const overflow =
      "This model's maximum context length is 32768 tokens. However, you requested 40000 tokens (8000 in the messages, 32000 in the completion). Please reduce the length of the messages or completion.";
    api.rules = [(b) => (b.max_completion_tokens > 8000 && JSON.stringify(b.messages).includes('A very long brief') ? overflow : undefined)];
    api.replies = [{ content: GOOD }, { content: GOOD }];
    const p = provider();
    await p.structured({ kind: 'phase_review', system: SYSTEM, prompt: 'A very long brief.', schema: Answer, model: 'big-model', effort: 'high', context: {} });
    // Less room for the reply, for that request alone: the model's limit on output was never the trouble.
    expect(api.chats.map((b) => b.max_completion_tokens)).toEqual([32000, 4096]);
    await ask(p);
    expect(api.chats.at(-1).max_completion_tokens).toBe(32000);
  });

  it('says the work is too long, not that the provider is at fault, when it cannot be made to fit', async () => {
    api.rules = [() => "This model's maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens. Please reduce the length of the messages."];
    const p = provider();
    // A failure of the task, which the lead sees at its gate, where a fault of the provider's would pause everything.
    expect(await ask(p).catch((e) => e)).toMatchObject({ code: 'invalid_output', retryable: false, message: expect.stringContaining('outgrew the model’s context window') });
    expect(api.chats.map((b) => b.max_completion_tokens)).toEqual([32000, 4096]);
    // Nothing was learned about the model from it.
    api.rules = [];
    api.replies = [{ content: GOOD }];
    await ask(p);
    expect(api.chats.at(-1).max_completion_tokens).toBe(32000);
  });

  it('reshapes a request refused with a 422 as it would one refused with a 400', async () => {
    api.replies = [{ status: 422, error: 'Extra inputs are not permitted: stream_options' }, { content: GOOD }, { content: GOOD }];
    const p = provider();
    await ask(p);
    await ask(p);
    expect(api.chats.map((b) => !!b.stream_options)).toEqual([true, false, false]);
  });

  it('sends nothing to an endpoint that OpenAI\'s own environment variables would have added', async () => {
    const before = { ...process.env };
    process.env.OPENAI_ORG_ID = 'org-not-theirs';
    process.env.OPENAI_PROJECT_ID = 'proj-not-theirs';
    process.env.OPENAI_ADMIN_KEY = 'sk-admin-not-theirs';
    process.env.OPENAI_CUSTOM_HEADERS = 'X-Internal-Gateway: not-theirs\nX-Team: nor-this';
    process.env.OPENAI_BASE_URL = 'http://127.0.0.1:9/v1';
    try {
      api.replies = [{ content: GOOD }];
      await ask(provider());
      const sent = JSON.stringify(api.seen.at(-1)!.headers);
      expect(sent).not.toMatch(/not-theirs|nor-this/);
      expect(api.seen.at(-1)!.headers).not.toHaveProperty('openai-organization');
      expect(api.seen.at(-1)!.headers).not.toHaveProperty('openai-project');
      expect(api.seen.at(-1)!.headers).not.toHaveProperty('x-internal-gateway');
      expect(api.seen.at(-1)!.headers.authorization).toBe('Bearer sk-test');
    } finally {
      for (const name of ['OPENAI_ORG_ID', 'OPENAI_PROJECT_ID', 'OPENAI_ADMIN_KEY', 'OPENAI_CUSTOM_HEADERS', 'OPENAI_BASE_URL']) {
        if (before[name] === undefined) delete process.env[name];
        else process.env[name] = before[name];
      }
    }
  });

  it('will not be built without an address, which would send its key to OpenAI', () => {
    expect(() => provider(OPENAI_LIKE, { baseURL: '' })).toThrow(/has no address to call/);
  });

  it('uses the limit known for a model without having to be refused first', async () => {
    api.replies = [{ content: GOOD }];
    await ask(provider(OPENAI_LIKE, { maxOutputOf: () => 4096 }));
    expect(api.chats.map((b) => b.max_completion_tokens)).toEqual([4096]);
  });

  it('switches to the other name for the output cap when the endpoint asks for it', async () => {
    api.rules = [(b) => (b.max_tokens !== undefined ? "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." : undefined)];
    api.replies = [{ content: GOOD }];
    await ask(provider(PLAIN));
    expect(api.chats.at(-1).max_completion_tokens).toBe(32000);
    expect(api.chats.at(-1).max_tokens).toBeUndefined();
  });

  it('adds the fields an endpoint is known to want, and drops one it turns out not to take', async () => {
    const dialect: Dialect = { ...PLAIN, extraBody: { tool_stream: true, thinking: { type: 'enabled' } } };
    api.rules = [(b) => (b.tool_stream !== undefined ? 'Unrecognized request argument supplied: tool_stream' : undefined)];
    api.replies = [{ content: GOOD }, { content: GOOD }];
    const p = provider(dialect);
    await ask(p);
    await ask(p);
    // Refused once, then left out for good; the field that was not refused stays.
    expect(api.chats.map((b) => [b.tool_stream, b.thinking])).toEqual([
      [true, { type: 'enabled' }],
      [undefined, { type: 'enabled' }],
      [undefined, { type: 'enabled' }],
    ]);
  });

  it('stops sending an effort level to a model that does not take one', async () => {
    api.rules = [(b) => (b.reasoning_effort ? "Unrecognized request argument supplied: reasoning_effort" : undefined)];
    api.replies = [{ content: GOOD }, { content: GOOD }];
    const p = provider();
    await ask(p);
    await ask(p);
    expect(api.chats.map((b) => b.reasoning_effort)).toEqual(['high', undefined, undefined]);
  });

  it('finds out what an endpoint objects to when its refusal does not say, and remembers only that', async () => {
    // This endpoint takes no extra fields, and says only that the request is wrong.
    const dialect: Dialect = { ...OPENAI_LIKE, structured: ['json_object', 'prompt'], extraBody: { tool_stream: true } };
    api.rules = [(b) => (b.tool_stream ? 'Invalid request parameters (1210)' : undefined)];
    api.replies = [{ content: GOOD }, { content: GOOD }];
    const p = provider(dialect);
    expect(await ask(p)).toMatchObject({ verdict: 'pass' });
    // Refused as sent, and again when sent once more as it was; refused without the effort level, which was
    // not the trouble; accepted without the extra field.
    expect(api.chats.map((b) => [b.reasoning_effort, b.tool_stream])).toEqual([
      ['high', true],
      ['high', true],
      [undefined, true],
      ['high', undefined],
    ]);
    // From then on the extra field is left out and nothing is refused. The effort level, which was tried
    // without and made no difference, is still sent, and so is the request for token counts.
    await ask(p);
    expect(api.chats).toHaveLength(5);
    expect(api.chats[4]).toMatchObject({ reasoning_effort: 'high', stream_options: { include_usage: true } });
    expect(api.chats[4].tool_stream).toBeUndefined();
  });

  it('learns nothing from a refusal that does not come twice', async () => {
    // A passing fault on the provider's side, reported as if the request were at fault.
    api.replies = [{ status: 400, error: 'Upstream error, please try again' }, { content: GOOD }, { content: GOOD }];
    const p = provider({ ...OPENAI_LIKE, extraBody: { tool_stream: true } });
    expect(await ask(p)).toMatchObject({ verdict: 'pass' });
    await ask(p);
    // Sent again exactly as it was, and from then on exactly as before: streamed, with everything optional.
    for (const body of api.chats) expect(body).toMatchObject({ stream: true, reasoning_effort: 'high', tool_stream: true, stream_options: { include_usage: true } });
    expect(api.chats).toHaveLength(3);
  });

  it('keeps what a refusal taught it only once a request has gone through that way', async () => {
    // The endpoint names the effort level as the trouble, and then fails the reshaped request for a reason of its own.
    api.rules = [(b) => (b.reasoning_effort ? 'Unrecognized request argument supplied: reasoning_effort' : undefined)];
    api.replies = [{ status: 500, error: 'boom' }];
    const p = provider();
    expect(await ask(p).catch((e) => e)).toMatchObject({ code: 'unavailable', retryable: true });
    expect(api.chats.map((b) => b.reasoning_effort)).toEqual(['high', undefined]);
    // Nothing went through, so nothing was learned: the next request starts where the last one did.
    api.replies = [{ content: GOOD }, { content: GOOD }];
    await ask(p);
    await ask(p);
    // This time the reshaped request succeeded, and the lesson holds.
    expect(api.chats.map((b) => b.reasoning_effort)).toEqual(['high', undefined, 'high', undefined, undefined]);
  });

  it('drops everything optional when an endpoint objects to more than one thing without saying which', async () => {
    const dialect: Dialect = { ...OPENAI_LIKE, structured: ['json_object', 'prompt'], extraBody: { tool_stream: true } };
    api.rules = [(b) => (b.reasoning_effort || b.tool_stream ? 'Invalid request parameters (1210)' : undefined)];
    api.replies = [{ content: GOOD }, { content: GOOD }];
    const p = provider(dialect);
    expect(await ask(p)).toMatchObject({ verdict: 'pass' });
    // As sent, twice; then without each of the three optional things alone; then without all of them.
    expect(api.chats.map((b) => [b.reasoning_effort, b.tool_stream, !!b.stream_options])).toEqual([
      ['high', true, true],
      ['high', true, true],
      [undefined, true, true],
      ['high', undefined, true],
      ['high', true, false],
      [undefined, undefined, false],
    ]);
    await ask(p);
    expect(api.chats).toHaveLength(7);
    expect([api.chats[6].reasoning_effort, api.chats[6].tool_stream, api.chats[6].stream_options]).toEqual([undefined, undefined, undefined]);
  });

  it('reports the first refusal, and learns nothing, when a request is wrong whatever is left out', async () => {
    api.rules = [(b) => (b.model === 'big-model' ? 'The request could not be processed (1210)' : undefined)];
    const p = provider({ ...OPENAI_LIKE, extraBody: { tool_stream: true } });
    const failure = await ask(p).catch((e) => e);
    expect(failure).toMatchObject({ code: 'bad_request', retryable: false, message: expect.stringContaining('could not be processed') });
    // Each way of asking for the answer was tried, each without each optional setting in turn.
    expect(api.chats.length).toBeGreaterThan(3);
    expect(new Set(api.chats.map((b) => b.response_format?.type))).toEqual(new Set(['json_schema', 'json_object', undefined]));

    // Once the endpoint takes the request, it goes out to the same model as it would have before any of that.
    api.seen.length = 0;
    api.rules = [];
    api.replies = [{ content: GOOD }];
    await ask(p);
    expect(api.chats).toHaveLength(1);
    expect(api.chats[0]).toMatchObject({ reasoning_effort: 'high', tool_stream: true, stream_options: { include_usage: true } });
    expect(api.chats[0].response_format.type).toBe('json_schema');
  });

  it('falls back to another way of asking for JSON when the refusal does not say that was the trouble, and remembers', async () => {
    api.rules = [(b) => (b.response_format?.type === 'json_schema' ? 'Invalid parameter (1214)' : undefined)];
    api.replies = [{ content: GOOD }, { content: GOOD }];
    const p = provider({ ...OPENAI_LIKE, efforts: null, streamUsage: false });
    expect(await ask(p)).toMatchObject({ verdict: 'pass' });
    // Asked twice with the schema, in case the refusal was a passing fault; then the next way down, which is kept.
    expect(api.chats.map((b) => b.response_format?.type)).toEqual(['json_schema', 'json_schema', 'json_object']);
    await ask(p);
    expect(api.chats.map((b) => b.response_format?.type)).toEqual(['json_schema', 'json_schema', 'json_object', 'json_object']);
  });

  it('uses the effort levels a particular model takes, where they are not the endpoint\'s usual ones', async () => {
    const p = provider(OPENAI_LIKE, { effortOf: (model) => (model === 'plain-model' ? null : model === 'odd-model' ? ['low', 'max'] : undefined) });
    api.replies = [{ content: GOOD }, { content: GOOD }, { content: GOOD }];
    await ask(p, undefined, 'plain-model');
    await ask(p, undefined, 'odd-model');
    await ask(p, undefined, 'big-model');
    expect(api.chats.map((b) => b.reasoning_effort)).toEqual([undefined, 'max', 'high']);
  });

  it('maps the effort levels an endpoint does not have onto the nearest it does', async () => {
    api.replies = [{ content: GOOD }];
    await provider().structured({ kind: 'plan', system: SYSTEM, prompt: 'Plan.', schema: Answer, model: 'big-model', effort: 'max', context: {} });
    expect(api.chats[0].reasoning_effort).toBe('xhigh');
  });

  it('counts tokens itself, roughly, when the endpoint will not report them on a stream', async () => {
    api.rules = [(b) => (b.stream_options ? 'Unknown parameter: stream_options' : undefined)];
    api.replies = [{ content: GOOD, usage: null }];
    const usage: CallUsage[] = [];
    await ask(provider(), (u) => usage.push(u));
    expect(api.chats.map((b) => b.stream_options)).toEqual([{ include_usage: true }, undefined]);
    expect(usage[0]!.inputTokens).toBeGreaterThan(10);
    expect(usage[0]!.outputTokens).toBe(Math.ceil(GOOD.length / 4));
    expect(usage[0]!.costUsd).toBeGreaterThan(0);
  });

  it('asks for the whole reply at once from an endpoint that cannot stream', async () => {
    api.rules = [(b) => (b.stream ? 'Streaming is not supported for this model' : undefined)];
    api.replies = [{ content: GOOD, usage: { prompt_tokens: 50, completion_tokens: 10 } }];
    const usage: CallUsage[] = [];
    await ask(provider(), (u) => usage.push(u));
    expect(api.chats.at(-1).stream).toBeUndefined();
    expect(usage[0]).toMatchObject({ inputTokens: 50, outputTokens: 10 });
  });

  it('charges a stand-in price for a model whose price is not known, and the gateway\'s own figure when it gives one', async () => {
    api.replies = [{ content: GOOD, usage: { prompt_tokens: 1000, completion_tokens: 1000 } }, { content: GOOD, usage: { prompt_tokens: 1000, completion_tokens: 1000, cost: 0.0123 } }];
    const usage: CallUsage[] = [];
    await ask(provider(), (u) => usage.push(u), 'unpriced-model');
    await ask(provider(), (u) => usage.push(u), 'unpriced-model');
    expect(usage[0]!.costUsd).toBeCloseTo((1000 * UNKNOWN_PRICE.input + 1000 * UNKNOWN_PRICE.output) / 1e6, 10);
    expect(usage[1]!.costUsd).toBe(0.0123);
  });

  it('charges what is written to a prompt cache at its own rate, and a long prompt at the long-prompt rates', async () => {
    const priceOf = () => ({ input: 2, cached: 0.1, cacheWrite: 2.5, output: 10, long: { above: 272_000, input: 4, cached: 0.2, output: 15 } });
    api.replies = [
      { content: GOOD, usage: { prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 400, cache_write_tokens: 100 } } },
      { content: GOOD, usage: { prompt_tokens: 300_000, completion_tokens: 1000, prompt_tokens_details: { cached_tokens: 100_000, cache_write_tokens: 50_000 } } },
    ];
    const usage: CallUsage[] = [];
    const p = provider(OPENAI_LIKE, { priceOf });
    await ask(p, (u) => usage.push(u));
    await ask(p, (u) => usage.push(u));
    expect(usage[0]).toMatchObject({ inputTokens: 500, cacheReadTokens: 400, cacheWriteTokens: 100, outputTokens: 200 });
    expect(usage[0]!.costUsd).toBeCloseTo((500 * 2 + 400 * 0.1 + 100 * 2.5 + 200 * 10) / 1e6, 10);
    // Past 272,000 prompt tokens every part of the request is at the higher rates; a cache write with no rate of its own there is plain input.
    expect(usage[1]!.costUsd).toBeCloseTo((150_000 * 4 + 100_000 * 0.2 + 50_000 * 4 + 1000 * 15) / 1e6, 10);
  });

  it('does not take a reported cost of nothing for the cost of a model that has a price', async () => {
    api.replies = [{ content: GOOD, usage: { prompt_tokens: 1000, completion_tokens: 200, cost: 0 } }, { content: GOOD, usage: { prompt_tokens: 1000, completion_tokens: 200, cost: 0.5 } }];
    const usage: CallUsage[] = [];
    const p = provider();
    await ask(p, (u) => usage.push(u));
    await ask(p, (u) => usage.push(u));
    expect(usage[0]!.costUsd).toBeCloseTo((1000 * 2 + 200 * 10) / 1e6, 10);
    expect(usage[1]!.costUsd).toBe(0.5);
  });

  it('reads the cache counts some providers report under their own names', async () => {
    api.replies = [{ content: GOOD, usage: { prompt_tokens: 1000, completion_tokens: 100, prompt_cache_hit_tokens: 900, prompt_cache_miss_tokens: 100 } }];
    const usage: CallUsage[] = [];
    await ask(provider(), (u) => usage.push(u));
    expect(usage[0]).toMatchObject({ inputTokens: 100, cacheReadTokens: 900, outputTokens: 100 });
  });
});

describe('an agent run', () => {
  const files: Record<string, string> = {};
  const tools = (): AgentTool[] => [
    {
      name: 'list_files',
      description: 'List the files.',
      schema: z.object({ directory: z.string() }),
      run: async () => Object.keys(files).join('\n') || 'The workspace is empty.',
    },
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
  const run = (p: OpenAICompatibleProvider, extra: Partial<Parameters<OpenAICompatibleProvider['agent']>[0]> = {}) =>
    p.agent({ kind: 'task', system: SYSTEM, prompt: 'Write the spec.', model: 'big-model', effort: 'medium', tools: tools(), webSearch: null, maxTurns: 8, context: {}, ...extra });
  beforeEach(() => {
    for (const key of Object.keys(files)) delete files[key];
  });

  it('runs the tools the model calls, answers each call by its id, and ends on the closing message', async () => {
    api.replies = [
      { content: 'Looking first.', calls: [{ id: 'call_a', name: 'list_files', arguments: { directory: '' } }] },
      { calls: [{ id: 'call_b', name: 'write_file', arguments: { path: 'engineering/spec.md', content: '# Spec\n\nWith "quotes" and a\nnew line.' } }, { id: 'call_c', name: 'list_files', arguments: { directory: 'engineering' } }] },
      { content: 'Wrote engineering/spec.md.' },
    ];
    const usage: CallUsage[] = [];
    const result = await run(provider(), { onUsage: (u) => usage.push(u) });

    expect(result).toEqual({ text: 'Wrote engineering/spec.md.', turns: 3, stopped: 'done' });
    expect(files['engineering/spec.md']).toBe('# Spec\n\nWith "quotes" and a\nnew line.');
    expect(usage).toHaveLength(3);

    const [first, second, third] = api.chats;
    expect(first.tools.map((t: any) => [t.type, t.function.name])).toEqual([['function', 'list_files'], ['function', 'write_file']]);
    expect(first.tools[1].function.parameters).toMatchObject({ type: 'object', required: ['path', 'content'] });
    expect(first.tools[1].function.parameters.$schema).toBeUndefined();
    expect(first.max_completion_tokens).toBe(64000);
    // The history only ever grows: each request repeats the last and adds to it.
    expect(second.messages.slice(0, 2)).toEqual(first.messages);
    expect(second.messages.slice(2)).toEqual([
      { role: 'assistant', content: 'Looking first.', tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'list_files', arguments: '{"directory":""}' } }] },
      { role: 'tool', tool_call_id: 'call_a', content: 'The workspace is empty.' },
    ]);
    expect(third.messages.slice(4).map((m: any) => [m.role, m.tool_call_id ?? m.tool_calls?.map((c: any) => c.id)])).toEqual([
      ['assistant', ['call_b', 'call_c']],
      ['tool', 'call_b'],
      ['tool', 'call_c'],
    ]);
    expect(third.messages[4].content).toBeNull();
    expect(third.messages[6].content).toBe('engineering/spec.md');
  });

  it('sends a model\'s reasoning back with its tool calls where the endpoint wants it kept, and not where it does not', async () => {
    const replies = () => [
      { reasoning: 'I should look at the files first.', calls: [{ id: 'call_a', name: 'list_files', arguments: { directory: '' } }] },
      { reasoning: 'Nothing there, so I am done.', content: 'Nothing to do.' },
    ];
    api.replies = replies();
    await run(provider(PLAIN));
    expect(api.chats[1].messages[2]).toMatchObject({ role: 'assistant', reasoning_content: 'I should look at the files first.' });

    api.reset();
    api.replies = replies();
    await run(provider({ ...PLAIN, echoReasoning: false }));
    expect(api.chats[1].messages[2].reasoning_content).toBeUndefined();

    // A gateway that names the field differently gets it back under its own name.
    api.reset();
    api.replies = [{ reasoning: 'Look first.', reasoningField: 'reasoning', calls: [{ id: 'call_a', name: 'list_files', arguments: { directory: '' } }] }, { content: 'Done.' }];
    await run(provider(PLAIN));
    expect(api.chats[1].messages[2]).toMatchObject({ reasoning: 'Look first.' });
  });

  it('sends back whatever else the endpoint put on a tool call, and makes up an id where it left one out', async () => {
    api.replies = [
      { calls: [{ id: '', name: 'list_files', arguments: { directory: '' }, whole: true, extra: { extra_content: { google: { thought_signature: 'sig-123' } } } }] },
      { content: 'Done.' },
    ];
    await run(provider());
    const [assistant, tool] = api.chats[1].messages.slice(2);
    expect(assistant.tool_calls[0].extra_content).toEqual({ google: { thought_signature: 'sig-123' } });
    expect(assistant.tool_calls[0].id).toMatch(/^call\d{5}$/);
    expect(tool.tool_call_id).toBe(assistant.tool_calls[0].id);
  });

  it('tells the model when a call\'s arguments cannot be read, and gives up if it keeps happening', async () => {
    api.replies = [
      { calls: [{ id: 'call_a', name: 'write_file', arguments: '{"path": "x.md", "content": "unterminated' }] },
      { calls: [{ id: 'call_b', name: 'write_file', arguments: { path: 'x.md' } }] },
      { calls: [{ id: 'call_c', name: 'write_file', arguments: { path: 'x.md', content: 'ok' } }] },
      { content: 'Wrote x.md.' },
    ];
    const result = await run(provider());
    expect(result.stopped).toBe('done');
    expect(files['x.md']).toBe('ok');
    expect(api.chats[1].messages.at(-1).content).toMatch(/^Error: the arguments were not valid JSON/);
    expect(api.chats[2].messages.at(-1).content).toMatch(/^Error: the arguments do not fit the tool \(content: /);

    api.reset();
    api.replies = Array.from({ length: 3 }, (_, i) => ({ calls: [{ id: `call_${i}`, name: 'write_file', arguments: 'not json' }] }));
    expect(await run(provider()).catch((e) => e)).toMatchObject({ code: 'invalid_output', retryable: false });
    expect(api.chats).toHaveLength(3);
  });

  it('answers a call to a tool that does not exist without stopping the run', async () => {
    api.replies = [{ calls: [{ id: 'call_a', name: 'run_code', arguments: { code: 'print(1)' } }] }, { content: 'I cannot run code.' }];
    expect((await run(provider())).text).toBe('I cannot run code.');
    expect(api.chats[1].messages.at(-1).content).toBe('Error: there is no tool named run_code.');
  });

  it('sends back, as they came, the other fields an endpoint wants returned with a turn', async () => {
    const replies = () => [
      {
        reasoning: 'A summary of the thinking.',
        fields: { encrypted_content: 'ENC-0123456789-abcdef', reasoning_details: [{ type: 'reasoning.encrypted', data: 'one' }, { type: 'reasoning.encrypted', data: 'two' }], signature: { v: 2 } },
        calls: [{ id: 'call_a', name: 'list_files', arguments: { directory: '' } }],
      },
      { content: 'Done.' },
    ];
    api.replies = replies();
    await run(provider({ ...PLAIN, echoFields: ['encrypted_content', 'reasoning_details', 'signature', 'never_sent'] }));
    const turn = api.chats[1].messages[2];
    // Text that came in pieces is whole again, a list that came an item at a time is in order, and nothing is made up.
    expect(turn).toMatchObject({
      role: 'assistant',
      reasoning_content: 'A summary of the thinking.',
      encrypted_content: 'ENC-0123456789-abcdef',
      reasoning_details: [{ type: 'reasoning.encrypted', data: 'one' }, { type: 'reasoning.encrypted', data: 'two' }],
      signature: { v: 2 },
    });
    expect('never_sent' in turn).toBe(false);

    // The same from an endpoint that does not stream.
    api.reset();
    api.rules = [(b) => (b.stream ? 'stream is not supported' : undefined)];
    api.replies = replies();
    await run(provider({ ...PLAIN, echoFields: ['encrypted_content'] }));
    expect(api.chats.at(-1).messages[2]).toMatchObject({ encrypted_content: 'ENC-0123456789-abcdef' });
    expect(api.chats.at(-1).messages[2].reasoning_details).toBeUndefined();

    // An endpoint that is not known to want them back does not get them.
    api.reset();
    api.replies = replies();
    await run(provider(PLAIN));
    expect(api.chats[1].messages[2].encrypted_content).toBeUndefined();
  });

  it('puts a stand-in on a tool call that came with nothing attached, for an endpoint that refuses one returned bare', async () => {
    const dialect: Dialect = { ...PLAIN, echoReasoning: false, firstCallFallback: { extra_content: { google: { thought_signature: 'skip' } } } };
    api.replies = [
      { calls: [{ id: 'call_a', name: 'list_files', arguments: { directory: '' } }, { id: 'call_b', name: 'list_files', arguments: { directory: 'x' } }] },
      { calls: [{ id: 'call_c', name: 'list_files', arguments: { directory: '' }, extra: { extra_content: { google: { thought_signature: 'real-sig' } } } }, { id: 'call_d', name: 'list_files', arguments: { directory: 'y' } }] },
      { content: 'Done.' },
    ];
    await run(provider(dialect));
    const history = api.chats[2].messages;
    // The first turn's calls came bare: the first of them gets the stand-in, and only the first.
    expect(history[2].tool_calls.map((c: any) => c.extra_content)).toEqual([{ google: { thought_signature: 'skip' } }, undefined]);
    // The second turn's first call came with its own, which goes back untouched.
    expect(history[5].tool_calls.map((c: any) => c.extra_content)).toEqual([{ google: { thought_signature: 'real-sig' } }, undefined]);

    // The stand-in is for a turn that came with nothing at all. One whose attachment is on a later call, or on
    // the message, is returned as it came and nothing is added to it.
    api.reset();
    api.replies = [
      { calls: [{ id: 'call_a', name: 'list_files', arguments: { directory: '' } }, { id: 'call_b', name: 'list_files', arguments: { directory: 'x' }, extra: { extra_content: { google: { thought_signature: 'on-the-second' } } } }] },
      { fields: { extra_content: { google: { thought_signature: 'on-the-message' } } }, calls: [{ id: 'call_c', name: 'list_files', arguments: { directory: '' } }] },
      { content: 'Done.' },
    ];
    await run(provider({ ...dialect, echoFields: ['extra_content'] }));
    const again = api.chats[2].messages;
    expect(again[2].tool_calls.map((c: any) => c.extra_content)).toEqual([undefined, { google: { thought_signature: 'on-the-second' } }]);
    expect(again[5].tool_calls.map((c: any) => c.extra_content)).toEqual([undefined]);
    expect(again[5].extra_content).toEqual({ google: { thought_signature: 'on-the-message' } });
  });

  it('puts a gateway\'s reasoning details back together from the pieces they were streamed in', async () => {
    const dialect: Dialect = { ...PLAIN, echoReasoning: false, echoFields: ['reasoning_details'] };
    api.replies = [
      {
        fields: {
          reasoning_details: [
            { type: 'reasoning.text', index: 0, id: 'r1', format: 'maker-v1', text: 'First I will ' },
            { type: 'reasoning.text', index: 0, id: 'r1', format: 'maker-v1', text: 'look at the files.' },
            { type: 'reasoning.text', index: 0, id: 'r1', format: 'maker-v1', signature: 'sig-abc' },
            { type: 'reasoning.encrypted', index: 1, id: 'r2', format: 'maker-v1', data: 'AAAA' },
            { type: 'reasoning.encrypted', index: 1, id: 'r2', format: 'maker-v1', data: 'BBBB' },
          ],
        },
        calls: [{ id: 'call_a', name: 'list_files', arguments: { directory: '' } }],
      },
      { content: 'Done.' },
    ];
    await run(provider(dialect));
    expect(api.chats[1].messages[2].reasoning_details).toEqual([
      { type: 'reasoning.text', index: 0, id: 'r1', format: 'maker-v1', text: 'First I will look at the files.', signature: 'sig-abc' },
      { type: 'reasoning.encrypted', index: 1, id: 'r2', format: 'maker-v1', data: 'AAAABBBB' },
    ]);
  });

  it('reads a reply whose content comes as a list of parts, thinking and words apart', async () => {
    api.replies = [{ fields: { content: [{ type: 'thinking', thinking: [{ type: 'text', text: 'Nothing to do here.' }] }, { type: 'text', text: 'There was nothing to do.' }] } }];
    expect(await run(provider())).toEqual({ text: 'There was nothing to do.', turns: 1, stopped: 'done' });
    // The same from an endpoint that does not stream.
    api.rules = [(b) => (b.stream ? 'stream is not supported' : undefined)];
    api.replies = [{ fields: { content: [{ type: 'text', text: 'Whole.' }] } }];
    expect((await run(provider())).text).toBe('Whole.');
  });

  it('has the agent stop and report when told to wrap up, without offering it tools again', async () => {
    let wrap = false;
    api.replies = [
      { calls: [{ id: 'call_a', name: 'list_files', arguments: { directory: '' } }] },
      { content: 'Stopped: only the listing was read.' },
    ];
    const result = await run(provider(), { shouldWrapUp: () => wrap, onUsage: () => (wrap = true) });
    expect(result).toEqual({ text: 'Stopped: only the listing was read.', turns: 2, stopped: 'cut_short' });
    const last = api.chats[1];
    expect(last.tool_choice).toBe('none');
    expect(last.messages.at(-1)).toEqual({ role: 'user', content: expect.stringContaining('You have to stop here.') });
  });

  it('wraps up without the tool switch on an endpoint that does not have it', async () => {
    api.rules = [(b) => (b.tool_choice ? 'tool_choice is not supported' : undefined)];
    api.replies = [{ calls: [{ id: 'call_a', name: 'list_files', arguments: { directory: '' } }] }, { content: 'Stopped.' }];
    const result = await run(provider(), { maxTurns: 1 });
    expect(result.stopped).toBe('cut_short');
    expect(api.chats.at(-1).tool_choice).toBeUndefined();
  });

  it('does not ask for the tool switch at all where the endpoint is known not to have it', async () => {
    api.rules = [(b) => (b.tool_choice ? 'tool_choice is not supported' : undefined)];
    api.replies = [{ calls: [{ id: 'call_a', name: 'list_files', arguments: { directory: '' } }] }, { content: 'Stopped.' }];
    const result = await run(provider({ ...PLAIN, toolChoiceNone: false }), { maxTurns: 1 });
    expect(result.stopped).toBe('cut_short');
    // Two requests, neither refused: the switch was never sent.
    expect(api.chats).toHaveLength(2);
    expect(api.chats[1].tool_choice).toBeUndefined();
    expect(api.chats[1].messages.at(-1).content).toContain('You have to stop here.');
  });

  it('starts nothing when it is already time to stop, and drops a run that is told to stop part-way', async () => {
    expect(await run(provider(), { shouldWrapUp: () => true })).toEqual({ text: '', turns: 0, stopped: 'interrupted' });
    expect(api.chats).toHaveLength(0);

    let stop = false;
    api.replies = [{ calls: [{ id: 'call_a', name: 'list_files', arguments: { directory: '' } }] }];
    expect(await run(provider(), { shouldStop: () => stop, onUsage: () => (stop = true) })).toEqual({ text: '', turns: 1, stopped: 'interrupted' });
  });

  it('sends a turn again after a failure that may pass, without starting the run over', async () => {
    api.replies = [
      { calls: [{ id: 'call_a', name: 'list_files', arguments: { directory: '' } }] },
      { status: 500, error: 'upstream error' },
      { content: 'half a rep', cut: true },
      { content: 'Done.' },
    ];
    const usage: CallUsage[] = [];
    const result = await run(provider(), { onUsage: (u) => usage.push(u) });
    expect(result).toEqual({ text: 'Done.', turns: 2, stopped: 'done' });
    // Four requests for two turns: the second turn was sent three times, each time with the same history.
    expect(api.chats).toHaveLength(4);
    expect(api.chats[2].messages).toEqual(api.chats[1].messages);
    expect(api.chats[3].messages).toEqual(api.chats[1].messages);
    // The request that was refused cost nothing. The reply that was lost part-way did.
    expect(usage).toHaveLength(3);
  });

  it('counts a reply that was lost part-way: as the endpoint reported it if it did, and by its length if not', async () => {
    api.replies = [
      // The connection drops with 4,000 characters written and nothing said of tokens.
      { content: 'x'.repeat(4000), cut: true },
      // The stream closes in good order, token counts and all, without the reply ever being finished.
      { content: 'I have written half of the rep', unfinished: true },
      { content: 'Done.' },
    ];
    const usage: CallUsage[] = [];
    expect(await run(provider(), { onUsage: (u) => usage.push(u) })).toEqual({ text: 'Done.', turns: 1, stopped: 'done' });
    // Each of the three replies is counted once.
    expect(usage).toHaveLength(3);
    // About four characters to a token, for what was written and for the prompt it answered.
    expect(usage[0]!.outputTokens).toBe(1000);
    expect(usage[0]!.inputTokens).toBe(Math.ceil(JSON.stringify(api.chats[0].messages).length / 4));
    expect(usage[0]!.costUsd).toBeCloseTo((usage[0]!.inputTokens * 2 + 1000 * 10) / 1e6, 10);
    expect(usage[1]).toMatchObject({ inputTokens: 1000, outputTokens: 200 });
    expect(usage[2]).toMatchObject({ inputTokens: 1000, outputTokens: 200 });
  });

  it('counts nothing for a call that was stopped on purpose', async () => {
    const stop = new AbortController();
    api.replies = [{ content: 'x'.repeat(4000), hold: true }];
    const usage: CallUsage[] = [];
    const call = run(provider(), { signal: stop.signal, onUsage: (u) => usage.push(u) }).catch((e) => e);
    // The endpoint is part-way through its reply when the call is cut off.
    await waitFor(() => api.chats.length === 1, 'the request to arrive');
    await new Promise((resolve) => setTimeout(resolve, 50));
    stop.abort();
    expect(await call).toBeInstanceOf(ProviderError);
    expect(usage).toHaveLength(0);
  });

  it('reads the endings some endpoints have names of their own for', async () => {
    // Withheld by the provider's content rules.
    api.replies = [{ content: '', finish: 'sensitive' }];
    expect(await run(provider()).catch((e) => e)).toMatchObject({ code: 'refusal', retryable: false });

    // Lost on the provider's side: the turn is asked for again, with the same history, and its tool call is not run twice.
    api.replies = [
      { calls: [{ id: 'call_a', name: 'write_file', arguments: { path: 'a.md', content: 'A' } }], finish: 'network_error' },
      { calls: [{ id: 'call_a', name: 'write_file', arguments: { path: 'a.md', content: 'A' } }] },
      { content: 'Done.' },
    ];
    api.seen.length = 0;
    const usage: CallUsage[] = [];
    expect(await run(provider(), { onUsage: (u) => usage.push(u) })).toEqual({ text: 'Done.', turns: 2, stopped: 'done' });
    expect(api.chats[1].messages).toEqual(api.chats[0].messages);
    // The lost reply was still paid for.
    expect(usage).toHaveLength(3);

    // One that keeps being lost is given up on, not asked for without end.
    api.seen.length = 0;
    api.replies = Array.from({ length: 6 }, () => ({ content: 'half', finish: 'network_error' }));
    expect(await run(provider()).catch((e) => e)).toMatchObject({ code: 'unavailable', retryable: true });
    expect(api.chats).toHaveLength(4);

    // Another provider's name for the same thing.
    api.seen.length = 0;
    api.replies = [{ content: '', finish: 'insufficient_system_resource' }, { content: 'Done.' }];
    expect(await run(provider())).toEqual({ text: 'Done.', turns: 1, stopped: 'done' });
    expect(api.chats).toHaveLength(2);

    api.replies = [{ content: '', finish: 'model_context_window_exceeded' }];
    expect(await run(provider()).catch((e) => e)).toMatchObject({ code: 'bad_request', retryable: false });
  });

  it('does not take a reply for finished when the stream closed without saying so', async () => {
    // As when something between here and the provider times out and closes the stream in good order.
    api.replies = [{ content: 'I have written half of the rep', unfinished: true }, { content: 'I have written the report.' }];
    const usage: CallUsage[] = [];
    expect(await run(provider(), { onUsage: (u) => usage.push(u) })).toEqual({ text: 'I have written the report.', turns: 1, stopped: 'done' });
    expect(api.chats).toHaveLength(2);
    // The half that arrived was paid for, and so was the whole that followed.
    expect(usage).toHaveLength(2);
    // One that never finishes is given up on, as a fault that may pass.
    api.replies = Array.from({ length: 6 }, () => ({ content: 'half', unfinished: true }));
    expect(await run(provider()).catch((e) => e)).toMatchObject({ code: 'unavailable', retryable: true, message: expect.stringContaining('without saying it was finished') });
    // An endpoint that does not stream says how the reply ended in the reply itself.
    api.rules = [(b) => (b.stream ? 'stream is not supported' : undefined)];
    api.replies = [{ content: 'Whole.' }];
    expect((await run(provider())).text).toBe('Whole.');
  });

  it('counts what the model wrote into a tool call when the endpoint reports no tokens', async () => {
    api.replies = [{ calls: [{ id: 'call_a', name: 'write_file', arguments: { path: 'big.md', content: 'x'.repeat(48_000) } }], usage: null }, { content: 'Done.', usage: null }];
    const usage: CallUsage[] = [];
    await run(provider(), { onUsage: (u) => usage.push(u) });
    // About four characters to a token: the file's 48,000 characters are some 12,000 tokens of output, not none.
    expect(usage[0]!.outputTokens).toBeGreaterThan(12_000);
    expect(usage[0]!.outputTokens).toBeLessThan(13_000);
    expect(usage[0]!.costUsd).toBeGreaterThan(0.12);
  });

  it('takes two calls sent whole under the same number for two calls', async () => {
    api.replies = [
      { calls: [{ id: 'call_a', name: 'write_file', arguments: { path: 'a.md', content: 'A' }, whole: true, index: 0 }, { id: 'call_b', name: 'write_file', arguments: { path: 'b.md', content: 'B' }, whole: true, index: 0 }] },
      { content: 'Done.' },
    ];
    await run(provider());
    expect(files).toMatchObject({ 'a.md': 'A', 'b.md': 'B' });
    expect(api.chats[1].messages.slice(2).map((m: any) => [m.role, m.tool_call_id ?? m.tool_calls.map((c: any) => c.id)])).toEqual([
      ['assistant', ['call_a', 'call_b']],
      ['tool', 'call_a'],
      ['tool', 'call_b'],
    ]);
  });

  it('never runs a tool call that was cut off at the output limit', async () => {
    api.replies = [{ calls: [{ id: 'call_a', name: 'write_file', arguments: '{"path":"x.md","content":"ha' }], finish: 'length' }];
    expect(await run(provider()).catch((e) => e)).toMatchObject({ code: 'truncated', retryable: true });
    expect(files['x.md']).toBeUndefined();
  });

  it('says what went wrong in terms a person can act on', async () => {
    const p = provider();
    api.replies = [{ status: 401, error: 'Incorrect API key provided.' }];
    expect(await run(p).catch((e) => e)).toMatchObject({ code: 'auth', retryable: false, message: expect.stringContaining('Testco rejected the API key') });
    api.replies = [{ status: 429, error: 'You exceeded your current quota, please check your plan and billing details.' }];
    expect(await run(p).catch((e) => e)).toMatchObject({ code: 'auth', retryable: false, message: expect.stringContaining('out of credit or quota') });
    api.replies = [{ status: 402, error: 'Insufficient Balance' }];
    expect(await run(p).catch((e) => e)).toMatchObject({ code: 'auth', retryable: false });
    api.replies = Array.from({ length: 4 }, () => ({ status: 429, error: 'Rate limit reached for requests' }));
    expect(await run(p).catch((e) => e)).toMatchObject({ code: 'rate_limit', retryable: true });
    // A provider that quotes the key back in its refusal does not get it into anything shown or kept.
    api.replies = [{ status: 401, error: 'The key sk-test is not valid for this project.' }];
    const quoted = await run(p).catch((e) => e);
    expect(quoted.message).toContain('The key [the key] is not valid');
    expect(quoted.message).not.toContain('sk-test');
    // One provider answers a wrong key with a 400 rather than a 401. It is still the key that is wrong.
    api.replies = [{ status: 400, error: 'Please pass a valid API key' }];
    expect(await run(p).catch((e) => e)).toMatchObject({ code: 'auth', retryable: false, message: expect.stringContaining('rejected the API key') });
    // A refusal that is plainly not about the form of the request is reported at once, not worked around.
    api.seen.length = 0;
    api.replies = [{ status: 400, error: 'The model `nope` does not exist' }];
    expect(await run(p).catch((e) => e)).toMatchObject({ code: 'bad_request', retryable: false, message: expect.stringContaining('does not exist') });
    expect(api.chats).toHaveLength(1);
  });
});

describe('what a key can call', () => {
  it('lists the chat models and leaves out the ones that are not for chat', async () => {
    api.models = ['big-model', 'small-model', 'text-embedding-3-large', 'tts-1', 'whisper-1', 'gpt-image-2', 'omni-moderation-latest', 'gpt-realtime'].map((id) => ({ id, object: 'model' }));
    expect((await provider().listModels()).map((m) => m.id)).toEqual(['big-model', 'small-model']);
    // A listing that puts "models/" in front of its ids gives the ids the chat endpoint is called with.
    api.models = [{ id: 'models/gem-pro', display_name: 'Gem Pro' }, { id: 'models/text-embedding-9' }];
    expect(await provider().listModels()).toEqual([{ id: 'gem-pro', name: 'Gem Pro' }]);
  });

  it('reads the names, prices and abilities a gateway\'s listing carries', async () => {
    api.models = [
      {
        id: 'maker/model-a',
        name: 'Maker: Model A',
        context_length: 200000,
        pricing: { prompt: '0.000003', completion: '0.000015', input_cache_read: '0.0000003', input_cache_write: '0.00000375' },
        top_provider: { max_completion_tokens: 64000 },
        supported_parameters: ['tools', 'temperature', 'reasoning', 'reasoning_effort'],
        reasoning: { mandatory: true, supported_efforts: ['xhigh', 'high', 'medium', 'low'], default_effort: 'xhigh' },
      },
      { id: 'maker/model-b', name: 'Maker: Model B', pricing: { prompt: '0', completion: '0' }, supported_parameters: ['temperature'] },
    ];
    expect(await provider().listModels()).toEqual([
      { id: 'maker/model-a', name: 'Maker: Model A', contextWindow: 200000, maxOutput: 64000, price: { input: 3, output: 15, cached: 0.3, cacheWrite: 3.75 }, tools: true, efforts: ['xhigh', 'high', 'medium', 'low'] },
      // Free, cannot call tools, and takes no effort level: each said by what its entry leaves out.
      { id: 'maker/model-b', name: 'Maker: Model B', price: { input: 0, output: 0 }, tools: false, efforts: null },
    ]);
  });

  it('reads what a maker\'s own listing says about a model, in whichever words it says it', async () => {
    api.models = [
      { id: 'deep-flash', name: 'Deep Flash', context_window: 1000000, max_output_tokens: 393216, effort: { supported_levels: ['low', 'high', 'max'], default_level: 'high' } },
      { id: 'seed-pro', context_window: 256000, features: { tools: { function_calling: true }, structured_outputs: { json_schema: false } } },
      { id: 'le-large', max_context_length: 131072, capabilities: { completion_chat: true, function_calling: false } },
      { id: 'bare' },
    ];
    expect(await provider().listModels()).toEqual([
      { id: 'deep-flash', name: 'Deep Flash', contextWindow: 1000000, maxOutput: 393216, efforts: ['low', 'high', 'max'] },
      { id: 'seed-pro', contextWindow: 256000, tools: true },
      { id: 'le-large', contextWindow: 131072, tools: false },
      { id: 'bare' },
    ]);
  });

  it('says so when the endpoint will not take the key', async () => {
    api.key = 'sk-right';
    expect(await provider().listModels().catch((e) => e)).toMatchObject({ code: 'auth', retryable: false });
  });
});
