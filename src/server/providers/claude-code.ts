import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { z } from 'zod';
import type { ProviderInfo } from '../../shared/types';
import { MODELS, costOfRequest, isKnownModel } from './pricing';
import { ProviderError, type AgentRequest, type AgentResult, type AgentTool, type CallUsage, type Provider, type StructuredRequest, type SystemPrompt } from './types';

// Runs the organisation on Claude through Claude Code, the program, instead
// of through an API key: each call is one non-interactive run of the `claude`
// command on this machine, which uses whatever login that command has. The
// login itself is never read, copied or sent anywhere by this project.
//
// A run is given nothing of the person's own Claude Code set-up: no settings,
// plugins, skills, memory files or tool servers, and none of its built-in
// tools, so it cannot run a command or read a file. An agent's tools are the
// organisation's own, served to that one run over a local tool server (MCP)
// on a loopback port, under a path only that run is told.
//
// What is known of the command's behaviour was read from its documentation
// and checked against Claude Code 2.1.317 on Linux with a few short runs.

/** The oldest Claude Code this works with: the first that takes every option used here. */
export const MIN_CLAUDE_CODE = '2.1.259';
/** The model a new organisation starts on when Claude Code is the only connection: the balanced one, which is kinder to a plan's limits. */
export const CLAUDE_CODE_STARTER = 'claude-sonnet-5-5';

/** The name the tool server goes by. Claude Code shows the model each tool as mcp__<this>__<tool>. */
const SERVER_NAME = 'org';
/** Turns allowed beyond the engine's own limit, for the closing report after the agent is told to stop. */
const TURN_SLACK = 4;
/** A tool result may be this long before Claude Code would put it in a file the agent has no tool to read. */
const MAX_RESULT_CHARS = 200_000;
/** The most a tool call's body may weigh. A file an agent writes can be a megabyte, and JSON makes it longer. */
const MAX_BODY_BYTES = 8_000_000;

const WRAP_UP =
  'You have to stop here. Do not call any more tools. Give your closing report now: what you produced and where, and exactly what is left unfinished.';

export interface ClaudeCodeOptions {
  /** The command to run. "claude", found on the PATH, unless told otherwise. */
  command?: string;
  /** A directory of this provider's own: where runs are started from, and where the files handed to them are kept. */
  dir: string;
  /** The environment to start from. The server's own unless given. */
  env?: NodeJS.ProcessEnv;
  /** Carry on when the plan's included usage is spent and Claude Code starts using paid extra usage. Off unless asked for. */
  extraUsage?: boolean;
  /** How long a run may say nothing before it is given up on. */
  idleTimeoutMs?: number;
  /** How long a run is given to end after being told to, before it is killed outright. */
  killGraceMs?: number;
}

/** What Claude Code said about itself when asked. */
export interface ClaudeCodeStatus {
  version: string;
  /** "claude.ai" for a subscription login; otherwise whatever Claude Code calls the way it is signed in. */
  authMethod: string;
  /** The plan, where the login is a subscription: "max", "pro" and so on. */
  plan: string | null;
}

/** What Claude Code last said about the login's usage limits. */
export interface UsageLimits {
  status: string;
  /** Which limit it is about, e.g. "seven_day". */
  window: string | null;
  /** How much of that limit is used, from 0 to 1, where Claude Code says. */
  utilization: number | null;
  resetsAt: string | null;
  /** True once the plan's included usage is spent and usage is being billed as extra. */
  usingExtra: boolean;
  /** Whether the account lets that happen at all. */
  extraAllowed: boolean;
  seenAt: string;
}

type Json = Record<string, unknown>;
type Killed = 'abort' | 'stop' | 'idle' | 'extra_usage' | 'answered';

/** Runs in flight, in every provider. A run must not outlive the server that is answering its tool calls and counting its spend. */
const LIVE = new Set<ChildProcess>();
let watching = false;
function track(child: ChildProcess): void {
  LIVE.add(child);
  child.once('close', () => LIVE.delete(child));
  if (watching) return;
  watching = true;
  process.once('exit', () => {
    for (const run of LIVE) run.kill('SIGTERM');
  });
}

