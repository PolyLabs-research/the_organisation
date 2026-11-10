import { createHash } from 'node:crypto';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { JsonSchemaValidator, jsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/types.js';
import { tokenHeader, toolServerURL } from './access-network';
import { AccessError, type StoredTool, type ToolServerSecret } from './access-vault';

// Tool servers: other programs' tools, offered over the Model Context Protocol (MCP). This is the only place that
// speaks to one. The address and the token come from the vault for every use, and no agent chooses either. Nothing a
// server says is taken as true: what it lists is kept only in the shape checked here, and what a tool returns goes
// back as text and as nothing else. A request is never sent on to another origin, so a token goes only where a
// person sent it.

const CLIENT = { name: 'the_organisation', version: '1.0.0' };
const CONNECT_MS = 20_000;
const LIST_MS = 20_000;
const CALL_MS = 120_000;
const CLOSE_MS = 5_000;
const IDLE_MS = 10 * 60_000;
const MAX_SESSIONS = 48;
const MAX_PAGES = 20;
const MAX_TOOLS = 150;
const MAX_NAME_CHARS = 128;
const MAX_DESCRIPTION_CHARS = 4_000;
const MAX_SCHEMA_CHARS = 20_000;
/** All of one server's descriptions together. They are kept in the vault, which is written whole at every change. */
const MAX_KEPT_CHARS = 500_000;
const MAX_RESULT_CHARS = 60_000;
const MAX_RESPONSE_BYTES = 8_000_000;
/** A model's tool list takes names of 64 characters, and one provider puts a prefix of its own in front. */
const MAX_CALL_NAME = 48;
/** The names every model provider accepts for what a tool takes. One that does not fit has the whole request refused. */
const PROPERTY_NAME = /^[a-zA-Z0-9_.-]{1,64}$/;

/** A tool as a server lists it, checked and cut to size. The name agents call it by and a person's approval are added where it is kept. */
export type ListedTool = Omit<StoredTool, 'callName' | 'approved'>;
export interface ToolFacts { serverName: string; tools: ListedTool[]; leftOut: number; }
type Server = Pick<ToolServerSecret, 'id' | 'url' | 'password' | 'header'>;
type Address = Pick<Server, 'url' | 'password' | 'header'>;

/** Everything the program does on a tool server. Tests point it at a local one. */
export interface ToolHost {
  /** What the server offers now. Asked in a session of its own, which ends with the answer. */
  tools(server: Address, signal: AbortSignal): Promise<ToolFacts>;
  /** One call of one tool. Calls made for the same piece of work share a session, since a server may keep its place between them. */
  call(server: Server, work: string, name: string, input: { [key: string]: unknown }, signal: AbortSignal): Promise<{ text: string; failed: boolean }>;
  /** End the sessions with one server, those of one piece of work, or all of them. */
  close(serverId?: string, work?: string): Promise<void>;
}

const ordered = (value: unknown): unknown => Array.isArray(value) ? value.map(ordered)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered((value as { [key: string]: unknown })[key])]))
    : value;
const short = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * Everything about a tool that a person sees when allowing it and a model sees when using it, as one value. A person
 * allows a tool as it is described: described any differently, it has another fingerprint and has not been allowed.
 */
export function fingerprint(tool: Pick<StoredTool, 'name' | 'description' | 'inputSchema' | 'readOnly' | 'destructive' | 'unusable'>): string {
  return short(JSON.stringify(ordered([tool.name, tool.description, tool.inputSchema, tool.readOnly, tool.destructive, tool.unusable]))).slice(0, 32);
}

/** What goes in front of a server's tools' names: a few letters of its label, and not what another server has. */
export function prefixFor(label: string, taken: ReadonlySet<string>): string {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 12) || 'tools';
  for (let n = 1; ; n++) {
    const prefix = n === 1 ? base : base + n;
    if (!taken.has(prefix)) return prefix;
  }
}

/** The name agents call a tool by: the server's prefix and the tool's own name, in the characters and the length a model's tool list takes. */
export function callName(prefix: string, name: string, taken: Set<string>): string {
  const marked = (full: string) => full.slice(0, MAX_CALL_NAME - 7) + '_' + short(name).slice(0, 6);
  let full = prefix + '__' + name.replace(/[^A-Za-z0-9_-]/g, '_');
  if (full.length > MAX_CALL_NAME) full = marked(full);
  if (taken.has(full)) full = marked(full);
  taken.add(full);
  return full;
}

