/** True when the error carries the given Node.js errno code, e.g. 'ENOENT'. */
export const isErrno = (error: unknown, code: string): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === code;

/** Human-readable message for an arbitrary thrown value. */
export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Shared shape for the codebase's coded error classes. Subclasses pass their
 * own name explicitly so bundler minification cannot corrupt wire-visible names.
 */
export class CodedError<TCode extends string = string> extends Error {
  readonly code: TCode;

  constructor(name: string, code: TCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = name;
    this.code = code;
  }
}

/**
 * Windows FlushFileBuffers capability failures. Directory handles have no
 * public fsync primitive and fail with EACCES, EINVAL, or EPERM depending on
 * the volume and Node/libuv mapping. Callers that already persisted a
 * directory treat these codes as best-effort durability, not a lost write.
 * Regular-file sync still fails closed.
 */
export const isTolerableWin32SyncError = (platform: string, error: unknown): boolean =>
  platform === 'win32'
  && (isErrno(error, 'EACCES') || isErrno(error, 'EINVAL') || isErrno(error, 'EPERM'));
