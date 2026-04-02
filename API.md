# L0 Worker API Reference

Complete API documentation for the L0 Worker.

## Table of Contents

- [Endpoints](#endpoints)
  - [POST /api/submit](#post-apisubmit)
  - [POST /api/replay](#post-apireplay)
  - [GET /api/status](#get-apistatus)
  - [POST /api/config](#post-apiconfig)
  - [POST /api/drain](#post-apidrain)
- [Request Types](#request-types)
  - [AuthEnvelope](#authenvelope)
  - [InferenceOrder](#inferenceorder) (incl. [TimeoutSpec](#timeoutspec), [GuardrailSpec](#guardrailspec), [ToolSpec](#toolspec), [ParallelSpec](#parallelspec))
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
data: {"type":"TASK_ACCEPTED","taskId":"task-123","workerId":"...","ts":1702900000000}

data: {"type":"TASK_PROGRESS","taskId":"task-123","stage":"first_token","ts":1702900000100}

data: {"type":"TASK_COMPLETED","taskId":"task-123","workerId":"...","output":"Hello!","outputHash":"sha256:...","finalMetrics":{"durationMs":1500,"tokenCount":10},"ts":1702900001500}

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
data: {"type":"TASK_ACCEPTED","taskId":"task-123",...}

data: {"type":"TASK_PROGRESS","taskId":"task-123",...}

data: {"type":"TASK_COMPLETED","taskId":"task-123",...}

data: {"type":"REPLAY_COMPLETE","eventsReplayed":3,"outputHashMatch":true}
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
  "workerId": "01234567-89ab-7cde-f012-34567890abcd",
  "state": "ACCEPTING",
  "protocolVersion": "1.0.0",
  "maxConcurrency": 1,
  "inflightTasks": 0,
  "availableSlots": 1,
  "ts": 1702900000000
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
  "maxConcurrency": 2,
  "ts": 1702900000000
}
```

**Error Responses:**

| Status | Reason |
|--------|--------|
| 400 | Invalid request body or worker ID mismatch |
| 405 | Method not allowed |
| 503 | Worker not initialized |

---

### POST /api/drain

Trigger graceful shutdown. Aborts in-flight L0 streams via `AbortSignal`.

- **Localhost**: No auth required
- **Non-localhost**: Requires valid auth token

**Request Body (remote only):**

```json
{
  "worker_id": "...",
  "auth": {
    "token": "...",
    "issued_at": 1702900000000,
    "ttl": 30000
  }
}
```

**Response:**

```json
{
  "success": true,
  "message": "Drain initiated",
  "workerId": "...",
  "drainBufferMs": 5000
}
```

The worker emits `WORKER_DRAINING`, aborts in-flight streams, and exits after `drainBufferMs` milliseconds.

**Error Responses:**

| Status | Reason |
|--------|--------|
| 401 | Auth validation failed (remote only) |
| 405 | Method not allowed |
| 503 | Worker not initialized |

---

## Request Types

### AuthEnvelope

Ephemeral, single-invocation authentication with HMAC verification.

```typescript
interface AuthEnvelope {
  token: string;      // HMAC-SHA256 signature (base64)
  issued_at: number;  // Unix timestamp (ms) when token was created
  ttl: number;        // Time-to-live in milliseconds
}
```

**Token Generation (L1 side):**

```typescript
import { createHmac } from "node:crypto";

function generateAuthToken(
  secret: string,
  taskId: string,
  issuedAt: number,
  ttl: number
): string {
  const payload = `${taskId}|${issuedAt}|${ttl}`;
  return createHmac("sha256", secret).update(payload, "utf8").digest("base64");
}
```

**Validation (L0 side):**

1. **Format:** Token is valid base64, TTL > 0
2. **Freshness:** `Date.now() < issued_at + ttl`
3. **Clock skew:** `issued_at` not more than 5 seconds in future
4. **Signature:** `token === HMAC-SHA256(L0_AUTH_SECRET, task_id|issued_at|ttl)`

If `L0_AUTH_SECRET` environment variable is not set, signature verification is skipped (development mode only).

**Example:**

```json
{
  "token": "K7gNU3sdo+OL0wNhqoVWhr3g6s1xYv72ol/pe/Unols=",
  "issued_at": 1702900000000,
  "ttl": 30000
}
```

Note: The example token is `HMAC-SHA256(secret, "task-123|1702900000000|30000")` in base64.

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
  parallel?: ParallelSpec;       // Optional parallel execution (race or fanout)
  retry?: RetrySpec;             // Optional retry behavior
  fallbacks?: FallbackSpec[];    // Optional model fallbacks
  tools?: ToolSpec[];            // Optional tool definitions (schema-only)
  timeout?: TimeoutSpec;         // Optional per-stream timeouts
  guardrails?: GuardrailSpec;    // Optional output quality guardrails
  continueFromLastKnownGoodToken?: boolean;  // Resume from checkpoint on retry/fallback
}
```

#### ModelSpec

```typescript
interface ModelSpec {
  provider: string;                    // Currently "openai" only
  model: string;                       // Model identifier
  params?: Record<string, unknown>;    // Provider-specific parameters
}
```

**Common params:**

| Param | Type | Description |
|-------|------|-------------|
| `temperature` | number | Sampling temperature (0-2) |
| `maxOutputTokens` | number | Maximum output tokens |
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

When specified, all models in `ExecutionSpec.models` run simultaneously.

```typescript
interface ParallelSpec {
  mode: "race" | "fanout";  // race: first wins; fanout: all run to completion
  max?: number;              // Max concurrency for fanout mode
}
```

- **race**: Returns the output from whichever model completes first. Others are cancelled.
- **fanout**: All models run to completion. Results returned as a JSON array in `output`.

#### ToolSpec

Schema-only tool definitions. The model generates tool call arguments; the worker does **not** execute tools server-side. Tool calls are captured in the result and emitted as `TASK_PROGRESS` events with `stage: "tool_invoked"`.

```typescript
interface ToolSpec {
  name: string;              // Tool identifier
  description?: string;      // Helps the model decide when to use the tool
  schema: JSONSchema;        // JSON Schema for tool input parameters
}
```

#### TimeoutSpec

Per-stream timeout configuration passed to the L0 runtime. Critical for serverless deployments.

```typescript
interface TimeoutSpec {
  initialTokenMs?: number;   // Max time to wait for first token
  interTokenMs?: number;     // Max time between consecutive tokens
}
```

Timeouts trigger L0's `TIMEOUT_TRIGGERED` event and may cause retry or fallback depending on configuration.

#### GuardrailSpec

Output quality validation during streaming. Uses preset rule sets from the L0 runtime.

```typescript
interface GuardrailSpec {
  preset?: "minimal" | "recommended" | "strict" | "json-only" | "markdown-only" | "latex-only";
  checkIntervalMs?: number;  // How often to run guardrail checks (ms)
}
```

| Preset | Description |
|--------|-------------|
| `minimal` | Zero-output detection only |
| `recommended` | JSON, Markdown, and zero-output checks |
| `strict` | All checks with strict JSON validation |
| `json-only` | JSON structure validation |
| `markdown-only` | Markdown structure validation |
| `latex-only` | LaTeX structure validation |

Guardrail violations are classified as `guardrail_violation` in `TASK_FAILED`.

#### OutputSpec

```typescript
type OutputSpec = TextOutput | JsonOutput;

interface TextOutput {
  kind: "text";
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
        "params": { "temperature": 0.7, "maxOutputTokens": 1000 }
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
    ],
    "timeout": {
      "initialTokenMs": 10000,
      "interTokenMs": 5000
    },
    "guardrails": {
      "preset": "recommended",
      "checkIntervalMs": 500
    },
    "tools": [
      {
        "name": "get_weather",
        "description": "Get current weather for a location",
        "schema": {
          "type": "object",
          "properties": { "city": { "type": "string" } },
          "required": ["city"]
        }
      }
    ],
    "continueFromLastKnownGoodToken": true
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
  constraints?: {                    // Reserved — parsed but not enforced
    timeout_ms?: number;
    memory_cap_mb?: number;
    determinism_required?: boolean;
  };
  meta?: Record<string, unknown>;  // Passed through to L0 runtime
  input_hash: string;
  submission_ts: number;
}
```

**Example:**

```json
{
  "type": "TASK_SUBMIT",
  "auth": {
    "token": "K7gNU3sdo+OL0wNhqoVWhr3g6s1xYv72ol/pe/Unols=",
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
  workerId: string;
  protocolVersion: string;
  maxConcurrency: number;
  ts: number;
}
```

#### WORKER_LOAD

Current resource pressure.

```typescript
interface WorkerLoadEvent {
  type: "WORKER_LOAD";
  workerId: string;
  inflightTasks: number;
  queueDepth: number;        // Always 0 (no internal queue)
  cpuPressure: number;       // 0-1
  memoryPressure: number;    // 0-1
  gpuPressure?: number;      // 0-1
  ts: number;
}
```

#### WORKER_DRAINING

Graceful shutdown initiated.

```typescript
interface WorkerDrainingEvent {
  type: "WORKER_DRAINING";
  workerId: string;
  reason: string;
  ts: number;
}
```

#### WORKER_OFFLINE

Worker shutting down.

```typescript
interface WorkerOfflineEvent {
  type: "WORKER_OFFLINE";
  workerId: string;
  ts: number;
}
```

---

### Task Events

#### TASK_ACCEPTED

Task accepted for execution.

```typescript
interface TaskAcceptedEvent {
  type: "TASK_ACCEPTED";
  taskId: string;
  workerId: string;
  ts: number;
}
```

#### TASK_PROGRESS

Milestone reached during execution.

```typescript
interface TaskProgressEvent {
  type: "TASK_PROGRESS";
  taskId: string;
  stage: "first_token" | "tool_invoked";
  ts: number;
  metadata?: Record<string, unknown>;  // For tool_invoked: { toolName, toolArgs }
}
```

| Stage | When emitted |
|-------|-------------|
| `first_token` | First token received from the model |
| `tool_invoked` | Model generated a tool call (metadata contains `toolName` and `toolArgs`) |

#### TASK_COMPLETED

Execution succeeded.

```typescript
interface TaskCompletedEvent {
  type: "TASK_COMPLETED";
  taskId: string;
  workerId: string;
  finalMetrics: {
    durationMs: number;
    tokenCount: number;
    promptTokens?: number;
    completionTokens?: number;
  };
  outputHash: string;
  output: string;
  ts: number;
}
```

#### TASK_FAILED

Execution failed.

```typescript
interface TaskFailedEvent {
  type: "TASK_FAILED";
  taskId: string;
  workerId: string;
  failureClass: FailureClass;
  retryable: boolean;
  message?: string;
  ts: number;
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

Possible `reason` values: `"expired"`, `"invalid_format"`, `"issued_in_future"`, `"invalid_signature"`, `"missing_auth_secret"`

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
