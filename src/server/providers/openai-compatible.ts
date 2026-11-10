import OpenAI from 'openai';
import { z } from 'zod';
import type { Effort } from '../../shared/types';
import { nearestEffort, type Dialect, type Price } from './catalogue';
import { extractJson, strictSchema, type JsonSchema } from './schema';
import { ProviderError, type AgentRequest, type AgentResult, type CallUsage, type StructuredRequest, type SystemPrompt } from './types';

// Any model that is reached through an OpenAI-compatible Chat Completions
// endpoint: OpenAI itself, Google's Gemini, and most other makers' APIs,
// including the Chinese ones. The endpoints agree on the shape of a request
// and differ in the details (what they call the output cap, whether they take
// a JSON schema, what they do with reasoning text). The differences that are
// known ahead of time are in the connection's `Dialect`; the rest are learned
// from the endpoint's refusals, once, and remembered.

type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type Tool = OpenAI.Chat.Completions.ChatCompletionTool;
type Chunk = OpenAI.Chat.Completions.ChatCompletionChunk;
type Usage = OpenAI.Completions.CompletionUsage;
type CreateParams = OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;

export interface CompatibleOptions {
  /** The provider's name, for messages a person reads. */
  label: string;
  baseURL: string;
  apiKey: string;
  dialect: Dialect;
  /** List price of a model on this connection, or null if it is not known. */
  priceOf(model: string): Price | null;
  /** The most output tokens the model allows in one reply, where that is known. */
  maxOutputOf?(model: string): number | undefined;
  /** The effort levels one model takes, where they are known and differ from the dialect's. Null for a model that takes none. */
  effortOf?(model: string): string[] | null | undefined;
  maxRetries?: number;
  /** Delay before a failed agent turn is sent again; doubles each time. */
  turnRetryDelayMs?: number;
  /** Extra headers for every request (some gateways ask for one naming the client). */
  headers?: Record<string, string>;
}

/** A model the endpoint says it serves, as far as the listing tells. */
export interface ListedModel {
  id: string;
  /** A name for people, where the listing has one. */
  name?: string;
  /** USD per million tokens, where the listing carries prices. */
  price?: Price;
  contextWindow?: number;
  /** The most output tokens one reply may have, where the listing says. */
  maxOutput?: number;
  /** False where the listing says the model cannot call tools. Unknown otherwise. */
  tools?: boolean;
  /** The reasoning effort levels the model takes, where the listing says. Null where it says the model takes none. */
  efforts?: string[] | null;
}

/** What is charged for a model whose price is not known: enough that an unknown model is never the cheap choice by accident. */
export const UNKNOWN_PRICE: Price = { input: 5, output: 25 };

// Most of these models think before they answer, and on most endpoints the thinking counts against the cap.
export const STRUCTURED_MAX_TOKENS = 32_000;
export const AGENT_MAX_TOKENS = 64_000;
/** How often one turn of an agent run is sent again after a failure that may pass, before the run is given up. */
export const TURN_RETRIES = 3;
/** How many times one request is reshaped after the endpoint refuses something about its form. */
const MAX_ADAPTATIONS = 10;
/** How often in a row an agent may send tool arguments that cannot be read before the run is given up. */
export const MAX_BAD_ARGUMENTS = 3;

export const WRAP_UP =
  'You have to stop here. Do not call any more tools. Give your closing report now: what you produced and where, and exactly what is left unfinished.';

/** Listings mix chat models with everything else an account can call. These are the ones that are not for chat. */
const NOT_CHAT = /embed|tts|whisper|speech|transcri|audio|realtime|image|dall-e|imagen|sora|veo|video|moderation|rerank|guard|ocr|vision-preview|search-index|babbage|davinci-00|bge-|clip/i;

/** A refusal that is about the way a structured answer was asked for. */
export const ABOUT_FORMAT = /response_format|text\.format|json_schema|json_object|json mode|structured|schema/i;
/** A refusal that is plainly about something other than the form of the request, so that reshaping it cannot help. */
export const NOT_ABOUT_FORM =
  /does not exist|not found|no such model|unknown model|not have access|api[ _-]?key|unauthori[sz]ed|authenticat|context (length|window)|too (long|large|many)|content (policy|filter|management)|moderation|inspection|safety|balance|quota|billing|credit|arrears/i;

/**
 * The codes and types endpoints put on a request they turned away for what it says, not for how it was put:
 * OpenAI's content_policy_violation and its *_policy codes, content_filter (Azure, Moonshot), Alibaba's
 * data_inspection_failed, moderation_blocked, ByteDance's SensitiveContentDetected, Zhipu's 1301.
 */
const REFUSED_CODE = /policy|safety|content_filter|data_inspection|moderation|sensitive_?content|\b1301\b/i;
/** The same in words, for an endpoint or a gateway in front of one that gives no code for it. */
const REFUSED_WORDS = /content (policy|filter|management)|inappropriate content|content exists risk|(prompt|input) was flagged/i;
/** Whether a refusal, by its code or failing that its words, is of what a request says. Sent again in any form, it would be refused again. */
export const refusesContent = (code: string, message: string): boolean => REFUSED_CODE.test(code) || REFUSED_WORDS.test(message);
export const refusedForContent = (err: InstanceType<typeof OpenAI.APIError>): boolean => refusesContent(`${err.code ?? ''} ${err.type ?? ''}`, err.message);

