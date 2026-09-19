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

Activation records intent only in Phase 1. Collection and scheduling begin in Phase 2, so an active
task does not fetch external sources yet.
