# L0 Worker

Stateless, deterministic execution substrate for LLM inference. Receives commands from L1 orchestrator, executes tasks using the L0 runtime, and emits factual events back.

## 📖 Overview

L0 Worker is a serverless-first execution layer that:

- 📥 Receives task submissions via HTTP/SSE
- 🤖 Executes LLM inference using `@ai2070/l0` + Vercel AI SDK
- 📡 Streams events back to L1 orchestrator
- 🔇 Enforces backpressure by silence (no `TASK_ACCEPTED` = rejection)
- 🔁 Supports deterministic replay of recorded events

## 🛠️ Stack

- **Runtime:** Node.js + TypeScript
- **Inference:** `@ai2070/l0` (streaming runtime, retry, fallbacks, guardrails)
- **Providers:** `ai` + `@ai-sdk/openai`
- **Validation:** Zod
- **Deployment:** Vercel Serverless Functions

## 📦 Installation

```bash
npm install
```

## 💻 Development

```bash
# Local development with tsx
npm run dev

# Vercel local development
npm run dev:vercel

# Type checking
npm run lint

# Build
npm run build
```

## 🌐 API Endpoints

### POST /api/submit

Submit a task for execution. Returns streaming SSE response with events.

```bash
curl -X POST http://localhost:3000/api/submit \
  -H "Content-Type: application/json" \
  -d '{
    "type": "TASK_SUBMIT",
    "auth": {
      "token": "K7gNU3sdo+OL0wNhqoVWhr3g6s1xYv72ol/pe/Unols=",
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
    "worker_id": "...",
    "max_concurrency": 2,
    "effective_ts": 1702900000000
  }'
```

### POST /api/drain

Trigger graceful shutdown. Used by supervisor for cross-platform graceful shutdown.

- **Localhost**: No auth required
- **Non-localhost**: Requires valid auth token

```bash
# From localhost (no auth needed)
curl -X POST http://localhost:3000/api/drain

# From remote (auth required)
curl -X POST http://worker-host:3000/api/drain \
  -H "Content-Type: application/json" \
  -d '{
    "worker_id": "...",
    "auth": {
      "token": "...",
      "issued_at": 1702900000000,
      "ttl": 30000
    }
  }'
```

Response:
```json
{
  "success": true,
  "message": "Drain initiated",
  "workerId": "...",
  "drainBufferMs": 5000
}
```

The worker will emit `worker.draining` event and exit after `drainBufferMs` milliseconds.

## 📋 Inference Order

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

## 🔐 Authentication

Ephemeral, single-invocation auth with HMAC verification:

```typescript
{
  "auth": {
    "token": "HMAC-SHA256(secret, task_id|issued_at|ttl)",  // base64
    "issued_at": 1702900000000,  // Unix timestamp ms
    "ttl": 30000                  // Validity window ms
  }
}
```

**L1 generates tokens:**
```typescript
import { createHmac } from "node:crypto";

const payload = `${taskId}|${issuedAt}|${ttl}`;
const token = createHmac("sha256", L0_AUTH_SECRET)
  .update(payload, "utf8")
  .digest("base64");
```

- ✅ Token validated once per request via HMAC signature
- 🚫 Never stored, never reused
- ⏱️ Freshness check: `now - issued_at < ttl`
- 🔓 If `L0_AUTH_SECRET` is not set, signature verification is skipped (dev mode)

## 📤 Events

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

## ⏸️ Backpressure

L0 enforces backpressure by silence:

1. `TASK_SUBMIT` arrives
2. Check slot availability
3. If available → emit `TASK_ACCEPTED`
4. If no slot → **silence** (L1 infers rejection)

No queue. No buffering. No rejection event.

## 🔁 Replay

Replay re-emits recorded facts. It does NOT re-execute.

Replay must **NEVER**:
- ❌ Regenerate tokens differently
- ❌ Re-invoke tools with side effects
- ❌ Fabricate progress events
- ❌ Emit events that weren't originally recorded

## ⚙️ Configuration

### Deployment Presets

The worker auto-detects deployment environment and applies appropriate defaults:

| Setting | Local | Vercel |
|---------|-------|--------|
| `maxConcurrency` | 64 | 1 |
| `functionTimeoutMs` | 0 (disabled) | 60000 (60s) |
| `drainBufferMs` | 5000 | 5000 |
| `skipAuthValidation` | true | false |

Preset is selected by:
- `DEPLOYMENT=vercel` env var, or
- `VERCEL` env var (auto-set by Vercel platform)

### Environment Variables

All variables override preset defaults:

