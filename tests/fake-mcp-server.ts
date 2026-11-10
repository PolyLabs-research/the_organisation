import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// A tool server for the tests: the protocol's own server classes behind a local address, so that what is tested is
// the real client speaking the real protocol. What it offers is plain data that a test can change between requests.

export interface FakeTool {
  name: string;
  description?: string;
  inputSchema: { [key: string]: unknown };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  /** What is remembered between the calls of one session is passed in, for a tool that keeps its place. */
  run(input: { [key: string]: unknown }, memory: Map<string, unknown>, signal: AbortSignal): CallToolResult | Promise<CallToolResult>;
}
export const text = (value: string): CallToolResult => ({ content: [{ type: 'text', text: value }] });
export const taking = (properties: { [name: string]: unknown }, required: string[] = Object.keys(properties)) => ({ type: 'object', properties, required });

export class FakeToolServer {
  /** The token the server asks for. Empty for a server that asks for none. */
  token = 'tool-server-token-0001';
  /** The header it reads the token from: as a bearer token in Authorization, and as it is in any other. */
  header = 'authorization';
  name = 'Orders';
  tools: FakeTool[] = [
    { name: 'find_order', description: 'Look up an order by its number.', inputSchema: taking({ number: { type: 'string', description: 'The order number' } }), annotations: { readOnlyHint: true }, run: input => text('Order ' + String(input.number) + ': 3 ferns, paid.') },
    { name: 'cancel_order', description: 'Cancel an order. This cannot be undone.', inputSchema: taking({ number: { type: 'string' }, reason: { type: 'string' } }, ['number']), annotations: { readOnlyHint: false, destructiveHint: true }, run: input => text('Order ' + String(input.number) + ' is cancelled.') },
    { name: 'remember', description: 'Keep a value for this session.', inputSchema: taking({ value: { type: 'string' } }), run: (input, memory) => { memory.set('value', input.value); return text('Kept.'); } },
    { name: 'recall', description: 'Give back the value kept in this session.', inputSchema: taking({}), annotations: { readOnlyHint: true }, run: (_input, memory) => text(String(memory.get('value') ?? 'nothing')) },
  ];
  /** Every request as it arrived: what it was, the session it named, and what it carried in Authorization and in the header the token is read from. */
  readonly seen: Array<{ method: string; path: string; session: string | undefined; authorization: string | undefined; key: string | undefined }> = [];
  /** Every tool call that reached a tool. */
  readonly calls: Array<{ tool: string; input: unknown; session: string | undefined }> = [];
  url = '';
  base = '';
  private readonly sessions = new Map<string, { transport: StreamableHTTPServerTransport; memory: Map<string, unknown> }>();
  private readonly server = http.createServer((req, res) => { void this.answer(req, res).catch(() => { if (!res.headersSent) res.writeHead(500).end(); }); });

  /** Sessions still open on the server. */
  get open(): number { return this.sessions.size; }
  /** The server loses every session it had, as one does when it restarts. */
  forget(): void { this.sessions.clear(); }

  private build(memory: Map<string, unknown>): Server {
    const server = new Server({ name: this.name, version: '2.1.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: this.tools.map(({ run: _run, ...tool }) => tool) }) as never);
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const tool = this.tools.find(item => item.name === request.params.name);
      if (!tool) throw new McpError(ErrorCode.InvalidParams, 'Unknown tool: ' + request.params.name);
      this.calls.push({ tool: tool.name, input: request.params.arguments, session: extra.sessionId });
      return tool.run(request.params.arguments ?? {}, memory, extra.signal);
    });
    return server;
  }

  private async answer(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const path = (req.url ?? '').split('?')[0]!;
    const session = typeof req.headers['mcp-session-id'] === 'string' ? req.headers['mcp-session-id'] : undefined;
    const key = typeof req.headers[this.header] === 'string' ? (req.headers[this.header] as string) : undefined;
    this.seen.push({ method: req.method ?? '', path, session, authorization: req.headers.authorization, key });
    if (path === '/page') { res.writeHead(200, { 'content-type': 'text/html' }).end('<h1>Not a tool server</h1>'); return; }
    if (path === '/moved') { res.writeHead(307, { location: this.elsewhere + '/mcp' }).end(); return; }
    if (path !== '/mcp') { res.writeHead(404).end(); return; }
    if (this.token && key !== (this.header === 'authorization' ? 'Bearer ' + this.token : this.token)) { res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized' })); return; }
    let known = session ? this.sessions.get(session) : undefined;
    if (!known) {
      if (session) { res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null })); return; }
      const memory = new Map<string, unknown>();
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: id => { this.sessions.set(id, { transport, memory }); },
        onsessionclosed: id => { this.sessions.delete(id); },
      });
      known = { transport, memory };
      await this.build(memory).connect(transport);
    }
    await known.transport.handleRequest(req, res);
  }

  /** Where `/moved` sends a request on to: another origin, which must never be sent anything. */
  elsewhere = 'http://127.0.0.1:9';

  async listen(): Promise<void> {
    await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve));
    this.base = 'http://127.0.0.1:' + (this.server.address() as AddressInfo).port;
    this.url = this.base + '/mcp';
  }
  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
  }
}