/** A refusal that says the prompt, or the prompt and the room asked for the reply together, is more than the model can read. */
export const OVERFLOW = /context (length|window|size|limit)|maximum context|context_length|prompt is too long|input.{0,30}too long|too many (input |prompt )?tokens|exceeds? the (model'?s? )?(maximum )?(context|input)/i;
/** The same said by its code, which OpenAI and the endpoints that copy it give, whatever the words. */
export const overflows = (err: InstanceType<typeof OpenAI.APIError>): boolean => err.code === 'context_length_exceeded' || OVERFLOW.test(err.message);
/** The room left for a reply when a request is sent again after overflowing the model's window. */
const SQUEEZED_CAP = 4096;

/** A refusal of the request as it was put, which putting it another way might cure. Some endpoints answer 422 where most answer 400. */
export function refusesForm(err: unknown): err is InstanceType<typeof OpenAI.APIError> {
  return err instanceof OpenAI.BadRequestError || err instanceof OpenAI.UnprocessableEntityError;
}

/**
 * Headers the client would add from OpenAI's OPENAI_CUSTOM_HEADERS variable, each set to be left out. They were
 * meant for OpenAI's endpoint, and these connections are mostly to someone else's.
 */
function environmentHeadersCleared(): Record<string, null> {
  const cleared: Record<string, null> = {};
  for (const line of (process.env.OPENAI_CUSTOM_HEADERS ?? '').split('\n')) {
    const colon = line.indexOf(':');
    if (colon > 0) cleared[line.slice(0, colon).trim()] = null;
  }
  return cleared;
}

/** What endpoints call a reply their content rules stopped. */
const REFUSED = /^(content_filter|sensitive|safety|prohibited_content)$/;

export const sleep = (ms: number, signal?: AbortSignal) =>
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

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
  /** Fields the endpoint put on the call that are not part of the common shape, to be sent back as they came. */
  extra: Record<string, unknown>;
}

interface Reply {
  content: string;
  /** The model's reasoning text, where the endpoint returns it. Some endpoints want it back with the tool calls. */
  reasoning: string;
  /** The field the reasoning came in, since it goes back under the same name. */
  reasoningField: 'reasoning_content' | 'reasoning' | null;
  /** Fields of the message that the dialect says go back as they came. */
  kept: Record<string, unknown>;
  calls: ToolCall[];
  finish: string | null;
  usage: CallUsage;
}

interface Shape {
  tools?: Tool[];
  toolChoice?: 'none';
  format?: CreateParams['response_format'];
}

export class OpenAICompatibleProvider {
  protected readonly client: OpenAI;
  protected readonly label: string;
  protected readonly dialect: Dialect;
  protected readonly turnRetryDelayMs: number;

  // What this endpoint has turned out not to accept, learned from its refusals.
  private streamUsage: boolean;
  private streaming = true;
  private toolChoiceNone: boolean;
  /** Fields of the dialect's extra body that the endpoint has refused. */
  private readonly noExtra = new Set<string>();
  protected readonly noEffort = new Set<string>();
  private readonly capParam = new Map<string, 'max_tokens' | 'max_completion_tokens'>();
  protected readonly cap = new Map<string, number>();
  /** Per model: how far down the dialect's list of ways to ask for structured output the endpoint has pushed it. */
  protected readonly structuredMode = new Map<string, number>();

  constructor(protected readonly options: CompatibleOptions) {
    this.label = options.label;
    this.dialect = options.dialect;
    this.streamUsage = options.dialect.streamUsage;
    this.toolChoiceNone = options.dialect.toolChoiceNone !== false;
    this.turnRetryDelayMs = options.turnRetryDelayMs ?? 2000;
    // Without an address the client would fall back to OpenAI's own, and send this connection's key there.
    if (!options.baseURL) throw new ProviderError(`${options.label} has no address to call.`, 'bad_request', false);
    this.client = new OpenAI({
      apiKey: options.apiKey || 'none', // a local server may take no key, but the client insists on one
      baseURL: options.baseURL,
      // The client reads these from OpenAI's environment variables when they are left unsaid, and would send
      // them to whoever this connection is for.
      organization: null,
      project: null,
      adminAPIKey: null,
      maxRetries: options.maxRetries ?? 3,
      defaultHeaders: { ...environmentHeadersCleared(), ...options.headers },
    });
  }

  /** The chat models this key can call, as the endpoint lists them. Throws if the endpoint refuses the key. */
  async listModels(signal?: AbortSignal): Promise<ListedModel[]> {
    const models: ListedModel[] = [];
    try {
      for await (const model of this.client.models.list({ signal })) {
        if (!model?.id || NOT_CHAT.test(model.id)) continue;
        models.push(listed(model as unknown as Record<string, unknown>));
        if (models.length >= 2000) break;
      }
    } catch (err) {
      throw this.translate(err);
    }
    return models;
  }

