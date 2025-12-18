import type { EventStore } from "../store/event-store.js";
import type { OutboundEvent } from "../events/index.js";

/**
 * Replay result.
 */
export interface ReplayResult {
  success: boolean;
  eventsReplayed: number;
  outputHashMatch: boolean | null;
  error?: string;
}

/**
 * Replayer for re-emitting recorded events.
 *
 * CRITICAL: Replay re-emits recorded facts, it does NOT re-execute.
 *
 * Replay scope is strictly limited to:
 * - Task-scoped events only
 * - Already-emitted facts only
 *
 * Replay must NEVER:
 * - Regenerate tokens differently
 * - Re-invoke tools with side effects
 * - Fabricate progress events
 * - Emit events that weren't originally recorded
 */
export class Replayer {
  constructor(private readonly eventStore: EventStore) {}

  /**
   * Replay all recorded events for a task.
   * Yields events exactly as they were originally emitted.
   */
  async *replay(taskId: string): AsyncGenerator<OutboundEvent, void, unknown> {
    const events = await this.eventStore.getEventsForTask(taskId);
    for (const event of events) {
      yield event;
    }
  }

  /**
   * Replay with validation against expected output hash.
   */
  async replayWithValidation(
    taskId: string,
    expectedOutputHash: string | undefined,
    emit: (event: OutboundEvent) => void,
  ): Promise<ReplayResult> {
    const hasTask = await this.eventStore.hasTask(taskId);
    if (!hasTask) {
      return {
        success: false,
        eventsReplayed: 0,
        outputHashMatch: null,
        error: `No recorded events for task ${taskId}`,
      };
    }

    const events = await this.eventStore.getEventsForTask(taskId);
    let outputHash: string | null = null;

    // Re-emit all recorded events
    for (const event of events) {
      emit(event);

      // Track output hash if present
      if (event.type === "TASK_COMPLETED") {
        outputHash = event.outputHash;
      }
    }

    // Validate output hash if expected
    let outputHashMatch: boolean | null = null;
    if (expectedOutputHash !== undefined && outputHash !== null) {
      outputHashMatch = outputHash === expectedOutputHash;
    }

    return {
      success: true,
      eventsReplayed: events.length,
      outputHashMatch,
    };
  }

  /**
   * Check if a task can be replayed.
   */
  async canReplay(taskId: string): Promise<boolean> {
    return this.eventStore.hasTask(taskId);
  }

  /**
   * Get the recorded output hash for a task.
   */
  async getRecordedOutputHash(taskId: string): Promise<string | null> {
    return this.eventStore.getOutputHash(taskId);
  }
}