/** What a reference inside a schema points at, or undefined. Only a reference into the schema itself is followed: nothing is ever fetched. */
function pointed(root: unknown, ref: unknown): unknown {
  if (typeof ref !== 'string' || !ref.startsWith('#')) return undefined;
  let at: unknown = root;
  try {
    for (const part of decodeURIComponent(ref.slice(1)).split('/').slice(1)) {
      if (!at || typeof at !== 'object') return undefined;
      at = (at as { [key: string]: unknown })[part.replaceAll('~1', '/').replaceAll('~0', '~')];
    }
  } catch { return undefined; }
  return at;
}
/** Whether a schema is one a model provider takes: schemas all the way down, not too deep, every reference to something in it, and every property under a name a model can write. */
function fits(schema: unknown, root: unknown, depth = 0): boolean {
  if (typeof schema === 'boolean') return true;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || depth > 16) return false;
  const node = schema as { [key: string]: unknown };
  if (node.$ref !== undefined && pointed(root, node.$ref) === undefined) return false;
  for (const key of ['properties', '$defs', 'definitions']) {
    const map = node[key];
    if (map === undefined) continue;
    if (!map || typeof map !== 'object' || Array.isArray(map)) return false;
    for (const [name, sub] of Object.entries(map)) if ((key === 'properties' && !PROPERTY_NAME.test(name)) || !fits(sub, root, depth + 1)) return false;
  }
  for (const key of ['items', 'additionalProperties', 'not', 'if', 'then', 'else', 'contains', 'propertyNames', 'unevaluatedProperties', 'unevaluatedItems']) {
    if (node[key] !== undefined && !fits(node[key], root, depth + 1)) return false;
  }
  for (const key of ['anyOf', 'oneOf', 'allOf', 'prefixItems']) {
    const list = node[key];
    if (list !== undefined && (!Array.isArray(list) || !list.every(item => fits(item, root, depth + 1)))) return false;
  }
  return true;
}

/** Holds a schema against the rules for schemas, which is a check of data. A server's schema is never compiled into anything that runs. */
const rules = new Ajv2020({ strict: false, validateFormats: false, logger: false });
/** The words in a schema that are there to be read, by a person or a model, and change nothing about what the tool takes. */
const WORDS = new Set(['description', 'title', '$comment']);
/**
 * A schema with nothing in it that cannot be seen. Its descriptions are cleaned like any other text from a server.
 * Anything else, such as a name or one of the values a tool will take, cannot be altered without altering the tool,
 * so a schema with something unseen there is not one that can be offered: this returns null.
 */
function legible(value: unknown, key = '', depth = 0): unknown {
  if (typeof value === 'string') return WORDS.has(key) ? plain(value, MAX_DESCRIPTION_CHARS) : hides(value) ? null : value;
  if (!value || typeof value !== 'object') return value;
  if (depth > 40) return null;
  if (Array.isArray(value)) {
    const items = value.map(item => legible(item, '', depth + 1));
    return items.some((item, i) => item === null && value[i] !== null) ? null : items;
  }
  const kept: Array<[string, unknown]> = [];
  for (const [name, item] of Object.entries(value)) {
    const clean = legible(item, name, depth + 1);
    // A name that would be taken for the object's own workings is not one a schema has any use for.
    if (name === '__proto__' || hides(name) || (clean === null && item !== null)) return null;
    kept.push([name, clean]);
  }
  return Object.fromEntries(kept);
}

const NOTHING = { type: 'object', properties: {} };
/**
 * What a tool takes, as every model provider will accept it, or why it cannot be offered. A schema a provider turns
 * down has the whole request refused, and with it every task of the team, so one that might be is kept back here.
 */
function inputOf(raw: unknown): { inputSchema: { [key: string]: unknown }; unusable: string } {
  const cannot = (unusable: string) => ({ inputSchema: NOTHING, unusable });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return cannot('The server does not say what it takes.');
  const seen = legible(raw);
  if (!seen) return cannot('Its description of what it takes carries characters that cannot be seen, or a name that cannot be used.');
  const { $schema: _dialect, anyOf, oneOf, allOf, not: _not, if: _if, then: _then, else: _else, ...schema } = seen as { [key: string]: unknown };
  if (schema.type !== 'object') return cannot('What it takes is not described as a set of named values.');
  // A choice between whole shapes cannot be put to a model at the top. Where the values are named anyway, the server is left to hold the call to the rest.
  if ((anyOf || oneOf || allOf) && !Object.keys((schema.properties as object | undefined) ?? {}).length) return cannot('What it takes is described as a choice between shapes, which cannot be offered to a model.');
  schema.properties ??= {};
  if (JSON.stringify(schema).length > MAX_SCHEMA_CHARS) return cannot('Its description of what it takes is too long.');
  if (!fits(schema, schema)) return cannot('One of the values it takes has a name or a form a model cannot use.');
  try {
    if (rules.validateSchema(schema) !== true) return cannot('Its description of what it takes is not a valid JSON Schema.');
  } catch { return cannot('Its description of what it takes is not a valid JSON Schema.'); }
  return { inputSchema: schema, unusable: '' };
}

