import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { AgentSession, detectPseudoToolCall } from "../src/agent.js";
import { ProviderError, type AssistantMessage } from "../src/provider.js";
import { TaskState } from "../src/state.js";
import { createTools } from "../src/tools.js";
import { nullLogger } from "../src/ui.js";
import { Workspace } from "../src/workspace.js";
import { assertValidOrdering, call, cleanupTempDirs, reply, ScriptedProvider, tempDir, type Scripted } from "./helpers.js";

afterEach(cleanupTempDirs);

const PASSING_TEST = "const t = require('node:test'); t('ok', () => {});\n";
const FAILING_TEST = "const t = require('node:test'); t('bad', () => { throw new Error('boom'); });\n";

async function setup(script: Scripted[], opts: { maxSteps?: number; approve?: boolean; onExhausted?: () => AssistantMessage; files?: Record<string, string> } = {}) {
  const root = await tempDir();
  for (const [p, c] of Object.entries(opts.files ?? {})) {
    await fs.mkdir(path.dirname(path.join(root, p)), { recursive: true });
    await fs.writeFile(path.join(root, p), c);
  }
  const workspace = await Workspace.create(root);
  const state = new TaskState();
  const approver = vi.fn(async () => opts.approve ?? true);
  const provider = new ScriptedProvider(script, opts.onExhausted);
  const session = new AgentSession({
    provider, state, logger: nullLogger, maxSteps: opts.maxSteps ?? 10, workspaceRoot: workspace.root,
    platformInfo: "test", shellInfo: "sh", secrets: ["sk-topsecret-key-123456"],
    tools: createTools({ workspace, state, approver, commandTimeoutMs: 20_000, maxOutputChars: 5000, shell: "auto" }),
  });
  return { session, provider, state, workspace, root, approver };
}

describe("detectPseudoToolCall", () => {
  const names = ["list_files", "read_file", "write_file", "run_command"];
  it("flags unknown tool names such as run_shell_command", () => {
    expect(detectPseudoToolCall("I will use run_shell_command to run the tests.", names)).toMatch(/run_shell_command.*not an available tool/);
  });
  it("flags JSON tool calls written as text, for known and unknown tools", () => {
    expect(detectPseudoToolCall('{"name": "run_command", "arguments": {"command": "ls"}}', names)).toMatch(/plain text/);
    expect(detectPseudoToolCall('```json\n{"name":"bash","parameters":{"cmd":"ls"}}\n```', names)).toMatch(/not an available tool/);
  });
  it("leaves ordinary prose and registered tool names alone", () => {
    expect(detectPseudoToolCall("I read the file and everything looks fine.", names)).toBeNull();
    expect(detectPseudoToolCall("Used read_file and write_file to update it.", names)).toBeNull();
    expect(detectPseudoToolCall("", names)).toBeNull();
    expect(detectPseudoToolCall('{"status": "ok"}', names)).toBeNull();
  });
});

