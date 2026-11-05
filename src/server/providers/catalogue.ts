import type { Effort } from '../../shared/types';

// The model makers this project knows how to reach, what their APIs expect,
// and list prices for the models most people will pick. A key's own list of
// models comes live from the provider; this file adds what a listing does not
// say: which models are the ones to reach for, what they cost, and how each
// provider's API differs from the others'.
//
// Everything here was read from the providers' own documentation on the date
// in PRICES_CHECKED. None of it has been tried against a live API from this
// project: no key for any of these providers was to hand when it was written.
//
// Prices are list prices in US dollars per million tokens. They are what
// spend estimates and budgets are worked out from, so a wrong price means a
// wrong budget: check the provider's pricing page before relying on them, and
// correct a price for your own account under "Models and keys".

/** The day the prices and API particulars below were read from the providers' pages. */
export const PRICES_CHECKED = '2026-11-05';

/** USD per million tokens. */
export interface Price {
  input: number;
  output: number;
  /** Input read from the provider's prompt cache, where it is priced apart. */
  cached?: number;
  /** Input written to the provider's prompt cache, where that costs more than plain input. */
  cacheWrite?: number;
  /** Rates for a whole request whose prompt is longer than `above` tokens, where a provider charges more for long prompts. */
  long?: { above: number; input: number; output: number; cached?: number; cacheWrite?: number };
}

export interface CatalogueModel extends Price {
  /** The id as the provider's API takes it. */
  id: string;
  label: string;
  /** flagship: the maker's strongest. balanced: most of that for less. fast: the cheap, quick one. */
  tier: 'flagship' | 'balanced' | 'fast';
  /** The model a new organisation starts on when this provider's key is the first one connected. The first listed if none is marked. */
  starter?: boolean;
  contextWindow?: number;
  /** The most output tokens one reply may have. */
  maxOutput?: number;
  /** The regions (by id) whose platform has this model, where a provider's platforms differ. On every platform if absent. */
  only?: string[];
  /** The reasoning effort levels this model takes, where they are not the provider's usual ones. Null if it takes none. */
  efforts?: string[] | null;
  /** A change of list price the provider has announced: from that day (UTC), these rates. */
  next?: Price & { from: string };
  note?: string;
}

/** How an OpenAI-compatible endpoint differs from the others in what it accepts. */
export interface Dialect {
  /** What the parameter that caps output is called. */
  maxTokensParam: 'max_tokens' | 'max_completion_tokens';
  /**
   * Ways of asking for structured output, best first. json_schema: the endpoint holds the reply to a schema.
   * json_object: it promises JSON, and the schema is stated in the prompt. prompt: it promises nothing.
   * The provider falls down the list if the endpoint refuses one.
   */
  structured: Array<'json_schema' | 'json_object' | 'prompt'>;
  /**
   * The reasoning effort levels the endpoint's models usually take, or null if nothing should be sent. An
   * organisation's effort setting is sent as the nearest of them. A model can have its own in the catalogue, and
   * a provider's listing can say what each model takes; either stands over this.
   */
  efforts: string[] | null;
  /** Whether a reply's reasoning text must be sent back with the tool calls it led to, within one agent run. */
  echoReasoning: boolean;
  /**
   * Other fields of a reply's message that go back with it as they came, such as reasoning the endpoint has
   * signed or encrypted. They are not read, only returned.
   */
  echoFields?: string[];
  /** False where `tool_choice` takes nothing but "auto", so a closing turn cannot have its tools switched off. */
  toolChoiceNone?: boolean;
  /** Whether `stream_options: {include_usage: true}` is accepted, which is how a streamed reply reports its tokens. */
  streamUsage: boolean;
  /** Fields to add to every request body. */
  extraBody?: Record<string, unknown>;
  /**
   * What to put on a turn's first tool call when the endpoint sent nothing of its own with it, for an endpoint
   * that refuses a tool call returned without what it attached.
   */
  firstCallFallback?: Record<string, unknown>;
}

