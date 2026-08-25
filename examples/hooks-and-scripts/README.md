# Hooks and Scripts

From the repository root, launch this example with:

```bash
pnpm example:hooks
```

The example is credential-free. It models a release preparation session with a
session-start Hook, a manifest-backed packaging check, and a risk-register
check so the Workbench can show canonical Hook simulation, successful and
blocking script traces, and live Logs.

## Workbench walkthrough

1. Open **Hooks**, select the Codex `sessionStart` binding, enter a canonical
   event with `"source": "workbench"`, and run the simulation. The result
   explains that release preparation is active and directs developers to both
   release checks before it continues the session.
2. Press **Replay saved simulation** to rerun the exact epoch-bound Hook input.
3. Open **Playground** and run `verify-release`. It reads
   the packaged `release/release-manifest.json` asset relative to its emitted
   module, confirms the changelog and three required artifacts, and reports
   that release 2.4.0 is ready for packaging.
4. Run `detect-risk`. It reads `release/risk-register.json`, reports the open
   high-severity risk `REL-204`, and exits with code 2 to block packaging.
5. Open **Logs** to filter the emitted records by producer, level, kind, or
   context, then open a record to inspect its details.

## Reversible diagnostic walkthrough

The checked-in project is healthy. To see last-good artifact behavior, replace
the body of `src/hooks/session-start.ts` temporarily with:

```ts
export default () => ({
```

Press **Rebuild**. The Workbench reports the new diagnostic while retaining the
previous active artifact. Restore the checked-in handler, press **Rebuild**
again, and confirm that a new active epoch replaces the stale state and clears
the diagnostic.

## Noninteractive checks

After the repository-level `pnpm build`, run the same public commands directly
from the example package:

```bash
cd examples/hooks-and-scripts
pnpm validate
pnpm build
pnpm dev
```

Use `pnpm check` for the noninteractive validation-and-build pair.
