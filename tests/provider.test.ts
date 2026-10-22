import { describe, expect, it, vi } from "vitest";
import { createOpenAICompatibleProvider, parseChatResponse, ProviderError, redactSecrets } from "../src/provider.js";

async function rejection(p: Promise<unknown>): Promise<ProviderError> {
  try { await p; } catch (e) { return e as ProviderError; }
  throw new Error("expected the promise to reject");
}

const ok = (message: unknown) => new Response(JSON.stringify({ choices: [{ message, finish_reason: "stop" }] }), { status: 200 });
const status = (code: number, body: unknown = { error: { message: "boom" } }) => new Response(JSON.stringify(body), { status: code });

function make(fetchImpl: typeof fetch, over: Partial<Parameters<typeof createOpenAICompatibleProvider>[0]> = {}) {
  const sleep = vi.fn(async () => {});
  const provider = createOpenAICompatibleProvider({
    baseUrl: "http://localhost:11434/v1", apiKey: "sk-supersecretkey1234567890", model: "llama3.2:3b",
    timeoutMs: 5000, maxRetries: 2, fetchImpl, sleep, ...over,
  });
  return { provider, sleep };
}

describe("parseChatResponse", () => {
  it("normalizes object arguments, missing ids and duplicate ids", () => {
    const msg = parseChatResponse({
      choices: [{
        message: {
          content: null,
          tool_calls: [
            { function: { name: "read_file", arguments: { path: "a.ts" } } },
            { id: "dup", function: { name: "list_files", arguments: "{}" } },
            { id: "dup", function: { name: "list_files", arguments: "{}" } },
          ],
        },
      }],
    });
    expect(msg.content).toBeNull();
    const calls = msg.tool_calls!;
    expect(calls).toHaveLength(3);
    expect(calls[0]!.function.arguments).toBe('{"path":"a.ts"}');
    expect(new Set(calls.map((c) => c.id)).size).toBe(3);
    expect(calls.every((c) => c.id.length > 0 && c.type === "function")).toBe(true);
  });

  it("rejects malformed response shapes", () => {
    expect(() => parseChatResponse({})).toThrow(ProviderError);
    expect(() => parseChatResponse({ choices: [] })).toThrow(/unexpected response shape/);
    expect(() => parseChatResponse({ choices: [{ message: { tool_calls: [{ function: {} }] } }] })).toThrow(/unexpected response shape/);
    expect(() => parseChatResponse("nope")).toThrow(ProviderError);
  });
});

