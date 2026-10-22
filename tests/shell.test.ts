import { describe, expect, it } from "vitest";
import {
  detectPlatform, formatRunResult, runCommand, runProcess, sanitizedEnv, selectShell, wrapPowerShell, type RunResult,
} from "../src/shell.js";
import { tempDir, cleanupTempDirs } from "./helpers.js";
import { afterEach } from "vitest";

afterEach(cleanupTempDirs);

const node = process.execPath;

describe("platform and shell selection", () => {
  it("detects platforms", () => {
    expect(detectPlatform("win32")).toBe("windows");
    expect(detectPlatform("darwin")).toBe("macos");
    expect(detectPlatform("linux")).toBe("linux");
  });

  it("defaults to Windows PowerShell with an encoded command on Windows", () => {
    const s = selectShell("npm test && echo \"hi\"", { platform: "windows", env: { SystemRoot: "C:\\Windows" } });
    expect(s.kind).toBe("powershell");
    expect(s.executable).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(s.args).toContain("-NoProfile");
    expect(s.args).toContain("-NonInteractive");
    const encoded = s.args[s.args.indexOf("-EncodedCommand") + 1]!;
    const script = Buffer.from(encoded, "base64").toString("utf16le");
    expect(script).toContain("npm test && echo \"hi\"");
    expect(script).toBe(wrapPowerShell("npm test && echo \"hi\""));
    expect(s.windowsVerbatimArguments).toBe(false);
  });

  it("falls back to powershell.exe on PATH when SystemRoot is unset", () => {
    expect(selectShell("dir", { platform: "windows", env: {} }).executable).toBe("powershell.exe");
  });

  it("supports cmd.exe with verbatim arguments and ComSpec", () => {
    const s = selectShell("dir /b", { platform: "windows", preferred: "cmd", env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" } });
    expect(s.kind).toBe("cmd");
    expect(s.executable).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(s.args).toEqual(["/d", "/s", "/c", "\"dir /b\""]);
    expect(s.windowsVerbatimArguments).toBe(true);
  });

  it("supports pwsh on Windows and elsewhere", () => {
    expect(selectShell("ls", { platform: "windows", preferred: "pwsh" }).executable).toBe("pwsh.exe");
    expect(selectShell("ls", { platform: "linux", preferred: "pwsh" }).executable).toBe("pwsh");
  });

  it("uses /bin/sh -c on Linux/macOS and honours bash/zsh", () => {
    expect(selectShell("ls", { platform: "linux" })).toMatchObject({ kind: "sh", executable: "/bin/sh", args: ["-c", "ls"] });
    expect(selectShell("ls", { platform: "macos", preferred: "zsh" })).toMatchObject({ kind: "zsh", executable: "zsh", args: ["-c", "ls"] });
    expect(selectShell("ls", { platform: "linux", preferred: "bash" }).executable).toBe("bash");
  });

  it("rejects shells that do not exist on the platform", () => {
    expect(() => selectShell("ls", { platform: "linux", preferred: "cmd" })).toThrow(/only supported on Windows/);
    expect(() => selectShell("ls", { platform: "linux", preferred: "powershell" })).toThrow(/only supported on Windows/);
    expect(() => selectShell("ls", { platform: "windows", preferred: "bash" })).toThrow(/not available on Windows/);
  });

  it("PowerShell wrapper propagates native exit codes and failures", () => {
    const script = wrapPowerShell("npm test");
    expect(script).toContain("exit $__forge_code");
    expect(script).toContain("if (-not $__forge_ok) { exit 1 }");
  });
});

describe("runProcess", () => {
  it("captures stdout, stderr and a zero exit code", async () => {
    const cwd = await tempDir();
    const r = await runProcess({ executable: node, args: ["-e", "console.log('out'); console.error('err')"], cwd, timeoutMs: 10_000, maxOutputChars: 1000 });
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("out");
    expect(r.stderr.trim()).toBe("err");
    expect(r.timedOut).toBe(false);
  });

  it("reports non-zero exit codes as failures", async () => {
    const cwd = await tempDir();
    const r = await runProcess({ executable: node, args: ["-e", "process.exit(7)"], cwd, timeoutMs: 10_000, maxOutputChars: 1000 });
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(7);
    expect(formatRunResult(r)).toMatch(/FAILED \(exit code 7\)/);
    expect(formatRunResult(r)).not.toMatch(/SUCCEEDED/);
  });

  it("kills a command that exceeds its timeout", async () => {
    const cwd = await tempDir();
    const started = Date.now();
    const r = await runProcess({ executable: node, args: ["-e", "setInterval(()=>{}, 1000)"], cwd, timeoutMs: 300, maxOutputChars: 1000, killGraceMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(r.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(8000);
    expect(formatRunResult(r)).toMatch(/TIMED OUT/);
    expect(formatRunResult(r)).not.toMatch(/SUCCEEDED/);
  });

  it("truncates large output but keeps head and tail", async () => {
    const cwd = await tempDir();
    const script = "process.stdout.write('HEAD' + 'x'.repeat(200000) + 'TAIL')";
    const r = await runProcess({ executable: node, args: ["-e", script], cwd, timeoutMs: 20_000, maxOutputChars: 1000 });
    expect(r.truncated).toBe(true);
    expect(r.stdout.length).toBeLessThan(1300);
    expect(r.stdout.startsWith("HEAD")).toBe(true);
    expect(r.stdout.endsWith("TAIL")).toBe(true);
    expect(r.stdout).toMatch(/bytes truncated/);
    expect(formatRunResult(r)).toMatch(/output was truncated/);
  });

  it("kills a process that floods output past the hard cap", async () => {
    const cwd = await tempDir();
    const r = await runProcess({
      executable: node, args: ["-e", "const b='y'.repeat(65536); setInterval(()=>process.stdout.write(b),1)"],
      cwd, timeoutMs: 20_000, maxOutputChars: 1000, hardOutputCapBytes: 500_000, killGraceMs: 300,
    });
    expect(r.killedForOutput).toBe(true);
    expect(r.ok).toBe(false);
  });

  it("reports a missing executable instead of throwing", async () => {
    const cwd = await tempDir();
    const r = await runProcess({ executable: "definitely-not-a-real-binary-xyz", args: [], cwd, timeoutMs: 5000, maxOutputChars: 1000 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not found/i);
    expect(formatRunResult(r)).toMatch(/NOT RUN \/ FAILED TO START/);
  });

  it("stops promptly when the abort signal fires", async () => {
    const cwd = await tempDir();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const r = await runProcess({ executable: node, args: ["-e", "setInterval(()=>{}, 1000)"], cwd, timeoutMs: 20_000, maxOutputChars: 1000, signal: ac.signal, killGraceMs: 300 });
    expect(r.cancelled).toBe(true);
    expect(r.ok).toBe(false);
    expect(formatRunResult(r)).toMatch(/CANCELLED/);
  });

  it("runs in the requested working directory", async () => {
    const cwd = await tempDir();
    const r = await runProcess({ executable: node, args: ["-e", "console.log(process.cwd())"], cwd, timeoutMs: 10_000, maxOutputChars: 1000 });
    const { realpath } = await import("node:fs/promises");
    expect(await realpath(r.stdout.trim())).toBe(await realpath(cwd));
  });
});

describe("runCommand (host shell)", () => {
  it("runs a command through the platform shell and reports success only on exit 0", async () => {
    const cwd = await tempDir();
    const ok = await runCommand({ command: "node --version", cwd, timeoutMs: 20_000, maxOutputChars: 1000 });
    expect(ok.ok).toBe(true);
    expect(ok.stdout).toMatch(/^v\d+/);
    const bad = await runCommand({ command: "node -e \"process.exit(3)\"", cwd, timeoutMs: 20_000, maxOutputChars: 1000 });
    expect(bad.ok).toBe(false);
    expect(bad.exitCode).toBe(3);
  });

  it("returns a result (not an exception) when the shell choice is invalid for this OS", async () => {
    const cwd = await tempDir();
    const r = await runCommand({ command: "echo hi", cwd, timeoutMs: 5000, maxOutputChars: 1000, platform: "linux", preferredShell: "cmd" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/only supported on Windows/);
  });
});

describe("sanitizedEnv", () => {
  it("drops secret-looking variables, including the Forge API key", () => {
    const env = sanitizedEnv({ PATH: "/bin", FORGE_API_KEY: "sk-abc", GITHUB_TOKEN: "t", AWS_SECRET_ACCESS_KEY: "s", DB_PASSWORD: "p", HOME: "/h" });
    expect(env.PATH).toBe("/bin");
    expect(env.HOME).toBe("/h");
    expect(env.FORGE_API_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.DB_PASSWORD).toBeUndefined();
    expect(env.FORGE_AGENT).toBe("1");
  });
});

describe("formatRunResult", () => {
  const base: RunResult = {
    command: "x", shell: "sh", exitCode: 0, signal: null, stdout: "", stderr: "", timedOut: false, cancelled: false,
    truncated: false, killedForOutput: false, durationMs: 1, ok: true,
  };
  it("only says SUCCEEDED for a clean exit 0", () => {
    expect(formatRunResult(base)).toMatch(/SUCCEEDED/);
    expect(formatRunResult({ ...base, ok: false, exitCode: 1 })).not.toMatch(/SUCCEEDED/);
    expect(formatRunResult({ ...base, ok: false, exitCode: 0, timedOut: true })).not.toMatch(/SUCCEEDED/);
    expect(formatRunResult({ ...base, ok: false, exitCode: null, signal: "SIGKILL" })).toMatch(/FAILED/);
  });
});
