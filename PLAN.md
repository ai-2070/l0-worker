# L0 Worker Implementation Plan

## Overview

Stateless, deterministic execution substrate that:
- Receives commands from L1 orchestrator via gRPC
- Executes LLM tasks using `@ai2070/l0` + Vercel AI SDK + OpenAI
- Emits factual events back to L1
- Enforces backpressure by silence (no TASK_ACCEPTED = rejection)

**Stack:** 
- Plain Node.js + TypeScript
- `@ai2070/l0` (streaming runtime + Zod 4 schemas)
- `ai` + `@ai-sdk/openai` (inference)
- `@grpc/grpc-js` (L1 transport)
- `zod` (runtime validation)

---

## Event Flow

```
                    L1 ORCHESTRATOR
                          │
          ┌───────────────┼───────────────┐
          │               │               │
          ▼               ▼               ▼
    TASK_SUBMIT    WORKER_DRAIN    TASK_REPLAY
          │          REQUEST        REQUEST
          │               │               │
          └───────────────┼───────────────┘
                          │
                          ▼
                    ┌───────────┐
                    │ L0 WORKER │
                    └─────┬─────┘
                          │
          ┌───────────────┼───────────────┐
          │               │               │
          ▼               ▼               ▼
   TASK_ACCEPTED   TASK_PROGRESS   TASK_COMPLETED
   TASK_FAILED     WORKER_LOAD     WORKER_DRAINING
   WORKER_READY    WORKER_OFFLINE
          │               │               │
          └───────────────┼───────────────┘
                          │
                          ▼
                    L1 ORCHESTRATOR
```

---

## Inbound Events (from L1)

### Core (v1)

| Event | Purpose | Response |
|-------|---------|----------|
| `TASK_SUBMIT` | Propose work | `TASK_ACCEPTED` or silence |
| `WORKER_DRAIN_REQUEST` | Graceful shutdown | `WORKER_DRAINING` |
| `TASK_REPLAY_REQUEST` | Re-execute deterministically | Re-emit all events |

### Control Plane

| Event | Purpose | Response |
|-------|---------|----------|
| `WORKER_CONFIG_UPDATE` | Hot reconfiguration | Apply new config |

### Optional (v2)

| Event | Purpose | Response |
|-------|---------|----------|
| `STATE_SNAPSHOT_LOAD` | Fast recovery | Load snapshot |
| `EXECUTION_ABORT` | Hard stop | Abort task |
| `CAPABILITY_INVALIDATED` | Invalidate capability | Reject incompatible work |

---

## Outbound Events (to L1)

| Event | When |
|-------|------|
| `WORKER_READY` | Boot complete |
| `WORKER_LOAD` | Periodic / threshold |
| `TASK_ACCEPTED` | Task accepted |
| `TASK_PROGRESS` | Milestone reached |
| `TASK_COMPLETED` | Success |
| `TASK_FAILED` | Failure |
| `WORKER_DRAINING` | Drain started |
| `WORKER_OFFLINE` | Shutdown complete |

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                            L0 WORKER                                 │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌─────────────────┐                          ┌──────────────────┐   │
│  │  gRPC Receiver  │─── inbound events ──────▶│  Event Router    │   │
│  │  (from L1)      │                          │                  │   │
│  └─────────────────┘                          └────────┬─────────┘   │
│                                                        │             │
│         ┌──────────────────────────────────────────────┼─────┐       │
│         │                      │                       │     │       │
│         ▼                      ▼                       ▼     ▼       │
│  ┌────────────┐    ┌─────────────────┐    ┌───────┐  ┌───────────┐   │
│  │TASK_SUBMIT │    │WORKER_DRAIN_REQ │    │REPLAY │  │CONFIG_UPD │   │
│  └─────┬──────┘    └────────┬────────┘    └───┬───┘  └─────┬─────┘   │
│        │                    │                 │            │         │
│        ▼                    ▼                 │            ▼         │
│  ┌───────────┐       ┌───────────┐            │     ┌───────────┐    │
│  │   Slots   │       │   State   │            │     │  Config   │    │
│  │  Manager  │       │  Machine  │            │     │  Manager  │    │
│  └─────┬─────┘       └───────────┘            │     └───────────┘    │
│        │                                      │                      │
│        ▼                                      │                      │
│  ┌───────────────────────────────────────┐    │                      │
│  │            Task Executor              │◀───┘                      │
│  │  ┌─────────────────────────────────┐  │                           │
│  │  │         @ai2070/l0              │  │                           │
│  │  │  (stream, checkpoint, events)   │  │                           │
│  │  └─────────────────────────────────┘  │                           │
│  │  ┌─────────────────────────────────┐  │                           │
│  │  │   Vercel AI SDK + OpenAI        │  │                           │
│  │  └─────────────────────────────────┘  │                           │
│  └───────────────────┬───────────────────┘                           │
│                      │                                               │
│                      ▼                                               │
│  ┌───────────────────────────────────────────────────────────────┐   │
│  │                    Event Emitter                              │   │
│  │  (validates with L0EventSchema, sends to gRPC)                │   │
│  └───────────────────────────────────────────────────────────────┘   │
│                      │                                               │
└──────────────────────┼───────────────────────────────────────────────┘
                       │
                       ▼
                 L1 ORCHESTRATOR
