#!/usr/bin/env node
// A stand-in for the `claude` command, for tests. It takes the options the
// Claude Code provider passes, answers in the same stream of JSON events the
// real command writes, and reaches an agent's tools the way the real one
// does: over the tool server it is pointed at. It calls no model. Asked for
// a structured answer, it returns the plainest object that fits the schema;
// given tools, it writes one file and reports.
//
// Its shapes were copied from what Claude Code 2.1.317 printed on 2026-11-05.
// That makes it a check on what the provider sends and how it reads replies,
// not on what the real command does.
//
// What it does is steered through the environment:
//   FAKE_CLAUDE_LOG      a file to append one JSON line to for each run
//   FAKE_CLAUDE_MODE     follow (default) | limit | auth | model | overloaded | crash | unknown-option | hang
//                        | silent | extra | loop | maxturns | nostructured | invalid | refusal | badinput
//   FAKE_CLAUDE_VERSION  the version to claim
//   FAKE_CLAUDE_AUTH     JSON for `auth status`
import { appendFileSync, readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const env = process.env;
const VERSION = env.FAKE_CLAUDE_VERSION ?? '2.1.317';
const MODE = env.FAKE_CLAUDE_MODE ?? 'follow';

if (argv[0] === '--version') {
  console.log(`${VERSION} (Claude Code)`);
  process.exit(0);
}
if (argv[0] === 'auth' && argv[1] === 'status') {
  const status = env.FAKE_CLAUDE_AUTH ? JSON.parse(env.FAKE_CLAUDE_AUTH) : { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'someone@example.com', subscriptionType: 'max' };
  console.log(JSON.stringify(status, null, 2));
  process.exit(status.loggedIn ? 0 : 1);
}

// ---- a run ----

const VALUED = new Set(['--output-format', '--model', '--effort', '--system-prompt-file', '--json-schema', '--mcp-config', '--allowedTools', '--max-turns', '--tools', '--permission-prompts']);
const BARE = new Set(['-p', '--verbose', '--no-session-persistence', '--restricted', '--strict-mcp-config', '--disable-slash-commands']);
const flags = {};
for (let i = 0; i < argv.length; i++) {
  const name = argv[i];
  if (VALUED.has(name)) flags[name] = argv[++i];
  else if (BARE.has(name)) flags[name] = true;
  else {
    console.error(`error: unknown option '${name}'`);
    process.exit(1);
  }
}
if (MODE === 'unknown-option') {
  console.error("error: unknown option '--restricted'");
  process.exit(1);
}
if (!flags['-p']) {
  console.error('This stand-in only runs non-interactively.');
  process.exit(1);
}
if (flags['--output-format'] === 'stream-json' && !flags['--verbose']) {
  console.error('Error: When using --print, --output-format=stream-json requires --verbose');
  process.exit(1);
}

const prompt = readFileSync(0, 'utf8');
const system = flags['--system-prompt-file'] ? readFileSync(flags['--system-prompt-file'], 'utf8') : '';
const model = flags['--model'] ?? 'claude-sonnet-5-5';
const schema = flags['--json-schema'] ? JSON.parse(flags['--json-schema']) : null;
const servers = flags['--mcp-config'] ? (JSON.parse(flags['--mcp-config']).mcpServers ?? {}) : {};
// As the real command does, an entry with an address and no type is passed over.
const server = Object.entries(servers).find(([, s]) => s.type === 'http' && s.url);

if (env.FAKE_CLAUDE_LOG) {
  appendFileSync(
    env.FAKE_CLAUDE_LOG,
    `${JSON.stringify({ argv, flags, prompt, system, cwd: process.cwd(), envNames: Object.keys(env).sort(), mode: MODE })}\n`,
  );
}

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const session = 'fake-session';
let messages = 0;
/** What one reply cost: its input in full when it starts, and only a little of its output, as the real stream reports it. */
const reply = (content, partialOut = 5) => {
  messages += 1;
  emit({
    type: 'assistant',
    session_id: session,
    message: { id: `msg_${messages}`, type: 'message', role: 'assistant', model, content, stop_reason: null, usage: { input_tokens: 2000, output_tokens: partialOut, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  });
};
const limits = (more = {}) =>
  emit({ type: 'rate_limit_event', session_id: session, rate_limit_info: { status: 'allowed', resetsAt: 1794358800, rateLimitType: 'seven_day', utilization: 0.25, overageStatus: 'rejected', isUsingOverage: false, overageEnabled: false, ...more } });
const finish = (more = {}) => {
  const exact = { inputTokens: 2000 * messages, outputTokens: 500 * messages, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0.01 * messages, canonicalModel: model };
  emit({
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: session,
    num_turns: messages,
    result: '',
    stop_reason: 'end_turn',
    terminal_reason: 'completed',
    api_error_status: null,
    permission_denials: [],
    total_cost_usd: exact.costUSD,
    usage: { input_tokens: exact.inputTokens, output_tokens: exact.outputTokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    modelUsage: messages ? { [model]: exact } : {},
    ...more,
  });
};
const fail = (status, text) => {
  // Claude Code writes the failure itself, as a reply that is not the model's, and ends with a non-zero status.
  emit({ type: 'assistant', session_id: session, message: { id: 'synthetic', model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text }], usage: { input_tokens: 0, output_tokens: 0 } } });
  finish({ is_error: true, result: text, api_error_status: status, terminal_reason: 'api_error', stop_reason: 'stop_sequence', total_cost_usd: 0, modelUsage: {} });
  process.exit(1);
};

/** The plainest value that fits a JSON schema: the first of an enum, one item in a list, a word for a string. */
function fill(node, root = node) {
  if (node.$ref) return fill(node.$ref.replace(/^#\//, '').split('/').reduce((at, key) => at?.[key], root), root);
  if (node.const !== undefined) return node.const;
  if (Array.isArray(node.enum)) return node.enum[0];
  const variants = node.anyOf ?? node.oneOf;
  if (Array.isArray(variants)) return fill(variants.find((v) => v.type !== 'null') ?? variants[0], root);
  const type = Array.isArray(node.type) ? node.type.find((t) => t !== 'null') : node.type;
  switch (type) {
    case 'object':
      return Object.fromEntries(Object.entries(node.properties ?? {}).map(([key, value]) => [key, fill(value, root)]));
    case 'array':
      return [fill(node.items ?? {}, root)];
    case 'integer':
    case 'number':
      return Math.max(1, Number(node.minimum ?? 1));
    case 'boolean':
      return false;
    case 'null':
      return null;
    default:
      return 'Settled.';
  }
}

/** One request to the tool server, as the real command makes it. */
async function rpc(method, params, id) {
  const [, entry] = server;
  const res = await fetch(entry.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'user-agent': `claude-code/${VERSION} (sdk-cli)`, ...(entry.headers ?? {}) },
    body: JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}), ...(id === undefined ? {} : { id }) }),
  });
  if (id === undefined) return null;
  if (!res.ok) throw new Error(`the tool server answered ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

let calls = 0;
async function useTool(name, input) {
  calls += 1;
  const id = `toolu_${calls}`;
  reply([{ type: 'tool_use', id, name: `mcp__${server[0]}__${name}`, input }]);
  const result = await rpc('tools/call', { name, arguments: input, _meta: { 'claudecode/toolUseId': id } }, 100 + calls);
  emit({ type: 'user', session_id: session, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: result.content, is_error: result.isError }] } });
  return { text: result.content.map((c) => c.text).join(''), isError: !!result.isError };
}

async function main() {
  // A run that never says anything at all.
  if (MODE === 'silent') return new Promise(() => setInterval(() => {}, 1000));
  let tools = [];
  if (server) {
    // The real command first asks after a newer revision of the protocol, and falls back when the server does not know it.
    await rpc('server/discover', undefined, 0).catch(() => {});
    await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'claude-code', version: VERSION } }, 1);
    await rpc('notifications/initialized');
    tools = (await rpc('tools/list', undefined, 2)).tools;
  }
  emit({
    type: 'system',
    subtype: 'init',
    session_id: session,
    model,
    cwd: process.cwd(),
    permissionMode: 'default',
    apiKeySource: 'none',
    claude_code_version: VERSION,
    tools: [...(schema ? ['StructuredOutput'] : []), ...tools.map((t) => `mcp__${server[0]}__${t.name}`)],
    mcp_servers: server ? [{ name: server[0], status: 'connected' }] : [],
  });

  switch (MODE) {
    case 'limit':
      return fail(429, "You've hit your weekly limit · resets Nov 11, 9am (UTC)");
    case 'auth':
      return fail(401, 'Invalid API key · Please run /login');
    case 'model':
      return fail(404, `There's an issue with the selected model (${model}). It may not exist or you may not have access to it. Run --model to pick a different model.`);
    case 'overloaded':
      return fail(529, 'API Error: Repeated 529 Overloaded errors');
    case 'crash':
      console.error('Segmentation fault (stand-in)');
      process.exit(134);
    // eslint-disable-next-line no-fallthrough
    case 'hang':
      return new Promise(() => setInterval(() => {}, 1000));
    case 'extra':
      reply([{ type: 'text', text: 'Working.' }]);
      limits({ status: 'allowed', utilization: 1, overageStatus: 'allowed', overageEnabled: true, isUsingOverage: true });
      // The real command would carry on at the account's expense. Give the provider time to stop it.
      await new Promise((resolve) => setTimeout(resolve, Number(env.FAKE_CLAUDE_EXTRA_WAIT_MS ?? 300)));
      break;
    default:
      break;
  }

  if (schema) {
    if (MODE === 'refusal') {
      reply([{ type: 'text', text: 'I can’t help with that.' }]);
      return finish({ result: 'I can’t help with that.', stop_reason: 'refusal' });
    }
    if (MODE === 'nostructured') {
      reply([{ type: 'text', text: 'Here is my answer in prose instead.' }]);
      return finish({ result: 'Here is my answer in prose instead.' });
    }
    const data = MODE === 'invalid' ? { unexpected: true } : fill(schema);
    reply([{ type: 'tool_use', id: 'toolu_structured', name: 'StructuredOutput', input: data }], 24);
    emit({ type: 'user', session_id: session, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_structured', content: 'Structured output provided successfully' }] } });
    limits();
    return finish({ result: JSON.stringify(data), structured_output: data, stop_reason: 'tool_use' });
  }

  if (!server) {
    reply([{ type: 'text', text: 'Done.' }]);
    return finish({ result: 'Done.' });
  }

  if (MODE === 'maxturns') {
    await useTool('list_files', {});
    return finish({ subtype: 'error_max_turns', is_error: true, result: null, errors: [`Reached maximum number of turns (${flags['--max-turns']})`], terminal_reason: 'max_turns', stop_reason: 'tool_use' });
  }
  if (MODE === 'loop') {
    // An agent that never thinks it is finished: it stops only when a tool result tells it to.
    for (;;) {
      const result = await useTool('list_files', {});
      if (/You have to stop here/.test(result.text)) break;
      if (result.isError) break;
    }
    limits();
    reply([{ type: 'text', text: 'Stopped as told. Nothing is finished.' }]);
    return finish({ result: 'Stopped as told. Nothing is finished.' });
  }
  if (MODE === 'badinput') {
    const refused = await useTool('write_file', { path: 7 });
    reply([{ type: 'text', text: `The tool said: ${refused.text}` }]);
    return finish({ result: `The tool said: ${refused.text}` });
  }

  // Agents are told which folder their team keeps its files in.
  const dir = /Keep your files under `([^`]+)\/`/.exec(`${system}\n${prompt}`)?.[1] ?? 'shared';
  const name = `note-${process.pid}.md`;
  await useTool('list_files', {});
  const wrote = await useTool('write_file', { path: `${dir}/${name}`, content: `# Note\n\nWritten through Claude Code's stand-in.` });
  limits();
  reply([{ type: 'text', text: `Wrote the note and checked it. ${wrote.text}` }]);
  return finish({ result: `Wrote the note and checked it. ${wrote.text}` });
}

main().catch((err) => {
  console.error(err.stack ?? String(err));
  process.exit(1);
});