| Variable | Description |
|----------|-------------|
| `WORKER_ID` | Worker identifier (default: uuidv7) |
| `MAX_CONCURRENCY` | Max concurrent tasks |
| `FUNCTION_TIMEOUT_MS` | Serverless timeout in ms (0 = disabled) |
| `DRAIN_BUFFER_MS` | Buffer before timeout to emit WORKER_DRAINING |
| `SKIP_AUTH_VALIDATION` | Skip HMAC auth (default: true for local) |
| `L0_AUTH_SECRET` | Shared secret for HMAC auth (required in production) |
| `OPENAI_API_KEY` | OpenAI API key |

## 🖥️ Supervisor (Multi-Worker Pool)

For running multiple workers with automatic health checking and crash recovery, use the Rust supervisor:

```bash
cd supervisor
cargo build --release

# Run 4 workers starting at port 3001
./target/release/l0-supervisor -w 4 -p 3001 ./path/to/l0-worker
```

### Supervisor Features

- **Process pool management** - Spawn and manage multiple worker processes
- **Health checking** - Periodic HTTP health checks via `/api/status`
- **Crash recovery** - Automatic restart with exponential backoff
- **Hung worker detection** - Kill and restart workers that fail consecutive health checks
- **Graceful shutdown** - Cross-platform via `/api/drain` endpoint
- **Pool status API** - Query worker states for L1 routing
- **Event streaming** - Pool lifecycle events for monitoring

### Supervisor API

The supervisor exposes a REST API for querying pool state:

#### GET /api/pool

Returns status of all workers in the pool.

```bash
curl http://localhost:9000/api/pool
```

Response:
```json
{
  "workers": [
    { "id": "l0-1", "port": 3001, "state": "healthy", "consecutive_failures": 0 },
    { "id": "l0-2", "port": 3002, "state": "healthy", "consecutive_failures": 0 },
    { "id": "l0-3", "port": 3003, "state": "starting", "consecutive_failures": 0 }
  ],
  "healthy_count": 2,
  "total_count": 3
}
```

Worker states: `starting`, `healthy`, `draining`, `failed`, `stopped`

#### GET /api/pool/events (SSE)

Real-time event stream for worker lifecycle changes. L1 can subscribe once and receive instant notifications.

```bash
curl -N http://localhost:9000/api/pool/events
```

Events:
```
event: worker_healthy
data: {"id":"l0-1","port":3001}

event: worker_unhealthy
data: {"id":"l0-2","reason":"health check failed"}

event: worker_restarting
data: {"id":"l0-2","attempt":1}

event: worker_failed
data: {"id":"l0-2"}

event: all_workers_healthy
data: {}

event: shutting_down
data: {}
```

### Supervisor CLI Options

| Option | Description | Default |
|--------|-------------|---------|
| `-w, --workers` | Number of workers | CPU count |
| `-p, --base-port` | Starting port for workers | 3001 |
| `--api-port` | Supervisor API port | 9000 |
| `--health-interval` | Health check interval (ms) | 2000 |
| `--health-timeout` | Health check timeout (ms) | 2000 |
| `--restart-delay` | Initial restart delay (ms) | 500 |
| `--max-restart-delay` | Max restart delay (ms) | 30000 |
| `--max-failures` | Max consecutive failures before stopping | 5 |
| `--max-unhealthy-checks` | Max consecutive unhealthy checks before killing | 2 |
| `--shutdown-timeout` | Graceful shutdown timeout (ms) | 30000 |

### Building the Supervisor

```bash
cd supervisor
cargo build --release
```

The binary will be at `supervisor/target/release/l0-supervisor`.

## 📁 Project Structure

```
l0-worker/
├── api/                    # Vercel API routes
│   ├── submit.ts
│   ├── replay.ts
│   ├── status.ts
│   └── config.ts
├── src/
│   ├── index.ts            # Main exports
│   ├── server.ts           # Standalone Bun server
│   ├── worker-instance.ts  # Worker class
│   ├── config.ts           # Configuration defaults
│   ├── events/             # Event schemas
│   ├── executor/           # Task execution with L0
│   ├── inference/          # Inference order types
│   ├── state/              # Worker state machine
│   ├── store/              # Event recording
│   ├── replay/             # Event replay
│   ├── auth/               # Auth validation
│   └── utils/              # Utilities
├── supervisor/             # Rust process supervisor
│   ├── src/
│   │   ├── main.rs         # CLI entry point
│   │   ├── pool.rs         # Worker pool management
│   │   ├── worker.rs       # Worker process handling
│   │   └── health.rs       # Health checking
│   └── Cargo.toml
└── package.json
```

## 📄 License

Apache-2.0
