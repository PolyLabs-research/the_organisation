import http from 'node:http';
import type { AddressInfo } from 'node:net';

// A local stand-in for an OpenAI-compatible endpoint: a models listing,
// Chat Completions (streamed or whole), and OpenAI's own Responses API
// (streamed). A test queues the replies it wants and can set rules that
// refuse requests the way a particular provider would.
// It checks what the client sends and how it handles what comes back; it
// cannot check that any real provider accepts the requests.

export interface FakeCall {
  id?: string;
  name: string;
  /** Sent as it is if a string; as JSON if an object. */
  arguments: string | Record<string, unknown>;
  /** Send the whole call in one piece with no index, as some endpoints do. */
  whole?: boolean;
  /** With `whole`: the number to put on the call all the same, as an endpoint does that numbers every call 0. */
  index?: number;
  /** Extra fields on the call, as an endpoint with something of its own to say puts them. */
  extra?: Record<string, unknown>;
}

export interface FakeReply {
  status?: number;
  error?: string;
  /** The code the refusal carries, where an endpoint gives one. */
  code?: string;
  content?: string;
  /** Reasoning text, sent in the field named. */
  reasoning?: string;
  reasoningField?: 'reasoning_content' | 'reasoning';
  /** Other fields on the reply's message, as an endpoint with something of its own to say puts them. Text is streamed in pieces. */
  fields?: Record<string, unknown>;
  calls?: FakeCall[];
  finish?: string;
  /** Token counts for the reply. null sends none at all. Extra fields go in as given. */
  usage?: Record<string, unknown> | null;
  /** Drop the connection part-way through the reply. */
  cut?: boolean;
  /** End the stream in good order without ever saying why the reply ended, as a proxy that times out can. */
  unfinished?: boolean;
  /** Send the words and then say nothing more, with the connection left open. */
  hold?: boolean;
}

/** A reply from the Responses API: what the model produced, and how the response ended. */
export interface FakeResponse {
  /** Fail the request itself, before any response starts. */
  status?: number;
  error?: string;
  /** Reasoning the model did first. Its encrypted form is sent only if the request asked for it. */
  reasoning?: string;
  text?: string;
  /** Decline in the model's own words, in place of an answer. */
  refusal?: string;
  calls?: FakeCall[];
  /** End the response unfinished, for this reason. */
  incomplete?: 'max_output_tokens' | 'content_filter';
  /** End the response as failed, with this error on it. */
  failed?: { code: string; message: string };
  /** Send an error event part-way through the stream, and nothing after it. */
  streamError?: { code: string; message: string };
  /** Token counts. null sends none. */
  usage?: Record<string, unknown> | null;
  /** Leave the finished response's list of output empty, so that it has to be gathered from the stream. */
  bareFinal?: boolean;
  /** Drop the connection before the response is finished. */
  cut?: boolean;
  /** Send what the model produced and then say nothing more, with the connection left open. */
  hold?: boolean;
}

export interface FakeRequest {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: any;
}

/** A reason to refuse a request, or nothing to let it through. */
export type Rule = (body: any) => string | undefined;

