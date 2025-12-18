> **L0 emits facts. It listens only to facts and commands that can be reduced to facts.**

No intent graphs, no orchestration signals, no “please try harder” messages.

* * *

The Rule of Thumb
-----------------

An L0 worker should listen for **exactly three categories of inbound events**:

1.  **Work admission**
2.  **Control-plane lifecycle**
3.  **Replay / recovery**

Anything else belongs to L1+.

* * *

1\. Work Admission Events (Core)
--------------------------------

These are the only events that cause _execution_.

### ✅ `TASK_SUBMIT`

This is the **only event that can create work**.

**Purpose**

*   Proposes a unit of execution
*   Does _not_ guarantee acceptance

**Fields**

*   `task_id`
*   `payload` (opaque blob or reference)
*   `constraints` (optional: timeout, memory cap, determinism flags)
*   `input_hash`
*   `submission_ts`

**Worker behavior**

*   Validate payload
*   Check safety envelope
*   Either:
    *   emit `TASK_ACCEPTED`
    *   or silently ignore (backpressure by absence)

**Important**

*   No retries here
*   No priority
*   No routing logic

* * *

2\. Control-Plane Lifecycle Events
----------------------------------

These do **not** create work.  
They only affect _whether_ work is accepted.

### ✅ `WORKER_CONFIG_UPDATE`

Allows **hot-reconfiguration without redeploys**.

**Fields**

*   `worker_id`
*   `max_concurrency`
*   `resource_caps`
*   `feature_flags`
*   `effective_ts`

**Why it matters**

*   Enables fleet-wide tuning
*   Enables experiments
*   Enables emergency clamps

* * *

### ✅ `WORKER_DRAIN_REQUEST`

Graceful shutdown coordination.

**Fields**

*   `worker_id`
*   `reason`
*   `deadline_ts`

**Worker behavior**

*   Emit `WORKER_DRAINING`
*   Stop accepting new tasks
*   Finish inflight work

* * *

3\. Replay & Recovery Events (Critical)
---------------------------------------

This is what makes the system **legend-level instead of brittle**.

### ✅ `TASK_REPLAY_REQUEST`

Requests deterministic re-execution.

**Fields**

*   `task_id`
*   `input_hash`
*   `expected_output_hash` (optional)
*   `reason`
*   `replay_ts`

**Worker behavior**

*   Reconstruct execution context
*   Re-emit events
*   Never mutate history

* * *

### ✅ `STATE_SNAPSHOT_LOAD` (Optional but powerful)

Allows fast recovery without full replay.

**Fields**

*   `snapshot_id`
*   `snapshot_hash`
*   `created_ts`

Used mostly in:

*   long-running tasks
*   streaming inference
*   agent loops

* * *

4\. Optional (Advanced, Still L0-Safe)
--------------------------------------

These are **allowed**, but not required for v1.

### ⚠️ `EXECUTION_ABORT`

Hard stop.

**Fields**

*   `task_id`
*   `reason`
*   `force: bool`

Used for:

*   safety violations
*   resource exhaustion
*   manual intervention

* * *

### ⚠️ `CAPABILITY_INVALIDATED`

Signals that assumptions are no longer valid.

**Fields**

*   `worker_id`
*   `capability_hash`
*   `timestamp`

Worker may:

*   finish current tasks
*   reject new incompatible work

* * *

What L0 Must **Never** Listen To
--------------------------------

These are _explicitly forbidden_ at L0:

❌ “retry this task”  
❌ “increase priority”  
❌ “route this to GPU”  
❌ “this task is important”  
❌ “try another provider”  
❌ “user intent changed”

Those are **decisions**, not facts.
