import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AssistantMessage, ChatMessage, ChatProvider, FunctionTool, ToolCall } from "../src/provider.js";

const dirs: string[] = [];

export async function tempDir(prefix = "forge-test-"): Promise<string> {
  const d = await mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

export async function cleanupTempDirs(): Promise<void> {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
}

export function call(id: string, name: string, args: unknown): ToolCall {
  return { id, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } };
}

export function reply(content: string | null, ...calls: ToolCall[]): AssistantMessage {
  return { role: "assistant", content, ...(calls.length ? { tool_calls: calls } : {}) };
}

export type Scripted = AssistantMessage | Error | ((messages: ChatMessage[]) => AssistantMessage);

/** Provider that replays a script and records a deep copy of every request. */
export class ScriptedProvider implements ChatProvider {
  readonly name = "scripted";
  readonly model = "test-model";
  requests: Array<{ messages: ChatMessage[]; tools: FunctionTool[] }> = [];
  private i = 0;
  constructor(private readonly script: Scripted[], private readonly onExhausted?: () => AssistantMessage) {}

  async chat(messages: ChatMessage[], tools: FunctionTool[]): Promise<AssistantMessage> {
    this.requests.push({ messages: JSON.parse(JSON.stringify(messages)), tools });
    const next = this.script[this.i++];
    if (next === undefined) {
      if (this.onExhausted) return this.onExhausted();
      throw new Error("ScriptedProvider script exhausted");
    }
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next(messages) : next;
  }
}

/** Asserts the provider-API invariant: every assistant tool_call is answered by tool messages with the same ids, immediately after. */
export function assertValidOrdering(messages: ChatMessage[]): void {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === "assistant" && m.tool_calls?.length) {
      const ids = m.tool_calls.map((c) => c.id);
      const following = messages.slice(i + 1, i + 1 + ids.length);
      if (following.length !== ids.length || following.some((f, k) => f.role !== "tool" || f.tool_call_id !== ids[k])) {
        throw new Error(`Tool results after message ${i} do not match tool_call ids ${ids.join(",")}`);
      }
    }
    if (m.role === "tool") {
      const prev = messages.slice(0, i).reverse().find((x) => x.role === "assistant");
      if (!prev?.tool_calls?.some((c) => c.id === m.tool_call_id)) throw new Error(`Orphan tool message at ${i}`);
    }
  }
}
