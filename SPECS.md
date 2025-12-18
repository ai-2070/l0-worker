L0 Worker – Design Specification
================================

**Deterministic Execution Substrate (L0)**

Purpose
-------

The L0 Worker is a **stateless, deterministic execution unit** that participates in the L0 data plane.  
It does **not** schedule, orchestrate, or decide _what_ to run — it only:

*   accepts work
*   executes deterministically
*   emits factual events
*   enforces backpressure at the protocol level

L0 Workers are designed to be:

*   replayable
*   observable
*   crash-recoverable
*   horizontally scalable
*   schedulable _by emergence_, not control logic

* * *

Core Design Principles
----------------------

1.  **Events describe facts, never intent**
2.  **No centralized scheduler**
3.  **No hidden state**
4.  **Determinism > convenience**
5.  **Replay is a first-class feature**
6.  **Backpressure is enforced by protocol, not policy**

* * *

Non-Goals (Explicit)
--------------------

The L0 Worker does **not**:

*   queue tasks
*   assign work to others
*   hold global state
*   manage retries
*   perform orchestration
*   implement business logic

Those belong to L1+.

* * *

Worker Lifecycle
----------------

```
BOOT
 └─> WORKER_READY
      ├─> TASK_ACCEPTED
      │    ├─> TASK_PROGRESS*
      │    └─> TASK_COMPLETED | TASK_FAILED
      ├─> WORKER_LOAD (periodic / threshold)
      ├─> WORKER_DRAINING
      └─> WORKER_OFFLINE
```

(\* optional)

* * *

Event Model (Authoritative)
---------------------------

All events are:

*   append-only
*   idempotent
*   timestamped
*   replayable
*   transport-agnostic

### 1\. WORKER\_READY

Emitted when the worker is able to accept work.

**Fields**

*   `worker_id`
*   `protocol_version`
*   `capability_hash`
*   `max_concurrency`
*   `timestamp`

**Notes**

*   Replaces heartbeats
*   Absence implies failure

* * *

### 2\. WORKER\_LOAD

Describes **current pressure**, not intent.

**Fields**

*   `worker_id`
*   `inflight_tasks`
*   `queue_depth`
*   `cpu_pressure`
*   `memory_pressure`
*   `optional: gpu_pressure`
*   `timestamp`

**Emission**

*   periodic
*   threshold-based
*   state change only

* * *

### 3\. TASK\_ACCEPTED

Commit point for execution.

**Fields**

*   `task_id`
*   `worker_id`
*   `timestamp`

**Rules**

*   emitted exactly once per task
*   after this, retries must use replay

* * *

### 4\. TASK\_PROGRESS (Optional)

Milestone-based progress, not percentages.

**Examples**

*   model\_loaded
*   first\_token\_emitted
*   tool\_invoked
*   checkpoint\_written

**Fields**

*   `task_id`
*   `stage`
*   `timestamp`
*   `optional metadata`

* * *

### 5\. TASK\_COMPLETED

Terminal success state.

**Fields**

*   `task_id`
*   `worker_id`
*   `final_metrics`
*   `output_hash`
*   `timestamp`

* * *

### 6\. TASK\_FAILED

Terminal failure state.

**Fields**

*   `task_id`
*   `worker_id`
*   `failure_class`
*   `retryable: bool`
*   `timestamp`

Failure classes must be **enumerated**, not free-text.

* * *

### 7\. WORKER\_DRAINING

Signals graceful shutdown.

**Fields**

*   `worker_id`
*   `reason`
*   `timestamp`

**Effect**

*   no new TASK\_ACCEPTED events allowed

* * *

### 8\. WORKER\_OFFLINE

Final event.

**Fields**

*   `worker_id`
*   `timestamp`

* * *

Execution Model
---------------

*   Tasks are **pure functions of input + environment**
*   All side effects must be:
    *   observable
    *   replayable
    *   checksum-verifiable
*   Workers may crash at any point
*   Recovery is achieved via replay, not rollback

* * *

Determinism Guarantees
----------------------

The worker guarantees:

*   ordered execution per stream
*   byte-exact output for identical inputs
*   replayable failure modes
*   monotonic event ordering

The worker does **not** guarantee:

*   execution timing
*   resource fairness
*   task priority

* * *

Backpressure & Safety Envelope
------------------------------

Backpressure is enforced by:

*   refusing TASK\_ACCEPTED when saturated
*   emitting WORKER\_LOAD truthfully
*   never buffering unbounded work

This creates a **protocol-level safety envelope**:

*   no queue explosions
*   no cascading failures
*   no hidden overload

* * *

Concurrency Model
-----------------

*   Fixed `max_concurrency`
*   No dynamic thread spawning
*   No internal scheduling
*   Each accepted task occupies one slot until terminal

* * *

Crash & Recovery Semantics
--------------------------

After crash:

1.  Worker restarts
2.  Emits WORKER\_READY
3.  Replays unfinished tasks if requested
4.  Never emits duplicate TASK\_ACCEPTED

* * *

Observability
-------------

Everything meaningful is an event.  
Logs are optional.  
Metrics are derived, not primary.

* * *

Interfaces (Minimal)
--------------------

### Input

*   Task payload (opaque to L0)
*   Replay instruction (optional)

### Output

*   Event stream only

* * *

Size & Complexity Targets
-------------------------

*   < 10k LOC for worker core
*   zero required external dependencies
*   embeddable in:
    *   Rust
    *   WASM
    *   native desktop runtimes
