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
- **Sharing and the artifact market** — Any artifact can become a `/s/<token>` link that **needs no account** to open and always shows the latest version; revoke it and it dies instantly. Publishing to the public market at `/market` is a second, separate click — sending one colleague a link and "I want everyone to see this" are two different decisions, so they are two different switches. The visitor's page still only handles JSON, and the artifact runs in the same sandboxed iframe: **the server never serves model-generated content as HTML**. Turn the whole thing off with `ARTIFACT_SHARING_ENABLED=0`.
- **Long-term memory** — Cross-session facts stored as human-readable `MEMORY.md`, editable by both users and the model.
- **Projects** — Group sessions under projects with persistent instructions and project-scoped memory.
- **Scheduled tasks** — 5-field cron expressions with IANA timezone support. The model can create tasks directly from conversation.
- **Extensible skills** — Directory-based skill system (`SKILL.md` + `scripts/`) that gets staged into the sandbox at runtime.
- **User workspace** — Persistent shared storage for session workspaces and user-created skills that survive sandbox teardown.
- **Zero cold start** — Fixed sandbox slot pool with pre-built namespaces. Execution = spawn in an already-running slot.
- **Docker-ready** — Three images (Agent + Worker + Manager) orchestrated via `docker compose`.

## Quick Start

### Local Development

