import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ShellChoice } from "./config.js";
import { unifiedDiff } from "./diff.js";
import { evaluateCommand, isVerificationCommand } from "./policy.js";
import { formatRunResult, runCommand } from "./shell.js";
import { sha256, type TaskState } from "./state.js";
import type { Approver } from "./ui.js";
import { classifyPath, Workspace } from "./workspace.js";

export type ToolResult = { ok: boolean; output: string };

export type ToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Validates `raw` (untrusted model output) and executes. Validation errors throw ToolInputError. */
  execute(raw: unknown, ctx: { signal?: AbortSignal }): Promise<ToolResult>;
};

/** Thrown for bad model-supplied arguments; the message is safe and useful to show the model. */
export class ToolInputError extends Error {}

export type ToolDeps = {
  workspace: Workspace;
  state: TaskState;
  approver: Approver;
  commandTimeoutMs: number;
  maxOutputChars: number;
  shell: ShellChoice;
  /** Max characters returned by read_file in one call. */
  maxReadChars?: number;
};

const ReadArgs = z.object({ path: z.string().min(1), start_line: z.number().int().min(1).optional(), end_line: z.number().int().min(1).optional() });
const ListArgs = z.object({ path: z.string().default(".") });
const WriteArgs = z.object({ path: z.string().min(1), content: z.string().max(400_000) });
const EditArgs = z.object({ path: z.string().min(1), old_text: z.string().min(1), new_text: z.string(), replace_all: z.boolean().optional() });
const DeleteArgs = z.object({ path: z.string().min(1) });
const SearchArgs = z.object({ query: z.string().min(1), path: z.string().default(".") });
const ShellArgs = z.object({ command: z.string().min(1) });

function schema(properties: Record<string, unknown>, required: string[] = []) {
  return { type: "object", properties, required, additionalProperties: false };
}

function validate<T extends z.ZodTypeAny>(toolName: string, parser: T, raw: unknown, shape: string): z.infer<T> {
  const result = parser.safeParse(raw ?? {});
  if (result.success) return result.data;
  const problems = result.error.issues.map((i) => `${i.path.join(".") || "arguments"}: ${i.message}`).join("; ");
  throw new ToolInputError(`Invalid arguments for ${toolName}: ${problems}. Expected a JSON object like ${shape}`);
}

const detectEol = (text: string): "\r\n" | "\n" => (text.includes("\r\n") ? "\r\n" : "\n");
const toLf = (text: string) => text.replace(/\r\n/g, "\n");
const withEol = (text: string, eol: "\r\n" | "\n") => (eol === "\r\n" ? text.replace(/\r?\n/g, "\r\n") : text);

