/** Push-based async iterable: producers `push`, one consumer iterates until `close` (or `fail`). */
export class AsyncQueue<T> implements AsyncIterable<T> {
  #items: Array<T | undefined> = [];
  #head = 0;
  readonly #waiters: Array<{ resolve: (r: IteratorResult<T>) => void; reject: (e: unknown) => void }> = [];
  #closed = false;
  #error: unknown = null;

  get closed(): boolean {
    return this.#closed;
  }

  push(item: T): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({ value: item, done: false });
    else this.#items.push(item);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter.resolve({ value: undefined, done: true });
  }

  fail(error: unknown): void {
    if (this.#closed) return;
    this.#error = error;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.#head < this.#items.length) {
          const item = this.#items[this.#head] as T;
          this.#items[this.#head++] = undefined;
          if (this.#head === this.#items.length) {
            this.#items.length = 0;
            this.#head = 0;
          } else if (this.#head >= 1024 && this.#head * 2 >= this.#items.length) {
            // Release consumed slots without moving the remaining burst on every event.
            this.#items = this.#items.slice(this.#head);
            this.#head = 0;
          }
          return Promise.resolve({ value: item, done: false });
        }
        if (this.#error !== null) return Promise.reject(this.#error);
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
      },
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}
