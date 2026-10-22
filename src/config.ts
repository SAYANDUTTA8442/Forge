import { z } from "zod";

const ConfigSchema = z.object({
  baseUrl: z.string().url(),
  apiKey: z.string().default("local"),
  model: z.string().min(1),
  maxSteps: z.number().int().min(1).max(50).default(12),
  commandTimeoutMs: z.number().int().min(1000).max(120000).default(30000),
});

function loadEnvFile(): void {
  // Minimal .env loader; existing process environment always wins.
  try {
    const content = requireEnvFile();
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf("=");
      if (index < 1) continue;
      const key = trimmed.slice(0, index).trim();
      const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // .env is optional; environment variables can be set externally.
  }
}

function requireEnvFile(): string {
  // Avoid a dotenv dependency for this starter.
  return readTextFile(".env");
}
function readTextFile(path: string): string {
  // Static import keeps this module ESM-compatible.
  return envFileReader(path);
}
import { readFileSync } from "node:fs";
const envFileReader = (path: string) => readFileSync(path, "utf8");

export function getConfig() {
  loadEnvFile();
  const parsed = ConfigSchema.safeParse({
    baseUrl: process.env.FORGE_BASE_URL ?? "http://localhost:11434/v1",
    apiKey: process.env.FORGE_API_KEY ?? "local",
    model: process.env.FORGE_MODEL ?? "",
    maxSteps: Number(process.env.FORGE_MAX_STEPS ?? 12),
    commandTimeoutMs: Number(process.env.FORGE_COMMAND_TIMEOUT_MS ?? 30000),
  });
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${details}\nSet FORGE_MODEL and review .env.example.`);
  }
  return parsed.data;
}