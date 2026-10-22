import { spawn, type ChildProcess } from "node:child_process";
import type { ShellChoice } from "./config.js";

export type Platform = "windows" | "linux" | "macos";

export function detectPlatform(nodePlatform: NodeJS.Platform = process.platform): Platform {
  if (nodePlatform === "win32") return "windows";
  if (nodePlatform === "darwin") return "macos";
  return "linux";
}

export type ShellKind = "cmd" | "powershell" | "pwsh" | "sh" | "bash" | "zsh";

export type ShellInvocation = {
  kind: ShellKind;
  executable: string;
  args: string[];
  /** Windows cmd.exe needs raw (unquoted-by-Node) arguments. */
  windowsVerbatimArguments: boolean;
};

/** PowerShell wrapper that makes the process exit code reflect the user's command. */
export function wrapPowerShell(command: string): string {
  return [
    "$ProgressPreference = 'SilentlyContinue'",
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "$global:LASTEXITCODE = 0",
    command,
    "$__forge_ok = $?",
    "$__forge_code = $LASTEXITCODE",
    "if ($__forge_code -is [int] -and $__forge_code -ne 0) { exit $__forge_code }",
    "if (-not $__forge_ok) { exit 1 }",
    "exit 0",
  ].join("\n");
}

export function encodePowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

/**
 * Chooses the executable + argument vector for a command string. Pure function (platform and
 * environment are injected) so Windows selection can be unit-tested on any OS.
 */
