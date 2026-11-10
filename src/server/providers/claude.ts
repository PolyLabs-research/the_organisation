import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { BetaMessageStream } from '@anthropic-ai/sdk/lib/BetaMessageStream';
import { z } from 'zod';
import type { ProviderInfo } from '../../shared/types';
import { hasCause, translate } from './errors';
import { strictSchema, type JsonSchema } from './schema';
import { ManagedResources } from './managed/resources';
import { DEFAULT_TIMINGS, PlanSession, archiveSession, threadDetail, type SessionTimings } from './managed/session';
import { scrub } from './openai-compatible';
import { DEFAULT_MODEL, MODELS, WEB_SEARCH_PRICE, costOfRequest, webFetchToolFor, webSearchToolFor } from './pricing';
import {
  ProviderError,
  type AgentRequest,
  type AgentResult,
  type CallUsage,
  type PlanJob,
  type PlanOutcome,
  type Provider,
  type StructuredRequest,
  type SystemPrompt,
} from './types';

// Safety classifiers on current models can decline a request. With this opt-in
// the API retries a declined request on the fallback model Anthropic
// recommends for that kind of refusal, inside the same call. On a model
// without fallbacks the request simply runs on the requested model.
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

const STRUCTURED_MAX_TOKENS = 32_000;
const AGENT_MAX_TOKENS = 64_000;
/** How often a server-side tool turn that paused is resumed before the run is given up. */
const MAX_PAUSE_RESUMES = 5;
/** How often one turn of an agent run is sent again after a failure that may pass, before the run is given up. */
const TURN_RETRIES = 3;

export interface ClaudeProviderOptions {
  apiKey?: string;
  baseURL?: string;
  /** Headers for every request, over the client's own. One set to null is left out. */
  defaultHeaders?: Record<string, string | null>;
  maxRetries?: number;
  /** Delay before a failed agent turn is sent again; doubles each time. */
  turnRetryDelayMs?: number;
  /** Where the ids of the agents and environments that hosted sessions start from are kept. */
  managedStateFile?: string;
  /** The workspace's name in links to the Console. */
  workspace?: string;
  /** How a hosted session is paced. For tests. */
  sessionTimings?: Partial<SessionTimings>;
}

/** Runs the organisation on Claude through the Anthropic API. */
export class ClaudeProvider implements Provider {
  private readonly client: Anthropic;
  private readonly apiKey: string;
  private readonly turnRetryDelayMs: number;
  private readonly resources: ManagedResources;
  private readonly workspace: string;
  private readonly sessionTimings: SessionTimings;

  constructor(options: ClaudeProviderOptions = {}) {
    const { turnRetryDelayMs = 2000, managedStateFile = 'data/managed.json', workspace = 'default', sessionTimings, ...clientOptions } = options;
    this.turnRetryDelayMs = turnRetryDelayMs;
    this.apiKey = options.apiKey ?? '';
    // With no key passed, the SDK resolves credentials from the environment
    // (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or an `ant auth login` profile).
    this.client = new Anthropic({ maxRetries: 4, ...clientOptions });
    this.resources = new ManagedResources(this.client, managedStateFile);
    this.workspace = workspace;
    this.sessionTimings = { ...DEFAULT_TIMINGS, ...sessionTimings };
  }

  /**
   * What went wrong, as the engine needs to know it. What Anthropic, or an endpoint that stands in for it, said goes
   * on to be shown and kept, so a key it quotes back is taken out first.
   */
  private translate(err: unknown): ProviderError {
    const failure = translate(err);
    const clean = scrub(failure.message, this.apiKey);
    return clean === failure.message ? failure : new ProviderError(clean, failure.code, failure.retryable);
  }

  /**
   * Carry a plan through in a Claude Managed Agents session: the lead and its
   * agents work in a hosted sandbox where they can run what they build.
   */
  async executePlan(job: PlanJob): Promise<PlanOutcome> {
    try {
      return await new PlanSession({ client: this.client, resources: this.resources, workspace: this.workspace, timings: this.sessionTimings }, job).run();
    } catch (err) {
      throw this.translate(err);
    }
  }

  async agentDetail(sessionId: string, threadId: string): Promise<{ brief: string | null; report: string | null }> {
    try {
      return await threadDetail(this.client, sessionId, threadId);
    } catch (err) {
      throw this.translate(err);
    }
  }

  /** Whether a hosted session is on this key's account. A session belongs to the account that made it and is unknown to any other. */
  async hasSession(sessionId: string): Promise<boolean> {
    try {
      await this.client.beta.sessions.retrieve(sessionId);
      return true;
    } catch (err) {
      if (err instanceof Anthropic.NotFoundError) return false;
      throw this.translate(err);
    }
  }

