/** True when the error carries the given Node.js errno code, e.g. 'ENOENT'. */
export const isErrno = (error: unknown, code: string): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === code;
