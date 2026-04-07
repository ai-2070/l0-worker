# L0: The Missing Reliability Substrate for LLM Inference

**A Stateless, Deterministic Execution Layer Between Orchestrators and Language Models**

*Version 1.0 - April 2026*

---

## Abstract

Large language model (LLM) inference in production is fragile. Providers fail, streams stall, rate limits fire without warning, and output quality varies between calls. Most systems cope with this at the application layer - scattering retry logic, timeout handling, and output validation across orchestration code that was never designed for it.

L0 is a purpose-built execution substrate that sits between an orchestrator (L1) and LLM providers. It absorbs the full complexity of reliable inference - retries, fallbacks, guardrails, timeouts, parallel execution, and token resumption - into a single stateless layer. The worker emits a deterministic stream of lifecycle events that can be replayed byte-for-byte without re-execution.

The result is a system where the orchestrator submits declarative *inference orders* and receives factual events. No polling. No internal queues. No opinions about how tasks should be scheduled. L0 does one thing - execute inference reliably - and reports exactly what happened.

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

---

## 2. Design Principles

L0 is built on five principles that constrain every design decision:

### 2.1 Statelessness

The worker holds no persistent state. It can be killed, restarted, or scaled to zero at any time without data loss. The only in-memory structure is the event store for replay, which is ephemeral by design - if the process dies, events are re-requested from the orchestrator or regenerated.

**Implication:** No database. No disk writes. No coordination between worker instances. Each worker is an island.

### 2.2 Determinism

Every event emitted during task execution is recorded. A replay request re-emits those events byte-for-byte - same order, same content, same hashes. Replay never regenerates tokens, re-invokes tools, or fabricates events.

**Implication:** The event stream is the single source of truth. If the SSE connection drops, the orchestrator can replay from the event store without re-executing the inference. The output hash guarantees integrity.

### 2.3 Declarative Execution

The orchestrator does not tell L0 *how* to execute. It submits an *inference order* - a declarative specification of models, retry policy, fallback chain, guardrails, timeout thresholds, and output shape. L0 interprets the order and reports what happened.

**Implication:** No imperative control flow crosses the L1/L0 boundary. The orchestrator's contract is: "here is what I want; tell me what you did." This makes orders portable across worker implementations and provider backends.

### 2.4 Backpressure by Silence

When a worker has no available slots, it does not reject the task, queue it, or send an error. It simply does not emit `TASK_ACCEPTED`. The orchestrator infers rejection from the absence of acknowledgment.

**Implication:** No rejection protocol. No queue depth to monitor. No buffering that hides overload. The orchestrator always knows: either a worker accepted the task (and will report on it), or no worker did (and the orchestrator must decide what to do).

### 2.5 Event-Driven Observability

Every significant moment in task execution - first token, tool invocation, retry attempt, fallback selection, guardrail check, timeout trigger, checkpoint save - is emitted as a typed event over SSE. The orchestrator receives a complete, ordered narrative of what happened and why.

**Implication:** No log scraping. No metrics aggregation. No post-hoc reconstruction of what went wrong. The event stream is the observability layer.

---

## 3. Architecture

### 3.1 System Topology

```
                    ┌─────────────────────────────────────┐
                    │           L1 Orchestrator            │
                    │  (scheduling, routing, tool exec)    │
                    └──────────┬──────────────▲────────────┘
                               │              │
                        TASK_SUBMIT      SSE Events
                               │              │
                    ┌──────────▼──────────────┤────────────┐
                    │          L0 Worker                    │
                    │  ┌─────────────────────────────────┐ │
                    │  │  Slot Manager                   │ │
                    │  │  ┌────┐ ┌────┐ ┌────┐ ┌────┐   │ │
                    │  │  │ S1 │ │ S2 │ │ S3 │ │ .. │   │ │
                    │  │  └──┬─┘ └──┬─┘ └──┬─┘ └──┬─┘   │ │
                    │  └─────┼──────┼──────┼──────┼──────┘ │
                    │        │      │      │      │        │
                    │  ┌─────▼──────▼──────▼──────▼──────┐ │
                    │  │         L0 Runtime               │ │
                    │  │  Retry · Fallback · Guardrails   │ │
                    │  │  Timeout · Resume · Checkpoint   │ │
                    │  └─────────────┬────────────────────┘ │
                    └───────────────┼──────────────────────┘
                                    │
                             ┌──────▼──────┐
                             │ LLM Provider │
                             │  (OpenAI)    │
                             └─────────────┘
```

