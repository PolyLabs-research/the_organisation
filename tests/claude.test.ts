import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ClaudeProvider } from '../src/server/providers/claude';
import { ProviderError, type AgentTool, type CallUsage } from '../src/server/providers/types';
import { waitFor } from './helpers';

// These tests run the Claude provider against a local stand-in for the
// Messages API that speaks the same streaming protocol. They check what the
// provider sends and how it handles what comes back; they cannot check that
// the real API accepts the requests.

type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown; rawInput?: string }
  /** Any other block, sent whole as the stream announces it. */
  | { type: 'raw'; block: Record<string, unknown> };
interface Reply {
  status?: number;
  error?: { type: string; message: string };
  content?: Block[];
  stop_reason?: string;
  model?: string;
  /** Extra fields for the usage reported at the end of the reply. */
  usage?: Record<string, unknown>;
  /** Drop the connection part-way through the reply. */
  cut?: boolean;
  /** Start the reply and then say nothing more, with the connection left open. */
  hold?: boolean;
  /** Start the reply and then end the stream in good order, as something on the way that times out can. */
  unfinished?: boolean;
  /** Answer 200 with nothing in it at all. */
  empty?: boolean;
}
interface Seen {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: any;
}

let server: http.Server;
let baseURL: string;
let replies: Reply[] = [];
let seen: Seen[] = [];

function sse(reply: Reply): string {
  const events: Array<[string, unknown]> = [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: reply.model ?? 'claude-opus-5-5',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 900, cache_creation_input_tokens: 50 },
        },
      },
    ],
  ];
  (reply.content ?? []).forEach((block, index) => {
    if (block.type === 'text') {
      events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }]);
      events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } }]);
    } else if (block.type === 'raw') {
      events.push(['content_block_start', { type: 'content_block_start', index, content_block: block.block }]);
    } else {
      events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } }]);
      events.push([
        'content_block_delta',
        { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: block.rawInput ?? JSON.stringify(block.input) } },
      ]);
    }
    events.push(['content_block_stop', { type: 'content_block_stop', index }]);
  });
  events.push(['message_delta', { type: 'message_delta', delta: { stop_reason: reply.stop_reason ?? 'end_turn', stop_sequence: null }, usage: { output_tokens: 40, ...reply.usage } }]);
  events.push(['message_stop', { type: 'message_stop' }]);
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      seen.push({ path: req.url ?? '', headers: req.headers, body: raw ? JSON.parse(raw) : null });
      const reply = replies.shift() ?? { content: [{ type: 'text', text: 'unexpected call' }] };
      if (reply.status && reply.status >= 400) {
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: reply.error ?? { type: 'api_error', message: 'failed' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (reply.empty) return void res.end();
      if (reply.cut || reply.hold || reply.unfinished) {
        // The reply starts, then the connection goes away, or goes quiet, or the stream just ends.
        res.write(sse(reply).split('\n\n').slice(0, 2).join('\n\n') + '\n\n');
        if (reply.cut) setTimeout(() => res.destroy(), 5);
        if (reply.unfinished) res.end();
        return;
      }
      res.end(sse(reply));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  replies = [];
  seen = [];
});

const provider = () => new ClaudeProvider({ apiKey: 'test-key', baseURL, maxRetries: 0, turnRetryDelayMs: 0 });
const system = { charter: 'The charter.', role: 'The role.' };
const Answer = z.object({ verdict: z.enum(['pass', 'rework']), summary: z.string() });

function structuredRequest(onUsage?: (usage: CallUsage) => void) {
  return { kind: 'phase_review' as const, system, prompt: 'Review the phase.', schema: Answer, model: 'claude-opus-5-5', effort: 'medium' as const, onUsage, context: {} };
}

async function failure(promise: Promise<unknown>): Promise<ProviderError> {
  const err = await promise.then(
    () => null,
    (e) => e,
  );
  expect(err).toBeInstanceOf(ProviderError);
  return err as ProviderError;
}

