# L0 Worker Desktop Deployment Plan

## Overview

Create a two-component architecture for desktop/local deployment:
- **Rust Supervisor (`l0-supervisor`)**: Process management, health monitoring, restart on crash
- **Bun Worker (`l0-worker`)**: Existing TypeScript code compiled to single executable

## Architecture

```
┌─────────────────────────────────────────────────┐
│           l0-supervisor (Rust, ~5MB)            │
│  - Spawn/restart worker processes               │
│  - Health monitoring via /api/status            │
│  - Graceful shutdown orchestration              │
│  - Load balancing across workers                │
│  - IPC event forwarding to L1                   │
└──────────────────┬──────────────────────────────┘
                   │ spawns & monitors
     ┌─────────────┼─────────────────┐
     ▼             ▼                 ▼
┌─────────┐  ┌─────────┐       ┌─────────┐
│Worker 1 │  │Worker 2 │  ...  │Worker N │
│:3001    │  │:3002    │       │:300N    │
└─────────┘  └─────────┘       └─────────┘
```

## Component 1: Bun Worker Modifications

### Files to Modify

- `src/config.ts` - Add `PORT` env var support for dynamic port assignment
- `package.json` - Add bun build script

### Changes Required

1. **Dynamic port binding**
   ```typescript
   // src/config.ts
   port: Number(process.env.PORT) || 3000
   ```

2. **Bun build configuration**
   ```json
   // package.json
   "scripts": {
     "build:desktop": "bun build ./src/server.ts --compile --outfile dist/l0-worker"
   }
   ```

3. **Standalone HTTP server entry point**
   - Create `src/server.ts` that starts HTTP server (not Vercel-specific)
   - Reuse existing handler logic from `api/*.ts`

### New File: `src/server.ts`

Standalone HTTP server using Bun's native server:
- Mount existing route handlers
- Support SSE streaming
- Bind to `PORT` env var
- Emit ready signal to stdout for supervisor detection

---

## Component 2: Rust Supervisor

### New Directory: `supervisor/`

```
supervisor/
├── Cargo.toml
├── src/
│   ├── main.rs           # Entry point, CLI args
│   ├── config.rs         # Supervisor configuration
│   ├── worker.rs         # Worker process management
│   ├── health.rs         # Health check logic
│   ├── pool.rs           # Worker pool orchestration
│   └── proxy.rs          # Optional: HTTP proxy to workers
```

### Rust Dependencies (Cargo.toml)

```toml
[dependencies]
tokio = { version = "1", features = ["full"] }
reqwest = { version = "0.12", features = ["json"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tracing = "0.1"
tracing-subscriber = "0.3"
clap = { version = "4", features = ["derive"] }
```

### Supervisor Features

1. **Process Spawning**
   - Spawn N worker processes with unique PORT assignments
   - Capture stdout/stderr for logging
   - Detect ready state via stdout marker or first successful health check

2. **Health Monitoring**
   - Poll `GET /api/status` every 5s (configurable)
   - Check: `state == "ACCEPTING"` and process alive
   - Track consecutive failures before restart

3. **Restart Policy**
   - Immediate restart on crash (exit code != 0)
   - Exponential backoff on repeated failures (1s, 2s, 4s, max 30s)
   - Max restart attempts before marking worker as failed
   - **Important**: Only restart on process crashes, not semantic failures
     - Crash (exit != 0) → restart
     - Overload (503s) → do NOT restart, mark degraded
     - This distinction matters more in production; Phase 1 can be simpler

4. **Graceful Shutdown**
   - On SIGTERM/SIGINT: stop accepting new tasks
   - Send SIGTERM to workers, wait for drain
   - Force kill after timeout (30s default)

5. **Load Distribution** (optional, phase 2)
   - Round-robin task distribution
   - Or: single entry point proxy that forwards to least-loaded worker

---

## Implementation Phases

### Phase 1: Bun Worker Standalone Mode

1. Create `src/server.ts` - standalone HTTP server
2. Update `src/config.ts` - add PORT env support
3. Add `build:desktop` script to package.json
4. Test: `bun run build:desktop && ./dist/l0-worker`
5. Verify all endpoints work standalone

### Phase 2: Rust Supervisor Core

1. Initialize `supervisor/` Cargo project
2. Implement `worker.rs` - spawn single worker, monitor process
3. Implement `health.rs` - poll /api/status endpoint
4. Implement `main.rs` - CLI with worker-count arg
5. Test: supervisor spawns 1 worker, restarts on crash

### Phase 3: Worker Pool

1. Implement `pool.rs` - manage N workers
2. Add port assignment (base_port + index)
3. Add parallel health checking
4. Test: supervisor manages 2-4 workers

### Phase 4: Graceful Shutdown

1. Handle SIGTERM/SIGINT in supervisor
2. Propagate shutdown to workers
3. Wait for in-flight tasks to complete
4. Test: graceful shutdown with active tasks

### Phase 5: Distribution Bundle

1. Build script that produces:
   - `l0-supervisor` (Rust binary)
   - `l0-worker` (Bun compiled binary)
2. Single archive/installer for each platform
3. Test on macOS, Linux, Windows

---

## Configuration

### Supervisor CLI Arguments

```
l0-supervisor [OPTIONS]

Options:
  -w, --workers <N>          Number of worker processes (default: CPU cores)
  -p, --base-port <PORT>     Starting port for workers (default: 3001)
  --health-interval <MS>     Health check interval (default: 5000)
  --restart-delay <MS>       Initial restart delay (default: 1000)
  --max-restart-delay <MS>   Max restart delay (default: 30000)
  --shutdown-timeout <MS>    Graceful shutdown timeout (default: 30000)
  --worker-binary <PATH>     Path to l0-worker binary (default: ./l0-worker)
```

### Environment Variables (passed to workers)

- `PORT` - Assigned by supervisor
- `WORKER_ID` - Unique per worker
- `L0_AUTH_SECRET` - Shared auth secret
- `OPENAI_API_KEY` - API keys passed through

### Startup Logging

Worker logs mode once at startup (not a warning, just a fact):
```
mode=local auth=disabled
```

Or in production:
```
mode=production auth=enabled
```

---

## IPC Protocol

### Supervisor → Worker
- Environment variables at spawn
- SIGTERM for graceful shutdown
- SIGKILL for force kill

### Worker → Supervisor
- Stdout: Structured JSON ready signal
  ```json
  {"event":"worker.ready","port":3002,"workerId":"l0-2"}
  ```
- Exit code: 0 = clean, non-zero = crash
- HTTP: `/api/status` for health (see below)

### Health Endpoint Response

`GET /api/status` must expose intentional state:
```json
{
  "state": "ACCEPTING" | "DRAINING" | "STOPPED",
  "inflight": 12,
  "availableSlots": 2,
  "uptimeMs": 123456,
  "workerId": "l0-2"
}
```

This allows supervisor to make smarter shutdown decisions and avoid race conditions during restarts.

### Supervisor → L1 (future)
- Aggregate health from all workers
- Forward events from workers
- Single endpoint for task submission with load balancing

---

## Success Criteria

1. Single command starts supervisor + N workers
2. Worker crash triggers automatic restart within 2s
3. Graceful shutdown completes in-flight tasks
4. Distribution bundle < 60MB total
5. Cold start to ready < 500ms
