import type { OutboundEvent } from "../events/index.js";
import type { EventStore } from "./event-store.js";

/**
 * In-memory event store implementation.
 * Events are lost on process restart.
 * Optionally implements LRU-style eviction when max tasks limit is reached.
 */
export class MemoryEventStore implements EventStore {
  private events = new Map<string, OutboundEvent[]>();
  private readonly maxTasks: number;

  /**
   * @param maxTasks Maximum tasks to retain. Set to 0 (default) for no limit.
   */
  constructor(maxTasks: number = 0) {
    this.maxTasks = maxTasks;
  }

  async record(taskId: string, event: OutboundEvent): Promise<void> {
    // Evict oldest task if at capacity and this is a new task
    if (
      this.maxTasks > 0 &&
      !this.events.has(taskId) &&
      this.events.size >= this.maxTasks
    ) {
      const oldestKey = this.events.keys().next().value;
      if (oldestKey) {
        this.events.delete(oldestKey);
      }
    }

    const existing = this.events.get(taskId) ?? [];
    existing.push(event);
    this.events.set(taskId, existing);
  }

  async getEventsForTask(taskId: string): Promise<OutboundEvent[]> {
    return this.events.get(taskId) ?? [];
  }

  async hasTask(taskId: string): Promise<boolean> {
    return this.events.has(taskId);
  }

  async getOutputHash(taskId: string): Promise<string | null> {
    const events = this.events.get(taskId) ?? [];
    for (const event of events) {
      if (event.type === "TASK_COMPLETED") {
        return event.output_hash;
      }
    }
    return null;
  }

  async clearTask(taskId: string): Promise<void> {
    this.events.delete(taskId);
  }

  /**
   * Clear all events (for testing).
   */
  clear(): void {
    this.events.clear();
  }

  /**
   * Get number of tasks stored (for testing/metrics).
   */
  size(): number {
    return this.events.size;
  }
}
