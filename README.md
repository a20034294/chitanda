# Chitanda

Self-hosted LLM information monitoring platform. The implementation follows
[PLATFORM_DESIGN.md](./PLATFORM_DESIGN.md).

## Requirements

- nvm
- Docker with Compose

## Local development

```sh
nvm use
corepack enable
pnpm install --frozen-lockfile
pnpm init:secrets
pnpm typecheck
pnpm test
pnpm dev
```

The Vite development UI listens on `http://localhost:5173`; the API listens on
`http://localhost:3000`.

## Docker Compose

```sh
pnpm init:secrets
docker compose -f deploy/compose.yaml up --build
```

On first launch, read `.secrets/bootstrap-token` and use it once in the setup screen to create the
administrator account. Secret files are generated with mode `0600` and are never overwritten by
`pnpm init:secrets`.

Compose exposes only the Chitanda API on `127.0.0.1:3000`. TLS and reverse proxy configuration
are intentionally out of scope and must be supplied by the deployment environment.

The optional local Qwen runtime is started with:

```sh
docker compose -f deploy/compose.yaml --profile local-llm up --build
```

## Configuration

Stable defaults live in `config/default.yaml`. Create one instance override from
`config/instance.example.yaml`, then set only:

```sh
CHITANDA_CONFIG_FILE=config/instance.yaml
```

This is the sole general-purpose bootstrap environment variable. Secrets are referenced as files
from the YAML configuration rather than copied into environment variables.

The default intent parser is local Qwen through Ollama. You can select OpenAI in the task preview
screen after placing an API key in `.secrets/openai-api-key`; no key is needed for local-only use.

## Phase 1 workflow

1. Create the first administrator with the one-time bootstrap token.
2. Optionally enroll TOTP. It is bypassed for local use by default; set
   `security.requireAdminMfa: true` for a public deployment.
3. Describe a monitoring need and select local Qwen or OpenAI.
4. Review clarification questions, warnings, and the editable `TaskDefinitionV1` JSON.
5. Confirm to persist revision 1 as a draft, then activate it explicitly. Revising a task creates a
   new immutable revision and returns it to draft status.

Phase 1 records and activates the interpreted intent. With Phase 2, an active task containing an
`rss` or `json_api` source is scheduled by the worker. Pure `manual` and `webhook` tasks are push
sources and are not scheduled for outbound requests.

## Phase 2 collection

- RSS/Atom source query: `{ "url": "https://example.com/feed.xml" }`
- JSON API source query supports `url`, `itemsPath`, `idField`, `urlField`, `titleField`,
  `contentField`, `authorField`, `publishedAtField`, and `languageField`.
- `POST /api/tasks/:id/run` queues an immediate pull run.
- `POST /api/tasks/:id/ingest` accepts up to 100 normalized records for authenticated manual or
  webhook ingestion.
- `GET /api/tasks/:id/runs` returns run state, counters, and sanitized failure details.
- `POST /api/tasks/:id/runs/:runId/retry` requeues a failed or dead-letter run as a new run.

Outbound connectors allow only HTTP(S), reject embedded URL credentials and private/loopback DNS
answers, enforce a 30-second timeout, and cap responses at 5 MiB. Task definitions must use public
source URLs; local fixture endpoints are intentionally blocked in production.

## Phase 3 analysis and Inbox

Collected item versions are processed in a separate, retryable analysis job. Deterministic filters
run first; items that pass can then use the task's selected Ollama or OpenAI provider for structured
classification, fact extraction, summarization, uncertainty, and evidence. Content sent to an LLM
is treated as untrusted data and cannot invoke tools. Every collection run pins its immutable task
revision so later task edits cannot change the meaning of an in-flight or retried run.

- `GET /api/events` lists the authenticated user's Inbox with optional `state`, `before`, and
  `limit` filters.
- `GET /api/events/:id` returns the exact immutable source version, analysis metadata, facts,
  uncertainty, and evidence used for the event.
- `POST /api/events/:id/state` marks an event `unread`, `read`, or `archived`.
- `POST /api/events/:id/feedback` stores `useful`, `irrelevant`, or `duplicate` feedback.

The worker creates idempotent `new_item`, `content_changed`, `field_changed`,
`threshold_crossed`, and `back_in_stock` events according to each task definition. The Runs panel
shows collection and analysis states separately, while the Inbox provides source links and short
evidence excerpts.

## Phase 4 notifications and web sources

- `webpage` extracts static HTML with configurable `itemSelector`, `titleSelector`,
  `linkSelector`, `contentSelector`, `dateSelector`, and `maxItems` fields.
- `search` uses the Brave Search API when `acquisition.search.enabled` is true and its API key file
  is configured.
- Every outbound HTTP request sends a configurable browser-like `acquisition.userAgent` plus common
  browser compatibility headers. Chitanda still enforces its SSRF, redirect, timeout, and
  response-size policies.
- SMTP supports immediate mail, daily digest grouping, quiet-hours deferral, database-backed retry,
  and deterministic message IDs. SMTP usernames, passwords, and search keys are read from secret
  files and must not be committed.
- The UI includes a deterministic Singapore concert template backed by the public Live Nation
  Singapore page. It runs every six hours, stores events in Inbox, and requests immediate Email.

Copy the relevant sections from `config/instance.example.yaml`, create the referenced files under
`.secrets/` (or mount Docker/Kubernetes secrets at `/run/secrets`), and enable Email or search only
after those files exist. Use **測試 Email** in the header to verify SMTP delivery to the signed-in
account. Static-page selectors are expected to require maintenance when a source changes its HTML.
