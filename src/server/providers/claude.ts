import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import type { ProviderInfo } from '../../shared/types';
import { DEFAULT_MODEL, MODELS, priceUsage, webSearchToolFor } from './pricing';
import {
  ProviderError,
  type AgentRequest,
  type AgentResult,
  type CallUsage,
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

export interface ClaudeProviderOptions {
  apiKey?: string;
  baseURL?: string;
  maxRetries?: number;
}

/** Runs the organisation on Claude through the Anthropic API. */
export class ClaudeProvider implements Provider {
  private readonly client: Anthropic;

  constructor(options: ClaudeProviderOptions = {}) {
    // With no key passed, the SDK resolves credentials from the environment
    // (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or an `ant auth login` profile).
    this.client = new Anthropic({ maxRetries: 4, ...options });
  }

  info(): ProviderInfo {
    return {
      id: 'claude',
      label: 'Claude',
      simulated: false,
      defaultModel: DEFAULT_MODEL,
      models: MODELS.map((m) => ({ id: m.id, label: m.label, inputPerMTok: m.input, outputPerMTok: m.output })),
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
      if (!(err instanceof Anthropic.BadRequestError) || this.plainSchemas) throw translate(err);
      try {
        message = await this.requestStructured(req, true);
        this.plainSchemas = true;
      } catch {
        throw translate(err);
      }
    }
    req.onUsage?.(usageOf(message, req.model));
    checkStop(message);
    if (message.stop_reason === 'max_tokens') {
      throw new ProviderError('The reply was cut off before it was complete.', 'truncated', true);
    }
    const text = message.content
      .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new ProviderError('The reply was not valid JSON.', 'invalid_output', true);
    }
    // The API enforces the shape; this also enforces whatever the schema could not express to it.
    const parsed = req.schema.safeParse(data);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new ProviderError(`The reply did not match the expected structure (${issue?.path.join('.')}: ${issue?.message}).`, 'invalid_output', true);
    }
    return parsed.data;
  }

  private requestStructured<T>(req: StructuredRequest<T>, plain: boolean): Promise<Anthropic.Beta.BetaMessage> {
    return this.client.beta.messages
      .stream(
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
      )
      .finalMessage();
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
    if (req.webSearch) tools.push({ type: webSearchToolFor(req.model), name: 'web_search', max_uses: req.webSearch.maxUses });

    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: req.prompt }];
    let turns = 0;
    let pauses = 0;
    let badJson = 0;
    let wrapUpSent = false;

    for (;;) {
      if (req.shouldStop?.()) return { text: '', turns, stopped: 'interrupted' };

      let message;
      try {
        message = await this.client.beta.messages
          .stream(
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
          )
          .finalMessage();
        badJson = 0;
      } catch (err) {
        if (err instanceof Anthropic.APIError || req.signal?.aborted) throw translate(err);
        // With eager input streaming, a tool input that is not parseable JSON
        // rejects here. The turn was never added to the history, so re-issue it.
        if (++badJson > 2) {
          throw new ProviderError(`The agent’s tool call could not be read: ${(err as Error).message}`, 'invalid_output', false);
        }
        continue;
      }
      turns += 1;
      req.onUsage?.(usageOf(message, req.model));
      checkStop(message);

      if (message.stop_reason === 'pause_turn') {
        // A server-side tool (web search) hit its iteration limit; sending the turn back resumes it.
        if (++pauses > MAX_PAUSE_RESUMES) throw new ProviderError('The agent kept pausing on a server-side tool.', 'unavailable', true);
        messages.push({ role: 'assistant', content: message.content });
        continue;
      }

      const text = message.content
        .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim();
      const calls = message.content.filter((block): block is Anthropic.Beta.BetaToolUseBlock => block.type === 'tool_use');
      if (!calls.length) return { text, turns, stopped: wrapUpSent ? 'max_turns' : 'done' };

      // A tool input cut off at the token limit can still parse as a smaller valid object, so never run it.
      if (message.stop_reason === 'max_tokens') {
        throw new ProviderError('A tool call was cut off before it was complete.', 'truncated', true);
      }
      if (wrapUpSent) return { text, turns, stopped: 'max_turns' };

      messages.push({ role: 'assistant', content: message.content });
      const results: Anthropic.Beta.BetaContentBlockParam[] = [];
      for (const call of calls) {
        results.push(await runTool(req, call));
      }
      if (turns >= req.maxTurns) {
        wrapUpSent = true;
        results.push({
          type: 'text',
          text: 'You have reached your turn limit. Do not call any more tools. Give your closing report now, and say what is left unfinished.',
        });
      }
      messages.push({ role: 'user', content: results });
    }
  }
}

// JSON Schema keywords that structured outputs do not accept. Zod adds numeric bounds to every integer.
const UNSUPPORTED_KEYWORDS = new Set([
  '$schema',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'minItems',
  'maxItems',
  'uniqueItems',
  'default',
]);

type JsonSchema = Record<string, unknown>;

/** The schema as structured outputs take it: unsupported keywords removed, objects closed, enums kept. */
function strictSchema(node: JsonSchema): JsonSchema {
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(node)) {
    if (UNSUPPORTED_KEYWORDS.has(key)) continue;
    if (key === 'properties' || key === '$defs') {
      // The keys here are property names, not keywords, so none of them is dropped.
      out[key] = Object.fromEntries(Object.entries(value as Record<string, JsonSchema>).map(([name, sub]) => [name, strictSchema(sub)]));
    } else if (key === 'items') {
      out[key] = strictSchema(value as JsonSchema);
    } else if (key === 'anyOf' || key === 'allOf' || key === 'oneOf') {
      out[key === 'oneOf' ? 'anyOf' : key] = (value as JsonSchema[]).map(strictSchema);
    } else {
      out[key] = value;
    }
  }
  if (out.type === 'object') out.additionalProperties = false;
  return out;
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
    throw new ProviderError('The conversation outgrew the model’s context window.', 'bad_request', false);
  }
}

function usageOf(message: Anthropic.Beta.BetaMessage, requested: string): CallUsage {
  const usage = message.usage;
  return priceUsage({
    // If a fallback model served the request, price it as that model.
    model: message.model || requested,
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
    webSearches: usage.server_tool_use?.web_search_requests ?? 0,
  });
}

/** Map the SDK's typed errors onto what the engine needs to know: what happened and whether retrying can help. */
function translate(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof Anthropic.APIUserAbortError) return new ProviderError('The call was interrupted.', 'aborted', false);
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new ProviderError(`Anthropic rejected the credentials: ${err.message}`, 'auth', false);
  }
  if (err instanceof Anthropic.RateLimitError) return new ProviderError(`Rate limited: ${err.message}`, 'rate_limit', true);
  if (err instanceof Anthropic.BadRequestError || err instanceof Anthropic.NotFoundError || err instanceof Anthropic.UnprocessableEntityError) {
    return new ProviderError(`Anthropic rejected the request: ${err.message}`, 'bad_request', false);
  }
  if (err instanceof Anthropic.APIConnectionError) return new ProviderError(`Could not reach Anthropic: ${err.message}`, 'unavailable', true);
  if (err instanceof Anthropic.APIError) {
    const retryable = err.status === undefined || err.status >= 500 || err.status === 408 || err.status === 409;
    return new ProviderError(`Anthropic API error${err.status ? ` ${err.status}` : ''}: ${err.message}`, retryable ? 'unavailable' : 'bad_request', retryable);
  }
  // Anything else was raised before a response arrived, e.g. no credentials could be resolved.
  return new ProviderError(err instanceof Error ? err.message : String(err), 'bad_request', false);
}
