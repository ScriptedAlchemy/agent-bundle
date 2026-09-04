import { Data } from 'effect';

/**
 * Yieldable bases for framework-process error classes (Wave 3.5, maintainer
 * decision 2026-09-03: adopt `Data.Error`; `Schema.TaggedError` stays
 * deferred). A class that extends one of these can be raised inside
 * `Effect.gen` as `return yield* new X(...)` without `Effect.fail`, and still
 * behaves as the plain `Error` subclass it replaces:
 *
 * - `instanceof Error` / `instanceof X`, `.name`, `.message`, `.code`,
 *   `.cause`, and `.stack` are unchanged (rc.112 `Data.Error` is
 *   `class extends globalThis.Error`).
 * - `JSON.stringify(error)`, `stableJson(error)`, and `{ ...error }` stay
 *   byte-identical to the plain-`Error` output. rc.112 `Data.Error#toJSON`
 *   would spread the constructor fields (`message`, `cause`) into the JSON
 *   and `stableJson` would then sort the keys; the base shadows `toJSON` so
 *   both serializers take their plain-object path ("own enumerable fields,
 *   insertion order").
 * - `util.inspect` / `console.error(error)` print the stack trace. rc.112
 *   installs `[nodejs.util.inspect.custom]` on the yieldable prototype
 *   (returning `toJSON()`), which would replace the stack with a field dump
 *   in CLI output; the base shadows it so Node's default `Error` formatting
 *   applies again.
 * - `cause` is installed exactly like `new Error(message, { cause })`: only
 *   when `options` carries the key, and never enumerable. rc.112 passes a
 *   falsy `cause` through `Object.assign`-style property assignment, which
 *   would make it an enumerable own field.
 *
 * Scope: internal classes of the framework process (the dev seam, the eval
 * service). This module imports `effect`, so anything reachable from an
 * Effect-free entry (`agent-bundle/config`, `agent-bundle/meta`,
 * `agent-bundle/rstest`, `agent-bundle/test/browser`, the CLI's `--help` /
 * `--version` path, the host MCP proxy, emitted hook / MCP / bin runtime)
 * keeps `CodedError` / `Error`; `tests/cli.test.ts` and
 * `tests/emitted-artifact-effect-surface.test.ts` pin that. Any class whose
 * declaration file a `package.json` export's `types` reaches (exported or
 * merely imported by the public `.d.ts` graph, e.g. `McpSessionError`) also
 * stays plain: a consumer's `tsc` would otherwise need `effect` for
 * `Cause.YieldableError`; `tests/public-api.test.ts` walks every export's
 * declaration graph and pins it. Carve-out list:
 * `docs/effect-conventions.md` § Yieldable framework errors.
 */

interface YieldableFields {
  readonly message?: string;
}

const nodeInspectSymbol = Symbol.for('nodejs.util.inspect.custom');

const installCause = (target: object, options: ErrorOptions | undefined): void => {
  if (options === undefined || !('cause' in options)) return;
  Object.defineProperty(target, 'cause', {
    configurable: true,
    enumerable: false,
    value: options.cause,
    writable: true,
  });
};

/**
 * `Error`'s yieldable twin: same `(message?, options?)` constructor, same
 * observable shape (see the module doc), plus `yield*` inside `Effect.gen`.
 * Subclasses set `this.name` exactly as they did on `Error`.
 */
export class YieldableFrameworkError extends Data.Error<YieldableFields> {
  constructor(message?: string, options?: ErrorOptions) {
    super(message === undefined ? {} : { message });
    installCause(this, options);
  }
}

// Shadow Effect's prototype `toJSON` (spreads the constructor fields) and
// `[nodejs.util.inspect.custom]` (returns `toJSON()`) with non-functions.
// `JSON.stringify`, `stableJson`, Effect's `Inspectable.toJSON`, and
// `util.inspect` all check `typeof === 'function'` first, so every one of
// them falls back to exactly what it does for a plain `Error` subclass: own
// enumerable fields in insertion order, and the default `name: message` +
// stack rendering. Defined on the prototype (not as class members) because
// `Cause.YieldableError` types both as methods.
for (const key of ['toJSON', nodeInspectSymbol] as const) {
  Object.defineProperty(YieldableFrameworkError.prototype, key, {
    configurable: true,
    enumerable: false,
    value: undefined,
    writable: true,
  });
}

/**
 * `CodedError`'s yieldable twin: identical `(name, code, message, options?)`
 * constructor and `code` field, for coded framework-process errors raised in
 * Effect programs. The boundary's `isTypedDevError` already matches it
 * through its string `code` (no `instanceof CodedError` needed).
 */
export class YieldableCodedError<TCode extends string = string> extends YieldableFrameworkError {
  readonly code: TCode;

  constructor(name: string, code: TCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = name;
    this.code = code;
  }
}