export function createTools(deps: ToolDeps): ToolDefinition[] {
  const { workspace, state } = deps;
  const maxRead = deps.maxReadChars ?? 12_000;

  async function statOrNull(p: string) {
    return fs.lstat(p).catch(() => null);
  }

  async function checkWritable(rel: string, full: string, verb: string): Promise<void> {
    const kind = classifyPath(rel);
    if (kind === "forbidden") throw new ToolInputError(`Refusing to ${verb} "${rel}": this location (.git, .forge, node_modules) is protected.`);
    if (kind === "sensitive") {
      const ok = await deps.approver({ title: `${verb} sensitive file`, detail: rel });
      if (!ok) throw new ToolInputError(`Not done: approval was denied for ${verb} "${rel}" (sensitive file).`);
    }
    void full;
  }

  const tools: ToolDefinition[] = [
    {
      name: "list_files",
      description: "List files and directories in a workspace directory. Use a relative path; defaults to the workspace root.",
      parameters: schema({ path: { type: "string", description: "Relative directory path, e.g. src" } }),
      async execute(raw) {
        const { path: rel } = validate("list_files", ListArgs, raw, '{"path": "src"}');
        const full = await workspace.resolveInside(rel);
        const entries = await fs.readdir(full, { withFileTypes: true });
        entries.sort((a, b) => a.name.localeCompare(b.name));
        const lines = entries.slice(0, 200).map((e) => `${e.isDirectory() ? "dir " : e.isSymbolicLink() ? "link" : "file"} ${e.name}`);
        if (entries.length > 200) lines.push(`... ${entries.length - 200} more entries`);
        return { ok: true, output: lines.join("\n") || "(empty directory)" };
      },
    },
    {
      name: "read_file",
      description: "Read a UTF-8 text file in the workspace. Optionally pass start_line/end_line (1-based) to read part of a large file.",
      parameters: schema({ path: { type: "string" }, start_line: { type: "integer" }, end_line: { type: "integer" } }, ["path"]),
      async execute(raw) {
        const a = validate("read_file", ReadArgs, raw, '{"path": "src/index.ts"}');
        const full = await workspace.resolveInside(a.path);
        const stat = await fs.stat(full);
        if (!stat.isFile()) throw new ToolInputError(`"${a.path}" is not a regular file.`);
        if (stat.size > 5_000_000) throw new ToolInputError(`"${a.path}" is too large (${stat.size} bytes). Use search_text or read a line range of a smaller file.`);
        const content = await fs.readFile(full, "utf8");
        if (content.includes("\0")) throw new ToolInputError(`"${a.path}" looks like a binary file.`);
        state.readSnapshots.set(workspace.relative(full), sha256(content));
        const lines = toLf(content).split("\n");
        if (a.start_line !== undefined || a.end_line !== undefined) {
          const start = a.start_line ?? 1;
          const end = Math.min(a.end_line ?? lines.length, lines.length);
          if (start > lines.length) throw new ToolInputError(`start_line ${start} is beyond the end of the file (${lines.length} lines).`);
          const slice = lines.slice(start - 1, end).join("\n");
          return { ok: true, output: `[lines ${start}-${end} of ${lines.length}]\n${slice.slice(0, maxRead)}` };
        }
        const text = toLf(content);
        if (text.length > maxRead) {
          return { ok: true, output: `${text.slice(0, maxRead)}\n...[truncated at ${maxRead} of ${text.length} characters; use start_line/end_line to read more]` };
        }
        return { ok: true, output: text };
      },
    },
    {
      name: "write_file",
      description: "Create a new file or fully replace an existing one. Existing files must be read with read_file first. For small changes prefer edit_file. Returns a diff.",
      parameters: schema({ path: { type: "string" }, content: { type: "string", description: "Complete new file content" } }, ["path", "content"]),
      async execute(raw) {
        const a = validate("write_file", WriteArgs, raw, '{"path": "src/a.ts", "content": "..."}');
        const full = await workspace.resolveInside(a.path);
        const rel = workspace.relative(full);
        await checkWritable(rel, full, "write");
        const existing = await statOrNull(full);
        let before = "";
        let eol: "\r\n" | "\n" = "\n";
        if (existing) {
          if (!existing.isFile()) throw new ToolInputError(`"${rel}" exists and is not a regular file.`);
          const current = await fs.readFile(full, "utf8");
          const seen = state.readSnapshots.get(rel);
          if (seen === undefined) {
            throw new ToolInputError(`"${rel}" already exists and has not been inspected. Call read_file on it first (or use edit_file for a targeted change).`);
          }
          if (seen !== sha256(current)) {
            throw new ToolInputError(`"${rel}" changed on disk since you last read it (possibly edited by the user). Call read_file again and merge, instead of overwriting.`);
          }
          before = toLf(current);
          eol = detectEol(current);
          if (before.length >= 400 && a.content.length < before.length * 0.3) {
            const ok = await deps.approver({ title: "replace file with much smaller content", detail: `${rel}: ${before.length} -> ${a.content.length} characters` });
            if (!ok) throw new ToolInputError(`Not written: approval was denied for shrinking "${rel}" by more than 70%. Use edit_file for targeted changes.`);
          }
        }
        const newText = toLf(a.content);
        await fs.mkdir(path.dirname(full), { recursive: true });
        // Re-validate after mkdir: parents now exist, so symlink checks see the real path.
        await workspace.resolveInside(a.path);
        const onDisk = withEol(newText, eol);
        await fs.writeFile(full, onDisk, "utf8");
        const verify = await fs.readFile(full, "utf8");
        if (verify !== onDisk) throw new Error(`Write verification failed for "${rel}": file content on disk does not match what was written.`);
        state.readSnapshots.set(rel, sha256(verify));
        state.recordChange(rel, existing ? "modified" : "created");
        const diff = unifiedDiff(before, newText, rel);
        return { ok: true, output: `${existing ? "Updated" : "Created"} ${rel} (${newText.split("\n").length} lines, verified on disk).\n${diff}` };
      },
    },
    {
      name: "edit_file",
      description: "Replace exact text in an existing file. old_text must match exactly once (include enough surrounding lines to be unique), or set replace_all. Returns a diff. Preferred for small changes.",
      parameters: schema(
        { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" }, replace_all: { type: "boolean" } },
        ["path", "old_text", "new_text"],
      ),
      async execute(raw) {
        const a = validate("edit_file", EditArgs, raw, '{"path": "src/a.ts", "old_text": "foo", "new_text": "bar"}');
        const full = await workspace.resolveInside(a.path);
        const rel = workspace.relative(full);
        await checkWritable(rel, full, "edit");
        const stat = await statOrNull(full);
        if (!stat || !stat.isFile()) throw new ToolInputError(`"${rel}" does not exist or is not a regular file. Use write_file to create files.`);
        const current = await fs.readFile(full, "utf8");
        const eol = detectEol(current);
        const text = toLf(current);
        const oldText = toLf(a.old_text);
        const newText = toLf(a.new_text);
        if (oldText === newText) throw new ToolInputError("old_text and new_text are identical; nothing to change.");
        const count = text.split(oldText).length - 1;
        if (count === 0) throw new ToolInputError(`old_text was not found in "${rel}". Read the file again and copy the text exactly (whitespace matters).`);
        if (count > 1 && !a.replace_all) throw new ToolInputError(`old_text matches ${count} places in "${rel}". Add more surrounding context to make it unique, or set replace_all to true.`);
        const updated = a.replace_all ? text.split(oldText).join(newText) : text.replace(oldText, () => newText);
        const onDisk = withEol(updated, eol);
        await fs.writeFile(full, onDisk, "utf8");
        const verify = await fs.readFile(full, "utf8");
        if (verify !== onDisk) throw new Error(`Write verification failed for "${rel}".`);
        state.readSnapshots.set(rel, sha256(verify));
        state.recordChange(rel, "modified");
        return { ok: true, output: `Edited ${rel} (${count} replacement${count === 1 ? "" : "s"}, verified on disk).\n${unifiedDiff(text, updated, rel)}` };
      },
    },
    {
      name: "delete_file",
      description: "Delete ONE file in the workspace. Always requires the person's approval. Directories cannot be deleted.",
      parameters: schema({ path: { type: "string" } }, ["path"]),
      async execute(raw) {
        const a = validate("delete_file", DeleteArgs, raw, '{"path": "old/file.txt"}');
        const full = await workspace.resolveInside(a.path);
        const rel = workspace.relative(full);
        if (full === workspace.root) throw new ToolInputError("Cannot delete the workspace root.");
        const kind = classifyPath(rel);
        if (kind === "forbidden") throw new ToolInputError(`Refusing to delete "${rel}": this location is protected.`);
        const stat = await statOrNull(full);
        if (!stat) throw new ToolInputError(`"${rel}" does not exist.`);
        if (stat.isDirectory()) throw new ToolInputError(`"${rel}" is a directory. delete_file only removes single files.`);
        const ok = await deps.approver({ title: "delete file", detail: `${rel} (${stat.size} bytes)` });
        if (!ok) return { ok: false, output: `NOT DELETED: approval was denied for "${rel}". The file is unchanged.` };
        await fs.unlink(full);
        if (await statOrNull(full)) throw new Error(`Delete verification failed: "${rel}" still exists.`);
        state.readSnapshots.delete(rel);
        state.recordChange(rel, "deleted");
        return { ok: true, output: `Deleted ${rel}.` };
      },
    },
    {
      name: "search_text",
      description: "Search for a literal substring in workspace files. Skips node_modules, .git, dist, build, coverage and binary files. Returns path:line: text.",
      parameters: schema({ query: { type: "string" }, path: { type: "string" } }, ["query"]),
      async execute(raw) {
        const { query, path: rel } = validate("search_text", SearchArgs, raw, '{"query": "TODO", "path": "src"}');
        const start = await workspace.resolveInside(rel);
        const results: string[] = [];
        let visited = 0;
        const skip = new Set([".git", ".forge", "node_modules", "dist", "build", "coverage"]);
        async function walk(dir: string): Promise<void> {
          if (results.length >= 80 || visited >= 1500) return;
          const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
          for (const entry of entries) {
            if (results.length >= 80 || visited >= 1500) return;
            if (skip.has(entry.name)) continue;
            const child = path.join(dir, entry.name);
            if (entry.isDirectory()) await walk(child);
            else if (entry.isFile()) {
              visited++;
              try {
                const stat = await fs.stat(child);
                if (stat.size > 500_000) continue;
                const content = await fs.readFile(child, "utf8");
                if (content.includes("\0")) continue;
                content.split(/\r?\n/).forEach((line, index) => {
                  if (line.includes(query) && results.length < 80) results.push(`${workspace.relative(child)}:${index + 1}: ${line.trim().slice(0, 240)}`);
                });
              } catch { /* unreadable or binary */ }
            }
          }
        }
        const stat = await fs.stat(start);
        if (stat.isFile()) {
          const content = await fs.readFile(start, "utf8");
          content.split(/\r?\n/).forEach((line, i) => { if (line.includes(query) && results.length < 80) results.push(`${workspace.relative(start)}:${i + 1}: ${line.trim().slice(0, 240)}`); });
        } else {
          await walk(start);
        }
        return { ok: true, output: results.join("\n") || `No matches for "${query}".` };
      },
    },
    {
      name: "run_command",
      description:
        "Run a shell command in the workspace root and get its real exit code, stdout and stderr. Use for tests, builds and inspection (e.g. `npm test`). Dangerous commands are blocked; sensitive ones need approval; commands time out.",
      parameters: schema({ command: { type: "string", description: "Command line to run, e.g. npm test" } }, ["command"]),
      async execute(raw, ctx) {
        const { command } = validate("run_command", ShellArgs, raw, '{"command": "npm test"}');
        const verification = isVerificationCommand(command);
        const decision = evaluateCommand(command);
        const notRun = (why: string): ToolResult => {
          state.recordCommand({ command, ok: false, exitCode: null, timedOut: false, verification, notRun: true, summary: why });
          return { ok: false, output: `COMMAND NOT RUN: ${why}` };
        };
        if (decision.verdict === "block") return notRun(`blocked by Forge safety policy (${decision.reason}). Choose a safer approach; this is not available.`);
        if (decision.verdict === "approve") {
          const ok = await deps.approver({ title: `run sensitive command (${decision.reason})`, detail: command });
          if (!ok) return notRun(`approval was denied for a sensitive command (${decision.reason}).`);
        }
        const result = await runCommand({
          command,
          cwd: workspace.root,
          timeoutMs: deps.commandTimeoutMs,
          maxOutputChars: deps.maxOutputChars,
          preferredShell: deps.shell,
          signal: ctx.signal,
        });
        const didNotStart = result.error !== undefined;
        state.recordCommand({
          command,
          ok: result.ok,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          verification,
          notRun: didNotStart,
          summary: result.ok ? "exit 0" : result.cancelled ? "cancelled" : result.timedOut ? "timed out" : result.error ?? `exit ${result.exitCode}`,
        });
        return { ok: result.ok, output: formatRunResult(result) };
      },
    },
  ];
  return tools;
}
