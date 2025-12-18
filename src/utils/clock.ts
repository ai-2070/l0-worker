/**
 * Monotonic clock for event ordering.
 * Ensures timestamps are always increasing, even if system clock drifts.
 */
export class MonotonicClock {
  private lastTimestamp = 0;

  /**
   * Get current timestamp in milliseconds.
   * Guaranteed to be strictly greater than the last returned value.
   */
  now(): number {
    const current = Date.now();
    if (current <= this.lastTimestamp) {
      this.lastTimestamp += 1;
    } else {
      this.lastTimestamp = current;
    }
    return this.lastTimestamp;
  }
}

/**
 * Global monotonic clock instance for the worker.
 */
export const clock = new MonotonicClock();