describe('structured calls', () => {
  it('sends a request the current models accept and returns the parsed reply', async () => {
    replies.push({ content: [{ type: 'text', text: JSON.stringify({ verdict: 'pass', summary: 'Good.' }) }] });
    const usage: CallUsage[] = [];
    const data = await provider().structured(structuredRequest((u) => usage.push(u)));
    expect(data).toEqual({ verdict: 'pass', summary: 'Good.' });

    const { body, headers } = seen[0]!;
    expect(body.model).toBe('claude-opus-5-5');
    expect(body.stream).toBe(true);
    expect(body.output_config.effort).toBe('medium');
    expect(body.output_config.format.type).toBe('json_schema');
    // Enums reach the API as enums, so a reply can only pick from the values on offer.
    expect(body.output_config.format.schema.properties.verdict.enum).toEqual(['pass', 'rework']);
    expect(body.output_config.format.schema.additionalProperties).toBe(false);
    expect(body.output_config.format.schema).not.toHaveProperty('$schema');
    // Refusal fallback is opted into on every request.
    expect(body.fallbacks).toBe('default');
    expect(String(headers['anthropic-beta'])).toContain('server-side-fallback-2026-07-01');
    // Both system blocks are cache breakpoints, charter first.
    expect(body.system).toEqual([
      { type: 'text', text: 'The charter.', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'The role.', cache_control: { type: 'ephemeral' } },
    ]);
    expect(body.messages).toEqual([{ role: 'user', content: 'Review the phase.' }]);
    // Parameters the current models reject must not be sent.
    for (const banned of ['thinking', 'temperature', 'top_p', 'top_k', 'tool_choice']) expect(body).not.toHaveProperty(banned);

    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ model: 'claude-opus-5-5', inputTokens: 100, outputTokens: 40, cacheReadTokens: 900, cacheWriteTokens: 50 });
    // 100 in at $4, 40 out at $20, 900 cache reads at $0.20, 50 cache writes at $5, per million.
    expect(usage[0]!.costUsd).toBeCloseTo((100 * 4 + 40 * 20 + 900 * 0.2 + 50 * 5) / 1e6, 10);
  });

  it('strips the constraints structured outputs reject, at every depth', async () => {
    replies.push({ content: [{ type: 'text', text: JSON.stringify({ count: 2, items: [{ minimum: 'kept', n: 1 }] }) }] });
    const schema = z.object({ count: z.number().int(), items: z.array(z.object({ minimum: z.string(), n: z.number().int() })) });
    await provider().structured({ ...structuredRequest(), schema });
    const sent = seen[0]!.body.output_config.format.schema;
    expect(sent.properties.count).toEqual({ type: 'integer' });
    // A property that happens to be called "minimum" is a property, not a constraint.
    expect(sent.properties.items.items.properties.minimum).toEqual({ type: 'string' });
    expect(sent.properties.items.items.properties.n).toEqual({ type: 'integer' });
    expect(sent.properties.items.items.additionalProperties).toBe(false);
  });

  it('falls back to the conservative schema form if the API refuses the strict one, and remembers', async () => {
    const reply = { content: [{ type: 'text' as const, text: JSON.stringify({ verdict: 'rework', summary: 'Gaps.' }) }] };
    replies.push({ status: 400, error: { type: 'invalid_request_error', message: 'output_config.format.schema: unsupported keyword' } }, reply, reply);
    const claude = provider();
    expect(await claude.structured(structuredRequest())).toEqual({ verdict: 'rework', summary: 'Gaps.' });
    expect(seen).toHaveLength(2);
    expect(seen[1]!.body.output_config.format.schema.properties.verdict).not.toHaveProperty('enum');
    expect(seen[1]!.body.output_config.format.schema.properties.verdict.description).toContain('rework');
    await claude.structured(structuredRequest());
    expect(seen).toHaveLength(3);
    expect(seen[2]!.body.output_config.format.schema.properties.verdict).not.toHaveProperty('enum');
  });

  it('rejects a reply that is valid JSON but not what was asked for', async () => {
    replies.push({ content: [{ type: 'text', text: JSON.stringify({ verdict: 'maybe', summary: 'Hm.' }) }] });
    const err = await failure(provider().structured(structuredRequest()));
    expect(err.code).toBe('invalid_output');
    expect(err.retryable).toBe(true);
    expect(err.message).toContain('verdict');
  });

  it('reports a refusal as such and does not ask for a retry', async () => {
    replies.push({ content: [], stop_reason: 'refusal' });
    const err = await failure(provider().structured(structuredRequest()));
    expect(err.code).toBe('refusal');
    expect(err.retryable).toBe(false);
  });

  it('takes a request the content filter turned away with an error for a refusal, and sends it once', async () => {
    replies.push({ status: 400, error: { type: 'invalid_request_error', message: 'Output blocked by content filtering policy' } });
    const err = await failure(provider().structured(structuredRequest()));
    expect([err.code, err.retryable]).toEqual(['refusal', false]);
    // Not tried again with the other form of the schema: it was not the schema that was refused.
    expect(seen).toHaveLength(1);
  });

  it('treats a reply cut off at the token limit as retryable', async () => {
    replies.push({ content: [{ type: 'text', text: '{"verdict":"pa' }], stop_reason: 'max_tokens' });
    const err = await failure(provider().structured(structuredRequest()));
    expect(err.code).toBe('truncated');
    expect(err.retryable).toBe(true);
  });

  it('still counts the spend when the reply is unusable', async () => {
    replies.push({ content: [{ type: 'text', text: '{"verdict":"pa' }], stop_reason: 'max_tokens' });
    const usage: CallUsage[] = [];
    await failure(provider().structured(structuredRequest((u) => usage.push(u))));
    expect(usage).toHaveLength(1);
  });

  it('treats a connection lost part-way through a reply as something that may pass', async () => {
    replies.push({ content: [{ type: 'text', text: JSON.stringify({ verdict: 'pass', summary: 'Good.' }) }], cut: true });
    const err = await failure(provider().structured(structuredRequest()));
    expect(err.code).toBe('unavailable');
    expect(err.retryable).toBe(true);
  });

  it('treats a reply that stops arriving, with the connection closed in good order, the same way', async () => {
    replies.push({ content: [{ type: 'text', text: JSON.stringify({ verdict: 'pass', summary: 'Good.' }) }], unfinished: true });
    const err = await failure(provider().structured(structuredRequest()));
    expect([err.code, err.retryable]).toEqual(['unavailable', true]);
    expect(err.message).toContain('ended before it was complete');
    // So too an answer with nothing in it, which is not a reply at all.
    replies.push({ empty: true });
    const none = await failure(provider().structured(structuredRequest()));
    expect([none.code, none.retryable]).toEqual(['unavailable', true]);
  });

  it('counts what a reply had said it read by the time the connection was lost', async () => {
    replies.push({ content: [{ type: 'text', text: JSON.stringify({ verdict: 'pass', summary: 'Good.' }) }], cut: true });
    const usage: CallUsage[] = [];
    await failure(provider().structured(structuredRequest((u) => usage.push(u))));
    // The reply never finished, but it had started, and what it had read by then was paid for.
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ model: 'claude-opus-5-5', inputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 50 });
    expect(usage[0]!.costUsd).toBeCloseTo((100 * 4 + 900 * 0.2 + 50 * 5) / 1e6, 10);
  });

  it('counts nothing for a call that was stopped on purpose', async () => {
    replies.push({ content: [{ type: 'text', text: 'never finished' }], hold: true });
    const stop = new AbortController();
    const usage: CallUsage[] = [];
    const call = failure(provider().structured({ ...structuredRequest((u) => usage.push(u)), signal: stop.signal }));
    await waitFor(() => seen.length === 1, 'the request to arrive');
    await new Promise((resolve) => setTimeout(resolve, 50));
    stop.abort();
    expect((await call).code).toBe('aborted');
    expect(usage).toHaveLength(0);
  });

  it('treats work that outgrew the context window as a failure of the work, not of the provider', async () => {
    replies.push({ content: [], stop_reason: 'model_context_window_exceeded' });
    const err = await failure(provider().structured(structuredRequest()));
    expect(err.code).toBe('too_long');
    expect(err.retryable).toBe(false);
  });

  it.each([
    [400, 'prompt is too long: 210432 tokens > 200000 maximum'],
    [400, 'input length and `max_tokens` exceed context limit: 180000 + 32000 > 200000, decrease input length or `max_tokens` and try again'],
    [413, 'Request exceeds the maximum allowed number of bytes.'],
  ])('says the same when the API turns the request itself away as too long (%i: %s)', async (status, message) => {
    replies.push({ status, error: { type: status === 413 ? 'request_too_large' : 'invalid_request_error', message } });
    const err = await failure(provider().structured(structuredRequest()));
    expect([err.code, err.retryable]).toEqual(['too_long', false]);
    expect(err.message).toContain(message);
    // Not tried again with the other form of the schema: it would be as long.
    expect(seen).toHaveLength(1);
  });

  it('prices every attempt at the rates of the model that made it', async () => {
    replies.push({
      content: [{ type: 'text', text: JSON.stringify({ verdict: 'pass', summary: 'Good.' }) }],
      model: 'claude-opus-4-8',
      // The requested model declined part-way; a fallback model then answered.
      usage: {
        iterations: [
          { type: 'message', model: 'claude-opus-5-5', input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: null },
          { type: 'fallback_message', model: 'claude-opus-4-8', input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0, cache_creation: null },
        ],
      },
    });
    const usage: CallUsage[] = [];
    await provider().structured(structuredRequest((u) => usage.push(u)));
    expect(usage[0]).toMatchObject({ model: 'claude-opus-4-8', inputTokens: 2000, outputTokens: 600, cacheReadTokens: 2000 });
    const declined = (1000 * 4 + 100 * 20) / 1e6;
    const fallback = (1000 * 5 + 500 * 25 + 2000 * 0.5) / 1e6;
    expect(usage[0]!.costUsd).toBeCloseTo(declined + fallback, 10);
  });

  it('reads the answer of a fallback model that took over after the first model had begun one', async () => {
    const marker = { type: 'raw' as const, block: { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-4-8' }, trigger: { type: 'refusal' } } };
    // The fallback wrote the answer afresh: what the first model had written of it is not part of it.
    replies.push({ content: [{ type: 'text', text: '{"verdict":"rew' }, marker, { type: 'text', text: JSON.stringify({ verdict: 'pass', summary: 'Good.' }) }], model: 'claude-opus-4-8' });
    expect(await provider().structured(structuredRequest())).toEqual({ verdict: 'pass', summary: 'Good.' });
    // The fallback carried on from where the first model stopped: the answer is the two together.
    replies.push({ content: [{ type: 'text', text: '{"verdict":"pa' }, marker, { type: 'text', text: 'ss","summary":"Good."}' }], model: 'claude-opus-4-8' });
    expect(await provider().structured(structuredRequest())).toEqual({ verdict: 'pass', summary: 'Good.' });
  });

  it('takes the key out of a refusal that quotes it back, before the refusal is shown or kept', async () => {
    replies.push({ status: 401, error: { type: 'authentication_error', message: 'invalid x-api-key: test-key has been revoked' } });
    const err = await failure(provider().structured(structuredRequest()));
    expect(err.code).toBe('auth');
    expect(err.message).toContain('invalid x-api-key: [the key] has been revoked');
    expect(err.message).not.toContain('test-key');
    // An agent's call meets the same refusal the same way.
    replies.push({ status: 401, error: { type: 'authentication_error', message: 'invalid x-api-key: test-key has been revoked' } });
    const met = await failure(provider().agent({ kind: 'task', system, prompt: 'Write the spec.', model: 'claude-opus-5-5', effort: 'medium', tools: [], webSearch: null, maxTurns: 10, context: {} }));
    expect(met.message).not.toContain('test-key');
  });

  it.each([
    [401, 'authentication_error', 'auth', false],
    [403, 'permission_error', 'auth', false],
    [400, 'invalid_request_error', 'bad_request', false],
    [429, 'rate_limit_error', 'rate_limit', true],
    [529, 'overloaded_error', 'unavailable', true],
  ])('maps HTTP %i to a %s error', async (status, type, code, retryable) => {
    // A 400 is tried once more with the conservative schema form before it is reported.
    replies.push({ status, error: { type, message: 'nope' } }, { status, error: { type, message: 'nope' } });
    const err = await failure(provider().structured(structuredRequest()));
    expect(err.code).toBe(code);
    expect(err.retryable).toBe(retryable);
    expect(seen).toHaveLength(status === 400 ? 2 : 1);
  });
});

