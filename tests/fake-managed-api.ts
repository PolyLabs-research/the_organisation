import http from 'node:http';
import type { AddressInfo } from 'node:net';

// A local stand-in for the parts of the Claude Managed Agents API that a
// hosted session uses: agents, environments, files, sessions and their event
// stream. A test gives each session a script that plays the agent's side.
// It checks what the client sends and how it reacts to what comes back; it
// cannot check that the real API behaves as this stand-in does.

export interface Recorded {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: http.IncomingHttpHeaders;
  body: any;
}

type Json = Record<string, any>;
type StopReason = { type: 'end_turn' } | { type: 'requires_action'; event_ids: string[] } | { type: 'budget_reached' } | { type: 'retries_exhausted' } | { type: 'refusal' };

const text = (value: string) => [{ type: 'text', text: value }];

export class FakeSession {
  readonly events: Json[] = [];
  /** What the client has sent, in order. */
  readonly received: Json[] = [];
  readonly outputs: Array<{ id: string; filename: string; bytes: Buffer; downloadable: boolean | undefined; createdAt: string }> = [];
  readonly threads = new Map<string, Json[]>();
  readonly streams = new Set<http.ServerResponse>();
  status: 'idle' | 'running' | 'terminated' = 'idle';
  /** How long the status a client can ask for trails behind the events, as the real one can. */
  statusLagMs = 0;
  private shown: 'idle' | 'running' | 'terminated' = 'idle';
  blocked: 'requires_action' | 'budget_reached' | null = null;
  capCents: number;
  spentCents = 0;
  archived = false;
  /** Set to have the session refuse to be archived, as one with a workflow run still open can. */
  openRun = false;
  /** An error thrown by the script, for the test to see. */
  failure: unknown = null;
  readonly createdAt = new Date().toISOString();
  private consumed = 0;
  private waiters: Array<() => void> = [];

  constructor(
    readonly api: FakeManagedApi,
    readonly id: string,
    readonly created: Json,
    readonly resources: Json[],
  ) {
    this.capCents = Number(created.budget?.max_list_cost?.amount ?? 0);
  }

  // ---- what the session says ----

