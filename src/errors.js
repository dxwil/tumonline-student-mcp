export class SafeError extends Error {
  /**
   * @param {string} code
   * @param {string} message A message that is safe to show. It must not contain secrets or response bodies.
   */
  constructor(code, message) {
    super(message);
    this.name = "SafeError";
    this.code = code;
  }
}

export function asSafe(error) {
  if (error instanceof SafeError) {
    return error;
  }
  return new SafeError("internal", "The request could not be completed.");
}
