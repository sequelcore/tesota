/**
 * A bound on how much runs at once, such as the shell's session operations
 * and a turn's explorers. Places are granted in the order they were asked
 * for; one whose signal aborts while waiting leaves the queue and is refused.
 */
export class Semaphore {
  readonly #limit: number;
  #used = 0;
  readonly #waiting: (() => void)[] = [];

  constructor(limit: number) {
    this.#limit = limit;
  }

  /** Take a place, waiting for one if all are taken; false when the signal aborts first. */
  acquire(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    if (this.#used < this.#limit) {
      this.#used += 1;
      return Promise.resolve(true);
    }
    return new Promise((settle) => {
      const grant = (): void => { signal.removeEventListener("abort", abort); settle(true); };
      const abort = (): void => {
        const index = this.#waiting.indexOf(grant);
        if (index >= 0) this.#waiting.splice(index, 1);
        settle(false);
      };
      signal.addEventListener("abort", abort, { once: true });
      this.#waiting.push(grant);
    });
  }

  /** Give back a place taken with `acquire`; the longest waiter receives it. */
  release(): void {
    const next = this.#waiting.shift();
    if (next === undefined) this.#used -= 1;
    else next();
  }
}
