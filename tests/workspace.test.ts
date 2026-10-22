import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Workspace } from "../src/workspace.js";

let temp = "";
afterEach(async () => {
  if (temp) await rm(temp, { recursive: true, force: true });
  temp = "";
});

describe("Workspace", () => {
  it("resolves paths inside the workspace", async () => {
    temp = await mkdtemp(path.join(os.tmpdir(), "forge-test-"));
    const ws = await Workspace.create(temp);
    expect(await ws.resolveInside("src/index.ts")).toBe(path.join(temp, "src/index.ts"));
  });

  it("rejects parent traversal", async () => {
    temp = await mkdtemp(path.join(os.tmpdir(), "forge-test-"));
    const ws = await Workspace.create(temp);
    await expect(ws.resolveInside("../outside.txt")).rejects.toThrow(/escapes/i);
  });

  it("rejects absolute paths", async () => {
    temp = await mkdtemp(path.join(os.tmpdir(), "forge-test-"));
    const ws = await Workspace.create(temp);
    await expect(ws.resolveInside(path.resolve(temp, "file.txt"))).rejects.toThrow(/absolute/i);
  });

  it("rejects writes through an escaping symlink", async () => {
    temp = await mkdtemp(path.join(os.tmpdir(), "forge-test-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "forge-outside-"));
    try {
      const ws = await Workspace.create(temp);
      await mkdir(path.join(temp, "link"));
      // Symlink test is intentionally platform-dependent.
      const fs = await import("node:fs/promises");
      await fs.rm(path.join(temp, "link"), { recursive: true, force: true });
      await fs.symlink(outside, path.join(temp, "link"), "dir");
      await expect(ws.resolveInside("link/new.txt")).rejects.toThrow(/escapes/i);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});