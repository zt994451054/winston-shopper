/** An expected failure with a public code, safe message, and recovery instruction. */
export class ShoppingError extends Error {
  /** @param {string} code @param {string} message @param {string} nextAction */
  constructor(code, message, nextAction = 'Run the command again after resolving this condition.') {
    super(message);
    this.name = 'ShoppingError';
    this.code = code;
    this.nextAction = nextAction;
  }
}

/**
 * Return a safe error envelope without external response bodies or credentials.
 * @param {unknown} error
 * @returns {{code: string, message: string, next_action: string}}
 * @example publicError(new ShoppingError('TARGET_MISSING', 'The tab is closed.'))
 */
export function publicError(error) {
  if (error instanceof ShoppingError) {
    return { code: error.code, message: error.message, next_action: error.nextAction };
  }
  return {
    code: 'INTERNAL_ERROR',
    message: 'The command failed unexpectedly. No external error details were printed.',
    next_action: 'Run doctor and report the command name and error code.',
  };
}
