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

1. **Overview** is the Bundle dashboard. It relates the authored Hook to its
   emitted artifact, exercise trace, and evaluation pages; its status is the
   authoritative current-or-stale epoch state.
2. **Hooks** defaults to the Claude `sessionStart` binding and its populated
   inline canonical JSON, including `"source": "workbench"`. Run the
   simulation, then use **Replay saved simulation** to rerun exactly that
   epoch-bound input. The result directs the release session through both
   checks.
3. **Playground** defaults to Script execution, the Claude target, and
   `verify-release`. Run it and wait until the session is finalized: the
   emitted script reads the packaged `release/release-manifest.json` relative
   to its module and reports release 2.4.0 ready for packaging.
4. Change the target to portable and select `detect-risk`. Its emitted script
   reads `release/risk-register.json`, reports high-severity `REL-204`, exits
   with code 2, and finalizes a durable blocking trace.
5. **Logs** filters those producer records by producer, level, kind, or
   context; open a record to inspect raw details. **Artifacts** is the emitted
   file/provenance view, while **Comparisons** aligns outcomes only after two
   recorded eval runs.

## Reversible diagnostic walkthrough

The checked-in project is healthy. To see last-good artifact behavior, replace
the body of `src/hooks/session-start.ts` temporarily with:

```ts
export default () => ({
```

Press **Rebuild** and wait for the completed **Failed** state. The Workbench
reports the new diagnostic while retaining the last-good artifact. Restore the
checked-in handler, press **Rebuild** again, and wait for **Idle**: a new active
epoch replaces the stale state and clears the diagnostic. Do not treat a
Building state as a completed repair.

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