describe("tool-call handling and message ordering", () => {
  it("returns tool results with matching ids, in order, before the next model call", async () => {
    const { session, provider } = await setup([
      reply(null, call("a1", "list_files", { path: "." }), call("a2", "read_file", { path: "hello.txt" })),
      reply("The file says hi."),
    ], { files: { "hello.txt": "hi" } });
    const r = await session.run("inspect");
    expect(r.status).toBe("completed");
    const second = provider.requests[1]!.messages;
    const assistantIdx = second.findIndex((m) => m.role === "assistant");
    expect(second[assistantIdx]!.tool_calls!.map((c) => c.id)).toEqual(["a1", "a2"]);
    expect(second[assistantIdx + 1]).toMatchObject({ role: "tool", tool_call_id: "a1", name: "list_files" });
    expect(second[assistantIdx + 2]).toMatchObject({ role: "tool", tool_call_id: "a2", name: "read_file", content: "hi" });
    assertValidOrdering(session.messages);
  });

  it("answers an unknown tool with the list of real tools and lets the model retry", async () => {
    const { session, provider } = await setup([
      reply(null, call("x1", "run_shell_command", { command: "ls" })),
      reply(null, call("x2", "list_files", {})),
      reply("done"),
    ]);
    const r = await session.run("look around");
    expect(r.status).toBe("completed");
    const toolMsg = provider.requests[1]!.messages.find((m) => m.role === "tool")!;
    expect(toolMsg.tool_call_id).toBe("x1");
    expect(toolMsg.content).toMatch(/unknown tool "run_shell_command"/);
    expect(toolMsg.content).toMatch(/list_files, read_file, write_file, edit_file, delete_file, search_text, run_command/);
    expect(provider.requests).toHaveLength(3);
    assertValidOrdering(session.messages);
  });

  it("reports malformed JSON arguments back to the model and keeps going", async () => {
    const { session, provider } = await setup([
      reply(null, call("m1", "read_file", "{not json")),
      reply(null, call("m2", "read_file", '"just a string"')),
      reply(null, call("m3", "read_file", "[1,2]")),
      reply("gave up"),
    ]);
    await session.run("x");
    const tools = session.messages.filter((m) => m.role === "tool");
    expect(tools).toHaveLength(3);
    expect(tools[0]!.content).toMatch(/not valid JSON/);
    expect(tools[1]!.content).toMatch(/Invalid arguments|must be a JSON object|not valid JSON/);
    expect(tools[2]!.content).toMatch(/must be a JSON object/);
    expect(provider.requests).toHaveLength(4);
    assertValidOrdering(session.messages);
  });

  it("accepts double-encoded JSON arguments and empty argument strings", async () => {
    const { session } = await setup([
      reply(null, call("d1", "read_file", JSON.stringify(JSON.stringify({ path: "a.txt" }))), call("d2", "list_files", "")),
      reply("ok"),
    ], { files: { "a.txt": "AAA" } });
    await session.run("x");
    const tools = session.messages.filter((m) => m.role === "tool");
    expect(tools[0]!.content).toBe("AAA");
    expect(tools[1]!.content).toMatch(/a.txt/);
  });

  it("reports missing required fields", async () => {
    const { session } = await setup([reply(null, call("f1", "write_file", { path: "a.txt" })), reply("hmm")]);
    await session.run("x");
    expect(session.messages.find((m) => m.role === "tool")!.content).toMatch(/content: Required/);
  });

  it("answers every call even when the model sends more than the per-turn limit", async () => {
    const calls = Array.from({ length: 11 }, (_, i) => call(`c${i}`, "list_files", {}));
    const { session } = await setup([reply(null, ...calls), reply("done")]);
    await session.run("x");
    const tools = session.messages.filter((m) => m.role === "tool");
    expect(tools).toHaveLength(11);
    expect(tools[10]!.content).toMatch(/at most 8 tool calls/);
    assertValidOrdering(session.messages);
  });

  it("never executes ordinary assistant text as a tool call", async () => {
    const { session, root } = await setup([
      reply('{"name": "write_file", "arguments": {"path": "pwned.txt", "content": "x"}}'),
      reply("I will not use text calls. Done."),
    ]);
    const r = await session.run("x");
    await expect(fs.stat(path.join(root, "pwned.txt"))).rejects.toThrow();
    expect(r.changedFiles).toHaveLength(0);
  });

  it("does not terminate when the model only mentions a nonexistent tool; it asks for a retry", async () => {
    const { session, provider } = await setup([
      reply("Let me call run_shell_command to run the tests."),
      reply(null, call("t1", "list_files", {})),
      reply("All done."),
    ]);
    const r = await session.run("x");
    expect(provider.requests).toHaveLength(3);
    const nudge = provider.requests[1]!.messages.at(-1)!;
    expect(nudge.role).toBe("user");
    expect(nudge.content).toMatch(/run_shell_command.*not an available tool/);
    expect(nudge.content).toMatch(/Available tools: list_files/);
    expect(r.status).toBe("completed");
  });

  it("gives up with INCOMPLETE if the model keeps producing unusable replies", async () => {
    const { session } = await setup([], { onExhausted: () => reply("use run_shell_command") });
    const r = await session.run("x");
    expect(r.status).toBe("incomplete");
    expect(r.summary).toMatch(/INCOMPLETE/);
  });

  it("treats an empty reply as unusable, not as success", async () => {
    const { session, provider } = await setup([reply(""), reply("Here is my answer.")]);
    const r = await session.run("x");
    expect(provider.requests).toHaveLength(2);
    expect(r.status).toBe("completed");
  });
});

