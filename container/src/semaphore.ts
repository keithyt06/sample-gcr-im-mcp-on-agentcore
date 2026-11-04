// Bounded concurrency gate (port of the Lark sample's createSemaphore).

export class ServerBusyError extends Error {
  constructor() {
    super('server_busy');
    this.name = 'ServerBusyError';
  }
}

export type WithSemaphore = <T>(fn: () => Promise<T>, signal?: AbortSignal) => Promise<T>;

/** Past `maxConcurrent` callers queue; past `maxQueue` they get ServerBusyError. An aborted queued caller is removed. */
export function createSemaphore(maxConcurrent: number, maxQueue: number): WithSemaphore {
  let active = 0;
  const queue: { resolve: () => void; reject: (e: Error) => void }[] = [];
  return async function withSemaphore<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (active >= maxConcurrent) {
      if (queue.length >= maxQueue) throw new ServerBusyError();
      await new Promise<void>((resolve, reject) => {
        const entry = { resolve, reject };
        queue.push(entry);
        signal?.addEventListener(
          'abort',
          () => {
            const i = queue.indexOf(entry);
            if (i >= 0) {
              queue.splice(i, 1);
              reject(new Error('client_aborted'));
            }
          },
          { once: true },
        );
      });
    }
    active++;
    try {
      return await fn();
    } finally {
      active--;
      queue.shift()?.resolve();
    }
  };
}

/** Per-key FIFO mutex. `acquire(key)` resolves to a release function. */
export function createKeyedLock(): (key: string) => Promise<() => void> {
  const tails = new Map<string, Promise<void>>();
  return async (key: string) => {
    const prev = tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => mine);
    tails.set(key, tail);
    await prev;
    return () => {
      release();
      if (tails.get(key) === tail) tails.delete(key);
    };
  };
}