  async structured<T>(req: StructuredRequest<T>): Promise<T> {
    const full = z.toJSONSchema(req.schema) as JsonSchema;
    const messages: Message[] = [
      { role: 'system', content: systemText(req.system) },
      { role: 'user', content: req.prompt },
    ];
    const modes = this.dialect.structured;
    let mode = modes[this.structuredMode.get(req.model) ?? 0] ?? 'prompt';
    let reply: Reply;
    // A refusal that does not say what it objects to may be about the way the answer was asked for. The next way
    // down is tried, and kept only if it works; if nothing works, the first refusal is the one to report.
    let unexplained: unknown;
    const formatFor = (way: typeof mode): Shape['format'] =>
      way === 'json_schema' ? { type: 'json_schema', json_schema: { name: req.kind, schema: strictSchema(full), strict: true } } : way === 'json_object' ? { type: 'json_object' } : undefined;
    const asked = (way: typeof mode) => (way === 'json_schema' ? messages : withSchema(messages, full));
    for (;;) {
      const shaped = asked(mode);
      const format = formatFor(mode);
      try {
        reply = await this.complete(req.model, shaped, { format }, req.effort, STRUCTURED_MAX_TOKENS, req.signal, req.onUsage);
        if (unexplained) this.structuredMode.set(req.model, modes.indexOf(mode));
        break;
      } catch (err) {
        // An endpoint that does not take this way of asking says so with a 400. Ask the next way down, from now on.
        const next = modes.indexOf(mode) + 1;
        if (refusesForm(err) && format && next < modes.length) {
          if (ABOUT_FORMAT.test(err.message)) this.structuredMode.set(req.model, next);
          else unexplained ??= err;
          mode = modes[next]!;
          continue;
        }
        // The first refusal is the one to report only if this is still a refusal: a rate limit or an outage
        // met on the way down is what happened, and can be waited out.
        throw this.translate(refusesForm(err) ? (unexplained ?? err) : err);
      }
    }
    req.onUsage?.(reply.usage);
    this.checkFinish(reply);

    const read = (text: string) => {
      const data = mode === 'json_schema' ? safeParse(text) : extractJson(text);
      if (data === undefined) return { ok: false as const, problem: 'it was not a JSON object' };
      const parsed = req.schema.safeParse(data);
      if (parsed.success) return { ok: true as const, data: parsed.data };
      const issue = parsed.error.issues[0];
      return { ok: false as const, problem: `${issue?.path.join('.') || 'the object'}: ${issue?.message}` };
    };
    let result = read(reply.content);
    if (!result.ok) {
      // A model that is only asked for JSON, not held to a schema, sometimes misses a field, and an endpoint that
      // says it holds replies to a schema does not always. One chance to put it right costs far less than
      // starting the whole call again.
      const repair: Message[] = [
        ...asked(mode),
        // Some endpoints refuse a turn with nothing in it, and a reply of nothing but spaces is nothing.
        { role: 'assistant', content: reply.content.trim() ? reply.content : '(nothing)' },
        { role: 'user', content: `That reply does not match the required structure (${result.problem}). Reply again with the corrected JSON object and nothing else.` },
      ];
      try {
        const second = await this.complete(req.model, repair, { format: formatFor(mode) }, req.effort, STRUCTURED_MAX_TOKENS, req.signal, req.onUsage);
        req.onUsage?.(second.usage);
        this.checkFinish(second);
        result = read(second.content);
      } catch (err) {
        throw this.translate(err);
      }
    }
    if (!result.ok) throw new ProviderError(`The reply did not match the expected structure (${result.problem}).`, 'invalid_output', true);
    return result.data;
  }

  /**
   * A tool loop written out by hand, as for Claude: spend is counted and the
   * budget checked between turns, and a turn that fails is sent again by
   * itself instead of the whole run being paid for twice.
   */
  async agent(req: AgentRequest): Promise<AgentResult> {
    const tools: Tool[] = req.tools.map((tool) => {
      const { $schema: _dialect, ...parameters } = z.toJSONSchema(tool.schema) as Record<string, unknown>;
      return { type: 'function', function: { name: tool.name, description: tool.description, parameters } };
    });
    const messages: Message[] = [
      { role: 'system', content: systemText(req.system) },
      { role: 'user', content: req.prompt },
    ];
    let turns = 0;
    let retries = 0;
    let badArguments = 0;
    let wrapUpSent = false;

    for (;;) {
      if (req.shouldStop?.()) return { text: '', turns, stopped: 'interrupted' };
      // Nothing has been spent on this run yet, so there is nothing to wrap up: leave the task for later.
      if (turns === 0 && req.shouldWrapUp?.()) return { text: '', turns, stopped: 'interrupted' };

      let reply: Reply;
      try {
        reply = await this.complete(req.model, messages, { tools, toolChoice: wrapUpSent ? 'none' : undefined }, req.effort, AGENT_MAX_TOKENS, req.signal, req.onUsage);
      } catch (err) {
        const failure = this.translate(err);
        if (req.signal?.aborted) throw failure;
        // The failed turn was never added to the history, so the same request can be sent again.
        if (failure.retryable && retries < TURN_RETRIES) {
          await sleep(this.turnRetryDelayMs * 2 ** retries++, req.signal);
          continue;
        }
        throw failure;
      }
      req.onUsage?.(reply.usage);
      try {
        this.checkStopped(reply);
      } catch (err) {
        // A reply the endpoint lost part-way was paid for but never joined the history: the turn can be asked for again.
        if (err instanceof ProviderError && err.retryable && retries < TURN_RETRIES && !req.signal?.aborted) {
          await sleep(this.turnRetryDelayMs * 2 ** retries++, req.signal);
          continue;
        }
        throw err;
      }
      retries = 0;
      turns += 1;

      const text = reply.content.trim();
      if (!reply.calls.length) {
        if (reply.finish === 'length' && !text) throw new ProviderError('The reply was cut off before it said anything.', 'truncated', true);
        return { text, turns, stopped: wrapUpSent || reply.finish === 'length' ? 'cut_short' : 'done' };
      }
      // A call cut off at the output limit can still read as a smaller valid one, so it is never run.
      if (reply.finish === 'length') throw new ProviderError('A tool call was cut off before it was complete.', 'truncated', true);
      if (wrapUpSent) return { text, turns, stopped: 'cut_short' };

      messages.push(this.assistantTurn(reply));
      let unreadable = 0;
      for (const call of reply.calls) {
        const result = await runTool(req, call);
        if (result.unreadable) unreadable += 1;
        messages.push({ role: 'tool', tool_call_id: call.id, content: result.content });
      }
      badArguments = unreadable === reply.calls.length ? badArguments + 1 : 0;
      if (badArguments >= MAX_BAD_ARGUMENTS) throw new ProviderError('The agent kept sending tool calls that could not be read.', 'invalid_output', false);

      if (turns >= req.maxTurns || req.shouldWrapUp?.()) {
        wrapUpSent = true;
        messages.push({ role: 'user', content: WRAP_UP });
      }
    }
  }