/**
 * Characters that take up no room on a page, or that turn the page's direction round. A person reading a tool's
 * description before allowing it cannot see them, and a model reads them, so nothing a model is shown may carry one.
 */
const UNSEEN = /\p{Default_Ignorable_Code_Point}/gu;
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
const hides = (text: string) => text.search(UNSEEN) >= 0 || text.search(CONTROLS) >= 0;
/** Text from a server as it is kept and shown: what cannot be seen taken out, and no run of empty lines to push the rest out of sight. */
const plain = (text: unknown, limit: number) => (typeof text === 'string' ? text.slice(0, limit * 8) : '').replace(CONTROLS, ' ').replace(UNSEEN, '').replace(/\n[ \t]*(\n[ \t]*)+\n/g, '\n\n').trim().slice(0, limit);

/** A server's list of tools as it is kept: checked one by one, and no more of it than there is room for. */
export function listed(tools: readonly unknown[]): { tools: ListedTool[]; leftOut: number } {
  const kept: ListedTool[] = [];
  const names = new Set<string>();
  let room = MAX_KEPT_CHARS;
  for (const item of tools) {
    const raw = (item && typeof item === 'object' ? item : {}) as { name?: unknown; title?: unknown; description?: unknown; inputSchema?: unknown; annotations?: { title?: unknown; readOnlyHint?: unknown; destructiveHint?: unknown } };
    const name = typeof raw.name === 'string' ? raw.name : '';
    if (!name || name.length > MAX_NAME_CHARS || /[\n\t]/.test(name) || hides(name) || names.has(name) || kept.length >= MAX_TOOLS) continue;
    const hint = (value: unknown) => (typeof value === 'boolean' ? value : null);
    const tool: ListedTool = {
      name,
      description: plain(raw.description, MAX_DESCRIPTION_CHARS) || plain(raw.title, 300) || plain(raw.annotations?.title, 300),
      ...inputOf(raw.inputSchema),
      readOnly: hint(raw.annotations?.readOnlyHint),
      destructive: hint(raw.annotations?.destructiveHint),
    };
    const size = JSON.stringify(tool).length;
    if (size > room) continue;
    room -= size;
    names.add(name);
    kept.push(tool);
  }
  return { tools: kept, leftOut: tools.length - kept.length };
}

/** What a tool returned, as text. Pictures, recordings and files are named and not passed on: an agent reads text. */
export function rendered(result: unknown): { text: string; failed: boolean } {
  const answer = (result && typeof result === 'object' ? result : {}) as { content?: unknown; structuredContent?: unknown; toolResult?: unknown; isError?: unknown };
  const parts: string[] = [];
  for (const item of Array.isArray(answer.content) ? answer.content : []) {
    const block = (item && typeof item === 'object' ? item : {}) as { type?: unknown; text?: unknown; mimeType?: unknown; uri?: unknown; name?: unknown; resource?: { uri?: unknown; text?: unknown; mimeType?: unknown } };
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'resource' && typeof block.resource?.text === 'string') parts.push('[' + String(block.resource.uri ?? 'attached text') + ']\n' + block.resource.text);
    else if (block.type === 'resource') parts.push('[The tool attached a file that cannot be shown here: ' + String(block.resource?.uri ?? '') + ' ' + String(block.resource?.mimeType ?? '') + ']');
    else if (block.type === 'resource_link') parts.push('[The tool pointed to ' + String(block.name ?? 'a resource') + ': ' + String(block.uri ?? '') + ']');
    else if (block.type === 'image' || block.type === 'audio') parts.push('[The tool returned ' + (block.type === 'image' ? 'a picture' : 'a recording') + ' that cannot be shown here: ' + String(block.mimeType ?? '') + ']');
  }
  let text = parts.join('\n\n');
  const data = answer.structuredContent ?? answer.toolResult;
  if (!text.trim() && data !== undefined) text = JSON.stringify(data) ?? '';
  if (text.length > MAX_RESULT_CHARS) text = text.slice(0, MAX_RESULT_CHARS) + '\n[Shortened: the tool returned more than can be passed on.]';
  return { text: text || '[The tool returned nothing.]', failed: answer.isError === true };
}

