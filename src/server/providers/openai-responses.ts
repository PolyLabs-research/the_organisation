import OpenAI from 'openai';
import { z } from 'zod';
import type { Effort } from '../../shared/types';
import {
  ABOUT_FORMAT,
  AGENT_MAX_TOKENS,
  MAX_BAD_ARGUMENTS,
  NOT_ABOUT_FORM,
  OpenAICompatibleProvider,
  STRUCTURED_MAX_TOKENS,
  TURN_RETRIES,
  WRAP_UP,
  counted,
  lowerCap,
  overflows,
  refusedForContent,
  refusesContent,
  refusesForm,
  runTool,
  safeParse,
  sleep,
  systemText,
  whileItLasts,
} from './openai-compatible';
import { extractJson, strictSchema, type JsonSchema } from './schema';
import { ProviderError, type AgentRequest, type AgentResult, type CallUsage, type StructuredRequest } from './types';

// OpenAI's own models, through its Responses API. OpenAI's current models
// call tools only there: through Chat Completions the strongest will not call
// them at all, and the rest only with reasoning switched off.
//
// Nothing is kept on OpenAI's side (`store: false`). Each request carries the
// whole exchange so far, as it does for every other provider: what the model
// produced on a turn, its reasoning included, goes back exactly as it came.
// The reasoning comes encrypted, and is returned unread.
//
// Listing models, pricing and the wording of errors are shared with the
// provider for OpenAI-compatible endpoints, which this extends.

/** One thing in the exchange: a message, a tool call, its result, or a piece of the model's reasoning. Passed through as it came. */
type Item = Record<string, unknown>;

interface FunctionCall {
  callId: string;
  name: string;
  arguments: string;
}

interface Turn {
  /** Everything the model produced, to go back as it came. */
  items: Item[];
  text: string;
  calls: FunctionCall[];
  /** True when the reply stopped at the output cap. */
  cutOff: boolean;
}

interface Shape {
  tools?: Item[];
  toolChoice?: 'none';
  format?: Item;
}

/** How many times one request is reshaped after the endpoint refuses something about its form. */
const MAX_ADAPTATIONS = 7;
/** The room left for a reply when a request is sent again after overflowing the model's window. */
const SQUEEZED_CAP = 4096;

export class OpenAIResponsesProvider extends OpenAICompatibleProvider {
  /** Models that turned out not to take a request for their reasoning to come back encrypted. */
  private readonly noInclude = new Set<string>();