  /** The assistant's turn as it goes back into the history: its words, its tool calls, and whatever the endpoint wants kept with them. */
  private assistantTurn(reply: Reply): Message {
    const calls = reply.calls.map((call) => ({ ...call.extra, id: call.id, type: 'function' as const, function: { name: call.name, arguments: call.arguments } }));
    // An endpoint that refuses a tool call returned without what it attached gets a stand-in when it attached nothing.
    const fallback = this.dialect.firstCallFallback;
    if (fallback && calls[0] && !reply.calls.some((call) => Object.keys(call.extra).length) && !Object.keys(reply.kept).length) calls[0] = { ...fallback, ...calls[0] };
    const turn: Message = { role: 'assistant', content: reply.content || null, tool_calls: calls };
    // Reasoning text is not part of the common shape. Endpoints that return it differ on whether it must come
    // back with the tool calls it led to or must not; the connection's dialect says which.
    const reasoning = this.dialect.echoReasoning && reply.reasoning && reply.reasoningField ? { [reply.reasoningField]: reply.reasoning } : {};
    return { ...turn, ...reasoning, ...reply.kept } as Message;
  }

  /** Ways a reply can end that are not the model finishing what it had to say. Endpoints have their own names for some. */
  private checkStopped(reply: Reply): void {
    const finish = reply.finish ?? '';
    if (REFUSED.test(finish)) throw new ProviderError('The model declined this request.', 'refusal', false);
    if (finish === 'network_error' || finish === 'error' || finish === 'insufficient_system_resource') throw new ProviderError(`${this.label} lost the reply part-way through.`, 'unavailable', true);
    if (/context_window|context_length/.test(finish)) throw new ProviderError('The conversation grew longer than the model can read.', 'too_long', false);
  }

  private checkFinish(reply: Reply): void {
    this.checkStopped(reply);
    if (reply.finish === 'length') throw new ProviderError('The reply was cut off before it was complete.', 'truncated', true);
  }

  /**
   * One request. Its form is adjusted to what the endpoint has been found to
   * accept; when the endpoint refuses something about the form, the request
   * is reshaped and sent again, and the lesson is kept for later requests.
   * A reply that breaks off part-way returns nothing, so what it cost is told to `onLost`.
   */
  private async complete(model: string, messages: Message[], shape: Shape, effort: Effort, wanted: number, signal?: AbortSignal, onLost?: (usage: CallUsage) => void): Promise<Reply> {
    type Optional = 'effort' | 'extra' | 'choice' | 'usage';
    // How this request goes out. It starts from what earlier requests learned about the endpoint, and each
    // refusal changes it. A change is kept for later requests only once a request has gone through with it:
    // a refusal that turns out to have been about something else teaches nothing.
    const now = {
      capParam: this.capParam.get(model) ?? this.dialect.maxTokensParam,
      cap: Math.min(wanted, this.cap.get(model) ?? this.options.maxOutputOf?.(model) ?? wanted),
      effort: !this.noEffort.has(model),
      extra: new Set(Object.keys(this.dialect.extraBody ?? {}).filter((key) => !this.noExtra.has(key))),
      choice: this.toolChoiceNone,
      usage: this.streamUsage,
      streaming: this.streaming,
    };
    const lessons: Array<() => void> = [];
    // After a refusal that does not say what it objects to, the request is sent once more as it was, and then
    // without each thing an endpoint might not know: one at a time, then all together. If nothing helps, the
    // first refusal is the one reported.
    let without = new Set<Optional>();
    let trials: Optional[][] | null = null;
    let unexplained: unknown;
    let squeezed = false;
    for (let adaptations = 0; ; adaptations++) {
      const level = now.effort && !without.has('effort') ? this.levelFor(model, effort) : undefined;
      const extra = without.has('extra') ? {} : Object.fromEntries(Object.entries(this.dialect.extraBody ?? {}).filter(([key]) => now.extra.has(key)));
      const choice = shape.toolChoice && now.choice && !without.has('choice') ? shape.toolChoice : undefined;
      const usage = now.usage && !without.has('usage');
      const body: Record<string, unknown> = {
        ...extra,
        model,
        messages,
        [now.capParam]: now.cap,
        ...(level ? { reasoning_effort: level } : {}),
        ...(shape.tools?.length ? { tools: shape.tools } : {}),
        ...(choice ? { tool_choice: choice } : {}),
        ...(shape.format ? { response_format: shape.format } : {}),
      };
      try {
        const reply = now.streaming ? await this.stream(model, body, usage, signal, onLost) : await this.whole(model, body, signal);
        for (const learn of lessons) learn();
        if (without.has('effort')) this.noEffort.add(model);
        if (without.has('extra')) for (const key of now.extra) this.noExtra.add(key);
        if (without.has('choice')) this.toolChoiceNone = false;
        if (without.has('usage')) this.streamUsage = false;
        return reply;
      } catch (err) {
        if (!refusesForm(err)) throw err;
        // Nothing about the form of a request changes what it says.
        if (refusedForContent(err)) throw this.translate(err);
        if (adaptations >= MAX_ADAPTATIONS) throw unexplained ?? err;
        const said = err.message;
        // The way a structured answer is asked for is the caller's to change.
        if (shape.format && ABOUT_FORMAT.test(said)) throw err;
        // A refusal that names what it objects to says how to put the request next.
        const refusedExtra = Object.keys(extra).find((key) => said.includes(key));
        if (refusedExtra) {
          now.extra.delete(refusedExtra);
          lessons.push(() => this.noExtra.add(refusedExtra));
        } else if (usage && /stream_options|include_usage/i.test(said)) {
          now.usage = false;
          lessons.push(() => (this.streamUsage = false));
        } else if (level && /reasoning_effort|reasoning\.effort|reasoning effort/i.test(said)) {
          now.effort = false;
          lessons.push(() => this.noEffort.add(model));
        } else if (choice && /tool_choice/i.test(said)) {
          now.choice = false;
          lessons.push(() => (this.toolChoiceNone = false));
        } else if (overflows(err)) {
          // The prompt and the room asked for the reply do not fit the model's window together. A shorter
          // reply may fit: for this request only, since the next prompt may well be shorter.
          if (squeezed || now.cap <= SQUEEZED_CAP) throw new ProviderError('The work outgrew the model’s context window.', 'too_long', false);
          squeezed = true;
          now.cap = SQUEEZED_CAP;
        } else if (/max_completion_tokens/i.test(said) && /unsupported|unrecognized|unknown|not supported|not permitted|unexpected|instead/i.test(said) && now.capParam === 'max_completion_tokens') {
          now.capParam = 'max_tokens';
          lessons.push(() => this.capParam.set(model, 'max_tokens'));
        } else if (/max_tokens/i.test(said) && /max_completion_tokens/i.test(said) && now.capParam === 'max_tokens') {
          now.capParam = 'max_completion_tokens';
          lessons.push(() => this.capParam.set(model, 'max_completion_tokens'));
        } else if (/max_tokens|max_completion_tokens|max_output|(output|completion) tokens/i.test(said) && now.cap > 1024) {
          // The model allows less output than was asked for: that is true of every request to it.
          const lower = lowerCap(said, now.cap);
          now.cap = lower;
          if (!squeezed) lessons.push(() => this.cap.set(model, lower));
        } else if (now.streaming && /\bstream(ing|ed)?\b/i.test(said) && /not supported|unsupported|does not support|not allowed|not available|disabled|must be false/i.test(said)) {
          now.streaming = false;
          lessons.push(() => (this.streaming = false));
        } else {
          if (NOT_ABOUT_FORM.test(said)) throw unexplained ?? err;
          unexplained ??= err;
          if (!trials) {
            const sent: Optional[] = [];
            if (level) sent.push('effort');
            if (Object.keys(extra).length) sent.push('extra');
            if (choice) sent.push('choice');
            if (usage && now.streaming) sent.push('usage');
            // First as it was: a refusal that does not come twice was a passing fault, and teaches nothing.
            trials = [[], ...sent.map((one) => [one])];
            if (sent.length > 1) trials.push(sent);
          }
          const next = trials.shift();
          if (!next) throw unexplained;
          without = new Set(next);
        }
      }
    }
  }

