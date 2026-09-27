import type { CompletionRequest, CompletionResult, EmbeddingResult, LlmProvider } from "./types";

/**
 * OpenAI-compatible HTTP provider (ADR-0003 §Decision 2, implemented per ADR-0017/D-23).
 * Plain fetch against any OpenAI-shaped endpoint — no vendor SDK (tech-stack.md §3) —
 * with the same failure contract as the gateway: every transport/HTTP problem becomes
 * a ProviderUnavailableError so callers degrade to their labeled rules/extractive
 * paths. The API key is never logged and never appears in an error message.
 *
 * Opt-in only: `LLM_PROVIDER=mock` remains the mandatory offline default for tests,
 * CI and demos (deterministic, cost-zero). Selecting this provider without
 * OPENAI_API_KEY fails fast at construction with an error naming the variable.
 */

export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
export const DEFAULT_OPENAI_EMBED_MODEL = "text-embedding-3-small";
const REQUEST_TIMEOUT_MS = 30_000;

export interface OpenAiCompatibleOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  embedModel?: string;
  timeoutMs?: number;
  /** Test seam — defaults to global fetch. Must satisfy the DOM fetch signature. */
  fetchImpl?: typeof fetch;
}

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly name = "openai-compatible" as const;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly embedModel: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAiCompatibleOptions) {
    if (!options.apiKey) {
      throw new Error("OpenAiCompatibleProvider requires an API key");
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, "");
    this.model = options.model ?? DEFAULT_OPENAI_MODEL;
    this.embedModel = options.embedModel ?? DEFAULT_OPENAI_EMBED_MODEL;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  static fromEnv(
    env: NodeJS.ProcessEnv = process.env,
    fetchImpl?: typeof fetch,
  ): OpenAiCompatibleProvider {
    const apiKey = env.OPENAI_API_KEY ?? "";
    if (!apiKey) {
      // Gateway contract (ADR-0003): construction failure is a degrade signal,
      // not a crash — callers catch ProviderUnavailableError and fall back.
      throw new Error(
        "OPENAI_API_KEY is required when LLM_PROVIDER=openai-compatible; " +
          "set LLM_PROVIDER=mock for offline development",
      );
    }
    return new OpenAiCompatibleProvider({
      apiKey,
      baseUrl: env.OPENAI_BASE_URL || undefined,
      model: env.OPENAI_MODEL || undefined,
      embedModel: env.OPENAI_EMBED_MODEL || undefined,
      fetchImpl,
    });
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const body = {
      model: this.model,
      messages: request.messages,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
    };
    const json = await this.post("/chat/completions", body);
    const choice = (json as ChatCompletionResponse).choices?.[0]?.message?.content;
    if (typeof choice !== "string") {
      throw new Error("malformed response: missing choices[0].message.content");
    }
    const usage = (json as ChatCompletionResponse).usage;
    return {
      text: choice,
      provider: this.name,
      usage: {
        inputTokens: usage?.prompt_tokens ?? 0,
        outputTokens: usage?.completion_tokens ?? 0,
      },
    };
  }

  async embed(text: string): Promise<EmbeddingResult> {
    const json = await this.post("/embeddings", { model: this.embedModel, input: text });
    const vector = (json as EmbeddingResponse).data?.[0]?.embedding;
    if (!Array.isArray(vector)) {
      throw new Error("malformed response: missing data[0].embedding");
    }
    const usage = (json as EmbeddingResponse).usage;
    return {
      vector,
      usage: { inputTokens: usage?.prompt_tokens ?? 0 },
    };
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      // Network/DNS/timeout — surface as gateway degrade signal, never leak headers.
      throw new Error(`request failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!response.ok) {
      // Status + reason only — response bodies can echo authenticated context.
      throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
    }
    return response.json();
  }
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface EmbeddingResponse {
  data?: Array<{ embedding?: number[] }>;
  usage?: { prompt_tokens?: number };
}
