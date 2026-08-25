# MCP App

From the repository root, launch this example with:

```bash
pnpm example:mcp-app
```

This credential-free example combines a real local MCP server, one typed tool,
an interactive MCP App resource, and a deterministic eval.

## Workbench walkthrough

1. Open **MCP**, start the `status` session, and refresh its catalogs.
2. Select `show-status`, enter `{ "service": "compiler" }`, and invoke it.
3. Inspect the text and structured result, then use the rendered status panel's
   **Toggle details** button. The panel receives the result through the official
   MCP Apps bridge.
4. Inspect the protocol trace and export the Inspector configuration.
5. Close and reopen the session to exercise the complete lifecycle.
6. Open **Evals**, run `mcp-app-status`, and inspect the completed passing trial.

## Noninteractive checks

```bash
pnpm --filter @agent-bundle-example/mcp-app check
```

The deterministic portable eval reads only its checked-in fixture and requires
no native Claude/Codex login or API key.
