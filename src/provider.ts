import { z } from "zod";

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_call_id?: string;
  name?: string;
  tool_calls?: ToolCall[];
};

export type FunctionTool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type AssistantMessage = {
  role: "assistant";
  content: string | null;
  tool_calls?: ToolCall[];
};

/** Provider abstraction: the agent only depends on this, never on a vendor. */
export interface ChatProvider {
  readonly name: string;
  readonly model: string;
  chat(messages: ChatMessage[], tools: FunctionTool[], signal?: AbortSignal): Promise<AssistantMessage>;
}

export type ProviderErrorKind =
  | "unreachable"
  | "timeout"
  | "cancelled"
  | "auth"
  | "not_found"
  | "tools_unsupported"
  | "rate_limited"
  | "server"
  | "bad_request"
  | "invalid_response";

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly kind: ProviderErrorKind,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export function redactSecrets(text: string, secrets: Array<string | undefined>): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 4 && !["local", "ollama"].includes(secret)) out = out.split(secret).join("[REDACTED]");
  }
  return out.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[REDACTED]").replace(/\bsk-[A-Za-z0-9_-]{16,}/g, "[REDACTED]");
}

// --- response validation -------------------------------------------------------------------

const RawToolCall = z.object({
  id: z.string().optional().nullable(),
  type: z.string().optional().nullable(),
  function: z.object({
    name: z.string(),
    // OpenAI sends a JSON string; Ollama and some gateways send an object.
    arguments: z.union([z.string(), z.record(z.unknown()), z.null()]).optional(),
  }),
});

const RawResponse = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          role: z.string().optional(),
          content: z.union([z.string(), z.null()]).optional(),
          tool_calls: z.array(RawToolCall).optional().nullable(),
        }),
        finish_reason: z.string().optional().nullable(),
      }),
    )
    .min(1),
});

/** Validates and normalizes a chat-completions body into an assistant message with unique tool-call IDs. */
export function parseChatResponse(body: unknown): AssistantMessage {
  const parsed = RawResponse.safeParse(body);
  if (!parsed.success) {
    const detail = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new ProviderError(`Model API returned an unexpected response shape (${detail}).`, "invalid_response", true);
  }
  const message = parsed.data.choices[0]!.message;
  const seen = new Set<string>();
  const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((raw, index) => {
    let id = raw.id && raw.id.length > 0 ? raw.id : `call_${index}`;
    while (seen.has(id)) id = `${id}_${index}`;
    seen.add(id);
    const args = raw.function.arguments;
    return {
      id,
      type: "function" as const,
      function: {
        name: raw.function.name,
        arguments: typeof args === "string" ? args : args == null ? "{}" : JSON.stringify(args),
      },
    };
  });
  return {
    role: "assistant",
    content: message.content ?? null,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

// --- provider ------------------------------------------------------------------------------

export type OpenAICompatibleOptions = {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxRetries: number;
  retryBaseDelayMs?: number;
  temperature?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ProviderError("Cancelled.", "cancelled", false));
    const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(new ProviderError("Cancelled.", "cancelled", false)); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function classifyHttp(status: number, detail: string, options: OpenAICompatibleOptions): ProviderError {
  const base = options.baseUrl;
  if (/does not support tools|tools? (are |is )?not supported|tool[_ ]use (is )?not supported|doesn't support tool/i.test(detail)) {
    return new ProviderError(
      `Model "${options.model}" does not support tool calling (${detail}). Choose a tool-capable model (for Ollama: llama3.1+, llama3.2, qwen2.5, mistral-nemo) via FORGE_MODEL.`,
      "tools_unsupported", false, status);
  }
  if (status === 401 || status === 403) return new ProviderError(`Authentication failed (HTTP ${status}). Check FORGE_API_KEY. ${detail}`, "auth", false, status);
  if (status === 404) return new ProviderError(`HTTP 404 from ${base}. Check FORGE_BASE_URL (it should end in /v1) and that model "${options.model}" exists (Ollama: \`ollama pull ${options.model}\`). ${detail}`, "not_found", false, status);
  if (status === 408 || status === 409 || status === 425) return new ProviderError(`Model API returned HTTP ${status}. ${detail}`, "server", true, status);
  if (status === 429) return new ProviderError(`Rate limited by the model API (HTTP 429). ${detail}`, "rate_limited", true, status);
  if (status >= 500) return new ProviderError(`Model API server error (HTTP ${status}). ${detail}`, "server", true, status);
  return new ProviderError(`Model API rejected the request (HTTP ${status}). ${detail}`, "bad_request", false, status);
}

export function createOpenAICompatibleProvider(options: OpenAICompatibleOptions): ChatProvider {
  const doFetch = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const url = `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const baseDelay = options.retryBaseDelayMs ?? 500;
  const clean = (text: string) => redactSecrets(text, [options.apiKey]);

  async function attempt(messages: ChatMessage[], tools: FunctionTool[], signal?: AbortSignal): Promise<AssistantMessage> {
    const timeout = AbortSignal.timeout(options.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${options.apiKey}` },
        body: JSON.stringify({
          model: options.model,
          messages,
          ...(tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
          temperature: options.temperature ?? 0.2,
          stream: false,
        }),
        signal: combined,
      });
    } catch (error) {
      if (signal?.aborted) throw new ProviderError("Cancelled.", "cancelled", false);
      if (timeout.aborted) {
        throw new ProviderError(`Model API did not respond within ${options.timeoutMs}ms (${clean(options.baseUrl)}). Local models can be slow on first load; raise FORGE_PROVIDER_TIMEOUT_MS.`, "timeout", true);
      }
      const reason = error instanceof Error ? `${error.message}${(error as { cause?: { code?: string } }).cause?.code ? ` (${(error as { cause?: { code?: string } }).cause!.code})` : ""}` : String(error);
      throw new ProviderError(`Cannot reach the model endpoint ${clean(options.baseUrl)}: ${clean(reason)}. Is the server running (Ollama: \`ollama serve\`) and is FORGE_BASE_URL correct?`, "unreachable", true);
    }

    const text = await response.text().catch(() => "");
    let body: unknown;
    try { body = text ? JSON.parse(text) : {}; } catch { body = undefined; }

    if (!response.ok) {
      const errObj = (body as { error?: { message?: string } | string } | undefined)?.error;
      const msg = typeof errObj === "string" ? errObj : errObj?.message ?? text.slice(0, 500);
      throw classifyHttp(response.status, clean(String(msg)).slice(0, 500), options);
    }
    if (body === undefined) throw new ProviderError("Model API returned a non-JSON response body.", "invalid_response", true);
    return parseChatResponse(body);
  }

  return {
    name: new URL(options.baseUrl).host,
    model: options.model,
    async chat(messages, tools, signal) {
      let lastError: ProviderError | undefined;
      for (let tryNo = 0; tryNo <= options.maxRetries; tryNo++) {
        try {
          return await attempt(messages, tools, signal);
        } catch (error) {
          const pe = error instanceof ProviderError
            ? error
            : new ProviderError(clean(error instanceof Error ? error.message : String(error)), "invalid_response", false);
          lastError = pe;
          if (!pe.retryable || tryNo === options.maxRetries) break;
          await sleep(Math.min(baseDelay * 2 ** tryNo, 8000), signal);
        }
      }
      const attempts = options.maxRetries + 1;
      const e = lastError!;
      if (e.retryable) {
        throw new ProviderError(`${e.message} (gave up after ${attempts} attempt${attempts === 1 ? "" : "s"})`, e.kind, false, e.status);
      }
      throw e;
    },
  };
}