describe('agent runs', () => {
  const written: Array<{ path: string; content: string }> = [];
  const WriteInput = z.object({ path: z.string(), content: z.string() });
  const tools: AgentTool[] = [
    {
      name: 'write_file',
      description: 'Write a file.',
      schema: WriteInput,
      async run(input) {
        const parsed = WriteInput.parse(input);
        if (parsed.path.startsWith('..')) throw new Error('path escapes the workspace');
        written.push(parsed);
        return `Wrote ${parsed.path}.`;
      },
    },
  ];
  const agentRequest = (extra: Partial<Parameters<ClaudeProvider['agent']>[0]> = {}) => ({
    kind: 'task' as const,
    system,
    prompt: 'Write the spec.',
    model: 'claude-opus-5-5',
    effort: 'medium' as const,
    tools,
    webSearch: null,
    maxTurns: 10,
    context: {},
    ...extra,
  });
  beforeEach(() => {
    written.length = 0;
  });

  it('runs the tools the model calls and returns its closing report', async () => {
    replies.push({
      content: [
        { type: 'text', text: 'Writing the spec now.' },
        { type: 'tool_use', id: 'toolu_1', name: 'write_file', input: { path: 'engineering/spec.md', content: '# Spec' } },
      ],
      stop_reason: 'tool_use',
    });
    replies.push({ content: [{ type: 'text', text: 'Produced engineering/spec.md.' }] });
    const usage: CallUsage[] = [];
    const result = await provider().agent(agentRequest({ onUsage: (u) => usage.push(u) }));

    expect(result).toEqual({ text: 'Produced engineering/spec.md.', turns: 2, stopped: 'done' });
    expect(written).toEqual([{ path: 'engineering/spec.md', content: '# Spec' }]);
    expect(usage).toHaveLength(2);

    const first = seen[0]!.body;
    expect(first.tools).toHaveLength(1);
    expect(first.tools[0]).toMatchObject({ name: 'write_file', eager_input_streaming: true });
    expect(first.tools[0].input_schema).toMatchObject({ type: 'object', required: ['path', 'content'] });
    expect(first.tools[0].input_schema).not.toHaveProperty('$schema');
    expect(first.cache_control).toEqual({ type: 'ephemeral' });
    expect(first.fallbacks).toBe('default');
    expect(first).not.toHaveProperty('output_config.format');

    // The second request replays the first turn untouched and answers the tool call.
    const second = seen[1]!.body;
    expect(second.messages).toHaveLength(3);
    expect(second.messages[0]).toEqual(first.messages[0]);
    expect(second.messages[1].role).toBe('assistant');
    expect(second.messages[1].content.map((b: any) => b.type)).toEqual(['text', 'tool_use']);
    expect(second.messages[2]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Wrote engineering/spec.md.' }] });
    expect(second.tools).toEqual(first.tools);
    expect(second.system).toEqual(first.system);
  });

  it('shows the model a tool’s own schema where it brings one, and hands the tool what the model sent', async () => {
    const taken: unknown[] = [];
    const parameters = { type: 'object', properties: { number: { type: 'string', description: 'The order number' }, on: { type: 'string', format: 'date' } }, required: ['number'] };
    const connected: AgentTool = { name: 'orders__find_order', description: 'Look up an order.', schema: z.record(z.string(), z.unknown()), parameters, run: async (input) => (taken.push(input), 'Found.') };
    replies.push({ content: [{ type: 'tool_use', id: 'toolu_1', name: 'orders__find_order', input: { number: 'A-17', on: '2026-11-10' } }], stop_reason: 'tool_use' });
    replies.push({ content: [{ type: 'text', text: 'Done.' }] });
    await provider().agent(agentRequest({ tools: [...tools, connected] }));
    expect(seen[0]!.body.tools[1]).toEqual({ name: 'orders__find_order', description: 'Look up an order.', input_schema: parameters, eager_input_streaming: true });
    expect(taken).toEqual([{ number: 'A-17', on: '2026-11-10' }]);
  });

  it('offers web search and page reading only when the organisation allows it', async () => {
    replies.push({ content: [{ type: 'text', text: 'Done.' }] });
    await provider().agent(agentRequest({ webSearch: { perRequest: 3, perTask: 8 } }));
    expect(seen[0]!.body.tools.slice(-2)).toEqual([
      { type: 'web_search_20260209', name: 'web_search', max_uses: 3 },
      { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 4, max_content_tokens: 20_000 },
    ]);
    // Haiku does not run the self-filtering search tool, so it is given the basic one.
    replies.push({ content: [{ type: 'text', text: 'Done.' }] });
    await provider().agent(agentRequest({ webSearch: { perRequest: 2, perTask: 8 }, model: 'claude-haiku-5-5' }));
    expect(seen[1]!.body.tools.slice(-2)).toEqual([
      { type: 'web_search_20250305', name: 'web_search', max_uses: 2 },
      { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 4, max_content_tokens: 20_000 },
    ]);
    replies.push({ content: [{ type: 'text', text: 'Done.' }] });
    await provider().agent(agentRequest());
    expect(seen[2]!.body.tools.some((t: { name: string }) => t.name === 'web_search' || t.name === 'web_fetch')).toBe(false);
  });

  it('hands a tool error back to the model instead of failing the run', async () => {
    replies.push({ content: [{ type: 'tool_use', id: 'toolu_1', name: 'write_file', input: { path: '../outside.md', content: 'x' } }], stop_reason: 'tool_use' });
    replies.push({ content: [{ type: 'text', text: 'Could not write there.' }] });
    const result = await provider().agent(agentRequest());
    expect(result.stopped).toBe('done');
    expect(seen[1]!.body.messages[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_1', is_error: true, content: 'Error: path escapes the workspace' });
  });

  it('does not run a tool whose input fails validation, or one it does not know', async () => {
    replies.push({
      content: [
        { type: 'tool_use', id: 'toolu_1', name: 'write_file', input: { path: 'a.md' } },
        { type: 'tool_use', id: 'toolu_2', name: 'delete_everything', input: {} },
      ],
      stop_reason: 'tool_use',
    });
    replies.push({ content: [{ type: 'text', text: 'Stopping.' }] });
    await provider().agent(agentRequest());
    expect(written).toEqual([]);
    const results = seen[1]!.body.messages[2].content;
    expect(results[0]).toMatchObject({ tool_use_id: 'toolu_1', is_error: true });
    expect(JSON.parse(results[0].content)).toHaveProperty('INVALID_JSON');
    expect(results[1]).toMatchObject({ tool_use_id: 'toolu_2', is_error: true, content: 'Unknown tool: delete_everything' });
  });

  it('never runs a tool call that was cut off at the token limit', async () => {
    replies.push({ content: [{ type: 'tool_use', id: 'toolu_1', name: 'write_file', input: { path: 'a.md', content: 'half a fi' } }], stop_reason: 'max_tokens' });
    const err = await failure(provider().agent(agentRequest()));
    expect(err.code).toBe('truncated');
    expect(written).toEqual([]);
  });

  it('says so when the closing report was cut off at the token limit, and takes nothing at all for no report', async () => {
    replies.push({ content: [{ type: 'text', text: 'I produced engineering/spec.md and the remaining wo' }], stop_reason: 'max_tokens' });
    expect(await provider().agent(agentRequest())).toEqual({ text: 'I produced engineering/spec.md and the remaining wo', turns: 1, stopped: 'cut_short' });
    // All of the room went on thinking: there is no report to keep, and another try may do better.
    replies.push({ content: [], stop_reason: 'max_tokens' });
    const err = await failure(provider().agent(agentRequest()));
    expect([err.code, err.retryable]).toEqual(['truncated', true]);
  });

  it('asks for a closing report at the turn limit and stops there', async () => {
    const call = (id: string): Reply => ({ content: [{ type: 'tool_use', id, name: 'write_file', input: { path: `${id}.md`, content: 'x' } }], stop_reason: 'tool_use' });
    replies.push(call('toolu_1'), call('toolu_2'), { content: [{ type: 'text', text: 'Out of turns; two files written.' }] });
    const result = await provider().agent(agentRequest({ maxTurns: 2 }));
    expect(result).toEqual({ text: 'Out of turns; two files written.', turns: 3, stopped: 'cut_short' });
    expect(written).toHaveLength(2);
    const last = seen[2]!.body.messages.at(-1);
    expect(last.content.at(-1).type).toBe('text');
    expect(last.content.at(-1).text).toContain('Do not call any more tools');
  });

  it('stops without running more tools if the model ignores the turn limit', async () => {
    const call = (id: string): Reply => ({ content: [{ type: 'tool_use', id, name: 'write_file', input: { path: `${id}.md`, content: 'x' } }], stop_reason: 'tool_use' });
    replies.push(call('toolu_1'), call('toolu_2'));
    const result = await provider().agent(agentRequest({ maxTurns: 1 }));
    expect(result.stopped).toBe('cut_short');
    expect(written).toHaveLength(1);
    expect(seen).toHaveLength(2);
  });

  it('resumes a turn the server paused, without adding a message of its own', async () => {
    replies.push({ content: [{ type: 'text', text: 'Searching…' }], stop_reason: 'pause_turn' });
    replies.push({ content: [{ type: 'text', text: 'Found it.' }] });
    const result = await provider().agent(agentRequest());
    expect(result.text).toBe('Found it.');
    const messages = seen[1]!.body.messages;
    expect(messages.map((m: any) => m.role)).toEqual(['user', 'assistant']);
  });

  it('gives up on a turn that keeps pausing, not on a run in which several turns each paused and went on', async () => {
    const call = (id: string): Reply => ({ content: [{ type: 'tool_use', id, name: 'write_file', input: { path: `${id}.md`, content: 'x' } }], stop_reason: 'tool_use' });
    const pause: Reply = { content: [{ type: 'text', text: 'Searching…' }], stop_reason: 'pause_turn' };
    // Six turns, each paused once by the server and then finished.
    for (let i = 1; i <= 6; i++) replies.push(pause, call(`toolu_${i}`));
    replies.push({ content: [{ type: 'text', text: 'Six files written.' }] });
    const result = await provider().agent(agentRequest({ maxTurns: 24 }));
    expect(result).toMatchObject({ text: 'Six files written.', stopped: 'done' });
    expect(written).toHaveLength(6);
    // One turn that is paused six times running is not going to finish.
    replies.push(pause, pause, pause, pause, pause, pause);
    const err = await failure(provider().agent(agentRequest()));
    expect([err.code, err.retryable]).toEqual(['unavailable', true]);
    expect(err.message).toContain('kept pausing');
  });

  it('stops between turns when told to, before spending anything more', async () => {
    replies.push({ content: [{ type: 'tool_use', id: 'toolu_1', name: 'write_file', input: { path: 'a.md', content: 'x' } }], stop_reason: 'tool_use' });
    let turn = 0;
    const result = await provider().agent(agentRequest({ shouldStop: () => turn++ > 0 }));
    expect(result).toEqual({ text: '', turns: 1, stopped: 'interrupted' });
    expect(seen).toHaveLength(1);
  });

  it('sends the same turn again after a dropped connection, keeping what the run has already done', async () => {
    const call: Reply = { content: [{ type: 'tool_use', id: 'toolu_1', name: 'write_file', input: { path: 'a.md', content: 'x' } }], stop_reason: 'tool_use' };
    replies.push(call, { content: [{ type: 'text', text: 'half a rep' }], cut: true }, { content: [{ type: 'text', text: 'Done after a retry.' }] });
    const result = await provider().agent(agentRequest());
    expect(result).toEqual({ text: 'Done after a retry.', turns: 2, stopped: 'done' });
    // The tool ran once; the second turn was asked for twice with the same history.
    expect(written).toHaveLength(1);
    expect(seen).toHaveLength(3);
    expect(seen[2]!.body.messages).toEqual(seen[1]!.body.messages);
  });

  it('sends the same turn again when a reply simply stops arriving, and does not take that for a tool call it could not read', async () => {
    const call: Reply = { content: [{ type: 'tool_use', id: 'toolu_1', name: 'write_file', input: { path: 'a.md', content: 'x' } }], stop_reason: 'tool_use' };
    replies.push(call, { content: [{ type: 'text', text: 'half a rep' }], unfinished: true }, { content: [{ type: 'text', text: 'Done after a retry.' }] });
    const result = await provider().agent(agentRequest());
    expect(result).toEqual({ text: 'Done after a retry.', turns: 2, stopped: 'done' });
    expect(written).toHaveLength(1);
    expect(seen).toHaveLength(3);
    // One that keeps stopping is given up on as something that may pass: the first try and three more.
    seen = [];
    replies.push({ unfinished: true }, { unfinished: true }, { unfinished: true }, { unfinished: true });
    const err = await failure(provider().agent(agentRequest()));
    expect([err.code, err.retryable]).toEqual(['unavailable', true]);
    expect(err.message).not.toContain('tool call');
    expect(seen).toHaveLength(4);
  });

  it('counts a reply that was lost part-way once, and the one sent for in its place once', async () => {
    const call: Reply = { content: [{ type: 'tool_use', id: 'toolu_1', name: 'write_file', input: { path: 'a.md', content: 'x' } }], stop_reason: 'tool_use' };
    replies.push(call, { content: [{ type: 'text', text: 'half a rep' }], cut: true }, { content: [{ type: 'text', text: 'Done after a retry.' }] });
    const usage: CallUsage[] = [];
    await provider().agent(agentRequest({ onUsage: (u) => usage.push(u) }));
    // Three replies were paid for: the tool call, the reply that was lost, and the one that took its place.
    expect(usage).toHaveLength(3);
    expect(usage.map((u) => u.inputTokens)).toEqual([100, 100, 100]);
    // The lost reply never said how long it was; the other two did.
    expect(usage.map((u) => u.outputTokens)).toEqual([40, 0, 40]);
  });

  it('counts a reply whose tool call could not be read, before asking for the turn again', async () => {
    replies.push(
      // A line break written raw inside a string: the reply arrives whole, and its tool input is not JSON.
      { content: [{ type: 'tool_use', id: 'toolu_1', name: 'write_file', input: {}, rawInput: '{"path": "a.md", "content": "one line\nand another"}' }], stop_reason: 'tool_use' },
      { content: [{ type: 'text', text: 'Done.' }] },
    );
    const usage: CallUsage[] = [];
    const result = await provider().agent(agentRequest({ onUsage: (u) => usage.push(u) }));
    expect(result).toEqual({ text: 'Done.', turns: 1, stopped: 'done' });
    expect(written).toEqual([]);
    expect(seen).toHaveLength(2);
    expect(usage).toHaveLength(2);
    expect(usage[0]).toMatchObject({ inputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 50 });
  });

  it('counts what a lost reply had written by its length, since it never got to say', async () => {
    const raw = `{"path": "a.md", "content": "${'A line of the file.\n'.repeat(40)}"}`;
    replies.push({ content: [{ type: 'tool_use', id: 'toolu_1', name: 'write_file', input: {}, rawInput: raw }], stop_reason: 'tool_use' }, { content: [{ type: 'text', text: 'Done.' }] });
    const usage: CallUsage[] = [];
    await provider().agent(agentRequest({ onUsage: (u) => usage.push(u) }));
    // About four characters to a token: the 800-odd characters that arrived are some 200 tokens of output, not none.
    expect(usage[0]!.outputTokens).toBe(Math.ceil(raw.length / 4));
    expect(usage[0]!.costUsd).toBeCloseTo((100 * 4 + Math.ceil(raw.length / 4) * 20 + 900 * 0.2 + 50 * 5) / 1e6, 10);
    // A reply that did say how long it was is counted as it said.
    expect(usage[1]!.outputTokens).toBe(40);
  });

  it('gives up on a tool call that keeps arriving unreadable, without quoting the call in what it says', async () => {
    const raw = `{"path": "a.md", "content": "${'A line of the file.\n'.repeat(400)}"}`;
    const unreadable: Reply = { content: [{ type: 'tool_use', id: 'toolu_1', name: 'write_file', input: {}, rawInput: raw }], stop_reason: 'tool_use' };
    replies.push(unreadable, unreadable, unreadable);
    const err = await failure(provider().agent(agentRequest()));
    expect([err.code, err.retryable]).toEqual(['invalid_output', false]);
    expect(seen).toHaveLength(3);
    expect(written).toEqual([]);
    // The failure is shown to a person and kept with the task: it says what went wrong, not the file that was being written.
    expect(err.message).toContain('could not be read');
    expect(err.message).not.toContain('A line of the file.');
    expect(err.message.length).toBeLessThan(400);
  });

  it('sends the same turn again when the API is overloaded', async () => {
    const call: Reply = { content: [{ type: 'tool_use', id: 'toolu_1', name: 'write_file', input: { path: 'a.md', content: 'x' } }], stop_reason: 'tool_use' };
    replies.push(call, { status: 529, error: { type: 'overloaded_error', message: 'Overloaded' } }, { content: [{ type: 'text', text: 'Done.' }] });
    const result = await provider().agent(agentRequest());
    expect(result.stopped).toBe('done');
    expect(written).toHaveLength(1);
    expect(seen).toHaveLength(3);
  });

  it('gives up on a turn that keeps failing, saying it may pass later', async () => {
    const overloaded: Reply = { status: 529, error: { type: 'overloaded_error', message: 'Overloaded' } };
    replies.push(overloaded, overloaded, overloaded, overloaded);
    const err = await failure(provider().agent(agentRequest()));
    expect(err.code).toBe('unavailable');
    expect(err.retryable).toBe(true);
    expect(seen).toHaveLength(4);
  });

  it('does not run or echo what a model had started before a fallback model took over', async () => {
    replies.push({
      content: [
        { type: 'text', text: 'First I will write the file.' },
        { type: 'raw', block: { type: 'thinking', thinking: '', signature: 'sig' } },
        { type: 'tool_use', id: 'toolu_abandoned', name: 'write_file', input: { path: 'abandoned.md', content: 'x' } },
        { type: 'raw', block: { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-4-8' }, trigger: { type: 'refusal' } } },
        { type: 'text', text: 'Continuing.' },
        { type: 'tool_use', id: 'toolu_live', name: 'write_file', input: { path: 'live.md', content: 'y' } },
      ],
      stop_reason: 'tool_use',
      model: 'claude-opus-4-8',
    });
    replies.push({ content: [{ type: 'text', text: 'Wrote live.md.' }] });
    await provider().agent(agentRequest());
    expect(written).toEqual([{ path: 'live.md', content: 'y' }]);
    const [, assistant, user] = seen[1]!.body.messages;
    expect(assistant.content.map((b: any) => [b.type, b.id ?? b.text])).toEqual([
      ['text', 'First I will write the file.'],
      ['text', 'Continuing.'],
      ['tool_use', 'toolu_live'],
    ]);
    expect(user.content).toEqual([{ type: 'tool_result', tool_use_id: 'toolu_live', content: 'Wrote live.md.' }]);
  });

  it('holds the agent to its search allowance for the whole task, not per request', async () => {
    const call = (id: string, searches: number): Reply => ({
      content: [{ type: 'tool_use', id, name: 'write_file', input: { path: `${id}.md`, content: 'x' } }],
      stop_reason: 'tool_use',
      usage: { server_tool_use: { web_search_requests: searches, web_fetch_requests: 0 } },
    });
    replies.push(call('toolu_1', 4), call('toolu_2', 0), call('toolu_3', 1), { content: [{ type: 'text', text: 'Stopped.' }] });
    const usage: CallUsage[] = [];
    const result = await provider().agent(agentRequest({ webSearch: { perRequest: 3, perTask: 4 }, onUsage: (u) => usage.push(u) }));
    const lastText = (i: number) => seen[i]!.body.messages.at(-1).content.at(-1);
    // Allowance used: told once to finish without searching.
    expect(lastText(1).text).toContain('4 web searches allowed for this task');
    // It carried on without searching: nothing more is said.
    expect(lastText(2).type).toBe('tool_result');
    // It searched again: it is made to stop.
    expect(lastText(3).text).toContain('Do not call any more tools');
    expect(result).toEqual({ text: 'Stopped.', turns: 4, stopped: 'cut_short' });
    // The tool list never changes during a run.
    expect(seen[3]!.body.tools).toEqual(seen[0]!.body.tools);
    expect(usage[0]!.costUsd).toBeGreaterThan(4 * 0.01);
  });

  it('has the agent wrap up when told to, keeping what it has done', async () => {
    replies.push({ content: [{ type: 'tool_use', id: 'toolu_1', name: 'write_file', input: { path: 'a.md', content: 'x' } }], stop_reason: 'tool_use' });
    replies.push({ content: [{ type: 'text', text: 'Wrote a.md; the review is not done.' }] });
    let spent = false;
    const result = await provider().agent(agentRequest({ onUsage: () => void (spent = true), shouldWrapUp: () => spent }));
    expect(result).toEqual({ text: 'Wrote a.md; the review is not done.', turns: 2, stopped: 'cut_short' });
    expect(written).toHaveLength(1);
    expect(seen[1]!.body.messages.at(-1).content.at(-1).text).toContain('Do not call any more tools');
  });

  it('does not start a run it would have to wrap up at once', async () => {
    const result = await provider().agent(agentRequest({ shouldWrapUp: () => true }));
    expect(result).toEqual({ text: '', turns: 0, stopped: 'interrupted' });
    expect(seen).toHaveLength(0);
  });

  it('declines to continue after a refusal', async () => {
    replies.push({ content: [], stop_reason: 'refusal' });
    const err = await failure(provider().agent(agentRequest()));
    expect(err.code).toBe('refusal');
  });

  it('declines to continue when the refusal comes as an error from the content filter', async () => {
    replies.push({ status: 400, error: { type: 'invalid_request_error', message: 'Output blocked by content filtering policy' } });
    const err = await failure(provider().agent(agentRequest()));
    expect([err.code, err.retryable]).toEqual(['refusal', false]);
    expect(seen).toHaveLength(1);
  });
});

describe('with no credentials to send', () => {
  // The provider is handed no key, as it is for a login the client finds by itself, and there is none to be found:
  // nothing in the environment, and an empty directory where a login would be kept.
  const NAMES = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_PROFILE', 'ANTHROPIC_FEDERATION_RULE_ID', 'ANTHROPIC_ORGANIZATION_ID', 'ANTHROPIC_CONFIG_DIR'];
  const saved = new Map<string, string | undefined>();
  let empty: string;
  beforeEach(async () => {
    empty = await mkdtemp(path.join(os.tmpdir(), 'the-organisation-no-login-'));
    for (const name of NAMES) {
      saved.set(name, process.env[name]);
      delete process.env[name];
    }
    process.env.ANTHROPIC_CONFIG_DIR = empty;
  });
  afterEach(async () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(empty, { recursive: true, force: true });
  });
  const keyless = () => new ClaudeProvider({ baseURL, maxRetries: 0, turnRetryDelayMs: 0 });
  const task = { kind: 'task' as const, system, prompt: 'Write the spec.', model: 'claude-opus-5-5', effort: 'medium' as const, tools: [], webSearch: null, maxTurns: 10, context: {} };

  it('says that is what is wrong, and does not wait and try again as if a connection had dropped', async () => {
    for (const call of [() => keyless().structured(structuredRequest()), () => keyless().agent(task)]) {
      const err = await failure(call());
      expect([err.code, err.retryable]).toEqual(['auth', false]);
      expect(err.message).toContain('Could not resolve authentication method');
      expect(err.message).not.toMatch(/connection|part-way|tool call/);
    }
    // Nothing was sent, since there was nothing to send it with.
    expect(seen).toHaveLength(0);
  });

  it('says the same of a login that is named and cannot be found', async () => {
    process.env.ANTHROPIC_PROFILE = 'no-such-login';
    for (const call of [() => keyless().structured(structuredRequest()), () => keyless().agent(task)]) {
      const err = await failure(call());
      expect([err.code, err.retryable]).toEqual(['auth', false]);
      expect(err.message).toContain('no-such-login');
      expect(err.message).not.toMatch(/tool call/);
    }
    expect(seen).toHaveLength(0);
  });

  it('says so for a call that is not a reply to be read, such as asking after a hosted session', async () => {
    const err = await failure(keyless().hasSession('sesn_1'));
    expect([err.code, err.retryable]).toEqual(['auth', false]);
    expect(seen).toHaveLength(0);
  });
});
