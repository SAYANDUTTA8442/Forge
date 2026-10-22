import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";
import { Workspace } from "./workspace.js";

export type ToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(args: unknown): Promise<string>;
};

const ReadArgs = z.object({ path: z.string().min(1) });
const ListArgs = z.object({ path: z.string().default(".") });
const WriteArgs = z.object({ path: z.string().min(1), content: z.string() });
const SearchArgs = z.object({ query: z.string().min(1), path: z.string().default(".") });
const ShellArgs = z.object({ command: z.string().min(1) });

const riskyPatterns = [
  /(^|[;&|]\s*)sudo\b/i,
  /\brm\s+-[^\n]*r[^\n]*f|\brm\s+-[^\n]*f[^\n]*r/i,
  /\bmkfs\b|\bdd\s+if=|\bshutdown\b|\breboot\b/i,
  /\bgit\s+(push|reset|clean)\b/i,
  /\b(curl|wget)\b[^|]*\|\s*(sh|bash)\b/i,
  />\s*\/dev\/(sd|nvme)/i,
  /\bchmod\s+(-R\s+)?777\b/i,
];

function jsonSchema(properties: Record<string, unknown>, required: string[] = []) {
  return { type: "object", properties, required, additionalProperties: false };
}

export function createTools(workspace: Workspace, timeoutMs: number): ToolDefinition[] {
  return [
    {
      name: "list_files",
      description: "List files and directories in the workspace. Use a relative path; defaults to root.",
      parameters: jsonSchema({ path: { type: "string" } }),
      async execute(raw) {
        const { path: rel } = ListArgs.parse(raw);
        const full = await workspace.resolveInside(rel);
        const entries = await fs.readdir(full, { withFileTypes: true });
        return entries.slice(0, 200).map((e) => `${e.isDirectory() ? "dir " : "file"} ${e.name}`).join("\n") || "(empty directory)";
      },
    },
    {
      name: "read_file",
      description: "Read a UTF-8 text file from the workspace. Large files are truncated.",
      parameters: jsonSchema({ path: { type: "string" } }, ["path"]),
      async execute(raw) {
        const { path: rel } = ReadArgs.parse(raw);
        const full = await workspace.resolveInside(rel);
        const content = await fs.readFile(full, "utf8");
        return content.length > 24000 ? `${content.slice(0, 24000)}\n...[truncated]` : content;
      },
    },
    {
      name: "write_file",
      description: "Create or replace a UTF-8 text file inside the workspace. Inspect existing files before replacing them.",
      parameters: jsonSchema({ path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
      async execute(raw) {
        const { path: rel, content } = WriteArgs.parse(raw);
        const full = await workspace.resolveInside(rel);
        await fs.mkdir(path.dirname(full), { recursive: true });
        await fs.writeFile(full, content, { encoding: "utf8", flag: "w" });
        return `Wrote ${rel} (${content.length} characters).`;
      },
    },
    {
      name: "search_text",
      description: "Search text in workspace files using a literal substring. Skips node_modules, .git, dist, and binary/unreadable files.",
      parameters: jsonSchema({ query: { type: "string" }, path: { type: "string" } }, ["query"]),
      async execute(raw) {
        const { query, path: rel } = SearchArgs.parse(raw);
        const start = await workspace.resolveInside(rel);
        const results: string[] = [];
        let visited = 0;
        async function walk(dir: string): Promise<void> {
          if (results.length >= 80 || visited >= 1500) return;
          let entries;
          try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
          for (const entry of entries) {
            if (results.length >= 80 || visited >= 1500) return;
            if (entry.name.startsWith(".") && [".git", ".forge"].includes(entry.name)) continue;
            if (["node_modules", "dist", "build", "coverage"].includes(entry.name)) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) await walk(full);
            else if (entry.isFile()) {
              visited++;
              try {
                const stat = await fs.stat(full);
                if (stat.size > 500_000) continue;
                const content = await fs.readFile(full, "utf8");
                if (content.includes("\0")) continue;
                content.split(/\r?\n/).forEach((line, index) => {
                  if (line.includes(query) && results.length < 80) {
                    results.push(`${path.relative(workspace.root, full)}:${index + 1}: ${line.trim().slice(0, 240)}`);
                  }
                });
              } catch { /* skip unreadable or binary files */ }
            }
          }
        }
        await walk(start);
        return results.join("\n") || `No matches for "${query}".`;
      },
    },
    {
      name: "run_command",
      description: "Run a shell command in the workspace. Use for tests, builds, and inspection. Destructive/high-risk command patterns are blocked; commands time out and output is capped.",
      parameters: jsonSchema({ command: { type: "string" } }, ["command"]),
      async execute(raw) {
        const { command } = ShellArgs.parse(raw);
        if (riskyPatterns.some((pattern) => pattern.test(command))) {
          throw new Error("Blocked by Forge safety policy: command matches a high-risk pattern. Perform this action manually if you truly intend it.");
        }
        return await new Promise<string>((resolve) => {
          const child = spawn("/bin/sh", ["-lc", command], {
            cwd: workspace.root,
            env: { ...process.env, FORGE_AGENT: "1" },
            stdio: ["ignore", "pipe", "pipe"],
          });
          let output = "";
          let timedOut = false;
          const append = (chunk: Buffer) => {
            if (output.length < 18000) output += chunk.toString("utf8").slice(0, 18000 - output.length);
          };
          child.stdout.on("data", append);
          child.stderr.on("data", (chunk: Buffer) => append(chunk));
          const timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
            setTimeout(() => child.kill("SIGKILL"), 1500).unref();
          }, timeoutMs);
          child.on("error", (error) => {
            clearTimeout(timer);
            resolve(`Failed to start command: ${error.message}`);
          });
          child.on("close", (code) => {
            clearTimeout(timer);
            resolve(`$ ${command}\n${timedOut ? `[Timed out after ${timeoutMs}ms]\n` : ""}exit code: ${code ?? "unknown"}\n${output || "(no output)"}`);
          });
        });
      },
    },
  ];
}