export interface Preset {
  id: string;
  /** The provider's name, as on its own site. */
  label: string;
  /** The model family people know it by, where that differs from the provider's name. */
  family?: string;
  /**
   * anthropic: Claude's own API. responses: OpenAI's Responses API. openai: any endpoint that speaks OpenAI's
   * Chat Completions, which is most of them.
   */
  kind: 'anthropic' | 'responses' | 'openai';
  /** Where the API is. Providers with separate international and mainland-China platforms list both; the first is the default. */
  regions: Array<{ id: string; label: string; baseURL: string }>;
  /** Environment variables a key is read from, first one set wins. */
  env: string[];
  /** Where a person gets a key. */
  keysUrl: string;
  /** Something a person adding a key should know. */
  note?: string;
  dialect: Dialect;
  models: CatalogueModel[];
  /** The pages the prices and particulars were read from. */
  sources: string[];
}

/** What an endpoint is assumed to accept when nothing better is known: the most widely supported form of everything. */
export const PLAIN_DIALECT: Dialect = {
  maxTokensParam: 'max_tokens',
  structured: ['json_object', 'prompt'],
  efforts: null,
  echoReasoning: false,
  streamUsage: true,
};

/**
 * Yuan to the dollar, for the few models that have a list price only in yuan. It is the rate Alibaba's own
 * paired price lists imply (¥12 beside $1.65 for the same model in the same region).
 */
const YUAN_PER_DOLLAR = 7.27;
const yuan = (amount: number) => Math.round((amount / YUAN_PER_DOLLAR) * 1000) / 1000;

const MILLION = 1_000_000;