L0 occupies a narrow band in the stack. It receives work from L1, executes it against a provider, and reports back. It does not schedule, route, retry at the task level, execute tools, or persist results. Those responsibilities belong to L1.

### 3.2 Worker Lifecycle

The worker progresses through a strict state machine:

```
BOOT → READY → ACCEPTING → DRAINING → OFFLINE
```

- **BOOT**: Process started, configuration loading, provider clients initializing.
- **READY**: Initialization complete, not yet accepting tasks. Emits `WORKER_READY`.
- **ACCEPTING**: Actively processing `TASK_SUBMIT` requests. This is the steady state.
- **DRAINING**: Graceful shutdown initiated (either by explicit request or approaching function timeout). In-flight streams are aborted via `AbortSignal`. No new tasks accepted.
- **OFFLINE**: All tasks terminated, process exiting. Emits `WORKER_OFFLINE`.

Invalid transitions (e.g., `BOOT → DRAINING`) are rejected at the state machine level. This prevents impossible states from arising under race conditions.

### 3.3 Slot Management

Concurrency is controlled by a fixed slot pool. Each task requires exactly one slot. No task enters execution without a slot; no slot exists without a corresponding task.

```
acquire(taskId) → "acquired" | "no_slots" | "duplicate"
release(taskId) → boolean
```

The slot manager is the mechanism behind backpressure by silence. When `acquire` returns `no_slots`, the worker emits nothing - the orchestrator's timeout or retry logic handles the non-response.

Duplicate detection prevents the same task from consuming two slots if the orchestrator retries a submit before the first attempt's SSE connection is established.

### 3.4 Event Store

An in-memory store records every event emitted during task execution. This store serves two purposes:

1. **Replay**: If the SSE connection drops, the orchestrator can request a replay and receive the same events without re-execution.
2. **Integrity**: The output hash recorded at `TASK_COMPLETED` can be verified against the replayed output.

The store uses optional FIFO eviction when a configurable maximum task count is reached. Events are lost on process restart - this is intentional. A stateless worker does not persist events across invocations.

---

## 4. The Inference Order

The inference order is the contract between L1 and L0. It is a declarative specification with two sections: *execution* (how to run the inference) and *output* (what shape the result must have).

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
  kind:    "text" | "json"
  schema:  JSONSchema          # required when kind is "json"
  strict:  boolean             # enforce strict schema validation
