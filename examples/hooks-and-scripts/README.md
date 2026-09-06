# Hooks and Scripts

From the repository root, launch this example with:

```bash
pnpm example:hooks
```

The example is credential-free. It models a release preparation session with a
session-start Hook, a manifest-backed packaging check, and a risk-register
check so the Workbench can show canonical Hook simulation, successful and
blocking script traces, and live Logs. Both scripts export `main` and return
their exit codes; the build generates the process envelope that owns argv,
awaiting, and exit-code adoption. `verify-release` ships by convention — any
unclaimed plain script under `src/scripts/` is discovered — while
`detect-risk` stays explicitly configured because it selects a host: it is
emitted only when the build selects `portable`, into the shared `scripts/` of
the one plugin root every selected host installs — so the example keeps both
modes covered.

The plain Hook imports the application-owned `releaseContext` function from
`src/release-context.ts`; the emitted wrapper bundles it without starting an MCP
service or render worker.

## Workbench walkthrough

1. The shell header reports the authoritative current-or-stale epoch state and
   links build diagnostics to **Problems**.
2. Under **Application → Events / Hooks**, select the Claude `sessionStart`
   binding and its populated inline canonical JSON, including
   `"source": "workbench"`. Run the
   simulation, then use **Replay saved simulation** to rerun exactly that
   epoch-bound input. The result directs the release session through both
   checks.
3. Under **Application → Scripts**, select `verify-release` and the Claude
   target, then run it. The
   emitted script reads the packaged `release/release-manifest.json` relative
   to its module and reports release 2.4.0 ready for packaging.
4. Change the target to portable and select `detect-risk`. Its emitted script
   reads `release/risk-register.json`, reports high-severity `REL-204`, exits
   with code 2, and finalizes a durable blocking trace.
5. **Advanced → Raw logs** filters those producer records by producer, level,
   kind, or context; open a record to inspect raw details. **Advanced →
   Artifact** is the emitted file/provenance view, while **Advanced → Evals →
   Compare** aligns outcomes only after two recorded eval runs.

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