  /** What an organisation's effort setting is sent as to one model: the nearest level the model takes, or nothing. */
  protected levelFor(model: string, effort: Effort): string | undefined {
    const own = this.options.effortOf?.(model);
    return nearestEffort(effort, own === undefined ? this.dialect.efforts : own);
  }

  private async stream(model: string, body: Record<string, unknown>, withUsage: boolean, signal?: AbortSignal, onLost?: (usage: CallUsage) => void): Promise<Reply> {
    const params = { ...body, stream: true, ...(withUsage ? { stream_options: { include_usage: true } } : {}) } as unknown as CreateParams;
    const stream = await this.client.chat.completions.create(params, { signal });
    let content = '';
    let reasoning = '';
    let reasoningField: Reply['reasoningField'] = null;
    let finish: string | null = null;
    let usage: Usage | undefined;
    const kept: Record<string, unknown> = {};
    const calls: ToolCall[] = [];
    // A reply that breaks off once it has started was paid for as far as it got. It is counted as the endpoint
    // reported it, if it had, and otherwise by its length. A call that was stopped on purpose is not counted.
    const lost = () => {
      if (!signal?.aborted) onLost?.(this.price(model, usage, messagesLength(body), content.length + reasoning.length + callsLength(finished(calls))));
    };
    for await (const chunk of whileItLasts(stream as AsyncIterable<Chunk>, lost)) {
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finish = choice.finish_reason;
      // Reasoning text and anything else an endpoint adds are outside the common shape, so they are read by name.
      const delta = (choice.delta ?? {}) as unknown as Record<string, unknown>;
      if (typeof delta.content === 'string') content += delta.content;
      else if (Array.isArray(delta.content)) {
        const parts = readParts(delta.content);
        content += parts.text;
        reasoning += parts.thinking;
      }
      for (const field of ['reasoning_content', 'reasoning'] as const) {
        if (typeof delta[field] === 'string' && delta[field]) {
          reasoning += delta[field];
          reasoningField ??= field;
        }
      }
      for (const field of this.dialect.echoFields ?? []) keep(kept, field, delta[field]);
      if (Array.isArray(delta.tool_calls)) for (const part of delta.tool_calls as Array<Record<string, unknown>>) addCallPart(calls, part);
    }
    // Every reply ends by saying why it ended. A stream that closes without doing so was cut off somewhere
    // on the way, however cleanly, and what arrived is not the whole of it.
    if (finish === null) {
      lost();
      throw new ProviderError(`${this.label} ended a reply without saying it was finished.`, 'unavailable', true);
    }
    const made = finished(calls);
    return { content, reasoning, reasoningField, kept, calls: made, finish, usage: this.price(model, usage, messagesLength(body), content.length + reasoning.length + callsLength(made)) };
  }

