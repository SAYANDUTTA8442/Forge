import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { classifyPath, Workspace } from "../src/workspace.js";
import { cleanupTempDirs, tempDir } from "./helpers.js";

afterEach(cleanupTempDirs);

async function trySymlink(target: string, link: string, type: "dir" | "file"): Promise<boolean> {
  try {
    await fs.symlink(target, link, type);
    return true;
  } catch (error) {
    // Windows without developer mode/admin cannot create symlinks.
    if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}

describe("Workspace path containment", () => {
  it("resolves paths inside the workspace, including not-yet-existing ones", async () => {
    const temp = await tempDir();
    const ws = await Workspace.create(temp);
    expect(await ws.resolveInside("src/new/index.ts")).toBe(path.join(ws.root, "src/new/index.ts"));
  });

  it("rejects parent traversal in several spellings", async () => {
    const ws = await Workspace.create(await tempDir());
    for (const p of ["../outside.txt", "a/../../outside.txt", "..", "a/b/../../../x"]) {
      await expect(ws.resolveInside(p), p).rejects.toThrow(/escapes/i);
    }
  });

  it("rejects absolute and drive-letter paths on every OS", async () => {
    const temp = await tempDir();
    const ws = await Workspace.create(temp);
    for (const p of [path.resolve(temp, "file.txt"), "/etc/passwd", "C:\\Windows\\system.ini", "C:foo.txt", "\\\\server\\share\\x"]) {
      await expect(ws.resolveInside(p), p).rejects.toThrow(/absolute/i);
    }
  });

  it("rejects empty paths and NUL bytes", async () => {
    const ws = await Workspace.create(await tempDir());
    await expect(ws.resolveInside("")).rejects.toThrow();
    await expect(ws.resolveInside("a\0b")).rejects.toThrow(/NUL/);
  });

  it("rejects writes through a directory symlink that escapes", async () => {
    const temp = await tempDir();
    const outside = await tempDir("forge-outside-");
    const ws = await Workspace.create(temp);
    if (!(await trySymlink(outside, path.join(temp, "link"), "dir"))) return;
    await expect(ws.resolveInside("link/new.txt")).rejects.toThrow(/escapes/i);
    await expect(ws.resolveInside("link")).rejects.toThrow(/escapes/i);
  });

  it("rejects a file symlink that points outside", async () => {
    const temp = await tempDir();
    const outside = await tempDir("forge-outside-");
    await fs.writeFile(path.join(outside, "secret.txt"), "secret");
    const ws = await Workspace.create(temp);
    if (!(await trySymlink(path.join(outside, "secret.txt"), path.join(temp, "s.txt"), "file"))) return;
    await expect(ws.resolveInside("s.txt")).rejects.toThrow(/escapes/i);
  });

  it("rejects a dangling symlink (writing through it would create the external target)", async () => {
    const temp = await tempDir();
    const outside = await tempDir("forge-outside-");
    const ws = await Workspace.create(temp);
    if (!(await trySymlink(path.join(outside, "does-not-exist.txt"), path.join(temp, "dangling.txt"), "file"))) return;
    await expect(ws.resolveInside("dangling.txt")).rejects.toThrow(/dangling|escapes/i);
  });

  it("allows symlinks that stay inside the workspace", async () => {
    const temp = await tempDir();
    const ws = await Workspace.create(temp);
    await fs.mkdir(path.join(temp, "real"));
    if (!(await trySymlink(path.join(temp, "real"), path.join(temp, "alias"), "dir"))) return;
    await expect(ws.resolveInside("alias/x.txt")).resolves.toBeTruthy();
  });

  it("rejects a workspace that is not a directory", async () => {
    const temp = await tempDir();
    await fs.writeFile(path.join(temp, "f.txt"), "x");
    await expect(Workspace.create(path.join(temp, "f.txt"))).rejects.toThrow();
  });
});

describe("classifyPath", () => {
  it("forbids .git and node_modules, flags secrets as sensitive", () => {
    expect(classifyPath(".git/config")).toBe("forbidden");
    expect(classifyPath("a/node_modules/x.js")).toBe("forbidden");
    expect(classifyPath(".env")).toBe("sensitive");
    expect(classifyPath("config/.env.production")).toBe("sensitive");
    expect(classifyPath(".github/workflows/ci.yml")).toBe("sensitive");
    expect(classifyPath("src/index.ts")).toBe("normal");
  });
});
