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
  lowerCap,
  runTool,
  safeParse,
  sleep,
  systemText,
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
  usage: CallUsage;
}

interface Shape {
  tools?: Item[];
  toolChoice?: 'none';
  format?: Item;
}

/** How many times one request is reshaped after the endpoint refuses something about its form. */
const MAX_ADAPTATIONS = 7;

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
        turn = await this.respond(req.model, asked(mode), instructions, { format: formatFor(mode) }, req.effort, STRUCTURED_MAX_TOKENS, req.signal);
        if (unexplained) this.structuredMode.set(req.model, modes.indexOf(mode));
        break;
      } catch (err) {
        const next = modes.indexOf(mode) + 1;
        if (err instanceof OpenAI.BadRequestError && formatFor(mode) && next < modes.length) {
          if (ABOUT_FORMAT.test(err.message)) this.structuredMode.set(req.model, next);
          else unexplained ??= err;
          mode = modes[next]!;
          continue;
        }
        throw this.translate(unexplained ?? err);
      }
    }
    req.onUsage?.(turn.usage);
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
        const second = await this.respond(req.model, repair, instructions, { format: formatFor(mode) }, req.effort, STRUCTURED_MAX_TOKENS, req.signal);
        req.onUsage?.(second.usage);
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
        turn = await this.respond(req.model, input, instructions, { tools, toolChoice: wrapUpSent ? 'none' : undefined }, req.effort, AGENT_MAX_TOKENS, req.signal);
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
      req.onUsage?.(turn.usage);

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
   * One request. When the endpoint refuses something about its form, the request is reshaped and sent again;
   * what is learned is kept for later requests, but only once a reshaped request has gone through.
   */
  private async respond(model: string, input: Item[], instructions: string, shape: Shape, effort: Effort, wanted: number, signal?: AbortSignal): Promise<Turn> {
    // After a refusal that does not say what it objects to, the request is tried without each optional thing:
    // one at a time, then both. What it went through without becomes a lesson; if nothing helps, nothing is learned.
    type Optional = 'effort' | 'include';
    let without = new Set<Optional>();
    let trials: Optional[][] | null = null;
    let unexplained: unknown;
    for (let adaptations = 0; ; adaptations++) {
      const cap = Math.min(wanted, this.cap.get(model) ?? this.options.maxOutputOf?.(model) ?? wanted);
      const level = this.noEffort.has(model) || without.has('effort') ? undefined : this.levelFor(model, effort);
      const include = !this.noInclude.has(model) && !without.has('include');
      const body: Record<string, unknown> = {
        model,
        instructions,
        input,
        max_output_tokens: cap,
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
        const turn = await this.read(model, body, signal);
        if (without.has('effort')) this.noEffort.add(model);
        if (without.has('include')) this.noInclude.add(model);
        return turn;
      } catch (err) {
        if (!(err instanceof OpenAI.BadRequestError)) throw err;
        if (adaptations >= MAX_ADAPTATIONS) throw unexplained ?? err;
        const said = err.message;
        // The way a structured answer is asked for is the caller's to change.
        if (shape.format && ABOUT_FORMAT.test(said)) throw err;
        if (level && /reasoning|effort/i.test(said)) this.noEffort.add(model);
        else if (include && /include|encrypted_content/i.test(said)) this.noInclude.add(model);
        else if (/max_output_tokens|maximum.{0,40}tokens|output tokens/i.test(said) && cap > 1024) this.cap.set(model, lowerCap(said, cap));
        else {
          if (NOT_ABOUT_FORM.test(said)) throw unexplained ?? err;
          unexplained ??= err;
          if (!trials) {
            const sent: Optional[] = [];
            if (level) sent.push('effort');
            if (include) sent.push('include');
            trials = sent.map((one) => [one]);
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
  private async read(model: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<Turn> {
    const stream = (await this.client.responses.create(body as unknown as OpenAI.Responses.ResponseCreateParamsStreaming, { signal })) as unknown as AsyncIterable<Record<string, unknown>>;
    let final: Record<string, unknown> | undefined;
    const finished: Item[] = [];
    for await (const event of stream) {
      const type = event.type;
      if (type === 'response.output_item.done' && event.item && typeof event.item === 'object') finished.push(event.item as Item);
      else if (type === 'response.completed' || type === 'response.incomplete' || type === 'response.failed') final = event.response as Record<string, unknown>;
      else if (type === 'error') throw this.failure(String(event.code ?? ''), String(event.message ?? 'The reply was stopped by an error.'));
    }
    if (!final) throw new ProviderError(`The connection to ${this.label} closed before the reply was complete.`, 'unavailable', true);

    const failed = final.error as { code?: unknown; message?: unknown } | null | undefined;
    if (final.status === 'failed' || failed) throw this.failure(String(failed?.code ?? ''), String(failed?.message ?? 'The response failed.'));
    const reason = (final.incomplete_details as { reason?: unknown } | null | undefined)?.reason;
    if (reason === 'content_filter') throw new ProviderError('The model declined this request.', 'refusal', false);

    // The finished response lists everything produced. The items gathered along the way stand in if it does not.
    const items = Array.isArray(final.output) && final.output.length ? (final.output as Item[]) : finished;
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

    const usage = (final.usage ?? null) as { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } } | null;
    return {
      items,
      text,
      calls,
      cutOff: final.status === 'incomplete' && reason !== 'content_filter',
      usage: this.cost(model, {
        // Without counts from the endpoint, the request is still charged for, at about four characters to a token.
        prompt: usage?.input_tokens ?? Math.ceil((JSON.stringify(body.input).length + String(body.instructions ?? '').length) / 4),
        cached: usage?.input_tokens_details?.cached_tokens ?? 0,
        written: usage?.input_tokens_details?.cache_write_tokens ?? 0,
        output: usage?.output_tokens ?? Math.ceil(JSON.stringify(items).length / 4),
        billed: null,
      }),
    };
  }

  /** A response that failed after it was accepted: what it means, by the code it carries. */
  private failure(code: string, message: string): ProviderError {
    if (/policy|safety|content_filter/.test(code)) return new ProviderError(`The model declined this request: ${message}`, 'refusal', false);
    if (/rate_limit/.test(code)) return new ProviderError(`${this.label} is rate limiting this key: ${message}`, 'rate_limit', true);
    if (code === '' || /server_error|overloaded|timeout|unavailable/.test(code)) return new ProviderError(`${this.label} failed part-way through a reply: ${message}`, 'unavailable', true);
    return new ProviderError(`${this.label} rejected the request: ${message}`, 'bad_request', false);
  }
}
