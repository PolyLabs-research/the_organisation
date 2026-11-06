import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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
import { ClaudeCodeProvider, MIN_CLAUDE_CODE, checkClaudeCode, childEnv, describeStatus, unswallow, type ClaudeCodeOptions } from '../src/server/providers/claude-code';
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
      GOOGLE_CLIENT_SECRET: 'oauth-client-secret',
      MOONSHOT_BASE_URL: 'https://api.moonshot.cn/v1',
      SOME_AUTH_TOKEN: 'token',
      CLAUDECODE: '1',
      CLAUDE_CODE_SESSION_ID: 'parent-session',
      CLAUDE_CODE_ENTRYPOINT: 'sdk-cli',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_EFFORT: 'max',
      CLAUDE_PID: '5060',
      CLAUDE_CONFIG_DIR: '/home/someone/.claude-work',
      CLAUDE_SECURESTORAGE_CONFIG_DIR: '/home/someone/.claude-secure',
      CLAUDE_CODE_OAUTH_TOKEN: 'long-lived-token',
      UNSET: undefined,
    });
    expect(env).toEqual({
      PATH: '/bin',
      HOME: '/home/someone',
      HTTPS_PROXY: 'http://proxy.example:3128',
      CLAUDE_CONFIG_DIR: '/home/someone/.claude-work',
      CLAUDE_SECURESTORAGE_CONFIG_DIR: '/home/someone/.claude-secure',
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

    // Spend is counted as the reply starts, again as more of it is known, and made exact when the run says what it came to.
    expect(new Set(usage.map((u) => u.model))).toEqual(new Set(['claude-haiku-5-5']));
    expect(usage[0]).toMatchObject({ inputTokens: 2000, outputTokens: 1 });
    // One reply was given. Everything after the first word on it is more spend on that reply, not another reply.
    expect(usage.map((u) => u.adjustment ?? false)).toEqual([false, ...Array(usage.length - 1).fill(true)]);
    expect(usage.length).toBeGreaterThan(2);
    // The run asked for each reply's size as the reply ends.
    expect(run!.flags['--include-partial-messages']).toBe(true);
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

  it('takes an answer that is all there but for a slip in how the model wrote it, without waiting to be refused', async () => {
    // What a real model sent, in short: the summary ended with a tag of its own name, and the list after it went in with it.
    const slipped = {
      headline: 'The site is built and not yet verified.',
      summary: 'Spec, Build and Release produced their documents. It is not live.</summary>\n<parameter name="outcomes">["Delivered as files: site/index.html", "Nothing was run in a browser."]',
      asks: ['Someone with a browser: run the checks.'],
    };
    expect(unswallow(slipped)).toEqual({
      headline: 'The site is built and not yet verified.',
      summary: 'Spec, Build and Release produced their documents. It is not live.',
      outcomes: ['Delivered as files: site/index.html', 'Nothing was run in a browser.'],
      asks: ['Someone with a browser: run the checks.'],
    });
    // Text that was swallowed stays text, more than one field can be, and a field that arrived is left as it came.
    expect(unswallow({ proposal: 'Ship it.</proposal>\n<parameter name="rationale">Because [it] is ready.</rationale>\n<parameter name="needs">Nothing.', other: 1 })).toEqual({
      proposal: 'Ship it.',
      rationale: 'Because [it] is ready.',
      needs: 'Nothing.',
      other: 1,
    });
    expect(unswallow({ summary: 'One.</summary>\n<parameter name="asks">["swallowed"]', asks: ['kept'] })).toEqual({ summary: 'One.', asks: ['kept'] });
    // An answer with no such slip in it is not touched.
    const plain = { summary: 'Close with </p> as HTML does; <parameter name="x"> is not one.', asks: [] };
    expect(unswallow(plain)).toEqual(plain);
    expect(unswallow('text')).toBe('text');

    // The run is not left to ask five times and give up: the first answer is put right and taken.
    const Report = z.object({ headline: z.string(), summary: z.string(), outcomes: z.array(z.string()), asks: z.array(z.string()) });
    const usage: CallUsage[] = [];
    const began = Date.now();
    const data = await provider({ FAKE_CLAUDE_MODE: 'swallow' }).structured({ kind: 'report', system: SYSTEM, prompt: 'Report to the board.', model: 'claude-haiku-5-5', effort: 'low', schema: Report, context: {}, onUsage: (u: CallUsage) => usage.push(u) });
    expect(data).toEqual({ headline: 'Settled.', summary: 'Settled.', outcomes: ['Settled.'], asks: ['Settled.'] });
    // Left to itself the run would ask five times, over six seconds.
    expect(Date.now() - began).toBeLessThan(3000);
    // One reply was paid for, and counted: its input as reported, its output by the length of what it wrote.
    expect(usage.filter((u) => !u.adjustment)).toHaveLength(1);
    expect(usage.reduce((sum, u) => sum + u.inputTokens, 0)).toBe(2000);
    expect(usage.reduce((sum, u) => sum + u.outputTokens, 0)).toBeGreaterThan(24);
    // An answer that is wrong in itself is still refused.
    expect((await failure(provider({ FAKE_CLAUDE_MODE: 'invalid' }).structured(ask()))).code).toBe('invalid_output');
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
    const guarded = provider({ FAKE_CLAUDE_MODE: 'extra-once', FAKE_CLAUDE_EXTRA_WAIT_MS: '3000' });
    // Two runs are in flight when one of them hears that the plan's included usage is spent. Both are ended,
    // the one that heard nothing as well: its next reply would have been billed.
    const [error, other] = await Promise.all([failure(guarded.structured(ask())), failure(guarded.structured(ask({ model: 'claude-sonnet-5-5' })))]);
    expect([error.code, error.retryable, other.code, other.retryable]).toEqual(['rate_limit', false, 'rate_limit', false]);
    expect(error.message).toMatch(/has started to bill further usage as extra\. The organisation is paused so that it does not spend money without your say-so\. Nothing more is run on this login until 2026-11-11 at 01:00 UTC.*CLAUDE_CODE_EXTRA_USAGE=allow/);
    expect(guarded.limits()).toMatchObject({ usingExtra: true, extraAllowed: true, utilization: 1, window: 'seven_day' });
    // And nothing more is started on the login, on any model, until the limit is due to reset: resuming costs nothing.
    const before = (await runs()).length;
    expect((await failure(guarded.structured(ask()))).message).toMatch(/Nothing more is run on this login until/);
    expect((await failure(guarded.agent(task({ tools: tools().tools, model: 'claude-opus-5-5' })))).code).toBe('rate_limit');
    expect((await runs()).length).toBe(before);

    const allowed = provider({ FAKE_CLAUDE_MODE: 'extra', FAKE_CLAUDE_EXTRA_WAIT_MS: '10' }, { extraUsage: true });
    expect(await allowed.structured(ask())).toEqual({ proposal: 'Settled.', priority: 'high' });
    expect(await allowed.structured(ask())).toEqual({ proposal: 'Settled.', priority: 'high' });
  });

  it('pauses when a model is billed to paid usage though the plan has plenty left, and holds only that model', async () => {
    // Claude Code has a second word for this, which says nothing about the plan being spent.
    const guarded = provider({ FAKE_CLAUDE_MODE: 'credits', FAKE_CLAUDE_EXTRA_WAIT_MS: '3000' });
    const error = await failure(guarded.structured(ask({ model: 'claude-fable-5-1' })));
    expect([error.code, error.retryable]).toEqual(['rate_limit', false]);
    expect(error.message).toMatch(/this model is being billed to paid usage, not counted against your plan\. The organisation is paused.*Nothing more is run on this model until/);
    expect(guarded.limits()).toMatchObject({ usingExtra: true, utilization: 0.3 });
    const before = (await runs()).length;
    expect((await failure(guarded.structured(ask({ model: 'claude-fable-5-1' })))).code).toBe('rate_limit');
    expect((await runs()).length).toBe(before);
    // Another model on the same login is not held: it is started, and judged on what Claude Code says of it.
    await failure(guarded.structured(ask({ model: 'claude-haiku-5-5' })));
    expect((await runs()).length).toBe(before + 1);

    // A model the plan does not cover, on a login that has not agreed to pay for it, is refused by Claude Code itself.
    const refused = await failure(provider({ FAKE_CLAUDE_MODE: 'needscredits' }).structured(ask({ model: 'claude-fable-5-1' })));
    expect([refused.code, refused.retryable]).toEqual(['rate_limit', false]);
    expect(refused.message).toMatch(/would have to bill this call to paid usage, which your plan does not cover: This model needs usage credits\./);
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
    const server = JSON.parse(String(run!.flags['--mcp-config-read'])).mcpServers.org;
    expect(server).toMatchObject({ type: 'http', url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/[0-9a-f]{48}$/) });
    // The address is all it takes to use the tools, so it is not on the command line, which anyone on the machine
    // can see: it is in a file only this user can read, and the file is gone when the run is over.
    expect(run!.argv.join(' ')).not.toContain('/mcp/');
    expect(path.dirname(String(run!.flags['--mcp-config']))).toBe(path.join(dir, 'claude-code', 'runs'));
    expect(existsSync(String(run!.flags['--mcp-config']))).toBe(false);
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
    const url = JSON.parse(String((await runs())[0]!.flags['--mcp-config-read'])).mcpServers.org.url as string;
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

    // An agent that takes no notice is not left to run on: the next time it uses a tool, in a later reply, the run is ended.
    const deaf = tools();
    const ignored = await provider({ FAKE_CLAUDE_MODE: 'stubborn' }).agent(task({ tools: deaf.tools, shouldWrapUp: () => deaf.calls.length >= 2 }));
    expect(ignored.stopped).toBe('cut_short');
    expect(deaf.calls).toHaveLength(2);
    expect(ignored.turns).toBe(3);

    // An agent whose calls keep failing is told all the same: the notice rides on a refusal as it does on a result.
    const failing = tools();
    let asked = 0;
    const told = await provider({ FAKE_CLAUDE_MODE: 'badloop' }).agent(task({ tools: failing.tools, shouldWrapUp: () => ++asked > 2 }));
    expect(told).toMatchObject({ stopped: 'cut_short', text: 'Stopped as told, with nothing written.' });
    expect(failing.calls).toEqual([]);
    // Two calls that failed, the second of them carrying the notice, and the closing report.
    expect(told.turns).toBe(3);

    // Tools asked for together, in the reply that reaches the limit, are all carried out, as on every other provider.
    const three = tools();
    const together = await provider({ FAKE_CLAUDE_MODE: 'parallel' }).agent(task({ tools: three.tools, maxTurns: 1 }));
    expect(three.calls.map(([, input]) => input.path)).toEqual(['shared/a.md', 'shared/b.md', 'shared/c.md']);
    expect(together.stopped).toBe('cut_short');
    expect(together.text.match(/You have to stop here/g)).toHaveLength(3);
  });

  it('counts each reply in full as it ends, so that a run cut off has been paid for up to the reply it was cut off in', async () => {
    const kit = tools();
    const usage: CallUsage[] = [];
    const halted = await provider({ FAKE_CLAUDE_MODE: 'loop' }).agent(task({ tools: kit.tools, shouldStop: () => kit.calls.length >= 2, onUsage: (u) => usage.push(u) }));
    expect(halted.stopped).toBe('interrupted');
    // Two replies had ended and a third had begun. The two are counted whole, the third as far as it had got.
    expect(usage.filter((u) => !u.adjustment)).toHaveLength(3);
    expect(usage.reduce((sum, u) => sum + u.inputTokens, 0)).toBe(6000);
    expect(usage.reduce((sum, u) => sum + u.outputTokens, 0)).toBe(1005);
  });

  it('settles a run to its own account when the model goes by another name there', async () => {
    const usage: CallUsage[] = [];
    await provider({ FAKE_CLAUDE_MODE: 'renamed' }).structured(ask({ onUsage: (u) => usage.push(u) }));
    // One model in the run and one in its account: the same model, counted once.
    expect(usage.reduce((sum, u) => sum + u.inputTokens, 0)).toBe(2000);
    expect(usage.reduce((sum, u) => sum + u.outputTokens, 0)).toBe(500);
    expect(usage.reduce((sum, u) => sum + u.costUsd, 0)).toBeCloseTo(0.01, 9);
  });

  it('ends a run that could not reach its tools, and the runs in flight when the connection is closed', async () => {
    const lost = await failure(provider({ FAKE_CLAUDE_MODE: 'notools' }).agent(task({ tools: tools().tools })));
    expect([lost.code, lost.retryable]).toEqual(['unavailable', true]);
    expect(lost.message).toMatch(/could not reach the organisation’s tools/);

    const closing = provider({ FAKE_CLAUDE_MODE: 'hang' });
    const hung = closing.agent(task({ tools: tools().tools }));
    await waitFor(() => existsSync(log) && readFileSync(log, 'utf8').includes('"mode":"hang"'), 'the run to start');
    closing.close();
    const error = await failure(hung);
    expect([error.code, error.message]).toEqual(['auth', 'Claude Code was disconnected while this call was running.']);
  });

  it('ends whatever the command started along with it, when the command is a script around the real one', async () => {
    const wrapper = path.join(dir, 'claude-wrapper.sh');
    // No "exec": the script waits on the program, as a wrapper someone wrote for their own set-up might.
    writeFileSync(wrapper, `#!/bin/sh\n"${FAKE}" "$@"\n`, { mode: 0o755 });
    const cut = new AbortController();
    const hung = provider({ FAKE_CLAUDE_MODE: 'hang' }, { command: wrapper }).structured(ask({ signal: cut.signal }));
    await waitFor(() => existsSync(log), 'the run to start');
    const pid = (await runs()).at(-1)! as Run & { pid: number };
    const began = Date.now();
    cut.abort();
    expect((await failure(hung)).code).toBe('aborted');
    expect(Date.now() - began).toBeLessThan(3000);
    await waitFor(() => {
      try {
        process.kill(pid.pid, 0);
        return false;
      } catch {
        return true;
      }
    }, 'the program behind the script to end');
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
    expect(router.info().models[0]!.note).toContain('if Claude Code says a call is being billed, the organisation pauses');
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

    // An entry written by hand, with nothing but what it is, is kept too: it must not fall back to the simulator.
    await writeFile(path.join(dir, 'connections.json'), JSON.stringify({ version: 1, connections: [{ id: 'claude-code', presetId: 'claude-code', label: 'Claude Code', baseURL: 'https://left.over' }] }));
    const byHand = await connections();
    expect(byHand.store.list().map((c) => [c.id, c.apiKey, c.baseURL])).toEqual([['claude-code', '', '']]);
    expect(byHand.router.simulated).toBe(false);
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

    // Signed out since, it says so when looked at again, and no longer says how it was signed in.
    const signedOut = await connections({}, { env: fakeEnv({ FAKE_CLAUDE_AUTH: '{"loggedIn":false}' }) });
    const stale = await signedOut.router.refresh('claude-code');
    expect(stale.listingError).toMatch(/installed but not signed in.*try again here/);
    expect(stale.detail).toBeUndefined();
    expect(signedOut.router.info().connections![0]).not.toHaveProperty('detail');
    // It is asked afresh every time the server starts, however lately it was last asked.
    const again = await connections();
    expect(again.store.get('claude-code')!.listingError).toMatch(/not signed in/);
    await again.router.refreshStale();
    expect(again.store.get('claude-code')).toMatchObject({ listingError: null, detail: 'Claude Code 2.1.317, signed in with a Claude Max plan' });

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
