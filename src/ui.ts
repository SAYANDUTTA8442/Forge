import type { Interface as ReadlineInterface } from "node:readline/promises";
import { redactSecrets } from "./provider.js";

export type Logger = {
  info(message: string): void;
  step(step: number, max: number): void;
  assistant(text: string): void;
  toolCall(name: string, args: string): void;
  toolResult(name: string, ok: boolean, text: string): void;
  warn(message: string): void;
  error(message: string): void;
  success(message: string): void;
  dim(message: string): void;
};

export type ApprovalRequest = { title: string; detail: string };
export type Approver = (request: ApprovalRequest) => Promise<boolean>;

const useColor = (): boolean => !process.env.NO_COLOR && Boolean(process.stdout.isTTY || process.env.FORCE_COLOR);

export function paint(code: string, text: string, enabled = useColor()): string {
  return enabled ? `\x1b[${code}m${text}\x1b[0m` : text;
}

export function createConsoleLogger(opts: { secrets?: Array<string | undefined>; color?: boolean; maxToolOutput?: number; write?: (line: string) => void } = {}): Logger {
  const color = opts.color ?? useColor();
  const max = opts.maxToolOutput ?? 1200;
  const out = opts.write ?? ((line: string) => console.log(line));
  const clean = (t: string) => redactSecrets(t, opts.secrets ?? []);
  const c = (code: string, t: string) => paint(code, t, color);
  return {
    info: (m) => out(clean(m)),
    dim: (m) => out(c("90", clean(m))),
    step: (s, n) => out(c("90", `\n[step ${s}/${n}]`)),
    assistant: (t) => out(`\n${clean(t)}`),
    toolCall: (name, args) => out(`\n${c("36;1", `→ ${name}`)} ${c("90", clean(args).slice(0, 300))}`),
    toolResult: (_name, ok, text) => {
      const body = clean(text);
      const shown = body.length > max ? `${body.slice(0, max)}\n…[${body.length - max} more characters not shown here]` : body;
      out(c(ok ? "32" : "31", ok ? "  ✓ ok" : "  ✗ failed"));
      out(c("90", shown.split("\n").map((l) => `  ${l}`).join("\n")));
    },
    warn: (m) => out(c("33", `⚠ ${clean(m)}`)),
    error: (m) => out(c("31", `✗ ${clean(m)}`)),
    success: (m) => out(c("32", `✓ ${clean(m)}`)),
  };
}

/** Silent logger for tests and embedding. */
export const nullLogger: Logger = {
  info() {}, step() {}, assistant() {}, toolCall() {}, toolResult() {}, warn() {}, error() {}, success() {}, dim() {},
};

/** Approver that always refuses (non-interactive runs, `--approval deny`). */
export const denyAll: Approver = async () => false;

/** Asks on the terminal. Anything other than an explicit "y"/"yes" is a refusal. */
export function createReadlineApprover(rl: ReadlineInterface, logger: Logger, getSignal: () => AbortSignal | undefined = () => undefined): Approver {
  return async ({ title, detail }) => {
    logger.warn(`Approval required: ${title}`);
    logger.info(detail.split("\n").map((l) => `    ${l}`).join("\n"));
    try {
      const signal = getSignal();
      const answer = (await rl.question(paint("33;1", "  Allow this? [y/N] "), signal ? { signal } : {})).trim().toLowerCase();
      return answer === "y" || answer === "yes";
    } catch {
      return false; // cancelled or input closed: treat as a refusal
    }
  };
}
