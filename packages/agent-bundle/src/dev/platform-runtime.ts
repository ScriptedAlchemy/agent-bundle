/**
 * The dev server's platform runtime, as the services see it: one per
 * `startDevServer` call, created inside that function (never at module top
 * level — `effect` is a CLI cold-start cost, #530) and closed from the returned
 * session's `close` after the last service that ran on it has closed.
 *
 * Deliberately Effect-free. Every dev service names this type in its exported
 * options (`platformRuntime?: DevPlatformRuntime`), and those declarations sit
 * on the package's public declaration graph, which must not import `effect`
 * (`public-api.test.ts` "keeps every public declaration graph free of
 * effect"). The Effect-typed edge lives in `./platform-run.ts`
 * (`createDevPlatformRuntime`, `platformRunOf`), which services import for
 * their implementation only.
 */
export interface DevPlatformRuntime {
  /** Releases the runtime's Scope. Call after every service that ran on it has closed. */
  close(): Promise<void>;
}
