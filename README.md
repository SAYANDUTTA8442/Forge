# Forge Agent

A CLI-first, provider-agnostic coding agent for Node.js. It talks to any OpenAI-compatible chat-completions API (Ollama, hosted APIs), works inside one workspace directory, and — importantly — **verifies its own work** instead of trusting the model's "I'm done".

## What it does

- **Tools:** `list_files`, `read_file`, `write_file`, `edit_file`, `delete_file`, `search_text`, `run_command`.
- **Windows-native command execution:** PowerShell (default on Windows), PowerShell 7 (`pwsh`) or `cmd.exe`; `sh`/`bash`/`zsh` on Linux/macOS. Commands run through `spawn` with an explicit executable and argument vector (PowerShell uses `-EncodedCommand`, so there is no quoting roulette), in the workspace, with a timeout, output limits and whole-process-tree termination (`taskkill /T /F` on Windows, process groups elsewhere).
- **Honest results:** every command returns exit code, stdout, stderr and timeout status. "SUCCEEDED" is only printed for a real exit code 0.
- **Reliable tool calling:** responses and arguments are validated; only registered tools run; unknown tools, bad JSON and missing fields are reported back to the model with the correct `tool_call_id`; text is **never** parsed into a tool call. If the model talks about a tool that doesn't exist (e.g. `run_shell_command`), Forge lists the real tools and asks it to retry rather than ending the task.
- **Completion verification:** a reply without tool calls is not "done". If files changed, Forge requires a passing test/build/typecheck run *after the last change* (it nudges the model to run one, and to fix failures, within bounded retries). The final summary is built from what actually happened, not from the model's claims, and flags claims of passing tests that nothing backs up.
- **Safer editing:** all paths stay inside the workspace (traversal, absolute paths, drive letters, symlink and dangling-symlink escapes are rejected). Existing files must be read before `write_file` replaces them, and are refused if they changed on disk since being read. Edits return a diff and are verified by reading the file back. CRLF line endings are preserved. `.git`, `.forge` and `node_modules` are protected; `.env`, keys and CI workflows need approval.
- **Resilient provider:** timeouts, bounded retries with exponential backoff (network errors, 408/429/5xx), clear errors for unreachable endpoints, bad keys, missing models and models without tool support. API keys are redacted from logs and errors.

## Requirements

- Node.js **20.3+**
- Ollama (or another OpenAI-compatible endpoint) with a **tool-capable** model, e.g. `llama3.2:3b`

## Windows setup

```powershell
# 1. Install Node.js 20+ (https://nodejs.org) and Ollama (https://ollama.com/download)
ollama pull llama3.2:3b
ollama serve            # skip if the Ollama tray app is already running

# 2. Install and configure Forge
git clone <your fork>  forge-agent ; cd forge-agent
npm install
Copy-Item .env.example .env       # defaults already target local Ollama + llama3.2:3b
npm run build

# 3. Run it against a repository
npm start -- --workspace C:\path\to\your\repo
# or one-shot:
npm start -- --workspace C:\path\to\your\repo "Fix the failing test in src/parser.test.ts and run the tests"
```

Notes for Windows:
- Default shell is **Windows PowerShell 5.1** (always installed). It does not support `&&`; use `;`. The model is told which shell it is using. Use `--shell pwsh` (PowerShell 7) or `--shell cmd` if you prefer.
- Symlink-escape tests are skipped automatically if your account cannot create symlinks (enable Developer Mode to run them).
- Small local models have small context windows. Ollama's default context is short; if the agent forgets instructions, raise it (for example set `OLLAMA_CONTEXT_LENGTH=8192` before `ollama serve`) and keep `FORGE_MAX_CONTEXT_CHARS` below it (roughly 3-4 characters per token).

## Linux / macOS

```bash
npm install && cp .env.example .env && npm run build
npm start -- --workspace /path/to/repo
```

## Usage

Interactive mode (conversation persists across prompts until `/clear`):

| Command | Effect |
|---|---|
| `/help` | list commands |
| `/model` | show the configured endpoint (no secrets) and model |
| `/clear` | clear the conversation and what Forge has "read" |
| `/exit` (or `/quit`) | quit |
| `Ctrl+C` | cancel the running task (kills the running command); twice at an idle prompt to exit |

Options: `-w/--workspace`, `-m/--model`, `--max-steps`, `--shell`, `--approval ask|deny`.

Example prompts:
- `Explain the architecture of this repository.`
- `Add a unit test for the date parser and run it.`
- `Fix the failing test in src/parser.test.ts.`

One-shot mode exits with code `0` only when the task finished **and** was verified (or needed no verification); otherwise `1` (`130` if cancelled), so it can be scripted.

