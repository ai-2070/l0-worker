// Main exports
export {
  VercelWorker,
  getWorkerInstance,
  createWorkerInstance,
} from "./worker-instance.js";
export {
  WorkerConfigSchema,
  type WorkerConfig,
  type WorkerConfigInput,
} from "./state/index.js";

// Events
export {
  // Inbound events
  TaskSubmitSchema,
  WorkerDrainRequestSchema,
  TaskReplayRequestSchema,
  WorkerConfigUpdateSchema,
  ExecutionAbortSchema,
  InboundEventSchema,
  type TaskSubmit,
  type WorkerDrainRequest,
  type TaskReplayRequest,
  type WorkerConfigUpdate,
  type ExecutionAbort,
  type InboundEvent,
  // Outbound events
  FailureClass,
  ProgressStage,
  TaskMetricsSchema,
  WorkerReadyEventSchema,
  WorkerLoadEventSchema,
  TaskAcceptedEventSchema,
  TaskProgressEventSchema,
  TaskCompletedEventSchema,
  TaskFailedEventSchema,
  WorkerDrainingEventSchema,
  WorkerOfflineEventSchema,
  OutboundEventSchema,
  type TaskMetrics,
  type WorkerReadyEvent,
  type WorkerLoadEvent,
  type TaskAcceptedEvent,
  type TaskProgressEvent,
  type TaskCompletedEvent,
  type TaskFailedEvent,
  type WorkerDrainingEvent,
  type WorkerOfflineEvent,
  type OutboundEvent,
} from "./events/index.js";

// State
export { WorkerState, WorkerStateMachine } from "./state/index.js";

// Executor
export {
  SlotManager,
  executeOrder,
  parseTaskPayload,
  type TaskPayload,
  type TaskConstraints,
  type ExecutionResult,
  type ExecutionCallbacks,
} from "./executor/index.js";

// Store
export type { EventStore } from "./store/index.js";
export { MemoryEventStore } from "./store/index.js";

// Replay
export { Replayer, type ReplayResult } from "./replay/index.js";

// Utils
export { sha256, hashPayload, MonotonicClock, clock } from "./utils/index.js";
