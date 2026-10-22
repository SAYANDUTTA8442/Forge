#!/usr/bin/env node
import { Command } from "commander";
import { createInterface, type Interface as Readline } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import os from "node:os";
import path from "node:path";
import { AgentSession, type AgentResult } from "./agent.js";
import { APPROVAL_MODES, SHELL_CHOICES, configWarnings, displayBaseUrl, getConfig, type ForgeConfig } from "./config.js";
import { createOpenAICompatibleProvider } from "./provider.js";
import { detectPlatform, selectShell, shellHint } from "./shell.js";
import { TaskState } from "./state.js";
import { createTools } from "./tools.js";
import { createConsoleLogger, createReadlineApprover, denyAll, paint, type Approver } from "./ui.js";
import { Workspace } from "./workspace.js";

const VERSION = "0.2.0";

const program = new Command();
program
  .name("forge")
  .description("A model-agnostic, CLI-first coding agent")
  .version(VERSION)
  .option("-w, --workspace <path>", "repository/workspace to operate in", process.cwd())
  .option("-m, --model <model>", "override configured model")
  .option("--max-steps <count>", "maximum model/tool loop steps per task")
  .option("--shell <shell>", `shell for run_command (${SHELL_CHOICES.join("|")})`)
  .option("--approval <mode>", `how sensitive actions are handled (${APPROVAL_MODES.join("|")})`)
  .argument("[task...]", "task to perform; omit to start interactive mode");

program.parse(process.argv);
const options = program.opts<{ workspace: string; model?: string; maxSteps?: string; shell?: string; approval?: string }>();
const initialTask = program.args.join(" ").trim();

const HELP = `Commands:
  /help    show this help
  /model   show the configured provider and model
  /clear   clear the conversation (and what Forge has read)
  /exit    quit (also /quit)
Anything else is sent to the agent as a task. Ctrl+C cancels a running task; press it twice at the prompt to exit.
Sensitive actions (deleting files, git push, installs, ...) ask for your approval; dangerous commands are always blocked.`;

function modelInfo(config: ForgeConfig): string {
  return `Provider endpoint: ${displayBaseUrl(config.baseUrl)}\nModel: ${config.model}\nProvider timeout: ${config.providerTimeoutMs}ms, retries: ${config.maxRetries}`;
}