interface Tokens {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

interface Outcome {
  /** The run's closing "result" event, if it got that far. */
  result: Json | null;
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  /** What the model last said in words. */
  lastText: string;
  /** How many replies the model gave. */
  turns: number;
  killed: Killed | null;
}

/** What a run in progress can be asked, by the tool server that is answering its calls. */
interface Live {
  turns(): number;
  kill(why: Killed): void;
}

/** What a caller wants to hear of a run while it is under way. */
interface Watch {
  onStart?(live: Live): void;
  /** The model has given a structured answer. True if that is all that was wanted, and the run can end here. */
  onStructured?(input: unknown): boolean;
}

type RunRequest = Pick<StructuredRequest<unknown>, 'model' | 'effort' | 'system' | 'prompt' | 'signal' | 'onUsage'>;

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const brief = (value: string, max = 400): string => (value.length > max ? `${value.slice(0, max)}…` : value);

/**
 * Put right a slip a model makes when it writes a structured answer: a long text field ended with a tag of its
 * own name ("</summary>") instead of the proper ending, so that the fields after it are swallowed into its text.
 * Claude Code then sees those fields as missing and asks again, sometimes until it gives up, though the answer
 * was all there. Seen with Claude Haiku 5.5 on 2026-11-06, in one structured answer in ten.
 */
export function unswallow(input: unknown): unknown {
  if (!isObject(input)) return input;
  const out: Json = { ...input };
  for (const [field, value] of Object.entries(input)) {
    if (typeof value !== 'string') continue;
    // The text, then for each swallowed field its name and what was written for it.
    const parts = value.split(/<\/[\w.-]+>\s*<parameter name="([\w.-]+)">/);
    if (parts.length < 3) continue;
    out[field] = parts[0]!.trimEnd();
    for (let i = 1; i + 1 < parts.length; i += 2) {
      const name = parts[i]!;
      // A field that did arrive is not written over by something found inside another.
      if (name in input) continue;
      const raw = parts[i + 1]!.replace(/<\/[\w.-]+>\s*$/, '').trim();
      let found: unknown = raw;
      if (/^[[{]/.test(raw)) {
        try {
          found = JSON.parse(raw);
        } catch {
          // Then it is text.
        }
      }
      out[name] = found;
    }
  }
  return out;
}

/** A model's name without the parts that vary between two names for the same model: a date, a context-window marker. */
function canonical(model: string): string {
  return model.replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '');
}

function parseVersion(value: string): [number, number, number] | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(value);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function olderThan(version: string, least: string): boolean {
  const a = parseVersion(version);
  const b = parseVersion(least);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! < b[i]!;
  }
  return false;
}

/** Variables that say where Claude Code keeps its login, which a run needs; every other CLAUDE variable is left behind. */
const KEPT = new Set(['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN']);

/**
 * The environment a run is started in: the server's own, without anything that would change whose account the
 * run is on or how it behaves. An API key in the server's environment is for the API connection; handed to
 * Claude Code it would be used in place of the login, and billed. Variables that Claude Code sets for its own
 * child processes are left out too, so that a server started from inside a Claude Code session does not pass
 * that session's identity on. Other providers' keys have no business in the run either.
 */
export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (/^ANTHROPIC_/.test(name)) continue;
    if (/^CLAUDE(CODE|_)/.test(name) && !KEPT.has(name)) continue;
    if (/_(API_KEY|AUTH_TOKEN|BASE_URL)$/.test(name)) continue;
    out[name] = value;
  }
  // Nothing of the person's own instructions or memory goes into a seat's prompt, and nothing is left running behind.
  out.CLAUDE_CODE_DISABLE_CLAUDE_MDS = '1';
  out.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  out.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = '1';
  return out;
}

function notFound(command: string): ProviderError {
  return new ProviderError(
    `Claude Code was not found on this machine: there is no "${command}" command to run. Install it (https://code.claude.com/docs/en/setup), or set CLAUDE_CODE_PATH to where it is.`,
    'auth',
    false,
  );
}