  async archiveSession(sessionId: string): Promise<'archived' | 'busy' | 'gone'> {
    try {
      return await archiveSession(this.client, sessionId, Math.min(300, this.sessionTimings.graceMs));
    } catch (err) {
      throw this.translate(err);
    }
  }

  /** Create, or bring up to date, the agents and environment that hosted sessions of this kind start from. Sessions do this themselves when they need to. */
  async prepareManaged(spec: Parameters<ManagedResources['ensure']>[0]): Promise<Awaited<ReturnType<ManagedResources['ensure']>>> {
    try {
      return await this.resources.ensure(spec);
    } catch (err) {
      throw this.translate(err);
    }
  }

  info(): ProviderInfo {
    return {
      id: 'claude',
      label: 'Claude',
      simulated: false,
      defaultModel: DEFAULT_MODEL,
      models: MODELS.map((m) => ({ id: m.id, label: m.label, inputPerMTok: m.input, outputPerMTok: m.output, provider: 'Anthropic', priced: true, recommended: true, hosted: true, web: true })),
      managed: true,
    };
  }

  /** Set once the API has refused a schema that carries `enum`; from then on enums are stated in descriptions. */
  private plainSchemas = false;

  async structured<T>(req: StructuredRequest<T>): Promise<T> {
    let message: Anthropic.Beta.BetaMessage;
    try {
      message = await this.requestStructured(req, this.plainSchemas);
    } catch (err) {
      // Schemas are sent with their enums, which structured outputs document
      // as supported, so a reply can only name ids that exist. Should the API
      // refuse such a schema, repeat the call with the SDK's more conservative
      // form and keep to that form afterwards.
      // A request turned away for what it says, or for its length, would be turned away in either form.
      if (!(err instanceof Anthropic.BadRequestError) || this.plainSchemas || this.translate(err).code !== 'bad_request') throw this.translate(err);
      try {
        message = await this.requestStructured(req, true);
        this.plainSchemas = true;
      } catch {
        throw this.translate(err);
      }
    }
    req.onUsage?.(usageOf(message, req.model));
    checkStop(message);
    if (message.stop_reason === 'max_tokens') {
      throw new ProviderError('The reply was cut off before it was complete.', 'truncated', true);
    }
    const read = (blocks: Anthropic.Beta.BetaContentBlock[]): unknown => {
      const text = blocks
        .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('');
      try {
        return JSON.parse(text);
      } catch {
        return undefined;
      }
    };
    // A fallback model that took over part-way leaves a marker where it began. What follows the marker is the
    // answer written afresh, or the rest of the one the first model had started: whichever reads as JSON.
    const data = read(message.content.slice(message.content.findLastIndex((block) => block.type === 'fallback') + 1)) ?? read(message.content);
    if (data === undefined) throw new ProviderError('The reply was not valid JSON.', 'invalid_output', true);
    // The API enforces the shape; this also enforces whatever the schema could not express to it.
    const parsed = req.schema.safeParse(data);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new ProviderError(`The reply did not match the expected structure (${issue?.path.join('.')}: ${issue?.message}).`, 'invalid_output', true);
    }
    return parsed.data;
  }

  private requestStructured<T>(req: StructuredRequest<T>, plain: boolean): Promise<Anthropic.Beta.BetaMessage> {
    return replyOf(
      this.client.beta.messages.stream(
        {
          model: req.model,
          max_tokens: STRUCTURED_MAX_TOKENS,
          betas: [FALLBACK_BETA],
          fallbacks: 'default',
          system: systemBlocks(req.system),
          output_config: { effort: req.effort, format: outputFormat(req.schema, plain) },
          messages: [{ role: 'user', content: req.prompt }],
        },
        { signal: req.signal },
      ),
      req,
    );
  }

  /**
   * A manual tool loop rather than the SDK's tool runner: the organisation
   * needs to count spend and check the budget between turns, and the history
   * must stay append-only (thinking blocks are only valid in the conversation
   * that produced them, so earlier turns are never edited or dropped).
   */
  async agent(req: AgentRequest): Promise<AgentResult> {
    const tools: Anthropic.Beta.BetaToolUnion[] = req.tools.map((tool) => {
      const { $schema: _dialect, ...schema } = z.toJSONSchema(tool.schema) as Record<string, unknown>;
      return {
        name: tool.name,
        description: tool.description,
        input_schema: schema as Anthropic.Beta.BetaTool.InputSchema,
        // Stream file contents as they are generated instead of buffering them server-side.
        // The server then no longer validates the input, so it is validated below before use.
        eager_input_streaming: true,
      };
    });
    // `max_uses` limits one request, not the run, and the tool list cannot change
    // mid-run, so the allowance for the whole task is enforced below by counting.
    if (req.webSearch) {
      tools.push({ type: webSearchToolFor(req.model), name: 'web_search', max_uses: req.webSearch.perRequest });
      // Reading a page a search found (or a file names) is what turns a search hit into a checked source.
      // Each page is capped, since every page read is carried in every later turn of the run.
      tools.push({ type: webFetchToolFor(req.model), name: 'web_fetch', max_uses: MAX_FETCHES_PER_REQUEST, max_content_tokens: MAX_FETCH_TOKENS });
    }

    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: req.prompt }];
    let turns = 0;
    let pauses = 0;
    let badJson = 0;
    let retries = 0;
    let searches = 0;
    let searchesWhenWarned: number | null = null;
    let wrapUpSent = false;

    for (;;) {
      if (req.shouldStop?.()) return { text: '', turns, stopped: 'interrupted' };
      // Nothing has been spent on this run yet, so there is nothing to wrap up: leave the task for later.
      if (turns === 0 && req.shouldWrapUp?.()) return { text: '', turns, stopped: 'interrupted' };

      let message: Anthropic.Beta.BetaMessage;
      try {
        message = await replyOf(
          this.client.beta.messages.stream(
            {
              model: req.model,
              max_tokens: AGENT_MAX_TOKENS,
              betas: [FALLBACK_BETA],
              fallbacks: 'default',
              // The system prompt is cached explicitly; this caches the growing conversation as well.
              cache_control: { type: 'ephemeral' },
              system: systemBlocks(req.system),
              tools,
              output_config: { effort: req.effort },
              messages,
            },
            { signal: req.signal },
          ),
          req,
        );
        badJson = 0;
        retries = 0;
      } catch (err) {
        if (req.signal?.aborted) throw this.translate(err);
        const failure = this.translate(err);
        // The failed turn was never added to the history, so the same request can be sent
        // again. Giving up on the run instead would mean paying for every earlier turn twice.
        if (failure.retryable && retries < TURN_RETRIES) {
          await sleep(this.turnRetryDelayMs * 2 ** retries++, req.signal);
          continue;
        }
        if (!(err instanceof ProviderError) && !(err instanceof Anthropic.APIError) && !hasCause(err)) {
          // With eager input streaming, a tool input that is not parseable JSON rejects here.
          if (++badJson <= 2) continue;
          // The SDK's message ends with the whole of the input it could not read, which may be a file as long as
          // a megabyte. What went wrong is kept; the input is not, since this is shown to a person and stored.
          const why = (err as Error).message.replace(/\s*JSON: [\s\S]*$/, '').slice(0, 300);
          throw new ProviderError(`The agent’s tool call could not be read: ${why}`, 'invalid_output', false);
        }
        throw failure;
      }
      turns += 1;
      const usage = usageOf(message, req.model);
      req.onUsage?.(usage);
      searches += usage.webSearches;
      checkStop(message);

      if (message.stop_reason === 'pause_turn') {
        // A server-side tool (web search) hit its iteration limit; sending the turn back resumes it.
        if (++pauses > MAX_PAUSE_RESUMES) throw new ProviderError('The agent kept pausing on a server-side tool.', 'unavailable', true);
        messages.push({ role: 'assistant', content: message.content });
        continue;
      }
      // The turn came to its end: the limit is on one turn being resumed again and again, not on the whole run.
      pauses = 0;

      const { content, calls } = afterFallback(message.content);
      const text = content
        .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim();
      if (!calls.length) {
        // Words cut off at the token limit are still a report, and are marked as one that was cut short. Nothing at
        // all is not a report.
        if (message.stop_reason === 'max_tokens' && !text) throw new ProviderError('The reply was cut off before it said anything.', 'truncated', true);
        return { text, turns, stopped: wrapUpSent || message.stop_reason === 'max_tokens' ? 'cut_short' : 'done' };
      }

      // A tool input cut off at the token limit can still parse as a smaller valid object, so never run it.
      if (message.stop_reason === 'max_tokens') {
        throw new ProviderError('A tool call was cut off before it was complete.', 'truncated', true);
      }
      if (wrapUpSent) return { text, turns, stopped: 'cut_short' };

      messages.push({ role: 'assistant', content });
      const results: Anthropic.Beta.BetaContentBlockParam[] = [];
      for (const call of calls) {
        results.push(await runTool(req, call));
      }
      // Instructions to the agent mid-run go after the tool results, so earlier turns are never edited.
      const allowance = req.webSearch?.perTask ?? Infinity;
      const searchedAfterWarning = searchesWhenWarned !== null && searches > searchesWhenWarned;
      if (turns >= req.maxTurns || req.shouldWrapUp?.() || searchedAfterWarning) {
        wrapUpSent = true;
        results.push({ type: 'text', text: WRAP_UP });
      } else if (searches >= allowance && searchesWhenWarned === null) {
        searchesWhenWarned = searches;
        results.push({
          type: 'text',
          text: `You have used the ${allowance} web searches allowed for this task. Do not search again: finish the task with what you have found.`,
        });
      }
      messages.push({ role: 'user', content: results });
    }
  }
}

