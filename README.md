# Forge Agent (MVP)

A CLI-first coding-agent starter with a provider-agnostic, OpenAI-compatible chat-completions adapter, workspace-scoped file tools, bounded search, a shell tool, and an agent loop.

## Requirements
- Node.js 20+
- A hosted API key or a local OpenAI-compatible endpoint such as Ollama
- Optional: `rg` (ripgrep) for faster repository search

## Quick start
```bash
npm install
cp .env.example .env
# Edit .env with your endpoint, model, and key
npm run dev -- --workspace /path/to/your/repo
```

Or build and run:
```bash
npm run build
npm start -- --workspace /path/to/your/repo
```

## Example prompts
- `Explain the architecture of this repository.`
- `Find where user authentication is implemented and summarize it.`
- `Add a unit test for the date parser and run the relevant test.`
- `Fix the failing test in src/parser.test.ts.`

## Safety model in this MVP
- File reads/writes are constrained to the selected workspace after path resolution.
- Shell commands run with the workspace as their working directory and a timeout/output limit.
- A small set of destructive or high-risk shell patterns is blocked. This is a guardrail, **not a security sandbox**.
- Review the diff and use a disposable repository/container for untrusted projects.
- The model can still make incorrect edits. Commit your work before asking it to modify a real project.
- Do not run this agent as root or expose secrets in the workspace.

## Configuration
See `.env.example`. `FORGE_BASE_URL` should point to an OpenAI-compatible `/v1` API root (not the full chat-completions path). Hosted and local models use the same adapter, provided they support the chat-completions tool-call format.

## Current limitations
- No durable conversation/session storage yet.
- No streaming output yet.
- No embeddings/RAG; context is gathered through tools.
- Provider compatibility varies, especially for local tool-calling models.
- Shell safety uses denylist patterns and is not equivalent to OS-level sandboxing.
- No parallel tool calls; each tool is executed sequentially.

## Roadmap
1. Reliable tool loop and safe workspace tools (this MVP)
2. Persistent sessions, cancellation, and token/cost accounting
3. Approval policies and structured diffs
4. Provider adapters and model capability tests
5. Git-aware checkpoints and sandboxed command execution
6. TUI, streaming, and background tasks
