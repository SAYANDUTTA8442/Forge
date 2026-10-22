import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { TaskState } from "../src/state.js";
import { createTools, ToolInputError, type ToolDefinition } from "../src/tools.js";
import { Workspace } from "../src/workspace.js";
import { cleanupTempDirs, tempDir } from "./helpers.js";

afterEach(cleanupTempDirs);

let ws: Workspace;
let state: TaskState;
let approver: ReturnType<typeof vi.fn>;
let tools: Map<string, ToolDefinition>;

beforeEach(async () => {
  ws = await Workspace.create(await tempDir());
  state = new TaskState();
  approver = vi.fn(async () => true);
  tools = new Map(createTools({ workspace: ws, state, approver, commandTimeoutMs: 20_000, maxOutputChars: 5000, shell: "auto" }).map((t) => [t.name, t]));
});

const run = (name: string, args: unknown) => tools.get(name)!.execute(args, {});
const file = (p: string) => path.join(ws.root, p);

describe("argument validation", () => {
  it("rejects missing and wrongly typed fields with a helpful message", async () => {
    await expect(run("write_file", { path: "a.txt" })).rejects.toThrow(/content: Required/);
    await expect(run("read_file", {})).rejects.toThrow(ToolInputError);
    await expect(run("read_file", { path: 42 })).rejects.toThrow(/path/);
    await expect(run("run_command", { command: "" })).rejects.toThrow(/command/);
    await expect(run("edit_file", { path: "a", old_text: "x" })).rejects.toThrow(/new_text/);
    await expect(run("write_file", null)).rejects.toThrow(/Expected a JSON object like/);
  });
});