export class FakeOpenAI {
  readonly seen: FakeRequest[] = [];
  replies: FakeReply[] = [];
  /** Replies for the Responses API, in the order they are to be given. */
  responses: FakeResponse[] = [];
  rules: Rule[] = [];
  models: Array<Record<string, unknown>> = [];
  /** What the models listing answers with instead of the list, e.g. 401 or 404. */
  modelsStatus: number | null = null;
  /** The key the endpoint accepts. Any other gets a 401. Empty accepts all. */
  key = '';
  /** Report token counts on every streamed reply, asked for or not, as some endpoints do. */
  alwaysUsage = false;
  /** What to answer when no reply is queued: a function of the request, for a stand-in that plays a model's part. */
  auto: { chat?: (body: any) => FakeReply; responses?: (body: any) => FakeResponse } = {};
  private server!: http.Server;
  baseURL = '';

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => this.route(req, res, Buffer.concat(chunks).toString('utf8')));
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.baseURL = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/v1`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  reset(): void {
    this.seen.length = 0;
    this.replies = [];
    this.responses = [];
    this.rules = [];
    this.models = [];
    this.modelsStatus = null;
    this.key = '';
    this.alwaysUsage = false;
    this.auto = {};
  }

  /** The bodies of the chat requests made so far. */
  get chats(): any[] {
    return this.seen.filter((r) => r.path === '/v1/chat/completions').map((r) => r.body);
  }

  /** The bodies of the requests made to the Responses API so far. */
  get asked(): any[] {
    return this.seen.filter((r) => r.path === '/v1/responses').map((r) => r.body);
  }

  private route(req: http.IncomingMessage, res: http.ServerResponse, raw: string): void {
    const path = (req.url ?? '/').split('?')[0]!;
    const body = raw ? JSON.parse(raw) : null;
    this.seen.push({ path, headers: req.headers, body });
    const fail = (status: number, message: string, code?: string) =>
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message, type: status === 401 ? 'invalid_request_error' : 'error', code: code ?? null } }));

    // As some providers do, the refusal quotes the key that was offered.
    if (this.key && req.headers.authorization !== `Bearer ${this.key}`) {
      return void fail(401, `Incorrect API key provided: ${String(req.headers.authorization ?? '').replace(/^Bearer /, '')}.`, 'invalid_api_key');
    }

    if (req.method === 'GET' && path === '/v1/models') {
      if (this.modelsStatus) return void fail(this.modelsStatus, this.modelsStatus === 404 ? 'Not found' : 'refused');
      return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'list', data: this.models }));
    }
    if (req.method === 'POST' && path === '/v1/responses') {
      for (const rule of this.rules) {
        const reason = rule(body);
        if (reason) return void fail(400, reason);
      }
      return void this.respond(body, res, fail);
    }
    if (req.method !== 'POST' || path !== '/v1/chat/completions') return void fail(404, `no route for ${req.method} ${path}`);

    for (const rule of this.rules) {
      const reason = rule(body);
      if (reason) return void fail(400, reason);
    }
    const reply = this.replies.shift() ?? this.auto.chat?.(body) ?? { content: 'Done.' };
    if (reply.status && reply.status >= 400) return void fail(reply.status, reply.error ?? 'failed', reply.code ?? (reply.status === 429 && /quota/.test(reply.error ?? '') ? 'insufficient_quota' : undefined));

    const usage = reply.usage === null ? undefined : { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200, ...reply.usage };
    const finish = reply.finish ?? (reply.calls?.length ? 'tool_calls' : 'stop');
    const reasoningField = reply.reasoningField ?? 'reasoning_content';
    const base = { id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1, model: body.model };

    if (!body.stream) {
      const message: Record<string, unknown> = { role: 'assistant', content: reply.content ?? null };
      if (reply.reasoning) message[reasoningField] = reply.reasoning;
      Object.assign(message, reply.fields);
      if (reply.calls?.length) {
        message.tool_calls = reply.calls.map((c, i) => ({ id: c.id ?? `call_${i}`, type: 'function', function: { name: c.name, arguments: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments) }, ...c.extra }));
      }
      return void res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message, finish_reason: finish }], usage }));
    }

    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta: Record<string, unknown>, finishReason: string | null = null) => res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
    send({ role: 'assistant', content: '' });
    // Reasoning, then words, each in a few pieces, as a model produces them.
    for (const piece of pieces(reply.reasoning ?? '')) send({ [reasoningField]: piece });
    for (const piece of pieces(reply.content ?? '')) send({ content: piece });
    for (const [field, value] of Object.entries(reply.fields ?? {})) {
      if (typeof value === 'string') for (const piece of pieces(value)) send({ [field]: piece });
      else if (Array.isArray(value)) for (const item of value) send({ [field]: [item] });
      else send({ [field]: value });
    }
    // What was written is given time to arrive first: a reply cut off part-way is one that had started.
    if (reply.cut) return void setTimeout(() => res.destroy(), 5);
    if (reply.hold) return;
    (reply.calls ?? []).forEach((call, index) => {
      const args = typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments);
      const id = call.id ?? `call_${index}`;
      if (call.whole) return void send({ tool_calls: [{ ...(call.index !== undefined ? { index: call.index } : {}), id, type: 'function', function: { name: call.name, arguments: args }, ...call.extra }] });
      send({ tool_calls: [{ index, id, type: 'function', function: { name: call.name, arguments: '' }, ...call.extra }] });
      for (const piece of pieces(args)) send({ tool_calls: [{ index, function: { arguments: piece } }] });
    });
    if (!reply.unfinished) send({}, finish);
    if (usage && (body.stream_options?.include_usage || this.alwaysUsage)) res.write(`data: ${JSON.stringify({ ...base, choices: [], usage })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  }

  /** One response from the Responses API, as a stream of events ending with the finished response. */
  private respond(body: any, res: http.ServerResponse, fail: (status: number, message: string, code?: string) => void): void {
    const reply = this.responses.shift() ?? this.auto.responses?.(body) ?? { text: 'Done.' };
    if (reply.status && reply.status >= 400) return void fail(reply.status, reply.error ?? 'failed');
    if (!body.stream) return void fail(400, 'this stand-in only streams responses');

    const n = this.asked.length;
    const output: Array<Record<string, unknown>> = [];
    if (reply.reasoning) {
      // The encrypted form of the reasoning is only sent to a request that asked for it.
      const encrypted = Array.isArray(body.include) && body.include.includes('reasoning.encrypted_content');
      output.push({ id: `rs_${n}`, type: 'reasoning', summary: [], ...(encrypted ? { encrypted_content: `ENC(${reply.reasoning})` } : {}) });
    }
    if (reply.text !== undefined || reply.refusal !== undefined) {
      output.push({
        id: `msg_${n}`,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: reply.refusal !== undefined ? [{ type: 'refusal', refusal: reply.refusal }] : [{ type: 'output_text', text: reply.text, annotations: [] }],
      });
    }
    (reply.calls ?? []).forEach((call, i) => {
      output.push({
        id: `fc_${n}_${i}`,
        type: 'function_call',
        call_id: call.id ?? `call_${n}_${i}`,
        name: call.name,
        arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments),
        status: 'completed',
      });
    });

    const status = reply.failed ? 'failed' : reply.incomplete ? 'incomplete' : 'completed';
    const usage =
      reply.usage === null
        ? null
        : { input_tokens: 1000, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens: 200, output_tokens_details: { reasoning_tokens: 50 }, total_tokens: 1200, ...reply.usage };
    const response = {
      id: `resp_${n}`,
      object: 'response',
      model: body.model,
      status,
      output: reply.bareFinal ? [] : output,
      usage,
      error: reply.failed ?? null,
      incomplete_details: reply.incomplete ? { reason: reply.incomplete } : null,
    };

    res.writeHead(200, { 'content-type': 'text/event-stream' });
    let sequence = 0;
    const send = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`);
    send('response.created', { response: { ...response, status: 'in_progress', output: [], usage: null } });
    output.forEach((item, output_index) => {
      send('response.output_item.added', { output_index, item: { ...item, status: 'in_progress' } });
      // Text arrives in pieces first, as it does from a model; the finished item follows.
      if (item.type === 'message' && reply.text) for (const delta of pieces(reply.text)) send('response.output_text.delta', { output_index, content_index: 0, item_id: item.id, delta });
      send('response.output_item.done', { output_index, item });
    });
    if (reply.cut) return void setTimeout(() => res.destroy(), 5);
    if (reply.hold) return;
    if (reply.streamError) {
      send('error', { code: reply.streamError.code, message: reply.streamError.message, param: null });
      return void res.end();
    }
    send(`response.${status}`, { response });
    res.end();
  }
}

/** A string in three pieces, so that anything put back together from a stream has to be put together properly. */
function pieces(text: string): string[] {
  if (!text) return [];
  const third = Math.ceil(text.length / 3);
  return [text.slice(0, third), text.slice(third, 2 * third), text.slice(2 * third)].filter(Boolean);
}