/** Pages an agent may read in one model request, and how much of each page it gets. */
const MAX_FETCHES_PER_REQUEST = 4;
const MAX_FETCH_TOKENS = 20_000;

const WRAP_UP =
  'You have to stop here. Do not call any more tools. Give your closing report now: what you produced and where, and exactly what is left unfinished.';

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (ms <= 0 || signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });

/**
 * The finished reply of a stream. A reply that fails once it has started to arrive has been paid for as far as
 * it got, so what the stream had said of its size by then is counted before the failure is passed on. A call
 * that was stopped on purpose is not counted.
 */
async function replyOf(stream: BetaMessageStream, req: Pick<AgentRequest, 'model' | 'signal' | 'onUsage'>): Promise<Anthropic.Beta.BetaMessage> {
  let started: Anthropic.Beta.BetaMessage | undefined;
  let written = 0;
  stream.on('streamEvent', (event, snapshot) => {
    started = snapshot;
    if (event.type === 'content_block_delta') written += sizeOf(event.delta);
  });
  try {
    return await stream.finalMessage();
  } catch (err) {
    if (started && !req.signal?.aborted) {
      // A reply says how much it wrote only as it ends. One that never got that far is counted by the length
      // of what had arrived, at about four characters to a token.
      const usage = started.stop_reason === null ? { ...started.usage, output_tokens: Math.max(started.usage.output_tokens, Math.ceil(written / 4)) } : started.usage;
      req.onUsage?.(usageOf({ ...started, usage }, req.model));
    }
    // Nothing was sent at all, and it was not the connection that failed: the SDK stops there when it has no key,
    // token or login to send the request with, or cannot use the one it has.
    if (!stream.response && !(err instanceof Anthropic.APIError) && !req.signal?.aborted) {
      throw new ProviderError(`No usable Anthropic credentials were found: ${(err as Error).message}`, 'auth', false);
    }
    // A stream that just stops, with no error from the API or from the connection, leaves the SDK with no message
    // to give: a reply that was never finished, or an answer with nothing in it. That is a reply lost on the way
    // like any other, and asking again may well get it.
    if (!(err instanceof Anthropic.APIError) && !hasCause(err) && (!stream.errored || (!started && stream.response))) {
      throw new ProviderError('The reply from Anthropic ended before it was complete.', 'unavailable', true);
    }
    throw err;
  }
}