describe("task completion verification", () => {
  it("is completed + verified only after a passing test run following the last change", async () => {
    const { session, provider, state } = await setup([
      reply(null, call("w", "write_file", { path: "x.test.js", content: PASSING_TEST })),
      reply("Done, I added a test."),
      reply(null, call("t", "run_command", { command: "node --test" })),
      reply("Added x.test.js; node --test passed."),
    ]);
    const r = await session.run("add a test");
    expect(provider.requests).toHaveLength(4);
    expect(provider.requests[2]!.messages.at(-1)!.content).toMatch(/have not run any test/);
    expect(r.status).toBe("completed");
    expect(r.verification).toBe("passed");
    expect(r.changedFiles).toEqual([{ path: "x.test.js", kind: "created" }]);
    expect(r.summary).toMatch(/COMPLETED/);
    expect(r.summary).toMatch(/created x.test.js/);
    expect(state.freshVerification?.ok).toBe(true);
    assertValidOrdering(session.messages);
  });

  it("re-requires verification when a file changes after a passing run", async () => {
    const { session, provider } = await setup([
      reply(null, call("w", "write_file", { path: "x.test.js", content: PASSING_TEST })),
      reply(null, call("t", "run_command", { command: "node --test" })),
      reply(null, call("e", "edit_file", { path: "x.test.js", old_text: "'ok'", new_text: "'ok2'" })),
      reply("finished"),
      reply(null, call("t2", "run_command", { command: "node --test" })),
      reply("verified again"),
    ]);
    const r = await session.run("x");
    expect(provider.requests).toHaveLength(6);
    expect(r.status).toBe("completed");
  });

  it("reports FAILED with the real failure when tests keep failing, after bounded fix attempts", async () => {
    const { session, provider } = await setup([
      reply(null, call("w", "write_file", { path: "x.test.js", content: FAILING_TEST })),
      reply(null, call("t", "run_command", { command: "node --test" })),
      reply("All tests pass!"),
    ], { onExhausted: () => reply("Everything is fixed and tests pass.") });
    const r = await session.run("add a failing test");
    expect(r.status).toBe("failed");
    expect(r.verification).toBe("failed");
    expect(r.summary).toMatch(/FAILED/);
    expect(r.summary).toMatch(/✗ node --test/);
    expect(r.summary).not.toMatch(/Verified: PASSED/);
    expect(r.warnings.join(" ")).toMatch(/claims tests\/build passed/);
    // 1 write + 1 run + final + 3 fix nudges' replies; bounded, not endless
    expect(provider.requests.length).toBeLessThanOrEqual(8);
    expect(provider.requests.some((q) => q.messages.some((m) => m.role === "user" && /verification command failed/.test(m.content ?? "")))).toBe(true);
  });

  it("lets the agent fix a failing test and then verifies the result", async () => {
    const { session } = await setup([
      reply(null, call("w", "write_file", { path: "x.test.js", content: FAILING_TEST })),
      reply(null, call("t", "run_command", { command: "node --test" })),
      reply(null, call("e", "edit_file", { path: "x.test.js", old_text: "throw new Error('boom');", new_text: "" })),
      reply(null, call("t2", "run_command", { command: "node --test" })),
      reply("Fixed; tests pass now."),
    ]);
    const r = await session.run("x");
    expect(r.status).toBe("completed");
    expect(r.verification).toBe("passed");
    expect(r.commands.map((c) => c.ok)).toEqual([false, true]);
  });

  it("finishes as NOT VERIFIED (never 'completed') if changes were made but no check could be run", async () => {
    const { session } = await setup([
      reply(null, call("w", "write_file", { path: "notes.md", content: "hello\n" })),
      reply("Created notes.md."),
      reply("There is no test command in this project."),
      reply("Still no tests."),
    ]);
    const r = await session.run("write notes");
    expect(r.status).toBe("completed_unverified");
    expect(r.verification).toBe("not_run");
    expect(r.summary).toMatch(/NOT VERIFIED/);
    expect(r.remaining.join(" ")).toMatch(/Run the project's tests/);
  });

  it("flags an unbacked claim that tests passed", async () => {
    const { session } = await setup([
      reply(null, call("w", "write_file", { path: "n.md", content: "x\n" })),
      reply("done"), reply("All tests passed successfully!"), reply("All tests passed successfully!"),
    ]);
    const r = await session.run("x");
    expect(r.status).toBe("completed_unverified");
    expect(r.warnings.join(" ")).toMatch(/no passing test\/build command backs that up/);
  });

  it("does not count an `echo` of a test command as verification", async () => {
    const { session } = await setup([
      reply(null, call("w", "write_file", { path: "n.md", content: "x\n" })),
      reply(null, call("e", "run_command", { command: "echo npm test passed" })),
      reply("done"), reply("done"), reply("done"),
    ]);
    const r = await session.run("x");
    expect(r.status).toBe("completed_unverified");
  });

  it("does not require verification for read-only tasks", async () => {
    const { session, provider } = await setup([reply(null, call("l", "list_files", {})), reply("It has one file.")]);
    const r = await session.run("explain");
    expect(r.status).toBe("completed");
    expect(r.verification).toBe("not_needed");
    expect(provider.requests).toHaveLength(2);
  });

  it("does not run a blocked command and does not count it as verification", async () => {
    const { session, root } = await setup([
      reply(null, call("w", "write_file", { path: "n.md", content: "x\n" })),
      reply(null, call("b", "run_command", { command: "rm -rf /" })),
      reply("done"), reply("done"), reply("done"),
    ]);
    const r = await session.run("x");
    expect(session.messages.find((m) => m.tool_call_id === "b")!.content).toMatch(/COMMAND NOT RUN/);
    expect(r.commands.find((c) => c.command === "rm -rf /")!.notRun).toBe(true);
    await fs.stat(path.join(root, "n.md"));
  });
});

describe("step budget, loops, cancellation and errors", () => {
  it("stops at the step budget, withholds tools on the wrap-up step, and reports max_steps", async () => {
    const { session, provider } = await setup([], { maxSteps: 4, onExhausted: () => reply(null, call(`id${Math.random()}`, "list_files", {})) });
    const r = await session.run("never ending");
    expect(r.status).toBe("max_steps");
    expect(provider.requests).toHaveLength(4);
    expect(provider.requests[0]!.tools.length).toBeGreaterThan(0);
    expect(provider.requests[3]!.tools).toHaveLength(0); // wrap-up step
    expect(r.summary).toMatch(/step budget/);
    assertValidOrdering(session.messages);
  });

  it("with a wrap-up summary but unfinished work, still reports max_steps rather than success", async () => {
    const { session } = await setup([
      reply(null, call("w", "write_file", { path: "n.md", content: "x" })),
      reply("I ran out of steps; wrote n.md but did not test."),
    ], { maxSteps: 2 });
    const r = await session.run("x");
    expect(r.status).toBe("max_steps");
    expect(r.verification).toBe("not_run");
  });

  it("works with maxSteps = 1", async () => {
    const { session } = await setup([reply(null, call("l", "list_files", {}))], { maxSteps: 1 });
    const r = await session.run("x");
    expect(r.status).toBe("max_steps");
    assertValidOrdering(session.messages);
  });

  it("stops an agent that repeats the same failing action unchanged", async () => {
    const { session, provider } = await setup([], { maxSteps: 20, onExhausted: () => reply(null, call(`r${Math.random()}`, "read_file", { path: "missing.txt" })) });
    const r = await session.run("x");
    expect(r.status).toBe("failed");
    expect(provider.requests.length).toBeLessThan(20);
    expect(session.messages.some((m) => m.role === "tool" && /already failed 2 times/.test(m.content ?? ""))).toBe(true);
    assertValidOrdering(session.messages);
  });

  it("allows re-running a failing command after a file change", async () => {
    const { session } = await setup([
      reply(null, call("t1", "run_command", { command: "node --test" })),
      reply(null, call("t2", "run_command", { command: "node --test" })),
      reply(null, call("e", "edit_file", { path: "a.test.js", old_text: "throw new Error('boom');", new_text: "" })),
      reply(null, call("t3", "run_command", { command: "node --test" })),
      reply("ok"),
    ], { files: { "a.test.js": FAILING_TEST } });
    const r = await session.run("x");
    expect(session.messages.filter((m) => m.role === "tool").some((m) => /already failed/.test(m.content ?? ""))).toBe(false);
    expect(r.status).toBe("completed");
    expect(r.verification).toBe("passed");
  });

  it("returns an ERROR result (not a crash) when the provider fails, without leaking the key", async () => {
    const { session } = await setup([new ProviderError("Cannot reach the model endpoint sk-topsecret-key-123456", "unreachable", false)]);
    const r = await session.run("x");
    expect(r.status).toBe("error");
    expect(r.summary).toMatch(/ERROR/);
    expect(JSON.stringify(r)).not.toContain("sk-topsecret-key-123456");
  });

  it("can continue after an error with a consistent history", async () => {
    const { session } = await setup([new ProviderError("down", "server", false), reply("back")]);
    expect((await session.run("first")).status).toBe("error");
    expect((await session.run("second")).status).toBe("completed");
  });

  it("cancels via AbortSignal and still answers every pending tool call", async () => {
    const ac = new AbortController();
    const { session } = await setup([
      (() => { ac.abort(); return reply(null, call("c1", "list_files", {}), call("c2", "list_files", {})); }),
    ]);
    const r = await session.run("x", ac.signal);
    expect(r.status).toBe("cancelled");
    const tools = session.messages.filter((m) => m.role === "tool");
    expect(tools.map((t) => t.tool_call_id)).toEqual(["c1", "c2"]);
    assertValidOrdering(session.messages);
  });

  it("redacts the API key from tool output sent to the model", async () => {
    const { session } = await setup([reply(null, call("r", "read_file", { path: "k.txt" })), reply("ok")], { files: { "k.txt": "token=sk-topsecret-key-123456" } });
    await session.run("x");
    expect(session.messages.find((m) => m.role === "tool")!.content).not.toContain("sk-topsecret-key-123456");
  });
});

describe("session management", () => {
  it("keeps history across tasks and /clear resets it", async () => {
    const { session, provider } = await setup([reply("one"), reply("two"), reply("three")]);
    await session.run("first");
    await session.run("second");
    expect(provider.requests[1]!.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    session.clear();
    expect(session.messages).toHaveLength(1);
    await session.run("third");
    expect(provider.requests[2]!.messages.map((m) => m.role)).toEqual(["system", "user"]);
  });

  it("system prompt names the real tools and the workspace", async () => {
    const { session, workspace } = await setup([reply("x")]);
    const sys = session.messages[0]!.content!;
    expect(sys).toContain(workspace.root);
    expect(sys).toMatch(/list_files, read_file, write_file, edit_file, delete_file, search_text, run_command/);
  });

  it("elides old tool output when the context budget is exceeded", async () => {
    const big = "L".repeat(5000);
    const script: Scripted[] = [];
    for (let i = 0; i < 6; i++) script.push(reply(null, call(`r${i}`, "read_file", { path: "big.txt" })));
    script.push(reply("done"));
    const root = await tempDir();
    await fs.writeFile(path.join(root, "big.txt"), big);
    const workspace = await Workspace.create(root);
    const state = new TaskState();
    const provider = new ScriptedProvider(script);
    const session = new AgentSession({
      provider, state, logger: nullLogger, maxSteps: 10, workspaceRoot: root, platformInfo: "t", shellInfo: "sh", maxContextChars: 12_000,
      tools: createTools({ workspace, state, approver: async () => true, commandTimeoutMs: 5000, maxOutputChars: 5000, shell: "auto" }),
    });
    await session.run("x");
    expect(session.messages.some((m) => m.role === "tool" && /elided/.test(m.content ?? ""))).toBe(true);
    assertValidOrdering(session.messages);
  });
});