export const PRESETS: Preset[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    family: 'Claude',
    kind: 'anthropic',
    regions: [{ id: 'default', label: 'api.anthropic.com', baseURL: 'https://api.anthropic.com' }],
    env: ['ANTHROPIC_API_KEY'],
    keysUrl: 'https://platform.claude.com/settings/keys',
    note: 'The only provider whose models can carry plans out in hosted sessions, and whose agents can search the web here.',
    dialect: PLAIN_DIALECT,
    // Claude's models and prices are in pricing.ts, with the rest of what the Claude provider needs to know about them.
    models: [],
    sources: ['https://platform.claude.com/docs/en/about-claude/pricing'],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    family: 'GPT',
    kind: 'responses',
    regions: [{ id: 'default', label: 'api.openai.com', baseURL: 'https://api.openai.com/v1' }],
    env: ['OPENAI_API_KEY'],
    keysUrl: 'https://platform.openai.com/api-keys',
    note: 'Called through the Responses API, which OpenAI’s current models need before they will call tools. A key lists every model on the account, so the ones not picked out include older models and some that are not for chat.',
    dialect: { maxTokensParam: 'max_completion_tokens', structured: ['json_schema', 'json_object', 'prompt'], efforts: ['low', 'medium', 'high'], echoReasoning: false, streamUsage: true },
    models: [
      {
        id: 'gpt-6-astra',
        label: 'GPT-6 Astra',
        tier: 'flagship',
        input: 10,
        cached: 1,
        cacheWrite: 12.5,
        output: 50,
        long: { above: 272_000, input: 20, cached: 2, cacheWrite: 25, output: 75 },
        contextWindow: 1_050_000,
        maxOutput: 128_000,
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      },
      {
        id: 'gpt-6.1-sol',
        label: 'GPT-6.1 Sol',
        tier: 'balanced',
        starter: true,
        input: 2,
        cached: 0.1,
        cacheWrite: 2.5,
        output: 10,
        long: { above: 272_000, input: 4, cached: 0.2, cacheWrite: 5, output: 15 },
        contextWindow: 1_050_000,
        maxOutput: 128_000,
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      },
      {
        id: 'gpt-6.1-terra',
        label: 'GPT-6.1 Terra',
        tier: 'fast',
        input: 1,
        cached: 0.05,
        cacheWrite: 1.25,
        output: 5,
        long: { above: 272_000, input: 2, cached: 0.1, cacheWrite: 2.5, output: 7.5 },
        contextWindow: 1_050_000,
        maxOutput: 128_000,
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      },
      {
        id: 'gpt-6-luna',
        label: 'GPT-6 Luna',
        tier: 'fast',
        input: 0.1,
        cached: 0.01,
        cacheWrite: 0.125,
        output: 0.5,
        long: { above: 272_000, input: 0.2, cached: 0.02, cacheWrite: 0.25, output: 0.75 },
        contextWindow: 1_050_000,
        maxOutput: 128_000,
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      },
    ],
    sources: ['https://developers.openai.com/api/docs/pricing', 'https://developers.openai.com/api/docs/models', 'https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6-astra'],
  },
  {
    id: 'google',
    label: 'Google',
    family: 'Gemini',
    kind: 'openai',
    regions: [{ id: 'default', label: 'Gemini API', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai' }],
    env: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    keysUrl: 'https://aistudio.google.com/apikey',
    note: 'A key from Google AI Studio, used through the Gemini API’s OpenAI-compatible endpoint, which Google still calls a beta. Gemini 4 Argon needs a paid tier. Gemini 4 Carbon is not on the public API.',
    dialect: {
      maxTokensParam: 'max_completion_tokens',
      structured: ['json_schema', 'json_object', 'prompt'],
      efforts: ['low', 'medium', 'high'],
      echoReasoning: false,
      // Gemini signs its thinking and wants the signature back with the tool call it came on. It arrives on the
      // call itself, which is returned as it came; this covers an endpoint that puts it on the message instead.
      echoFields: ['extra_content'],
      streamUsage: true,
      // A tool call returned with no signature at all is refused outright. Google documents this value as one
      // that passes the check; it costs the model its train of thought, which is better than the run failing.
      firstCallFallback: { extra_content: { google: { thought_signature: 'skip_thought_signature_validator' } } },
    },
    models: [
      {
        id: 'gemini-4-argon',
        label: 'Gemini 4 Argon',
        tier: 'flagship',
        input: 2,
        cached: 0.1,
        output: 10,
        next: { from: '2026-12-01', input: 4, cached: 0.2, output: 20 },
        contextWindow: 1_048_576,
        maxOutput: 65_536,
        note: 'An introductory price until 30 November 2026; $4 in and $20 out from 1 December.',
      },
      {
        id: 'gemini-3.8-flash',
        label: 'Gemini 3.8 Flash',
        tier: 'balanced',
        input: 0.75,
        cached: 0.075,
        output: 3.75,
        next: { from: '2027-01-01', input: 1.5, cached: 0.15, output: 7.5 },
        contextWindow: 1_048_576,
        maxOutput: 65_536,
        note: 'An introductory price until 31 December 2026; $1.50 in and $7.50 out from 1 January.',
      },
      {
        id: 'gemini-3.5-flash-lite',
        label: 'Gemini 3.5 Flash-Lite',
        tier: 'fast',
        input: 0.3,
        cached: 0.03,
        output: 2.5,
        contextWindow: 1_048_576,
        maxOutput: 65_536,
        efforts: ['minimal', 'low', 'medium', 'high'],
      },
    ],
    sources: ['https://ai.google.dev/gemini-api/docs/pricing', 'https://ai.google.dev/gemini-api/docs/models', 'https://ai.google.dev/gemini-api/docs/openai', 'https://ai.google.dev/gemini-api/docs/thought-signatures'],
  },
  {
    id: 'meta',
    label: 'Meta',
    family: 'Muse',
    kind: 'openai',
    regions: [{ id: 'default', label: 'api.meta.ai', baseURL: 'https://api.meta.ai/v1' }],
    env: ['META_API_KEY'],
    keysUrl: 'https://dev.meta.ai/docs/authentication',
    note: 'The Meta Model API. Whether it can be used depends on your country. Muse Wonder is a preview; the stronger Muse Wonder Full has no API.',
    dialect: {
      maxTokensParam: 'max_completion_tokens',
      structured: ['json_schema', 'json_object', 'prompt'],
      efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],
      echoReasoning: false,
      toolChoiceNone: false,
      streamUsage: true,
    },
    models: [
      {
        id: 'muse-wonder-1.0',
        label: 'Muse Wonder (preview)',
        tier: 'flagship',
        input: 4,
        cached: 0.2,
        output: 20,
        contextWindow: 1_048_576,
        efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      },
      {
        id: 'muse-spark-1.3',
        label: 'Muse Spark 1.3',
        tier: 'balanced',
        starter: true,
        input: 1.25,
        cached: 0.15,
        output: 4.25,
        contextWindow: 1_048_576,
        maxOutput: 131_072,
        efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      },
    ],
    sources: ['https://dev.meta.ai/docs/pricing-rate-limits', 'https://dev.meta.ai/docs/models', 'https://dev.meta.ai/docs/protocols/chat-completions'],
  },
  {
    id: 'moonshot',
    label: 'Moonshot AI',
    family: 'Kimi',
    kind: 'openai',
    regions: [
      { id: 'intl', label: 'International (platform.kimi.ai)', baseURL: 'https://api.moonshot.ai/v1' },
      { id: 'cn', label: 'Mainland China (platform.kimi.com)', baseURL: 'https://api.moonshot.cn/v1' },
    ],
    env: ['MOONSHOT_API_KEY'],
    keysUrl: 'https://platform.kimi.ai/',
    note: 'The two platforms have separate accounts and keys. Until an account has topped up $10 in all, Kimi allows one call at a time and three a minute: set “Model calls in flight at once” to 1 in an organisation’s settings, or expect it to wait.',
    dialect: { maxTokensParam: 'max_completion_tokens', structured: ['json_schema', 'json_object', 'prompt'], efforts: ['low', 'high', 'max'], echoReasoning: true, streamUsage: true },
    models: [
      { id: 'kimi-k3.1-pro', label: 'Kimi K3.1 Pro', tier: 'flagship', input: 2, cached: 0.2, output: 10, contextWindow: 1_048_576, maxOutput: 131_072 },
      {
        id: 'kimi-k3.1-pro-highspeed',
        label: 'Kimi K3.1 Pro Highspeed',
        tier: 'fast',
        input: 4,
        cached: 0.2,
        output: 20,
        contextWindow: 1_048_576,
        maxOutput: 131_072,
        note: 'The same model, two to three times as fast, at twice the price.',
      },
    ],
    sources: ['https://platform.kimi.ai/docs/pricing/chat', 'https://platform.kimi.ai/docs/models', 'https://platform.kimi.ai/docs/guide/use-thinking-models', 'https://platform.kimi.ai/docs/pricing/limits'],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    kind: 'openai',
    regions: [{ id: 'default', label: 'api.deepseek.com', baseURL: 'https://api.deepseek.com' }],
    env: ['DEEPSEEK_API_KEY'],
    keysUrl: 'https://platform.deepseek.com/api_keys',
    note: 'The prices here are the peak-hours rates. DeepSeek charges half outside 01:00 to 04:00 and 06:00 to 10:00 UTC on weekdays, so spend at other times is counted at twice what is billed.',
    dialect: { maxTokensParam: 'max_tokens', structured: ['json_object', 'prompt'], efforts: ['low', 'high', 'max'], echoReasoning: true, streamUsage: true },
    models: [
      {
        id: 'deepseek-flash',
        label: 'DeepSeek V4.1 Flash',
        tier: 'flagship',
        input: 0.3,
        cached: 0.006,
        output: 1.2,
        contextWindow: MILLION,
        maxOutput: 393_216,
        note: 'DeepSeek’s strongest model and its cheapest. The id moves on to each new Flash release.',
      },
      {
        id: 'deepseek-v4-pro',
        label: 'DeepSeek V4 Pro',
        tier: 'balanced',
        input: 1.32,
        cached: 0.044,
        output: 3.96,
        contextWindow: MILLION,
        maxOutput: 393_216,
        note: 'The older model. It scores below V4.1 Flash on current benchmarks.',
      },
    ],
    sources: ['https://api-docs.deepseek.com/quick_start/pricing', 'https://api-docs.deepseek.com/guides/thinking_mode', 'https://api-docs.deepseek.com/api/create-chat-completion'],
  },
  {
    id: 'alibaba',
    label: 'Alibaba Cloud Model Studio',
    family: 'Qwen',
    kind: 'openai',
    regions: [
      { id: 'intl', label: 'International (Singapore)', baseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' },
      { id: 'cn', label: 'Mainland China (Beijing)', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
      { id: 'us', label: 'United States (Virginia)', baseURL: 'https://dashscope-us.aliyuncs.com/compatible-mode/v1' },
      { id: 'hk', label: 'Hong Kong', baseURL: 'https://cn-hongkong.dashscope.aliyuncs.com/compatible-mode/v1' },
    ],
    env: ['DASHSCOPE_API_KEY'],
    keysUrl: 'https://www.alibabacloud.com/help/en/model-studio/get-api-key',
    note: 'Each region has its own keys and its own prices; the prices here are Singapore’s, and the others are lower. Alibaba now recommends a workspace address of the form https://{WorkspaceId}.{region}.maas.aliyuncs.com/compatible-mode/v1, which can be given under “Use a different address”.',
    // Qwen takes a JSON schema in some regions and not in Singapore, so plain JSON is asked for everywhere.
    dialect: { maxTokensParam: 'max_completion_tokens', structured: ['json_object', 'prompt'], efforts: null, echoReasoning: true, streamUsage: true },
    models: [
      { id: 'qwen3.8-max', label: 'Qwen3.8 Max', tier: 'flagship', input: 2, output: 6, contextWindow: MILLION, maxOutput: 128_000, efforts: ['low', 'medium', 'xhigh'] },
      {
        id: 'qwen3.7-plus',
        label: 'Qwen3.7 Plus',
        tier: 'balanced',
        input: 0.4,
        output: 1.6,
        long: { above: 256_000, input: 1.2, output: 4.8 },
        contextWindow: MILLION,
        maxOutput: 128_000,
      },
      { id: 'qwen3.8-flash', label: 'Qwen3.8 Flash', tier: 'fast', input: 0.15, output: 0.47, contextWindow: MILLION, maxOutput: 128_000, efforts: ['low', 'medium', 'xhigh'] },
    ],
    sources: [
      'https://www.alibabacloud.com/help/en/model-studio/model-pricing',
      'https://www.alibabacloud.com/help/en/model-studio/base-url',
      'https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-chat-completions',
      'https://www.alibabacloud.com/help/en/model-studio/qwen-structured-output',
    ],
  },
  {
    id: 'zhipu',
    label: 'Z.ai (Zhipu AI)',
    family: 'GLM',
    kind: 'openai',
    regions: [
      { id: 'intl', label: 'International (Z.ai)', baseURL: 'https://api.z.ai/api/paas/v4' },
      { id: 'cn', label: 'Mainland China (BigModel)', baseURL: 'https://open.bigmodel.cn/api/paas/v4' },
    ],
    env: ['ZAI_API_KEY', 'ZHIPUAI_API_KEY'],
    keysUrl: 'https://docs.z.ai/api-reference/introduction',
    note: 'A pay-as-you-go API key. A GLM Coding Plan key is for coding tools only and will not work here. Prices are Z.ai’s, in dollars; BigModel’s, in yuan, are lower.',
    dialect: { maxTokensParam: 'max_tokens', structured: ['json_object', 'prompt'], efforts: ['low', 'high', 'max'], echoReasoning: true, toolChoiceNone: false, streamUsage: false },
    models: [
      { id: 'glm-5.3', label: 'GLM-5.3', tier: 'flagship', input: 1.4, cached: 0.26, output: 4.4, contextWindow: MILLION, maxOutput: 128_000 },
      { id: 'glm-5.3-flash', label: 'GLM-5.3 Flash', tier: 'fast', input: 0.15, cached: 0.03, output: 0.5, contextWindow: MILLION, maxOutput: 128_000 },
    ],
    sources: ['https://docs.z.ai/guides/overview/pricing', 'https://docs.z.ai/api-reference/llm/chat-completion', 'https://docs.z.ai/guides/capabilities/thinking-mode'],
  },
  {
    id: 'tencent',
    label: 'Tencent Cloud TokenHub',
    family: 'Hunyuan',
    kind: 'openai',
    regions: [
      { id: 'intl', label: 'International (Singapore)', baseURL: 'https://tokenhub-intl.tencentcloudmaas.com/v1' },
      { id: 'cn', label: 'Mainland China (Guangzhou)', baseURL: 'https://tokenhub.tencentcloudmaas.com/v1' },
      { id: 'us', label: 'United States (Silicon Valley)', baseURL: 'https://tokenhub-us.tencentcloudmaas.tech/v1' },
    ],
    env: ['TOKENHUB_API_KEY', 'HUNYUAN_API_KEY'],
    keysUrl: 'https://www.tencentcloud.com/document/product/1300/78934',
    note: 'A key works in the region it was made in and no other. Tencent lists Hy4 at half price until 31 December 2026; spend is counted at the full list price.',
    dialect: { maxTokensParam: 'max_completion_tokens', structured: ['json_schema', 'json_object', 'prompt'], efforts: null, echoReasoning: true, streamUsage: true },
    models: [
      { id: 'hy4', label: 'Hy4', tier: 'flagship', input: 0.834, cached: 0.042, output: 2.501, contextWindow: MILLION, maxOutput: 64_000 },
      { id: 'hy3', label: 'Hy3', tier: 'fast', input: 0.132, cached: 0.033, output: 0.528, contextWindow: 256_000, maxOutput: 128_000 },
    ],
    sources: ['https://www.tencentcloud.com/document/product/1300/78937', 'https://www.tencentcloud.com/document/product/1300/78934', 'https://www.tencentcloud.com/document/product/1300/82345'],
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    kind: 'openai',
    regions: [
      { id: 'intl', label: 'International (minimax.io)', baseURL: 'https://api.minimax.io/v1' },
      { id: 'cn', label: 'Mainland China (minimax.cn)', baseURL: 'https://api.minimax.cn/v1' },
    ],
    env: ['MINIMAX_API_KEY'],
    keysUrl: 'https://platform.minimax.io/docs/guides/text-generation',
    note: 'A pay-as-you-go API key, from the platform whose region you choose here. An M Plan subscription key will not work.',
    dialect: {
      maxTokensParam: 'max_completion_tokens',
      // MiniMax documents no JSON mode for this endpoint, so the answer is asked for in words and checked.
      structured: ['prompt'],
      efforts: null,
      echoReasoning: true,
      toolChoiceNone: false,
      streamUsage: true,
      // Without this the older model puts its thinking inside the reply, in tags, where JSON is looked for.
      extraBody: { reasoning_split: true },
    },
    models: [
      {
        id: 'MiniMax-M3.1-Flash',
        label: 'MiniMax M3.1 Flash',
        tier: 'flagship',
        input: 0.15,
        cached: 0.015,
        output: 0.6,
        contextWindow: MILLION,
        maxOutput: 131_072,
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      },
      {
        id: 'MiniMax-M3',
        label: 'MiniMax M3',
        tier: 'balanced',
        input: 0.3,
        cached: 0.06,
        output: 1.2,
        long: { above: 512_000, input: 0.6, cached: 0.12, output: 2.4 },
        contextWindow: MILLION,
        maxOutput: 131_072,
        note: 'The older model. It scores below M3.1 Flash on current benchmarks.',
      },
    ],
    sources: ['https://platform.minimax.io/docs/pricing/overview', 'https://platform.minimax.io/docs/api-reference/text-openai-api', 'https://platform.minimax.io/docs/guides/text-m3-function-call'],
  },
  {
    id: 'bytedance',
    label: 'ByteDance',
    family: 'Doubao / Seed',
    kind: 'openai',
    regions: [
      { id: 'intl', label: 'International (BytePlus ModelArk)', baseURL: 'https://ark.ap-southeast.bytepluses.com/api/v3' },
      { id: 'cn', label: 'Mainland China (Volcano Engine Ark)', baseURL: 'https://ark.cn-beijing.volces.com/api/v3' },
    ],
    env: ['ARK_API_KEY'],
    keysUrl: 'https://docs.byteplus.com/en/docs/ModelArk/1330310',
    note: 'A model has to be switched on in the console before a key can call it. The two platforms carry different models: the newest, Seed 2.1 Pro and Lite, are on the mainland platform only, priced in yuan and shown here converted at ¥7.27 to the dollar. BytePlus is not offered in the United States.',
    dialect: {
      maxTokensParam: 'max_tokens',
      structured: ['json_schema', 'json_object', 'prompt'],
      efforts: ['low', 'medium', 'high'],
      echoReasoning: true,
      // The newer models encrypt their reasoning and want it back whole with the tool calls it led to.
      echoFields: ['encrypted_content'],
      streamUsage: true,
    },
    models: [
      { id: 'dola-seed-2-1-turbo-260628', label: 'Seed 2.1 Turbo', tier: 'flagship', only: ['intl'], input: 0.5, cached: 0.1, output: 2.5, contextWindow: 256_000 },
      {
        id: 'seed-2-0-pro-260328',
        label: 'Seed 2.0 Pro',
        tier: 'balanced',
        only: ['intl'],
        input: 0.5,
        cached: 0.1,
        output: 3,
        long: { above: 128_000, input: 1, cached: 0.2, output: 6 },
        contextWindow: 256_000,
      },
      { id: 'seed-2-0-mini-260428', label: 'Seed 2.0 Mini', tier: 'fast', only: ['intl'], input: 0.1, cached: 0.02, output: 0.4, contextWindow: 256_000 },
      { id: 'doubao-seed-2-1-pro-260915', label: 'Doubao Seed 2.1 Pro', tier: 'flagship', only: ['cn'], input: yuan(6), cached: yuan(1.2), output: yuan(30), contextWindow: 1_024_000, note: '¥6 in and ¥30 out.' },
      {
        id: 'doubao-seed-2-1-turbo-260628',
        label: 'Doubao Seed 2.1 Turbo',
        tier: 'balanced',
        only: ['cn'],
        input: yuan(3),
        cached: yuan(0.6),
        output: yuan(15),
        contextWindow: 256_000,
        note: '¥3 in and ¥15 out.',
      },
      {
        id: 'doubao-seed-2-1-lite-260915',
        label: 'Doubao Seed 2.1 Lite',
        tier: 'fast',
        only: ['cn'],
        input: yuan(0.8),
        cached: yuan(0.16),
        output: yuan(2.7),
        contextWindow: 1_024_000,
        note: '¥0.80 in and ¥2.70 out.',
      },
    ],
    sources: [
      'https://docs.byteplus.com/en/docs/modelark/model-pricing',
      'https://docs.byteplus.com/en/docs/modelark/chat-api',
      'https://docs.byteplus.com/en/docs/modelark/agent-model-invocation-practice',
      'https://docs.volcengine.com/docs/82379/1544106',
    ],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    kind: 'openai',
    regions: [{ id: 'default', label: 'openrouter.ai', baseURL: 'https://openrouter.ai/api/v1' }],
    env: ['OPENROUTER_API_KEY'],
    keysUrl: 'https://openrouter.ai/settings/keys',
    note: 'One key for several hundred models from every maker, including those with no entry of their own here (Mistral, Xiaomi, Baidu and others). OpenRouter says what each call cost, and that figure is what counts against the budget.',
    dialect: {
      maxTokensParam: 'max_tokens',
      structured: ['json_schema', 'json_object', 'prompt'],
      // The listing says which effort levels each model takes; nothing is sent to a model it is silent about.
      efforts: null,
      echoReasoning: false,
      // Whatever form a model's reasoning takes, OpenRouter returns it here and wants it back unchanged.
      echoFields: ['reasoning_details'],
      streamUsage: false,
    },
    // Prices come from OpenRouter's own listing when it can be read. These are for when it cannot.
    models: [
      { id: 'anthropic/claude-opus-5.5', label: 'Claude Opus 5.5', tier: 'flagship', input: 4, cached: 0.2, cacheWrite: 5, output: 20 },
      { id: 'openai/gpt-6-astra', label: 'GPT-6 Astra', tier: 'flagship', input: 10, cached: 1, output: 50, long: { above: 272_000, input: 20, cached: 2, output: 75 } },
      { id: 'google/gemini-4-argon', label: 'Gemini 4 Argon', tier: 'flagship', input: 2, cached: 0.1, output: 10, next: { from: '2026-12-01', input: 4, cached: 0.2, output: 20 } },
      { id: 'openai/gpt-6.1-sol', label: 'GPT-6.1 Sol', tier: 'balanced', input: 2, cached: 0.1, output: 10, long: { above: 272_000, input: 4, cached: 0.2, output: 15 } },
      { id: 'moonshotai/kimi-k3.1-pro', label: 'Kimi K3.1 Pro', tier: 'balanced', input: 2, cached: 0.2, output: 10 },
      { id: 'meta/muse-wonder', label: 'Muse Wonder', tier: 'balanced', input: 4, cached: 0.2, output: 20 },
      { id: 'qwen/qwen3.8-max-0902', label: 'Qwen3.8 Max', tier: 'balanced', input: 2, cached: 0.25, output: 6 },
      { id: 'deepseek/deepseek-v4.1-flash-1017', label: 'DeepSeek V4.1 Flash', tier: 'fast', input: 0.3, cached: 0.006, output: 1.2 },
      { id: 'z-ai/glm-5.3-flash', label: 'GLM-5.3 Flash', tier: 'fast', input: 0.15, cached: 0.03, output: 0.5 },
    ],
    sources: ['https://openrouter.ai/api/v1/models', 'https://openrouter.ai/docs/cookbook/administration/usage-accounting', 'https://openrouter.ai/docs/guides/best-practices/reasoning-tokens'],
  },
  {
    id: 'custom',
    label: 'Another OpenAI-compatible endpoint',
    kind: 'openai',
    regions: [{ id: 'custom', label: 'Your own address', baseURL: '' }],
    env: [],
    keysUrl: '',
    note: 'Any server that speaks OpenAI’s Chat Completions, including one on this machine (llama.cpp’s llama-server, LM Studio, Ollama, vLLM). Give its address, ending in /v1 for most servers. A local server needs no key.',
    dialect: PLAIN_DIALECT,
    models: [],
    sources: [],
  },
];

export function presetById(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}

/** The rates a catalogue model is charged at on a given day: its listed ones, or those of an announced change once its day has come. */
export function ratesOn(model: CatalogueModel, now: Date = new Date()): Price {
  const { next } = model;
  const source: Price = next && now.getTime() >= Date.parse(`${next.from}T00:00:00Z`) ? next : model;
  return {
    input: source.input,
    output: source.output,
    ...(source.cached !== undefined ? { cached: source.cached } : {}),
    ...(source.cacheWrite !== undefined ? { cacheWrite: source.cacheWrite } : {}),
    ...(source.long ? { long: source.long } : {}),
  };
}

const EFFORT_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * The effort level an endpoint takes that is nearest the one asked for, and the stronger of two equally near.
 * Never "none": thinking is not switched off by a rounding.
 */
export function nearestEffort(wanted: Effort, levels: readonly string[] | null | undefined): string | undefined {
  if (!levels) return undefined;
  const at = EFFORT_ORDER.indexOf(wanted);
  let best = -1;
  for (const level of levels) {
    const i = EFFORT_ORDER.indexOf(level);
    if (i < 0) continue;
    if (best < 0 || Math.abs(i - at) < Math.abs(best - at) || (Math.abs(i - at) === Math.abs(best - at) && i > best)) best = i;
  }
  return best < 0 ? undefined : EFFORT_ORDER[best];
}
