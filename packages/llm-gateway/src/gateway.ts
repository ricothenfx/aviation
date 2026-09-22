import { MockProvider } from "./mock-provider";
import {
  ProviderUnavailableError,
  type CompletionRequest,
  type CompletionResult,
  type EmbeddingResult,
  type LlmProvider,
  type ProviderName,
} from "./types";

/**
 * Single entry point for all LLM access (ADR-0003). F1 ships the interface + mock
 * provider; HTTP-compatible and Bedrock-shaped providers arrive with the copilot
 * milestone (F4) and remain drop-in implementations of LlmProvider.
 */
export class LlmGateway {
  private constructor(private readonly provider: LlmProvider) {}

  static forProvider(provider: LlmProvider): LlmGateway {
    return new LlmGateway(provider);
  }

  /** Factory honoring LLM_PROVIDER; "mock" is the mandatory offline default. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): LlmGateway {
    const requested = (env.LLM_PROVIDER ?? "mock") as ProviderName;
    switch (requested) {
      case "mock":
        return LlmGateway.forProvider(new MockProvider());
      case "openai-compatible":
      case "bedrock-shape":
        throw new ProviderUnavailableError(
          `LLM provider "${requested}" is registered but not implemented until F4; ` +
            "set LLM_PROVIDER=mock for offline development",
        );
    }
  }

  get providerName(): ProviderName {
    return this.provider.name;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    try {
      return await this.provider.complete(request);
    } catch (err) {
      if (err instanceof ProviderUnavailableError) throw err;
      throw new ProviderUnavailableError(
        `provider "${this.provider.name}" failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async embed(text: string): Promise<EmbeddingResult> {
    try {
      return await this.provider.embed(text);
    } catch (err) {
      if (err instanceof ProviderUnavailableError) throw err;
      throw new ProviderUnavailableError(
        `provider "${this.provider.name}" failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
