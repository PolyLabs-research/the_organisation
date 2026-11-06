import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createApp } from '../src/server/app';
import type { Config } from '../src/server/config';
import { loadConfig } from '../src/server/config';
import { ConnectionStore } from '../src/server/connections';
import { ValidationError } from '../src/server/engine/state';
import { ClaudeCodeProvider, MIN_CLAUDE_CODE, checkClaudeCode, childEnv, describeStatus, type ClaudeCodeOptions } from '../src/server/providers/claude-code';
import { ProviderRouter } from '../src/server/providers/router';
import { ProviderError, type AgentRequest, type AgentTool, type CallUsage, type StructuredRequest } from '../src/server/providers/types';
import { Registry } from '../src/server/registry';
import { Store } from '../src/server/store';
import { QUIET, harness, runToRest, waitFor, type Harness } from './helpers';

// Claude Code as a way to reach Claude: the provider that runs the `claude`
// command for each call, and the connection for it. Everything here runs
// against a stand-in for the command (fake-claude.mjs), which answers in the
// shapes the real one was seen to. That checks what is passed to the command
// and how its answers are read. It cannot check the real command, or a login.

const FAKE = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url));

let dir: string;
let log: string;
const open: ClaudeCodeProvider[] = [];
let h: Harness | undefined;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'the-organisation-claude-code-'));
  log = path.join(dir, 'runs.jsonl');
});
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
  for (const provider of open.splice(0)) provider.close();
  await rm(dir, { recursive: true, force: true });
});