async function main(): Promise<number> {
  const workspacePath = path.resolve(options.workspace);
  const base = getConfig(workspacePath);
  const config: ForgeConfig = { ...base };
  if (options.model) config.model = options.model;
  if (options.maxSteps !== undefined) {
    const n = Number(options.maxSteps);
    if (!Number.isInteger(n) || n < 1 || n > 100) throw new Error("--max-steps must be an integer between 1 and 100.");
    config.maxSteps = n;
  }
  if (options.shell !== undefined) {
    if (!(SHELL_CHOICES as readonly string[]).includes(options.shell)) throw new Error(`--shell must be one of: ${SHELL_CHOICES.join(", ")}.`);
    config.shell = options.shell as ForgeConfig["shell"];
  }
  if (options.approval !== undefined) {
    if (!(APPROVAL_MODES as readonly string[]).includes(options.approval)) throw new Error(`--approval must be one of: ${APPROVAL_MODES.join(", ")}.`);
    config.approval = options.approval as ForgeConfig["approval"];
  }

  const platform = detectPlatform();
  // Validate the shell choice for this OS up-front for a clear error.
  const shellKind = selectShell("echo", { platform, preferred: config.shell }).kind;

  const workspace = await Workspace.create(workspacePath);
  const logger = createConsoleLogger({ secrets: [config.apiKey] });

  let currentAbort: AbortController | undefined;
  const interactive = initialTask === "";
  const canPrompt = Boolean(stdin.isTTY && stdout.isTTY);
  // Task given on the command line + non-TTY stdin: no readline needed (approvals are denied).
  const rl: Readline | undefined = interactive || canPrompt ? createInterface({ input: stdin, output: stdout, terminal: canPrompt }) : undefined;
  // Non-TTY (piped) input: queue lines ourselves so none are lost when the stream ends early.
  const queued: string[] = [];
  let waiting: ((line: string | null) => void) | undefined;
  let inputClosed = false;
  if (rl && !canPrompt) {
    rl.on("line", (l) => { if (waiting) { const w = waiting; waiting = undefined; w(l); } else queued.push(l); });
    rl.on("close", () => { inputClosed = true; waiting?.(null); });
  }
  const nextLine = async (): Promise<string | null> => {
    if (canPrompt) return rl!.question(paint("1;32", "\nforge> ")).catch(() => null);
    if (queued.length) return queued.shift()!;
    if (inputClosed) return null;
    return new Promise((resolve) => { waiting = resolve; });
  };
  let approver: Approver = denyAll;
  if (config.approval === "ask" && rl && canPrompt) approver = createReadlineApprover(rl, logger, () => currentAbort?.signal);

  const state = new TaskState();
  const provider = createOpenAICompatibleProvider({
    baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model,
    timeoutMs: config.providerTimeoutMs, maxRetries: config.maxRetries,
  });
  const tools = createTools({
    workspace, state, approver, commandTimeoutMs: config.commandTimeoutMs,
    maxOutputChars: config.maxOutputChars, shell: config.shell,
  });
  const session = new AgentSession({
    provider, tools, state, logger, maxSteps: config.maxSteps, maxContextChars: config.maxContextChars,
    workspaceRoot: workspace.root,
    platformInfo: `${platform} (${os.type()} ${os.release()})`,
    shellInfo: `${shellKind} — ${shellHint(shellKind, platform)}`,
    secrets: [config.apiKey],
  });

  console.log(paint("1", `Forge Agent v${VERSION}`));
  console.log(`Workspace: ${workspace.root}`);
  console.log(`Model:     ${config.model} @ ${displayBaseUrl(config.baseUrl)}`);
  console.log(`Shell:     ${shellKind} (${platform}) | max steps: ${config.maxSteps} | approval: ${config.approval}${config.approval === "ask" && !canPrompt ? " (no terminal: sensitive actions will be denied)" : ""}`);
  console.log("Safety:    command filtering is a guardrail, NOT a sandbox. Use a disposable worktree/container for untrusted repos.");
  for (const w of configWarnings(config)) logger.warn(w);

  // ---- Ctrl+C handling ----
  let lastSigint = 0;
  const onSigint = () => {
    if (currentAbort && !currentAbort.signal.aborted) {
      logger.warn("Cancelling current task... (press Ctrl+C again to force exit)");
      currentAbort.abort();
      lastSigint = Date.now();
      return;
    }
    if (Date.now() - lastSigint < 2000 || !interactive) {
      console.log("\nBye.");
      process.exit(130);
    }
    lastSigint = Date.now();
    console.log("\n(Press Ctrl+C again or type /exit to quit.)");
    if (rl) rl.prompt();
  };
  rl?.on("SIGINT", onSigint);
  process.on("SIGINT", onSigint);

  const runTask = async (task: string): Promise<AgentResult> => {
    currentAbort = new AbortController();
    try {
      return await session.run(task, currentAbort.signal);
    } finally {
      currentAbort = undefined;
    }
  };

  try {
    if (!interactive) {
      const result = await runTask(initialTask);
      return result.status === "completed" ? 0 : result.status === "cancelled" ? 130 : 1;
    }

    console.log("Type a task, or /help. Use /exit to quit.");
    for (;;) {
      const line = await nextLine();
      if (line === null) break; // stdin closed
      const input = line.trim();
      if (!input) continue;
      if (input.startsWith("/")) {
        const cmd = input.split(/\s+/)[0]!.toLowerCase();
        if (cmd === "/exit" || cmd === "/quit") break;
        else if (cmd === "/help") console.log(HELP);
        else if (cmd === "/model") console.log(modelInfo(config));
        else if (cmd === "/clear") { session.clear(); console.log("Conversation cleared."); }
        else console.log(`Unknown command ${cmd}. Type /help.`);
        continue;
      }
      try {
        await runTask(input);
      } catch (error) {
        logger.error(`Unexpected agent error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    console.log("Bye.");
    return 0;
  } finally {
    rl?.close();
  }
}

main().then(
  (code) => { process.exitCode = code; process.exit(code); },
  (error) => {
    console.error(`\nForge failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