  /** The same request without streaming, for the rare endpoint that does not stream. */
  private async whole(model: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<Reply> {
    const completion = await this.client.chat.completions.create(body as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming, { signal });
    const choice = completion.choices?.[0];
    const message = (choice?.message ?? {}) as unknown as Record<string, unknown>;
    const parts = Array.isArray(message.content) ? readParts(message.content) : { text: '', thinking: '' };
    const content = typeof message.content === 'string' ? message.content : parts.text;
    const reasoningField = typeof message.reasoning_content === 'string' ? 'reasoning_content' : typeof message.reasoning === 'string' ? 'reasoning' : null;
    const reasoning = reasoningField ? String(message[reasoningField]) : parts.thinking;
    const calls: ToolCall[] = [];
    if (Array.isArray(message.tool_calls)) for (const part of message.tool_calls as Array<Record<string, unknown>>) addCallPart(calls, { ...part, index: calls.length });
    const kept: Record<string, unknown> = {};
    for (const field of this.dialect.echoFields ?? []) keep(kept, field, message[field]);
    const made = finished(calls);
    return {
      content,
      reasoning,
      reasoningField,
      kept,
      calls: made,
      finish: choice?.finish_reason ?? null,
      usage: this.price(model, completion.usage, messagesLength(body), content.length + reasoning.length + callsLength(made)),
    };
  }

  /** What a request cost, from the endpoint's own token counts and the model's list price. */
  private price(model: string, usage: Usage | undefined, promptChars: number, replyChars: number): CallUsage {
    const more = (usage ?? {}) as unknown as Record<string, unknown>;
    const details = (usage?.prompt_tokens_details ?? {}) as unknown as Record<string, unknown>;
    const cached = details.cached_tokens ?? more.prompt_cache_hit_tokens;
    return this.cost(model, {
      // Without counts from the endpoint, the request is still charged for, at about four characters to a token.
      prompt: counted(usage?.prompt_tokens) ?? Math.ceil(promptChars / 4),
      cached: counted(cached) ?? 0,
      written: counted(details.cache_write_tokens) ?? 0,
      output: counted(usage?.completion_tokens) ?? Math.ceil(replyChars / 4),
      // A gateway that bills for others' models says what the request cost; that is taken over an estimate. A
      // cost of nothing is not: an endpoint that fills the field in without meaning it would make every call free.
      billed: (counted(more.cost) ?? 0) > 0 ? (more.cost as number) : null,
    });
  }

  /**
   * Token counts priced at the model's list rates. `prompt` is every input token; `cached` and `written` are the
   * parts of it read from and written to the provider's prompt cache, which are charged at rates of their own.
   */
  protected cost(model: string, counts: { prompt: number; cached: number; written: number; output: number; billed: number | null }): CallUsage {
    const price = this.options.priceOf(model) ?? UNKNOWN_PRICE;
    // A provider that charges more for a long prompt charges the whole request at the higher rates.
    const rates = price.long && counts.prompt > price.long.above ? price.long : price;
    const cached = Math.max(0, Math.min(counts.prompt, counts.cached));
    const written = Math.max(0, Math.min(counts.prompt - cached, counts.written));
    const plain = counts.prompt - cached - written;
    return {
      model,
      inputTokens: plain,
      outputTokens: counts.output,
      cacheReadTokens: cached,
      cacheWriteTokens: written,
      webSearches: 0,
      costUsd: counts.billed ?? (plain * rates.input + cached * (rates.cached ?? rates.input) + written * (rates.cacheWrite ?? rates.input) + counts.output * rates.output) / 1_000_000,
    };
  }

  /**
   * Map the client's typed errors onto what the engine needs to know: what happened and whether trying again can
   * help. What a provider says goes on to be shown and kept, so a key it quotes back is taken out first.
   */
  translate(err: unknown): ProviderError {
    const failure = this.describe(err);
    const clean = scrub(failure.message, this.options.apiKey);
    return clean === failure.message ? failure : new ProviderError(clean, failure.code, failure.retryable);
  }

  private describe(err: unknown): ProviderError {
    if (err instanceof ProviderError) return err;
    const who = this.label;
    if (err instanceof OpenAI.APIUserAbortError) return new ProviderError('The call was interrupted.', 'aborted', false);
    // Turned away for what the request says, under whatever status: some gateways answer 403, which is not a key refused.
    if (err instanceof OpenAI.APIError && refusedForContent(err)) return new ProviderError(`${who} declined this request: ${err.message}`, 'refusal', false);
    // One provider answers a bad key with a 400 that says so, where the rest answer 401.
    const keyRefused = err instanceof OpenAI.BadRequestError && /api[ _-]?key/i.test(err.message) && /valid|incorrect|missing|expired|not found/i.test(err.message);
    if (err instanceof OpenAI.AuthenticationError || err instanceof OpenAI.PermissionDeniedError || keyRefused) {
      return new ProviderError(`${who} rejected the API key: ${err.message}`, 'auth', false);
    }
    if (err instanceof OpenAI.RateLimitError) {
      // The same status is used for an account that is out of credit, which waiting does not cure.
      if (/insufficient|quota|balance|billing|credit/i.test(err.message)) return new ProviderError(`${who} says the account is out of credit or quota: ${err.message}`, 'auth', false);
      return new ProviderError(`${who} is rate limiting this key: ${err.message}`, 'rate_limit', true);
    }
    if (err instanceof OpenAI.APIConnectionError) return new ProviderError(`Could not reach ${who}: ${err.message}`, 'unavailable', true);
    if (err instanceof OpenAI.APIError) {
      if (err.status === 402) return new ProviderError(`${who} says the account is out of credit: ${err.message}`, 'auth', false);
      // A request too large for the endpoint to take in at all: the same work sent again would be as large.
      if (err.status === 413) return new ProviderError(`The work outgrew what ${who} takes in one request: ${err.message}`, 'too_long', false);
      const retryable = err.status === undefined || err.status >= 500 || err.status === 408 || err.status === 409;
      return new ProviderError(`${who} ${retryable ? 'failed' : 'rejected the request'}${err.status ? ` (${err.status})` : ''}: ${err.message}`, retryable ? 'unavailable' : 'bad_request', retryable);
    }
    if (err instanceof Error && err.cause !== undefined && err.cause !== null) {
      return new ProviderError(`The connection to ${who} was lost part-way through a reply: ${err.message}`, 'unavailable', true);
    }
    return new ProviderError(err instanceof Error ? err.message : String(err), 'bad_request', false);
  }
}

/**
 * A count an endpoint reported, if it is one: a number, and not below nothing. Anything else an endpoint may put in
 * its place is no count at all, and would make a cost that cannot be added to the spend.
 */
export const counted = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined);

