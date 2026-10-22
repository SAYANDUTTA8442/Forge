import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const SHELL_CHOICES = ["auto", "cmd", "powershell", "pwsh", "sh", "bash", "zsh"] as const;
export type ShellChoice = (typeof SHELL_CHOICES)[number];

export const APPROVAL_MODES = ["ask", "deny"] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

const ConfigSchema = z.object({
  baseUrl: z
    .string()
    .url()
    .refine((u) => /^https?:\/\//i.test(u), "must start with http:// or https://"),
  apiKey: z.string().default("local"),
  model: z.string().min(1, "is required (for Ollama try llama3.2:3b)"),
  maxSteps: z.number().int().min(1).max(100),
  commandTimeoutMs: z.number().int().min(1000).max(600_000),
  providerTimeoutMs: z.number().int().min(1000).max(600_000),
  maxRetries: z.number().int().min(0).max(8),
  maxOutputChars: z.number().int().min(1000).max(200_000),
  shell: z.enum(SHELL_CHOICES),
  approval: z.enum(APPROVAL_MODES),
  maxContextChars: z.number().int().min(4000).max(2_000_000),
});

export type ForgeConfig = z.infer<typeof ConfigSchema>;

/** Parses KEY=VALUE lines. Existing keys in `target` are never overwritten. */
export function applyEnvText(content: string, target: Record<string, string | undefined>): void {
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index < 1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
    if (target[key] === undefined) target[key] = value;
  }
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Loads .env files into process.env (process environment always wins).
 * Sources, in order: FORGE_ENV_FILE, the Forge install directory, and the current
 * directory — but NOT a .env that lives inside the selected workspace, because
 * repository files are untrusted and could redirect the model endpoint.
 */
export function loadEnvFiles(workspaceRoot?: string): void {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates: string[] = [];
  if (process.env.FORGE_ENV_FILE) candidates.push(path.resolve(process.env.FORGE_ENV_FILE));
  candidates.push(path.resolve(here, "..", ".env"));
  const cwdEnv = path.resolve(process.cwd(), ".env");
  if (!workspaceRoot || !isInside(path.resolve(workspaceRoot), cwdEnv)) candidates.push(cwdEnv);
  for (const file of candidates) {
    try {
      applyEnvText(readFileSync(file, "utf8"), process.env);
    } catch {
      // .env files are optional.
    }
  }
}

function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  return Number(value);
}

export function parseConfig(env: Record<string, string | undefined>): ForgeConfig {
  const parsed = ConfigSchema.safeParse({
    baseUrl: env.FORGE_BASE_URL?.trim() || "http://localhost:11434/v1",
    apiKey: env.FORGE_API_KEY ?? "local",
    model: env.FORGE_MODEL?.trim() || "llama3.2:3b",
    maxSteps: num(env.FORGE_MAX_STEPS, 20),
    commandTimeoutMs: num(env.FORGE_COMMAND_TIMEOUT_MS, 60_000),
    providerTimeoutMs: num(env.FORGE_PROVIDER_TIMEOUT_MS, 120_000),
    maxRetries: num(env.FORGE_MAX_RETRIES, 3),
    maxOutputChars: num(env.FORGE_MAX_OUTPUT_CHARS, 20_000),
    shell: (env.FORGE_SHELL?.trim().toLowerCase() || "auto") as ShellChoice,
    approval: (env.FORGE_APPROVAL?.trim().toLowerCase() || "ask") as ApprovalMode,
    maxContextChars: num(env.FORGE_MAX_CONTEXT_CHARS, 40_000),
  });
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "config"}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${details}\nSee .env.example for the FORGE_* variables.`);
  }
  const config = parsed.data;
  if (/^(replace-me|your-api-key|changeme)$/i.test(config.apiKey)) {
    throw new Error("Invalid configuration:\n  - apiKey: FORGE_API_KEY is still a placeholder. Set a real key, or use `ollama` for local Ollama.");
  }
  return config;
}

export function getConfig(workspaceRoot?: string): ForgeConfig {
  loadEnvFiles(workspaceRoot);
  return parseConfig(process.env);
}

/** Non-fatal configuration warnings for the user. */
export function configWarnings(config: ForgeConfig): string[] {
  const warnings: string[] = [];
  const url = new URL(config.baseUrl);
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  if (url.protocol === "http:" && !local && config.apiKey !== "local" && config.apiKey !== "ollama") {
    warnings.push(`FORGE_BASE_URL uses plain http:// to a non-local host (${url.hostname}); your API key would be sent unencrypted.`);
  }
  if (url.username || url.password) warnings.push("FORGE_BASE_URL contains credentials; prefer FORGE_API_KEY.");
  if (/\/chat\/completions\/?$/.test(url.pathname)) {
    warnings.push("FORGE_BASE_URL should be the API root (e.g. http://localhost:11434/v1), not the /chat/completions path.");
  }
  return warnings;
}

/** Base URL safe to display (no credentials, no query string). */
export function displayBaseUrl(baseUrl: string): string {
  try {
    const u = new URL(baseUrl);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return "(invalid url)";
  }
}
