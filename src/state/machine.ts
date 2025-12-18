/**
 * Worker states in the lifecycle.
 */
export const WorkerState = {
  BOOT: "BOOT",
  READY: "READY",
  ACCEPTING: "ACCEPTING",
  DRAINING: "DRAINING",
  OFFLINE: "OFFLINE",
} as const;

export type WorkerState = (typeof WorkerState)[keyof typeof WorkerState];

/**
 * Valid state transitions.
 */
const TRANSITIONS: Record<WorkerState, WorkerState[]> = {
  [WorkerState.BOOT]: [WorkerState.READY],
  [WorkerState.READY]: [WorkerState.ACCEPTING, WorkerState.DRAINING, WorkerState.OFFLINE],
  [WorkerState.ACCEPTING]: [WorkerState.DRAINING, WorkerState.OFFLINE],
  [WorkerState.DRAINING]: [WorkerState.OFFLINE],
  [WorkerState.OFFLINE]: [],
};

/**
 * Worker state machine.
 * Enforces valid transitions and tracks current state.
 */
export class WorkerStateMachine {
  private _state: WorkerState = WorkerState.BOOT;
  private readonly listeners: Array<(from: WorkerState, to: WorkerState) => void> = [];

  get state(): WorkerState {
    return this._state;
  }

  /**
   * Check if a transition is valid.
   */
  canTransition(to: WorkerState): boolean {
    return TRANSITIONS[this._state].includes(to);
  }

  /**
   * Transition to a new state.
   * Throws if transition is invalid.
   */
  transition(to: WorkerState): void {
    if (!this.canTransition(to)) {
      throw new Error(`Invalid state transition: ${this._state} -> ${to}`);
    }
    const from = this._state;
    this._state = to;
    for (const listener of this.listeners) {
      listener(from, to);
    }
  }

  /**
   * Subscribe to state transitions.
   */
  onTransition(listener: (from: WorkerState, to: WorkerState) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index !== -1) {
        this.listeners.splice(index, 1);
      }
    };
  }

  /**
   * Check if worker is accepting new tasks.
   */
  isAccepting(): boolean {
    return this._state === WorkerState.READY || this._state === WorkerState.ACCEPTING;
  }

  /**
   * Check if worker is in terminal state.
   */
  isOffline(): boolean {
    return this._state === WorkerState.OFFLINE;
  }

  /**
   * Check if worker is draining.
   */
  isDraining(): boolean {
    return this._state === WorkerState.DRAINING;
  }
}
