import type { OutboundEvent } from "../events/index.js";

/**
 * Event store interface for recording and replaying task events.
 * Replay re-emits recorded facts - it does NOT re-execute.
 */
export interface EventStore {
  /**
   * Record an event for a task.
   */
  record(taskId: string, event: OutboundEvent): Promise<void>;

  /**
   * Get all recorded events for a task, in order.
   */
  getEventsForTask(taskId: string): Promise<OutboundEvent[]>;

  /**
   * Check if a task has recorded events.
   */
  hasTask(taskId: string): Promise<boolean>;

  /**
   * Get the output hash for a completed task, if available.
   */
  getOutputHash(taskId: string): Promise<string | null>;

  /**
   * Clear events for a task (for cleanup).
   */
  clearTask(taskId: string): Promise<void>;
}