interface Run {
  argv: string[];
  flags: Record<string, string | boolean>;
  prompt: string;
  system: string;
  cwd: string;
  envNames: string[];
}
/** What the stand-in was run with, one entry for each run. */
async function runs(): Promise<Run[]> {
  if (!existsSync(log)) return [];
  return (await readFile(log, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Run);
}

const fakeEnv = (more: Record<string, string> = {}): NodeJS.ProcessEnv => ({ PATH: process.env.PATH, HOME: process.env.HOME, FAKE_CLAUDE_LOG: log, ...more });
function provider(env: Record<string, string> = {}, options: Partial<ClaudeCodeOptions> = {}): ClaudeCodeProvider {
  const made = new ClaudeCodeProvider({ command: FAKE, dir: path.join(dir, 'claude-code'), env: fakeEnv(env), killGraceMs: 200, ...options });
  open.push(made);
  return made;
}

const SYSTEM = { charter: 'You are part of "Fernery".', role: 'You are the Chief Executive Officer.' };
const Answer = z.object({ proposal: z.string(), priority: z.enum(['high', 'low']) });
const ask = (more: Partial<StructuredRequest<z.infer<typeof Answer>>> = {}): StructuredRequest<z.infer<typeof Answer>> => ({
  kind: 'consult',
  system: SYSTEM,
  prompt: 'What should engineering do next?',
  model: 'claude-haiku-5-5',
  effort: 'medium',
  schema: Answer,
  context: {},
  ...more,
});

/** An agent's tools, keeping a note of what they were asked to do. */
function tools(): { tools: AgentTool[]; calls: Array<[string, Record<string, unknown>]> } {
  const calls: Array<[string, Record<string, unknown>]> = [];
  return {
    calls,
    tools: [
      {
        name: 'list_files',
        description: 'List the files in the shared workspace.',
        schema: z.object({ directory: z.string().optional() }),
        async run(input) {
          calls.push(['list_files', input]);
          return 'The workspace is empty.';
        },
      },
      {
        name: 'write_file',
        description: 'Create a file in the shared workspace.',
        schema: z.object({ path: z.string(), content: z.string() }),
        async run(input) {
          calls.push(['write_file', input]);
          return `Wrote ${String(input.path)} (${String(input.content).length} bytes).`;
        },
      },
    ],
  };
}
const task = (more: Partial<AgentRequest>): AgentRequest => ({
  kind: 'task',
  system: { charter: SYSTEM.charter, role: 'You are an agent of the engineering team. Keep your files under `engineering/`.' },
  prompt: 'Write the note.',
  model: 'claude-haiku-5-5',
  effort: 'low',
  tools: [],
  webSearch: null,
  maxTurns: 24,
  context: {},
  ...more,
});

async function failure(work: Promise<unknown>): Promise<ProviderError> {
  try {
    await work;
  } catch (err) {
    if (err instanceof ProviderError) return err;
    throw err;
  }
  throw new Error('the call was expected to fail');
}

describe('the environment a run of Claude Code is given', () => {
  it('keeps where the login is, and leaves out keys, addresses and the marks of a session it was started from', () => {
    const env = childEnv({
      PATH: '/bin',
      HOME: '/home/someone',
      HTTPS_PROXY: 'http://proxy.example:3128',
      ANTHROPIC_API_KEY: 'sk-ant-secret',
      ANTHROPIC_BASE_URL: 'https://gateway.example',
      ANTHROPIC_MODEL: 'opus',
      OPENAI_API_KEY: 'sk-openai',
      MOONSHOT_BASE_URL: 'https://api.moonshot.cn/v1',
      SOME_AUTH_TOKEN: 'token',
      CLAUDECODE: '1',
      CLAUDE_CODE_SESSION_ID: 'parent-session',
      CLAUDE_CODE_ENTRYPOINT: 'sdk-cli',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_EFFORT: 'max',
      CLAUDE_PID: '5060',
      CLAUDE_CONFIG_DIR: '/home/someone/.claude-work',
      CLAUDE_CODE_OAUTH_TOKEN: 'long-lived-token',
      UNSET: undefined,
    });
    expect(env).toEqual({
      PATH: '/bin',
      HOME: '/home/someone',
      HTTPS_PROXY: 'http://proxy.example:3128',
      CLAUDE_CONFIG_DIR: '/home/someone/.claude-work',
      CLAUDE_CODE_OAUTH_TOKEN: 'long-lived-token',
      // Nothing of the person's own instructions or memory goes into a seat's prompt, and nothing is left running.
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
    });
  });
});

describe('asking Claude Code about itself', () => {
  it('says which version it is and how it is signed in, without a run', async () => {
    const status = await checkClaudeCode(FAKE, fakeEnv());
    expect(status).toEqual({ version: '2.1.317', authMethod: 'claude.ai', plan: 'max' });
    expect(describeStatus(status)).toBe('Claude Code 2.1.317, signed in with a Claude Max plan');
    expect(describeStatus({ version: '2.1.317', authMethod: 'console', plan: null })).toBe('Claude Code 2.1.317, signed in another way (console), so its usage is billed to that account');
    expect(await runs()).toEqual([]);
  });

  it('says what to do when it is missing, too old or not signed in', async () => {
    expect((await failure(checkClaudeCode('/no/such/claude', fakeEnv()))).message).toMatch(/Claude Code was not found on this machine.*CLAUDE_CODE_PATH/);
    expect((await failure(checkClaudeCode(FAKE, fakeEnv({ FAKE_CLAUDE_VERSION: '2.1.100' })))).message).toBe(`Claude Code 2.1.100 is too old for this: ${MIN_CLAUDE_CODE} or later is needed. Update it with "claude update".`);
    expect((await failure(checkClaudeCode(FAKE, fakeEnv({ FAKE_CLAUDE_AUTH: '{"loggedIn":false}' })))).message).toMatch(/installed but not signed in/);
    // A command that is not Claude Code at all.
    expect((await failure(checkClaudeCode('node', fakeEnv()))).message).toMatch(/"node --version" did not answer as Claude Code does.*CLAUDE_CODE_PATH/);
  });
});

describe('one call through Claude Code', () => {
  it('runs the command with nothing of the person’s own set-up, and reads the structured answer', async () => {
    const usage: CallUsage[] = [];
    const data = await provider({ ANTHROPIC_API_KEY: 'sk-ant-secret', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'parent' }).structured(ask({ onUsage: (u) => usage.push(u) }));
    expect(data).toEqual({ proposal: 'Settled.', priority: 'high' });

    const [run, ...others] = await runs();
    expect(others).toEqual([]);
    expect(run!.prompt).toBe('What should engineering do next?');
    expect(run!.system).toBe('You are part of "Fernery".\n\nYou are the Chief Executive Officer.');
    expect(run!.flags).toMatchObject({
      '-p': true,
      '--output-format': 'stream-json',
      '--verbose': true,
      '--no-session-persistence': true,
      '--model': 'claude-haiku-5-5',
      '--effort': 'medium',
      // None of the person's settings, plugins or tool servers, none of Claude Code's own tools, and nobody to ask.
      '--restricted': true,
      '--strict-mcp-config': true,
      '--tools': '',
      '--disable-slash-commands': true,
      '--permission-prompts': 'none',
    });
    expect(run!.flags['--mcp-config']).toBeUndefined();
    expect(JSON.parse(String(run!.flags['--json-schema']))).toMatchObject({ type: 'object', properties: { priority: { enum: ['high', 'low'] } }, required: ['proposal', 'priority'] });
    expect(JSON.parse(String(run!.flags['--json-schema']))).not.toHaveProperty('$schema');
    // It is started from a directory of its own, and never sees the server's API key or the session the server was started from.
    expect(run!.cwd).toBe(path.join(dir, 'claude-code', 'cwd'));
    expect(run!.envNames).not.toContain('ANTHROPIC_API_KEY');
    expect(run!.envNames).not.toContain('CLAUDECODE');
    expect(run!.envNames).not.toContain('CLAUDE_CODE_SESSION_ID');
    expect(run!.envNames).toContain('CLAUDE_CODE_DISABLE_CLAUDE_MDS');

    // Spend is counted as the reply starts, and made exact when the run says what it came to.
    expect(usage.map((u) => u.model)).toEqual(['claude-haiku-5-5', 'claude-haiku-5-5']);
    expect(usage[0]).toMatchObject({ inputTokens: 2000, outputTokens: 24 });
    // What settles the run is more spend on the reply already counted, not a second reply.
    expect(usage.map((u) => u.adjustment ?? false)).toEqual([false, true]);
    const total = usage.reduce((sum, u) => ({ input: sum.input + u.inputTokens, output: sum.output + u.outputTokens, cost: sum.cost + u.costUsd }), { input: 0, output: 0, cost: 0 });
    expect(total.input).toBe(2000);
    expect(total.output).toBe(500);
    expect(total.cost).toBeCloseTo(0.01, 9);
  });

  it('writes a seat’s instructions to a file once, readable by this user only', async () => {
    const claude = provider();
    const { readdir, stat } = await import('node:fs/promises');
    await claude.structured(ask());
    const first = String((await runs())[0]!.flags['--system-prompt-file']);
    const writtenAt = (await stat(first)).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await claude.structured(ask({ prompt: 'And after that?' }));
    // The same instructions are not written a second time.
    expect((await stat(first)).mtimeMs).toBe(writtenAt);
    await claude.structured(ask({ system: { ...SYSTEM, role: 'You are the Chief Technology Officer.' } }));
    const files = (await runs()).map((r) => String(r.flags['--system-prompt-file']));
    expect(files[0]).toBe(files[1]);
    expect(files[2]).not.toBe(files[0]);
    expect(path.dirname(files[0]!)).toBe(path.join(dir, 'claude-code', 'prompts'));
    expect((await stat(files[0]!)).mode & 0o777).toBe(0o600);

    // Runs that start together for one seat all read the whole of its instructions: the file is written once.
    const together = provider();
    const role = `You are the Chief Product Officer. ${'Hold to the mission. '.repeat(4000)}`;
    await Promise.all([1, 2, 3, 4].map(() => together.structured(ask({ system: { ...SYSTEM, role } }))));
    const four = (await runs()).slice(-4);
    expect(new Set(four.map((r) => r.flags['--system-prompt-file'])).size).toBe(1);
    expect(four.map((r) => r.system.length)).toEqual(Array(4).fill(`${SYSTEM.charter}\n\n${role}`.length));
    expect((await readdir(path.join(dir, 'claude-code', 'prompts'))).filter((name) => name.endsWith('.part'))).toEqual([]);
  });

  it.each([
    ['limit', 'rate_limit', false, /reached a usage limit of your plan: You've hit your weekly limit · resets Nov 11, 9am \(UTC\) The organisation is paused/],
    ['auth', 'auth', false, /login was not accepted.*sign in again/],
    ['model', 'bad_request', false, /could not use that model on this login/],
    ['overloaded', 'unavailable', true, /not answering just now/],
    ['crash', 'unavailable', true, /ended without an answer \(exit 134\): Segmentation fault/],
    ['unknown-option', 'bad_request', false, /does not take an option this connection uses.*claude update/],
    ['invalid', 'invalid_output', true, /did not match the expected structure \(proposal/],
    ['nostructured', 'invalid_output', true, /gave no structured reply: Here is my answer in prose instead\./],
    ['refusal', 'refusal', false, /declined this request/],
  ] as const)('turns a run that ends in "%s" into an error the organisation can act on', async (mode, code, retryable, message) => {
    const error = await failure(provider({ FAKE_CLAUDE_MODE: mode }).structured(ask()));
    expect([error.code, error.retryable]).toEqual([code, retryable]);
    expect(error.message).toMatch(message);
  });

  it('says so when the command is not there', async () => {
    const error = await failure(provider({}, { command: '/no/such/claude' }).structured(ask()));
    expect([error.code, error.retryable]).toEqual(['auth', false]);
    expect(error.message).toMatch(/was not found on this machine/);
  });

  it('stops a run that is cut off, and one that has gone quiet', async () => {
    const cut = new AbortController();
    const hung = provider({ FAKE_CLAUDE_MODE: 'hang' }).structured(ask({ signal: cut.signal }));
    await waitFor(() => existsSync(log), 'the run to start');
    cut.abort();
    expect([(await failure(hung)).code]).toEqual(['aborted']);

    // Cut off before it began, nothing is run at all.
    const before = (await runs()).length;
    const never = new AbortController();
    never.abort();
    expect((await failure(provider().structured(ask({ signal: never.signal })))).code).toBe('aborted');
    expect((await runs()).length).toBe(before);

    const quiet = await failure(provider({ FAKE_CLAUDE_MODE: 'hang' }, { idleTimeoutMs: 150 }).structured(ask()));
    expect([quiet.code, quiet.retryable]).toEqual(['unavailable', true]);
    expect(quiet.message).toMatch(/said nothing for .* and was stopped/);
    // So is one that never says anything at all.
    const silent = await failure(provider({ FAKE_CLAUDE_MODE: 'silent' }, { idleTimeoutMs: 150 }).structured(ask()));
    expect([silent.code, silent.retryable]).toEqual(['unavailable', true]);
  });

  it('pauses rather than carry on into paid extra usage, unless told it may', async () => {
    const guarded = provider({ FAKE_CLAUDE_MODE: 'extra', FAKE_CLAUDE_EXTRA_WAIT_MS: '3000' });
    const error = await failure(guarded.structured(ask()));
    expect([error.code, error.retryable]).toEqual(['rate_limit', false]);
    expect(error.message).toMatch(/has started to bill further usage as extra\. The organisation is paused so that it does not spend money without your say-so\..*CLAUDE_CODE_EXTRA_USAGE=allow/);
    expect(guarded.limits()).toMatchObject({ usingExtra: true, extraAllowed: true, utilization: 1, window: 'seven_day' });

    const allowed = provider({ FAKE_CLAUDE_MODE: 'extra', FAKE_CLAUDE_EXTRA_WAIT_MS: '10' }, { extraUsage: true });
    expect(await allowed.structured(ask())).toEqual({ proposal: 'Settled.', priority: 'high' });
  });
});

describe('an agent run through Claude Code', () => {
  it('gives the agent the organisation’s tools and no others, and takes its closing report', async () => {
    const kit = tools();
    const usage: CallUsage[] = [];
    const result = await provider().agent(task({ tools: kit.tools, onUsage: (u) => usage.push(u) }));
    expect(result).toMatchObject({ stopped: 'done', turns: 3 });
    expect(result.text).toMatch(/^Wrote the note and checked it\. Wrote engineering\/note-\d+\.md \(\d+ bytes\)\.$/);
    // The tools ran here, in this process, with what the agent asked for.
    expect(kit.calls.map(([name]) => name)).toEqual(['list_files', 'write_file']);
    expect(kit.calls[1]![1]).toMatchObject({ path: expect.stringMatching(/^engineering\/note-\d+\.md$/) });

    const [run] = await runs();
    expect(run!.flags).toMatchObject({ '--restricted': true, '--strict-mcp-config': true, '--tools': '', '--allowedTools': 'mcp__org__list_files,mcp__org__write_file', '--max-turns': '28' });
    expect(run!.flags['--json-schema']).toBeUndefined();
    const server = JSON.parse(String(run!.flags['--mcp-config'])).mcpServers.org;
    expect(server).toMatchObject({ type: 'http', url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/[0-9a-f]{48}$/) });
    // Once the run is over, the address it was given leads nowhere.
    const after = await fetch(server.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    expect(after.status).toBe(404);
    // Three replies, counted as they came and settled at the end.
    expect(usage.reduce((sum, u) => sum + u.inputTokens, 0)).toBe(6000);
    expect(usage.reduce((sum, u) => sum + u.outputTokens, 0)).toBe(1500);
    expect(usage.reduce((sum, u) => sum + u.costUsd, 0)).toBeCloseTo(0.03, 9);
  });

  it('answers a run’s tool calls only at the address that run was given, and to nothing that could be a web page', async () => {
    const kit = tools();
    const cut = new AbortController();
    const hung = provider({ FAKE_CLAUDE_MODE: 'hang' }).agent(task({ tools: kit.tools, signal: cut.signal }));
    await waitFor(() => existsSync(log), 'the run to start');
    const url = JSON.parse(String((await runs())[0]!.flags['--mcp-config'])).mcpServers.org.url as string;
    const post = (to: string, headers: Record<string, string> = {}, body: unknown = { jsonrpc: '2.0', id: 9, method: 'tools/list' }) =>
      fetch(to, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

    const listed = await post(url);
    expect(listed.status).toBe(200);
    const list = (await listed.json()) as { result: { tools: Array<{ name: string; inputSchema: Record<string, unknown>; _meta: Record<string, unknown> }> } };
    expect(list.result.tools.map((t) => t.name)).toEqual(['list_files', 'write_file']);
    // Offered from the first turn, and allowed results as long as a file an agent may read.
    expect(list.result.tools[1]!._meta).toEqual({ 'anthropic/alwaysLoad': true, 'anthropic/maxResultSizeChars': 200_000 });
    expect(list.result.tools[1]!.inputSchema).toMatchObject({ type: 'object', required: ['path', 'content'] });

    expect((await post(url.replace(/[0-9a-f]{48}$/, 'f'.repeat(48)))).status).toBe(404);
    expect((await post(url, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await fetch(url)).status).toBe(405);
    const unknown = (await (await post(url, {}, { jsonrpc: '2.0', id: 3, method: 'server/discover' })).json()) as { error: { code: number } };
    expect(unknown.error.code).toBe(-32601);
    expect((await post(url, {}, { jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
    // A name the tool server is not reached by.
    const port = new URL(url).port;
    const viaName = await new Promise<number>((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, path: new URL(url).pathname, method: 'POST', headers: { host: `evil.example:${port}`, 'content-type': 'application/json' } }, (res) => resolve(res.statusCode ?? 0));
      req.end('{}');
    });
    expect(viaName).toBe(403);

    cut.abort();
    expect((await failure(hung)).code).toBe('aborted');
    expect((await post(url)).status).toBe(404);
  });

  it('tells the agent to stop and report when the budget is spent or its turns are used up', async () => {
    const spent = tools();
    const byBudget = await provider({ FAKE_CLAUDE_MODE: 'loop' }).agent(task({ tools: spent.tools, shouldWrapUp: () => spent.calls.length >= 2 }));
    expect(byBudget).toMatchObject({ stopped: 'cut_short', text: 'Stopped as told. Nothing is finished.' });
    // The call that was under way was carried out; the instruction to stop went with its result.
    expect(spent.calls).toHaveLength(2);

    const limited = tools();
    const byTurns = await provider({ FAKE_CLAUDE_MODE: 'loop' }).agent(task({ tools: limited.tools, maxTurns: 3 }));
    expect(byTurns).toMatchObject({ stopped: 'cut_short', text: 'Stopped as told. Nothing is finished.' });
    expect(limited.calls).toHaveLength(3);

    // Claude Code's own limit is the backstop behind that, and ends the run with whatever was said last.
    const backstop = await provider({ FAKE_CLAUDE_MODE: 'maxturns' }).agent(task({ tools: tools().tools }));
    expect(backstop).toMatchObject({ stopped: 'cut_short', text: '' });
  });

  it('ends the run at once when the organisation is halted, and starts none when it already is', async () => {
    const kit = tools();
    const halted = await provider({ FAKE_CLAUDE_MODE: 'loop' }).agent(task({ tools: kit.tools, shouldStop: () => kit.calls.length >= 2 }));
    expect(halted).toMatchObject({ stopped: 'interrupted', text: '' });
    expect(kit.calls).toHaveLength(2);

    const before = (await runs()).length;
    expect(await provider().agent(task({ tools: tools().tools, shouldStop: () => true }))).toEqual({ text: '', turns: 0, stopped: 'interrupted' });
    expect(await provider().agent(task({ tools: tools().tools, shouldWrapUp: () => true }))).toEqual({ text: '', turns: 0, stopped: 'interrupted' });
    expect((await runs()).length).toBe(before);
  });

  it('hands an input a tool does not take back to the agent, without running the tool', async () => {
    const kit = tools();
    const result = await provider({ FAKE_CLAUDE_MODE: 'badinput' }).agent(task({ tools: kit.tools }));
    expect(result.text).toMatch(/The tool said: That is not an input write_file takes \(path: .*\)\. Call it again with the input corrected\./);
    expect(kit.calls).toEqual([]);
  });
});

describe('the Claude Code connection', () => {
  async function connections(env: NodeJS.ProcessEnv = {}, claudeCode: Partial<ClaudeCodeOptions & { blocked: string }> | null = {}) {
    const store = new ConnectionStore(path.join(dir, 'connections.json'), env);
    await store.load();
    const router = new ProviderRouter(store, {
      mock: QUIET,
      ...(claudeCode ? { claudeCode: { command: FAKE, dir: path.join(dir, 'claude-code'), env: fakeEnv(), killGraceMs: 200, ...claudeCode } } : {}),
    });
    return { store, router };
  }

  it('is added without a key, after asking Claude Code about itself, and offers Claude’s models', async () => {
    const { router, store } = await connections();
    expect(router.simulated).toBe(true);
    const connection = await router.connect({ presetId: 'claude-code' });
    expect(connection).toMatchObject({ id: 'claude-code', presetId: 'claude-code', label: 'Claude Code', apiKey: '', baseURL: '', source: 'stored', detail: 'Claude Code 2.1.317, signed in with a Claude Max plan', listingError: null });
    // Connecting called no model.
    expect(await runs()).toEqual([]);
    // With it connected, organisations are no longer simulated.
    expect(router.simulated).toBe(false);
    expect(router.info().connections).toEqual([expect.objectContaining({ id: 'claude-code', keyHint: '', modelCount: 4, detail: 'Claude Code 2.1.317, signed in with a Claude Max plan' })]);
    expect(router.info().models.map((m) => [m.id, m.provider, m.hosted, m.web, m.priced])).toEqual([
      ['claude-code:claude-opus-5-5', 'Claude Code', false, false, true],
      ['claude-code:claude-fable-5-1', 'Claude Code', false, false, true],
      ['claude-code:claude-sonnet-5-5', 'Claude Code', false, false, true],
      ['claude-code:claude-haiku-5-5', 'Claude Code', false, false, true],
    ]);
    expect(router.info().models[0]!.note).toContain('on a subscription none of it is billed');
    expect(router.knows('claude-code:claude-haiku-5-5')).toBe(true);
    // Neither hosted sessions nor web search are to be had through it.
    expect(router.hosts('claude-code:claude-opus-5-5', 'claude-code:claude-opus-5-5')).toBe(false);
    expect(router.searches('claude-code:claude-opus-5-5')).toBe(false);
    // It is the only connection, so a new organisation starts on it: on the balanced model, not the strongest.
    expect(router.defaultModel()).toBe('claude-code:claude-sonnet-5-5');

    // There is one login on the machine, so one connection.
    await expect(router.connect({ presetId: 'claude-code' })).rejects.toThrow(/already connected/);
    // It is kept, with no key and no address, and is there when the server starts again.
    const again = new ConnectionStore(path.join(dir, 'connections.json'), {});
    await again.load();
    expect(again.list().map((c) => [c.id, c.apiKey, c.baseURL, c.detail])).toEqual([['claude-code', '', '', 'Claude Code 2.1.317, signed in with a Claude Max plan']]);
    expect(JSON.parse(await readFile(path.join(dir, 'connections.json'), 'utf8')).hadKeys).toBe(true);
    expect(store.hadKeys).toBe(true);
  });

  it('is never what a new organisation starts on while there is a key', async () => {
    // Connected first, and listed first.
    const alone = await connections();
    await alone.router.connect({ presetId: 'claude-code' });
    const withOpenAI = await connections({ OPENAI_API_KEY: 'sk-test-1234' });
    expect(withOpenAI.router.info().connections!.map((c) => c.id)).toEqual(['openai', 'claude-code']);
    expect(withOpenAI.router.defaultModel()).toMatch(/^openai:/);
    // Also when the key was added after it, and so comes after it in every list.
    const file = path.join(dir, 'connections.json');
    const kept = JSON.parse(await readFile(file, 'utf8'));
    kept.connections.push({ id: 'deepseek', presetId: 'deepseek', label: 'DeepSeek', baseURL: 'https://api.deepseek.com', apiKey: 'sk-test-5678', source: 'stored', addedAt: new Date().toISOString(), models: [], checkedAt: null, listingError: null, prices: {}, extraModels: [] });
    await writeFile(file, JSON.stringify(kept));
    const later = await connections();
    expect(later.router.info().connections!.map((c) => c.id)).toEqual(['claude-code', 'deepseek']);
    expect(later.router.defaultModel()).toMatch(/^deepseek:/);
    await writeFile(file, JSON.stringify({ ...kept, connections: kept.connections.slice(0, 1) }));
    const withClaude = await connections({ ANTHROPIC_API_KEY: 'sk-ant-test' });
    expect(withClaude.router.defaultModel()).toBe('claude-opus-5-5');
    // The login's models are still there to be chosen.
    expect(withClaude.router.knows('claude-code:claude-sonnet-5-5')).toBe(true);
    expect(withClaude.router.info().models.filter((m) => m.connectionId === 'claude-code')).toHaveLength(4);
  });

  it('is refused, with the reason, where it cannot or may not be used', async () => {
    const missing = await connections({}, { command: '/no/such/claude' });
    await expect(missing.router.connect({ presetId: 'claude-code' })).rejects.toThrow(/Claude Code was not found on this machine/);
    const signedOut = await connections({}, { env: fakeEnv({ FAKE_CLAUDE_AUTH: '{"loggedIn":false}' }) });
    await expect(signedOut.router.connect({ presetId: 'claude-code' })).rejects.toThrow(ValidationError);
    const blocked = await connections({}, { blocked: 'The Claude Code connection is for your own use on this machine.' });
    await expect(blocked.router.connect({ presetId: 'claude-code' })).rejects.toThrow(/for your own use on this machine/);
    const without = await connections({}, null);
    await expect(without.router.connect({ presetId: 'claude-code' })).rejects.toThrow(/not started in a way that can run Claude Code/);
    expect(missing.router.simulated && signedOut.router.simulated && blocked.router.simulated && without.router.simulated).toBe(true);

    // A server that was moved to an address others can reach stops using a login that was connected before.
    const first = await connections();
    await first.router.connect({ presetId: 'claude-code' });
    const moved = await connections({}, { blocked: 'Switched off while the server listens on 0.0.0.0.' });
    const error = await failure(moved.router.structured(ask({ model: 'claude-code:claude-haiku-5-5' })));
    expect([error.code, error.retryable, error.message]).toEqual(['auth', false, 'Switched off while the server listens on 0.0.0.0.']);
    expect(await runs()).toEqual([]);
  });

  it('has no key to change, can be looked at again, and can be disconnected', async () => {
    const { router } = await connections();
    await router.connect({ presetId: 'claude-code' });
    await expect(router.update('claude-code', { apiKey: 'sk-ant-something' })).rejects.toThrow(/has no key/);
    expect((await router.update('claude-code', { label: 'My Claude Code' })).label).toBe('My Claude Code');
    const looked = await router.refresh('claude-code');
    expect(looked).toMatchObject({ detail: 'Claude Code 2.1.317, signed in with a Claude Max plan', listingError: null });
    expect(looked.checkedAt).not.toBeNull();

    // A call goes to the command, under the name the organisation knows the model by.
    const usage: CallUsage[] = [];
    expect(await router.structured(ask({ model: 'claude-code:claude-haiku-5-5', onUsage: (u) => usage.push(u) }))).toEqual({ proposal: 'Settled.', priority: 'high' });
    expect((await runs())[0]!.flags['--model']).toBe('claude-haiku-5-5');
    expect(new Set(usage.map((u) => u.model))).toEqual(new Set(['claude-code:claude-haiku-5-5']));
    // What Claude Code said of the plan's limits is shown with the connection from then on.
    expect(router.info().connections![0]!.usage).toBe('25% of the plan’s weekly limit was used when Claude Code last ran.');

    await router.disconnect('claude-code');
    expect(router.info().connections).toEqual([]);
    const error = await failure(router.structured(ask({ model: 'claude-code:claude-haiku-5-5' })));
    expect(error.message).toBe('Claude Code is not connected, which the model "claude-code:claude-haiku-5-5" needs. Connect it under Models and keys, or choose another model in this organisation\'s settings.');
    // It had a connection once, so it does not go back to simulating.
    expect(router.simulated).toBe(false);
  });

  it('is switched off on a server that other machines can reach', () => {
    expect(loadConfig({}).claudeCode).toEqual({ command: 'claude', extraUsage: false, blocked: null });
    expect(loadConfig({ HOST: 'localhost', CLAUDE_CODE_PATH: ' /opt/claude ', CLAUDE_CODE_EXTRA_USAGE: 'Allow' }).claudeCode).toEqual({ command: '/opt/claude', extraUsage: true, blocked: null });
    expect(loadConfig({ HOST: '0.0.0.0' }).claudeCode.blocked).toMatch(/switched off while the server listens on 0\.0\.0\.0.*use an API key/);
    expect(loadConfig({ CLAUDE_CODE_EXTRA_USAGE: 'yes' }).claudeCode.extraUsage).toBe(false);
  });

  it('carries a whole organisation through a cycle', async () => {
    const { router } = await connections();
    await router.connect({ presetId: 'claude-code' });
    h = await harness({
      provider: router,
      executives: [{ profileId: 'engineering', agentCount: 2 }, { profileId: 'product', agentCount: 1 }],
      settings: { executiveModel: 'claude-code:claude-sonnet-5-5', workerModel: 'claude-code:claude-haiku-5-5', maxCycles: 1, budgetUsd: 50 },
    });
    await runToRest(h.runner);
    const { org } = h;
    expect(org.lastError).toBeNull();
    expect(org.pauseReason).toBe('cycle_limit');
    expect(org.plans.length).toBeGreaterThan(0);
    for (const plan of org.plans) {
      expect(plan.status).toBe('done');
      // Hosted sessions are not to be had on this connection: the plan was carried out here.
      expect(plan.execution).toBe('local');
    }
    // The agents' files were written through the organisation's own tools, into its workspace.
    const files = (await h.runner.workspace.list()).map((f) => f.path);
    expect(files.some((f) => /^engineering\/note-\d+\.md$/.test(f))).toBe(true);
    expect(files.some((f) => /^product\/note-\d+\.md$/.test(f))).toBe(true);

    const all = await runs();
    expect(all.length).toBeGreaterThan(10);
    for (const run of all) {
      expect(run.flags).toMatchObject({ '--restricted': true, '--strict-mcp-config': true, '--tools': '', '--permission-prompts': 'none', '--no-session-persistence': true });
      expect(run.envNames.filter((name) => /^ANTHROPIC_|_API_KEY$/.test(name))).toEqual([]);
    }
    // Executives ran on one model and agents on the other, and each was counted under the name it was chosen by.
    expect(new Set(all.filter((r) => r.flags['--json-schema']).map((r) => r.flags['--model']))).toEqual(new Set(['claude-sonnet-5-5']));
    expect(new Set(all.filter((r) => r.flags['--mcp-config']).map((r) => r.flags['--model']))).toEqual(new Set(['claude-haiku-5-5']));
    expect(org.usage.costUsd).toBeGreaterThan(0.1);
    // Every reply of every run is counted once: one for an executive's answer, three for an agent's task here.
    const tasks = all.filter((r) => r.flags['--mcp-config']).length;
    expect(org.usage.calls).toBe(all.length - tasks + 3 * tasks);
    // And spend comes to what the runs said they cost: a cent a reply, in the stand-in.
    expect(org.usage.costUsd).toBeCloseTo(0.01 * org.usage.calls, 6);
  });
});

describe('Claude Code over the API', () => {
  let server: http.Server;
  let registry: Registry;

  afterEach(async () => {
    if (!server) return;
    await registry.shutdown();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('is connected by naming it, with no key in the request or in anything said back', async () => {
    const store = new Store(dir);
    await store.init();
    const connections = new ConnectionStore(path.join(dir, 'connections.json'), {});
    await connections.load();
    const router = new ProviderRouter(connections, { mock: QUIET, claudeCode: { command: FAKE, dir: path.join(dir, 'claude-code'), env: fakeEnv(), killGraceMs: 200 } });
    registry = new Registry(store, router, { retryDelayMs: 1, emitIntervalMs: 1 });
    const config: Config = { port: 0, host: '127.0.0.1', dataDir: dir, provider: 'auto', providerReason: 'test', production: false, workspace: 'default', anthropicAmbient: false, claudeCode: { command: FAKE, extraUsage: false, blocked: null } };
    server = createApp(registry, config, router).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = async (method: string, url: string, body?: unknown) => {
      const res = await fetch(base + url, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, data: (await res.json()) as any };
    };

    const meta = await call('GET', '/api/meta');
    expect(meta.data.keys.presets.find((p: { id: string }) => p.id === 'claude-code')).toMatchObject({ kind: 'claude-code', label: 'Claude Code', env: [], models: [] });
    expect(meta.data.provider.simulated).toBe(true);

    const added = await call('POST', '/api/connections', { presetId: 'claude-code' });
    expect(added.status).toBe(201);
    expect(added.data.connections).toEqual([expect.objectContaining({ id: 'claude-code', presetId: 'claude-code', keyHint: '', baseURL: '', detail: 'Claude Code 2.1.317, signed in with a Claude Max plan' })]);
    expect(added.data.provider).toMatchObject({ simulated: false, defaultModel: 'claude-code:claude-sonnet-5-5' });
    expect((await call('POST', '/api/connections', { presetId: 'claude-code' })).status).toBe(400);

    // An organisation can be set to its models, and is told when it cannot be.
    const created = await call('POST', '/api/orgs', { name: 'Fernery', idea: 'A subscription box that sends people a new houseplant every month.', executives: [{ profileId: 'engineering', agentCount: 1 }], settings: { maxCycles: 1 } });
    expect(created.status).toBe(201);
    expect(created.data.org.settings).toMatchObject({ executiveModel: 'claude-code:claude-sonnet-5-5', workerModel: 'claude-code:claude-sonnet-5-5', execution: 'local' });

    expect((await call('DELETE', '/api/connections/claude-code')).data.connections).toEqual([]);
  });
});