/** Run the command for a short answer, with nothing on its input. */
function ask(command: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = 20_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(err.code === 'ENOENT' || err.code === 'EACCES' ? notFound(command) : new ProviderError(`Claude Code could not be started: ${err.message}`, 'unavailable', false));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * Ask Claude Code which version it is and whether it is signed in. Neither question calls a model. Throws,
 * with words for the person, if the command is missing, too old or not signed in.
 */
export async function checkClaudeCode(command = 'claude', env: NodeJS.ProcessEnv = process.env): Promise<ClaudeCodeStatus> {
  const clean = childEnv(env);
  const said = await ask(command, ['--version'], clean);
  const version = /claude code/i.test(said.stdout) ? parseVersion(said.stdout)?.join('.') : undefined;
  if (!version) {
    throw new ProviderError(`"${command} --version" did not answer as Claude Code does${said.stderr.trim() ? ` (${brief(said.stderr.trim(), 200)})` : ''}. Set CLAUDE_CODE_PATH to the Claude Code command.`, 'auth', false);
  }
  if (olderThan(version, MIN_CLAUDE_CODE)) {
    throw new ProviderError(`Claude Code ${version} is too old for this: ${MIN_CLAUDE_CODE} or later is needed. Update it with "claude update".`, 'auth', false);
  }
  const auth = await ask(command, ['auth', 'status', '--json'], clean);
  let status: Json | null = null;
  try {
    const parsed: unknown = JSON.parse(auth.stdout);
    if (isObject(parsed)) status = parsed;
  } catch {
    // Said below.
  }
  if (!status) throw new ProviderError('Claude Code did not say whether it is signed in. Run "claude auth status" in a terminal to see why.', 'auth', false);
  if (status.loggedIn !== true) {
    throw new ProviderError('Claude Code is installed but not signed in. Run "claude" in a terminal, sign in, and then connect it here again.', 'auth', false);
  }
  return { version, authMethod: text(status.authMethod) || 'unknown', plan: text(status.subscriptionType) || null };
}

/** A line about a login for the keys page: which Claude Code, and how it is signed in. */
export function describeStatus(status: ClaudeCodeStatus): string {
  const how =
    status.authMethod === 'claude.ai'
      ? `signed in with ${status.plan ? `a Claude ${status.plan.charAt(0).toUpperCase()}${status.plan.slice(1)} plan` : 'a Claude plan'}`
      : `signed in another way (${status.authMethod}), so its usage is billed to that account`;
  return `Claude Code ${status.version}, ${how}`;
}

// ---- the tool server ----

interface Session {
  tools: AgentTool[];
  call(name: string, input: unknown): Promise<{ text: string; isError: boolean }>;
}

/**
 * A tool server for the runs of one provider: it speaks as much of the Model Context Protocol over HTTP as
 * Claude Code needs to list a run's tools and call them. Each run reaches its own tools under a path that
 * holds a secret made for that run, on a loopback port, and the path stops working when the run is over.
 */
class ToolBridge {
  private server: http.Server | null = null;
  private starting: Promise<number> | null = null;
  private readonly sessions = new Map<string, Session>();

  private listen(): Promise<number> {
    this.starting ??= new Promise<number>((resolve, reject) => {
      const server = http.createServer((req, res) => void this.handle(req, res));
      server.once('error', (err) => {
        // A port that could not be had this time may be had the next.
        this.starting = null;
        reject(err);
      });
      server.listen(0, '127.0.0.1', () => {
        this.server = server;
        // Nothing waits on this server: it must not keep the process alive by itself.
        server.unref();
        resolve((server.address() as AddressInfo).port);
      });
    });
    return this.starting;
  }

  /** Make a run's tools reachable. Returns the address to give the run, and the way to take it away again. */
  async open(session: Session): Promise<{ url: string; close(): void }> {
    const port = await this.listen();
    const secret = randomBytes(24).toString('hex');
    this.sessions.set(secret, session);
    return { url: `http://127.0.0.1:${port}/mcp/${secret}`, close: () => void this.sessions.delete(secret) };
  }

  close(): void {
    this.sessions.clear();
    this.server?.close();
    this.server?.closeAllConnections();
    this.server = null;
    this.starting = null;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const send = (status: number, body?: unknown, headers: Record<string, string> = {}) => {
      if (body === undefined) res.writeHead(status, headers).end();
      else res.writeHead(status, { 'Content-Type': 'application/json', ...headers }).end(JSON.stringify(body));
    };
    try {
      // A page in a browser has an origin and says so. Nothing with one is a run of Claude Code.
      if (req.headers.origin) return send(403);
      const port = (this.server?.address() as AddressInfo | null)?.port;
      if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) return send(403);
      const secret = /^\/mcp\/([0-9a-f]{48})$/.exec(req.url ?? '')?.[1];
      const session = secret ? this.sessions.get(secret) : undefined;
      if (!session) return send(404);
      // Claude Code also asks for a stream of the server's own messages. There are none to send.
      if (req.method !== 'POST') return send(405, undefined, { Allow: 'POST' });

      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req as AsyncIterable<Buffer>) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) return send(413);
        chunks.push(chunk);
      }
      let message: unknown;
      try {
        message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      }
      const batch = Array.isArray(message);
      const replies: Json[] = [];
      for (const one of batch ? (message as unknown[]) : [message]) {
        const reply = await this.answer(session, one);
        if (reply) replies.push(reply);
      }
      // Notifications get no answer of their own.
      if (!replies.length) return send(202);
      send(200, batch ? replies : replies[0]);
    } catch (err) {
      if (!res.headersSent) send(500, { jsonrpc: '2.0', id: null, error: { code: -32603, message: (err as Error).message } });
      else res.end();
    }
  }

  private async answer(session: Session, message: unknown): Promise<Json | null> {
    if (!isObject(message) || typeof message.method !== 'string') return null;
    const id = message.id;
    if (id === undefined || id === null) return null;
    const ok = (result: Json): Json => ({ jsonrpc: '2.0', id, result });
    const params = isObject(message.params) ? message.params : {};
    switch (message.method) {
      case 'initialize': {
        const asked = text(params.protocolVersion);
        return ok({
          // Nothing used here differs between revisions of the protocol, so the one the client names is the one spoken.
          protocolVersion: /^\d{4}-\d{2}-\d{2}$/.test(asked) ? asked : '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: '1.0.0' },
        });
      }
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({
          tools: session.tools.map((tool) => {
            const { $schema: _dialect, ...inputSchema } = z.toJSONSchema(tool.schema) as Json;
            return {
              name: tool.name,
              description: tool.description,
              inputSchema,
              // Offered from the first turn, and allowed results as long as a file an agent may read.
              _meta: { 'anthropic/alwaysLoad': true, 'anthropic/maxResultSizeChars': MAX_RESULT_CHARS },
            };
          }),
        });
      case 'tools/call': {
        const result = await session.call(text(params.name), params.arguments ?? {});
        return ok({ content: [{ type: 'text', text: result.text }], isError: result.isError });
      }
      default:
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${message.method}` } };
    }
  }
}

// ---- the provider ----

export class ClaudeCodeProvider implements Provider {
  private readonly command: string;
  private readonly dir: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly extraUsage: boolean;
  private readonly idleTimeoutMs: number;
  private readonly killGraceMs: number;
  private readonly bridge = new ToolBridge();
  private readonly written = new Map<string, Promise<string>>();
  private prepared: Promise<void> | null = null;
  private lastLimits: UsageLimits | null = null;

  constructor(options: ClaudeCodeOptions) {
    this.command = options.command?.trim() || 'claude';
    this.dir = options.dir;
    this.env = childEnv(options.env ?? process.env);
    this.extraUsage = options.extraUsage ?? false;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 10 * 60_000;
    this.killGraceMs = options.killGraceMs ?? 3000;
  }

  info(): ProviderInfo {
    return {
      id: 'claude',
      label: 'Claude Code',
      simulated: false,
      defaultModel: CLAUDE_CODE_STARTER,
      models: MODELS.map((m) => ({ id: m.id, label: m.label, inputPerMTok: m.input, outputPerMTok: m.output, provider: 'Claude Code', priced: true, recommended: true, tier: m.tier, hosted: false, web: false })),
      managed: false,
    };
  }

  /** What Claude Code last said about the login's usage limits, if it has said anything since the server started. */
  limits(): UsageLimits | null {
    return this.lastLimits;
  }

  /** Stop answering tool calls. Runs in flight are not waited for. */
  close(): void {
    this.bridge.close();
  }

  private get cwd(): string {
    return path.join(this.dir, 'cwd');
  }

  private prepare(): Promise<void> {
    this.prepared ??= (async () => {
      await fs.mkdir(this.cwd, { recursive: true });
      await fs.mkdir(path.join(this.dir, 'prompts'), { recursive: true, mode: 0o700 });
      await fs.mkdir(path.join(this.dir, 'runs'), { recursive: true, mode: 0o700 });
    })();
    return this.prepared;
  }

  /**
   * A seat's standing instructions, in a file for the run to read them from: they are too long to be sure of
   * as an argument on every system. The same instructions are written once and used by every run that has them.
   */
  private systemFile(system: SystemPrompt): Promise<string> {
    const content = `${system.charter}\n\n${system.role}`;
    const file = path.join(this.dir, 'prompts', `${createHash('sha256').update(content).digest('hex').slice(0, 32)}.txt`);
    // Several runs for one seat can start together. The file is written by the first of them, whole or not at
    // all, and the others wait for that: a run must never read instructions that are still being written.
    let writing = this.written.get(file);
    if (!writing) {
      writing = (async () => {
        const part = `${file}.${randomBytes(6).toString('hex')}.part`;
        await fs.writeFile(part, content, { encoding: 'utf8', mode: 0o600 });
        await fs.rename(part, file);
        return file;
      })();
      this.written.set(file, writing);
      writing.catch(() => this.written.delete(file));
    }
    return writing;
  }

  /** One run of Claude Code, from start to its end. Spend is reported as it goes, and settled when the run says what it came to. */
  private async run(req: RunRequest, extra: string[], watch: Watch = {}): Promise<Outcome> {
    await this.prepare();
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--no-session-persistence',
      '--model',
      req.model,
      '--effort',
      req.effort,
      '--system-prompt-file',
      await this.systemFile(req.system),
      // Nothing of the person's own Claude Code set-up, and none of its built-in tools.
      '--restricted',
      '--strict-mcp-config',
      '--tools',
      '',
      '--disable-slash-commands',
      '--permission-prompts',
      'none',
      ...extra,
    ];
    return new Promise<Outcome>((resolve, reject) => {
      if (req.signal?.aborted) return reject(new ProviderError('The call was stopped before it began.', 'aborted', false));
      const child = spawn(this.command, args, { cwd: this.cwd, env: this.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      track(child);
      let settled = false;
      let killed: Killed | null = null;
      let hard: NodeJS.Timeout | undefined;
      let result: Json | null = null;
      let stderr = '';
      let buffer = '';
      let lastText = '';
      /** The words of each reply, by the reply's id: a reply arrives a block at a time. */
      const words = new Map<string, string>();
      const seen = new Set<string>();
      /** What has been reported of each model's spend so far, by the model's plain name. */
      const reported = new Map<string, Tokens & { costUsd: number }>();

      const kill = (why: Killed) => {
        if (settled || killed) return;
        killed = why;
        child.kill('SIGTERM');
        hard = setTimeout(() => child.kill('SIGKILL'), this.killGraceMs);
      };
      let idle = setTimeout(() => kill('idle'), this.idleTimeoutMs);
      const onAbort = () => kill('abort');
      req.signal?.addEventListener('abort', onAbort, { once: true });
      const finish = () => {
        settled = true;
        clearTimeout(idle);
        clearTimeout(hard);
        req.signal?.removeEventListener('abort', onAbort);
      };

      /** The name spend is reported under: the one the organisation chose the model by, where the run was served by that model. */
      const nameOf = (served: string) => (canonical(served) === canonical(req.model) ? req.model : served);
      const report = (model: string, tokens: Tokens, costUsd: number, settling?: { webSearches: number }) => {
        // What is added when a run is settled is more spend on replies already counted, not another reply.
        const usage: CallUsage = { model: nameOf(model), ...tokens, webSearches: settling?.webSearches ?? 0, costUsd, ...(settling ? { adjustment: true } : {}) };
        req.onUsage?.(usage);
      };

      const handle = (event: Json) => {
        if (event.type === 'assistant' && isObject(event.message)) {
          const message = event.message;
          const id = text(message.id);
          const model = text(message.model);
          // A reply Claude Code wrote itself, to say what went wrong, is not the model's and cost nothing.
          if (!id || model === '<synthetic>') return;
          if (!seen.has(id)) {
            seen.add(id);
            // What a reply says of its own size when it starts: its input in full, its output only so far.
            // It is counted now, so that the budget sees a long run as it goes, and made exact at the end.
            const usage = isObject(message.usage) ? message.usage : {};
            const tokens: Tokens = {
              inputTokens: num(usage.input_tokens),
              outputTokens: num(usage.output_tokens),
              cacheReadTokens: num(usage.cache_read_input_tokens),
              cacheWriteTokens: num(usage.cache_creation_input_tokens),
            };
            const plain = canonical(model);
            const costUsd = isKnownModel(plain) ? costOfRequest(plain, tokens) : 0;
            const before = reported.get(plain);
            reported.set(plain, {
              inputTokens: (before?.inputTokens ?? 0) + tokens.inputTokens,
              outputTokens: (before?.outputTokens ?? 0) + tokens.outputTokens,
              cacheReadTokens: (before?.cacheReadTokens ?? 0) + tokens.cacheReadTokens,
              cacheWriteTokens: (before?.cacheWriteTokens ?? 0) + tokens.cacheWriteTokens,
              costUsd: (before?.costUsd ?? 0) + costUsd,
            });
            report(model, tokens, costUsd);
          }
          const blocks = (Array.isArray(message.content) ? message.content : []).filter(isObject);
          const said = blocks
            .filter((block) => block.type === 'text')
            .map((block) => text(block.text))
            .join('');
          if (said) {
            words.set(id, `${words.get(id) ?? ''}${said}`);
            lastText = words.get(id)!;
          }
          const answer = blocks.find((block) => block.type === 'tool_use' && block.name === 'StructuredOutput');
          if (answer && watch.onStructured?.(answer.input)) {
            // The run ends here, before it says what it used. What this reply wrote is counted by its length.
            const plain = canonical(model);
            const written = Math.ceil(JSON.stringify(answer.input ?? '').length / 3.5);
            const more: Tokens = { inputTokens: 0, outputTokens: Math.max(0, written - num(isObject(message.usage) ? message.usage.output_tokens : 0)), cacheReadTokens: 0, cacheWriteTokens: 0 };
            if (more.outputTokens > 0) report(model, more, isKnownModel(plain) ? costOfRequest(plain, more) : 0, { webSearches: 0 });
            kill('answered');
          }
          return;
        }
        if (event.type === 'rate_limit_event' && isObject(event.rate_limit_info)) {
          const info = event.rate_limit_info;
          this.lastLimits = {
            status: text(info.status) || 'unknown',
            window: text(info.rateLimitType) || null,
            utilization: typeof info.utilization === 'number' ? info.utilization : null,
            resetsAt: typeof info.resetsAt === 'number' ? new Date(info.resetsAt * 1000).toISOString() : null,
            usingExtra: info.isUsingOverage === true,
            extraAllowed: info.overageEnabled === true || info.overageStatus === 'allowed',
            seenAt: new Date().toISOString(),
          };
          // Past the plan's included usage, every further call is billed. That is not for this program to decide.
          if (this.lastLimits.usingExtra && !this.extraUsage) kill('extra_usage');
          return;
        }
        if (event.type === 'result') {
          result = event;
          // The run's own account of what it used, by model, which is exact where the running count was not.
          const byModel = isObject(event.modelUsage) ? Object.entries(event.modelUsage).filter((entry): entry is [string, Json] => isObject(entry[1])) : [];
          const exact = byModel.length
            ? byModel.map(([model, used]) => ({
                model: text(used.canonicalModel) || model,
                tokens: {
                  inputTokens: num(used.inputTokens),
                  outputTokens: num(used.outputTokens),
                  cacheReadTokens: num(used.cacheReadInputTokens),
                  cacheWriteTokens: num(used.cacheCreationInputTokens),
                },
                costUsd: typeof used.costUSD === 'number' ? used.costUSD : null,
                webSearches: num(used.webSearchRequests),
              }))
            : [];
          for (const entry of exact) {
            const plain = canonical(entry.model);
            const before = reported.get(plain);
            const costUsd = entry.costUsd ?? (isKnownModel(plain) ? costOfRequest(plain, entry.tokens) : 0);
            const more: Tokens = {
              inputTokens: Math.max(0, entry.tokens.inputTokens - (before?.inputTokens ?? 0)),
              outputTokens: Math.max(0, entry.tokens.outputTokens - (before?.outputTokens ?? 0)),
              cacheReadTokens: Math.max(0, entry.tokens.cacheReadTokens - (before?.cacheReadTokens ?? 0)),
              cacheWriteTokens: Math.max(0, entry.tokens.cacheWriteTokens - (before?.cacheWriteTokens ?? 0)),
            };
            const moreCost = Math.max(0, costUsd - (before?.costUsd ?? 0));
            if (moreCost > 0 || entry.webSearches > 0 || Object.values(more).some((n) => n > 0)) report(entry.model, more, moreCost, { webSearches: entry.webSearches });
          }
          // A run that gives only a total is settled to that total, under the model that was asked for.
          if (!exact.length) {
            const counted = [...reported.values()].reduce((sum, r) => sum + r.costUsd, 0);
            const missing = num(event.total_cost_usd) - counted;
            if (missing > 0) report(req.model, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, missing, { webSearches: 0 });
          }
        }
      };

      child.on('error', (err: NodeJS.ErrnoException) => {
        if (settled) return;
        finish();
        reject(err.code === 'ENOENT' || err.code === 'EACCES' ? notFound(this.command) : new ProviderError(`Claude Code could not be started: ${err.message}`, 'unavailable', false));
      });
      // A run that ends before it has read its prompt closes its input. That is said by how it ends, not here.
      child.stdin.on('error', () => {});
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        clearTimeout(idle);
        idle = setTimeout(() => kill('idle'), this.idleTimeoutMs);
        buffer += chunk;
        for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
          const line = buffer.slice(0, at).trim();
          buffer = buffer.slice(at + 1);
          if (!line) continue;
          try {
            const event: unknown = JSON.parse(line);
            if (isObject(event)) handle(event);
          } catch {
            // A line that is not an event is nothing this program can act on.
          }
        }
      });
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        if (stderr.length < 20_000) stderr += chunk;
      });
      child.on('close', (code, signal) => {
        if (settled) return;
        finish();
        resolve({ result, code, signal, stderr, lastText, turns: seen.size, killed });
      });

      watch.onStart?.({ turns: () => seen.size, kill });
      child.stdin.end(req.prompt);
    });
  }

  /** The result of a run that ended as a run should, or the reason it did not, as an error the engine can act on. */
  private settle(outcome: Outcome, options: { turnLimitIsAnEnd?: boolean } = {}): Json {
    if (outcome.killed === 'abort') throw new ProviderError('The call was stopped.', 'aborted', false);
    if (outcome.killed === 'idle') {
      throw new ProviderError(`Claude Code said nothing for ${Math.round(this.idleTimeoutMs / 60_000)} minutes and was stopped.`, 'unavailable', true);
    }
    if (outcome.killed === 'extra_usage') {
      const resets = this.lastLimits?.resetsAt ? ` The limit resets on ${this.lastLimits.resetsAt.slice(0, 16).replace('T', ' at ')} UTC.` : '';
      throw new ProviderError(
        `Your Claude plan's included usage is used up, and Claude Code has started to bill further usage as extra. The organisation is paused so that it does not spend money without your say-so.${resets} Resume it then, move it to another model, or start the server with CLAUDE_CODE_EXTRA_USAGE=allow to let it carry on at your expense.`,
        'rate_limit',
        false,
      );
    }
    const result = outcome.result;
    if (!result) {
      const said = brief(outcome.stderr.trim().split('\n').slice(-3).join(' '), 500);
      if (/unknown option|unknown argument/i.test(said)) {
        throw new ProviderError(`This Claude Code does not take an option this connection uses (${said}). Update it with "claude update".`, 'bad_request', false);
      }
      const how = outcome.code !== null ? ` (exit ${outcome.code})` : outcome.signal ? ` (${outcome.signal})` : '';
      throw new ProviderError(`Claude Code ended without an answer${how}${said ? `: ${said}` : '.'}`, 'unavailable', true);
    }
    if (result.is_error !== true) {
      if (result.stop_reason === 'refusal') throw new ProviderError('The model declined this request.', 'refusal', false);
      return result;
    }
    if (result.subtype === 'error_max_turns' && options.turnLimitIsAnEnd) return result;
    if (result.subtype === 'error_max_structured_output_retries') {
      throw new ProviderError('The reply did not match the expected structure, after Claude Code had asked for it again.', 'invalid_output', true);
    }
    const said = brief(text(result.result) || (Array.isArray(result.errors) ? result.errors.map(String).join('; ') : '') || 'It gave no reason.', 600);
    const status = num(result.api_error_status);
    if (status === 401 || status === 403 || /not logged in|\/login|authentication/i.test(said)) {
      throw new ProviderError(`Claude Code's login was not accepted: ${said} Run "claude" in a terminal, sign in again, then resume.`, 'auth', false);
    }
    if (status === 429 || /usage limit|hit your (?:\w+ )?limit|limit reached|rate limit/i.test(said)) {
      throw new ProviderError(`Claude Code has reached a usage limit of your plan: ${said} The organisation is paused. Resume it once the limit has reset, or move it to another model.`, 'rate_limit', false);
    }
    if (status === 404) throw new ProviderError(`Claude Code could not use that model on this login: ${said}`, 'bad_request', false);
    if (status === 400) throw new ProviderError(`Claude Code's request was refused: ${said}`, 'bad_request', false);
    if (status >= 500 || /overloaded/i.test(said)) throw new ProviderError(`Claude is not answering just now: ${said}`, 'unavailable', true);
    throw new ProviderError(`Claude Code stopped with an error: ${said}`, 'unavailable', false);
  }

  async structured<T>(req: StructuredRequest<T>): Promise<T> {
    const { $schema: _dialect, ...schema } = z.toJSONSchema(req.schema) as Json;
    let mended: { data: T } | null = null;
    const outcome = await this.run(req, ['--json-schema', JSON.stringify(schema)], {
      onStructured: (input) => {
        // An answer that is right as it stands is left for Claude Code to accept and account for. One that would
        // be refused only for a slip in how it was written is put right here, and the run need not go on.
        if (req.schema.safeParse(input).success) return false;
        const repaired = req.schema.safeParse(unswallow(input));
        if (!repaired.success) return false;
        mended = { data: repaired.data };
        return true;
      },
    });
    if (outcome.killed === 'answered' && mended) return (mended as { data: T }).data;
    const result = this.settle(outcome);
    let data: unknown = result.structured_output;
    if (data === undefined) {
      // No structured answer was recorded. What the model said instead may still be one.
      try {
        data = JSON.parse(text(result.result));
      } catch {
        const said = text(result.result).trim();
        throw new ProviderError(`Claude Code gave no structured reply${said ? `: ${brief(said, 300)}` : '.'}`, 'invalid_output', true);
      }
    }
    // Claude Code holds the reply to the schema; this also enforces whatever the schema could not express to it.
    const parsed = req.schema.safeParse(data);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new ProviderError(`The reply did not match the expected structure (${issue?.path.join('.')}: ${issue?.message}).`, 'invalid_output', true);
    }
    return parsed.data;
  }

  /**
   * An agent run. Claude Code runs the loop; this answers its tool calls, which is also the only point at
   * which the agent can be told anything: that the run is over, or that it must stop and report.
   */
  async agent(req: AgentRequest): Promise<AgentResult> {
    if (req.shouldStop?.()) return { text: '', turns: 0, stopped: 'interrupted' };
    // Nothing has been spent on this run yet, so there is nothing to wrap up: leave the task for later.
    if (req.shouldWrapUp?.()) return { text: '', turns: 0, stopped: 'interrupted' };

    let live: Live | null = null;
    let stopped = false;
    let wrappingUp = false;
    /** Tools run one at a time, in the order asked for, as they do on every other provider. */
    let queue: Promise<unknown> = Promise.resolve();
    const call = (name: string, input: unknown) => {
      const next = queue.then(async (): Promise<{ text: string; isError: boolean }> => {
        if (stopped || req.shouldStop?.()) {
          stopped = true;
          live?.kill('stop');
          return { text: 'The run has been stopped.', isError: true };
        }
        if (wrappingUp) return { text: WRAP_UP, isError: true };
        const tool = req.tools.find((t) => t.name === name);
        if (!tool) return { text: `Unknown tool: ${name}`, isError: true };
        const parsed = tool.schema.safeParse(input);
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          return { text: `That is not an input ${name} takes (${issue?.path.join('.') || 'input'}: ${issue?.message}). Call it again with the input corrected.`, isError: true };
        }
        let said: string;
        try {
          said = await tool.run(parsed.data);
        } catch (err) {
          return { text: `Error: ${(err as Error).message}`, isError: true };
        }
        // Instructions to the agent mid-run ride on a tool result: it is the one thing the agent is sure to read next.
        if ((live?.turns() ?? 0) >= req.maxTurns || req.shouldWrapUp?.()) {
          wrappingUp = true;
          return { text: `${said}\n\n${WRAP_UP}`, isError: false };
        }
        return { text: said, isError: false };
      });
      queue = next.catch(() => {});
      return next;
    };

    await this.prepare();
    const tools = await this.bridge.open({ tools: req.tools, call });
    // Where the run's tools are is told to it in a file only this user can read, not on its command line, which
    // anyone on the machine can see: the address is all it takes to use the tools while the run lasts.
    const told = path.join(this.dir, 'runs', `${randomBytes(12).toString('hex')}.json`);
    let outcome: Outcome;
    try {
      await fs.writeFile(told, JSON.stringify({ mcpServers: { [SERVER_NAME]: { type: 'http', url: tools.url } } }), { encoding: 'utf8', mode: 0o600 });
      outcome = await this.run(
        req,
        [
          '--mcp-config',
          told,
          '--allowedTools',
          req.tools.map((tool) => `mcp__${SERVER_NAME}__${tool.name}`).join(','),
          // The engine's own limit is kept by the tool server, which can ask for a closing report. This is the backstop behind it.
          '--max-turns',
          String(req.maxTurns + TURN_SLACK),
        ],
        { onStart: (started) => (live = started) },
      );
    } finally {
      tools.close();
      await fs.rm(told, { force: true });
    }
    if (stopped || outcome.killed === 'stop') return { text: '', turns: outcome.turns, stopped: 'interrupted' };
    const result = this.settle(outcome, { turnLimitIsAnEnd: true });
    if (result.subtype === 'error_max_turns') return { text: outcome.lastText.trim(), turns: outcome.turns, stopped: 'cut_short' };
    return { text: (text(result.result) || outcome.lastText).trim(), turns: outcome.turns, stopped: wrappingUp ? 'cut_short' : 'done' };
  }
}
