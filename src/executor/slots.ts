/**
 * Slot manager for fixed concurrency.
 * Each task occupies one slot until terminal state.
 * No internal queue - backpressure by rejection (silence).
 */
export class SlotManager {
  private readonly slots: Map<string, { taskId: string; startedAt: number }> =
    new Map();
  private _maxConcurrency: number;

  constructor(maxConcurrency: number) {
    this._maxConcurrency = maxConcurrency;
  }

  get maxConcurrency(): number {
    return this._maxConcurrency;
  }

  set maxConcurrency(value: number) {
    if (value < 1) {
      throw new Error("maxConcurrency must be at least 1");
    }
    this._maxConcurrency = value;
  }

  /**
   * Number of currently occupied slots.
   */
  get inflightCount(): number {
    return this.slots.size;
  }

  /**
   * Number of available slots.
   */
  get availableCount(): number {
    return Math.max(0, this._maxConcurrency - this.slots.size);
  }

  /**
   * Check if there's an available slot.
   */
  hasAvailableSlot(): boolean {
    return this.slots.size < this._maxConcurrency;
  }

  /**
   * Try to acquire a slot for a task.
   * Returns true if acquired, false if no slots available.
   */
  acquire(taskId: string): boolean {
    if (!this.hasAvailableSlot()) {
      return false;
    }
    if (this.slots.has(taskId)) {
      return false; // Already has a slot
    }
    this.slots.set(taskId, { taskId, startedAt: Date.now() });
    return true;
  }

  /**
   * Release a slot for a task.
   */
  release(taskId: string): boolean {
    return this.slots.delete(taskId);
  }

  /**
   * Check if a task has a slot.
   */
  hasSlot(taskId: string): boolean {
    return this.slots.has(taskId);
  }

  /**
   * Get all inflight task IDs.
   */
  getInflightTaskIds(): string[] {
    return Array.from(this.slots.keys());
  }

  /**
   * Get slot info for a task.
   */
  getSlotInfo(
    taskId: string,
  ): { taskId: string; startedAt: number } | undefined {
    return this.slots.get(taskId);
  }

  /**
   * Clear all slots (for shutdown).
   */
  clear(): void {
    this.slots.clear();
  }
}
