import { createHash } from "node:crypto";

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export type ChangeKind = "created" | "modified" | "deleted";

export type CommandRecord = {
  command: string;
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  /** True when the command looks like a test/build/typecheck/lint run. */
  verification: boolean;
  /** Not executed (blocked by policy or approval denied). */
  notRun: boolean;
  seq: number;
  summary: string;
};

export type ActionRecord = { step: number; tool: string; ok: boolean; summary: string };

/**
 * Ground truth about what the agent actually did. The final report is generated from this record,
 * never from what the model claims.
 */
export class TaskState {
  task = "";
  private seq = 0;
  private lastChangeSeq = 0;
  readonly changes = new Map<string, ChangeKind>();
  readonly commands: CommandRecord[] = [];
  readonly actions: ActionRecord[] = [];
  /** path -> hash of the content the model last saw. Persists across tasks within a session. */
  readonly readSnapshots = new Map<string, string>();

  beginTask(task: string): void {
    this.task = task;
    this.changes.clear();
    this.commands.length = 0;
    this.actions.length = 0;
    this.lastChangeSeq = this.seq; // anything verified before this task does not count
  }

  reset(): void {
    this.beginTask("");
    this.readSnapshots.clear();
  }

  recordChange(path: string, kind: ChangeKind): void {
    const previous = this.changes.get(path);
    // created then modified stays "created"; created then deleted cancels out.
    if (previous === "created" && kind === "modified") kind = "created";
    if (previous === "created" && kind === "deleted") this.changes.delete(path);
    else this.changes.set(path, kind);
    this.lastChangeSeq = ++this.seq;
  }

  recordCommand(rec: Omit<CommandRecord, "seq">): CommandRecord {
    const full = { ...rec, seq: ++this.seq };
    this.commands.push(full);
    return full;
  }

  recordAction(a: ActionRecord): void {
    this.actions.push(a);
  }

  /** Monotonic counter that changes whenever a file changes (used to reset repeat-failure tracking). */
  get changeSeq(): number {
    return this.lastChangeSeq;
  }

  get hasChanges(): boolean {
    return this.changes.size > 0;
  }

  /** Most recent verification command that actually ran. */
  get lastVerification(): CommandRecord | undefined {
    for (let i = this.commands.length - 1; i >= 0; i--) {
      const c = this.commands[i]!;
      if (c.verification && !c.notRun) return c;
    }
    return undefined;
  }

  /** Verification that ran AFTER the latest file change. */
  get freshVerification(): CommandRecord | undefined {
    const v = this.lastVerification;
    return v && v.seq > this.lastChangeSeq ? v : undefined;
  }

  get anyVerificationPassed(): boolean {
    return this.commands.some((c) => c.verification && c.ok);
  }
}
