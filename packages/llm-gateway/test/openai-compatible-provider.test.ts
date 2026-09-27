import { describe, expect, it } from "vitest";

import { LlmGateway } from "../src/gateway";
import {
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_OPENAI_EMBED_MODEL,
  DEFAULT_OPENAI_MODEL,
  OpenAiCompatibleProvider,
} from "../src/openai-compatible-provider";
import { ProviderUnavailableError } from "../src/types";

const KEY = "sk-test-not-a-real-key";

/** Minimal fetch double capturing the request and returning a canned response. */
function fetchDouble(
  responder: (url: string, init: RequestInit) => { status?: number; body: unknown },
) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const init_ = init ?? {};
    calls.push({ url: String(url), init: init_ });
    const out = responder(String(url), init_);
    return new Response(JSON.stringify(out.body), {
      status: out.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { impl, calls };
}

describe("OpenAiCompatibleProvider (ADR-0017/D-23)", () => {
  it("posts chat completions to the configured base URL with bearer auth and maps usage", async () => {
    const { impl, calls } = fetchDouble(() => ({
      body: {
        choices: [{ message: { content: "Real answer text." } }],
        usage: { prompt_tokens: 41, completion_tokens: 17 },
      },
    }));
    const provider = new OpenAiCompatibleProvider({
      apiKey: KEY,
      baseUrl: "https://llm.example.test/v1/",
      fetchImpl: impl,
    });

    const result = await provider.complete({
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "explain" },
      ],
      temperature: 0.2,
      maxTokens: 300,
    });

    expect(result).toEqual({
      text: "Real answer text.",
      provider: "openai-compatible",
      usage: { inputTokens: 41, outputTokens: 17 },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://llm.example.test/v1/chat/completions");
    expect(calls[0]!.init.method).toBe("POST");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(body.model).toBe(DEFAULT_OPENAI_MODEL);
    expect(body.max_tokens).toBe(300);
    expect(body.temperature).toBe(0.2);
  });

  it("embeds via the embeddings endpoint and maps the vector + usage", async () => {
    const { impl, calls } = fetchDouble(() => ({
      body: {
        data: [{ embedding: [0.1, 0.2, 0.3] }],
        usage: { prompt_tokens: 9 },
      },
    }));
    const provider = new OpenAiCompatibleProvider({ apiKey: KEY, fetchImpl: impl });

    const result = await provider.embed("loader breakdown");

    expect(result.vector).toEqual([0.1, 0.2, 0.3]);
    expect(result.usage.inputTokens).toBe(9);
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(calls[0]!.url).toBe(`${DEFAULT_OPENAI_BASE_URL}/embeddings`);
    expect(body.model).toBe(DEFAULT_OPENAI_EMBED_MODEL);
    expect(body.input).toBe("loader breakdown");
  });

  it("honors env overrides for base URL and models on real calls", async () => {
    const { impl, calls } = fetchDouble(() => ({
      body: {
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      },
    }));
    const provider = OpenAiCompatibleProvider.fromEnv(
      {
        OPENAI_API_KEY: KEY,
        OPENAI_BASE_URL: "https://gateway.corp.test/api/",
        OPENAI_MODEL: "vendor-model-x",
      },
      impl,
    );
    await provider.complete({ messages: [{ role: "user", content: "hi" }] });
    expect(calls[0]!.url).toBe("https://gateway.corp.test/api/chat/completions");
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(body.model).toBe("vendor-model-x");
  });

  it("never leaks the API key in HTTP error messages", async () => {
    const { impl } = fetchDouble(() => ({ status: 401, body: { error: {} } }));
    const gateway = LlmGateway.forProvider(
      new OpenAiCompatibleProvider({ apiKey: KEY, fetchImpl: impl }),
    );
    await expect(gateway.complete({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(
      ProviderUnavailableError,
    );
    await expect(
      gateway
        .complete({ messages: [{ role: "user", content: "hi" }] })
        .catch((e: Error) => e.message),
    ).resolves.toContain("401");
    await expect(
      gateway
        .complete({ messages: [{ role: "user", content: "hi" }] })
        .catch((e: Error) => e.message),
    ).resolves.not.toContain(KEY);
  });

  it("maps transport failures to the gateway degrade error", async () => {
    const failing = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const gateway = LlmGateway.forProvider(
      new OpenAiCompatibleProvider({ apiKey: KEY, fetchImpl: failing }),
    );
    await expect(gateway.embed("x")).rejects.toThrow(ProviderUnavailableError);
  });
});

describe("LlmGateway.fromEnv with openai-compatible (ADR-0017)", () => {
  it("fails fast with a ProviderUnavailableError naming the missing variable", () => {
    expect(() => LlmGateway.fromEnv({ LLM_PROVIDER: "openai-compatible" })).toThrow(
      ProviderUnavailableError,
    );
    try {
      LlmGateway.fromEnv({ LLM_PROVIDER: "openai-compatible" });
    } catch (err) {
      expect((err as Error).message).toContain("OPENAI_API_KEY");
    }
  });

  it("constructs a real gateway when the key is present", () => {
    const gateway = LlmGateway.fromEnv({ LLM_PROVIDER: "openai-compatible", OPENAI_API_KEY: KEY });
    expect(gateway.providerName).toBe("openai-compatible");
  });

  it("keeps bedrock-shape registered-but-unimplemented", () => {
    expect(() => LlmGateway.fromEnv({ LLM_PROVIDER: "bedrock-shape" })).toThrow(
      ProviderUnavailableError,
    );
  });

  it("keeps mock as the default provider", () => {
    expect(LlmGateway.fromEnv({}).providerName).toBe("mock");
  });
});
