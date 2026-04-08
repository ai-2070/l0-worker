# L0 Worker: A Stateless Execution Substrate for Reliable LLM Inference

**The missing layer between orchestrators and language models**

> LLM inference in production is fragile. Providers fail, streams stall, rate limits fire without warning, and output quality varies between calls. L0 Worker absorbs the full complexity of reliable inference into a single stateless process that accepts declarative orders and emits deterministic events.

*Version 1.0 - April 2026*

---

## Abstract

Production LLM inference has a reliability problem. Providers fail mid-stream, rate limits appear without warning, outputs violate schemas, and latency spikes from 200ms to 30 seconds. Most systems cope by scattering retry logic, timeout handling, and output validation across application code that was never designed for it.

**L0 Worker** is a purpose-built execution substrate that sits between an orchestrator (L1) and LLM providers. It wraps the [L0 deterministic streaming runtime](https://github.com/ai-2070/l0) (`@ai2070/l0`) - which provides token-level reliability, guardrails, drift detection, and event sourcing - and adds the operational layer required for production deployment: concurrency control via fixed slot pools, a strict worker lifecycle state machine, ephemeral HMAC authentication, drain-aware abort for serverless platforms, deterministic replay from an in-memory event store, and a complete SSE event protocol for orchestrator communication.

The orchestrator submits declarative *inference orders* specifying models, retry policy, fallback chains, guardrails, timeouts, output shape, and tool schemas. L0 Worker interprets each order, executes it reliably through the L0 runtime, and reports exactly what happened as a stream of typed events. No polling. No internal queues. No opinions about scheduling. The worker does one thing - execute inference reliably - and tells you what it did.

Deployable as a standalone Bun server, a Vercel serverless function, or a pool of processes managed by a Rust supervisor.

---

## 1. The Problem

### 1.1 Inference Is Not a Function Call

The mental model of `response = llm(prompt)` breaks down in production along every axis:

- **Latency is unbounded.** First-token latency can spike from 200ms to 30 seconds under provider load. Inter-token gaps can stall indefinitely.
- **Failures are partial.** A stream can deliver 90% of a response and then drop the connection. The 90% may or may not be usable.
- **Output quality is non-deterministic.** The same prompt can produce valid JSON on one call and malformed garbage on the next. Temperature zero does not guarantee identical outputs across calls.
- **Rate limits are opaque.** Providers throttle based on internal state the caller cannot observe. Retry timing is a guess.
- **Cost accrues on failure.** A timed-out inference still consumes tokens. A retried inference doubles the cost. A fallback to a larger model triples it.

### 1.2 The Scatter Problem

Without a dedicated reliability layer, every system that calls an LLM independently re-implements:

- Retry logic (often wrong - no jitter, no backoff ceiling, no distinction between retryable and terminal errors)
- Timeout handling (often missing entirely until the first production incident)
- Fallback chains (often hardcoded, untested, and triggered too late)
- Output validation (often post-hoc, after the full response has been buffered)
- Observability (often ad-hoc logging that captures neither the full event sequence nor enough context to diagnose failures)

This scattered reliability logic is expensive to maintain, inconsistent across services, and difficult to test in isolation. Worse, it couples orchestration logic to provider-specific failure modes, making it harder to swap providers or add new ones.

### 1.3 The Serverless Constraint

Serverless platforms add a hard constraint: function execution has a wall-clock deadline. An inference call that exceeds the function timeout is killed mid-stream with no cleanup. This means:

- In-flight tokens are lost
- No terminal event is emitted
- The orchestrator cannot distinguish between "still running" and "silently dead"
- Provider connections may remain open, consuming resources

A reliability substrate for LLM inference must be serverless-aware - it must know when the deadline approaches and drain gracefully before the platform kills it.

### 1.4 The Two-Layer Problem

Token-level reliability (retries, guardrails, drift detection, checkpoints) and operational reliability (concurrency, lifecycle, authentication, deployment) are different concerns that belong in different layers:

- **L0 runtime** (`@ai2070/l0`) solves the streaming problem: it wraps any AI stream and upgrades it into a deterministic, observable execution with retry, fallback, guardrails, timeouts, drift detection, and checkpoint resumption.
- **L0 Worker** solves the operational problem: it wraps the L0 runtime in a deployable process with slot management, lifecycle governance, event sourcing, authentication, and a protocol for orchestrator communication.

Neither layer alone is sufficient. The runtime without the worker has no concurrency control, no deployment model, and no protocol. The worker without the runtime has no token-level reliability. Together they form a complete execution substrate.

---

## 2. Design Principles

L0 Worker is built on five principles that constrain every design decision:

### 2.1 Statelessness

The worker holds no persistent state. It can be killed, restarted, or scaled to zero at any time without data loss. The only in-memory structure is the event store for replay, which is ephemeral by design - if the process dies, events are re-requested from the orchestrator or regenerated.

**Implication:** No database. No disk writes. No coordination between worker instances. Each worker is an island.

### 2.2 Determinism

Every event emitted during task execution is recorded. A replay request re-emits those events byte-for-byte - same order, same content, same hashes. Replay never regenerates tokens, re-invokes tools, or fabricates events. A monotonic clock ensures event timestamps are strictly increasing even if the system clock drifts backward.

**Implication:** The event stream is the single source of truth. If the SSE connection drops, the orchestrator can replay from the event store without re-executing the inference. The output hash guarantees integrity.

### 2.3 Declarative Execution

The orchestrator does not tell L0 *how* to execute. It submits an *inference order* - a declarative specification of models, retry policy, fallback chain, guardrails, timeout thresholds, and output shape. L0 interprets the order and reports what happened.

**Implication:** No imperative control flow crosses the L1/L0 boundary. The orchestrator's contract is: "here is what I want; tell me what you did." This makes orders portable across worker implementations and provider backends.

### 2.4 Backpressure by Silence

When a worker has no available slots, it does not reject the task, queue it, or send an error. It simply does not emit `TASK_ACCEPTED`. The orchestrator infers rejection from the absence of acknowledgment.

**Implication:** No rejection protocol. No queue depth to monitor. No buffering that hides overload. The orchestrator always knows: either a worker accepted the task (and will report on it), or no worker did (and the orchestrator must decide what to do).

### 2.5 Event-Driven Observability

Every significant moment in task execution - first token, tool invocation, retry attempt, fallback selection, guardrail check, timeout trigger, checkpoint save - is emitted as a typed event over SSE. The orchestrator receives a complete, ordered narrative of what happened and why.

**Implication:** No log scraping. No metrics aggregation. No post-hoc reconstruction of what went wrong. The event stream *is* the observability layer.

---

## 3. Architecture

### 3.1 System Topology

```
                    +-------------------------------------+
                    |           L1 Orchestrator            |
                    |  (scheduling, routing, tool exec)    |
                    +----------+--------------^------------+
                               |              |
                        TASK_SUBMIT      SSE Events
                               |              |
                    +----------v--------------+------------+
                    |          L0 Worker                    |
                    |  +-----------------------------------+
                    |  |  Slot Manager                     |
                    |  |  +----+ +----+ +----+ +----+     |
                    |  |  | S1 | | S2 | | S3 | | .. |     |
                    |  |  +--+-+ +--+-+ +--+-+ +--+-+     |
                    |  +-----+------+------+------+-------+
                    |        |      |      |      |        |
                    |  +-----v------v------v------v-------+
                    |  |        L0 Runtime (@ai2070/l0)    |
                    |  |  Retry . Fallback . Guardrails    |
                    |  |  Timeout . Drift . Checkpoint     |
                    |  |  Event Sourcing . Resume           |
                    |  +---------------+-------------------+
                    +------------------|--------------------+
                                       |
                    +------------------v-------------------+
                    |          LLM Providers                |
                    |   OpenAI . Anthropic . Google . ...   |
                    +--------------------------------------+
```

L0 Worker occupies a narrow band in the stack. It receives work from L1, executes it against a provider through the L0 runtime, and reports back. It does not schedule, route, retry at the task level, execute tools, or persist results. Those responsibilities belong to L1.

### 3.2 Worker Lifecycle

The worker progresses through a strict state machine:

```
BOOT --> READY --> ACCEPTING --> DRAINING --> OFFLINE
```

- **BOOT**: Process started, configuration loading, provider clients initializing.
- **READY**: Initialization complete, not yet accepting tasks. Emits `WORKER_READY`.
- **ACCEPTING**: Actively processing `TASK_SUBMIT` requests. This is the steady state.
- **DRAINING**: Graceful shutdown initiated (either by explicit request or approaching function timeout). In-flight streams are aborted via `AbortSignal`. No new tasks accepted. Emits `WORKER_DRAINING`.
- **OFFLINE**: All tasks terminated, process exiting. Emits `WORKER_OFFLINE`.

Invalid transitions (e.g., `BOOT -> DRAINING`) are rejected at the state machine level. Listeners can subscribe to transitions, enabling hot-reload and coordinated shutdown.

### 3.3 Slot Management

Concurrency is controlled by a fixed slot pool. Each task requires exactly one slot. No task enters execution without a slot; no slot exists without a corresponding task.

```
acquire(taskId) -> "acquired" | "no_slots" | "duplicate"
release(taskId) -> boolean
```

The slot manager is the mechanism behind backpressure by silence. When `acquire` returns `no_slots`, the worker emits nothing - the orchestrator's timeout or retry logic handles the non-response.

Duplicate detection prevents the same task from consuming two slots if the orchestrator retries a submit before the first attempt's SSE connection is established.

### 3.4 Event Store

An in-memory store records every event emitted during task execution. This store serves two purposes:

1. **Replay**: If the SSE connection drops, the orchestrator can request a replay and receive the same events without re-execution.
2. **Integrity**: The output hash recorded at `TASK_COMPLETED` can be verified against the replayed output.

The store uses optional FIFO eviction when a configurable maximum task count is reached. Events are lost on process restart - this is intentional. A stateless worker does not persist events across invocations.

### 3.5 Configuration Management

Configuration is loaded from environment variables at boot and organized into deployment presets:

| Setting | Local | Vercel |
|---------|-------|--------|
| `maxConcurrency` | 64 | 1 |
| `functionTimeoutMs` | 0 (disabled) | 60000 |
| `drainBufferMs` | 5000 | 5000 |
| `skipAuthValidation` | true | false |

A `ConfigManager` supports hot-reload via `POST /api/config`, allowing runtime updates to concurrency limits, resource caps, and feature flags without restarting the process. Registered listeners react to changes immediately.

---

## 4. The Inference Order

The inference order is the contract between L1 and L0. It is a declarative specification with two sections: *execution* (how to run the inference) and *output* (what shape the result must have). The entire schema is defined and validated with Zod.

### 4.1 Execution Specification

```
execution:
  models:        [{ provider, model, params? }]   # required, ordered preference
  retry:         { attempts, maxRetries, backoff, baseDelayMs, maxDelayMs }
  fallbacks:     [{ when, model }]                 # triggered on error|timeout|output_violation
  timeout:       { initialTokenMs, interTokenMs }
  guardrails:    { preset, checkIntervalMs? }
  tools:         [{ name, description?, schema }]
  parallel:      { mode, max? }                    # race or fanout
  continueFromLastKnownGoodToken: boolean
```

**No defaults.** Every field is either explicitly provided or absent. L0 does not guess what the orchestrator intended. This eliminates an entire class of bugs where default retry counts or timeout values silently mask problems.

**Models are ordered.** The first model in the list is preferred. Fallbacks are separate from the model list - they are triggered by specific failure conditions, not by preference.

### 4.2 Output Specification

```
output:
  kind:    "text" | "json" | "tokens"
  schema:  JSONSchema          # required when kind is "json"
  strict:  boolean             # enforce strict schema validation
```

The output kind determines the execution path:

- **Text**: Token-by-token streaming via `streamText()`. Output is the raw text.
- **JSON**: Structured streaming via `streamObject()`. Output is validated against the provided JSON schema during streaming, not after completion.
- **Tokens**: Raw token stream for fine-grained processing.

This upfront declaration eliminates post-hoc parsing. The worker knows the expected shape before the first token arrives and can fail fast on violations.

### 4.3 Execution Paths

The executor selects one of three paths based on the order:

1. **Text execution**: Single model, streaming text output. The simplest path. Collects tokens, captures tool calls, and emits progress events at first token.
2. **Structured execution**: Single model, streaming JSON output with schema validation. Returns a parsed and validated object alongside the raw content.
3. **Parallel execution**: Multiple models running simultaneously.
   - **Race mode**: First model to complete wins. All others are cancelled via `AbortSignal`.
   - **Fanout mode**: All models run to completion. Results are aggregated into a JSON array.

Parallel execution enables A/B testing (race two models, use whichever responds first), redundancy (fanout to multiple providers for critical tasks), and cost optimization (race a cheap model against an expensive one - if the cheap model is fast enough, the expensive one never completes).

### 4.4 Task Payload

The task payload carries the actual content for inference:

```
payload:
  prompt?:    string                            # simple text prompt
  messages?:  [{ role, content }]               # conversation history
```

Exactly one of `prompt` or `messages` must be provided. The executor converts prompts to the message format expected by the AI SDK, supporting `system`, `user`, and `assistant` roles.

---

## 5. Reliability Mechanisms

The L0 Worker delegates token-level reliability to the L0 runtime (`@ai2070/l0`), which provides a battle-tested stack of recovery primitives. The worker maps inference order specifications to L0 configuration and forwards all runtime events to the orchestrator.

### 5.1 Retry

L0 supports five backoff strategies:

| Strategy | Behavior |
|----------|----------|
| `fixed` | Constant delay between attempts |
| `linear` | Delay increases linearly: `baseDelay * attempt` |
| `exponential` | Delay doubles: `baseDelay * 2^attempt`, capped at `maxDelay` |
| `fixed-jitter` | Fixed delay + random jitter |
| `full-jitter` | Exponential delay * random factor (0-1) |

Each retry attempt emits `RETRY_ATTEMPT` with the attempt number, delay, and reason. The orchestrator sees exactly how many retries occurred and why.

Retries are bounded by both `attempts` (per error) and `maxRetries` (total across all errors). When the budget is exhausted, L0 emits `RETRY_GIVE_UP` and either triggers a fallback or fails the task.

**Error-category-aware budgeting**: Network errors retry with backoff but do not count toward model retry limits. This prevents network instability from exhausting the retry budget intended for model-level failures like guardrail violations or content errors.

### 5.2 Fallback

Fallbacks are triggered by three conditions:

- **Error**: The model returned an error (API failure, rate limit, context length exceeded).
- **Timeout**: The model did not produce tokens within the configured thresholds.
- **Output violation**: The model's output failed guardrail validation.

Each fallback specifies an alternative model. Fallbacks are sequential - if the first fallback also fails, the next in the chain is tried. Each fallback gets its own full retry budget. When the chain is exhausted, the task fails with `ALL_STREAMS_EXHAUSTED`.

Fallback events (`FALLBACK_START`, `FALLBACK_MODEL_SELECTED`, `FALLBACK_END`) provide full visibility into the decision chain.

### 5.3 Guardrails

Guardrails validate output during streaming, not after completion. They are pure validation functions that inspect content and signal whether to retry or halt - they never rewrite content. Six presets are available:

| Preset | Rules | Purpose |
|--------|-------|---------|
| `minimal` | Zero output | Basic safety - catches empty responses |
| `recommended` | JSON, Markdown, patterns, zero output | Balanced validation for general use |
| `strict` | JSON, Markdown, LaTeX, patterns, zero output | Aggressive output filtering |
| `json-only` | JSON structure | Streaming-aware brace/bracket depth tracking |
| `markdown-only` | Markdown well-formedness | Fence, table, and list validation |
| `latex-only` | LaTeX syntax | Environment and delimiter validation |

Guardrails execute on two paths for performance:

- **Fast path** (synchronous): Lightweight delta checks inline with each token batch. Incremental JSON depth tracking, pattern matching on recent content.
- **Slow path** (asynchronous): Heavier full-content scans on configurable intervals (default: every 15 tokens) without blocking the stream.

A violation carries severity (`warning`, `error`, `fatal`) which determines recovery: warnings are recorded, errors trigger retry, fatals halt immediately.

### 5.4 Timeouts

Two independent timeout clocks run during inference:

- **Initial token timeout** (`initialTokenMs`): Maximum time from request to first token. Catches provider stalls, cold starts, and queue delays.
- **Inter-token timeout** (`interTokenMs`): Maximum gap between consecutive tokens. Catches mid-stream stalls and connection issues.

Timeouts are critical for serverless cost control. A stalled inference that runs until the function timeout wastes the entire invocation budget. Inter-token timeouts catch stalls early, leaving time for retry or fallback.

### 5.5 Token Resumption

When `continueFromLastKnownGoodToken` is enabled, retries and fallbacks resume from the last checkpoint rather than restarting from scratch. This is particularly valuable for long-form generation where the first 80% of the output was valid but the stream failed near the end.

L0 periodically saves checkpoints at configurable token intervals. On retry or fallback, the checkpoint content is validated with guardrails and drift detection before resumption. Smart continuation deduplication automatically removes repeated suffix/prefix overlap when models repeat the last few words after resuming.

**Safety limitation**: Checkpoint continuation is not used for structured JSON output, because prepending partial JSON can corrupt the structure. In those cases, retry from scratch is the safe default.

Checkpoints are emitted as `CHECKPOINT_SAVED` events. Resumption emits `RESUME_START` and `RESUME_END`, providing visibility into how much work was preserved.

### 5.6 Drift Detection

Even when output is structurally valid, it can drift in ways that break downstream usage. The L0 runtime detects seven drift types:

| Type | Detection Method |
|------|-----------------|
| Tone shift | Register/voice change analysis |
| Meta-commentary | AI self-reference pattern matching ("As an AI...") |
| Format collapse | Structural degradation detection |
| Markdown collapse | Markdown formatting breakdown |
| Repetition | Phrase/sentence loop detection |
| Entropy spike | Statistical surprise in token distribution |
| Hedging spiral | Excessive qualification language |

Drift checks operate over a sliding window (default 500 characters) rather than rescanning the entire output, keeping cost at O(windowSize) per check. Drift detection is opt-in and can trigger retries when drift is detected.

### 5.7 Drain-Aware Abort

On serverless platforms, the worker knows its function timeout (`functionTimeoutMs`) and reserves a buffer (`drainBufferMs`) for graceful shutdown. When the deadline approaches:

1. Worker transitions to `DRAINING`
2. Emits `WORKER_DRAINING`
3. Fires `AbortSignal` on all in-flight streams
4. Waits for streams to terminate
5. Emits terminal events for each task (`TASK_FAILED` with `failureClass: "aborted"`)
6. Transitions to `OFFLINE`

This prevents the platform from killing the process mid-stream. The orchestrator receives a clean failure event and can retry on another worker.

---

## 6. Authentication

L0 uses ephemeral HMAC-SHA256 tokens for request authentication:

```
token = HMAC-SHA256(secret, "task_id|issued_at|ttl")
```

Validation checks:

1. **Format**: Token is valid base64, TTL is non-zero.
2. **Freshness**: Current time is within `issued_at + ttl`.
3. **Clock skew**: `issued_at` is not more than 5 seconds in the future.
4. **Signature**: Constant-time comparison of computed vs. provided HMAC.

Tokens are validated once per request and never stored. There is no session, no token refresh, no revocation list. Each request carries its own proof of authorization, bound to a specific `task_id`.

In development, authentication can be bypassed by leaving `L0_AUTH_SECRET` unset or setting `SKIP_AUTH_VALIDATION=true`.

---

## 7. Deterministic Replay

The replay engine re-emits recorded events from the in-memory event store. Replay is byte-identical to the original emission:

- Same event types, same order, same payloads
- Same output hash (verified against the original `TASK_COMPLETED` event)
- No tokens regenerated, no tools re-invoked, no events fabricated
- No network calls, no retries, no recomputation of guardrails or drift

Replay serves three purposes:

1. **Network recovery**: If the SSE connection drops during task execution, the orchestrator can request a replay to recover the full event stream without re-executing the inference (and incurring the cost).
2. **Auditability**: The recorded event stream is a complete, verifiable record of what happened during execution.
3. **Debugging**: Replay with validation confirms the integrity of recorded events against the expected output hash, making production failures reproducible.

---

## 8. API Protocol

### 8.1 POST /api/submit

Submit a task for execution. Returns an SSE event stream.

- **Request**: `TaskSubmit` (auth token, inference order, task payload)
- **Response**: SSE stream of typed events (worker events + L0 runtime events)
- **Backpressure**: Returns 503 if no slots available (the HTTP-level safety net; the primary backpressure mechanism is silence at the SSE level)
- **Validation**: Auth token, request schema, worker state, slot availability

### 8.2 POST /api/replay

Replay recorded events for a completed task.

- **Request**: `TaskReplayRequest` (taskId, expected_output_hash, reason)
- **Response**: Recorded events + `REPLAY_COMPLETE` summary
- **404**: If task not found in the event store

### 8.3 GET /api/status

Health check and capacity reporting.

- **Response**: `{ workerId, state, protocolVersion, maxConcurrency, inflightTasks, availableSlots, ts }`
- **No auth required** - this endpoint is used by supervisors and load balancers.

### 8.4 POST /api/config

Hot-reload configuration without restart.

- **Request**: `WorkerConfigUpdate` (auth token, config patch)
- **Updates**: maxConcurrency, resourceCaps, featureFlags
- **Reactive**: Registered listeners are notified immediately.

### 8.5 POST /api/drain

Initiate graceful shutdown.

- **Localhost**: No auth required (for supervisor use).
- **Remote**: Requires valid auth token.
- **Effect**: Transitions to DRAINING, aborts in-flight streams, exits after drain buffer.

---

## 9. Event Taxonomy

L0 Worker emits two categories of events over SSE:

### 9.1 Worker Events

Events about the worker's own lifecycle and task-level milestones:

| Event | Significance |
|-------|-------------|
| `WORKER_READY` | Worker initialized, ready to accept tasks |
| `WORKER_LOAD` | Current load metrics (inflight tasks, CPU pressure) |
| `WORKER_DRAINING` | Graceful shutdown initiated |
| `WORKER_OFFLINE` | Process exiting |
| `TASK_ACCEPTED` | Slot acquired, execution beginning |
| `TASK_PROGRESS` | Milestone reached (see stages below) |
| `TASK_COMPLETED` | Success - includes output, output hash, and metrics |
| `TASK_FAILED` | Failure - includes failure class and retryable flag |

**Task progress stages:**

| Stage | Metadata | Meaning |
|-------|----------|---------|
| `first_token` | - | First token received from the model |
| `tool_invoked` | `{ toolName, toolArgs }` | Model requested a tool call |
| `streaming` | - | Streaming in progress |
| `checkpoint_written` | - | Checkpoint saved for resumption |

**Failure classes:**

| Class | Meaning |
|-------|---------|
| `timeout` | Initial token or inter-token timeout exceeded |
| `rate_limited` | Provider rate limit hit |
| `context_length_exceeded` | Input exceeded model context window |
| `invalid_input` | Malformed order or payload; JSON schema validation failure |
| `model_error` | Provider returned an error |
| `network_error` | Transport-level failure |
| `guardrail_violation` | Output violated a guardrail rule |
| `determinism_violation` | Replay hash mismatch |
| `aborted` | Task cancelled (drain, explicit abort, or AbortSignal) |
| `unknown` | Unclassified failure |

### 9.2 L0 Runtime Events

All events from the L0 runtime are forwarded to L1 without modification:

| Category | Events |
|----------|--------|
| **Session** | `SESSION_START`, `SESSION_END`, `SESSION_SUMMARY` |
| **Stream** | `STREAM_INIT`, `STREAM_READY` |
| **Retry** | `RETRY_START`, `RETRY_ATTEMPT`, `RETRY_END`, `RETRY_GIVE_UP` |
| **Fallback** | `FALLBACK_START`, `FALLBACK_MODEL_SELECTED`, `FALLBACK_END` |
| **Guardrail** | `GUARDRAIL_PHASE_START`, `GUARDRAIL_PHASE_END`, `GUARDRAIL_RULE_PASS`, `GUARDRAIL_RULE_FAIL` |
| **Timeout** | `TIMEOUT_START`, `TIMEOUT_RESET`, `TIMEOUT_TRIGGERED` |
| **Network** | `NETWORK_ERROR`, `NETWORK_RECOVERY`, `CONNECTION_DROPPED`, `CONNECTION_RESTORED` |
| **Tools** | `TOOL_REQUESTED`, `TOOL_START`, `TOOL_RESULT`, `TOOL_ERROR`, `TOOL_COMPLETED` |
| **Checkpoint** | `CHECKPOINT_SAVED`, `RESUME_START`, `RESUME_END` |
| **Drift** | `DRIFT_CHECK_START`, `DRIFT_CHECK_END`, `DRIFT_DETECTED` |
| **Abort** | `ABORT_REQUESTED`, `ABORT_COMPLETED` |

The full event stream provides a complete narrative of every retry attempt, every fallback decision, every guardrail check, and every timeout trigger. Debugging production inference failures becomes a matter of reading the event log rather than correlating scattered metrics.

---

## 10. Tool Handling

L0 supports schema-only tool definitions. Tools are passed to the model as part of the inference request, but L0 never executes them. When the model generates a tool call:

1. L0 detects the tool call event as it streams and buffers arguments incrementally
2. Emits `TASK_PROGRESS` with stage `tool_invoked` and metadata `{ toolName, toolArgs }`
3. Emits corresponding `TOOL_REQUESTED` / `TOOL_START` / `TOOL_RESULT` / `TOOL_COMPLETED` runtime events
4. Tracks all detected tool calls in the execution result

Tool execution is L1's responsibility. L0 reports what the model asked for; L1 decides whether and how to fulfill it.

This separation keeps L0 stateless (no tool execution context to manage) and gives L1 full control over tool authorization, execution environment, and result injection. Multi-turn tool use requires L1 to manage the conversation loop, submitting follow-up inference orders with tool results injected into the message history.

---

## 11. Deployment Models

### 11.1 Standalone Server

A Bun HTTP server running on a single machine. Suitable for development, testing, and single-node deployments.

- Default concurrency: 64 slots
- No function timeout (runs indefinitely)
- Authentication optional
- Hot-reload configuration via `/api/config`

```bash
npm run dev:standalone    # Development with hot reload
npm run build:desktop     # Compile to single executable
```

### 11.2 Vercel Serverless

Each function invocation is an independent worker with a single slot. The platform manages scaling - more requests spawn more invocations.

- Concurrency: 1 slot per invocation (platform handles horizontal scaling)
- Function timeout: 60 seconds (Pro plan)
- Drain buffer: 5 seconds reserved for graceful shutdown
- Authentication required

```bash
npm run dev:vercel    # Local Vercel dev server
vercel deploy         # Production deployment
```

### 11.3 Multi-Worker Pool (Supervisor)

A Rust process supervisor manages a pool of worker processes on a single machine. The supervisor handles:

- **Process lifecycle**: Spawn, health check, drain, kill, restart
- **Crash recovery**: Exponential backoff restart on failure, with configurable max consecutive failures
- **Health monitoring**: Periodic HTTP health checks against each worker's `/api/status` endpoint
- **Hung worker detection**: Workers that fail health checks are killed and restarted
- **Graceful shutdown**: Coordinated drain across all workers on SIGTERM/SIGINT
- **Observability**: Real-time SSE stream of pool lifecycle events at the supervisor API

```
Supervisor (port 9000)
+-- Worker 0 (port 3001) - healthy, 12/64 slots used
+-- Worker 1 (port 3002) - healthy, 8/64 slots used
+-- Worker 2 (port 3003) - draining, 1/64 slots used
+-- Worker 3 (port 3004) - restarting (crash #2, backoff 2000ms)
```

**Supervisor API:**

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/workers` | GET | List all workers with status |
| `/workers/:id` | GET | Single worker status |
| `/workers/events` | GET | SSE stream of pool events |
| `/workers/spawn` | POST | Spawn new worker |
| `/workers/:id/drain` | POST | Graceful shutdown |
| `/workers/:id/kill` | POST | Force kill |
| `/workers/:id/restart` | POST | Drain + spawn |

**Worker states:** `starting -> healthy -> draining -> drained | unhealthy -> restarting | failed`

The supervisor does not route requests. It manages processes. Routing is L1's responsibility - the supervisor exposes worker health and capacity, and L1 decides which worker receives each task.

---

## 12. Relationship to L0 Runtime

L0 Worker is the operational shell around the L0 deterministic streaming runtime (`@ai2070/l0`). Understanding the boundary is important:

| Responsibility | L0 Runtime | L0 Worker |
|----------------|-----------|-----------|
| Token-level retry & backoff | Yes | Maps order spec to L0 config |
| Fallback model chains | Yes | Maps order spec to L0 fallbackStreams |
| Streaming guardrails | Yes | Maps preset names to L0 guardrail configs |
| Timeout enforcement (TTFT, inter-token) | Yes | Maps order spec to L0 timeout config |
| Drift detection | Yes | Opt-in passthrough |
| Checkpoint & resumption | Yes | Maps order flag to L0 option |
| Event sourcing & replay | L0 records events | Worker stores, indexes, and serves replay |
| Concurrency control | No | Slot manager |
| Worker lifecycle | No | State machine |
| Authentication | No | HMAC-SHA256 validation |
| SSE protocol | No | Event emission to L1 |
| Drain-aware abort | No | Function timeout tracking + AbortSignal |
| Deployment | No | Standalone, Vercel, Supervisor |
| Hot-reload config | No | ConfigManager |

The worker translates the inference order's declarative specification into L0 runtime calls, forwards all runtime events to L1, and adds the operational events (`TASK_ACCEPTED`, `TASK_COMPLETED`, `TASK_FAILED`, `WORKER_*`) that the orchestrator needs for scheduling and state management.

---

## 13. Design Tradeoffs

### Statelessness vs. Efficiency

A stateless worker cannot cache model connections, reuse warm contexts, or batch related requests. Every task is independent. This trades per-request efficiency for operational simplicity - workers can be killed, restarted, or replaced without coordination.

### Silence vs. Explicit Rejection

Backpressure by silence is unconventional. Most systems send explicit rejection messages. Silence has two advantages: it requires no rejection protocol (simpler implementation, fewer edge cases), and it forces the orchestrator to handle non-response as a first-class case (which it must do anyway for network failures). The disadvantage is that the orchestrator cannot distinguish "worker is full" from "worker is dead" without a separate health check.

### In-Memory Event Store vs. Persistence

The event store is in-memory and lost on restart. A persistent store would enable replay across process restarts, but would require disk I/O, introduce write latency, and violate the statelessness principle. The current design assumes that the orchestrator can re-submit tasks if the worker dies - replay is an optimization for connection drops, not a durability guarantee.

### No Defaults vs. Convenience

Inference orders have no default values. Every retry count, every timeout threshold, every guardrail preset must be explicitly specified. This is verbose but eliminates a class of bugs where default values silently mask problems or produce unexpected behavior. The orchestrator - which understands the task's requirements - makes all decisions explicitly.

### Schema-Only Tools vs. Server-Side Execution

L0 does not execute tools. This limits its usefulness for agentic workflows where tool results must be fed back to the model in the same inference call. The tradeoff is simplicity and security - L0 has no access to external systems, no credentials to manage, and no tool execution failures to handle. Multi-turn tool use requires L1 to manage the conversation loop.

### Single Provider vs. Multi-Provider

The current implementation resolves models through the OpenAI provider via the Vercel AI SDK. Adding providers is straightforward through the AI SDK's provider ecosystem, but each provider must be explicitly integrated and tested. This trades breadth for confidence - every supported provider is verified, not just plumbed through.

---

## 14. Comparison to Alternatives

| Approach | Limitation L0 Worker Addresses |
|----------|-------------------------------|
| **Raw provider SDKs** | No retry, no fallback, no guardrails, no observability. Every consumer re-implements reliability. |
| **LLM gateway/proxy** (LiteLLM, Portkey) | Focused on routing and provider abstraction. No streaming guardrails, no deterministic replay, no serverless drain awareness, no declarative execution orders. |
| **Application-level retry** | Scattered across services, inconsistent policies, no unified event stream, no replay, no error-category-aware retry budgets. |
| **Queue-based workers** (Celery, BullMQ) | Internal queuing hides backpressure. Not designed for streaming inference. No token-level timeout. No guardrails during streaming. |
| **AI orchestration frameworks** (LangChain, CrewAI) | Opinionated about agent design and tool execution. L0 has no opinions - it executes inference orders and reports events. The orchestrator decides everything else. |
| **Inference servers** (vLLM, TGI) | Optimized for self-hosted model serving. L0 sits above the provider layer - it works with any API-accessible model, hosted or self-hosted. |

L0 Worker is not a gateway, not a queue, not a framework, and not an inference server. It is a single-purpose execution substrate: accept an inference order, execute it reliably, report what happened.

---

## 15. Testing

L0 Worker is validated by unit tests and end-to-end integration tests covering:

- **Authentication**: Format validation, freshness checks, clock skew handling, constant-time signature comparison
- **State machine**: All valid transitions, rejection of invalid transitions, listener notification
- **Slot management**: Acquisition, release, duplicate detection, capacity limits
- **Executor**: Retry/fallback/guardrail mapping, text/structured/parallel execution paths, tool schema building, message construction
- **Event store**: Recording, retrieval, FIFO eviction, task isolation
- **Replay**: Byte-identical re-emission, output hash validation, missing task handling
- **Configuration**: Hot-reload, preset selection, listener notification
- **E2E inference**: Real provider API calls (OpenAI) for text, structured output, tools, guardrails, timeouts, and parallel execution

End-to-end tests require `OPENAI_API_KEY` and exercise the complete path from task submission through L0 runtime execution to event emission.

---

## 16. Future Directions

- **Multi-provider support**: Extend beyond OpenAI to Anthropic, Google, and open-source model providers via the Vercel AI SDK provider ecosystem.
- **Persistent event store**: Optional durable event storage for cross-restart replay, backed by an append-only log.
- **Adaptive concurrency**: Dynamic slot scaling based on observed provider latency and error rates.
- **Multi-turn tool loops**: Support for iterative tool use within a single task, with L0 managing the conversation loop and L1 providing tool results via a callback protocol.
- **Cost tracking**: Per-task token counting and cost estimation, emitted as event metadata.
- **Distributed supervisor**: Extend the Rust supervisor to manage workers across multiple machines with leader election and work distribution.
- **Consensus and race at the worker level**: Expose L0 runtime's multi-model consensus and race primitives through the inference order specification.
- **Streaming structured output**: Leverage L0's `structuredStream()` for progressive JSON validation with streaming delivery to L1.

---

## 17. Conclusion

LLM inference in production requires a reliability layer that most systems build ad-hoc, maintain poorly, and debug with difficulty. L0 Worker is that layer - purpose-built, stateless, deterministic, and observable.

It stands on the shoulders of the L0 deterministic streaming runtime, which provides token-level reliability primitives (retry, fallback, guardrails, drift detection, checkpoints, event sourcing). The worker adds what the runtime cannot provide alone: concurrency control, lifecycle governance, authentication, a deployment model, and an SSE protocol that gives orchestrators a complete, replayable narrative of every inference execution.

By constraining itself to a narrow responsibility (execute inference orders and report events), L0 Worker avoids the complexity traps of general-purpose frameworks. By requiring declarative orders with no defaults, it forces explicit decision-making at the orchestrator level. By emitting a complete event stream, it makes every retry, fallback, guardrail check, timeout, drift event, and tool call visible without log scraping or metrics correlation.

The design is intentionally minimal. L0 Worker does not schedule, route, queue, cache, or execute tools. It executes inference reliably and tells you what happened. Everything else is someone else's job.

---

*L0 Worker is open source under the Apache-2.0 license.*
*Repository: [github.com/ai-2070/l0-worker](https://github.com/ai-2070/l0-worker)*
*L0 Runtime: [github.com/ai-2070/l0](https://github.com/ai-2070/l0)*
