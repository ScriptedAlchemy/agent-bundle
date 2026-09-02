# MCP App

From the repository root, launch this example with:

```bash
pnpm example:mcp-app
```

This credential-free example turns one service-readiness workflow into a real
local MCP server, typed tool, interactive MCP App resource, Skill, session-start
Hook, fixture-check script, and deterministic eval. It builds portable, Codex,
and Claude artifacts; the App resource remains portable.

## What is authored

- `src/skills/service-readiness` documents the evidence, checks, and report needed
  for a service-readiness decision.
- `src/hooks/session-start.ts` adds the readiness workflow to compatible host
  sessions, while `check-service-fixture` validates the checked-in compiler
  fixture before a release walkthrough.
- `src/mcp/status.ts` default-exports the `status` server factory serving
  immutable `compiler` and `payments-api` health records; `payments-api`
  deliberately returns degraded latency evidence. The build discovers the
  entry through the `src/mcp/<server-id>.ts` convention — the config declares
  no `entry` — and wraps the factory in the generated stdio lifecycle shell
  (console-to-stderr guard, signal handling, stdin-EOF exit, bounded
  shutdown, heartbeat).

## Workbench walkthrough

1. **Overview** opens on the Bundle dashboard. Its Author, Build, Exercise,
   and Evaluate stages connect the source capability to its emitted artifact,
   runtime evidence, and eval result.
2. **Skills** defaults to `service-readiness`; compare its authored status
   policy and readiness-report resource with generated output and its explicit
   eval coverage. **Hooks** defaults to a populated Claude `sessionStart`
   canonical input; run the simulation to attach the readiness workflow.
3. **Playground** defaults to Script execution, the Claude target, and
   `check-service-fixture`. Run it and wait for the finalized session. The
   emitted checker resolves the packaged status fixture beside its emitted
   module, so it succeeds without depending on the shell working directory.
4. **Logs** exposes the resulting producer records. In **Artifacts**, select
   portable to inspect `mcp-apps/status.html`; Codex and Claude retain their
   host artifacts but not this portable App resource.
5. Before recording two eval runs, **Comparisons** deliberately displays:
   `At least two recorded runs are needed before a comparison can be aligned.`
   That is the precise empty state, not an error.
6. In **MCP playground**, the defaults are portable and the `status` server.
   Open the session, list tools, select `show-status`, choose `payments-api`,
   and invoke it. Invocation history shows the degraded summary and labelled
   Availability and P95 latency checks (the latter fails). Open the App preview:
   the rendered panel also shows `payments-api`, a text-labelled amber
   `degraded` indicator, the same summary, and passing/failing checks through
   the MCP Apps bridge. Inspect the
   protocol trace, use **Restart MCP session**, then close, reset, and reopen
   it to exercise the lifecycle.
7. **Evals** defaults to the deterministic `mcp-app-status` suite. Run
   `status-is-healthy` and inspect its completed passing trial attributed to
   `service-readiness`; it reads only checked-in fixture data and needs no
   native login or API key.

If you intentionally edit a source file, rebuild and wait for a failed or idle
state before judging the result. Restore the checked-in source and rebuild to
repair the diagnostic; a new active epoch is the repair evidence, while a
Building state is still in progress.

## Noninteractive checks

After the repository-level `pnpm build`, run the public CLI workflow directly
from the example package:

```bash
cd examples/mcp-app
pnpm validate
pnpm build
pnpm exec agent-bundle eval --case status-is-healthy --trials 1
pnpm dev
```

Run the built `status` server in the foreground on stdio:

```bash
pnpm exec agent-bundle mcp run --server status --target portable
```

The command resolves the generated entry from the portable target's MCP
manifest, building a temporary artifact first; pass `--artifact dist` to
reuse the `pnpm build` output instead. Closing stdin exits 0 and Ctrl-C
exits 130, and per-server state persists under
`.agent-bundle/mcp-run/portable/status`.

`mcp run` loads the project-root `.env` set, including the selected `--mode`
variants, by default. Launch environment precedence is manifest env, then
`.env` files, then exported operator variables. Use repeatable
`--env-file <path>` to replace the conventional files, `--no-env` to skip
them, and `--plugin-root <path>` only for a copied-artifact rehearsal.

Use `pnpm check` for validation and build without opening the Workbench. The
deterministic portable eval and fixture check read only checked-in data and
require no native Claude/Codex login or API key.
