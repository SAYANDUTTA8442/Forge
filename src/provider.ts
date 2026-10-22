export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_call_id?: string;
  name?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
};

export type FunctionTool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type ChatResponse = {
  choices?: Array<{
    message?: ChatMessage;
    finish_reason?: string | null;
  }>;
  error?: { message?: string };
};

export async function chatCompletion(args: {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  tools: FunctionTool[];
}): Promise<ChatMessage> {
  const url = `${args.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${args.apiKey}`,
    },
    body: JSON.stringify({
      model: args.model,
      messages: args.messages,
      tools: args.tools,
      tool_choice: "auto",
      temperature: 0.2,
    }),
    signal: AbortSignal.timeout(120000),
  });

  const body = await response.json().catch(() => ({})) as ChatResponse;
  if (!response.ok) {
    throw new Error(`Model API returned HTTP ${response.status}: ${body.error?.message ?? JSON.stringify(body).slice(0, 1000)}`);
  }
  const message = body.choices?.[0]?.message;
  if (!message) throw new Error(`Model API returned no assistant message: ${JSON.stringify(body).slice(0, 1000)}`);
  return message;
}