The agent runs on the host (edit, restart, no image rebuild); its dependencies — the sandbox
cluster and MySQL — run in containers. **The database is not optional**: structured data lives
only in MySQL, there is no file mode (see [MySQL](#mysql-required) for why).

```bash
# Dependencies: worker + manager + redis + mysql
docker compose -f docker-compose.dev.yml up -d

# Install and build the web UI (only needed once, or after changing web/)
npm run web:install
npm run web:build

# Configure and start the agent
cp .env.example .env.dev
# Change these lines (each one is marked "本地开发：" in the file):
#   MYSQL_HOST=localhost
#   SANDBOX_MANAGER_URL=http://localhost:3000
#   SANDBOX_MANAGER_CODE=dev-api-code
#   LLM_MODE=faux
#   SKILL_DIRS=builtin-skills:managed-skills
#   CONSOLE_USERS=admin:changeme
npm run dev

# Open http://127.0.0.1:8787 (default login: admin / changeme)
```

**`.env.example` is the only config file** (there used to be a second `.env.dev.template`; two
half-lists that never reminded each other, so a few switches only ever existed in one of them).
Its values are written for the full-stack deployment — containers find each other by service
name — which is why local development needs the edits above; every such line is marked in place.
The defaults cannot simply be `localhost`: compose feeds `.env` into `${MYSQL_HOST:-mysql}` for
interpolation, so the agent container would try to reach itself.

`LLM_MODE=faux` is a mock model — no API key, no network — but it **never calls a tool**, so
skills, sandboxes and artifacts cannot be exercised under it; switch to `db` (models managed in
the admin console) or `direct` when you need those. Tables are created on first start. To try
self-registration too, turn on `AUTH_ALLOW_REGISTER=1`, `REGISTER_VERIFY_EMAIL=1` and
`MAIL_TRANSPORT=log` — the last one prints the message, code included, into the server log
instead of sending it.

`npm test` does **not** need a database: the store tests run against an in-memory double
(`test/helpers/memory-storage.js`). Point `AP_TEST_MYSQL_URL` at a scratch database to additionally
run the storage contract against real MySQL — CI should do that, since it is what catches the double
drifting from the real backend.

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
| `LLM_MODE` | `platform` \| `db` \| `direct` \| `faux` | Model provider. `platform`: fetch the list and each user's llmToken from the backend. `db`: the list admins configure in the console, stored in MySQL and scoped by user group (see [Model configuration and user groups](#model-configuration-and-user-groups)). `direct`: connect to any OpenAI-compatible endpoint (local integration only). `faux`: mock model |
| `LLM_CONFIG_SECRET` | passphrase | Only meaningful under `LLM_MODE=db`: encrypts model API keys at rest. Empty = stored in plaintext |
| `SANDBOX_MODE` | `manager` \| `http` \| `local` \| `none` | Execution backend. `manager`: cluster with ticket-based auth (recommended). `http`: direct worker connection. `local`: in-process (dev only) |
| `MYSQL_HOST` etc. | — | **Required.** Sessions, projects, long-term memory, artifacts, shares/market, cron and accounts all live in the database — see the MySQL section below |

### Feature Toggles

| Variable | Default | Description |
|----------|---------|-------------|
| `MEMORY_ENABLED` | `1` | Long-term cross-session memory |
| `PROJECTS_ENABLED` | `1` | Project-based session grouping with instructions |
| `SESSION_AUTO_TITLE` | `1` | Let the model name each conversation on its first turn (once per session) |
| `ARTIFACTS_ENABLED` | `1` | Versioned artifacts kept outside the transcript |
| `ARTIFACT_ALLOWED_ORIGINS` | empty | External origins the artifact preview may load (comma-separated). **Fully offline by default** (Vue / mermaid runtimes ship with the app) |
| `ARTIFACT_MAX_FILES` | `40` | Maximum files per artifact |
| `ARTIFACT_SHARING_ENABLED` | `1` | Share links (`/s/<token>`, **readable without logging in**) — the only unauthenticated data path in the service |
| `ARTIFACT_MARKET_ENABLED` | `1` | Public artifact market (`/market`). Only carries artifacts the author **explicitly publishes** |
| `CRON_ENABLED` | `1` | Scheduled task support |
| `WEB_UI` | `1` | Serve the built-in chat UI at `/` |
| `DEV_CONSOLE` | `0` | Debug endpoints (must be `0` in production) |

### Authentication (Password Mode)

| Variable | Description |
|----------|-------------|
| `CONSOLE_USERS` | `user1:pass1,…` — **seeding only**: accounts are copied into the account store at startup (existing ones are left alone). After that, add users and change passwords through the UI or the API; only a scrypt derivation is stored. On a fresh deployment the first entry becomes the admin |
| `AUTH_ALLOW_REGISTER` | Open self-service registration, **default `0`**. An account here means "can run models, can open sandboxes", so this has to be turned on deliberately. Once on, the first person to register becomes the admin |
| `SESSION_SECRET` | JWT signing key (auto-generated if omitted; sessions invalidate on restart) |
| `SESSION_TTL_HOURS` | Session token lifetime (default: 24) |
| `REGISTER_REQUIRE_EMAIL` | Require an email address at registration (default `0`) |
| `REGISTER_VERIFY_EMAIL` | The address must be proven with a code before the account is activated (default `0`). Once on, registration **no longer issues a token** — the user has to call `/v1/auth/activate` first. Requires a working mail account, otherwise the service refuses to start |
| `REGISTER_CODE_LENGTH` / `REGISTER_CODE_TTL_MINUTES` / `REGISTER_CODE_MAX_ATTEMPTS` | Code length, lifetime and attempt cap (defaults 6 / 15 / 5). Six digits cannot resist enumeration on their own — what actually holds is **the code being voided once attempts run out** |
| `REGISTER_CODE_RESEND_SECONDS` | Minimum gap between two sends (default 60). Without it, a `/resend` loop is a free mail cannon |
| `REGISTER_EMAIL_DOMAINS` | Only allow these email domains (comma-separated; empty = no restriction) |

### Mail account

One purpose only: registration codes. **No nodemailer** — the SMTP client lives in
`src/mail/smtp.js` at roughly two hundred lines; a new dependency tree is not worth
one plain-text message.

| Variable | Description |
|----------|-------------|
| `MAIL_TRANSPORT` | `smtp` (default, actually sends) or `log` (does not send; dumps the whole message, code included, into the log). **Forbidden in production** — that hands account activation to anyone who can read logs |
| `MAIL_SMTP_HOST` / `MAIL_SMTP_PORT` | Server and port (default 465) |
| `MAIL_SMTP_SECURE` | `1` = implicit TLS on connect (465); `0` = plain connect then STARTTLS (587). Defaults to whatever the port implies. If the server does not offer STARTTLS the send **fails** rather than quietly continuing in the clear |
| `MAIL_SMTP_USER` / `MAIL_SMTP_PASS` | Credentials. Most providers want an app password here, not the login password |
| `MAIL_FROM` / `MAIL_FROM_NAME` | Sender. An empty `MAIL_FROM` falls back to `MAIL_SMTP_USER` |
| `MAIL_TLS_REJECT_UNAUTHORIZED` | Default `1`. Turning it off lets this hop be intercepted — and the message carries the code. Forbidden in production |

### MySQL (required)

**Structured data lives only in the database — there is no file mode.** Sessions, projects,
long-term memory, artifacts, shares/market, cron, accounts and cron credentials are all in MySQL.

Tables are created at startup (`CREATE TABLE IF NOT EXISTS`, safe to re-run) — no manual import
step. The reviewable source of truth is [`src/persistence/schema.sql`](src/persistence/schema.sql).

```bash
docker compose up -d      # ships a mysql service; agent waits for its healthcheck
```

The container port binds to loopback only (`MYSQL_BIND`): a database shouldn't become reachable
from the LAN just because someone ran a compose file.

| Variable | Default | Description |
|----------|---------|-------------|
| `MYSQL_HOST` / `MYSQL_PORT` | — / `3306` | |
| `MYSQL_USER` / `MYSQL_PASSWORD` / `MYSQL_DATABASE` | — | |
| `MYSQL_CONNECTION_LIMIT` | `10` | The whole process **shares one pool** (separate pools per store would make this number meaningless, and multiply out to saturate the database across replicas) |

**Why the file mode was dropped**: supporting two backends costs something at *every* change — each
storage operation has to be written twice, plus a contract test to pin them together, and the
semantic differences between them only surface in production. On top of that the file backend could
only ever be "fine on a single replica": its read-modify-write serialises within one process, with no
cross-replica lock, so two replicas editing the same record have the later write clobber the earlier
one; and being local disk, the same person hitting a different replica sees different history. MySQL
does read-modify-write in a transaction with row locks, which holds across replicas. The long form is
in the header of [`src/persistence/storage.js`](src/persistence/storage.js).

⚠️ **No automatic migration.** Upgrading from a version that stored data under `DATA_DIR` will *not*
move those sessions, projects, memories or artifacts into the database — they stay where they are and
the service no longer reads them. Import them yourself if you need them, or keep the old version
around to export.

⚠️ One thing stays out of the database: session workspaces and user skills
(`USER_WORKSPACE_ROOT`). Those get staged into sandboxes as whole directories with no size ceiling —
that is a shared-filesystem job.

### Model configuration and user groups

Under `LLM_MODE=db` the model list lives in MySQL and admins maintain it from **Admin console → Models**.
Changes take effect **immediately, no restart**:

| Field | Notes |
|-------|-------|
| Name | Human-readable label, shown in the model picker |
| Model ID | The name sent upstream, e.g. `claude-sonnet-5`. **Unique across the deployment** — it is what users select and what the usage ledger bills against |
| Base URL | OpenAI-compatible endpoint. A trailing `/chat/completions` is stripped (the SDK appends it itself) |
| API key | Server-side only; the API returns a mask (`sk-1a••••••cd9f`). Leaving it blank on edit means "don't touch it" |
| Context window / max output | Max output `0` means the field is omitted entirely so the upstream default applies |
| Image input / reasoning | Getting image input wrong makes pi **silently drop** screenshots from tool results — the model only sees "Screenshot captured: N bytes" |
| Allowed groups | None checked = available to everyone; otherwise only members of those groups see it |
| Sort | Ascending. **The first enabled model is the default** — the one used when the user picks nothing |

**User groups** are maintained on the Groups page. A group only decides which models a person can use —
it is not a role (that is `role`) and not an isolation boundary (sessions, artifacts and memory have always
been isolated per account). New accounts join whichever group is marked default. Users with no group get the
models that have no group restriction. Deleting a group returns its members to "no group" and detaches it
from every model's allow list — neither accounts nor models are deleted.

⚠️ **The key in this mode belongs to the deployment**, shared by everyone using that model — the same property
that gets `direct` rejected in production. It is allowed here because the cost is covered: usage is still
recorded per `username + model_id` in `ap_usage` (the admin usage page still answers "who burned what"),
visibility is scoped by group, and keys never reach the browser. What it still cannot do is **split billing
upstream** — the upstream sees one key and bills one line. Deployments that need per-user upstream accounting
should use `LLM_MODE=platform`.

Set `LLM_CONFIG_SECRET` to encrypt newly saved keys at rest with AES-256-GCM; leave it empty and they are
stored in plaintext (guarded only by database access control, with a startup warning). Change or lose that
secret and the affected rows are flagged "cannot decrypt" in the console and skipped — rather than taking
everyone's conversations down with them.

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
| GET | `/v1/auth/me` | Current authenticated identity (401 if not logged in), including `account` (role, disabled) |

### Accounts (`AUTH_MODE=password`)

Passwords are stored as a **scrypt derivation plus a per-user salt** — no plaintext anywhere.
Verification is constant-time and **runs a full derivation even when the user doesn't exist**,
otherwise "does this username exist" leaks through response timing, which is step one of credential stuffing.

| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/auth/login` | Username + password → JWT. Every failure returns the same message (the real reason goes to the log only) |
| POST | `/v1/auth/register` | Self-service registration `{ username, password, email? }`. Requires `AUTH_ALLOW_REGISTER=1`, otherwise 403. With `REGISTER_VERIFY_EMAIL` on it returns **202 + `pendingActivation` and no token** — the account starts out inactive |
| POST | `/v1/auth/activate` | `{ username, code }` → activates and signs in. They just proved both that they know the password and that they can read that mailbox; sending them back to the login form verifies nothing extra |
| POST | `/v1/auth/activation/resend` | Resend the code. Unknown or already-active accounts still get a **200** — otherwise this is a username probe that does not even need a password. A too-soon resend returns 429 |
| POST | `/v1/auth/password` | Change your own password. **Requires the old password** — letting a token alone change it turns "borrowed for a minute" into permanent takeover |
| GET | `/v1/admin/users` | List accounts (admin only) |
| POST | `/v1/admin/users` | Admin creates an account |
| PATCH | `/v1/admin/users/:name` | `{ disabled, role, newPassword, groupId }`. Disabling **keeps the data**; you cannot disable yourself or drop your own admin role (nobody might be left who can undo it). An empty `groupId` leaves the group; a non-empty one must actually exist |
| GET | `/v1/admin/models` | Model list (admin only). **Keys come back masked.** `effective` says whether this list is currently in use (only under `LLM_MODE=db`); `encrypted` says whether keys are encrypted at rest |
| POST | `/v1/admin/models` | Add a model: `{ name, model, baseUrl, key, contextWindow, maxTokens, input, reasoning, groups, enabled, sort }` |
| PATCH | `/v1/admin/models/:id` | Edit one. **Omitting `key` leaves it alone**; pass `key: null` to clear it |
| DELETE | `/v1/admin/models/:id` | Delete one. **Historical usage rows are kept** — the bill still has to add up |
| GET | `/v1/admin/groups` | Groups, each with `userCount` and `modelCount`; `ungrouped` counts accounts with no group |
| POST | `/v1/admin/groups` | Create a group: `{ name, description, isDefault }`. At most one default (setting a new one clears the old) |
| PATCH | `/v1/admin/groups/:id` | Rename, re-describe, or make default |
| DELETE | `/v1/admin/groups/:id` | Delete: members fall back to "no group", every model's allow list drops it. Returns `{ detachedUsers, detachedModels }` |
| GET | `/v1/admin/usage` | Token usage, admin only. `?days=30` is the window (`days=0` = all time); `?group=user` (default) gives a row per account carrying the models it used, `?group=model` gives a row per model carrying the accounts that used it. Both are transposes of one **account × model** cross-tab, so the totals are identical either way. Accounts that never ran anything still get a row of zeros — otherwise "never used it" and "doesn't exist" look identical |
| GET | `/v1/admin/usage/user/:name` | One account's per-day series; `?modelId=` narrows it to a single model |
| GET | `/v1/admin/usage/model/:modelId` | One model's per-day series across all accounts |

Usage is attributed **per model, not just per account** — model prices differ by an order of
magnitude, so "this user spent 8M tokens" is unbillable on its own. `cache_read_tokens` is a
separate column for the same reason: it is priced differently from fresh input, so it is never
folded into the headline total. All three endpoints return aggregates only — **no conversation
content passes through them**.

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
| POST | `/v1/artifacts/:id/share` | Create a share link. **Idempotent** — an already-shared artifact returns its existing link rather than invalidating the one you sent out |
| PATCH | `/v1/artifacts/:id/share` | `{ market, summary }`: list/delist on the artifact market, edit the blurb |
| DELETE | `/v1/artifacts/:id/share` | Revoke — the link stops working immediately |

### Public sharing (**no authentication**)

The only routes in the service that sit before authentication. Three rules: **token-only** (there is no
"name an id and read it" entry point); every failure is a 404 (never distinguish "no such link" from
"revoked" — that would be a probe for whether a token exists); content is always `text/plain`.
A share **always follows the latest version** — the author ships a new one, visitors see it on refresh.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/public/shares/:token` | Metadata plus **every file of the latest version**. No `sessionKey` / `projectId` / version history |
| GET | `/v1/public/shares/:token/raw?path=&download=1` | Raw content of a single file. Shares the same send function as the authenticated route — `text/plain` + `nosniff` |
| GET | `/v1/public/market?q=&kind=` | Artifact market listing (**no content**), newest publications first |
| GET | `/s/:token`, `/market` | The pages themselves. These return **our own** SPA shell, never the artifact's HTML |

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
├── identity/           Authentication (password JWT / dev header) + user groups
├── models/             LLM provider client, model factory, retry logic, admin-configured model list
├── sessions/           Session store (memory / file / mysql)
├── artifacts/          Versioned multi-file artifacts (metadata + per-version file tree)
├── memory/             Long-term memory (MEMORY.md + optimistic locking)
├── projects/           Project management (grouping + instructions)
├── cron/               Scheduled tasks (5-field cron + timezone)
├── sandbox/            Sandbox client (manager / http / local / none)
├── workspace/          User workspace (shared storage)
├── tools/              Extended tools (task plan, browser, memory, cron)
├── persistence/        File-based storage primitives
├── credentials/        Credential broker + encryption-at-rest for model keys
└── telemetry/          In-process metrics + the persisted per-user token usage ledger

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