```

---

## Dependencies

```json
{
  "dependencies": {
    "@ai2070/l0": "latest",
    "ai": "^4.0.0",
    "@ai-sdk/openai": "^1.0.0",
    "@grpc/grpc-js": "^1.12.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vitest": "^2.0.0",
    "@types/node": "^22.0.0",
    "tsx": "^4.0.0"
  }
}
```

---

## File Structure

```
l0-worker/
├── src/
│   ├── index.ts                 # Entry point
│   ├── worker.ts                # Main L0Worker class
│   │
│   ├── events/
│   │   ├── inbound.ts           # Inbound event schemas (TASK_SUBMIT, etc.)
│   │   ├── outbound.ts          # Outbound event types (uses L0 schemas)
│   │   ├── router.ts            # Event routing logic
│   │   └── index.ts
│   │
│   ├── transport/
│   │   ├── grpc.ts              # gRPC bidirectional stream
│   │   ├── serialization.ts     # JSON encode/decode
│   │   └── index.ts
│   │
│   ├── executor/
│   │   ├── executor.ts          # Task execution with @ai2070/l0
│   │   ├── slots.ts             # Concurrency slot manager
│   │   └── index.ts
│   │
│   ├── state/
│   │   ├── machine.ts           # Worker state machine
│   │   ├── config.ts            # Hot-reloadable config
│   │   └── index.ts
│   │
│   ├── replay/
│   │   ├── replayer.ts          # Re-emit recorded events
│   │   └── index.ts
│   │
│   ├── store/
│   │   ├── event-store.ts       # Record emitted events per task
│   │   ├── memory-store.ts      # In-memory implementation
│   │   └── index.ts
│   │
│   └── utils/
│       ├── hash.ts              # SHA-256 for output_hash
│       ├── clock.ts             # Monotonic timestamps
│       └── index.ts
│
├── tests/
│   ├── executor.test.ts
│   ├── slots.test.ts
│   ├── state.test.ts
│   └── replay.test.ts
│
├── package.json
├── tsconfig.json
├── SPECS.md
└── EVENTS.md
```

---

## Key Types

### Inbound Events (Zod schemas)

```typescript
import { z } from "zod";

export const TaskSubmitSchema = z.object({
  type: z.literal("TASK_SUBMIT"),
  task_id: z.string(),
  payload: z.unknown(),  // opaque to L0
  constraints: z.object({
    timeout_ms: z.number().optional(),
    memory_cap_mb: z.number().optional(),
    determinism_required: z.boolean().optional(),
  }).optional(),
  input_hash: z.string(),
  submission_ts: z.number(),
});

export const WorkerDrainRequestSchema = z.object({
  type: z.literal("WORKER_DRAIN_REQUEST"),
  worker_id: z.string(),
  reason: z.string(),
  deadline_ts: z.number(),
});

export const TaskReplayRequestSchema = z.object({
  type: z.literal("TASK_REPLAY_REQUEST"),
  task_id: z.string(),
  input_hash: z.string(),
  expected_output_hash: z.string().optional(),
  reason: z.string(),
  replay_ts: z.number(),
});

