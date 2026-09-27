import { MockProvider } from "./mock-provider";
import { OpenAiCompatibleProvider } from "./openai-compatible-provider";
import {
  ProviderUnavailableError,
  type CompletionRequest,
  type CompletionResult,
  type EmbeddingResult,
  type LlmProvider,
  type ProviderName,
} from "./types";

/**
 * Single entry point for all LLM access (ADR-0003). F1 shipped the interface +
 * mock provider; the openai-compatible HTTP provider arrived post-F5 (ADR-0017,
 * D-23) as a drop-in implementation of LlmProvider. bedrock-shape remains
 * registered-but-unimplemented (the AWS migration target, tech-stack.md §2).
 */
export class LlmGateway {
  private constructor(private readonly provider: LlmProvider) {}

  static forProvider(provider: LlmProvider): LlmGateway {
    return new LlmGateway(provider);
  }

  /** Factory honoring LLM_PROVIDER; "mock" is the mandatory offline default. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): LlmGateway {
    const requested = (env.LLM_PROVIDER ?? "mock") as ProviderName | "off";
    switch (requested) {
      case "mock":
        return LlmGateway.forProvider(new MockProvider());
      case "off":
        // Explicit "no LLM provider configured" — copilot callers must degrade
        // to the rules engine and label the answer source (ADR-0003).
        throw new ProviderUnavailableError(
          "LLM provider disabled by configuration (LLM_PROVIDER=off); " +
            "falling back to rule-based answers is expected behaviour",
        );
      case "openai-compatible":
        try {
          return LlmGateway.forProvider(OpenAiCompatibleProvider.fromEnv(env));
        } catch (err) {
          // ADR-0017: a misconfigured real provider (e.g. missing OPENAI_API_KEY)
          // is a degrade signal, not a crash — same contract as provider failures.
          throw new ProviderUnavailableError(
            `openai-compatible provider unavailable: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      case "bedrock-shape":
        throw new ProviderUnavailableError(
          `LLM provider "${requested}" is registered but not implemented; ` +
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