/** How many characters of words, thinking or tool input one piece of a streamed reply carries. */
const sizeOf = (delta: Anthropic.Beta.BetaRawContentBlockDelta): number =>
  delta.type === 'text_delta' ? delta.text.length : delta.type === 'input_json_delta' ? delta.partial_json.length : delta.type === 'thinking_delta' ? delta.thinking.length : 0;

/**
 * What of an assistant turn may be sent back, and which tool calls in it are
 * live. When a safety classifier stops a model part-way and a fallback model
 * takes over, the turn holds a `fallback` marker. The first model's thinking
 * and tool calls before that marker were abandoned: they must not be echoed,
 * run or answered. Its text, and server tool calls that already have their
 * results, stand.
 */
function afterFallback(blocks: Anthropic.Beta.BetaContentBlock[]): {
  content: Anthropic.Beta.BetaContentBlock[];
  calls: Anthropic.Beta.BetaToolUseBlock[];
} {
  const isCall = (block: Anthropic.Beta.BetaContentBlock): block is Anthropic.Beta.BetaToolUseBlock => block.type === 'tool_use';
  const boundary = blocks.findLastIndex((block) => block.type === 'fallback');
  if (boundary < 0) return { content: blocks, calls: blocks.filter(isCall) };
  const before = blocks.slice(0, boundary);
  const resultFor = (block: Anthropic.Beta.BetaContentBlock) => ('tool_use_id' in block && typeof block.tool_use_id === 'string' ? block.tool_use_id : null);
  const answered = new Set(before.map(resultFor).filter((id): id is string => id !== null));
  const kept = before.filter((block) => block.type === 'text' || resultFor(block) !== null || (block.type === 'server_tool_use' && answered.has(block.id)));
  const after = blocks.slice(boundary + 1);
  return { content: [...kept, ...after], calls: after.filter(isCall) };
}

