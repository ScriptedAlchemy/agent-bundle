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

- `skills/service-readiness` documents the evidence, checks, and report needed
  for a service-readiness decision.
- `src/hooks/session-start.ts` adds the readiness workflow to compatible host
  sessions, while `check-service-fixture` validates the checked-in compiler
  fixture before a release walkthrough.
- `src/mcp-server.ts` serves immutable `compiler` and `payments-api` health
  records. `payments-api` deliberately returns degraded latency evidence.

## Workbench walkthrough

1. Open **Skills**, select `service-readiness`, and inspect its status policy
   and readiness report resource.
2. Open **Hooks**, select a `sessionStart` binding, and simulate the canonical
   event to add the readiness workflow to the session.
3. Open **Playground**, run `check-service-fixture`, and confirm the checked-in
   compiler fixture is healthy.
4. Open **MCP**, start the `status` session, and refresh its catalogs.
5. Select `show-status`, enter `{ "service": "payments-api" }`, and invoke it.
   Inspect its degraded summary and labelled availability and P95 latency checks
   in the structured result and rendered status panel. The panel receives
   official tool-input and tool-result notifications through the MCP Apps bridge.
6. Inspect the protocol trace and export the Inspector configuration.
7. Press **Restart MCP session**, then close, reset, and reopen it to exercise
   the complete lifecycle.
8. Open **Evals**, run `mcp-app-status`, and inspect the completed passing trial
   attributed to `service-readiness`.
9. Open **Artifacts** to inspect portable, Codex, and Claude outputs; only the
   portable artifact contains the MCP App resource. Open **Comparisons** to see
   the expected empty state for this single-epoch walkthrough.

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

Use `pnpm check` for validation and build without opening the Workbench. The
deterministic portable eval and fixture check read only checked-in data and
require no native Claude/Codex login or API key.
