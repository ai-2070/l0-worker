import { WorkerStateMachine, WorkerState } from "./state/machine.js";
import { ConfigManager, type WorkerConfigInput } from "./state/config.js";
import {
  SlotManager,
  executeOrder,
  parseTaskPayload,
} from "./executor/index.js";
import { MemoryEventStore } from "./store/memory-store.js";
import { Replayer, type ReplayResult } from "./replay/replayer.js";
import {
  type TaskSubmit,
  type TaskReplayRequest,
  type OutboundEvent,
  type TaskAcceptedEvent,
  type TaskProgressEvent,
  type TaskCompletedEvent,
  type TaskFailedEvent,
  type WorkerDrainingEvent,
  FailureClass,
  ProgressStage,
} from "./events/index.js";
import type { L0Event } from "./executor/index.js";
import { sha256, clock } from "./utils/index.js";
import { config } from "./config.js";

/**
 * Vercel-compatible L0 Worker instance.
 * Designed for serverless execution with SSE streaming.
 */
export class VercelWorker {
  private readonly stateMachine: WorkerStateMachine;
  private readonly configManager: ConfigManager;
  private readonly slots: SlotManager;
  private readonly eventStore: MemoryEventStore;
  private readonly replayer: Replayer;

  constructor(workerConfig: WorkerConfigInput) {
    this.configManager = new ConfigManager(workerConfig);
    this.stateMachine = new WorkerStateMachine();
    this.slots = new SlotManager(this.configManager.maxConcurrency);
    this.eventStore = new MemoryEventStore();
    this.replayer = new Replayer(this.eventStore);

    // Transition to READY on creation
    this.stateMachine.transition(WorkerState.READY);

    // Update slots when config changes
    this.configManager.onUpdate((runtime) => {
      this.slots.maxConcurrency = runtime.maxConcurrency;
    });
  }

  get workerId(): string {
    return this.configManager.workerId;
  }

  get state(): WorkerState {
    return this.stateMachine.state;
  }

  get protocolVersion(): string {
    return this.configManager.protocolVersion;
  }

  get maxConcurrency(): number {
    return this.configManager.maxConcurrency;
  }

  get inflightCount(): number {
    return this.slots.inflightCount;
  }

  get availableSlots(): number {
    return this.slots.availableCount;
  }

  isAccepting(): boolean {
    return this.stateMachine.isAccepting();
  }

  hasAvailableSlot(): boolean {
    return this.slots.hasAvailableSlot();
  }

  updateConfig(update: {
    maxConcurrency?: number;
    resourceCaps?: Record<string, number>;
    featureFlags?: Record<string, boolean>;
  }): void {
    this.configManager.update(update);
  }

  async canReplay(taskId: string): Promise<boolean> {
    return this.replayer.canReplay(taskId);
  }

  async replay(
    request: TaskReplayRequest,
    emit: (event: OutboundEvent) => void,
  ): Promise<ReplayResult> {
    return this.replayer.replayWithValidation(
      request.task_id,
      request.expected_output_hash,
      emit,
    );
  }

