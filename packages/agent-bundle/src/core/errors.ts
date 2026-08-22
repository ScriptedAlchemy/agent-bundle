/** True when the error carries the given Node.js errno code, e.g. 'ENOENT'. */
export const isErrno = (error: unknown, code: string): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === code;

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

/** Windows denies fsync on directories and AV-locked files; durability there is best-effort. */
export const isTolerableWin32SyncError = (platform: string, error: unknown): boolean =>
  platform === 'win32' && (isErrno(error, 'EACCES') || isErrno(error, 'EINVAL'));