describe("file tools", () => {
  it("creates a file (and parent directories) and verifies it on disk", async () => {
    const r = await run("write_file", { path: "src/deep/new.ts", content: "export const a = 1;\n" });
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/Created src\/deep\/new.ts/);
    expect(await fs.readFile(file("src/deep/new.ts"), "utf8")).toBe("export const a = 1;\n");
    expect(state.changes.get("src/deep/new.ts")).toBe("created");
  });

  it("refuses to overwrite an existing file that was not inspected", async () => {
    await fs.writeFile(file("a.txt"), "important");
    await expect(run("write_file", { path: "a.txt", content: "x" })).rejects.toThrow(/has not been inspected/);
    expect(await fs.readFile(file("a.txt"), "utf8")).toBe("important");
  });

  it("allows overwriting after read_file and returns a diff", async () => {
    await fs.writeFile(file("a.txt"), "one\ntwo\nthree\n");
    await run("read_file", { path: "a.txt" });
    const r = await run("write_file", { path: "a.txt", content: "one\nTWO\nthree\n" });
    expect(r.output).toContain("-two");
    expect(r.output).toContain("+TWO");
    expect(state.changes.get("a.txt")).toBe("modified");
  });

  it("refuses to clobber changes the user made after the model read the file", async () => {
    await fs.writeFile(file("a.txt"), "v1");
    await run("read_file", { path: "a.txt" });
    await fs.writeFile(file("a.txt"), "v2 edited by the user");
    await expect(run("write_file", { path: "a.txt", content: "mine" })).rejects.toThrow(/changed on disk/);
    expect(await fs.readFile(file("a.txt"), "utf8")).toBe("v2 edited by the user");
  });

  it("asks approval before replacing a file with much smaller content", async () => {
    await fs.writeFile(file("big.txt"), "x".repeat(1000));
    await run("read_file", { path: "big.txt" });
    approver.mockResolvedValueOnce(false);
    await expect(run("write_file", { path: "big.txt", content: "tiny" })).rejects.toThrow(/approval was denied/);
    expect(await fs.readFile(file("big.txt"), "utf8")).toHaveLength(1000);
  });

  it("blocks writes outside the workspace and into .git", async () => {
    await expect(run("write_file", { path: "../evil.txt", content: "x" })).rejects.toThrow(/escapes/);
    await expect(run("write_file", { path: "/tmp/evil.txt", content: "x" })).rejects.toThrow(/Absolute/);
    await expect(run("write_file", { path: ".git/hooks/pre-commit", content: "x" })).rejects.toThrow(/protected/);
    await expect(run("read_file", { path: "../../etc/passwd" })).rejects.toThrow(/escapes/);
  });

  it("requires approval for sensitive files like .env", async () => {
    approver.mockResolvedValueOnce(false);
    await expect(run("write_file", { path: ".env", content: "K=V" })).rejects.toThrow(/approval was denied/);
    await expect(fs.stat(file(".env"))).rejects.toThrow();
    approver.mockResolvedValueOnce(true);
    await run("write_file", { path: ".env", content: "K=V" });
    expect(approver).toHaveBeenCalledTimes(2);
  });

  it("edit_file replaces exactly one match and rejects ambiguous or missing text", async () => {
    await fs.writeFile(file("a.ts"), "const a = 1;\nconst b = 1;\n");
    await expect(run("edit_file", { path: "a.ts", old_text: "= 1", new_text: "= 2" })).rejects.toThrow(/matches 2 places/);
    await expect(run("edit_file", { path: "a.ts", old_text: "nope", new_text: "x" })).rejects.toThrow(/not found/);
    const r = await run("edit_file", { path: "a.ts", old_text: "const a = 1;", new_text: "const a = 2;" });
    expect(r.ok).toBe(true);
    expect(await fs.readFile(file("a.ts"), "utf8")).toBe("const a = 2;\nconst b = 1;\n");
    await run("edit_file", { path: "a.ts", old_text: "= ", new_text: "= 9 + ", replace_all: true });
    expect(await fs.readFile(file("a.ts"), "utf8")).toBe("const a = 9 + 2;\nconst b = 9 + 1;\n");
  });

  it("preserves CRLF line endings (Windows files) in edit_file and write_file", async () => {
    await fs.writeFile(file("w.txt"), "line1\r\nline2\r\nline3\r\n");
    await run("edit_file", { path: "w.txt", old_text: "line2\nline3", new_text: "LINE2\nline3" });
    expect(await fs.readFile(file("w.txt"), "utf8")).toBe("line1\r\nLINE2\r\nline3\r\n");
    await run("read_file", { path: "w.txt" });
    await run("write_file", { path: "w.txt", content: "a\nb\n" });
    expect(await fs.readFile(file("w.txt"), "utf8")).toBe("a\r\nb\r\n");
  });

  it("edit_file does not touch files outside the workspace or missing files", async () => {
    await expect(run("edit_file", { path: "missing.ts", old_text: "a", new_text: "b" })).rejects.toThrow(/does not exist/);
    await expect(run("edit_file", { path: "../x", old_text: "a", new_text: "b" })).rejects.toThrow(/escapes/);
  });

  it("read_file supports line ranges and truncation", async () => {
    await fs.writeFile(file("l.txt"), Array.from({ length: 50 }, (_, i) => `row${i + 1}`).join("\n"));
    const part = await run("read_file", { path: "l.txt", start_line: 10, end_line: 12 });
    expect(part.output).toContain("row10\nrow11\nrow12");
    expect(part.output).toContain("lines 10-12 of 50");
    await fs.writeFile(file("huge.txt"), "z".repeat(30_000));
    const big = await run("read_file", { path: "huge.txt" });
    expect(big.output).toMatch(/truncated/);
  });

  it("rejects binary files", async () => {
    await fs.writeFile(file("bin.dat"), Buffer.from([1, 2, 0, 3]));
    await expect(run("read_file", { path: "bin.dat" })).rejects.toThrow(/binary/);
  });

  it("list_files and search_text work and skip node_modules", async () => {
    await fs.mkdir(file("src"));
    await fs.mkdir(file("node_modules"));
    await fs.writeFile(file("src/a.ts"), "// TODO fix\n");
    await fs.writeFile(file("node_modules/b.ts"), "// TODO hidden\n");
    expect((await run("list_files", { path: "." })).output).toMatch(/dir\s+src/);
    const found = await run("search_text", { query: "TODO" });
    expect(found.output).toContain("src/a.ts:1");
    expect(found.output).not.toContain("node_modules");
    expect((await run("search_text", { query: "nothing-here" })).output).toMatch(/No matches/);
  });
});