export const WorkerConfigUpdateSchema = z.object({
  type: z.literal("WORKER_CONFIG_UPDATE"),
  worker_id: z.string(),
  max_concurrency: z.number().optional(),
  resource_caps: z.record(z.number()).optional(),
  feature_flags: z.record(z.boolean()).optional(),
  effective_ts: z.number(),
});

export const InboundEventSchema = z.discriminatedUnion("type", [
  TaskSubmitSchema,
  WorkerDrainRequestSchema,
  TaskReplayRequestSchema,
  WorkerConfigUpdateSchema,
]);
```

### Outbound Events (from L0 library)

```typescript
import { L0EventSchema } from "@ai2070/l0/zod";

// Use L0's built-in schemas for validation
// Extend with worker-specific events
```

---

## Implementation Phases

### Phase 1: Project Setup
- Initialize package.json, tsconfig.json
- Install dependencies
- Create folder structure

### Phase 2: Event System
- Define inbound event Zod schemas
- Import L0 outbound schemas
- Build event router

### Phase 3: gRPC Transport
- Untyped bidirectional stream
- JSON serialization
- Connection management

### Phase 4: State Machine
- BOOT → READY → ACCEPTING → DRAINING → OFFLINE
- Hot config updates

### Phase 5: Slot Manager
- Fixed `max_concurrency` slots
- Backpressure by rejection (silence)

### Phase 6: Task Executor
- Integrate `@ai2070/l0` with `streamText`
- Map L0 events to TASK_PROGRESS
- Compute output_hash on completion

### Phase 7: Load Reporting
- Periodic WORKER_LOAD events
- CPU/memory pressure metrics

### Phase 8: Replay Support
- **Replay = re-emit recorded events, NOT re-execute**
- Scope limited to task-scoped, already-emitted facts
- Never regenerate tokens differently
- Never re-invoke tools with side effects
- Never fabricate progress events
- Validate output_hash matches recorded

### Phase 9: Tests
- Unit tests for each module
- Integration tests with mock L1

---

## Failure Classes

```typescript
enum FailureClass {
  TIMEOUT = "timeout",
  RATE_LIMITED = "rate_limited", 
  CONTEXT_LENGTH_EXCEEDED = "context_length_exceeded",
  INVALID_INPUT = "invalid_input",
  MODEL_ERROR = "model_error",
  NETWORK_ERROR = "network_error",
  GUARDRAIL_VIOLATION = "guardrail_violation",
  DETERMINISM_VIOLATION = "determinism_violation",
  ABORTED = "aborted",
  UNKNOWN = "unknown"
}
```

---

## Progress Stages

```typescript
enum ProgressStage {
  FIRST_TOKEN = "first_token",
  STREAMING = "streaming",
  TOOL_INVOKED = "tool_invoked",
  CHECKPOINT_WRITTEN = "checkpoint_written"
}
```

---

## Backpressure Strategy

**L0 enforces backpressure by silence:**

1. `TASK_SUBMIT` arrives
2. Check slot availability
3. If slot available → emit `TASK_ACCEPTED`
4. If no slot → **do nothing** (L1 infers rejection by absence)

No queue. No buffering. No rejection event.

---

## Replay Constraints

**Replay = re-emit recorded facts, NOT re-execute**

Replay scope is strictly limited to:
- Task-scoped events only
- Already-emitted facts only

Replay must **NEVER**:
- Regenerate tokens differently
- Re-invoke tools with side effects
- Fabricate progress events
- Emit events that weren't originally recorded

Implementation:
```typescript
// Replay reads from event store, not execution
async function replay(taskId: string, eventStore: EventStore): AsyncIterable<L0Event> {
  const recorded = await eventStore.getEventsForTask(taskId);
  for (const event of recorded) {
    yield event;  // Re-emit exactly as recorded
  }
}
```

This requires an **event store** to record all emitted events during execution.

---

## Constraints

- **No internal queue** - Reject by silence
- **No retries at L0** - L0 library handles stream retries, L1 handles task retries
- **No orchestration** - Execute what L1 assigns
- **Events are facts** - Never intent
- **Determinism** - Same input → same output_hash
- **Replay is re-emit, not re-execute** - Only recorded facts
