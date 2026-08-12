<p align="center">
  <h1 align="center">AgentPod</h1>
  <p align="center">
    Self-hostable, multi-tenant AI agent service with sandboxed code execution
  </p>
  <p align="center">
    <a href="#quick-start">Quick Start</a> •
    <a href="#architecture">Architecture</a> •
    <a href="#deployment">Deployment</a> •
    <a href="#configuration">Configuration</a> •
    <a href="#api-reference">API Reference</a> •
    <a href="docs/ARCHITECTURE.md">Design Docs</a>
  </p>
  <p align="center">
    English | <a href="README.zh-CN.md">中文</a>
  </p>
</p>

---

AgentPod is a **server-side, multi-tenant AI agent service** powered by the [pi](https://github.com/nicholasgasior/pi-coding-agent) coding agent engine. A single Node.js process serves multiple users concurrently — each request spawns an `AgentSession` that runs to completion and is destroyed, with all state externalized to pluggable storage backends.

**Key features:**

- **Multi-tenant isolation** — Per-user session, memory, and workspace separation enforced at the storage layer, verified by static analysis rules and runtime isolation tests.
- **Sandboxed code execution** — Commands run in isolated Linux namespaces (PID/mount/network/uts/ipc) with independent cgroups per slot. No shared state between tenants.
- **Conversational UI** — Built-in Vue 3 chat interface with SSE streaming, project management, session history, and slash commands.
- **Artifacts** — Substantial output is stored as a standalone versioned **set of files** instead of being pasted into the chat: multi-file web pages, Vue 3 SFC projects, Markdown documents (with mermaid diagrams), SVG and code. A **standalone artifact library** (cross-session, searchable, with creation guidance) plus an in-chat side panel: live preview, per-file source view, version switching, download; edits are surgical string replacements rather than full rewrites. Vue is compiled in the browser and mermaid is self-hosted, so **previews are fully offline by default**, running inside a sandboxed iframe without `allow-same-origin` under a `default-src 'none'` CSP — model-generated scripts can neither read your session token nor reach the network.
- **Long-term memory** — Cross-session facts stored as human-readable `MEMORY.md`, editable by both users and the model.
- **Projects** — Group sessions under projects with persistent instructions and project-scoped memory.
- **Scheduled tasks** — 5-field cron expressions with IANA timezone support. The model can create tasks directly from conversation.
- **Extensible skills** — Directory-based skill system (`SKILL.md` + `scripts/`) that gets staged into the sandbox at runtime.
- **User workspace** — Persistent shared storage for session workspaces and user-created skills that survive sandbox teardown.
- **Zero cold start** — Fixed sandbox slot pool with pre-built namespaces. Execution = spawn in an already-running slot.
- **Docker-ready** — Three images (Agent + Worker + Manager) orchestrated via `docker compose`.

## Quick Start

### Local Development (No External Dependencies)

```bash
# Install and build the web UI (only needed once, or after changing web/)
npm run web:install
npm run web:build

# Start with mock LLM + trusted identity + local execution
npm run dev

# Open http://127.0.0.1:8787
```

This starts with `LLM_MODE=faux` (mock model), `AUTH_MODE=dev` (trusts `X-Username` header), and `SANDBOX_MODE=local` (executes in-process). No API keys, databases, or network access required.

### Local Development with Sandbox Cluster

To use real namespace-isolated sandboxes locally:

```bash
# Start the sandbox infrastructure (worker + manager + redis)
docker compose -f docker-compose.sandbox.yml up -d

# Start agent with sandbox cluster
cp .env.sandbox.template .env.sandbox
npm run dev:sandbox

# Open http://127.0.0.1:8787 (default login: admin / changeme)
```

### Full Stack Deployment

```bash
# One command to start everything (agent + worker + manager + redis)
cp .env.example .env    # Edit as needed
docker compose up -d
```

### Frontend Development

```bash
# Vite dev server on port 5273, proxying API to the agent process
npm --prefix web run dev
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Clients                                 │
│              (Web UI / API / Scheduled Tasks)                   │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Agent Service (src/)                          │
│                                                                 │
│  ┌──────────┐  ┌──────────┐  ┌────────┐  ┌───────┐  ┌───────┐ │
│  │ Identity │  │Run Service│  │Sessions│  │Memory │  │ Cron  │ │
│  │ (Auth)   │  │(Orchestr.)│  │  Store │  │ Store │  │Schedu.│ │
│  └──────────┘  └────┬─────┘  └────────┘  └───────┘  └───────┘ │
│                     │                                           │
│                     ▼                                           │
│              ┌────────────┐     ┌──────────┐                    │
│              │  Run Turn  │────▶│   LLM    │                    │
│              │ (pi engine)│     │ Provider │                    │
│              └──────┬─────┘     └──────────┘                    │
│                     │                                           │
└─────────────────────┼───────────────────────────────────────────┘
                      │
          ┌───────────┼───────────┐
          ▼                       ▼
┌──────────────────┐    ┌──────────────────┐
│  Sandbox Worker  │    │ Sandbox Manager  │
│                  │    │                  │
│  ┌────────────┐  │    │  Node Registry   │
│  │ Slot Pool  │  │    │  Load Balancer   │
│  │ (NS+cgroup)│  │    │  Ticket Issuer   │
│  └────────────┘  │    │                  │
│  bash / browser  │    │    (Redis)       │
│  file I/O        │    │                  │
└──────────────────┘    └──────────────────┘
```

| Service | Image | Runs As | Requires |
|---------|-------|---------|----------|
| **Agent** | `Dockerfile` | Non-root (`agent` user) | — |
| **Worker** | `sandbox-worker/Dockerfile` | root | `--privileged` or `CAP_SYS_ADMIN` + `CAP_NET_ADMIN` |
| **Manager** | `sandbox-manager/Dockerfile` | Non-root (`manager` user) | Redis |

The **Agent** handles conversation orchestration, session/memory/project/cron management, and skill loading. The **Worker** provides isolated command execution with namespace separation. The **Manager** handles worker registration, health checking, load-balanced scheduling, and short-lived ticket issuance. Exec traffic flows directly from agent to worker — the manager is control-plane only.

## Deployment

### Docker Compose (Recommended)

```bash
# Build and start all services
docker compose up -d

# View logs
docker compose logs -f agent
docker compose logs -f worker
docker compose logs -f manager
```

### Build Individual Images

```bash
docker build -t agentpod-agent .
docker build -t agentpod-worker -f sandbox-worker/Dockerfile .
docker build -t agentpod-manager ./sandbox-manager
```

### Worker Requirements

The sandbox worker needs privileged capabilities to set up namespace isolation. Before deploying, verify your environment:

```bash
sandbox-worker/bin/check-namespace-caps.sh
```

### Production Checklist

When `NODE_ENV=production`, the following are **enforced at startup** (the process refuses to start otherwise):

- `AUTH_MODE=password` (no dev identity trust)
- `SANDBOX_MODE` ≠ `local` (no in-process execution)
- `LLM_MODE` ∉ `{faux, direct}` (no mock or direct model access)
- `DEV_CONSOLE=0` (no debug endpoints exposed)
- `FALLBACK_COOKIE` must be empty

## Configuration

All configuration is via environment variables, validated at startup. Invalid configuration causes the process to exit with code 2.

You can also use a `.env` file (reads `<cwd>/.env` by default, or set `ENV_FILE=<path>`). **Real environment variables always take precedence over the file.**

See [`.env.example`](.env.example) for the complete annotated reference.

### Core Settings

| Variable | Values | Description |
|----------|--------|-------------|
| `AUTH_MODE` | `password` \| `dev` | `password`: built-in username/password + JWT sessions. `dev`: trusts `X-Username` header (local only) |
| `LLM_MODE` | `platform` \| `direct` \| `faux` | Model provider. `platform`: fetch from backend. `direct`: connect to any OpenAI-compatible endpoint. `faux`: mock model |
| `SANDBOX_MODE` | `manager` \| `http` \| `local` \| `none` | Execution backend. `manager`: cluster with ticket-based auth (recommended). `http`: direct worker connection. `local`: in-process (dev only) |
| `SESSION_STORE` | `memory` \| `file` \| `mysql` | Session persistence. `file` writes to `DATA_DIR`. `mysql` for multi-replica deployments |
| `DATA_DIR` | Path | Storage root for sessions, memory, projects, cron. Default: `~/.agentpod` |

### Feature Toggles

| Variable | Default | Description |
|----------|---------|-------------|
| `MEMORY_ENABLED` | `1` | Long-term cross-session memory |
| `PROJECTS_ENABLED` | `1` | Project-based session grouping with instructions |
| `SESSION_AUTO_TITLE` | `1` | Let the model name each conversation on its first turn (once per session) |
| `ARTIFACTS_ENABLED` | `1` | Versioned artifacts kept outside the transcript |
| `ARTIFACT_ALLOWED_ORIGINS` | empty | External origins the artifact preview may load (comma-separated). **Fully offline by default** (Vue / mermaid runtimes ship with the app) |
| `ARTIFACT_MAX_FILES` | `40` | Maximum files per artifact |
| `CRON_ENABLED` | `1` | Scheduled task support |
| `WEB_UI` | `1` | Serve the built-in chat UI at `/` |
| `DEV_CONSOLE` | `0` | Debug endpoints (must be `0` in production) |

### Authentication (Password Mode)

| Variable | Description |
|----------|-------------|
| `CONSOLE_USERS` | `user1:pass1,user2:pass2` — comma-separated credentials |
| `SESSION_SECRET` | JWT signing key (auto-generated if omitted; sessions invalidate on restart) |
| `SESSION_TTL_HOURS` | Session token lifetime (default: 24) |

### Direct LLM Mode

For local development with real models (without a platform backend):

| Variable | Example | Description |
|----------|---------|-------------|
| `LLM_DIRECT_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible endpoint |
| `LLM_DIRECT_API_KEY` | `sk-xxx` | API key |
| `LLM_DIRECT_MODEL` | `gpt-4o-mini,gpt-4o` | Comma-separated, first is default |
| `LLM_DIRECT_INPUT` | `text,image` | Supported input modalities |

### Sandbox Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `SANDBOX_SLOTS` | `2` | Number of concurrent isolation slots per worker |
| `SANDBOX_TIMEOUT_MS` | `120000` | Command execution timeout |
| `SANDBOX_KEEPALIVE` | `1` | Periodic lease renewal during long model thinking |
| `SANDBOX_EXEC_ASYNC` | `1` | Async execution with disconnect recovery |

### Concurrency & Limits

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_CONCURRENT_RUNS` | `8` | Global concurrent run limit |
| `MAX_RUNS_PER_USER` | `2` | Per-user concurrent run limit |
| `RUN_TIMEOUT_MS` | `600000` | Maximum run duration (10 min) |

## API Reference

### Health & Diagnostics

| Method | Path | Description |
|--------|------|-------------|
| GET | `/healthz` | Liveness probe + concurrency stats + enabled features |
| GET | `/metrics.json` | Run duration percentiles, failure distribution, token usage |
| GET | `/v1/auth/me` | Current authenticated identity (401 if not logged in) |

### Chat

| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/chat/stream` | Start a conversation turn (SSE streaming response) |
| POST | `/v1/runs/:runId/abort` | Abort a running conversation (own runs only) |
| GET | `/v1/models` | Available model list |

**SSE Events:** `run_start` · `model` · `thinking` · `text` · `text_end` · `tool_call` · `tool_result` · `usage` · `final` · `error`

### Sessions

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/sessions` | List sessions. `?projectId=` to filter, `?includeArchived=1` |
| GET | `/v1/sessions/:key` | Session history (rendered messages) |
| PATCH | `/v1/sessions/:key` | Update title / pinned / archived / projectId |
| DELETE | `/v1/sessions/:key` | Delete session |
| GET | `/v1/search?q=` | Search sessions (title + body with snippets) |

### Projects

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/projects` | List projects |
| POST | `/v1/projects` | Create project |
| GET | `/v1/projects/:id` | Project details |
| PATCH | `/v1/projects/:id` | Update name / description / instructions / archived |
| DELETE | `/v1/projects/:id` | Delete project (sessions are ungrouped, not deleted) |

### Artifacts

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/artifacts?sessionKey=` | Artifact list (**no content**) plus the origins the preview may load |
| GET | `/v1/artifacts/:id?v=` | Details including **every file's content** for that version. Latest version when `v` is omitted |
| GET | `/v1/artifacts/:id/raw?path=&v=&download=1` | Raw content of a single file (`path` defaults to the entry file). **Always `text/plain` + `nosniff`** — this service never serves model-generated content as HTML |
| DELETE | `/v1/artifacts/:id` | Delete an artifact and all of its versions |

Writes happen only through the model's `artifact` tool; there is no public write endpoint.

### Memory

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/memory?projectId=` | Read memory (personal or project-scoped) |
| PUT | `/v1/memory?projectId=` | Update memory (requires `revision` for optimistic locking, 409 on conflict) |

### Scheduled Tasks

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/crons` | List scheduled tasks |
| POST | `/v1/crons` | Create task |
| GET | `/v1/crons/:id` | Task details |
| PATCH | `/v1/crons/:id` | Update task (including enable/disable) |
| DELETE | `/v1/crons/:id` | Delete task |
| POST | `/v1/crons/:id/run` | Trigger immediate execution |

### Skills & Workspace

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/skills` | Skill list with availability status |
| GET | `/v1/workspace` | User workspace usage and quota |

## Skills

Skills are directory-based — each skill is a folder containing `SKILL.md` (instructions) and `scripts/` (executable code):

```
my-skill/
├── SKILL.md           # Instructions for the model
└── scripts/
    ├── run.sh         # Entry point
    └── ...
```

Skills are loaded from directories specified in `SKILL_DIRS` (colon-separated). At runtime, skill directories are staged into the sandbox workspace so the model can execute them.

The model can also **create skills** during conversation using the `skill_save` tool, which persists them to the user's workspace for future sessions.

**Capability gating**: Skills without a sandbox backend are not announced to the model at all — rather than registering them and having the model repeatedly fail, they simply don't exist in the model's context.

## User Workspace

When `USER_WORKSPACE_ROOT` is configured, each user gets persistent storage that survives sandbox teardown:

```
<root>/users/<username>/
  skills/created/<name>/        User-created skills (read-only in sandbox)
  skills/installed/<name>/      Installed skills (read-only in sandbox)
  sessions/<key>/workspace/     Session workspace (read-write, synced back)
```

Only `workspace/` content is synced back from the sandbox. This prevents runaway scripts from modifying installed skills.

## Development

### Project Structure

```
src/                    Core agent service
├── agent/              Run orchestration, tool assembly, skill loading
├── http/               Routes, SSE streaming, graceful shutdown
├── identity/           Authentication (password JWT / dev header)
├── models/             LLM provider client, model factory, retry logic
├── sessions/           Session store (memory / file / mysql)
├── artifacts/          Versioned multi-file artifacts (metadata + per-version file tree)
├── memory/             Long-term memory (MEMORY.md + optimistic locking)
├── projects/           Project management (grouping + instructions)
├── cron/               Scheduled tasks (5-field cron + timezone)
├── sandbox/            Sandbox client (manager / http / local / none)
├── workspace/          User workspace (shared storage)
├── tools/              Extended tools (task plan, browser, memory, cron)
├── persistence/        File-based storage primitives
├── credentials/        Credential broker
└── telemetry/          Metrics collection

web/                    Chat UI (Vue 3 + Vite)
├── src/stores/         Global state (reactive singleton)
├── src/lib/            API client, SSE, markdown, debug bundle
└── src/components/     Sidebar, chat thread, tool cards, panels

sandbox-worker/         Isolated execution environment
├── src/namespace/      PID/mount/network namespace + cgroup setup
├── src/browser/        Playwright browser automation
└── src/manager/        Manager registration + ticket verification

sandbox-manager/        Cluster control plane
├── src/lib/            Registry, scheduler, ticket issuer
└── web/                Management console (Vue 3)

managed-skills/         Platform skills (synced from external repo)
builtin-skills/         Built-in skills (cloud-browser, skill-author)
scripts/                Static isolation rule checker (CI)
test/                   Isolation regression + integration tests
```

### Testing

```bash
# Run all checks (static isolation rules + unit/integration tests)
npm run check

# Tests only
npm test

# Isolation contract static analysis only
npm run check:isolation
```

The isolation tests include both **positive** (concurrent multi-user invisibility) and **negative** (deliberately break username filtering and assert the test must fail) cases. The negative case ensures the detector itself works — without it, a green test could mean the checker is broken.

### Isolation Contract

Multi-tenant isolation is enforced through multiple layers:

1. **Static analysis** (`scripts/check-isolation-rules.js`) — scans source for credential leaks, forbidden patterns
2. **Runtime guards** (`src/agent/run-turn.js`) — every run is scoped to a single username
3. **Storage isolation** — all data paths include username as a partition key
4. **Sandbox isolation** — each slot has independent Linux namespaces; tenant data is never co-located

Run `npm run check:isolation` to verify the static rules. The check runs in CI and must pass before merge.

## Tech Stack

- **Runtime**: Node.js ≥ 20.11 (ESM)
- **Agent Engine**: [@mariozechner/pi-coding-agent](https://github.com/nicholasgasior/pi-coding-agent)
- **Frontend**: Vue 3 + Vite
- **Sandbox**: Linux namespaces + cgroups (PID/mount/network/uts/ipc isolation)
- **Manager**: Fastify + TypeScript + Redis
- **Database**: MySQL (optional, for multi-replica session storage)
- **Container**: Docker + Docker Compose

## Contributing

Contributions are welcome! Please read the isolation contract documentation before modifying any code that touches user data or credentials:

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Run all checks (`npm run check`)
4. Commit your changes
5. Push to the branch and open a Pull Request

**Before submitting**: ensure `npm run check` passes. The static isolation rules and tests are there to prevent multi-tenant data leaks — PRs that break them will not be merged.

## License

[MIT](LICENSE)