```

The output kind determines the execution path:

- **Text**: Token-by-token streaming via `streamText()`. Output is the raw text.
- **JSON**: Structured streaming via `streamObject()`. Output is validated against the provided JSON schema during streaming, not after completion.

This upfront declaration eliminates post-hoc parsing. The worker knows the expected shape before the first token arrives and can fail fast on violations.

### 4.3 Execution Paths

The executor selects one of three paths based on the order:

1. **Text execution**: Single model, streaming text output. The simplest path.
2. **Structured execution**: Single model, streaming JSON output with schema validation.
3. **Parallel execution**: Multiple models running simultaneously.
   - **Race mode**: First model to complete wins. All others are cancelled via `AbortSignal`.
   - **Fanout mode**: All models run to completion. Results are aggregated into a JSON array.

Parallel execution enables A/B testing (race two models, use whichever responds first), redundancy (fanout to multiple providers for critical tasks), and cost optimization (race a cheap model against an expensive one - if the cheap model is fast enough, the expensive one never completes).

---

## 5. Reliability Mechanisms

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

### 5.2 Fallback

Fallbacks are triggered by three conditions:

- **Error**: The model returned an error (API failure, rate limit, context length exceeded).
- **Timeout**: The model did not produce tokens within the configured thresholds.
- **Output violation**: The model's output failed guardrail validation.

Each fallback specifies an alternative model. Fallbacks are sequential - if the first fallback also fails, the next in the chain is tried. When the chain is exhausted, the task fails.

Fallback events (`FALLBACK_START`, `FALLBACK_MODEL_SELECTED`, `FALLBACK_END`) provide full visibility into the decision chain.

### 5.3 Guardrails

Guardrails validate output during streaming, not after completion. Six presets are available:

| Preset | Purpose |
|--------|---------|
| `minimal` | Basic safety checks |
| `recommended` | Balanced validation for general use |
| `strict` | Aggressive output filtering |
| `json-only` | Validates JSON structure during streaming |
| `markdown-only` | Validates Markdown well-formedness |
| `latex-only` | Validates LaTeX syntax |

Guardrails run at a configurable interval (`checkIntervalMs`) against the accumulated output. A violation can trigger a fallback (if configured) or fail the task immediately.

### 5.4 Timeouts

Two independent timeout clocks run during inference:

- **Initial token timeout** (`initialTokenMs`): Maximum time from request to first token. Catches provider stalls, cold starts, and queue delays.
- **Inter-token timeout** (`interTokenMs`): Maximum gap between consecutive tokens. Catches mid-stream stalls and connection issues.

Timeouts are critical for serverless cost control. A stalled inference that runs until the function timeout wastes the entire invocation budget. Inter-token timeouts catch stalls early, leaving time for retry or fallback.

### 5.5 Token Resumption

When `continueFromLastKnownGoodToken` is enabled, retries and fallbacks resume from the last checkpoint rather than restarting from scratch. This is particularly valuable for long-form generation where the first 80% of the output was valid but the stream failed near the end.

Checkpoints are saved as `CHECKPOINT_SAVED` events. Resumption emits `RESUME_START` and `RESUME_END`, providing visibility into how much work was preserved.

### 5.6 Drain-Aware Abort

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

1. **Format**: Token length and TTL are non-zero.
2. **Freshness**: Current time is within `issued_at + ttl`.
3. **Clock skew**: `issued_at` is not more than 5 seconds in the future.
4. **Signature**: Constant-time comparison of computed vs. provided HMAC.

Tokens are validated once per request and never stored. There is no session, no token refresh, no revocation list. Each request carries its own proof of authorization.

In development, authentication can be bypassed by leaving `L0_AUTH_SECRET` unset or setting `SKIP_AUTH_VALIDATION=true`.

---

## 7. Deterministic Replay

The replay engine re-emits recorded events from the in-memory event store. Replay is byte-identical to the original emission:

- Same event types, same order, same payloads
- Same output hash (verified against the original `TASK_COMPLETED` event)
- No tokens regenerated, no tools re-invoked, no events fabricated

Replay serves two purposes:

1. **Network recovery**: If the SSE connection drops during task execution, the orchestrator can request a replay to recover the full event stream without re-executing the inference (and incurring the cost).
2. **Auditability**: The recorded event stream is a complete, verifiable record of what happened during execution.

---

## 8. Deployment Models

### 8.1 Standalone Server

A Bun HTTP server running on a single machine. Suitable for development, testing, and single-node deployments.

- Default concurrency: 64 slots
- No function timeout (runs indefinitely)
- Authentication optional

### 8.2 Vercel Serverless

Each function invocation is an independent worker with a single slot. The platform manages scaling - more requests spawn more invocations.

- Concurrency: 1 slot per invocation (platform handles horizontal scaling)
- Function timeout: 60 seconds (Pro plan)
- Drain buffer: 5 seconds reserved for graceful shutdown
- Authentication required

### 8.3 Multi-Worker Pool (Supervisor)

A Rust process supervisor manages a pool of worker processes on a single machine. The supervisor handles:

- **Process lifecycle**: Spawn, health check, drain, kill, restart
- **Crash recovery**: Exponential backoff restart on failure, with configurable max consecutive failures
- **Health monitoring**: Periodic HTTP health checks against each worker's `/api/status` endpoint
- **Hung worker detection**: Workers that fail health checks are killed and restarted
- **Graceful shutdown**: Coordinated drain across all workers on SIGTERM/SIGINT
- **Observability**: Real-time SSE stream of pool lifecycle events at the supervisor API

```
Supervisor (port 9000)
├── Worker 0 (port 3001) - healthy, 12/64 slots used
├── Worker 1 (port 3002) - healthy, 8/64 slots used
├── Worker 2 (port 3003) - draining, 1/64 slots used
└── Worker 3 (port 3004) - restarting (crash #2, backoff 2000ms)
```

The supervisor does not route requests. It manages processes. Routing is L1's responsibility - the supervisor exposes worker health and capacity, and L1 decides which worker receives each task.

---

## 9. Event Taxonomy

L0 emits two categories of events:

### 9.1 Worker Events

Events about the worker's own lifecycle and task-level milestones:

| Event | Significance |
|-------|-------------|
| `WORKER_READY` | Worker initialized, ready to accept tasks |
| `WORKER_DRAINING` | Graceful shutdown initiated |
| `WORKER_OFFLINE` | Process exiting |
| `TASK_ACCEPTED` | Slot acquired, execution beginning |
| `TASK_PROGRESS` | Milestone reached (first token, tool invoked) |
| `TASK_COMPLETED` | Success - includes output, output hash, and final metrics |
| `TASK_FAILED` | Failure - includes failure class and retryable flag |

### 9.2 L0 Runtime Events

Events from the reliability runtime, forwarded to L1 without modification:

| Category | Events |
|----------|--------|
| **Session** | `SESSION_START`, `SESSION_END`, `SESSION_SUMMARY` |
| **Retry** | `RETRY_START`, `RETRY_ATTEMPT`, `RETRY_END`, `RETRY_GIVE_UP` |
| **Fallback** | `FALLBACK_START`, `FALLBACK_MODEL_SELECTED`, `FALLBACK_END` |
| **Guardrail** | `GUARDRAIL_PHASE_START`, `GUARDRAIL_PHASE_END`, `GUARDRAIL_RULE_*` |
| **Timeout** | `TIMEOUT_START`, `TIMEOUT_RESET`, `TIMEOUT_TRIGGERED` |
| **Network** | `NETWORK_ERROR`, `NETWORK_RECOVERY`, `CONNECTION_DROPPED` |
| **Tools** | `TOOL_REQUESTED`, `TOOL_START`, `TOOL_RESULT`, `TOOL_COMPLETED` |
| **Checkpoint** | `CHECKPOINT_SAVED`, `RESUME_START`, `RESUME_END` |

The full event stream provides a complete narrative of every retry attempt, every fallback decision, every guardrail check, and every timeout trigger. Debugging production inference failures becomes a matter of reading the event log rather than correlating scattered metrics.

---

## 10. Tool Handling

L0 supports schema-only tool definitions. Tools are passed to the model as part of the inference request, but L0 never executes them. When the model generates a tool call:

1. L0 captures the tool name and arguments
2. Emits `TASK_PROGRESS` with stage `tool_invoked` and metadata `{ toolName, toolArgs }`
3. Emits corresponding `TOOL_REQUESTED` / `TOOL_START` / `TOOL_RESULT` / `TOOL_COMPLETED` runtime events

Tool execution is L1's responsibility. L0 reports what the model asked for; L1 decides whether and how to fulfill it.

This separation keeps L0 stateless (no tool execution context to manage) and gives L1 full control over tool authorization, execution environment, and result injection.

---

## 11. Design Tradeoffs

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

---

## 12. Comparison to Alternatives

| Approach | Limitation L0 Addresses |
|----------|------------------------|
| **Raw provider SDKs** | No retry, no fallback, no guardrails, no observability. Every consumer re-implements reliability. |
| **LLM gateway/proxy** (LiteLLM, Portkey) | Focused on routing and provider abstraction. Typically no streaming guardrails, no deterministic replay, no serverless drain awareness. |
| **Application-level retry** | Scattered across services, inconsistent policies, no unified event stream, no replay. |
| **Queue-based workers** (Celery, BullMQ) | Internal queuing hides backpressure. Not designed for streaming inference. No token-level timeout. |

L0 is not a gateway, not a queue, and not a framework. It is a single-purpose execution substrate: accept an inference order, execute it reliably, report what happened.

---

## 13. Future Directions

- **Multi-provider support**: Extend beyond OpenAI to Anthropic, Google, and open-source model providers via the Vercel AI SDK provider ecosystem.
- **Persistent event store**: Optional durable event storage for cross-restart replay, backed by an append-only log.
- **Adaptive concurrency**: Dynamic slot scaling based on observed provider latency and error rates.
- **Multi-turn tool loops**: Support for iterative tool use within a single task, with L0 managing the conversation loop and L1 providing tool results via a callback protocol.
- **Cost tracking**: Per-task token counting and cost estimation, emitted as event metadata.
- **Distributed supervisor**: Extend the Rust supervisor to manage workers across multiple machines with leader election and work distribution.

---

## 14. Conclusion

LLM inference in production requires a reliability layer that most systems build ad-hoc, maintain poorly, and debug with difficulty. L0 is that layer - purpose-built, stateless, deterministic, and observable.

By constraining itself to a narrow responsibility (execute inference orders and report events), L0 avoids the complexity traps of general-purpose frameworks. By requiring declarative orders with no defaults, it forces explicit decision-making at the orchestrator level. By emitting a complete event stream, it makes every retry, fallback, guardrail check, and timeout visible without log scraping or metrics correlation.

The design is intentionally minimal. L0 does not schedule, route, queue, cache, or execute tools. It executes inference reliably and tells you what happened. Everything else is someone else's job.

---

*L0 Worker is open source under the Apache-2.0 license.*
*Repository: [github.com/ai-2070/l0-worker](https://github.com/ai-2070/l0-worker)*
