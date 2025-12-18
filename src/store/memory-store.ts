import type { OutboundEvent } from "../events/index.js";
import type { EventStore } from "./event-store.js";

/**
 * In-memory event store implementation.
 * Events are lost on process restart.
 */
export class MemoryEventStore implements EventStore {
  private events = new Map<string, OutboundEvent[]>();

  async record(taskId: string, event: OutboundEvent): Promise<void> {
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
