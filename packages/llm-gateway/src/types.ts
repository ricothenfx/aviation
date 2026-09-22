/**
 * Gateway interface (ADR-0003): a narrow surface — complete / embed / stream — with
 * token accounting. Vendor SDKs are allowed only behind this interface (tech-stack.md §3).
 */

export type ProviderName = "mock" | "openai-compatible" | "bedrock-shape";

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface CompletionRequest {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface CompletionResult {
  text: string;
  provider: ProviderName;
  usage: TokenUsage;
}

export interface EmbeddingResult {
  vector: number[];
  usage: { inputTokens: number };
}

/**
 * Raised when the configured provider cannot serve a request. Callers must degrade
 * gracefully to the rules engine and label the answer source (ADR-0003).
 */
export class ProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderUnavailableError";
  }
}

export interface LlmProvider {
  readonly name: ProviderName;
  complete(request: CompletionRequest): Promise<CompletionResult>;
  embed(text: string): Promise<EmbeddingResult>;
}
