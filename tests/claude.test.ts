import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ClaudeProvider } from '../src/server/providers/claude';
import { ProviderError, type AgentTool, type CallUsage } from '../src/server/providers/types';

// These tests run the Claude provider against a local stand-in for the
// Messages API that speaks the same streaming protocol. They check what the
// provider sends and how it handles what comes back; they cannot check that
// the real API accepts the requests.

type Block = { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown; rawInput?: string };
interface Reply {
  status?: number;
  error?: { type: string; message: string };
  content?: Block[];
  stop_reason?: string;
  model?: string;
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
    } else {
      events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } }]);
      events.push([
        'content_block_delta',
        { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: block.rawInput ?? JSON.stringify(block.input) } },
      ]);
    }
    events.push(['content_block_stop', { type: 'content_block_stop', index }]);
  });
  events.push(['message_delta', { type: 'message_delta', delta: { stop_reason: reply.stop_reason ?? 'end_turn', stop_sequence: null }, usage: { output_tokens: 40 } }]);
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

const provider = () => new ClaudeProvider({ apiKey: 'test-key', baseURL, maxRetries: 0 });
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

  it('offers web search only when the organisation allows it', async () => {
    replies.push({ content: [{ type: 'text', text: 'Done.' }] });
    await provider().agent(agentRequest({ webSearch: { maxUses: 5 } }));
    expect(seen[0]!.body.tools.at(-1)).toEqual({ type: 'web_search_20260209', name: 'web_search', max_uses: 5 });
    // Haiku does not run the self-filtering search tool, so it is given the basic one.
    replies.push({ content: [{ type: 'text', text: 'Done.' }] });
    await provider().agent(agentRequest({ webSearch: { maxUses: 3 }, model: 'claude-haiku-5-5' }));
    expect(seen[1]!.body.tools.at(-1)).toEqual({ type: 'web_search_20250305', name: 'web_search', max_uses: 3 });
    replies.push({ content: [{ type: 'text', text: 'Done.' }] });
    await provider().agent(agentRequest());
    expect(seen[2]!.body.tools.some((t: { name: string }) => t.name === 'web_search')).toBe(false);
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

  it('asks for a closing report at the turn limit and stops there', async () => {
    const call = (id: string): Reply => ({ content: [{ type: 'tool_use', id, name: 'write_file', input: { path: `${id}.md`, content: 'x' } }], stop_reason: 'tool_use' });
    replies.push(call('toolu_1'), call('toolu_2'), { content: [{ type: 'text', text: 'Out of turns; two files written.' }] });
    const result = await provider().agent(agentRequest({ maxTurns: 2 }));
    expect(result).toEqual({ text: 'Out of turns; two files written.', turns: 3, stopped: 'max_turns' });
    expect(written).toHaveLength(2);
    const last = seen[2]!.body.messages.at(-1);
    expect(last.content.at(-1).type).toBe('text');
    expect(last.content.at(-1).text).toContain('turn limit');
  });

  it('stops without running more tools if the model ignores the turn limit', async () => {
    const call = (id: string): Reply => ({ content: [{ type: 'tool_use', id, name: 'write_file', input: { path: `${id}.md`, content: 'x' } }], stop_reason: 'tool_use' });
    replies.push(call('toolu_1'), call('toolu_2'));
    const result = await provider().agent(agentRequest({ maxTurns: 1 }));
    expect(result.stopped).toBe('max_turns');
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

  it('stops between turns when told to, before spending anything more', async () => {
    replies.push({ content: [{ type: 'tool_use', id: 'toolu_1', name: 'write_file', input: { path: 'a.md', content: 'x' } }], stop_reason: 'tool_use' });
    let turn = 0;
    const result = await provider().agent(agentRequest({ shouldStop: () => turn++ > 0 }));
    expect(result).toEqual({ text: '', turns: 1, stopped: 'interrupted' });
    expect(seen).toHaveLength(1);
  });

  it('declines to continue after a refusal', async () => {
    replies.push({ content: [], stop_reason: 'refusal' });
    const err = await failure(provider().agent(agentRequest()));
    expect(err.code).toBe('refusal');
  });
});