/** The pieces of a streamed reply, as they come. If the stream fails before its end, `lost` is called before the failure is passed on. */
export async function* whileItLasts<T>(stream: AsyncIterable<T>, lost: () => void): AsyncGenerator<T> {
  try {
    yield* stream;
  } catch (err) {
    lost();
    throw err;
  }
}

/** A message with every appearance of a secret taken out of it. */
export function scrub(text: string, secret: string): string {
  return secret.length >= 6 ? text.split(secret).join('[the key]') : text;
}

export function systemText(system: SystemPrompt): string {
  return `${system.charter}\n\n${system.role}`;
}

/** The same messages, with the last one saying what JSON is wanted, for endpoints that cannot be handed the schema itself. */
export function withSchema(messages: Message[], schema: JsonSchema): Message[] {
  const last = messages.at(-1)!;
  const { $schema: _dialect, ...plain } = schema;
  // Some endpoints take a request for JSON only if the word "json" is in the prompt, so it is there in both cases.
  const ask = `\n\nReply in json: a single JSON object and nothing else, with no words before or after it and no code fence. The object must match this JSON Schema:\n${JSON.stringify(plain)}`;
  return [...messages.slice(0, -1), { ...last, content: `${String(last.content)}${ask}` } as Message];
}

export function safeParse(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' ? value : undefined;
  } catch {
    return extractJson(text);
  }
}

/**
 * Add one piece of a field that is being kept to send back. A streamed reply delivers such a field in pieces:
 * text is joined up, lists are joined up, and anything else is taken whole.
 */
function keep(kept: Record<string, unknown>, field: string, value: unknown): void {
  if (typeof value === 'string') {
    if (value) kept[field] = (typeof kept[field] === 'string' ? kept[field] : '') + value;
  } else if (Array.isArray(value)) {
    const list = Array.isArray(kept[field]) ? (kept[field] as unknown[]) : (kept[field] = []) as unknown[];
    for (const item of value) addItem(list, item);
  } else if (value !== undefined && value !== null) {
    kept[field] = value;
  }
}

/**
 * Add one item to a list that is being kept. An item that carries a number saying which item it is a piece of
 * (as a gateway's reasoning details do) is joined to the piece before it, so that what goes back is the item
 * whole, as it would have come had the reply not been streamed.
 */
function addItem(list: unknown[], item: unknown): void {
  const piece = item as Record<string, unknown> | null;
  const whole = piece && typeof piece === 'object' && typeof piece.index === 'number'
    ? (list.find((entry) => entry && typeof entry === 'object' && (entry as Record<string, unknown>).index === piece.index && (entry as Record<string, unknown>).type === piece.type) as Record<string, unknown> | undefined)
    : undefined;
  if (!piece || !whole) return void list.push(item && typeof item === 'object' ? { ...(item as object) } : item);
  for (const [key, value] of Object.entries(piece)) {
    if (key === 'index' || key === 'type' || key === 'id' || key === 'format') continue;
    if (typeof value === 'string' && typeof whole[key] === 'string') whole[key] = (whole[key] as string) + value;
    else if (value !== undefined && value !== null) whole[key] = value;
  }
}

/** The words and the thinking in a reply whose content came as a list of parts, as one provider sends it when a model reasons. */
function readParts(parts: unknown[]): { text: string; thinking: string } {
  let text = '';
  let thinking = '';
  for (const part of parts as Array<Record<string, unknown> | null>) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' && typeof part.text === 'string') text += part.text;
    else if (part.type === 'thinking') thinking += Array.isArray(part.thinking) ? readParts(part.thinking).text : typeof part.thinking === 'string' ? part.thinking : '';
  }
  return { text, thinking };
}

/** A lower output cap after the endpoint refused the last one: the limit it named, if it named one, or half. */
export function lowerCap(said: string, cap: number): number {
  // The client puts the HTTP status at the front of the message; that is not the limit.
  const named = [...said.replace(/^\s*\d{3}\b/, '').matchAll(/\d[\d,]{2,}/g)].map((m) => Number(m[0].replace(/,/g, ''))).filter((n) => n >= 512 && n < cap);
  return named.length ? Math.max(...named) : Math.max(1024, Math.floor(cap / 2));
}

