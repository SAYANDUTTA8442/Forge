import path from "node:path";
import fs from "node:fs/promises";

function escapes(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
}

export class Workspace {
  readonly root: string;

  private constructor(root: string) {
    this.root = root;
  }

  static async create(root: string): Promise<Workspace> {
    const resolved = await fs.realpath(path.resolve(root));
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) throw new Error(`Workspace is not a directory: ${resolved}`);
    return new Workspace(resolved);
  }

  /**
   * Resolves a workspace-relative path and guarantees that neither the lexical path nor the
   * real (symlink-resolved) path leaves the workspace. Works for paths that do not exist yet.
   */
  async resolveInside(relativePath: string): Promise<string> {
    if (typeof relativePath !== "string" || relativePath.length === 0) throw new Error("Path must be a non-empty string.");
    if (relativePath.includes("\0")) throw new Error("Path contains a NUL byte.");
    if (path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath) || /^[a-zA-Z]:/.test(relativePath)) {
      throw new Error("Absolute paths are not allowed.");
    }
    const candidate = path.resolve(this.root, relativePath);
    if (escapes(this.root, candidate)) throw new Error("Path escapes the selected workspace.");

    // Resolve the nearest existing ancestor so writes cannot pass through a symlink that
    // points outside the workspace.
    let ancestor = candidate;
    for (;;) {
      try {
        const realAncestor = await fs.realpath(ancestor);
        if (escapes(this.root, realAncestor)) throw new Error("Resolved path escapes the selected workspace (symlink).");
        return candidate;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
        // realpath fails with ENOENT for a *dangling* symlink too; writing through one would
        // create its (possibly external) target, so refuse it explicitly.
        const lst = await fs.lstat(ancestor).catch(() => null);
        if (lst?.isSymbolicLink()) throw new Error("Path is a dangling symlink; refusing to follow it.");
        const parent = path.dirname(ancestor);
        if (parent === ancestor) throw error;
        ancestor = parent;
      }
    }
  }

  /** Workspace-relative path with forward slashes, for display and for the model. */
  relative(full: string): string {
    return path.relative(this.root, full).split(path.sep).join("/") || ".";
  }
}

/** Paths the agent must never write or delete, and paths that need explicit approval. */
export function classifyPath(rel: string): "forbidden" | "sensitive" | "normal" {
  const parts = rel.split(/[\\/]+/).filter(Boolean).map((p) => p.toLowerCase());
  if (parts.includes(".git")) return "forbidden";
  if (parts.includes(".forge")) return "forbidden";
  const base = parts[parts.length - 1] ?? "";
  if (base === ".env" || base.startsWith(".env.") || /\.(pem|key|p12|pfx)$/.test(base) || base === ".npmrc" || base === "id_rsa") return "sensitive";
  if (parts.includes(".github") && parts.includes("workflows")) return "sensitive";
  if (parts.includes("node_modules")) return "forbidden";
  return "normal";
}