  /**
   * Execute a task and emit events via callback.
   */
  async executeTaskWithEvents(
    taskSubmit: TaskSubmit,
    emit: (event: OutboundEvent | L0Event) => void,
  ): Promise<void> {
    const taskId = taskSubmit.task_id;
    const workerId = this.workerId;

    // Parse payload before acquiring slot - fail fast on invalid input
    const payload = parseTaskPayload(taskSubmit.payload);

    // Acquire slot
    if (!this.slots.acquire(taskId)) {
      throw new Error("No slots available");
    }

    // Set up drain timer before function timeout (only if timeout configured)
    let drainTimer: ReturnType<typeof setTimeout> | null = null;

    try {
      // Transition to ACCEPTING if needed
      if (this.stateMachine.state === WorkerState.READY) {
        this.stateMachine.transition(WorkerState.ACCEPTING);
      }

      // Configure drain timer
      if (config.functionTimeoutMs > 0) {
        const drainTimeoutMs = config.functionTimeoutMs - config.drainBufferMs;
        if (drainTimeoutMs > 0) {
          drainTimer = setTimeout(() => {
            if (this.stateMachine.state !== WorkerState.DRAINING) {
              this.stateMachine.transition(WorkerState.DRAINING);
              const drainingEvent: WorkerDrainingEvent = {
                type: "WORKER_DRAINING",
                worker_id: workerId,
                reason: "function_timeout_approaching",
                timestamp: clock.now(),
              };
              emit(drainingEvent);
            }
          }, drainTimeoutMs);
        }
      }
      // Emit TASK_ACCEPTED
      const acceptedEvent: TaskAcceptedEvent = {
        type: "TASK_ACCEPTED",
        task_id: taskId,
        worker_id: workerId,
        timestamp: clock.now(),
      };
      emit(acceptedEvent);
      await this.eventStore.record(taskId, acceptedEvent);

      const startTime = Date.now();

      // Execute with order
      const result = await executeOrder(taskSubmit.order, payload, {
        callbacks: {
          onFirstToken: () => {
            const progressEvent: TaskProgressEvent = {
              type: "TASK_PROGRESS",
              task_id: taskId,
              stage: ProgressStage.FIRST_TOKEN,
              timestamp: clock.now(),
            };
            emit(progressEvent);
            // Don't await - fire and forget for streaming
            this.eventStore.record(taskId, progressEvent);
          },
          onL0Event: (l0Event) => {
            // Pass L0 events directly to L1 without wrapping
            emit(l0Event);
          },
        },
        meta: taskSubmit.meta,
        workerId,
      });

      const duration = Date.now() - startTime;
      const outputHash = sha256(result.content);

      // Emit TASK_COMPLETED
      const completedEvent: TaskCompletedEvent = {
        type: "TASK_COMPLETED",
        task_id: taskId,
        worker_id: workerId,
        final_metrics: {
          duration_ms: duration,
          token_count: result.tokenCount,
          prompt_tokens: result.inputTokens,
          completion_tokens: result.outputTokens,
        },
        output_hash: outputHash,
        output: result.content,
        timestamp: clock.now(),
      };
      emit(completedEvent);
      await this.eventStore.record(taskId, completedEvent);
    } catch (error) {
      const failureClass = classifyError(error);
      const retryable = isRetryable(failureClass);

      const failedEvent: TaskFailedEvent = {
        type: "TASK_FAILED",
        task_id: taskId,
        worker_id: workerId,
        failure_class: failureClass,
        retryable,
        message: error instanceof Error ? error.message : String(error),
        timestamp: clock.now(),
      };
      emit(failedEvent);
      await this.eventStore.record(taskId, failedEvent);

      throw error;
    } finally {
      // Clear drain timer if set
      if (drainTimer) {
        clearTimeout(drainTimer);
      }

      // Release slot
      this.slots.release(taskId);
    }
  }
}

// Singleton instance
let workerInstance: VercelWorker | null = null;

export function getWorkerInstance(): VercelWorker | null {
  return workerInstance;
}

export function createWorkerInstance(): VercelWorker {
  workerInstance = new VercelWorker({
    workerId: config.workerId,
    maxConcurrency: config.maxConcurrency,
    protocolVersion: config.protocolVersion,
  });
  return workerInstance;
}

function classifyError(error: unknown): FailureClass {
  if (!(error instanceof Error)) {
    return FailureClass.UNKNOWN;
  }

  const message = error.message.toLowerCase();
  const name = error.name.toLowerCase();

  if (name === "outputvalidationerror") {
    return FailureClass.INVALID_INPUT;
  }
  if (message.includes("abort") || name.includes("abort")) {
    return FailureClass.ABORTED;
  }
  if (message.includes("timeout") || name.includes("timeout")) {
    return FailureClass.TIMEOUT;
  }
  if (message.includes("rate limit") || message.includes("429")) {
    return FailureClass.RATE_LIMITED;
  }
  if (message.includes("context length") || message.includes("too long")) {
    return FailureClass.CONTEXT_LENGTH_EXCEEDED;
  }
  if (
    message.includes("network") ||
    message.includes("econnreset") ||
    message.includes("econnrefused")
  ) {
    return FailureClass.NETWORK_ERROR;
  }
  if (message.includes("model") || message.includes("invalid model")) {
    return FailureClass.MODEL_ERROR;
  }
  if (message.includes("invalid") || message.includes("validation")) {
    return FailureClass.INVALID_INPUT;
  }

  return FailureClass.UNKNOWN;
}

function isRetryable(failureClass: FailureClass): boolean {
  switch (failureClass) {
    case FailureClass.TIMEOUT:
    case FailureClass.RATE_LIMITED:
    case FailureClass.NETWORK_ERROR:
      return true;
    default:
      return false;
  }
}