function messagesLength(body: Record<string, unknown>): number {
  return JSON.stringify(body.messages ?? '').length;
}

/** The size of a reply's tool calls, which are output the model wrote and is charged for like its words. */
function callsLength(calls: ToolCall[]): number {
  return calls.reduce((n, call) => n + call.name.length + call.arguments.length, 0);
}

/**
 * Add one streamed piece of a tool call to the calls gathered so far. The
 * common form numbers each call and sends its arguments in fragments; some
 * endpoints send a call whole, and some leave the number out.
 */
function addCallPart(calls: ToolCall[], part: Record<string, unknown>): void {
  const fn = (part.function ?? {}) as Record<string, unknown>;
  const id = typeof part.id === 'string' ? part.id : '';
  let call = typeof part.index === 'number' ? calls[part.index] : id && calls.at(-1)?.id !== id ? undefined : calls.at(-1);
  // A piece that carries an id other than the one its number already has is not a piece of that call but a
  // call of its own, from an endpoint that numbers every call the same.
  const another = !!call && !!id && !!call.id && call.id !== id;
  if (!call || another) {
    call = { id, name: '', arguments: '', extra: {} };
    if (typeof part.index === 'number' && !another) calls[part.index] = call;
    else calls.push(call);
  }
  if (id && !call.id) call.id = id;
  if (typeof fn.name === 'string' && fn.name) call.name = call.name ? call.name : fn.name;
  if (typeof fn.arguments === 'string') call.arguments += fn.arguments;
  else if (fn.arguments && typeof fn.arguments === 'object') call.arguments = JSON.stringify(fn.arguments);
  for (const [key, value] of Object.entries(part)) {
    if (key !== 'index' && key !== 'id' && key !== 'type' && key !== 'function' && value !== undefined && value !== null) call.extra[key] = value;
  }
}

/** The calls a reply made, each with an id to answer it by. An endpoint that leaves the id empty gets one made up. */
function finished(calls: ToolCall[]): ToolCall[] {
  return calls
    .filter((call): call is ToolCall => !!call && !!call.name)
    .map((call, i) => ({ ...call, id: call.id || `call${String(i).padStart(5, '0')}`, arguments: call.arguments || '{}' }));
}

export async function runTool(req: AgentRequest, call: Pick<ToolCall, 'name' | 'arguments'>): Promise<{ content: string; unreadable: boolean }> {
  const tool = req.tools.find((t) => t.name === call.name);
  if (!tool) return { content: `Error: there is no tool named ${call.name}.`, unreadable: false };
  let input: unknown;
  try {
    input = JSON.parse(call.arguments);
  } catch (err) {
    return { content: `Error: the arguments were not valid JSON (${(err as Error).message}). Call the tool again with valid JSON.`, unreadable: true };
  }
  const parsed = tool.schema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { content: `Error: the arguments do not fit the tool (${issue?.path.join('.') || 'arguments'}: ${issue?.message}). Call it again with the right arguments.`, unreadable: true };
  }
  try {
    return { content: await tool.run(parsed.data), unreadable: false };
  } catch (err) {
    return { content: `Error: ${(err as Error).message}`, unreadable: false };
  }
}

/** One entry of a models listing, read loosely: the common fields, and the extra ones some providers and gateways carry. */
export function listed(model: Record<string, unknown>): ListedModel {
  // Google's listing puts "models/" in front of every id; its chat endpoint takes the id either way.
  const entry: ListedModel = { id: String(model.id).replace(/^models\//, '') };
  const number = (...values: unknown[]) => values.find((v): v is number => typeof v === 'number' && v > 0);
  const object = (value: unknown) => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
  const levels = (value: unknown) => (Array.isArray(value) && value.every((v) => typeof v === 'string') ? (value as string[]) : undefined);

  if (typeof model.name === 'string' && model.name) entry.name = model.name;
  else if (typeof model.display_name === 'string' && model.display_name) entry.name = model.display_name;
  const context = number(model.context_length, model.context_window, model.max_context_length);
  if (context) entry.contextWindow = context;
  const maxOutput = number(model.max_output_tokens, object(model.top_provider).max_completion_tokens);
  if (maxOutput) entry.maxOutput = maxOutput;

  // A gateway's listing gives prices in dollars per token, as strings.
  const pricing = object(model.pricing);
  const perMillion = (value: unknown) => {
    const n = value === undefined || value === null || value === '' ? NaN : Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.round(n * 1e6 * 1e6) / 1e6 : undefined;
  };
  const input = perMillion(pricing.prompt);
  const output = perMillion(pricing.completion);
  if (input !== undefined && output !== undefined) {
    const cached = perMillion(pricing.input_cache_read);
    const cacheWrite = perMillion(pricing.input_cache_write);
    entry.price = { input, output, ...(cached !== undefined ? { cached } : {}), ...(cacheWrite !== undefined ? { cacheWrite } : {}) };
  }

  // Whether the model can call tools, in each of the ways a listing says it.
  const parameters = Array.isArray(model.supported_parameters) ? (model.supported_parameters as unknown[]) : undefined;
  const calling = object(object(model.features).tools).function_calling ?? object(model.capabilities).function_calling;
  if (parameters) entry.tools = parameters.includes('tools');
  else if (typeof calling === 'boolean') entry.tools = calling;

  // Which effort levels it takes: a provider's own listing, or a gateway's.
  const own = levels(object(model.effort).supported_levels) ?? levels(object(model.reasoning).supported_efforts);
  if (own) entry.efforts = own;
  else if (parameters && !parameters.includes('reasoning_effort') && !parameters.includes('reasoning')) entry.efforts = null;
  return entry;
}
