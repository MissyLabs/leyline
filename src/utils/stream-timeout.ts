/** Default timeout for stream operations (30 seconds). */
export const STREAM_TIMEOUT_MS = 30_000;

/**
 * Wrap an async iterable with a per-message timeout. If no message arrives
 * within `timeoutMs`, the iterable is terminated and the underlying iterator
 * is properly cleaned up to prevent resource leaks.
 */
export async function* withTimeout<T>(
  source: AsyncIterable<T>,
  timeoutMs: number = STREAM_TIMEOUT_MS,
): AsyncIterable<T> {
  const iterator = source[Symbol.asyncIterator]();
  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        iterator.next(),
        new Promise<{ done: true; value: undefined }>((resolve) => {
          timer = setTimeout(() => resolve({ done: true, value: undefined }), timeoutMs);
        }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
      if (result.done) break;
      yield result.value;
    }
  } finally {
    await iterator.return?.();
  }
}
