export const createAbortError = (): DOMException => {
  return new DOMException(
    "The operation was cancelled.",
    "AbortError",
  );
};

export const throwIfAborted = (
  signal?: AbortSignal,
): void => {
  if (signal?.aborted) {
    throw createAbortError();
  }
};

export const isAbortError = (
  error: unknown,
): boolean => {
  return (
    error instanceof DOMException &&
    error.name === "AbortError"
  ) || (
    error instanceof Error &&
    error.name === "AbortError"
  );
};