  override async structured<T>(req: StructuredRequest<T>): Promise<T> {
    const full = z.toJSONSchema(req.schema) as JsonSchema;
    const { $schema: _dialect, ...plain } = full;
    const instructions = systemText(req.system);
    const modes = this.dialect.structured;
    let mode = modes[this.structuredMode.get(req.model) ?? 0] ?? 'prompt';
    const formatFor = (way: typeof mode): Item | undefined =>
      way === 'json_schema' ? { type: 'json_schema', name: req.kind, schema: strictSchema(full), strict: true } : way === 'json_object' ? { type: 'json_object' } : undefined;
    // The word "json" has to be in the prompt for plain JSON to be asked for at all.
    const ask = `\n\nReply in json: a single JSON object and nothing else, with no words before or after it and no code fence. The object must match this JSON Schema:\n${JSON.stringify(plain)}`;
    const asked = (way: typeof mode): Item[] => [{ role: 'user', content: way === 'json_schema' ? req.prompt : `${req.prompt}${ask}` }];

    let turn: Turn;
    let unexplained: unknown;
    for (;;) {
      try {
        turn = await this.respond(req.model, asked(mode), instructions, { format: formatFor(mode) }, req.effort, STRUCTURED_MAX_TOKENS, req.onUsage, req.signal);
        if (unexplained) this.structuredMode.set(req.model, modes.indexOf(mode));
        break;
      } catch (err) {
        const next = modes.indexOf(mode) + 1;
        if (refusesForm(err) && formatFor(mode) && next < modes.length) {
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
    if (turn.cutOff) throw new ProviderError('The reply was cut off before it was complete.', 'truncated', true);

    const read = (text: string) => {
      const data = mode === 'json_schema' ? safeParse(text) : extractJson(text);
      if (data === undefined) return { ok: false as const, problem: 'it was not a JSON object' };
      const parsed = req.schema.safeParse(data);
      if (parsed.success) return { ok: true as const, data: parsed.data };
      const issue = parsed.error.issues[0];
      return { ok: false as const, problem: `${issue?.path.join('.') || 'the object'}: ${issue?.message}` };
    };
    let result = read(turn.text);
    if (!result.ok) {
      // One chance to put a wrong reply right costs far less than starting the whole call again.
      const repair: Item[] = [
        ...asked(mode),
        ...turn.items,
        { role: 'user', content: `That reply does not match the required structure (${result.problem}). Reply again with the corrected JSON object and nothing else.` },
      ];
      try {
        const second = await this.respond(req.model, repair, instructions, { format: formatFor(mode) }, req.effort, STRUCTURED_MAX_TOKENS, req.onUsage, req.signal);
        if (second.cutOff) throw new ProviderError('The reply was cut off before it was complete.', 'truncated', true);
        result = read(second.text);
      } catch (err) {
        throw this.translate(err);
      }
    }
    if (!result.ok) throw new ProviderError(`The reply did not match the expected structure (${result.problem}).`, 'invalid_output', true);
    return result.data;
  }

  /** The same loop as for every other provider: tools run here, spend is counted between turns, and a turn that fails is sent again by itself. */
  override async agent(req: AgentRequest): Promise<AgentResult> {
    const tools: Item[] = req.tools.map((tool) => {
      const { $schema: _dialect, ...parameters } = z.toJSONSchema(tool.schema) as Record<string, unknown>;
      // Not strict: the arguments are checked here when they arrive, and a strict schema has rules of its own to trip over.
      return { type: 'function', name: tool.name, description: tool.description, parameters, strict: false };
    });
    const instructions = systemText(req.system);
    const input: Item[] = [{ role: 'user', content: req.prompt }];
    let turns = 0;
    let retries = 0;
    let badArguments = 0;
    let wrapUpSent = false;

    for (;;) {
      if (req.shouldStop?.()) return { text: '', turns, stopped: 'interrupted' };
      // Nothing has been spent on this run yet, so there is nothing to wrap up: leave the task for later.
      if (turns === 0 && req.shouldWrapUp?.()) return { text: '', turns, stopped: 'interrupted' };

      let turn: Turn;
      try {
        turn = await this.respond(req.model, input, instructions, { tools, toolChoice: wrapUpSent ? 'none' : undefined }, req.effort, AGENT_MAX_TOKENS, req.onUsage, req.signal);
      } catch (err) {
        const failure = this.translate(err);
        if (req.signal?.aborted) throw failure;
        // The failed turn was never added to the exchange, so the same request can be sent again.
        if (failure.retryable && retries < TURN_RETRIES) {
          await sleep(this.turnRetryDelayMs * 2 ** retries++, req.signal);
          continue;
        }
        throw failure;
      }
      retries = 0;
      turns += 1;

      const text = turn.text.trim();
      if (!turn.calls.length) {
        if (turn.cutOff && !text) throw new ProviderError('The reply was cut off before it said anything.', 'truncated', true);
        return { text, turns, stopped: wrapUpSent || turn.cutOff ? 'cut_short' : 'done' };
      }
      // A call cut off at the output limit can still read as a smaller valid one, so it is never run.
      if (turn.cutOff) throw new ProviderError('A tool call was cut off before it was complete.', 'truncated', true);
      if (wrapUpSent) return { text, turns, stopped: 'cut_short' };

      input.push(...turn.items);
      let unreadable = 0;
      for (const call of turn.calls) {
        const result = await runTool(req, call);
        if (result.unreadable) unreadable += 1;
        input.push({ type: 'function_call_output', call_id: call.callId, output: result.content });
      }
      badArguments = unreadable === turn.calls.length ? badArguments + 1 : 0;
      if (badArguments >= MAX_BAD_ARGUMENTS) throw new ProviderError('The agent kept sending tool calls that could not be read.', 'invalid_output', false);

      if (turns >= req.maxTurns || req.shouldWrapUp?.()) {
        wrapUpSent = true;
        input.push({ role: 'user', content: WRAP_UP });
      }
    }
  }

  /**
   * One request. When the endpoint refuses something about its form, the request is reshaped and sent again.
   * What a refusal teaches is kept for later requests only once a request has gone through with the change.
   * The spend of every response that comes back is reported, whether or not the response is any use.
   */
  private async respond(
    model: string,
    input: Item[],
    instructions: string,
    shape: Shape,
    effort: Effort,
    wanted: number,
    onUsage: ((usage: CallUsage) => void) | undefined,
    signal?: AbortSignal,
  ): Promise<Turn> {
    type Optional = 'effort' | 'include';
    const now = {
      cap: Math.min(wanted, this.cap.get(model) ?? this.options.maxOutputOf?.(model) ?? wanted),
      effort: !this.noEffort.has(model),
      include: !this.noInclude.has(model),
    };
    const lessons: Array<() => void> = [];
    // After a refusal that does not say what it objects to, the request is sent once more as it was, and then
    // without each optional thing: one at a time, then both. If nothing helps, the first refusal is the one reported.
    let without = new Set<Optional>();
    let trials: Optional[][] | null = null;
    let unexplained: unknown;
    let squeezed = false;
    for (let adaptations = 0; ; adaptations++) {
      const level = now.effort && !without.has('effort') ? this.levelFor(model, effort) : undefined;
      const include = now.include && !without.has('include');
      const body: Record<string, unknown> = {
        model,
        instructions,
        input,
        max_output_tokens: now.cap,
        store: false,
        // With nothing stored, the model's reasoning has to travel with the exchange, which it does encrypted.
        ...(include ? { include: ['reasoning.encrypted_content'] } : {}),
        ...(level ? { reasoning: { effort: level } } : {}),
        ...(shape.tools?.length ? { tools: shape.tools } : {}),
        ...(shape.toolChoice ? { tool_choice: shape.toolChoice } : {}),
        ...(shape.format ? { text: { format: shape.format } } : {}),
        stream: true,
      };
      try {
        const turn = await this.read(model, body, onUsage, signal);
        for (const learn of lessons) learn();
        if (without.has('effort')) this.noEffort.add(model);
        if (without.has('include')) this.noInclude.add(model);
        return turn;
      } catch (err) {
        if (!refusesForm(err)) throw err;
        // Nothing about the form of a request changes what it says.
        if (refusedForContent(err)) throw this.translate(err);
        if (adaptations >= MAX_ADAPTATIONS) throw unexplained ?? err;
        const said = err.message;
        // The way a structured answer is asked for is the caller's to change.
        if (shape.format && ABOUT_FORMAT.test(said)) throw err;
        if (level && /\beffort\b/i.test(said)) {
          now.effort = false;
          lessons.push(() => this.noEffort.add(model));
        } else if (include && /\binclude\b|encrypted_content/i.test(said)) {
          now.include = false;
          lessons.push(() => this.noInclude.add(model));
        } else if (overflows(err)) {
          // The exchange and the room asked for the reply do not fit the model's window together. A shorter
          // reply may fit: for this request only, since the next exchange may well be shorter.
          if (squeezed || now.cap <= SQUEEZED_CAP) throw new ProviderError('The work outgrew the model’s context window.', 'too_long', false);
          squeezed = true;
          now.cap = SQUEEZED_CAP;
        } else if (/max_output_tokens|(output|completion) tokens/i.test(said) && now.cap > 1024) {
          const lower = lowerCap(said, now.cap);
          now.cap = lower;
          if (!squeezed) lessons.push(() => this.cap.set(model, lower));
        } else {
          if (NOT_ABOUT_FORM.test(said)) throw unexplained ?? err;
          unexplained ??= err;
          if (!trials) {
            const sent: Optional[] = [];
            if (level) sent.push('effort');
            if (include) sent.push('include');
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

  /** Send one request and gather the reply from its stream: the finished response, as the last event carries it. */
  private async read(model: string, body: Record<string, unknown>, onUsage: ((usage: CallUsage) => void) | undefined, signal?: AbortSignal): Promise<Turn> {
    const stream = (await this.client.responses.create(body as unknown as OpenAI.Responses.ResponseCreateParamsStreaming, { signal })) as unknown as AsyncIterable<Record<string, unknown>>;
    let final: Record<string, unknown> | undefined;
    const finished: Item[] = [];
    // Without counts from the endpoint, the request is still charged for, at about four characters to a token.
    const sent = Math.ceil((JSON.stringify(body.input).length + String(body.instructions ?? '').length) / 4);
    // A response that breaks off once it has started was paid for as far as it got, and never says what that came
    // to: it is counted by the length of what had arrived. A call that was stopped on purpose is not counted.
    const lost = () => {
      if (!signal?.aborted) onUsage?.(this.cost(model, { prompt: sent, cached: 0, written: 0, output: Math.ceil(JSON.stringify(finished).length / 4), billed: null }));
    };
    for await (const event of whileItLasts(stream, lost)) {
      const type = event.type;
      if (type === 'response.output_item.done' && event.item && typeof event.item === 'object') finished.push(event.item as Item);
      else if (type === 'response.completed' || type === 'response.incomplete' || type === 'response.failed') final = event.response as Record<string, unknown>;
      else if (type === 'error') {
        lost();
        throw this.failure(String(event.code ?? ''), String(event.message ?? 'The reply was stopped by an error.'));
      }
    }
    if (!final) {
      lost();
      throw new ProviderError(`The connection to ${this.label} closed before the reply was complete.`, 'unavailable', true);
    }

    // The finished response lists everything produced. The items gathered along the way stand in if it does not.
    const items = Array.isArray(final.output) && final.output.length ? (final.output as Item[]) : finished;
    const failed = final.error as { code?: unknown; message?: unknown } | null | undefined;
    const broken = final.status === 'failed' || !!failed;

    // What the response cost is owed whatever became of it, so it is counted before anything is made of the reply.
    // A response that failed and reports no tokens is taken to have cost none.
    const usage = (final.usage ?? null) as { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } } | null;
    const spent = this.cost(model, {
      prompt: counted(usage?.input_tokens) ?? sent,
      cached: counted(usage?.input_tokens_details?.cached_tokens) ?? 0,
      written: counted(usage?.input_tokens_details?.cache_write_tokens) ?? 0,
      output: counted(usage?.output_tokens) ?? Math.ceil(JSON.stringify(items).length / 4),
      billed: null,
    });
    if (usage || !broken) onUsage?.(spent);

    if (broken) throw this.failure(String(failed?.code ?? ''), String(failed?.message ?? 'The response failed.'));
    const reason = (final.incomplete_details as { reason?: unknown } | null | undefined)?.reason;
    if (reason === 'content_filter') throw new ProviderError('The model declined this request.', 'refusal', false);

    let text = '';
    const calls: FunctionCall[] = [];
    for (const item of items) {
      if (item.type === 'message' && Array.isArray(item.content)) {
        for (const part of item.content as Array<Record<string, unknown>>) {
          if (part?.type === 'output_text' && typeof part.text === 'string') text += part.text;
          else if (part?.type === 'refusal') throw new ProviderError(`The model declined this request${typeof part.refusal === 'string' && part.refusal ? `: ${part.refusal}` : '.'}`, 'refusal', false);
        }
      } else if (item.type === 'function_call' && typeof item.name === 'string') {
        calls.push({ callId: String(item.call_id ?? item.id ?? ''), name: item.name, arguments: typeof item.arguments === 'string' && item.arguments ? item.arguments : '{}' });
      }
    }
    return { items, text, calls, cutOff: final.status === 'incomplete' };
  }

  /** A response that failed after it was accepted: what it means, by the code it carries. */
  private failure(code: string, message: string): ProviderError {
    if (refusesContent(code, message)) return new ProviderError(`The model declined this request: ${message}`, 'refusal', false);
    if (code === 'context_length_exceeded') return new ProviderError(`The work outgrew the model’s context window: ${message}`, 'too_long', false);
    if (/rate_limit/.test(code)) return new ProviderError(`${this.label} is rate limiting this key: ${message}`, 'rate_limit', true);
    if (code === '' || /server_error|overloaded|timeout|unavailable/.test(code)) return new ProviderError(`${this.label} failed part-way through a reply: ${message}`, 'unavailable', true);
    return new ProviderError(`${this.label} rejected the request: ${message}`, 'bad_request', false);
  }
}