/** A fetch that stops reading an answer once it is longer than any honest one. */
const capped: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  if (!response.body) return response;
  let seen = 0;
  const counted = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(part, controller) {
      seen += part.byteLength;
      if (seen > MAX_RESPONSE_BYTES) controller.error(new Error('The server sent more than can be taken.'));
      else controller.enqueue(part);
    },
  }));
  return new Response(counted, { status: response.status, statusText: response.statusText, headers: response.headers });
};

const unchecked: jsonSchemaValidator = {
  getValidator<T>(): JsonSchemaValidator<T> { return input => ({ valid: true, data: input as T, errorMessage: undefined }); },
};

const within = async (ms: number, work: Promise<unknown>): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([work, new Promise(resolve => { timer = setTimeout(resolve, ms); timer.unref(); })]);
  clearTimeout(timer);
};

interface Session {
  key: string; serverId: string; work: string; client: Client; transport: StreamableHTTPClientTransport;
  /** Calls under way in it. */
  calls: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** Let go of. A call that was handed it before then opens another. */
  closed: boolean;
}

export class McpToolHost implements ToolHost {
  /** Each session by its server and its piece of work: while it is being opened, and once it is open. */
  private readonly sessions = new Map<string, { opening: Promise<Session>; open?: Session }>();

  /** An error as a person or an agent may read it: what went wrong, in words fixed here, and never a request, a header or the token. */
  private refused(error: unknown, token: string): AccessError {
    if (error instanceof AccessError) return error;
    if (error instanceof StreamableHTTPError) {
      const status = error.code ?? 0;
      if (status === 401 || status === 403) return new AccessError(token ? 'The server refused the token. It may be wrong, or have expired.' : 'The server asks for a token, or for a sign-in that cannot be done from here.', 403);
      if (status === 404 || status === 405) return new AccessError('There is no tool server at that address. Check the path: many answer at /mcp.', 404);
      if (status === 429) return new AccessError('The server is turning requests away for now. Try again later.', 429);
      if (status >= 300 && status < 400) return new AccessError('The server sent the request on to another address, which is not followed. Give the address the server itself answers at.', 502);
      if (status === -1) return new AccessError('What answers at that address is not a tool server.', 502);
      return new AccessError('The server could not complete the request.', 502);
    }
    if (error instanceof McpError) {
      if (error.code === ErrorCode.RequestTimeout) return new AccessError('The server did not answer in time.', 504);
      if (error.code === ErrorCode.ConnectionClosed) return new AccessError('The connection to the server was closed.', 502);
      return new AccessError('The server answered with an error: ' + this.said(error, token), 502);
    }
    return new AccessError('The server could not be reached, or what it sent is not what a tool server sends.', 502);
  }
  private said(error: McpError, token: string): string {
    // The protocol's own label can come twice: once put on by the server, and once on arrival.
    const text = plain(error.message.replace(/^(MCP error -?\d+: )+/, ''), 300) || 'it did not say what.';
    return token ? text.split(token).join('[redacted]') : text;
  }

