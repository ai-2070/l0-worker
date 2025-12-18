# L0 Worker API Reference

Complete API documentation for the L0 Worker.

## Table of Contents

- [Endpoints](#endpoints)
  - [POST /api/submit](#post-apisubmit)
  - [POST /api/replay](#post-apireplay)
  - [GET /api/status](#get-apistatus)
  - [POST /api/config](#post-apiconfig)
- [Request Types](#request-types)
  - [AuthEnvelope](#authenvelope)
  - [InferenceOrder](#inferenceorder)
  - [TaskSubmit](#tasksubmit)
  - [TaskReplayRequest](#taskreplayrequest)
  - [WorkerConfigUpdate](#workerconfigupdate)
- [Response Events](#response-events)
  - [Worker Events](#worker-events)
  - [Task Events](#task-events)
  - [L0 Lifecycle Events](#l0-lifecycle-events)
- [Error Handling](#error-handling)

---

## Endpoints

### POST /api/submit

Submit a task for execution. Returns streaming SSE response.

**Request Body:** [TaskSubmit](#tasksubmit)

**Response:** `text/event-stream`

Each event is a JSON object on a single line prefixed with `data: `:

```
data: {"type":"TASK_ACCEPTED","task_id":"task-123","worker_id":"l0-...","timestamp":1702900000000}

data: {"type":"TASK_PROGRESS","task_id":"task-123","stage":"first_token","timestamp":1702900000100}

data: {"type":"TASK_COMPLETED","task_id":"task-123","worker_id":"l0-...","output":"Hello!","output_hash":"sha256:...","final_metrics":{"duration_ms":1500,"token_count":10},"timestamp":1702900001500}

data: [DONE]
```

**Error Responses:**

| Status | Reason |
|--------|--------|
| 400 | Invalid request body |
| 401 | Auth validation failed |
| 405 | Method not allowed |
| 503 | Worker not accepting / no slots available |

---

### POST /api/replay

Replay recorded events for a task. Re-emits previously recorded events without re-execution.

**Request Body:** [TaskReplayRequest](#taskreplayrequest)

**Response:** `text/event-stream`

```
data: {"type":"TASK_ACCEPTED","task_id":"task-123",...}

data: {"type":"TASK_PROGRESS","task_id":"task-123",...}

data: {"type":"TASK_COMPLETED","task_id":"task-123",...}

data: {"type":"REPLAY_COMPLETE","events_replayed":3,"output_hash_match":true}
```

**Error Responses:**

| Status | Reason |
|--------|--------|
| 400 | Invalid request body |
| 401 | Auth validation failed |
| 404 | Task not found |
| 405 | Method not allowed |
| 503 | Worker not initialized |

---

### GET /api/status

Get current worker status.

**Response:**

```json
{
  "worker_id": "l0-01234567-89ab-7cde-f012-34567890abcd",
  "state": "accepting",
  "protocol_version": "1.0.0",
  "max_concurrency": 1,
  "inflight_tasks": 0,
  "available_slots": 1,
  "timestamp": 1702900000000
}
```

**Worker States:**

| State | Description |
|-------|-------------|
| `BOOT` | Initializing |
| `READY` | Ready to accept tasks |
| `ACCEPTING` | Actively accepting and processing tasks |
| `DRAINING` | Graceful shutdown, finishing existing tasks |
| `OFFLINE` | Shut down |

---

### POST /api/config

Hot-reload worker configuration.

**Request Body:** [WorkerConfigUpdate](#workerconfigupdate)

**Response:**

```json
{
  "success": true,
  "max_concurrency": 2,
  "timestamp": 1702900000000
}
```

---

## Request Types

### AuthEnvelope

Ephemeral, single-invocation authentication.

```typescript
interface AuthEnvelope {
  token: string;      // Min 32 characters, high entropy
  issued_at: number;  // Unix timestamp (ms) when token was created
  ttl: number;        // Time-to-live in milliseconds
}
```

**Validation:**

1. **Format:** Token length >= 32, TTL > 0
2. **Freshness:** `Date.now() < issued_at + ttl`
3. **Clock skew:** `issued_at` not more than 5 seconds in future

**Example:**

```json
{
  "token": "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6",
  "issued_at": 1702900000000,
  "ttl": 30000
}
```

---

### InferenceOrder

Defines what to execute and what shape the result must have.

```typescript
interface InferenceOrder {
  execution: ExecutionSpec;
  output: OutputSpec;
}
```

#### ExecutionSpec

```typescript
interface ExecutionSpec {
  models: ModelSpec[];           // Ordered preference list (required, min 1)
  parallel?: ParallelSpec;       // Optional parallel execution
  retry?: RetrySpec;             // Optional retry behavior
  fallbacks?: FallbackSpec[];    // Optional model fallbacks
  tools?: ToolSpec[];            // Optional tool access
}
```

#### ModelSpec

```typescript
interface ModelSpec {
  provider: string;                    // "openai" | "anthropic" | custom
  model: string;                       // Model identifier
  params?: Record<string, unknown>;    // Provider-specific parameters
}
```

**Common params:**

| Param | Type | Description |
|-------|------|-------------|
| `temperature` | number | Sampling temperature (0-2) |
| `maxTokens` | number | Maximum output tokens |
| `topP` | number | Nucleus sampling |
| `frequencyPenalty` | number | Frequency penalty (-2 to 2) |
| `presencePenalty` | number | Presence penalty (-2 to 2) |
| `stop` | string[] | Stop sequences |

#### RetrySpec

```typescript
interface RetrySpec {
  attempts: number;      // LLM-level error retries
  maxRetries: number;    // Total retries (LLM + network)
  backoff: "fixed" | "linear" | "exponential" | "fixed-jitter" | "full-jitter";
  baseDelayMs?: number;  // Base delay in ms (default: 1000)
  maxDelayMs?: number;   // Max delay in ms (default: 30000)
}
```

#### FallbackSpec

```typescript
interface FallbackSpec {
  when: "error" | "timeout" | "output_violation";
  model: ModelSpec;
}
```

#### ParallelSpec

```typescript
interface ParallelSpec {
  mode: "race" | "fanout";
  max?: number;
}
```

#### ToolSpec

```typescript
interface ToolSpec {
  name: string;
  schema: JSONSchema;
}
```

#### OutputSpec

```typescript
type OutputSpec = TextOutput | TokenOutput | JsonOutput;

interface TextOutput {
  kind: "text";
}

interface TokenOutput {
  kind: "tokens";
}

interface JsonOutput {
  kind: "json";
  schema: JSONSchema;     // JSON Schema for validation
  strict?: boolean;       // Strict validation (default: true)
}
```

**Example InferenceOrder:**

```json
{
  "execution": {
    "models": [
      {
        "provider": "openai",
        "model": "gpt-4o",
        "params": { "temperature": 0.7, "maxTokens": 1000 }
      }
    ],
    "retry": {
      "attempts": 3,
      "maxRetries": 6,
      "backoff": "exponential",
      "baseDelayMs": 1000
    },
    "fallbacks": [
      {
        "when": "error",
        "model": { "provider": "openai", "model": "gpt-4o-mini" }
      }
    ]
  },
  "output": {
    "kind": "json",
    "schema": {
      "type": "object",
      "properties": {
        "summary": { "type": "string" },
        "keywords": { "type": "array", "items": { "type": "string" } }
      },
      "required": ["summary", "keywords"]
    },
    "strict": true
  }
}
```

---

### TaskSubmit

```typescript
interface TaskSubmit {
  type: "TASK_SUBMIT";
  auth: AuthEnvelope;
  task_id: string;
  order: InferenceOrder;
  payload: {
    prompt?: string;
    messages?: Array<{
      role: "system" | "user" | "assistant";
      content: string;
    }>;
  };
  constraints?: {
    timeout_ms?: number;
    memory_cap_mb?: number;
    determinism_required?: boolean;
  };
  input_hash: string;
  submission_ts: number;
}
```

**Example:**

```json
{
  "type": "TASK_SUBMIT",
  "auth": {
    "token": "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6",
    "issued_at": 1702900000000,
    "ttl": 30000
  },
  "task_id": "task-abc123",
  "order": {
    "execution": {
      "models": [{ "provider": "openai", "model": "gpt-4o" }]
    },
    "output": { "kind": "text" }
  },
  "payload": {
    "prompt": "Explain quantum computing in simple terms."
  },
  "input_hash": "sha256:abc123...",
  "submission_ts": 1702900000000
}
```

---

### TaskReplayRequest

```typescript
interface TaskReplayRequest {
  type: "TASK_REPLAY_REQUEST";
  auth: AuthEnvelope;
  task_id: string;
  input_hash: string;
  expected_output_hash?: string;    // Optional verification
  reason: string;
  replay_ts: number;
}
```

---

### WorkerConfigUpdate

```typescript
interface WorkerConfigUpdate {
  type: "WORKER_CONFIG_UPDATE";
  worker_id: string;
  max_concurrency?: number;
  resource_caps?: Record<string, number>;
  feature_flags?: Record<string, boolean>;
  effective_ts: number;
}
```

---

## Response Events

### Worker Events

#### WORKER_READY

Emitted when worker is initialized and ready.

```typescript
interface WorkerReadyEvent {
  type: "WORKER_READY";
  worker_id: string;
  protocol_version: string;
  max_concurrency: number;
  timestamp: number;
}
```

#### WORKER_LOAD

Current resource pressure.

```typescript
interface WorkerLoadEvent {
  type: "WORKER_LOAD";
  worker_id: string;
  inflight_tasks: number;
  queue_depth: number;        // Always 0 (no internal queue)
  cpu_pressure: number;       // 0-1
  memory_pressure: number;    // 0-1
  gpu_pressure?: number;      // 0-1
  timestamp: number;
}
```

#### WORKER_DRAINING

Graceful shutdown initiated.

```typescript
interface WorkerDrainingEvent {
  type: "WORKER_DRAINING";
  worker_id: string;
  reason: string;
  timestamp: number;
}
```

#### WORKER_OFFLINE

Worker shutting down.

```typescript
interface WorkerOfflineEvent {
  type: "WORKER_OFFLINE";
  worker_id: string;
  timestamp: number;
}
```

---

### Task Events

#### TASK_ACCEPTED

Task accepted for execution.

```typescript
interface TaskAcceptedEvent {
  type: "TASK_ACCEPTED";
  task_id: string;
  worker_id: string;
  timestamp: number;
}
```

#### TASK_PROGRESS

Milestone reached during execution.

```typescript
interface TaskProgressEvent {
  type: "TASK_PROGRESS";
  task_id: string;
  stage: "first_token" | "streaming" | "tool_invoked" | "checkpoint_written";
  timestamp: number;
  metadata?: Record<string, unknown>;
}
```

#### TASK_COMPLETED

Execution succeeded.

```typescript
interface TaskCompletedEvent {
  type: "TASK_COMPLETED";
  task_id: string;
  worker_id: string;
  final_metrics: {
    duration_ms: number;
    token_count: number;
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  output_hash: string;
  output: string;
  timestamp: number;
}
```

#### TASK_FAILED

Execution failed.

```typescript
interface TaskFailedEvent {
  type: "TASK_FAILED";
  task_id: string;
  worker_id: string;
  failure_class: FailureClass;
  retryable: boolean;
  message?: string;
  timestamp: number;
}

type FailureClass =
  | "timeout"
  | "rate_limited"
  | "context_length_exceeded"
  | "invalid_input"
  | "model_error"
  | "network_error"
  | "guardrail_violation"
  | "determinism_violation"
  | "aborted"
  | "unknown";
```

---

### L0 Lifecycle Events

L0 runtime events are passed through directly. All have `type` and `ts` fields.

#### Session Events

```typescript
{ type: "SESSION_START", ts: number, sessionId: string }
{ type: "SESSION_END", ts: number }
{ type: "SESSION_SUMMARY", ts: number, tokenCount: number, startTs: number, endTs: number, ... }
```

#### Stream Events

```typescript
{ type: "STREAM_INIT", ts: number, model: string, provider: string }
{ type: "STREAM_READY", ts: number }
```

#### Retry Events

```typescript
{ type: "RETRY_START", ts: number, attempt: number, maxAttempts: number }
{ type: "RETRY_ATTEMPT", ts: number, index: number, reason: string, isNetwork: boolean, isModelIssue: boolean }
{ type: "RETRY_END", ts: number, attempt: number, success: boolean, durationMs: number }
{ type: "RETRY_GIVE_UP", ts: number, attempts: number, lastError: string }
```

#### Fallback Events

```typescript
{ type: "FALLBACK_START", ts: number, from: string, to: string, reason: string }
{ type: "FALLBACK_MODEL_SELECTED", ts: number, index: number, model: string }
{ type: "FALLBACK_END", ts: number, index: number, durationMs: number }
```

#### Guardrail Events

```typescript
{ type: "GUARDRAIL_PHASE_START", ts: number, phase: "pre" | "post", ruleCount: number }
{ type: "GUARDRAIL_PHASE_END", ts: number, phase: "pre" | "post", passed: boolean, violations: number, durationMs: number }
{ type: "GUARDRAIL_RULE_START", ts: number, index: number, ruleId: string, callbackId: string }
{ type: "GUARDRAIL_RULE_RESULT", ts: number, index: number, ruleId: string, passed: boolean, violation?: object }
{ type: "GUARDRAIL_RULE_END", ts: number, index: number, ruleId: string, passed: boolean, callbackId: string, durationMs: number }
{ type: "GUARDRAIL_CALLBACK_START", ts: number, callbackId: string, index: number, ruleId: string }
{ type: "GUARDRAIL_CALLBACK_END", ts: number, callbackId: string, index: number, ruleId: string, durationMs: number, success: boolean, error?: string }
```

#### Timeout Events

```typescript
{ type: "TIMEOUT_START", ts: number, timeoutType: "initial" | "inter", configuredMs: number }
{ type: "TIMEOUT_RESET", ts: number, timeoutType: "initial" | "inter", configuredMs: number, tokenIndex: number }
{ type: "TIMEOUT_TRIGGERED", ts: number, timeoutType: "initial" | "inter", elapsedMs: number, configuredMs: number }
```

#### Network Events

```typescript
{ type: "NETWORK_ERROR", ts: number, error: string, code: string, willRetry: boolean }
{ type: "NETWORK_RECOVERY", ts: number, attemptCount: number, durationMs: number }
{ type: "CONNECTION_DROPPED", ts: number, reason: string }
{ type: "CONNECTION_RESTORED", ts: number, durationMs: number }
```

#### Tool Events

```typescript
{ type: "TOOL_REQUESTED", ts: number, toolName: string, arguments: object, toolCallId: string }
{ type: "TOOL_START", ts: number, toolCallId: string, toolName: string }
{ type: "TOOL_RESULT", ts: number, toolCallId: string, result: unknown, durationMs: number }
{ type: "TOOL_ERROR", ts: number, toolCallId: string, error: string, durationMs: number }
{ type: "TOOL_COMPLETED", ts: number, toolCallId: string, status: "success" | "error" }
```

#### Checkpoint Events

```typescript
{ type: "CHECKPOINT_SAVED", ts: number, checkpoint: string, tokenCount: number }
```

#### Resume Events

```typescript
{ type: "RESUME_START", ts: number, checkpoint: string, stateHash: string, tokenCount: number }
{ type: "RESUME_END", ts: number, checkpoint: string, durationMs: number, success: boolean }
```

#### Abort Events

```typescript
{ type: "ABORT_REQUESTED", ts: number, source: "user" | "timeout" | "error" }
{ type: "ABORT_COMPLETED", ts: number, resourcesFreed: boolean }
```

#### Drift Events

```typescript
{ type: "DRIFT_CHECK_START", ts: number, checkpoint: string, tokenCount: number, strategy: string }
{ type: "DRIFT_CHECK_RESULT", ts: number, detected: boolean, score: number, metrics: object, threshold: number }
{ type: "DRIFT_CHECK_END", ts: number, durationMs: number }
{ type: "DRIFT_CHECK_SKIPPED", ts: number, reason: string }
```

---

## Error Handling

### HTTP Errors

| Status | Description |
|--------|-------------|
| 400 | Bad Request - Invalid request body or schema validation failed |
| 401 | Unauthorized - Auth validation failed (expired, invalid format, etc.) |
| 404 | Not Found - Resource not found (e.g., task for replay) |
| 405 | Method Not Allowed - Wrong HTTP method |
| 503 | Service Unavailable - Worker not accepting tasks or no slots available |

### Auth Errors

```json
{
  "error": "Auth validation failed",
  "reason": "expired"
}
```

Possible `reason` values: `"expired"`, `"invalid_format"`, `"issued_in_future"`

### Validation Errors

```json
{
  "error": "Invalid request",
  "details": {
    "order": { "execution": { "_errors": ["Required"] } }
  }
}
```

### Backpressure

When no slots are available:

```json
{
  "error": "No slots available",
  "inflight": 1,
  "max": 1
}
```

---

## Rate Limits

L0 Worker does not implement rate limiting. Backpressure is enforced via slot availability. L1 orchestrator is responsible for higher-level rate limiting and load balancing.

---

## Versioning

Protocol version is returned in `WORKER_READY` event and `/api/status` response.

Current version: `1.0.0`