function outputFormat(schema: z.ZodType, plain: boolean): Anthropic.Beta.BetaJSONOutputFormat {
  // Neither form carries a `parse` function, so the SDK leaves reading the reply to the caller.
  if (plain) return { type: 'json_schema', schema: betaZodOutputFormat(schema).schema };
  return { type: 'json_schema', schema: strictSchema(z.toJSONSchema(schema) as JsonSchema) };
}

function systemBlocks(system: SystemPrompt): Anthropic.Beta.BetaTextBlockParam[] {
  // Two cache breakpoints: the charter is shared by every seat in the
  // organisation, so other seats' calls read it from cache.
  return [
    { type: 'text', text: system.charter, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: system.role, cache_control: { type: 'ephemeral' } },
  ];
}

async function runTool(req: AgentRequest, call: Anthropic.Beta.BetaToolUseBlock): Promise<Anthropic.Beta.BetaToolResultBlockParam> {
  const tool = req.tools.find((t) => t.name === call.name);
  if (!tool) {
    return { type: 'tool_result', tool_use_id: call.id, is_error: true, content: `Unknown tool: ${call.name}` };
  }
  const parsed = tool.schema.safeParse(call.input);
  if (!parsed.success) {
    // Hand the unusable input back so the model can issue the call again.
    return {
      type: 'tool_result',
      tool_use_id: call.id,
      is_error: true,
      content: JSON.stringify({ INVALID_JSON: JSON.stringify(call.input) }),
    };
  }
  try {
    return { type: 'tool_result', tool_use_id: call.id, content: await tool.run(parsed.data) };
  } catch (err) {
    return { type: 'tool_result', tool_use_id: call.id, is_error: true, content: `Error: ${(err as Error).message}` };
  }
}

function checkStop(message: Anthropic.Beta.BetaMessage): void {
  if (message.stop_reason === 'refusal') {
    const category = message.stop_details?.category;
    throw new ProviderError(`The model declined this request${category ? ` (${category})` : ''}.`, 'refusal', false);
  }
  if (message.stop_reason === 'model_context_window_exceeded') {
    // Trying the same work again would end the same way, so this is a failure of the work, not of the provider.
    throw new ProviderError('The work outgrew the model’s context window.', 'too_long', false);
  }
}

/**
 * What a response cost. When the API retried a declined request on a fallback
 * model, or ran several sampling rounds for a server tool, `usage.iterations`
 * lists every attempt with the model that made it, and the top-level figures
 * cover only the last. Each attempt is priced at its own model's rates.
 */
function usageOf(message: Anthropic.Beta.BetaMessage, requested: string): CallUsage {
  const usage = message.usage;
  const served = message.model || requested;
  const attempts = usage.iterations?.length
    ? usage.iterations.map((entry) => ({
        model: ('model' in entry && entry.model) || served,
        inputTokens: entry.input_tokens ?? 0,
        outputTokens: entry.output_tokens ?? 0,
        cacheReadTokens: entry.cache_read_input_tokens ?? 0,
        cacheWriteTokens: entry.cache_creation_input_tokens ?? 0,
      }))
    : [
        {
          model: served,
          inputTokens: usage.input_tokens ?? 0,
          outputTokens: usage.output_tokens ?? 0,
          cacheReadTokens: usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
        },
      ];
  const webSearches = usage.server_tool_use?.web_search_requests ?? 0;
  const sum = (pick: (attempt: (typeof attempts)[number]) => number) => attempts.reduce((total, attempt) => total + pick(attempt), 0);
  return {
    model: served,
    inputTokens: sum((a) => a.inputTokens),
    outputTokens: sum((a) => a.outputTokens),
    cacheReadTokens: sum((a) => a.cacheReadTokens),
    cacheWriteTokens: sum((a) => a.cacheWriteTokens),
    webSearches,
    costUsd: sum((a) => costOfRequest(a.model, a)) + webSearches * WEB_SEARCH_PRICE,
  };
}
