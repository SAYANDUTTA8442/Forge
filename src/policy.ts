/**
 * Command policy: a best-effort *guardrail* that rejects obviously dangerous commands and flags
 * sensitive ones for approval. It is a pattern filter, NOT a security sandbox: a determined or
 * confused model can obfuscate commands (variables, encoding, scripts it writes first, etc.).
 * Use OS-level isolation (container, VM, Windows Sandbox, restricted user) for real containment.
 */
export type PolicyDecision =
  | { verdict: "allow" }
  | { verdict: "approve"; reason: string }
  | { verdict: "block"; reason: string };

type Rule = { pattern: RegExp; reason: string };

// Never run, even with approval: do it manually if you really mean it.
const BLOCKED: Rule[] = [
  { pattern: /\brm\s+(-[a-z]*\s+)*-[a-z]*[rR][a-z]*\s+(-[a-z]*\s+)*(\/|~|\$HOME|\*|\.\.?)(\s|$|\/\*)/, reason: "recursive delete of root/home/workspace-wide target" },
  { pattern: /\brm\s+(-[a-z]*\s+)*--no-preserve-root\b/, reason: "rm --no-preserve-root" },
  { pattern: /\b(del|erase)\b[^\n]*\s\/[sS]\b/, reason: "recursive delete (del /s)" },
  { pattern: /\b(rd|rmdir)\b[^\n]*\s\/[sS]\b/, reason: "recursive directory removal (rmdir /s)" },
  { pattern: /\bremove-item\b[^\n]*-recurse\b/i, reason: "recursive Remove-Item" },
  { pattern: /\bformat(\.com)?\s+[a-z]:/i, reason: "disk format" },
  { pattern: /\b(diskpart|mkfs(\.\w+)?|fdisk|parted|cipher\s+\/w)\b/i, reason: "disk partitioning/formatting" },
  { pattern: /\bdd\s+[^\n]*\bof=\/dev\//, reason: "raw write to a device" },
  { pattern: />\s*\/dev\/(sd|nvme|disk|hd)/i, reason: "raw write to a device" },
  { pattern: /\b(shutdown|reboot|halt|poweroff)\b/i, reason: "system shutdown/reboot" },
  { pattern: /\bstop-computer\b|\brestart-computer\b/i, reason: "system shutdown/reboot" },
  { pattern: /(^|[;&|]\s*)sudo\b|\brunas\b|\bstart-process\b[^\n]*-verb\s+runas/i, reason: "privilege escalation" },
  { pattern: /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(sh|bash|zsh|pwsh|powershell)\b/i, reason: "piping a download into a shell" },
  { pattern: /\b(iwr|irm|invoke-webrequest|invoke-restmethod)\b[^\n]*\|\s*(iex|invoke-expression)\b/i, reason: "executing downloaded code" },
  { pattern: /\b(iex|invoke-expression)\b[^\n]*\b(downloadstring|iwr|irm|invoke-webrequest)\b/i, reason: "executing downloaded code" },
  { pattern: /\breg(\.exe)?\s+(delete|add|import)\b/i, reason: "registry modification" },
  { pattern: /\b(set-executionpolicy|bcdedit|netsh\s+advfirewall|schtasks\s+\/create|crontab\s+-[re])\b/i, reason: "system configuration change" },
  { pattern: /\bchmod\s+(-R\s+)?[0-7]*777\b|\bchown\s+-R\s+\S+\s+\//i, reason: "unsafe permission change" },
  { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: "fork bomb" },
];

// Allowed only after the person approves.
const SENSITIVE: Rule[] = [
  { pattern: /\bgit\s+(push|reset|clean|checkout\s+--|restore|rebase|stash\s+(drop|clear)|branch\s+-D|tag\s+-d|filter-branch|commit\s+--amend)\b/i, reason: "git command that publishes or discards work" },
  { pattern: /\b(npm|pnpm|yarn|bun)\s+(publish|unpublish|deprecate|login|adduser|token|access|owner)\b/i, reason: "package publishing/registry account action" },
  { pattern: /\b(twine\s+upload|cargo\s+publish|gem\s+push|dotnet\s+nuget\s+push|docker\s+push|gh\s+release|vercel|netlify\s+deploy|firebase\s+deploy|wrangler\s+(deploy|publish)|kubectl\s+(apply|delete)|terraform\s+(apply|destroy)|helm\s+(install|upgrade|uninstall))\b/i, reason: "deploy/publish action" },
  { pattern: /\b(npm|pnpm|yarn|bun)\s+(install|i|add|ci|update|upgrade|remove|uninstall|link)\b/i, reason: "dependency change (runs third-party install scripts)" },
  { pattern: /\b(pip3?|python3?\s+-m\s+pip|uv\s+pip|poetry|cargo|go|dotnet|gem|composer)\s+(install|add|get|remove|uninstall|update)\b/i, reason: "dependency change (runs third-party code)" },
  { pattern: /\b(winget|choco|scoop|apt(-get)?|brew|dnf|yum)\s+(install|uninstall|remove|upgrade)\b/i, reason: "system package change" },
  { pattern: /\b(rm|del|erase|rd|rmdir|remove-item|unlink)\b/i, reason: "deletes files" },
  { pattern: /\b(mv|move|ren|rename|move-item|rename-item)\b[^\n]*(\.\.[\\/]|\s[a-zA-Z]:[\\/]|\s\/)/i, reason: "moves files toward a path outside the workspace" },
  { pattern: /(^|[\s;&|])(cd|chdir|set-location|pushd)\s+(\/|[a-zA-Z]:|\.\.|~)/i, reason: "changes directory outside the workspace" },
  { pattern: /\b(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b[^\n]*(-d\b|--data|-F\b|--form|-T\b|--upload-file|-method\s+(post|put|delete)|-body|-X\s*(POST|PUT|DELETE|PATCH))/i, reason: "sends data over the network" },
  { pattern: /\b(ssh|scp|sftp|rsync|nc|ncat|telnet)\b/i, reason: "remote network access" },
  { pattern: /\b(cat|type|get-content|gc)\b[^\n]*(\.env\b|id_rsa|\.npmrc|\.aws[\\/]credentials|\.pem\b)/i, reason: "reads a secrets file" },
  { pattern: /\b(printenv|env|set|get-childitem\s+env:|dir\s+env:)\s*(\||>|$)/i, reason: "dumps environment variables (may contain secrets)" },
  { pattern: /\bdocker\s+(run|rm|rmi|system|volume|compose\s+down)\b/i, reason: "container operation" },
];

export const MAX_COMMAND_LENGTH = 4000;

export function evaluateCommand(command: string): PolicyDecision {
  if (command.length > MAX_COMMAND_LENGTH) {
    return { verdict: "block", reason: `command is longer than ${MAX_COMMAND_LENGTH} characters; write a script file with write_file instead` };
  }
  if (command.includes("\0")) return { verdict: "block", reason: "command contains a NUL byte" };
  for (const rule of BLOCKED) if (rule.pattern.test(command)) return { verdict: "block", reason: rule.reason };
  for (const rule of SENSITIVE) if (rule.pattern.test(command)) return { verdict: "approve", reason: rule.reason };
  return { verdict: "allow" };
}

/** Commands whose success is meaningful evidence that code works (tests, build, typecheck, lint). */
const VERIFY_PATTERNS: RegExp[] = [
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|tests|build|typecheck|type-check|lint|check|verify|ci)\b/i,
  /\b(npm|pnpm|yarn|bun)\s+(t|tst)\b/i,
  /\bnpx\s+(--no-install\s+)?(vitest|jest|tsc|mocha|eslint|playwright|ava)\b/i,
  /\b(vitest|jest|mocha|ava|pytest|tox|nosetests|tsc|eslint|ruff|mypy|pyright|flake8)\b/i,
  /\bpython3?\s+-m\s+(pytest|unittest|mypy|ruff)\b/i,
  /\bnode\s+(--test|[^\n]*\.test\.[cm]?js)\b/i,
  /\bcargo\s+(test|build|check|clippy)\b/i,
  /\bgo\s+(test|build|vet)\b/i,
  /\bdotnet\s+(test|build)\b/i,
  /\b(mvn|mvnw|gradle|gradlew)\b[^\n]*\b(test|build|verify|check|compile)\b/i,
  /\bmake\s+(test|check|build|all)\b/i,
  /\bctest\b|\bphpunit\b|\brspec\b|\brake\s+test\b|\bbundle\s+exec\s+rspec\b/i,
];

export function isVerificationCommand(command: string): boolean {
  // `echo npm test` prints text; it verifies nothing.
  if (/^\s*(echo|printf|write-host|write-output|rem|::|#)\b/i.test(command)) return false;
  return VERIFY_PATTERNS.some((p) => p.test(command));
}