  emit(type: string, fields: Json = {}): Json {
    const event = { id: `sevt_${this.api.nextId()}`, type, processed_at: this.api.tick(), ...fields };
    this.events.push(event);
    const frame = `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const stream of this.streams) stream.write(frame);
    return event;
  }

  private show(status: 'idle' | 'running' | 'terminated'): void {
    this.status = status;
    if (this.statusLagMs > 0) setTimeout(() => (this.shown = this.status), this.statusLagMs);
    else this.shown = status;
  }

  running(): void {
    this.show('running');
    this.blocked = null;
    this.emit('session.status_running');
  }

  idle(reason: StopReason): void {
    this.show('idle');
    this.blocked = reason.type === 'requires_action' || reason.type === 'budget_reached' ? reason.type : null;
    this.emit('session.status_idle', { stop_reason: reason, stop_details: null });
  }

  terminate(): void {
    this.show('terminated');
    this.emit('session.status_terminated');
    this.wake();
  }

  says(message: string): void {
    this.emit('agent.message', { content: text(message) });
  }

  usage(): Json {
    return {
      input_tokens: this.spentCents * 1000,
      output_tokens: this.spentCents * 100,
      cache_read_input_tokens: 0,
      list_cost: { amount: String(this.spentCents), currency: 'USD' },
      server_tool_use: { web_search_requests: 0 },
    };
  }

  /** Spend, as model requests do. At the cap the session pauses, as the platform's gate makes it, until the cap is raised. */
  async charge(cents: number): Promise<void> {
    this.spentCents += cents;
    this.emit('session.usage', { usage: this.usage(), budget: this.budget() });
    while (this.spentCents >= this.capCents && this.status !== 'terminated') {
      this.idle({ type: 'budget_reached' });
      const cap = this.capCents;
      await this.until(() => this.capCents !== cap || this.status === 'terminated');
      if (this.spentCents < this.capCents) this.running();
    }
  }

  budget(): Json {
    return { type: 'limit', max_list_cost: { amount: String(this.capCents), currency: 'USD' } };
  }

  /** The lead calls one of its custom tools and waits for the client's answer. */
  async call(name: string, input: Json, threadId?: string): Promise<{ text: string; isError: boolean }> {
    const event = this.emit('agent.custom_tool_use', { name, input, ...(threadId ? { session_thread_id: threadId } : {}) });
    this.idle({ type: 'requires_action', event_ids: [event.id] });
    const result = await this.next((e) => e.type === 'user.custom_tool_result' && e.custom_tool_use_id === event.id);
    this.running();
    return { text: result.content?.[0]?.text ?? '', isError: !!result.is_error };
  }

  /** A sandbox tool call the platform could not judge: it waits for the client to allow or deny it. */
  async ask(name: string, input: Json, threadId?: string): Promise<Json> {
    const event = this.emit('agent.tool_use', {
      name,
      input,
      evaluated_permission: 'ask',
      evaluation: { type: 'auto', evaluated_permission: { type: 'ask', reason_code: 'indeterminate' } },
      ...(threadId ? { session_thread_id: threadId } : {}),
    });
    this.idle({ type: 'requires_action', event_ids: [event.id] });
    const answer = await this.next((e) => e.type === 'user.tool_confirmation' && e.tool_use_id === event.id);
    this.running();
    return answer;
  }

  /** The lead gives one of its agents a task; the agent works, optionally leaves a file, and reports. */
  delegate(threadId: string, brief: string, report: string, file?: { name: string; content: string }): void {
    const name = 'Team agent';
    if (!this.threads.has(threadId)) {
      this.threads.set(threadId, []);
      this.emit('session.thread_created', { session_thread_id: threadId, agent_name: name, workflow_run_id: null });
    }
    this.emit('agent.thread_message_sent', { to_session_thread_id: threadId, to_agent_name: name, content: text(brief) });
    this.emit('session.thread_status_running', { session_thread_id: threadId, agent_name: name });
    // On the agent's own thread: the task arrives as a message to it, it says something as it starts, and its
    // report to the lead is a message it sends.
    this.threads.get(threadId)!.push(
      { id: `sevt_${this.api.nextId()}`, type: 'agent.thread_message_received', from_session_thread_id: 'sthr_primary', content: text(brief), processed_at: this.api.tick() },
      { id: `sevt_${this.api.nextId()}`, type: 'agent.message', content: text('I will start by reading the workspace.'), processed_at: this.api.tick() },
      { id: `sevt_${this.api.nextId()}`, type: 'agent.thread_message_sent', to_session_thread_id: 'sthr_primary', content: text(report), processed_at: this.api.tick() },
    );
    if (file) this.writes(file.name, file.content);
    this.emit('session.thread_status_idle', { session_thread_id: threadId, agent_name: name, stop_reason: { type: 'end_turn' }, stop_details: null });
    this.emit('agent.thread_message_received', { from_session_thread_id: threadId, from_agent_name: name, content: text(report) });
  }

  /**
   * A file appears in the session's output folder. Writing a name again keeps the file's id, unless `anew`
   * is set, in which case the listing holds both the old file and the new one under the same name.
   */
  writes(filename: string, content: string, downloadable: boolean | 'unsaid' = true, anew = false): string {
    const existing = this.outputs.find((o) => o.filename === filename);
    if (existing && !anew) {
      existing.bytes = Buffer.from(content);
      return existing.id;
    }
    const id = `file_out_${this.api.nextId()}`;
    // Newest first, so that a client which simply takes the listing in order ends up with the oldest version.
    this.outputs.unshift({ id, filename, bytes: Buffer.from(content), downloadable: downloadable === 'unsaid' ? undefined : downloadable, createdAt: this.api.tick() });
    return id;
  }

  /** The lead calls one of its custom tools while its agents are still at work, so the session does not go idle. */
  async callWhileBusy(name: string, input: Json): Promise<{ text: string; isError: boolean }> {
    const event = this.emit('agent.custom_tool_use', { name, input });
    const result = await this.next((e) => e.type === 'user.custom_tool_result' && e.custom_tool_use_id === event.id);
    return { text: result.content?.[0]?.text ?? '', isError: !!result.is_error };
  }

  // ---- what the client says ----

  /** The next thing the client sends that matches, whether it has arrived yet or not. Each is handed out once. */
  async next(test: (event: Json) => boolean): Promise<Json> {
    for (;;) {
      for (let i = this.consumed; i < this.received.length; i++) {
        const event = this.received[i]!;
        if (!event.__taken && test(event)) {
          event.__taken = true;
          return event;
        }
      }
      if (this.status === 'terminated') throw new Error('the session ended while its script was waiting');
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  async until(test: () => boolean): Promise<void> {
    while (!test()) await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  wake(): void {
    const waiting = this.waiters;
    this.waiters = [];
    for (const resolve of waiting) resolve();
  }

  /** Cut every open stream, as a network fault would. */
  drop(): void {
    for (const stream of this.streams) stream.destroy();
    this.streams.clear();
  }

  json(): Json {
    return {
      id: this.id,
      type: 'session',
      status: this.shown,
      agent: { id: this.created.agent?.id, version: this.created.agent?.version ?? 1 },
      archived_at: this.archived ? this.api.tick() : null,
      budget: this.budget(),
      created_at: this.createdAt,
      updated_at: this.createdAt,
      environment_id: this.created.environment_id,
      metadata: this.created.metadata ?? {},
      outcome_evaluations: [],
      resources: this.resources,
      stats: {},
      title: this.created.title ?? null,
      usage: this.usage(),
      vault_ids: [],
    };
  }
}

export class FakeManagedApi {
  readonly requests: Recorded[] = [];
  readonly agents = new Map<string, Json>();
  readonly environments = new Map<string, Json>();
  readonly files = new Map<string, { id: string; filename: string; bytes: Buffer }>();
  readonly sessions = new Map<string, FakeSession>();
  /** Plays the agent's side of each new session. */
  script: (session: FakeSession) => Promise<void> = async () => {};
  /** Called each time a client attaches to a session's stream, before anything else is served. */
  onStream: ((session: FakeSession) => void) | null = null;
  /** Messages for which this returns true are shown as queued (no time on them) and never as taken up. */
  queueOnly: ((event: Json) => boolean) | null = null;
  queued = 0;
  /** A reply to give instead of the normal one, once, for the next request that matches. */
  private faults: Array<{ test: (r: Recorded) => boolean; status: number; message: string; times: number }> = [];
  private silences: Array<(r: Recorded) => boolean> = [];
  private server!: http.Server;
  private ids = 0;
  private clock = Date.parse('2026-11-05T10:00:00Z');
  baseURL = '';

  nextId(): number {
    return ++this.ids;
  }

  /** Each event gets a later time than the last, so "since this time" means "after this event". */
  tick(): string {
    this.clock += 1;
    return new Date(this.clock).toISOString();
  }

  /** Let time pass between events. */
  skip(ms: number): void {
    this.clock += ms;
  }

  /** For the next request that matches: carry it out, then drop the connection without replying. */
  dropReplyOnce(test: (r: Recorded) => boolean): void {
    this.silences.push(test);
  }

  failOnce(test: (r: Recorded) => boolean, status: number, message: string): void {
    this.faults.push({ test, status, message, times: 1 });
  }

  /** Refuse every request that matches, until the stand-in is reset. */
  failAlways(test: (r: Recorded) => boolean, status: number, message: string): void {
    this.faults.push({ test, status, message, times: Infinity });
  }

  /** The requests made to one route, e.g. count('POST', '/v1/agents'). */
  count(method: string, path: string | RegExp): number {
    return this.requests.filter((r) => r.method === method && (typeof path === 'string' ? r.path === path : path.test(r.path))).length;
  }

  session(): FakeSession {
    const sessions = [...this.sessions.values()];
    if (!sessions.length) throw new Error('no session has been created');
    return sessions.at(-1)!;
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        this.route(req, res, Buffer.concat(chunks)).catch((err) => {
          res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: String(err) } }));
        });
      });
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.baseURL = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    for (const session of this.sessions.values()) {
      session.status = 'terminated';
      session.wake();
      session.drop();
    }
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  reset(): void {
    for (const session of this.sessions.values()) {
      session.status = 'terminated';
      session.wake();
      session.drop();
    }
    this.requests.length = 0;
    this.agents.clear();
    this.environments.clear();
    this.files.clear();
    this.sessions.clear();
    this.faults = [];
    this.silences = [];
    this.script = async () => {};
    this.onStream = null;
    this.queueOnly = null;
    this.queued = 0;
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse, raw: Buffer): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    const type = String(req.headers['content-type'] ?? '');
    const body = type.includes('application/json') && raw.length ? JSON.parse(raw.toString('utf8')) : type.includes('multipart/form-data') ? multipart(raw, type) : null;
    const recorded: Recorded = { method, path, query: url.searchParams, headers: req.headers, body };
    this.requests.push(recorded);

    const silence = this.silences.findIndex((test) => test(recorded));
    const silent = silence >= 0;
    if (silent) this.silences.splice(silence, 1);
    const send = (status: number, payload: unknown): void => {
      if (silent) return void res.destroy();
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
    };
    const kinds: Record<number, string> = { 403: 'permission_error', 404: 'not_found_error', 409: 'conflict_error', 500: 'api_error' };
    const fail = (status: number, message: string) => send(status, { type: 'error', error: { type: kinds[status] ?? 'invalid_request_error', message } });

    const fault = this.faults.find((f) => f.test(recorded));
    if (fault) {
      if (--fault.times <= 0) this.faults.splice(this.faults.indexOf(fault), 1);
      return fail(fault.status, fault.message);
    }

    // ---- agents and environments ----
    if (method === 'POST' && path === '/v1/agents') {
      const agent = { id: `agent_${this.nextId()}`, type: 'agent', version: 1, archived_at: null, ...body };
      this.agents.set(agent.id, agent);
      return send(200, agent);
    }
    let match = /^\/v1\/agents\/([^/]+)$/.exec(path);
    if (match && method === 'POST') {
      const agent = this.agents.get(match[1]!);
      if (!agent) return fail(404, 'agent not found');
      if (body.version !== undefined && body.version !== agent.version) return fail(409, 'the agent has a newer version');
      const { version: _version, ...changes } = body;
      Object.assign(agent, changes, { version: agent.version + 1 });
      return send(200, agent);
    }
    if (method === 'POST' && path === '/v1/environments') {
      if ([...this.environments.values()].some((e) => e.name === body.name)) return fail(409, 'an environment of that name exists');
      const environment = { id: `env_${this.nextId()}`, type: 'environment', archived_at: null, ...body };
      this.environments.set(environment.id, environment);
      return send(200, environment);
    }
    if (method === 'GET' && path === '/v1/environments') return send(200, { data: [...this.environments.values()], next_page: null });

    // ---- files ----
    if (method === 'POST' && path === '/v1/files') {
      const id = `file_${this.nextId()}`;
      this.files.set(id, { id, filename: body.filename, bytes: body.bytes });
      const expires = new Date(Date.now() + Number(body.fields.expires_in_seconds ?? 0) * 1000).toISOString();
      return send(200, { id, type: 'file', filename: body.filename, mime_type: 'text/plain', size_bytes: body.bytes.length, created_at: this.tick(), expires_at: expires, downloadable: false });
    }
    if (method === 'GET' && path === '/v1/files') {
      const session = this.sessions.get(url.searchParams.get('scope_id') ?? '');
      if (!session) return send(200, { data: [], next_page: null });
      const scope = { id: session.id, type: 'session' };
      // The listing holds the session's copies of what was mounted into it as well as what it wrote.
      const inputs = session.resources.map((r) => ({ id: r.file_id, type: 'file', filename: String(r.mount_path).split('/').pop(), mime_type: 'text/plain', size_bytes: 1, created_at: this.tick(), downloadable: false, scope }));
      const outputs = session.outputs.map((o) => ({ id: o.id, type: 'file', filename: o.filename, mime_type: 'text/plain', size_bytes: o.bytes.length, created_at: o.createdAt, ...(o.downloadable === undefined ? {} : { downloadable: o.downloadable }), scope }));
      return send(200, { data: [...inputs, ...outputs], next_page: null });
    }
    match = /^\/v1\/files\/([^/]+)\/content$/.exec(path);
    if (match && method === 'GET') {
      for (const session of this.sessions.values()) {
        const output = session.outputs.find((o) => o.id === match![1]);
        if (output && output.downloadable === false) return fail(400, 'this file cannot be downloaded');
        if (output && output.downloadable === undefined) return fail(400, 'this file cannot be downloaded');
        if (output) return void res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(output.bytes);
      }
      return fail(404, 'file not found');
    }

    // ---- sessions ----
    if (method === 'POST' && path === '/v1/sessions') {
      if (!this.agents.has(body.agent?.id)) return fail(404, 'agent not found');
      if (!this.environments.has(body.environment_id)) return fail(404, 'environment not found');
      for (const resource of body.resources ?? []) if (!this.files.has(resource.file_id)) return fail(400, `file ${resource.file_id} was not found`);
      const resources = (body.resources ?? []).map((r: Json) => ({
        id: `sesrsc_${this.nextId()}`,
        type: 'file',
        // A session gets its own copy of each mounted file, with an id of its own.
        file_id: `file_copy_${this.nextId()}`,
        mount_path: `/mnt/session/uploads${r.mount_path}`,
      }));
      const session = new FakeSession(this, `sesn_${this.nextId()}`, body, resources);
      this.sessions.set(session.id, session);
      for (const event of body.initial_events ?? []) {
        session.received.push({ ...event });
        session.emit(event.type, { content: event.content });
      }
      send(200, session.json());
      // The agent starts on its kickoff once the session exists.
      if (body.initial_events?.length) void this.play(session);
      return;
    }
    if (method === 'GET' && path === '/v1/sessions') {
      const agent = url.searchParams.get('agent_id');
      const since = url.searchParams.get('created_at[gte]');
      const found = [...this.sessions.values()].filter((s) => (!agent || s.created.agent?.id === agent) && (!since || s.createdAt >= since));
      return send(200, { data: found.reverse().map((s) => s.json()), next_page: null, prev_page: null });
    }
    match = /^\/v1\/sessions\/([^/]+)(\/.*)?$/.exec(path);
    const session = match ? this.sessions.get(match[1]!) : undefined;
    if (!match) return fail(404, `no route for ${method} ${path}`);
    if (!session) return fail(404, 'session not found');
    const rest = match[2] ?? '';

    if (rest === '' && method === 'GET') return send(200, session.json());
    if (rest === '' && method === 'POST') {
      if (body.budget) {
        const cents = Number(body.budget.max_list_cost.amount);
        if (cents <= session.spentCents) return fail(400, "budget.max_list_cost must be greater than the session's consumed list cost");
        session.capCents = cents;
        session.emit('session.updated', { budget: session.budget() });
        session.wake();
      }
      return send(200, session.json());
    }
    if (rest === '/archive' && method === 'POST') {
      // A session cannot be archived while it is working, or (here, always) while a workflow run in it is open.
      if (session.status === 'running') return fail(400, 'cannot archive a session while it is running');
      if (session.openRun) return fail(400, 'a workflow run is open (workflow_run_open)');
      session.archived = true;
      return send(200, session.json());
    }
    if (rest === '/events' && method === 'GET') return send(200, { data: listed(session.events, url.searchParams), next_page: null });
    if (rest === '/events' && method === 'POST') {
      if (session.archived) return fail(409, 'the session is archived');
      const starts = (body.events as Json[]).some((e) => e.type === 'user.message');
      if (starts && session.blocked) return fail(400, `the session is waiting (${session.blocked}); only user.tool_confirmation, user.tool_result, user.custom_tool_result and user.interrupt are accepted`);
      const echoed = (body.events as Json[]).map((event) => {
        session.received.push({ ...event });
        const fields = event.type === 'user.interrupt' ? {} : (({ type: _type, ...rest }) => rest)(event);
        // A message waiting behind a turn in progress has no time on it until the session takes it up.
        return session.emit(event.type, event.type === 'user.message' && this.queueOnly?.(event) ? { ...fields, processed_at: null } : fields);
      });
      send(200, { data: echoed });
      session.wake();
      return;
    }
    if (rest === '/events/stream' && method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write('event: ping\ndata: {}\n\n');
      session.streams.add(res);
      res.on('close', () => session.streams.delete(res));
      this.onStream?.(session);
      return;
    }
    const thread = /^\/threads\/([^/]+)\/events$/.exec(rest);
    if (thread && method === 'GET') return send(200, { data: session.threads.get(thread[1]!) ?? [], next_page: null });
    return fail(404, `no route for ${method} ${path}`);
  }

  private async play(session: FakeSession): Promise<void> {
    // Give the client a moment to attach, as a real session takes time to start work.
    await new Promise((resolve) => setTimeout(resolve, 5));
    try {
      await this.script(session);
    } catch (err) {
      if (session.status !== 'terminated') session.failure = err;
    }
  }
}

function listed(events: Json[], query: URLSearchParams): Json[] {
  const since = query.get('created_at[gte]');
  const types = [...query.entries()].filter(([key]) => key === 'types' || key.startsWith('types[')).map(([, value]) => value);
  let out = events.filter((e) => (!since || e.processed_at >= since) && (!types.length || types.includes(e.type)));
  if (query.get('order') === 'desc') out = [...out].reverse();
  const cap = Number(query.get('limit') ?? 0);
  return cap > 0 ? out.slice(0, cap) : out;
}

/** Enough of multipart parsing for one uploaded file and its plain fields. */
function multipart(raw: Buffer, contentType: string): { filename: string; bytes: Buffer; fields: Record<string, string> } {
  const boundary = Buffer.from(`--${/boundary=([^;]+)/.exec(contentType)![1]!.replace(/^"|"$/g, '')}`);
  const out = { filename: 'unnamed', bytes: Buffer.alloc(0), fields: {} as Record<string, string> };
  let at = raw.indexOf(boundary);
  while (at >= 0) {
    const next = raw.indexOf(boundary, at + boundary.length);
    if (next < 0) break;
    const part = raw.subarray(at + boundary.length + 2, next - 2);
    const split = part.indexOf('\r\n\r\n');
    const head = part.subarray(0, split).toString('utf8');
    const content = part.subarray(split + 4);
    const name = /name="([^"]*)"/.exec(head)?.[1] ?? '';
    const filename = /filename="([^"]*)"/.exec(head)?.[1];
    if (filename !== undefined) {
      out.filename = filename;
      out.bytes = Buffer.from(content);
    } else if (name) {
      out.fields[name] = content.toString('utf8');
    }
    at = next;
  }
  return out;
}
