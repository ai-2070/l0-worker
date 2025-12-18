# L0 Worker

Stateless, deterministic execution substrate for LLM inference. Receives commands from L1 orchestrator, executes tasks using the L0 runtime, and emits factual events back.

## Overview

L0 Worker is a serverless-first execution layer that:

- Receives task submissions via HTTP/SSE
- Executes LLM inference using `@ai2070/l0` + Vercel AI SDK
- Streams events back to L1 orchestrator
- Enforces backpressure by silence (no `TASK_ACCEPTED` = rejection)
- Supports deterministic replay of recorded events

## Stack

- **Runtime:** Node.js + TypeScript
- **Inference:** `@ai2070/l0` (streaming runtime, retry, fallbacks, guardrails)
- **Providers:** `ai` + `@ai-sdk/openai`
- **Validation:** Zod
- **Deployment:** Vercel Serverless Functions

## Installation

```bash
npm install
```

## Development

```bash
# Local development with tsx
npm run dev

# Vercel local development
npm run dev:vercel

# Type checking
npm run typecheck

# Build
npm run build
```

## API Endpoints

### POST /api/submit

Submit a task for execution. Returns streaming SSE response with events.

```bash
curl -X POST http://localhost:3000/api/submit \
  -H "Content-Type: application/json" \
  -d '{
    "type": "TASK_SUBMIT",
    "auth": {
      "token": "your-32-char-minimum-token-here!",
      "issued_at": 1702900000000,
      "ttl": 30000
    },
    "task_id": "task-123",
    "order": {
      "execution": {
        "models": [{ "provider": "openai", "model": "gpt-4o" }]
      },
      "output": { "kind": "text" }
    },
    "payload": { "prompt": "Hello, world!" },
    "input_hash": "sha256:...",
    "submission_ts": 1702900000000
  }'
```

### POST /api/replay

Replay recorded events for a task. Does NOT re-execute - only re-emits previously recorded events.

```bash
curl -X POST http://localhost:3000/api/replay \
  -H "Content-Type: application/json" \
  -d '{
    "type": "TASK_REPLAY_REQUEST",
    "auth": { "token": "...", "issued_at": ..., "ttl": 30000 },
    "task_id": "task-123",
    "input_hash": "sha256:...",
    "reason": "verification",
    "replay_ts": 1702900000000
  }'
```

### GET /api/status

Get worker status.

```bash
curl http://localhost:3000/api/status
```

### POST /api/config

Update worker configuration (hot reload).

```bash
curl -X POST http://localhost:3000/api/config \
  -H "Content-Type: application/json" \
  -d '{
    "type": "WORKER_CONFIG_UPDATE",
    "worker_id": "l0-...",
    "max_concurrency": 2,
    "effective_ts": 1702900000000
  }'
```

## Inference Order

Every task submission requires an `order` that defines execution and output contract:

```typescript
{
  "order": {
    "execution": {
      "models": [
        { "provider": "openai", "model": "gpt-4o", "params": { "temperature": 0.7 } }
      ],
      "retry": {
        "attempts": 3,
        "maxRetries": 6,
        "backoff": "exponential",
        "baseDelayMs": 1000
      },
      "fallbacks": [
        { "when": "error", "model": { "provider": "openai", "model": "gpt-4o-mini" } }
      ]
    },
    "output": {
      "kind": "json",
      "schema": { "type": "object", "properties": { "name": { "type": "string" } } },
      "strict": true
    }
  }
}
```

### Output Kinds

| Kind | Description |
|------|-------------|
| `text` | Raw text stream |
| `tokens` | Token-by-token stream |
| `json` | Structured JSON with schema validation |

## Authentication

Ephemeral, single-invocation auth envelope:

```typescript
{
  "auth": {
    "token": "min-32-char-high-entropy-secret",
    "issued_at": 1702900000000,  // Unix timestamp ms
    "ttl": 30000                  // Validity window ms
  }
}
```

- Token validated once per request
- Never stored, never reused
- Freshness check: `now - issued_at < ttl`

## Events

### Outbound (Worker → L1)

| Event | Description |
|-------|-------------|
| `WORKER_READY` | Worker initialized and accepting tasks |
| `WORKER_LOAD` | Current resource pressure |
| `TASK_ACCEPTED` | Task accepted for execution |
| `TASK_PROGRESS` | Milestone reached (first_token, streaming, etc.) |
| `TASK_COMPLETED` | Execution succeeded |
| `TASK_FAILED` | Execution failed |
| `WORKER_DRAINING` | Graceful shutdown in progress |
| `WORKER_OFFLINE` | Worker shutting down |

### L0 Lifecycle Events

L0 runtime events are passed through directly to L1:

- `SESSION_START`, `SESSION_END`
- `RETRY_START`, `RETRY_ATTEMPT`, `RETRY_END`
- `FALLBACK_START`, `FALLBACK_END`
- `GUARDRAIL_PHASE_START`, `GUARDRAIL_PHASE_END`
- `TIMEOUT_TRIGGERED`, `NETWORK_ERROR`
- And more (see [API.md](./API.md))

## Backpressure

L0 enforces backpressure by silence:

1. `TASK_SUBMIT` arrives
2. Check slot availability
3. If available → emit `TASK_ACCEPTED`
4. If no slot → **silence** (L1 infers rejection)

No queue. No buffering. No rejection event.

## Replay

Replay re-emits recorded facts. It does NOT re-execute.

Replay must **NEVER**:
- Regenerate tokens differently
- Re-invoke tools with side effects
- Fabricate progress events
- Emit events that weren't originally recorded

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `WORKER_ID` | `l0-{uuidv7}` | Worker identifier |
| `MAX_CONCURRENCY` | `1` | Max concurrent tasks |
| `OPENAI_API_KEY` | - | OpenAI API key |

## Project Structure

```
l0-worker/
├── api/                    # Vercel API routes
│   ├── submit.ts
│   ├── replay.ts
│   ├── status.ts
│   └── config.ts
├── src/
│   ├── index.ts            # Main exports
│   ├── worker-instance.ts  # Vercel worker class
│   ├── config.ts           # Configuration defaults
│   ├── events/             # Event schemas
│   ├── executor/           # Task execution with L0
│   ├── inference/          # Inference order types
│   ├── state/              # Worker state machine
│   ├── store/              # Event recording
│   ├── replay/             # Event replay
│   ├── auth/               # Auth validation
│   └── utils/              # Utilities
└── package.json
```

## License

PROPRIETARY
