/** Default timeout for stream operations (30 seconds). */
export const STREAM_TIMEOUT_MS = 30_000;

export class StreamAbortedError extends Error {
  constructor() {
    super('Stream aborted via AbortSignal');
    this.name = 'StreamAbortedError';
  }
}

/**
 * Wrap an async iterable with a per-message timeout and optional AbortSignal.
 * If no message arrives within `timeoutMs`, or the signal fires, the iterable
 * is terminated and the underlying iterator is properly cleaned up.
 */
export async function* withTimeout<T>(
  source: AsyncIterable<T>,
  timeoutMs: number = STREAM_TIMEOUT_MS,
  signal?: AbortSignal,
): AsyncIterable<T> {
  if (signal?.aborted) return;

  const iterator = source[Symbol.asyncIterator]();
  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const promises: Promise<IteratorResult<T>>[] = [
        iterator.next(),
        new Promise<{ done: true; value: undefined }>((resolve) => {
          timer = setTimeout(() => resolve({ done: true, value: undefined }), timeoutMs);
        }),
      ];

      if (signal) {
        promises.push(
          new Promise<never>((_, reject) => {
            if (signal.aborted) {
              reject(new StreamAbortedError());
              return;
            }
            const onAbort = () => reject(new StreamAbortedError());
            signal.addEventListener('abort', onAbort, { once: true });
          }),
        );
      }

      const result = await Promise.race(promises);
      if (timer !== undefined) clearTimeout(timer);
      if (result.done) break;
      yield result.value;
    }
  } finally {
    await iterator.return?.();
  }
}