export function selectShell(
  command: string,
  opts: { platform?: Platform; preferred?: ShellChoice; env?: Record<string, string | undefined> } = {},
): ShellInvocation {
  const platform = opts.platform ?? detectPlatform();
  const preferred = opts.preferred ?? "auto";
  const env = opts.env ?? process.env;

  if (platform === "windows") {
    const kind: ShellKind = preferred === "cmd" || preferred === "pwsh" ? preferred : "powershell";
    if (preferred !== "auto" && !["cmd", "powershell", "pwsh"].includes(preferred)) {
      throw new Error(`Shell "${preferred}" is not available on Windows. Use cmd, powershell, or pwsh (FORGE_SHELL).`);
    }
    if (kind === "cmd") {
      const executable = env.ComSpec || env.COMSPEC || "cmd.exe";
      // `/d` skips AutoRun, `/s` + outer quotes preserve the command text exactly, `/c` runs and exits.
      return { kind, executable, args: ["/d", "/s", "/c", `"${command}"`], windowsVerbatimArguments: true };
    }
    const systemRoot = env.SystemRoot || env.SYSTEMROOT;
    const executable =
      kind === "pwsh"
        ? "pwsh.exe"
        : systemRoot
          ? `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
          : "powershell.exe";
    return {
      kind,
      executable,
      // -EncodedCommand avoids every quoting problem between Node, CreateProcess and PowerShell.
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(wrapPowerShell(command))],
      windowsVerbatimArguments: false,
    };
  }

  if (preferred === "cmd" || preferred === "powershell") {
    throw new Error(`Shell "${preferred}" is only supported on Windows. Use sh, bash, zsh, or pwsh (FORGE_SHELL).`);
  }
  if (preferred === "pwsh") {
    return {
      kind: "pwsh",
      executable: "pwsh",
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(wrapPowerShell(command))],
      windowsVerbatimArguments: false,
    };
  }
  const kind: ShellKind = preferred === "auto" ? "sh" : preferred;
  const executable = kind === "sh" ? "/bin/sh" : kind;
  return { kind, executable, args: ["-c", command], windowsVerbatimArguments: false };
}

/** Human-readable hint about the shell dialect, included in the model's system prompt. */
export function shellHint(kind: ShellKind, platform: Platform): string {
  if (kind === "cmd") return "Windows Command Prompt (cmd.exe): use `&&`, `dir`, `type`, `findstr`; no PowerShell cmdlets.";
  if (kind === "powershell") return "Windows PowerShell 5.1: use `;` (not `&&`) to chain commands; `Get-ChildItem`, `Get-Content`; native commands such as `npm test` work normally.";
  if (kind === "pwsh") return "PowerShell 7 (pwsh): `&&` works; use `Get-ChildItem`, `Get-Content`.";
  return `POSIX shell (${kind}) on ${platform}.`;
}

export type RunResult = {
  command: string;
  shell: string;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  /** Output exceeded the per-stream limit and was shortened (head + tail kept). */
  truncated: boolean;
  /** Process was killed because it produced an unreasonable amount of output. */
  killedForOutput: boolean;
  durationMs: number;
  /** Set when the process could not be started or another unexpected failure occurred. */
  error?: string;
  /** True only when the process started, exited on its own with code 0. */
  ok: boolean;
};

export type RunOptions = {
  executable: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  /** Max characters kept per stream (head and tail are both retained). */
  maxOutputChars: number;
  /** Kill the process once this many bytes in total were produced. */
  hardOutputCapBytes?: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  windowsVerbatimArguments?: boolean;
  /** Display string for results. */
  label?: string;
  shellLabel?: string;
  killGraceMs?: number;
};

class BoundedCollector {
  private head: Buffer[] = [];
  private headBytes = 0;
  private tail: Buffer[] = [];
  private tailBytes = 0;
  total = 0;
  constructor(private readonly limit: number) {}

  push(chunk: Buffer): void {
    this.total += chunk.length;
    const headLimit = Math.ceil(this.limit * 0.6);
    const tailLimit = this.limit - headLimit;
    let rest = chunk;
    if (this.headBytes < headLimit) {
      const take = Math.min(headLimit - this.headBytes, rest.length);
      this.head.push(rest.subarray(0, take));
      this.headBytes += take;
      rest = rest.subarray(take);
    }
    if (rest.length > 0) {
      this.tail.push(rest);
      this.tailBytes += rest.length;
      while (this.tailBytes - (this.tail[0]?.length ?? 0) >= tailLimit && this.tail.length > 1) {
        this.tailBytes -= this.tail.shift()!.length;
      }
      if (this.tailBytes > tailLimit) {
        const joined = Buffer.concat(this.tail);
        const kept = joined.subarray(joined.length - tailLimit);
        this.tail = [kept];
        this.tailBytes = kept.length;
      }
    }
  }

  get truncated(): boolean {
    return this.total > this.headBytes + this.tailBytes;
  }

  toString(): string {
    const head = Buffer.concat(this.head).toString("utf8");
    if (!this.truncated) return head + Buffer.concat(this.tail).toString("utf8");
    const dropped = this.total - this.headBytes - this.tailBytes;
    return `${head}\n[... ${dropped} bytes truncated ...]\n${Buffer.concat(this.tail).toString("utf8")}`;
  }
}

function killTree(child: ChildProcess, platform: Platform, force: boolean): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    if (platform === "windows") {
      // taskkill /T terminates the whole tree; /F is required for console apps without windows.
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      killer.on("error", () => { try { child.kill(); } catch { /* already gone */ } });
    } else {
      // Commands run in their own process group (detached), so kill the whole group.
      try { process.kill(-pid, force ? "SIGKILL" : "SIGTERM"); }
      catch { child.kill(force ? "SIGKILL" : "SIGTERM"); }
    }
  } catch {
    // Process already exited.
  }
}

/** Runs an executable without a shell string. Never rejects; failures are reported in the result. */
export function runProcess(options: RunOptions): Promise<RunResult> {
  const platform = detectPlatform();
  const started = Date.now();
  const limit = options.maxOutputChars;
  const hardCap = options.hardOutputCapBytes ?? Math.max(limit * 50, 5_000_000);
  const stdout = new BoundedCollector(limit);
  const stderr = new BoundedCollector(limit);
  const label = options.label ?? [options.executable, ...options.args].join(" ");
  const shell = options.shellLabel ?? options.executable;

  return new Promise<RunResult>((resolve) => {
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let killedForOutput = false;
    let spawnError: string | undefined;
    let timer: NodeJS.Timeout | undefined;
    let graceTimer: NodeJS.Timeout | undefined;

    const finish = (exitCode: number | null, signal: string | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      options.signal?.removeEventListener("abort", onAbort);
      const ok = exitCode === 0 && !timedOut && !cancelled && !killedForOutput && !spawnError;
      resolve({
        command: label,
        shell,
        exitCode,
        signal,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        timedOut,
        cancelled,
        truncated: stdout.truncated || stderr.truncated,
        killedForOutput,
        durationMs: Date.now() - started,
        error: spawnError,
        ok,
      });
    };

    if (options.signal?.aborted) {
      cancelled = true;
      finish(null, null);
      return;
    }

    let child: ChildProcess;
    try {
      child = spawn(options.executable, options.args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: options.windowsVerbatimArguments,
        detached: platform !== "windows",
      });
    } catch (error) {
      spawnError = `Failed to start "${options.executable}": ${error instanceof Error ? error.message : String(error)}`;
      finish(null, null);
      return;
    }

    const terminate = () => {
      killTree(child, platform, false);
      // Escalate, and make sure we resolve even if a grandchild keeps the pipes open.
      graceTimer = setTimeout(() => {
        killTree(child, platform, true);
        graceTimer = setTimeout(() => finish(child.exitCode, child.signalCode), 1000);
        graceTimer.unref?.();
      }, options.killGraceMs ?? 1500);
      graceTimer.unref?.();
    };

    function onAbort() {
      cancelled = true;
      terminate();
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });

    timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);

    const onData = (target: BoundedCollector) => (chunk: Buffer) => {
      target.push(chunk);
      if (!killedForOutput && stdout.total + stderr.total > hardCap) {
        killedForOutput = true;
        terminate();
      }
    };
    child.stdout?.on("data", onData(stdout));
    child.stderr?.on("data", onData(stderr));

    child.on("error", (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      spawnError =
        code === "ENOENT"
          ? `Shell executable not found: "${options.executable}". Set FORGE_SHELL to an installed shell.`
          : `Failed to start "${options.executable}": ${error.message}`;
      finish(null, null);
    });
    child.on("close", (code, signal) => finish(code, signal));
  });
}

const SECRET_ENV = /(^FORGE_API_KEY$|API_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL)/i;

/** Child environment: inherits the parent's but drops variables that look like secrets (least privilege). */
export function sanitizedEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (!SECRET_ENV.test(key)) env[key] = value;
  }
  env.FORGE_AGENT = "1";
  env.CI = env.CI ?? "1"; // many tools (vitest, jest) then avoid interactive/watch modes
  return env;
}

export type CommandRequest = {
  command: string;
  cwd: string;
  timeoutMs: number;
  maxOutputChars: number;
  preferredShell?: ShellChoice;
  signal?: AbortSignal;
  platform?: Platform;
};

/** Runs a command string through the selected shell inside the workspace. */
export async function runCommand(req: CommandRequest): Promise<RunResult> {
  let invocation: ShellInvocation;
  try {
    invocation = selectShell(req.command, { platform: req.platform, preferred: req.preferredShell });
  } catch (error) {
    return {
      command: req.command, shell: req.preferredShell ?? "auto", exitCode: null, signal: null, stdout: "", stderr: "",
      timedOut: false, cancelled: false, truncated: false, killedForOutput: false, durationMs: 0, ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  return runProcess({
    executable: invocation.executable,
    args: invocation.args,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    cwd: req.cwd,
    timeoutMs: req.timeoutMs,
    maxOutputChars: req.maxOutputChars,
    env: sanitizedEnv(),
    signal: req.signal,
    label: req.command,
    shellLabel: invocation.kind,
  });
}

/** Text returned to the model. The status line is derived from the real exit status only. */
export function formatRunResult(r: RunResult): string {
  let status: string;
  if (r.error) status = `NOT RUN / FAILED TO START: ${r.error}`;
  else if (r.cancelled) status = "CANCELLED by user";
  else if (r.timedOut) status = "FAILED: TIMED OUT and was killed";
  else if (r.killedForOutput) status = "FAILED: killed for producing excessive output";
  else if (r.exitCode === 0) status = "SUCCEEDED (exit code 0)";
  else status = `FAILED (exit code ${r.exitCode ?? "none"}${r.signal ? `, signal ${r.signal}` : ""})`;
  const parts = [`$ ${r.command}`, `shell: ${r.shell} | duration: ${r.durationMs}ms`, `result: ${status}`];
  if (r.truncated) parts.push("note: output was truncated (head and tail kept)");
  parts.push(`--- stdout ---\n${r.stdout.trim() || "(empty)"}`);
  parts.push(`--- stderr ---\n${r.stderr.trim() || "(empty)"}`);
  return parts.join("\n");
}