  private async connect(server: Address, signal: AbortSignal): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
    // In Authorization a token goes as a bearer token. A service that names a header of its own for its key reads the key there as it is.
    const header = tokenHeader(server.header || 'Authorization');
    const transport = new StreamableHTTPClientTransport(toolServerURL(server.url), {
      fetch: capped,
      requestInit: server.password ? { headers: { [header]: header === 'Authorization' ? 'Bearer ' + server.password : server.password } } : undefined,
    });
    // Nothing is offered to the server: it cannot ask a model anything, ask a person anything or read any files through this.
    // What a tool says it returns is not held to a schema either, so no schema of the server's is ever compiled.
    const client = new Client(CLIENT, { capabilities: {}, jsonSchemaValidator: unchecked });
    try {
      await client.connect(transport, { signal, timeout: CONNECT_MS });
      return { client, transport };
    } catch (error) {
      await client.close().catch(() => {});
      throw error;
    }
  }
  /** Telling a server its session is over is a courtesy. It is not waited on for long. */
  private async end(client: Client, transport: StreamableHTTPClientTransport): Promise<void> {
    await within(CLOSE_MS, transport.terminateSession().catch(() => {}));
    await client.close().catch(() => {});
  }

  async tools(server: Address, signal: AbortSignal): Promise<ToolFacts> {
    let open: { client: Client; transport: StreamableHTTPClientTransport } | undefined;
    try {
      open = await this.connect(server, signal);
      const all: unknown[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES && all.length < MAX_TOOLS * 4; page++) {
        const answer = await open.client.listTools(cursor ? { cursor } : undefined, { signal, timeout: LIST_MS });
        all.push(...answer.tools);
        cursor = answer.nextCursor;
        if (!cursor) break;
      }
      const about = open.client.getServerVersion();
      const facts = listed(all);
      // A list that was still going on when the reading stopped has at least one more in it.
      return { serverName: plain([about?.title ?? about?.name, about?.version].filter(Boolean).join(' '), 200), tools: facts.tools, leftOut: facts.leftOut + (cursor ? 1 : 0) };
    } catch (error) {
      if (signal.aborted) throw error;
      throw this.refused(error, server.password);
    } finally {
      if (open) await this.end(open.client, open.transport);
    }
  }

  private session(server: Server, work: string, signal: AbortSignal): Promise<Session> {
    const key = server.id + ':' + work;
    const known = this.sessions.get(key);
    if (known) return known.opening;
    if (this.sessions.size >= MAX_SESSIONS) throw new AccessError('Too many sessions with tool servers are open at once. Try again shortly.', 409);
    const entry: { opening: Promise<Session>; open?: Session } = {
      opening: this.connect(server, signal).then(({ client, transport }) => (entry.open = { key, serverId: server.id, work, client, transport, calls: 0, timer: null, closed: false })),
    };
    this.sessions.set(key, entry);
    // One that could not be opened is not kept: the next call tries afresh.
    entry.opening.catch(() => { if (this.sessions.get(key) === entry) this.sessions.delete(key); });
    return entry.opening;
  }
  /** Let go of a session. It is out of the list before anything is waited for, so that nothing new is started in it. */
  private drop(session: Session): Promise<void> {
    session.closed = true;
    if (session.timer) clearTimeout(session.timer);
    session.timer = null;
    if (this.sessions.get(session.key)?.open === session) this.sessions.delete(session.key);
    return this.end(session.client, session.transport);
  }

  async call(server: Server, work: string, name: string, input: { [key: string]: unknown }, signal: AbortSignal): Promise<{ text: string; failed: boolean }> {
    for (let attempt = 0; ; attempt++) {
      let session: Session;
      try { do session = await this.session(server, work, signal); while (session.closed); }
      catch (error) {
        if (signal.aborted) throw error;
        throw this.refused(error, server.password);
      }
      session.calls++;
      if (session.timer) clearTimeout(session.timer);
      session.timer = null;
      let failed = false;
      try {
        return rendered(await session.client.callTool({ name, arguments: input }, undefined, { signal, timeout: CALL_MS, maxTotalTimeout: CALL_MS }));
      } catch (error) {
        if (signal.aborted) { failed = true; throw error; }
        // The server understood and said no: there is no such tool, or it will not take what it was given. The agent is told, and the session is still good.
        if (error instanceof McpError && error.code !== ErrorCode.RequestTimeout && error.code !== ErrorCode.ConnectionClosed) return { text: 'The server answered with an error: ' + this.said(error, server.password), failed: true };
        failed = true;
        // A server that has forgotten the session never saw the call, so it is safe to make it once more in a new one.
        if (attempt === 0 && error instanceof StreamableHTTPError && error.code === 404) continue;
        if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) throw new AccessError('The tool did not answer in time. It may still have done what was asked: check before calling it again.', 504);
        throw this.refused(error, server.password);
      } finally {
        session.calls--;
        // A session that has failed is not used again. One that is idle is kept for a while, in case the work comes back to it.
        if (failed) await this.drop(session);
        else if (session.calls === 0 && !session.closed) {
          session.timer = setTimeout(() => { if (session.calls === 0) void this.drop(session); }, IDLE_MS);
          session.timer.unref();
        }
      }
    }
  }

  async close(serverId?: string, work?: string): Promise<void> {
    const ending: Promise<void>[] = [];
    for (const [key, entry] of this.sessions) {
      const [ofServer, ...rest] = key.split(':');
      if ((serverId && ofServer !== serverId) || (work && rest.join(':') !== work)) continue;
      this.sessions.delete(key);
      ending.push(entry.opening.then(session => this.drop(session), () => {}));
    }
    await Promise.all(ending);
  }
}