describe("delete_file", () => {
  it("requires approval and leaves the file when denied", async () => {
    await fs.writeFile(file("x.txt"), "x");
    approver.mockResolvedValueOnce(false);
    const r = await run("delete_file", { path: "x.txt" });
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/NOT DELETED/);
    expect(await fs.readFile(file("x.txt"), "utf8")).toBe("x");
    expect(state.changes.size).toBe(0);
  });

  it("deletes after approval and records the change", async () => {
    await fs.writeFile(file("x.txt"), "x");
    const r = await run("delete_file", { path: "x.txt" });
    expect(r.ok).toBe(true);
    await expect(fs.stat(file("x.txt"))).rejects.toThrow();
    expect(state.changes.get("x.txt")).toBe("deleted");
  });

  it("refuses directories, the root, protected paths, and escapes", async () => {
    await fs.mkdir(file("dir"));
    await fs.mkdir(file(".git"));
    await fs.writeFile(file(".git/config"), "x");
    await expect(run("delete_file", { path: "dir" })).rejects.toThrow(/directory/);
    await expect(run("delete_file", { path: "." })).rejects.toThrow(/root/);
    await expect(run("delete_file", { path: ".git/config" })).rejects.toThrow(/protected/);
    await expect(run("delete_file", { path: "../x" })).rejects.toThrow(/escapes/);
    await expect(run("delete_file", { path: "nope.txt" })).rejects.toThrow(/does not exist/);
    expect(approver).not.toHaveBeenCalled();
  });
});

describe("run_command", () => {
  it("runs allowed commands and records real results", async () => {
    const ok = await run("run_command", { command: "node --version" });
    expect(ok.ok).toBe(true);
    expect(ok.output).toMatch(/SUCCEEDED/);
    const bad = await run("run_command", { command: "node -e \"process.exit(2)\"" });
    expect(bad.ok).toBe(false);
    expect(bad.output).toMatch(/FAILED \(exit code 2\)/);
    expect(state.commands.map((c) => c.ok)).toEqual([true, false]);
  });

  it("does not run blocked commands and says so", async () => {
    const r = await run("run_command", { command: "rm -rf /" });
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/COMMAND NOT RUN/);
    expect(approver).not.toHaveBeenCalled();
    expect(state.commands[0]).toMatchObject({ notRun: true, ok: false });
  });

  it("asks approval for sensitive commands and does not run them when denied", async () => {
    approver.mockResolvedValueOnce(false);
    await fs.writeFile(file("keep.txt"), "x");
    const r = await run("run_command", { command: "rm keep.txt" });
    expect(r.output).toMatch(/COMMAND NOT RUN.*approval was denied/);
    expect(await fs.readFile(file("keep.txt"), "utf8")).toBe("x");
  });

  it("runs in the workspace directory and flags verification commands", async () => {
    await fs.writeFile(file("a.test.js"), "require('node:test')('ok', () => {});\n");
    const r = await run("run_command", { command: "node --test" });
    expect(r.ok).toBe(true);
    expect(state.commands[0]!.verification).toBe(true);
  });

  it("enforces the command timeout", async () => {
    const quick = new Map(createTools({ workspace: ws, state, approver, commandTimeoutMs: 400, maxOutputChars: 5000, shell: "auto" }).map((t) => [t.name, t]));
    const r = await quick.get("run_command")!.execute({ command: "node -e \"setInterval(()=>{},1000)\"" }, {});
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/TIMED OUT/);
  });
});