describe("OpenAI-compatible provider", () => {
  it("sends model, messages, tools and auth header and returns the assistant message", async () => {
    const fetchImpl = vi.fn(async (_url: unknown, _init?: RequestInit) => ok({ content: "hi" }));
    const { provider } = make(fetchImpl as unknown as typeof fetch);
    const out = await provider.chat([{ role: "user", content: "yo" }], [{ type: "function", function: { name: "t", description: "d", parameters: {} } }]);
    expect(out).toEqual({ role: "assistant", content: "hi" });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("http://localhost:11434/v1/chat/completions");
    const body = JSON.parse(String(init!.body));
    expect(body.model).toBe("llama3.2:3b");
    expect(body.tools).toHaveLength(1);
    expect((init!.headers as Record<string, string>).authorization).toBe("Bearer sk-supersecretkey1234567890");
  });

  it("retries transient HTTP errors with backoff and then succeeds", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(status(503))
      .mockResolvedValueOnce(status(429))
      .mockResolvedValueOnce(ok({ content: "finally" }));
    const { provider, sleep } = make(fetchImpl as unknown as typeof fetch);
    await expect(provider.chat([], [])).resolves.toMatchObject({ content: "finally" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    const [d1, d2] = sleep.mock.calls.map((c) => (c as unknown as [number])[0]);
    expect(d2!).toBeGreaterThan(d1!); // exponential backoff
  });

  it("gives up after maxRetries and reports the number of attempts", async () => {
    const fetchImpl = vi.fn(async () => status(500));
    const { provider } = make(fetchImpl as unknown as typeof fetch, { maxRetries: 2 });
    await expect(provider.chat([], [])).rejects.toThrow(/gave up after 3 attempts/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("does not retry when maxRetries is 0", async () => {
    const fetchImpl = vi.fn(async () => status(500));
    const { provider } = make(fetchImpl as unknown as typeof fetch, { maxRetries: 0 });
    await expect(provider.chat([], [])).rejects.toBeInstanceOf(ProviderError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not retry client errors (400/401/404)", async () => {
    for (const code of [400, 401, 404]) {
      const fetchImpl = vi.fn(async () => status(code));
      const { provider } = make(fetchImpl as unknown as typeof fetch);
      await expect(provider.chat([], [])).rejects.toBeInstanceOf(ProviderError);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it("explains unsupported tool calling", async () => {
    const fetchImpl = vi.fn(async () => status(400, { error: { message: "registry.ollama.ai/library/gemma:2b does not support tools" } }));
    const { provider } = make(fetchImpl as unknown as typeof fetch);
    const err = await rejection(provider.chat([], []));
    expect(err.kind).toBe("tools_unsupported");
    expect(err.message).toMatch(/does not support tool calling/);
    expect(err.message).toMatch(/FORGE_MODEL/);
  });

  it("gives actionable messages for auth failures and 404", async () => {
    const a = make((async () => status(401)) as unknown as typeof fetch).provider;
    await expect(a.chat([], [])).rejects.toThrow(/FORGE_API_KEY/);
    const n = make((async () => status(404)) as unknown as typeof fetch).provider;
    await expect(n.chat([], [])).rejects.toThrow(/ollama pull llama3.2:3b/);
  });

  it("reports an unreachable endpoint and retries network failures", async () => {
    const fetchImpl = vi.fn(async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }); });
    const { provider } = make(fetchImpl as unknown as typeof fetch, { maxRetries: 1 });
    const err = await rejection(provider.chat([], []));
    expect(err.kind).toBe("unreachable");
    expect(err.message).toMatch(/Cannot reach the model endpoint/);
    expect(err.message).toMatch(/ECONNREFUSED/);
    expect(err.message).toMatch(/ollama serve/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("times out a hung request and retries within the limit", async () => {
    const hang = vi.fn((_u: unknown, init?: RequestInit) => new Promise<Response>((_res, rej) => {
      init!.signal!.addEventListener("abort", () => rej(new DOMException("aborted", "TimeoutError")));
    }));
    const { provider } = make(hang as unknown as typeof fetch, { timeoutMs: 30, maxRetries: 1 });
    const err = await rejection(provider.chat([], []));
    expect(err.kind).toBe("timeout");
    expect(err.message).toMatch(/FORGE_PROVIDER_TIMEOUT_MS/);
    expect(hang).toHaveBeenCalledTimes(2);
  });

  it("retries invalid responses a bounded number of times", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>gateway</html>", { status: 200 }));
    const { provider } = make(fetchImpl as unknown as typeof fetch, { maxRetries: 1 });
    await expect(provider.chat([], [])).rejects.toThrow(/non-JSON/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("stops immediately when cancelled", async () => {
    const ac = new AbortController();
    const fetchImpl = vi.fn((_u: unknown, init?: RequestInit) => new Promise<Response>((_res, rej) => {
      init!.signal!.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
    }));
    const { provider } = make(fetchImpl as unknown as typeof fetch);
    const p = provider.chat([], [], ac.signal);
    setTimeout(() => ac.abort(), 10);
    const err = await rejection(p);
    expect(err.kind).toBe("cancelled");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("never leaks the API key in errors, even if the server echoes it", async () => {
    const key = "sk-supersecretkey1234567890";
    const fetchImpl = vi.fn(async () => status(400, { error: { message: `Invalid key ${key} for Bearer ${key}` } }));
    const { provider } = make(fetchImpl as unknown as typeof fetch);
    const err = await rejection(provider.chat([], []));
    expect(err.message).not.toContain(key);
    expect(err.message).toContain("[REDACTED]");
  });

  it("omits tools/tool_choice when no tools are offered", async () => {
    const fetchImpl = vi.fn(async (_u: unknown, _i?: RequestInit) => ok({ content: "x" }));
    const { provider } = make(fetchImpl as unknown as typeof fetch);
    await provider.chat([], []);
    const body = JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body));
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
  });
});

describe("redactSecrets", () => {
  it("redacts keys and bearer tokens but leaves the local placeholder keys alone", () => {
    expect(redactSecrets("key=abcd1234efgh", ["abcd1234efgh"])).toBe("key=[REDACTED]");
    expect(redactSecrets("Authorization: Bearer abcdefghijklmnop", [])).toContain("[REDACTED]");
    expect(redactSecrets("model ollama is local", ["ollama", "local"])).toBe("model ollama is local");
  });
});
