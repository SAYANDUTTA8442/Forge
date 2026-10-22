import path from "node:path";
import fs from "node:fs/promises";

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

  async resolveInside(relativePath: string): Promise<string> {
    if (path.isAbsolute(relativePath)) throw new Error("Absolute paths are not allowed.");
    const candidate = path.resolve(this.root, relativePath);
    const rel = path.relative(this.root, candidate);
    if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      throw new Error("Path escapes the selected workspace.");
    }

    // Resolve the nearest existing ancestor to prevent writes through symlinks
    // that point outside the workspace.
    let ancestor = candidate;
    while (true) {
      try {
        const realAncestor = await fs.realpath(ancestor);
        const realRel = path.relative(this.root, realAncestor);
        if (realRel === ".." || realRel.startsWith(`..${path.sep}`) || path.isAbsolute(realRel)) {
          throw new Error("Resolved path escapes the selected workspace.");
        }
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const parent = path.dirname(ancestor);
        if (parent === ancestor) throw error;
        ancestor = parent;
      }
    }
    return candidate;
  }
}