At the end of each task Forge prints a summary: status (COMPLETED / NOT VERIFIED / FAILED / STOPPED - step budget / CANCELLED / ERROR), changed files, commands with real results, verification state, warnings and remaining work.

## Configuration

See `.env.example`. Variables (environment wins over `.env`):

| Variable | Default | Meaning |
|---|---|---|
| `FORGE_BASE_URL` | `http://localhost:11434/v1` | API root (not the `/chat/completions` path) |
| `FORGE_API_KEY` | `local` | Bearer key (`ollama` for Ollama) |
| `FORGE_MODEL` | `llama3.2:3b` | Model name |
| `FORGE_MAX_STEPS` | `20` | Model calls per task; the final call is a no-tools wrap-up |
| `FORGE_COMMAND_TIMEOUT_MS` | `60000` | Per command |
| `FORGE_PROVIDER_TIMEOUT_MS` | `120000` | Per model request |
| `FORGE_MAX_RETRIES` | `3` | Provider retries |
| `FORGE_MAX_OUTPUT_CHARS` | `20000` | Per output stream (head+tail kept) |
| `FORGE_MAX_CONTEXT_CHARS` | `40000` | Older tool output is elided beyond this |
| `FORGE_SHELL` | `auto` | `powershell`, `pwsh`, `cmd`, `sh`, `bash`, `zsh` |
| `FORGE_APPROVAL` | `ask` | `ask` prompts; `deny` refuses sensitive actions |

Configuration is validated at startup with specific messages. `.env` is loaded from the Forge install directory, `FORGE_ENV_FILE`, and the current directory — but **not** from a `.env` inside the selected workspace, because repository files are untrusted and could redirect your model endpoint.

## Safety model — read this

**Command filtering is a guardrail, not a security sandbox.** Forge uses pattern matching to *block* obviously dangerous commands (recursive deletes of root/home/workspace, `format`, `diskpart`, `shutdown`, `sudo`/`runas`, `curl | sh`, `iwr | iex`, registry edits, ...) and to *require your approval* for sensitive ones (`git push/reset/clean`, `npm publish`, dependency installs, deleting files, network uploads, `ssh`, reading `.env`, `cd` outside the workspace, deploy tools...). A model — or a malicious file the model reads — can evade patterns (encoded commands, scripts written to disk and then run, `node -e` that deletes things, aliases). Tests and builds are themselves arbitrary code.

What Forge does enforce: file tools cannot leave the workspace; approvals default to "deny" when there is no terminal; the child process environment drops variables that look like secrets (`*KEY*`, `*TOKEN*`, `*SECRET*`, `*PASSWORD*`, `FORGE_API_KEY`); output, runtime and step counts are bounded; the agent is told never to deploy, publish, push or delete data.

What still needs **OS-level sandboxing** (run Forge inside it for untrusted repositories or unattended use):
- Filesystem isolation for commands: a container/VM, Windows Sandbox, a throwaway git worktree, or a restricted low-privilege user. `run_command` can read and write anything the user account can.
- Network egress control: commands can reach the network (and exfiltrate anything they can read).
- Resource limits (CPU, memory, disk, process count) beyond the single timeout.
- Protection of secrets outside the workspace (SSH keys, cloud credentials, browser profiles).

Other advice: commit before you start, review the diff afterwards, never run as root/Administrator, and treat everything the model reads (repo files, command output) as untrusted.

## Development

```bash
npm run build        # compile to dist/
npm run typecheck    # src + tests
npm test             # vitest; no live model or API key needed
```

Tests cover: workspace containment and symlink escapes, shell selection per platform, command timeouts/truncation/cancellation, dangerous-command rejection, malformed tool arguments, unknown tools, tool-call/result message ordering, provider errors and retry limits, task-completion verification, and step-budget handling. The provider is mocked and the agent is driven by a scripted fake model.

### Tested platforms

Developed and tested on Linux. The Windows execution path (PowerShell/cmd selection, `-EncodedCommand`, `taskkill`) is unit-tested through injected platform/environment values, but **has not been run on a real Windows machine**. If something misbehaves there, please run `npm test` on Windows and report the output.

## Known limitations

- Verification is based on command patterns (`npm test`, `pytest`, `cargo test`, ...). Unusual test runners may not be recognised; Forge will then report "NOT VERIFIED" rather than guess.
- Files changed *by commands* (formatters, generators) are not tracked as changes; only file-tool edits are.
- No streaming, no persisted sessions across restarts, no embeddings/RAG.
- A 3B local model is weak at multi-step coding. Forge makes failures visible and bounded, but it cannot make a small model smart; use a larger tool-capable model for harder tasks.
- Parallel tool calls are executed sequentially (at most 8 per turn).
