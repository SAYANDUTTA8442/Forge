#!/usr/bin/env node
import { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import path from "node:path";
import { getConfig } from "./config.js";
import { runAgent } from "./agent.js";
import { Workspace } from "./workspace.js";

const program = new Command();
program
  .name("forge")
  .description("A model-agnostic CLI coding agent")
  .version("0.1.0")
  .option("-w, --workspace <path>", "repository/workspace to operate in", process.cwd())
  .option("-m, --model <model>", "override configured model")
  .option("--max-steps <count>", "maximum model/tool loop steps")
  .argument("[task]", "task to perform; omit to start interactive mode");

program.parse(process.argv);
const options = program.opts<{ workspace: string; model?: string; maxSteps?: string }>();
const initialTask = program.args.join(" ").trim();

async function main() {
  const baseConfig = getConfig();
  const config = {
    ...baseConfig,
    model: options.model ?? baseConfig.model,
    maxSteps: options.maxSteps ? Number(options.maxSteps) : baseConfig.maxSteps,
  };
  if (!Number.isInteger(config.maxSteps) || config.maxSteps < 1 || config.maxSteps > 50) {
    throw new Error("--max-steps must be an integer between 1 and 50.");
  }

  const workspacePath = path.resolve(options.workspace);
  const workspace = await Workspace.create(workspacePath);
  console.log(`\x1b[1mForge Agent v0.1.0\x1b[0m`);
  console.log(`Workspace: ${workspace.root}`);
  console.log(`Model: ${config.model} (${config.baseUrl})`);
  console.log(`Max steps: ${config.maxSteps}`);
  console.log("Safety: high-risk shell patterns blocked; this is not an OS sandbox.");
  console.log("Type /exit to quit. Use a disposable git worktree for autonomous edits.");

  if (initialTask) {
    await runAgent(initialTask, workspace, config);
    return;
  }

  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  try {
    while (true) {
      const task = (await rl.question("\nforge> ")).trim();
      if (!task) continue;
      if (["/exit", "/quit"].includes(task)) break;
      if (task === "/help") {
        console.log("Enter a coding task, or /exit to quit. Each prompt starts a fresh context in this MVP.");
        continue;
      }
      try {
        await runAgent(task, workspace, config);
      } catch (error) {
        console.error(`\n\x1b[31mAgent error: ${error instanceof Error ? error.message : String(error)}\x1b[0m`);
      }
    }
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error(`\nForge failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});